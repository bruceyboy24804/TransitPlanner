namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Objects;
    using Game.Routes;
    using Game.Vehicles;

    using Unity.Entities;

    #endregion

    /// <summary>
    /// Selection both ways. World → panel: whatever the player selects in the world (a line, a
    /// stop, a station, a vehicle or a trailing car) resolves to its line and the open panel
    /// follows it. Panel → world: <c>goTo(entity)</c> selects a stop or vehicle in the world and
    /// puts the camera on it, through vanilla's own selected-info system.
    /// </summary>
    /// <remarks>
    /// Resolution order is ExtendedTransportManager's (<c>LineRequirementsCheckJob</c>): the entity
    /// itself, a vehicle's <c>CurrentRoute</c> (via its <c>Controller</c> for a trailer), then the
    /// <c>ConnectedRoute</c>s of a stop or of a building's sub-objects — each entry's waypoint is
    /// owned by its line. A stop shared by several lines keeps the line already shown when it is
    /// one of them, else takes the first.
    /// </remarks>
    public partial class TP_PlannerUISystem {
        private Entity m_LastWorldSelection;

        private void CreateFollowBindings() {
            CreateTrigger<Entity>("goTo", GoTo);
            // What the overview's rename does (TransportationOverviewUISystem.SetLineName).
            CreateTrigger<Entity, string>("rename", (entity, name) => {
                if (!EntityManager.Exists(entity) || string.IsNullOrWhiteSpace(name)) return;
                m_Names.SetCustomName(entity, name.Trim());
            });
        }

        /// <summary>Called every UI frame: follows a new world selection while the panel is open, and sets the reach origin while the infoview is on.</summary>
        private void FollowWorldSelection() {
            var picked = m_SelectedInfo.selectedEntity;
            if (picked == m_LastWorldSelection) return;
            m_LastWorldSelection = picked;
            if (picked == Entity.Null) return;
            // Infoview on and a stop clicked: reach from here, computed here (the panel's own
            // Dijkstra lives in the UI, which need not be open), for the Reach heatmap / colouring.
            if (World.GetOrCreateSystemManaged<TP_InfoviewSystem>().Active) {
                var stop = FindStop(picked);
                m_Log.Debug($"Infoview click {picked} → stop {stop}");
                if (stop != Entity.Null) ReachFromStop(stop);
            }
            if (!m_Visible.Value) return;
            var line = ResolveLine(picked, m_Selected.Value);
            if (line != Entity.Null && line != m_Selected.Value) {
                m_Selected.Value = line;
                m_Log.Debug($"Following world selection {picked} → line {line}");
            }
        }

        /// <summary>
        /// Travel time from <paramref name="origin"/> to every stop over every line, the same
        /// model as the Network tab's Reach (Dijkstra on (stop, line): ride = the leg's planned
        /// duration, board / change = half the line's headway), handed to the world overlay as a
        /// reach request so the Reach heatmap and building colouring pick it up.
        /// </summary>
        private void ReachFromStop(Entity origin) {
            var em = EntityManager;
            const float reachMax = 30f; // clock minutes
            // Lines as stop sequences with leg durations.
            var lines = m_LineQuery.ToEntityArray(Unity.Collections.Allocator.Temp);
            var lineStops = new List<List<Entity>>();
            var lineLegs  = new List<List<float>>();
            var lineHead  = new List<float>();
            var atStop    = new Dictionary<Entity, List<(int line, int pos)>>();
            foreach (var line in lines) {
                if (!em.HasBuffer<RouteWaypoint>(line) || !em.HasBuffer<RouteSegment>(line)) continue;
                var wps = em.GetBuffer<RouteWaypoint>(line, true);
                var segs = em.GetBuffer<RouteSegment>(line, true);
                var stops = new List<Entity>(); var stopWp = new List<int>();
                for (var w = 0; w < wps.Length; w++) {
                    if (!em.HasComponent<Connected>(wps[w].m_Waypoint)) continue;
                    var s = em.GetComponentData<Connected>(wps[w].m_Waypoint).m_Connected;
                    if (s == Entity.Null || (stops.Count > 0 && stops[stops.Count - 1] == s)) continue;
                    stops.Add(s); stopWp.Add(w);
                }
                if (stops.Count < 2 || segs.Length == 0) continue;
                var legs = new List<float>(stops.Count);
                for (var k = 0; k < stops.Count; k++) {
                    var from = stopWp[k]; var to = stopWp[(k + 1) % stops.Count]; var sum = 0f;
                    for (var sIdx = from; sIdx != to; sIdx = (sIdx + 1) % segs.Length) {
                        if (em.HasComponent<Game.Pathfind.PathInformation>(segs[sIdx].m_Segment)) sum += em.GetComponentData<Game.Pathfind.PathInformation>(segs[sIdx].m_Segment).m_Duration;
                    }
                    legs.Add(sum);
                }
                var li = lineStops.Count;
                lineStops.Add(stops); lineLegs.Add(legs); lineHead.Add(em.GetComponentData<TransportLine>(line).m_VehicleInterval);
                for (var k = 0; k < stops.Count; k++) {
                    if (!atStop.TryGetValue(stops[k], out var l)) atStop[stops[k]] = l = new List<(int, int)>();
                    l.Add((li, k));
                }
            }
            lines.Dispose();
            if (!atStop.ContainsKey(origin)) return;

            // Dijkstra on (stop, line) states; a plain sorted frontier is fine at this size.
            var best = new Dictionary<Entity, float> { [origin] = 0f };
            var dist = new Dictionary<(Entity, int), float>();
            var open = new SortedSet<(float c, int n, Entity s, int l)>();
            var n = 0;
            foreach (var (li, _) in atStop[origin]) { var c = lineHead[li] / 2f; dist[(origin, li)] = c; open.Add((c, n++, origin, li)); }
            while (open.Count > 0) {
                var cur = open.Min; open.Remove(cur);
                if (cur.c > dist[(cur.s, cur.l)]) continue;
                var stops = lineStops[cur.l];
                var pos = -1;
                foreach (var (li, p) in atStop[cur.s]) if (li == cur.l) { pos = p; break; }
                if (pos < 0) continue;
                void Relax(Entity ns, int nl, float nc) {
                    if (!dist.TryGetValue((ns, nl), out var old) || nc < old) { dist[(ns, nl)] = nc; open.Add((nc, n++, ns, nl)); }
                    if (!best.TryGetValue(ns, out var b) || nc < b) best[ns] = nc;
                }
                Relax(stops[(pos + 1) % stops.Count], cur.l, cur.c + lineLegs[cur.l][pos]);
                foreach (var (li, _) in atStop[cur.s]) if (li != cur.l) Relax(cur.s, li, cur.c + lineHead[li] / 2f);
            }

            // Seconds → clock minutes; everything reachable goes to the overlay as the reach request.
            var rs = new List<Entity>(best.Count); var rm = new List<float>(best.Count);
            foreach (var kv in best) { rs.Add(kv.Key); rm.Add(kv.Value * 1440f / 4369f); }
            World.GetOrCreateSystemManaged<TP_WorldOverlaySystem>().Set(TP_WorldOverlaySystem.Mode.Reach, 0f, reachMax, rs.ToArray(), rm.ToArray(), false);
            m_Log.Debug($"Reach from {origin}: {rs.Count} stop(s) evaluated");
        }

        /// <summary>The stop behind a world selection: the entity itself, or — for a station — the first of its sub-objects that is one.</summary>
        private Entity FindStop(Entity e) {
            var em = EntityManager;
            if (!em.Exists(e)) return Entity.Null;
            if (em.HasComponent<Game.Routes.TransportStop>(e)) return e;
            if (em.HasBuffer<SubObject>(e)) {
                foreach (var so in em.GetBuffer<SubObject>(e, true)) {
                    if (em.HasComponent<Game.Routes.TransportStop>(so.m_SubObject) && em.HasBuffer<ConnectedRoute>(so.m_SubObject)) return so.m_SubObject;
                }
            }
            return Entity.Null;
        }

        /// <summary>The line behind any transit-related entity, or Null.</summary>
        private Entity ResolveLine(Entity e, Entity prefer) {
            var em = EntityManager;
            if (!em.Exists(e)) return Entity.Null;
            if (IsLine(e)) return e;

            // Vehicles: a trailing car points at its controller; the controller carries the route.
            var vehicle = e;
            if (em.HasComponent<Controller>(vehicle)) {
                var c = em.GetComponentData<Controller>(vehicle).m_Controller;
                if (c != Entity.Null) vehicle = c;
            }
            if (em.HasComponent<CurrentRoute>(vehicle)) {
                var r = em.GetComponentData<CurrentRoute>(vehicle).m_Route;
                if (IsLine(r)) return r;
            }

            // Stops, and stations through their sub-objects (platforms, bus stops on the building).
            var found = FromConnectedRoutes(e, prefer);
            if (found == Entity.Null && em.HasBuffer<SubObject>(e)) {
                foreach (var so in em.GetBuffer<SubObject>(e, true)) {
                    found = FromConnectedRoutes(so.m_SubObject, prefer);
                    if (found == prefer && prefer != Entity.Null) break;
                    if (found != Entity.Null && prefer == Entity.Null) break;
                }
            }
            return found;
        }

        private Entity FromConnectedRoutes(Entity stop, Entity prefer) {
            var em = EntityManager;
            if (!em.HasBuffer<ConnectedRoute>(stop)) return Entity.Null;
            var first = Entity.Null;
            foreach (var cr in em.GetBuffer<ConnectedRoute>(stop, true)) {
                if (!em.HasComponent<Owner>(cr.m_Waypoint)) continue;
                var line = em.GetComponentData<Owner>(cr.m_Waypoint).m_Owner;
                if (!IsLine(line)) continue;
                if (line == prefer) return line;
                if (first == Entity.Null) first = line;
            }
            return first;
        }

        /// <summary>Selects <paramref name="entity"/> in the world and moves the camera to it (following a vehicle).</summary>
        private void GoTo(Entity entity) {
            if (!EntityManager.Exists(entity)) return;
            // Our own follow must not bounce the panel to another line for a shared stop.
            m_LastWorldSelection = entity;
            m_SelectedInfo.SetSelection(entity);
            m_SelectedInfo.Focus(entity);
            m_Log.Debug($"goTo {entity}");
        }
    }
}
