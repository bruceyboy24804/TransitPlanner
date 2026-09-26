import { useMemo, useState } from "react";
import { useValue } from "cs2/api";
import { LocalizedEntityName } from "cs2/l10n";
import { Scrollable, Tooltip } from "cs2/ui";
import classNames from "classnames";
import { lines$, schedule$, selected$, stats$, timeOfDay$ } from "../bindings";
import { byLine, formatDuration, formatTimeOfDay, framesToMinutes, LineRow, sameEntity, TimetableFlags } from "../types";
import { vanilla } from "../vanilla";
import { TimetableEditor } from "./timetable-editor";
import { SplitHandle, useSplit } from "./split-handle";
import { TypeSelection } from "./type-sidebar";
import { typeLabel } from "./planner-panel";
import styles from "./planner.module.scss";

// The Timetable tab, built like Fleet and Depots from the transportation overview's own parts: a
// sortable table, one row per line of the sidebar's type, with its timetable at a glance (on/off,
// anchor stop, first departure, interval or set times, timing points, punctuality). Selecting a
// row selects the line everywhere and opens its timetable editor under the table.

const cssColor = (c: LineRow["color"]) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;

type SortKey = "name" | "on" | "first" | "every" | "points" | "ontime" | "late";
const sorters: Record<SortKey, (r: LineRow) => number> = {
    name: (r) => r.entity.index,
    on: (r) => (r.timetable ? 1 : 0),
    first: (r) => (r.timetable ? r.ttFirst : Number.MAX_SAFE_INTEGER),
    every: (r) => (r.timetable ? ((r.ttFlags & TimetableFlags.List) ? -r.ttDepartures : r.ttInterval) : Number.MAX_SAFE_INTEGER),
    points: (r) => r.ttTimingPoints,
    // Unmeasured lines sort after every measured one.
    ontime: (r) => (r.ttOnTime >= 0 ? r.ttOnTime : 2),
    late: (r) => (r.ttOnTime >= 0 ? r.ttLate : -1),
};

const every = (r: LineRow) =>
    (r.ttFlags & TimetableFlags.List) ? `${r.ttDepartures} set` : `${Math.max(1, Math.round(framesToMinutes(r.ttInterval)))} min`;

/** The selected line's timetable editor, under the table. */
const Detail = ({ line, height }: { line: LineRow; height: number }) => {
    const stats = useValue(stats$.binding);
    const schedule = useValue(schedule$.binding);
    const now = useValue(timeOfDay$.binding);
    const ready = stats.valid && sameEntity(stats.entity, line.entity) && sameEntity(schedule.entity, line.entity);
    return (
        <div className={classNames(styles.bulk, styles.ttDetail)} style={{ height }}>
            <div className={styles.row}>
                <div className={styles.swatch} style={{ backgroundColor: cssColor(line.color) }} />
                <span className={styles.sectionTitle}><LocalizedEntityName value={line.name} /></span>
                <span className={styles.spacer} />
                {ready && <span className={styles.inlineHint}>{`Headway ${formatDuration(stats.headway)} · loop ${formatDuration(stats.stableDuration)} · ${stats.fleet}/${stats.target} vehicles`}</span>}
            </div>
            <Scrollable vertical className={styles.ttDetailScroll}>
                {ready ? <TimetableEditor schedule={schedule} stats={stats} now={now} /> : <div className={styles.empty}>Reading line…</div>}
            </Scrollable>
        </div>
    );
};

