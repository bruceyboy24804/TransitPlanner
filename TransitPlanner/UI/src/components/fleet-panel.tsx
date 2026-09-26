import { useMemo, useState } from "react";
import { useValue } from "cs2/api";
import { transport } from "cs2/bindings";
import type { Entity } from "cs2/bindings";
import { TypeSelection, typeTitle } from "./type-sidebar";

const { hideLine, selectLine, setLineActive, setLineColor, setLineSchedule, showLine, toggleHighlight } = transport;
import * as l10n from "cs2/l10n";
import { LocalizedEntityName, useLocalization } from "cs2/l10n";

/** A vehicle prefab's display name: the Assets.NAME table, falling back to the prefab id (BTS's rule). */
export const useModelName = () => {
    const { translate } = useLocalization();
    return (m: ModelInfo) => translate(`Assets.NAME[${m.id}]`, m.id) ?? m.id;
};

// cs2/l10n declares LocalizedNumber twice (interface + component) and Unit only as a type, so
// the component is reached past the typings and units are the literal strings (see CLAUDE.md).
const LocalizedNumber = (l10n as unknown as { LocalizedNumber: React.FC<{ value: number; unit?: string }> }).LocalizedNumber;
const UNIT_LENGTH = "length";
const UNIT_PERCENT = "percentage";
import { Scrollable, Tooltip } from "cs2/ui";
import classNames from "classnames";
import { addModel, fleet$, models$, removeModel, setModels, setOption } from "../bindings";
import { byLine, FleetRow, formatDuration, ModelInfo, RouteOption, RouteSchedule, sameEntity, TransportType, transportTypeId } from "../types";
import { vanilla } from "../vanilla";
import { FlatButton } from "./flat-button";
import { ModelDropdown } from "./model-dropdown";
import { ResourceChips } from "./freight-detail";
import { typeLabel } from "./planner-panel";
import styles from "./planner.module.scss";

// The fleet manager tab, built from the transportation overview's own parts: its page layout
// (types sidebar / lines panel / header / cells), its TransportTypeItem buttons, its line-row
// classes and IconButton actions, and its bindings for select / active / schedule / visibility
// (cs2/bindings). Our own columns (fleet vs target, headway, load, ticket, models) and the
// multi-select with bulk edits sit on top. Model and option edits go through TP_FleetUISystem.

const has = (list: Entity[], e: Entity) => list.some((x) => sameEntity(x, e));
const NULL: Entity = { index: 0, version: 0 };

// Sort keys for the header, the overview's own sort-button treatment. The report columns
// (peak load, quietest hour, longest wait) come from the line's hourly history — the ranking
// idea is ExtendedTransportManager's occupancy report, per line and sortable here.
type SortKey = "name" | "length" | "stops" | "fleet" | "headway" | "usage" | "peak" | "low" | "wait" | "late";
const sorters: Record<SortKey, (r: FleetRow) => number> = {
    name: (r) => r.entity.index,
    length: (r) => r.length,
    stops: (r) => r.stops,
    fleet: (r) => r.fleet,
    headway: (r) => r.headway,
    usage: (r) => (r.capacity > 0 ? r.riders / r.capacity : 0),
    peak: (r) => r.peakLoad,
    low: (r) => (r.sampledHours > 0 ? r.lowLoad : 9),
    wait: (r) => r.maxWait,
    // Lines without a timetable sort after every measured one.
    late: (r) => (r.onTime >= 0 ? r.late : -1),
};
const hh = (h: number) => `${h.toString().padStart(2, "0")}:00`;

const scheduleOf = (r: FleetRow): RouteSchedule =>
    r.dayOnly ? RouteSchedule.Day : r.nightOnly ? RouteSchedule.Night : RouteSchedule.DayAndNight;

const nextSchedule = (s: RouteSchedule): RouteSchedule =>
    s === RouteSchedule.DayAndNight ? RouteSchedule.Day : s === RouteSchedule.Day ? RouteSchedule.Night : RouteSchedule.DayAndNight;

