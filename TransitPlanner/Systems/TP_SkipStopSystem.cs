namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game;
    using Game.Common;
    using Game.Pathfind;
    using Game.Routes;
    using Game.Simulation;
    using Game.Tools;

    using Unity.Collections;
    using Unity.Entities;
    using Unity.Mathematics;

    using ModsCommon.Systems;

    using TransitPlanner.Components;
    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// Express running: turns each line's <see cref="TP_SkipStop"/> list into <see
    /// cref="TP_SkippedNow"/> tags on the waypoints being skipped now. A line whose (enabled)
    /// schedule has Express bands skips its stops exactly while an Express band runs; any other
    /// line uses each entry's own window.
    /// </summary>
    /// <remarks>
    /// The tag does two things elsewhere. The boarding-queue job
    /// (<c>Patches/ResidentBoardingPatches</c>) drops waiting passengers' <c>RequireStop</c> at a
    /// tagged stop, so vanilla's own test-then-skip drives past; riders aboard who want to get off
    /// there still stop the bus, so nobody is carried past their stop. <see
    /// cref="TP_SkipStopPathfindSystem"/> closes the stop to this line in trip planning, so no new
    /// trip counts on it. Tagging goes through the end-of-frame barrier; a waypoint newly tagged
    /// also gets <see cref="TP_SkipDirty"/> (its edge is re-sent), one untagged gets vanilla's
    /// <c>PathfindUpdated</c> (vanilla rebuilds its edge as it was).
    /// </remarks>
    public partial class TP_SkipStopSystem : CommonGameSystemBase {
        private EntityQuery m_LineQuery;
        private EntityQuery m_TaggedQuery;
        private TimeSystem m_TimeSystem;
        private SimulationSystem m_Simulation;
        private EndFrameBarrier m_Barrier;

        public override int GetUpdateInterval(SystemUpdatePhase phase) => 64;

        protected override void OnCreate() {
            base.OnCreate();
            m_TimeSystem = World.GetOrCreateSystemManaged<TimeSystem>();
            m_Simulation = World.GetOrCreateSystemManaged<SimulationSystem>();
            m_Barrier    = World.GetOrCreateSystemManaged<EndFrameBarrier>();
            m_LineQuery = SystemAPI.QueryBuilder()
                                   .WithAll<Route, TransportLine, TP_SkipStop, RouteWaypoint>()
                                   .WithNone<Temp, Deleted>()
                                   .Build();
            m_TaggedQuery = SystemAPI.QueryBuilder()
                                     .WithAll<Waypoint, TP_SkippedNow>()
                                     .Build();
            RequireAnyForUpdate(m_LineQuery, m_TaggedQuery);
        }

        protected override void OnUpdate() {
            var em = EntityManager;
            var frameOfDay = (uint)(math.frac(m_TimeSystem.normalizedTime) * TimeSystem.kTicksPerDay);

            // What should be skipped right now.
            var want = new Dictionary<Entity, Entity>(); // waypoint -> its line
            var lines = m_LineQuery.ToEntityArray(Allocator.Temp);
            foreach (var line in lines) {
                if (!SkipStops.LineCanSkip(em, line)) continue;
                var waypoints = em.GetBuffer<RouteWaypoint>(line, true);
                var skips = em.GetBuffer<TP_SkipStop>(line, true);
                var express = ExpressState(em, line, frameOfDay);
                for (var i = 0; i < skips.Length; i++) {
                    var s = skips[i];
                    if (s.m_Waypoint < 0 || s.m_Waypoint >= waypoints.Length) continue;
                    if (express == Express.None ? !s.ActiveAt(frameOfDay) : express == Express.Idle) continue;
                    var wp = waypoints[s.m_Waypoint].m_Waypoint;
                    if (SkipStops.StopCanBeSkipped(em, wp)) want[wp] = line;
                }
            }
            lines.Dispose();

            var ecb = m_Barrier.CreateCommandBuffer();
            var now = m_Simulation.frameIndex;
            var tagged = m_TaggedQuery.ToEntityArray(Allocator.Temp);
            var had = new HashSet<Entity>();
            var off = 0; var on = 0; var detached = 0;
            foreach (var wp in tagged) {
                had.Add(wp);
                if (want.TryGetValue(wp, out var line)) {
                    // Still skipped. A stop vanilla will not pass by itself is detached once a full
                    // loop has gone by since the skip began: trip planning closed the stop at once,
                    // so by then every rider who planned to get off there has done so.
                    if (!em.HasComponent<TP_SkipDetached>(wp) && !SkipStops.UsesVanillaSkip(em, line, wp)) {
                        var since = em.GetComponentData<TP_SkippedNow>(wp).m_Since;
                        if (now - since >= LoopFrames(em, line)) { Detach(em, ecb, wp); detached++; }
                    }
                    continue;
                }
                ecb.RemoveComponent<TP_SkippedNow>(wp);
                if (em.HasComponent<TP_SkipDetached>(wp)) Reattach(em, ecb, wp);
                if (em.Exists(wp)) ecb.AddComponent<PathfindUpdated>(wp); // vanilla rebuilds the edge
                off++;
            }
            tagged.Dispose();
            foreach (var wp in want.Keys) {
                if (had.Contains(wp)) continue;
                ecb.AddComponent(wp, new TP_SkippedNow { m_Since = now });
                ecb.AddComponent<TP_SkipDirty>(wp);
                on++;
            }
            if (on + off + detached > 0) m_Log.Debug($"Skip stops: {on} started, {off} ended, {detached} detached");
        }

        /// <summary>Makes the stop a corner for every vehicle AI: Connected points at nothing.</summary>
        private static void Detach(EntityManager em, EntityCommandBuffer ecb, Entity wp) {
            if (!em.HasComponent<Connected>(wp)) return;
            var connected = em.GetComponentData<Connected>(wp);
            if (connected.m_Connected == Entity.Null) return;
            ecb.AddComponent(wp, new TP_SkipDetached { m_Stop = connected.m_Connected });
            ecb.SetComponent(wp, new Connected(Entity.Null));
        }

        /// <summary>Puts the stop back (the save guard does the same before every save).</summary>
        internal static void Reattach(EntityManager em, EntityCommandBuffer ecb, Entity wp) {
            var stop = em.GetComponentData<TP_SkipDetached>(wp).m_Stop;
            if (em.HasComponent<Connected>(wp) && em.Exists(stop)) ecb.SetComponent(wp, new Connected(stop));
            ecb.RemoveComponent<TP_SkipDetached>(wp);
        }

        /// <summary>One loop of the line in frames: its legs' measured durations (seconds × 60); an hour if unknown.</summary>
        private static uint LoopFrames(EntityManager em, Entity line) {
            var seconds = 0f;
            if (em.HasBuffer<RouteSegment>(line)) {
                foreach (var s in em.GetBuffer<RouteSegment>(line, true)) {
                    if (em.HasComponent<RouteInfo>(s.m_Segment)) seconds += em.GetComponentData<RouteInfo>(s.m_Segment).m_Duration;
                }
            }
            return seconds > 0f ? (uint)(seconds * 60f) : (uint)(TimeSystem.kTicksPerDay / 24);
        }

        private enum Express { None, Idle, Running }

        /// <summary>
        /// None: the line has no Express band (or its schedule is off), so the stops' own windows
        /// apply. Running / Idle: it has Express bands, and one covers <paramref name="frameOfDay"/> or not.
        /// </summary>
        private static Express ExpressState(EntityManager em, Entity line, uint frameOfDay) {
            if (!em.HasComponent<TP_LineSchedule>(line) || !em.GetComponentData<TP_LineSchedule>(line).Enabled || !em.HasBuffer<TP_ScheduleBand>(line)) return Express.None;
            var any = false;
            foreach (var b in em.GetBuffer<TP_ScheduleBand>(line, true)) {
                if (b.m_Mode != BandMode.Express) continue;
                any = true;
                if (b.Contains(frameOfDay)) return Express.Running;
            }
            return any ? Express.Idle : Express.None;
        }
    }
}
