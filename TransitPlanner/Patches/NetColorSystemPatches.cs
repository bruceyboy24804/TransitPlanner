namespace TransitPlanner.Patches {
    #region Using Statements

    using Game.Rendering;

    using HarmonyLib;

    using TransitPlanner.Systems;

    #endregion

    /// <summary>
    /// After <c>NetColorSystem.OnUpdate</c> has coloured (or reset) every edge, lets
    /// <see cref="TP_NetLoadColorSystem"/> overwrite the edges transit lines run over while the
    /// Line &amp; vehicle load infomode is on. A postfix, so vanilla's own net infomodes keep working.
    /// </summary>
    [HarmonyPatch(typeof(NetColorSystem), "OnUpdate")]
    public static class NetColorSystemPatches {
        [HarmonyPostfix]
        public static void Postfix(NetColorSystem __instance) => TP_NetLoadColorSystem.AfterFrame(__instance);
    }
}
