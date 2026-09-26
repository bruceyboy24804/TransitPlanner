namespace TransitPlanner.Systems {
    #region Using Statements

    using Game;
    using Game.Common;
    using Game.Routes;
    using Game.Tools;

    using Unity.Collections;
    using Unity.Entities;

    using ModsCommon.Systems;

    using TransitPlanner.Components;

    #endregion

    /// <summary>
    /// Attaches <see cref="TP_LineSchedule"/> and an empty <see cref="TP_ScheduleBand"/> buffer to
    /// every transport line that lacks them: lines from before the mod was installed, and lines
    /// vanilla creates while it runs.
    /// </summary>
    /// <remarks>
    /// Structural changes go through an <see cref="EntityCommandBuffer"/> played back at the end
    /// of the frame. <c>AddComponent</c>/<c>AddBuffer</c>, never <c>Set</c>: the entity does not
    /// have the types yet, and a Set throws at playback.
    ///
    /// The schedule starts disabled with no bands, so a line the player never opens in the planner
    /// behaves exactly as vanilla. Per-type default presets are applied by the preset system once
    /// it exists, gated on <c>Setting.ApplyDefaultsToNewLines</c>.
    /// </remarks>
    public partial class TP_ScheduleInitSystem : CommonGameSystemBase {
        private EntityQuery m_MissingQuery;
        private EntityQuery m_MissingModelsQuery;
        private EntityQuery m_MissingHistoryQuery;
        private EndFrameBarrier m_Barrier;

        public override int GetUpdateInterval(SystemUpdatePhase phase) => 64;

        protected override void OnCreate() {
            base.OnCreate();
            m_Barrier = World.GetOrCreateSystemManaged<EndFrameBarrier>();
            m_MissingQuery = SystemAPI.QueryBuilder()
                                      .WithAll<Route, TransportLine>()
                                      .WithNone<TP_LineSchedule, Temp, Deleted>()
                                      .Build();
            // Lines scheduled by a build before per-band models existed lack the two buffers.
            m_MissingModelsQuery = SystemAPI.QueryBuilder()
                                            .WithAll<Route, TransportLine, TP_LineSchedule>()
                                            .WithNone<TP_BandModel, Temp, Deleted>()
                                            .Build();
            m_MissingHistoryQuery = SystemAPI.QueryBuilder()
                                             .WithAll<Route, TransportLine, TP_LineSchedule>()
                                             .WithNone<TP_LoadSample, Temp, Deleted>()
                                             .Build();
            RequireAnyForUpdate(m_MissingQuery, m_MissingModelsQuery, m_MissingHistoryQuery);
        }

        protected override void OnUpdate() {
            var entities = m_MissingQuery.ToEntityArray(Allocator.Temp);
            var ecb = m_Barrier.CreateCommandBuffer();
            foreach (var entity in entities) {
                ecb.AddComponent(entity, new TP_LineSchedule { m_AppliedModelBand = -1 });
                ecb.AddBuffer<TP_ScheduleBand>(entity);
                ecb.AddBuffer<TP_BandModel>(entity);
                ecb.AddBuffer<TP_BaselineModel>(entity);
                AddHistory(ecb, entity);
            }
            if (entities.Length > 0) m_Log.Debug($"Attached schedule to {entities.Length} line(s)");

            var histories = m_MissingHistoryQuery.ToEntityArray(Allocator.Temp);
            foreach (var entity in histories) AddHistory(ecb, entity);
            if (histories.Length > 0) m_Log.Debug($"Added load history to {histories.Length} line(s)");
            histories.Dispose();
            entities.Dispose();

            var upgrades = m_MissingModelsQuery.ToEntityArray(Allocator.Temp);
            foreach (var entity in upgrades) {
                ecb.AddBuffer<TP_BandModel>(entity);
                ecb.AddBuffer<TP_BaselineModel>(entity);
            }
            if (upgrades.Length > 0) m_Log.Debug($"Added per-band model buffers to {upgrades.Length} line(s)");
            upgrades.Dispose();
        }

        /// <summary>The 24 hourly slots, empty; a missing hour reads as m_Samples == 0.</summary>
        private static void AddHistory(EntityCommandBuffer ecb, Entity entity) {
            var buffer = ecb.AddBuffer<TP_LoadSample>(entity);
            for (var h = 0; h < 24; h++) buffer.Add(default);
        }
    }
}
