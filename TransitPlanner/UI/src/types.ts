import type { Entity, Name, Color } from "cs2/bindings";

// Mirrors of Domain/PlannerDtos.cs. Field names are the JSON keys the C# writer emits.

/** Game.Prefabs.TransportType. */
export enum TransportType {
    None = -1,
    Bus = 0,
    Train = 1,
    Taxi = 2,
    Tram = 3,
    Ship = 4,
    Post = 5,
    Helicopter = 6,
    Airplane = 7,
    Subway = 8,
    Rocket = 9,
    Work = 10,
    Ferry = 11,
    Bicycle = 12,
    Car = 13,
}

/** Domain/BandMode.cs. */
export enum BandMode {
    Default = 0,
    Headway = 1,
    Fleet = 2,
    /** No service: the line is switched off (Inactive policy) for the band. */
    Off = 3,
    /** Keep load between loadMin and loadMax: the fleet steps up / down at most once a game hour. */
    TargetLoad = 4,
    /** Keep the stop wait between loadMin and loadMax (simulation seconds). Passenger lines. */
    TargetWait = 5,
    /** Fleet from this hour's history: measured fleet × load / value (target load). */
    FollowDemand = 6,
    /** Headway eases from `headway` to `value` (seconds) across the band. */
    Ramp = 7,
    /** `value` departures per game hour. */
    Frequency = 8,
    /** `value` × the headway of `line`. */
    MatchLine = 9,
    /** Freight: stations' mean fill between loadMin and loadMax. */
    StationStock = 10,
    /** The fullest vehicle's load between loadMin and loadMax. */
    CrowdingCap = 11,
    /** Freight: cargo waiting to leave / fleet capacity between loadMin and loadMax. */
    DemandFirst = 12,
    /** Freight: departures on slots every `headway` s; wait for loadMin full or loadMax s past the slot. */
    Convoy = 13,
    /** Budget: every `headway` s but at most `fleet` vehicles. */
    Capped = 14,
    /** Run the line's short form (Short route editor) during the band, every `headway` s. */
    Express = 15,
}

/** Modes that step the fleet once a game hour (and show "Running N now"). */
export const steppingModes = [BandMode.TargetLoad, BandMode.TargetWait, BandMode.StationStock, BandMode.CrowdingCap, BandMode.DemandFirst];

/** Domain/PlannerDtos.cs BoardRow: one line on the Schedule tab. */
export interface BoardRow {
    entity: Entity;
    name: Name;
    color: Color;
    fleet: number;
    target: number;
    /** Simulation seconds. */
    headway: number;
    stable: number;
    notEnoughVehicles: boolean;
    /** Scheduled headway per hour, seconds; 0 = not running. */
    hourHeadway: number[];
    schedule: Schedule;
}

export interface ScheduleBoard {
    type: number;
    cargo: boolean;
    rows: BoardRow[];
    depotCapacity: number;
    depotAvailable: number;
}

export interface LineRow {
    entity: Entity;
    name: Name;
    color: Color;
    type: TransportType;
    cargo: boolean;
    fleet: number;
    target: number;
    riders: number;
    capacity: number;
    /** Simulation seconds. */
    headway: number;
    notEnoughVehicles: boolean;
    scheduled: boolean;
    /** Timetable summary for the Timetable tab (Domain/PlannerDtos.cs LineRow). */
    timetable: boolean;
    ttFlags: number;
    /** Frames of day / frames. */
    ttFirst: number;
    ttInterval: number;
    ttDepartures: number;
    ttTimingPoints: number;
    ttAnchor: Name | null;
    /** 0..1, -1 unmeasured. */
    ttOnTime: number;
    /** Simulation seconds. */
    ttLate: number;
    closedPeriods: number;
    /** Schedule-tab template the line follows ("" = none). */
    template?: string;
}

export interface Band {
    /** Frame of day, inclusive. */
    start: number;
    /** Frame of day, exclusive; below `start` wraps past midnight. */
    end: number;
    mode: BandMode;
    /** Simulation seconds. */
    headway: number;
    fleet: number;
    /** Negative leaves the fare to vanilla. */
    fare: number;
    /** The stepping modes' low / high: load or fill share, or wait seconds (TargetWait). */
    loadMin?: number;
    loadMax?: number;
    /** The mode's own number: end headway s (Ramp), departures/hour (Frequency), target load (FollowDemand), multiplier (MatchLine). */
    value?: number;
    /** MatchLine: the line followed. */
    line?: Entity;
    /** Vehicle models to run in this band (engines / single vehicles); empty keeps the line's own. */
    primary: Entity[];
    /** Carriages, for train-like types. */
    secondary: Entity[];
}

