namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Buildings;
    using Game.Common;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Tools;
    using Game.Vehicles;

    using Unity.Collections;
    using Unity.Entities;

    using TransitPlanner.Components;
    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// Preferred depot: the depots of the selected line's type, which one the line prefers, and
    /// the trigger that sets it. The preference itself is applied by
    /// <c>Patches.TransportPathfindSetupPatches</c> at dispatch time; nothing here moves a vehicle.
    /// </summary>
    public partial class TP_PlannerUISystem {
        private EntityQuery m_DepotQuery;

        private void CreateDepotBindings() {
            m_DepotQuery = SystemAPI.QueryBuilder()
                                    .WithAll<Game.Buildings.TransportDepot, PrefabRef>()
                                    .WithNone<Temp, Deleted, Destroyed, Game.Buildings.ServiceUpgrade>()
                                    .Build();
            CreateBinding("depots", ReadDepots);
            CreateBinding("preferredDepot", () => {
                var line = m_Selected.Value;
                return IsLine(line) && EntityManager.HasComponent<TP_PreferredDepot>(line) ? EntityManager.GetComponentData<TP_PreferredDepot>(line).m_Depot : Entity.Null;
            });
            CreateTrigger<Entity, Entity>("setPreferredDepot", SetPreferredDepot);

            // The Depots tab: every depot, the lines it serves and the lines bound to it.
            CreateBinding("depotRows", ReadDepotRows);
            CreateTrigger<Entity[], Entity>("bindLines", (lines, depot) => { foreach (var l in lines) SetPreferredDepot(l, depot); });
        }

        private DepotRow[] ReadDepotRows() {
            var em = EntityManager;

            // Pass 1: per depot, the lines whose vehicles it owns (via each line's RouteVehicle →
            // Owner) and the lines bound to it, so a depot row lists both kinds.
            var served = new Dictionary<Entity, Dictionary<Entity, int>>();
            var bound  = new Dictionary<Entity, List<Entity>>();
            var lines  = m_LineQuery.ToEntityArray(Allocator.Temp);
            foreach (var line in lines) {
                if (em.HasBuffer<RouteVehicle>(line)) {
                    foreach (var rv in em.GetBuffer<RouteVehicle>(line, true)) {
                        if (!em.HasComponent<Owner>(rv.m_Vehicle)) continue;
                        var depot = em.GetComponentData<Owner>(rv.m_Vehicle).m_Owner;
                        if (!served.TryGetValue(depot, out var per)) served[depot] = per = new Dictionary<Entity, int>();
                        per[line] = per.TryGetValue(line, out var n) ? n + 1 : 1;
                    }
                }
                if (em.HasComponent<TP_PreferredDepot>(line)) {
                    var depot = em.GetComponentData<TP_PreferredDepot>(line).m_Depot;
                    if (!bound.TryGetValue(depot, out var list)) bound[depot] = list = new List<Entity>();
                    list.Add(line);
                }
            }
            lines.Dispose();

            var depots = m_DepotQuery.ToEntityArray(Allocator.Temp);
            var rows   = new List<DepotRow>(depots.Length);
            foreach (var depot in depots) {
                var prefab = em.GetComponentData<PrefabRef>(depot).m_Prefab;
                if (!em.HasComponent<TransportDepotData>(prefab)) continue;
                var data = em.GetComponentData<TransportDepotData>(prefab);
                var td   = em.GetComponentData<Game.Buildings.TransportDepot>(depot);
                served.TryGetValue(depot, out var per);
                bound.TryGetValue(depot, out var boundHere);

                var seen  = new HashSet<Entity>();
                var dl    = new List<DepotLine>();
                var starved = false;
                void AddLine(Entity line, int vehicles, bool isBound) {
                    if (!seen.Add(line) || !IsLine(line)) return;
                    var tl = em.GetComponentData<TransportLine>(line);
                    var notEnough = (tl.m_Flags & TransportLineFlags.NotEnoughVehicles) != 0;
                    if (isBound && notEnough && td.m_AvailableVehicles == 0) starved = true;
                    dl.Add(new DepotLine {
                        entity = line, name = m_Names.GetName(line),
                        color  = em.HasComponent<Color>(line) ? (UnityEngine.Color)em.GetComponentData<Color>(line).m_Color : UnityEngine.Color.white,
                        vehicles = vehicles, bound = isBound, notEnoughVehicles = notEnough,
                    });
                }
                if (boundHere != null) foreach (var l in boundHere) AddLine(l, per != null && per.TryGetValue(l, out var n) ? n : 0, true);
                if (per != null) foreach (var kv in per) AddLine(kv.Key, kv.Value, false);

                rows.Add(new DepotRow {
                    entity       = depot,
                    name         = m_Names.GetName(depot),
                    type         = (int)data.m_TransportType,
                    available    = td.m_AvailableVehicles,
                    owned        = em.HasBuffer<OwnedVehicle>(depot) ? em.GetBuffer<OwnedVehicle>(depot, true).Length : 0,
                    capacity     = data.m_VehicleCapacity,
                    hasAvailable = (td.m_Flags & TransportDepotFlags.HasAvailableVehicles) != 0,
                    starved      = starved,
                    lines        = dl.ToArray(),
                });
            }
            depots.Dispose();
            return rows.ToArray();
        }

        private DepotInfo[] ReadDepots() {
            var em   = EntityManager;
            var line = m_Selected.Value;
            if (!IsLine(line)) return System.Array.Empty<DepotInfo>();
            var lineData = em.GetComponentData<TransportLineData>(em.GetComponentData<PrefabRef>(line).m_Prefab);

            // Which depot each of the line's vehicles belongs to, for the "serving" column.
            var serving = new Dictionary<Entity, int>();
            if (em.HasBuffer<RouteVehicle>(line)) {
                foreach (var rv in em.GetBuffer<RouteVehicle>(line, true)) {
                    if (!em.HasComponent<Owner>(rv.m_Vehicle)) continue;
                    var owner = em.GetComponentData<Owner>(rv.m_Vehicle).m_Owner;
                    serving[owner] = serving.TryGetValue(owner, out var n) ? n + 1 : 1;
                }
            }

            var depots = m_DepotQuery.ToEntityArray(Allocator.Temp);
            var rows   = new List<DepotInfo>();
            foreach (var depot in depots) {
                var prefab = em.GetComponentData<PrefabRef>(depot).m_Prefab;
                if (!em.HasComponent<TransportDepotData>(prefab)) continue;
                var data = em.GetComponentData<TransportDepotData>(prefab);
                if (data.m_TransportType != lineData.m_TransportType) continue;
                var td = em.GetComponentData<Game.Buildings.TransportDepot>(depot);
                rows.Add(new DepotInfo {
                    entity    = depot,
                    name      = m_Names.GetName(depot),
                    type      = (int)data.m_TransportType,
                    available = td.m_AvailableVehicles,
                    owned     = em.HasBuffer<OwnedVehicle>(depot) ? em.GetBuffer<OwnedVehicle>(depot, true).Length : 0,
                    serving   = serving.TryGetValue(depot, out var s) ? s : 0,
                });
            }
            depots.Dispose();
            return rows.ToArray();
        }

        /// <summary>Sets (or, with Null, clears) the depot <paramref name="line"/> prefers.</summary>
        private void SetPreferredDepot(Entity line, Entity depot) {
            var em = EntityManager;
            if (!IsLine(line)) return;
            if (depot == Entity.Null || !em.Exists(depot) || !em.HasComponent<Game.Buildings.TransportDepot>(depot)) {
                if (em.HasComponent<TP_PreferredDepot>(line)) em.RemoveComponent<TP_PreferredDepot>(line);
                m_Log.Debug($"setPreferredDepot for {line}: cleared");
                return;
            }
            if (em.HasComponent<TP_PreferredDepot>(line)) em.SetComponentData(line, new TP_PreferredDepot { m_Depot = depot });
            else em.AddComponentData(line, new TP_PreferredDepot { m_Depot = depot });
            m_Log.Debug($"setPreferredDepot for {line}: {depot}");
        }
    }
}
