import { useMemo, useRef, useState } from "react";
import { useChartStyle } from "./chart-style";
import { useRem } from "cs2/utils";
import { useValue } from "cs2/api";
import { transport } from "cs2/bindings";
import { LocalizedEntityName, useLocalization } from "cs2/l10n";
import { Scrollable, Tooltip } from "cs2/ui";
import classNames from "classnames";
import { cargo$, goTo, schedule$, setSchedule, stats$, timeOfDay$ } from "../bindings";
import { CargoInfo, CargoStop, formatDuration, framesToMinutes, LineRow, minutesToFrames, ResourceAmount, sameEntity, Schedule } from "../types";
import { FlatButton } from "./flat-button";
import { toggleWait, waitAt, WaitSettings } from "./wait-settings";
import { vanilla } from "../vanilla";
import { hsl } from "../colour";
import { DepotPicker } from "./depot-picker";
import { ScheduleEditor } from "./schedule-editor";
import { MareyChart, useMareyHistory } from "./marey-chart";
import { HelpTitle } from "./encyclopedia";
import styles from "./planner.module.scss";

// The Planner for a freight line. A passenger line's page (fares, unbunching, waiting passengers)
// mostly does not apply to freight, so a cargo line gets its own: a freight header (utilisation,
// empty running), a flow diagram of the loop (each leg as thick as the cargo on it, coloured by
// what it carries, grey when running empty), a station table with the game's own surplus /
// deficit rating per resource, and the schedule without the passenger-only rows.
// Data: the `cargo` binding (TP_PlannerUISystem.Cargo.cs).

/** A stable hue per resource id, so each resource keeps its colour everywhere. */
export const resourceHue = (key: string) => {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
    return hsl(h, 0.6, 0.55);
};

/**
 * A cargo amount as the game shows it: amounts are kilograms and its panels read in tonnes
 * (a cargo train "0.06 / 1.2 kt" is 60 000 of 1 200 000 here).
 */
export const fmt = (kg: number) =>
    kg >= 1_000_000 ? `${(kg / 1_000_000).toFixed(kg >= 10_000_000 ? 0 : 1)} kt`
        : kg >= 1000 ? `${Math.round(kg / 1000)} t`
        : `${kg} kg`;

export const useResourceName = () => {
    const { translate } = useLocalization();
    return (key: string) => translate(`Resources.TITLE[${key}]`, key) ?? key;
};

const statusClass = (s?: string | null) => (s === "Deficit" ? styles.resDeficit : s === "Surplus" ? styles.resSurplus : undefined);

/** A resource as icon + amount (and its station rating, when it has one), named in the tooltip. */
export const ResourceChip = ({ r }: { r: ResourceAmount }) => {
    const name = useResourceName();
    const rating = r.status === "Deficit" ? " · running low" : r.status === "Surplus" ? " · surplus" : "";
    return (
        <Tooltip tooltip={`${name(r.key)}: ${fmt(r.amount)}${rating}`}>
            <span className={classNames(styles.resChip, statusClass(r.status))}>
                <img className={styles.resIcon} src={`Media/Game/Resources/${r.key}.svg`} />
                <span>{fmt(r.amount)}</span>
            </span>
        </Tooltip>
    );
};

export const ResourceChips = ({ list, max = 4 }: { list: ResourceAmount[]; max?: number }) =>
    list.length === 0 ? <span className={styles.dim}>—</span> : (
        <span className={styles.resChips}>
            {list.slice(0, max).map((r) => <ResourceChip key={r.key} r={r} />)}
            {list.length > max && <span className={styles.dim}>{`+${list.length - max}`}</span>}
        </span>
    );

