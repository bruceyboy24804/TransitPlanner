namespace TransitPlanner.Systems {
    #region Using Statements

    using Game;
    using Game.Common;
    using Game.Pathfind;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Simulation;
    using Game.Tools;
    using Game.UI.InGame;
    using Game.Vehicles;

    using Unity.Collections;
    using Unity.Entities;
    using Unity.Mathematics;

    using ModsCommon.Systems;

    using TransitPlanner.Components;
    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// Turns each line's schedule into the two inputs vanilla's <see cref="TransportLineSystem"/>
    /// reads every 256 frames: the <c>RouteModifier</c> buffer (headway and fare) and
    /// <c>TransportLine.m_UnbunchingFactor</c>.
    /// </summary>
    /// <remarks>
    /// Runs on the same 256-frame cadence, ordered before <see cref="TransportLineSystem"/>, so a
    /// change lands on the tick that reads it. Writing more often is wasted work; writing after it
    /// is a one-tick lag on every change.
    ///
    /// The modifier buffer is shared with the policy system, which rebuilds it whenever a policy on
    /// the line changes (vanilla's vehicle-count slider is such a policy). See
    /// <see cref="TP_LineSchedule"/> for the baseline/written protocol that lets a Default band hand
    /// control back to that slider.
    ///
    /// Main-thread loop rather than a job: there are at most a few hundred lines, the work per line
    /// is trivial, and it runs once per 256 frames.
    /// </remarks>
    public partial class TP_ScheduleApplySystem : CommonGameSystemBase {
        private TimeSystem       m_TimeSystem;
        private SimulationSystem m_Simulation;
        private PoliciesUISystem m_Policies;
        private EntityQuery      m_RouteOptionPolicyQuery;
        private Entity           m_InactivePolicy;

        public override int GetUpdateInterval(SystemUpdatePhase phase) => 256;

        protected override void OnCreate() {
            base.OnCreate();
            m_TimeSystem = World.GetOrCreateSystemManaged<TimeSystem>();
            m_Simulation = World.GetOrCreateSystemManaged<SimulationSystem>();
            m_Policies   = World.GetOrCreateSystemManaged<PoliciesUISystem>();
            m_RouteOptionPolicyQuery = SystemAPI.QueryBuilder().WithAll<PolicyData, RouteOptionData>().Build();
        }

        protected override void OnUpdate() {
            var frameOfDay = (uint)(math.frac(m_TimeSystem.normalizedTime) * TimeSystem.kTicksPerDay);
            var lineData   = SystemAPI.GetComponentLookup<TransportLineData>(true);
            var pathInfo   = SystemAPI.GetComponentLookup<PathInformation>(true);
            var timing     = SystemAPI.GetComponentLookup<VehicleTiming>(true);

            var routeVehicles = SystemAPI.GetBufferLookup<RouteVehicle>(true);
            var layouts       = SystemAPI.GetBufferLookup<LayoutElement>(true);
            var passengers    = SystemAPI.GetBufferLookup<Passenger>(true);
            var prefabRefs    = SystemAPI.GetComponentLookup<PrefabRef>(true);
            var ptVehicleData = SystemAPI.GetComponentLookup<PublicTransportVehicleData>(true);
            var cargoData     = SystemAPI.GetComponentLookup<CargoTransportVehicleData>(true);
            var cargoLoads    = SystemAPI.GetBufferLookup<Game.Economy.Resources>(true);
            var waiting       = SystemAPI.GetComponentLookup<WaitingPassengers>(true);
            var histories     = SystemAPI.GetBufferLookup<TP_LoadSample>();
            var hour          = (int)math.clamp(frameOfDay * 24f / TimeSystem.kTicksPerDay, 0f, 23f);

            if (m_InactivePolicy == Entity.Null) m_InactivePolicy = RoutePolicies.Find(EntityManager, m_RouteOptionPolicyQuery, RouteOption.Inactive);
            var routes = SystemAPI.GetComponentLookup<Route>(true);

            var vehicleModels = SystemAPI.GetBufferLookup<VehicleModel>();
            var bandModels    = SystemAPI.GetBufferLookup<TP_BandModel>(true);
            var baselines     = SystemAPI.GetBufferLookup<TP_BaselineModel>();
            var closedLookup  = SystemAPI.GetBufferLookup<TP_ClosedPeriod>(true);
            // MatchLine reads another line's headway; the loop below holds TransportLine
            // read-write, so every line's current interval is copied out first.
            var lines = new NativeParallelHashMap<Entity, float>(64, Allocator.Temp);
            foreach (var (tl, e) in SystemAPI.Query<RefRO<TransportLine>>().WithNone<Temp, Deleted>().WithEntityAccess()) {
                lines[e] = tl.ValueRO.m_VehicleInterval;
            }

            foreach (var (schedule, line, prefabRef, modifierBuffer, bands, waypoints, segments, entity) in
                     SystemAPI.Query<RefRW<TP_LineSchedule>, RefRW<TransportLine>, RefRO<PrefabRef>,
                                     DynamicBuffer<RouteModifier>, DynamicBuffer<TP_ScheduleBand>,
                                     DynamicBuffer<RouteWaypoint>, DynamicBuffer<RouteSegment>>()
                              .WithAll<Route>()
                              .WithNone<Temp, Deleted>()
                              .WithEntityAccess()) {
                ref var s = ref schedule.ValueRW;
                // Deconstructed foreach variables are readonly; the buffer is a handle, so a copy
                // still writes the same chunk memory.
                var modifiers = modifierBuffer;

                // Measured performance goes into this hour's slot whether or not the schedule is
                // on: the history is what tells the player whether a schedule is needed.
                SampleHistory(entity, hour, waypoints, routeVehicles, layouts, passengers, prefabRefs, ptVehicleData, cargoData, cargoLoads, waiting, histories);

                // ApplyModifier indexes the buffer positionally and ignores a short one, so make
                // sure both slots exist before anything is written into them.
                while (modifiers.Length <= (int)RouteModifierType.VehicleInterval) {
                    modifiers.Add(default);
                }

                // Vanilla-rebuilt values are recognised by not being what we last wrote.
                var current = modifiers[(int)RouteModifierType.VehicleInterval].m_Delta;
                if (!current.Equals(s.m_WrittenInterval)) s.m_VanillaInterval = current;
                current = modifiers[(int)RouteModifierType.TicketPrice].m_Delta;
                if (!current.Equals(s.m_WrittenFare)) s.m_VanillaFare = current;

                // Service hours switch the line off outside its window, bands or not.
                var outOfHours = !ClosedHours.InService(closedLookup.HasBuffer(entity) ? closedLookup[entity] : default, s, frameOfDay);
                if (!s.Enabled || !lineData.HasComponent(prefabRef.ValueRO.m_Prefab)) {
                    if (s.m_AppliedModelBand >= 0) ApplyBandModels(entity, ref s, -1, vehicleModels, bandModels, baselines);
                    ApplyOff(entity, ref s, outOfHours, routes);
                    continue;
                }

                var prefab    = lineData[prefabRef.ValueRO.m_Prefab];
                var bandIndex = FindBand(bands, frameOfDay);
                var band      = bandIndex >= 0 ? bands[bandIndex] : new TP_ScheduleBand { m_Mode = BandMode.Default, m_Fare = -1f };

                ApplyBandModels(entity, ref s, bandIndex, vehicleModels, bandModels, baselines);
                ApplyOff(entity, ref s, band.m_Mode == BandMode.Off || outOfHours, routes);

                // Headway: an absolute delta from the prefab default, relative part zeroed, so the
                // value vanilla computes is exactly the target. Default: give the slider back.
                var interval = s.m_VanillaInterval;
                var target   = -1f; // headway to write, simulation seconds; −1 leaves vanilla's
                if (band.m_Mode != BandMode.Default && band.m_Mode != BandMode.Off) {
                    // Vanilla derives the fleet as round(stableDuration / interval); fleet modes invert it.
                    var stable = LineMath.StableDuration(waypoints, segments, prefab, pathInfo, timing);
                    target = BandMath.FixedHeadway(band, frameOfDay, stable);
                    if (target < 0f) {
                        var fleet = -1;
                        switch (band.m_Mode) {
                            case BandMode.TargetLoad:
                            case BandMode.TargetWait:
                            case BandMode.StationStock:
                            case BandMode.CrowdingCap:
                            case BandMode.DemandFirst:
                                fleet = StepAutoFleet(ref s, band, entity, hour, routeVehicles, histories, waypoints, layouts, passengers, prefabRefs, ptVehicleData, cargoData, cargoLoads);
                                break;
                            case BandMode.FollowDemand:
                                fleet = DemandFleet(band, entity, hour, routeVehicles, histories);
                                break;
                            case BandMode.MatchLine:
                                // The other line's current headway (its tick's output), times the multiplier.
                                if (band.m_Line != Entity.Null && band.m_Line != entity && lines.TryGetValue(band.m_Line, out var other) && other > 0f)
                                    target = other * math.max(0.1f, band.m_Value);
                                break;
                        }
                        if (fleet > 0) target = LineMath.HeadwayFor(fleet, stable);
                    }
                }
                if (target > 0f) interval = new float2(math.max(1f, target) - prefab.m_DefaultVehicleInterval, 0f);

                var fare = band.m_Mode != BandMode.Default && band.m_Fare >= 0f
                    ? new float2(band.m_Fare, 0f)
                    : s.m_VanillaFare;

                modifiers[(int)RouteModifierType.VehicleInterval] = new RouteModifier { m_Delta = interval };
                modifiers[(int)RouteModifierType.TicketPrice]     = new RouteModifier { m_Delta = fare };
                s.m_WrittenInterval = interval;
                s.m_WrittenFare     = fare;

                if ((s.m_Flags & LineScheduleFlags.OverrideUnbunching) != 0) {
                    line.ValueRW.m_UnbunchingFactor = s.m_UnbunchingFactor;
                }
            }
            lines.Dispose();
        }

        // EMA weight per sample: ~43 samples an hour, so a slot settles within the hour and still
        // remembers yesterday enough to show a pattern before today's hour has run.
        private const float kHistoryAlpha = 0.05f;

        /// <summary>Folds the line's current load, queues and waits into the hour's slot.</summary>
        private static void SampleHistory(Entity line, int hour, DynamicBuffer<RouteWaypoint> waypoints,
                                          BufferLookup<RouteVehicle> routeVehicles, BufferLookup<LayoutElement> layouts,
                                          BufferLookup<Passenger> passengers, ComponentLookup<PrefabRef> prefabRefs,
                                          ComponentLookup<PublicTransportVehicleData> ptVehicleData,
                                          ComponentLookup<CargoTransportVehicleData> cargoData, BufferLookup<Game.Economy.Resources> cargoLoads,
                                          ComponentLookup<WaitingPassengers> waiting, BufferLookup<TP_LoadSample> histories) {
            if (!histories.HasBuffer(line)) return;
            var history = histories[line];
            if (history.Length < 24) return;

            var riders = 0;
            var seats  = 0;
            var fleet  = 0;
            var empty  = 0;
            if (routeVehicles.HasBuffer(line)) {
                foreach (var rv in routeVehicles[line]) {
                    var v = rv.m_Vehicle;
                    var before = riders;
                    if (layouts.HasBuffer(v)) {
                        foreach (var car in layouts[v]) Count(car.m_Vehicle, ref riders, ref seats);
                    } else {
                        Count(v, ref riders, ref seats);
                    }
                    fleet++;
                    if (riders == before) empty++;
                }
            }
            var queue = 0f;
            var wait  = 0f;
            var stops = 0;
            for (var i = 0; i < waypoints.Length; i++) {
                if (!waiting.TryGetComponent(waypoints[i].m_Waypoint, out var w)) continue;
                queue += w.m_Count;
                wait  += w.m_AverageWaitingTime;
                stops++;
            }
            if (seats == 0 && stops == 0) return;

            var slot = history[hour];
            var load = seats > 0 ? (float)riders / seats : slot.m_Load;
            var q    = stops > 0 ? queue / stops : slot.m_Waiting;
            var wt   = stops > 0 ? wait / stops : slot.m_Wait;
            var emp  = fleet > 0 ? (float)empty / fleet : 0f;
            if (slot.m_Samples == 0) {
                slot.m_Load = load; slot.m_Waiting = q; slot.m_Wait = wt; slot.m_Fleet = fleet; slot.m_Empty = emp;
            } else {
                slot.m_Load    += (load - slot.m_Load) * kHistoryAlpha;
                slot.m_Waiting += (q - slot.m_Waiting) * kHistoryAlpha;
                slot.m_Wait    += (wt - slot.m_Wait) * kHistoryAlpha;
                slot.m_Fleet   += (fleet - slot.m_Fleet) * kHistoryAlpha;
                slot.m_Empty   += (emp - slot.m_Empty) * kHistoryAlpha;
            }
            if (slot.m_Samples < ushort.MaxValue) slot.m_Samples++;
            history[hour] = slot;

            // Passengers against seats, or — on a cargo line — cargo carried against cargo capacity
            // (the Resources buffer on each car, as vanilla's CargoSection reads it). Before this
            // counted cargo, every cargo line sampled a load of 0.
            void Count(Entity car, ref int r, ref int c) {
                if (car == Entity.Null) return;
                if (passengers.HasBuffer(car)) r += passengers[car].Length;
                if (cargoLoads.HasBuffer(car)) foreach (var res in cargoLoads[car]) r += res.m_Amount;
                if (!prefabRefs.TryGetComponent(car, out var pr)) return;
                if (ptVehicleData.TryGetComponent(pr.m_Prefab, out var d)) c += d.m_PassengerCapacity;
                if (cargoData.TryGetComponent(pr.m_Prefab, out var cd)) c += cd.m_CargoCapacity;
            }
        }

        /// <summary>
        /// Switches the line off or back on for an Off band through the Inactive policy, the
        /// vanilla panel's own path (a policy event; ModifiedSystem rebuilds the modifiers, which
        /// this tick re-applies). Only the mod's own switch-off is undone: a line the player set
        /// inactive stays inactive.
        /// </summary>
        private void ApplyOff(Entity line, ref TP_LineSchedule s, bool off, ComponentLookup<Route> routes) {
            if (m_InactivePolicy == Entity.Null || !routes.HasComponent(line)) return;
            var inactive = RouteUtils.CheckOption(routes[line], RouteOption.Inactive);
            var byBand   = (s.m_Flags & LineScheduleFlags.InactiveByBand) != 0;
            if (off && !inactive) {
                m_Policies.SetPolicy(line, m_InactivePolicy, true);
                s.m_Flags |= LineScheduleFlags.InactiveByBand;
            } else if (!off && byBand) {
                if (inactive) m_Policies.SetPolicy(line, m_InactivePolicy, false);
                s.m_Flags &= ~LineScheduleFlags.InactiveByBand;
            }
        }

        // A game hour in frames: the TargetLoad cool-down, so one change can show in the load
        // before the next is judged.
        private const uint kAutoCooldownFrames = (uint)(TimeSystem.kTicksPerDay / 24);
        private const int  kAutoMaxFleet = 80;

        /// <summary>
        /// TargetLoad: the fleet to run now. Seeded from the running fleet; then, at most once a
        /// game hour, one vehicle more while the hour's smoothed load (the TP_LoadSample EMA the
        /// history shows, so one full or empty trip does not swing it) is above the band's range,
        /// one fewer while it is below. Floors at one (vanilla does too).
        /// </summary>
        /// <remarks>
        /// The same stepping serves every "keep X in a range" mode; only the measurement differs:
        /// TargetLoad the hour's smoothed load, TargetWait the hour's smoothed stop wait (seconds),
        /// CrowdingCap the fullest vehicle right now, StationStock the stations' mean fill.
        /// </remarks>
        private int StepAutoFleet(ref TP_LineSchedule s, TP_ScheduleBand band, Entity line, int hour,
                                  BufferLookup<RouteVehicle> routeVehicles, BufferLookup<TP_LoadSample> histories,
                                  DynamicBuffer<RouteWaypoint> waypoints, BufferLookup<LayoutElement> layouts,
                                  BufferLookup<Passenger> passengers, ComponentLookup<PrefabRef> prefabRefs,
                                  ComponentLookup<PublicTransportVehicleData> ptVehicleData,
                                  ComponentLookup<CargoTransportVehicleData> cargoData, BufferLookup<Game.Economy.Resources> cargoLoads) {
            var running = routeVehicles.HasBuffer(line) ? routeVehicles[line].Length : 1;
            if (s.m_AutoFleet <= 0) { s.m_AutoFleet = math.max(1, running); s.m_AutoFrame = m_Simulation.frameIndex; }
            var frame = m_Simulation.frameIndex;
            if (frame - s.m_AutoFrame < kAutoCooldownFrames) return s.m_AutoFleet;

            float load;
            var gap = 0.05f;
            switch (band.m_Mode) {
                case BandMode.CrowdingCap: {
                    load = -1f;
                    if (routeVehicles.HasBuffer(line)) {
                        foreach (var rv in routeVehicles[line]) {
                            int r = 0, c = 0;
                            if (layouts.HasBuffer(rv.m_Vehicle)) foreach (var car in layouts[rv.m_Vehicle]) CountLoad(car.m_Vehicle, ref r, ref c, passengers, cargoLoads, prefabRefs, ptVehicleData, cargoData);
                            else CountLoad(rv.m_Vehicle, ref r, ref c, passengers, cargoLoads, prefabRefs, ptVehicleData, cargoData);
                            if (c > 0) load = math.max(load, (float)r / c);
                        }
                    }
                    if (load < 0f) return s.m_AutoFleet;
                    break;
                }
                case BandMode.StationStock:
                    load = StationFill(waypoints);
                    if (load < 0f) return s.m_AutoFleet;
                    break;
                case BandMode.DemandFirst: {
                    var capacity = 0;
                    if (routeVehicles.HasBuffer(line)) {
                        foreach (var rv in routeVehicles[line]) {
                            int r = 0;
                            if (layouts.HasBuffer(rv.m_Vehicle)) foreach (var car in layouts[rv.m_Vehicle]) CountLoad(car.m_Vehicle, ref r, ref capacity, passengers, cargoLoads, prefabRefs, ptVehicleData, cargoData);
                            else CountLoad(rv.m_Vehicle, ref r, ref capacity, passengers, cargoLoads, prefabRefs, ptVehicleData, cargoData);
                        }
                    }
                    if (capacity <= 0) return s.m_AutoFleet;
                    load = PendingCargo(waypoints) / (float)capacity;
                    break;
                }
                default: {
                    if (!histories.HasBuffer(line)) return s.m_AutoFleet;
                    var hist = histories[line];
                    if (hour >= hist.Length || hist[hour].m_Samples < 4) return s.m_AutoFleet;
                    if (band.m_Mode == BandMode.TargetWait) { load = hist[hour].m_Wait; gap = 1f; }
                    else load = hist[hour].m_Load;
                    break;
                }
            }
            var lo = math.max(0f, band.m_LoadMin);
            var hi = math.max(lo + gap, band.m_LoadMax);
            // Up only once the last increase has arrived: vanilla fills a larger fleet by dispatching
            // from a depot, and with none spare the line just stays short (NotEnoughVehicles) —
            // stepping up again then would only run the target away from what can ever run.
            if (load > hi && s.m_AutoFleet < kAutoMaxFleet && running >= s.m_AutoFleet) { s.m_AutoFleet++; s.m_AutoFrame = frame; }
            else if (load < lo && s.m_AutoFleet > 1) { s.m_AutoFleet--; s.m_AutoFrame = frame; }
            return s.m_AutoFleet;
        }

        /// <summary>Riders (or kg of cargo) and capacity of one car, as SampleHistory counts them.</summary>
        private static void CountLoad(Entity car, ref int r, ref int c, BufferLookup<Passenger> passengers,
                                      BufferLookup<Game.Economy.Resources> cargoLoads, ComponentLookup<PrefabRef> prefabRefs,
                                      ComponentLookup<PublicTransportVehicleData> ptVehicleData, ComponentLookup<CargoTransportVehicleData> cargoData) {
            if (car == Entity.Null) return;
            if (passengers.HasBuffer(car)) r += passengers[car].Length;
            if (cargoLoads.HasBuffer(car)) foreach (var res in cargoLoads[car]) r += res.m_Amount;
            if (!prefabRefs.TryGetComponent(car, out var pr)) return;
            if (ptVehicleData.TryGetComponent(pr.m_Prefab, out var d)) c += d.m_PassengerCapacity;
            if (cargoData.TryGetComponent(pr.m_Prefab, out var cd)) c += cd.m_CargoCapacity;
        }

        /// <summary>
        /// StationStock: the line's stations' mean fill (stored / storage limit, upgrades combined,
        /// as the Planner's station table reads it), or −1 when no station has a limit. A station
        /// is counted once however many of its stops the line uses.
        /// </summary>
        private float StationFill(DynamicBuffer<RouteWaypoint> waypoints) {
            var em = EntityManager;
            var seen = new NativeParallelHashSet<Entity>(8, Allocator.Temp);
            var sum = 0f;
            var n = 0;
            foreach (var wp in waypoints) {
                if (!em.HasComponent<Connected>(wp.m_Waypoint)) continue;
                var stop = em.GetComponentData<Connected>(wp.m_Waypoint).m_Connected;
                if (!em.HasComponent<Owner>(stop)) continue;
                var building = em.GetComponentData<Owner>(stop).m_Owner;
                if (!seen.Add(building) || !em.HasBuffer<Game.Economy.Resources>(building) || !em.HasComponent<PrefabRef>(building)) continue;
                var prefab = em.GetComponentData<PrefabRef>(building).m_Prefab;
                if (!UpgradeUtils.TryGetCombinedComponent<Game.Companies.StorageLimitData>(em, building, prefab, out var limit) || limit.m_Limit <= 0) continue;
                var stored = 0L;
                foreach (var r in em.GetBuffer<Game.Economy.Resources>(building, true)) stored += math.max(0, r.m_Amount);
                sum += math.saturate(stored / (float)limit.m_Limit);
                n++;
            }
            seen.Dispose();
            return n > 0 ? sum / n : -1f;
        }

        /// <summary>
        /// DemandFirst: kg of cargo the line's stations want to send to another station on the
        /// line — their outgoing <c>StorageTransferRequest</c>s (no <c>Incoming</c> flag), which is
        /// what vanilla loads at <c>BeginBoarding</c> / <c>EndBoarding</c>.
        /// </summary>
        private long PendingCargo(DynamicBuffer<RouteWaypoint> waypoints) {
            var em = EntityManager;
            var stations = new NativeParallelHashSet<Entity>(8, Allocator.Temp);
            foreach (var wp in waypoints) {
                if (!em.HasComponent<Connected>(wp.m_Waypoint)) continue;
                var stop = em.GetComponentData<Connected>(wp.m_Waypoint).m_Connected;
                stations.Add(stop);
                if (em.HasComponent<Owner>(stop)) stations.Add(em.GetComponentData<Owner>(stop).m_Owner);
            }
            var pending = 0L;
            foreach (var station in stations) {
                if (!em.HasBuffer<Game.Companies.StorageTransferRequest>(station)) continue;
                foreach (var req in em.GetBuffer<Game.Companies.StorageTransferRequest>(station, true)) {
                    if ((req.m_Flags & Game.Companies.StorageTransferFlags.Incoming) != 0) continue;
                    if (req.m_Amount > 0 && stations.Contains(req.m_Target)) pending += req.m_Amount;
                }
            }
            stations.Dispose();
            return pending;
        }

        /// <summary>
        /// FollowDemand: the fleet that would have carried this hour's measured demand at the
        /// band's target load — measured fleet × measured load / target — or the running fleet
        /// until the hour has history.
        /// </summary>
        private static int DemandFleet(TP_ScheduleBand band, Entity line, int hour,
                                       BufferLookup<RouteVehicle> routeVehicles, BufferLookup<TP_LoadSample> histories) {
            var running = routeVehicles.HasBuffer(line) ? routeVehicles[line].Length : 1;
            if (!histories.HasBuffer(line)) return math.max(1, running);
            var hist = histories[line];
            if (hour >= hist.Length || hist[hour].m_Samples < 4 || hist[hour].m_Fleet <= 0f) return math.max(1, running);
            var target = math.max(0.1f, band.m_Value);
            return math.clamp((int)math.ceil(hist[hour].m_Fleet * hist[hour].m_Load / target), 1, kAutoMaxFleet);
        }

        /// <summary>Index of the first band containing the frame, or -1.</summary>
        private static int FindBand(DynamicBuffer<TP_ScheduleBand> bands, uint frameOfDay) {
            for (var i = 0; i < bands.Length; i++) {
                if (bands[i].Contains(frameOfDay)) return i;
            }
            return -1;
        }

        /// <summary>
        /// Puts the active band's models on the line, or the line's own back. Only the moment the
        /// active band changes writes anything: the first band to take over snapshots the line's
        /// selection into <see cref="TP_BaselineModel"/>; a band without models (or no band)
        /// restores it. Vanilla does the rest: vehicles that no longer match are abandoned and
        /// replacements dispatched, exactly as after a manual selection.
        /// </summary>
        private static void ApplyBandModels(Entity line, ref TP_LineSchedule s, int bandIndex,
                                            BufferLookup<VehicleModel> vehicleModels, BufferLookup<TP_BandModel> bandModels,
                                            BufferLookup<TP_BaselineModel> baselines) {
            if (!vehicleModels.HasBuffer(line) || !bandModels.HasBuffer(line) || !baselines.HasBuffer(line)) return;
            var wanted    = bandModels[line];
            var hasModels = false;
            for (var i = 0; i < wanted.Length; i++) {
                if (wanted[i].m_Band == bandIndex) { hasModels = true; break; }
            }
            var target = hasModels ? bandIndex : -1;
            if (target == s.m_AppliedModelBand) return;

            var models   = vehicleModels[line];
            var baseline = baselines[line];
            if (s.m_AppliedModelBand < 0) {
                // The line's own selection, kept until no band wants models any more.
                baseline.Clear();
                for (var i = 0; i < models.Length; i++) {
                    baseline.Add(new TP_BaselineModel { m_Primary = models[i].m_PrimaryPrefab, m_Secondary = models[i].m_SecondaryPrefab });
                }
            }

            models.Clear();
            if (target >= 0) {
                for (var i = 0; i < wanted.Length; i++) {
                    if (wanted[i].m_Band != bandIndex) continue;
                    // A prefab that no longer exists deserialized as Null; a pair of Nulls is "any".
                    if (wanted[i].m_Primary == Entity.Null && wanted[i].m_Secondary == Entity.Null) continue;
                    models.Add(new VehicleModel { m_PrimaryPrefab = wanted[i].m_Primary, m_SecondaryPrefab = wanted[i].m_Secondary });
                }
            } else {
                for (var i = 0; i < baseline.Length; i++) {
                    models.Add(new VehicleModel { m_PrimaryPrefab = baseline[i].m_Primary, m_SecondaryPrefab = baseline[i].m_Secondary });
                }
                baseline.Clear();
            }
            s.m_AppliedModelBand = target;
        }
    }
}