export interface Schedule {
    /** Schedule tab: the shared template (a custom preset name) the line follows, and its row group. "" = none; omit to leave unchanged. */
    template?: string;
    group?: string;
    /** Read-only (setBoardOrder / switchPlan write them): row order, live plan, every plan the line has. */
    order?: number;
    plan?: string;
    plans?: string[];
    entity: Entity;
    enabled: boolean;
    overrideUnbunching: boolean;
    unbunching: number;
    /** Stretches of the day the line does not run (frames of day, start < end), sorted. */
    closed: { start: number; end: number }[];
    /** 0 flat (vanilla / band fare), 1 base + per-km. Mirrors Components/FareMode. */
    fareMode: number;
    fareBase: number;
    farePerKm: number;
    /** Clock-time departures from one anchor stop (frames of day / frames). */
    timetable: boolean;
    timetableStop: number;
    timetableFirst: number;
    timetableInterval: number;
    /** TimetableFlags bits. */
    timetableFlags: number;
    /** Frames a late vehicle may still take its missed slot (LeaveIfLate). */
    timetableLateTolerance: number;
    /** Intervals after which slot memory is forgotten. */
    timetableResync: number;
    /** Recovery margin on derived timing-point offsets, 0..1. */
    timetableSlack: number;
    /** Explicit departures, frames of day (List mode). */
    timetableDepartures: number[];
    timingPoints: TimingPoint[];
    /** Wait-for-load stations: waypoint index, load share to wait for, longest hold (frames). */
    loadWaits: { waypoint: number; minLoad: number; maxWait: number; minWait?: number }[];
    /** Stops the line drives past (bus lines, plain stops): waypoint index and window, frames of the day (start == end = all day). */
    skipStops?: SkipStop[];
    /** Read-only: the fleet a TargetLoad band has arrived at (0 = none yet). */
    autoFleet: number;
    bands: Band[];
}

/** Components/TP_Timetable.cs TimetableFlags. */
export const TimetableFlags = { FollowBands: 1, List: 2, LeaveIfLate: 4 } as const;

export interface TimingPoint {
    /** Waypoint index. */
    waypoint: number;
    /** Frames after the anchor departure. */
    offset: number;
}

export interface PunctualitySample {
    /** Average lateness, simulation seconds. */
    late: number;
    /** 0..1. */
    onTime: number;
    samples: number;
}

export const FareMode = { Flat: 0, Distance: 1 } as const;

/** One depot the selected line could be served from (Domain/PlannerDtos.cs DepotInfo). */
export interface DepotInfo {
    entity: Entity;
    name: Name;
    type: TransportType;
    /** Parked and ready to dispatch. */
    available: number;
    /** Owned in total. */
    owned: number;
    /** Of the selected line's vehicles, how many this depot owns. */
    serving: number;
}

export interface DepotLine {
    entity: Entity;
    name: Name;
    color: Color;
    vehicles: number;
    bound: boolean;
    notEnoughVehicles: boolean;
}

/** One row of the Depots tab (Domain/PlannerDtos.cs DepotRow). */
export interface DepotRow {
    entity: Entity;
    name: Name;
    type: TransportType;
    available: number;
    owned: number;
    capacity: number;
    hasAvailable: boolean;
    starved: boolean;
    lines: DepotLine[];
}

export interface StopStat {
    stop: Entity;
    /** Index in the line's RouteWaypoint buffer. */
    waypoint: number;
    name: Name;
    waiting: number;
    /** Simulation seconds. */
    averageWait: number;
    /** A plain stop on a bus line: express running may skip it. */
    skippable?: boolean;
    /** Being driven past right now. */
    skippedNow?: boolean;
}

/** A stop the line drives past. */
export interface SkipStop { waypoint: number; start: number; end: number }

/** An amount of one resource; `key` is the Game.Economy.Resource enum name (icon Media/Game/Resources/<key>.svg, title Resources.TITLE[<key>]). */
export interface ResourceAmount {
    key: string;
    amount: number;
    /** At a station: the game's rating (Surplus / Normal / Deficit / None). */
    status?: string | null;
}

