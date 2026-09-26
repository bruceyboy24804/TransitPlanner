import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useValue } from "cs2/api";
import { LocalizedEntityName } from "cs2/l10n";
import classNames from "classnames";
import { goTo, lineMap$, lines$, selected$ } from "../bindings";
import { formatDuration, MapLeg, MapStop, MapTransfer, MapVehicle, sameEntity } from "../types";
import { SVGBounds, SVGMouseEvent, vanilla } from "../vanilla";
import { useRegisterSVGContext, useTimelineViewport } from "./svg-viewport";
import styles from "./line-map.module.scss";

// The line map: our version of vanilla's Line Visualizer, drawn as a transit diagram the way
// XTM's line viewer draws one (a thick line in the line's OWN colour, white station bullets on a
// coloured ring, names along the line, vehicles as load rings) rather than as a chart. The loop is
// unrolled left to right (0..1 of its length) on the same SVG composition as the timeline.
// Lateness (RouteInfo vs PathInformation) is a thin stripe under the casing, so the line keeps its
// identity and the measurement is still there. Vehicle placement is a projection onto the loop's
// curves, good for a diagram (see TP_PlannerUISystem.LineMap.cs).
//
// Stop names are ON the diagram (vertical labels), so there is no chip list under it: the list
// repeated every name, and its second wrapped line overflowed its container and painted over the
// schedule editor's buttons. Transfers are in the stop's hover tooltip; jumping between lines is
// the Network tab's job.

const BOUNDS: SVGBounds = { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } };
const cssColor = (c: MapTransfer["color"]) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;

const sameHover = (a: Hover | null, b: Hover | null) => {
    if (a === b) return true;
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === "stop" && b.kind === "stop") return a.stop.entity.index === b.stop.entity.index;
    if (a.kind === "vehicle" && b.kind === "vehicle") return a.vehicle.entity.index === b.vehicle.entity.index;
    if (a.kind === "leg" && b.kind === "leg") return a.index === b.index;
    return false;
};
// Stop labels run straight down from their bullet (rotate(90), anchored at the start, so the name
// begins at the stop and any ellipsis trails away from it). Vertical is what a strip map does and
// it is the only angle with NO horizontal reach: two neighbouring labels can never collide
// sideways, however tightly the stops sit. The cost is vertical room - the padding below the data
// area has to cover the longest label - which is what LABEL_MAX bounds. The SVG is sized to that
// reach plus the distance marks on its bottom edge; anything more is dead space under the map.
const PADDING = { top: 30, right: 28, bottom: 86, left: 28 };
const TRACK_Y = 0.22;
const LABEL_MAX = 16;
/** Load to the ring colour XTM uses for crowdedness: green, amber, red. */
const loadColor = (r: number) => (r >= 0.9 ? "rgb(240, 90, 75)" : r >= 0.6 ? "rgb(250, 195, 70)" : "rgb(120, 205, 140)");

/** Achieved / planned: 1 = on plan, 1.5 = half again as slow. */
const lateness = (l: MapLeg) => (l.planned > 0 && l.achieved > 0 ? l.achieved / l.planned : 1);

type Hover =
    | { kind: "stop"; stop: MapStop }
    | { kind: "vehicle"; vehicle: MapVehicle }
    | { kind: "leg"; leg: MapLeg; index: number };

const HoverTip = ({ hover, length }: { hover: Hover; length: number }) => {
    switch (hover.kind) {
        case "stop":
            return (
                <div className={styles.tip}>
                    <div className={styles.tipTitle}><LocalizedEntityName value={hover.stop.name} /></div>
                    <div>{`${hover.stop.waiting} waiting`}</div>
                    <div>{`Average wait ${formatDuration(hover.stop.averageWait)}`}</div>
                    {(hover.stop.transfers ?? []).map((t) => (
                        <div key={t.entity.index} className={styles.tipTransfer}>
                            <span className={styles.tipSwatch} style={{ backgroundColor: cssColor(t.color) }} />
                            <LocalizedEntityName value={t.name} />
                        </div>
                    ))}
                    <div className={styles.tipHint}>Click to go there</div>
                </div>
            );
        case "vehicle":
            return (
                <div className={styles.tip}>
                    <div className={styles.tipTitle}><LocalizedEntityName value={hover.vehicle.name} /></div>
                    <div>{`${hover.vehicle.riders} / ${hover.vehicle.capacity} on board`}</div>
                    <div>{hover.vehicle.boarding ? "Boarding" : hover.vehicle.returning ? "Returning to depot" : "En route"}</div>
                    <div className={styles.tipHint}>Click to follow</div>
                </div>
            );
        default: {
            const r = lateness(hover.leg);
            return (
                <div className={styles.tip}>
                    <div className={styles.tipTitle}>{`Leg ${hover.index + 1} · ${((hover.leg.to - hover.leg.from) * length / 1000).toFixed(2)} km`}</div>
                    <div>{`Planned ${formatDuration(hover.leg.planned)}`}</div>
                    <div>{`Achieved ${formatDuration(hover.leg.achieved)}`}</div>
                    <div className={r >= 1.2 ? styles.tipWarn : undefined}>{r > 1 ? `${Math.round((r - 1) * 100)}% behind plan` : "On plan"}</div>
                    {hover.leg.inactiveDay && <div>Inactive by day</div>}
                    {hover.leg.inactiveNight && <div>Inactive by night</div>}
                </div>
            );
        }
    }
};

