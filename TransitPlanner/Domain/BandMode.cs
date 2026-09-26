namespace TransitPlanner.Domain {
    /// <summary>
    /// What a schedule band does to the line while the clock is inside it.
    /// </summary>
    // Stored as a byte in the save; append new values, never reorder.
    public enum BandMode : byte {
        /// <summary>Hands control back to vanilla: the line's policies (incl. the vehicle-count slider) apply.</summary>
        Default = 0,

        /// <summary>Run one vehicle every <c>m_Headway</c> frames.</summary>
        Headway = 1,

        /// <summary>Run exactly <c>m_Fleet</c> vehicles, whatever the line length.</summary>
        Fleet = 2,

        /// <summary>
        /// No service: the line is switched off for the band through vanilla's Inactive route
        /// policy (the only way to a fleet of zero — the tick floors an active line at one
        /// vehicle). Vehicles return to the depot and come back when the band ends.
        /// </summary>
        Off = 3,
        /// <summary>
        /// Keep the line's load (riders / seats, or cargo / capacity) between
        /// <c>m_LoadMin</c> and <c>m_LoadMax</c>: the apply tick adds a vehicle while the hour's
        /// measured load is above the range and removes one while it is below, at most once per
        /// game hour. The fleet it arrives at lives in <c>TP_LineSchedule.m_AutoFleet</c>.
        /// </summary>
        TargetLoad = 4,

        /// <summary>
        /// Keep the average wait at the line's stops between <c>m_LoadMin</c> and <c>m_LoadMax</c>
        /// (simulation seconds): a vehicle more while the hour's measured wait is longer, one fewer
        /// while it is shorter, at most once a game hour. Passenger lines.
        /// </summary>
        TargetWait = 5,

        /// <summary>
        /// Size the fleet from this hour's history instead of reacting: the fleet that would have
        /// run the hour at <c>m_Value</c> load (measured fleet × measured load / target).
        /// </summary>
        FollowDemand = 6,

        /// <summary>Headway eases from <c>m_Headway</c> at the band's start to <c>m_Value</c> at its end (seconds).</summary>
        Ramp = 7,

        /// <summary><c>m_Value</c> departures per game hour (a headway entered the other way round).</summary>
        Frequency = 8,

        /// <summary>
        /// Run at <c>m_Value</c> × the headway of <c>m_Line</c> (1 = the same, 2 = half as often),
        /// so a line tracks the one it feeds or shares a corridor with.
        /// </summary>
        MatchLine = 9,

        /// <summary>
        /// Freight: follow the stock at the line's stations. A vehicle more while they are on
        /// average fuller than <c>m_LoadMax</c> of their capacity (cargo piling up), one fewer while
        /// emptier than <c>m_LoadMin</c>, at most once a game hour.
        /// </summary>
        StationStock = 10,

        /// <summary>
        /// Crowding cap: a vehicle more while the fullest vehicle on the line is above
        /// <c>m_LoadMax</c>, one fewer while it is below <c>m_LoadMin</c> — the worst leg, not the
        /// line's average. At most once a game hour.
        /// </summary>
        CrowdingCap = 11,

        /// <summary>
        /// Freight: follow the cargo waiting to leave. The line's stations' outgoing
        /// <c>StorageTransferRequest</c>s bound for another station on the line, against the fleet's
        /// capacity: a vehicle more above <c>m_LoadMax</c> (e.g. 1 = a full fleet-load waiting),
        /// one fewer below <c>m_LoadMin</c>. At most once a game hour.
        /// </summary>
        DemandFirst = 12,

        /// <summary>
        /// Freight convoy: departures from the anchor stop (the timetable's, else the first stop)
        /// only on slots every <c>m_Headway</c> seconds from the band start; at a slot a vehicle
        /// still waits until it is <c>m_LoadMin</c> full or <c>m_LoadMax</c> seconds have passed.
        /// The fleet is sized from <c>m_Headway</c>.
        /// </summary>
        Convoy = 13,

        /// <summary>
        /// Budget: one vehicle every <c>m_Headway</c> seconds, but never more than <c>m_Fleet</c>
        /// vehicles — the game costs vehicles through the depot's upkeep, not per line, so a
        /// line's budget is its fleet.
        /// </summary>
        Capped = 14,

        /// <summary>
        /// Express: while the band runs, the line's buses drive past the stops ticked under Skip
        /// stops (<see cref="Components.TP_SkipStop"/>); headway <c>m_Headway</c>. (It once rebuilt
        /// the route into a short form; that was replaced by skipping, which keeps every stop on
        /// the line.)
        /// </summary>
        Express = 15,
    }
}