export interface CargoStop {
    stop: Entity;
    /** Index in the line's RouteWaypoint buffer. */
    waypoint: number;
    name: Name;
    station: Entity;
    stationName: Name;
    stock: ResourceAmount[];
    /** Station total stored and capacity (0 = unknown). */
    stored: number;
    capacity: number;
    /** Vehicles on the leg ending at this stop, their cargo and capacity. */
    legVehicles: number;
    legCarried: number;
    legCapacity: number;
    leg: ResourceAmount[];
}

/** The selected cargo line's freight (Domain/PlannerDtos.cs CargoInfo). */
export interface CargoInfo {
    valid: boolean;
    entity: Entity;
    vehicles: number;
    carried: number;
    capacity: number;
    /** Vehicles carrying nothing right now. */
    emptyVehicles: number;
    aboard: ResourceAmount[];
    stops: CargoStop[];
}

export interface LegStat {
    planned: number;
    achieved: number;
}

export interface LineStats {
    valid: boolean;
    entity: Entity;
    defaultHeadway: number;
    headway: number;
    stableDuration: number;
    fleet: number;
    target: number;
    riders: number;
    capacity: number;
    unbunching: number;
    notEnoughVehicles: boolean;
    paidTicket: boolean;
    ticketPrice: number;
    stops: StopStat[];
    legs: LegStat[];
    /** 24 entries, index = hour of the game day; samples === 0 means no data yet. */
    history: HourSample[];
    /** 24 entries once the line has been timetabled. */
    punctuality: PunctualitySample[];
}

export interface HourSample {
    /** Riders / seats, 0..1+. */
    load: number;
    /** People waiting, per stop. */
    waiting: number;
    /** Average wait, simulation seconds. */
    wait: number;
    /** Vehicles running (smoothed), and the share of them empty 0..1. */
    fleet?: number;
    empty?: number;
    samples: number;
}

/**
 * Two clocks. Band edges and the timeline are FRAMES of the game day (TimeSystem.kTicksPerDay).
 * Every interval and duration the simulation reports (headway, loop, waits) is in SIMULATION
 * SECONDS, 60 frames each (RouteUtils.CalculateDepartureFrame) — so a game day is ~4369 s and
 * vanilla's default 15 s headway is ~4.9 clock-minutes. Convert at the display boundary only.
 */
export const TICKS_PER_DAY = 262144;
export const FRAMES_PER_SECOND = 60;
export const SECONDS_PER_DAY = TICKS_PER_DAY / FRAMES_PER_SECOND;

/** The game's own day/night cut (TransportLineSystem): night is before 06:00 or from 22:00. */
export const DAY_START = TICKS_PER_DAY * 0.25;
export const NIGHT_START = TICKS_PER_DAY * (11 / 12);

export const framesToMinutes = (frames: number) => (frames * 1440) / TICKS_PER_DAY;
export const minutesToFrames = (minutes: number) => (minutes * TICKS_PER_DAY) / 1440;
/** Simulation seconds -> clock minutes of the game day. */
export const secondsToMinutes = (seconds: number) => (seconds * 1440) / SECONDS_PER_DAY;
export const minutesToSeconds = (minutes: number) => (minutes * SECONDS_PER_DAY) / 1440;

