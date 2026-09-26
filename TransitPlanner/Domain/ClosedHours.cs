namespace TransitPlanner.Domain {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Simulation;

    using Unity.Entities;

    using TransitPlanner.Components;

    #endregion

    /// <summary>
    /// When a line is in service: not inside any of its <see cref="TP_ClosedPeriod"/>s, or — for a
    /// line that has none but carries the old single window (<see cref="LineScheduleFlags.ServiceHours"/>)
    /// — inside that window.
    /// </summary>
    public static class ClosedHours {
        private const uint kDay = (uint)TimeSystem.kTicksPerDay;

        public static bool InService(DynamicBuffer<TP_ClosedPeriod> closed, in TP_LineSchedule schedule, uint frameOfDay) {
            if (closed.IsCreated && closed.Length > 0) {
                for (var i = 0; i < closed.Length; i++) if (closed[i].Contains(frameOfDay)) return false;
                return true;
            }
            return schedule.InService(frameOfDay);
        }

        /// <summary>Frames from <paramref name="frameOfDay"/> (closed) to the next moment the line is in service; 0 when it already is.</summary>
        public static uint UntilOpen(DynamicBuffer<TP_ClosedPeriod> closed, in TP_LineSchedule schedule, uint frameOfDay) {
            if (closed.IsCreated && closed.Length > 0) {
                // Periods can touch (a start block ending where another begins), so walk forward.
                uint waited = 0;
                var f = frameOfDay;
                for (var guard = 0; guard < closed.Length + 1; guard++) {
                    var hit = false;
                    for (var i = 0; i < closed.Length; i++) {
                        if (!closed[i].Contains(f)) continue;
                        waited += closed[i].m_End - f;
                        f = closed[i].m_End % kDay;
                        hit = true;
                        break;
                    }
                    if (!hit) return waited;
                }
                return waited;
            }
            if (schedule.InService(frameOfDay)) return 0;
            return (schedule.m_ServiceStart + kDay - frameOfDay) % kDay;
        }

        /// <summary>The old single window as closed periods: before the start, after the end, or the middle when it runs past midnight.</summary>
        public static List<(uint start, uint end)> FromWindow(in TP_LineSchedule s) {
            var list = new List<(uint, uint)>();
            if ((s.m_Flags & LineScheduleFlags.ServiceHours) == 0 || s.m_ServiceStart == s.m_ServiceEnd) return list;
            if (s.m_ServiceStart < s.m_ServiceEnd || s.m_ServiceEnd == 0) {
                if (s.m_ServiceStart > 0) list.Add((0, s.m_ServiceStart));
                if (s.m_ServiceEnd > 0) list.Add((s.m_ServiceEnd, kDay));
            } else {
                list.Add((s.m_ServiceEnd, s.m_ServiceStart));
            }
            return list;
        }
    }
}
