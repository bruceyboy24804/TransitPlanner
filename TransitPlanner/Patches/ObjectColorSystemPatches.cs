namespace TransitPlanner.Patches {
    #region Using Statements

    using Game.Rendering;

    using HarmonyLib;

    using TransitPlanner.Systems;

    #endregion

    /// <summary>
    /// Hands <c>ObjectColorSystem.OnUpdate</c> to <see cref="TP_BuildingColorSystem"/> while the mod's
    /// infoview shows one of its building modes (IBLIV's recipe). A class-level attribute is what
    /// <c>PatchAll</c> scans for — a method attribute alone inside a system is never applied.
    /// </summary>
    [HarmonyPatch(typeof(ObjectColorSystem), "OnUpdate")]
    public static class ObjectColorSystemPatches {
        [HarmonyPrefix]
        public static bool Prefix(ObjectColorSystem __instance) => TP_BuildingColorSystem.TakeFrame(__instance);
    }
}
