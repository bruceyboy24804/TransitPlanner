namespace TransitPlanner {
    #region Using Statements

    using System.Collections.Generic;

    using Colossal;
    using Colossal.IO.AssetDatabase;

    using Game.Modding;
    using Game.Settings;

    #endregion

    /// <summary>
    /// Mod options. Kept deliberately small: the schedule itself lives on each line (saved with
    /// the city), so the options screen only holds behaviour that is global to the player.
    /// </summary>
    [FileLocation(nameof(TransitPlanner))]
    [SettingsUIGroupOrder(kGeneralGroup)]
    [SettingsUIShowGroupName(kGeneralGroup)]
    public class Setting : ModSetting {
        public const string kSection      = "Main";
        public const string kGeneralGroup = "General";

        public Setting(IMod mod) : base(mod) { }

        /// <summary>
        /// Apply the per-type default schedule to lines the mod has not seen before (new lines and
        /// lines created before the mod was installed). Off, such lines keep vanilla behaviour until
        /// the player opens them in the planner.
        /// </summary>
        [SettingsUISection(kSection, kGeneralGroup)]
        public bool ApplyDefaultsToNewLines { get; set; } = true;

        /// <summary>
        /// The rule set (Domain/RuleSet) as JSON: a player preference edited in the Rules tab, not
        /// city state, so it lives in the settings file. Hidden from the options screen.
        /// </summary>
        [SettingsUIHidden]
        public string RulesJson { get; set; } = "";

        /// <summary>
        /// The player's own schedule presets, as JSON (<c>{ version, presets: [{ name, bands }] }</c>),
        /// edited whole by the UI. A player preference like the rules: the same presets in every city.
        /// </summary>
        [SettingsUIHidden]
        public string PresetsJson { get; set; } = "";

        public override void SetDefaults() {
            ApplyDefaultsToNewLines = true;
            RulesJson = "";
            PresetsJson = "";
        }
    }

    /// <summary>English strings for the options screen.</summary>
    public class LocaleEN : IDictionarySource {
        private readonly Setting m_Setting;

        public LocaleEN(Setting setting) {
            m_Setting = setting;
        }

        public IEnumerable<KeyValuePair<string, string>> ReadEntries(IList<IDictionaryEntryError> errors,
                                                                     Dictionary<string, int> indexCounts) {
            return new Dictionary<string, string> {
                { m_Setting.GetSettingsLocaleID(), "Transit Planner" },
                { m_Setting.GetOptionTabLocaleID(Setting.kSection), "Main" },
                { m_Setting.GetOptionGroupLocaleID(Setting.kGeneralGroup), "General" },

                { m_Setting.GetOptionLabelLocaleID(nameof(Setting.ApplyDefaultsToNewLines)), "Apply default schedule to new lines" },
                {
                    m_Setting.GetOptionDescLocaleID(nameof(Setting.ApplyDefaultsToNewLines)),
                    "Lines the planner has not seen yet get the default schedule for their transport type. When off, they keep vanilla behaviour until you open them in the planner."
                },

                // The mod's infoview (Systems/TP_InfoviewSystem): the game's own key shapes.
                { "Infoviews.INFOVIEW[TransitPlanner]", "Transit Planner" },
                { "Infoviews.INFOVIEW_TOOLTIP[TransitPlanner]", "Transit lines with the planner's heatmaps: coverage, service frequency, waiting passengers, reach." },
                { "Infoviews.INFOMODE[TransitPlannerCoverage]", "Transit coverage" },
                { "Infoviews.INFOMODE_TOOLTIP[TransitPlannerCoverage]", "How close the ground is to a transit stop; green within a short walk, red beyond 800 m." },
                { "Infoviews.INFOMODE[TransitPlannerFrequency]", "Service frequency" },
                { "Infoviews.INFOMODE_TOOLTIP[TransitPlannerFrequency]", "Departures per hour over every line calling nearby; blue where service is frequent." },
                { "Infoviews.INFOMODE[TransitPlannerWaiting]", "Waiting passengers" },
                { "Infoviews.INFOMODE_TOOLTIP[TransitPlannerWaiting]", "Passengers queued at nearby stops; red where they pile up." },
                { "Infoviews.INFOMODE[TransitPlannerReach]", "Reach from origin" },
                { "Infoviews.INFOMODE_TOOLTIP[TransitPlannerReach]", "Travel time from the reach origin — click a stop while this infoview is open, or use Reach on the planner's Network tab. Green is near, red is at the limit." },
                { "Infoviews.INFOMODE[TransitPlannerWait]", "Average wait" },
                { "Infoviews.INFOMODE_TOOLTIP[TransitPlannerWait]", "How long riders wait at nearby stops on average; red where the wait is long." },
                { "Infoviews.INFOMODE[TransitPlannerUnserved]", "Unserved demand" },
                { "Infoviews.INFOMODE_TOOLTIP[TransitPlannerUnserved]", "Where people live and work with no stop within 400 m — the places a new stop would serve." },
                { "Infoviews.INFOMODE[TransitPlannerBuildingCoverage]", "Buildings: distance to a stop" },
                { "Infoviews.INFOMODE_TOOLTIP[TransitPlannerBuildingCoverage]", "Each building coloured by how far it is from the nearest transit stop." },
                { "Infoviews.INFOMODE[TransitPlannerBuildingReach]", "Buildings: reach from origin" },
                { "Infoviews.INFOMODE_TOOLTIP[TransitPlannerBuildingReach]", "Each building coloured by travel time from the reach origin via its nearest stops." },
                { "Infoviews.INFOMODE[TransitPlannerBuildingFrequency]", "Buildings: service frequency" },
                { "Infoviews.INFOMODE_TOOLTIP[TransitPlannerBuildingFrequency]", "Each building coloured by the departures per hour at stops within a short walk." },
                { "Infoviews.INFOMODE[TransitPlannerVehicleLoad]", "Line & vehicle load" },
                { "Infoviews.INFOMODE_TOOLTIP[TransitPlannerVehicleLoad]", "Vehicles tinted by how full they are, and the roads and tracks under each line coloured by the load of the vehicle that last ran that stretch. Red is full." },
                { "Infoviews.INFOMODE[TransitPlannerVehicleState]", "Vehicle state" },
                { "Infoviews.INFOMODE_TOOLTIP[TransitPlannerVehicleState]", "Blue running, yellow boarding, orange held at a stop (timetable or unbunching), red bunched up behind the vehicle ahead." },
            };
        }

        public void Unload() { }
    }
}
