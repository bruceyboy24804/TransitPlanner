namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Prefabs;
    using Game.Rendering;
    using Game.Routes;
    using Game.Simulation;
    using Game.Tools;

    using Unity.Collections;
    using Unity.Entities;
    using Unity.Mathematics;

    using UnityEngine;

    using ModsCommon.Systems;

    #endregion

    /// <summary>
    /// Fills the mod's heatmap infomodes: the terrain overlay texture the game's own heatmaps use,
    /// one channel per active infomode (<c>InfomodeActive.m_Index − 1</c>), a byte 0..255 that the
    /// terrain shader tints with the infomode's gradient. Runs after <c>OverlayInfomodeSystem</c>
    /// in the same phase, because that system nulls <c>TerrainRenderSystem.overrideOverlaymap</c>
    /// at the start of every frame and only sets it back for heatmaps it knows.
    /// </summary>
    /// <remarks>
    /// The grid is the cell-map convention: 256 × 256 cells over the 14 336 m world, row = z. Each
    /// heatmap stamps every transit stop with a radial falloff (main thread; a few hundred stops
    /// × a 30-cell square is nothing), recomputed every <see cref="kEveryFrames"/> frames or when
    /// the set of active channels changes; the texture is uploaded only then. Values:
    /// coverage = nearness to the nearest stop (800 m → 0), frequency = departures per game hour
    /// summed over the lines at the stop, waiting = queued passengers, reach = minutes from the
    /// planner's chosen origin (what the Network tab last sent, else nothing).
    /// </remarks>
    public partial class TP_HeatmapSystem : CommonGameSystemBase {
        private const int   kSize = 256;
        private const int   kEveryFrames = 120;
        private const float kWorld = 14336f;                 // CellMapSystem.kMapSize
        private const float kCell  = kWorld / kSize;         // 56 m
        private const float kCoverageRadius = 800f;
        private const float kStampRadius    = 600f;

        private TerrainRenderSystem   m_Terrain;
        private TP_WorldOverlaySystem m_Overlay;
        private EntityQuery           m_ActiveQuery;
        private EntityQuery           m_StopQuery;
        private EntityQuery           m_BuildingQuery;
        private Texture2D             m_Texture;
        private int                   m_Frame = -1;
        private int                   m_LastChannels = -1;

        protected override void OnCreate() {
            base.OnCreate();
            m_Terrain = World.GetOrCreateSystemManaged<TerrainRenderSystem>();
            m_Overlay = World.GetOrCreateSystemManaged<TP_WorldOverlaySystem>();
            m_ActiveQuery = SystemAPI.QueryBuilder().WithAll<InfomodeActive, InfoviewHeatmapData>().Build();
            m_StopQuery   = SystemAPI.QueryBuilder().WithAll<Game.Routes.TransportStop, Game.Objects.Transform>().WithNone<Temp, Deleted>().Build();
            m_BuildingQuery = SystemAPI.QueryBuilder().WithAll<Game.Buildings.Building, Game.Objects.Transform>().WithNone<Temp, Deleted, Owner>().Build();
            m_Texture = new Texture2D(kSize, kSize, TextureFormat.RGBA32, false, true) {
                name = "TransitPlannerHeatmap", hideFlags = HideFlags.HideAndDontSave, wrapMode = TextureWrapMode.Clamp,
            };
        }

        protected override void OnDestroy() {
            if (m_Texture != null) Object.Destroy(m_Texture);
            base.OnDestroy();
        }

        protected override void OnUpdate() {
            // Which of our heatmaps are active, and on which channel.
            var em = EntityManager;
            var channels = 0; var typeOf = new HeatmapData[4];
            var actives = m_ActiveQuery.ToEntityArray(Allocator.Temp);
            foreach (var e in actives) {
                var type = em.GetComponentData<InfoviewHeatmapData>(e).m_Type;
                if ((int)type < 100) continue;
                var ch = em.GetComponentData<InfomodeActive>(e).m_Index - 1;
                if (ch < 0 || ch > 3) continue;
                channels |= 1 << ch;
                typeOf[ch] = type;
            }
            actives.Dispose();
            if (channels == 0) { m_LastChannels = 0; return; }

            // Vanilla nulls the override every frame; claim it while ours are showing.
            m_Terrain.overrideOverlaymap = m_Texture;

            var frame = UnityEngine.Time.frameCount;
            if (channels == m_LastChannels && frame - m_Frame < kEveryFrames) return;
            m_Frame = frame; m_LastChannels = channels;

            var data = m_Texture.GetRawTextureData<byte>();
            for (var i = 0; i < data.Length; i++) data[i] = 0;
            for (var ch = 0; ch < 4; ch++) {
                if ((channels & (1 << ch)) == 0) continue;
                switch (typeOf[ch]) {
                    case TP_InfoviewSystem.kCoverage:  Coverage(data, ch); break;
                    case TP_InfoviewSystem.kFrequency: PerStop(data, ch, StopFrequency, 40f); break;
                    case TP_InfoviewSystem.kWaiting:   PerStop(data, ch, StopWaiting, 3f); break;
                    case TP_InfoviewSystem.kReach:     Reach(data, ch); break;
                    case TP_InfoviewSystem.kWait:      PerStop(data, ch, StopAverageWait, 1.5f); break;
                    case TP_InfoviewSystem.kUnserved:  Unserved(data, ch); break;
                }
            }
            m_Texture.Apply(false);
        }

        // --- Stamping -------------------------------------------------------------------------

        private static int2 Cell(float3 pos) => (int2)math.floor((new float2(pos.x, pos.z) + kWorld * 0.5f) / kCell);

        /// <summary>Writes max(current, value × falloff) into <paramref name="ch"/> around a world position.</summary>
        private static void Stamp(NativeArray<byte> data, int ch, float3 pos, float value255, float radius) {
            var c = Cell(pos);
            var r = (int)math.ceil(radius / kCell);
            for (var dy = -r; dy <= r; dy++) {
                var y = c.y + dy;
                if (y < 0 || y >= kSize) continue;
                for (var dx = -r; dx <= r; dx++) {
                    var x = c.x + dx;
                    if (x < 0 || x >= kSize) continue;
                    var d = math.length(new float2(dx, dy)) * kCell;
                    if (d > radius) continue;
                    var v = (byte)math.clamp(value255 * (1f - d / radius), 0f, 255f);
                    var k = (y * kSize + x) * 4 + ch;
                    if (v > data[k]) data[k] = v;
                }
            }
        }

        private void Coverage(NativeArray<byte> data, int ch) {
            var em = EntityManager;
            var stops = m_StopQuery.ToEntityArray(Allocator.Temp);
            foreach (var s in stops) Stamp(data, ch, em.GetComponentData<Game.Objects.Transform>(s).m_Position, 255f, kCoverageRadius);
            stops.Dispose();
        }

        private void PerStop(NativeArray<byte> data, int ch, System.Func<Entity, float> measure, float scale) {
            var em = EntityManager;
            var stops = m_StopQuery.ToEntityArray(Allocator.Temp);
            foreach (var s in stops) {
                var v = measure(s) * scale;
                if (v <= 0f) continue;
                Stamp(data, ch, em.GetComponentData<Game.Objects.Transform>(s).m_Position, math.min(255f, v), kStampRadius);
            }
            stops.Dispose();
        }

        /// <summary>Departures per game hour over every line calling at the stop (a game hour is ~182 simulation seconds).</summary>
        private float StopFrequency(Entity stop) {
            var em = EntityManager;
            if (!em.HasBuffer<ConnectedRoute>(stop)) return 0f;
            var perHour = 0f;
            foreach (var cr in em.GetBuffer<ConnectedRoute>(stop, true)) {
                if (!em.HasComponent<Owner>(cr.m_Waypoint)) continue;
                var line = em.GetComponentData<Owner>(cr.m_Waypoint).m_Owner;
                if (!em.HasComponent<TransportLine>(line)) continue;
                var interval = em.GetComponentData<TransportLine>(line).m_VehicleInterval;
                if (interval > 0f) perHour += (4369f / 24f) / interval;
            }
            return perHour;
        }

        /// <summary>Passengers waiting across every line's queue at the stop.</summary>
        private float StopWaiting(Entity stop) {
            var em = EntityManager;
            if (!em.HasBuffer<ConnectedRoute>(stop)) return 0f;
            var n = 0f;
            foreach (var cr in em.GetBuffer<ConnectedRoute>(stop, true)) {
                if (em.HasComponent<WaitingPassengers>(cr.m_Waypoint)) n += em.GetComponentData<WaitingPassengers>(cr.m_Waypoint).m_Count;
            }
            return n;
        }

        /// <summary>Average wait at the stop, simulation seconds, worst line wins (WaitingPassengers.m_AverageWaitingTime).</summary>
        private float StopAverageWait(Entity stop) {
            var em = EntityManager;
            if (!em.HasBuffer<ConnectedRoute>(stop)) return 0f;
            var worst = 0f;
            foreach (var cr in em.GetBuffer<ConnectedRoute>(stop, true)) {
                if (em.HasComponent<WaitingPassengers>(cr.m_Waypoint)) worst = math.max(worst, em.GetComponentData<WaitingPassengers>(cr.m_Waypoint).m_AverageWaitingTime);
            }
            return worst;
        }

        /// <summary>
        /// Unserved demand: where people live and work with no stop in walking range. Residents +
        /// workers of every building are stamped as demand, then the cells within 400 m of a stop
        /// are cleared, so what remains lights up exactly the places a new stop would serve.
        /// </summary>
        private void Unserved(NativeArray<byte> data, int ch) {
            var em = EntityManager;
            var buildings = m_BuildingQuery.ToEntityArray(Allocator.Temp);
            foreach (var b in buildings) {
                var people = 0;
                if (em.HasBuffer<Game.Buildings.Renter>(b)) {
                    foreach (var r in em.GetBuffer<Game.Buildings.Renter>(b, true)) {
                        if (em.HasBuffer<Game.Citizens.HouseholdCitizen>(r.m_Renter)) people += em.GetBuffer<Game.Citizens.HouseholdCitizen>(r.m_Renter, true).Length;
                        else if (em.HasBuffer<Game.Companies.Employee>(r.m_Renter)) people += em.GetBuffer<Game.Companies.Employee>(r.m_Renter, true).Length;
                    }
                }
                if (people <= 0) continue;
                Stamp(data, ch, em.GetComponentData<Game.Objects.Transform>(b).m_Position, math.min(255f, people * 4f), 250f);
            }
            buildings.Dispose();
            // Clear the served ground.
            var stops = m_StopQuery.ToEntityArray(Allocator.Temp);
            foreach (var s in stops) Clear(data, ch, em.GetComponentData<Game.Objects.Transform>(s).m_Position, 400f);
            stops.Dispose();
        }

        private static void Clear(NativeArray<byte> data, int ch, float3 pos, float radius) {
            var c = Cell(pos);
            var r = (int)math.ceil(radius / kCell);
            for (var dy = -r; dy <= r; dy++) {
                var y = c.y + dy;
                if (y < 0 || y >= kSize) continue;
                for (var dx = -r; dx <= r; dx++) {
                    var x = c.x + dx;
                    if (x < 0 || x >= kSize) continue;
                    if (math.length(new float2(dx, dy)) * kCell > radius) continue;
                    data[(y * kSize + x) * 4 + ch] = 0;
                }
            }
        }

        /// <summary>Reach from the Network tab's origin: nearer in minutes → higher; nothing when no reach is set.</summary>
        private void Reach(NativeArray<byte> data, int ch) {
            var em = EntityManager;
            var (stops, minutes, max) = m_Overlay.ReachData;
            if (stops == null || minutes == null || max <= 0f) return;
            for (var i = 0; i < stops.Length && i < minutes.Length; i++) {
                var m = minutes[i];
                if (m < 0f || float.IsInfinity(m) || m > max || !em.Exists(stops[i]) || !em.HasComponent<Game.Objects.Transform>(stops[i])) continue;
                Stamp(data, ch, em.GetComponentData<Game.Objects.Transform>(stops[i]).m_Position, 255f * (1f - m / max), kStampRadius);
            }
        }
    }
}
