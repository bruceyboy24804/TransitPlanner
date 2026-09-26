import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import classNames from "classnames";
import { Band, BandMode, DAY_START, formatTimeOfDay, HourSample, PunctualitySample, minutesToFrames, NIGHT_START, secondsToMinutes, TICKS_PER_DAY } from "../types";
import { SVGBounds, SVGMouseEvent, SVGViewport, vanilla } from "../vanilla";
import { useRegisterSVGContext, useTimelineViewport } from "./svg-viewport";
import styles from "./timeline.module.scss";

// The 24-hour band editor, on the game's own SVG chart kit (game-ui/common/svg/), composed the
// way Traffic's phase editor composes it: our own viewport (svg-viewport.ts, Traffic's recipe, not
// the kit's useSVGSetup) with bounds in DATA units, useSVGInteraction handing every mouse event over with `.point` already converted into
// those units, SVGContext shares the viewport with GridLines, and the bands themselves are raw
// <rect>s placed through viewport.posFromPoint / scaleToViewport (the kit's Rect element sizes in
// rem, so it is for markers, not spans).
//
// Data units are HOURS on x (0..24) so GridLines' "nice" ticks fall on hours, and 0..1 on y with
// inverted: false so y grows downward like the rest of the UI.
//
// Bands are kept sorted, non-overlapping and within a single day; a night band is two bands
// (22:00–24:00 and 00:00–06:00), which is also how the presets create them. The wrap-around form
// the C# side supports is not produced here.

const HOURS = 24;
const SNAP_MIN = 5;
const MIN_WIDTH_MIN = 15;
const BOUNDS: SVGBounds = { min: { x: 0, y: 0 }, max: { x: HOURS, y: 1 } };
// Side padding leaves room for the edge time labels ("00:00") centred on a band's edge.
const PADDING = { top: 18, right: 28, bottom: 22, left: 28 };
const TRACK_TOP = 0.05;
const TRACK_BOTTOM = 0.95;
/** Edge grab tolerance, in rem. */
const HANDLE_REM = 8;
const CLIP_ID = "tp-timeline-clip";
// A stable object: the viewport hook depends on it, and a fresh literal per render would
// re-subscribe the wheel listener every frame.
const ZOOM_RANGE = { min: 0.1, max: 1 };

const framesToHours = (f: number) => (f / TICKS_PER_DAY) * HOURS;
const hoursToFrames = (h: number) => (h / HOURS) * TICKS_PER_DAY;
const snapHours = (h: number) => Math.round((h * 60) / SNAP_MIN) * (SNAP_MIN / 60);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const MIN_WIDTH_H = MIN_WIDTH_MIN / 60;

/** A stretch of the day the line does not run, frames of the day, start < end (TP_ClosedPeriod). */
export type ClosedPeriod = { start: number; end: number };
type Closed = ClosedPeriod[] | undefined;

/** The open stretches of the day, in hours: the day minus the closed periods, slivers dropped. */
const openRanges = (closed: Closed): [number, number][] => {
    const out: [number, number][] = [];
    let cursor = 0;
    for (const c of [...(closed ?? [])].sort((a, b) => a.start - b.start)) {
        const a = framesToHours(c.start);
        const b = framesToHours(c.end);
        if (a > cursor) out.push([cursor, a]);
        cursor = Math.max(cursor, b);
    }
    if (cursor < HOURS) out.push([cursor, HOURS]);
    return out.filter(([a, b]) => b - a >= MIN_WIDTH_H);
};

/** True if frame-of-day `f` is inside a closed period. */
const isClosed = (closed: Closed, f: number) => (closed ?? []).some((c) => f >= c.start && f < c.end);

/** The open stretch containing hour `h`, or the nearest one (a band sitting in closed hours is pulled into it). */
const rangeFor = (ranges: [number, number][], h: number): [number, number] =>
    ranges.find(([a, b]) => h >= a && h <= b)
    ?? ranges.reduce((best, r) => (Math.min(Math.abs(h - r[0]), Math.abs(h - r[1])) < Math.min(Math.abs(h - best[0]), Math.abs(h - best[1])) ? r : best), ranges[0] ?? [0, HOURS]);

