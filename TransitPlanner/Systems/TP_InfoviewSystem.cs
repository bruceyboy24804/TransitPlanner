namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;
    using System.Linq;

    using Game.Prefabs;
    using Game.Rendering;
    using Game.Tools;

    using Unity.Entities;

    using UnityEngine;

    using ModsCommon.Systems;

    #endregion

    /// <summary>
    /// Registers the mod's infoview, "Transit Planner", built the way the game's own are: an
    /// <see cref="InfoviewPrefab"/> with the vanilla Transport infoview's infomodes (route colours,
    /// transit buildings — the game colours those) plus four <b>heatmap infomodes of our own</b>:
    /// coverage, frequency, waiting and reach. Heatmaps are a terrain texture with one channel
    /// per active infomode, tinted by the infomode's low/medium/high gradient;
    /// <see cref="TP_HeatmapSystem"/> fills our channels.
    /// </summary>
    /// <remarks>
    /// Registered from <c>Mod.RegisterSystems</c>, i.e. at mod load, as rcav8tr's infoview mods do
    /// (CS2Mod-VehicleUse, MIT): the game's infoviews exist by then, and the infoview menu lists a
    /// prefab added now through its ordinary game-load refresh. Adding one from a system in the
    /// running game did not work — its <c>Created</c> tag was cleared before
    /// <c>PrefabInitializeSystem</c>'s pass, so it was never initialised and stayed invalid.
    ///
    /// The heatmap trick: <c>OverlayInfomodeSystem</c> switches on <c>InfoviewHeatmapData.m_Type</c>
    /// and ignores values it does not know, but <c>ToolSystem.SetInfomodeActive</c> still assigns
    /// such an infomode a channel (colour group 0, index 1..4 → channel index−1) and
    /// <c>UpdateInfoviewColors</c> still uploads its gradient. A <see cref="HeatmapInfomodePrefab"/>
    /// with an unused <c>m_Type</c> is therefore a fully wired heatmap slot whose pixels nobody
    /// writes — until our system does. Three of the four are <c>m_Supplemental</c> so only
    /// Coverage is on when the infoview opens; the legend toggles the rest.
    /// </remarks>
    public partial class TP_InfoviewSystem : CommonGameSystemBase {
        public const string kName = "TransitPlanner";

        /// <summary>Our HeatmapData values: past every vanilla one, so OverlayInfomodeSystem leaves them alone.</summary>
        public const HeatmapData kCoverage  = (HeatmapData)100;
        public const HeatmapData kFrequency = (HeatmapData)101;
        public const HeatmapData kWaiting   = (HeatmapData)102;
        public const HeatmapData kReach     = (HeatmapData)103;
        public const HeatmapData kWait      = (HeatmapData)104;
        public const HeatmapData kUnserved  = (HeatmapData)105;

        /// <summary>Our building-colour modes (colour group 2): BuildingStatusType values past every vanilla one.</summary>
        public const BuildingStatusType kBuildingCoverage  = (BuildingStatusType)200;
        public const BuildingStatusType kBuildingReach     = (BuildingStatusType)201;
        public const BuildingStatusType kBuildingFrequency = (BuildingStatusType)202;
        /// <summary>Vehicle / line modes (same colour group, same object-colour seam): load along the line and on each vehicle; vehicle state.</summary>
        public const BuildingStatusType kVehicleLoad  = (BuildingStatusType)210;
        public const BuildingStatusType kVehicleState = (BuildingStatusType)211;

        /// <summary>Vehicle-state mode values (0..255 on its gradient): running, boarding, held at a stop, bunched.</summary>
        public const byte kStateRunning = 0, kStateBoarding = 96, kStateHeld = 160, kStateBunched = 255;

        private PrefabSystem m_Prefabs;
        private ToolSystem   m_Tools;
        private EntityQuery  m_ActiveStatusModes;

        public InfoviewPrefab Infoview { get; private set; }
        public bool Active => Infoview != null && m_Tools.activeInfoview == Infoview;

        protected override void OnCreate() {
            base.OnCreate();
            m_Prefabs = World.GetOrCreateSystemManaged<PrefabSystem>();
            m_Tools   = World.GetOrCreateSystemManaged<ToolSystem>();
            m_ActiveStatusModes = SystemAPI.QueryBuilder().WithAll<InfomodeActive, InfoviewBuildingStatusData>().Build();
            Enabled   = false; // nothing to do per frame; Register() is called once from the mod
        }

        /// <summary>Whether one of our object-colour modes is on, and its gradient slot (<c>InfomodeActive.m_Index</c>).</summary>
        public bool ModeActive(BuildingStatusType type, out int index) {
            index = -1;
            if (!Active) return false;
            var em = EntityManager;
            var actives = m_ActiveStatusModes.ToEntityArray(Unity.Collections.Allocator.Temp);
            foreach (var e in actives) {
                if (em.GetComponentData<InfoviewBuildingStatusData>(e).m_Type != type) continue;
                index = em.GetComponentData<InfomodeActive>(e).m_Index;
                break;
            }
            actives.Dispose();
            return index >= 0;
        }

        protected override void OnUpdate() { }

        /// <summary>Builds and adds the infoview and its infomodes. Idempotent.</summary>
        public void Register() {
            if (Infoview != null) return;
            if (m_Prefabs.TryGetPrefab(new PrefabID(nameof(InfoviewPrefab), kName), out var existing) && existing is InfoviewPrefab already) {
                Infoview = already;
                return;
            }
            var transport = World.GetOrCreateSystemManaged<InfoviewInitializeSystem>().infoviews.FirstOrDefault(v => v.name == "Transport");
            if (transport == null) { m_Log.Warn("The game's Transport infoview is not loaded yet; the Transit Planner infoview is not registered"); return; }

            // From vanilla, only the route colouring (RouteInfomodePrefab: the "Transportation
            // Lines" network colour), so lines stay readable under a heatmap. The station / stop /
            // vehicle / track modes are the Transport infoview's business and only bury our rows.
            var modes = new List<InfomodeInfo>();
            if (transport.m_Infomodes != null) {
                foreach (var m in transport.m_Infomodes) {
                    if (m.m_Mode is not RouteInfomodePrefab) continue;
                    modes.Add(new InfomodeInfo { m_Mode = m.m_Mode, m_Priority = 200 + m.m_Priority, m_Supplemental = m.m_Supplemental, m_Optional = m.m_Optional });
                }
            }
            // Low → High reads "bad → good" for coverage / frequency / reach, "quiet → busy" for waiting.
            modes.Add(Heatmap("TransitPlannerCoverage",  kCoverage,  new Color(0.85f, 0.2f, 0.2f), new Color(0.95f, 0.8f, 0.2f), new Color(0.2f, 0.8f, 0.4f), 100, false));
            modes.Add(Heatmap("TransitPlannerFrequency", kFrequency, new Color(0.85f, 0.2f, 0.2f), new Color(0.95f, 0.8f, 0.2f), new Color(0.2f, 0.6f, 1.0f), 101, true));
            modes.Add(Heatmap("TransitPlannerWaiting",   kWaiting,   new Color(0.2f, 0.8f, 0.4f), new Color(0.95f, 0.8f, 0.2f), new Color(0.9f, 0.25f, 0.15f), 102, true));
            modes.Add(Heatmap("TransitPlannerReach",     kReach,     new Color(0.9f, 0.3f, 0.2f), new Color(0.95f, 0.8f, 0.2f), new Color(0.2f, 0.85f, 0.45f), 103, true));
            modes.Add(Heatmap("TransitPlannerWait",      kWait,      new Color(0.2f, 0.8f, 0.4f), new Color(0.95f, 0.8f, 0.2f), new Color(0.9f, 0.25f, 0.15f), 104, true));
            modes.Add(Heatmap("TransitPlannerUnserved",  kUnserved,  new Color(0.3f, 0.3f, 0.35f), new Color(0.95f, 0.6f, 0.2f), new Color(0.95f, 0.2f, 0.5f), 105, true));
            // Building colouring (colour group 2, so it never competes with the terrain channels):
            // TP_BuildingColorSystem replaces ObjectColorSystem's update while our infoview is on.
            modes.Add(Building("TransitPlannerBuildingCoverage",  kBuildingCoverage,  new Color(0.85f, 0.2f, 0.2f), new Color(0.95f, 0.8f, 0.2f), new Color(0.2f, 0.8f, 0.4f), 110, true));
            modes.Add(Building("TransitPlannerBuildingReach",     kBuildingReach,     new Color(0.9f, 0.3f, 0.2f), new Color(0.95f, 0.8f, 0.2f), new Color(0.2f, 0.85f, 0.45f), 111, true));
            modes.Add(Building("TransitPlannerBuildingFrequency", kBuildingFrequency, new Color(0.85f, 0.2f, 0.2f), new Color(0.95f, 0.8f, 0.2f), new Color(0.2f, 0.6f, 1.0f), 112, true));
            // Vehicles + lines: load (vehicle tint by riders/seats, each line's curves by the load of
            // the vehicle that last ran them — TP_WorldOverlaySystem) and vehicle state (running /
            // boarding / held / bunched as fixed points on the gradient — the legend row labels them).
            modes.Add(Building("TransitPlannerVehicleLoad",  kVehicleLoad,  new Color(0.2f, 0.8f, 0.4f), new Color(0.95f, 0.8f, 0.2f), new Color(0.9f, 0.2f, 0.15f), 120, true));
            modes.Add(Building("TransitPlannerVehicleState", kVehicleState, new Color(0.45f, 0.75f, 0.95f), new Color(0.95f, 0.8f, 0.2f), new Color(0.9f, 0.2f, 0.15f), 121, true));

            var prefab = ScriptableObject.CreateInstance<InfoviewPrefab>();
            prefab.name             = kName;
            prefab.m_IconPath       = transport.m_IconPath;
            prefab.m_DefaultColor   = transport.m_DefaultColor;
            prefab.m_SecondaryColor = transport.m_SecondaryColor;
            prefab.m_Priority       = transport.m_Priority + 1;
            prefab.m_Group          = transport.m_Group;
            prefab.m_WarningCategories = transport.m_WarningCategories;
            prefab.m_Infomodes      = modes.ToArray();

            if (m_Prefabs.AddPrefab(prefab)) {
                Infoview = prefab;
                m_Log.Info($"Registered infoview '{kName}' with {modes.Count} infomode(s), 4 heatmaps");
            } else {
                m_Log.Warn($"AddPrefab refused infoview '{kName}'");
            }
        }

        private InfomodeInfo Building(string name, BuildingStatusType type, Color low, Color medium, Color high, int priority, bool supplemental) {
            var p = ScriptableObject.CreateInstance<BuildingStatusInfomodePrefab>();
            p.name          = name;
            p.m_Type        = type;
            p.m_Low         = low;
            p.m_Medium      = medium;
            p.m_High        = high;
            p.m_Steps       = 11;
            p.m_LegendType  = GradientLegendType.Gradient;
            p.m_LowLabelId  = "Low";
            p.m_HighLabelId = "High";
            if (!m_Prefabs.AddPrefab(p)) m_Log.Warn($"AddPrefab refused infomode '{name}'");
            return new InfomodeInfo { m_Mode = p, m_Priority = priority, m_Supplemental = supplemental };
        }

        private InfomodeInfo Heatmap(string name, HeatmapData type, Color low, Color medium, Color high, int priority, bool supplemental) {
            var p = ScriptableObject.CreateInstance<HeatmapInfomodePrefab>();
            p.name          = name;
            p.m_Type        = type;
            p.m_Low         = low;
            p.m_Medium      = medium;
            p.m_High        = high;
            p.m_Steps       = 11;
            p.m_LegendType  = GradientLegendType.Gradient;
            p.m_LowLabelId  = "Low";
            p.m_HighLabelId = "High";
            if (!m_Prefabs.AddPrefab(p)) m_Log.Warn($"AddPrefab refused infomode '{name}'");
            return new InfomodeInfo { m_Mode = p, m_Priority = priority, m_Supplemental = supplemental };
        }
    }
}
