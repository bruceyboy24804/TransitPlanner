namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Prefabs;
    using Game.Routes;

    using Unity.Entities;

    using TransitPlanner.Components;

    #endregion

    /// <summary>
    /// Route variants from the UI: marking which stops the short form keeps, and asking for a
    /// rebuild. The capture rule: the variant buffer is (re)written from the live route whenever
    /// the line is in its full form, so player edits made in the full form are kept.
    /// </summary>
    public partial class TP_PlannerUISystem {
        private TP_RouteVariantToolSystem m_VariantTool;

        private void CreateVariantBindings() {
            m_VariantTool = World.GetOrCreateSystemManaged<TP_RouteVariantToolSystem>();
            CreateTrigger<Entity, Entity[]>("setVariant", SetVariant);
            CreateTrigger<Entity, bool>("rebuildVariant", RebuildVariant);
            m_LinePrefabQuery = SystemAPI.QueryBuilder().WithAll<PrefabData, TransportLineData>().Build();
            CreateTrigger<int, bool, Entity[]>("createLine", CreateLine);
            m_ExpressQuery = SystemAPI.QueryBuilder()
                                      .WithAll<Route, TP_RouteVariant, TP_VariantWaypoint, TP_LineSchedule, TP_ScheduleBand>()
                                      .WithNone<Game.Tools.Temp, Game.Common.Deleted>()
                                      .Build();
        }

        private EntityQuery m_LinePrefabQuery;
        private int m_LinesCreated;
        private int m_ExpressFrame;

        /// <summary>
        /// Express bands used to rebuild a line into its short form; they now skip stops instead
        /// (<see cref="TP_SkipStop"/>, driven by <see cref="TP_SkipStopSystem"/>). What is left
        /// here only undoes the old switch: a line an Express band put into short form
        /// (<see cref="LineScheduleFlags.ShortByBand"/>) is rebuilt to its full route, one line per
        /// check (every 60 UI frames; a refused request is retried next check).
        /// </summary>
        private void ApplyExpressBands() {
            if (++m_ExpressFrame < 60) return;
            m_ExpressFrame = 0;
            var em = EntityManager;
            using var lines = m_ExpressQuery.ToEntityArray(Unity.Collections.Allocator.Temp);
            foreach (var line in lines) {
                if (em.GetBuffer<TP_VariantWaypoint>(line, true).Length == 0) continue;
                var s = em.GetComponentData<TP_LineSchedule>(line);
                var isShort = em.GetComponentData<TP_RouteVariant>(line).m_ActiveShort == 1;
                var byBand  = (s.m_Flags & LineScheduleFlags.ShortByBand) != 0;
                if (!byBand) continue;
                if (!isShort) { s.m_Flags &= ~LineScheduleFlags.ShortByBand; em.SetComponentData(line, s); continue; }
                RebuildVariant(line, false);
                if (em.GetComponentData<TP_RouteVariant>(line).m_ActiveShort == 0) { s.m_Flags &= ~LineScheduleFlags.ShortByBand; em.SetComponentData(line, s); }
                return; // one rebuild per check
            }
        }

        private EntityQuery m_ExpressQuery;

        /// <summary>
        /// Creates a new line of the given type through the stops, in order, with a colour that
        /// keeps its distance from the last few created. The creation goes through the variant
        /// tool's placement pipeline, so vanilla does the linking, pathing and dispatch.
        /// </summary>
        private void CreateLine(int type, bool cargo, Entity[] stops) {
            var em = EntityManager;
            var prefab = Entity.Null;
            var prefabs = m_LinePrefabQuery.ToEntityArray(Unity.Collections.Allocator.Temp);
            foreach (var p in prefabs) {
                var d = em.GetComponentData<TransportLineData>(p);
                if ((int)d.m_TransportType != type || (d.m_CargoTransport && !d.m_PassengerTransport) != cargo) continue;
                prefab = p;
                break;
            }
            prefabs.Dispose();
            if (prefab == Entity.Null) { m_Log.Warn($"createLine: no line prefab for type {type} cargo={cargo}"); return; }

            // Golden-angle hue so consecutive new lines never look alike.
            var hue   = (m_LinesCreated++ * 0.618034f) % 1f;
            var color = (UnityEngine.Color32)UnityEngine.Color.HSVToRGB(hue, 0.75f, 0.95f);
            var list  = new List<Entity>(stops);
            if (m_VariantTool.RequestNew(prefab, list, color)) m_Log.Info($"createLine: {list.Count} stop(s), prefab {prefab}");
            else m_Log.Warn("createLine: refused (tool busy or fewer than two stops)");
        }

        /// <summary>Marks the stops the short variant keeps; every other stop is dropped in short form.</summary>
        private void SetVariant(Entity line, Entity[] shortStops) {
            var em = EntityManager;
            if (!IsLine(line)) return;
            if (!em.HasComponent<TP_RouteVariant>(line)) em.AddComponentData(line, new TP_RouteVariant());
            if (!em.HasBuffer<TP_VariantWaypoint>(line)) em.AddBuffer<TP_VariantWaypoint>(line);

            var variant = em.GetComponentData<TP_RouteVariant>(line);
            var buffer  = em.GetBuffer<TP_VariantWaypoint>(line);
            if (variant.m_ActiveShort == 0) {
                // Full form: capture the live route as the full variant.
                buffer.Clear();
                foreach (var rw in em.GetBuffer<RouteWaypoint>(line, true)) {
                    var wp   = rw.m_Waypoint;
                    var stop = em.HasComponent<Connected>(wp) ? em.GetComponentData<Connected>(wp).m_Connected : Entity.Null;
                    buffer.Add(new TP_VariantWaypoint { m_Position = em.GetComponentData<Position>(wp).m_Position, m_Stop = stop });
                }
            }
            for (var i = 0; i < buffer.Length; i++) {
                var w = buffer[i];
                var keep = w.m_Stop == Entity.Null; // corners stay with whichever stops surround them; resolved at rebuild
                foreach (var s in shortStops) if (s == w.m_Stop) { keep = true; break; }
                w.m_InShort = (byte)(keep ? 1 : 0);
                buffer[i] = w;
            }
            m_Log.Debug($"setVariant for {line}: {shortStops.Length} stop(s) in short form");
        }

        /// <summary>Rebuilds the line as its short or full form through the variant tool.</summary>
        private void RebuildVariant(Entity line, bool wantShort) {
            var em = EntityManager;
            if (!IsLine(line) || !em.HasBuffer<TP_VariantWaypoint>(line)) return;
            var variant = em.GetComponentData<TP_RouteVariant>(line);
            if ((variant.m_ActiveShort == 1) == wantShort) return;

            // Kept waypoints, in full-route order, resolved against the live route by stop.
            var live = em.GetBuffer<RouteWaypoint>(line, true);
            var liveByStop = new Dictionary<Entity, Entity>();
            foreach (var rw in live) {
                if (em.HasComponent<Connected>(rw.m_Waypoint)) liveByStop[em.GetComponentData<Connected>(rw.m_Waypoint).m_Connected] = rw.m_Waypoint;
            }
            var kept      = new List<TP_VariantWaypoint>();
            var originals = new List<Entity>();
            var full      = em.GetBuffer<TP_VariantWaypoint>(line, true);
            var lastKeptStop = true;
            foreach (var w in full) {
                if (w.m_Stop != Entity.Null && !em.Exists(w.m_Stop)) continue; // bulldozed
                var stopKept = w.m_Stop == Entity.Null ? lastKeptStop : (!wantShort || w.m_InShort == 1);
                if (w.m_Stop != Entity.Null) lastKeptStop = stopKept;
                if (!stopKept) continue;
                kept.Add(w);
                originals.Add(w.m_Stop != Entity.Null && liveByStop.TryGetValue(w.m_Stop, out var wp) ? wp : Entity.Null);
            }
            if (kept.Count < 2) { m_Log.Warn($"rebuildVariant for {line}: fewer than two waypoints kept, refused"); return; }

            if (m_VariantTool.Request(line, kept, originals)) {
                variant.m_ActiveShort = (byte)(wantShort ? 1 : 0);
                em.SetComponentData(line, variant);
                m_Log.Info($"rebuildVariant for {line}: {(wantShort ? "short" : "full")} form, {kept.Count} waypoint(s) requested");
            }
        }
    }
}
