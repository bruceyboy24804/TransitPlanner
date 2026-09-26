import { useMemo, useState } from "react";
import { Band, BandMode, BoardRow, minutesToFrames, minutesToSeconds, Schedule, TICKS_PER_DAY, TimetableFlags } from "../types";
import { vanilla } from "../vanilla";
import { FlatButton } from "./flat-button";
import { SelectDropdown } from "./select-dropdown";
import { SliderField } from "./slider-field";
import { TextField } from "./text-field";
import { clipToService, sortBands } from "./timeline";
import styles from "./planner.module.scss";

// The schedule wizard — Traffic's "New plan wizard" (name, cycle, pattern, options → Generate),
// for lines: pick which lines, a day pattern (with its peak hours), service hours and the
// headways; optionally run the busy periods on Target load, set fares, unbunching and
// band-following timetables, stretch everything to what the depots can run, and save the result
// as a shared template. Generate hands one schedule per line to the board, which drafts it like
// any other edit (review, then Apply).

const HOUR = TICKS_PER_DAY / 24;

type Pattern = "commuter" | "school" | "leisure" | "steady" | "night" | "load";
type Scope = "all" | "ticked" | "unscheduled";
type Level = "peak" | "off" | "night";

/** Vehicles a headway needs on a loop, as vanilla sizes it. */
const fleetFor = (headwaySec: number, stable: number) => (headwaySec > 0 ? Math.max(1, Math.round(stable / Math.max(1, headwaySec))) : 0);

/** Default peak windows (hours) for the patterns that have two. */
const peakDefaults: Partial<Record<Pattern, [number, number, number, number]>> = {
    commuter: [6, 9, 16, 19],
    school: [7, 9, 14, 16],
};

/**
 * A checkbox with its label. Declared at module level on purpose: defined inside the wizard it was
 * a new component type every render, so React remounted the checkbox whenever the board
 * re-rendered (hover, the clock) and a press that straddled a re-render never became a click.
 */
const Check = ({ on, set, children }: { on: boolean; set: (v: boolean) => void; children: React.ReactNode }) => (
    <div className={styles.row}>
        <vanilla.Checkbox checked={on} onChange={() => set(!on)} />
        <span className={styles.inlineHint}>{children}</span>
    </div>
);

export interface WizardResult {
    line: BoardRow;
    bands: Band[];
    closed: { start: number; end: number }[];
    /** Other schedule fields the wizard sets (timetable, unbunching). */
    extra: Partial<Schedule>;
}

