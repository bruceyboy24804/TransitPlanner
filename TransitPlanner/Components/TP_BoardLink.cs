namespace TransitPlanner.Components {
    #region Using Statements

    using Colossal.Serialization.Entities;

    using Unity.Collections;
    using Unity.Entities;

    #endregion

    /// <summary>
    /// The Schedule tab's per-line links, on the route entity: the shared schedule template the
    /// line follows (by name — templates are the player's presets, kept in the settings, so they
    /// outlive a save), the group its row is filed under, its order within the group, and the name
    /// of the plan its bands currently are. Empty strings mean none; a line with none of them has
    /// no component.
    /// </summary>
    public struct TP_BoardLink : IComponentData, IQueryTypeParameter, ISerializable {
        // v2: m_Order, m_Plan.
        private const int kVersion = 2;

        public FixedString64Bytes m_Template;
        public FixedString64Bytes m_Group;

        /// <summary>Row order within the group (the board sorts group, order, entity).</summary>
        public int m_Order;

        /// <summary>The plan the line's live bands belong to; empty = "Default".</summary>
        public FixedString64Bytes m_Plan;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Template.ToString());
            writer.Write(m_Group.ToString());
            writer.Write(m_Order);
            writer.Write(m_Plan.ToString());
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out string template);
            reader.Read(out string group);
            m_Template = Clip(template);
            m_Group    = Clip(group);
            if (version >= 2) {
                reader.Read(out m_Order);
                reader.Read(out string plan);
                m_Plan = Clip(plan);
            }
        }

        public bool IsEmpty => m_Template.Length == 0 && m_Group.Length == 0 && m_Order == 0 && m_Plan.Length == 0;

        /// <summary>A string cut to what a FixedString64 holds (61 UTF-8 bytes), so a long name cannot throw.</summary>
        public static FixedString64Bytes Clip(string s) {
            var f = new FixedString64Bytes();
            if (string.IsNullOrEmpty(s)) return f;
            foreach (var ch in s) {
                if (f.Append(ch) != FormatError.None) break;
            }
            return f;
        }
    }

    /// <summary>
    /// One band of a line's inactive named plan (Traffic's timing plans, for lines: "Weekday",
    /// "Event day"…). The active plan's bands are the line's <see cref="TP_ScheduleBand"/> buffer;
    /// switching plans swaps them through this buffer. Per-band vehicle models are not stashed.
    /// </summary>
    [InternalBufferCapacity(0)]
    public struct TP_PlanBand : IBufferElementData, ISerializable {
        private const int kVersion = 1;

        public FixedString64Bytes m_Plan;
        public TP_ScheduleBand m_Band;

        public void Serialize<TWriter>(TWriter writer) where TWriter : IWriter {
            writer.Write(kVersion);
            writer.Write(m_Plan.ToString());
            m_Band.Serialize(writer);
        }

        public void Deserialize<TReader>(TReader reader) where TReader : IReader {
            reader.Read(out int version);
            reader.Read(out string plan);
            m_Plan = TP_BoardLink.Clip(plan);
            m_Band.Deserialize(reader);
            _ = version;
        }
    }
}
