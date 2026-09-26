namespace TransitPlanner.Components {
    #region Using Statements

    using Colossal.Serialization.Entities;

    using Unity.Entities;
    using Unity.Mathematics;

    #endregion

    /// <summary>
    /// A line's "full" route, remembered so the planner can shorten it for a band and put it back:
    /// one element per waypoint of the full route, in order, with a flag saying whether the
    /// short variant keeps it. Captured from the live route when the player marks a short variant;
    /// re-captured whenever the line is in its full form and the player edits it.
    /// </summary>
    /// <remarks>
    /// The stop entity is what survives: waypoint entities are created and destroyed by every
    /// route edit, so a variant is described by stops (plus a position for waypoints that are
    /// only corners). Entity references are remapped by the save; a bulldozed stop comes back as
    /// Null and its waypoint is dropped from both variants.
    /// </remarks>
    [InternalBufferCapacity(0)]
    public struct TP_VariantWaypoint : IBufferElementData, ISerializable {
        private const int kVersion = 1;

        public float3 m_Position;
        /// <summary>The stop the waypoint serves (Connected.m_Connected), or Null for a corner.</summary>
        public Entity m_Stop;
        /// <summary>1 when the short variant keeps this waypoint.</summary>
        public byte m_InShort;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Position);
            writer.Write(m_Stop);
            writer.Write(m_InShort);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Position);
            reader.Read(out m_Stop);
            reader.Read(out m_InShort);
            _ = version;
        }
    }

    /// <summary>Which variant the line is currently built as, and which the schedule wants.</summary>
    public struct TP_RouteVariant : IComponentData, IQueryTypeParameter, ISerializable {
        private const int kVersion = 1;

        /// <summary>1 while the line is in its short form.</summary>
        public byte m_ActiveShort;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_ActiveShort);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_ActiveShort);
            _ = version;
        }
    }
}