const Stat = ({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
    <div className={styles.stat}>
        <div className={styles.statLabel}>{label}</div>
        <div className={classNames(styles.statValue, warn && styles.warn)}>{value}</div>
    </div>
);

/** The worst rating at a station: Deficit beats Surplus beats Normal. */
const stationRating = (s: CargoStop) =>
    s.stock.some((r) => r.status === "Deficit") ? "Deficit" : s.stock.some((r) => r.status === "Surplus") ? "Surplus" : s.stock.length ? "Normal" : "";

// The game's production chart palette (production-colors.module.scss), in the order the line's
// resources are given it; everything past it folds into "Other" in the chart's neutral grey.
const PALETTE = ["#4b91e2", "#f5a524", "#8cdb48", "#4bc3f1", "#41d880"];
const OTHER = "__other";
const OTHER_COLOUR = "#808080";

/**
 * The line's resources ranked by how much of each is moving over the whole loop, the top ones
 * given the palette's colours, and each leg's cargo folded to those plus "Other".
 */
const useFlowPalette = (info: CargoInfo) => {
    const totals = new Map<string, number>();
    for (const st of info.stops) for (const r of st.leg) totals.set(r.key, (totals.get(r.key) ?? 0) + r.amount);
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const named = ranked.slice(0, PALETTE.length);
    const colour = (key: string) => (key === OTHER ? OTHER_COLOUR : PALETTE[named.indexOf(key)] ?? OTHER_COLOUR);
    /** A leg's cargo in the palette's order, the rest summed into Other. */
    const fold = (list: ResourceAmount[]): ResourceAmount[] => {
        const out = named.map((k) => ({ key: k, amount: list.find((r) => r.key === k)?.amount ?? 0 }));
        const other = list.filter((r) => !named.includes(r.key)).reduce((a, r) => a + r.amount, 0);
        if (other > 0) out.push({ key: OTHER, amount: other });
        return out.filter((r) => r.amount > 0);
    };
    return { colour, fold, named };
};

/** A band from (x0, y0..y0+h0) to (x1, y1..y1+h1), its edges cubic curves like the game's Sankey links. */
const bandPath = (x0: number, y0: number, h0: number, x1: number, y1: number, h1: number) => {
    const mx = (x0 + x1) / 2;
    return `M${x0} ${y0} C${mx} ${y0} ${mx} ${y1} ${x1} ${y1} L${x1} ${y1 + h1} C${mx} ${y1 + h1} ${mx} ${y0 + h0} ${x0} ${y0 + h0} Z`;
};

/**
 * The line's freight as a Sankey in the manner of the game's Production Data chart: a bar per
 * station in loop order (the first again at the end, so the return leg closes the loop), and
 * between two bars the leg's cargo as bands, one per resource, as thick as its tonnage. Each
 * leg's stack is centred on the bars at both of its ends, and a bar is as tall as the busier of
 * its legs, so bands bend where the cargo changes from one leg to the next — loading and
 * unloading show as the flow widening or narrowing through a station. Resources take the chart's
 * palette in order of how much of each moves; the rest are "Other". Bars are coloured by the
 * station's rating (the chart's deficit red / normal grey, surplus amber).
 *
 * Drawn here rather than reused: the game's chart renders with a Sankey library its bundle does
 * not expose (only the finished production widget is registered, and it loads its own data).
 */
const FlowSankey = ({ info }: { info: CargoInfo }) => {
    const host = useRef<HTMLDivElement | null>(null);
    const rect = vanilla.useElementRect(host);
    const rem = useRem();
    const name = useResourceName();
    const { colour, fold } = useFlowPalette(info);
    const W = rect?.width ?? 0;
    const n = info.stops.length;
    const nameH = rem * 18;
    const flowH = rem * 120;             // the busiest leg's height
    const H = nameH + flowH + rem * 10;
    const mid = nameH + flowH / 2;       // everything is centred on this line
    const barW = rem * 8;
    const cols = n + 1;
    const colX = (c: number) => (cols <= 1 ? 0 : (c * (W - barW)) / (cols - 1));
    // Leg c runs from column c to c + 1: its cargo is the leg INTO stop c + 1.
    const leg = (c: number) => info.stops[(c + 1) % n];
    const biggest = Math.max(1, ...info.stops.map((st) => st.legCarried));
    const scale = flowH / biggest;
    const legH = (c: number) => leg(((c % n) + n) % n).legCarried * scale;
    const barH = (c: number) => Math.max(rem * 4, c > 0 ? legH(c - 1) : 0, c < n ? legH(c) : 0);
    const barColour = (st: CargoStop) => {
        const r = stationRating(st);
        return r === "Deficit" ? "#e95f49" : r === "Surplus" ? "#f5a524" : "#808080";
    };

    return (
        <div ref={host} className={styles.flow} style={{ height: `${H}px` }}>
            {W > 0 && n > 1 && (
                <>
                    <svg width={W} height={H} className={styles.flowSvg}>
                        {Array.from({ length: n }, (_, c) => {
                            const st = leg(c);
                            const x0 = colX(c) + barW, x1 = colX(c + 1);
                            if (st.legCarried === 0) {
                                // No cargo on the leg: a thin dashed guide, so the loop still reads.
                                return <line key={c} x1={x0} x2={x1} y1={mid} y2={mid} stroke="rgba(255,255,255,0.3)" strokeWidth={1.5} strokeDasharray={`${rem * 5} ${rem * 4}`} />;
                            }
                            // Each end stacks from the top of its own station bar, as a Sankey link leaves
                            // and enters its nodes: bars of different height put the two ends at
                            // different heights, which is what bends the bands.
                            let y0 = mid - barH(c) / 2, y1 = mid - barH(c + 1) / 2;
                            return (
                                <g key={c}>
                                    {fold(st.leg).map((r) => {
                                        const h = r.amount * scale;
                                        const d = bandPath(x0, y0, h, x1, y1, h);
                                        y0 += h; y1 += h;
                                        return <path key={r.key} d={d} fill={colour(r.key)} fillOpacity={0.66} />;
                                    })}
                                </g>
                            );
                        })}
                        {Array.from({ length: cols }, (_, c) => {
                            const h = barH(c);
                            return <rect key={`b${c}`} x={colX(c)} y={mid - h / 2} width={barW} height={h} rx={3} fill={barColour(info.stops[c % n])} />;
                        })}
                    </svg>
                    {/* Band labels (icon + tonnage) where a band is tall enough; "Other" and small bands keep to the tooltip-less legend. */}
                    {Array.from({ length: n }, (_, c) => {
                        const st = leg(c);
                        const x0 = colX(c) + barW;
                        const out: JSX.Element[] = [];
                        if (st.legCarried === 0) {
                            out.push(<div key={`e${c}`} className={styles.sankeyNote} style={{ left: `${x0 + rem * 8}px`, top: `${mid - rem * 16}px` }}>
                                {st.legVehicles === 0 ? "no vehicle on this leg" : `${st.legVehicles} running empty`}
                            </div>);
                            return out;
                        }
                        const total = st.legCarried * scale;
                        let y = mid - barH(c) / 2;
                        for (const r of fold(st.leg)) {
                            const h = r.amount * scale;
                            if (h >= rem * 15 && r.key !== OTHER) {
                                out.push(
                                    <Tooltip key={`${c}${r.key}`} tooltip={`${name(r.key)}: ${fmt(r.amount)}`}>
                                        <div className={styles.sankeyLabel} style={{ left: `${x0 + rem * 8}px`, top: `${y + h / 2 - rem * 9}px` }}>
                                            <img className={styles.resIcon} src={`Media/Game/Resources/${r.key}.svg`} />
                                            <span>{fmt(r.amount)}</span>
                                        </div>
                                    </Tooltip>,
                                );
                            }
                            y += h;
                        }
                        if (st.legCapacity > 0) {
                            out.push(<div key={`f${c}`} className={classNames(styles.sankeyNote, styles.sankeyFull)} style={{ left: `${colX(c + 1) - rem * 6}px`, top: `${mid - barH(c + 1) / 2 + legH(c) + rem * 3}px` }}>
                                {`${Math.round((100 * st.legCarried) / st.legCapacity)}% full · ${st.legVehicles} vehicle${st.legVehicles === 1 ? "" : "s"}`}
                            </div>);
                        }
                        return out;
                    })}
                    {/* Station names above: the first runs right, the last left, the rest centred on their bar. */}
                    {Array.from({ length: cols }, (_, c) => {
                        const st = info.stops[c % n];
                        const cls = c === 0 ? styles.flowStopFirst : c === cols - 1 ? styles.flowStopLast : styles.flowStopMid;
                        const left = c === 0 ? colX(c) : c === cols - 1 ? colX(c) + barW : colX(c) + barW / 2;
                        return (
                            <div key={`s${c}`} className={classNames(styles.flowStopLabel, styles.sankeyStation, cls)}
                                style={{ left: `${left}px`, top: `0px`, maxWidth: `${Math.max(rem * 80, W / cols - rem * 6)}px` }}
                                onClick={() => goTo(st.station.index ? st.station : st.stop)}>
                                <LocalizedEntityName value={st.station.index ? st.stationName : st.name} />
                            </div>
                        );
                    })}
                </>
            )}
        </div>
    );
};

/**
 * The line's load profile — transit planning's standard line diagram: stations along the bottom in
 * loop order, one column per leg, each column's cargo stacked by resource from the floor, and a
 * ghost box behind it for the capacity of the vehicles on that leg. The tallest box is the scale,
 * so where the line runs full and where it runs empty reads at a glance; tonnes loaded / unloaded
 * are the step between neighbouring columns.
 */
const LoadProfile = ({ info }: { info: CargoInfo }) => {
    const name = useResourceName();
    const nameOf = vanilla.useNameFormat();
    const { axis, base } = useChartStyle();
    const { colour, fold, named } = useFlowPalette(info);
    const n = info.stops.length;
    // Leg c runs from stop c to stop c + 1 (its cargo is the leg INTO stop c + 1).
    const legs = info.stops.map((_, c) => info.stops[(c + 1) % n]);
    const keys = [...named, OTHER].filter((k) => legs.some((st) => fold(st.leg).some((r) => r.key === k)));
    const amount = (st: CargoStop, k: string) => fold(st.leg).find((r) => r.key === k)?.amount ?? 0;
    const stationName = (st: CargoStop) => nameOf(st.station.index ? st.stationName : st.name);
    const data = useMemo(() => ({
        // Two-line labels: where the leg ends, and how full it runs.
        labels: legs.map((st) => [
            `\u2192 ${stationName(st)}`,
            st.legVehicles === 0 ? "no vehicle" : st.legCapacity > 0 ? `${Math.round((100 * st.legCarried) / st.legCapacity)}% full` : fmt(st.legCarried),
        ]),
        datasets: [
            ...keys.map((k) => ({
                type: "bar", label: k, stack: "leg",
                data: legs.map((st) => amount(st, k)),
                backgroundColor: colour(k), borderWidth: 0,
            })),
            // The room left, stacked on top: cargo + this = the capacity running on the leg.
            {
                type: "bar", label: "__room", stack: "leg",
                data: legs.map((st) => Math.max(0, st.legCapacity - st.legCarried)),
                backgroundColor: "rgba(255, 255, 255, 0.07)", borderColor: "rgba(255, 255, 255, 0.25)", borderWidth: 1,
            },
        ],
    }), [info]);
    const options = useMemo(() => ({
        ...base,
        scales: {
            x: axis({ stacked: true, grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0 } }),
            y: axis({ stacked: true, beginAtZero: true, ticks: { maxTicksLimit: 6, callback: (v: number) => fmt(v) } }),
        },
    }), [base, axis]);

    return (
        <Tooltip tooltip={legs.map((st) => `${stationName(st)}: ${st.legVehicles === 0 ? "no vehicle" : `${fmt(st.legCarried)} of ${fmt(st.legCapacity)}` +
            fold(st.leg).map((r) => ` · ${r.key === OTHER ? "Other" : name(r.key)} ${fmt(r.amount)}`).join("")}`).join("\n")}>
            <div>
                {n > 1 && <vanilla.ResponsiveChart type="bar" data={data} options={options} className={styles.chart} />}
            </div>
        </Tooltip>
    );
};

