namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Prefabs;
    using Game.Tools;
    using Game.Zones;

    using Unity.Collections;
    using Unity.Entities;
    using Unity.Mathematics;

    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// Ground context for the network view: zone blocks as quads and building footprints as
    /// rotated rectangles, world x/z. Read rarely; like the roads it lives in world space in the
    /// UI under one transform.
    /// </summary>
    public partial class TP_PlannerUISystem {
        private EntityQuery m_BlockQuery;
        private EntityQuery m_BuildingQuery;
        private GroundLayer m_Ground = new GroundLayer();
        private int         m_GroundFrame = -1;
        private const int   kGroundEveryFrames = 1800;

        private void CreateGroundBindings() {
            m_BlockQuery    = SystemAPI.QueryBuilder().WithAll<Block>().WithNone<Temp, Deleted>().Build();
            m_BuildingQuery = SystemAPI.QueryBuilder().WithAll<Game.Buildings.Building, Game.Objects.Transform, PrefabRef>().WithNone<Temp, Deleted>().Build();
            CreateBinding("networkGround", ReadGround);
        }

        private GroundLayer ReadGround() {
            var frame = UnityEngine.Time.frameCount;
            if (m_NetworkType < 0) return m_Ground;
            var blocks = m_BlockQuery.CalculateEntityCount();
            var buildings = m_BuildingQuery.CalculateEntityCount();
            if (frame - m_GroundFrame < kGroundEveryFrames && m_Ground.blockCount == blocks && m_Ground.buildingCount == buildings) return m_Ground;
            m_GroundFrame = frame;

            var em    = EntityManager;
            var layer = new GroundLayer { version = m_Ground.version + 1, blockCount = blocks, buildingCount = buildings };

            // Blocks: the four corners ZoneUtils computes from position, direction and cell size.
            var be = m_BlockQuery.ToEntityArray(Allocator.Temp);
            var bl = new List<float>(be.Length * 8);
            foreach (var e in be) {
                var q = ZoneUtils.CalculateCorners(em.GetComponentData<Block>(e));
                bl.Add(q.a.x); bl.Add(q.a.y); bl.Add(q.b.x); bl.Add(q.b.y);
                bl.Add(q.c.x); bl.Add(q.c.y); bl.Add(q.d.x); bl.Add(q.d.y);
            }
            be.Dispose();
            layer.blocks = bl.ToArray();

            // Buildings: centre, footprint size and yaw from the transform's rotation.
            var ge = m_BuildingQuery.ToEntityArray(Allocator.Temp);
            var gl = new List<float>(ge.Length * 5);
            foreach (var e in ge) {
                var prefab = em.GetComponentData<PrefabRef>(e).m_Prefab;
                if (!em.HasComponent<ObjectGeometryData>(prefab)) continue;
                var size = em.GetComponentData<ObjectGeometryData>(prefab).m_Size;
                if (size.x < 1f || size.z < 1f) continue;
                var t   = em.GetComponentData<Game.Objects.Transform>(e);
                var fwd = math.mul(t.m_Rotation, new float3(0, 0, 1));
                var yaw = math.degrees(math.atan2(fwd.x, fwd.z));
                gl.Add(t.m_Position.x); gl.Add(t.m_Position.z); gl.Add(size.x); gl.Add(size.z); gl.Add(yaw);
            }
            ge.Dispose();
            layer.buildings = gl.ToArray();
            return m_Ground = layer;
        }
    }
}
