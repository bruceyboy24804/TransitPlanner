namespace TransitPlanner.Domain {
    #region Using Statements

    using Game.Common;
    using Game.Prefabs;
    using Game.Routes;

    using Unity.Entities;

    #endregion

    /// <summary>Which stops a line may drive past, and how (see <see cref="Components.TP_SkipStop"/>).</summary>
    public static class SkipStops {
        /// <summary>Every passenger line can skip stops.</summary>
        public static bool LineCanSkip(EntityManager em, Entity line) => Data(em, line, out var data) && data.m_PassengerTransport;

        /// <summary>
        /// Bus lines skip plain stops the vanilla way (the road-vehicle AI's test-then-skip, see
        /// <c>TransportCarAISystem.CheckNavigationLanes</c>), which lets riders aboard still stop
        /// the bus; everything else is detached.
        /// </summary>
        public static bool UsesVanillaSkip(EntityManager em, Entity line, Entity waypoint) =>
            Data(em, line, out var data) && data.m_TransportType == TransportType.Bus && !InStation(em, StopOf(em, waypoint));

        /// <summary>The stop a waypoint serves: its Connected stop, or the one a detach put aside.</summary>
        public static Entity StopOf(EntityManager em, Entity waypoint) {
            if (em.HasComponent<Components.TP_SkipDetached>(waypoint)) return em.GetComponentData<Components.TP_SkipDetached>(waypoint).m_Stop;
            return em.HasComponent<Connected>(waypoint) ? em.GetComponentData<Connected>(waypoint).m_Connected : Entity.Null;
        }

        /// <summary>A real stop (not a path corner).</summary>
        public static bool StopCanBeSkipped(EntityManager em, Entity waypoint) {
            var stop = StopOf(em, waypoint);
            return stop != Entity.Null && em.HasComponent<BoardingVehicle>(stop);
        }

        /// <summary>Part of a station — walks the stop's owners the way <c>GetTransportStationFromStop</c> does.</summary>
        public static bool InStation(EntityManager em, Entity stop) {
            for (var guard = 0; stop != Entity.Null && guard < 8; guard++) {
                if (em.HasComponent<Game.Buildings.TransportStation>(stop)) return true;
                stop = em.HasComponent<Owner>(stop) ? em.GetComponentData<Owner>(stop).m_Owner : Entity.Null;
            }
            return false;
        }

        private static bool Data(EntityManager em, Entity line, out TransportLineData data) {
            data = default;
            if (!em.HasComponent<PrefabRef>(line)) return false;
            var prefab = em.GetComponentData<PrefabRef>(line).m_Prefab;
            if (!em.HasComponent<TransportLineData>(prefab)) return false;
            data = em.GetComponentData<TransportLineData>(prefab);
            return true;
        }
    }
}
