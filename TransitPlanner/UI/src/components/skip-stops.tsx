import { LocalizedEntityName } from "cs2/l10n";
import { Tooltip } from "cs2/ui";
import { setSchedule } from "../bindings";
import { BandMode, formatTimeOfDay, Schedule, SkipStop, StopStat, TICKS_PER_DAY } from "../types";
import { vanilla } from "../vanilla";
import { FlatButton } from "./flat-button";
import { SelectDropdown } from "./select-dropdown";
import { HelpTitle } from "./encyclopedia";
import styles from "./planner.module.scss";

// Express running (TP_SkipStop / TP_SkipStopSystem), every passenger line: vehicles drive past the
// ticked stops during the window or the line's Express bands, and the stop is closed to this
// line in trip planning. A bus at a plain stop still stops for a rider who wants to get off;
// elsewhere the stop is only passed once a full loop has gone by, so nobody aboard is carried past.

const HALF_HOUR = TICKS_PER_DAY / 48;
const TIMES: [string, number][] = Array.from({ length: 48 }, (_, i) => [formatTimeOfDay(i * HALF_HOUR), Math.round(i * HALF_HOUR)]);
const DEFAULT_WINDOW = { start: Math.round(7 * 2 * HALF_HOUR), end: Math.round(9 * 2 * HALF_HOUR) };

const skipAt = (schedule: Schedule, waypoint: number) => (schedule.skipStops ?? []).find((s) => s.waypoint === waypoint);

/** The section on the passenger line page; nothing for lines that cannot skip (not a bus line). */
export const SkipStops = ({ schedule, stops }: { schedule: Schedule; stops: StopStat[] }) => {
    if (!stops.some((s) => s.skippable)) return null;
    const skips = schedule.skipStops ?? [];
    // One window for the whole line: every entry carries it; a new stop takes the others'.
    const window = skips[0] ? { start: skips[0].start, end: skips[0].end } : { start: 0, end: 0 };
    const allDay = window.start === window.end;
    const write = (next: SkipStop[]) => setSchedule({ ...schedule, skipStops: next });
    const toggle = (waypoint: number) => write(skipAt(schedule, waypoint)
        ? skips.filter((s) => s.waypoint !== waypoint)
        : [...skips, { waypoint, ...window }]);
    const setWindow = (w: { start: number; end: number }) => write(skips.map((s) => ({ ...s, ...w })));
    // Express bands, when the (enabled) schedule has any, decide when the stops are skipped.
    const express = schedule.enabled ? (schedule.bands ?? []).filter((b) => b.mode === BandMode.Express) : [];
    const expressBands = express.length ? express.map((b) => `${formatTimeOfDay(b.start)}–${formatTimeOfDay(b.end)}`).join(", ") : "";

    return (
        <>
            <HelpTitle className={styles.sectionTitle} title="Skip stops (express)" section="planner.skipstops" />
            <div className={styles.hint}>
                Vehicles drive past the ticked stops, which stay on the line. Passengers stop planning trips from or to them on this line at once; vehicles start driving past after one full loop, so riders already aboard get off first. Buses at ordinary stops still stop for a rider who wants to get off.
            </div>
            {expressBands && skips.length > 0 && (
                <div className={styles.hint}>{`Skipped only while an Express band runs (${expressBands}). Add or move Express bands on the timeline above to change when.`}</div>
            )}
            {expressBands && skips.length === 0 && (
                <div className={styles.hint}>The line has Express bands: tick the stops they should skip.</div>
            )}
            {!expressBands && skips.length > 0 && (
                <div className={styles.row}>
                    <span className={styles.fieldLabel}>When</span>
                    <FlatButton selected={allDay} onClick={() => setWindow({ start: 0, end: 0 })}>All day</FlatButton>
                    <FlatButton selected={!allDay} onClick={() => { if (allDay) setWindow(DEFAULT_WINDOW); }}>Between</FlatButton>
                    {!allDay && (
                        <>
                            <SelectDropdown className={styles.selectNarrow} options={TIMES} value={nearest(window.start)} onChange={(v) => setWindow({ start: v, end: window.end })} />
                            <span className={styles.dim}>and</span>
                            <SelectDropdown className={styles.selectNarrow} options={TIMES} value={nearest(window.end)} onChange={(v) => setWindow({ start: window.start, end: v })} />
                        </>
                    )}
                </div>
            )}
            {stops.map((s) => {
                const on = !!skipAt(schedule, s.waypoint);
                return (
                    <div key={s.waypoint} className={styles.stopRow}>
                        <Tooltip tooltip={!s.skippable ? "Not a stop this line can skip" : on ? "Stop at this stop again" : "Drive past this stop"}>
                            <div className={styles.row} style={s.skippable ? undefined : { opacity: 0.35 }}>
                                <vanilla.Checkbox checked={on} onChange={() => s.skippable && toggle(s.waypoint)} />
                            </div>
                        </Tooltip>
                        <LocalizedEntityName value={s.name} />
                        <span className={styles.spacer} />
                        {s.skippedNow && <span className={styles.badge}>skipped now</span>}
                        <span className={styles.dim}>{`${s.waiting} waiting`}</span>
                    </div>
                );
            })}
        </>
    );
};

/** The half-hour option nearest a stored time (older values may not sit on the grid). */
const nearest = (f: number) => TIMES.reduce((best, [, v]) => (Math.abs(v - f) < Math.abs(best - f) ? v : best), TIMES[0][1]);
