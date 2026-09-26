namespace TransitPlanner.Domain {
    #region Using Statements

    using System.Collections.Generic;

    #endregion

    /// <summary>What makes a rule fire.</summary>
    public enum RuleTrigger {
        /// <summary>Once, when the planner first sees the line.</summary>
        NewLine = 0,
        /// <summary>The busiest sampled hour's load is above the threshold (0..1+).</summary>
        PeakLoadAbove = 1,
        /// <summary>The quietest sampled hour's load is below the threshold (0..1).</summary>
        LowLoadBelow = 2,
        /// <summary>The longest hourly average wait is above the threshold (simulation seconds).</summary>
        MaxWaitAbove = 3,
        /// <summary>A timetabled line's average departure lateness is above the threshold (simulation seconds).</summary>
        LateAbove = 4,
        /// <summary>A timetabled line's on-time share is below the threshold (0..1).</summary>
        OnTimeBelow = 5,
        /// <summary>The line is flagged short of vehicles right now.</summary>
        NotEnoughVehicles = 6,
        /// <summary>The line runs more vehicles than the threshold.</summary>
        FleetAbove = 7,
        /// <summary>The line runs fewer vehicles than the threshold.</summary>
        FleetBelow = 8,
        /// <summary>The load in hour <see cref="Rule.hour"/> is above the threshold (0..1+).</summary>
        LoadAtHourAbove = 9,
        /// <summary>Every tick: the rule's actions are kept in force on every line in scope.</summary>
        Always = 10,
    }

    /// <summary>Service hours a rule sets: on with a window, or off (all day).</summary>
    public class RuleServiceHours {
        public bool on = true;
        /// <summary>Frames of the day.</summary>
        public uint start;
        public uint end;
    }

    /// <summary>A timetable a rule sets, anchored at the line's first stop; <see cref="on"/> false removes it.</summary>
    public class RuleTimetable {
        public bool on = true;
        public bool followBands;
        /// <summary>Frames of the day.</summary>
        public uint first;
        /// <summary>Frames.</summary>
        public uint interval;
        public bool leaveIfLate;
        /// <summary>Frames.</summary>
        public uint lateTolerance;
        /// <summary>Hold at every stop until its scheduled time (leg times × (1 + slack)).</summary>
        public bool allStops;
        public float slack;
    }

    /// <summary>Line options a rule sets; a null field is left alone.</summary>
    public class RuleOptions {
        /// <summary>Unbunching factor (1 = vanilla hold); negative hands it back to vanilla.</summary>
        public float? unbunching;
        public bool? paidTicket;
        /// <summary>0 day only, 1 night only, 2 day and night (vanilla's RouteSchedule).</summary>
        public int? routeSchedule;
        /// <summary><see cref="Components.FareMode"/> as int.</summary>
        public int? fareMode;
        public int fareBase;
        public float farePerKm;
    }

    /// <summary>
    /// One rule, as edited in the UI and stored as JSON in the settings file. Rules are a player
    /// preference rather than city state — the same rule set applies in every city — so vehicle
    /// prefabs are held by name and resolved per save.
    /// </summary>
    public class Rule {
        public string id = System.Guid.NewGuid().ToString("N");
        public string name = "";
        public bool enabled = true;
        /// <summary>Evaluated on the simulation tick; off, the rule runs only on "apply now".</summary>
        public bool auto = true;
        /// <summary>Scope: <c>TransportType</c> as int, and the passenger/cargo group.</summary>
        public int type;
        public bool cargo;
        /// <summary><see cref="RuleTrigger"/> as int.</summary>
        public int trigger;
        public float threshold;
        /// <summary>Set the line's models to these prefab names; empty = leave models alone.</summary>
        public List<string> primary = new List<string>();
        public List<string> secondary = new List<string>();
        /// <summary>Replace the line's schedule with these bands and switch it on; empty = leave it.</summary>
        public List<BandDto> bands = new List<BandDto>();
        /// <summary>Hour of the day for <see cref="RuleTrigger.LoadAtHourAbove"/>.</summary>
        public int hour = 8;
        /// <summary>Only lines whose name contains this (case-insensitive); empty = every line of the type.</summary>
        public string nameContains = "";
        /// <summary>Null = leave alone.</summary>
        public RuleServiceHours serviceHours;
        public RuleTimetable timetable;
        public RuleOptions options;
    }

    /// <summary>The rule set, JSON-serialised into <c>Setting.RulesJson</c>.</summary>
    public class RuleSet {
        public int version = 1;
        public List<Rule> rules = new List<Rule>();
    }
}