const modeClass: Record<BandMode, string> = {
    [BandMode.Default]: styles.bandDefault,
    [BandMode.Headway]: styles.bandHeadway,
    [BandMode.Fleet]: styles.bandFleet,
    [BandMode.Off]: styles.bandOff,
    [BandMode.TargetLoad]: styles.bandTarget,
    [BandMode.TargetWait]: styles.bandTarget,
    [BandMode.StationStock]: styles.bandTarget,
    [BandMode.CrowdingCap]: styles.bandTarget,
    [BandMode.FollowDemand]: styles.bandTarget,
    [BandMode.Ramp]: styles.bandHeadway,
    [BandMode.Frequency]: styles.bandHeadway,
    [BandMode.MatchLine]: styles.bandFleet,
    [BandMode.DemandFirst]: styles.bandTarget,
    [BandMode.Convoy]: styles.bandHeadway,
    [BandMode.Capped]: styles.bandFleet,
    [BandMode.Express]: styles.bandHeadway,
};

export const bandLabel = (b: Band) => {
    switch (b.mode) {
        case BandMode.Headway:
            return `every ${Math.round(secondsToMinutes(b.headway))} min`;
        case BandMode.Fleet:
            return `${b.fleet} vehicles`;
        case BandMode.Off:
            return "no service";
        case BandMode.TargetLoad:
            return `load ${Math.round((b.loadMin ?? 0.5) * 100)}–${Math.round((b.loadMax ?? 0.85) * 100)}%`;
        case BandMode.TargetWait:
            return `wait ${Math.round(secondsToMinutes(b.loadMin ?? 0))}–${Math.round(secondsToMinutes(b.loadMax ?? 0))} min`;
        case BandMode.StationStock:
            return `stock ${Math.round((b.loadMin ?? 0.2) * 100)}–${Math.round((b.loadMax ?? 0.6) * 100)}%`;
        case BandMode.CrowdingCap:
            return `fullest ≤ ${Math.round((b.loadMax ?? 0.9) * 100)}%`;
        case BandMode.FollowDemand:
            return `demand @ ${Math.round((b.value ?? 0.7) * 100)}%`;
        case BandMode.Ramp:
            return `${Math.round(secondsToMinutes(b.headway))}→${Math.round(secondsToMinutes(b.value ?? b.headway))} min`;
        case BandMode.Frequency:
            return `${b.value ?? 0}/h`;
        case BandMode.MatchLine:
            return `match ×${b.value ?? 1}`;
        case BandMode.DemandFirst:
            return `waiting ${Math.round((b.loadMin ?? 0.3) * 100)}–${Math.round((b.loadMax ?? 1) * 100)}%`;
        case BandMode.Convoy:
            return `convoy every ${Math.round(secondsToMinutes(b.headway))} min`;
        case BandMode.Capped:
            return `every ${Math.round(secondsToMinutes(b.headway))} min, ≤ ${b.fleet}`;
        case BandMode.Express:
            return `express every ${Math.round(secondsToMinutes(b.headway))} min`;
        default:
            return "vanilla";
    }
};

interface Drag {
    band: number;
    edge: "start" | "end" | "move";
    /** Hours between the mouse and the band start at grab time (move only). */
    grabOffset: number;
}

export interface TimelineProps {
    bands: Band[];
    selected: number;
    onSelect: (index: number) => void;
    /** Committed on mouse-up, never during the drag. */
    onChange: (bands: Band[]) => void;
    /** Current frame of the day, drawn as a marker. */
    now?: number;
    /** A freight line: the history is cargo load and there is no passenger queue to draw. */
    freight?: boolean;
    /** The line's measured hourly history, drawn under the bands. */
    history?: HourSample[];
    /** Closed periods (frames of day), drawn over the bands; bands cannot enter them. */
    closed?: ClosedPeriod[];
    /** Called on mouse-up after a closed block was dragged; without it the blocks are fixed. */
    onClosedChange?: (closed: ClosedPeriod[]) => void;
    /** The selected closed block (index into `closed`), or -1. */
    selectedClosed?: number;
    onSelectClosed?: (index: number) => void;
    /** Timetabled departures from the anchor, frames of the day, drawn as ticks under the track. */
    departures?: number[];
    /** Hourly punctuality (24 entries), drawn as a strip over the track: redder = more late departures. */
    punctuality?: PunctualitySample[];
}

/** Which band and edge a data point lands on, edges taking priority within the handle tolerance. */
const hitTest = (bands: Band[], viewport: SVGViewport, x: number): { band: number; edge: Drag["edge"] } | null => {
    const tol = viewport.scaleToPoint(viewport.rem(HANDLE_REM), 0).x;
    for (let i = 0; i < bands.length; i++) {
        const s = framesToHours(bands[i].start);
        const e = framesToHours(bands[i].end);
        if (Math.abs(x - s) <= tol) return { band: i, edge: "start" };
        if (Math.abs(x - e) <= tol) return { band: i, edge: "end" };
    }
    for (let i = 0; i < bands.length; i++) {
        if (x >= framesToHours(bands[i].start) && x < framesToHours(bands[i].end)) return { band: i, edge: "move" };
    }
    return null;
};

