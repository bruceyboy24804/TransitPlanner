namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Routes;
    using Game.Simulation;

    using Unity.Entities;

    using TransitPlanner.Components;
    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// The timetable's writes: the line's own timetable from <c>setSchedule</c>, and
    /// <c>pulseTimetable</c>, which gives every other line calling at the anchor's stop (or its
    /// station) the same departure grid so they meet there on the same minutes.
    /// </summary>
    public partial class TP_PlannerUISystem {
        private void CreateTimetableBindings() {
            CreateTrigger<Entity>("pulseTimetable", PulseTimetable);
        }

        /// <summary>Replaces the line's wait-for-load stations. Structural (the buffer is added on first use).</summary>
        private void WriteLoadWaits(Entity line, LoadWaitDto[] waits) {
            var em = EntityManager;
            var list = new List<TP_LoadWait>();
            foreach (var w in waits ?? System.Array.Empty<LoadWaitDto>()) {
                if (w == null || w.waypoint < 0) continue;
                var maxWait = System.Math.Max(60u, w.maxWait);
                list.Add(new TP_LoadWait { m_Waypoint = w.waypoint, m_MinLoad = System.Math.Max(0f, System.Math.Min(1f, w.minLoad)), m_MaxWait = maxWait, m_MinWait = System.Math.Min(w.minWait, maxWait) });
            }
            if (list.Count == 0 && !em.HasBuffer<TP_LoadWait>(line)) return;
            var buffer = em.HasBuffer<TP_LoadWait>(line) ? em.GetBuffer<TP_LoadWait>(line) : em.AddBuffer<TP_LoadWait>(line);
            buffer.Clear();
            foreach (var w in list) buffer.Add(w);
        }

        /// <summary>Replaces the line's skipped stops (one entry per waypoint). Structural (the buffer is added on first use).</summary>
        private void WriteSkipStops(Entity line, SkipStopDto[] skips) {
            var em   = EntityManager;
            var day  = (uint)TimeSystem.kTicksPerDay;
            var list = new List<TP_SkipStop>();
            var seen = new HashSet<int>();
            foreach (var s in skips ?? System.Array.Empty<SkipStopDto>()) {
                if (s == null || s.waypoint < 0 || !seen.Add(s.waypoint)) continue;
                list.Add(new TP_SkipStop { m_Waypoint = s.waypoint, m_Start = s.start % day, m_End = s.end % day });
            }
            if (list.Count == 0 && !em.HasBuffer<TP_SkipStop>(line)) return;
            var buffer = em.HasBuffer<TP_SkipStop>(line) ? em.GetBuffer<TP_SkipStop>(line) : em.AddBuffer<TP_SkipStop>(line);
            buffer.Clear();
            foreach (var s in list) buffer.Add(s);
        }

        /// <summary>Replaces the line's closed periods; sorted, clamped to the day, empty ones dropped. Structural (the buffer is added on first use).</summary>
        private void WriteClosed(Entity line, ClosedDto[] periods) {
            var em   = EntityManager;
            var day  = (uint)TimeSystem.kTicksPerDay;
            var list = new List<(uint start, uint end)>();
            foreach (var p in periods ?? System.Array.Empty<ClosedDto>()) {
                if (p == null) continue;
                var s = System.Math.Min(p.start, day);
                var e = System.Math.Min(p.end, day);
                if (e > s) list.Add((s, e));
            }
            list.Sort((a, b) => a.start.CompareTo(b.start));
            if (list.Count == 0 && !em.HasBuffer<TP_ClosedPeriod>(line)) return;
            var buffer = em.HasBuffer<TP_ClosedPeriod>(line) ? em.GetBuffer<TP_ClosedPeriod>(line) : em.AddBuffer<TP_ClosedPeriod>(line);
            buffer.Clear();
            foreach (var (s, e) in list) buffer.Add(new TP_ClosedPeriod { m_Start = s, m_End = e });
        }

        /// <summary>Adds, updates or removes the timetable, its departure list and its timing points. Structural; main thread.</summary>
        private void WriteTimetable(Entity line, ScheduleDto dto) {
            var em = EntityManager;
            if (!dto.timetable || dto.timetableInterval < 60) {
                if (em.HasComponent<TP_Timetable>(line)) em.RemoveComponent<TP_Timetable>(line);
                if (em.HasBuffer<TP_TimetableDeparture>(line)) em.RemoveComponent<TP_TimetableDeparture>(line);
                if (em.HasBuffer<TP_TimingPoint>(line)) em.RemoveComponent<TP_TimingPoint>(line);
                return;
            }

            // Editing resets the slot memory so the new grid starts clean.
            var tt = new TP_Timetable {
                m_StopIndex     = dto.timetableStop,
                m_First         = dto.timetableFirst % (uint)TimeSystem.kTicksPerDay,
                m_Interval      = dto.timetableInterval,
                m_Flags         = (TimetableFlags)dto.timetableFlags,
                m_LateTolerance = dto.timetableLateTolerance,
                m_Resync        = (byte)System.Math.Max(1, System.Math.Min(255, dto.timetableResync)),
                m_Slack         = System.Math.Max(0f, dto.timetableSlack),
            };
            if (em.HasComponent<TP_Timetable>(line)) em.SetComponentData(line, tt);
            else em.AddComponentData(line, tt);

            var departures = new List<uint>();
            foreach (var d in dto.timetableDepartures ?? System.Array.Empty<uint>()) departures.Add(d % (uint)TimeSystem.kTicksPerDay);
            departures.Sort();
            var list = em.HasBuffer<TP_TimetableDeparture>(line) ? em.GetBuffer<TP_TimetableDeparture>(line) : em.AddBuffer<TP_TimetableDeparture>(line);
            list.Clear();
            foreach (var d in departures) list.Add(new TP_TimetableDeparture { m_Frame = d });

            var points = em.HasBuffer<TP_TimingPoint>(line) ? em.GetBuffer<TP_TimingPoint>(line) : em.AddBuffer<TP_TimingPoint>(line);
            points.Clear();
            foreach (var p in dto.timingPoints ?? System.Array.Empty<TimingPointDto>()) {
                if (p == null || p.waypoint == dto.timetableStop) continue;
                points.Add(new TP_TimingPoint { m_Waypoint = p.waypoint, m_Offset = p.offset });
            }
        }

        /// <summary>
        /// Copies <paramref name="line"/>'s departure grid (first, interval, list, flags) onto
        /// every other line at its anchor stop, anchored at that line's own waypoint for the stop.
        /// The other lines' timing points are dropped: their offsets were from another anchor.
        /// </summary>
        private void PulseTimetable(Entity line) {
            var em = EntityManager;
            if (!IsLine(line) || !em.HasComponent<TP_Timetable>(line)) return;
            var tt        = em.GetComponentData<TP_Timetable>(line);
            var waypoints = em.GetBuffer<RouteWaypoint>(line, true);
            if (tt.m_StopIndex < 0 || tt.m_StopIndex >= waypoints.Length) return;
            var wp = waypoints[tt.m_StopIndex].m_Waypoint;
            if (!em.HasComponent<Connected>(wp)) return;
            var stop = em.GetComponentData<Connected>(wp).m_Connected;

            // The hub: the stop, and the station building's other stops.
            var hub = new HashSet<Entity> { stop };
            if (em.HasComponent<Owner>(stop)) {
                var building = em.GetComponentData<Owner>(stop).m_Owner;
                if (em.HasBuffer<Game.Objects.SubObject>(building)) {
                    foreach (var so in em.GetBuffer<Game.Objects.SubObject>(building, true)) {
                        if (em.HasBuffer<ConnectedRoute>(so.m_SubObject)) hub.Add(so.m_SubObject);
                    }
                }
            }

            // Other line -> its waypoint index at the hub (first one found).
            var targets = new Dictionary<Entity, int>();
            foreach (var s in hub) {
                if (!em.HasBuffer<ConnectedRoute>(s)) continue;
                foreach (var cr in em.GetBuffer<ConnectedRoute>(s, true)) {
                    if (!em.HasComponent<Owner>(cr.m_Waypoint) || !em.HasComponent<Waypoint>(cr.m_Waypoint)) continue;
                    var other = em.GetComponentData<Owner>(cr.m_Waypoint).m_Owner;
                    if (other == line || targets.ContainsKey(other) || !IsLine(other)) continue;
                    targets[other] = em.GetComponentData<Waypoint>(cr.m_Waypoint).m_Index;
                }
            }

            var departures = new List<uint>();
            if (em.HasBuffer<TP_TimetableDeparture>(line)) foreach (var d in em.GetBuffer<TP_TimetableDeparture>(line, true)) departures.Add(d.m_Frame);

            foreach (var kv in targets) {
                var copy = tt;
                copy.m_StopIndex = kv.Value;
                copy.m_LastSlot  = 0;
                if (em.HasComponent<TP_Timetable>(kv.Key)) em.SetComponentData(kv.Key, copy);
                else em.AddComponentData(kv.Key, copy);
                var list = em.HasBuffer<TP_TimetableDeparture>(kv.Key) ? em.GetBuffer<TP_TimetableDeparture>(kv.Key) : em.AddBuffer<TP_TimetableDeparture>(kv.Key);
                list.Clear();
                foreach (var d in departures) list.Add(new TP_TimetableDeparture { m_Frame = d });
                if (em.HasBuffer<TP_TimingPoint>(kv.Key)) em.GetBuffer<TP_TimingPoint>(kv.Key).Clear();
            }
            m_Log.Info($"pulseTimetable from {line}: {targets.Count} other line(s) at the hub now share its departures");
        }
    }
}