const legClass = (l: MapLeg) => {
    const r = lateness(l);
    return r >= 1.5 ? styles.legBad : r >= 1.2 ? styles.legSlow : styles.legOk;
};

const Body = ({ stops, legs, vehicles, length, color }: { stops: MapStop[]; legs: MapLeg[]; vehicles: MapVehicle[]; length: number; color: string }) => {
    const { viewport } = vanilla.useSVG();
    const nameStr = vanilla.useNameFormat();
    if (!viewport) return null;
    const x = (at: number) => viewport.posFromPoint(at, 0).x;
    const y = viewport.posFromPoint(0, TRACK_Y).y;
    const rem = viewport.rem;
    const casing = rem(11);

    // Vertical labels occupy a column one line-height wide, so neighbours only collide when the
    // bullets themselves are closer than that; the greedy skip keeps the rest readable.
    const minStep = rem(12);
    let lastLabelX = -1e9;

    return (
        <>
            {/* The line: a dark casing with the line's own colour inside it, end to end. */}
            <line className={styles.trackCasing} x1={x(0)} x2={x(1)} y1={y} y2={y} strokeWidth={casing + rem(4)} />
            <line className={styles.track} x1={x(0)} x2={x(1)} y1={y} y2={y} strokeWidth={casing} style={{ stroke: color }} />
            {/* Lateness as a stripe under the line, so the colour above stays the line's own. */}
            {legs.map((l, i) => (
                <line key={`leg${i}`} className={classNames(styles.lateness, legClass(l))} x1={x(l.from)} x2={x(l.to)} y1={y + casing} y2={y + casing} />
            ))}
            {stops.map((s, i) => {
                const cx = x(s.at);
                const dots = s.transfers ?? [];
                const terminus = i === 0;
                const r = terminus ? rem(9) : dots.length > 0 ? rem(8) : rem(6.5);
                const full = nameStr(s.name) ?? "";
                const label = full.length > LABEL_MAX ? `${full.slice(0, LABEL_MAX - 1)}…` : full;
                const showLabel = cx - lastLabelX >= minStep;
                if (showLabel) lastLabelX = cx;
                return (
                    <g key={s.entity.index}>
                        {/* Waiting: a pill above the bullet, warm when the queue is piling up. */}
                        {s.waiting > 0 && (
                            <g>
                                <rect className={classNames(styles.waitPill, s.waiting > 20 && styles.waitPillBusy)}
                                      x={cx - rem(11)} y={y - casing - rem(17)} width={rem(22)} height={rem(13)} rx={rem(6.5)} />
                                <text className={styles.waitText} x={cx} y={y - casing - rem(7)} textAnchor="middle">{`${s.waiting}`}</text>
                            </g>
                        )}
                        {/* Station bullet: white, ringed in the line's colour; bigger at a terminus or interchange. */}
                        <circle className={styles.stopRing} cx={cx} cy={y} r={r + rem(2.5)} style={{ fill: color }} />
                        <circle className={styles.stop} cx={cx} cy={y} r={r} />
                        {/* Interchanges: a short bar per other line, stacked below the bullet. */}
                        {dots.map((t, k) => (
                            <rect key={t.entity.index} className={styles.transfer}
                                  x={cx - rem(5)} y={y + casing / 2 + rem(4) + k * rem(5)} width={rem(10)} height={rem(3)} rx={rem(1.5)}
                                  style={{ fill: cssColor(t.color) }} />
                        ))}
                        {showLabel && (
                            <g transform={`rotate(90 ${cx} ${y + casing + rem(10)})`}>
                                <text className={classNames(styles.stopLabel, terminus && styles.stopLabelTerminus)}
                                      x={cx} y={y + casing + rem(10)} textAnchor="start">{label}</text>
                            </g>
                        )}
                    </g>
                );
            })}
            {vehicles.map((v) => {
                const cx = x(v.at);
                const load = v.capacity > 0 ? Math.min(1, v.riders / v.capacity) : 0;
                const ring = rem(10);
                return (
                    <g key={v.entity.index} className={classNames(styles.vehicle, v.returning && styles.vehicleReturning)}>
                        <circle className={styles.vehicleRing} cx={cx} cy={y} r={ring} style={{ stroke: loadColor(load) }} />
                        {!v.boarding && load > 0 && (
                            <circle className={styles.vehicleFill} cx={cx} cy={y} r={ring * Math.sqrt(load) * 0.82} style={{ fill: loadColor(load) }} />
                        )}
                    </g>
                );
            })}
            {/* The distance marks sit on the SVG's bottom edge, not under the track: the stop
                labels hang down into that space and the two collided. */}
            <text className={styles.axisLabel} x={x(0)} y={viewport.size.height - rem(3)}>0 km</text>
            <text className={styles.axisLabel} x={x(1)} y={viewport.size.height - rem(3)} textAnchor="end">{`${(length / 1000).toFixed(1)} km`}</text>
        </>
    );
};