/**
 * Axis labels for the visible span: the coarsest step (3 h down to 5 min) that keeps labels
 * about 80rem apart, so zooming in reveals finer times instead of the same 3-hour marks.
 */
const AXIS_STEPS_H = [1 / 12, 0.25, 0.5, 1, 3];
const axisTicks = (viewport: SVGViewport): number[] => {
    const { min, max } = viewport.bounds;
    const pxPerHour = viewport.scaleToViewport(1, 0).x;
    const step = AXIS_STEPS_H.find((s) => s * pxPerHour >= viewport.rem(80)) ?? 3;
    const ticks: number[] = [];
    for (let h = Math.ceil(min.x / step) * step; h < Math.min(max.x, HOURS); h += step) {
        if (h >= 0) ticks.push(Math.round(h * 1e6) / 1e6);
    }
    return ticks;
};

/** The chart body; only rendered once the viewport exists, so useSVG() is never empty here. */
/** The measured history as a load area and a queue line, hour by hour, under the bands. */
const HistoryOverlay = ({ history, freight }: { history: HourSample[]; freight?: boolean }) => {
    const { viewport } = vanilla.useSVG();
    if (!viewport || history.length !== 24) return null;
    const known = history.filter((h) => h.samples > 0);
    if (known.length === 0) return null;
    const top = viewport.posFromPoint(0, TRACK_TOP).y;
    const bottom = viewport.posFromPoint(0, TRACK_BOTTOM).y;
    const h = bottom - top;
    const maxQueue = Math.max(1, ...known.map((s) => s.waiting));
    // Load: 0..1 fills the track, more than full spills above it and is clamped at 1.25.
    const loadY = (s: HourSample) => bottom - h * Math.min(1.25, s.load);
    const queueY = (s: HourSample) => bottom - h * (s.waiting / maxQueue);
    const x = (hour: number) => viewport.posFromPoint(hour, 0).x;
    // One step per hour, drawn as a stepped path across each hour's span.
    let area = "";
    let line = "";
    history.forEach((s, hr) => {
        if (s.samples === 0) return;
        const x0 = x(hr);
        const x1 = x(hr + 1);
        area += `${area ? " L" : "M"}${x0},${bottom} L${x0},${loadY(s)} L${x1},${loadY(s)} L${x1},${bottom}`;
        line += `${line ? " L" : "M"}${x0},${queueY(s)} L${x1},${queueY(s)}`;
    });
    const full = history.map((s, hr) => (s.samples > 0 && s.load >= 1 ? hr : -1)).filter((hr) => hr >= 0);
    // Freight: the share running empty per hour (0..1 of the track), and the vehicles running as
    // a step line scaled to the busiest hour, with the count written at each change.
    let emptyLine = "";
    let fleetLine = "";
    const fleetMarks: { x: number; y: number; n: number }[] = [];
    if (freight) {
        const maxFleet = Math.max(1, ...known.map((s) => s.fleet ?? 0));
        let lastN = -1;
        history.forEach((s, hr) => {
            if (s.samples === 0) return;
            const x0 = x(hr), x1 = x(hr + 1);
            const ey = bottom - h * Math.min(1, s.empty ?? 0);
            emptyLine += `${emptyLine ? " L" : "M"}${x0},${ey} L${x1},${ey}`;
            const fy = bottom - h * 0.9 * ((s.fleet ?? 0) / maxFleet);
            fleetLine += `${fleetLine ? " L" : "M"}${x0},${fy} L${x1},${fy}`;
            const nRound = Math.round(s.fleet ?? 0);
            if (nRound !== lastN) { fleetMarks.push({ x: x0, y: fy, n: nRound }); lastN = nRound; }
        });
    }
    return (
        <g>
            <path className={styles.loadArea} d={area + " Z"} />
            {!freight && <path className={styles.queueLine} d={line} />}
            {freight && emptyLine && <path className={styles.emptyLine} d={emptyLine} />}
            {freight && fleetLine && <path className={styles.fleetLine} d={fleetLine} />}
            {freight && fleetMarks.map((m, i) => (
                <text key={i} className={styles.fleetMark} x={m.x + viewport.rem(3)} y={m.y - viewport.rem(3)}>{`${m.n}`}</text>
            ))}
            {full.map((hr) => (
                <rect key={hr} className={styles.overloadMark} x={x(hr)} y={top} width={x(hr + 1) - x(hr)} height={viewport.rem(4)} />
            ))}
        </g>
    );
};