/** The key: the line's resources in their palette colours, then the station bar colours. */
const FlowLegend = ({ info, stations }: { info: CargoInfo; stations?: boolean }) => {
    const { colour, named } = useFlowPalette(info);
    const name = useResourceName();
    const hasOther = info.stops.some((st) => st.leg.some((r) => !named.includes(r.key)));
    const L = vanilla.ColorLegend;
    return (
        <div className={styles.flowLegend}>
            {named.map((k) => <L key={k} color={colour(k)} label={name(k)} className={styles.flowKey} />)}
            {hasOther && <L color={OTHER_COLOUR} label="Other" className={styles.flowKey} />}
            {stations ? (
                <>
                    <L color="#e95f49" label="station running low" className={styles.flowKey} />
                    <L color="#f5a524" label="surplus" className={styles.flowKey} />
                    <L color="#808080" label="balanced" className={styles.flowKey} />
                </>
            ) : <L color="rgba(255, 255, 255, 0.25)" label="room left" className={styles.flowKey} />}
        </div>
    );
};

/** Per station: what the leg in brings, what it holds against its capacity, and the game's rating. */
const StationTable = ({ info, schedule }: { info: CargoInfo; schedule: Schedule | null }) => {

    const page = vanilla.overviewPage;
    const item = vanilla.lineItem;
    return (
        <>
            <div className={page.header}>
                <div className={page.legends}>
                    <div className={classNames(page.cellWide, page.alignLeft)}><div className={page.buttonLabel}>Station</div></div>
                    <div className={classNames(page.cellWide, page.alignLeft)}><div className={page.buttonLabel}>Arriving</div></div>
                    <div className={classNames(page.cellWide, page.alignLeft)}><div className={page.buttonLabel}>Holds</div></div>
                    <div className={page.cellDouble}><div className={page.buttonLabel}>Stored</div></div>
                    <div className={page.cellDouble}><div className={page.buttonLabel}>Status</div></div>
                    <div className={page.cellDouble}><div className={page.buttonLabel}>Wait for load</div></div>
                </div>
            </div>
            {info.stops.map((s, k) => {
                const rating = stationRating(s);
                return (
                    <div key={k} className={item.transportationLineItem}>
                        <div className={item.container} onClick={() => goTo(s.station.index ? s.station : s.stop)}>
                            <div className={classNames(page.cellWide, page.alignLeft)}><LocalizedEntityName value={s.station.index ? s.stationName : s.name} /></div>
                            <div className={classNames(page.cellWide, page.alignLeft)}>
                                {s.legVehicles === 0 ? <span className={styles.dim}>none on the way</span>
                                    : s.legCarried === 0 ? <span className={styles.dim}>{`${s.legVehicles} empty`}</span>
                                    : <ResourceChips list={s.leg} max={3} />}
                            </div>
                            <div className={classNames(page.cellWide, page.alignLeft)}><ResourceChips list={s.stock} max={3} /></div>
                            <div className={page.cellDouble}>{s.capacity > 0 ? `${Math.round((100 * s.stored) / s.capacity)}%` : fmt(s.stored)}</div>
                            <div className={classNames(page.cellDouble, rating === "Deficit" && styles.warn, rating === "Surplus" && styles.resSurplus)}>
                                {rating === "Deficit" ? "Running low" : rating === "Surplus" ? "Surplus" : rating === "Normal" ? "Balanced" : "—"}
                            </div>
                            <div className={page.cellDouble} onClick={(e) => e.stopPropagation()}>
                                <Tooltip tooltip="Vehicles loading here wait until they are full enough, or until the longest wait runs out">
                                    <div><vanilla.Checkbox checked={!!schedule && !!waitAt(schedule, s.waypoint)} onChange={() => schedule && toggleWait(schedule, s.waypoint)} /></div>
                                </Tooltip>
                            </div>
                        </div>
                    </div>
                );
            })}
        </>
    );
};

