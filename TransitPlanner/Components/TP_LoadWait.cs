namespace TransitPlanner.Components {
    #region Using Statements

    using Colossal.Serialization.Entities;

    using Unity.Entities;

    #endregion

    /// <summary>
    /// A "wait for load" stop on a line (freight or passenger): a vehicle loading here leaves only
    /// once it has waited at least <see cref="m_MinWait"/> frames, and then as soon as it is at
    /// least <see cref="m_MinLoad"/> full or has waited <see cref="m_MaxWait"/> frames. Keyed by
    /// waypoint index, like the timetable's anchor.
    /// </summary>
    [InternalBufferCapacity(0)]
    public struct TP_LoadWait : IBufferElementData, ISerializable {
        // v2: m_MinWait.
        private const int kVersion = 2;

        /// <summary>Index into the line's <c>RouteWaypoint</c> buffer.</summary>
        public int m_Waypoint;

        /// <summary>Load share to wait for, 0..1.</summary>
        public float m_MinLoad;

        /// <summary>The longest hold, frames (after which the vehicle leaves however full).</summary>
        public uint m_MaxWait;

        /// <summary>The shortest hold, frames (a vehicle full sooner still waits this long).</summary>
        public uint m_MinWait;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Waypoint);
            writer.Write(m_MinLoad);
            writer.Write(m_MaxWait);
            writer.Write(m_MinWait);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Waypoint);
            reader.Read(out m_MinLoad);
            reader.Read(out m_MaxWait);
            if (version >= 2) reader.Read(out m_MinWait);
        }
    }

    /// <summary>On a vehicle held by <see cref="TP_LoadWait"/>: where the hold started and when.</summary>
    public struct TP_LoadHold : IComponentData, IQueryTypeParameter, ISerializable {
        private const int kVersion = 1;

        /// <summary>Waypoint index the vehicle is being held at; −1 when not held.</summary>
        public int m_Waypoint;

        /// <summary>Simulation frame the hold started.</summary>
        public uint m_Since;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Waypoint);
            writer.Write(m_Since);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Waypoint);
            reader.Read(out m_Since);
            _ = version;
        }
    }
}
