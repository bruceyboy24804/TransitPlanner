namespace TransitPlanner.Patches {
    #region Using Statements

    using Colossal.Collections;

    using Game.Buildings;
    using Game.Common;
    using Game.Objects;
    using Game.Pathfind;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Simulation;
    using Game.Tools;
    using Game.Vehicles;

    using HarmonyLib;

    using Unity.Burst;
    using Unity.Burst.Intrinsics;
    using Unity.Collections;
    using Unity.Entities;
    using Unity.Jobs;
    using Unity.Mathematics;

    using TransitPlanner.Components;

    #endregion

    /// <summary>
    /// Preferred depot per line. Dispatch is a pathfind match: a line's vehicle request seeks every
    /// depot with spare vehicles (and every idle vehicle) of its type, and depots seek requests
    /// the other way; the cheapest pairing wins. Vanilla enumerates the candidates in two Burst
    /// jobs that <c>TransportPathfindSetup</c> schedules from two plain managed methods, so the
    /// mod replaces the scheduling: same enumeration, minus every source that is not the line's
    /// <see cref="TP_PreferredDepot"/>.
    /// </summary>
    /// <remarks>
    /// A hard filter, by the player's choice: only the chosen depot may send vehicles to the line.
    /// When it has none spare the request goes unmatched and vanilla marks the line
    /// <c>NotEnoughVehicles</c> after its retries — the fleet tab shows that flag, which is the
    /// signal to buy more vehicles at that depot or pick another. Both directions filter
    /// (request → depot in <see cref="SetupTransportVehiclesJob"/>, depot → request in
    /// <see cref="TransportVehicleRequestsJob"/>), so the two-sided match agrees. Idle vehicles
    /// are attributed to their <c>Owner</c> depot.
    ///
    /// The job bodies are copies of vanilla's (1.6.2) with the penalty lines added; keep them in
    /// step when the game updates. The queries are re-created through the system's own
    /// <c>GetSetupQuery</c>, which dedupes identical descriptions, so nothing leaks.
    /// </remarks>
    // Patched on the class-level dispatcher, not on TransportPathfindSetup's own methods: that is
    // a struct, and a Harmony prefix returning a JobHandle (a struct) from a struct instance
    // method handed the game a corrupt handle — native crash in the very next Schedule.
    [HarmonyPatch(typeof(PathfindSetupSystem), "FindTargets", new[] { typeof(SetupTargetType), typeof(PathfindSetupSystem.SetupData) }, new[] { ArgumentType.Normal, ArgumentType.Ref })]
    public static class TransportPathfindSetupPatches {
        private static EntityQuery s_VehicleQuery;
        private static EntityQuery s_RequestQuery;
        private static PathfindSetupSystem s_QueryOwner;

        /// <summary><c>SystemBase.Dependency</c> is protected; the prefix needs the same input handle the original uses.</summary>
        private static readonly System.Func<SystemBase, JobHandle> s_GetDependency =
            AccessTools.MethodDelegate<System.Func<SystemBase, JobHandle>>(AccessTools.PropertyGetter(typeof(SystemBase), "Dependency"));

        [HarmonyPrefix]
        public static bool Prefix(PathfindSetupSystem __instance, SetupTargetType targetType, ref PathfindSetupSystem.SetupData setupData, ref JobHandle __result) {
            switch (targetType) {
                case SetupTargetType.TransportVehicle:
                    SetupTransportVehicle(__instance, setupData, s_GetDependency(__instance), ref __result);
                    return false;
                case SetupTargetType.TransportVehicleRequest:
                    SetupTransportVehicleRequest(__instance, setupData, s_GetDependency(__instance), ref __result);
                    return false;
                default:
                    return true;
            }
        }

        private static void EnsureQueries(PathfindSetupSystem system) {
            if (ReferenceEquals(s_QueryOwner, system)) return;
            s_QueryOwner = system;
            s_VehicleQuery = system.GetSetupQuery(new EntityQueryDesc {
                Any  = new[] { ComponentType.ReadOnly<Game.Buildings.TransportDepot>(), ComponentType.ReadOnly<Game.Vehicles.CargoTransport>(), ComponentType.ReadOnly<Game.Vehicles.PublicTransport>() },
                None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Destroyed>(), ComponentType.ReadOnly<Game.Buildings.ServiceUpgrade>(), ComponentType.ReadOnly<Temp>() },
            });
            s_RequestQuery = system.GetSetupQuery(ComponentType.ReadOnly<TransportVehicleRequest>(), ComponentType.Exclude<Dispatched>(), ComponentType.Exclude<PathInformation>());
        }

        private static void SetupTransportVehicle(PathfindSetupSystem system, PathfindSetupSystem.SetupData setupData, JobHandle inputDeps, ref JobHandle __result) {
            EnsureQueries(system);
            __result = JobChunkExtensions.ScheduleParallel(new SetupTransportVehiclesJob {
                m_EntityType                = system.GetEntityTypeHandle(),
                m_TransportDepotType        = system.GetComponentTypeHandle<Game.Buildings.TransportDepot>(true),
                m_CargoTransportType        = system.GetComponentTypeHandle<Game.Vehicles.CargoTransport>(true),
                m_PublicTransportType       = system.GetComponentTypeHandle<Game.Vehicles.PublicTransport>(true),
                m_ControllerType            = system.GetComponentTypeHandle<Controller>(true),
                m_RouteColorType            = system.GetComponentTypeHandle<Game.Routes.Color>(true),
                m_OwnerType                 = system.GetComponentTypeHandle<Owner>(true),
                m_PrefabRefType             = system.GetComponentTypeHandle<PrefabRef>(true),
                m_LayoutElementType         = system.GetBufferTypeHandle<LayoutElement>(true),
                m_TransportVehicleRequestData = system.GetComponentLookup<TransportVehicleRequest>(true),
                m_RouteColorData            = system.GetComponentLookup<Game.Routes.Color>(true),
                m_PrefabTransportDepotData  = system.GetComponentLookup<TransportDepotData>(true),
                m_TransportLineData         = system.GetComponentLookup<TransportLineData>(true),
                m_MultipleUnitTrainData     = system.GetComponentLookup<MultipleUnitTrainData>(true),
                m_VehicleModels             = system.GetBufferLookup<VehicleModel>(true),
                m_PreferredDepotData        = system.GetComponentLookup<TP_PreferredDepot>(true),
                m_SetupData                 = setupData,
            }, s_VehicleQuery, inputDeps);
        }

        private static void SetupTransportVehicleRequest(PathfindSetupSystem system, PathfindSetupSystem.SetupData setupData, JobHandle inputDeps, ref JobHandle __result) {
            EnsureQueries(system);
            __result = JobChunkExtensions.ScheduleParallel(new TransportVehicleRequestsJob {
                m_EntityType                  = system.GetEntityTypeHandle(),
                m_ServiceRequestType          = system.GetComponentTypeHandle<ServiceRequest>(true),
                m_TransportVehicleRequestType = system.GetComponentTypeHandle<TransportVehicleRequest>(true),
                m_TransportVehicleRequestData = system.GetComponentLookup<TransportVehicleRequest>(true),
                m_PublicTransportData         = system.GetComponentLookup<Game.Vehicles.PublicTransport>(true),
                m_CargoTransportData          = system.GetComponentLookup<Game.Vehicles.CargoTransport>(true),
                m_TransportLineData           = system.GetComponentLookup<TransportLineData>(true),
                m_TransportDepotData          = system.GetComponentLookup<TransportDepotData>(true),
                m_MultipleUnitTrainData       = system.GetComponentLookup<MultipleUnitTrainData>(true),
                m_Waypoints                   = system.GetBufferLookup<RouteWaypoint>(true),
                m_VehicleModels               = system.GetBufferLookup<VehicleModel>(true),
                m_PreferredDepotData          = system.GetComponentLookup<TP_PreferredDepot>(true),
                m_SetupData                   = setupData,
            }, s_RequestQuery, inputDeps);
        }

        /// <summary>True when <paramref name="line"/> is bound to a depot other than <paramref name="depot"/>.</summary>
        private static bool Excluded(ref ComponentLookup<TP_PreferredDepot> preferred, Entity line, Entity depot) {
            return preferred.TryGetComponent(line, out var p) && p.m_Depot != Entity.Null && p.m_Depot != depot;
        }

        /// <summary>Copy of vanilla's job: a line's request seeking depots (branch 1) and idle vehicles (branch 2).</summary>
        [BurstCompile]
        private struct SetupTransportVehiclesJob : IJobChunk {
            [ReadOnly] public EntityTypeHandle m_EntityType;
            [ReadOnly] public ComponentTypeHandle<Game.Buildings.TransportDepot> m_TransportDepotType;
            [ReadOnly] public ComponentTypeHandle<Game.Vehicles.CargoTransport> m_CargoTransportType;
            [ReadOnly] public ComponentTypeHandle<Game.Vehicles.PublicTransport> m_PublicTransportType;
            [ReadOnly] public ComponentTypeHandle<Controller> m_ControllerType;
            [ReadOnly] public ComponentTypeHandle<Game.Routes.Color> m_RouteColorType;
            [ReadOnly] public ComponentTypeHandle<Owner> m_OwnerType;
            [ReadOnly] public ComponentTypeHandle<PrefabRef> m_PrefabRefType;
            [ReadOnly] public BufferTypeHandle<LayoutElement> m_LayoutElementType;
            [ReadOnly] public ComponentLookup<TransportVehicleRequest> m_TransportVehicleRequestData;
            [ReadOnly] public ComponentLookup<Game.Routes.Color> m_RouteColorData;
            [ReadOnly] public ComponentLookup<TransportDepotData> m_PrefabTransportDepotData;
            [ReadOnly] public ComponentLookup<TransportLineData> m_TransportLineData;
            [ReadOnly] public ComponentLookup<MultipleUnitTrainData> m_MultipleUnitTrainData;
            [ReadOnly] public BufferLookup<VehicleModel> m_VehicleModels;
            [ReadOnly] public ComponentLookup<TP_PreferredDepot> m_PreferredDepotData;
            public PathfindSetupSystem.SetupData m_SetupData;

            public void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex, bool useEnabledMask, in v128 chunkEnabledMask) {
                var entities = chunk.GetNativeArray(m_EntityType);
                var depots   = chunk.GetNativeArray(ref m_TransportDepotType);
                if (depots.Length != 0) {
                    var prefabRefs = chunk.GetNativeArray(ref m_PrefabRefType);
                    for (var i = 0; i < m_SetupData.Length; i++) {
                        m_SetupData.GetItem(i, out _, out var owner, out var seeker);
                        m_TransportVehicleRequestData.TryGetComponent(owner, out var request);
                        var lineData = default(TransportLineData);
                        if (seeker.m_PrefabRef.TryGetComponent(request.m_Route, out var linePrefab)) {
                            m_TransportLineData.TryGetComponent(linePrefab.m_Prefab, out lineData);
                        }
                        for (var j = 0; j < depots.Length; j++) {
                            if ((depots[j].m_Flags & TransportDepotFlags.HasAvailableVehicles) == 0) continue;
                            if (!m_PrefabTransportDepotData.TryGetComponent(prefabRefs[j].m_Prefab, out var depotData) || depotData.m_TransportType != lineData.m_TransportType) continue;
                            var depot = entities[j];
                            // Preferred depot: no other depot may send vehicles to this line.
                            if (Excluded(ref m_PreferredDepotData, request.m_Route, depot)) continue;
                            seeker.FindTargets(depot, seeker.m_PathfindParameters.m_Weights.time * 10f);
                        }
                    }
                    return;
                }

                if (!chunk.Has(ref m_OwnerType)) return;
                var cargos      = chunk.GetNativeArray(ref m_CargoTransportType);
                var publics     = chunk.GetNativeArray(ref m_PublicTransportType);
                var controllers = chunk.GetNativeArray(ref m_ControllerType);
                var colours     = chunk.GetNativeArray(ref m_RouteColorType);
                var vehPrefabs  = chunk.GetNativeArray(ref m_PrefabRefType);
                var owners      = chunk.GetNativeArray(ref m_OwnerType);
                var layouts     = chunk.GetBufferAccessor(ref m_LayoutElementType);
                for (var k = 0; k < m_SetupData.Length; k++) {
                    m_SetupData.GetItem(k, out _, out var owner, out var seeker);
                    m_TransportVehicleRequestData.TryGetComponent(owner, out var request);
                    var lineData = default(TransportLineData);
                    if (seeker.m_PrefabRef.TryGetComponent(request.m_Route, out var linePrefab)) {
                        m_TransportLineData.TryGetComponent(linePrefab.m_Prefab, out lineData);
                    }
                    var hasModels = m_VehicleModels.TryGetBuffer(request.m_Route, out var models);
                    var hasColour = m_RouteColorData.TryGetComponent(request.m_Route, out var lineColour);
                    if (cargos.Length != 0 != lineData.m_CargoTransport || publics.Length != 0 != lineData.m_PassengerTransport) continue;
                    for (var l = 0; l < entities.Length; l++) {
                        var vehicle = entities[l];
                        var cost    = 0f;
                        if (controllers.Length != 0) {
                            var controller = controllers[l];
                            if (controller.m_Controller != Entity.Null && controller.m_Controller != vehicle) continue;
                        }
                        if (cargos.Length != 0) {
                            var cargo = cargos[l];
                            if (cargo.m_RequestCount > 0 || (cargo.m_State & (CargoTransportFlags.EnRoute | CargoTransportFlags.RequiresMaintenance | CargoTransportFlags.DummyTraffic | CargoTransportFlags.Disabled)) != 0) continue;
                        }
                        if (publics.Length != 0) {
                            var pt = publics[l];
                            if (pt.m_RequestCount > 0 || (pt.m_State & (PublicTransportFlags.EnRoute | PublicTransportFlags.Evacuating | PublicTransportFlags.PrisonerTransport | PublicTransportFlags.RequiresMaintenance | PublicTransportFlags.DummyTraffic | PublicTransportFlags.Disabled)) != 0) continue;
                        }
                        if (hasModels) {
                            var prefabRef = vehPrefabs[l];
                            var layout    = default(DynamicBuffer<LayoutElement>);
                            if (layouts.Length != 0) layout = layouts[l];
                            if (!RouteUtils.CheckVehicleModel(models, prefabRef, layout, ref seeker.m_PrefabRef, ref m_MultipleUnitTrainData)) continue;
                        }
                        if (CollectionUtils.TryGet(colours, l, out var colour)) {
                            if (hasColour && lineColour.m_Color.r == colour.m_Color.r && lineColour.m_Color.g == colour.m_Color.g && lineColour.m_Color.b == colour.m_Color.b && lineColour.m_Color.a == colour.m_Color.a) {
                                cost -= seeker.m_PathfindParameters.m_Weights.time * 10f;
                            }
                        } else {
                            cost -= seeker.m_PathfindParameters.m_Weights.time * math.select(10f, 5f, hasColour);
                        }
                        // Preferred depot: an idle vehicle belongs to its owner depot.
                        if (Excluded(ref m_PreferredDepotData, request.m_Route, owners[l].m_Owner)) continue;
                        seeker.FindTargets(vehicle, cost);
                    }
                }
            }
        }

        /// <summary>Copy of vanilla's job: a depot (or idle vehicle) seeking open line requests.</summary>
        [BurstCompile]
        private struct TransportVehicleRequestsJob : IJobChunk {
            [ReadOnly] public EntityTypeHandle m_EntityType;
            [ReadOnly] public ComponentTypeHandle<ServiceRequest> m_ServiceRequestType;
            [ReadOnly] public ComponentTypeHandle<TransportVehicleRequest> m_TransportVehicleRequestType;
            [ReadOnly] public ComponentLookup<TransportVehicleRequest> m_TransportVehicleRequestData;
            [ReadOnly] public ComponentLookup<Game.Vehicles.PublicTransport> m_PublicTransportData;
            [ReadOnly] public ComponentLookup<Game.Vehicles.CargoTransport> m_CargoTransportData;
            [ReadOnly] public ComponentLookup<TransportLineData> m_TransportLineData;
            [ReadOnly] public ComponentLookup<TransportDepotData> m_TransportDepotData;
            [ReadOnly] public ComponentLookup<MultipleUnitTrainData> m_MultipleUnitTrainData;
            [ReadOnly] public BufferLookup<RouteWaypoint> m_Waypoints;
            [ReadOnly] public BufferLookup<VehicleModel> m_VehicleModels;
            [ReadOnly] public ComponentLookup<TP_PreferredDepot> m_PreferredDepotData;
            public PathfindSetupSystem.SetupData m_SetupData;

            public void Execute(in ArchetypeChunk chunk, int unfilteredChunkIndex, bool useEnabledMask, in v128 chunkEnabledMask) {
                var entities = chunk.GetNativeArray(m_EntityType);
                var services = chunk.GetNativeArray(ref m_ServiceRequestType);
                var requests = chunk.GetNativeArray(ref m_TransportVehicleRequestType);
                for (var i = 0; i < m_SetupData.Length; i++) {
                    m_SetupData.GetItem(i, out _, out var owner, out var seeker);
                    // In this direction the request's "route" is the depot or vehicle offering itself.
                    if (!m_TransportVehicleRequestData.TryGetComponent(owner, out var offer) || !seeker.m_PrefabRef.TryGetComponent(offer.m_Route, out var sourcePrefab)) continue;
                    var isDepot = false;
                    var isPublic = false;
                    var isCargo = false;
                    var layout = default(DynamicBuffer<LayoutElement>);
                    if (m_TransportDepotData.TryGetComponent(sourcePrefab.m_Prefab, out var depotData)) {
                        isDepot = true;
                    } else {
                        isPublic = m_PublicTransportData.HasComponent(offer.m_Route);
                        isCargo  = m_CargoTransportData.HasComponent(offer.m_Route);
                        seeker.m_VehicleLayout.TryGetBuffer(offer.m_Route, out layout);
                    }
                    if (!isDepot && !isPublic && !isCargo) continue;
                    // The depot this source belongs to, for the preference check.
                    var sourceDepot = offer.m_Route;
                    if (!isDepot && seeker.m_Owner.TryGetComponent(offer.m_Route, out var vehicleOwner)) sourceDepot = vehicleOwner.m_Owner;

                    for (var j = 0; j < requests.Length; j++) {
                        if ((services[j].m_Flags & ServiceRequestFlags.Reversed) != 0) continue;
                        var request = requests[j];
                        if (!seeker.m_PrefabRef.TryGetComponent(request.m_Route, out var linePrefab) || !m_TransportLineData.TryGetComponent(linePrefab.m_Prefab, out var lineData)) continue;
                        if (isDepot) {
                            if (lineData.m_TransportType != depotData.m_TransportType) continue;
                        } else if (isCargo != lineData.m_CargoTransport || isPublic != lineData.m_PassengerTransport || (m_VehicleModels.TryGetBuffer(request.m_Route, out var models) && !RouteUtils.CheckVehicleModel(models, sourcePrefab, layout, ref seeker.m_PrefabRef, ref m_MultipleUnitTrainData))) {
                            continue;
                        }
                        if (Excluded(ref m_PreferredDepotData, request.m_Route, sourceDepot)) continue;
                        var target    = entities[j];
                        var waypoints = m_Waypoints[request.m_Route];
                        for (var k = 0; k < waypoints.Length; k++) {
                            var waypoint = waypoints[k].m_Waypoint;
                            if (!seeker.m_RouteLane.HasComponent(waypoint)) continue;
                            var routeLane = seeker.m_RouteLane[waypoint];
                            if (routeLane.m_StartLane == Entity.Null) continue;
                            seeker.m_Buffer.Enqueue(new PathTarget(target, routeLane.m_StartLane, routeLane.m_StartCurvePos, 0f));
                        }
                    }
                }
            }
        }
    }
}
