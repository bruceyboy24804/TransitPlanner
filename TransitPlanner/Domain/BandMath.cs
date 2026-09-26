namespace TransitPlanner.Domain {
    #region Using Statements

    using Game.Simulation;

    using Unity.Mathematics;

    using TransitPlanner.Components;

    #endregion

    /// <summary>
    /// Headways the band modes ask for that follow from the band alone (no measurements), shared
    /// by the apply tick and the Network tab's hour-by-hour headways.
    /// </summary>
    public static class BandMath {
        /// <summary>Simulation seconds in one game hour (a day is kTicksPerDay / 60 seconds).</summary>
        public const float kSecondsPerHour = TimeSystem.kTicksPerDay / 60f / 24f;

        /// <summary>Frames in the band, wrap included.</summary>
        public static uint Length(TP_ScheduleBand b) =>
            b.m_End >= b.m_Start ? b.m_End - b.m_Start : (uint)TimeSystem.kTicksPerDay - b.m_Start + b.m_End;

        /// <summary>0..1 through the band at <paramref name="frameOfDay"/>.</summary>
        public static float Progress(TP_ScheduleBand b, uint frameOfDay) {
            var len = Length(b);
            if (len == 0) return 0f;
            var into = frameOfDay >= b.m_Start ? frameOfDay - b.m_Start : (uint)TimeSystem.kTicksPerDay - b.m_Start + frameOfDay;
            return math.saturate(into / (float)len);
        }

        /// <summary>
        /// The headway (simulation seconds) a band sets at a moment, or −1 when it depends on
        /// measurements or another line (the stepping modes, MatchLine, Default).
        /// </summary>
        public static float FixedHeadway(TP_ScheduleBand b, uint frameOfDay, float stableDuration) {
            switch (b.m_Mode) {
                case BandMode.Headway:   return math.max(1f, b.m_Headway);
                case BandMode.Fleet:     return LineMath.HeadwayFor(b.m_Fleet, stableDuration);
                case BandMode.Ramp:      return math.max(1f, math.lerp(b.m_Headway, b.m_Value, Progress(b, frameOfDay)));
                case BandMode.Frequency: return math.max(1f, kSecondsPerHour / math.max(0.1f, b.m_Value));
                case BandMode.Convoy:
                case BandMode.Express:   return math.max(1f, b.m_Headway);
                // Never more than m_Fleet: the longer of the two headways.
                case BandMode.Capped:    return math.max(math.max(1f, b.m_Headway), LineMath.HeadwayFor(math.max(1, b.m_Fleet), stableDuration));
                default:                 return -1f;
            }
        }
    }
}
