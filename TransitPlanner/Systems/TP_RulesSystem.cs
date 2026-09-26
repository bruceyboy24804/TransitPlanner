namespace TransitPlanner.Systems {
    #region Using Statements

    using System;
    using System.Collections.Generic;

    using Game;
    using Game.Common;
    using Game.Pathfind;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Simulation;
    using Game.Tools;
    using Game.UI;
    using Game.UI.InGame;

    using Newtonsoft.Json;

    using Unity.Collections;
    using Unity.Entities;

    using ModsCommon.Systems;

    using TransitPlanner.Components;
    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// Applies the player's rules to lines: "new bus lines get preset X and model Y", "lines whose
    /// peak load passes 80% switch to model Z". Runs on a slow simulation tick for the rules marked
    /// auto, and once for every enabled rule when the UI asks ("apply now").
    /// </summary>
    /// <remarks>
    /// A rule only writes when it would change something, so a line that already matches is left
    /// alone and nothing flaps. Model writes respect the schedule's per-band ownership: while a
    /// band owns the models, the rule writes the line's baseline (what the band hands back to),
    /// otherwise the live buffer, the same way the fleet tab's bulk edit would. Load triggers
    /// wait for at least six sampled hours so a fresh line's first noisy samples do not fire them.
    /// </remarks>
    public partial class TP_RulesSystem : CommonGameSystemBase {
        private EntityQuery m_LineQuery;
        private EntityQuery m_VehiclePrefabQuery;
        private PrefabSystem m_Prefabs;
        private NameSystem   m_Names;
        private PoliciesUISystem m_Policies;
        private EntityQuery  m_RouteOptionPolicyQuery;

        private string    m_LoadedJson;
        private RuleSet   m_Rules = new RuleSet();
        private bool      m_ApplyAllOnce;
        private const int kMinSampledHours = 6;

        /// <summary>Every ~1024 frames (about 5½ clock minutes): rules do not need to be quick.</summary>
        public override int GetUpdateInterval(SystemUpdatePhase phase) => 1024;

        protected override void OnCreate() {
            base.OnCreate();
            m_Prefabs  = World.GetOrCreateSystemManaged<PrefabSystem>();
            m_Names    = World.GetOrCreateSystemManaged<NameSystem>();
            m_Policies = World.GetOrCreateSystemManaged<PoliciesUISystem>();
            m_RouteOptionPolicyQuery = SystemAPI.QueryBuilder().WithAll<PolicyData, RouteOptionData>().Build();
            m_LineQuery = SystemAPI.QueryBuilder()
                                   .WithAll<Route, TransportLine, PrefabRef, TP_LineSchedule, TP_ScheduleBand>()
                                   .WithNone<Temp, Deleted>()
                                   .Build();
            m_VehiclePrefabQuery = GetEntityQuery(TransportVehicleSelectData.GetEntityQueryDesc());
        }

        /// <summary>Runs every enabled rule once on the next tick, auto or not.</summary>
        public void RequestApplyAll() => m_ApplyAllOnce = true;

        /// <summary>The current rules as JSON, for the UI.</summary>
        public string RulesJson => ((Setting)Mod.Instance.Settings).RulesJson ?? "";

        protected override void OnUpdate() {
            var setting = (Setting)Mod.Instance.Settings;
            var json = setting.RulesJson ?? "";
            if (json != m_LoadedJson) {
                m_LoadedJson = json;
                try {
                    m_Rules = string.IsNullOrEmpty(json) ? new RuleSet() : JsonConvert.DeserializeObject<RuleSet>(json) ?? new RuleSet();
                } catch (Exception e) {
                    m_Log.Warn($"Rules JSON unreadable, ignoring: {e.Message}");
                    m_Rules = new RuleSet();
                }
            }

            var applyAll = m_ApplyAllOnce;
            m_ApplyAllOnce = false;
            var active = m_Rules.rules.FindAll(r => r.enabled && (r.auto || applyAll));
            var em = EntityManager;
            var lines = m_LineQuery.ToEntityArray(Allocator.Temp);
            var namesToPrefabs = active.Count > 0 ? PrefabsByName() : null;
            var applied = 0;

            foreach (var line in lines) {
                var schedule = em.GetComponentData<TP_LineSchedule>(line);
                var isNew = (schedule.m_Flags & LineScheduleFlags.RulesSeen) == 0;
                var prefab = em.GetComponentData<PrefabRef>(line).m_Prefab;
                if (!em.HasComponent<TransportLineData>(prefab)) continue;
                var lineData = em.GetComponentData<TransportLineData>(prefab);
                var type = (int)lineData.m_TransportType;
                var cargo = lineData.m_CargoTransport && !lineData.m_PassengerTransport;

                Summarise(line, out var peak, out var low, out var wait, out var sampled);
                var fleet = em.HasBuffer<RouteVehicle>(line) ? em.GetBuffer<RouteVehicle>(line, true).Length : 0;
                var shortOfVehicles = (em.GetComponentData<TransportLine>(line).m_Flags & TransportLineFlags.NotEnoughVehicles) != 0;
                string lineName = null;

                foreach (var rule in active) {
                    if (rule.type != type || rule.cargo != cargo) continue;
                    if (!string.IsNullOrEmpty(rule.nameContains)) {
                        lineName ??= LineName(line);
                        if (lineName.IndexOf(rule.nameContains, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    }
                    var fires = (RuleTrigger)rule.trigger switch {
                        RuleTrigger.NewLine           => isNew && setting.ApplyDefaultsToNewLines,
                        RuleTrigger.PeakLoadAbove     => sampled >= kMinSampledHours && peak > rule.threshold,
                        RuleTrigger.LowLoadBelow      => sampled >= kMinSampledHours && low < rule.threshold,
                        RuleTrigger.MaxWaitAbove      => sampled >= kMinSampledHours && wait > rule.threshold,
                        RuleTrigger.LateAbove         => Punctuality(line, out _, out var late) >= kMinSampledHours && late > rule.threshold,
                        RuleTrigger.OnTimeBelow       => Punctuality(line, out var onTime, out _) >= kMinSampledHours && onTime < rule.threshold,
                        RuleTrigger.NotEnoughVehicles => shortOfVehicles,
                        RuleTrigger.FleetAbove        => fleet > rule.threshold,
                        RuleTrigger.FleetBelow        => fleet < rule.threshold,
                        RuleTrigger.LoadAtHourAbove   => LoadAt(line, rule.hour, out var load) && load > rule.threshold,
                        RuleTrigger.Always            => true,
                        _ => false,
                    };
                    if (!fires) continue;
                    if (ApplyRule(line, rule, namesToPrefabs)) applied++;
                }

                if (isNew) {
                    schedule = em.GetComponentData<TP_LineSchedule>(line);
                    schedule.m_Flags |= LineScheduleFlags.RulesSeen;
                    em.SetComponentData(line, schedule);
                }
            }
            lines.Dispose();
            if (applied > 0) m_Log.Info($"Rules applied to {applied} line(s){(applyAll ? " (apply now)" : "")}");
        }

        /// <summary>Writes the rule's models and/or bands; true if anything changed.</summary>
        private bool ApplyRule(Entity line, Rule rule, Dictionary<string, Entity> prefabs) {
            var em = EntityManager;
            var changed = false;

            if (rule.primary.Count + rule.secondary.Count > 0) {
                var primary   = Resolve(rule.primary, prefabs);
                var secondary = Resolve(rule.secondary, prefabs);
                var schedule  = em.GetComponentData<TP_LineSchedule>(line);
                var n = Math.Max(primary.Count, secondary.Count);
                if (schedule.m_AppliedModelBand >= 0 && em.HasBuffer<TP_BaselineModel>(line)) {
                    // A band owns the live buffer; the rule sets what the line runs outside bands.
                    var baseline = em.GetBuffer<TP_BaselineModel>(line);
                    if (!SameModels(baseline, primary, secondary)) {
                        baseline.Clear();
                        for (var i = 0; i < n; i++) baseline.Add(new TP_BaselineModel { m_Primary = At(primary, i), m_Secondary = At(secondary, i) });
                        changed = true;
                    }
                } else if (em.HasBuffer<VehicleModel>(line)) {
                    var models = em.GetBuffer<VehicleModel>(line);
                    if (!SameModels(models, primary, secondary)) {
                        models.Clear();
                        for (var i = 0; i < n; i++) models.Add(new VehicleModel { m_PrimaryPrefab = At(primary, i), m_SecondaryPrefab = At(secondary, i) });
                        changed = true;
                    }
                }
            }

            // "No service" bands are retired in favour of closed periods: a rule's Off bands are
            // written as closed periods (below, with the structural writes), the rest as bands.
            var ruleBands = rule.bands.FindAll(b => (BandMode)b.mode != BandMode.Off);
            var ruleOff   = rule.bands.FindAll(b => (BandMode)b.mode == BandMode.Off);
            if (ruleBands.Count > 0 && em.HasBuffer<TP_ScheduleBand>(line)) {
                var bands = em.GetBuffer<TP_ScheduleBand>(line);
                if (!SameBands(bands, ruleBands)) {
                    bands.Clear();
                    foreach (var b in ruleBands) {
                        bands.Add(new TP_ScheduleBand { m_Start = b.start, m_End = b.end, m_Mode = (BandMode)b.mode, m_Headway = b.headway, m_Fleet = b.fleet, m_Fare = b.fare, m_LoadMin = b.loadMin, m_LoadMax = b.loadMax, m_Value = b.value });
                    }
                    // Rule bands carry no per-band models; clear any left from a previous schedule.
                    if (em.HasBuffer<TP_BandModel>(line)) em.GetBuffer<TP_BandModel>(line).Clear();
                    var schedule = em.GetComponentData<TP_LineSchedule>(line);
                    schedule.m_Flags |= LineScheduleFlags.Enabled;
                    em.SetComponentData(line, schedule);
                    changed = true;
                }
            }

            // Plain component writes before the structural ones below (which invalidate buffers).
            // Service hours and the rule's Off bands are one set of closed periods, written together
            // (two separate writes would each undo the other on every tick of an Always rule).
            if (rule.serviceHours != null || ruleOff.Count > 0) changed |= SetClosed(line, rule.serviceHours, ruleOff);
            if (rule.options != null) changed |= ApplyOptions(line, rule.options);
            if (rule.timetable != null) changed |= ApplyTimetable(line, rule.timetable);
            return changed;
        }

        /// <summary>
        /// Service hours as closed periods: the window's outside (before the start, after the end,
        /// or the middle when it runs past midnight), or none for "all day". Also retires the
        /// line's old single window. Writes only when the periods differ.
        /// </summary>
        private bool ApplyServiceHours(Entity line, RuleServiceHours h) {
            var em  = EntityManager;
            var day = (uint)TimeSystem.kTicksPerDay;
            var want = new List<(uint start, uint end)>();
            if (h.on) {
                var probe = new TP_LineSchedule { m_Flags = LineScheduleFlags.ServiceHours, m_ServiceStart = h.start % day, m_ServiceEnd = h.end % day };
                want = ClosedHours.FromWindow(probe);
            }

            var changed = false;
            var s = em.GetComponentData<TP_LineSchedule>(line);
            if ((s.m_Flags & LineScheduleFlags.ServiceHours) != 0) {
                s.m_Flags &= ~LineScheduleFlags.ServiceHours;
                em.SetComponentData(line, s);
                changed = true;
            }

            var has = em.HasBuffer<TP_ClosedPeriod>(line);
            if (!has && want.Count == 0) return changed;
            var buffer = has ? em.GetBuffer<TP_ClosedPeriod>(line) : em.AddBuffer<TP_ClosedPeriod>(line);
            var same = buffer.Length == want.Count;
            for (var i = 0; same && i < want.Count; i++) same = buffer[i].m_Start == want[i].start && buffer[i].m_End == want[i].end;
            if (same) return changed;
            buffer.Clear();
            foreach (var (a, b) in want) buffer.Add(new TP_ClosedPeriod { m_Start = a, m_End = b });
            return true;
        }

        /// <summary>
        /// The line's closed periods from a rule: its service hours (the window's outside; null
        /// keeps the line's current periods) plus its Off bands (a band past midnight is two
        /// periods), merged. Retires the old single window. Writes only when the result differs.
        /// </summary>
        private bool SetClosed(Entity line, RuleServiceHours hours, List<BandDto> off) {
            var em  = EntityManager;
            var day = (uint)TimeSystem.kTicksPerDay;
            var sched0 = em.GetComponentData<TP_LineSchedule>(line);
            var before = new List<(uint start, uint end)>();
            if (em.HasBuffer<TP_ClosedPeriod>(line)) foreach (var c in em.GetBuffer<TP_ClosedPeriod>(line, true)) before.Add((c.m_Start, c.m_End));
            else before.AddRange(ClosedHours.FromWindow(sched0));
            var list = hours == null ? new List<(uint start, uint end)>(before)
                : hours.on ? ClosedHours.FromWindow(new TP_LineSchedule { m_Flags = LineScheduleFlags.ServiceHours, m_ServiceStart = hours.start % day, m_ServiceEnd = hours.end % day })
                : new List<(uint start, uint end)>();
            foreach (var b in off) {
                var s0 = b.start % day;
                var e0 = b.end == day ? day : b.end % day;
                if (s0 < e0) list.Add((s0, e0));
                else { list.Add((s0, day)); if (e0 > 0) list.Add((0, e0)); }
            }
            list.Sort((a, c) => a.start.CompareTo(c.start));
            var merged = new List<(uint start, uint end)>();
            foreach (var (a, c) in list) {
                if (c <= a) continue;
                if (merged.Count > 0 && a <= merged[merged.Count - 1].end) {
                    var last = merged[merged.Count - 1];
                    merged[merged.Count - 1] = (last.start, Math.Max(last.end, c));
                } else merged.Add((a, c));
            }
            var same = merged.Count == before.Count && em.HasBuffer<TP_ClosedPeriod>(line) && (sched0.m_Flags & LineScheduleFlags.ServiceHours) == 0;
            for (var i = 0; same && i < merged.Count; i++) same = merged[i].Equals(before[i]);
            if (same) return false;

            var sched = em.GetComponentData<TP_LineSchedule>(line);
            sched.m_Flags &= ~LineScheduleFlags.ServiceHours;
            em.SetComponentData(line, sched);
            var buffer = em.HasBuffer<TP_ClosedPeriod>(line) ? em.GetBuffer<TP_ClosedPeriod>(line) : em.AddBuffer<TP_ClosedPeriod>(line);
            buffer.Clear();
            foreach (var (a, c) in merged) buffer.Add(new TP_ClosedPeriod { m_Start = a, m_End = c });
            return true;
        }

        private bool ApplyOptions(Entity line, RuleOptions o) {
            var em = EntityManager;
            var changed = false;

            if (o.unbunching.HasValue) {
                var s = em.GetComponentData<TP_LineSchedule>(line);
                var want = o.unbunching.Value >= 0f;
                var has  = (s.m_Flags & LineScheduleFlags.OverrideUnbunching) != 0;
                if (want != has || (want && Math.Abs(s.m_UnbunchingFactor - o.unbunching.Value) > 1e-4f)) {
                    if (want) { s.m_Flags |= LineScheduleFlags.OverrideUnbunching; s.m_UnbunchingFactor = o.unbunching.Value; }
                    else s.m_Flags &= ~LineScheduleFlags.OverrideUnbunching;
                    em.SetComponentData(line, s);
                    changed = true;
                }
            }

            // Policies go through the vanilla panel's path, and only when the option differs.
            if (o.paidTicket.HasValue) changed |= SetOption(line, RouteOption.PaidTicket, o.paidTicket.Value);
            if (o.routeSchedule.HasValue) {
                var r = o.routeSchedule.Value;
                changed |= SetOption(line, RouteOption.Day, r == 0);
                changed |= SetOption(line, RouteOption.Night, r == 1);
            }

            if (o.fareMode.HasValue) {
                if ((FareMode)o.fareMode.Value == FareMode.Distance) {
                    var rule = new TP_FareRule { m_Mode = FareMode.Distance, m_Base = Math.Max(0, o.fareBase), m_PerKm = Math.Max(0f, o.farePerKm) };
                    if (!em.HasComponent<TP_FareRule>(line)) { em.AddComponentData(line, rule); changed = true; }
                    else {
                        var cur = em.GetComponentData<TP_FareRule>(line);
                        if (cur.m_Mode != rule.m_Mode || cur.m_Base != rule.m_Base || Math.Abs(cur.m_PerKm - rule.m_PerKm) > 1e-4f) { em.SetComponentData(line, rule); changed = true; }
                    }
                } else if (em.HasComponent<TP_FareRule>(line)) {
                    em.RemoveComponent<TP_FareRule>(line);
                    changed = true;
                }
            }
            return changed;
        }

        private bool SetOption(Entity line, RouteOption option, bool active) {
            if (RouteUtils.CheckOption(EntityManager.GetComponentData<Route>(line), option) == active) return false;
            var policy = RoutePolicies.Find(EntityManager, m_RouteOptionPolicyQuery, option);
            if (policy == Entity.Null) return false;
            m_Policies.SetPolicy(line, policy, active);
            return true;
        }

        /// <summary>Sets or removes the timetable, anchored at the line's first stop; keeps the slot memory when the grid is unchanged.</summary>
        private bool ApplyTimetable(Entity line, RuleTimetable t) {
            var em = EntityManager;
            if (!t.on) {
                if (!em.HasComponent<TP_Timetable>(line)) return false;
                em.RemoveComponent<TP_Timetable>(line);
                if (em.HasBuffer<TP_TimingPoint>(line)) em.RemoveComponent<TP_TimingPoint>(line);
                return true;
            }

            var waypoints = em.GetBuffer<RouteWaypoint>(line, true);
            var stops = new List<int>();
            for (var i = 0; i < waypoints.Length; i++) {
                var wp = waypoints[i].m_Waypoint;
                if (em.HasComponent<Connected>(wp) && em.GetComponentData<Connected>(wp).m_Connected != Entity.Null) stops.Add(i);
            }
            if (stops.Count == 0) return false;

            var flags = TimetableFlags.None;
            if (t.followBands) flags |= TimetableFlags.FollowBands;
            if (t.leaveIfLate) flags |= TimetableFlags.LeaveIfLate;
            var want = new TP_Timetable {
                m_StopIndex = stops[0], m_First = t.first % (uint)TimeSystem.kTicksPerDay, m_Interval = Math.Max(60u, t.interval),
                m_Flags = flags, m_LateTolerance = t.lateTolerance, m_Resync = 2, m_Slack = Math.Max(0f, t.slack),
            };
            // All-stops offsets from the legs, anchored at the first stop.
            var points = new List<TP_TimingPoint>();
            if (t.allStops) {
                var segments = em.GetBuffer<RouteSegment>(line, true);
                var n = segments.Length;
                var offsets = new float[n];
                var acc = 0f;
                for (var k = 1; k < n; k++) {
                    var seg = segments[(stops[0] + k - 1) % n].m_Segment;
                    var achieved = em.HasComponent<RouteInfo>(seg) ? em.GetComponentData<RouteInfo>(seg).m_Duration : 0f;
                    var planned  = em.HasComponent<PathInformation>(seg) ? em.GetComponentData<PathInformation>(seg).m_Duration : 0f;
                    acc += (achieved > 0f ? achieved : planned) * 60f;
                    offsets[(stops[0] + k) % n] = acc * (1f + want.m_Slack);
                }
                for (var i = 1; i < stops.Count; i++) points.Add(new TP_TimingPoint { m_Waypoint = stops[i], m_Offset = (uint)offsets[stops[i]] });
            }

            var changed = false;
            if (em.HasComponent<TP_Timetable>(line)) {
                var cur = em.GetComponentData<TP_Timetable>(line);
                var sameGrid = cur.m_StopIndex == want.m_StopIndex && cur.m_First == want.m_First && cur.m_Interval == want.m_Interval
                            && (cur.m_Flags & ~TimetableFlags.List) == want.m_Flags && cur.m_LateTolerance == want.m_LateTolerance
                            && Math.Abs(cur.m_Slack - want.m_Slack) < 1e-4f && (cur.m_Flags & TimetableFlags.List) == 0;
                if (!sameGrid) {
                    want.m_LastSlot = 0;
                    em.SetComponentData(line, want);
                    changed = true;
                }
            } else {
                em.AddComponentData(line, want);
                changed = true;
            }

            // Timing points: compared by stop set only — offsets drift with measured leg times,
            // and rewriting them every tick would flap.
            var buf = em.HasBuffer<TP_TimingPoint>(line) ? em.GetBuffer<TP_TimingPoint>(line) : em.AddBuffer<TP_TimingPoint>(line);
            var same = buf.Length == points.Count;
            for (var i = 0; same && i < points.Count; i++) same = buf[i].m_Waypoint == points[i].m_Waypoint;
            if (!same) {
                buf.Clear();
                foreach (var p in points) buf.Add(p);
                changed = true;
            }
            return changed;
        }

        /// <summary>The line's display name: the custom name, or the prefab's name and route number.</summary>
        private string LineName(Entity line) {
            if (m_Names.TryGetCustomName(line, out var custom)) return custom;
            var name = m_Names.GetRenderedLabelName(line) ?? "";
            if (EntityManager.HasComponent<RouteNumber>(line)) name += " " + EntityManager.GetComponentData<RouteNumber>(line).m_Number;
            return name;
        }

        private bool LoadAt(Entity line, int hour, out float load) {
            load = 0f;
            if (!EntityManager.HasBuffer<TP_LoadSample>(line)) return false;
            var hist = EntityManager.GetBuffer<TP_LoadSample>(line, true);
            if (hour < 0 || hour >= hist.Length || hist[hour].m_Samples == 0) return false;
            load = hist[hour].m_Load;
            return true;
        }

        private void Summarise(Entity line, out float peak, out float low, out float wait, out int sampled) {
            peak = 0f; low = float.MaxValue; wait = 0f; sampled = 0;
            if (!EntityManager.HasBuffer<TP_LoadSample>(line)) { low = 0f; return; }
            foreach (var h in EntityManager.GetBuffer<TP_LoadSample>(line, true)) {
                if (h.m_Samples == 0) continue;
                sampled++;
                if (h.m_Load > peak) peak = h.m_Load;
                if (h.m_Load < low) low = h.m_Load;
                if (h.m_Wait > wait) wait = h.m_Wait;
            }
            if (sampled == 0) low = 0f;
        }

        /// <summary>Hours of punctuality data on a timetabled line, with its mean on-time share and lateness (simulation seconds).</summary>
        private int Punctuality(Entity line, out float onTime, out float late) {
            onTime = 1f; late = 0f;
            if (!EntityManager.HasComponent<TP_Timetable>(line) || !EntityManager.HasBuffer<TP_Punctuality>(line)) return 0;
            TimetableMath.Summarise(EntityManager.GetBuffer<TP_Punctuality>(line, true), out onTime, out late, out var hours);
            return hours;
        }

        /// <summary>Every pickable transport vehicle prefab by its prefab name.</summary>
        private Dictionary<string, Entity> PrefabsByName() {
            var map = new Dictionary<string, Entity>();
            var prefabs = m_VehiclePrefabQuery.ToEntityArray(Allocator.Temp);
            foreach (var p in prefabs) {
                var name = m_Prefabs.GetPrefabName(p);
                if (!string.IsNullOrEmpty(name)) map[name] = p;
            }
            prefabs.Dispose();
            return map;
        }

        private List<Entity> Resolve(List<string> names, Dictionary<string, Entity> prefabs) {
            var list = new List<Entity>(names.Count);
            foreach (var n in names) {
                if (prefabs.TryGetValue(n, out var e)) list.Add(e);
                else m_Log.Warn($"Rule names a vehicle prefab this save does not have: {n}");
            }
            return list;
        }

        private static Entity At(List<Entity> list, int i) => i < list.Count ? list[i] : Entity.Null;

        private static bool SameModels(DynamicBuffer<VehicleModel> buffer, List<Entity> primary, List<Entity> secondary) {
            var n = Math.Max(primary.Count, secondary.Count);
            if (buffer.Length != n) return false;
            for (var i = 0; i < n; i++) if (buffer[i].m_PrimaryPrefab != At(primary, i) || buffer[i].m_SecondaryPrefab != At(secondary, i)) return false;
            return true;
        }

        private static bool SameModels(DynamicBuffer<TP_BaselineModel> buffer, List<Entity> primary, List<Entity> secondary) {
            var n = Math.Max(primary.Count, secondary.Count);
            if (buffer.Length != n) return false;
            for (var i = 0; i < n; i++) if (buffer[i].m_Primary != At(primary, i) || buffer[i].m_Secondary != At(secondary, i)) return false;
            return true;
        }

        private static bool SameBands(DynamicBuffer<TP_ScheduleBand> bands, List<BandDto> wanted) {
            if (bands.Length != wanted.Count) return false;
            for (var i = 0; i < wanted.Count; i++) {
                var a = bands[i]; var b = wanted[i];
                if (a.m_Start != b.start || a.m_End != b.end || (int)a.m_Mode != b.mode || a.m_Headway != b.headway || a.m_Fleet != b.fleet || a.m_Fare != b.fare) return false;
            }
            return true;
        }
    }
}
