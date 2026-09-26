import { useEffect, useMemo, useState } from "react";
import { useValue } from "cs2/api";
import { Scrollable } from "cs2/ui";
import classNames from "classnames";
import { applyRules, models$, rules$, setRules } from "../bindings";
import { Band, BandMode, formatTimeOfDay, framesToMinutes, minutesToFrames, minutesToSeconds, Rule, RuleOptions, RuleSet, RuleTimetable, RuleTrigger, secondsToMinutes, TICKS_PER_DAY } from "../types";
import { vanilla } from "../vanilla";
import { FlatButton } from "./flat-button";
import { TextField } from "./text-field";
import { Glyph, Section, Step } from "./toolbar";
import { HelpButton } from "./encyclopedia";
import { SelectDropdown } from "./select-dropdown";
import { SliderField } from "./slider-field";
import { ModelDropdown } from "./model-dropdown";
import { presetsFor, samePresetBands, usePresets } from "../presets";
import { typeLabel } from "./planner-panel";
import { TypeSelection } from "./type-sidebar";
import styles from "./planner.module.scss";

// Rules / auto-assign: "new bus lines get the peak preset and the articulated bus", "bus lines
// whose peak load passes 80% switch to the double-decker". Edited here as a whole set and handed
// back to C# as JSON (a player preference in the settings file); TP_RulesSystem applies them.
// Every action is optional: null / empty means "leave the line's own setting alone".

const triggerLabel: Record<RuleTrigger, string> = {
    [RuleTrigger.NewLine]: "New line",
    [RuleTrigger.Always]: "Always",
    [RuleTrigger.PeakLoadAbove]: "Peak load above",
    [RuleTrigger.LowLoadBelow]: "Quietest hour below",
    [RuleTrigger.LoadAtHourAbove]: "Load at hour above",
    [RuleTrigger.MaxWaitAbove]: "Max wait above",
    [RuleTrigger.LateAbove]: "Late above",
    [RuleTrigger.OnTimeBelow]: "On time below",
    [RuleTrigger.NotEnoughVehicles]: "Short of vehicles",
    [RuleTrigger.FleetAbove]: "Fleet above",
    [RuleTrigger.FleetBelow]: "Fleet below",
};
const triggerOrder = [
    RuleTrigger.NewLine, RuleTrigger.Always, RuleTrigger.PeakLoadAbove, RuleTrigger.LowLoadBelow, RuleTrigger.LoadAtHourAbove,
    RuleTrigger.MaxWaitAbove, RuleTrigger.LateAbove, RuleTrigger.OnTimeBelow, RuleTrigger.NotEnoughVehicles, RuleTrigger.FleetAbove, RuleTrigger.FleetBelow,
];
const defaultThreshold = (t: RuleTrigger) => {
    switch (t) {
        case RuleTrigger.MaxWaitAbove: return minutesToSeconds(20);
        case RuleTrigger.LateAbove: return minutesToSeconds(3);
        case RuleTrigger.LowLoadBelow: return 0.2;
        case RuleTrigger.OnTimeBelow: return 0.8;
        case RuleTrigger.FleetAbove: return 10;
        case RuleTrigger.FleetBelow: return 2;
        default: return 0.8;
    }
};

const hh = (h: number) => `${h.toString().padStart(2, "0")}:00`;

const thresholdText = (r: Rule) => {
    switch (r.trigger) {
        case RuleTrigger.PeakLoadAbove:
        case RuleTrigger.LowLoadBelow:
        case RuleTrigger.OnTimeBelow:
            return `${Math.round(r.threshold * 100)}%`;
        case RuleTrigger.LoadAtHourAbove:
            return `${Math.round(r.threshold * 100)}% at ${hh(r.hour ?? 8)}`;
        case RuleTrigger.MaxWaitAbove:
        case RuleTrigger.LateAbove:
            return `${Math.round(secondsToMinutes(r.threshold))} min`;
        case RuleTrigger.FleetAbove:
        case RuleTrigger.FleetBelow:
            return `${Math.round(r.threshold)}`;
        default:
            return "";
    }
};

