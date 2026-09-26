namespace TransitPlanner.Domain {
    #region Using Statements

    using Game.UI;

    using Unity.Entities;

    using UnityEngine;

    #endregion

    // The network view: every line of one type, drawn through its stops' world positions.

    public struct NetStop {
        public Entity entity;
        public NameSystem.Name name;
        /// <summary>World x / z, metres.</summary>
        public float x;
        public float y;
        /// <summary>Passengers waiting across every line's queue at this stop.</summary>
        public int waiting;
        /// <summary>How many of the shown lines call here.</summary>
        public int lines;
        /// <summary>Indices into <see cref="Network.lines"/> of the lines calling here, for the interchange ring.</summary>
        public int[] lineIds;
    }

    /// <summary>A depot of the network's type on the map.</summary>
    public struct NetDepot {
        public Entity entity;
        public NameSystem.Name name;
        public float x;
        public float y;
        public int available;
        public int owned;
        /// <summary>A bound line is short of vehicles while this depot has none spare.</summary>
        public bool starved;
        /// <summary>Indices into <see cref="Network.lines"/> of the lines bound to this depot (TP_PreferredDepot).</summary>
        public int[] boundLines;
    }

    public struct NetLine {
        public Entity entity;
        public NameSystem.Name name;
        public Color color;
        /// <summary>Indices into <see cref="Network.stops"/>, in loop order (the loop closes back to the first).</summary>
        public int[] stops;
        /// <summary>
        /// The loop's real geometry: world x, z pairs sampled along every segment's curves, in
        /// loop order, decimated to a few metres. Empty when the line has no segment geometry yet.
        /// </summary>
        public float[] path;
        /// <summary>Per stop (same order as <see cref="stops"/>), the index of the path point where that stop's leg begins.</summary>
        public int[] legStarts;
        /// <summary>Per stop, the planned duration of the leg from it to the next stop, simulation seconds (PathInformation over the segments between).</summary>
        public float[] legDurations;
        /// <summary>Current headway, simulation seconds; half of it is the expected wait when boarding.</summary>
        public float headway;
        /// <summary>24 hourly loads (0..1+) from the line's measured history; -1 where no hour has been sampled yet.</summary>
        public float[] history;
        public int fleet;
        public int riders;
        public int capacity;
        public bool notEnoughVehicles;
        public bool inactive;
        /// <summary>Scheduled headway per hour of the day, simulation seconds; 0 = not running that hour.</summary>
        public float[] hourHeadway;
        /// <summary>Position in <see cref="stops"/> of the timetable anchor, −1 when not timetabled.</summary>
        public int anchorStop;
        /// <summary>Timetabled departures from the anchor, frames of the day.</summary>
        public uint[] departures;
    }

    /// <summary>A vehicle on the network view, at its world position; published more often than the network itself.</summary>
    public struct NetVehicle {
        public Entity entity;
        public Entity line;
        public float x;
        public float y;
        public int riders;
        public int capacity;
        public bool boarding;
        public bool returning;
        /// <summary>Position in the line's stop order of the stop it is heading to (its leg ends there), or -1.</summary>
        public int nextStop;
    }

    /// <summary>A district outline for context: world x, z pairs of its polygon.</summary>
    public struct NetDistrict {
        public Entity entity;
        public NameSystem.Name name;
        public float[] points;
    }

    /// <summary>Every road and track edge, seven floats each (x0 y0, xm ym, x1 y1, width), world x/z.</summary>
    /// <summary>Coverage gaps: people (residents + workers) per 200 m cell with no stop of the shown type within 400 m.</summary>
    public class GapLayer {
        public int version;
        public float cell;
        /// <summary>x, z, people triples (cell centres, world metres).</summary>
        public float[] cells = System.Array.Empty<float>();
    }

    public class RoadLayer {
        /// <summary>Bumps on every rebuild so the UI can cache its path strings.</summary>
        public int version;
        public int roadCount;
        public int trackCount;
        public float[] roads = System.Array.Empty<float>();
        public float[] tracks = System.Array.Empty<float>();
    }

    /// <summary>Zone blocks (8 floats: four corners) and building footprints (5: x z sizeX sizeZ yaw°), world x/z.</summary>
    public class GroundLayer {
        public int version;
        public int blockCount;
        public int buildingCount;
        public float[] blocks = System.Array.Empty<float>();
        public float[] buildings = System.Array.Empty<float>();
    }

    /// <summary>Terrain height bands and water on a coarse grid over the playable area (row-major, origin at the south-west corner).</summary>
    public class TerrainLayer {
        public int version;
        public int cells;
        public int bands;
        public float originX;
        public float originY;
        public float cellX;
        public float cellY;
        /// <summary>Height band 0..bands-1 per cell.</summary>
        public int[] band = System.Array.Empty<int>();
        /// <summary>1 where the cell is under water.</summary>
        public int[] water = System.Array.Empty<int>();
    }

    /// <summary>What the Network tab wants drawn in the world (TP_WorldOverlaySystem).</summary>
    public class WorldOverlayRequest {
        /// <summary>0 none, 1 catchment, 2 reach.</summary>
        public int mode;
        public float radius;
        public float reachMax;
        public Entity[] stops = System.Array.Empty<Entity>();
        public float[] values = System.Array.Empty<float>();
        /// <summary>Draw even when the mod's infoview is not active.</summary>
        public bool force;
    }

    /// <summary>Live figures for the infoview's legend rows.</summary>
    public class InfoviewStats {
        public int stops;
        public int lines;
        public int buildings;
        public int buildingsCovered;
        /// <summary>Departures per game hour, averaged over stops with service.</summary>
        public float avgFrequency;
        public float bestFrequency;
        public int waiting;
        public int worstWaiting;
        public NameSystem.Name worstStopName;
        public NameSystem.Name reachOriginName;
        public int reachStops;
        public float reachMax;
        /// <summary>Vehicle modes: transit vehicles seen, mean load 0..1, and how many are boarding / held / bunched.</summary>
        public int vehicles;
        public float avgLoad;
        public int boarding;
        public int held;
        public int bunched;
    }

    public class Network {
        public bool valid;
        public int type;
        public bool cargo;
        public NetStop[] stops = System.Array.Empty<NetStop>();
        public NetLine[] lines = System.Array.Empty<NetLine>();
        public NetDepot[] depots = System.Array.Empty<NetDepot>();
        public NetDistrict[] districts = System.Array.Empty<NetDistrict>();
    }
}
