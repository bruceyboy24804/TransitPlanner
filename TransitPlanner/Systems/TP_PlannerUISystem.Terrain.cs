namespace TransitPlanner.Systems {
    #region Using Statements

    using Game.Simulation;

    using Unity.Mathematics;

    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// Terrain and water for the network view, sampled on a coarse grid over the playable area:
    /// a height band per cell and a water flag per cell. Not an entity read — the heightmap and
    /// the water surface are textures — so it is sampled through <c>TerrainUtils</c> /
    /// <c>WaterUtils</c> on the main thread, rarely, and handed over as two int grids the UI turns
    /// into run-length rectangles.
    /// </summary>
    public partial class TP_PlannerUISystem {
        private TerrainSystem m_Terrain;
        private WaterSystem   m_Water;
        private TerrainLayer  m_TerrainLayer = new TerrainLayer();
        private int           m_TerrainFrame = -1;
        private const int     kTerrainEveryFrames = 3600;
        /// <summary>Cells across the playable area; 14 km / 160 ≈ 90 m — the map's grain, not the game's.</summary>
        private const int     kTerrainCells = 160;
        private const int     kTerrainBands = 6;

        private void CreateTerrainBindings() {
            m_Terrain = World.GetOrCreateSystemManaged<TerrainSystem>();
            m_Water   = World.GetOrCreateSystemManaged<WaterSystem>();
            CreateBinding("networkTerrain", ReadTerrain);
        }

        private TerrainLayer ReadTerrain() {
            var frame = UnityEngine.Time.frameCount;
            if (m_NetworkType < 0) return m_TerrainLayer;
            if (frame - m_TerrainFrame < kTerrainEveryFrames && m_TerrainLayer.version > 0) return m_TerrainLayer;
            m_TerrainFrame = frame;

            var heights = m_Terrain.GetHeightData();
            if (!heights.isCreated) return m_TerrainLayer;
            var water = m_Water.GetSurfaceData(out var deps);
            deps.Complete();

            // The heightmap covers the playable area: heightmap space [0, resolution) ↔ world
            // hm / scale − offset.
            var min  = TerrainUtils.ToWorldSpace(ref heights, float3.zero);
            var max  = TerrainUtils.ToWorldSpace(ref heights, new float3(heights.resolution.x, 0, heights.resolution.z));
            var n    = kTerrainCells;
            var cell = new float2((max.x - min.x) / n, (max.z - min.z) / n);
            var layer = new TerrainLayer {
                version = m_TerrainLayer.version + 1,
                cells = n, originX = min.x, originY = min.z, cellX = cell.x, cellY = cell.y,
                band = new int[n * n], water = new int[n * n],
            };

            // Pass 1: raw heights, and the range over land for banding.
            var h = new float[n * n];
            var lo = float.MaxValue; var hi = float.MinValue;
            for (var j = 0; j < n; j++) {
                for (var i = 0; i < n; i++) {
                    var p = new float3(min.x + (i + 0.5f) * cell.x, 0, min.z + (j + 0.5f) * cell.y);
                    var k = j * n + i;
                    h[k] = TerrainUtils.SampleHeight(ref heights, p);
                    var depth = water.isCreated ? WaterUtils.SampleDepth(ref water, p) : 0f;
                    layer.water[k] = depth > 0.5f ? 1 : 0;
                    if (layer.water[k] == 0) { lo = math.min(lo, h[k]); hi = math.max(hi, h[k]); }
                }
            }
            // Pass 2: bands over the land range (water cells keep band 0).
            var span = math.max(1f, hi - lo);
            for (var k = 0; k < n * n; k++) {
                layer.band[k] = layer.water[k] == 1 ? 0 : math.clamp((int)((h[k] - lo) / span * kTerrainBands), 0, kTerrainBands - 1);
            }
            layer.bands = kTerrainBands;
            return m_TerrainLayer = layer;
        }
    }
}