const describe = (r: Rule) => {
    const scope = `${typeLabel[r.type] ?? "?"} ${r.cargo ? "routes" : "lines"}${r.nameContains ? ` named "${r.nameContains}"` : ""}`;
    const when = r.trigger === RuleTrigger.NewLine ? "new" : r.trigger === RuleTrigger.Always ? "always" : `${triggerLabel[r.trigger].toLowerCase()} ${thresholdText(r)}`;
    const o = r.options;
    const acts = [
        r.primary.length + r.secondary.length > 0 ? `${r.primary.length + r.secondary.length} model(s)` : null,
        r.bands.length > 0 ? `${r.bands.length}-band schedule` : null,
        r.serviceHours ? (r.serviceHours.on ? `hours ${formatTimeOfDay(r.serviceHours.start)}–${formatTimeOfDay(r.serviceHours.end)}` : "all day") : null,
        r.timetable ? (r.timetable.on ? "timetable" : "no timetable") : null,
        o && (o.unbunching != null || o.paidTicket != null || o.routeSchedule != null || o.fareMode != null) ? "options" : null,
    ].filter(Boolean);
    return `${scope}, ${when} → ${acts.length ? acts.join(" + ") : "nothing yet"}`;
};

const parse = (json: string): RuleSet => {
    try {
        const v = json ? (JSON.parse(json) as RuleSet) : null;
        return v && Array.isArray(v.rules) ? v : { version: 1, rules: [] };
    } catch {
        return { version: 1, rules: [] };
    }
};

const newRule = (sel: TypeSelection): Rule => ({
    id: Math.random().toString(36).slice(2),
    name: "",
    enabled: true,
    auto: true,
    type: sel.type,
    cargo: sel.cargo,
    trigger: RuleTrigger.NewLine,
    threshold: 0.8,
    primary: [],
    secondary: [],
    bands: [],
    hour: 8,
    nameContains: "",
    serviceHours: null,
    timetable: null,
    options: null,
});

const defaultTimetable = (): RuleTimetable => ({
    on: true, followBands: true, first: Math.round(minutesToFrames(5 * 60)), interval: Math.round(minutesToFrames(10)),
    leaveIfLate: false, lateTolerance: Math.round(minutesToFrames(5)), allStops: false, slack: 0.1,
});
const noOptions: RuleOptions = { unbunching: null, paidTicket: null, routeSchedule: null, fareMode: null, fareBase: 5, farePerKm: 1 };

const Row = ({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) => (
    <div className={classNames(styles.row, styles.wrap)}>
        <span className={styles.fieldLabel}>{label}</span>
        {children}
        {help && <HelpButton section={help} inline />}
    </div>
);

/** One choice among several, as the game's dropdown. */
const Choice = SelectDropdown;

/** A 5-minute time-of-day slider over frames of the day. */
const TimeSlider = ({ label, value, onChange }: { label: string; value: number; onChange: (frames: number) => void }) => (
    <SliderField label={`${label} (${formatTimeOfDay(value)})`} value={Math.round(framesToMinutes(value) / 5)} min={0} max={287}
        onChange={(v) => onChange(Math.round(minutesToFrames(v * 5)) % TICKS_PER_DAY)} />
);

/** The name filter: the game's text input, committed on blur or Enter (typing does not reach the game's hotkeys). */
const NameFilter = ({ value, onCommit }: { value: string; onCommit: (v: string) => void }) => {
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);
    const commit = () => { if (draft.trim() !== value) onCommit(draft.trim()); };
    return (
        <TextField value={draft} placeholder="Any line (part of a name)" onChange={setDraft} onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") setDraft(value); }} />
    );
};

