namespace TransitPlanner.Components {
    #region Using Statements

    using System;

    using Colossal.Serialization.Entities;

    using Unity.Entities;

    #endregion

    /// <summary>How a line's timetable generates and hands out departures.</summary>
    [Flags]
    public enum TimetableFlags : byte {
        None = 0,

        /// <summary>
        /// Inside a schedule band in Headway mode the slots run from the band's start at the
        /// band's headway, so the timetable and the fleet vanilla sizes from that headway agree.
        /// Off bands have no departures. Elsewhere the line's own grid (first + interval) applies.
        /// </summary>
        FollowBands = 1,

        /// <summary>Departures are the explicit <see cref="TP_TimetableDeparture"/> list, not a grid.</summary>
        List = 2,

        /// <summary>
        /// A vehicle that reaches the anchor after its due slot, by no more than
        /// <see cref="TP_Timetable.m_LateTolerance"/>, leaves at once on that slot instead of
        /// waiting for the next free one.
        /// </summary>
        LeaveIfLate = 4,
    }

    /// <summary>
    /// Clock-time departures from one anchor stop of a line: the first departure of the day and
    /// the interval between departures, both in frames of the day. Vehicles boarding at that stop
    /// are held until the next free slot; the line's <see cref="TP_TimingPoint"/>s hold them again
    /// at the scheduled offset from that slot; every other stop keeps vanilla's headway hold.
    /// </summary>
    /// <remarks>
    /// The hold is vanilla's own: <c>PublicTransport.m_DepartureFrame</c> is what every vehicle AI
    /// waits on, written by the boarding job from the headway. <c>TP_TimetableSystem</c> overwrites
    /// it with the slot frame while the vehicle is boarding at the anchor. Fleet size is untouched
    /// (unless <see cref="TimetableFlags.FollowBands"/> ties the slots to the band headways, which
    /// the fleet is sized from), so the timetable aligns departures rather than replacing the
    /// schedule. Present only while a timetable is set.
    /// </remarks>
    public struct TP_Timetable : IComponentData, IQueryTypeParameter, ISerializable {
        private const int kVersion = 2;

        /// <summary>Index into the line's <c>RouteWaypoint</c> buffer of the anchor stop.</summary>
        public int m_StopIndex;

        /// <summary>First departure, frames of the day (0..262144).</summary>
        public uint m_First;

        /// <summary>Frames between departures; at least one simulation second.</summary>
        public uint m_Interval;

        /// <summary>The last slot handed to a vehicle, as an absolute simulation frame; the next vehicle takes a later one.</summary>
        public uint m_LastSlot;

        // v2 ---------------------------------------------------------------------------------

        public TimetableFlags m_Flags;

        /// <summary>With <see cref="TimetableFlags.LeaveIfLate"/>: how late (frames) a vehicle may be and still take its missed slot.</summary>
        public uint m_LateTolerance;

        /// <summary>Slot memory older than this many intervals is forgotten and the grid restarts from now.</summary>
        public byte m_Resync;

        /// <summary>Recovery margin added to the timing-point offsets the UI derives from leg times, 0..1. Kept so the editor can show it.</summary>
        public float m_Slack;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_StopIndex);
            writer.Write(m_First);
            writer.Write(m_Interval);
            writer.Write(m_LastSlot);
            writer.Write((byte)m_Flags);
            writer.Write(m_LateTolerance);
            writer.Write(m_Resync);
            writer.Write(m_Slack);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_StopIndex);
            reader.Read(out m_First);
            reader.Read(out m_Interval);
            reader.Read(out m_LastSlot);
            m_Resync = 2;
            if (version >= 2) {
                reader.Read(out byte flags);
                m_Flags = (TimetableFlags)flags;
                reader.Read(out m_LateTolerance);
                reader.Read(out m_Resync);
                reader.Read(out m_Slack);
            }
        }
    }

    /// <summary>One explicit departure from the anchor, frames of the day; used with <see cref="TimetableFlags.List"/>. Kept sorted.</summary>
    [InternalBufferCapacity(0)]
    public struct TP_TimetableDeparture : IBufferElementData, ISerializable {
        private const int kVersion = 1;

        public uint m_Frame;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Frame);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Frame);
            _ = version;
        }
    }

    /// <summary>
    /// A stop past the anchor where a vehicle may not leave before its trip's anchor slot plus
    /// <see cref="m_Offset"/>. Keyed by waypoint index like the anchor.
    /// </summary>
    [InternalBufferCapacity(0)]
    public struct TP_TimingPoint : IBufferElementData, ISerializable {
        private const int kVersion = 1;

        /// <summary>Index into the line's <c>RouteWaypoint</c> buffer.</summary>
        public int m_Waypoint;

        /// <summary>Frames after the anchor departure.</summary>
        public uint m_Offset;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Waypoint);
            writer.Write(m_Offset);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Waypoint);
            reader.Read(out m_Offset);
            _ = version;
        }
    }

    /// <summary>
    /// On a vehicle of a timetabled line: the anchor slot of the trip it is on, and the waypoint
    /// it was last handled at (so a vehicle boarding over several ticks is given one slot, not
    /// pushed back an interval every tick).
    /// </summary>
    public struct TP_TripSlot : IComponentData, IQueryTypeParameter, ISerializable {
        private const int kVersion = 1;

        /// <summary>Absolute simulation frame of the trip's anchor departure; 0 before the first anchor visit.</summary>
        public uint m_Slot;

        /// <summary>Waypoint index the vehicle was last handled at; −1 once it moves on.</summary>
        public int m_Handled;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Slot);
            writer.Write(m_Handled);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Slot);
            reader.Read(out m_Handled);
            _ = version;
        }
    }

    /// <summary>
    /// One hour of a timetabled line's punctuality: departure lateness at the anchor and timing
    /// points, EMA-smoothed like <see cref="TP_LoadSample"/>. 24 elements, index = hour of day.
    /// </summary>
    [InternalBufferCapacity(24)]
    public struct TP_Punctuality : IBufferElementData, ISerializable {
        private const int kVersion = 1;

        /// <summary>Average lateness, simulation seconds (early counts as 0).</summary>
        public float m_Late;

        /// <summary>Share of departures within the on-time window, 0..1.</summary>
        public float m_OnTime;

        public ushort m_Samples;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Late);
            writer.Write(m_OnTime);
            writer.Write(m_Samples);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out m_Late);
            reader.Read(out m_OnTime);
            reader.Read(out m_Samples);
            _ = version;
        }
    }
}