export const ScheduleWizard = ({ lines, ticked, depotCapacity, freight, onGenerate, onClose, saveTemplate }: {
    lines: BoardRow[]; ticked: number[]; depotCapacity: number; freight: boolean;
    onGenerate: (out: WizardResult[], template: string | null) => void; onClose: () => void;
    saveTemplate: (name: string, bands: Band[]) => boolean;
}) => {
    const [scope, setScope] = useState<Scope>(ticked.length ? "ticked" : "all");
    const [pattern, setPatternRaw] = useState<Pattern>(freight ? "night" : "commuter");
    const [peaks, setPeaks] = useState<[number, number, number, number]>(peakDefaults.commuter!);
    const setPattern = (p: Pattern) => { setPatternRaw(p); if (peakDefaults[p]) setPeaks(peakDefaults[p]!); };
    const [first, setFirst] = useState(5);
    const [last, setLast] = useState(24);
    const [keepClosed, setKeepClosed] = useState(false);
    const [peak, setPeak] = useState(5);
    const [off, setOff] = useState(12);
    const [night, setNight] = useState(30);
    const [busyLoad, setBusyLoad] = useState(false);
    const [fares, setFares] = useState(false);
    const [peakFare, setPeakFare] = useState(10);
    const [offFare, setOffFare] = useState(6);
    const [unbunching, setUnbunching] = useState<number | null>(null);
    const [timetable, setTimetable] = useState(false);
    const [fit, setFit] = useState(true);
    const [asTemplate, setAsTemplate] = useState(false);
    const [name, setName] = useState("Wizard plan");

    const chosen = lines.filter((l) => scope === "all" || (scope === "ticked" ? ticked.includes(l.entity.index) : (l.schedule.bands ?? []).length === 0));
    const hasPeaks = !!peakDefaults[pattern];

    /** What an hour of the day is under the pattern: busy, normal or quiet. */
    const levelAt = (h: number): Level => {
        switch (pattern) {
            case "commuter":
            case "school":
                if (h < 6 || h >= 22) return "night";
                return (h >= peaks[0] && h < peaks[1]) || (h >= peaks[2] && h < peaks[3]) ? "peak" : "off";
            case "leisure": return h < 6 || h >= 22 ? "night" : h >= 10 && h < 18 ? "peak" : "off";
            case "steady": return h < 6 || h >= 22 ? "night" : "off";
            case "night": return h < 6 || h >= 18 ? "peak" : "off";
            default: return "off";
        }
    };
    const headwayOf = (l: Level) => minutesToSeconds(l === "peak" ? peak : l === "off" ? off : night);

    // Headways (seconds) per hour before fitting; 0 outside service or where the fleet follows load.
    const hourly = useMemo(() => Array.from({ length: 24 }, (_, h) => {
        if (h < first || h >= last || pattern === "load") return 0;
        const l = levelAt(h);
        return busyLoad && l === "peak" ? 0 : headwayOf(l);
    }), [pattern, peaks, first, last, peak, off, night, busyLoad]);

    // Vehicles the chosen lines need at the busiest hour, and the stretch that fits the depots.
    const peakNeed = (k: number) => Math.max(0, ...hourly.map((hw) => chosen.reduce((a, l) => a + fleetFor(hw * k, l.stable), 0)));
    const need = peakNeed(1);
    const stretch = useMemo(() => {
        if (!fit || pattern === "load" || depotCapacity <= 0 || need <= depotCapacity) return 1;
        let k = 1;
        while (k < 10 && peakNeed(k) > depotCapacity) k += 0.05;
        return k;
    }, [fit, need, depotCapacity, pattern, chosen.length, hourly]);
    const fitted = peakNeed(stretch);

    /** The generated bands (hours merged into spans of one level), and the closed ends. */
    const build = (): { bands: Band[]; closed: { start: number; end: number }[] } => {
        const closed = [
            ...(first > 0 ? [{ start: 0, end: first * HOUR }] : []),
            ...(last < 24 ? [{ start: last * HOUR, end: TICKS_PER_DAY }] : []),
        ];
        const fareOf = (l: Level) => (fares && !freight ? (l === "peak" ? peakFare : offFare) : -1);
        const base = { fleet: 0, primary: [], secondary: [] };
        if (pattern === "load") {
            return { closed, bands: [{ ...base, fare: fareOf("off"), start: first * HOUR, end: last * HOUR, mode: BandMode.TargetLoad, headway: 0, loadMin: 0.5, loadMax: 0.85 }] };
        }
        const bands: (Band & { level: Level })[] = [];
        for (let h = first; h < last; h++) {
            const level = levelAt(h);
            const load = busyLoad && level === "peak";
            const hw = load ? 0 : Math.round(hourly[h] * stretch);
            const prev = bands[bands.length - 1];
            if (prev && prev.end === h * HOUR && prev.level === level && prev.headway === hw) { prev.end = (h + 1) * HOUR; continue; }
            bands.push({
                ...base, level, start: h * HOUR, end: (h + 1) * HOUR, fare: fareOf(level),
                ...(load ? { mode: BandMode.TargetLoad, headway: 0, loadMin: 0.5, loadMax: 0.85 } : { mode: BandMode.Headway, headway: hw }),
            });
        }
        return { bands: bands.map(({ level, ...b }) => b), closed };
    };

    const generate = () => {
        const { bands, closed } = build();
        const template = asTemplate && name.trim() && saveTemplate(name.trim(), bands) ? name.trim() : null;
        onGenerate(chosen.map((line) => {
            // Keep the line's own closed hours, or use the wizard's service hours; bands are cut to fit.
            const own = keepClosed ? line.schedule.closed ?? [] : closed;
            const extra: Partial<Schedule> = {};
            if (unbunching !== null) { extra.overrideUnbunching = true; extra.unbunching = unbunching / 100; }
            if (timetable) {
                extra.timetable = true;
                extra.timetableFlags = TimetableFlags.FollowBands;
                extra.timetableStop = line.schedule.timetable ? line.schedule.timetableStop : line.schedule.timetableStop ?? 0;
                extra.timetableFirst = first * HOUR;
                extra.timetableInterval = Math.round(minutesToFrames(off));
            }
            return { line, bands: sortBands(clipToService(bands.map((b) => ({ ...b })), own)), closed: own, extra };
        }), template);
        onClose();
    };

    const hourOptions = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i).map((h) => [`${String(h).padStart(2, "0")}:00`, h] as [string, number]);
    const setPeak4 = (i: number, v: number) => setPeaks((p) => { const n = [...p] as [number, number, number, number]; n[i] = v; return n; });

    return (
        <div className={styles.wizard}>
            <div className={styles.wizardTitle}>Schedule wizard</div>
            <div className={styles.hint}>Build a day's schedule for many lines at once. It lands on the board as a draft: look it over, then Apply.</div>

            <div className={styles.wizardGrid}>
                <span className={styles.fieldLabel}>Lines</span>
                <SelectDropdown<Scope> value={scope} onChange={setScope}
                    options={[[`All shown (${lines.length})`, "all"], [`Ticked (${ticked.length})`, "ticked"], [`Without a schedule (${lines.filter((l) => !(l.schedule.bands ?? []).length).length})`, "unscheduled"]]} />
                <span className={styles.fieldLabel}>Pattern</span>
                <SelectDropdown<Pattern> value={pattern} onChange={setPattern}
                    options={[
                        ["Commuter peaks", "commuter"], ["School runs", "school"], ["Leisure (busy 10–18)", "leisure"], ["Steady all day", "steady"],
                        [freight ? "Night-heavy (avoid the day)" : "Evening & night heavy", "night"], ["Follow the load (target 50–85%)", "load"],
                    ]} />
            </div>
            {hasPeaks && (
                <div className={styles.wizardGrid}>
                    <span className={styles.fieldLabel}>Morning peak</span>
                    <SelectDropdown<number> value={peaks[0]} onChange={(v) => setPeak4(0, v)} options={hourOptions(4, 12)} />
                    <span className={styles.inlineHint}>to</span>
                    <SelectDropdown<number> value={peaks[1]} onChange={(v) => setPeak4(1, Math.max(peaks[0] + 1, v))} options={hourOptions(5, 13)} />
                    <span className={styles.fieldLabel}>Afternoon peak</span>
                    <SelectDropdown<number> value={peaks[2]} onChange={(v) => setPeak4(2, v)} options={hourOptions(12, 20)} />
                    <span className={styles.inlineHint}>to</span>
                    <SelectDropdown<number> value={peaks[3]} onChange={(v) => setPeak4(3, Math.max(peaks[2] + 1, v))} options={hourOptions(13, 22)} />
                </div>
            )}
            <div className={styles.wizardGrid}>
                <span className={styles.fieldLabel}>Service</span>
                <SelectDropdown<number> value={first} onChange={(v) => { setFirst(v); if (last <= v) setLast(Math.min(24, v + 1)); }} options={hourOptions(0, 23)} />
                <span className={styles.inlineHint}>to</span>
                <SelectDropdown<number> value={last} onChange={(v) => setLast(Math.max(first + 1, v))} options={hourOptions(1, 24)} />
                <Check on={keepClosed} set={setKeepClosed}>Keep each line's own closed hours instead</Check>
            </div>

            {pattern !== "load" && (
                <>
                    {!busyLoad && <SliderField label={pattern === "night" ? "Busy every" : "Peak every"} unit="min" value={peak} min={1} max={60} onChange={setPeak} />}
                    <SliderField label="Off-peak every" unit="min" value={off} min={1} max={90} onChange={setOff} />
                    <SliderField label={pattern === "night" ? "Quiet every" : "Night every"} unit="min" value={night} min={1} max={120} onChange={setNight} />
                    <Check on={busyLoad} set={setBusyLoad}>Run the busy periods on Target load (50–85%) instead of a fixed headway</Check>
                </>
            )}

            {!freight && (
                <>
                    <Check on={fares} set={setFares}>Set fares by period</Check>
                    {fares && (
                        <>
                            <SliderField label="Peak fare" value={peakFare} min={0} max={50} onChange={setPeakFare} />
                            <SliderField label="Other fare" value={offFare} min={0} max={50} onChange={setOffFare} />
                        </>
                    )}
                </>
            )}
            <div className={styles.row}>
                <span className={styles.fieldLabel}>Unbunching</span>
                <SelectDropdown<boolean> value={unbunching !== null} onChange={(v) => setUnbunching(v ? 100 : null)} options={[["Leave alone", false], ["Set", true]]} />
                {unbunching !== null && <SliderField compact label="" unit="%" value={unbunching} min={0} max={300} onChange={setUnbunching} />}
            </div>
            <Check on={timetable} set={setTimetable}>Add timetables that follow the bands (fixed departure times from each line's anchor stop)</Check>
            <Check on={fit} set={setFit}>Fit to the depots (stretch the headways so the busiest hour needs no more vehicles than they hold)</Check>
            <div className={styles.row}>
                <vanilla.Checkbox checked={asTemplate} onChange={() => setAsTemplate(!asTemplate)} />
                <span className={styles.inlineHint}>Save as a shared template and link the lines to it</span>
                {asTemplate && <TextField value={name} placeholder="Template name" onChange={setName} />}
            </div>

            <div className={styles.row}>
                <span className={styles.inlineHint}>
                    {pattern === "load" ? `${chosen.length} line${chosen.length === 1 ? "" : "s"} · the fleet follows the measured load`
                        : `${chosen.length} line${chosen.length === 1 ? "" : "s"} · busiest ${busyLoad ? "fixed " : ""}hour needs ${fitted} vehicle${fitted === 1 ? "" : "s"} of ${depotCapacity} in the depots`
                        + (stretch > 1 ? ` (headways ×${stretch.toFixed(2)}; ${need} unfitted)` : "")}
                </span>
                <span className={styles.spacer} />
                <FlatButton onClick={onClose}>Cancel</FlatButton>
                <FlatButton disabled={chosen.length === 0} onClick={generate}>Generate</FlatButton>
            </div>
        </div>
    );
};