export const RulesPanel = ({ typeSel }: { typeSel: TypeSelection }) => {
    const json = useValue(rules$.binding);
    const set = useMemo(() => parse(json), [json]);
    const catalog = useValue(models$.binding);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const rule = set.rules.find((r) => r.id === selectedId);
    const everyPreset = usePresets().all;
    const presets = rule ? presetsFor(everyPreset, rule.cargo) : everyPreset;

    const save = (rules: Rule[]) => setRules(JSON.stringify({ version: 1, rules }));
    const patch = (p: Partial<Rule>) => rule && save(set.rules.map((r) => (r.id === rule.id ? { ...r, ...p } : r)));
    const add = () => { const r = newRule(typeSel); save([...set.rules, r]); setSelectedId(r.id); };
    const duplicate = () => { if (rule) { const r = { ...rule, id: Math.random().toString(36).slice(2), name: rule.name ? `${rule.name} (copy)` : "" }; save([...set.rules, r]); setSelectedId(r.id); } };
    const remove = () => { if (rule) { save(set.rules.filter((r) => r.id !== rule.id)); setSelectedId(null); } };
    const move = (d: number) => {
        if (!rule) return;
        const i = set.rules.findIndex((r) => r.id === rule.id);
        const j = i + d;
        if (j < 0 || j >= set.rules.length) return;
        const next = [...set.rules];
        [next[i], next[j]] = [next[j], next[i]];
        save(next);
    };

    const cat = rule ? catalog.find((c) => c.type === rule.type && c.cargo === rule.cargo) : undefined;
    const byName = (names: string[]) => (cat ? cat.primary.concat(cat.secondary).filter((m) => names.includes(m.id)).map((m) => m.entity) : []);
    const toggleName = (slot: "primary" | "secondary", id: string) => {
        if (!rule) return;
        const list = rule[slot];
        patch({ [slot]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] } as Partial<Rule>);
    };

    const tt = rule?.timetable;
    const patchTt = (p: Partial<RuleTimetable>) => rule && tt && patch({ timetable: { ...tt, ...p } });
    const opts = rule?.options ?? noOptions;
    const patchOpts = (p: Partial<RuleOptions>) => rule && patch({ options: { ...opts, ...p } });

    return (
        <div className={styles.rules}>
            <div className={styles.rulesList}>
                <div className={styles.boardTools}>
                    <Section label={`Rules · ${set.rules.length}`}>
                        <Glyph src="Media/Glyphs/Plus.svg" onClick={add} tooltip={`Add a rule for ${typeLabel[typeSel.type]} ${typeSel.cargo ? "routes" : "lines"}`} />
                    </Section>
                    <Section label="Run" help="rules.basics">
                        <FlatButton onClick={() => applyRules()} tooltip="Run every enabled rule once, now" disabled={set.rules.length === 0}>Apply now</FlatButton>
                    </Section>
                </div>
                <Scrollable vertical className={styles.rulesScroll}>
                    {set.rules.length === 0 && <div className={styles.empty}>No rules yet. A rule sets models, a schedule, service hours, a timetable or line options on lines of one type, when the line is new, always, or when a measured figure crosses a threshold.</div>}
                    {set.rules.map((r) => (
                        <div key={r.id} className={classNames(styles.ruleRow, r.id === selectedId && styles.selected, !r.enabled && styles.dim)} onClick={() => setSelectedId(r.id)}>
                            <div className={styles.ruleName}>{r.name || describe(r)}</div>
                            {r.name && <div className={styles.ruleDesc}>{describe(r)}</div>}
                            <div className={styles.ruleFlags}>
                                {!r.enabled && <span className={styles.badge}>off</span>}
                                {r.enabled && r.auto && <span className={styles.badge}>auto</span>}
                            </div>
                        </div>
                    ))}
                </Scrollable>
            </div>

            {rule && (
                <Scrollable vertical className={styles.ruleEditor}>
                    <div className={styles.boardTools}>
                        <Section label="Rule">
                            <FlatButton selected={rule.enabled} onClick={() => patch({ enabled: !rule.enabled })}>{rule.enabled ? "Enabled" : "Disabled"}</FlatButton>
                            <FlatButton selected={rule.auto} onClick={() => patch({ auto: !rule.auto })} tooltip="Evaluated automatically on the simulation tick; off, only on Apply now">Auto</FlatButton>
                        </Section>
                        <Section label="Order">
                            <Glyph src="Media/Glyphs/ThickStrokeArrowUp.svg" onClick={() => move(-1)} tooltip="Run earlier (rules run top to bottom; a later rule wins)" />
                            <Glyph src="Media/Glyphs/ThickStrokeArrowDown.svg" onClick={() => move(1)} tooltip="Run later" />
                        </Section>
                        <Section label="Edit">
                            <Glyph src="Media/Glyphs/Copy.svg" onClick={duplicate} tooltip="Duplicate this rule" />
                            <Glyph src="Media/Glyphs/Trash.svg" onClick={remove} tooltip="Delete this rule" />
                        </Section>
                    </div>
                    <Step label="If" />
                    <Row label="Applies to" help="rules.basics">
                        <span className={styles.formValue}>{`${typeLabel[rule.type]} ${rule.cargo ? "routes" : "lines"}`}</span>
                        <FlatButton onClick={() => patch({ type: typeSel.type, cargo: typeSel.cargo, primary: [], secondary: [] })} tooltip="Use the type selected in the sidebar">Use sidebar type</FlatButton>
                    </Row>
                    <Row label="Name contains">
                        <NameFilter value={rule.nameContains ?? ""} onCommit={(v) => patch({ nameContains: v })} />
                    </Row>
                    <Row label="When" help="rules.triggers">
                        <Choice<RuleTrigger> options={triggerOrder.map((t) => [triggerLabel[t], t] as [string, RuleTrigger])} value={rule.trigger}
                            onChange={(t) => patch({ trigger: t, threshold: defaultThreshold(t) })} />
                    </Row>
                    {(rule.trigger === RuleTrigger.PeakLoadAbove || rule.trigger === RuleTrigger.LowLoadBelow || rule.trigger === RuleTrigger.LoadAtHourAbove) && (
                        <Row label="Load">
                            <SliderField compact label="" unit="%" value={Math.round(rule.threshold * 100)} min={0} max={150} onChange={(v) => patch({ threshold: v / 100 })} />
                        </Row>
                    )}
                    {rule.trigger === RuleTrigger.LoadAtHourAbove && (
                        <Row label="Hour">
                            <SliderField compact label={hh(rule.hour ?? 8)} value={rule.hour ?? 8} min={0} max={23} onChange={(v) => patch({ hour: v })} />
                        </Row>
                    )}
                    {rule.trigger === RuleTrigger.OnTimeBelow && (
                        <Row label="On time">
                            <SliderField compact label="" unit="%" value={Math.round(rule.threshold * 100)} min={0} max={100} onChange={(v) => patch({ threshold: v / 100 })} />
                        </Row>
                    )}
                    {rule.trigger === RuleTrigger.LateAbove && (
                        <Row label="Late by">
                            <SliderField compact label="" unit="min" value={Math.round(secondsToMinutes(rule.threshold))} min={1} max={60} onChange={(v) => patch({ threshold: minutesToSeconds(v) })} />
                        </Row>
                    )}
                    {rule.trigger === RuleTrigger.MaxWaitAbove && (
                        <Row label="Wait">
                            <SliderField compact label="" unit="min" value={Math.round(secondsToMinutes(rule.threshold))} min={1} max={180} onChange={(v) => patch({ threshold: minutesToSeconds(v) })} />
                        </Row>
                    )}
                    {(rule.trigger === RuleTrigger.FleetAbove || rule.trigger === RuleTrigger.FleetBelow) && (
                        <Row label="Vehicles">
                            <SliderField compact label="" value={Math.round(rule.threshold)} min={0} max={60} onChange={(v) => patch({ threshold: v })} />
                        </Row>
                    )}
                    <div className={styles.hint}>
                        {rule.trigger === RuleTrigger.NewLine
                            ? "Fires once per line the planner has not seen — including every existing line the first time this mod runs in a city. Needs \"Apply default schedule to new lines\" on in the options."
                            : rule.trigger === RuleTrigger.Always
                                ? "Keeps the actions in force on every matching line: whatever the line is changed to, the rule puts it back on its next tick (about every 5 clock minutes)."
                                : rule.trigger === RuleTrigger.NotEnoughVehicles || rule.trigger === RuleTrigger.FleetAbove || rule.trigger === RuleTrigger.FleetBelow
                                    ? "Judged on the line right now, every tick while the rule is auto."
                                    : "Judged on the line's measured hourly history, once at least six hours have data (punctuality: six timetabled hours). The action only writes when it would change something, so it does not flap."}
                    </div>

                    <Step label="Then · models" />
                    {cat ? (
                        <>
                            <Row label={cat.secondary.length ? "Engines" : "Vehicles"}>
                                <ModelDropdown label="" models={cat.primary} cargo={cat.cargo} selected={byName(rule.primary)} emptyText="Leave models alone" onToggle={(m) => toggleName("primary", m.id)} />
                            </Row>
                            {cat.secondary.length > 0 && (
                                <Row label="Carriages">
                                    <ModelDropdown label="" models={cat.secondary} cargo={cat.cargo} selected={byName(rule.secondary)} emptyText="Leave carriages alone" onToggle={(m) => toggleName("secondary", m.id)} />
                                </Row>
                            )}
                        </>
                    ) : (
                        <div className={styles.hint}>No model catalogue for this type in this city yet (needs a depot of the type).</div>
                    )}

                    <Step label="Then · schedule" />
                    <Row label="Schedule" help="rules.actions">
                        <Choice<string>
                            options={[["Leave alone", ""] as [string, string]]
                                .concat(presets.filter((p) => p.bands.length > 0).map((p) => [p.custom ? `${p.name} ★` : p.name, p.name] as [string, string]))
                                .concat(rule.bands.length > 0 && !presets.some((p) => p.bands.length > 0 && samePresetBands(rule.bands, p.bands)) ? [["Custom bands", "custom"] as [string, string]] : [])}
                            value={rule.bands.length === 0 ? "" : presets.find((p) => p.bands.length > 0 && samePresetBands(rule.bands, p.bands))?.name ?? "custom"}
                            onChange={(name) => { if (name !== "custom") patch({ bands: (presets.find((p) => p.name === name)?.bands ?? []).map((b) => ({ ...b })) }); }} />
                    </Row>

                    <Step label="Then · service hours" />
                    <Row label="Hours">
                        <Choice<"leave" | "all" | "set">
                            options={[["Leave alone", "leave"], ["All day", "all"], ["Set hours", "set"]]}
                            value={!rule.serviceHours ? "leave" : rule.serviceHours.on ? "set" : "all"}
                            onChange={(v) => patch({ serviceHours: v === "leave" ? null : { on: v === "set", start: rule.serviceHours?.start || Math.round(minutesToFrames(5 * 60)), end: rule.serviceHours?.end || Math.round(minutesToFrames(23 * 60)) } })} />
                    </Row>
                    {rule.serviceHours?.on && (
                        <>
                            <TimeSlider label="Start" value={rule.serviceHours.start} onChange={(f) => patch({ serviceHours: { ...rule.serviceHours!, start: f } })} />
                            <TimeSlider label="End" value={rule.serviceHours.end} onChange={(f) => patch({ serviceHours: { ...rule.serviceHours!, end: f } })} />
                        </>
                    )}

                    <Step label="Then · timetable" />
                    <Row label="Timetable" help="timetable.basics">
                        <Choice<"leave" | "off" | "on">
                            options={[["Leave alone", "leave"], ["Remove", "off"], ["Set", "on"]]}
                            value={!tt ? "leave" : tt.on ? "on" : "off"}
                            onChange={(v) => patch({ timetable: v === "leave" ? null : { ...(tt ?? defaultTimetable()), on: v === "on" } })} />
                    </Row>
                    {tt?.on && (
                        <>
                            <TimeSlider label="First" value={tt.first} onChange={(f) => patchTt({ first: f })} />
                            <SliderField label="Every" unit="min" value={Math.max(1, Math.round(framesToMinutes(tt.interval)))} min={1} max={120} onChange={(v) => patchTt({ interval: Math.round(minutesToFrames(v)) })} />
                            <Row label="Grid">
                                <FlatButton selected={tt.followBands} onClick={() => patchTt({ followBands: !tt.followBands })} tooltip="Inside Headway bands, depart at the band's headway">Follow bands</FlatButton>
                                <FlatButton selected={tt.allStops} onClick={() => patchTt({ allStops: !tt.allStops })} tooltip="Hold at every stop until its scheduled time">All-stop timing points</FlatButton>
                            </Row>
                            {tt.allStops && (
                                <SliderField label="Margin" unit="%" value={Math.round(tt.slack * 100)} min={0} max={50} onChange={(v) => patchTt({ slack: v / 100 })} />
                            )}
                            <Row label="When late">
                                <Choice<boolean> options={[["Wait for next slot", false], ["Leave now", true]]} value={tt.leaveIfLate} onChange={(v) => patchTt({ leaveIfLate: v })} />
                                {tt.leaveIfLate && (
                                    <SliderField compact label="" unit="min" value={Math.round(framesToMinutes(tt.lateTolerance))} min={1} max={60} onChange={(v) => patchTt({ lateTolerance: Math.round(minutesToFrames(v)) })} />
                                )}
                            </Row>
                            <div className={styles.hint}>Anchored at the line's first stop. Replaces a hand-made departure list on the line.</div>
                        </>
                    )}

                    <Step label="Then · line options" />
                    <Row label="Unbunching" help="planner.unbunching">
                        <Choice<"leave" | "vanilla" | "custom">
                            options={[["Leave alone", "leave"], ["Vanilla", "vanilla"], ["Custom", "custom"]]}
                            value={opts.unbunching == null ? "leave" : opts.unbunching < 0 ? "vanilla" : "custom"}
                            onChange={(v) => patchOpts({ unbunching: v === "leave" ? null : v === "vanilla" ? -1 : 1 })} />
                        {opts.unbunching != null && opts.unbunching >= 0 && (
                            <SliderField compact label="" unit="%" value={Math.round(opts.unbunching * 100)} min={0} max={300} onChange={(v) => patchOpts({ unbunching: v / 100 })} />
                        )}
                    </Row>
                    <Row label="Paid ticket">
                        <Choice<boolean | null> options={[["Leave alone", null], ["On", true], ["Off", false]]} value={opts.paidTicket ?? null} onChange={(v) => patchOpts({ paidTicket: v })} />
                    </Row>
                    <Row label="Runs">
                        <Choice<number | null> options={[["Leave alone", null], ["Day and night", 2], ["Day only", 0], ["Night only", 1]]} value={opts.routeSchedule ?? null} onChange={(v) => patchOpts({ routeSchedule: v })} />
                    </Row>
                    <Row label="Fare rule" help="planner.fares">
                        <Choice<number | null> options={[["Leave alone", null], ["Flat", 0], ["By distance", 1]]} value={opts.fareMode ?? null} onChange={(v) => patchOpts({ fareMode: v })} />
                    </Row>
                    {opts.fareMode === 1 && (
                        <>
                            <SliderField label="Base" value={opts.fareBase} min={0} max={50} onChange={(v) => patchOpts({ fareBase: v })} />
                            <SliderField label="Per km" unit="/10" value={Math.round(opts.farePerKm * 10)} min={0} max={100} onChange={(v) => patchOpts({ farePerKm: v / 10 })} />
                        </>
                    )}
                </Scrollable>
            )}
            {!rule && set.rules.length > 0 && <div className={styles.empty}>Select a rule to edit it.</div>}
        </div>
    );
};

const sameBands = (a: Band[] | Omit<Band, "primary" | "secondary">[], b: Omit<Band, "primary" | "secondary">[]) =>
    a.length === b.length && a.every((x, i) => x.start === b[i].start && x.end === b[i].end && x.mode === b[i].mode && x.headway === b[i].headway && x.fleet === b[i].fleet);

// Keeps the unused imports honest for the type-only exports.
export type { BandMode };
