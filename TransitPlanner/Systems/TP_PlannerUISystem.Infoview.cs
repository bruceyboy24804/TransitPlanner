namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Tools;

    using Unity.Collections;
    using Unity.Entities;
    using Unity.Mathematics;

    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// Live figures for the Transit Planner infoview's legend rows (the UI swaps its own row in
    /// for each of our infomodes, rcav8tr's `InfomodeItem` extension recipe): stops and lines,
    /// the share of buildings within a short walk of a stop, average and best service frequency,
    /// total and worst waiting, and the reach origin. Recomputed every few seconds.
    /// </summary>
    public partial class TP_PlannerUISystem {
        private EntityQuery   m_AllStopQuery;
        private EntityQuery   m_BuildingQueryIv;
        private InfoviewStats m_IvStats = new InfoviewStats();
        private int           m_IvFrame = -1;
        private const int     kIvEveryFrames = 120;
        private const float   kWalk = 400f;

        private void CreateInfoviewStatsBindings() {
            m_AllStopQuery   = SystemAPI.QueryBuilder().WithAll<Game.Routes.TransportStop, Game.Objects.Transform>().WithNone<Temp, Deleted>().Build();
            m_BuildingQueryIv = SystemAPI.QueryBuilder().WithAll<Game.Buildings.Building, Game.Objects.Transform>().WithNone<Temp, Deleted, Owner>().Build();
            CreateBinding("infoviewStats", ReadInfoviewStats);
        }

        private InfoviewStats ReadInfoviewStats() {
            var frame = UnityEngine.Time.frameCount;
            if (frame - m_IvFrame < kIvEveryFrames) return m_IvStats;
            m_IvFrame = frame;
            var em = EntityManager;
            var s  = new InfoviewStats();

            // Stops into a coarse grid for the walk test; frequency and waiting per stop meanwhile.
            var stops = m_AllStopQuery.ToEntityArray(Allocator.Temp);
            var grid  = new Dictionary<int2, List<float2>>();
            var freqSum = 0f; var freqN = 0; var bestFreq = 0f;
            var worstWait = 0; var worstStop = Entity.Null;
            foreach (var stop in stops) {
                var p = em.GetComponentData<Game.Objects.Transform>(stop).m_Position;
                var xz = new float2(p.x, p.z);
                var cell = (int2)math.floor(xz / kWalk);
                if (!grid.TryGetValue(cell, out var list)) grid[cell] = list = new List<float2>();
                list.Add(xz);
                s.stops++;
                if (!em.HasBuffer<ConnectedRoute>(stop)) continue;
                var perHour = 0f; var waiting = 0; var lines = 0;
                foreach (var cr in em.GetBuffer<ConnectedRoute>(stop, true)) {
                    if (em.HasComponent<WaitingPassengers>(cr.m_Waypoint)) waiting += em.GetComponentData<WaitingPassengers>(cr.m_Waypoint).m_Count;
                    if (!em.HasComponent<Owner>(cr.m_Waypoint)) continue;
                    var line = em.GetComponentData<Owner>(cr.m_Waypoint).m_Owner;
                    if (!em.HasComponent<TransportLine>(line)) continue;
                    lines++;
                    var interval = em.GetComponentData<TransportLine>(line).m_VehicleInterval;
                    if (interval > 0f) perHour += (4369f / 24f) / interval;
                }
                if (lines > 0) { freqSum += perHour; freqN++; bestFreq = math.max(bestFreq, perHour); }
                s.waiting += waiting;
                if (waiting > worstWait) { worstWait = waiting; worstStop = stop; }
            }
            stops.Dispose();
            s.lines        = m_LineQuery.CalculateEntityCount();
            s.avgFrequency = freqN > 0 ? freqSum / freqN : 0f;
            s.bestFrequency = bestFreq;
            s.worstWaiting = worstWait;
            if (worstStop != Entity.Null) s.worstStopName = m_Names.GetName(worstStop);

            // Buildings within a walk of a stop: the 3×3 cells around the building's own.
            var buildings = m_BuildingQueryIv.ToEntityArray(Allocator.Temp);
            foreach (var b in buildings) {
                var p = em.GetComponentData<Game.Objects.Transform>(b).m_Position;
                var xz = new float2(p.x, p.z);
                var c  = (int2)math.floor(xz / kWalk);
                var near = false;
                for (var dy = -1; dy <= 1 && !near; dy++) for (var dx = -1; dx <= 1 && !near; dx++) {
                    if (!grid.TryGetValue(c + new int2(dx, dy), out var list)) continue;
                    foreach (var q in list) if (math.distancesq(q, xz) <= kWalk * kWalk) { near = true; break; }
                }
                s.buildings++;
                if (near) s.buildingsCovered++;
            }
            buildings.Dispose();

            // Reach: whatever the Network tab last asked for.
            var overlay = World.GetOrCreateSystemManaged<TP_WorldOverlaySystem>();
            var (rStops, rMin, rMax) = overlay.ReachData;
            if (rStops != null && rMin != null) {
                s.reachMax = rMax;
                for (var i = 0; i < rStops.Length && i < rMin.Length; i++) {
                    if (rMin[i] == 0f && em.Exists(rStops[i])) s.reachOriginName = m_Names.GetName(rStops[i]);
                    if (rMin[i] >= 0f && rMin[i] <= rMax) s.reachStops++;
                }
            }
            // Vehicles: the object-colour system's last read (only filled while a vehicle mode is on).
            foreach (var v in World.GetOrCreateSystemManaged<TP_BuildingColorSystem>().Vehicles) {
                s.vehicles++;
                s.avgLoad += v.load;
                if (v.state == TP_InfoviewSystem.kStateBunched) s.bunched++;
                else if (v.state == TP_InfoviewSystem.kStateHeld) s.held++;
                else if (v.state == TP_InfoviewSystem.kStateBoarding) s.boarding++;
            }
            if (s.vehicles > 0) s.avgLoad /= s.vehicles;
            return m_IvStats = s;
        }
    }
}