export const ModelChip = ({ model, state, onClick }: { model: ModelInfo; state: "all" | "some" | "none"; onClick: () => void }) => {
    const name = useModelName();
    return (
        <FlatButton selected={state === "all"} className={classNames(styles.chip, state === "some" && styles.chipSome)} onClick={onClick}
            tooltip={`${model.id}${model.capacity ? ` · capacity ${model.capacity}` : ""}`}>
            {name(model)}
        </FlatButton>
    );
};

const Row = ({ r, picked, models, onToggle, onOpen }: { r: FleetRow; picked: boolean; models: ModelInfo[]; onToggle: () => void; onOpen: (r: FleetRow) => void }) => {
    const page = vanilla.overviewPage;
    const item = vanilla.lineItem;
    const { IconButton, Checkbox, ColorField } = vanilla;
    const load = r.capacity > 0 ? r.riders / r.capacity : 0;
    const schedule = scheduleOf(r);
    const tagged = r.primaryModels.concat(r.secondaryModels).map((e) => models.find((m) => sameEntity(m.entity, e)));
    const highlight = () => toggleHighlight(r.entity);
    const name = useModelName();

    return (
        <div className={item.transportationLineItem}>
            <div
                className={classNames(item.container, picked && styles.pickedRow)}
                onMouseEnter={highlight}
                onMouseLeave={highlight}
                onClick={onToggle}
            >
                <div className={page.cellSingle} onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={picked} onChange={onToggle} />
                </div>
                <div className={page.cellSingle}>
                    <Tooltip tooltip="Open in the planner">
                        <IconButton tinted src="Media/Glyphs/ViewInfo.svg" className={classNames(item.button, item.smallerIcon)}
                            onSelect={() => onOpen(r)} onClick={(e) => e.stopPropagation()} />
                    </Tooltip>
                </div>
                <div className={classNames(page.cellWide, page.alignLeft)}>
                    <LocalizedEntityName value={r.name} />
                </div>
                <div className={page.cellDouble}>
                    <LocalizedNumber value={r.length} unit={UNIT_LENGTH} />
                </div>
                <div className={page.cellDouble}>{r.stops}</div>
                <div className={classNames(page.cellDouble, r.notEnoughVehicles && styles.warn)}>{r.fleet} / {r.target}</div>
                <div className={page.cellDouble}>{formatDuration(r.headway)}</div>
                <div className={classNames(page.cellDouble, page.alignRight)}>
                    <LocalizedNumber value={100 * load} unit={UNIT_PERCENT} />
                </div>
                <div className={classNames(page.cellDouble, page.alignRight, r.peakLoad >= 1 && styles.warn)}>
                    <Tooltip tooltip={r.sampledHours > 0 ? `Busiest at ${hh(r.peakHour)}` : "No history yet"}>
                        <span>{r.sampledHours > 0 ? `${Math.round(r.peakLoad * 100)}%` : "—"}</span>
                    </Tooltip>
                </div>
                <div className={classNames(page.cellDouble, page.alignRight)}>{r.sampledHours > 0 ? `${Math.round(r.lowLoad * 100)}%` : "—"}</div>
                {r.cargo
                    ? <div className={classNames(page.cellDouble, styles.padLeft)}><ResourceChips list={r.carrying ?? []} max={2} /></div>
                    : <div className={classNames(page.cellDouble, styles.padLeft)}>{r.sampledHours > 0 ? formatDuration(r.maxWait) : "—"}</div>}
                <div className={classNames(page.cellDouble, r.onTime >= 0 && r.onTime < 0.8 && styles.warn)}>
                    <Tooltip tooltip={r.onTime >= 0 ? `${Math.round(r.onTime * 100)}% on time` : "Not timetabled, or nothing measured yet"}>
                        <span>{r.onTime >= 0 ? formatDuration(r.late) : "—"}</span>
                    </Tooltip>
                </div>
                {r.cargo
                    ? <div className={classNames(page.cellDouble, r.fleet > 0 && r.emptyVehicles / r.fleet >= 0.5 && styles.warn)}>{r.fleet > 0 ? `${r.emptyVehicles} of ${r.fleet}` : "—"}</div>
                    : <div className={page.cellDouble}>{r.paidTicket ? r.ticketPrice : "—"}</div>}
                <div className={classNames(page.cellDouble, styles.colModels)}>
                    {tagged.length === 0
                        ? <span className={styles.dim}>any</span>
                        : tagged.map((m, i) => m
                            ? <span key={i} className={styles.modelTag}>{name(m)}</span>
                            : <span key={i} className={classNames(styles.modelTag, styles.dim)}>?</span>)}
                </div>
                <div className={classNames(page.cellSingle, styles.colourCell)} onClick={(e) => e.stopPropagation()}>
                    <Tooltip tooltip="Line colour">
                        <ColorField value={r.color} className={item.colorField} onChange={(c) => setLineColor(r.entity, c)} />
                    </Tooltip>
                </div>
                <div className={classNames(page.cellSingle, styles.actionCell)}>
                    <Tooltip tooltip={r.inactive ? "Reactivate" : "Deactivate"}>
                        <IconButton tinted src="Media/Glyphs/OnOff.svg" className={classNames(item.button, item.toggle, r.inactive && item.toggleOff)}
                            onSelect={() => setLineActive(r.entity, r.inactive)} onClick={(e) => e.stopPropagation()} />
                    </Tooltip>
                </div>
                <div className={classNames(page.cellSingle, styles.actionCell)}>
                    <Tooltip tooltip="Day / night / both">
                        <IconButton src={vanilla.getScheduleIcon(schedule)} className={classNames(item.button, item.scheduleButton)}
                            onSelect={() => setLineSchedule(r.entity, nextSchedule(schedule))} onClick={(e) => e.stopPropagation()} />
                    </Tooltip>
                </div>
                <div className={classNames(page.cellSingle, styles.actionCell)}>
                    <Tooltip tooltip="Show / hide on the map">
                        <IconButton tinted src={r.visible ? "Media/Glyphs/EyeOpen.svg" : "Media/Glyphs/EyeClosed.svg"} className={classNames(item.button, item.smallerIcon)}
                            onSelect={() => (r.visible ? hideLine(r.entity, false) : showLine(r.entity, false))} onClick={(e) => e.stopPropagation()} />
                    </Tooltip>
                </div>
                <div className={classNames(page.cellSingle, styles.actionCell)}>
                    <Tooltip tooltip="Select the line">
                        <IconButton tinted src="Media/Glyphs/ViewInfo.svg" className={classNames(item.button, item.smallerIcon)}
                            onSelect={() => selectLine(r.entity)} onClick={(e) => e.stopPropagation()} />
                    </Tooltip>
                </div>
            </div>
        </div>
    );
};

