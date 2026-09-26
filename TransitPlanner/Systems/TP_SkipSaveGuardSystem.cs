namespace TransitPlanner.Systems {
    #region Using Statements

    using Game.Routes;

    using Unity.Collections;
    using Unity.Entities;

    using ModsCommon.Systems;

    using TransitPlanner.Components;

    #endregion

    /// <summary>
    /// Runs in the Serialize phase just before <c>SerializerSystem</c>, on every save (autosaves
    /// too): every stop a skip detached (<see cref="TP_SkipDetached"/>) is reconnected to its
    /// waypoint, so the save holds the line exactly as vanilla built it — a save made during an
    /// express band, or loaded without the mod, never has a disconnected stop.
    /// </summary>
    /// <remarks>
    /// Immediate EntityManager writes, not a command buffer: the save is written this frame. The
    /// skip itself (<see cref="TP_SkippedNow"/>) stays, and its grace period has already run, so
    /// <see cref="TP_SkipStopSystem"/> detaches the stop again on its next tick.
    /// </remarks>
    public partial class TP_SkipSaveGuardSystem : CommonGameSystemBase {
        private EntityQuery m_DetachedQuery;

        protected override void OnCreate() {
            base.OnCreate();
            m_DetachedQuery = SystemAPI.QueryBuilder().WithAll<TP_SkipDetached, Connected>().Build();
            RequireForUpdate(m_DetachedQuery);
        }

        protected override void OnUpdate() {
            var em = EntityManager;
            var waypoints = m_DetachedQuery.ToEntityArray(Allocator.Temp);
            foreach (var wp in waypoints) {
                var stop = em.GetComponentData<TP_SkipDetached>(wp).m_Stop;
                if (em.Exists(stop)) em.SetComponentData(wp, new Connected(stop));
            }
            em.RemoveComponent<TP_SkipDetached>(m_DetachedQuery);
            m_Log.Info($"Skip stops: reconnected {waypoints.Length} detached stop(s) before saving");
            waypoints.Dispose();
        }
    }
}
