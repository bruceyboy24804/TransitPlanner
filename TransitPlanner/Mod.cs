namespace TransitPlanner {
    #region Using Statements

    using Colossal;

    using Game;
    using Game.Modding;
    using Game.Simulation;

    using ModsCommon.Mod;

    using TransitPlanner.Systems;

    #endregion

    /// <summary>
    /// Mod entry point. Lifecycle (logging, settings, i18n, Harmony, asset hosting) is handled by
    /// <see cref="ModsCommonBase{TSelf}"/>; this class only supplies the mod-specific pieces.
    /// </summary>
    // The base deliberately does not implement IMod — the game instantiates every IMod-derived type
    // in the assembly, and shared code is compiled in by source inclusion, so an abstract IMod base
    // would be picked up and crash. The concrete class declares it instead.
    //
    // No field initializers here: the game creates this object with
    // FormatterServices.GetUninitializedObject, so they never run. Initialise in OnAfterLoad.
    public sealed class Mod : ModsCommonBase<Mod>, IMod {
        /// <inheritdoc/>
        public override string ModName => "Transit Planner";

        /// <inheritdoc/>
        // Binding group for every C# <-> TypeScript binding. MUST match "id" in UI/mod.json.
        public override string Id => "TransitPlanner";

        /// <inheritdoc/>
        protected override string UiHostPrefix => "transitplanner";

        /// <inheritdoc/>
        protected override ModSetting CreateSettings(IMod mod) => new Setting(mod);

        /// <inheritdoc/>
        protected override IDictionarySource CreateEnUsLocalization(ModSetting settings) =>
            new LocaleEN((Setting)settings);

        /// <inheritdoc/>
        protected override void RegisterSystems(UpdateSystem updateSystem) {
            // Init first so a fresh line has its schedule before the tick that would apply it;
            // apply immediately before vanilla's line tick so the write lands on the same frame.
            updateSystem.UpdateBefore<TP_ScheduleInitSystem, TP_ScheduleApplySystem>(SystemUpdatePhase.GameSimulation);
            updateSystem.UpdateBefore<TP_ScheduleApplySystem, TransportLineSystem>(SystemUpdatePhase.GameSimulation);
            // Rules write bands/models the apply tick then picks up; a slow tick of its own.
            updateSystem.UpdateAt<TP_RulesSystem>(SystemUpdatePhase.GameSimulation);
            updateSystem.UpdateAt<TP_TimetableSystem>(SystemUpdatePhase.GameSimulation);
            updateSystem.UpdateAt<TP_LoadWaitSystem>(SystemUpdatePhase.GameSimulation);
            // Express running: tags the stops being skipped now; the pathfinding re-send must come
            // right after vanilla's own edge rewrite in the same phase, or vanilla's would win.
            updateSystem.UpdateAt<TP_SkipStopSystem>(SystemUpdatePhase.GameSimulation);
            updateSystem.UpdateAfter<TP_SkipStopPathfindSystem, Game.Pathfind.RoutesModifiedSystem>(SystemUpdatePhase.ModificationEnd);
            // Stops a skip detached are reconnected before anything is written to a save.
            updateSystem.UpdateBefore<TP_SkipSaveGuardSystem, Game.Serialization.SerializerSystem>(SystemUpdatePhase.Serialize);
            // The infoview is registered right here at mod load, the way rcav8tr's infoview mods
            // (CS2Mod-VehicleUse etc., MIT) do it: the game's infoviews already exist when mods
            // load, and the menu picks a prefab added now up through its normal game-load refresh.
            // A prefab added from a running-game system was never initialised (its Created tag was
            // cleared before PrefabInitializeSystem's pass) and stayed invalid.
            Unity.Entities.World.DefaultGameObjectInjectionWorld.GetOrCreateSystemManaged<TP_InfoviewSystem>().Register();
            // Building colouring runs from a Harmony prefix on ObjectColorSystem; it only needs to exist.
            Unity.Entities.World.DefaultGameObjectInjectionWorld.GetOrCreateSystemManaged<TP_BuildingColorSystem>();
            Unity.Entities.World.DefaultGameObjectInjectionWorld.GetOrCreateSystemManaged<TP_NetLoadColorSystem>();
            updateSystem.UpdateAt<TP_WorldOverlaySystem>(SystemUpdatePhase.Rendering);
            // Heatmap channels are filled after vanilla's overlay system has (re)set the terrain override.
            updateSystem.UpdateAfter<TP_HeatmapSystem, Game.Rendering.OverlayInfomodeSystem>(SystemUpdatePhase.PreCulling);
            // The variant tool runs only while it is the active tool (three frames per rebuild).
            updateSystem.UpdateAt<TP_RouteVariantToolSystem>(SystemUpdatePhase.ToolUpdate);
            updateSystem.UpdateAt<TP_PlannerUISystem>(SystemUpdatePhase.UIUpdate);
            updateSystem.UpdateAt<TP_FleetUISystem>(SystemUpdatePhase.UIUpdate);
        }
    }
}
