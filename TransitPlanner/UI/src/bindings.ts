import type { Entity, Name } from "cs2/bindings";
import { OneWayBinding } from "utils/onewayBinding";
import { TwoWayBinding } from "utils/bidirectionalBinding";
import triggers from "utils/trigger";
import { CargoInfo, DepotInfo, DepotRow, FleetRow, GapLayer, GroundLayer, LineMap, LineRow, LineStats, ModelCatalog, Network, NetVehicle, NULL_ENTITY, RoadLayer, Schedule, ScheduleBoard, TerrainLayer } from "./types";

// One object per binding in Systems/TP_PlannerUISystem.cs. Keys must match exactly; the shared
// helpers add the BINDING:/TRIGGER: prefixes on both sides.

export const visible$ = new TwoWayBinding<boolean>("visible", false);
export const selected$ = new TwoWayBinding<Entity>("selected", NULL_ENTITY);

/** Current frame of the game day, for the timeline's marker. */
export const timeOfDay$ = new OneWayBinding<number>("timeOfDay", 0);

export const lines$ = new OneWayBinding<LineRow[]>("lines", []);
export const schedule$ = new OneWayBinding<Schedule>("schedule", {
    entity: NULL_ENTITY,
    enabled: false,
    overrideUnbunching: false,
    unbunching: 0,
    closed: [],
    fareMode: 0,
    fareBase: 0,
    farePerKm: 0,
    timetable: false,
    timetableStop: 0,
    timetableFirst: 0,
    timetableInterval: 0,
    timetableFlags: 0,
    timetableLateTolerance: 0,
    timetableResync: 2,
    timetableSlack: 0,
    timetableDepartures: [],
    timingPoints: [],
    loadWaits: [],
    autoFleet: 0,
    bands: [],
});
export const stats$ = new OneWayBinding<LineStats>("stats", {
    valid: false,
    entity: NULL_ENTITY,
    defaultHeadway: 0,
    headway: 0,
    stableDuration: 0,
    fleet: 0,
    target: 0,
    riders: 0,
    capacity: 0,
    unbunching: 0,
    notEnoughVehicles: false,
    paidTicket: false,
    ticketPrice: 0,
    stops: [],
    legs: [],
    history: [],
    punctuality: [],
});

/** The selected cargo line's freight: aboard, per leg, per station. */
export const cargo$ = new OneWayBinding<CargoInfo>("cargo", { valid: false, entity: NULL_ENTITY, vehicles: 0, carried: 0, capacity: 0, emptyVehicles: 0, aboard: [], stops: [] });

/** The selected line's loop, unrolled: stops, legs, vehicles. Recomputed every few frames. */
export const lineMap$ = new OneWayBinding<LineMap>("lineMap", { valid: false, entity: NULL_ENTITY, length: 0, stops: [], legs: [], vehicles: [] });

/** Replaces the line's whole schedule; the apply system picks it up on its next 256-frame tick. */
export const setSchedule = triggers.create<[Schedule]>("setSchedule");
/** Gives every other line at the timetable's anchor stop (or its station) this line's departure grid. */
export const pulseTimetable = triggers.create<[Entity]>("pulseTimetable");

/** The rule set as JSON (Domain/RuleSet); edited whole and handed back with setRules. */
export const rules$ = new OneWayBinding<string>("rules", "");
export const setRules = triggers.create<[string]>("setRules");
/** Runs every enabled rule once, now. */
export const applyRules = triggers.create<[]>("applyRules");

/** The player's own schedule presets as JSON ({ version, presets }); edited whole, like the rules. */
export const presets$ = new OneWayBinding<string>("presets", "");
export const setPresets = triggers.create<[string]>("setPresets");

/** Renames a line (or any named entity) the way the overview does: NameSystem.SetCustomName. */
export const rename = triggers.create<[Entity, string]>("rename");

/** Creates a new line of a type through the given stops, in order, via the placement pipeline. */
export const createLine = triggers.create<[number, boolean, Entity[]]>("createLine");

/** Route variants (spike): which stops the short form keeps, and a rebuild request. */
export const setVariant = triggers.create<[Entity, Entity[]]>("setVariant");
export const rebuildVariant = triggers.create<[Entity, boolean]>("rebuildVariant");

/** Preferred depot: depots of the selected line's type, the line's current preference, and the setter (Null clears). */
export const depots$ = new OneWayBinding<DepotInfo[]>("depots", []);
export const preferredDepot$ = new OneWayBinding<Entity>("preferredDepot", NULL_ENTITY);
export const setPreferredDepot = triggers.create<[Entity, Entity]>("setPreferredDepot");

/** The Depots tab: every depot with the lines it serves / is bound to; bindLines binds many lines at once (Null unbinds). */
export const depotRows$ = new OneWayBinding<DepotRow[]>("depotRows", []);
export const bindLines = triggers.create<[Entity[], Entity]>("bindLines");

