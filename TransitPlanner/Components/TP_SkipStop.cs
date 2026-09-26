namespace TransitPlanner.Components {
    #region Using Statements

    using Colossal.Serialization.Entities;

    using Unity.Entities;

    #endregion

    /// <summary>
    /// A stop the line's vehicles drive past (express running), on the route entity: the stop's
    /// waypoint index and a window, frames of the day, <c>[m_Start, m_End)</c>; <c>m_Start ==
    /// m_End</c> means all day, and <c>m_Start &gt; m_End</c> runs over midnight.
    /// </summary>
    /// <remarks>
    /// Any stop of a passenger line. Two ways to drive past, chosen per stop by <see
    /// cref="Systems.TP_SkipStopSystem"/>: a bus at a plain stop uses vanilla's own test-then-skip
    /// (waiting passengers' <c>RequireStop</c> is dropped); everything else — trains, trams,
    /// metro, ships, aircraft, and buses at stations — is detached (<see cref="TP_SkipDetached"/>),
    /// which every vehicle AI treats as a path corner.
    /// </remarks>
    [InternalBufferCapacity(0)]
    public struct TP_SkipStop : IBufferElementData, ISerializable {
        private const int kVersion = 1;

        public int  m_Waypoint;
        public uint m_Start;
        public uint m_End;

        /// <summary>True if the window covers <paramref name="frameOfDay"/>.</summary>
        public bool ActiveAt(uint frameOfDay) =>
            m_Start == m_End ||
            (m_Start < m_End ? frameOfDay >= m_Start && frameOfDay < m_End : frameOfDay >= m_Start || frameOfDay < m_End);

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Waypoint);
            writer.Write(m_Start);
            writer.Write(m_End);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Waypoint);
            reader.Read(out m_Start);
            reader.Read(out m_End);
            _ = version;
        }
    }

    /// <summary>
    /// On a line's waypoint while its stop is being skipped now. Runtime only (not saved: no
    /// ISerializable), rebuilt by <see cref="Systems.TP_SkipStopSystem"/> after a load. Read by
    /// the boarding-queue job (drop waiting passengers' stop requests) and by <see
    /// cref="Systems.TP_SkipStopPathfindSystem"/> (the stop is closed to this line's trips).
    /// </summary>
    public struct TP_SkippedNow : IComponentData, IQueryTypeParameter {
        /// <summary>Simulation frame the skip began (the detach waits one loop after it).</summary>
        public uint m_Since;
    }

    /// <summary>
    /// On a skipped waypoint whose stop is detached: <c>Connected.m_Connected</c> is set to Null so
    /// every vehicle AI (<c>Transport*AISystem.CheckNavigationLanes</c>) sees a corner and drives
    /// through; <see cref="m_Stop"/> is the stop to put back. Runtime only: the stop is reconnected
    /// before every save (<see cref="Systems.TP_SkipSaveGuardSystem"/>), so a save never holds a
    /// detached stop. The stop's <c>ConnectedRoute</c> list is left alone (vanilla only rebuilds
    /// it on load and on an <c>Updated</c> waypoint), so reconnecting restores everything.
    /// </summary>
    public struct TP_SkipDetached : IComponentData, IQueryTypeParameter {
        public Entity m_Stop;
    }

    /// <summary>On a waypoint whose pathfinding edge must be re-sent (it was just tagged skipped).</summary>
    public struct TP_SkipDirty : IComponentData, IQueryTypeParameter { }
}