/**
 * 45° hatching for a rectangle as one path: each line x − y = c cut to the rectangle by hand
 * (no <pattern> or clip-path needed, so nothing here depends on less-used SVG features).
 */
export const hatch = (x: number, y: number, w: number, h: number, step: number) => {
    let d = "";
    // Line through (k, y + h) rising to the right: points (k + t, y + h − t), t in [0, h].
    for (let k = x - h; k < x + w; k += step) {
        const t0 = Math.max(0, x - k);
        const t1 = Math.min(h, x + w - k);
        if (t1 <= t0) continue;
        d += `M${k + t0},${y + h - t0} L${k + t1},${y + h - t1} `;
    }
    return d;
};

/** Departure ticks under the track and the lateness strip over it. */
const TimetableOverlay = ({ departures, punctuality }: { departures?: number[]; punctuality?: PunctualitySample[] }) => {
    const { viewport } = vanilla.useSVG();
    if (!viewport) return null;
    const x = (hours: number) => viewport.posFromPoint(hours, 0).x;
    const tickTop = viewport.posFromPoint(0, TRACK_BOTTOM).y;
    const tickBottom = viewport.posFromPoint(0, 1).y;
    const stripTop = viewport.posFromPoint(0, 0).y;
    const stripBottom = viewport.posFromPoint(0, TRACK_TOP).y;
    let ticks = "";
    for (const f of departures ?? []) {
        const tx = x(framesToHours(f));
        ticks += `M${tx},${tickTop} L${tx},${tickBottom} `;
    }
    return (
        <g>
            {ticks && <path className={styles.departureTick} d={ticks} />}
            {(punctuality ?? []).map((p, hr) => p.samples > 0 && (
                <rect key={hr} className={styles.lateMark} style={{ opacity: Math.min(1, Math.max(0.08, 1 - p.onTime)) }}
                    x={x(hr)} y={stripTop} width={x(hr + 1) - x(hr)} height={Math.max(1, stripBottom - stripTop)} />
            ))}
        </g>
    );
};

