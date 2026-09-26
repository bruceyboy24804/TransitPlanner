namespace TransitPlanner.Systems {
    #region Using Statements

    using Game;
    using Game.Common;
    using Game.Routes;
    using Game.Simulation;
    using Game.Tools;
    using Game.Vehicles;

    using Unity.Collections;
    using Unity.Entities;
    using Unity.Mathematics;

    using ModsCommon.Systems;

    using TransitPlanner.Components;
    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// Holds vehicles boarding at a line's timetable anchor until the next clock slot, and at the
    /// line's timing points until the trip's slot plus the point's offset. Vanilla's boarding job
    /// writes a headway-based <c>m_DepartureFrame</c> on the vehicle when boarding begins and
    /// every vehicle AI waits while <c>simulationFrame &lt; m_DepartureFrame</c>; this system
    /// raises that frame. Also measures how late departures are (<see cref="TP_Punctuality"/>).
    /// </summary>
    /// <remarks>
    /// Runs every 8 frames: vanilla's shortest hold is one simulation second (60 frames), so a
    /// vehicle is always seen boarding before it could leave. Slots are handed out in order —
    /// <see cref="TP_Timetable.m_LastSlot"/> remembers the last one, so a vehicle arriving early
    /// waits for its own slot and a late one either takes the next free slot or, with
    /// <see cref="TimetableFlags.LeaveIfLate"/>, leaves on its missed one. Each vehicle is handled
    /// once per stop visit (<see cref="TP_TripSlot.m_Handled"/>): the first version re-ran the slot
    /// pick every tick while the vehicle boarded and pushed it back an interval each time.
    /// </remarks>
    public partial class TP_TimetableSystem : CommonGameSystemBase {
        /// <summary>Departures within this many frames of their slot count as on time (two clock minutes).</summary>
        public const uint kOnTimeFrames = 2 * TimeSystem.kTicksPerDay / 1440;
        private const float kAlpha = 0.1f;

        private SimulationSystem m_Simulation;
        private TimeSystem       m_Time;
        private EntityQuery      m_Query;

        public override int GetUpdateInterval(SystemUpdatePhase phase) => 8;

        protected override void OnCreate() {
            base.OnCreate();
            m_Simulation = World.GetOrCreateSystemManaged<SimulationSystem>();
            m_Time       = World.GetOrCreateSystemManaged<TimeSystem>();
            m_Query = SystemAPI.QueryBuilder()
                               .WithAll<Route, TransportLine, RouteWaypoint, RouteVehicle>()
                               .WithAllRW<TP_Timetable>()
                               .WithNone<Temp, Deleted>()
                               .Build();
        }

        protected override void OnUpdate() {
            if (m_Query.IsEmptyIgnoreFilter) return;
            var em    = EntityManager;
            var frame = m_Simulation.frameIndex;
            var now   = (uint)(math.frac(m_Time.normalizedTime) * TimeSystem.kTicksPerDay);
            var hour  = math.clamp((int)(now * 24L / TimeSystem.kTicksPerDay), 0, 23);

            var lines = m_Query.ToEntityArray(Allocator.Temp);

            // Structural pass first: every buffer read below is invalidated by an add.
            var needTrip = new NativeList<Entity>(Allocator.Temp);
            var needHist = new NativeList<Entity>(Allocator.Temp);
            foreach (var line in lines) {
                if (!em.HasBuffer<TP_Punctuality>(line)) needHist.Add(line);
                foreach (var rv in em.GetBuffer<RouteVehicle>(line, true)) {
                    if (em.Exists(rv.m_Vehicle) && !em.HasComponent<TP_TripSlot>(rv.m_Vehicle)) needTrip.Add(rv.m_Vehicle);
                }
            }
            foreach (var v in needTrip) em.AddComponentData(v, new TP_TripSlot { m_Handled = -1 });
            foreach (var l in needHist) em.AddBuffer<TP_Punctuality>(l).ResizeUninitialized(24);
            foreach (var l in needHist) { var b = em.GetBuffer<TP_Punctuality>(l); for (var i = 0; i < 24; i++) b[i] = default; }
            needTrip.Dispose();
            needHist.Dispose();

            foreach (var line in lines) {
                var tt = em.GetComponentData<TP_Timetable>(line);
                var waypoints = em.GetBuffer<RouteWaypoint>(line, true);
                if (tt.m_StopIndex < 0 || tt.m_StopIndex >= waypoints.Length) continue;

                var schedule = em.HasComponent<TP_LineSchedule>(line) ? em.GetComponentData<TP_LineSchedule>(line) : default;
                var bandsOn  = schedule.Enabled && em.HasBuffer<TP_ScheduleBand>(line);
                var bands   = bandsOn ? em.GetBuffer<TP_ScheduleBand>(line, true) : default;
                var list    = em.HasBuffer<TP_TimetableDeparture>(line) ? em.GetBuffer<TP_TimetableDeparture>(line, true) : default;
                var closed  = em.HasBuffer<TP_ClosedPeriod>(line) ? em.GetBuffer<TP_ClosedPeriod>(line, true) : default;
                var points  = em.HasBuffer<TP_TimingPoint>(line) ? em.GetBuffer<TP_TimingPoint>(line, true) : default;
                var punct   = em.GetBuffer<TP_Punctuality>(line);

                foreach (var rv in em.GetBuffer<RouteVehicle>(line, true)) {
                    var vehicle = rv.m_Vehicle;
                    if (!em.HasComponent<TP_TripSlot>(vehicle) || !em.HasComponent<Target>(vehicle)) continue;
                    var trip   = em.GetComponentData<TP_TripSlot>(vehicle);
                    var target = em.GetComponentData<Target>(vehicle).m_Target;
                    var index  = em.HasComponent<Waypoint>(target) ? em.GetComponentData<Waypoint>(target).m_Index : -1;

                    // Moved on from the stop it was handled at: ready for the next one.
                    if (trip.m_Handled >= 0 && index != trip.m_Handled) {
                        trip.m_Handled = -1;
                        em.SetComponentData(vehicle, trip);
                    }
                    if (index < 0 || trip.m_Handled == index || !IsBoarding(em, vehicle, out var departure)) continue;

                    if (index == tt.m_StopIndex) {
                        var slot = TakeSlot(ref tt, bands, bandsOn, list, closed, schedule, frame, now, out var late, out var measured);
                        if (slot == 0) continue;
                        if (departure < slot) SetDeparture(em, vehicle, slot);
                        trip.m_Slot = slot;
                        if (measured) Record(punct, hour, late);
                    } else if (points.IsCreated && trip.m_Slot != 0) {
                        var found = -1;
                        for (var i = 0; i < points.Length; i++) if (points[i].m_Waypoint == index) { found = i; break; }
                        if (found < 0) continue;
                        var due = trip.m_Slot + points[found].m_Offset;
                        // A slot from an earlier trip (the vehicle joined mid-loop, or was sent
                        // home and back) says nothing about this one: wait for the next anchor.
                        if (frame > due + TimeSystem.kTicksPerDay / 24) {
                            trip.m_Slot = 0;
                            em.SetComponentData(vehicle, trip);
                            continue;
                        }
                        if (departure < due) SetDeparture(em, vehicle, due);
                        Record(punct, hour, frame > due ? frame - due : 0);
                    } else {
                        continue;
                    }
                    trip.m_Handled = index;
                    em.SetComponentData(vehicle, trip);
                }
                em.SetComponentData(line, tt);
            }
            lines.Dispose();
        }

        /// <summary>
        /// The slot for a vehicle now boarding at the anchor, as an absolute frame (0 = none).
        /// <paramref name="late"/> is how far past its due slot the vehicle arrived, when there
        /// is a due slot to measure against (<paramref name="measured"/>).
        /// </summary>
        private static uint TakeSlot(ref TP_Timetable tt, DynamicBuffer<TP_ScheduleBand> bands, bool bandsOn,
                                     DynamicBuffer<TP_TimetableDeparture> list, DynamicBuffer<TP_ClosedPeriod> closed, in TP_LineSchedule schedule, uint frame, uint now,
                                     out uint late, out bool measured) {
            late = 0; measured = false;
            var day      = (uint)TimeSystem.kTicksPerDay;
            var interval = TimetableMath.IntervalAt(tt, bands, bandsOn, list, now);
            var resync   = (uint)math.max(1, tt.m_Resync == 0 ? 2 : tt.m_Resync);

            // Forget slot memory from an edit (far ahead) or from long ago (the line stalled).
            if (tt.m_LastSlot > frame + day || (tt.m_LastSlot != 0 && frame > tt.m_LastSlot + resync * interval)) tt.m_LastSlot = 0;

            var wait = TimetableMath.WaitFrom(tt, bands, bandsOn, list, closed, schedule, now);
            if (wait == uint.MaxValue) return 0;
            var next = frame + wait;

            if (tt.m_LastSlot == 0) { tt.m_LastSlot = next; return next; }

            // The slot after the last one handed out is this vehicle's.
            var lastOfDay = (uint)(((long)now - (frame - (long)tt.m_LastSlot)) % day + day) % day;
            var afterLast = TimetableMath.WaitFrom(tt, bands, bandsOn, list, closed, schedule, (lastOfDay + 1) % day);
            if (afterLast == uint.MaxValue) return 0;
            var due = tt.m_LastSlot + 1 + afterLast;

            measured = true;
            if (due >= frame) { tt.m_LastSlot = due; return due; }

            late = frame - due;
            if ((tt.m_Flags & TimetableFlags.LeaveIfLate) != 0 && late <= math.max(tt.m_LateTolerance, 1u)) {
                tt.m_LastSlot = due;
                return due; // in the past: vanilla's own departure frame stands, it leaves on time for it
            }
            tt.m_LastSlot = next;
            return next;
        }

        private static bool IsBoarding(EntityManager em, Entity vehicle, out uint departure) {
            departure = 0;
            if (em.HasComponent<Game.Vehicles.PublicTransport>(vehicle)) {
                var pt = em.GetComponentData<Game.Vehicles.PublicTransport>(vehicle);
                departure = pt.m_DepartureFrame;
                return (pt.m_State & PublicTransportFlags.Boarding) != 0;
            }
            if (em.HasComponent<Game.Vehicles.CargoTransport>(vehicle)) {
                var ct = em.GetComponentData<Game.Vehicles.CargoTransport>(vehicle);
                departure = ct.m_DepartureFrame;
                return (ct.m_State & CargoTransportFlags.Boarding) != 0;
            }
            return false;
        }

        private static void SetDeparture(EntityManager em, Entity vehicle, uint frame) {
            if (em.HasComponent<Game.Vehicles.PublicTransport>(vehicle)) {
                var pt = em.GetComponentData<Game.Vehicles.PublicTransport>(vehicle);
                pt.m_DepartureFrame = frame;
                em.SetComponentData(vehicle, pt);
            } else if (em.HasComponent<Game.Vehicles.CargoTransport>(vehicle)) {
                var ct = em.GetComponentData<Game.Vehicles.CargoTransport>(vehicle);
                ct.m_DepartureFrame = frame;
                em.SetComponentData(vehicle, ct);
            }
        }

        private static void Record(DynamicBuffer<TP_Punctuality> punct, int hour, uint lateFrames) {
            if (hour >= punct.Length) return;
            var p      = punct[hour];
            var late   = lateFrames / 60f;
            var onTime = lateFrames <= kOnTimeFrames ? 1f : 0f;
            if (p.m_Samples == 0) { p.m_Late = late; p.m_OnTime = onTime; }
            else { p.m_Late = math.lerp(p.m_Late, late, kAlpha); p.m_OnTime = math.lerp(p.m_OnTime, onTime, kAlpha); }
            if (p.m_Samples < ushort.MaxValue) p.m_Samples++;
            punct[hour] = p;
        }
    }
}
