import { useMemo, useState } from "react";
import classNames from "classnames";
import { useValue } from "cs2/api";
import { LocalizedEntityName } from "cs2/l10n";
import { lineMap$, pulseTimetable, setSchedule } from "../bindings";
import { departuresOfDay, offsetsFromAnchor } from "../timetable";
import { formatDuration, formatTimeOfDay, framesToMinutes, LineStats, minutesToFrames, sameEntity, Schedule, TimetableFlags, TimingPoint, TICKS_PER_DAY } from "../types";
import { vanilla } from "../vanilla";
import { Scrollable } from "cs2/ui";
import { FlatButton } from "./flat-button";
import { SelectDropdown } from "./select-dropdown";
import dd from "./model-dropdown.module.scss";
import { SliderField } from "./slider-field";
import { HelpButton } from "./encyclopedia";
import styles from "./planner.module.scss";
import anchorIcon from "../images/anchor.svg";
import timingIcon from "../images/timing-point.svg";

// Line-level: clock-time departures from one anchor stop. Vehicles boarding there are held until
// the next slot (TP_TimetableSystem raises the vehicle's m_DepartureFrame, the field vanilla's
// headway hold uses); timing points hold them again at slot + offset; other stops keep the
// headway hold.

const Field = ({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) => (
    <div className={styles.row}>
        <span className={styles.fieldLabel}>{label}</span>
        {children}
        {help && <HelpButton section={help} inline />}
    </div>
);

export const withTimetableDefaults = (s: Schedule): Schedule => ({
    ...s,
    timetableFlags: s.timetableFlags ?? 0,
    timetableLateTolerance: s.timetableLateTolerance ?? 0,
    timetableResync: s.timetableResync || 2,
    timetableSlack: s.timetableSlack ?? 0,
    timetableDepartures: s.timetableDepartures ?? [],
    timingPoints: s.timingPoints ?? [],
});

/** A game glyph tinted with the text colour: a mask on a div (an <img> would paint over it); the url must be inline. */
const Glyph = ({ src, className }: { src: string; className?: string }) => (
    <div className={classNames(styles.glyph, className)} style={{ maskImage: `url(${src})`, WebkitMaskImage: `url(${src})` } as React.CSSProperties} />
);

const has = (flags: number, f: number) => (flags & f) !== 0;
const withFlag = (flags: number, f: number, on: boolean) => (on ? flags | f : flags & ~f);
const COLUMNS = 6;

export const TimetableEditor = ({ schedule: raw, stats, now = 0 }: { schedule: Schedule; stats: LineStats; now?: number }) => {
    // A DLL older than this UI sends none of the v2 fields; default them rather than crash.
    const schedule = withTimetableDefaults(raw);
    const stops = stats.stops;
    const set = (p: Partial<Schedule>) => setSchedule({ ...schedule, ...p });
    const flags = schedule.timetableFlags;
    const setFlag = (f: number, on: boolean) => set({ timetableFlags: withFlag(flags, f, on) });

    // The anchor, by waypoint index (corners are not in `stops`).
    const anchor = stops.find((s) => s.waypoint === schedule.timetableStop);

    // Other lines at the anchor, from the line map's transfer list (same stop or same station).
    const map = useValue(lineMap$.binding);
    const transfers = anchor ? map.stops.find((s) => sameEntity(s.entity, anchor.stop))?.transfers ?? [] : [];

    const derived = useMemo(() => offsetsFromAnchor(stats.legs, schedule.timetableStop, schedule.timetableSlack), [stats.legs, schedule.timetableStop, schedule.timetableSlack]);
    const pointAt = (wp: number) => schedule.timingPoints.find((p) => p.waypoint === wp);
    const allPoints = (): TimingPoint[] => stops.filter((s) => s.waypoint !== schedule.timetableStop).map((s) => ({ waypoint: s.waypoint, offset: derived[s.waypoint] ?? 0 }));
    const togglePoint = (wp: number) => set({
        timingPoints: pointAt(wp) ? schedule.timingPoints.filter((p) => p.waypoint !== wp) : [...schedule.timingPoints, { waypoint: wp, offset: derived[wp] ?? 0 }],
    });
    // Offsets follow the slack: re-derive every existing point when it moves.
    const setSlack = (slack: number) => {
        const d = offsetsFromAnchor(stats.legs, schedule.timetableStop, slack);
        set({ timetableSlack: slack, timingPoints: schedule.timingPoints.map((p) => ({ ...p, offset: d[p.waypoint] ?? p.offset })) });
    };

    const listMode = has(flags, TimetableFlags.List);
    const departures = useMemo(() => departuresOfDay(schedule), [schedule]);
    const [addAt, setAddAt] = useState(Math.round(framesToMinutes(schedule.timetableFirst) / 5));

    const punct = (stats.punctuality ?? []).filter((p) => p.samples > 0);
    const onTime = punct.length ? punct.reduce((a, p) => a + p.onTime, 0) / punct.length : -1;
    const late = punct.length ? punct.reduce((a, p) => a + p.late, 0) / punct.length : 0;

    const formatName = vanilla.useNameFormat();
    const turnOn = () => set({
        timetable: !schedule.timetable,
        timetableInterval: schedule.timetableInterval || Math.round(minutesToFrames(10)),
        timetableStop: anchor?.waypoint ?? stops[0]?.waypoint ?? 0,
        timetableResync: schedule.timetableResync || 2,
    });

    return (
        <>
            <Field label="Timetable">
                <SelectDropdown<boolean> className={styles.selectNarrow} options={[["Off", false], ["On", true]]} value={schedule.timetable} onChange={(on) => on !== schedule.timetable && turnOn()} />
                {schedule.timetable && stops.length > 0 && (
                    <>
                        <span className={styles.inlineHint}>from</span>
                        {/* The anchor, by waypoint index; moving it drops the timing points (their offsets were from the old anchor). */}
                        <SelectDropdown<number> className={styles.selectWide} options={stops.map((s) => [formatName(s.name), s.waypoint] as [string, number])} value={schedule.timetableStop}
                            onChange={(wp) => set({ timetableStop: wp, timingPoints: [] })} />
                    </>
                )}
            </Field>
            {schedule.timetable && (
                <>
                    <Field label="Departures">
                        {/* Set times start from the current grid, so switching never leaves the list empty. */}
                        <SelectDropdown<boolean> options={[["Every …", false], ["At set times", true]]} value={listMode}
                            onChange={(list) => set(list
                                ? { timetableFlags: withFlag(flags, TimetableFlags.List, true), timetableDepartures: schedule.timetableDepartures.length ? schedule.timetableDepartures : departures }
                                : { timetableFlags: withFlag(flags, TimetableFlags.List, false) })} />
                        {!listMode && (
                            <FlatButton selected={has(flags, TimetableFlags.FollowBands)} onClick={() => setFlag(TimetableFlags.FollowBands, !has(flags, TimetableFlags.FollowBands))}
                                tooltip="Inside a Headway band, depart at the band's headway from the band's start; no departures in No-service bands. The fleet vanilla sizes from that headway then matches the timetable.">
                                Follow bands
                            </FlatButton>
                        )}
                    </Field>

                    {!listMode ? (
                        <>
                            <SliderField label={`First (${formatTimeOfDay(schedule.timetableFirst)})`} value={Math.round(framesToMinutes(schedule.timetableFirst) / 5)} min={0} max={287}
                                onChange={(v) => set({ timetableFirst: Math.round(minutesToFrames(v * 5)) })} />
                            <SliderField label="Every" unit="min" value={Math.max(1, Math.round(framesToMinutes(schedule.timetableInterval)))} min={1} max={120}
                                onChange={(v) => set({ timetableInterval: Math.round(minutesToFrames(v)) })} />
                            {has(flags, TimetableFlags.FollowBands) && !schedule.enabled && (
                                <div className={styles.hint}>Follow bands needs the schedule switched on; until then the grid above applies all day.</div>
                            )}
                        </>
                    ) : (
                        <>
                            <div className={styles.row}>
                                <SliderField compact label={`Add ${formatTimeOfDay(minutesToFrames(addAt * 5))}`} value={addAt} min={0} max={287} onChange={setAddAt} />
                                <FlatButton onClick={() => set({ timetableDepartures: [...new Set([...schedule.timetableDepartures, Math.round(minutesToFrames(addAt * 5)) % TICKS_PER_DAY])].sort((a, b) => a - b) })}>Add</FlatButton>
                                <FlatButton onClick={() => set({ timetableDepartures: [] })} disabled={schedule.timetableDepartures.length === 0}>Clear</FlatButton>
                            </div>
                            <Field label="Times">
                                <DepartureDropdown departures={schedule.timetableDepartures}
                                    onRemove={(d) => set({ timetableDepartures: schedule.timetableDepartures.filter((x) => x !== d) })} />
                            </Field>
                        </>
                    )}

                    <Field label="When late">
                        <SelectDropdown<boolean> options={[["Wait for next slot", false], ["Leave now", true]]} value={has(flags, TimetableFlags.LeaveIfLate)}
                            onChange={(leave) => set(leave
                                ? { timetableFlags: withFlag(flags, TimetableFlags.LeaveIfLate, true), timetableLateTolerance: schedule.timetableLateTolerance || Math.round(minutesToFrames(5)) }
                                : { timetableFlags: withFlag(flags, TimetableFlags.LeaveIfLate, false) })} />
                        {has(flags, TimetableFlags.LeaveIfLate) && (
                            <SliderField compact label="" unit="min" value={Math.round(framesToMinutes(schedule.timetableLateTolerance))} min={1} max={60}
                                onChange={(v) => set({ timetableLateTolerance: Math.round(minutesToFrames(v)) })} />
                        )}
                    </Field>
                    <SliderField label="Resync after (intervals)" value={schedule.timetableResync || 2} min={1} max={10}
                        onChange={(v) => set({ timetableResync: v })} />

                    <Field label="Timing points" help="timetable.points">
                        {/* "Some stops" is what clicking stops in the printed timetable makes; picking it keeps them. */}
                        <SelectDropdown<"anchor" | "some" | "all">
                            options={[["Anchor only", "anchor"], ["Some stops", "some"], ["All stops", "all"]]}
                            value={schedule.timingPoints.length === 0 ? "anchor" : stops.length > 1 && schedule.timingPoints.length === stops.length - 1 ? "all" : "some"}
                            onChange={(v) => { if (v === "anchor") set({ timingPoints: [] }); else if (v === "all") set({ timingPoints: allPoints() }); }} />
                        <FlatButton onClick={() => setSlack(schedule.timetableSlack)} disabled={schedule.timingPoints.length === 0} tooltip="Re-derive the offsets from the current leg times">Recalculate</FlatButton>
                    </Field>
                    {schedule.timingPoints.length > 0 && (
                        <SliderField label="Margin" unit="%" value={Math.round(schedule.timetableSlack * 100)} min={0} max={50} onChange={(v) => setSlack(v / 100)} />
                    )}

                    {transfers.length > 0 && (
                        <Field label="Pulse" help="timetable.pulse">
                            <FlatButton onClick={() => pulseTimetable(schedule.entity)}
                                tooltip="Give the other lines at this stop (and its station) the same departures, anchored here, so passengers change on the same minutes. Replaces their timetables.">
                                {`Share with ${transfers.length} line${transfers.length === 1 ? "" : "s"} here`}
                            </FlatButton>
                        </Field>
                    )}

                    <div className={styles.hint}>
                        {onTime < 0
                            ? `${departures.length} departures a day. No punctuality measured yet.`
                            : `${departures.length} departures a day · ${Math.round(onTime * 100)}% on time · ${formatDuration(late)} late on average.`}
                    </div>

                    <TimetableGrid schedule={schedule} stats={stats} departures={departures} derived={derived} now={now} onTogglePoint={togglePoint} />
                </>
            )}
        </>
    );
};

/**
 * The hand-made departure list as the game's dropdown (the model picker's recipe): the toggle
 * summarises the list, the menu lists every time; clicking a row removes it.
 */
const DepartureDropdown = ({ departures, onRemove }: { departures: number[]; onRemove: (d: number) => void }) => {
    const { Dropdown, DropdownToggle } = vanilla;
    const summary = departures.length === 0
        ? "No departures"
        : `${departures.length} departure${departures.length === 1 ? "" : "s"} · ${formatTimeOfDay(departures[0])}–${formatTimeOfDay(departures[departures.length - 1])}`;
    const menu = (
        <div className={dd.menuBody}>
            <Scrollable vertical className={dd.listScroll}>
                {departures.map((d) => (
                    <div key={d} className={dd.row} onClick={() => onRemove(d)}>
                        <div className={dd.text}>
                            <div className={dd.name}>{formatTimeOfDay(d)}</div>
                        </div>
                        <div className={dd.meta}>remove</div>
                    </div>
                ))}
                {departures.length === 0 && <div className={dd.empty}>Add times with the slider above</div>}
            </Scrollable>
        </div>
    );
    return (
        <div className={dd.host}>
            <Dropdown theme={{ ...vanilla.gameDropdown, dropdownMenu: classNames(vanilla.gameDropdown.dropdownMenu, dd.menuTransparent) }} content={menu}>
                <DropdownToggle showHint>
                    <div className={dd.toggle}>
                        <div className={dd.summary}>{summary}</div>
                    </div>
                </DropdownToggle>
            </Dropdown>
        </div>
    );
};

/** The printed timetable: stops down, departures across, from now; a click on a stop toggles its timing point. */
const TimetableGrid = ({ schedule, stats, departures, derived, now, onTogglePoint }: {
    schedule: Schedule; stats: LineStats; departures: number[]; derived: number[]; now: number; onTogglePoint: (wp: number) => void;
}) => {
    const [page, setPage] = useState(0);
    if (departures.length === 0) return <div className={styles.hint}>No departures.</div>;
    const firstNext = Math.max(0, departures.findIndex((d) => d >= now));
    const start = (((firstNext + page * COLUMNS) % departures.length) + departures.length) % departures.length;
    const cols = Array.from({ length: Math.min(COLUMNS, departures.length) }, (_, i) => departures[(start + i) % departures.length]);
    // Order the rows from the anchor round the loop.
    const anchorAt = Math.max(0, stats.stops.findIndex((s) => s.waypoint === schedule.timetableStop));
    const rows = stats.stops.slice(anchorAt).concat(stats.stops.slice(0, anchorAt));
    const point = (wp: number) => schedule.timingPoints.find((p) => p.waypoint === wp);

    // The overview table's own parts (the Fleet / Depots tabs): its header with a column per
    // trip, then one line-item row per stop, stop name in the wide cell, one cell per departure.
    const pageCls = vanilla.overviewPage;
    const item = vanilla.lineItem;
    return (
        <div className={styles.ttGrid}>
            <div className={styles.row}>
                <span className={styles.sectionTitle}>Timetable</span>
                <span className={styles.spacer} />
                <FlatButton className={styles.pillButton} onClick={() => setPage(page - 1)} tooltip="Earlier departures"><Glyph src="Media/Glyphs/ThickStrokeArrowLeft.svg" /></FlatButton>
                <FlatButton className={styles.pillButton} onClick={() => setPage(0)} selected={page === 0}>Now</FlatButton>
                <FlatButton className={styles.pillButton} onClick={() => setPage(page + 1)} tooltip="Later departures"><Glyph src="Media/Glyphs/ThickStrokeArrowRight.svg" /></FlatButton>
            </div>
            <div className={pageCls.header}>
                <div className={pageCls.legends}>
                    <div className={pageCls.cellSingle} />
                    <div className={classNames(pageCls.cellWide, pageCls.alignLeft)}><div className={pageCls.buttonLabel}>Stop</div></div>
                    {cols.map((_, i) => (
                        <div key={i} className={pageCls.cellDouble}><div className={pageCls.buttonLabel}>{`Trip ${i + 1}`}</div></div>
                    ))}
                </div>
            </div>
            {rows.map((s) => {
                const isAnchor = s.waypoint === schedule.timetableStop;
                const p = point(s.waypoint);
                const offset = isAnchor ? 0 : p ? p.offset : derived[s.waypoint] ?? 0;
                return (
                    <div key={s.waypoint} className={item.transportationLineItem}>
                        <div className={classNames(item.container, (isAnchor || p) && styles.ttHold)}
                            onClick={() => !isAnchor && onTogglePoint(s.waypoint)}>
                            <div className={pageCls.cellSingle}>
                                {isAnchor ? <Glyph src={anchorIcon} className={styles.glyphAnchor} /> : p ? <Glyph src={timingIcon} className={styles.glyphTiming} /> : <span className={styles.dim}>·</span>}
                            </div>
                            <div className={classNames(pageCls.cellWide, pageCls.alignLeft)}><LocalizedEntityName value={s.name} /></div>
                            {cols.map((d, i) => (
                                <div key={i} className={classNames(pageCls.cellDouble, !(isAnchor || p) && styles.dim)}>
                                    {formatTimeOfDay(d + offset)}
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}
            <div className={classNames(styles.row, styles.ttLegend)}>
                <Glyph src={anchorIcon} className={styles.glyphAnchor} /><span>anchor</span>
                <Glyph src={timingIcon} className={styles.glyphTiming} /><span>timing point, held to the minute</span>
                <span className={styles.dim}>· others are estimates from the leg times. Click a stop to make it a timing point.</span>
            </div>
        </div>
    );
};
