namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Colossal.Mathematics;

    using Game.Objects;
    using Game.Pathfind;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Vehicles;

    using Unity.Entities;
    using Unity.Mathematics;

    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// The line map: the selected line's loop unrolled to 0..1, with stops, legs and vehicles.
    /// </summary>
    /// <remarks>
    /// The loop's geometry is the <c>CurveElement</c> buffer of each <c>RouteSegment</c>, in
    /// order; a stop sits where its segment starts. A vehicle is placed by projecting its world
    /// position onto the nearest curve element (<c>MathUtils.Distance</c>), which is a diagram's
    /// worth of accuracy at a fraction of vanilla's lane walk (<c>LineVisualizerSection.GetVehiclePosition</c>
    /// follows every navigation lane per vehicle kind). Vanilla's own walk is what to copy if
    /// exact placement ever matters.
    ///
    /// Recomputed every few UI frames, not every frame: the projection is vehicles × curve
    /// elements, a few thousand distance evaluations on a long line.
    /// </remarks>
    public partial class TP_PlannerUISystem {
        private LineMap m_LineMap = new LineMap();
        private int     m_LineMapFrame = -1;
        private const int kLineMapEveryFrames = 10;

        /// <summary>
        /// Other lines at <paramref name="stop"/>: its own ConnectedRoutes, and — when the stop
        /// belongs to a station building — the ConnectedRoutes of the building's other stops, so a
        /// train station's bus bays count as interchanges (XTM's stop-linking idea, done by walk).
        /// </summary>
        private MapTransfer[] Transfers(Entity stop, Entity line) {
            var em   = EntityManager;
            var seen = new HashSet<Entity> { line };
            var list = new List<MapTransfer>();
            void Collect(Entity s) {
                if (!em.HasBuffer<ConnectedRoute>(s)) return;
                foreach (var cr in em.GetBuffer<ConnectedRoute>(s, true)) {
                    if (!em.HasComponent<Game.Common.Owner>(cr.m_Waypoint)) continue;
                    var other = em.GetComponentData<Game.Common.Owner>(cr.m_Waypoint).m_Owner;
                    if (!IsLine(other) || !seen.Add(other)) continue;
                    var prefab = em.GetComponentData<PrefabRef>(other).m_Prefab;
                    list.Add(new MapTransfer {
                        entity = other,
                        name   = m_Names.GetName(other),
                        color  = em.HasComponent<Game.Routes.Color>(other) ? (UnityEngine.Color)em.GetComponentData<Game.Routes.Color>(other).m_Color : UnityEngine.Color.white,
                        type   = em.HasComponent<TransportLineData>(prefab) ? (int)em.GetComponentData<TransportLineData>(prefab).m_TransportType : 0,
                    });
                }
            }
            Collect(stop);
            // Up to the station: a stop owned by a building shares the building's other stops.
            if (em.HasComponent<Game.Common.Owner>(stop)) {
                var building = em.GetComponentData<Game.Common.Owner>(stop).m_Owner;
                if (em.HasBuffer<Game.Objects.SubObject>(building)) {
                    foreach (var so in em.GetBuffer<Game.Objects.SubObject>(building, true)) if (so.m_SubObject != stop) Collect(so.m_SubObject);
                }
            }
            return list.ToArray();
        }

        private LineMap ReadLineMap() {
            var frame = UnityEngine.Time.frameCount;
            var line  = m_Selected.Value;
            if (frame - m_LineMapFrame < kLineMapEveryFrames && m_LineMap.entity == line) return m_LineMap;
            m_LineMapFrame = frame;

            var em  = EntityManager;
            var map = new LineMap { entity = line };
            if (!IsLine(line)) return m_LineMap = map;

            var waypoints = em.GetBuffer<RouteWaypoint>(line, true);
            var segments  = em.GetBuffer<RouteSegment>(line, true);
            if (segments.Length == 0) return m_LineMap = map;

            // Geometry: every curve element in loop order, with its length and cumulative start.
            var curves = new List<(Bezier4x3 curve, float start, float length, int segment)>();
            var segmentStart = new float[segments.Length + 1];
            var total = 0f;
            for (var i = 0; i < segments.Length; i++) {
                segmentStart[i] = total;
                var seg = segments[i].m_Segment;
                if (!em.HasBuffer<CurveElement>(seg)) continue;
                foreach (var ce in em.GetBuffer<CurveElement>(seg, true)) {
                    var len = MathUtils.Length(ce.m_Curve);
                    curves.Add((ce.m_Curve, total, len, i));
                    total += len;
                }
            }
            segmentStart[segments.Length] = total;
            if (total <= 0f) return m_LineMap = map;
            map.length = total;

            // Stops: the waypoint at the start of segment i, when it serves a stop.
            var stops = new List<MapStop>();
            for (var i = 0; i < waypoints.Length && i < segments.Length; i++) {
                var wp = waypoints[i].m_Waypoint;
                if (!em.HasComponent<Connected>(wp)) continue;
                var stop = em.GetComponentData<Connected>(wp).m_Connected;
                if (stop == Entity.Null) continue;
                var waiting = em.HasComponent<WaitingPassengers>(wp) ? em.GetComponentData<WaitingPassengers>(wp) : default;
                stops.Add(new MapStop {
                    entity      = stop,
                    name        = m_Names.GetName(stop),
                    at          = segmentStart[i] / total,
                    waiting     = waiting.m_Count,
                    averageWait = waiting.m_AverageWaitingTime,
                    transfers   = Transfers(stop, line),
                });
            }
            map.stops = stops.ToArray();

            // Legs: one per segment, with the plan and the measured figure vanilla keeps on it.
            var legs = new MapLeg[segments.Length];
            for (var i = 0; i < segments.Length; i++) {
                var seg  = segments[i].m_Segment;
                var info = em.HasComponent<RouteInfo>(seg) ? em.GetComponentData<RouteInfo>(seg) : default;
                legs[i] = new MapLeg {
                    from          = segmentStart[i] / total,
                    to            = segmentStart[i + 1] / total,
                    planned       = em.HasComponent<PathInformation>(seg) ? em.GetComponentData<PathInformation>(seg).m_Duration : 0f,
                    achieved      = info.m_Duration,
                    inactiveDay   = (info.m_Flags & RouteInfoFlags.InactiveDay) != 0,
                    inactiveNight = (info.m_Flags & RouteInfoFlags.InactiveNight) != 0,
                };
            }
            map.legs = legs;

            // Vehicles: projected onto the nearest curve element.
            var vehicles = new List<MapVehicle>();
            if (em.HasBuffer<RouteVehicle>(line)) {
                foreach (var rv in em.GetBuffer<RouteVehicle>(line, true)) {
                    var v = rv.m_Vehicle;
                    if (v == Entity.Null || !em.Exists(v) || !em.HasComponent<Transform>(v)) continue;
                    var pos = em.GetComponentData<Transform>(v).m_Position;
                    var best = float.MaxValue;
                    var at   = 0f;
                    foreach (var c in curves) {
                        var d = MathUtils.Distance(c.curve, pos, out var t);
                        if (d < best) { best = d; at = (c.start + t * c.length) / total; }
                    }
                    CountRiders(v, out var riders, out var capacity);
                    var state = em.HasComponent<Game.Vehicles.PublicTransport>(v) ? (int)em.GetComponentData<Game.Vehicles.PublicTransport>(v).m_State
                              : em.HasComponent<Game.Vehicles.CargoTransport>(v)  ? (int)em.GetComponentData<Game.Vehicles.CargoTransport>(v).m_State : 0;
                    // Returning / EnRoute / Boarding / Arriving share their bits across both enums
                    // (the divergence starts at RequiresMaintenance), so the low bits are safe here.
                    vehicles.Add(new MapVehicle {
                        entity    = v,
                        name      = m_Names.GetName(v),
                        at        = at,
                        riders    = riders,
                        capacity  = capacity,
                        state     = state,
                        boarding  = (state & (int)PublicTransportFlags.Boarding) != 0,
                        returning = (state & (int)PublicTransportFlags.Returning) != 0,
                    });
                }
            }
            map.vehicles = vehicles.ToArray();
            map.valid = true;
            return m_LineMap = map;
        }

        /// <summary>Riders and seats over the consist: the controller's cars if it has a layout, else itself.</summary>
        internal void CountRiders(Entity vehicle, out int riders, out int capacity) {
            var em = EntityManager;
            riders = 0;
            capacity = 0;
            if (em.HasBuffer<LayoutElement>(vehicle)) {
                foreach (var car in em.GetBuffer<LayoutElement>(vehicle, true)) Count(car.m_Vehicle, ref riders, ref capacity);
            } else {
                Count(vehicle, ref riders, ref capacity);
            }

            void Count(Entity car, ref int r, ref int c) {
                if (car == Entity.Null || !em.Exists(car)) return;
                if (em.HasBuffer<Passenger>(car)) r += em.GetBuffer<Passenger>(car, true).Length;
                // Cargo lines: cargo carried against cargo capacity (vanilla's CargoSection).
                if (em.HasBuffer<Game.Economy.Resources>(car)) foreach (var res in em.GetBuffer<Game.Economy.Resources>(car, true)) r += res.m_Amount;
                if (em.HasComponent<PrefabRef>(car)) {
                    var prefab = em.GetComponentData<PrefabRef>(car).m_Prefab;
                    if (em.HasComponent<PublicTransportVehicleData>(prefab)) c += em.GetComponentData<PublicTransportVehicleData>(prefab).m_PassengerCapacity;
                    if (em.HasComponent<CargoTransportVehicleData>(prefab)) c += em.GetComponentData<CargoTransportVehicleData>(prefab).m_CargoCapacity;
                }
            }
        }
    }
}
