namespace TransitPlanner.Domain {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Economy;
    using Game.Prefabs;
    using Game.Vehicles;

    using Unity.Entities;

    #endregion

    /// <summary>
    /// A cargo vehicle's load, read the way vanilla's <c>CargoSection</c> reads it: the
    /// <c>Game.Economy.Resources</c> buffer of the vehicle, or of each car through
    /// <c>LayoutElement</c>, against <c>CargoTransportVehicleData.m_CargoCapacity</c> summed over
    /// the cars. Shared by the planner's cargo binding and the Fleet tab.
    /// </summary>
    public static class CargoMath {
        /// <summary>Adds the vehicle's cargo per resource into <paramref name="into"/> (may be null) and returns carried / capacity.</summary>
        public static void Vehicle(EntityManager em, Entity vehicle, Dictionary<Resource, int> into, out int carried, out int capacity) {
            carried = 0; capacity = 0;
            if (vehicle == Entity.Null || !em.Exists(vehicle)) return;
            if (em.HasBuffer<LayoutElement>(vehicle) && em.GetBuffer<LayoutElement>(vehicle, true).Length > 0) {
                foreach (var le in em.GetBuffer<LayoutElement>(vehicle, true)) Car(em, le.m_Vehicle, into, ref carried, ref capacity);
            } else {
                Car(em, vehicle, into, ref carried, ref capacity);
            }
        }

        private static void Car(EntityManager em, Entity car, Dictionary<Resource, int> into, ref int carried, ref int capacity) {
            if (car == Entity.Null || !em.Exists(car)) return;
            if (em.HasBuffer<Resources>(car)) {
                foreach (var r in em.GetBuffer<Resources>(car, true)) {
                    if (r.m_Amount <= 0 || r.m_Resource == Resource.NoResource) continue;
                    carried += r.m_Amount;
                    if (into != null) { into.TryGetValue(r.m_Resource, out var n); into[r.m_Resource] = n + r.m_Amount; }
                }
            }
            if (em.HasComponent<PrefabRef>(car)) {
                var prefab = em.GetComponentData<PrefabRef>(car).m_Prefab;
                if (em.HasComponent<CargoTransportVehicleData>(prefab)) capacity += em.GetComponentData<CargoTransportVehicleData>(prefab).m_CargoCapacity;
            }
        }

        /// <summary>
        /// How full a vehicle is, 0..1: cargo against cargo capacity for a freight vehicle,
        /// passengers against seats for a passenger one (over every car). −1 when it has no
        /// capacity of either kind.
        /// </summary>
        public static float LoadShare(EntityManager em, Entity vehicle) {
            Vehicle(em, vehicle, null, out var carried, out var capacity);
            if (capacity > 0) return (float)carried / capacity;
            var riders = 0; var seats = 0;
            void Seats(Entity car) {
                if (car == Entity.Null || !em.Exists(car)) return;
                if (em.HasBuffer<Passenger>(car)) riders += em.GetBuffer<Passenger>(car, true).Length;
                if (em.HasComponent<PrefabRef>(car)) {
                    var prefab = em.GetComponentData<PrefabRef>(car).m_Prefab;
                    if (em.HasComponent<PublicTransportVehicleData>(prefab)) seats += em.GetComponentData<PublicTransportVehicleData>(prefab).m_PassengerCapacity;
                }
            }
            if (em.HasBuffer<LayoutElement>(vehicle) && em.GetBuffer<LayoutElement>(vehicle, true).Length > 0) {
                foreach (var le in em.GetBuffer<LayoutElement>(vehicle, true)) Seats(le.m_Vehicle);
            } else {
                Seats(vehicle);
            }
            return seats > 0 ? (float)riders / seats : -1f;
        }

        /// <summary>The resource's enum name, which the game's UI keys icons (Media/Game/Resources/&lt;id&gt;.svg) and titles (Resources.TITLE[&lt;id&gt;]) on.</summary>
        public static string Id(Resource r) => System.Enum.GetName(typeof(Resource), r) ?? r.ToString();

        /// <summary>A resource dictionary as amounts, largest first, capped.</summary>
        public static ResourceAmount[] Sorted(Dictionary<Resource, int> d, int max = int.MaxValue) {
            var list = new List<ResourceAmount>(d.Count);
            foreach (var kv in d) list.Add(new ResourceAmount { key = Id(kv.Key), amount = kv.Value });
            list.Sort((a, b) => b.amount.CompareTo(a.amount));
            if (list.Count > max) list.RemoveRange(max, list.Count - max);
            return list.ToArray();
        }
    }
}