/** The network view: every line of the type the UI last asked for (setNetworkType), with stop world positions. */
export const network$ = new OneWayBinding<Network>("network", { valid: false, type: 0, cargo: false, stops: [], lines: [], depots: [], districts: [] });
export const setNetworkType = triggers.create<[number, boolean]>("setNetworkType");

/** The Schedule tab: every line of one type with its whole schedule (TP_PlannerUISystem.Board.cs). */
export const board$ = new OneWayBinding<ScheduleBoard>("scheduleBoard", { type: -1, cargo: false, rows: [], depotCapacity: 0, depotAvailable: 0 });
export const setBoardType = triggers.create<[number, boolean]>("setBoardType");
/** Row order on the Schedule tab: the lines as the player dragged them. */
export const setBoardOrder = triggers.create<[Entity[]]>("setBoardOrder");
/** Named plans: switch the lines to a plan (a new name saves the current bands as it) / drop a stashed plan. */
export const switchPlan = triggers.create<[Entity[], string]>("switchPlan");
export const deletePlan = triggers.create<[Entity[], string]>("deletePlan");
/** Coverage gaps for the shown type; rebuilt rarely (version bumps). */
export const networkGaps$ = new OneWayBinding<GapLayer>("networkGaps", { version: 0, cell: 200, cells: [] });
/** Rebuilds a line through exactly these stops, in order (existing stops keep their waypoints). */
export const editLineStops = triggers.create<[Entity, Entity[]]>("editLineStops");
/** Every road and track edge for the map background; rebuilt rarely (version bumps). */
export const networkRoads$ = new OneWayBinding<RoadLayer>("networkRoads", { version: 0, roadCount: 0, trackCount: 0, roads: [], tracks: [] });
/** Zone blocks and building footprints for the map background; rebuilt rarely. */
export const networkGround$ = new OneWayBinding<GroundLayer>("networkGround", { version: 0, blockCount: 0, buildingCount: 0, blocks: [], buildings: [] });
/** Terrain bands and water on a coarse grid; sampled rarely. */
export const networkTerrain$ = new OneWayBinding<TerrainLayer>("networkTerrain", { version: 0, cells: 0, bands: 0, originX: 0, originY: 0, cellX: 0, cellY: 0, band: [], water: [] });
/** Live figures for the infoview's legend rows (TP_PlannerUISystem.Infoview.cs). */
export interface InfoviewStats {
    stops: number; lines: number; buildings: number; buildingsCovered: number;
    avgFrequency: number; bestFrequency: number; waiting: number; worstWaiting: number;
    worstStopName: Name | null; reachOriginName: Name | null; reachStops: number; reachMax: number;
    vehicles: number; avgLoad: number; boarding: number; held: number; bunched: number;
}
export const infoviewStats$ = new OneWayBinding<InfoviewStats>("infoviewStats", {
    stops: 0, lines: 0, buildings: 0, buildingsCovered: 0, avgFrequency: 0, bestFrequency: 0,
    waiting: 0, worstWaiting: 0, worstStopName: null, reachOriginName: null, reachStops: 0, reachMax: 0,
    vehicles: 0, avgLoad: 0, boarding: 0, held: 0, bunched: 0,
});

/** World overlay (TP_WorldOverlaySystem): what to draw in the 3-D world, and the mod's infoview. */
export interface WorldOverlayRequest { mode: number; radius: number; reachMax: number; stops: Entity[]; values: number[]; force: boolean }
export const setWorldOverlay = triggers.create<[WorldOverlayRequest]>("setWorldOverlay");
export const setWorldHighlight = triggers.create<[Entity]>("setWorldHighlight");
export const infoviewActive$ = new OneWayBinding<boolean>("infoviewActive", false);
/** Toggles the "Transit Planner" infoview, as the infoview menu would. */
export const openInfoview = triggers.create<[]>("openInfoview");
/** The network's vehicles at their world positions, refreshed every few frames. */
export const networkVehicles$ = new OneWayBinding<NetVehicle[]>("networkVehicles", []);

/** Selects a stop or vehicle in the world and puts the camera on it (follows a vehicle). */
export const goTo = triggers.create<[Entity]>("goTo");

/** Selects whatever the vanilla selected-info panel currently shows. */
export const selectFromPanel = triggers.create<[]>("selectFromPanel");

// --- Fleet manager (Systems/TP_FleetUISystem.cs) -----------------------------------------------

export const fleet$ = new OneWayBinding<FleetRow[]>("fleet", []);
export const models$ = new OneWayBinding<ModelCatalog[]>("models", []);

/** Vanilla's select-vehicle algorithm on each line; Null for the slot you are not setting. */
export const addModel = triggers.create<[Entity[], Entity, Entity]>("addModel");
export const removeModel = triggers.create<[Entity[], Entity, Entity]>("removeModel");
/** Replaces each line's whole model list. */
export const setModels = triggers.create<[Entity[], Entity[], Entity[]]>("setModels");
/** Sets a RouteOption policy (Paid ticket / Day / Night / Inactive) on each line. */
export const setOption = triggers.create<[Entity[], number, boolean]>("setOption");
