namespace TransitPlanner.Components {
    #region Using Statements

    using System;

    using Colossal.Serialization.Entities;

    using Unity.Entities;
    using Unity.Mathematics;

    #endregion

    [Flags]
    public enum LineScheduleFlags : uint {
        None = 0,

        /// <summary>The planner drives this line. Off, the bands are kept but not applied.</summary>
        Enabled = 1u << 0,

        /// <summary>Write <see cref="TP_LineSchedule.m_UnbunchingFactor"/> onto the line each tick.</summary>
        OverrideUnbunching = 1u << 1,

        /// <summary>The rules system has seen this line once; "new line" rules will not fire again.</summary>
        RulesSeen = 1u << 2,

        /// <summary>The apply tick set the Inactive policy for an Off band; it clears it when the band ends.</summary>
        InactiveByBand = 1u << 3,

        /// <summary>An Express band switched the line to its short form; it switches back when the band ends.</summary>
        ShortByBand = 1u << 30,

        /// <summary>
        /// The line runs only between <see cref="TP_LineSchedule.m_ServiceStart"/> and
        /// <see cref="TP_LineSchedule.m_ServiceEnd"/>; outside them it is switched off like an
        /// Off band and the timetable has no departures. Applies whether or not the bands are on.
        /// </summary>
        ServiceHours = 1u << 4,
    }

    /// <summary>
    /// Per-line schedule state that is not a band: flags, the unbunching override, and the
    /// bookkeeping the apply system needs to share the <c>RouteModifier</c> buffer with vanilla.
    /// </summary>
    /// <remarks>
    /// The route-modifier buffer is rebuilt from the line's policies by <c>ModifiedSystem</c>
    /// whenever a policy changes (the vanilla vehicle-count slider is such a policy), so the mod
    /// cannot own it. The protocol: each tick, if a modifier is not what the mod last wrote,
    /// vanilla changed it and that value becomes the new <see cref="m_VanillaInterval"/> /
    /// <see cref="m_VanillaFare"/> baseline. A <c>Default</c> band writes the baseline back; any
    /// other band writes its own value. Either way the write is remembered in
    /// <see cref="m_WrittenInterval"/> / <see cref="m_WrittenFare"/> for the next comparison.
    /// </remarks>
    public struct TP_LineSchedule : IComponentData, IQueryTypeParameter, ISerializable {
        // v2: m_AppliedModelBand. v3: service hours. v4: target-load state.
        private const int kVersion = 4;

        public LineScheduleFlags m_Flags;

        /// <summary>Replacement for <c>TransportLine.m_UnbunchingFactor</c> when the flag is set.</summary>
        public float m_UnbunchingFactor;

        /// <summary>The <c>VehicleInterval</c> modifier delta as vanilla last left it.</summary>
        public float2 m_VanillaInterval;

        /// <summary>The <c>TicketPrice</c> modifier delta as vanilla last left it.</summary>
        public float2 m_VanillaFare;

        /// <summary>What the mod last wrote to the <c>VehicleInterval</c> modifier.</summary>
        public float2 m_WrittenInterval;

        /// <summary>What the mod last wrote to the <c>TicketPrice</c> modifier.</summary>
        public float2 m_WrittenFare;

        /// <summary>
        /// Index of the band whose models are currently written into the line's <c>VehicleModel</c>
        /// buffer, or -1 when the line's own selection (see <see cref="TP_BaselineModel"/>) is in place.
        /// </summary>
        public int m_AppliedModelBand;

        /// <summary>First frame of the day in service (with <see cref="LineScheduleFlags.ServiceHours"/>).</summary>
        public uint m_ServiceStart;

        /// <summary>Frame of the day service ends (exclusive); below the start wraps past midnight.</summary>
        public uint m_ServiceEnd;

        /// <summary>TargetLoad: the fleet the band has arrived at (0 = not started; seeded from the running fleet).</summary>
        public int m_AutoFleet;

        /// <summary>TargetLoad: the simulation frame of the last change, for the once-per-game-hour cool-down.</summary>
        public uint m_AutoFrame;

        public bool Enabled => (m_Flags & LineScheduleFlags.Enabled) != 0;

        /// <summary>True if the line is in service at <paramref name="frameOfDay"/>: always, unless service hours are set and the frame is outside them.</summary>
        public bool InService(uint frameOfDay) {
            if ((m_Flags & LineScheduleFlags.ServiceHours) == 0 || m_ServiceStart == m_ServiceEnd) return true;
            return m_ServiceStart < m_ServiceEnd
                ? frameOfDay >= m_ServiceStart && frameOfDay < m_ServiceEnd
                : frameOfDay >= m_ServiceStart || frameOfDay < m_ServiceEnd;
        }

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write((uint)m_Flags);
            writer.Write(m_UnbunchingFactor);
            writer.Write(m_VanillaInterval);
            writer.Write(m_VanillaFare);
            writer.Write(m_WrittenInterval);
            writer.Write(m_WrittenFare);
            writer.Write(m_AppliedModelBand);
            writer.Write(m_ServiceStart);
            writer.Write(m_ServiceEnd);
            writer.Write(m_AutoFleet);
            writer.Write(m_AutoFrame);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out uint flags);
            m_Flags = (LineScheduleFlags)flags;
            reader.Read(out m_UnbunchingFactor);
            reader.Read(out m_VanillaInterval);
            reader.Read(out m_VanillaFare);
            reader.Read(out m_WrittenInterval);
            reader.Read(out m_WrittenFare);
            // Additive: a v1 record has no applied band, which means "the line's own models".
            m_AppliedModelBand = -1;
            if (version >= 2) reader.Read(out m_AppliedModelBand);
            if (version >= 3) {
                reader.Read(out m_ServiceStart);
                reader.Read(out m_ServiceEnd);
            }
            if (version >= 4) {
                reader.Read(out m_AutoFleet);
                reader.Read(out m_AutoFrame);
            }
        }
    }
}
