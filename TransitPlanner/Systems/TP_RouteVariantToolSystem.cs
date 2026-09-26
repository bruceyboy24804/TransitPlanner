namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Tools;

    using Unity.Entities;
    using Unity.Jobs;

    using TransitPlanner.Components;

    #endregion

    /// <summary>
    /// A hidden tool that rebuilds a line with a chosen subset of its waypoints, through the game's
    /// own placement pipeline: exactly what the route tool does when the player removes a
    /// waypoint, minus the mouse. Activated for three frames per request and then hands the
    /// previous tool back.
    /// </summary>
    /// <remarks>
    /// Frame 1: <c>applyMode = Clear</c> and one definition entity —
    /// <c>{CreationDefinition(prefab, original = line), ColorDefinition, WaypointDefinition[] (the
    /// kept waypoints, with their original waypoint entity and connected stop), Updated}</c> —
    /// emitted through the <c>ToolOutputBarrier</c>, the way <c>RouteToolSystem.CreateDefinitionsJob</c>
    /// does. The modification phases turn it into a <c>Temp</c> route.
    /// Frame 2: the Temp route exists and <c>GetAllowApply()</c> holds → <c>applyMode = Apply</c>;
    /// <c>ApplyRoutesSystem</c> commits it over the original: waypoints, segments, stop links, path
    /// requests, vehicles re-pathed, all vanilla's doing.
    /// Frame 3: restore the previous tool.
    ///
    /// The definitions are built from the live route (waypoint entities, stops, positions), not
    /// from the variant buffer, so a waypoint that no longer exists is simply not in the list;
    /// re-adding the extension (the full form) supplies the missing waypoints as new ones by
    /// stop and position, which is what the route tool emits for a freshly clicked waypoint.
    ///
    /// This is the one place in the mod that changes what a line <em>is</em>. Nothing else may.
    /// </remarks>
    public partial class TP_RouteVariantToolSystem : ToolBaseSystem {
        public override string toolID => "TransitPlanner.RouteVariant";

        private ToolOutputBarrier m_Barrier;
        private ToolBaseSystem    m_PreviousTool;
        private EntityQuery       m_TempRouteQuery;
        private ModsCommon.Utils.PrefixedLogger m_Log;

        private struct Pending {
            /// <summary>The line being rebuilt, or Null when creating a new one.</summary>
            public Entity line;
            /// <summary>The line prefab for a new line (ignored for a rebuild, which keeps the line's own).</summary>
            public Entity prefab;
            public UnityEngine.Color32 color;
            /// <summary>The kept waypoints in order: original waypoint (or Null), stop (or Null), position.</summary>
            public List<TP_VariantWaypoint> waypoints;
            public List<Entity> originals;
        }

        private Pending? m_Request;
        private int      m_Frame;
        private bool     m_Busy;

        public bool Busy => m_Busy;

        public override PrefabBase GetPrefab() => null;
        public override bool TrySetPrefab(PrefabBase prefab) => false;

        protected override void OnCreate() {
            base.OnCreate();
            m_Log     = new ModsCommon.Utils.PrefixedLogger(nameof(TP_RouteVariantToolSystem));
            m_Barrier = World.GetOrCreateSystemManaged<ToolOutputBarrier>();
            m_TempRouteQuery = GetEntityQuery(ComponentType.ReadOnly<Route>(), ComponentType.ReadOnly<Temp>());
            m_PreviousTool = m_DefaultToolSystem;
            // Subscribe, never latch: survives activations this tool did not start.
            m_ToolSystem.EventToolChanged += tool => { if (tool != this) m_PreviousTool = tool; };
        }

        /// <summary>
        /// Rebuilds <paramref name="line"/> with exactly <paramref name="kept"/> (in order). Each
        /// entry names the original waypoint entity when it still exists, else the stop and
        /// position to create it from. Refused while a rebuild is in flight.
        /// </summary>
        public bool Request(Entity line, List<TP_VariantWaypoint> kept, List<Entity> originals) {
            if (m_Busy || kept.Count < 2) return false;
            m_Request = new Pending { line = line, waypoints = kept, originals = originals };
            m_Frame = 0;
            m_Busy  = true;
            m_ToolSystem.activeTool = this;
            return true;
        }

        /// <summary>
        /// Creates a new line of <paramref name="prefab"/> through <paramref name="stops"/> in order
        /// (the loop closes itself), the way the route tool would if every stop were clicked at once:
        /// a definition with no original and one waypoint per stop, each connected to its stop.
        /// </summary>
        public bool RequestNew(Entity prefab, List<Entity> stops, UnityEngine.Color32 color) {
            if (m_Busy || stops.Count < 2) return false;
            var em   = EntityManager;
            var kept = new List<TP_VariantWaypoint>(stops.Count);
            var orig = new List<Entity>(stops.Count);
            foreach (var stop in stops) {
                if (!em.Exists(stop) || !em.HasComponent<Game.Objects.Transform>(stop)) continue;
                kept.Add(new TP_VariantWaypoint { m_Position = em.GetComponentData<Game.Objects.Transform>(stop).m_Position, m_Stop = stop, m_InShort = 1 });
                orig.Add(Entity.Null);
            }
            if (kept.Count < 2) return false;
            m_Request = new Pending { line = Entity.Null, prefab = prefab, color = color, waypoints = kept, originals = orig };
            m_Frame = 0;
            m_Busy  = true;
            m_ToolSystem.activeTool = this;
            return true;
        }

        public override void InitializeRaycast() {
            base.InitializeRaycast();
            // Nothing to hit: the base reset leaves every mask empty.
        }

        /// <summary>Originals this tool rebuilds legitimately vanish mid-window; keep only the error clause.</summary>
        protected override bool GetAllowApply() => m_ErrorQuery.IsEmptyIgnoreFilter || m_ToolSystem.ignoreErrors;

        protected override JobHandle OnUpdate(JobHandle inputDeps) {
            if (m_Request == null) {
                applyMode = ApplyMode.None;
                Finish();
                return inputDeps;
            }
            var req = m_Request.Value;
            var em  = EntityManager;

            switch (m_Frame) {
                case 0: {
                    var isNew = req.line == Entity.Null;
                    if (!isNew && (!em.Exists(req.line) || !em.HasComponent<PrefabRef>(req.line))) { Finish(); break; }
                    if (isNew && !em.Exists(req.prefab)) { Finish(); break; }
                    applyMode = ApplyMode.Clear;
                    var ecb = m_Barrier.CreateCommandBuffer();
                    var e   = ecb.CreateEntity();
                    ecb.AddComponent(e, new CreationDefinition {
                        m_Prefab   = isNew ? req.prefab : em.GetComponentData<PrefabRef>(req.line).m_Prefab,
                        m_Original = req.line,
                    });
                    ecb.AddComponent(e, new ColorDefinition {
                        m_Color = isNew ? req.color : em.HasComponent<Color>(req.line) ? em.GetComponentData<Color>(req.line).m_Color : default,
                    });
                    var defs = ecb.AddBuffer<WaypointDefinition>(e);
                    for (var i = 0; i < req.waypoints.Count; i++) {
                        var w = req.waypoints[i];
                        defs.Add(new WaypointDefinition(w.m_Position) { m_Original = req.originals[i], m_Connection = w.m_Stop });
                    }
                    ecb.AddComponent(e, default(Updated));
                    m_Log.Info($"Variant rebuild of {req.line}: {req.waypoints.Count} waypoint(s) — definitions emitted");
                    break;
                }
                case 1: {
                    if (!m_TempRouteQuery.IsEmptyIgnoreFilter && GetAllowApply()) {
                        applyMode = ApplyMode.Apply;
                        m_Log.Info($"Variant rebuild of {req.line}: applying");
                    } else {
                        applyMode = ApplyMode.Clear;
                        m_Log.Warn($"Variant rebuild of {req.line}: no temp route or errors present, discarded");
                    }
                    break;
                }
                default:
                    applyMode = ApplyMode.None;
                    Finish();
                    break;
            }
            m_Frame++;
            return inputDeps;
        }

        private void Finish() {
            m_Request = null;
            m_Busy    = false;
            if (m_ToolSystem.activeTool == this) m_ToolSystem.activeTool = m_PreviousTool ?? m_DefaultToolSystem;
        }
    }
}
