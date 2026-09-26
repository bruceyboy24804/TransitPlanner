namespace TransitPlanner.Systems {
    #region Using Statements

    using System.Collections.Generic;

    using Game.Common;
    using Game.Economy;
    using Game.Prefabs;
    using Game.Routes;
    using Game.Simulation;
    using Game.UI;
    using Game.UI.InGame;
    using Game.Vehicles;

    using Unity.Collections;
    using Unity.Entities;
    using Unity.Mathematics;

    using TransitPlanner.Components;
    using TransitPlanner.Domain;

    // More usings than this file needs, on purpose: "Board" sorts first among this system's
    // partials, and the SystemAPI source generator emits the whole system's rewritten code under
    // the first file's usings (see the note in .Cargo.cs).

    #endregion

    /// <summary>
    /// The Schedule tab (Traffic's signal-plan editor, for lines): every line of one type as a row
    /// with its whole schedule and its scheduled headway hour by hour, plus the type's depot
    /// capacity for the totals strip. Edits go back through <c>setSchedule</c>, one line each.
    /// </summary>
    public partial class TP_PlannerUISystem {
        private int  m_BoardType = -1;
        private bool m_BoardCargo;
        private int  m_BoardFrame;
        private ScheduleBoard m_BoardCache;

        private void CreateBoardBindings() {
            CreateBinding("scheduleBoard", ReadBoard);
            CreateTrigger<int, bool>("setBoardType", (type, cargo) => {
                if (type == m_BoardType && cargo == m_BoardCargo) return;
                m_BoardType = type; m_BoardCargo = cargo; m_BoardCache = null;
            });
            CreateTrigger<Entity[]>("setBoardOrder", SetBoardOrder);
            CreateTrigger<Entity[], string>("switchPlan", SwitchPlan);
            CreateTrigger<Entity[], string>("deletePlan", DeletePlan);
        }

        private const string kDefaultPlan = "Default";

        private TP_BoardLink ReadLink(Entity line) =>
            EntityManager.HasComponent<TP_BoardLink>(line) ? EntityManager.GetComponentData<TP_BoardLink>(line) : default;

        /// <summary>Stores the link, or drops the component when nothing is set.</summary>
        private void StoreLink(Entity line, TP_BoardLink link) {
            var em = EntityManager;
            if (link.IsEmpty) { if (em.HasComponent<TP_BoardLink>(line)) em.RemoveComponent<TP_BoardLink>(line); }
            else if (em.HasComponent<TP_BoardLink>(line)) em.SetComponentData(line, link);
            else em.AddComponentData(line, link);
            m_BoardCache = null;
        }

        /// <summary>Sets the line's template / group link; null leaves a field, "" clears it.</summary>
        private void WriteBoardLink(Entity line, string template, string group) {
            if (template == null && group == null) return;
            var link = ReadLink(line);
            if (template != null) link.m_Template = TP_BoardLink.Clip(template);
            if (group != null)    link.m_Group    = TP_BoardLink.Clip(group);
            StoreLink(line, link);
        }

        /// <summary>Row order: the lines in the order the player dragged them, numbered 1..n.</summary>
        private void SetBoardOrder(Entity[] lines) {
            for (var i = 0; i < (lines?.Length ?? 0); i++) {
                if (!IsLine(lines[i])) continue;
                var link = ReadLink(lines[i]);
                link.m_Order = i + 1;
                StoreLink(lines[i], link);
            }
        }

        /// <summary>
        /// Switches lines to a named plan: each line's live bands are stashed under its current
        /// plan, and the target plan's stash (if the line has one) becomes the live bands; a line
        /// without that plan keeps its bands, which from now on are that plan's (so "switch to a new
        /// name" = "save the current bands as a new plan"). Per-band models are not stashed, so the
        /// line's own model selection is restored first, as setSchedule does.
        /// </summary>
        private void SwitchPlan(Entity[] lines, string name) {
            var em = EntityManager;
            var target = TP_BoardLink.Clip(string.IsNullOrWhiteSpace(name) ? kDefaultPlan : name.Trim());
            foreach (var line in lines ?? System.Array.Empty<Entity>()) {
                if (!IsLine(line) || !em.HasBuffer<TP_ScheduleBand>(line) || !em.HasComponent<TP_LineSchedule>(line)) continue;
                var link = ReadLink(line);
                var current = link.m_Plan.Length == 0 ? TP_BoardLink.Clip(kDefaultPlan) : link.m_Plan;
                if (current == target) continue;

                // Structural first (AddBuffer), then take every buffer fresh.
                if (!em.HasBuffer<TP_PlanBand>(line)) em.AddBuffer<TP_PlanBand>(line);
                RestoreBaselineModels(line);

                var stash = em.GetBuffer<TP_PlanBand>(line);
                var bands = em.GetBuffer<TP_ScheduleBand>(line);
                var incoming = new List<TP_ScheduleBand>();
                for (var i = stash.Length - 1; i >= 0; i--) {
                    if (stash[i].m_Plan != target) continue;
                    incoming.Insert(0, stash[i].m_Band);
                    stash.RemoveAt(i);
                }
                // An empty plan is stashed as one marker band, so "has the plan" = anything came back.
                var hadTarget = incoming.Count > 0;
                foreach (var b in bands) stash.Add(new TP_PlanBand { m_Plan = current, m_Band = b });
                if (bands.Length == 0) stash.Add(new TP_PlanBand { m_Plan = current, m_Band = EmptyMarker() });
                if (hadTarget) {
                    bands.Clear();
                    foreach (var b in incoming) if (!IsEmptyMarker(b)) bands.Add(b);
                }
                if (em.HasBuffer<TP_BandModel>(line)) em.GetBuffer<TP_BandModel>(line).Clear();

                link = ReadLink(line);
                link.m_Plan = target.ToString() == kDefaultPlan ? default : target;
                StoreLink(line, link);
            }
            m_BoardCache = null;
        }

        /// <summary>Drops a stashed plan from the lines (the live plan cannot be deleted).</summary>
        private void DeletePlan(Entity[] lines, string name) {
            var em = EntityManager;
            var target = TP_BoardLink.Clip(name ?? "");
            foreach (var line in lines ?? System.Array.Empty<Entity>()) {
                if (!IsLine(line) || !em.HasBuffer<TP_PlanBand>(line)) continue;
                var stash = em.GetBuffer<TP_PlanBand>(line);
                for (var i = stash.Length - 1; i >= 0; i--) if (stash[i].m_Plan == target) stash.RemoveAt(i);
            }
            m_BoardCache = null;
        }

        // A plan with no bands still has to exist in the stash: one marker band (start == end == uint.MaxValue).
        private static TP_ScheduleBand EmptyMarker() => new TP_ScheduleBand { m_Start = uint.MaxValue, m_End = uint.MaxValue };
        private static bool IsEmptyMarker(TP_ScheduleBand b) => b.m_Start == uint.MaxValue && b.m_End == uint.MaxValue;

        /// <summary>Hands the line its own vehicle models back (a band may own the buffer), as setSchedule does.</summary>
        private void RestoreBaselineModels(Entity line) {
            var em = EntityManager;
            var schedule = em.GetComponentData<TP_LineSchedule>(line);
            if (schedule.m_AppliedModelBand < 0 || !em.HasBuffer<TP_BaselineModel>(line) || !em.HasBuffer<VehicleModel>(line)) return;
            var vm = em.GetBuffer<VehicleModel>(line);
            var bl = em.GetBuffer<TP_BaselineModel>(line);
            vm.Clear();
            foreach (var b in bl) vm.Add(new VehicleModel { m_PrimaryPrefab = b.m_Primary, m_SecondaryPrefab = b.m_Secondary });
            bl.Clear();
            schedule.m_AppliedModelBand = -1;
            em.SetComponentData(line, schedule);
        }

        /// <summary>The plan names a line knows: its live one first, then its stashed ones.</summary>
        private string[] PlanNames(Entity line, out string active) {
            var em = EntityManager;
            var link = ReadLink(line);
            active = link.m_Plan.Length == 0 ? kDefaultPlan : link.m_Plan.ToString();
            var names = new List<string> { active };
            if (em.HasBuffer<TP_PlanBand>(line)) {
                foreach (var p in em.GetBuffer<TP_PlanBand>(line, true)) {
                    var n = p.m_Plan.ToString();
                    if (!names.Contains(n)) names.Add(n);
                }
            }
            return names.ToArray();
        }

        private ScheduleBoard ReadBoard() {
            // Every line's full schedule is not cheap: re-read every 30 UI frames.
            if (m_BoardCache != null && ++m_BoardFrame < 30) return m_BoardCache;
            m_BoardFrame = 0;
            var em    = EntityManager;
            var board = new ScheduleBoard { type = m_BoardType, cargo = m_BoardCargo };
            if (m_BoardType < 0) return m_BoardCache = board;

            var rows  = new List<BoardRow>();
            var lines = m_LineQuery.ToEntityArray(Allocator.Temp);
            foreach (var line in lines) {
                var prefab = em.GetComponentData<PrefabRef>(line).m_Prefab;
                if (!em.HasComponent<TransportLineData>(prefab)) continue;
                var data  = em.GetComponentData<TransportLineData>(prefab);
                var cargo = data.m_CargoTransport && !data.m_PassengerTransport;
                if ((int)data.m_TransportType != m_BoardType || cargo != m_BoardCargo) continue;
                var tl     = em.GetComponentData<TransportLine>(line);
                var stable = StableDuration(line, data);
                int riders = 0, capacity = 0;
                var fleet  = TransportUIUtils.GetRouteVehiclesCount(em, line, ref riders, ref capacity);
                rows.Add(new BoardRow {
                    entity     = line,
                    name       = m_Names.GetName(line),
                    color      = em.HasComponent<Game.Routes.Color>(line) ? (UnityEngine.Color)em.GetComponentData<Game.Routes.Color>(line).m_Color : UnityEngine.Color.white,
                    fleet      = fleet,
                    target     = TargetFleet(line, data),
                    headway    = tl.m_VehicleInterval,
                    stable     = stable,
                    notEnoughVehicles = (tl.m_Flags & TransportLineFlags.NotEnoughVehicles) != 0,
                    // Hours no band sets run vanilla's target fleet; hand HourHeadways the spacing that
                    // fleet gives, not m_VehicleInterval (the tick's output, which sizes back to 1
                    // on a short loop — the "target is step 5, not step 6" trap).
                    hourHeadway = HourHeadways(line, TargetFleet(line, data) > 0 ? stable / TargetFleet(line, data) : tl.m_VehicleInterval, stable),
                    schedule   = ReadScheduleOf(line),
                });
            }
            lines.Dispose();
            board.rows = rows.ToArray();

            // Depot capacity of the type, for "fleet needed vs vehicles the depots can hold".
            var depots = m_DepotQuery.ToEntityArray(Allocator.Temp);
            foreach (var depot in depots) {
                var prefab = em.GetComponentData<PrefabRef>(depot).m_Prefab;
                if (!em.HasComponent<TransportDepotData>(prefab)) continue;
                var data = em.GetComponentData<TransportDepotData>(prefab);
                if ((int)data.m_TransportType != m_BoardType) continue;
                board.depotCapacity += data.m_VehicleCapacity;
                board.depotAvailable += em.GetComponentData<Game.Buildings.TransportDepot>(depot).m_AvailableVehicles;
            }
            depots.Dispose();
            return m_BoardCache = board;
        }
    }
}
