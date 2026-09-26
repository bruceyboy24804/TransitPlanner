namespace TransitPlanner.Systems {
    #region Using Statements

    using Game.Common;
    using Game.Rendering;
    using Game.Routes;
    using Game.Tools;

    using Unity.Collections;
    using Unity.Entities;
    using Unity.Mathematics;

    using ModsCommon.Systems;

    using Color = UnityEngine.Color;

    #endregion

    /// <summary>
    /// Draws the planner's overlays in the 3-D world through the game's own overlay renderer —
    /// the buffer <c>EffectRangeRenderSystem</c>, <c>AreaBorderRenderSystem</c> and the Traffic mod
    /// draw into (<see cref="OverlayRenderSystem.GetBuffer"/>, Rendering phase). Stop catchment
    /// discs, reach discs coloured by travel time, and a highlighted line along its real curves.
    /// Active while the mod's infoview is selected or the Network tab asks for it.
    /// </summary>
    /// <remarks>
    /// Main-thread drawing: complete the buffer's dependencies, add curves and circles, hand back
    /// an empty writer handle. A few hundred primitives per frame, nothing that needs a job.
    /// Colours must be given in linear-friendly form; the buffer converts. Diameters are metres.
    /// </remarks>
    public partial class TP_WorldOverlaySystem : CommonGameSystemBase {
        public enum Mode { None = 0, Catchment = 1, Reach = 2 }

        private OverlayRenderSystem m_Overlay;
        private TP_InfoviewSystem   m_Infoview;
        private ToolSystem          m_Tools;

        // What the UI last asked for.
        private Mode     m_Mode;
        private float    m_Radius = 400f;
        private float    m_ReachMax = 30f;
        private Entity[] m_Stops = System.Array.Empty<Entity>();
        private float[]  m_Values = System.Array.Empty<float>();
        private Entity   m_Highlight;
        private bool     m_Force;

        protected override void OnCreate() {
            base.OnCreate();
            m_Overlay  = World.GetOrCreateSystemManaged<OverlayRenderSystem>();
            m_Infoview = World.GetOrCreateSystemManaged<TP_InfoviewSystem>();
            m_Tools    = World.GetOrCreateSystemManaged<ToolSystem>();
        }

        /// <summary>The UI's overlay request: which mode, its radius / scale, and per-stop data.</summary>
        public void Set(Mode mode, float radius, float reachMax, Entity[] stops, float[] values, bool force) {
            m_Mode = mode; m_Radius = radius; m_ReachMax = reachMax;
            m_Stops = stops ?? System.Array.Empty<Entity>();
            m_Values = values ?? System.Array.Empty<float>();
            m_Force = force;
        }

        public void SetHighlight(Entity line) => m_Highlight = line;

        /// <summary>The last reach request (stops, minutes, max), for the reach heatmap; stops null when none.</summary>
        public (Entity[] stops, float[] minutes, float max) ReachData => m_Mode == Mode.Reach ? (m_Stops, m_Values, m_ReachMax) : (null, null, 0f);

        protected override void OnUpdate() {
            var active = m_Force || m_Infoview.Active;
            if (!active) return;
            var em     = EntityManager;
            var buffer = m_Overlay.GetBuffer(out var deps);
            deps.Complete();

            switch (m_Mode) {
                case Mode.Catchment: {
                    var fill = new Color(0.47f, 0.86f, 0.63f, 0.10f);
                    var edge = new Color(0.47f, 0.86f, 0.63f, 0.45f);
                    foreach (var stop in m_Stops) Disc(ref buffer, stop, m_Radius * 2f, edge, fill);
                    break;
                }
                case Mode.Reach: {
                    for (var i = 0; i < m_Stops.Length && i < m_Values.Length; i++) {
                        var min = m_Values[i];
                        if (min < 0f || float.IsInfinity(min) || min > m_ReachMax) continue;
                        var t = math.saturate(min / m_ReachMax);
                        var c = Color.HSVToRGB((1f - t) * 0.33f, 0.8f, 0.9f);
                        Disc(ref buffer, m_Stops[i], 90f, new Color(c.r, c.g, c.b, 0.9f), new Color(c.r, c.g, c.b, 0.35f));
                    }
                    break;
                }
                default:
                    // Nothing asked: the infoview's heatmaps carry the picture on their own; discs
                    // only when the Network tab asks for catchment or reach.
                    break;
            }

            // Highlighted line: its own colour along its real curves, wide enough to read from above.
            if (m_Highlight != Entity.Null && em.Exists(m_Highlight) && em.HasBuffer<RouteSegment>(m_Highlight)) {
                var color = em.HasComponent<Game.Routes.Color>(m_Highlight) ? (Color)em.GetComponentData<Game.Routes.Color>(m_Highlight).m_Color : Color.white;
                color.a = 0.9f;
                foreach (var seg in em.GetBuffer<RouteSegment>(m_Highlight, true)) {
                    if (!em.HasBuffer<CurveElement>(seg.m_Segment)) continue;
                    foreach (var ce in em.GetBuffer<CurveElement>(seg.m_Segment, true)) buffer.DrawCurve(color, ce.m_Curve, 8f);
                }
            }
            m_Overlay.AddBufferWriter(default);
        }

        private void Disc(ref OverlayRenderSystem.Buffer buffer, Entity stop, float diameter, Color edge, Color fill) {
            var em = EntityManager;
            if (!em.Exists(stop) || !em.HasComponent<Game.Objects.Transform>(stop)) return;
            var pos = em.GetComponentData<Game.Objects.Transform>(stop).m_Position;
            buffer.DrawCircle(edge, fill, 2f, 0, new float2(0f, 1f), pos, diameter);
        }
    }
}
