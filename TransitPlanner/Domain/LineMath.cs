namespace TransitPlanner.Domain {
    #region Using Statements

    using Game.Pathfind;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Simulation;

    using Unity.Entities;

    #endregion

    /// <summary>
    /// The handful of numbers vanilla derives per line, reproduced so the mod's targets never
    /// drift from what <see cref="TransportLineSystem"/> will actually do with them.
    /// </summary>
    public static class LineMath {
        /// <summary>
        /// One loop's duration, stops included: vanilla's <c>stableDuration</c> from
        /// <c>TransportLineSystem.RefreshLineSegments</c> — the pathfinder's duration of every
        /// segment plus the prefab stop time at every timed waypoint. This is what the fleet size
        /// is computed against.
        /// </summary>
        public static float StableDuration(DynamicBuffer<RouteWaypoint> waypoints, DynamicBuffer<RouteSegment> segments,
                                           TransportLineData prefab, ComponentLookup<PathInformation> pathInfo,
                                           ComponentLookup<VehicleTiming> timing) {
            if (waypoints.Length == 0 || segments.Length == 0) return 0f;

            var total = 0f;
            for (var i = 0; i < segments.Length; i++) {
                if (pathInfo.TryGetComponent(segments[i].m_Segment, out var info)) {
                    total += info.m_Duration;
                }
            }
            for (var i = 0; i < waypoints.Length; i++) {
                if (timing.HasComponent(waypoints[i].m_Waypoint)) {
                    total += prefab.m_StopDuration;
                }
            }
            return total;
        }

        /// <summary>The headway vanilla will settle on for <paramref name="interval"/>, given the fleet it implies.</summary>
        public static int FleetFor(float interval, float stableDuration) =>
            TransportLineSystem.CalculateVehicleCount(interval, stableDuration);

        /// <summary>The headway that makes vanilla run exactly <paramref name="fleet"/> vehicles.</summary>
        public static float HeadwayFor(int fleet, float stableDuration) =>
            TransportLineSystem.CalculateVehicleInterval(stableDuration, fleet);
    }
}
