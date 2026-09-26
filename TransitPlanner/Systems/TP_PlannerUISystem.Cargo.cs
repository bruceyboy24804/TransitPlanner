namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Economy;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Simulation;
    using Game.UI;
    using Game.UI.InGame;
    using Game.Vehicles;

    using Unity.Entities;
    using Unity.Mathematics;

    using TransitPlanner.Components;
    using TransitPlanner.Domain;

    // More usings than this file needs, on purpose: the SystemAPI source generator emits the
    // system's rewritten query code (OnCreate, Depot.cs's builder…) under the usings of the
    // alphabetically first partial file, and "Cargo" sorts first. Missing ones broke the build
    // with "NameSystem / TP_PreferredDepot not found" errors pointing at other files.

    #endregion

    /// <summary>
    /// Freight planning for the selected line when it is a cargo line: what its vehicles carry now
    /// (per resource, against their cargo capacity, and how many run empty), what is moving on
    /// each leg (the cargo aboard the vehicles heading to each stop, against their capacity), and
    /// each stop's station: what it holds, against its capacity, with the game's own
    /// surplus / normal / deficit rating per resource.
    /// </summary>
    /// <remarks>
    /// Read the way vanilla's <c>CargoSection</c> and <c>StorageSection</c> read it (see
    /// <see cref="CargoMath"/>). A station's stock is the <c>Resources</c> buffer on the stop's
    /// owning building; its capacity is <c>StorageLimitData</c> combined over installed upgrades
    /// (<c>UpgradeUtils.TryGetCombinedComponent</c>, as the storage section does), split evenly
    /// over the resources the station stores (<c>StorageCompanyData.m_StoredResources</c>) for the
    /// per-resource limit; the rating is <c>UIResource</c>'s own, built with
    /// <c>StorageType.Cargo</c>, so it matches the game's panel. Recomputed every 20 UI frames.
    /// </remarks>
    public partial class TP_PlannerUISystem {
        private CargoInfo      m_Cargo = new CargoInfo();
        private int            m_CargoFrame = -1;
        private const int      kCargoEveryFrames = 20;
        private ResourceSystem m_ResourceSystem;

        private void CreateCargoBindings() {
            m_ResourceSystem = World.GetOrCreateSystemManaged<ResourceSystem>();
            CreateBinding("cargo", ReadCargo);
        }

        private CargoInfo ReadCargo() {
            var frame = UnityEngine.Time.frameCount;
            var line  = m_Selected.Value;
            if (frame - m_CargoFrame < kCargoEveryFrames && m_Cargo.entity == line) return m_Cargo;
            m_CargoFrame = frame;

            var em   = EntityManager;
            var info = new CargoInfo { entity = line };
            if (!IsLine(line)) return m_Cargo = info;
            var prefab = em.GetComponentData<PrefabRef>(line).m_Prefab;
            if (!em.HasComponent<TransportLineData>(prefab) || !em.GetComponentData<TransportLineData>(prefab).m_CargoTransport) return m_Cargo = info;
            info.valid = true;

            // Stops in order (corners skipped) and their waypoint indices, as the network reads them.
            var waypoints = em.GetBuffer<RouteWaypoint>(line, true);
            var stopWps   = new List<int>();
            var stopEnts  = new List<Entity>();
            for (var w = 0; w < waypoints.Length; w++) {
                var wp = waypoints[w].m_Waypoint;
                if (!em.HasComponent<Connected>(wp)) continue;
                var stop = em.GetComponentData<Connected>(wp).m_Connected;
                if (stop == Entity.Null) continue;
                stopWps.Add(w); stopEnts.Add(stop);
            }

            var n = stopEnts.Count;
            var aboard      = new Dictionary<Resource, int>();
            var perLeg      = new List<Dictionary<Resource, int>>();
            var legVehicles = new int[n];
            var legCarried  = new int[n];
            var legCapacity = new int[n];
            for (var k = 0; k < n; k++) perLeg.Add(new Dictionary<Resource, int>());

            if (em.HasBuffer<RouteVehicle>(line)) {
                foreach (var rv in em.GetBuffer<RouteVehicle>(line, true)) {
                    var v = rv.m_Vehicle;
                    if (v == Entity.Null || !em.Exists(v)) continue;
                    var mine = new Dictionary<Resource, int>();
                    CargoMath.Vehicle(em, v, mine, out var carried, out var capacity);
                    info.vehicles++;
                    info.carried  += carried;
                    info.capacity += capacity;
                    if (carried == 0) info.emptyVehicles++;
                    foreach (var kv in mine) { aboard.TryGetValue(kv.Key, out var a); aboard[kv.Key] = a + kv.Value; }
                    // The leg a vehicle is on is the one ending at the stop it is heading to.
                    var next = NextStopOf(v, waypoints, stopWps);
                    if (next < 0 || n == 0) continue;
                    var leg = (next + n - 1) % n;
                    legVehicles[leg]++;
                    legCarried[leg]  += carried;
                    legCapacity[leg] += capacity;
                    foreach (var kv in mine) { perLeg[leg].TryGetValue(kv.Key, out var a); perLeg[leg][kv.Key] = a + kv.Value; }
                }
            }
            info.aboard = CargoMath.Sorted(aboard);

            var prefabs = m_ResourceSystem.GetPrefabs();
            info.stops = new CargoStop[n];
            for (var k = 0; k < n; k++) {
                var stop = stopEnts[k];
                var building = em.HasComponent<Owner>(stop) ? em.GetComponentData<Owner>(stop).m_Owner : Entity.Null;
                var cs = new CargoStop {
                    stop        = stop,
                    waypoint    = stopWps[k],
                    name        = m_Names.GetName(stop),
                    station     = building,
                    stationName = building != Entity.Null ? m_Names.GetName(building) : default,
                    legVehicles = legVehicles[k],
                    legCarried  = legCarried[k],
                    legCapacity = legCapacity[k],
                    leg         = CargoMath.Sorted(perLeg[k]),
                    stock       = System.Array.Empty<ResourceAmount>(),
                };
                if (building != Entity.Null && em.HasBuffer<Resources>(building) && em.HasComponent<PrefabRef>(building)) {
                    var bPrefab = em.GetComponentData<PrefabRef>(building).m_Prefab;
                    var limit = UpgradeUtils.TryGetCombinedComponent<Game.Companies.StorageLimitData>(em, building, bPrefab, out var sl) ? sl.m_Limit : 0;
                    var perResource = limit;
                    if (UpgradeUtils.TryGetCombinedComponent<StorageCompanyData>(em, building, bPrefab, out var sc)) {
                        var count = EconomyUtils.CountResources(sc.m_StoredResources);
                        perResource = count == 0 ? limit : limit / count;
                    }
                    var stock = new List<ResourceAmount>();
                    var stored = 0;
                    foreach (var r in em.GetBuffer<Resources>(building, true)) {
                        if (r.m_Resource == Resource.NoResource || r.m_Amount <= 0) continue;
                        stored += r.m_Amount;
                        var ui = new UIResource(r.m_Resource, r.m_Amount, perResource, UIResource.StorageType.Cargo, em, prefabs);
                        stock.Add(new ResourceAmount { key = CargoMath.Id(r.m_Resource), amount = r.m_Amount, status = ui.status.ToString() });
                    }
                    stock.Sort((a, b) => b.amount.CompareTo(a.amount));
                    cs.stock    = stock.ToArray();
                    cs.stored   = stored;
                    cs.capacity = limit;
                }
                info.stops[k] = cs;
            }
            return m_Cargo = info;
        }

        /// <summary>Position in the stop order of the next stop a vehicle is heading to, walking forward past corners; −1 if unknown.</summary>
        private int NextStopOf(Entity vehicle, DynamicBuffer<RouteWaypoint> waypoints, List<int> stopWps) {
            var em = EntityManager;
            if (!em.HasComponent<Target>(vehicle) || stopWps.Count == 0) return -1;
            var target = em.GetComponentData<Target>(vehicle).m_Target;
            var wi = -1;
            for (var i = 0; i < waypoints.Length; i++) if (waypoints[i].m_Waypoint == target) { wi = i; break; }
            if (wi < 0) return -1;
            for (var k = 0; k < waypoints.Length; k++) {
                var idx = stopWps.IndexOf((wi + k) % waypoints.Length);
                if (idx >= 0) return idx;
            }
            return -1;
        }
    }
}
