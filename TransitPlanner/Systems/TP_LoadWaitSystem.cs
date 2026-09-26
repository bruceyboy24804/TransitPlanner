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
    /// Wait for load: at a line's <see cref="TP_LoadWait"/> stations, a vehicle that is loading is
    /// held until it is full enough or has waited long enough. The hold is the timetable's: the
    /// vehicle AI waits while <c>simulationFrame &lt; m_DepartureFrame</c>, so this system keeps
    /// that frame a little ahead of now while the conditions hold, and stops once either is met —
    /// vanilla's own departure (or a timetable slot, which may be later) then stands.
    /// </summary>
    /// <remarks>
    /// Every 8 frames, like the timetable (vanilla's shortest hold is 60). A held vehicle occupies
    /// the stop, so the ones behind it queue — expected at a freight terminal. Whether a held
    /// freight vehicle keeps taking on cargo while it waits depends on vanilla's loading, which
    /// is not verified live yet.
    /// </remarks>
    public partial class TP_LoadWaitSystem : CommonGameSystemBase {
        /// <summary>How far ahead of now a held vehicle's departure is kept (frames).</summary>
        private const uint kLead = 30;

        private SimulationSystem m_Simulation;
        private TimeSystem       m_Time;
        private EntityQuery      m_Query;

        public override int GetUpdateInterval(SystemUpdatePhase phase) => 8;

        protected override void OnCreate() {
            base.OnCreate();
            m_Simulation = World.GetOrCreateSystemManaged<SimulationSystem>();
            m_Time       = World.GetOrCreateSystemManaged<TimeSystem>();
            // Lines with wait stops, or with a schedule that may hold a Convoy band.
            m_Query = SystemAPI.QueryBuilder()
                               .WithAll<Route, TransportLine, RouteVehicle>()
                               .WithAny<TP_LoadWait, TP_ScheduleBand>()
                               .WithNone<Temp, Deleted>()
                               .Build();
        }

        protected override void OnUpdate() {
            if (m_Query.IsEmptyIgnoreFilter) return;
            var em    = EntityManager;
            var frame = m_Simulation.frameIndex;
            var frameOfDay = (uint)(math.frac(m_Time.normalizedTime) * TimeSystem.kTicksPerDay);
            var lines = m_Query.ToEntityArray(Allocator.Temp);

            // Each line's active Convoy band (index), if any; lines with neither are skipped below.
            var convoy = new NativeArray<int>(lines.Length, Allocator.Temp);
            for (var l = 0; l < lines.Length; l++) {
                convoy[l] = -1;
                var line = lines[l];
                if (!em.HasBuffer<TP_ScheduleBand>(line) || !em.HasComponent<TP_LineSchedule>(line) || !em.GetComponentData<TP_LineSchedule>(line).Enabled) continue;
                var bands = em.GetBuffer<TP_ScheduleBand>(line, true);
                for (var i = 0; i < bands.Length; i++) {
                    if (!bands[i].Contains(frameOfDay)) continue;
                    if (bands[i].m_Mode == BandMode.Convoy) convoy[l] = i;
                    break;
                }
            }

            // Structural pass first: every buffer read below is invalidated by an add.
            var need = new NativeList<Entity>(Allocator.Temp);
            for (var l = 0; l < lines.Length; l++) {
                var line = lines[l];
                if (convoy[l] < 0 && (!em.HasBuffer<TP_LoadWait>(line) || em.GetBuffer<TP_LoadWait>(line, true).Length == 0)) continue;
                foreach (var rv in em.GetBuffer<RouteVehicle>(line, true)) {
                    if (em.Exists(rv.m_Vehicle) && !em.HasComponent<TP_LoadHold>(rv.m_Vehicle)) need.Add(rv.m_Vehicle);
                }
            }
            foreach (var v in need) em.AddComponentData(v, new TP_LoadHold { m_Waypoint = -1 });
            need.Dispose();

            for (var l = 0; l < lines.Length; l++) {
                var line = lines[l];
                var hasWaits = em.HasBuffer<TP_LoadWait>(line);
                var waits = hasWaits ? em.GetBuffer<TP_LoadWait>(line, true) : default;
                var convoyBand = convoy[l] >= 0 ? em.GetBuffer<TP_ScheduleBand>(line, true)[convoy[l]] : default;
                var anchor = convoy[l] >= 0 ? ConvoyAnchor(em, line) : -1;
                if ((!hasWaits || waits.Length == 0) && anchor < 0) continue;
                foreach (var rv in em.GetBuffer<RouteVehicle>(line, true)) {
                    var v = rv.m_Vehicle;
                    if (!em.HasComponent<TP_LoadHold>(v) || !em.HasComponent<Target>(v)) continue;
                    var hold   = em.GetComponentData<TP_LoadHold>(v);
                    var target = em.GetComponentData<Target>(v).m_Target;
                    var index  = em.HasComponent<Waypoint>(target) ? em.GetComponentData<Waypoint>(target).m_Index : -1;

                    var wait = -1;
                    if (hasWaits) for (var i = 0; i < waits.Length; i++) if (waits[i].m_Waypoint == index) { wait = i; break; }
                    var atConvoy = anchor >= 0 && index == anchor;
                    if ((wait < 0 && !atConvoy) || !IsBoarding(em, v, out var departure)) {
                        if (hold.m_Waypoint != -1) { hold.m_Waypoint = -1; em.SetComponentData(v, hold); }
                        continue;
                    }
                    if (hold.m_Waypoint != index) { hold.m_Waypoint = index; hold.m_Since = frame; em.SetComponentData(v, hold); }

                    // Leave once the shortest wait is over AND the vehicle is full enough or the
                    // longest wait has run out; until then keep the departure just ahead of now.
                    var held = frame - hold.m_Since;
                    var load = CargoMath.LoadShare(em, v);
                    var want = frame + kLead;
                    if (atConvoy) {
                        // Convoy: hold to the next slot after arriving, then until full enough or
                        // the band's longest wait past that slot runs out.
                        var slot = NextSlot(convoyBand, frameOfDay, hold.m_Since, frame);
                        var maxWait = (uint)(math.max(0f, convoyBand.m_LoadMax) * 60f);
                        var ready = frame >= slot && (load < 0f || load >= convoyBand.m_LoadMin || frame >= slot + maxWait);
                        if (ready) continue;
                        if (departure < want) SetDeparture(em, v, want);
                        continue;
                    }
                    var w = waits[wait];
                    var fullEnough = load < 0f || load >= w.m_MinLoad;
                    if (held >= w.m_MinWait && (fullEnough || held >= w.m_MaxWait)) continue;
                    if (departure < want) SetDeparture(em, v, want);
                }
            }
            lines.Dispose();
            convoy.Dispose();
        }

        /// <summary>The convoy's departure stop: the timetable's anchor waypoint, else the first stop.</summary>
        private static int ConvoyAnchor(EntityManager em, Entity line) {
            if (em.HasComponent<TP_Timetable>(line)) return em.GetComponentData<TP_Timetable>(line).m_StopIndex;
            var wps = em.GetBuffer<RouteWaypoint>(line, true);
            for (var i = 0; i < wps.Length; i++) if (em.HasComponent<Connected>(wps[i].m_Waypoint)) return i;
            return -1;
        }

        /// <summary>
        /// The first convoy slot (band start + k·headway) at or after the vehicle's arrival, as an
        /// absolute frame. Slots are frames of the day; the arrival is mapped through "now".
        /// </summary>
        private static uint NextSlot(TP_ScheduleBand band, uint frameOfDay, uint since, uint frame) {
            var interval = (uint)math.max(60f, band.m_Headway * 60f);
            var arrivedOfDay = (long)frameOfDay - (frame - since);
            var day = (long)TimeSystem.kTicksPerDay;
            var into = ((arrivedOfDay - band.m_Start) % day + day) % day;
            var k = (into + interval - 1) / interval;
            // Arrival + (the slot's offset into the band − the arrival's).
            return (uint)(since + (k * interval - into));
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
    }
}
