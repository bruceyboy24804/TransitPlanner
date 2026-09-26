namespace TransitPlanner.Domain {
    #region Using Statements

    using Game.UI;

    using Unity.Entities;

    #endregion

    // The line map: the loop unrolled to 0..1, with what the game knows at each point.

    /// <summary>Another line calling at a stop: an interchange.</summary>
    public struct MapTransfer {
        public Entity entity;
        public NameSystem.Name name;
        public UnityEngine.Color color;
        public int type;
    }

    public struct MapStop {
        public Entity entity;
        public NameSystem.Name name;
        /// <summary>Position along the loop, 0..1.</summary>
        public float at;
        public int waiting;
        /// <summary>Simulation seconds.</summary>
        public int averageWait;
        /// <summary>Other lines at this stop — the stop's own ConnectedRoutes plus its station's other stops'.</summary>
        public MapTransfer[] transfers;
    }

    public struct MapLeg {
        public float from;
        public float to;
        /// <summary>Pathfinder plan, simulation seconds.</summary>
        public float planned;
        /// <summary>Plan scaled by what vehicles achieved (RouteInfo), simulation seconds.</summary>
        public float achieved;
        public bool inactiveDay;
        public bool inactiveNight;
    }

    public struct MapVehicle {
        public Entity entity;
        public NameSystem.Name name;
        public float at;
        public int riders;
        public int capacity;
        /// <summary><c>Game.Vehicles.PublicTransportFlags</c> (or the cargo flags) as int.</summary>
        public int state;
        public bool boarding;
        public bool returning;
    }

    public class LineMap {
        public bool valid;
        public Entity entity;
        /// <summary>Metres.</summary>
        public float length;
        public MapStop[] stops = System.Array.Empty<MapStop>();
        public MapLeg[] legs = System.Array.Empty<MapLeg>();
        public MapVehicle[] vehicles = System.Array.Empty<MapVehicle>();
    }
}
