namespace TransitPlanner.Components {
    #region Using Statements

    using Colossal.Serialization.Entities;

    using Unity.Entities;

    #endregion

    /// <summary>
    /// The only depot allowed to send vehicles to a line. Present only while a depot is chosen;
    /// removing the component restores vanilla dispatch (nearest available depot).
    /// </summary>
    /// <remarks>
    /// Dispatch is a pathfind match between a line's vehicle request and every depot (or idle
    /// vehicle) of the line's type, cheapest wins. <c>TransportPathfindSetupPatches</c> drops
    /// every other depot from that enumeration, so an empty chosen depot means the line waits
    /// (and shows NotEnoughVehicles) rather than being served from elsewhere. The entity
    /// reference is remapped by the save; a bulldozed depot comes back as Null, which the patch
    /// treats as "no restriction".
    /// </remarks>
    public struct TP_PreferredDepot : IComponentData, IQueryTypeParameter, ISerializable {
        private const int kVersion = 1;

        public Entity m_Depot;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Depot);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Depot);
            _ = version;
        }
    }
}