const TimelineBody = ({ bands, selected, now, drag, history, freight, departures, punctuality, closed, closedEditable, closedDrag, selectedClosed }: {
    bands: Band[]; selected: number; now?: number; drag: Drag | null; history?: HourSample[]; freight?: boolean; departures?: number[]; punctuality?: PunctualitySample[];
    closed?: ClosedPeriod[]; closedEditable?: boolean; closedDrag?: Drag | null; selectedClosed?: number;
}) => {
    const { viewport } = vanilla.useSVG();
    const GridLines = vanilla.GridLines;
    if (!viewport) return null;

    const span = (x0: number, x1: number, y0 = TRACK_TOP, y1 = TRACK_BOTTOM) => {
        const p = viewport.posFromPoint(x0, y0);
        const s = viewport.scaleToViewport(x1 - x0, y1 - y0);
        return { x: p.x, y: p.y, width: s.x, height: s.y };
    };
    const labelY = viewport.posFromPoint(0, 1).y + viewport.rem(16);
    const dayStart = framesToHours(DAY_START);
    const nightStart = framesToHours(NIGHT_START);

    return (
        <>
            {/* Everything zoomable is clipped to the padded area, Traffic's clipPath trick, so a
                zoomed-in day does not spill past the edges. */}
            <defs>
                <clipPath id={CLIP_ID}>
                    <rect x={viewport.padding.left} y={0} width={viewport.size.width - viewport.padding.left - viewport.padding.right} height={viewport.size.height} />
                </clipPath>
            </defs>
            <g clipPath={`url(#${CLIP_ID})`}>
            {/* The game's own night window: before 06:00 and from 22:00. */}
            <rect className={styles.night} {...span(0, dayStart)} />
            <rect className={styles.night} {...span(nightStart, HOURS)} />

            <GridLines drawAxes="x" tickWidth={40} overdraw />
            {history && <HistoryOverlay history={history} freight={freight} />}
            <TimetableOverlay departures={departures} punctuality={punctuality} />

            {axisTicks(viewport).map((h) => (
                <text key={h} className={styles.axis} x={viewport.posFromPoint(h, 0).x + viewport.rem(3)} y={labelY}>
                    {formatTimeOfDay(hoursToFrames(h))}
                </text>
            ))}

            {bands.map((b, i) => {
                const s = framesToHours(b.start);
                const e = framesToHours(b.end);
                const r = span(s, e);
                const isSel = i === selected;
                // A band in closed hours does nothing; its label would only show through the overlay.
                const open = !isClosed(closed, (b.start + b.end) / 2);
                const wide = open && r.width > viewport.rem(70);
                return (
                    <g key={i}>
                        <rect className={classNames(styles.band, modeClass[b.mode], isSel && styles.bandSelected)} {...r} />
                        {/* Target load: the range as two dashed lines on the load scale (full = track height), so the measured load shows against it. */}
                        {b.mode === BandMode.TargetLoad && [b.loadMin ?? 0.5, b.loadMax ?? 0.85].map((v, k) => {
                            const ty = r.y + r.height - r.height * Math.min(1.25, v);
                            return <line key={`t${k}`} className={styles.targetLine} x1={r.x} x2={r.x + r.width} y1={ty} y2={ty} />;
                        })}
                        {wide && (
                            <text className={styles.bandText} x={r.x + r.width / 2} y={r.y + r.height / 2 + viewport.rem(4)} textAnchor="middle">
                                {bandLabel(b)}
                            </text>
                        )}
                        <rect className={classNames(styles.handle, drag?.band === i && drag.edge === "start" && styles.handleActive)} x={r.x - viewport.rem(2)} y={r.y} width={viewport.rem(4)} height={r.height} />
                        <rect className={classNames(styles.handle, drag?.band === i && drag.edge === "end" && styles.handleActive)} x={r.x + r.width - viewport.rem(2)} y={r.y} width={viewport.rem(4)} height={r.height} />
                        {isSel && (
                            <>
                                <text className={styles.edgeText} x={r.x} y={r.y - viewport.rem(4)} textAnchor="middle">
                                    {formatTimeOfDay(b.start)}
                                </text>
                                <text className={styles.edgeText} x={r.x + r.width} y={r.y - viewport.rem(4)} textAnchor="middle">
                                    {formatTimeOfDay(b.end)}
                                </text>
                            </>
                        )}
                    </g>
                );
            })}

            {/* Closed blocks, drawn OVER the bands: the line does not run there, so a band there
                does nothing. Labelled by where they sit: "start" from midnight, "end" to midnight,
                "closed" in between. Each is a block of its own like a band: its edges and its body
                drag (edges win within the handle tolerance), and the selected one shows its times. */}
            {(closed ?? []).map((c, i) => {
                const a = framesToHours(c.start);
                const b = framesToHours(c.end);
                if (b <= a) return null;
                const r = span(a, b, 0, 1);
                const label = c.start === 0 ? "start" : c.end >= TICKS_PER_DAY ? "end" : "closed";
                const isSel = i === selectedClosed;
                const active = (k: Drag["edge"]) => closedDrag?.band === i && (closedDrag.edge === k || closedDrag.edge === "move");
                return (
                    <g key={`closed${i}`}>
                        <rect className={styles.closed} {...r} />
                        <path className={styles.closedHatch} d={hatch(r.x, r.y, r.width, r.height, viewport.rem(9))} />
                        <rect className={classNames(styles.closedBorder, isSel && styles.closedSelected)} {...r} />
                        {r.width > viewport.rem(50) && (
                            <text className={styles.closedText} x={r.x + r.width / 2} y={r.y + r.height / 2 + viewport.rem(4)} textAnchor="middle">{label}</text>
                        )}
                        {closedEditable && (["start", "end"] as const).map((k) => (
                            <rect key={k} className={classNames(styles.serviceHandle, active(k) && styles.serviceHandleActive)}
                                x={(k === "start" ? r.x : r.x + r.width) - viewport.rem(2.5)} y={r.y} width={viewport.rem(5)} height={r.height} />
                        ))}
                        {(isSel || closedDrag?.band === i) && (
                            <>
                                <text className={styles.edgeText} x={r.x} y={r.y - viewport.rem(4)} textAnchor="middle">{formatTimeOfDay(c.start)}</text>
                                <text className={styles.edgeText} x={r.x + r.width} y={r.y - viewport.rem(4)} textAnchor="middle">{c.end >= TICKS_PER_DAY ? "24:00" : formatTimeOfDay(c.end)}</text>
                            </>
                        )}
                    </g>
                );
            })}

            {now !== undefined && (() => {
                const x = viewport.posFromPoint(framesToHours(now), 0).x;
                return <line className={styles.now} x1={x} x2={x} y1={viewport.posFromPoint(0, 0).y} y2={viewport.posFromPoint(0, 1).y} />;
            })()}
            </g>
        </>
    );
};

