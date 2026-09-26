namespace TransitPlanner.Patches {
    #region Using Statements

    using Game.Common;
    using Game.Pathfind;
    using Game.Routes;
    using Game.Simulation;

    using HarmonyLib;

    using Unity.Burst;
    using Unity.Collections;
    using Unity.Entities;
    using Unity.Jobs;
    using Unity.Mathematics;

    using TransitPlanner.Components;

    #endregion

    /// <summary>
    /// Fares the way the player set them, charged the way vanilla charges them. Vanilla computes a
    /// ride's price inside <c>ResidentAISystem.ResidentTickJob</c> (Burst) and charges it in
    /// <c>ResidentAISystem.Actions.BoardingJob</c> (also Burst); the two talk through the public
    /// <c>Actions.m_BoardingQueue</c>, gated by the public <c>Actions.m_Dependency</c>. This
    /// prefix on <c>Actions.OnUpdate</c> schedules a job between them that rewrites
    /// <c>m_TicketPrice</c> on every <c>FinishEnter</c> item and bumps the dependency so the
    /// charging job waits. Two rewrites:
    /// <list type="bullet">
    /// <item>The head-car fix, on every line: vanilla reads the price through the boarded car's
    /// <c>CurrentRoute</c>, which only the controller carries, so riders boarding a trailing car
    /// paid nothing. The queue item names the controller (<c>m_LeaderVehicle</c>); read it there.</item>
    /// <item>Distance fares, on lines with a <see cref="TP_FareRule"/>: the passenger's path holds
    /// the boarding waypoint and the exit waypoint back to back, both resolvable to stops through
    /// <c>Connected</c>; the kilometres between them along the line's <c>RouteSegment</c>s
    /// (<c>RouteInfo.m_Distance</c>) price the ride.</item>
    /// </list>
    /// Also express running: a <c>RequireStop</c> from a passenger WAITING at a stop the line is
    /// skipping now (<see cref="TP_SkippedNow"/> on the vehicle's target waypoint) is dropped, so
    /// vanilla's test-then-skip drives past. Requests from riders aboard (no passenger entity in
    /// the item) are kept: the bus still stops for someone who wants to get off there.
    /// </summary>
    /// <remarks>
    /// Never touches any other queue item type, the queue's order, or the vanilla jobs. Costs one
    /// drain-and-refill of a queue that holds a handful of items per frame.
    /// </remarks>
    [HarmonyPatch(typeof(ResidentAISystem.Actions), "OnUpdate")]
    public static class ResidentBoardingPatches {
        [HarmonyPrefix]
        public static void Prefix(ResidentAISystem.Actions __instance) {
            if (!__instance.m_BoardingQueue.IsCreated) return;
            var job = new RewriteFaresJob {
                m_Queue          = __instance.m_BoardingQueue,
                m_CurrentRoute   = __instance.GetComponentLookup<CurrentRoute>(true),
                m_TransportLine  = __instance.GetComponentLookup<TransportLine>(true),
                m_FareRule       = __instance.GetComponentLookup<TP_FareRule>(true),
                m_PathOwner      = __instance.GetComponentLookup<PathOwner>(true),
                m_Connected      = __instance.GetComponentLookup<Connected>(true),
                m_RouteInfo      = __instance.GetComponentLookup<RouteInfo>(true),
                m_PathElements   = __instance.GetBufferLookup<PathElement>(true),
                m_RouteWaypoints = __instance.GetBufferLookup<RouteWaypoint>(true),
                m_RouteSegments  = __instance.GetBufferLookup<RouteSegment>(true),
                m_Target         = __instance.GetComponentLookup<Target>(true),
                m_SkippedNow     = __instance.GetComponentLookup<TP_SkippedNow>(true),
            };
            // After the tick job that filled the queue (m_Dependency is its handle); before the
            // boarding job, which the original OnUpdate schedules on m_Dependency. The system's
            // own Dependency ends up depending on the boarding job, so ours is tracked transitively.
            __instance.m_Dependency = job.Schedule(__instance.m_Dependency);
        }

        [BurstCompile]
        private struct RewriteFaresJob : IJob {
            public NativeQueue<ResidentAISystem.Boarding> m_Queue;
            [ReadOnly] public ComponentLookup<CurrentRoute> m_CurrentRoute;
            [ReadOnly] public ComponentLookup<TransportLine> m_TransportLine;
            [ReadOnly] public ComponentLookup<TP_FareRule> m_FareRule;
            [ReadOnly] public ComponentLookup<PathOwner> m_PathOwner;
            [ReadOnly] public ComponentLookup<Connected> m_Connected;
            [ReadOnly] public ComponentLookup<RouteInfo> m_RouteInfo;
            [ReadOnly] public BufferLookup<PathElement> m_PathElements;
            [ReadOnly] public BufferLookup<RouteWaypoint> m_RouteWaypoints;
            [ReadOnly] public BufferLookup<RouteSegment> m_RouteSegments;
            [ReadOnly] public ComponentLookup<Target> m_Target;
            [ReadOnly] public ComponentLookup<TP_SkippedNow> m_SkippedNow;

            public void Execute() {
                var count = m_Queue.Count;
                if (count == 0) return;
                var items = new NativeList<ResidentAISystem.Boarding>(count, Allocator.Temp);
                for (var i = 0; i < count; i++) {
                    var item = m_Queue.Dequeue();
                    if (item.m_Type == ResidentAISystem.BoardingType.FinishEnter) item.m_TicketPrice = Price(item);
                    else if (item.m_Type == ResidentAISystem.BoardingType.RequireStop && WaitingAtSkippedStop(item)) continue;
                    items.Add(item);
                }
                for (var i = 0; i < items.Length; i++) m_Queue.Enqueue(items[i]);
                items.Dispose();
            }

            /// <summary>
            /// A stop request from a passenger waiting (not riding) at a stop the vehicle's line is
            /// skipping now. The vehicle is the one testing the stop; its target is that stop's waypoint.
            /// </summary>
            private bool WaitingAtSkippedStop(in ResidentAISystem.Boarding item) =>
                item.m_Passenger != Entity.Null &&
                m_Target.TryGetComponent(item.m_Vehicle, out var target) &&
                m_SkippedNow.HasComponent(target.m_Target);

            private int Price(in ResidentAISystem.Boarding item) {
                // The controller is the car that knows the route; a trailing car has no CurrentRoute.
                var controller = item.m_LeaderVehicle != Entity.Null ? item.m_LeaderVehicle : item.m_Vehicle;
                if (!m_CurrentRoute.TryGetComponent(controller, out var current) || !m_TransportLine.TryGetComponent(current.m_Route, out var line)) return item.m_TicketPrice;
                var route = current.m_Route;
                var flat  = line.m_TicketPrice;

                if (!m_FareRule.TryGetComponent(route, out var rule) || rule.m_Mode != FareMode.Distance) return flat;
                if (!TryRideDistance(item.m_Passenger, route, out var metres)) return math.max(flat, rule.m_Base);
                return math.max(0, (int)math.round(rule.m_Base + rule.m_PerKm * metres / 1000f));
            }

            /// <summary>Metres along the line from the passenger's boarding stop to their exit stop.</summary>
            private bool TryRideDistance(Entity passenger, Entity route, out float metres) {
                metres = 0f;
                if (!m_PathOwner.TryGetComponent(passenger, out var owner) || !m_PathElements.TryGetBuffer(passenger, out var path)) return false;
                if (!m_RouteWaypoints.TryGetBuffer(route, out var waypoints) || !m_RouteSegments.TryGetBuffer(route, out var segments)) return false;
                if (segments.Length == 0 || waypoints.Length != segments.Length) return false;

                // The path holds boarding waypoint then exit waypoint back to back; the index may or
                // may not have advanced yet, so look around it for the first such pair on this line.
                var from = -1; var to = -1;
                for (var e = math.max(0, owner.m_ElementIndex - 1); e + 1 < path.Length && e <= owner.m_ElementIndex + 1; e++) {
                    var a = WaypointIndex(waypoints, path[e].m_Target);
                    if (a < 0) continue;
                    var b = WaypointIndex(waypoints, path[e + 1].m_Target);
                    if (b < 0) continue;
                    from = a; to = b;
                    break;
                }
                if (from < 0 || from == to) return false;

                // Segment k runs waypoint k → k+1, wrapping at the end of the loop.
                var n = waypoints.Length;
                for (var k = from; k != to; k = (k + 1) % n) {
                    if (m_RouteInfo.TryGetComponent(segments[k].m_Segment, out var info)) metres += info.m_Distance;
                }
                return true;
            }

            /// <summary>Index of the line's waypoint at the same stop as <paramref name="pathWaypoint"/>, or -1.</summary>
            private int WaypointIndex(DynamicBuffer<RouteWaypoint> waypoints, Entity pathWaypoint) {
                if (!m_Connected.TryGetComponent(pathWaypoint, out var c) || c.m_Connected == Entity.Null) return -1;
                for (var i = 0; i < waypoints.Length; i++) {
                    if (waypoints[i].m_Waypoint == pathWaypoint) return i;
                    if (m_Connected.TryGetComponent(waypoints[i].m_Waypoint, out var lc) && lc.m_Connected == c.m_Connected) return i;
                }
                return -1;
            }
        }
    }
}
