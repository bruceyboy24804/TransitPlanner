namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Net;
    using Game.Prefabs;
    using Game.Tools;

    using Unity.Collections;
    using Unity.Entities;

    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// The road and track network as a background for the network view: every edge's curve as
    /// three points (start, middle, end) plus its width, in world x/z. Static enough to read
    /// rarely; the UI keeps it in world coordinates and moves it with an SVG transform, so a
    /// 20 000-edge city costs one string build, not one per frame.
    /// </summary>
    public partial class TP_PlannerUISystem {
        private EntityQuery m_RoadQuery;
        private EntityQuery m_TrackQuery;
        private RoadLayer   m_Roads = new RoadLayer();
        private int         m_RoadsFrame = -1;
        private const int   kRoadsEveryFrames = 1800;

        private void CreateRoadBindings() {
            m_RoadQuery  = SystemAPI.QueryBuilder().WithAll<Edge, Curve, Road, PrefabRef>().WithNone<Temp, Deleted>().Build();
            m_TrackQuery = SystemAPI.QueryBuilder().WithAll<Edge, Curve, PrefabRef>().WithAny<TrainTrack, TramTrack, SubwayTrack>().WithNone<Temp, Deleted, Road>().Build();
            CreateBinding("networkRoads", ReadRoads);
        }

        private RoadLayer ReadRoads() {
            var frame = UnityEngine.Time.frameCount;
            if (m_NetworkType < 0) return m_Roads;
            var roadCount = m_RoadQuery.CalculateEntityCount();
            var trackCount = m_TrackQuery.CalculateEntityCount();
            if (frame - m_RoadsFrame < kRoadsEveryFrames && m_Roads.roadCount == roadCount && m_Roads.trackCount == trackCount) return m_Roads;
            m_RoadsFrame = frame;

            var layer = new RoadLayer { roadCount = roadCount, trackCount = trackCount, version = m_Roads.version + 1 };
            layer.roads  = Sample(m_RoadQuery);
            layer.tracks = Sample(m_TrackQuery);
            return m_Roads = layer;
        }

        /// <summary>Seven floats per edge: x0 y0, xm ym, x1 y1, width.</summary>
        private float[] Sample(EntityQuery query) {
            var em = EntityManager;
            var edges = query.ToEntityArray(Allocator.Temp);
            var pts = new List<float>(edges.Length * 7);
            foreach (var e in edges) {
                var c = em.GetComponentData<Curve>(e).m_Bezier;
                var prefab = em.GetComponentData<PrefabRef>(e).m_Prefab;
                var width = em.HasComponent<NetGeometryData>(prefab) ? em.GetComponentData<NetGeometryData>(prefab).m_DefaultWidth : 8f;
                var m = Colossal.Mathematics.MathUtils.Position(c, 0.5f);
                pts.Add(c.a.x); pts.Add(c.a.z);
                pts.Add(m.x);   pts.Add(m.z);
                pts.Add(c.d.x); pts.Add(c.d.z);
                pts.Add(width);
            }
            edges.Dispose();
            return pts.ToArray();
        }
    }
}