export const FleetPanel = ({ typeSel, onOpenInPlanner }: { typeSel: TypeSelection; onOpenInPlanner: (r: FleetRow) => void }) => {
    const page = vanilla.overviewPage;
    const { PanelSection } = vanilla;
    const unsorted = useValue(fleet$.binding);
    const rows = useMemo(() => [...unsorted].sort(byLine), [unsorted]);
    const catalog = useValue(models$.binding);
    const [picked, setPicked] = useState<Entity[]>([]);
    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [ascending, setAscending] = useState(true);
    const sortBy = (k: SortKey) => { if (k === sortKey) setAscending(!ascending); else { setSortKey(k); setAscending(k === "name"); } };


    const shown = useMemo(() => {
        const list = rows.filter((r) => r.type === typeSel.type && r.cargo === typeSel.cargo);
        const f = sorters[sortKey];
        return list.sort((a, b) => (ascending ? f(a) - f(b) : f(b) - f(a)));
    }, [rows, typeSel, sortKey, ascending]);
    const Head = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
        <div className={classNames(page.cellDouble, className)}>
            <button className={page.button} onClick={() => sortBy(k)}>
                <div className={page.buttonLabel}>{children}</div>
                {sortKey === k && <img className={page.sortIndicator} src={`Media/Glyphs/ThickStrokeArrow${ascending ? "Down" : "Up"}.svg`} />}
            </button>
        </div>
    );
    const selectedRows = useMemo(() => rows.filter((r) => has(picked, r.entity)), [rows, picked]);
    const selectedEntities = selectedRows.map((r) => r.entity);
    const first = selectedRows[0];
    const selType = first && selectedRows.every((r) => r.type === first.type && r.cargo === first.cargo) ? first.type : null;
    const cat = first && selType !== null ? catalog.find((c) => c.type === selType && c.cargo === first.cargo) : undefined;
    // For resolving a row's model tags: the matching (type, cargo) catalogue first, then every
    // catalogue of the type, so a model is named even when the flag is missing or the line's
    // models were picked before a cargo/passenger split.
    const catFor = (t: TransportType, cargo: boolean) =>
        catalog
            .filter((x) => x.type === t)
            .sort((a, b) => Number(b.cargo === cargo) - Number(a.cargo === cargo))
            .flatMap((c) => c.primary.concat(c.secondary));

    const toggle = (e: Entity) => setPicked((p) => (has(p, e) ? p.filter((x) => !sameEntity(x, e)) : [...p, e]));

    const chipState = (model: ModelInfo, slot: "primaryModels" | "secondaryModels"): "all" | "some" | "none" => {
        const n = selectedRows.filter((r) => has(r[slot], model.entity)).length;
        return n === 0 ? "none" : n === selectedRows.length ? "all" : "some";
    };
    const toggleModel = (model: ModelInfo, slot: "primaryModels" | "secondaryModels") => {
        const p = slot === "primaryModels" ? model.entity : NULL;
        const s = slot === "secondaryModels" ? model.entity : NULL;
        if (chipState(model, slot) === "all") removeModel(selectedEntities, p, s);
        else addModel(selectedRows.filter((r) => !has(r[slot], model.entity)).map((r) => r.entity), p, s);
    };
    const applyToType = () => {
        const src = selectedRows[0];
        if (!src || selType === null) return;
        setModels(rows.filter((r) => r.type === selType && r.cargo === src.cargo).map((r) => r.entity), src.primaryModels, src.secondaryModels);
    };
    const optionState = (get: (r: FleetRow) => boolean): "all" | "some" | "none" => {
        const n = selectedRows.filter(get).length;
        return n === 0 ? "none" : n === selectedRows.length ? "all" : "some";
    };
    const toggleOption = (option: RouteOption, get: (r: FleetRow) => boolean) => setOption(selectedEntities, option, optionState(get) !== "all");

    const title = typeTitle(typeSel, typeLabel[typeSel.type] ?? "?");

    return (
        <div className={classNames(page.transportationOverviewPage, styles.fleetPage)}>
            <PanelSection theme={vanilla.panelSection} className={classNames(page.lines, styles.fleetLines)} header={
                <div className={page.header}>
                    <div className={page.title}>{title.toUpperCase()}</div>
                    <div className={page.legends}>
                        <div className={page.cellSingle} />
                        <div className={page.cellSingle} />
                        <div className={classNames(page.cellWide, page.alignLeft)}>
                            <button className={page.button} onClick={() => sortBy("name")}><div className={page.buttonLabel}>Name</div></button>
                        </div>
                        <Head k="length">Length</Head>
                        <Head k="stops">Stops</Head>
                        <Head k="fleet">Vehicles</Head>
                        <Head k="headway">Headway</Head>
                        <Head k="usage" className={page.alignRight}>Usage</Head>
                        <Head k="peak" className={page.alignRight}>Peak</Head>
                        <Head k="low" className={page.alignRight}>Quiet</Head>
                        {typeSel.cargo
                            ? <div className={classNames(page.cellDouble, styles.padLeft)}><div className={page.buttonLabel}>Carrying</div></div>
                            : <Head k="wait" className={styles.padLeft}>Max wait</Head>}
                        <Head k="late">Late</Head>
                        <div className={page.cellDouble}><div className={page.buttonLabel}>{typeSel.cargo ? "Empty" : "Ticket"}</div></div>
                        <div className={page.cellDouble}><div className={page.buttonLabel}>Models</div></div>
                        <div className={classNames(page.cellSingle, styles.colourCell)} />
                        <div className={classNames(page.cellSingle, styles.actionCell)} />
                        <div className={classNames(page.cellSingle, styles.actionCell)} />
                        <div className={classNames(page.cellSingle, styles.actionCell)} />
                        <div className={classNames(page.cellSingle, styles.actionCell)} />
                    </div>
                </div>}>
                <Scrollable vertical className={classNames(page.scrollable, styles.fleetScroll)}>
                    {shown.length === 0 && <div className={page.noLines}>No lines</div>}
                    {shown.map((r) => (
                        <Row key={r.entity.index} r={r} picked={has(picked, r.entity)} models={catFor(r.type, r.cargo)} onToggle={() => toggle(r.entity)} onOpen={onOpenInPlanner} />
                    ))}
                </Scrollable>

                <div className={styles.bulk}>
                    <div className={styles.row}>
                        <span className={styles.sectionTitle}>
                            {selectedRows.length === 0 ? "Click rows to select lines and edit them together" : `${selectedRows.length} selected`}
                        </span>
                        <span className={styles.spacer} />
                        <FlatButton onClick={() => setPicked(shown.map((r) => r.entity))}>Select shown</FlatButton>
                        <FlatButton onClick={() => setPicked([])} disabled={picked.length === 0}>Clear</FlatButton>
                    </div>
                    {selectedRows.length > 0 && (
                        <div className={styles.row}>
                            <span className={styles.fieldLabel}>Options</span>
                            <FlatButton selected={optionState((r) => r.paidTicket) === "all"} onClick={() => toggleOption(RouteOption.PaidTicket, (r) => r.paidTicket)}>Paid ticket</FlatButton>
                            <FlatButton selected={optionState((r) => r.dayOnly) === "all"} onClick={() => toggleOption(RouteOption.Day, (r) => r.dayOnly)}>Day only</FlatButton>
                            <FlatButton selected={optionState((r) => r.nightOnly) === "all"} onClick={() => toggleOption(RouteOption.Night, (r) => r.nightOnly)}>Night only</FlatButton>
                            <FlatButton selected={optionState((r) => r.inactive) === "all"} onClick={() => toggleOption(RouteOption.Inactive, (r) => r.inactive)}>Inactive</FlatButton>
                        </div>
                    )}
                    {cat && (
                        <>
                            <div className={styles.row}>
                                <span className={styles.fieldLabel}>{cat.secondary.length ? "Engines" : "Models"}</span>
                                {/* Checked = on every selected line; toggling adds to the lines missing it or removes from all. */}
                                <ModelDropdown label="" models={cat.primary} cargo={cat.cargo} selected={cat.primary.filter((m) => chipState(m, "primaryModels") === "all").map((m) => m.entity)}
                                    onToggle={(m) => toggleModel(m, "primaryModels")} />
                            </div>
                            {cat.secondary.length > 0 && (
                                <div className={styles.row}>
                                    <span className={styles.fieldLabel}>Carriages</span>
                                    <ModelDropdown label="" models={cat.secondary} cargo={cat.cargo} selected={cat.secondary.filter((m) => chipState(m, "secondaryModels") === "all").map((m) => m.entity)}
                                        onToggle={(m) => toggleModel(m, "secondaryModels")} />
                                </div>
                            )}
                            <div className={styles.row}>
                                <FlatButton onClick={applyToType} tooltip="Copy the first selected line's models onto every line of this type">
                                    Apply first line's models to all {typeLabel[selType!]} lines
                                </FlatButton>
                                <FlatButton onClick={() => setPicked(rows.filter((r) => r.type === selType && r.cargo === first.cargo).map((r) => r.entity))}>Select all {typeLabel[selType!]} lines</FlatButton>
                                <FlatButton onClick={() => setModels(selectedEntities, [], [])} tooltip="Let the game pick any model">Any model</FlatButton>
                            </div>
                        </>
                    )}
                </div>
            </PanelSection>
        </div>
    );
};
