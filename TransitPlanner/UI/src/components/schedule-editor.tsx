import { useEffect, useMemo, useState } from "react";
import classNames from "classnames";
import { useValue } from "cs2/api";
import type { Entity } from "cs2/bindings";
import { lines$, models$, setSchedule } from "../bindings";
import { steppingModes, TimetableFlags } from "../types";
import { Band, BandMode, FareMode, formatTimeOfDay, framesToMinutes, LineRow, LineStats, minutesToFrames, minutesToSeconds, sameEntity, Schedule, secondsToMinutes, TICKS_PER_DAY } from "../types";
import { departuresOfDay } from "../timetable";
import { withTimetableDefaults } from "./timetable-editor";
import { ModelDropdown } from "./model-dropdown";
import { vanilla } from "../vanilla";
import { clipToService, largestGap, offBandsToClosed, sortBands, Timeline } from "./timeline";
import { FlatButton } from "./flat-button";
import { SelectDropdown } from "./select-dropdown";
import { presetsFor, usePresets } from "../presets";
import { SliderField } from "./slider-field";
import { HelpButton } from "./encyclopedia";
import styles from "./planner.module.scss";

const h = (hours: number) => (hours / 24) * TICKS_PER_DAY;
const noModels = { primary: [] as Entity[], secondary: [] as Entity[] };

