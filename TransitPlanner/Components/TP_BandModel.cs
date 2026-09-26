namespace TransitPlanner.Components {
    #region Using Statements

    using Colossal.Serialization.Entities;

    using Unity.Entities;

    #endregion

    /// <summary>
    /// One vehicle model a schedule band asks for, on the line's route entity. A band with no
    /// entries leaves the line's models alone; a band with entries has the apply system write
    /// exactly these into the line's <c>VehicleModel</c> buffer while it is active, the way a
    /// manual selection would — so vanilla abandons vehicles that no longer match and dispatches
    /// replacements (<c>RouteUtils.CheckVehicleModel</c>, <c>TransportLineSystem.CheckVehicles</c>).
    /// </summary>
    /// <remarks>
    /// Keyed by band index rather than stored on the band because a buffer element cannot hold a
    /// list. Entity references are remapped by the save; a reference to a prefab that no longer
    /// exists comes back Null and is skipped.
    /// </remarks>
    [InternalBufferCapacity(0)]
    public struct TP_BandModel : IBufferElementData, ISerializable {
        private const int kVersion = 1;

        /// <summary>Index into the line's <see cref="TP_ScheduleBand"/> buffer.</summary>
        public int m_Band;

        /// <summary>Engine / single vehicle prefab, or Null.</summary>
        public Entity m_Primary;

        /// <summary>Carriage prefab, or Null.</summary>
        public Entity m_Secondary;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Band);
            writer.Write(m_Primary);
            writer.Write(m_Secondary);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Band);
            reader.Read(out m_Primary);
            reader.Read(out m_Secondary);
            _ = version;
        }
    }

    /// <summary>
    /// The line's own model selection, snapshotted the moment a band first takes the models over,
    /// and written back when no band asks for models. Empty while the planner is not in charge.
    /// </summary>
    [InternalBufferCapacity(0)]
    public struct TP_BaselineModel : IBufferElementData, ISerializable {
        private const int kVersion = 1;

        public Entity m_Primary;
        public Entity m_Secondary;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Primary);
            writer.Write(m_Secondary);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Primary);
            reader.Read(out m_Secondary);
            _ = version;
        }
    }
}
