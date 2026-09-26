namespace TransitPlanner.Components {
    #region Using Statements

    using Colossal.Serialization.Entities;

    using Unity.Entities;

    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// One time band of a line's schedule, on the line's route entity. Bands are consulted in
    /// buffer order and the first one containing the current frame of the day wins; a frame no
    /// band covers behaves as <see cref="BandMode.Default"/>.
    /// </summary>
    /// <remarks>
    /// Band edges are frames of the game day (<c>0 .. TimeSystem.kTicksPerDay</c>), the clock the
    /// timeline draws. Headway is in simulation seconds, the unit of every vanilla interval and
    /// duration (<c>TransportLineData.m_DefaultVehicleInterval = 15f</c>, <c>PathInformation.m_Duration</c>);
    /// 60 frames make one simulation second (<c>RouteUtils.CalculateDepartureFrame</c>), so a day is
    /// ~4369 s and the vanilla default is ~4.9 clock-minutes. A band whose <see cref="m_End"/> is
    /// below its <see cref="m_Start"/> wraps past midnight.
    /// </remarks>
    [InternalBufferCapacity(0)]
    public struct TP_ScheduleBand : IBufferElementData, ISerializable {
        // Bump when the field set changes; Deserialize branches on it. Never reorder old fields.
        // v2: m_LoadMin / m_LoadMax (TargetLoad).
        // v3: m_Value / m_Line (Ramp, Frequency, FollowDemand, MatchLine).
        private const int kVersion = 3;

        /// <summary>First frame of the day (inclusive) this band covers.</summary>
        public uint m_Start;

        /// <summary>Frame of the day (exclusive) this band ends at.</summary>
        public uint m_End;

        public BandMode m_Mode;

        /// <summary>Target headway in simulation seconds; used by <see cref="BandMode.Headway"/>.</summary>
        public float m_Headway;

        /// <summary>Target vehicle count; used by <see cref="BandMode.Fleet"/>.</summary>
        public int m_Fleet;

        /// <summary>
        /// Ticket price for this band, or a negative value to leave the fare to vanilla. Only has an
        /// effect while the line has the PaidTicket policy, exactly like vanilla's own price.
        /// </summary>
        public float m_Fare;

        /// <summary>
        /// The low / high thresholds of the stepping modes: load share (TargetLoad, CrowdingCap),
        /// station fill share (StationStock), or wait in simulation seconds (TargetWait).
        /// </summary>
        public float m_LoadMin;
        public float m_LoadMax;

        /// <summary>
        /// The mode's own number: end headway (Ramp, seconds), departures per game hour
        /// (Frequency), target load (FollowDemand), headway multiplier (MatchLine).
        /// </summary>
        public float m_Value;

        /// <summary>MatchLine: the line whose headway this one follows.</summary>
        public Entity m_Line;

        /// <summary>True if <paramref name="frameOfDay"/> falls inside this band, wrap included.</summary>
        public bool Contains(uint frameOfDay) {
            return m_Start <= m_End
                ? frameOfDay >= m_Start && frameOfDay < m_End
                : frameOfDay >= m_Start || frameOfDay < m_End;
        }

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Start);
            writer.Write(m_End);
            writer.Write((byte)m_Mode);
            writer.Write(m_Headway);
            writer.Write(m_Fleet);
            writer.Write(m_Fare);
            writer.Write(m_LoadMin);
            writer.Write(m_LoadMax);
            writer.Write(m_Value);
            writer.Write(m_Line);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Start);
            reader.Read(out m_End);
            reader.Read(out byte mode);
            m_Mode = (BandMode)mode;
            reader.Read(out m_Headway);
            reader.Read(out m_Fleet);
            reader.Read(out m_Fare);
            if (version >= 2) {
                reader.Read(out m_LoadMin);
                reader.Read(out m_LoadMax);
            }
            if (version >= 3) {
                reader.Read(out m_Value);
                reader.Read(out m_Line);
            }
        }
    }
}
