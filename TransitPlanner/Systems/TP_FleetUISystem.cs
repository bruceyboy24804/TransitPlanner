namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Buildings;
    using Game.City;
    using Game.Common;
    using Game.Economy;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Tools;
    using Game.UI;
    using Game.UI.InGame;
    using Game.Vehicles;

    using Unity.Collections;
    using Unity.Entities;

    using ModsCommon.Systems;

    using TransitPlanner.Components;
    using TransitPlanner.Domain;

    #endregion

    /// <summary>
    /// The fleet manager: every line in one table, and edits applied to many lines at once.
    /// </summary>
    /// <remarks>
    /// Reads are the same lookups the planner uses plus each line's <c>VehicleModel</c> buffer.
    /// The model catalogue per transport type comes from vanilla's own lister,
    /// <see cref="TransportVehicleSelectData"/>, fed the same inputs <c>SelectVehiclesSection</c>
    /// feeds it (energy types OR'd over that type's depots, size class from the line prefab).
    ///
    /// Writes: models are edited with the exact algorithm of vanilla's
    /// <c>SelectVehiclesSection.SelectVehicleModel</c> / <c>DeselectVehicleModel</c>, applied to the
    /// chosen lines instead of the info panel's selection (those triggers are bound to
    /// <c>selectedEntity</c>, so they cannot be reused for a bulk edit). Options (Paid ticket,
    /// Day, Night, Inactive) go through <c>PoliciesUISystem.SetPolicy</c>.
    /// </remarks>
    public partial class TP_FleetUISystem : CommonUISystemBase {
        /// <inheritdoc/>
        protected override string ModId => Mod.Instance.Id;

        private NameSystem              m_Names;
        private PrefabSystem            m_Prefabs;
        private ImageSystem             m_Images;
        private PoliciesUISystem        m_Policies;
        private SelectedInfoUISystem    m_SelectedInfo;
        private CityConfigurationSystem m_CityConfiguration;

        private EntityQuery m_LineQuery;
        private EntityQuery m_DepotQuery;
        private EntityQuery m_VehiclePrefabQuery;
        private EntityQuery m_RouteOptionPolicyQuery;

        private TransportVehicleSelectData m_SelectData;
        private NativeList<Entity>         m_PrimaryScratch;
        private NativeList<Entity>         m_SecondaryScratch;

        // The catalogue depends on prefabs (static) and depots (rare); rebuild it on a slow clock.
        private ModelCatalog[] m_Catalog = System.Array.Empty<ModelCatalog>();
        private uint           m_CatalogFrame;
        private const uint     kCatalogRefreshFrames = 300;

        /// <inheritdoc/>
        protected override void OnCreate() {
            base.OnCreate();
            m_Names             = World.GetOrCreateSystemManaged<NameSystem>();
            m_Prefabs           = World.GetOrCreateSystemManaged<PrefabSystem>();
            m_Images            = World.GetOrCreateSystemManaged<ImageSystem>();
            m_Policies          = World.GetOrCreateSystemManaged<PoliciesUISystem>();
            m_SelectedInfo      = World.GetOrCreateSystemManaged<SelectedInfoUISystem>();
            m_CityConfiguration = World.GetOrCreateSystemManaged<CityConfigurationSystem>();

            m_LineQuery = SystemAPI.QueryBuilder()
                                   .WithAll<Route, TransportLine, PrefabRef>()
                                   .WithNone<Temp, Deleted>()
                                   .Build();
            m_DepotQuery = SystemAPI.QueryBuilder()
                                    .WithAll<Game.Buildings.TransportDepot, PrefabRef>()
                                    .WithNone<Temp, Deleted>()
                                    .Build();
            // Vanilla's own description of "a pickable transport vehicle prefab" (excludes Locked).
            m_VehiclePrefabQuery     = GetEntityQuery(TransportVehicleSelectData.GetEntityQueryDesc());
            m_RouteOptionPolicyQuery = SystemAPI.QueryBuilder().WithAll<PolicyData, RouteOptionData>().Build();

            m_SelectData       = new TransportVehicleSelectData(this);
            m_PrimaryScratch   = new NativeList<Entity>(32, Allocator.Persistent);
            m_SecondaryScratch = new NativeList<Entity>(32, Allocator.Persistent);

            CreateBinding("fleet", ReadFleet);
            CreateBinding("models", ReadCatalog);

            CreateTrigger<Entity[], Entity, Entity>("addModel", AddModel);
            CreateTrigger<Entity[], Entity, Entity>("removeModel", RemoveModel);
            CreateTrigger<Entity[], Entity[], Entity[]>("setModels", SetModels);
            CreateTrigger<Entity[], int, bool>("setOption", SetOption);
        }

        /// <inheritdoc/>
        protected override void OnDestroy() {
            m_PrimaryScratch.Dispose();
            m_SecondaryScratch.Dispose();
            base.OnDestroy();
        }

        #region Reads

        private FleetRow[] ReadFleet() {
            var em       = EntityManager;
            var entities = m_LineQuery.ToEntityArray(Allocator.Temp);
            var rows     = new List<FleetRow>(entities.Length);

            foreach (var line in entities) {
                var prefab = em.GetComponentData<PrefabRef>(line).m_Prefab;
                if (!em.HasComponent<TransportLineData>(prefab)) continue;

                var lineData = em.GetComponentData<TransportLineData>(prefab);
                var tl       = em.GetComponentData<TransportLine>(line);
                var route    = em.GetComponentData<Route>(line);
                var riders   = 0;
                var capacity = 0;
                var fleet    = TransportUIUtils.GetRouteVehiclesCount(em, line, ref riders, ref capacity);

                var primary   = new List<Entity>();
                var secondary = new List<Entity>();
                if (em.HasBuffer<VehicleModel>(line)) {
                    foreach (var model in em.GetBuffer<VehicleModel>(line, true)) {
                        if (model.m_PrimaryPrefab   != Entity.Null) primary.Add(model.m_PrimaryPrefab);
                        if (model.m_SecondaryPrefab != Entity.Null) secondary.Add(model.m_SecondaryPrefab);
                    }
                }

                var interval = lineData.m_DefaultVehicleInterval;
                if (em.HasBuffer<RouteModifier>(line)) {
                    RouteUtils.ApplyModifier(ref interval, em.GetBuffer<RouteModifier>(line, true), RouteModifierType.VehicleInterval);
                }
                var pathInfo = GetComponentLookup<Game.Pathfind.PathInformation>(true);
                var timing   = GetComponentLookup<VehicleTiming>(true);
                var stable   = LineMath.StableDuration(em.GetBuffer<RouteWaypoint>(line, true), em.GetBuffer<RouteSegment>(line, true), lineData, pathInfo, timing);

                var peakLoad = 0f; var peakHour = -1; var lowLoad = float.MaxValue; var maxWait = 0f; var sampled = 0;
                if (em.HasBuffer<TP_LoadSample>(line)) {
                    var hist = em.GetBuffer<TP_LoadSample>(line, true);
                    for (var h = 0; h < hist.Length; h++) {
                        if (hist[h].m_Samples == 0) continue;
                        sampled++;
                        if (hist[h].m_Load > peakLoad) { peakLoad = hist[h].m_Load; peakHour = h; }
                        if (hist[h].m_Load < lowLoad) lowLoad = hist[h].m_Load;
                        if (hist[h].m_Wait > maxWait) maxWait = hist[h].m_Wait;
                    }
                }
                if (sampled == 0) lowLoad = 0f;

                // Cargo lines: what is aboard and how many run empty (CargoMath, as vanilla's CargoSection).
                var carrying = System.Array.Empty<ResourceAmount>();
                var emptyVehicles = 0;
                if (lineData.m_CargoTransport && em.HasBuffer<RouteVehicle>(line)) {
                    var byRes = new Dictionary<Game.Economy.Resource, int>();
                    foreach (var rv in em.GetBuffer<RouteVehicle>(line, true)) {
                        CargoMath.Vehicle(em, rv.m_Vehicle, byRes, out var carried, out _);
                        if (carried == 0) emptyVehicles++;
                    }
                    carrying = CargoMath.Sorted(byRes, 3);
                }

                var onTime = -1f; var late = 0f;
                if (em.HasComponent<TP_Timetable>(line) && em.HasBuffer<TP_Punctuality>(line)) {
                    TimetableMath.Summarise(em.GetBuffer<TP_Punctuality>(line, true), out onTime, out late, out _);
                }

                rows.Add(new FleetRow {
                    entity            = line,
                    name              = m_Names.GetName(line),
                    color             = em.HasComponent<Color>(line) ? (UnityEngine.Color)em.GetComponentData<Color>(line).m_Color : UnityEngine.Color.white,
                    type              = (int)lineData.m_TransportType,
                    cargo             = lineData.m_CargoTransport && !lineData.m_PassengerTransport,
                    stops             = TransportUIUtils.GetStopCount(em, line),
                    length            = TransportUIUtils.GetRouteLength(em, line),
                    visible           = !em.HasComponent<HiddenRoute>(line),
                    fleet             = fleet,
                    target            = LineMath.FleetFor(interval, stable),
                    headway           = tl.m_VehicleInterval,
                    riders            = riders,
                    capacity          = capacity,
                    paidTicket        = RouteUtils.CheckOption(route, RouteOption.PaidTicket),
                    ticketPrice       = tl.m_TicketPrice,
                    notEnoughVehicles = (tl.m_Flags & TransportLineFlags.NotEnoughVehicles) != 0,
                    inactive          = RouteUtils.CheckOption(route, RouteOption.Inactive),
                    dayOnly           = RouteUtils.CheckOption(route, RouteOption.Day),
                    nightOnly         = RouteUtils.CheckOption(route, RouteOption.Night),
                    scheduled         = em.HasComponent<TP_LineSchedule>(line) && em.GetComponentData<TP_LineSchedule>(line).Enabled,
                    peakLoad          = peakLoad,
                    peakHour          = peakHour,
                    lowLoad           = lowLoad,
                    maxWait           = maxWait,
                    sampledHours      = sampled,
                    onTime            = onTime,
                    carrying          = carrying,
                    emptyVehicles     = emptyVehicles,
                    late              = late,
                    primaryModels     = primary.ToArray(),
                    secondaryModels   = secondary.ToArray(),
                });
            }

            entities.Dispose();
            return rows.ToArray();
        }

        private ModelCatalog[] ReadCatalog() {
            var frame = (uint)UnityEngine.Time.frameCount;
            if (m_Catalog.Length > 0 && frame - m_CatalogFrame < kCatalogRefreshFrames) return m_Catalog;
            m_CatalogFrame = frame;

            var em = EntityManager;

            // One catalogue per (transport type, size class, cargo/passenger) actually in use.
            var wanted = new Dictionary<(TransportType, SizeClass, bool), TransportLineData>();
            var lines  = m_LineQuery.ToEntityArray(Allocator.Temp);
            foreach (var line in lines) {
                var prefab = em.GetComponentData<PrefabRef>(line).m_Prefab;
                if (!em.HasComponent<TransportLineData>(prefab)) continue;
                var data = em.GetComponentData<TransportLineData>(prefab);
                wanted[(data.m_TransportType, data.m_SizeClass, data.m_CargoTransport && !data.m_PassengerTransport)] = data;
            }
            lines.Dispose();
            if (wanted.Count == 0) return m_Catalog = System.Array.Empty<ModelCatalog>();

            // Energy types per transport type, OR'd over depots the way SelectVehiclesSection's
            // TransportDepots job does (upgrades included via UpgradeUtils.CombineStats).
            var energy    = new Dictionary<TransportType, EnergyTypes>();
            var depots    = m_DepotQuery.ToEntityArray(Allocator.Temp);
            var prefabRef = GetComponentLookup<PrefabRef>(true);
            var depotData = GetComponentLookup<TransportDepotData>(true);
            foreach (var depot in depots) {
                if (!depotData.TryGetComponent(prefabRef[depot].m_Prefab, out var data)) continue;
                if (em.HasBuffer<InstalledUpgrade>(depot)) {
                    UpgradeUtils.CombineStats(ref data, em.GetBuffer<InstalledUpgrade>(depot, true), ref prefabRef, ref depotData);
                }
                energy.TryGetValue(data.m_TransportType, out var current);
                energy[data.m_TransportType] = current | data.m_EnergyTypes;
            }
            depots.Dispose();

            var catalog = new List<ModelCatalog>(wanted.Count);
            m_SelectData.PreUpdate(this, m_CityConfiguration, m_VehiclePrefabQuery, Allocator.TempJob, out var deps);
            deps.Complete();
            foreach (var kv in wanted) {
                var (type, size, cargo) = kv.Key;
                energy.TryGetValue(type, out var energyTypes);
                m_PrimaryScratch.Clear();
                m_SecondaryScratch.Clear();
                m_SelectData.ListVehicles(type, energyTypes, size,
                                          cargo ? 0 : PublicTransportPurpose.TransportLine,
                                          cargo ? unchecked((Resource)(-1)) : Resource.NoResource,
                                          m_PrimaryScratch, m_SecondaryScratch, ignoreTheme: true);
                catalog.Add(new ModelCatalog {
                    type      = (int)type,
                    cargo     = cargo,
                    primary   = Describe(m_PrimaryScratch),
                    secondary = Describe(m_SecondaryScratch),
                });
            }
            m_SelectData.PostUpdate(default);

            return m_Catalog = catalog.ToArray();
        }

        private ModelInfo[] Describe(NativeList<Entity> prefabs) {
            var em   = EntityManager;
            var list = new ModelInfo[prefabs.Length];
            for (var i = 0; i < prefabs.Length; i++) {
                var prefab = prefabs[i];
                list[i] = new ModelInfo {
                    entity   = prefab,
                    name     = m_Names.GetName(prefab),
                    id       = m_Prefabs.GetPrefabName(prefab),
                    capacity = em.HasComponent<PublicTransportVehicleData>(prefab) ? em.GetComponentData<PublicTransportVehicleData>(prefab).m_PassengerCapacity
                             : em.HasComponent<CargoTransportVehicleData>(prefab) ? em.GetComponentData<CargoTransportVehicleData>(prefab).m_CargoCapacity : 0,
                    // Same call as SelectVehiclesSection.WriteVehicle.
                    thumbnail = m_Images.GetThumbnail(prefab) ?? m_Images.placeholderIcon,
                };
            }
            return list;
        }

        #endregion

        #region Writes

        /// <summary>Vanilla's SelectVehicleModel, on each of <paramref name="lines"/>.</summary>
        private void AddModel(Entity[] lines, Entity primary, Entity secondary) {
            foreach (var line in lines) {
                if (!IsLine(line)) continue;
                var buffer = EntityManager.GetBuffer<VehicleModel>(line);
                var wantP = primary != Entity.Null;
                var wantS = secondary != Entity.Null;
                var doneP = false;
                var doneS = false;
                for (var i = 0; i < buffer.Length; i++) {
                    var value = buffer[i];
                    if (wantP && !doneP && value.m_PrimaryPrefab == Entity.Null)   { value.m_PrimaryPrefab   = primary;   doneP = true; }
                    if (wantS && !doneS && value.m_SecondaryPrefab == Entity.Null) { value.m_SecondaryPrefab = secondary; doneS = true; }
                    buffer[i] = value;
                    if (doneP & doneS) break;
                }
                if (((wantP && !doneP) & wantS) && !doneS)  buffer.Add(new VehicleModel { m_PrimaryPrefab = primary,     m_SecondaryPrefab = secondary });
                else if (wantP && !doneP)                   buffer.Add(new VehicleModel { m_PrimaryPrefab = primary,     m_SecondaryPrefab = Entity.Null });
                else if (wantS && !doneS)                   buffer.Add(new VehicleModel { m_PrimaryPrefab = Entity.Null, m_SecondaryPrefab = secondary });
                Touched(line);
            }
        }

        /// <summary>Vanilla's DeselectVehicleModel, on each of <paramref name="lines"/>.</summary>
        private void RemoveModel(Entity[] lines, Entity primary, Entity secondary) {
            foreach (var line in lines) {
                if (!IsLine(line)) continue;
                var buffer = EntityManager.GetBuffer<VehicleModel>(line);
                var wantP = primary != Entity.Null;
                var wantS = secondary != Entity.Null;
                var doneP = false;
                var doneS = false;
                for (var i = 0; i < buffer.Length; i++) {
                    var value = buffer[i];
                    if (wantP && !doneP && value.m_PrimaryPrefab == primary)     { value.m_PrimaryPrefab   = Entity.Null; doneP = true; }
                    if (wantS && !doneS && value.m_SecondaryPrefab == secondary) { value.m_SecondaryPrefab = Entity.Null; doneS = true; }
                    if (value.m_PrimaryPrefab == Entity.Null && value.m_SecondaryPrefab == Entity.Null) buffer.RemoveAtSwapBack(i);
                    else buffer[i] = value;
                    if (doneP & doneS) break;
                }
                Touched(line);
            }
        }

        /// <summary>
        /// "Apply this selection to all of these lines": replaces each line's whole model list.
        /// Pairs primary[i] with secondary[i] where both exist, the rest as singles — the same
        /// shape the vanilla buffer ends up in after a series of selects.
        /// </summary>
        private void SetModels(Entity[] lines, Entity[] primary, Entity[] secondary) {
            foreach (var line in lines) {
                if (!IsLine(line)) continue;
                var buffer = EntityManager.GetBuffer<VehicleModel>(line);
                buffer.Clear();
                var n = System.Math.Max(primary.Length, secondary.Length);
                for (var i = 0; i < n; i++) {
                    buffer.Add(new VehicleModel {
                        m_PrimaryPrefab   = i < primary.Length   ? primary[i]   : Entity.Null,
                        m_SecondaryPrefab = i < secondary.Length ? secondary[i] : Entity.Null,
                    });
                }
                Touched(line);
            }
            m_Log.Debug($"setModels: {lines.Length} line(s), {primary.Length} primary, {secondary.Length} secondary");
        }

        /// <summary>Sets a RouteOption policy (PaidTicket / Day / Night / Inactive) on each line.</summary>
        private void SetOption(Entity[] lines, int option, bool active) {
            var policy = RoutePolicies.Find(EntityManager, m_RouteOptionPolicyQuery, (RouteOption)option);
            if (policy == Entity.Null) {
                m_Log.Warn($"setOption: no policy prefab carries RouteOption {(RouteOption)option}");
                return;
            }
            foreach (var line in lines) {
                if (IsLine(line)) m_Policies.SetPolicy(line, policy, active);
            }
            m_Log.Debug($"setOption: {(RouteOption)option}={active} on {lines.Length} line(s)");
        }

        /// <summary>Vanilla refreshes the info panel after a model edit; so do we if it shows this line.</summary>
        private void Touched(Entity line) {
            if (m_SelectedInfo.selectedEntity == line) m_SelectedInfo.RequestUpdate();
        }

        #endregion

        private bool IsLine(Entity e) {
            var em = EntityManager;
            return e != Entity.Null && em.Exists(e) && em.HasComponent<TransportLine>(e) && em.HasBuffer<VehicleModel>(e);
        }
    }
}