const Field = ({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) => (
    <div className={styles.row}>
        <span className={styles.fieldLabel}>{label}</span>
        {children}
        {help && <HelpButton section={help} inline />}
    </div>
);




const pct = (v: number | undefined, d: number) => `${Math.round((v ?? d) * 100)}%`;

/** The band modes a line can use: wait needs passengers, station stock needs freight. */
const modeOptions = (freight: boolean): [string, BandMode][] => [
    ["Vanilla", BandMode.Default],
    ["Headway", BandMode.Headway],
    ["Frequency", BandMode.Frequency],
    ["Ramp", BandMode.Ramp],
    ["Fleet", BandMode.Fleet],
    ["Budget (max vehicles)", BandMode.Capped],
    ["Target load", BandMode.TargetLoad],
    ["Follow demand", BandMode.FollowDemand],
    ["Crowding cap", BandMode.CrowdingCap],
    ...(freight
        ? [["Station stock", BandMode.StationStock], ["Cargo waiting", BandMode.DemandFirst], ["Convoy", BandMode.Convoy]] as [string, BandMode][]
        : [["Target wait", BandMode.TargetWait], ["Express", BandMode.Express]] as [string, BandMode][]),
    ["Match line", BandMode.MatchLine],
];

const modeHelp: Partial<Record<BandMode, string>> = {
    [BandMode.Default]: "The line's own settings (the vanilla vehicle slider) apply.",
    [BandMode.Headway]: "One vehicle every N minutes.",
    [BandMode.Frequency]: "N departures per game hour — a headway entered the other way round.",
    [BandMode.Ramp]: "The headway eases from one value at the band's start to another at its end, instead of jumping.",
    [BandMode.Fleet]: "Exactly this many vehicles, whatever the loop takes.",
    [BandMode.TargetLoad]: "The fleet follows the measured load of this hour.",
    [BandMode.FollowDemand]: "Sized straight from this hour's history: enough vehicles to have carried it at the load you aim for. No hunting up and down.",
    [BandMode.CrowdingCap]: "Watches the fullest vehicle, not the average — so one packed leg adds a vehicle even when the line's average looks fine.",
    [BandMode.TargetWait]: "The fleet follows the average wait at the line's stops.",
    [BandMode.StationStock]: "The fleet follows the stock at the line's stations: cargo piling up adds a vehicle, empty stations take one away.",
    [BandMode.Capped]: "A headway, but never more than a set number of vehicles. The game charges vehicles through the depot's upkeep, not per line, so the fleet is the line's budget.",
    [BandMode.DemandFirst]: "The fleet follows the cargo the line's stations are waiting to send along it, measured against what the fleet can carry in one trip.",
    [BandMode.Convoy]: "Vehicles leave the departure stop (the timetable's anchor, else the first stop) only on fixed slots, and at a slot still wait to fill up — up to a limit.",
    [BandMode.Express]: "Buses drive past the stops ticked under Skip stops (express) while this band runs, and stop everywhere otherwise. Set the headway the express runs at.",
    [BandMode.MatchLine]: "Runs at a multiple of another line's current headway — 1× the same, 2× half as often.",
};

const stepHint = (b: Band) => {
    switch (b.mode) {
        case BandMode.TargetWait:
            return `One vehicle more while stops wait longer than ${Math.round(secondsToMinutes(b.loadMax ?? 0))} min on average, one fewer while shorter than ${Math.round(secondsToMinutes(b.loadMin ?? 0))} min.`;
        case BandMode.StationStock:
            return `One vehicle more while the stations are fuller than ${pct(b.loadMax, 0.6)} of their storage, one fewer while emptier than ${pct(b.loadMin, 0.2)}.`;
        case BandMode.DemandFirst:
            return `One vehicle more while more than ${pct(b.loadMax, 1)} of a full fleet-load is waiting at the stations, one fewer while less than ${pct(b.loadMin, 0.3)}.`;
        case BandMode.CrowdingCap:
            return `One vehicle more while any vehicle runs fuller than ${pct(b.loadMax, 0.9)}, one fewer while even the fullest is under ${pct(b.loadMin, 0.5)}.`;
        default:
            return `One vehicle more while this hour runs fuller than ${pct(b.loadMax, 0.85)}, one fewer while it runs emptier than ${pct(b.loadMin, 0.5)}.`;
    }
};

/** Sensible starting values when a band switches mode (only where the band has none yet). */
const modeDefaults = (m: BandMode, b: Band, line: LineRow): Partial<Band> => {
    switch (m) {
        case BandMode.Fleet: return { fleet: Math.max(1, b.fleet) };
        case BandMode.TargetLoad: return { loadMin: 0.5, loadMax: 0.85 };
        case BandMode.CrowdingCap: return { loadMin: 0.5, loadMax: 0.9 };
        case BandMode.StationStock: return { loadMin: 0.2, loadMax: 0.6 };
        case BandMode.TargetWait: return { loadMin: minutesToSeconds(2), loadMax: minutesToSeconds(6) };
        case BandMode.FollowDemand: return { value: 0.7 };
        case BandMode.Frequency: return { value: Math.max(1, Math.round(60 / Math.max(1, secondsToMinutes(b.headway || line.headway)))) };
        case BandMode.Ramp: return { headway: b.headway || minutesToSeconds(10), value: b.headway || minutesToSeconds(10) };
        case BandMode.MatchLine: return { value: 1 };
        case BandMode.DemandFirst: return { loadMin: 0.3, loadMax: 1 };
        case BandMode.Convoy: return { headway: b.headway || minutesToSeconds(30), loadMin: 0.8, loadMax: minutesToSeconds(10) };
        case BandMode.Capped: return { headway: b.headway || minutesToSeconds(10), fleet: Math.max(1, b.fleet || line.fleet || 4) };
        case BandMode.Express: return { headway: b.headway || minutesToSeconds(10) };
        default: return {};
    }
};


/**
 * One band's settings — mode, its numbers, fare, models. Shared by the planner's schedule editor
 * and the Schedule tab's inspector; `patch` writes the band back.
 */
export const BandEditor = ({ band, patch, freight, line, autoFleet }: { band: Band; patch: (p: Partial<Band>) => void; freight: boolean; line: LineRow; autoFleet: number }) => {
    const allLines = useValue(lines$.binding);
    const nameOf = vanilla.useNameFormat();
    const otherLines = allLines.filter((l) => l.type === line.type && l.cargo === line.cargo && !sameEntity(l.entity, line.entity));
    const catalog = useValue(models$.binding).find((c) => c.type === line.type && c.cargo === (line.cargo ?? false));
    const has = (list: Entity[], e: Entity) => list.some((x) => sameEntity(x, e));
    const toggleModel = (slot: "primary" | "secondary", e: Entity) => {
        const list = band[slot] ?? [];
        patch({ [slot]: has(list, e) ? list.filter((x) => !sameEntity(x, e)) : [...list, e] } as Partial<Band>);
    };
    const schedule = { autoFleet };
    return (
        <div className={styles.bandEditor}>
            <Field label="Mode" help="planner.bands">
                <SelectDropdown<BandMode>
                    options={modeOptions(freight)}
                    value={band.mode}
                    onChange={(m) => patch({ mode: m, ...modeDefaults(m, band, line) })} />
            </Field>
            <div className={styles.hint}>{modeHelp[band.mode] ?? ""}</div>
            {band.mode === BandMode.Headway && (
                <SliderField label="Every" unit="min" value={Math.round(secondsToMinutes(band.headway))} min={1} max={120}
                    onChange={(v) => patch({ headway: minutesToSeconds(v) })} />
            )}
            {(band.mode === BandMode.Convoy || band.mode === BandMode.Capped || band.mode === BandMode.Express) && (
                <SliderField label={band.mode === BandMode.Convoy ? "Slot every" : "Every"} unit="min" value={Math.round(secondsToMinutes(band.headway))} min={1} max={120}
                    onChange={(v) => patch({ headway: minutesToSeconds(v) })} />
            )}
            {band.mode === BandMode.Capped && (
                <SliderField label="At most" unit="vehicles" value={band.fleet || 1} min={1} max={40} onChange={(v) => patch({ fleet: v })} />
            )}
            {band.mode === BandMode.Convoy && (
                <>
                    <SliderField label="Wait until" unit="% full" value={Math.round((band.loadMin ?? 0.8) * 100)} min={5} max={100}
                        onChange={(v) => patch({ loadMin: v / 100 })} />
                    <SliderField label="Or at most" unit="min" value={Math.round(secondsToMinutes(band.loadMax ?? 0))} min={0} max={60}
                        onChange={(v) => patch({ loadMax: minutesToSeconds(v) })} />
                </>
            )}
            {band.mode === BandMode.Fleet && (
                <SliderField label="Vehicles" value={band.fleet || 1} min={1} max={40} onChange={(v) => patch({ fleet: v })} />
            )}
            {band.mode === BandMode.Ramp && (
                <>
                    <SliderField label="From every" unit="min" value={Math.round(secondsToMinutes(band.headway))} min={1} max={120}
                        onChange={(v) => patch({ headway: minutesToSeconds(v) })} />
                    <SliderField label="To every" unit="min" value={Math.round(secondsToMinutes(band.value ?? band.headway))} min={1} max={120}
                        onChange={(v) => patch({ value: minutesToSeconds(v) })} />
                </>
            )}
            {band.mode === BandMode.Frequency && (
                <SliderField label="Departures" unit="per hour" value={band.value ?? 6} min={1} max={60} onChange={(v) => patch({ value: v })} />
            )}
            {band.mode === BandMode.FollowDemand && (
                <SliderField label="Aim for" unit="% full" value={Math.round((band.value ?? 0.7) * 100)} min={10} max={120}
                    onChange={(v) => patch({ value: v / 100 })} />
            )}
            {band.mode === BandMode.MatchLine && (
                <>
                    <Field label="Follow">
                        <SelectDropdown<number>
                            options={otherLines.map((l) => [nameOf(l.name), l.entity.index] as [string, number])}
                            value={band.line?.index ?? -1}
                            onChange={(i) => { const l = otherLines.find((x) => x.entity.index === i); if (l) patch({ line: l.entity }); }} />
                    </Field>
                    <SliderField label="Headway" unit="% of theirs" value={Math.round((band.value ?? 1) * 100)} min={25} max={400}
                        onChange={(v) => patch({ value: v / 100 })} />
                </>
            )}
            {(band.mode === BandMode.TargetLoad || band.mode === BandMode.CrowdingCap || band.mode === BandMode.StationStock || band.mode === BandMode.DemandFirst) && (() => {
                const lo = band.loadMin ?? 0.5, hi = band.loadMax ?? 0.85;
                return (
                    <>
                        <SliderField label="At least" unit="%" value={Math.round(lo * 100)} min={0} max={95}
                            onChange={(v) => patch({ loadMin: v / 100, loadMax: Math.max(v / 100 + 0.05, hi) })} />
                        <SliderField label="At most" unit="%" value={Math.round(hi * 100)} min={5} max={150}
                            onChange={(v) => patch({ loadMax: v / 100, loadMin: Math.min(v / 100 - 0.05, lo) })} />
                    </>
                );
            })()}
            {band.mode === BandMode.TargetWait && (() => {
                const lo = Math.round(secondsToMinutes(band.loadMin ?? 0)), hi = Math.max(1, Math.round(secondsToMinutes(band.loadMax ?? 0)));
                return (
                    <>
                        <SliderField label="At least" unit="min" value={lo} min={0} max={29}
                            onChange={(v) => patch({ loadMin: minutesToSeconds(v), loadMax: minutesToSeconds(Math.max(v + 1, hi)) })} />
                        <SliderField label="At most" unit="min" value={hi} min={1} max={30}
                            onChange={(v) => patch({ loadMax: minutesToSeconds(v), loadMin: minutesToSeconds(Math.min(v - 1, lo)) })} />
                    </>
                );
            })()}
            {steppingModes.includes(band.mode) && (
                <div className={styles.hint}>{`${stepHint(band)} At most one change per game hour.${schedule.autoFleet > 0 ? ` Running ${schedule.autoFleet} now.` : ""}`}</div>
            )}
            <div className={styles.hint}>To stop the line for some hours, use a closed block (Start / End / Closed band above) rather than a band.</div>
            {!freight && band.mode !== BandMode.Default && band.mode !== BandMode.Off && (
                <Field label="Fare">
                    <SelectDropdown<boolean> options={[["Vanilla", false], ["Custom", true]]} value={band.fare >= 0}
                        onChange={(custom) => patch({ fare: custom ? Math.max(0, band.fare) : -1 })} />
                    {band.fare >= 0 && <SliderField compact label="" value={Math.round(band.fare)} min={0} max={100} onChange={(v) => patch({ fare: v })} />}
                </Field>
            )}
            {!freight && band.mode !== BandMode.Default && band.fare >= 0 && (
                <div className={styles.hint}>Custom fares switch on the line's Paid ticket policy; the fare applies from the next tick.</div>
            )}
            {band.mode !== BandMode.Default && band.mode !== BandMode.Off && catalog && catalog.primary.length > 0 && (
                <>
                    <Field label={catalog.secondary.length ? "Engines" : "Vehicles"}>
                        <ModelDropdown label="" models={catalog.primary} cargo={catalog.cargo} selected={band.primary ?? []} emptyText="Same as the line"
                            onToggle={(m) => toggleModel("primary", m.entity)} />
                    </Field>
                    {catalog.secondary.length > 0 && (
                        <Field label="Carriages">
                            <ModelDropdown label="" models={catalog.secondary} cargo={catalog.cargo} selected={band.secondary ?? []} emptyText="Same as the line"
                                onToggle={(m) => toggleModel("secondary", m.entity)} />
                        </Field>
                    )}
                    <div className={styles.hint}>
                        {(band.primary?.length ?? 0) + (band.secondary?.length ?? 0) === 0
                            ? "No models picked: this band runs whatever the line runs otherwise."
                            : "While this band is active the line runs only these; vehicles that no longer match return to the depot and replacements are sent."}
                    </div>
                </>
            )}
        </div>
    );
};

export const ScheduleEditor = ({ schedule, now, line, stats, onOpenTimetable, freight = false }: { schedule: Schedule; now?: number; line: LineRow; stats: LineStats; onOpenTimetable?: () => void; freight?: boolean }) => {
    // Freight lines: no fares (nobody buys a ticket), no waiting passengers, and unbunching
    // matters little, so those rows go (unbunching behind "Advanced").
    const [advanced, setAdvanced] = useState(false);
    const history = stats.history;
    const lineUnbunching = stats.unbunching;
    const [selected, setSelected] = useState(-1);
    const bands = schedule.bands;
    const band = bands[selected] as Band | undefined;


    const departures = useMemo(() => departuresOfDay(withTimetableDefaults(schedule)), [schedule]);

    const commit = (next: Band[]) => setSchedule({ ...schedule, bands: sortBands(next) });

    // "No service" bands are retired in favour of closed blocks: a line that still has any (from
    // before, or from a rule) is converted the first time it is opened here. The game keeps
    // honouring the old mode until then, so nothing changes for the line in between.
    // Only against a game that stores closed blocks (it sends `closed` back): an older DLL would
    // drop the blocks and the bands would be lost.
    const hasOff = Array.isArray(schedule.closed) && schedule.bands.some((b) => b.mode === BandMode.Off);
    useEffect(() => {
        if (!hasOff) return;
        const conv = offBandsToClosed(schedule.bands, schedule.closed ?? []);
        setSchedule({ ...schedule, bands: sortBands(conv.bands), closed: conv.closed });
        setSelected(-1);
    }, [schedule.entity.index, hasOff]);
    const patch = (p: Partial<Band>) => {
        if (!band) return;
        const next = bands.map((b, i) => (i === selected ? { ...b, ...p } : b));
        commit(next);
    };

    // Closed blocks: stretches of the day the line does not run. The buttons add one at the
    // start or end of the day (or take it away again); on the timeline each block drags like a
    // band. Every change clips the bands to what is left open, in the same write.
    const closed = [...(schedule.closed ?? [])].sort((a, b) => a.start - b.start);
    const [selectedClosed, setSelectedClosed] = useState(-1);
    const startBlock = closed.findIndex((c) => c.start === 0);
    const endBlock = closed.findIndex((c) => c.end >= TICKS_PER_DAY);
    const setClosed = (next: { start: number; end: number }[]) => {
        const sorted = [...next].sort((a, b) => a.start - b.start);
        const clipped = clipToService(bands, sorted);
        const selectedStart = band?.start;
        setSchedule({ ...schedule, closed: sorted, bands: clipped });
        if (clipped.length !== bands.length) setSelected(clipped.findIndex((b) => b.start === selectedStart));
    };
    /** Adds a block of `hours` at the start or end of the day, or removes the one there. */
    const toggleEdgeBlock = (side: "start" | "end") => {
        const at = side === "start" ? startBlock : endBlock;
        if (at >= 0) { setClosed(closed.filter((_, i) => i !== at)); setSelectedClosed(-1); return; }
        // Up to the next block, at most 5 h at the start / 1 h at the end.
        const block = side === "start"
            ? { start: 0, end: Math.min(h(5), closed[0]?.start ?? TICKS_PER_DAY) }
            : { start: Math.max(h(23), closed[closed.length - 1]?.end ?? 0), end: TICKS_PER_DAY };
        if (block.end - block.start < minutesToFrames(15)) return;
        setClosed([...closed, block]);
    };
    /** Adds a closed block in the middle of the widest open stretch (1 h, or less when it is short). */
    const addMiddleBlock = () => {
        const gap = largestGap([], closed);
        if (!gap) return;
        const len = Math.min(h(1), gap.end - gap.start);
        const mid = (gap.start + gap.end) / 2;
        const block = { start: Math.round(mid - len / 2), end: Math.round(mid + len / 2) };
        setClosed([...closed, block]);
    };
    const describeClosed = closed.length === 0
        ? "Runs all day"
        : `Closed ${closed.map((c) => `${formatTimeOfDay(c.start)}–${c.end >= TICKS_PER_DAY ? "24:00" : formatTimeOfDay(c.end)}`).join(", ")} · drag the blocks on the timeline`;
    const add = () => {
        const gap = largestGap(bands, closed);
        if (!gap) return;
        const next = [...bands, { start: gap.start, end: gap.end, mode: BandMode.Headway, headway: minutesToSeconds(10), fleet: 0, fare: -1, ...noModels }];
        const sorted = sortBands(next);
        commit(sorted);
        setSelected(sorted.findIndex((b) => b.start === gap.start));
    };
    const remove = () => {
        // The selected closed block, or else the selected band.
        if (selectedClosed >= 0 && selectedClosed < closed.length) {
            setClosed(closed.filter((_, i) => i !== selectedClosed));
            setSelectedClosed(-1);
            return;
        }
        if (!band) return;
        commit(bands.filter((_, i) => i !== selected));
        setSelected(-1);
    };

    return (
        <div className={styles.editor}>
            <Field label="Schedule">
                <vanilla.Checkbox checked={schedule.enabled} onChange={() => setSchedule({ ...schedule, enabled: !schedule.enabled })} />
                <span className={styles.inlineHint}>{schedule.enabled ? "The bands below run the line" : "Off: the line runs as vanilla (service hours still apply)"}</span>
            </Field>

            {/* Line-level: first and last service of the day. Outside them the apply tick switches
                the line off through the Inactive policy (like a No-service band) and the timetable
                has no departures. Works with the bands off too. */}
            {/* Service hours as closed blocks on the timeline: a start block (closed from midnight to
                the first service) and an end block (closed from the last service to midnight),
                each added or removed here and resized by dragging its red edge on the timeline.
                Stored as the window [start, end): no start block = 00:00, no end block = 24:00. */}
            <Field label="Service hours">
                <FlatButton selected={startBlock >= 0} onClick={() => toggleEdgeBlock("start")}
                    tooltip={startBlock >= 0 ? "Remove the closed block at the start of the day" : "Close the line from midnight (drag the block on the timeline)"}>
                    Start band
                </FlatButton>
                <FlatButton selected={endBlock >= 0} onClick={() => toggleEdgeBlock("end")}
                    tooltip={endBlock >= 0 ? "Remove the closed block at the end of the day" : "Close the line until midnight (drag the block on the timeline)"}>
                    End band
                </FlatButton>
                <FlatButton onClick={addMiddleBlock} disabled={!largestGap([], closed)} tooltip="Add a closed block in the middle of the day (drag it where you want it)">
                    Closed band
                </FlatButton>
                <span className={styles.inlineHint}>{describeClosed}</span>
            </Field>

            {/* Line-level: vanilla seeds m_UnbunchingFactor from the prefab and never rewrites it, so
                this is a plain component write the apply tick repeats while the override is on.
                The factor multiplies the hold a vehicle gets at a stop when it is running early;
                0 = never hold, 1 = vanilla, 2 = hold twice as long. */}
            {freight && (
                <Field label="Advanced">
                    <FlatButton selected={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? "Hide" : "Show"}</FlatButton>
                </Field>
            )}
            {(!freight || advanced) && <Field label="Unbunching" help="planner.unbunching">
                <SelectDropdown<boolean> options={[["Vanilla", false], ["Custom", true]]} value={schedule.overrideUnbunching}
                    onChange={(on) => setSchedule({ ...schedule, overrideUnbunching: on, unbunching: on && !schedule.overrideUnbunching ? Math.max(0.05, lineUnbunching) : schedule.unbunching })} />
                {schedule.overrideUnbunching && (
                    <SliderField compact label="" unit="%" value={Math.round(schedule.unbunching * 100)} min={0} max={300}
                        onChange={(v) => setSchedule({ ...schedule, unbunching: v / 100 })} />
                )}
                {schedule.overrideUnbunching && <span className={styles.inlineHint}>% of the vanilla hold</span>}
            </Field>}

            {/* Line-level: per-ride pricing, applied by rewriting the boarding queue between the
                job that computes vanilla's fare and the job that charges it. Flat = vanilla's
                per-line/per-band fare. Per-km is allowed in tenths; the total is rounded. */}
            {!freight && <Field label="Fare rule" help="planner.fares">
                <SelectDropdown<number> options={[["Flat", FareMode.Flat], ["By distance", FareMode.Distance]]} value={schedule.fareMode}
                    onChange={(m) => setSchedule({ ...schedule, fareMode: m })} />
            </Field>}
            {!freight && schedule.fareMode === FareMode.Distance && (
                <>
                    <SliderField label="Base" value={schedule.fareBase} min={0} max={50}
                        onChange={(v) => setSchedule({ ...schedule, fareBase: v })} />
                    <SliderField label="Per km" unit="/10" value={Math.round(schedule.farePerKm * 10)} min={0} max={100}
                        onChange={(v) => setSchedule({ ...schedule, farePerKm: v / 10 })} />
                    <div className={styles.hint}>{`Ride = ${schedule.fareBase} + ${schedule.farePerKm.toFixed(1)}/km, from boarding stop to exit stop. Riders in trailing cars pay too (vanilla charges only the front car).`}</div>
                </>
            )}

            {/* The timetable has its own tab; here, what it is doing and a way there. */}
            <Field label="Timetable" help="timetable.basics">
                <span className={styles.inlineHint}>
                    {!schedule.timetable ? "Off"
                        : withTimetableDefaults(schedule).timetableFlags & TimetableFlags.List ? `${departures.length} set departures a day`
                        : `${departures.length} departures a day, first ${formatTimeOfDay(departures[0] ?? schedule.timetableFirst)}`}
                </span>
                {onOpenTimetable && <FlatButton onClick={onOpenTimetable}>Edit timetable</FlatButton>}
            </Field>

            {/* Band editing sits with the timeline it edits. */}
            <div className={styles.row}>
                <FlatButton onClick={add} disabled={!largestGap(bands, closed)}>
                    Add band
                </FlatButton>
                <FlatButton onClick={remove} disabled={!band && selectedClosed < 0}>
                    Remove
                </FlatButton>
            </div>
            <Timeline bands={bands} selected={selected} onSelect={setSelected} onChange={commit} now={now} history={history} freight={freight}
                closed={closed} onClosedChange={setClosed} selectedClosed={selectedClosed} onSelectClosed={setSelectedClosed}
                departures={schedule.timetable ? departures : undefined} punctuality={schedule.timetable ? stats.punctuality : undefined} />

            {band ? (
                <BandEditor band={band} patch={patch} freight={freight} line={line} autoFleet={schedule.autoFleet} />
            ) : (
                <div className={styles.hint}>Select a band to edit it, drag its edges to move it.</div>
            )}

            {/* A preset covers the whole day; applied, it is cut to the service hours. */}
            <PresetsRow bands={bands} cargo={line.cargo ?? false} onApply={(next) => {
                const conv = offBandsToClosed(next.map((b) => ({ ...noModels, ...b })), closed);
                setSchedule({ ...schedule, bands: sortBands(clipToService(conv.bands, conv.closed)), closed: conv.closed });
                setSelected(-1);
            }} />
        </div>
    );
};

/**
 * Presets: apply one (replaces the whole day), save the current bands as your own (a name typed
 * into the game's text input, committed on Enter or Save; the same name overwrites), delete one of
 * yours. Built-in presets cannot be overwritten or deleted. Per-band models are not saved.
 */
const PresetsRow = ({ bands, cargo, onApply }: { bands: Band[]; cargo: boolean; onApply: (bands: Omit<Band, "primary" | "secondary">[]) => void }) => {
    const { all: every, custom, save, remove } = usePresets();
    const all = presetsFor(every, cargo);
    const { EllipsisTextInput } = vanilla;
    const [naming, setNaming] = useState(false);
    const [name, setName] = useState("");
    const [deleting, setDeleting] = useState<string | null>(null);
    const allLines = useValue(lines$.binding);
    const taken = custom.some((p) => p.name === name.trim());
    const builtin = all.some((p) => !p.custom && p.name === name.trim());
    const commitSave = () => { if (save(name, bands)) { setNaming(false); setName(""); } };

    return (
        <>
            <Field label="Presets" help="planner.presets">
                <SelectDropdown<string>
                    options={[["Apply a preset…", ""] as [string, string]].concat(all.map((p) => [p.custom ? `${p.name} ★` : p.name, p.name] as [string, string]))}
                    value=""
                    onChange={(n) => { const p = all.find((x) => x.name === n); if (p) onApply(p.bands); }} />
                {!naming && <FlatButton onClick={() => { setName(""); setNaming(true); }} disabled={bands.length === 0} tooltip="Save this line's bands as a preset of your own">Save as preset…</FlatButton>}
                {!naming && custom.length > 0 && (
                    <SelectDropdown<string>
                        options={[["Delete a preset…", ""] as [string, string]].concat(custom.map((p) => [p.name, p.name] as [string, string]))}
                        value=""
                        onChange={(n) => n && setDeleting(n)} />
                )}
            </Field>
            {/* A custom preset may be a Schedule-tab template lines follow: say so before it goes. */}
            {deleting && (() => {
                const n = allLines.filter((l) => l.template === deleting).length;
                return (
                    <Field label="Delete">
                        <span className={classNames(styles.inlineHint, n > 0 && styles.warn)}>
                            {n > 0 ? `"${deleting}" is a template ${n} line${n === 1 ? "" : "s"} follow — they keep their bands.` : `Delete "${deleting}"?`}
                        </span>
                        <FlatButton onClick={() => { remove(deleting); setDeleting(null); }}>Delete</FlatButton>
                        <FlatButton onClick={() => setDeleting(null)}>Keep</FlatButton>
                    </Field>
                );
            })()}
            {naming && (
                <Field label="Name">
                    <div className={styles.nameFilter}>
                        <EllipsisTextInput value={name} maxLength={40} theme={vanilla.lineNameInput}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") commitSave(); else if (e.key === "Escape") setNaming(false); }} />
                    </div>
                    <FlatButton onClick={commitSave} disabled={!name.trim() || builtin}>{taken ? "Overwrite" : "Save"}</FlatButton>
                    <FlatButton onClick={() => setNaming(false)}>Cancel</FlatButton>
                    {builtin && <span className={styles.inlineHint}>That name is a built-in preset</span>}
                </Field>
            )}
        </>
    );
};