export const Timeline = ({ bands, selected, onSelect, onChange, now, history, freight, departures, punctuality, closed, onClosedChange, selectedClosed = -1, onSelectClosed }: TimelineProps) => {
    const SVGcomponent = vanilla.SVGcomponent;
    const SVGContext = vanilla.SVGContext;
    const svgRef = useRef<SVGSVGElement | null>(null);
    // Traffic's phase editor settings: wheel zooms the time axis, middle mouse pans.
    const [viewport, zoom, resetViewport, scrollTo] = useTimelineViewport(svgRef, {
        bounds: BOUNDS,
        padding: PADDING,
        inverted: false,
        zoomable: "x",
        panable: "x",
        zoomRange: ZOOM_RANGE,
    });

    // The horizontal scrollbar under a zoomed timeline: thumb = the visible share of the day.
    const trackRef = useRef<HTMLDivElement | null>(null);
    const visibleShare = viewport ? (viewport.bounds.max.x - viewport.bounds.min.x) / HOURS : 1;
    const scrollRange = HOURS * (1 - visibleShare);
    const scrollFraction = viewport && scrollRange > 0 ? (viewport.bounds.min.x - BOUNDS.min.x) / scrollRange : 0;
    const onThumbDown = useCallback((e: React.MouseEvent) => {
        if (e.button !== 0 || !trackRef.current) return;
        e.preventDefault();
        const track = trackRef.current.getBoundingClientRect();
        const thumbW = track.width * visibleShare;
        const grab = e.clientX - (track.left + scrollFraction * (track.width - thumbW));
        const move = (ev: MouseEvent) => {
            const left = ev.clientX - grab - track.left;
            scrollTo(left / Math.max(1, track.width - thumbW));
        };
        const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    }, [visibleShare, scrollFraction, scrollTo]);

    const [drag, setDrag] = useState<Drag | null>(null);
    const [draft, setDraft] = useState<Band[] | null>(null);
    // Closed blocks drag like bands (edges or body, bounded by the neighbouring blocks); the bands
    // preview clipped to them, and the parent clips them for real on release (onClosedChange).
    const [cDrag, setCDrag] = useState<Drag | null>(null);
    const [cDraft, setCDraft] = useState<ClosedPeriod[] | null>(null);
    const shownClosed = cDraft ?? closed;
    const shown = cDraft ? clipToService(bands, cDraft) : draft ?? bands;

    // Refs so the interaction handlers (memoised once by the kit) always see current state.
    const bandsRef = useRef(bands);
    bandsRef.current = bands;
    const viewportRef = useRef(viewport);
    viewportRef.current = viewport;
    const dragRef = useRef(drag);
    dragRef.current = drag;
    const closedRef = useRef(closed);
    closedRef.current = closed;
    const cDragRef = useRef(cDrag);
    cDragRef.current = cDrag;
    const cDraftRef = useRef(cDraft);
    cDraftRef.current = cDraft;
    const onClosedChangeRef = useRef(onClosedChange);
    onClosedChangeRef.current = onClosedChange;
    const onSelectClosedRef = useRef(onSelectClosed);
    onSelectClosedRef.current = onSelectClosed;

    const commit = useCallback(() => {
        if (cDragRef.current) {
            const cd = cDraftRef.current;
            if (cd && onClosedChangeRef.current) onClosedChangeRef.current(cd);
            setCDrag(null);
            setCDraft(null);
            return;
        }
        setDrag(null);
        setDraft((d) => {
            if (d) onChange(d);
            return null;
        });
    }, [onChange]);

    const onMouseDown = useCallback((e: SVGMouseEvent) => {
        if (e.button !== 0 || !viewportRef.current) return;
        // Closed blocks come first: they are drawn over the bands, and after a clip their edges
        // sit exactly on a band's edge, where the block is what the player is reaching for.
        const cl = closedRef.current;
        if (cl && cl.length && onClosedChangeRef.current) {
            const asBands = cl.map((c) => ({ start: c.start, end: c.end } as Band));
            const hitC = hitTest(asBands, viewportRef.current, e.point.x);
            if (hitC) {
                onSelect(-1);
                onSelectClosedRef.current?.(hitC.band);
                setCDrag({ ...hitC, grabOffset: e.point.x - framesToHours(cl[hitC.band].start) });
                setCDraft(cl.map((c) => ({ ...c })));
                return;
            }
        }
        const hit = hitTest(bandsRef.current, viewportRef.current, e.point.x);
        onSelectClosedRef.current?.(-1);
        if (!hit) {
            onSelect(-1);
            return;
        }
        onSelect(hit.band);
        const start = framesToHours(bandsRef.current[hit.band].start);
        setDrag({ ...hit, grabOffset: e.point.x - start });
        setDraft(bandsRef.current.map((b) => ({ ...b })));
    }, [onSelect]);

    const onMouseMove = useCallback((e: SVGMouseEvent) => {
        const cd = cDragRef.current;
        if (cd) {
            // The band drag, for a closed block: bounded by the neighbouring blocks and the day.
            const x = snapHours(clamp(e.point.x, 0, HOURS));
            setCDraft((prev) => {
                if (!prev) return prev;
                const next = prev.map((c) => ({ ...c }));
                const c = next[cd.band];
                const lo = cd.band > 0 ? framesToHours(next[cd.band - 1].end) : 0;
                const hi = cd.band < next.length - 1 ? framesToHours(next[cd.band + 1].start) : HOURS;
                const s0 = framesToHours(c.start);
                const e0 = framesToHours(c.end);
                if (cd.edge === "start") {
                    c.start = hoursToFrames(clamp(x, lo, e0 - MIN_WIDTH_H));
                } else if (cd.edge === "end") {
                    c.end = hoursToFrames(clamp(x, s0 + MIN_WIDTH_H, hi));
                } else {
                    const width = Math.min(e0 - s0, hi - lo);
                    const ns = clamp(snapHours(e.point.x - cd.grabOffset), lo, hi - width);
                    c.start = hoursToFrames(ns);
                    c.end = hoursToFrames(ns + width);
                }
                return next;
            });
            return;
        }
        const d = dragRef.current;
        if (!d) return;
        const x = snapHours(clamp(e.point.x, 0, HOURS));
        setDraft((prev) => {
            if (!prev) return prev;
            const next = prev.map((b) => ({ ...b }));
            const b = next[d.band];
            const before = next[d.band - 1];
            const after = next[d.band + 1];
            const s = framesToHours(b.start);
            const en = framesToHours(b.end);
            // Neighbours bound the drag, and so do service hours: bands cannot be dragged or
            // moved into closed hours (the line does not run there, so a band would do nothing).
            const open = rangeFor(openRanges(closedRef.current), d.edge === "move" ? (s + en) / 2 : d.edge === "start" ? en : s);
            const lo = Math.max(before ? framesToHours(before.end) : 0, open[0]);
            const hi = Math.min(after ? framesToHours(after.start) : HOURS, open[1]);
            if (d.edge === "start") {
                b.start = hoursToFrames(clamp(x, lo, en - MIN_WIDTH_H));
            } else if (d.edge === "end") {
                b.end = hoursToFrames(clamp(x, s + MIN_WIDTH_H, hi));
            } else {
                // A band wider than the open stretch shrinks to fill it rather than poking out.
                const width = Math.min(en - s, hi - lo);
                const ns = clamp(snapHours(e.point.x - d.grabOffset), lo, hi - width);
                b.start = hoursToFrames(ns);
                b.end = hoursToFrames(ns + width);
            }
            // Whatever the edge, the band ends up inside [lo, hi]: an edge that was already in
            // closed hours (an oversized band, or one from before service hours were set) is
            // pulled in with it.
            b.start = hoursToFrames(clamp(framesToHours(b.start), lo, hi - MIN_WIDTH_H));
            b.end = hoursToFrames(clamp(framesToHours(b.end), framesToHours(b.start) + MIN_WIDTH_H, hi));
            return next;
        });
    }, []);

    const onMouseUp = useCallback(() => { if (dragRef.current || cDragRef.current) commit(); }, [commit]);
    const onMouseLeave = useCallback(() => { if (dragRef.current || cDragRef.current) commit(); }, [commit]);

    const interaction = vanilla.useSVGInteraction({ onMouseDown, onMouseMove, onMouseUp, onMouseLeave });
    useEffect(() => { interaction.updateViewport(viewport); }, [interaction, viewport]);
    const context = useMemo(() => ({ viewport, events: interaction.events }), [viewport, interaction]);
    useRegisterSVGContext(context);

    return (
        <div className={styles.timelineWrap}>
            <SVGContext.Provider value={context}>
                <SVGcomponent ref={svgRef} interaction={interaction} viewport={viewport} className={styles.svg}>
                    {viewport && <TimelineBody bands={shown} selected={cDraft ? -1 : selected} now={now} drag={drag} history={history} freight={freight} departures={departures} punctuality={punctuality}
                        closed={shownClosed} closedEditable={!!onClosedChange} closedDrag={cDrag} selectedClosed={selectedClosed} />}
                </SVGcomponent>
            </SVGContext.Provider>
            {history && history.some((s) => s.samples > 0) && (
                <div className={styles.legend}>
                    <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.swatchLoad)} />{freight ? " cargo load (full = track height)" : " load (full = track height)"}</span>
                    {!freight && <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.swatchQueue)} /> people waiting</span>}
                    {freight && <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.swatchFleet)} /> vehicles running (number at each change)</span>}
                    {freight && <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.swatchEmpty)} /> share running empty</span>}
                    {bands.some((b) => b.mode === BandMode.TargetLoad) && <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.swatchTarget)} /> target load range</span>}
                    <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.swatchOver)} /> overloaded hour</span>
                </div>
            )}
            {zoom.x !== 1 && (
                <button className={styles.zoomReset} onClick={resetViewport}>{Math.round(100 / zoom.x)}% - reset</button>
            )}
            {visibleShare < 1 && (
                <div ref={trackRef} className={styles.scrollTrack}
                    onMouseDown={(e) => { if (e.target === trackRef.current) scrollTo((e.clientX - trackRef.current.getBoundingClientRect().left) / trackRef.current.getBoundingClientRect().width - visibleShare / 2); }}>
                    <div className={styles.scrollThumb}
                        style={{ width: `${visibleShare * 100}%`, left: `${scrollFraction * (1 - visibleShare) * 100}%` }}
                        onMouseDown={onThumbDown} />
                </div>
            )}
        </div>
    );
};

