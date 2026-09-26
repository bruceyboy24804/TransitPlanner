namespace TransitPlanner.Components {
    #region Using Statements

    using Colossal.Serialization.Entities;

    using Unity.Entities;

    #endregion

    /// <summary>
    /// One stretch of the day the line does not run, frames of the day, <c>[m_Start, m_End)</c>
    /// with <c>m_Start &lt; m_End</c> (a closure over midnight is two periods: one ending at the
    /// day's end, one starting at 0). The list is kept sorted and non-overlapping by the UI.
    /// </summary>
    /// <remarks>
    /// Replaces the single service window on <see cref="TP_LineSchedule"/> (its v3
    /// <c>m_ServiceStart</c>/<c>m_ServiceEnd</c>), which could not hold two closed periods that do
    /// not touch midnight. A line with no periods here and the old <c>ServiceHours</c> flag is
    /// still read through that window (<see cref="Domain.ClosedHours"/>) until the UI next writes
    /// its schedule, which converts it.
    /// </remarks>
    [InternalBufferCapacity(0)]
    public struct TP_ClosedPeriod : IBufferElementData, ISerializable {
        private const int kVersion = 1;

        public uint m_Start;
        public uint m_End;

        public bool Contains(uint frameOfDay) => frameOfDay >= m_Start && frameOfDay < m_End;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Start);
            writer.Write(m_End);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Start);
            reader.Read(out m_End);
            _ = version;
        }
    }
}
