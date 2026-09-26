namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Pathfind;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Simulation;

    using Unity.Collections;
    using Unity.Entities;
    using Unity.Mathematics;

    using TransitPlanner.Components;
    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// The network view's planning layers: each line's scheduled headway per hour (for the time
    /// scrubber), its timetable departures (for the stop departure board), the coverage gaps
    /// (people with no stop of the shown type in walking range) and editing an existing line's
    /// stops from the map (through the variant tool's rebuild pipeline).
    /// </summary>
    public partial class TP_PlannerUISystem {
        private GapLayer m_Gaps = new GapLayer();
        private int      m_GapsFrame = -100000;
        private int      m_GapsType  = -2;
        private const int   kGapsEveryFrames = 1800;
        private const float kGapCell   = 200f;
        private const float kGapRadius = 400f;

        private void CreateNetworkPlusBindings() {
            CreateBinding("networkGaps", ReadGaps);
            CreateTrigger<Entity, Entity[]>("editLineStops", EditLineStops);
        }

        /// <summary>
        /// The line's scheduled headway for each hour of the day, simulation seconds; 0 where it
        /// does not run (a closed period, the old window, or an Off band at the hour's middle).
        /// Headway bands give their headway, Fleet bands the headway that fleet gives on the
        /// stable loop, everything else the line's current headway.
        /// </summary>
        private float[] HourHeadways(Entity line, float current, float stable) {
            var em  = EntityManager;
            var out_ = new float[24];
            var schedule = em.HasComponent<TP_LineSchedule>(line) ? em.GetComponentData<TP_LineSchedule>(line) : default;
            var bandsOn  = schedule.Enabled && em.HasBuffer<TP_ScheduleBand>(line);
            var bands    = bandsOn ? em.GetBuffer<TP_ScheduleBand>(line, true) : default;
            var closed   = em.HasBuffer<TP_ClosedPeriod>(line) ? em.GetBuffer<TP_ClosedPeriod>(line, true) : default;
            for (var h = 0; h < 24; h++) {
                var f = (uint)((h + 0.5f) / 24f * TimeSystem.kTicksPerDay);
                if (!ClosedHours.InService(closed, schedule, f)) { out_[h] = 0f; continue; }
                var value = current;
                if (bandsOn) {
                    for (var i = 0; i < bands.Length; i++) {
                        if (!bands[i].Contains(f)) continue;
                        var b = bands[i];
                        if (b.m_Mode == BandMode.Off) value = 0f;
                        else {
                            var fixedHw = BandMath.FixedHeadway(b, f, stable);
                            if (fixedHw > 0f) value = fixedHw;
                        }
                        break;
                    }
                }
                out_[h] = value;
            }
            return out_;
        }

        /// <summary>A timetabled line's departures from its anchor over the day, frames of the day (capped).</summary>
        private uint[] Departures(Entity line) {
            var em = EntityManager;
            if (!em.HasComponent<TP_Timetable>(line)) return System.Array.Empty<uint>();
            var tt       = em.GetComponentData<TP_Timetable>(line);
            var schedule = em.HasComponent<TP_LineSchedule>(line) ? em.GetComponentData<TP_LineSchedule>(line) : default;
            var bandsOn  = schedule.Enabled && em.HasBuffer<TP_ScheduleBand>(line);
            var bands    = bandsOn ? em.GetBuffer<TP_ScheduleBand>(line, true) : default;
            var list     = em.HasBuffer<TP_TimetableDeparture>(line) ? em.GetBuffer<TP_TimetableDeparture>(line, true) : default;
            var closed   = em.HasBuffer<TP_ClosedPeriod>(line) ? em.GetBuffer<TP_ClosedPeriod>(line, true) : default;
            var day = (uint)TimeSystem.kTicksPerDay;
            var out_ = new List<uint>();
            uint t = 0;
            while (out_.Count < 600) {
                var w = TimetableMath.WaitFrom(tt, bands, bandsOn, list, closed, schedule, t);
                if (w == uint.MaxValue || t + w >= day) break;
                out_.Add(t + w);
                t = t + w + 1;
            }
            return out_.ToArray();
        }

        /// <summary>Position in the line's stop order of its timetable anchor, or −1.</summary>
        private int AnchorPosition(Entity line, List<int> stopWaypoints) {
            var em = EntityManager;
            if (!em.HasComponent<TP_Timetable>(line)) return -1;
            return stopWaypoints.IndexOf(em.GetComponentData<TP_Timetable>(line).m_StopIndex);
        }

        /// <summary>
        /// Where people live and work with no stop of the network's type within walking range: a
        /// 200 m grid of residents + workers (buildings' renters), with every cell within 400 m of a
        /// shown stop removed. Rebuilt every ~30 s or when the type changes.
        /// </summary>
        private GapLayer ReadGaps() {
            var frame = UnityEngine.Time.frameCount;
            if (!m_Network.valid) return m_Gaps;
            if (m_GapsType == m_NetworkType + (m_NetworkCargo ? 1000 : 0) && frame - m_GapsFrame < kGapsEveryFrames) return m_Gaps;
            m_GapsFrame = frame;
            m_GapsType  = m_NetworkType + (m_NetworkCargo ? 1000 : 0);

            var em = EntityManager;
            var cells = new Dictionary<int2, int>();
            var buildings = m_BuildingQuery.ToEntityArray(Allocator.Temp);
            foreach (var b in buildings) {
                if (!em.HasBuffer<Game.Buildings.Renter>(b) || !em.HasComponent<Game.Objects.Transform>(b)) continue;
                var people = 0;
                foreach (var r in em.GetBuffer<Game.Buildings.Renter>(b, true)) {
                    if (em.HasBuffer<Game.Citizens.HouseholdCitizen>(r.m_Renter)) people += em.GetBuffer<Game.Citizens.HouseholdCitizen>(r.m_Renter, true).Length;
                    else if (em.HasBuffer<Game.Companies.Employee>(r.m_Renter)) people += em.GetBuffer<Game.Companies.Employee>(r.m_Renter, true).Length;
                }
                if (people <= 0) continue;
                var p = em.GetComponentData<Game.Objects.Transform>(b).m_Position;
                var c = new int2((int)math.floor(p.x / kGapCell), (int)math.floor(p.z / kGapCell));
                cells.TryGetValue(c, out var n);
                cells[c] = n + people;
            }
            buildings.Dispose();

            // Served: a cell whose centre is within walking range of a stop of this network.
            var r2 = (int)math.ceil(kGapRadius / kGapCell);
            foreach (var s in m_Network.stops) {
                var c = new int2((int)math.floor(s.x / kGapCell), (int)math.floor(s.y / kGapCell));
                for (var dy = -r2; dy <= r2; dy++) for (var dx = -r2; dx <= r2; dx++) {
                    var k = c + new int2(dx, dy);
                    var centre = (new float2(k) + 0.5f) * kGapCell;
                    if (math.distance(centre, new float2(s.x, s.y)) <= kGapRadius) cells.Remove(k);
                }
            }

            var outCells = new float[cells.Count * 3];
            var i = 0;
            foreach (var kv in cells) {
                outCells[i++] = (kv.Key.x + 0.5f) * kGapCell;
                outCells[i++] = (kv.Key.y + 0.5f) * kGapCell;
                outCells[i++] = kv.Value;
            }
            return m_Gaps = new GapLayer { version = m_Gaps.version + 1, cell = kGapCell, cells = outCells };
        }

        /// <summary>
        /// Rebuilds a line through exactly <paramref name="stops"/> in order. A stop the line
        /// already serves keeps its waypoint, and the path corners between two such stops stay;
        /// a new stop gets a fresh waypoint at its position. The same pipeline as the route
        /// variants (TP_RouteVariantToolSystem.Request); refused while a rebuild is in flight.
        /// </summary>
        private void EditLineStops(Entity line, Entity[] stops) {
            var em = EntityManager;
            if (!IsLine(line) || stops == null || stops.Length < 2) return;
            var live = em.GetBuffer<RouteWaypoint>(line, true);

            // The live route by waypoint: stop served (or Null for a corner), in order.
            var liveStops = new List<Entity>(live.Length);
            foreach (var rw in live) liveStops.Add(em.HasComponent<Connected>(rw.m_Waypoint) ? em.GetComponentData<Connected>(rw.m_Waypoint).m_Connected : Entity.Null);

            var kept      = new List<TP_VariantWaypoint>();
            var originals = new List<Entity>();
            for (var k = 0; k < stops.Length; k++) {
                var stop = stops[k];
                if (stop == Entity.Null || !em.Exists(stop) || !em.HasComponent<Game.Objects.Transform>(stop)) continue;
                var at = liveStops.IndexOf(stop);
                if (at >= 0) {
                    var wp = live[at].m_Waypoint;
                    kept.Add(new TP_VariantWaypoint { m_Position = em.GetComponentData<Position>(wp).m_Position, m_Stop = stop, m_InShort = 1 });
                    originals.Add(wp);
                    // Corners up to the next stop, when that next stop is also the live route's next stop.
                    var next = stops[(k + 1) % stops.Length];
                    var j = (at + 1) % live.Length;
                    var corners = new List<int>();
                    while (j != at && liveStops[j] == Entity.Null) { corners.Add(j); j = (j + 1) % live.Length; }
                    if (liveStops[j] == next) {
                        foreach (var ci in corners) {
                            var cw = live[ci].m_Waypoint;
                            kept.Add(new TP_VariantWaypoint { m_Position = em.GetComponentData<Position>(cw).m_Position, m_Stop = Entity.Null, m_InShort = 1 });
                            originals.Add(cw);
                        }
                    }
                } else {
                    kept.Add(new TP_VariantWaypoint { m_Position = em.GetComponentData<Game.Objects.Transform>(stop).m_Position, m_Stop = stop, m_InShort = 1 });
                    originals.Add(Entity.Null);
                }
            }
            if (kept.Count < 2) { m_Log.Warn($"editLineStops for {line}: fewer than two stops, refused"); return; }
            if (m_VariantTool.Request(line, kept, originals)) m_Log.Info($"editLineStops for {line}: {stops.Length} stop(s), {kept.Count} waypoint(s) requested");
            else m_Log.Warn($"editLineStops for {line}: a rebuild is already in flight");
        }
    }
}