/** hh:mm of a frame of the day. */
export const formatTimeOfDay = (frame: number) => {
    const minutes = Math.round(framesToMinutes(((frame % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY));
    const h = Math.floor(minutes / 60) % 24;
    const m = minutes % 60;
    return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
};

/** A simulation-seconds duration as clock time: "12 min" / "1 h 05 min". */
export const formatDuration = (seconds: number) => {
    const minutes = Math.round(secondsToMinutes(seconds));
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${(minutes % 60).toString().padStart(2, "0")} min`;
};

// --- Fleet manager (Domain/FleetDtos.cs) ---------------------------------------------------------

export interface ModelInfo {
    entity: Entity;
    name: Name;
    id: string;
    capacity: number;
    thumbnail: string;
}

export interface ModelCatalog {
    type: TransportType;
    cargo: boolean;
    primary: ModelInfo[];
    secondary: ModelInfo[];
}

export interface FleetRow {
    entity: Entity;
    name: Name;
    color: Color;
    type: TransportType;
    cargo: boolean;
    stops: number;
    /** Metres. */
    length: number;
    visible: boolean;
    fleet: number;
    target: number;
    /** Simulation seconds. */
    headway: number;
    riders: number;
    capacity: number;
    paidTicket: boolean;
    ticketPrice: number;
    notEnoughVehicles: boolean;
    inactive: boolean;
    dayOnly: boolean;
    nightOnly: boolean;
    scheduled: boolean;
    peakLoad: number;
    peakHour: number;
    lowLoad: number;
    /** Simulation seconds. */
    maxWait: number;
    sampledHours: number;
    /** Timetabled lines: share on time 0..1, -1 when not timetabled / unmeasured. */
    onTime: number;
    /** Average lateness, simulation seconds. */
    late: number;
    /** Cargo lines: top resources aboard and vehicles running empty. */
    carrying: ResourceAmount[];
    emptyVehicles: number;
    primaryModels: Entity[];
    secondaryModels: Entity[];
}

// --- Line map (Domain/LineMapDtos.cs) ------------------------------------------------------------

// --- Network view (Domain/NetworkDtos.cs) -------------------------------------------------------

export interface NetStop {
    entity: Entity;
    name: Name;
    /** World x / z, metres. */
    x: number;
    y: number;
    waiting: number;
    lines: number;
    /** Indices into Network.lines of the lines calling here. */
    lineIds: number[];
}

export interface NetDepot {
    entity: Entity;
    name: Name;
    x: number;
    y: number;
    available: number;
    owned: number;
    starved: boolean;
    /** Indices into Network.lines of the lines bound to this depot. */
    boundLines: number[];
}

export interface NetLine {
    entity: Entity;
    name: Name;
    color: Color;
    /** Indices into Network.stops in loop order; the loop closes back to the first. */
    stops: number[];
    /** Real geometry: world x, z pairs along the loop (empty = fall back to stop-to-stop). */
    path: number[];
    /** Per stop, the path point index where that stop's leg begins. */
    legStarts: number[];
    /** Per stop, planned seconds to the next stop. */
    legDurations: number[];
    /** Current headway, simulation seconds. */
    headway: number;
    /** 24 hourly loads, -1 where unsampled. */
    history: number[];
    fleet: number;
    riders: number;
    capacity: number;
    notEnoughVehicles: boolean;
    inactive: boolean;
    /** Scheduled headway per hour of day, simulation seconds; 0 = not running that hour. */
    hourHeadway: number[];
    /** Position in `stops` of the timetable anchor, -1 when not timetabled. */
    anchorStop: number;
    /** Timetabled departures from the anchor, frames of day. */
    departures: number[];
}

/** Coverage gaps: people per 200 m cell with no stop of the shown type within 400 m (x, z, people triples). */
export interface GapLayer {
    version: number;
    cell: number;
    cells: number[];
}

export interface NetVehicle {
    entity: Entity;
    line: Entity;
    x: number;
    y: number;
    riders: number;
    capacity: number;
    boarding: boolean;
    returning: boolean;
    /** Position in the line's stop order of the stop it heads to; its leg is the one ending there. -1 unknown. */
    nextStop: number;
}

export interface Network {
    valid: boolean;
    type: TransportType;
    cargo: boolean;
    stops: NetStop[];
    lines: NetLine[];
    depots: NetDepot[];
    districts: NetDistrict[];
}

/** Every road / track edge, seven floats each: x0 y0, xm ym, x1 y1, width (world x/z). */
export interface RoadLayer {
    version: number;
    roadCount: number;
    trackCount: number;
    roads: number[];
    tracks: number[];
}

/** Zone blocks (8 floats: four corners) and building footprints (5: x z sizeX sizeZ yaw°), world x/z. */
export interface GroundLayer {
    version: number;
    blockCount: number;
    buildingCount: number;
    blocks: number[];
    buildings: number[];
}

/** Terrain height bands and water on a coarse grid (row-major from the south-west corner). */
export interface TerrainLayer {
    version: number;
    cells: number;
    bands: number;
    originX: number;
    originY: number;
    cellX: number;
    cellY: number;
    band: number[];
    water: number[];
}

export interface NetDistrict {
    entity: Entity;
    name: Name;
    /** World x, z pairs of the polygon. */
    points: number[];
}

/** Another line calling at a stop. */
export interface MapTransfer {
    entity: Entity;
    name: Name;
    color: Color;
    type: TransportType;
}

export interface MapStop {
    entity: Entity;
    name: Name;
    /** 0..1 along the loop. */
    at: number;
    waiting: number;
    /** Simulation seconds. */
    averageWait: number;
    transfers: MapTransfer[];
}

export interface MapLeg {
    from: number;
    to: number;
    planned: number;
    achieved: number;
    inactiveDay: boolean;
    inactiveNight: boolean;
}

export interface MapVehicle {
    entity: Entity;
    name: Name;
    at: number;
    riders: number;
    capacity: number;
    state: number;
    boarding: boolean;
    returning: boolean;
}

export interface LineMap {
    valid: boolean;
    entity: Entity;
    /** Metres. */
    length: number;
    stops: MapStop[];
    legs: MapLeg[];
    vehicles: MapVehicle[];
}

// --- Rules (Domain/RuleDtos.cs) -----------------------------------------------------------------

export enum RuleTrigger {
    NewLine = 0,
    PeakLoadAbove = 1,
    LowLoadBelow = 2,
    MaxWaitAbove = 3,
    LateAbove = 4,
    OnTimeBelow = 5,
    NotEnoughVehicles = 6,
    FleetAbove = 7,
    FleetBelow = 8,
    LoadAtHourAbove = 9,
    Always = 10,
}

/** Domain/RuleDtos.cs RuleServiceHours. */
export interface RuleServiceHours {
    on: boolean;
    start: number;
    end: number;
}

/** Domain/RuleDtos.cs RuleTimetable: anchored at the line's first stop. */
export interface RuleTimetable {
    on: boolean;
    followBands: boolean;
    first: number;
    interval: number;
    leaveIfLate: boolean;
    lateTolerance: number;
    allStops: boolean;
    slack: number;
}

/** Domain/RuleDtos.cs RuleOptions; null/undefined fields are left alone. */
export interface RuleOptions {
    unbunching?: number | null;
    paidTicket?: boolean | null;
    routeSchedule?: number | null;
    fareMode?: number | null;
    fareBase: number;
    farePerKm: number;
}

export interface Rule {
    id: string;
    name: string;
    enabled: boolean;
    auto: boolean;
    type: TransportType;
    cargo: boolean;
    trigger: RuleTrigger;
    threshold: number;
    /** Vehicle prefab names (ModelInfo.id). */
    primary: string[];
    secondary: string[];
    bands: Omit<Band, "primary" | "secondary">[];
    /** LoadAtHourAbove: hour of day. */
    hour?: number;
    /** Only lines whose name contains this; empty = all. */
    nameContains?: string;
    serviceHours?: RuleServiceHours | null;
    timetable?: RuleTimetable | null;
    options?: RuleOptions | null;
}

export interface RuleSet {
    version: number;
    rules: Rule[];
}

/** Game.Routes.RouteOption. */
export enum RouteOption {
    Day = 0,
    Night = 1,
    Inactive = 2,
    PaidTicket = 3,
}

/** Game.UI.InGame.RouteSchedule, as vanilla's setLineSchedule takes it. */
export enum RouteSchedule {
    Day = 0,
    Night = 1,
    DayAndNight = 2,
}

/** The vanilla overview's type ids are the TransportType names. */
export const transportTypeId: Record<number, string> = {
    [TransportType.Bus]: "Bus",
    [TransportType.Train]: "Train",
    [TransportType.Taxi]: "Taxi",
    [TransportType.Tram]: "Tram",
    [TransportType.Ship]: "Ship",
    [TransportType.Post]: "Post",
    [TransportType.Helicopter]: "Helicopter",
    [TransportType.Airplane]: "Airplane",
    [TransportType.Subway]: "Subway",
    [TransportType.Rocket]: "Rocket",
    [TransportType.Work]: "Work",
    [TransportType.Ferry]: "Ferry",
    [TransportType.Bicycle]: "Bicycle",
    [TransportType.Car]: "Car",
};

export const NULL_ENTITY: Entity = { index: 0, version: 0 };
export const sameEntity = (a: Entity, b: Entity) => a.index === b.index && a.version === b.version;

/**
 * A stable order for line rows. The C# side lists lines straight from an entity query, whose
 * chunk order is not stable frame to frame, so an unsorted list shuffles under the cursor.
 * Cargo after passenger, then by type, then by entity (creation order, near enough).
 */
export const byLine = <T extends { entity: Entity; type: number; cargo?: boolean }>(a: T, b: T) =>
    Number(a.cargo ?? false) - Number(b.cargo ?? false) || a.type - b.type || a.entity.index - b.entity.index;
