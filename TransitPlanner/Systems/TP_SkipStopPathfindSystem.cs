namespace TransitPlanner.Systems {
    #region Using Statements

    using Game.Common;
    using Game.Net;
    using Game.Pathfind;
    using Game.Routes;

    using Unity.Collections;
    using Unity.Entities;
    using Unity.Jobs;

    using ModsCommon.Systems;

    using TransitPlanner.Components;

    #endregion

    /// <summary>
    /// Closes a skipped stop to the line in trip planning. Each (line, stop) pair has one
    /// pathfinding edge, owned by the line's waypoint at that stop and linking the stop to the
    /// line: it is how a passenger boards or leaves that line there. Riding *through* the stop
    /// uses the line's segment edges and is untouched. This system re-sends a tagged waypoint's
    /// edge with no methods and no directions, so no new trip boards or alights there.
    /// </summary>
    /// <remarks>
    /// Runs right after <c>RoutesModifiedSystem</c> (ModificationEnd), which rewrites the edge
    /// from vanilla's own data whenever the waypoint is <c>Updated</c> / <c>PathfindUpdated</c>
    /// (for instance when the line's headway moves); ours is queued after it in the same frame,
    /// so it wins. The nodes and location are built exactly as <c>RoutesModifiedSystem.
    /// UpdatePathEdgeJob</c> builds them for a waypoint (1.6.2). Un-skipping needs nothing here:
    /// <see cref="TP_SkipStopSystem"/> tags the waypoint <c>PathfindUpdated</c> and vanilla
    /// rebuilds the edge as it was.
    /// </remarks>
    public partial class TP_SkipStopPathfindSystem : CommonGameSystemBase {
        private EntityQuery m_Query;
        private EntityQuery m_DirtyQuery;
        private PathfindQueueSystem m_PathfindQueue;

        protected override void OnCreate() {
            base.OnCreate();
            m_PathfindQueue = World.GetOrCreateSystemManaged<PathfindQueueSystem>();
            m_Query = SystemAPI.QueryBuilder()
                               .WithAll<Waypoint, TP_SkippedNow>()
                               .WithAny<Updated, PathfindUpdated, TP_SkipDirty>()
                               .WithNone<Deleted>()
                               .Build();
            m_DirtyQuery = SystemAPI.QueryBuilder().WithAll<TP_SkipDirty>().Build();
            RequireForUpdate(m_Query);
        }

        protected override void OnUpdate() {
            var em = EntityManager;
            var entities = m_Query.ToEntityArray(Allocator.Temp);
            var action = new UpdateAction(entities.Length, Allocator.Persistent);
            for (var i = 0; i < entities.Length; i++) action.m_UpdateData[i] = ClosedEdge(em, entities[i]);
            m_PathfindQueue.Enqueue(action, default(JobHandle));
            m_Log.Debug($"Skip stops: closed {entities.Length} stop edge(s) to trips");
            entities.Dispose();
            em.RemoveComponent<TP_SkipDirty>(m_DirtyQuery);
        }

        /// <summary>The waypoint's edge as vanilla lays it out, with nothing allowed on it.</summary>
        private static UpdateActionData ClosedEdge(EntityManager em, Entity waypoint) {
            var data = new UpdateActionData { m_Owner = waypoint };
            var access = em.HasComponent<AccessLane>(waypoint) ? em.GetComponentData<AccessLane>(waypoint) : default;
            if (access.m_Lane != Entity.Null && em.HasComponent<Lane>(access.m_Lane)) {
                data.m_StartNode = new PathNode(em.GetComponentData<Lane>(access.m_Lane).m_MiddleNode, access.m_CurvePos);
            } else if (access.m_Lane != Entity.Null && em.HasComponent<TransportStop>(access.m_Lane)) {
                data.m_StartNode = new PathNode(access.m_Lane, 2);
            } else {
                data.m_StartNode = new PathNode(waypoint, 2);
            }
            data.m_MiddleNode = new PathNode(waypoint, 1);
            data.m_EndNode    = new PathNode(waypoint, 0);
            if (em.HasComponent<Position>(waypoint)) {
                data.m_Location = PathUtils.GetLocationSpecification(em.GetComponentData<Position>(waypoint).m_Position);
            }
            // No Forward / Backward / AllowEnter / AllowExit and no methods: the pathfinder cannot
            // use the edge in either direction, for any trip.
            data.m_Specification = new PathSpecification {
                m_Length            = 0f,
                m_MaxSpeed          = 1f,
                m_Density           = 0f,
                m_AccessRequirement = -1,
            };
            return data;
        }
    }
}
