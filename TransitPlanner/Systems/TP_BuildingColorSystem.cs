namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Buildings;
    using Game.Common;
    using Game.Objects;
    using Game.Prefabs;
    using Game.Rendering;
    using Game.Routes;
    using Game.Simulation;
    using Game.Tools;
    using Game.Vehicles;

    using HarmonyLib;

    using Unity.Burst;
    using Unity.Burst.Intrinsics;
    using Unity.Collections;
    using Unity.Entities;
    using Unity.Jobs;
    using Unity.Mathematics;

    using ModsCommon.Systems;

    #endregion

    /// <summary>
    /// Colours buildings by transit while the mod's infoview shows one of its building modes:
    /// distance to the nearest stop, minutes from the reach origin, or the best service frequency
    /// within a walk. The game's <c>ObjectColorSystem</c> writes <c>Game.Objects.Color</c>
    /// (<c>m_Index</c> = the active infomode's gradient slot, <c>m_Value</c> 0..255) from Burst jobs
    /// keyed on infomode types it knows; a Harmony prefix on its <c>OnUpdate</c> lets this system
    /// take the frame instead when ours is active — IBLIV's recipe (CS2Mod-IBLIV, MIT), the same
    /// "replace the scheduler, not the Burst job" seam as the preferred depot.
    /// </summary>
    /// <remarks>
    /// Every frame (while active): one job resets every object's colour, one job colours the
    /// buildings from a stop grid — a <c>NativeParallelMultiHashMap</c> of 400 m cells → stop
    /// position + value — that the main thread rebuilds every 120 frames. When none of our
    /// building modes is on, vanilla's update runs untouched (the prefix returns true).
    /// </remarks>
    public partial class TP_BuildingColorSystem : CommonGameSystemBase {
        private const float kCell = 400f;
        private const float kCoverageRadius = 800f;
        private const int   kRebuildEveryFrames = 120;

        private static TP_BuildingColorSystem s_Instance;

        // SystemBase.Dependency is protected; reached the way the depot patch reaches PathfindSetupSystem's.
        internal static readonly System.Func<SystemBase, JobHandle> s_GetDependency =
            AccessTools.MethodDelegate<System.Func<SystemBase, JobHandle>>(AccessTools.PropertyGetter(typeof(SystemBase), "Dependency"));
        internal static readonly System.Action<SystemBase, JobHandle> s_SetDependency =
            AccessTools.MethodDelegate<System.Action<SystemBase, JobHandle>>(AccessTools.PropertySetter(typeof(SystemBase), "Dependency"));

        private ToolSystem            m_Tools;
        private TP_InfoviewSystem     m_Infoview;
        private TP_WorldOverlaySystem m_Overlay;
        private EntityQuery           m_AllObjects;
        private EntityQuery           m_Buildings;
        private EntityQuery           m_ActiveModes;
        private EntityQuery           m_Stops;

        private TP_PlannerUISystem    m_Planner;
        private SimulationSystem      m_Simulation;
        private EntityQuery           m_Vehicles;
        private EntityQuery           m_Lines;

        private NativeParallelMultiHashMap<int2, StopCell> m_Grid;
        private int m_GridFrame = -1;
        private BuildingStatusType m_GridFor;
        /// <summary>Last colour job: the grid is only rebuilt once it has finished reading it (no safety checks in this build).</summary>
        private JobHandle m_LastJob;

        private struct StopCell { public float2 pos; public float value; }

        /// <summary>One transit vehicle (the controller) as the vehicle modes see it; rebuilt every 15 frames.</summary>
        public struct VehicleInfo {
            public Entity vehicle, line;
            /// <summary>Index into the line's RouteWaypoint buffer of the waypoint it is heading to (-1 unknown).</summary>
            public int    targetIndex;
            public float  load;
            public byte   state;
        }
        private const int kVehiclesEveryFrames = 15;
        private int m_VehiclesFrame = -1;
        private NativeParallelHashMap<Entity, byte> m_VehicleValues;
        private BuildingStatusType m_VehicleValuesFor;
        /// <summary>The last vehicle read, for the world overlay's line-load curves.</summary>
        public List<VehicleInfo> Vehicles { get; } = new List<VehicleInfo>();

        protected override void OnCreate() {
            base.OnCreate();
            s_Instance  = this;
            m_Tools     = World.GetOrCreateSystemManaged<ToolSystem>();
            m_Infoview  = World.GetOrCreateSystemManaged<TP_InfoviewSystem>();
            m_Overlay   = World.GetOrCreateSystemManaged<TP_WorldOverlaySystem>();
            m_AllObjects = SystemAPI.QueryBuilder().WithAll<Game.Objects.Object>().WithAllRW<Game.Objects.Color>().WithNone<Hidden, Deleted>().Build();
            m_Buildings  = SystemAPI.QueryBuilder().WithAll<Building, Game.Objects.Transform, PrefabRef>().WithAllRW<Game.Objects.Color>().WithNone<Hidden, Deleted, Temp, Owner>().Build();
            m_ActiveModes = SystemAPI.QueryBuilder().WithAll<InfomodeActive, InfoviewBuildingStatusData>().Build();
            m_Stops      = SystemAPI.QueryBuilder().WithAll<Game.Routes.TransportStop, Game.Objects.Transform>().WithNone<Temp, Deleted>().Build();
            m_Vehicles   = SystemAPI.QueryBuilder().WithAll<Game.Vehicles.Vehicle>().WithAllRW<Game.Objects.Color>().WithNone<Hidden, Deleted, Temp>().Build();
            m_Lines      = SystemAPI.QueryBuilder().WithAll<Route, TransportLine, RouteWaypoint, RouteVehicle>().WithNone<Temp, Deleted>().Build();
            m_Planner    = World.GetOrCreateSystemManaged<TP_PlannerUISystem>();
            m_Simulation = World.GetOrCreateSystemManaged<SimulationSystem>();
            m_Grid = new NativeParallelMultiHashMap<int2, StopCell>(1024, Allocator.Persistent);
            m_VehicleValues = new NativeParallelHashMap<Entity, byte>(256, Allocator.Persistent);
            Enabled = false; // driven from the prefix, never by the update loop
        }

        protected override void OnDestroy() {
            m_LastJob.Complete();
            if (m_Grid.IsCreated) m_Grid.Dispose();
            if (m_VehicleValues.IsCreated) m_VehicleValues.Dispose();
            base.OnDestroy();
        }

        protected override void OnUpdate() { }

        /// <summary>Called by the Harmony prefix on ObjectColorSystem.OnUpdate (Patches/ObjectColorSystemPatches): true = let vanilla run.</summary>
        public static bool TakeFrame(ObjectColorSystem vanilla) => s_Instance == null || s_Instance.Take(vanilla);

        private bool Take(ObjectColorSystem vanilla) {
            if (!m_Infoview.Active) return true;
            // Which of our modes are on: one building mode (200..) and one vehicle mode (210..), each the first found.
            var em = EntityManager;
            var type = (BuildingStatusType)0; var index = -1;
            var vType = (BuildingStatusType)0; var vIndex = -1;
            var actives = m_ActiveModes.ToEntityArray(Allocator.Temp);
            foreach (var e in actives) {
                var t = em.GetComponentData<InfoviewBuildingStatusData>(e).m_Type;
                if ((int)t >= 210) { if (vIndex < 0) { vType = t; vIndex = em.GetComponentData<InfomodeActive>(e).m_Index; } }
                else if ((int)t >= 200) { if (index < 0) { type = t; index = em.GetComponentData<InfomodeActive>(e).m_Index; } }
            }
            actives.Dispose();
            if (index < 0 && vIndex < 0) return true;

            if (index >= 0) RebuildGrid(type);
            if (vIndex >= 0) RebuildVehicles(vType);
            var reachMax = m_Overlay.ReachData.max;

            // Vanilla is skipped, so its (protected) Dependency is ours to chain on; hand the result back to it.
            var deps = s_GetDependency(vanilla);
            var handle = new ResetJob { m_ColorType = SystemAPI.GetComponentTypeHandle<Game.Objects.Color>() }.ScheduleParallel(m_AllObjects, deps);
            if (index >= 0) {
                handle = new ColorBuildingsJob {
                    m_ColorType     = SystemAPI.GetComponentTypeHandle<Game.Objects.Color>(),
                    m_TransformType = SystemAPI.GetComponentTypeHandle<Game.Objects.Transform>(true),
                    m_Grid          = m_Grid,
                    m_Index         = (byte)index,
                    m_Type          = type,
                    m_ReachMax      = reachMax,
                }.ScheduleParallel(m_Buildings, handle);
            }
            if (vIndex >= 0) {
                handle = new ColorVehiclesJob {
                    m_ColorType      = SystemAPI.GetComponentTypeHandle<Game.Objects.Color>(),
                    m_EntityType     = SystemAPI.GetEntityTypeHandle(),
                    m_ControllerType = SystemAPI.GetComponentTypeHandle<Controller>(true),
                    m_Values         = m_VehicleValues,
                    m_Index          = (byte)vIndex,
                }.ScheduleParallel(m_Vehicles, handle);
            }
            m_LastJob = handle;
            s_SetDependency(vanilla, handle);
            return false;
        }

        /// <summary>
        /// Every transit vehicle's load and state, keyed by controller: riders / seats, or running /
        /// boarding / held (boarding with a departure frame more than 2 s out - a timetable or
        /// unbunching hold) / bunched (the gap to the vehicle ahead, in waypoints along the loop,
        /// under 35 % of the even spacing). Also fills <see cref="Vehicles"/> for the overlay.
        /// </summary>
        private void RebuildVehicles(BuildingStatusType type) {
            var frame = UnityEngine.Time.frameCount;
            if (type == m_VehicleValuesFor && frame - m_VehiclesFrame < kVehiclesEveryFrames) return;
            m_VehicleValuesFor = type; m_VehiclesFrame = frame;
            m_LastJob.Complete();
            m_VehicleValues.Clear();
            Vehicles.Clear();
            var em = EntityManager;
            var simFrame = m_Simulation.frameIndex;
            var lines = m_Lines.ToEntityArray(Allocator.Temp);
            var onLine = new List<(int idx, float pos, float load, byte state, Entity v)>();
            foreach (var line in lines) {
                var waypoints = em.GetBuffer<RouteWaypoint>(line, true);
                var n = waypoints.Length;
                if (n == 0) continue;
                onLine.Clear();
                foreach (var rv in em.GetBuffer<RouteVehicle>(line, true)) {
                    var v = rv.m_Vehicle;
                    if (v == Entity.Null || !em.Exists(v)) continue;
                    m_Planner.CountRiders(v, out var riders, out var capacity);
                    var load = capacity > 0 ? math.saturate(riders / (float)capacity) : 0f;
                    // Position along the loop: target waypoint index plus how far along the leg to it.
                    var idx = -1; var pos = 0f;
                    if (em.HasComponent<Target>(v)) {
                        var target = em.GetComponentData<Target>(v).m_Target;
                        for (var i = 0; i < n; i++) if (waypoints[i].m_Waypoint == target) { idx = i; break; }
                        if (idx >= 0 && em.HasComponent<Game.Objects.Transform>(v) && em.HasComponent<Position>(target)) {
                            var prev = waypoints[(idx + n - 1) % n].m_Waypoint;
                            var vp = em.GetComponentData<Game.Objects.Transform>(v).m_Position;
                            var tp = em.GetComponentData<Position>(target).m_Position;
                            var pp = em.HasComponent<Position>(prev) ? em.GetComponentData<Position>(prev).m_Position : tp;
                            var leg = math.max(1f, math.distance(pp, tp));
                            pos = idx - math.saturate(math.distance(vp, tp) / leg);
                        }
                    }
                    var state = TP_InfoviewSystem.kStateRunning;
                    if (em.HasComponent<Game.Vehicles.PublicTransport>(v)) {
                        var pt = em.GetComponentData<Game.Vehicles.PublicTransport>(v);
                        if ((pt.m_State & Game.Vehicles.PublicTransportFlags.Boarding) != 0) state = pt.m_DepartureFrame > simFrame + 120 ? TP_InfoviewSystem.kStateHeld : TP_InfoviewSystem.kStateBoarding;
                    } else if (em.HasComponent<Game.Vehicles.CargoTransport>(v)) {
                        var ct = em.GetComponentData<Game.Vehicles.CargoTransport>(v);
                        if ((ct.m_State & Game.Vehicles.CargoTransportFlags.Boarding) != 0) state = ct.m_DepartureFrame > simFrame + 120 ? TP_InfoviewSystem.kStateHeld : TP_InfoviewSystem.kStateBoarding;
                    }
                    onLine.Add((idx, pos, load, state, v));
                }
                // Bunching: sort by position and compare each gap to the even spacing.
                if (onLine.Count >= 2) {
                    onLine.Sort((a, b) => a.pos.CompareTo(b.pos));
                    var expected = n / (float)onLine.Count;
                    for (var i = 0; i < onLine.Count; i++) {
                        var cur = onLine[i]; var ahead = onLine[(i + 1) % onLine.Count];
                        if (cur.idx < 0 || ahead.idx < 0) continue;
                        var gap = ahead.pos - cur.pos; if (gap < 0f) gap += n;
                        if (gap < 0.35f * expected && cur.state == TP_InfoviewSystem.kStateRunning) onLine[i] = (cur.idx, cur.pos, cur.load, TP_InfoviewSystem.kStateBunched, cur.v);
                    }
                }
                foreach (var o in onLine) {
                    Vehicles.Add(new VehicleInfo { vehicle = o.v, line = line, targetIndex = o.idx, load = o.load, state = o.state });
                    m_VehicleValues.TryAdd(o.v, type == TP_InfoviewSystem.kVehicleState ? o.state : (byte)math.round(o.load * 255f));
                }
            }
            lines.Dispose();
        }

        /// <summary>Stops into 400 m cells with the value the mode needs: frequency per hour, reach minutes, or nothing (coverage is distance only).</summary>
        private void RebuildGrid(BuildingStatusType type) {
            var frame = UnityEngine.Time.frameCount;
            if (type == m_GridFor && frame - m_GridFrame < kRebuildEveryFrames) return;
            m_GridFor = type; m_GridFrame = frame;
            m_LastJob.Complete();
            m_Grid.Clear();
            var em = EntityManager;
            var (rStops, rMin, _) = m_Overlay.ReachData;
            var stops = m_Stops.ToEntityArray(Allocator.Temp);
            foreach (var stop in stops) {
                var p = em.GetComponentData<Game.Objects.Transform>(stop).m_Position;
                var value = 0f;
                if (type == TP_InfoviewSystem.kBuildingFrequency) {
                    if (em.HasBuffer<ConnectedRoute>(stop)) {
                        foreach (var cr in em.GetBuffer<ConnectedRoute>(stop, true)) {
                            if (!em.HasComponent<Owner>(cr.m_Waypoint)) continue;
                            var line = em.GetComponentData<Owner>(cr.m_Waypoint).m_Owner;
                            if (!em.HasComponent<TransportLine>(line)) continue;
                            var interval = em.GetComponentData<TransportLine>(line).m_VehicleInterval;
                            if (interval > 0f) value += (4369f / 24f) / interval;
                        }
                    }
                } else if (type == TP_InfoviewSystem.kBuildingReach) {
                    value = -1f;
                    if (rStops != null) for (var i = 0; i < rStops.Length && i < rMin.Length; i++) if (rStops[i] == stop) { value = rMin[i]; break; }
                    if (value < 0f) continue; // unreachable stops do not count
                }
                var xz = new float2(p.x, p.z);
                m_Grid.Add((int2)math.floor(xz / kCell), new StopCell { pos = xz, value = value });
            }
            stops.Dispose();
        }

        [BurstCompile]
        private struct ResetJob : IJobChunk {
            public ComponentTypeHandle<Game.Objects.Color> m_ColorType;
            public void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex, bool useEnabledMask, in v128 chunkEnabledMask) {
                var colors = chunk.GetNativeArray(ref m_ColorType);
                for (var i = 0; i < colors.Length; i++) colors[i] = default;
            }
        }

        /// <summary>Tints every vehicle in the map by its value; trailing cars take their controller's.</summary>
        [BurstCompile]
        private struct ColorVehiclesJob : IJobChunk {
            public ComponentTypeHandle<Game.Objects.Color> m_ColorType;
            [ReadOnly] public EntityTypeHandle m_EntityType;
            [ReadOnly] public ComponentTypeHandle<Controller> m_ControllerType;
            [ReadOnly] public NativeParallelHashMap<Entity, byte> m_Values;
            public byte m_Index;

            public void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex, bool useEnabledMask, in v128 chunkEnabledMask) {
                var colors = chunk.GetNativeArray(ref m_ColorType);
                var entities = chunk.GetNativeArray(m_EntityType);
                var hasController = chunk.Has(ref m_ControllerType);
                var controllers = hasController ? chunk.GetNativeArray(ref m_ControllerType) : default;
                for (var i = 0; i < colors.Length; i++) {
                    var key = hasController && controllers[i].m_Controller != Entity.Null ? controllers[i].m_Controller : entities[i];
                    if (m_Values.TryGetValue(key, out var value)) colors[i] = new Game.Objects.Color(m_Index, value);
                }
            }
        }

        [BurstCompile]
        private struct ColorBuildingsJob : IJobChunk {
            public ComponentTypeHandle<Game.Objects.Color> m_ColorType;
            [ReadOnly] public ComponentTypeHandle<Game.Objects.Transform> m_TransformType;
            [ReadOnly] public NativeParallelMultiHashMap<int2, StopCell> m_Grid;
            public byte m_Index;
            public BuildingStatusType m_Type;
            public float m_ReachMax;

            public void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex, bool useEnabledMask, in v128 chunkEnabledMask) {
                var colors = chunk.GetNativeArray(ref m_ColorType);
                var transforms = chunk.GetNativeArray(ref m_TransformType);
                for (var i = 0; i < colors.Length; i++) {
                    var p = transforms[i].m_Position;
                    var xz = new float2(p.x, p.z);
                    var c = (int2)math.floor(xz / kCell);
                    var nearest = float.MaxValue; var best = 0f; var minutes = float.MaxValue;
                    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
                        if (!m_Grid.TryGetFirstValue(c + new int2(dx, dy), out var s, out var it)) continue;
                        do {
                            var d = math.distance(s.pos, xz);
                            if (d < nearest) nearest = d;
                            if (d <= kCell) { best = math.max(best, s.value); minutes = math.min(minutes, s.value); }
                        } while (m_Grid.TryGetNextValue(out s, ref it));
                    }
                    float v;
                    if (m_Type == TP_InfoviewSystem.kBuildingCoverage) v = nearest >= kCoverageRadius ? 0f : 1f - nearest / kCoverageRadius;
                    else if (m_Type == TP_InfoviewSystem.kBuildingFrequency) v = math.saturate(best / 40f);
                    else v = minutes == float.MaxValue || m_ReachMax <= 0f ? 0f : math.saturate(1f - minutes / m_ReachMax);
                    colors[i] = new Game.Objects.Color(m_Index, (byte)math.round(v * 255f));
                }
            }
        }
    }
}
