import { LocalizedEntityName } from "cs2/l10n";
import { PanelFoldout, Tooltip } from "cs2/ui";
import { setSchedule } from "../bindings";
import { framesToMinutes, minutesToFrames, Schedule, StopStat } from "../types";
import { vanilla } from "../vanilla";
import { SliderField } from "./slider-field";
import { HelpTitle } from "./encyclopedia";
import styles from "./planner.module.scss";

// Wait for load (TP_LoadWait / TP_LoadWaitSystem), shared by the freight and passenger pages: a
// vehicle loading at a chosen stop leaves once it has waited the shortest time AND it is full
// enough or the longest time is up. Every waiting stop on a line shares one set of settings.

type Wait = Schedule["loadWaits"][number];
const DEFAULTS = { minLoad: 0.8, minWait: 0, maxWait: Math.round(minutesToFrames(20)) };

export const waitAt = (schedule: Schedule, waypoint: number): Wait | undefined =>
    (schedule.loadWaits ?? []).find((w) => w.waypoint === waypoint);

/** Adds or removes a waiting stop; a new one takes the settings the line's others already use. */
export const toggleWait = (schedule: Schedule, waypoint: number) => {
    const waits = schedule.loadWaits ?? [];
    const base = waits[0] ?? DEFAULTS;
    setSchedule({
        ...schedule,
        loadWaits: waitAt(schedule, waypoint)
            ? waits.filter((w) => w.waypoint !== waypoint)
            : [...waits, { waypoint, minLoad: base.minLoad, minWait: base.minWait ?? 0, maxWait: base.maxWait }],
    });
};

/** The line's shared settings, shown once any stop waits. */
export const WaitSettings = ({ schedule, passengers }: { schedule: Schedule; passengers?: boolean }) => {
    const waits = schedule.loadWaits ?? [];
    if (waits.length === 0) return null;
    const first = waits[0];
    const set = (p: Partial<Wait>) => setSchedule({ ...schedule, loadWaits: waits.map((w) => ({ ...w, ...p })) });
    const minMin = Math.round(framesToMinutes(first.minWait ?? 0));
    const maxMin = Math.max(1, Math.round(framesToMinutes(first.maxWait)));
    return (
        <>
            <SliderField label="At least" unit="min" value={minMin} min={0} max={60}
                onChange={(v) => set({ minWait: Math.round(minutesToFrames(v)), maxWait: Math.max(first.maxWait, Math.round(minutesToFrames(v))) })} />
            <SliderField label="Wait until" unit="% full" value={Math.round(first.minLoad * 100)} min={5} max={100}
                onChange={(v) => set({ minLoad: v / 100 })} />
            <SliderField label="Or at most" unit="min" value={maxMin} min={1} max={120}
                onChange={(v) => set({ maxWait: Math.round(minutesToFrames(v)), minWait: Math.min(first.minWait ?? 0, Math.round(minutesToFrames(v))) })} />
            <div className={styles.hint}>
                {`A ${passengers ? "vehicle" : "vehicle loading"} at a waiting stop stays at least ${minMin} min, then leaves as soon as it is ${Math.round(first.minLoad * 100)}% full${passengers ? " of passengers" : ""} — or after ${maxMin} min however full. Vehicles behind it wait at the stop meanwhile.`}
            </div>
        </>
    );
};

/** One waiting stop's own settings (the passenger page edits them per stop). */
const StopWaitSettings = ({ schedule, wait }: { schedule: Schedule; wait: Wait }) => {
    const set = (p: Partial<Wait>) => setSchedule({ ...schedule, loadWaits: (schedule.loadWaits ?? []).map((w) => (w.waypoint === wait.waypoint ? { ...w, ...p } : w)) });
    const minMin = Math.round(framesToMinutes(wait.minWait ?? 0));
    const maxMin = Math.max(1, Math.round(framesToMinutes(wait.maxWait)));
    return (
        <div className={styles.waitBody}>
            <SliderField label="At least" unit="min" value={minMin} min={0} max={60}
                onChange={(v) => set({ minWait: Math.round(minutesToFrames(v)), maxWait: Math.max(wait.maxWait, Math.round(minutesToFrames(v))) })} />
            <SliderField label="Wait until" unit="% full" value={Math.round(wait.minLoad * 100)} min={5} max={100}
                onChange={(v) => set({ minLoad: v / 100 })} />
            <SliderField label="Or at most" unit="min" value={maxMin} min={1} max={120}
                onChange={(v) => set({ maxWait: Math.round(minutesToFrames(v)), minWait: Math.min(wait.minWait ?? 0, Math.round(minutesToFrames(v))) })} />
            <div className={styles.hint}>{`Stays at least ${minMin} min, then leaves once ${Math.round(wait.minLoad * 100)}% full of passengers — or after ${maxMin} min however full.`}</div>
        </div>
    );
};

/**
 * The passenger page's section: a row per stop with a checkbox; a ticked stop becomes the game's
 * PanelFoldout (cs2/ui, the info panel's expandable section) holding that stop's own settings.
 */
export const PassengerWaits = ({ schedule, stops }: { schedule: Schedule; stops: StopStat[] }) => {
    return (
        <>
            <HelpTitle className={styles.sectionTitle} title="Wait at stops" section="planner.waitload" />
            <div className={styles.hint}>Hold vehicles at chosen stops until they fill up — useful at a terminus or a big interchange.</div>
            {stops.map((s) => {
                const wait = waitAt(schedule, s.waypoint);
                const header = (
                    <div className={styles.waitHeader}>
                        {/* The checkbox must not also toggle the foldout it sits in. */}
                        <Tooltip tooltip={wait ? "Stop waiting here" : "Vehicles boarding here wait for passengers"}>
                            <div className={styles.row} onClick={(e) => e.stopPropagation()}>
                                <vanilla.Checkbox checked={!!wait} onChange={() => toggleWait(schedule, s.waypoint)} />
                            </div>
                        </Tooltip>
                        <LocalizedEntityName value={s.name} />
                        <span className={styles.spacer} />
                        <span className={styles.dim}>{`${s.waiting} waiting`}</span>
                    </div>
                );
                return wait ? (
                    <PanelFoldout key={s.waypoint} header={header} initialExpanded className={styles.waitFoldout}>
                        <StopWaitSettings schedule={schedule} wait={wait} />
                    </PanelFoldout>
                ) : (
                    <div key={s.waypoint} className={styles.stopRow}>{header}</div>
                );
            })}
        </>
    );
};