/** The largest empty gap in the day, or null if the day is full. */
/**
 * Bands cut to the service hours: each band is intersected with every open stretch, so a band
 * crossing closed hours is split into its open pieces, and pieces shorter than the minimum band
 * are dropped. With no service hours the bands come back unchanged. Frames of the day in and out.
 */
export const clipToService = <B extends { start: number; end: number }>(bands: B[], closed?: Closed): B[] => {
    if (!closed || closed.length === 0) return bands;
    const open = openRanges(closed).map(([a, b]) => [hoursToFrames(a), hoursToFrames(b)]);
    const out: B[] = [];
    for (const band of bands) {
        for (const [a, b] of open) {
            const start = Math.max(band.start, a);
            const end = Math.min(band.end, b);
            if (end - start >= minutesToFrames(MIN_WIDTH_MIN)) out.push({ ...band, start, end });
        }
    }
    return out.sort((x, y) => x.start - y.start);
};

/** Closed periods merged: overlapping or touching ones joined, sorted, empty ones dropped. */
export const mergeClosed = (list: ClosedPeriod[]): ClosedPeriod[] => {
    const sorted = list.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start);
    const out: ClosedPeriod[] = [];
    for (const c of sorted) {
        const last = out[out.length - 1];
        if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
        else out.push({ start: c.start, end: c.end });
    }
    return out;
};

