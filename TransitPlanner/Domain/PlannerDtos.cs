namespace TransitPlanner.Domain {
    #region Using Statements

    using Game.UI;

    using Unity.Entities;

    using UnityEngine;

    #endregion

    // Plain data crossing the C# <-> TypeScript boundary through the shared GenericUIWriter /
    // GenericUIReader. Public fields only; enums as int (the reader sets fields by reflection and
    // an int does not coerce into an enum field). Field names are the JSON keys.

    /// <summary>One row of the planner's line list.</summary>
    public struct LineRow {
        public Entity entity;
        public NameSystem.Name name;
        public Color color;
        /// <summary><c>Game.Prefabs.TransportType</c> as int.</summary>
        public int type;
        public bool cargo;
        public int fleet;
        public int target;
        public int riders;
        public int capacity;
        /// <summary>Current headway, simulation seconds (60 frames each).</summary>
        public float headway;
        public bool notEnoughVehicles;
        public bool scheduled;

        // Timetable summary, for the Timetable tab's table (TP_Timetable and friends).
        public bool timetable;
        /// <summary><see cref="Components.TimetableFlags"/> as int.</summary>
        public int ttFlags;
        /// <summary>Frames of the day / frames.</summary>
        public uint ttFirst;
        public uint ttInterval;
        /// <summary>Explicit departures (List mode).</summary>
        public int ttDepartures;
        public int ttTimingPoints;
        /// <summary>The anchor stop's name.</summary>
        public NameSystem.Name ttAnchor;
        /// <summary>Share on time 0..1 over the sampled hours, −1 when unmeasured.</summary>
        public float ttOnTime;
        /// <summary>Average lateness, simulation seconds.</summary>
        public float ttLate;
        /// <summary>Closed periods (service hours) on the line.</summary>
        public int closedPeriods;
        /// <summary>The Schedule-tab template the line follows ("" = none), for "used by N" warnings.</summary>
        public string template;
    }

    /// <summary>The Schedule tab: every line of one type with its whole schedule.</summary>
    public class ScheduleBoard {
        public int type = -1;
        public bool cargo;
        public BoardRow[] rows = System.Array.Empty<BoardRow>();
        /// <summary>Vehicles the type's depots can hold / have ready now.</summary>
        public int depotCapacity;
        public int depotAvailable;
    }

    public class BoardRow {
        public Entity entity;
        public NameSystem.Name name;
        public Color color;
        public int fleet;
        public int target;
        /// <summary>Simulation seconds.</summary>
        public float headway;
        public float stable;
        public bool notEnoughVehicles;
        /// <summary>Scheduled headway per hour, seconds; 0 = not running.</summary>
        public float[] hourHeadway = System.Array.Empty<float>();
        public ScheduleDto schedule;
    }

    /// <summary>One schedule band, as the UI edits it.</summary>
    public class BandDto {
        public uint start;
        public uint end;
        /// <summary><see cref="BandMode"/> as int.</summary>
        public int mode;
        /// <summary>Simulation seconds.</summary>
        public float headway;
        public int fleet;
        public float fare;
        /// <summary>TargetLoad: the load range to hold, 0..1+.</summary>
        public float loadMin;
        public float loadMax;
        /// <summary>The mode's own number (TP_ScheduleBand.m_Value).</summary>
        public float value;
        /// <summary>MatchLine: the line to follow.</summary>
        public Entity line;
        /// <summary>Vehicle models to run in this band; empty leaves the line's own selection.</summary>
        public Entity[] primary = System.Array.Empty<Entity>();
        public Entity[] secondary = System.Array.Empty<Entity>();
    }

    /// <summary>A line's whole schedule, both directions.</summary>
    public class ScheduleDto {
        public Entity entity;
        public bool enabled;
        public bool overrideUnbunching;
        public float unbunching;
        /// <summary>Stretches of the day the line does not run (TP_ClosedPeriod), sorted.</summary>
        public ClosedDto[] closed = System.Array.Empty<ClosedDto>();
        /// <summary><see cref="Components.FareMode"/> as int: 0 flat (vanilla / band fare), 1 by distance.</summary>
        public int fareMode;
        public int fareBase;
        public float farePerKm;
        /// <summary>Clock-time departures from one anchor stop; see <see cref="Components.TP_Timetable"/>.</summary>
        public bool timetable;
        public int timetableStop;
        /// <summary>Frames of the day.</summary>
        public uint timetableFirst;
        /// <summary>Frames.</summary>
        public uint timetableInterval;
        /// <summary><see cref="Components.TimetableFlags"/> as int.</summary>
        public int timetableFlags;
        /// <summary>Frames a vehicle may be late and still take its missed slot (LeaveIfLate).</summary>
        public uint timetableLateTolerance;
        /// <summary>Intervals after which slot memory is forgotten.</summary>
        public int timetableResync = 2;
        /// <summary>Recovery margin on derived timing-point offsets, 0..1.</summary>
        public float timetableSlack;
        /// <summary>Explicit departures, frames of the day (List mode).</summary>
        public uint[] timetableDepartures = System.Array.Empty<uint>();
        public TimingPointDto[] timingPoints = System.Array.Empty<TimingPointDto>();
        /// <summary>Wait-for-load stations (TP_LoadWait).</summary>
        public LoadWaitDto[] loadWaits = System.Array.Empty<LoadWaitDto>();
        /// <summary>Stops the line drives past (TP_SkipStop).</summary>
        public SkipStopDto[] skipStops = System.Array.Empty<SkipStopDto>();
        /// <summary>Read-only: the fleet a TargetLoad band has arrived at (0 = none yet).</summary>
        public int autoFleet;
        /// <summary>Schedule tab: the shared template the line follows / its row group. Null on a write = leave unchanged, "" = none.</summary>
        public string template;
        public string group;
        /// <summary>Read-only here (written by setBoardOrder / switchPlan): row order, live plan, every plan the line has.</summary>
        public int order;
        public string plan;
        public string[] plans = System.Array.Empty<string>();
        public BandDto[] bands = System.Array.Empty<BandDto>();
    }

    /// <summary>A wait-for-load station: waypoint index, load share to wait for (0..1), longest hold (frames).</summary>
    public class LoadWaitDto {
        public int waypoint;
        public float minLoad;
        public uint maxWait;
        /// <summary>Frames: the shortest hold.</summary>
        public uint minWait;
    }

    /// <summary>A skipped stop: waypoint index and window, frames of the day (start == end = all day).</summary>
    public class SkipStopDto {
        public int waypoint;
        public uint start;
        public uint end;
    }

    /// <summary>A closed period, frames of the day, start &lt; end.</summary>
    public class ClosedDto {
        public uint start;
        public uint end;
    }

    /// <summary>A timing point: waypoint index and frames after the anchor departure.</summary>
    public class TimingPointDto {
        public int waypoint;
        public uint offset;
    }

    /// <summary>One hour of a timetabled line's punctuality (TP_Punctuality).</summary>
    public struct PunctualitySample {
        /// <summary>Average lateness, simulation seconds.</summary>
        public float late;
        /// <summary>Share on time, 0..1.</summary>
        public float onTime;
        public int samples;
    }

    /// <summary>An amount of one resource; <see cref="key"/> is the <c>Game.Economy.Resource</c> enum name (the game's UI keys icons and titles on it).</summary>
    public struct ResourceAmount {
        public string key;
        public int amount;
        /// <summary>At a station: the game's own rating (UIResource.ResourceStatus name: Surplus / Normal / Deficit / None); null elsewhere.</summary>
        public string status;
    }

    /// <summary>One stop of a cargo line: its station's stock and what is moving on the leg that ends here.</summary>
    public struct CargoStop {
        public Entity stop;
        public NameSystem.Name name;
        /// <summary>Index in the line's RouteWaypoint buffer (what TP_LoadWait keys on).</summary>
        public int waypoint;
        /// <summary>The station building owning the stop, or Null.</summary>
        public Entity station;
        public NameSystem.Name stationName;
        public ResourceAmount[] stock;
        /// <summary>What the station holds in total, and its capacity (upgrades included; 0 when unknown).</summary>
        public int stored;
        public int capacity;
        /// <summary>Vehicles on the leg ending at this stop, their cargo, and their capacity.</summary>
        public int legVehicles;
        public int legCarried;
        public int legCapacity;
        public ResourceAmount[] leg;
    }

    /// <summary>The selected cargo line's freight: aboard now, per leg, and per station.</summary>
    public class CargoInfo {
        public bool valid;
        public Entity entity;
        public int vehicles;
        public int carried;
        public int capacity;
        /// <summary>Vehicles carrying nothing right now: the line's empty running.</summary>
        public int emptyVehicles;
        public ResourceAmount[] aboard = System.Array.Empty<ResourceAmount>();
        public CargoStop[] stops = System.Array.Empty<CargoStop>();
    }

    /// <summary>One depot the selected line could be served from.</summary>
    public struct DepotInfo {
        public Entity entity;
        public NameSystem.Name name;
        /// <summary><c>Game.Prefabs.TransportType</c> as int.</summary>
        public int type;
        /// <summary>Vehicles parked and ready to dispatch.</summary>
        public int available;
        /// <summary>Vehicles owned in total.</summary>
        public int owned;
        /// <summary>How many of the selected line's vehicles this depot owns right now.</summary>
        public int serving;
    }

    /// <summary>One line as seen from a depot's row.</summary>
    public struct DepotLine {
        public Entity entity;
        public NameSystem.Name name;
        public Color color;
        /// <summary>Vehicles of this line the depot owns right now.</summary>
        public int vehicles;
        /// <summary>The line is bound to this depot (TP_PreferredDepot).</summary>
        public bool bound;
        public bool notEnoughVehicles;
    }

    /// <summary>One row of the Depots tab.</summary>
    public struct DepotRow {
        public Entity entity;
        public NameSystem.Name name;
        public int type;
        public int available;
        public int owned;
        /// <summary>Prefab capacity (upgrades not counted).</summary>
        public int capacity;
        public bool hasAvailable;
        /// <summary>A bound line is short of vehicles while this depot has none spare.</summary>
        public bool starved;
        public DepotLine[] lines;
    }

    /// <summary>What the game measured at one stop.</summary>
    public struct StopStat {
        public Entity stop;
        /// <summary>Index in the line's <c>RouteWaypoint</c> buffer (corners are skipped in this list).</summary>
        public int waypoint;
        public NameSystem.Name name;
        public int waiting;
        /// <summary>Average wait, simulation seconds.</summary>
        public int averageWait;
        /// <summary>A plain stop (not a station) on a bus line: express running may skip it.</summary>
        public bool skippable;
        /// <summary>Being driven past right now.</summary>
        public bool skippedNow;
    }

    /// <summary>What the game measured on one leg.</summary>
    public struct LegStat {
        /// <summary>Pathfinder estimate, simulation seconds.</summary>
        public float planned;
        /// <summary>Estimate scaled by measured travel time, simulation seconds (vanilla's RouteInfo).</summary>
        public float achieved;
    }

    /// <summary>One hour of a line's measured history (TP_LoadSample).</summary>
    public struct HourSample {
        public float load;
        public float waiting;
        public float wait;
        /// <summary>Vehicles running (smoothed) and the share of them running empty, 0..1.</summary>
        public float fleet;
        public float empty;
        public int samples;
    }

    /// <summary>The selected line's measured performance.</summary>
    public class LineStats {
        public bool valid;
        public Entity entity;
        public float defaultHeadway;
        public float headway;
        public float stableDuration;
        public int fleet;
        public int target;
        public int riders;
        public int capacity;
        public float unbunching;
        public bool notEnoughVehicles;
        public bool paidTicket;
        public int ticketPrice;
        public StopStat[] stops = System.Array.Empty<StopStat>();
        public LegStat[] legs = System.Array.Empty<LegStat>();
        /// <summary>24 entries, index = hour of the game day.</summary>
        public HourSample[] history = System.Array.Empty<HourSample>();
        /// <summary>24 entries when the line has been timetabled, else empty.</summary>
        public PunctualitySample[] punctuality = System.Array.Empty<PunctualitySample>();
    }
}
