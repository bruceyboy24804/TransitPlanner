namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Prefabs;
    using Game.Routes;
    using Game.UI.InGame;

    using Unity.Collections;
    using Unity.Entities;

    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// The network view: every line of one transport type with its stops' world positions, so the
    /// UI can draw the whole type as a map. The UI says which type through <c>setNetworkType</c>;
    /// the read is cached for a few frames like the line map.
    /// </summary>
    public partial class TP_PlannerUISystem {
        private Network m_Network = new Network();
        private int     m_NetworkFrame = -1;
        private int     m_NetworkType  = -1;
        private bool    m_NetworkCargo;
        // Geometry makes this the heaviest binding (a few thousand points on a big network); a
        // second between reads is plenty for a map.
        private const int kNetworkEveryFrames = 60;

        private NetVehicle[] m_NetVehicles = System.Array.Empty<NetVehicle>();
        private int          m_NetVehiclesFrame = -1;
        private const int    kNetVehiclesEveryFrames = 6;

        private EntityQuery m_DistrictQuery;

        private void CreateNetworkBindings() {
            m_DistrictQuery = SystemAPI.QueryBuilder()
                                       .WithAll<Game.Areas.District, Game.Areas.Node>()
                                       .WithNone<Game.Tools.Temp, Deleted>()
                                       .Build();
            CreateBinding("network", ReadNetwork);
            // World overlay (TP_WorldOverlaySystem) and the mod's infoview state.
            var overlay = World.GetOrCreateSystemManaged<TP_WorldOverlaySystem>();
            var infoview = World.GetOrCreateSystemManaged<TP_InfoviewSystem>();
            CreateTrigger<WorldOverlayRequest>("setWorldOverlay", r => overlay.Set((TP_WorldOverlaySystem.Mode)r.mode, r.radius, r.reachMax, r.stops, r.values, r.force));
            CreateTrigger<Entity>("setWorldHighlight", overlay.SetHighlight);
            CreateBinding("infoviewActive", () => infoview.Active);
            CreateTrigger("openInfoview", () => {
                if (infoview.Infoview == null) return;
                var tools = World.GetOrCreateSystemManaged<Game.Tools.ToolSystem>();
                // What InfoviewsUISystem.SetActiveInfoview does: the `infoview` setter, not activeInfoview.
                tools.infoview = tools.activeInfoview == infoview.Infoview ? null : infoview.Infoview;
            });
            CreateBinding("networkVehicles", ReadNetworkVehicles);
            CreateTrigger<int, bool>("setNetworkType", (type, cargo) => { m_NetworkType = type; m_NetworkCargo = cargo; m_NetworkFrame = -1; });
        }

        /// <summary>
        /// The loop's geometry as x, z pairs: each <c>RouteSegment</c>'s <c>CurveElement</c> beziers
        /// in order, sampled at their middle and end and decimated so consecutive points are at
        /// least <see cref="kPathStep"/> metres apart. Enough to follow a road; far from every vertex.
        /// </summary>
        private const float kPathStep = 12f;
        /// <param name="stopWaypoints">Waypoint index of each stop in the line's stop order; <paramref name="legStarts"/> gets the path point index where each stop's leg begins.</param>
        private float[] SamplePath(Entity line, List<int> stopWaypoints, out int[] legStarts) {
            var em = EntityManager;
            legStarts = new int[stopWaypoints.Count];
            if (!em.HasBuffer<RouteSegment>(line)) return System.Array.Empty<float>();
            var pts  = new List<float>();
            var last = new Unity.Mathematics.float2(float.NaN, float.NaN);
            void Add(Unity.Mathematics.float3 p) {
                var q = new Unity.Mathematics.float2(p.x, p.z);
                if (!float.IsNaN(last.x) && Unity.Mathematics.math.distance(q, last) < kPathStep) return;
                pts.Add(q.x); pts.Add(q.y);
                last = q;
            }
            var segments = em.GetBuffer<RouteSegment>(line, true);
            for (var s = 0; s < segments.Length; s++) {
                // Segment s starts at waypoint s: a stop there begins its leg at this point.
                var pos = stopWaypoints.IndexOf(s);
                if (pos >= 0) legStarts[pos] = pts.Count / 2;
                var seg = segments[s].m_Segment;
                if (!em.HasBuffer<CurveElement>(seg)) continue;
                var curves = em.GetBuffer<CurveElement>(seg, true);
                for (var i = 0; i < curves.Length; i++) {
                    var c = curves[i].m_Curve;
                    if (i == 0) { last.x = float.NaN; Add(c.a); } // always keep a leg's first point
                    Add(Colossal.Mathematics.MathUtils.Position(c, 0.5f));
                    Add(c.d);
                }
            }
            return pts.ToArray();
        }

        /// <summary>Planned seconds from each stop to the next: the segments from its waypoint up to the next stop's waypoint, wrapping.</summary>
        private float[] LegDurations(Entity line, List<int> stopWaypoints) {
            var em  = EntityManager;
            var out_ = new float[stopWaypoints.Count];
            if (!em.HasBuffer<RouteSegment>(line)) return out_;
            var segments = em.GetBuffer<RouteSegment>(line, true);
            var n = segments.Length;
            if (n == 0) return out_;
            for (var k = 0; k < stopWaypoints.Count; k++) {
                var from = stopWaypoints[k];
                var to   = stopWaypoints[(k + 1) % stopWaypoints.Count];
                var sum  = 0f;
                for (var s = from; s != to; s = (s + 1) % n) {
                    if (em.HasComponent<Game.Pathfind.PathInformation>(segments[s].m_Segment)) sum += em.GetComponentData<Game.Pathfind.PathInformation>(segments[s].m_Segment).m_Duration;
                }
                out_[k] = sum;
            }
            return out_;
        }

        /// <summary>The line's 24 hourly loads, -1 for hours never sampled.</summary>
        private float[] History(Entity line) {
            var em  = EntityManager;
            var out_ = new float[24];
            for (var h = 0; h < 24; h++) out_[h] = -1f;
            if (!em.HasBuffer<Components.TP_LoadSample>(line)) return out_;
            var buf = em.GetBuffer<Components.TP_LoadSample>(line, true);
            for (var h = 0; h < 24 && h < buf.Length; h++) if (buf[h].m_Samples > 0) out_[h] = buf[h].m_Load;
            return out_;
        }

        /// <summary>Per line, the waypoint index of each stop in stop order — for placing a vehicle on a leg.</summary>
        private readonly Dictionary<Entity, int[]> m_LineStopWaypoints = new Dictionary<Entity, int[]>();

        /// <summary>Position in the line's stop order of the next stop the vehicle is heading to, or -1.</summary>
        private int NextStop(Entity line, Entity vehicle) {
            var em = EntityManager;
            if (!m_LineStopWaypoints.TryGetValue(line, out var stopWps) || stopWps.Length == 0) return -1;
            if (!em.HasComponent<Target>(vehicle) || !em.HasBuffer<RouteWaypoint>(line)) return -1;
            var target    = em.GetComponentData<Target>(vehicle).m_Target;
            var waypoints = em.GetBuffer<RouteWaypoint>(line, true);
            var wi = -1;
            for (var i = 0; i < waypoints.Length; i++) if (waypoints[i].m_Waypoint == target) { wi = i; break; }
            if (wi < 0) return -1;
            // Walk forward from the target waypoint to the first one that is a stop.
            for (var k = 0; k < waypoints.Length; k++) {
                var idx = System.Array.IndexOf(stopWps, (wi + k) % waypoints.Length);
                if (idx >= 0) return idx;
            }
            return -1;
        }

        /// <summary>Every vehicle of the network's lines at its world position; the lines come from the last network read.</summary>
        private NetVehicle[] ReadNetworkVehicles() {
            var frame = UnityEngine.Time.frameCount;
            if (!m_Network.valid) return m_NetVehicles;
            if (frame - m_NetVehiclesFrame < kNetVehiclesEveryFrames) return m_NetVehicles;
            m_NetVehiclesFrame = frame;

            var em   = EntityManager;
            var list = new List<NetVehicle>();
            foreach (var nl in m_Network.lines) {
                var line = nl.entity;
                if (!em.Exists(line) || !em.HasBuffer<RouteVehicle>(line)) continue;
                foreach (var rv in em.GetBuffer<RouteVehicle>(line, true)) {
                    var v = rv.m_Vehicle;
                    if (v == Entity.Null || !em.Exists(v) || !em.HasComponent<Game.Objects.Transform>(v)) continue;
                    var pos = em.GetComponentData<Game.Objects.Transform>(v).m_Position;
                    CountRiders(v, out var riders, out var capacity);
                    var state = em.HasComponent<Game.Vehicles.PublicTransport>(v) ? (int)em.GetComponentData<Game.Vehicles.PublicTransport>(v).m_State
                              : em.HasComponent<Game.Vehicles.CargoTransport>(v)  ? (int)em.GetComponentData<Game.Vehicles.CargoTransport>(v).m_State : 0;
                    list.Add(new NetVehicle {
                        entity = v, line = line, x = pos.x, y = pos.z,
                        riders = riders, capacity = capacity,
                        boarding  = (state & (int)Game.Vehicles.PublicTransportFlags.Boarding) != 0,
                        returning = (state & (int)Game.Vehicles.PublicTransportFlags.Returning) != 0,
                        nextStop  = NextStop(line, v),
                    });
                }
            }
            return m_NetVehicles = list.ToArray();
        }

        private Network ReadNetwork() {
            var frame = UnityEngine.Time.frameCount;
            if (m_NetworkType < 0) return m_Network;
            if (frame - m_NetworkFrame < kNetworkEveryFrames) return m_Network;
            m_NetworkFrame = frame;

            var em  = EntityManager;
            var net = new Network { valid = true, type = m_NetworkType, cargo = m_NetworkCargo };
            var stopIndex = new Dictionary<Entity, int>();
            var stops     = new List<NetStop>();
            var lines     = new List<NetLine>();
            var stopLines = new List<List<int>>();          // per stop, indices into `lines`
            var lineIndex = new Dictionary<Entity, int>();  // line entity → index into `lines`

            var entities = m_LineQuery.ToEntityArray(Allocator.Temp);
            foreach (var line in entities) {
                var prefab = em.GetComponentData<PrefabRef>(line).m_Prefab;
                if (!em.HasComponent<TransportLineData>(prefab)) continue;
                var data = em.GetComponentData<TransportLineData>(prefab);
                if ((int)data.m_TransportType != m_NetworkType || (data.m_CargoTransport && !data.m_PassengerTransport) != m_NetworkCargo) continue;
                if (!em.HasBuffer<RouteWaypoint>(line)) continue;

                var order    = new List<int>();
                var stopWps  = new List<int>();
                var waypoints = em.GetBuffer<RouteWaypoint>(line, true);
                for (var w = 0; w < waypoints.Length; w++) {
                    var wp = waypoints[w].m_Waypoint;
                    if (!em.HasComponent<Connected>(wp)) continue;
                    var stop = em.GetComponentData<Connected>(wp).m_Connected;
                    if (stop == Entity.Null || !em.HasComponent<Game.Objects.Transform>(stop)) continue;
                    if (!stopIndex.TryGetValue(stop, out var idx)) {
                        var pos = em.GetComponentData<Game.Objects.Transform>(stop).m_Position;
                        idx = stops.Count;
                        stopIndex[stop] = idx;
                        stops.Add(new NetStop { entity = stop, name = m_Names.GetName(stop), x = pos.x, y = pos.z });
                        stopLines.Add(new List<int>());
                    }
                    var s = stops[idx];
                    if (em.HasComponent<WaitingPassengers>(wp)) s.waiting += em.GetComponentData<WaitingPassengers>(wp).m_Count;
                    if (order.Count == 0 || order[order.Count - 1] != idx) {
                        s.lines++; order.Add(idx); stopWps.Add(w);
                        if (!stopLines[idx].Contains(lines.Count)) stopLines[idx].Add(lines.Count);
                    }
                    stops[idx] = s;
                }
                if (order.Count < 2) {
                    // Undo the memberships of a line that is not being added.
                    foreach (var sl in stopLines) sl.Remove(lines.Count);
                    continue;
                }
                lineIndex[line] = lines.Count;
                m_LineStopWaypoints[line] = stopWps.ToArray();
                var path = SamplePath(line, stopWps, out var legStarts);

                var riders = 0; var capacity = 0;
                var fleet  = TransportUIUtils.GetRouteVehiclesCount(em, line, ref riders, ref capacity);
                var tl     = em.GetComponentData<TransportLine>(line);
                lines.Add(new NetLine {
                    entity   = line,
                    name     = m_Names.GetName(line),
                    color    = em.HasComponent<Game.Routes.Color>(line) ? (UnityEngine.Color)em.GetComponentData<Game.Routes.Color>(line).m_Color : UnityEngine.Color.white,
                    stops    = order.ToArray(),
                    path     = path,
                    legStarts = legStarts,
                    legDurations = LegDurations(line, stopWps),
                    headway  = tl.m_VehicleInterval,
                    history  = History(line),
                    fleet    = fleet, riders = riders, capacity = capacity,
                    notEnoughVehicles = (tl.m_Flags & TransportLineFlags.NotEnoughVehicles) != 0,
                    inactive = RouteUtils.CheckOption(em.GetComponentData<Route>(line), RouteOption.Inactive),
                    hourHeadway = HourHeadways(line, tl.m_VehicleInterval, StableDuration(line, data)),
                    anchorStop  = AnchorPosition(line, stopWps),
                    departures  = Departures(line),
                });
            }
            entities.Dispose();

            for (var i = 0; i < stops.Count; i++) { var s = stops[i]; s.lineIds = stopLines[i].ToArray(); stops[i] = s; }

            // Depots of this type, with the shown lines bound to them (TP_PreferredDepot).
            var depots = new List<NetDepot>();
            var depotEntities = m_DepotQuery.ToEntityArray(Allocator.Temp);
            foreach (var depot in depotEntities) {
                var prefab = em.GetComponentData<PrefabRef>(depot).m_Prefab;
                if (!em.HasComponent<TransportDepotData>(prefab) || (int)em.GetComponentData<TransportDepotData>(prefab).m_TransportType != m_NetworkType) continue;
                if (!em.HasComponent<Game.Objects.Transform>(depot)) continue;
                var pos = em.GetComponentData<Game.Objects.Transform>(depot).m_Position;
                var td  = em.GetComponentData<Game.Buildings.TransportDepot>(depot);
                var bound = new List<int>();
                var starved = false;
                foreach (var kv in lineIndex) {
                    if (!em.HasComponent<Components.TP_PreferredDepot>(kv.Key) || em.GetComponentData<Components.TP_PreferredDepot>(kv.Key).m_Depot != depot) continue;
                    bound.Add(kv.Value);
                    if (lines[kv.Value].notEnoughVehicles && td.m_AvailableVehicles == 0) starved = true;
                }
                depots.Add(new NetDepot {
                    entity = depot, name = m_Names.GetName(depot), x = pos.x, y = pos.z,
                    available = td.m_AvailableVehicles,
                    owned = em.HasBuffer<Game.Vehicles.OwnedVehicle>(depot) ? em.GetBuffer<Game.Vehicles.OwnedVehicle>(depot, true).Length : 0,
                    starved = starved, boundLines = bound.ToArray(),
                });
            }
            depotEntities.Dispose();

            // Districts, for context: each one's polygon nodes.
            var districts = new List<NetDistrict>();
            var districtEntities = m_DistrictQuery.ToEntityArray(Allocator.Temp);
            foreach (var d in districtEntities) {
                var nodes = em.GetBuffer<Game.Areas.Node>(d, true);
                if (nodes.Length < 3) continue;
                var pts = new float[nodes.Length * 2];
                for (var i = 0; i < nodes.Length; i++) { pts[i * 2] = nodes[i].m_Position.x; pts[i * 2 + 1] = nodes[i].m_Position.z; }
                districts.Add(new NetDistrict { entity = d, name = m_Names.GetName(d), points = pts });
            }
            districtEntities.Dispose();

            net.stops     = stops.ToArray();
            net.lines     = lines.ToArray();
            net.depots    = depots.ToArray();
            net.districts = districts.ToArray();
            return m_Network = net;
        }
    }
}
