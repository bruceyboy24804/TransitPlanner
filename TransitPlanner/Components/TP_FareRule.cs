namespace TransitPlanner.Components {
    #region Using Statements

    using Colossal.Serialization.Entities;

    using Unity.Entities;

    #endregion

    /// <summary>How a line prices a ride, beyond the flat per-line/per-band ticket.</summary>
    // Stored as a byte in the save; append, never reorder.
    public enum FareMode : byte {
        /// <summary>Vanilla: the line's <c>TransportLine.m_TicketPrice</c> (which the bands already drive).</summary>
        Flat = 0,

        /// <summary><c>m_Base + m_PerKm × km ridden</c>, from the boarding stop to the passenger's exit stop.</summary>
        Distance = 1,
    }

    /// <summary>
    /// Per-line fare rule. Present only while the line prices by distance; without it the fare
    /// is whatever vanilla computed (after the head-car fix, which applies to every line).
    /// </summary>
    /// <remarks>
    /// The price is rewritten in <c>Patches.ResidentBoardingPatches</c>, between the Burst job
    /// that computes it and the job that charges it: the two talk through
    /// <c>ResidentAISystem.Actions.m_BoardingQueue</c>, and every <c>FinishEnter</c> item names
    /// the passenger, whose path says where they get off.
    /// </remarks>
    public struct TP_FareRule : IComponentData, IQueryTypeParameter, ISerializable {
        private const int kVersion = 1;

        public FareMode m_Mode;

        /// <summary>Boarding charge, whole currency units.</summary>
        public int m_Base;

        /// <summary>Charge per kilometre ridden, currency units (fractions allowed; the total is rounded).</summary>
        public float m_PerKm;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write((byte)m_Mode);
            writer.Write(m_Base);
            writer.Write(m_PerKm);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out byte mode);
            m_Mode = (FareMode)mode;
            reader.Read(out m_Base);
            reader.Read(out m_PerKm);
            _ = version;
        }
    }
}