/**
 * "No service" bands retired: they are closed blocks now. Takes a band list (a line's, a
 * preset's, a rule's) and moves every Off band into `closed` — a band wrapping past midnight
 * becomes two periods — then clips the remaining bands to what is left open.
 */
export const offBandsToClosed = <B extends { start: number; end: number; mode: BandMode }>(bands: B[], closed: ClosedPeriod[]): { bands: B[]; closed: ClosedPeriod[] } => {
    const off = bands.filter((b) => b.mode === BandMode.Off);
    if (off.length === 0) return { bands, closed };
    const periods: ClosedPeriod[] = [...closed];
    for (const b of off) {
        if (b.start <= b.end) periods.push({ start: b.start, end: b.end });
        else { periods.push({ start: b.start, end: TICKS_PER_DAY }); periods.push({ start: 0, end: b.end }); }
    }
    const merged = mergeClosed(periods);
    return { bands: clipToService(bands.filter((b) => b.mode !== BandMode.Off), merged), closed: merged };
};

/** The widest free stretch for a new band, inside service hours when they are set. */
export const largestGap = (bands: Band[], closed?: Closed): { start: number; end: number } | null => {
    const sorted = [...bands].sort((a, b) => a.start - b.start);
    const open = openRanges(closed).map(([a, b]) => [hoursToFrames(a), hoursToFrames(b)]);
    let best: { start: number; end: number } | null = null;
    let cursor = 0;
    const consider = (gs: number, ge: number) => {
        for (const [a, b] of open) {
            const s = Math.max(gs, a);
            const e = Math.min(ge, b);
            if (e - s >= minutesToFrames(MIN_WIDTH_MIN) && (!best || e - s > best.end - best.start)) best = { start: s, end: e };
        }
    };
    for (const b of sorted) {
        consider(cursor, b.start);
        cursor = Math.max(cursor, b.end);
    }
    consider(cursor, TICKS_PER_DAY);
    return best;
};

export const sortBands = (bands: Band[]) => [...bands].sort((a, b) => a.start - b.start);