export const TimetablePanel = ({ typeSel }: { typeSel: TypeSelection }) => {
    const page = vanilla.overviewPage;
    const item = vanilla.lineItem;
    const { PanelSection } = vanilla;
    const all = useValue(lines$.binding);
    const selected = useValue(selected$.binding);
    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [ascending, setAscending] = useState(true);
    const sortBy = (k: SortKey) => { if (k === sortKey) setAscending(!ascending); else { setSortKey(k); setAscending(k === "name"); } };

    const shown = useMemo(() => {
        const f = sorters[sortKey];
        return all.filter((l) => l.type === typeSel.type && (l.cargo ?? false) === typeSel.cargo)
            .sort(byLine)
            .sort((a, b) => (ascending ? f(a) - f(b) : f(b) - f(a)));
    }, [all, typeSel, sortKey, ascending]);
    const current = shown.find((l) => sameEntity(l.entity, selected));
    const [detailH, setDetailH] = useSplit("timetable", 520);

    const Head = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
        <div className={classNames(page.cellDouble, className)}>
            <button className={page.button} onClick={() => sortBy(k)}>
                <div className={page.buttonLabel}>{children}</div>
                {sortKey === k && <img className={page.sortIndicator} src={`Media/Glyphs/ThickStrokeArrow${ascending ? "Down" : "Up"}.svg`} />}
            </button>
        </div>
    );

    return (
        <div className={classNames(page.transportationOverviewPage, styles.fleetPage)}>
            <PanelSection theme={vanilla.panelSection} className={classNames(page.lines, styles.fleetLines)} header={
                <div className={page.header}>
                    <div className={page.title}>{`${typeLabel[typeSel.type] ?? "?"} timetables`.toUpperCase()}</div>
                    <div className={page.legends}>
                        <div className={page.cellSingle} />
                        <div className={classNames(page.cellWide, page.alignLeft)}>
                            <button className={page.button} onClick={() => sortBy("name")}><div className={page.buttonLabel}>Name</div></button>
                        </div>
                        <Head k="on">Timetable</Head>
                        <div className={classNames(page.cellWide, page.alignLeft)}><div className={page.buttonLabel}>From</div></div>
                        <Head k="first">First</Head>
                        <Head k="every">Every</Head>
                        <Head k="points">Timing pts</Head>
                        <Head k="ontime">On time</Head>
                        <Head k="late">Late</Head>
                    </div>
                </div>}>
                <Scrollable vertical className={classNames(page.scrollable, styles.fleetScroll)}>
                    {shown.length === 0 && <div className={page.noLines}>No lines</div>}
                    {shown.map((l) => {
                        const on = sameEntity(l.entity, selected);
                        const measured = l.timetable && l.ttOnTime >= 0;
                        return (
                            <div key={l.entity.index} className={item.transportationLineItem}>
                                <div className={classNames(item.container, on && styles.pickedRow)} onClick={() => selected$.set(l.entity)}>
                                    <div className={page.cellSingle}><div className={styles.swatch} style={{ backgroundColor: cssColor(l.color) }} /></div>
                                    <div className={classNames(page.cellWide, page.alignLeft)}><LocalizedEntityName value={l.name} /></div>
                                    <div className={page.cellDouble}>{l.timetable ? "On" : <span className={styles.dim}>Off</span>}</div>
                                    <div className={classNames(page.cellWide, page.alignLeft)}>{l.timetable && l.ttAnchor ? <LocalizedEntityName value={l.ttAnchor} /> : "—"}</div>
                                    <div className={page.cellDouble}>{l.timetable && !(l.ttFlags & TimetableFlags.List) ? formatTimeOfDay(l.ttFirst) : "—"}</div>
                                    <div className={page.cellDouble}>{l.timetable ? every(l) : "—"}</div>
                                    <div className={page.cellDouble}>{l.timetable ? (l.ttTimingPoints || "anchor") : "—"}</div>
                                    <div className={classNames(page.cellDouble, measured && l.ttOnTime < 0.8 && styles.warn)}>
                                        {measured ? `${Math.round(l.ttOnTime * 100)}%` : "—"}
                                    </div>
                                    <div className={page.cellDouble}>
                                        {measured ? (
                                            <Tooltip tooltip="Average departure lateness at the anchor and timing points">
                                                <span>{formatDuration(l.ttLate)}</span>
                                            </Tooltip>
                                        ) : "—"}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </Scrollable>

                {current && <SplitHandle height={detailH} onHeight={setDetailH} />}
                {current ? <Detail line={current} height={detailH} /> : (
                    <div className={styles.bulk}>
                        <span className={styles.sectionTitle}>Select a line to edit its timetable</span>
                    </div>
                )}
            </PanelSection>
        </div>
    );
};