export const LineMap = () => {
    const map = useValue(lineMap$.binding);
    // The line's own colour is what the diagram is drawn in (XTM's rule); it lives on the row.
    const rows = useValue(lines$.binding);
    const selected = useValue(selected$.binding);
    const color = useMemo(() => {
        const row = rows.find((r) => sameEntity(r.entity, selected));
        return row ? cssColor(row.color) : "rgb(150, 160, 175)";
    }, [rows, selected]);
    const { SVGcomponent, SVGContext } = vanilla;
    const svgRef = useRef<SVGSVGElement | null>(null);
    const [viewport] = useTimelineViewport(svgRef, { bounds: BOUNDS, padding: PADDING, inverted: false });
    const [hover, setHover] = useState<Hover | null>(null);
    const mapRef = useRef(map);
    mapRef.current = map;
    const viewportRef = useRef(viewport);
    viewportRef.current = viewport;

    // What is under the cursor: a vehicle or stop within a few rem of it, else the leg it is over.
    const onMouseMove = useCallback((e: SVGMouseEvent) => {
        const vp = viewportRef.current;
        const m = mapRef.current;
        if (!vp || !m.valid) return;
        const tolX = vp.scaleToPoint(vp.rem(10), 0).x;
        const nearTrack = Math.abs(e.point.y - TRACK_Y) < 0.35;
        let next: Hover | null = null;
        if (nearTrack) {
            const v = m.vehicles.find((x) => Math.abs(x.at - e.point.x) <= tolX);
            const s = !v ? m.stops.find((x) => Math.abs(x.at - e.point.x) <= tolX) : undefined;
            const li = !v && !s ? m.legs.findIndex((l) => e.point.x >= l.from && e.point.x < l.to) : -1;
            next = v ? { kind: "vehicle", vehicle: v } : s ? { kind: "stop", stop: s } : li >= 0 ? { kind: "leg", leg: m.legs[li], index: li } : null;
        }
        setHover((prev) => (sameHover(prev, next) ? prev : next));
    }, []);
    const onMouseLeave = useCallback(() => setHover(null), []);
    // Click = go there: select the stop or vehicle in the world and put the camera on it.
    const hoverRef = useRef(hover);
    hoverRef.current = hover;
    const onMouseDown = useCallback(() => {
        const h = hoverRef.current;
        if (h?.kind === "stop") goTo(h.stop.entity);
        else if (h?.kind === "vehicle") goTo(h.vehicle.entity);
    }, []);
    const interaction = vanilla.useSVGInteraction({ onMouseMove, onMouseLeave, onMouseDown });
    // The kit converts mouse events through the viewport it was last given; without this the
    // handlers never fire (it returns early on a missing viewport).
    useEffect(() => { interaction.updateViewport(viewport); }, [interaction, viewport]);
    const context = useMemo(() => ({ viewport, events: interaction.events }), [viewport, interaction]);
    useRegisterSVGContext(context);
    const FloatingMouseTooltip = vanilla.FloatingMouseTooltip;

    if (!map.valid) return null;
    const worst = map.legs.reduce((m, l) => Math.max(m, lateness(l)), 1);

    return (
        <div className={styles.wrap}>
            <FloatingMouseTooltip screenSpacePosition alwaysVisible disabled={!hover} tooltip={hover ? <HoverTip hover={hover} length={map.length} /> : null} />
            <SVGContext.Provider value={context}>
                <SVGcomponent ref={svgRef} interaction={interaction} viewport={viewport} className={styles.svg}>
                    {viewport && <Body stops={map.stops} legs={map.legs} vehicles={map.vehicles} length={map.length} color={color} />}
                </SVGcomponent>
            </SVGContext.Provider>
            <div className={styles.legend}>
                <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.legOkBg)} /> on plan</span>
                <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.legSlowBg)} /> 20% slower</span>
                <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.legBadBg)} /> 50% slower</span>
                <span className={styles.legendItem}>pills = waiting at stop · rings = vehicles, filled by load, hollow while boarding</span>
                {worst >= 1.2 && <span className={styles.legendWarn}>slowest leg runs {Math.round((worst - 1) * 100)}% behind plan</span>}
            </div>
        </div>
    );
};
