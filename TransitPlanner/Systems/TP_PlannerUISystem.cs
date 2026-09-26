namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Pathfind;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Simulation;
    using Game.Tools;
    using Game.UI;
    using Game.UI.InGame;

    using Unity.Collections;
    using Unity.Entities;
    using Unity.Mathematics;

    using ModsCommon.Extensions;
    using ModsCommon.Systems;

    using TransitPlanner.Components;
    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// The planner panel's data: the line list, the selected line's schedule (both ways) and the
    /// numbers the game measures about it but never shows.
    /// </summary>
    /// <remarks>
    /// Getter bindings re-read each UI frame. The reads are component lookups on a few hundred
    /// entities at most, and the game's own transport overview does the same every frame, so
    /// nothing is cached. Runs on the main thread because the selection and the command buffer
    /// both live there.
    ///
    /// Schedule writes go straight to the entity's buffer from the trigger: it is a main-thread
    /// structural-free write on a live entity, and the apply system picks it up on its next tick.
    /// </remarks>
    public partial class TP_PlannerUISystem : CommonUISystemBase {
        /// <inheritdoc/>
        protected override string ModId => Mod.Instance.Id;

        private NameSystem           m_Names;
        private SelectedInfoUISystem m_SelectedInfo;
        private TimeSystem           m_Time;
        private TP_RulesSystem       m_Rules;
        private EntityQuery          m_LineQuery;

        private PoliciesUISystem     m_Policies;
        private EntityQuery          m_RouteOptionPolicyQuery;

        private ValueBindingHelper<bool>   m_Visible;
        private ValueBindingHelper<Entity> m_Selected;

        /// <inheritdoc/>
        protected override void OnCreate() {
            base.OnCreate();
            m_Names        = World.GetOrCreateSystemManaged<NameSystem>();
            m_SelectedInfo = World.GetOrCreateSystemManaged<SelectedInfoUISystem>();
            m_Time         = World.GetOrCreateSystemManaged<TimeSystem>();
            m_Rules        = World.GetOrCreateSystemManaged<TP_RulesSystem>();
            m_Policies     = World.GetOrCreateSystemManaged<PoliciesUISystem>();

            // The line policies that set a RouteOption bit; the PaidTicket one is picked by mask.
            m_RouteOptionPolicyQuery = SystemAPI.QueryBuilder()
                                                .WithAll<PolicyData, RouteOptionData>()
                                                .Build();

            m_LineQuery = SystemAPI.QueryBuilder()
                                   .WithAll<Route, TransportLine, PrefabRef>()
                                   .WithNone<Temp, Deleted>()
                                   .Build();

            m_Visible  = CreateGenericBinding("visible", false, null);
            m_Selected = CreateGenericBinding("selected", Entity.Null, null);

            CreateBinding("timeOfDay", () => (int)(math.frac(m_Time.normalizedTime) * TimeSystem.kTicksPerDay));
            CreateBinding("lines", ReadLines);
            CreateBinding("schedule", ReadSchedule);
            CreateBinding("stats", ReadStats);
            CreateBinding("lineMap", ReadLineMap);

            CreateTrigger<ScheduleDto>("setSchedule", WriteSchedule);

            // Rules travel as JSON both ways: the UI edits the whole set and hands it back.
            CreateBinding("rules", () => m_Rules.RulesJson);
            CreateTrigger<string>("setRules", json => {
                var setting = (Setting)Mod.Instance.Settings;
                setting.RulesJson = json ?? "";
                setting.ApplyAndSave();
                m_Log.Debug($"setRules: {json?.Length ?? 0} chars");
            });
            CreateTrigger("applyRules", () => m_Rules.RequestApplyAll());

            // The player's own presets: JSON both ways, like the rules, kept in the settings file.
            CreateBinding("presets", () => ((Setting)Mod.Instance.Settings).PresetsJson ?? "");
            CreateTrigger<string>("setPresets", json => {
                var setting = (Setting)Mod.Instance.Settings;
                setting.PresetsJson = json ?? "";
                setting.ApplyAndSave();
                m_Log.Debug($"setPresets: {json?.Length ?? 0} chars");
            });
            CreateVariantBindings();
            CreateTimetableBindings();
            CreateNetworkPlusBindings();
            CreateCargoBindings();
            CreateDepotBindings();
            CreateBoardBindings();
            CreateFollowBindings();
            CreateNetworkBindings();
            CreateRoadBindings();
            CreateGroundBindings();
            CreateTerrainBindings();
            CreateInfoviewStatsBindings();
            CreateTrigger("selectFromPanel", () => {
                var line = ResolveLine(m_SelectedInfo.selectedEntity, m_Selected.Value);
                if (line != Entity.Null) m_Selected.Value = line;
            });
        }

        /// <inheritdoc/>
        protected override void OnUpdate() {
            base.OnUpdate();
            FollowWorldSelection();
            ApplyExpressBands();
        }

        #region Reads

        private LineRow[] ReadLines() {
            var em       = EntityManager;
            var entities = m_LineQuery.ToEntityArray(Allocator.Temp);
            var rows     = new List<LineRow>(entities.Length);

            foreach (var line in entities) {
                var prefab = em.GetComponentData<PrefabRef>(line).m_Prefab;
                if (!em.HasComponent<TransportLineData>(prefab)) continue;

                var lineData = em.GetComponentData<TransportLineData>(prefab);
                var tl       = em.GetComponentData<TransportLine>(line);
                var riders   = 0;
                var capacity = 0;
                var fleet    = TransportUIUtils.GetRouteVehiclesCount(em, line, ref riders, ref capacity);

                var row = new LineRow {
                    entity            = line,
                    name              = m_Names.GetName(line),
                    color             = em.HasComponent<Color>(line) ? (UnityEngine.Color)em.GetComponentData<Color>(line).m_Color : UnityEngine.Color.white,
                    type              = (int)lineData.m_TransportType,
                    cargo             = lineData.m_CargoTransport && !lineData.m_PassengerTransport,
                    fleet             = fleet,
                    target            = TargetFleet(line, lineData),
                    riders            = riders,
                    capacity          = capacity,
                    headway           = tl.m_VehicleInterval,
                    notEnoughVehicles = (tl.m_Flags & TransportLineFlags.NotEnoughVehicles) != 0,
                    scheduled         = em.HasComponent<TP_LineSchedule>(line) && em.GetComponentData<TP_LineSchedule>(line).Enabled,
                    ttOnTime          = -1f,
                    closedPeriods     = em.HasBuffer<TP_ClosedPeriod>(line) ? em.GetBuffer<TP_ClosedPeriod>(line, true).Length : 0,
                    template          = em.HasComponent<TP_BoardLink>(line) ? em.GetComponentData<TP_BoardLink>(line).m_Template.ToString() : "",
                };
                if (em.HasComponent<TP_Timetable>(line)) FillTimetable(line, ref row);
                rows.Add(row);
            }

            entities.Dispose();
            return rows.ToArray();
        }

        /// <summary>The Timetable tab's per-line summary: grid, anchor stop, timing points, punctuality.</summary>
        private void FillTimetable(Entity line, ref LineRow row) {
            var em = EntityManager;
            var tt = em.GetComponentData<TP_Timetable>(line);
            row.timetable      = true;
            row.ttFlags        = (int)tt.m_Flags;
            row.ttFirst        = tt.m_First;
            row.ttInterval     = tt.m_Interval;
            row.ttDepartures   = em.HasBuffer<TP_TimetableDeparture>(line) ? em.GetBuffer<TP_TimetableDeparture>(line, true).Length : 0;
            row.ttTimingPoints = em.HasBuffer<TP_TimingPoint>(line) ? em.GetBuffer<TP_TimingPoint>(line, true).Length : 0;
            var waypoints = em.GetBuffer<RouteWaypoint>(line, true);
            if (tt.m_StopIndex >= 0 && tt.m_StopIndex < waypoints.Length) {
                var wp = waypoints[tt.m_StopIndex].m_Waypoint;
                if (em.HasComponent<Connected>(wp)) row.ttAnchor = m_Names.GetName(em.GetComponentData<Connected>(wp).m_Connected);
            }
            if (em.HasBuffer<TP_Punctuality>(line)) {
                TimetableMath.Summarise(em.GetBuffer<TP_Punctuality>(line, true), out row.ttOnTime, out row.ttLate, out _);
            }
        }

        private ScheduleDto ReadSchedule() => ReadScheduleOf(m_Selected.Value);

        /// <summary>A line's whole schedule as the UI edits it (the planner's line, or a Schedule board row).</summary>
        private ScheduleDto ReadScheduleOf(Entity line) {
            var em   = EntityManager;
            var dto  = new ScheduleDto { entity = line };
            if (!IsLine(line) || !em.HasComponent<TP_LineSchedule>(line) || !em.HasBuffer<TP_ScheduleBand>(line)) {
                return dto;
            }

            var schedule = em.GetComponentData<TP_LineSchedule>(line);
            var bands    = em.GetBuffer<TP_ScheduleBand>(line, true);

            dto.enabled            = schedule.Enabled;
            dto.overrideUnbunching = (schedule.m_Flags & LineScheduleFlags.OverrideUnbunching) != 0;
            dto.unbunching         = schedule.m_UnbunchingFactor;
            if (em.HasBuffer<TP_ClosedPeriod>(line) && em.GetBuffer<TP_ClosedPeriod>(line, true).Length > 0) {
                var closed = em.GetBuffer<TP_ClosedPeriod>(line, true);
                dto.closed = new ClosedDto[closed.Length];
                for (var i = 0; i < closed.Length; i++) dto.closed[i] = new ClosedDto { start = closed[i].m_Start, end = closed[i].m_End };
            } else {
                // An old single service window, shown as its closed periods; the next write converts it.
                dto.closed = ClosedHours.FromWindow(schedule).ConvertAll(p => new ClosedDto { start = p.start, end = p.end }).ToArray();
            }
            if (em.HasComponent<TP_FareRule>(line)) {
                var rule = em.GetComponentData<TP_FareRule>(line);
                dto.fareMode  = (int)rule.m_Mode;
                dto.fareBase  = rule.m_Base;
                dto.farePerKm = rule.m_PerKm;
            }
            if (em.HasComponent<TP_Timetable>(line)) {
                var tt = em.GetComponentData<TP_Timetable>(line);
                dto.timetable         = true;
                dto.timetableStop     = tt.m_StopIndex;
                dto.timetableFirst    = tt.m_First;
                dto.timetableInterval = tt.m_Interval;
                dto.timetableFlags    = (int)tt.m_Flags;
                dto.timetableLateTolerance = tt.m_LateTolerance;
                dto.timetableResync   = tt.m_Resync == 0 ? 2 : tt.m_Resync;
                dto.timetableSlack    = tt.m_Slack;
            }
            if (em.HasBuffer<TP_TimetableDeparture>(line)) {
                var list = em.GetBuffer<TP_TimetableDeparture>(line, true);
                dto.timetableDepartures = new uint[list.Length];
                for (var i = 0; i < list.Length; i++) dto.timetableDepartures[i] = list[i].m_Frame;
            }
            if (em.HasBuffer<TP_TimingPoint>(line)) {
                var points = em.GetBuffer<TP_TimingPoint>(line, true);
                dto.timingPoints = new TimingPointDto[points.Length];
                for (var i = 0; i < points.Length; i++) dto.timingPoints[i] = new TimingPointDto { waypoint = points[i].m_Waypoint, offset = points[i].m_Offset };
            }
            dto.autoFleet          = schedule.m_AutoFleet;
            if (em.HasComponent<TP_BoardLink>(line)) {
                var link = em.GetComponentData<TP_BoardLink>(line);
                dto.template = link.m_Template.ToString();
                dto.group    = link.m_Group.ToString();
                dto.order    = link.m_Order;
            } else {
                dto.template = "";
                dto.group    = "";
            }
            dto.plans = PlanNames(line, out dto.plan);
            if (em.HasBuffer<TP_LoadWait>(line)) {
                var waits = em.GetBuffer<TP_LoadWait>(line, true);
                dto.loadWaits = new LoadWaitDto[waits.Length];
                for (var i = 0; i < waits.Length; i++) dto.loadWaits[i] = new LoadWaitDto { waypoint = waits[i].m_Waypoint, minLoad = waits[i].m_MinLoad, maxWait = waits[i].m_MaxWait, minWait = waits[i].m_MinWait };
            }
            if (em.HasBuffer<TP_SkipStop>(line)) {
                var skips = em.GetBuffer<TP_SkipStop>(line, true);
                dto.skipStops = new SkipStopDto[skips.Length];
                for (var i = 0; i < skips.Length; i++) dto.skipStops[i] = new SkipStopDto { waypoint = skips[i].m_Waypoint, start = skips[i].m_Start, end = skips[i].m_End };
            }
            dto.bands              = new BandDto[bands.Length];
            var models = em.HasBuffer<TP_BandModel>(line) ? em.GetBuffer<TP_BandModel>(line, true) : default;
            for (var i = 0; i < bands.Length; i++) {
                var b = bands[i];
                var primary   = new List<Entity>();
                var secondary = new List<Entity>();
                if (models.IsCreated) {
                    foreach (var m in models) {
                        if (m.m_Band != i) continue;
                        if (m.m_Primary   != Entity.Null) primary.Add(m.m_Primary);
                        if (m.m_Secondary != Entity.Null) secondary.Add(m.m_Secondary);
                    }
                }
                dto.bands[i] = new BandDto {
                    start = b.m_Start, end = b.m_End, mode = (int)b.m_Mode,
                    headway = b.m_Headway, fleet = b.m_Fleet, fare = b.m_Fare,
                    loadMin = b.m_LoadMin, loadMax = b.m_LoadMax, value = b.m_Value, line = b.m_Line,
                    primary = primary.ToArray(), secondary = secondary.ToArray(),
                };
            }
            return dto;
        }

        private LineStats ReadStats() {
            var em    = EntityManager;
            var line  = m_Selected.Value;
            var stats = new LineStats { entity = line };
            if (!IsLine(line)) return stats;

            var prefab = em.GetComponentData<PrefabRef>(line).m_Prefab;
            if (!em.HasComponent<TransportLineData>(prefab)) return stats;

            var lineData = em.GetComponentData<TransportLineData>(prefab);
            var tl       = em.GetComponentData<TransportLine>(line);
            var route    = em.GetComponentData<Route>(line);
            var riders   = 0;
            var capacity = 0;
            var stable   = StableDuration(line, lineData);

            stats.valid             = true;
            stats.defaultHeadway    = lineData.m_DefaultVehicleInterval;
            stats.headway           = tl.m_VehicleInterval;
            stats.stableDuration    = stable;
            stats.fleet             = TransportUIUtils.GetRouteVehiclesCount(em, line, ref riders, ref capacity);
            stats.target            = TargetFleet(line, lineData);
            stats.riders            = riders;
            stats.capacity          = capacity;
            stats.unbunching        = tl.m_UnbunchingFactor;
            stats.notEnoughVehicles = (tl.m_Flags & TransportLineFlags.NotEnoughVehicles) != 0;
            stats.paidTicket        = RouteUtils.CheckOption(route, RouteOption.PaidTicket);
            stats.ticketPrice       = tl.m_TicketPrice;

            // Stops: the queue figures (WaitingPassengers) sit on the WAYPOINT; Connected only
            // names the stop entity it serves (vanilla's LineVisualizerSection reads it the same
            // way). Waypoints that are just path corners have no Connected and are skipped.
            var waypoints = em.GetBuffer<RouteWaypoint>(line, true);
            var stops     = new List<StopStat>(waypoints.Length);
            var canSkip   = SkipStops.LineCanSkip(em, line);
            for (var i = 0; i < waypoints.Length; i++) {
                var wp = waypoints[i].m_Waypoint;
                if (!em.HasComponent<WaitingPassengers>(wp)) continue;
                // A stop an express skip has detached is still this line's stop (StopOf).
                var stop = SkipStops.StopOf(em, wp);
                if (stop == Entity.Null) continue;
                var waiting = em.GetComponentData<WaitingPassengers>(wp);
                stops.Add(new StopStat {
                    stop        = stop,
                    waypoint    = i,
                    name        = m_Names.GetName(stop),
                    waiting     = waiting.m_Count,
                    averageWait = waiting.m_AverageWaitingTime,
                    skippable   = canSkip && SkipStops.StopCanBeSkipped(em, wp),
                    skippedNow  = em.HasComponent<TP_SkippedNow>(wp),
                });
            }
            stats.stops = stops.ToArray();

            // Legs: PathInformation is the pathfinder's plan, RouteInfo the plan scaled by what
            // vehicles actually took (TransportLineSystem.RefreshLineSegments).
            var segments = em.GetBuffer<RouteSegment>(line, true);
            var legs     = new LegStat[segments.Length];
            for (var i = 0; i < segments.Length; i++) {
                var seg = segments[i].m_Segment;
                legs[i] = new LegStat {
                    planned  = em.HasComponent<PathInformation>(seg) ? em.GetComponentData<PathInformation>(seg).m_Duration : 0f,
                    achieved = em.HasComponent<RouteInfo>(seg) ? em.GetComponentData<RouteInfo>(seg).m_Duration : 0f,
                };
            }
            stats.legs = legs;

            if (em.HasBuffer<TP_LoadSample>(line)) {
                var hist = em.GetBuffer<TP_LoadSample>(line, true);
                var hours = new HourSample[hist.Length];
                for (var i = 0; i < hist.Length; i++) {
                    hours[i] = new HourSample { load = hist[i].m_Load, waiting = hist[i].m_Waiting, wait = hist[i].m_Wait, fleet = hist[i].m_Fleet, empty = hist[i].m_Empty, samples = hist[i].m_Samples };
                }
                stats.history = hours;
            }
            if (em.HasBuffer<TP_Punctuality>(line)) {
                var punct = em.GetBuffer<TP_Punctuality>(line, true);
                stats.punctuality = new PunctualitySample[punct.Length];
                for (var i = 0; i < punct.Length; i++) {
                    stats.punctuality[i] = new PunctualitySample { late = punct[i].m_Late, onTime = punct[i].m_OnTime, samples = punct[i].m_Samples };
                }
            }

            return stats;
        }

        #endregion

        #region Writes

        private void WriteSchedule(ScheduleDto dto) {
            var em   = EntityManager;
            var line = dto.entity;
            if (!IsLine(line)) {
                m_Log.Warn($"setSchedule for {line}: not a transport line");
                return;
            }
            if (!em.HasComponent<TP_LineSchedule>(line) || !em.HasBuffer<TP_ScheduleBand>(line)) {
                // The init system attaches these within 64 frames of a line existing; a write
                // before that would need a structural change here. Tell the UI to retry instead.
                m_Log.Warn($"setSchedule for {line}: schedule components not attached yet");
                return;
            }

            // Schedule tab links (template / group); null = leave as is. Structural, so first,
            // before any buffer below is taken.
            WriteBoardLink(line, dto.template, dto.group);

            var schedule = em.GetComponentData<TP_LineSchedule>(line);

            // Band indices are about to change: hand the line its own models back first, and let
            // the apply system re-take them on its next tick from the new bands.
            if (schedule.m_AppliedModelBand >= 0 && em.HasBuffer<TP_BaselineModel>(line)) {
                var vm = em.GetBuffer<VehicleModel>(line);
                var bl = em.GetBuffer<TP_BaselineModel>(line);
                vm.Clear();
                foreach (var b in bl) vm.Add(new VehicleModel { m_PrimaryPrefab = b.m_Primary, m_SecondaryPrefab = b.m_Secondary });
                bl.Clear();
                schedule.m_AppliedModelBand = -1;
            }

            // Keep the bookkeeping bits (RulesSeen, InactiveByBand); only the player's choices are replaced.
            schedule.m_Flags &= LineScheduleFlags.RulesSeen | LineScheduleFlags.InactiveByBand | LineScheduleFlags.ShortByBand;
            if (dto.enabled)            schedule.m_Flags |= LineScheduleFlags.Enabled;
            // The old single window is retired on write: the closed periods below replace it.
            schedule.m_ServiceStart = 0;
            schedule.m_ServiceEnd   = 0;
            if (dto.overrideUnbunching) schedule.m_Flags |= LineScheduleFlags.OverrideUnbunching;
            schedule.m_UnbunchingFactor = dto.unbunching;
            em.SetComponentData(line, schedule);

            // Distance fares live in their own component so the boarding patch can look them up
            // by route; absent means flat (vanilla / band fare). Structural, but on the main thread.
            if ((FareMode)dto.fareMode == FareMode.Distance) {
                var rule = new TP_FareRule { m_Mode = FareMode.Distance, m_Base = System.Math.Max(0, dto.fareBase), m_PerKm = System.Math.Max(0f, dto.farePerKm) };
                if (em.HasComponent<TP_FareRule>(line)) em.SetComponentData(line, rule);
                else em.AddComponentData(line, rule);
            } else if (em.HasComponent<TP_FareRule>(line)) {
                em.RemoveComponent<TP_FareRule>(line);
            }

            WriteTimetable(line, dto);
            WriteClosed(line, dto.closed);
            WriteLoadWaits(line, dto.loadWaits);
            WriteSkipStops(line, dto.skipStops);

            var bands  = em.GetBuffer<TP_ScheduleBand>(line);
            var models = em.HasBuffer<TP_BandModel>(line) ? em.GetBuffer<TP_BandModel>(line) : default;
            bands.Clear();
            if (models.IsCreated) models.Clear();
            var index = 0;
            foreach (var b in dto.bands ?? System.Array.Empty<BandDto>()) {
                bands.Add(new TP_ScheduleBand {
                    m_Start   = b.start,
                    m_End     = b.end,
                    m_Mode    = (BandMode)b.mode,
                    m_Headway = b.headway,
                    m_Fleet   = b.fleet,
                    m_Fare    = b.fare,
                    m_LoadMin = b.loadMin,
                    m_LoadMax = b.loadMax,
                    m_Value   = b.value,
                    m_Line    = b.line,
                });
                if (models.IsCreated) {
                    // Same pairing rule as the fleet manager's setModels: primary[i] with secondary[i].
                    var p = b.primary   ?? System.Array.Empty<Entity>();
                    var q = b.secondary ?? System.Array.Empty<Entity>();
                    for (var i = 0; i < System.Math.Max(p.Length, q.Length); i++) {
                        models.Add(new TP_BandModel {
                            m_Band      = index,
                            m_Primary   = i < p.Length ? p[i] : Entity.Null,
                            m_Secondary = i < q.Length ? q[i] : Entity.Null,
                        });
                    }
                }
                index++;
            }

            // A custom fare only does anything while the line has the Paid ticket policy: vanilla's
            // tick applies the TicketPrice modifier behind RouteOption.PaidTicket. Scheduling a fare
            // is the player asking for paid tickets, so switch the policy on through the same
            // path the vanilla panel uses (a policy event; ModifiedSystem then rebuilds the
            // modifiers, and the apply system re-overrides the fare slot on its next tick).
            if (dto.enabled && HasCustomFare(bands) && !RouteUtils.CheckOption(em.GetComponentData<Route>(line), RouteOption.PaidTicket)) {
                var policy = RoutePolicies.Find(em, m_RouteOptionPolicyQuery, RouteOption.PaidTicket);
                if (policy != Entity.Null) {
                    m_Policies.SetPolicy(line, policy, true);
                    m_Log.Info($"setSchedule for {line}: enabled the Paid ticket policy for a custom fare");
                } else {
                    m_Log.Warn("No policy prefab carries RouteOption.PaidTicket; custom fares will not apply");
                }
            }

            m_Log.Debug($"setSchedule for {line}: enabled={dto.enabled}, {bands.Length} band(s)");
        }

        private static bool HasCustomFare(DynamicBuffer<TP_ScheduleBand> bands) {
            for (var i = 0; i < bands.Length; i++) {
                if (bands[i].m_Mode != BandMode.Default && bands[i].m_Fare >= 0f) return true;
            }
            return false;
        }

        #endregion

        private bool IsLine(Entity e) {
            var em = EntityManager;
            return e != Entity.Null && em.Exists(e)
                && em.HasComponent<Route>(e) && em.HasComponent<TransportLine>(e)
                && em.HasComponent<PrefabRef>(e)
                && em.HasBuffer<RouteWaypoint>(e) && em.HasBuffer<RouteSegment>(e);
        }

        /// <summary>
        /// The fleet vanilla is steering toward: its tick computes it from the prefab default
        /// with the route modifiers applied, against the stable loop duration - NOT from
        /// <c>m_VehicleInterval</c>, which is the resulting spacing (loop / fleet).
        /// </summary>
        private int TargetFleet(Entity line, TransportLineData lineData) {
            var em       = EntityManager;
            var interval = lineData.m_DefaultVehicleInterval;
            if (em.HasBuffer<RouteModifier>(line)) {
                RouteUtils.ApplyModifier(ref interval, em.GetBuffer<RouteModifier>(line, true), RouteModifierType.VehicleInterval);
            }
            return LineMath.FleetFor(interval, StableDuration(line, lineData));
        }

        private float StableDuration(Entity line, TransportLineData lineData) {
            var pathInfo = GetComponentLookup<PathInformation>(true);
            var timing   = GetComponentLookup<VehicleTiming>(true);
            return LineMath.StableDuration(EntityManager.GetBuffer<RouteWaypoint>(line, true),
                                           EntityManager.GetBuffer<RouteSegment>(line, true),
                                           lineData, pathInfo, timing);
        }
    }
}
