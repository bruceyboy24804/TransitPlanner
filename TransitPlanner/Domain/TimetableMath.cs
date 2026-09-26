namespace TransitPlanner.Domain {
    #region Using Statements

    using Game.Simulation;

    using Unity.Entities;

    using TransitPlanner.Components;

    #endregion

    /// <summary>
    /// The timetable's departure generator, in frames of the day. <c>UI/src/timetable.ts</c> is
    /// the same algorithm for the printed timetable; keep the two in step.
    /// </summary>
    public static class TimetableMath {
        private const uint kDay = (uint)TimeSystem.kTicksPerDay;

        /// <summary>Frames from <paramref name="a"/> forward to <paramref name="b"/> around the day, 0..day-1.</summary>
        private static uint Fwd(uint a, uint b) => (b + kDay - a) % kDay;

        /// <summary>
        /// Frames from frame-of-day <paramref name="t"/> to the first departure at or after it, or
        /// <c>uint.MaxValue</c> when there is none within two days.
        /// </summary>
        /// <param name="bands">The line's schedule bands, consulted only with <see cref="TimetableFlags.FollowBands"/> and <paramref name="bandsOn"/>.</param>
        /// <param name="list">Explicit departures, consulted only with <see cref="TimetableFlags.List"/>.</param>
        /// <param name="closed">The line's closed periods (with <paramref name="schedule"/>'s old window as the fallback): departures inside them are dropped.</param>
        public static uint WaitFrom(in TP_Timetable tt, DynamicBuffer<TP_ScheduleBand> bands, bool bandsOn,
                                    DynamicBuffer<TP_TimetableDeparture> list, DynamicBuffer<TP_ClosedPeriod> closed, in TP_LineSchedule schedule, uint t) {
            t %= kDay;
            uint total = 0;
            // A departure outside service hours is skipped by starting again at the next opening.
            for (var tries = 0; tries < 8; tries++) {
                var w = WaitRaw(tt, bands, bandsOn, list, (t + total) % kDay);
                if (w == uint.MaxValue) return w;
                var at = (t + total + w) % kDay;
                var until = ClosedHours.UntilOpen(closed, schedule, at);
                if (until == 0) return total + w;
                total += w + until;
                if (total >= 2 * kDay) break;
            }
            return uint.MaxValue;
        }

        private static uint WaitRaw(in TP_Timetable tt, DynamicBuffer<TP_ScheduleBand> bands, bool bandsOn,
                                    DynamicBuffer<TP_TimetableDeparture> list, uint t) {
            t %= kDay;
            if ((tt.m_Flags & TimetableFlags.List) != 0) {
                if (!list.IsCreated || list.Length == 0) return uint.MaxValue;
                var best = uint.MaxValue;
                foreach (var d in list) {
                    var w = Fwd(t, d.m_Frame % kDay);
                    if (w < best) best = w;
                }
                return best;
            }

            var follow = bandsOn && (tt.m_Flags & TimetableFlags.FollowBands) != 0 && bands.IsCreated && bands.Length > 0;
            uint waited = 0;
            var d0 = t;
            // Each step either finds a departure in the segment containing d0 or moves to its end.
            for (var step = 0; step < 64 && waited < 2 * kDay; step++) {
                // Headway bands carry their own grid from the band start; Off bands have none.
                // Default and Fleet bands fall through to the line's grid below.
                var band = follow ? BandAt(bands, d0) : -1;
                if (band >= 0 && (bands[band].m_Mode == BandMode.Headway || bands[band].m_Mode == BandMode.Off)) {
                    var b = bands[band];
                    var len   = Fwd(b.m_Start, b.m_End); if (len == 0) len = kDay;
                    var since = Fwd(b.m_Start, d0);
                    var left  = len - since;
                    if (b.m_Mode == BandMode.Headway && b.m_Headway > 0f) {
                        var iv  = (uint)System.Math.Max(60f, b.m_Headway * 60f);
                        var off = (iv - since % iv) % iv;
                        if (off < left) return waited + off;
                    }
                    waited += left; d0 = (d0 + left) % kDay;
                    continue;
                }

                // The line's own grid: first departure of the day, then every interval to midnight.
                var until = kDay - d0;
                if (follow) {
                    for (var i = 0; i < bands.Length; i++) {
                        var m = bands[i].m_Mode;
                        if (m != BandMode.Headway && m != BandMode.Off) continue;
                        var w = Fwd(d0, bands[i].m_Start);
                        if (w > 0 && w < until) until = w;
                    }
                }
                var interval = System.Math.Max(60u, tt.m_Interval);
                var first    = tt.m_First % kDay;
                uint offset;
                if (d0 < first) offset = first - d0;
                else { var s = (d0 - first) % interval; offset = s == 0 ? 0 : interval - s; }
                if (offset < until) return waited + offset;
                waited += until; d0 = (d0 + until) % kDay;
            }
            return uint.MaxValue;
        }

        /// <summary>Mean on-time share and lateness over the hours with punctuality data; <paramref name="onTime"/> is −1 when there are none.</summary>
        public static void Summarise(DynamicBuffer<TP_Punctuality> punct, out float onTime, out float late, out int hours) {
            onTime = 0f; late = 0f; hours = 0;
            foreach (var p in punct) {
                if (p.m_Samples == 0) continue;
                onTime += p.m_OnTime; late += p.m_Late; hours++;
            }
            if (hours == 0) { onTime = -1f; return; }
            onTime /= hours; late /= hours;
        }

        private static int BandAt(DynamicBuffer<TP_ScheduleBand> bands, uint frameOfDay) {
            for (var i = 0; i < bands.Length; i++) if (bands[i].Contains(frameOfDay)) return i;
            return -1;
        }

        /// <summary>The interval the grid runs at around <paramref name="t"/>, for resync windows; a list uses its widest gap.</summary>
        public static uint IntervalAt(in TP_Timetable tt, DynamicBuffer<TP_ScheduleBand> bands, bool bandsOn,
                                      DynamicBuffer<TP_TimetableDeparture> list, uint t) {
            if ((tt.m_Flags & TimetableFlags.List) != 0) {
                if (!list.IsCreated || list.Length < 2) return kDay;
                uint widest = 0;
                for (var i = 0; i < list.Length; i++) {
                    var gap = Fwd(list[i].m_Frame, list[(i + 1) % list.Length].m_Frame);
                    if (gap == 0) gap = kDay;
                    if (gap > widest) widest = gap;
                }
                return widest;
            }
            if (bandsOn && (tt.m_Flags & TimetableFlags.FollowBands) != 0 && bands.IsCreated) {
                var i = BandAt(bands, t % kDay);
                if (i >= 0 && bands[i].m_Mode == BandMode.Headway && bands[i].m_Headway > 0f) {
                    return (uint)System.Math.Max(60f, bands[i].m_Headway * 60f);
                }
            }
            return System.Math.Max(60u, tt.m_Interval);
        }
    }
}
