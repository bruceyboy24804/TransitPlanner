namespace TransitPlanner.Domain {
    #region Using Statements

    using Game.UI;

    using Unity.Entities;

    using UnityEngine;

    #endregion

    /// <summary>A vehicle prefab as the fleet manager lists it.</summary>
    public struct ModelInfo {
        public Entity entity;
        public NameSystem.Name name;
        public string id;
        public int capacity;
        /// <summary>Vanilla's thumbnail for the prefab, or its placeholder icon.</summary>
        public string thumbnail;
    }

    /// <summary>The models one transport type can pick from, engines and carriages apart.</summary>
    public class ModelCatalog {
        /// <summary><c>Game.Prefabs.TransportType</c> as int.</summary>
        public int type;
        public bool cargo;
        public ModelInfo[] primary = System.Array.Empty<ModelInfo>();
        public ModelInfo[] secondary = System.Array.Empty<ModelInfo>();
    }

    /// <summary>One row of the fleet manager.</summary>
    public class FleetRow {
        public Entity entity;
        public NameSystem.Name name;
        public Color color;
        public int type;
        public bool cargo;
        public int stops;
        /// <summary>Metres.</summary>
        public float length;
        /// <summary>Not hidden on the map (no <c>HiddenRoute</c>).</summary>
        public bool visible;
        public int fleet;
        public int target;
        /// <summary>Simulation seconds.</summary>
        public float headway;
        public int riders;
        public int capacity;
        public bool paidTicket;
        public int ticketPrice;
        public bool notEnoughVehicles;
        public bool inactive;
        public bool dayOnly;
        public bool nightOnly;
        public bool scheduled;
        /// <summary>From TP_LoadSample: the busiest hour's load (riders/seats), and when.</summary>
        public float peakLoad;
        public int peakHour;
        /// <summary>The quietest sampled hour's load.</summary>
        public float lowLoad;
        /// <summary>Longest hourly average wait, simulation seconds.</summary>
        public float maxWait;
        /// <summary>Hours with data, 0..24.</summary>
        public int sampledHours;
        /// <summary>Timetabled lines: share of departures on time over the sampled hours, 0..1; −1 when not timetabled or unmeasured.</summary>
        public float onTime = -1f;
        /// <summary>Cargo lines: what the fleet carries now (top resources) and how many vehicles run empty.</summary>
        public ResourceAmount[] carrying = System.Array.Empty<ResourceAmount>();
        public int emptyVehicles;
        /// <summary>Average departure lateness, simulation seconds.</summary>
        public float late;
        public Entity[] primaryModels = System.Array.Empty<Entity>();
        public Entity[] secondaryModels = System.Array.Empty<Entity>();
    }
}
