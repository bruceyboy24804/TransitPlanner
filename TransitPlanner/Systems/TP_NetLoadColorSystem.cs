namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Net;
    using Game.Pathfind;
    using Game.Rendering;
    using Game.Routes;
    using Game.Tools;

    using Unity.Burst;
    using Unity.Burst.Intrinsics;
    using Unity.Collections;
    using Unity.Entities;
    using Unity.Mathematics;

    using ModsCommon.Systems;

    #endregion

    /// <summary>
    /// The "line load" half of the Line &amp; vehicle load infomode, drawn the way the game's own
    /// Traffic Flow infomode is: as the <b>network's colour</b>. Every road or track edge a transit
    /// line runs over gets an <see cref="EdgeColor"/> in the infomode's gradient slot, valued by
    /// the load of the vehicle that most recently covered that stretch of the line.
    /// </summary>
    /// <remarks>
    /// <c>NetColorSystem</c> rewrites every edge's colour each frame from the infomode types it
    /// knows, so ours is a Harmony <b>postfix</b> on its <c>OnUpdate</c>
    /// (Patches/NetColorSystemPatches): a job chained on the system's <c>Dependency</c> that
    /// overwrites the edges in our map after vanilla has reset them. The map — edge → value — is
    /// rebuilt every 15 frames on the main thread from the object-colour system's vehicle read:
    /// each <c>RouteSegment</c>'s <c>PathElement</c>s are the lanes it runs on, each lane's
    /// <c>Owner</c> is its edge. Where lines share an edge the busiest wins. The gradient index is
    /// the infomode's <c>InfomodeActive.m_Index</c>: colour slots are one global table
    /// (<c>ToolSystem.m_InfomodeColors</c>, group × 4 + n) shared by the object and net shaders,
    /// so the same infomode colours vehicles and edges alike.
    /// </remarks>
    public partial class TP_NetLoadColorSystem : CommonGameSystemBase {
        private const int kEveryFrames = 15;

        private static TP_NetLoadColorSystem s_Instance;

        private TP_InfoviewSystem      m_Infoview;
        private TP_BuildingColorSystem m_Colors;
        private EntityQuery            m_Edges;
        private EntityQuery            m_Lines;

        private NativeParallelHashMap<Entity, byte> m_EdgeValues;
        private int       m_Frame = -1;
        private Unity.Jobs.JobHandle m_LastJob;

        protected override void OnCreate() {
            base.OnCreate();
            s_Instance = this;
            m_Infoview = World.GetOrCreateSystemManaged<TP_InfoviewSystem>();
            m_Colors   = World.GetOrCreateSystemManaged<TP_BuildingColorSystem>();
            m_Edges    = SystemAPI.QueryBuilder().WithAll<Game.Net.Edge>().WithAllRW<EdgeColor>().WithNone<Deleted>().Build();
            m_Lines    = SystemAPI.QueryBuilder().WithAll<Route, TransportLine, RouteSegment>().WithNone<Temp, Deleted>().Build();
            m_EdgeValues = new NativeParallelHashMap<Entity, byte>(1024, Allocator.Persistent);
            Enabled = false; // driven from the postfix
        }

        protected override void OnDestroy() {
            m_LastJob.Complete();
            if (m_EdgeValues.IsCreated) m_EdgeValues.Dispose();
            base.OnDestroy();
        }

        protected override void OnUpdate() { }

        /// <summary>Called by the postfix on NetColorSystem.OnUpdate.</summary>
        public static void AfterFrame(NetColorSystem vanilla) => s_Instance?.After(vanilla);

        private void After(NetColorSystem vanilla) {
            if (!m_Infoview.ModeActive(TP_InfoviewSystem.kVehicleLoad, out var index)) return;
            Rebuild();
            var deps = TP_BuildingColorSystem.s_GetDependency(vanilla);
            var job = new ColorEdgesJob {
                m_ColorType  = SystemAPI.GetComponentTypeHandle<EdgeColor>(),
                m_EntityType = SystemAPI.GetEntityTypeHandle(),
                m_Values     = m_EdgeValues,
                m_Index      = (byte)index,
            }.ScheduleParallel(m_Edges, deps);
            m_LastJob = job;
            TP_BuildingColorSystem.s_SetDependency(vanilla, job);
        }

        /// <summary>Edge → load byte: per segment, the load of the vehicle that last ran it (nearest target ahead of the segment's end), spread over the segment's lanes' edges.</summary>
        private void Rebuild() {
            var frame = UnityEngine.Time.frameCount;
            if (frame - m_Frame < kEveryFrames) return;
            m_Frame = frame;
            m_LastJob.Complete();
            m_EdgeValues.Clear();
            var em = EntityManager;
            var byLine = new Dictionary<Entity, List<(int idx, float load)>>();
            foreach (var v in m_Colors.Vehicles) {
                if (v.targetIndex < 0) continue;
                if (!byLine.TryGetValue(v.line, out var l)) byLine[v.line] = l = new List<(int, float)>();
                l.Add((v.targetIndex, v.load));
            }
            var lines = m_Lines.ToEntityArray(Allocator.Temp);
            foreach (var line in lines) {
                if (!byLine.TryGetValue(line, out var onLine) || onLine.Count == 0) continue;
                var segments = em.GetBuffer<RouteSegment>(line, true);
                var n = segments.Length;
                for (var s = 0; s < n; s++) {
                    var bestD = int.MaxValue; var load = 0f;
                    foreach (var (idx, l) in onLine) {
                        var d = ((idx - (s + 1)) % n + n) % n;
                        if (d < bestD) { bestD = d; load = l; }
                    }
                    var value = (byte)math.round(math.saturate(load) * 255f);
                    var seg = segments[s].m_Segment;
                    if (!em.HasBuffer<PathElement>(seg)) continue;
                    foreach (var pe in em.GetBuffer<PathElement>(seg, true)) {
                        if (!em.HasComponent<Owner>(pe.m_Target)) continue;
                        var edge = em.GetComponentData<Owner>(pe.m_Target).m_Owner;
                        if (!em.HasComponent<Game.Net.Edge>(edge)) continue;
                        if (m_EdgeValues.TryGetValue(edge, out var old)) { if (value > old) m_EdgeValues[edge] = value; }
                        else m_EdgeValues.TryAdd(edge, value);
                    }
                }
            }
            lines.Dispose();
        }

        [BurstCompile]
        private struct ColorEdgesJob : IJobChunk {
            public ComponentTypeHandle<EdgeColor> m_ColorType;
            [ReadOnly] public EntityTypeHandle m_EntityType;
            [ReadOnly] public NativeParallelHashMap<Entity, byte> m_Values;
            public byte m_Index;

            public void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex, bool useEnabledMask, in v128 chunkEnabledMask) {
                var colors = chunk.GetNativeArray(ref m_ColorType);
                var entities = chunk.GetNativeArray(m_EntityType);
                for (var i = 0; i < colors.Length; i++) {
                    if (m_Values.TryGetValue(entities[i], out var v)) colors[i] = new EdgeColor(m_Index, v, v);
                }
            }
        }
    }
}