export const FreightDetail = ({ line, onOpenTimetable }: { line: LineRow; onOpenTimetable: () => void }) => {
    const stats = useValue(stats$.binding);
    const schedule = useValue(schedule$.binding);
    const info = useValue(cargo$.binding);
    const now = useValue(timeOfDay$.binding);
    const name = useResourceName();
    const [view, setView] = useState<"profile" | "flow" | "time">("profile");
    // Records vehicle positions for the time–distance view whichever view is showing.
    useMareyHistory(line.entity);
    if (!stats.valid || !sameEntity(stats.entity, line.entity)) return <div className={styles.empty}>Reading line…</div>;
    const ready = info.valid && sameEntity(info.entity, line.entity);
    const util = ready && info.capacity > 0 ? info.carried / info.capacity : 0;
    const empty = ready && info.vehicles > 0 ? info.emptyVehicles / info.vehicles : 0;
    const palette = useFlowPalette(info);

    return (
        <Scrollable vertical className={styles.detail}>
            <div className={classNames(styles.detailTitle, styles.row)}>
                <vanilla.ColorField value={line.color} className={styles.detailColor} onChange={(c) => transport.setLineColor(line.entity, c)} />
                <LocalizedEntityName value={line.name} />
                <span className={styles.badge}>freight</span>
            </div>

            <div className={styles.statGrid}>
                <Stat label="Vehicles" value={`${stats.fleet} / ${stats.target}`} warn={stats.notEnoughVehicles} />
                <Stat label="Every" value={formatDuration(stats.headway)} />
                <Stat label="Loop" value={formatDuration(stats.stableDuration)} />
                <Stat label="Stations" value={ready ? `${info.stops.length}` : "—"} />
                <Stat label="Utilisation" value={ready ? `${Math.round(util * 100)}%` : "—"} />
                <Stat label="Carrying" value={ready ? `${fmt(info.carried)} / ${fmt(info.capacity)}` : "—"} />
                <Stat label="Running empty" value={ready ? `${info.emptyVehicles} of ${info.vehicles}` : "—"} warn={empty >= 0.5} />
                <Stat label="Main cargo" value={ready && info.aboard[0] ? name(info.aboard[0].key) : "—"} />
            </div>

            {ready && (
                <>
                    <HelpTitle className={styles.sectionTitle} title="Flow" section="freight.page" />
                    {/* The fleet's load by resource, as shares of its whole capacity — only when there is some. */}
                    {info.carried > 0 ? (
                        <Tooltip tooltip={palette.fold(info.aboard).map((r) => `${r.key === OTHER ? "Other" : name(r.key)}: ${fmt(r.amount)}`).join("\n")}>
                            {/* The info panels' stacked bar: shares of the fleet's whole capacity. */}
                            <div className={styles.resBar}>
                                <vanilla.BarChart
                                    colors={palette.fold(info.aboard).map((r) => palette.colour(r.key))}
                                    data={{ values: palette.fold(info.aboard).map((r) => r.amount), total: Math.max(1, info.capacity) }} />
                            </div>
                        </Tooltip>
                    ) : (
                        <div className={styles.hint}>{info.vehicles === 0 ? "No vehicles on the line right now." : "Nothing aboard right now."}</div>
                    )}
                    <div className={styles.row}>
                        <FlatButton selected={view === "profile"} onClick={() => setView("profile")} tooltip="Load on each leg against the capacity running on it">Load profile</FlatButton>
                        <FlatButton selected={view === "flow"} onClick={() => setView("flow")} tooltip="Cargo as bands flowing through the stations">Flow</FlatButton>
                        <FlatButton selected={view === "time"} onClick={() => setView("time")} tooltip="Where every vehicle was over the last hours (Marey chart)">Time–distance</FlatButton>
                    </div>
                    {view === "profile" ? <LoadProfile info={info} /> : view === "flow" ? <FlowSankey info={info} /> : <MareyChart line={line.entity} />}
                    {view !== "time" && <FlowLegend info={info} stations={view === "flow"} />}

                    <HelpTitle className={styles.sectionTitle} title="Stations" section="freight.wait" />
                    <StationTable info={info} schedule={sameEntity(schedule.entity, line.entity) ? schedule : null} />
                    {sameEntity(schedule.entity, line.entity) && <WaitSettings schedule={schedule} />}
                </>
            )}

            {sameEntity(schedule.entity, line.entity) && <ScheduleEditor schedule={schedule} now={now} line={line} stats={stats} onOpenTimetable={onOpenTimetable} freight />}

            <DepotPicker line={line} />
        </Scrollable>
    );
};
