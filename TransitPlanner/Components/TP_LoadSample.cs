namespace TransitPlanner.Components {
    #region Using Statements

    using Colossal.Serialization.Entities;

    using Unity.Entities;

    #endregion

    /// <summary>
    /// One hour of the line's measured performance, on the route entity: a 24-element buffer,
    /// index = hour of the game day. Sampled on the apply tick (~43 samples per hour) and smoothed
    /// with an exponential moving average so a day's pattern survives the noise and carries over
    /// between days. This is the "measured load overlaid on the timeline" of the design brief;
    /// the idea of banding measurements by time of day is ExtendedTransportManager's
    /// (per-segment, six 4-hour buckets, sampled on departure), kept per line and hourly here.
    /// </summary>
    [InternalBufferCapacity(24)]
    public struct TP_LoadSample : IBufferElementData, ISerializable {
        // v2: m_Fleet, m_Empty.
        private const int kVersion = 2;

        /// <summary>Riders / seats over the line's vehicles, 0..1+.</summary>
        public float m_Load;

        /// <summary>People waiting, averaged per stop.</summary>
        public float m_Waiting;

        /// <summary>Average wait, simulation seconds, averaged over stops.</summary>
        public float m_Wait;

        /// <summary>Vehicles running on the line (smoothed).</summary>
        public float m_Fleet;

        /// <summary>Share of those vehicles carrying nothing, 0..1 (smoothed) — freight's empty running.</summary>
        public float m_Empty;

        /// <summary>Samples folded in so far; 0 means "no data for this hour yet".</summary>
        public ushort m_Samples;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Load);
            writer.Write(m_Waiting);
            writer.Write(m_Wait);
            writer.Write(m_Samples);
            writer.Write(m_Fleet);
            writer.Write(m_Empty);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Load);
            reader.Read(out m_Waiting);
            reader.Read(out m_Wait);
            reader.Read(out m_Samples);
            if (version >= 2) {
                reader.Read(out m_Fleet);
                reader.Read(out m_Empty);
            }
        }
    }
}
