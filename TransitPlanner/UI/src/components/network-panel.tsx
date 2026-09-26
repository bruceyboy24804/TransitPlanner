import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HelpButton } from "./encyclopedia";
import { useValue } from "cs2/api";
import { LocalizedEntityName } from "cs2/l10n";
import { useRem } from "cs2/utils";
import { Scrollable, Tooltip } from "cs2/ui";
import classNames from "classnames";
import { bindLines, createLine, editLineStops, goTo, infoviewActive$, openInfoview, rename, setWorldHighlight, setWorldOverlay, network$, networkGaps$, networkGround$, networkRoads$, networkTerrain$, networkVehicles$, selected$, setNetworkType, timeOfDay$ } from "../bindings";
import { bestInsert, DepartureBoard, headwayAt, LayersDropdown, octilinear, perHour, schematicLayout, TimeBar } from "./network-extras";
import { transport } from "cs2/bindings";
import type { Entity } from "cs2/bindings";
import { NULL_ENTITY, RouteSchedule } from "../types";
import { NetDepot, NetLine, NetStop, NetVehicle, sameEntity } from "../types";
import { vanilla } from "../vanilla";
import { hsl } from "../colour";
import { FlatButton } from "./flat-button";
import { TypeSelection } from "./type-sidebar";
import { typeLabel } from "./planner-panel";
import panel from "./planner.module.scss";
import styles from "./network.module.scss";

// The network view: every line of the sidebar's type drawn through its stops' real positions, a
// schematic of the whole network rather than one line at a time. Lines are polylines in their own
// colour (or a load colour), stops are nodes sized by how many lines call, interchanges stand out.
// Hover for details; click a stop to go there, a line to open it in the planner. Wheel zooms
// around the cursor, drag pans. Own 2-D viewport (the SVG kit's is one-axis, made for charts).

const cssColor = (c: NetLine["color"]) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;
/** 0..1 load → green → amber → red. */
// Green (empty) → red (full), as rgb: hsl() draws nothing in Gameface (see colour.ts).
const loadHue = (r: number) => hsl(120 - 120 * Math.min(1, r), 0.8, 0.55);

/** A stop→stop leg: its path points, mean load share, and volume (riders / kg aboard on it). */
interface Leg { points: number[]; load: number | null; volume: number }

type Hover = { kind: "stop"; stop: NetStop } | { kind: "line"; line: NetLine } | { kind: "vehicle"; vehicle: NetVehicle } | { kind: "depot"; depot: NetDepot } | null;

/** An arc from a0 to a1 (radians) as a polyline path, since arc commands are not something to trust in Gameface's SVG. */
const arcPath = (cx: number, cy: number, r: number, a0: number, a1: number) => {
    const n = Math.max(2, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 24));
    let d = "";
    for (let i = 0; i <= n; i++) {
        const a = a0 + ((a1 - a0) * i) / n;
        d += `${i === 0 ? "M" : "L"}${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
    }
    return d;
};

interface View { cx: number; cy: number; scale: number } // world centre and px per metre

/**
 * Collects path commands into several `d` strings of at most `per` shapes each. One attribute
 * holding a whole city (a 3 MB `d` for every building) put enough pressure on cohtml's JS heap
 * that unrelated native binds crashed; a few hundred KB per element is fine.
 */
class PathChunks {
    parts: string[] = [];
    private cur = "";
    private n = 0;
    constructor(private per = 1500) {}
    add(shape: string) { this.cur += shape; if (++this.n >= this.per) this.flush(); }
    flush() { if (this.cur) this.parts.push(this.cur); this.cur = ""; this.n = 0; }
    done() { this.flush(); return this.parts; }
}


/**
 * Travel time from one stop to every other over the shown lines, simulation seconds: Dijkstra
 * on (stop, line) states — riding costs the leg's planned duration, boarding or changing to a
 * line costs half its headway (the expected wait). Returns Infinity for the unreachable.
 */
const reachFrom = (net: { stops: NetStop[]; lines: NetLine[] }, start: number, shown: (l: NetLine) => boolean, headwayOf: (l: NetLine) => number): number[] => {
    const best = new Array(net.stops.length).fill(Infinity);
    const key = (s: number, l: number) => s * net.lines.length + l;
    const dist = new Map<number, number>();
    // A plain array as the frontier; networks are hundreds of stops, not millions.
    const open: { s: number; l: number; c: number }[] = [];
    best[start] = 0;
    for (const li of net.stops[start].lineIds ?? []) {
        const l = net.lines[li];
        if (!l || !shown(l) || headwayOf(l) <= 0) continue;
        const c = headwayOf(l) / 2;
        dist.set(key(start, li), c);
        open.push({ s: start, l: li, c });
    }
    while (open.length) {
        let bi = 0;
        for (let i = 1; i < open.length; i++) if (open[i].c < open[bi].c) bi = i;
        const { s, l, c } = open.splice(bi, 1)[0];
        if (c > (dist.get(key(s, l)) ?? Infinity)) continue;
        const line = net.lines[l];
        const pos = line.stops.indexOf(s);
        if (pos < 0) continue;
        // Ride to the next stop on this line.
        const nextS = line.stops[(pos + 1) % line.stops.length];
        const ride = c + (line.legDurations?.[pos] ?? 0);
        const relax = (ns: number, nl: number, nc: number) => {
            const k = key(ns, nl);
            if (nc < (dist.get(k) ?? Infinity)) { dist.set(k, nc); open.push({ s: ns, l: nl, c: nc }); }
            if (nc < best[ns]) best[ns] = nc;
        };
        relax(nextS, l, ride);
        // Change to another line here (expected wait = half its headway).
        for (const li of net.stops[s].lineIds ?? []) {
            if (li === l) continue;
            const other = net.lines[li];
            if (!other || !shown(other) || headwayOf(other) <= 0) continue;
            relax(s, li, c + headwayOf(other) / 2);
        }
    }
    return best;
};

/** Simulation seconds → clock minutes (a game day is 4369 s and 1440 clock minutes). */
const toClockMinutes = (seconds: number) => (seconds * 1440) / 4369;

export const NetworkPanel = ({ typeSel, onOpenInPlanner }: { typeSel: TypeSelection; onOpenInPlanner: (entity: NetLine["entity"], type: number, cargo: boolean) => void }) => {
    const net = useValue(network$.binding);
    const vehicles = useValue(networkVehicles$.binding);
    const [showVehicles, setShowVehicles] = useState(true);
    const selected = useValue(selected$.binding);
    const rem = useRem();
    const host = useRef<HTMLDivElement | null>(null);
    const rect = vanilla.useElementRect(host);
    const [view, setView] = useState<View | null>(null);
    const [hover, setHover] = useState<Hover>(null);
    const [byLoad, setByLoad] = useState(false);
    const [showDistricts, setShowDistricts] = useState(true);
    const [showRoads, setShowRoads] = useState(true);
    const [showGround, setShowGround] = useState(true);
    const [showTerrain, setShowTerrain] = useState(true);
    const [showCatchment, setShowCatchment] = useState(false);
    const [showLabels, setShowLabels] = useState(true);
    const [catchmentM, setCatchmentM] = useState(400);
    // Reach: pick a stop, colour every stop by travel time from it (clock minutes, three bands up to `reachMax`).
    const [reachMode, setReachMode] = useState(false);
    const [reachFromStop, setReachFromStop] = useState<number>(-1);
    const [reachMax, setReachMax] = useState(30);
    // Planning layers (network-extras.tsx): the scrubbed hour (null = live), coverage gaps, the
    // schematic layout, the departure board's stop, a frozen reach to compare against, and a
    // line whose stops are being edited on the map.
    const [hour, setHour] = useState<number | null>(null);
    const [playing, setPlaying] = useState(false);
    const now = useValue(timeOfDay$.binding);
    const [showGaps, setShowGaps] = useState(false);
    const gaps = useValue(networkGaps$.binding);
    const [schematic, setSchematic] = useState(false);
    const [boardStop, setBoardStop] = useState(-1);
    const [frozenReach, setFrozenReach] = useState<number[] | null>(null);
    const [editing, setEditing] = useState<{ line: NetLine; stops: Entity[] } | null>(null);
    const terrain = useValue(networkTerrain$.binding);
    // Terrain: one path per height band plus one for water, as horizontal runs of cells merged
    // into rectangles (world space, built once per version like the roads).
    const terrainPaths = useMemo(() => {
        const n = terrain.cells;
        if (!n) return { bands: [] as string[][], water: [] as string[] };
        const rect = (i0: number, i1: number, j: number) => {
            const x = terrain.originX + i0 * terrain.cellX, y = terrain.originY + j * terrain.cellY;
            const w = (i1 - i0) * terrain.cellX, h = terrain.cellY;
            // Absolute commands only; the relative h/v forms are not something to trust here.
            const x1 = (x + w).toFixed(0), y1 = (y + h).toFixed(0), x0 = x.toFixed(0), y0 = y.toFixed(0);
            return `M${x0} ${y0}L${x1} ${y0}L${x1} ${y1}L${x0} ${y1}Z`;
        };
        const runs = (pick: (k: number) => boolean) => {
            const d = new PathChunks(2000);
            for (let j = 0; j < n; j++) {
                let i = 0;
                while (i < n) {
                    if (!pick(j * n + i)) { i++; continue; }
                    const i0 = i;
                    while (i < n && pick(j * n + i)) i++;
                    d.add(rect(i0, i, j));
                }
            }
            return d.done();
        };
        const bands: string[][] = [];
        for (let b = 0; b < terrain.bands; b++) bands.push(runs((k) => terrain.water[k] === 0 && terrain.band[k] === b));
        return { bands, water: runs((k) => terrain.water[k] === 1) };
    }, [terrain.version]);
    const ground = useValue(networkGround$.binding);
    // Ground, same recipe as the roads: world-space path strings built once per version.
    const groundPaths = useMemo(() => {
        const blocks = new PathChunks(1500);
        const b = ground.blocks ?? [];
        for (let i = 0; i + 7 < b.length; i += 8) {
            blocks.add(`M${b[i].toFixed(0)} ${b[i + 1].toFixed(0)}L${b[i + 2].toFixed(0)} ${b[i + 3].toFixed(0)}L${b[i + 4].toFixed(0)} ${b[i + 5].toFixed(0)}L${b[i + 6].toFixed(0)} ${b[i + 7].toFixed(0)}Z`);
        }
        const buildings = new PathChunks(1500);
        const g = ground.buildings ?? [];
        for (let i = 0; i + 4 < g.length; i += 5) {
            // A rectangle of sizeX × sizeZ around (x, z), rotated by yaw (the building's forward).
            const cx = g[i], cy = g[i + 1], hw = g[i + 2] / 2, hh = g[i + 3] / 2;
            const a = (g[i + 4] * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
            const p = (dx: number, dy: number) => `${(cx + dx * ca + dy * sa).toFixed(0)} ${(cy - dx * sa + dy * ca).toFixed(0)}`;
            buildings.add(`M${p(-hw, -hh)}L${p(hw, -hh)}L${p(hw, hh)}L${p(-hw, hh)}Z`);
        }
        return { blocks: blocks.done(), buildings: buildings.done() };
    }, [ground.version]);
    const roads = useValue(networkRoads$.binding);
    // Road paths are built once per layer version in WORLD coordinates and moved with one SVG
    // transform, so panning a 20k-edge city never rebuilds a string. Bucketed by width so the
    // three groups can carry a stroke each (stroke width is in world metres under the transform).
    const roadPaths = useMemo(() => {
        const build = (arr: number[]) => {
            const buckets = [new PathChunks(1500), new PathChunks(1500), new PathChunks(1500)];
            for (let i = 0; i + 6 < arr.length; i += 7) {
                const w = arr[i + 6];
                const b = w < 12 ? 0 : w < 24 ? 1 : 2;
                buckets[b].add(`M${arr[i].toFixed(0)} ${arr[i + 1].toFixed(0)}L${arr[i + 2].toFixed(0)} ${arr[i + 3].toFixed(0)}L${arr[i + 4].toFixed(0)} ${arr[i + 5].toFixed(0)}`);
            }
            return buckets.map((c) => c.done());
        };
        return { roads: build(roads.roads ?? []), tracks: build(roads.tracks ?? []) };
    }, [roads.version]);
    const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
    const FloatingMouseTooltip = vanilla.FloatingMouseTooltip;
    const { Checkbox } = vanilla;

    // Filter / focus: hidden lines (by entity index), a problems-only switch, and click-to-solo.
    const [hidden, setHidden] = useState<Set<number>>(new Set());
    const [problemsOnly, setProblemsOnly] = useState(false);
    const hasProblem = (l: NetLine) => l.notEnoughVehicles || (l.capacity > 0 && l.riders / l.capacity >= 0.9);
    const shownLine = useCallback((l: NetLine) => !hidden.has(l.entity.index) && (!problemsOnly || hasProblem(l)), [hidden, problemsOnly]);
    const shownLineIdx = (li: number) => { const l = net.lines[li]; return !!l && shownLine(l); };
    const stopShown = (s: NetStop) => (s.lineIds ?? []).some(shownLineIdx);
    const vehicleShown = (v: NetVehicle) => { const l = net.lines.find((x) => sameEntity(x.entity, v.line)); return !!l && shownLine(l); };
    const toggleHidden = (l: NetLine) => setHidden((h) => { const n = new Set(h); if (n.has(l.entity.index)) n.delete(l.entity.index); else n.add(l.entity.index); return n; });
    const solo = (l: NetLine) => setHidden((h) => {
        const others = net.lines.filter((x) => !sameEntity(x.entity, l.entity)).map((x) => x.entity.index);
        const alreadySolo = !h.has(l.entity.index) && others.every((i) => h.has(i));
        return alreadySolo ? new Set() : new Set(others);
    });

    // Schematic: every stop's position on the simplified layout; world positions otherwise.
    const layout = useMemo(() => (schematic ? schematicLayout(net) : null), [schematic, net]);
    const stopIndex = useMemo(() => new Map(net.stops.map((st, i) => [st, i] as [NetStop, number])), [net]);
    const posOf = useCallback((st: NetStop) => (layout ? layout[stopIndex.get(st) ?? 0] ?? st : st), [layout, stopIndex]);
    const live = hour === null;

    // Tell C# which type to read; the data is stale until it answers.
    useEffect(() => { setNetworkType(typeSel.type, typeSel.cargo); touched.current = false; fitted.current = null; setHidden(new Set()); }, [typeSel.type, typeSel.cargo]);
    const ready = net.valid && net.type === typeSel.type && net.cargo === typeSel.cargo;

    // Fit the whole network on first sight of a type.
    const bounds = useMemo(() => {
        if (!ready || net.stops.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const st of net.stops) { const s = posOf(st); minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y); }
        return { minX, minY, maxX, maxY };
    }, [ready, net.stops.length, net.type, net.cargo, schematic]);
    // Until the player pans or zooms, keep refitting: the canvas reports a small size on its first
    // layout pass and grows afterwards, and a fit taken then is wildly zoomed in.
    const touched = useRef(false);
    const [fitTick, setFitTick] = useState(0);
    const fitted = useRef<{ w: number; h: number; b: typeof bounds } | null>(null);
    useEffect(() => {
        if (!bounds || !rect || rect.width === 0 || rect.height === 0) return;
        // Refit only on a real change of size or data, never because the view object changed —
        // depending on `view` here looped forever (set → effect → set).
        const f = fitted.current;
        if (touched.current || (f && f.w === rect.width && f.h === rect.height && f.b === bounds)) return;
        fitted.current = { w: rect.width, h: rect.height, b: bounds };
        const w = Math.max(200, bounds.maxX - bounds.minX);
        const h = Math.max(200, bounds.maxY - bounds.minY);
        const scale = 0.9 * Math.min(rect.width / w, rect.height / h);
        setView({ cx: (bounds.minX + bounds.maxX) / 2, cy: (bounds.minY + bounds.maxY) / 2, scale });
    }, [bounds, rect?.width, rect?.height, fitTick]);
    const fit = () => { touched.current = false; fitted.current = null; setFitTick((t) => t + 1); };
    // Switching layouts moves every stop: refit.
    useEffect(() => { fit(); }, [schematic]);
    const move = (f: (v: View) => View) => { touched.current = true; setView((v) => (v ? f(v) : v)); };

    const W = rect?.width ?? 0;
    const H = rect?.height ?? 0;
    // World z grows north; screen y grows down.
    const px = useCallback((x: number, y: number) => (view ? { x: (x - view.cx) * view.scale + W / 2, y: (view.cy - y) * view.scale + H / 2 } : { x: 0, y: 0 }), [view, W, H]);
    const world = (sx: number, sy: number) => (view ? { x: (sx - W / 2) / view.scale + view.cx, y: view.cy - (sy - H / 2) / view.scale } : { x: 0, y: 0 });
    const local = (e: React.MouseEvent) => ({ x: e.clientX - (rect?.x ?? 0), y: e.clientY - (rect?.y ?? 0) });
    /** A stop's screen position, on the schematic layout when it is on. */
    const pp = (st: NetStop) => { const q = posOf(st); return px(q.x, q.y); };

    // Wheel: zoom around the cursor. Capture phase + stopPropagation so the panel's Scrollable
    // does not move (same fix as the timeline).
    useEffect(() => {
        const el = host.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault(); e.stopPropagation();
            touched.current = true;
            setView((v) => {
                if (!v) return v;
                const sx = e.clientX - (rect?.x ?? 0), sy = e.clientY - (rect?.y ?? 0);
                const before = { x: (sx - W / 2) / v.scale + v.cx, y: v.cy - (sy - H / 2) / v.scale };
                const scale = Math.max(0.005, Math.min(5, v.scale * (e.deltaY > 0 ? 1 / 1.2 : 1.2)));
                return { scale, cx: before.x - (sx - W / 2) / scale, cy: before.y + (sy - H / 2) / scale };
            });
        };
        el.addEventListener("wheel", onWheel, true);
        return () => el.removeEventListener("wheel", onWheel, true);
    }, [rect?.x, rect?.y, W, H]);

    // A line's drawn points: the real route geometry when the game has it, else stop to stop.
    const linePoints = useCallback((l: NetLine): { x: number; y: number }[] => {
        if (layout) {
            // Schematic: octilinear legs between the laid-out stops, closing the loop.
            const out: { x: number; y: number }[] = [];
            l.stops.forEach((si, k) => {
                const a = layout[si], b = layout[l.stops[(k + 1) % l.stops.length]];
                const seg = octilinear(a, b);
                out.push(...seg.slice(0, seg.length - 1));
            });
            return out;
        }
        if (l.path && l.path.length >= 4) {
            const out: { x: number; y: number }[] = [];
            for (let i = 0; i + 1 < l.path.length; i += 2) out.push({ x: l.path[i], y: l.path[i + 1] });
            return out;
        }
        return l.stops.map((i) => ({ x: net.stops[i].x, y: net.stops[i].y }));
    }, [net, layout]);

    // Legs for load colouring: stop k → stop k+1 as a run of point indices into linePoints(l),
    // coloured by the mean load of the vehicles heading to stop k+1 (null when none is on it).
    const legLoads = useCallback((l: NetLine): Leg[] | null => {
        const n = l.stops.length;
        if (n < 2 || layout || !live) return null;
        const usePath = l.path && l.path.length >= 4 && l.legStarts && l.legStarts.length === n;
        const total = usePath ? l.path.length / 2 : n;
        const starts = usePath ? l.legStarts : l.stops.map((_, k) => k);
        const loads: (number | null)[] = new Array(n).fill(null);
        const counts: number[] = new Array(n).fill(0);
        const volumes: number[] = new Array(n).fill(0);
        for (const v of vehicles) {
            if (!sameEntity(v.line, l.entity) || v.nextStop < 0 || v.nextStop >= n || v.returning) continue;
            const k = (v.nextStop + n - 1) % n; // the leg that ends at nextStop starts at the stop before
            const load = v.capacity > 0 ? v.riders / v.capacity : 0;
            loads[k] = (loads[k] ?? 0) + load;
            counts[k]++;
            volumes[k] += v.riders;
        }
        return starts.map((s, k) => {
            const e = starts[(k + 1) % n];
            const points: number[] = [];
            for (let i = s; ; i = (i + 1) % total) { points.push(i); if (i === e) break; if (points.length > total) break; }
            return { points, load: counts[k] > 0 ? (loads[k] as number) / counts[k] : null, volume: volumes[k] };
        });
    }, [vehicles, layout, live]);

    // Bandwidth: the busiest leg of the shown lines is the widest, the rest by √volume (a flow
    // map's line-width-by-tonnage, as freight atlases draw rail flows).
    const maxVolume = useMemo(() => {
        let m = 0;
        for (const v of vehicles) if (!v.returning) m = Math.max(m, v.riders);
        return m;
    }, [vehicles]);
    const bandWidth = (volume: number, base: number) =>
        maxVolume > 0 ? base * 0.6 + rem * 12 * Math.sqrt(Math.min(1, volume / maxVolume)) : base;

    // Right-click menu: what was under the cursor and where to draw it. Sketch: stops picked
    // for a new line, in order; "Finish" hands them to C# and the placement pipeline.
    const [menu, setMenu] = useState<{ x: number; y: number; target: Hover } | null>(null);
    const [sketch, setSketch] = useState<Entity[]>([]);
    const inSketch = (e: Entity) => sketch.some((s) => sameEntity(s, e));
    const closeMenu = () => setMenu(null);
    const finishSketch = () => { if (sketch.length >= 2) createLine(net.type, net.cargo, sketch); setSketch([]); closeMenu(); };

    const reach = useMemo(() => {
        if (!reachMode || reachFromStop < 0 || reachFromStop >= net.stops.length) return null;
        return reachFrom(net, reachFromStop, shownLine, (l) => headwayAt(l, hour)).map(toClockMinutes);
    }, [reachMode, reachFromStop, net, shownLine, hour]);
    // In-world overlay through the game's overlay renderer: mirrors catchment / reach into the
    // 3-D view, plus the hovered line along its real curves. Sent whenever the inputs change.
    const [inWorld, setInWorld] = useState(false);
    const infoviewOn = useValue(infoviewActive$.binding);
    useEffect(() => {
        const shownStops = net.stops.filter(stopShown);
        if (reach) {
            const idx = net.stops.map((s, i) => i).filter((i) => stopShown(net.stops[i]));
            setWorldOverlay({ mode: 2, radius: 0, reachMax, stops: idx.map((i) => net.stops[i].entity), values: idx.map((i) => (Number.isFinite(reach[i]) ? reach[i] : -1)), force: inWorld });
        } else if (showCatchment) {
            setWorldOverlay({ mode: 1, radius: catchmentM, reachMax, stops: shownStops.map((s) => s.entity), values: [], force: inWorld });
        } else {
            setWorldOverlay({ mode: 0, radius: 0, reachMax, stops: [], values: [], force: inWorld });
        }
    }, [inWorld, reach, showCatchment, catchmentM, reachMax, net, hidden, problemsOnly]);
    useEffect(() => { setWorldHighlight(hover?.kind === "line" ? hover.line.entity : selected); }, [hover?.kind === "line" ? hover.line.entity.index : -1, selected.index]);
    useEffect(() => () => { setWorldOverlay({ mode: 0, radius: 0, reachMax: 0, stops: [], values: [], force: false }); setWorldHighlight({ index: 0, version: 0 }); }, []);

    /** Against a frozen result: green where the stop got closer, red where further, grey where the same. */
    const deltaHue = (i: number) => {
        if (!frozenReach || !reach) return null;
        const a = frozenReach[i], b = reach[i];
        if (!Number.isFinite(a) && !Number.isFinite(b)) return null;
        if (!Number.isFinite(a)) return "rgb(80, 220, 120)";
        if (!Number.isFinite(b)) return "rgb(255, 80, 70)";
        return b < a - 1 ? "rgb(80, 220, 120)" : b > a + 1 ? "rgb(255, 80, 70)" : "rgba(200, 200, 200, 0.6)";
    };
    const reachHue = (min: number) => (min <= reachMax / 3 ? "rgb(80, 220, 120)" : min <= (2 * reachMax) / 3 ? "rgb(255, 200, 70)" : min <= reachMax ? "rgb(255, 110, 60)" : null);

    // Labels: stop names once zoomed in (interchanges first, they matter most), line names at
    // each loop's midpoint; a label whose box overlaps one already placed is skipped, so dense
    // areas show the important few instead of a pile. Widths are estimated from the text.
    const nameStr = vanilla.useNameFormat();
    const labels = useMemo(() => {
        if (!view || !showLabels) return [] as { key: string; x: number; y: number; text: string; kind: "stop" | "line"; color?: string }[];
        const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
        const out: { key: string; x: number; y: number; text: string; kind: "stop" | "line"; color?: string }[] = [];
        const fits = (x: number, y: number, w: number, h: number) => {
            const b = { x0: x, y0: y - h, x1: x + w, y1: y };
            if (b.x1 < 0 || b.y1 < 0 || b.x0 > W || b.y0 > H) return false;
            if (placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0)) return false;
            placed.push(b);
            return true;
        };
        const charW = rem * 6.5, lineH = rem * 13;
        // Line names at the loop midpoint, always (they are few).
        for (const l of net.lines.filter(shownLine)) {
            const pts = linePoints(l);
            if (pts.length === 0) continue;
            const m = pts[Math.floor(pts.length / 2)];
            const q = px(m.x, m.y);
            const text = nameStr(l.name);
            const w = text.length * charW;
            if (fits(q.x + rem * 6, q.y - rem * 4, w, lineH)) out.push({ key: `L${l.entity.index}`, x: q.x + rem * 6, y: q.y - rem * 4, text, kind: "line", color: cssColor(l.color) });
        }
        // Stop names past a zoom threshold: interchanges first, then the rest.
        if (view.scale * 500 > rem * 40) {
            const stops = net.stops.filter(stopShown).sort((a, b) => b.lines - a.lines);
            for (const s of stops) {
                if (s.lines < 2 && view.scale * 500 < rem * 120) break; // single-line stops only when closer
                const q = pp(s);
                const text = nameStr(s.name);
                const w = text.length * charW;
                if (fits(q.x + rem * 7, q.y + rem * 4, w, lineH)) out.push({ key: `S${s.entity.index}`, x: q.x + rem * 7, y: q.y + rem * 4, text, kind: "stop" });
            }
        }
        return out;
    }, [view, showLabels, net, W, H, rem, shownLine, linePoints, nameStr, posOf]);

    const onMouseDown = (e: React.MouseEvent) => {
        if (!view) return;
        if (menu) { closeMenu(); return; }
        if (e.button === 2) {
            // Right-click: the menu for whatever is under the cursor (or the sketch menu on empty space).
            const p = local(e);
            setMenu({ x: p.x, y: p.y, target: hover });
            return;
        }
        // Editing a line: a click on one of its stops takes it out, on another stop puts it in
        // where it adds the least distance.
        if (hover?.kind === "stop" && editing) {
            const e0 = hover.stop.entity;
            setEditing((ed) => {
                if (!ed) return ed;
                if (ed.stops.some((x) => sameEntity(x, e0))) return { ...ed, stops: ed.stops.filter((x) => !sameEntity(x, e0)) };
                const order = ed.stops.map((e) => net.stops.find((st) => sameEntity(st.entity, e))).filter((st): st is NetStop => !!st);
                const at = bestInsert(order, hover.stop);
                const next = [...ed.stops];
                next.splice(at, 0, e0);
                return { ...ed, stops: next };
            });
            return;
        }
        // While sketching, a left-click on a stop appends it (or removes it again).
        if (hover?.kind === "stop" && sketch.length > 0) {
            const s = hover.stop.entity;
            setSketch((k) => (k.some((x) => sameEntity(x, s)) ? k.filter((x) => !sameEntity(x, s)) : [...k, s]));
            return;
        }
        if (hover?.kind === "stop" && reachMode) { setReachFromStop(net.stops.indexOf(hover.stop)); return; }
        if (hover?.kind === "stop") { setBoardStop(net.stops.indexOf(hover.stop)); return; }
        if (hover?.kind === "vehicle") { goTo(hover.vehicle.entity); return; }
        if (hover?.kind === "depot") { goTo(hover.depot.entity); return; }
        if (hover?.kind === "line") { onOpenInPlanner(hover.line.entity, net.type, net.cargo); return; }
        const p = local(e);
        drag.current = { x: p.x, y: p.y, cx: view.cx, cy: view.cy };
    };
    const onMouseMove = (e: React.MouseEvent) => {
        if (!view || menu) return; // the menu owns the mouse while it is open
        const p = local(e);
        if (drag.current) {
            const d = drag.current;
            move((v) => ({ ...v, cx: d.cx - (p.x - d.x) / v.scale, cy: d.cy + (p.y - d.y) / v.scale }));
            return;
        }
        // Hit test: stops first (within 8rem), then lines (within 5rem of a segment).
        const tolS = rem * 8, tolL = rem * 5;
        let next: Hover = null;
        let best = tolS;
        if (showVehicles && live && !layout) {
            for (const v of vehicles) {
                if (!vehicleShown(v)) continue;
                const q = px(v.x, v.y);
                const d = Math.hypot(q.x - p.x, q.y - p.y);
                if (d < best) { best = d; next = { kind: "vehicle", vehicle: v }; }
            }
        }
        if (!next) for (const d of net.depots ?? []) {
            const q = px(d.x, d.y);
            const dist = Math.hypot(q.x - p.x, q.y - p.y);
            if (dist < best) { best = dist; next = { kind: "depot", depot: d }; }
        }
        if (!next) for (const s of net.stops) {
            if (!stopShown(s)) continue;
            const q = pp(s);
            const d = Math.hypot(q.x - p.x, q.y - p.y);
            if (d < best) { best = d; next = { kind: "stop", stop: s }; }
        }
        if (!next) {
            best = tolL;
            for (const l of net.lines) {
                if (!shownLine(l)) continue;
                const pts = linePoints(l);
                for (let i = 0; i < pts.length; i++) {
                    const a = px(pts[i].x, pts[i].y);
                    const bW = pts[(i + 1) % pts.length];
                    const b = px(bW.x, bW.y);
                    const d = distToSegment(p, a, b);
                    if (d < best) { best = d; next = { kind: "line", line: l }; }
                }
            }
        }
        setHover((prev) => (sameHover(prev, next) ? prev : next));
    };
    const onMouseUp = () => { drag.current = null; };
    const onMouseLeave = () => { drag.current = null; setHover(null); };

    const w = world(0, 0); void w;
    const title = `${typeLabel[typeSel.type] ?? "?"} ${typeSel.cargo ? "routes" : "lines"} network`;

    return (
        <div className={styles.page}>
            <div className={classNames(panel.row, styles.bar)}>
                <span className={panel.sectionTitle}>{title}</span>
                <HelpButton section={reachMode ? "network.reach" : schematic ? "network.schematic" : "network.map"} inline />
                <span className={panel.spacer} />
                <FlatButton selected={byLoad} onClick={() => setByLoad(!byLoad)}>{byLoad ? "Colour: load" : "Colour: line"}</FlatButton>
                <LayersDropdown layers={[
                    { label: "Vehicles", on: showVehicles, set: setShowVehicles, extra: `${vehicles.length} now, live only` },
                    { label: "Labels", on: showLabels, set: setShowLabels },
                    { label: "Catchment", on: showCatchment, set: setShowCatchment, extra: `${catchmentM} m walking radius` },
                    { label: "Gaps", on: showGaps, set: setShowGaps, extra: "people with no stop within 400 m" },
                    { label: "Terrain", on: showTerrain, set: setShowTerrain },
                    { label: "Buildings", on: showGround, set: setShowGround },
                    { label: "Roads", on: showRoads, set: setShowRoads },
                    { label: "Districts", on: showDistricts, set: setShowDistricts },
                ]} />
                {showCatchment && (
                    <>
                        <FlatButton onClick={() => setCatchmentM((m) => Math.max(100, m - 100))}>−</FlatButton>
                        <FlatButton onClick={() => setCatchmentM((m) => Math.min(1500, m + 100))}>+</FlatButton>
                    </>
                )}
                <FlatButton selected={problemsOnly} onClick={() => setProblemsOnly(!problemsOnly)}>Problems only</FlatButton>
                <FlatButton selected={schematic} onClick={() => setSchematic(!schematic)} tooltip="A simplified tube-map layout of the network">Schematic</FlatButton>
                <FlatButton selected={reachMode} onClick={() => { setReachMode(!reachMode); if (reachMode) setReachFromStop(-1); }} tooltip="Click a stop: colour every stop by travel time from it">Reach</FlatButton>
                {reachMode && (
                    <>
                        <FlatButton onClick={() => setReachMax((m) => Math.max(5, m - 5))}>−</FlatButton>
                        <span className={panel.inlineHint}>{`${reachMax} min`}</span>
                        <FlatButton onClick={() => setReachMax((m) => Math.min(120, m + 5))}>+</FlatButton>
                        <FlatButton selected={!!frozenReach} disabled={!reach && !frozenReach} onClick={() => setFrozenReach(frozenReach ? null : reach)}
                            tooltip="Keep this result, change something (a schedule, the hour), and see which stops got closer (green) or further (red)">
                            {frozenReach ? "Unfreeze" : "Freeze"}
                        </FlatButton>
                    </>
                )}
                <FlatButton selected={inWorld} onClick={() => setInWorld(!inWorld)} tooltip="Draw catchment / reach and the hovered line in the 3-D world">In world</FlatButton>
                <FlatButton selected={infoviewOn} onClick={() => openInfoview()} tooltip="Open the Transit Planner infoview (transit lines, coverage, planner overlays)">Infoview</FlatButton>
                <FlatButton onClick={fit}>Fit</FlatButton>
                {/* 1:1 = one screen pixel per metre, around the current centre. */}
                <FlatButton selected={!!view && Math.abs(view.scale - 1) < 0.01} onClick={() => move((v) => ({ ...v, scale: 1 }))} tooltip="One pixel per metre">1:1</FlatButton>
                <FlatButton onClick={() => move((v) => ({ ...v, scale: Math.min(5, v.scale * 2) }))}>+</FlatButton>
                <FlatButton onClick={() => move((v) => ({ ...v, scale: Math.max(0.005, v.scale / 2) }))}>−</FlatButton>
            </div>
            <div className={styles.split}>
            <div ref={host} className={styles.canvas} onMouseDown={onMouseDown} onMouseMove={onMouseMove} onMouseUp={onMouseUp} onMouseLeave={onMouseLeave} onContextMenu={(e) => e.preventDefault()}>
                <FloatingMouseTooltip screenSpacePosition alwaysVisible disabled={!hover || !!menu} tooltip={hover ? <Tip hover={hover} reachMinutes={reach && hover.kind === "stop" ? reach[net.stops.indexOf(hover.stop)] : undefined} /> : null} />
                {view && ready && (
                    <svg className={styles.svg} width={W} height={H}>
                        {/* Roads and tracks in world space: matrix(s 0 0 -s tx ty) is exactly px(). Widths are real metres, floored to a pixel and a half. */}
                        {/* Terrain under everything: height bands light → dark, water blue. */}
                        {!layout && showTerrain && terrainPaths.bands.length > 0 && (
                            <g transform={`matrix(${view.scale} 0 0 ${-view.scale} ${W / 2 - view.cx * view.scale} ${H / 2 + view.cy * view.scale})`}>
                                {terrainPaths.bands.map((parts, b) => parts.map((d, k) => (
                                    <path key={`b${b}-${k}`} d={d} className={styles.terrain} style={{ fillOpacity: 0.05 + (0.18 * b) / Math.max(1, terrainPaths.bands.length - 1) }} />
                                )))}
                                {terrainPaths.water.map((d, k) => <path key={`w${k}`} d={d} className={styles.water} />)}
                            </g>
                        )}
                        {!layout && showGround && (
                            <g transform={`matrix(${view.scale} 0 0 ${-view.scale} ${W / 2 - view.cx * view.scale} ${H / 2 + view.cy * view.scale})`}>
                                {groundPaths.blocks.map((d, k) => <path key={`bl${k}`} d={d} className={styles.block} />)}
                                {view.scale * 500 > rem * 12 && groundPaths.buildings.map((d, k) => <path key={`bd${k}`} d={d} className={styles.building} />)}
                            </g>
                        )}
                        {!layout && showRoads && (
                            <g transform={`matrix(${view.scale} 0 0 ${-view.scale} ${W / 2 - view.cx * view.scale} ${H / 2 + view.cy * view.scale})`}>
                                {roadPaths.roads.map((parts, b) => parts.map((d, k) => (
                                    <path key={`r${b}-${k}`} d={d} className={styles.road} style={{ strokeWidth: Math.max([8, 16, 28][b], 1.5 / view.scale) }} />
                                )))}
                                {roadPaths.tracks.map((parts, b) => parts.map((d, k) => (
                                    <path key={`t${b}-${k}`} d={d} className={styles.track} style={{ strokeWidth: Math.max([4, 8, 12][b], 1.5 / view.scale) }} />
                                )))}
                            </g>
                        )}
                        {/* Stop catchment: a walking radius around every shown stop, world metres. */}
                        {/* Coverage gaps: a square per 200 m cell of people with no stop in walking range, brighter with more people. */}
                        {!layout && showGaps && (
                            <g transform={`matrix(${view.scale} 0 0 ${-view.scale} ${W / 2 - view.cx * view.scale} ${H / 2 + view.cy * view.scale})`}>
                                {(() => {
                                    const c = gaps.cells ?? [];
                                    const half = (gaps.cell || 200) / 2;
                                    const out: JSX.Element[] = [];
                                    for (let i = 0; i + 2 < c.length; i += 3) {
                                        const o = Math.min(0.75, 0.12 + 0.1 * Math.log2(1 + c[i + 2]));
                                        out.push(<rect key={i} x={c[i] - half} y={c[i + 1] - half} width={half * 2} height={half * 2} className={styles.gap} style={{ fillOpacity: o }} />);
                                    }
                                    return out;
                                })()}
                            </g>
                        )}
                        {/* Reach isochrones: the walking catchment left from every reached stop (80 m per clock minute, 600 m at most), coloured by band. */}
                        {!layout && reach && (
                            <g transform={`matrix(${view.scale} 0 0 ${-view.scale} ${W / 2 - view.cx * view.scale} ${H / 2 + view.cy * view.scale})`}>
                                {net.stops.map((st, i) => {
                                    const m = reach[i];
                                    const hue = Number.isFinite(m) ? reachHue(m) : null;
                                    if (!hue || !stopShown(st)) return null;
                                    return <circle key={`iso${st.entity.index}`} cx={st.x} cy={st.y} r={Math.min(600, Math.max(60, (reachMax - m) * 80))} className={styles.isochrone} style={{ fill: hue }} />;
                                })}
                            </g>
                        )}
                        {!layout && showCatchment && (
                            <g transform={`matrix(${view.scale} 0 0 ${-view.scale} ${W / 2 - view.cx * view.scale} ${H / 2 + view.cy * view.scale})`}>
                                {net.stops.filter(stopShown).map((s) => <circle key={`c${s.entity.index}`} cx={s.x} cy={s.y} r={catchmentM} className={styles.catchment} />)}
                            </g>
                        )}
                        {/* District outlines, for orientation; names when zoomed in. */}
                        {!layout && showDistricts && (net.districts ?? []).map((d) => {
                            const pts: { x: number; y: number }[] = [];
                            for (let i = 0; i + 1 < d.points.length; i += 2) pts.push(px(d.points[i], d.points[i + 1]));
                            if (pts.length < 3) return null;
                            const path = pts.map((q, k) => `${k === 0 ? "M" : "L"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ") + " Z";
                            const c = pts.reduce((a, q) => ({ x: a.x + q.x / pts.length, y: a.y + q.y / pts.length }), { x: 0, y: 0 });
                            return (
                                <g key={`dist${d.entity.index}`}>
                                    <path d={path} className={styles.district} />
                                    {view.scale * 500 > rem * 40 && <text x={c.x} y={c.y} textAnchor="middle" className={styles.districtLabel}><LocalizedEntityName value={d.name} /></text>}
                                </g>
                            );
                        })}
                        {/* Depot → bound line links, underneath everything: a dashed line to the line's nearest stop. */}
                        {(net.depots ?? []).map((d) => {
                            const q = px(d.x, d.y);
                            return (d.boundLines ?? []).filter(shownLineIdx).map((li) => {
                                const l = net.lines[li];
                                if (!l) return null;
                                let bestS = -1, bestD = Infinity;
                                for (const si of l.stops) { const s = net.stops[si]; const dd = Math.hypot(s.x - d.x, s.y - d.y); if (dd < bestD) { bestD = dd; bestS = si; } }
                                if (bestS < 0) return null;
                                const t = pp(net.stops[bestS]);
                                return <line key={`dl${d.entity.index}-${li}`} x1={q.x} y1={q.y} x2={t.x} y2={t.y} className={classNames(styles.depotLink, d.starved && styles.depotLinkStarved)} style={{ stroke: d.starved ? undefined : cssColor(l.color), strokeDasharray: `${rem * 4} ${rem * 4}` }} />;
                            });
                        })}
                        {net.lines.filter(shownLine).map((l) => {
                            const pts = linePoints(l).map((q) => px(q.x, q.y));
                            const on = sameEntity(l.entity, selected);
                            const hot = hover?.kind === "line" && sameEntity(hover.line.entity, l.entity);
                            // At a scrubbed hour: faded when not running, width from vehicles per hour.
                            const hw = headwayAt(l, hour);
                            const closedNow = !live && hw <= 0;
                            const cls = classNames(styles.line, l.inactive && live && styles.lineInactive, closedNow && styles.lineClosed, (on || hot) && styles.lineHot, hover && !hot && hover.kind === "line" && styles.lineDim);
                            const width = live ? rem * (on || hot ? 5 : 3) : rem * ((on || hot ? 1.5 : 0) + Math.max(1.5, Math.min(7, 1.5 + perHour(hw) / 3)));
                            const legs = byLoad ? legLoads(l) : null;
                            if (!legs) {
                                const d = pts.map((q, k) => `${k === 0 ? "M" : "L"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ") + " Z";
                                const histLoad = !live ? l.history?.[hour as number] ?? -1 : -1;
                                const stroke = byLoad && !live ? (histLoad >= 0 ? loadHue(histLoad) : "rgba(255,255,255,0.25)") : cssColor(l.color);
                                return <path key={l.entity.index} d={d} className={cls} style={{ stroke, strokeWidth: width }} />;
                            }
                            // Load per leg: one sub-path per stop→next stop, coloured by the vehicles on it.
                            return (
                                <g key={l.entity.index}>
                                    {legs.map((leg, k) => {
                                        const d = leg.points.map((i, j) => `${j === 0 ? "M" : "L"}${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`).join(" ");
                                        return <path key={k} d={d} className={cls} style={{ stroke: leg.load === null ? "rgba(255,255,255,0.25)" : loadHue(leg.load), strokeWidth: bandWidth(leg.volume, width), strokeLinejoin: "round" }} />;
                                    })}
                                </g>
                            );
                        })}
                        {/* Waiting heat: a soft halo whose radius grows with the queue, under the node. */}
                        {reach && net.stops.map((s, i) => {
                            if (!stopShown(s)) return null;
                            const q = pp(s);
                            const hue = frozenReach ? deltaHue(i) : reachHue(reach[i]);
                            if (i === reachFromStop) return <circle key={`rc${s.entity.index}`} cx={q.x} cy={q.y} r={rem * 14} className={styles.reachOrigin} />;
                            if (!hue) return null;
                            return <circle key={`rc${s.entity.index}`} cx={q.x} cy={q.y} r={rem * 11} className={styles.reachDisc} style={{ fill: hue }} />;
                        })}
                        {!reach && net.stops.filter((s) => s.waiting > 0 && stopShown(s)).map((s) => {
                            const q = pp(s);
                            // Log scale, capped: queues run into the hundreds and a linear halo swallowed the map.
                            const r = rem * Math.min(28, 4 + 5 * Math.log2(1 + s.waiting));
                            return <circle key={`h${s.entity.index}`} cx={q.x} cy={q.y} r={r} className={classNames(styles.halo, s.waiting > 20 && styles.haloBusy)} />;
                        })}
                        {net.stops.filter(stopShown).map((s) => {
                            const q = pp(s);
                            const hot = hover?.kind === "stop" && sameEntity(hover.stop.entity, s.entity);
                            return (
                                <circle
                                    key={s.entity.index}
                                    cx={q.x} cy={q.y}
                                    r={rem * (s.lines > 1 ? 5 : 3) * (hot ? 1.4 : 1)}
                                    className={classNames(styles.stop, s.lines > 1 && styles.interchange, s.waiting > 20 && styles.stopBusy)}
                                />
                            );
                        })}
                        {/* Interchange rings: one arc per line calling at a multi-line stop, in its colour. */}
                        {net.stops.filter((s) => (s.lineIds?.length ?? 0) > 1 && stopShown(s)).map((s) => {
                            const q = pp(s);
                            const ids = s.lineIds;
                            const r = rem * 8;
                            const gap = 0.12;
                            return (
                                <g key={`r${s.entity.index}`}>
                                    {ids.map((li, k) => {
                                        const l = net.lines[li];
                                        if (!l) return null;
                                        const a0 = -Math.PI / 2 + (k / ids.length) * Math.PI * 2 + gap / 2;
                                        const a1 = -Math.PI / 2 + ((k + 1) / ids.length) * Math.PI * 2 - gap / 2;
                                        return <path key={li} d={arcPath(q.x, q.y, r, a0, a1)} className={styles.ring} style={{ stroke: cssColor(l.color), strokeWidth: rem * 2.5 }} />;
                                    })}
                                </g>
                            );
                        })}
                        {/* Depots: squares, red when starved. */}
                        {(net.depots ?? []).map((d) => {
                            const q = px(d.x, d.y);
                            const hot = hover?.kind === "depot" && sameEntity(hover.depot.entity, d.entity);
                            const s = rem * (hot ? 12 : 9);
                            return <rect key={`d${d.entity.index}`} x={q.x - s / 2} y={q.y - s / 2} width={s} height={s} rx={rem * 1.5} className={classNames(styles.depot, d.starved && styles.depotStarved, d.available === 0 && !d.starved && styles.depotEmpty)} />;
                        })}
                        {/* The sketch of a new line: dashed through the picked stops, numbered, closing back to the first. */}
                        {sketch.length > 0 && (() => {
                            const pts = sketch.map((e) => net.stops.find((s) => sameEntity(s.entity, e))).filter((s): s is NetStop => !!s).map((s) => pp(s));
                            if (pts.length === 0) return null;
                            const d = pts.map((q, k) => `${k === 0 ? "M" : "L"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ") + (pts.length > 2 ? " Z" : "");
                            return (
                                <g>
                                    <path d={d} className={styles.sketch} style={{ strokeWidth: rem * 3, strokeDasharray: `${rem * 8} ${rem * 6}` }} />
                                    {pts.map((q, k) => (
                                        <g key={k}>
                                            <circle cx={q.x} cy={q.y} r={rem * 7} className={styles.sketchNode} />
                                            <text x={q.x} y={q.y + rem * 4} textAnchor="middle" className={styles.sketchLabel}>{`${k + 1}`}</text>
                                        </g>
                                    ))}
                                </g>
                            );
                        })()}
                        {boardStop >= 0 && net.stops[boardStop] && (() => { const q = pp(net.stops[boardStop]); return <circle cx={q.x} cy={q.y} r={rem * 12} className={styles.reachOrigin} />; })()}
                        {editing && (() => {
                            const pts = editing.stops.map((e) => net.stops.find((st) => sameEntity(st.entity, e))).filter((st): st is NetStop => !!st).map((st) => pp(st));
                            if (pts.length === 0) return null;
                            const d = pts.map((q, k) => `${k === 0 ? "M" : "L"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ") + (pts.length > 2 ? " Z" : "");
                            return (
                                <g>
                                    <path d={d} className={styles.sketch} style={{ stroke: cssColor(editing.line.color), strokeWidth: rem * 3, strokeDasharray: `${rem * 8} ${rem * 6}` }} />
                                    {pts.map((q, k) => (
                                        <g key={k}>
                                            <circle cx={q.x} cy={q.y} r={rem * 7} className={styles.sketchNode} />
                                            <text x={q.x} y={q.y + rem * 4} textAnchor="middle" className={styles.sketchLabel}>{`${k + 1}`}</text>
                                        </g>
                                    ))}
                                </g>
                            );
                        })()}
                        {showVehicles && live && !layout && vehicles.filter(vehicleShown).map((v) => {
                            const q = px(v.x, v.y);
                            const line = net.lines.find((l) => sameEntity(l.entity, v.line));
                            const load = v.capacity > 0 ? Math.min(1, v.riders / v.capacity) : 0;
                            const hot = hover?.kind === "vehicle" && sameEntity(hover.vehicle.entity, v.entity);
                            const r = rem * (hot ? 6 : 4.5);
                            const stroke = line ? cssColor(line.color) : "white";
                            return (
                                <g key={`v${v.entity.index}`} className={classNames(styles.vehicle, v.returning && styles.vehicleReturning)}>
                                    {/* Ring in the line colour; fill grows with load; hollow while boarding. */}
                                    <circle cx={q.x} cy={q.y} r={r} className={styles.vehicleRing} style={{ stroke }} />
                                    {!v.boarding && load > 0 && <circle cx={q.x} cy={q.y} r={r * Math.sqrt(load)} className={styles.vehicleFill} style={{ fill: stroke }} />}
                                </g>
                            );
                        })}
                        {showLabels && labels.map((l) => (
                            <text key={l.key} x={l.x} y={l.y} className={l.kind === "line" ? styles.lineLabel : styles.label} style={l.kind === "line" ? { fill: l.color } : undefined}>{l.text}</text>
                        ))}
                    </svg>
                )}
                {ready && net.lines.length === 0 && <div className={panel.empty}>No lines of this type.</div>}
                {menu && (
                    <ContextMenu x={menu.x} y={menu.y} target={menu.target} net={net} sketch={sketch} inSketch={inSketch} reachMode={reachMode}
                        onClose={closeMenu}
                        onOpen={(l) => onOpenInPlanner(l.entity, net.type, net.cargo)}
                        onSolo={solo} onHide={(l) => setHidden((h) => new Set(h).add(l.entity.index))}
                        onEdit={(l) => { setSketch([]); setEditing({ line: l, stops: l.stops.map((i) => net.stops[i].entity) }); }}
                        onReach={(s) => { setReachMode(true); setReachFromStop(net.stops.indexOf(s)); }}
                        onSketchAdd={(s) => setSketch((k) => (k.some((x) => sameEntity(x, s.entity)) ? k : [...k, s.entity]))}
                        onSketchRemove={(s) => setSketch((k) => k.filter((x) => !sameEntity(x, s.entity)))}
                        onSketchFinish={finishSketch} onSketchCancel={() => setSketch([])}
                        shownLines={net.lines.filter(shownLine)} />
                )}
                {sketch.length > 0 && !menu && (
                    <div className={styles.sketchBar}>
                        <span>{`New ${typeLabel[net.type] ?? ""} line · ${sketch.length} stop${sketch.length === 1 ? "" : "s"} — click stops to add, right-click to finish`}</span>
                        <FlatButton onClick={finishSketch} disabled={sketch.length < 2}>Create line</FlatButton>
                        <FlatButton onClick={() => setSketch([])}>Cancel</FlatButton>
                    </div>
                )}
                {editing && !menu && (
                    <div className={styles.sketchBar}>
                        <span>{`Editing ${nameStr(editing.line.name)} · ${editing.stops.length} stops — click a stop to add or remove it`}</span>
                        <FlatButton onClick={() => { if (editing.stops.length >= 2) editLineStops(editing.line.entity, editing.stops); setEditing(null); }} disabled={editing.stops.length < 2}>Apply</FlatButton>
                        <FlatButton onClick={() => setEditing(null)}>Cancel</FlatButton>
                    </div>
                )}
                {view && !layout && <ScaleBar scale={view.scale} rem={rem} />}
                {view && bounds && <MiniMap net={net} bounds={bounds} view={view} W={W} H={H} rem={rem} shownLine={shownLine} onJump={(x, y) => move((v) => ({ ...v, cx: x, cy: y }))} />}
            </div>
            <div className={styles.side}>
                {boardStop >= 0 && ready && (
                    <DepartureBoard net={net} stopIdx={boardStop} hour={hour}
                        from={hour === null ? now : Math.round((hour / 24) * 262144)} onClose={() => setBoardStop(-1)} />
                )}
                <div className={styles.sideHead}>
                    <span className={panel.sectionTitle}>Lines</span>
                    <span className={panel.spacer} />
                    <FlatButton onClick={() => setHidden(new Set())} disabled={hidden.size === 0}>All</FlatButton>
                </div>
                <Scrollable vertical className={styles.sideList}>
                    {[...net.lines].sort((a, b) => a.entity.index - b.entity.index).map((l) => {
                        const on = !hidden.has(l.entity.index);
                        const hot = hover?.kind === "line" && sameEntity(hover.line.entity, l.entity);
                        return (
                            <div key={l.entity.index} className={classNames(styles.sideRow, hot && styles.sideRowHot, problemsOnly && !hasProblem(l) && styles.sideRowDim)}
                                onMouseEnter={() => setHover({ kind: "line", line: l })} onMouseLeave={() => setHover(null)}>
                                <Checkbox checked={on} onChange={() => toggleHidden(l)} />
                                <span className={styles.sideSwatch} style={{ backgroundColor: cssColor(l.color) }} />
                                <Tooltip tooltip="Click: only this line. Click again: all lines. Double-click: open in the planner.">
                                    <span className={classNames(styles.sideName, l.notEnoughVehicles && panel.warn)} onClick={() => solo(l)} onDoubleClick={() => onOpenInPlanner(l.entity, net.type, net.cargo)}>
                                        <LocalizedEntityName value={l.name} />
                                    </span>
                                </Tooltip>
                                <span className={panel.spacer} />
                                <span className={styles.sideMeta}>{`${l.fleet}v · ${l.capacity > 0 ? Math.round((100 * l.riders) / l.capacity) : 0}%`}</span>
                            </div>
                        );
                    })}
                </Scrollable>
            </div>
            </div>
            <TimeBar hour={hour} onHour={setHour} playing={playing} onPlaying={setPlaying} now={now} />
            <div className={styles.legend}>
                {!live && <span className={styles.legendItem}>{`${String(hour).padStart(2, "0")}:00 as scheduled: line width = vehicles per hour, faded = not running${byLoad ? ", colour = that hour's measured load" : ""}`}</span>}
                {showGaps && <span className={styles.legendItem}>red squares: people with no stop of this type within 400 m (brighter = more)</span>}
                {schematic && <span className={styles.legendItem}>schematic: stops snapped to a grid, legs drawn at 45°/90° (simplified, not to scale)</span>}
                {frozenReach && <span className={styles.legendItem}>reach vs frozen: green = closer now, red = further, grey = same</span>}
                <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.swatchInterchange)} /> interchange (ring = lines meeting)</span>
                <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.swatchDepot)} /> depot, dashed = bound lines, red = starved</span>
                <span className={styles.legendItem}><span className={classNames(styles.swatch, styles.swatchBusy)} /> 20+ waiting · halo = queue size</span>
                {byLoad && <span className={styles.legendItem}>legs: green empty → red full by vehicles on them, grey = none there now</span>}
                {reachMode && <span className={styles.legendItem}>{reach ? `reach from the ringed stop: green ≤ ${Math.round(reachMax / 3)} min · amber ≤ ${Math.round((2 * reachMax) / 3)} · orange ≤ ${reachMax} · none = beyond (ride time + half a headway per boarding)` : "reach: click a stop to start from"}</span>}
                <span className={styles.legendItem}>vehicles: ring = line, fill = load, hollow = boarding</span>
                <span className={styles.legendItem}>click a stop for its departure board · a vehicle to follow · a line to open it · wheel zooms · drag pans</span>
            </div>
        </div>
    );
};

/**
 * The right-click menu. Line: planner / focus / vanilla row actions / depot binding. Stop: go
 * there, reach, and the new-line sketch (start / add / remove / finish). Depot: go there, bind the
 * shown lines. Empty space while sketching: finish / cancel. Vanilla line actions are the same
 * cs2/bindings transport.* triggers the Fleet tab rows use.
 */
const ContextMenu = ({ x, y, target, net, sketch, inSketch, reachMode, shownLines, onClose, onOpen, onSolo, onHide, onEdit, onReach, onSketchAdd, onSketchRemove, onSketchFinish, onSketchCancel }: {
    x: number; y: number; target: Hover;
    net: { stops: NetStop[]; lines: NetLine[]; depots: NetDepot[]; type: number };
    sketch: Entity[]; inSketch: (e: Entity) => boolean; reachMode: boolean; shownLines: NetLine[];
    onClose: () => void; onOpen: (l: NetLine) => void; onSolo: (l: NetLine) => void; onHide: (l: NetLine) => void; onEdit: (l: NetLine) => void;
    onReach: (s: NetStop) => void; onSketchAdd: (s: NetStop) => void; onSketchRemove: (s: NetStop) => void; onSketchFinish: () => void; onSketchCancel: () => void;
}) => {
    const [depotPick, setDepotPick] = useState(false);
    // Rename: the overview's own recipe — its EllipsisTextInput on its line-row theme, the typed
    // name committed on blur or Enter, an empty one discarded (lines-utils useLineName).
    const [renaming, setRenaming] = useState(false);
    const [draft, setDraft] = useState("");
    const currentName = vanilla.useLocalizedName(target?.kind === "line" ? target.line.name : null);
    const commitRename = (l: NetLine) => { const v = draft.trim(); if (v && v !== currentName) rename(l.entity, v); setRenaming(false); onClose(); };
    const { EllipsisTextInput } = vanilla;
    const Item =({ label, onClick, disabled }: { label: React.ReactNode; onClick: () => void; disabled?: boolean }) => (
        <div className={classNames(vanilla.gameDropdown.dropdownItem, styles.menuItem, disabled && styles.menuItemDisabled)} onMouseDown={(e) => { e.stopPropagation(); if (!disabled) { onClick(); onClose(); } }}>{label}</div>
    );
    const Title = ({ children }: { children: React.ReactNode }) => <div className={styles.menuTitle}>{children}</div>;
    let body: React.ReactNode;
    if (target?.kind === "line") {
        const l = target.line;
        body = (
            <>
                <Title><LocalizedEntityName value={l.name} /></Title>
                {!renaming ? (
                    <div className={classNames(vanilla.gameDropdown.dropdownItem, styles.menuItem)} onMouseDown={(e) => { e.stopPropagation(); setDraft(currentName); setRenaming(true); }}>Rename…</div>
                ) : (
                    <div className={styles.menuInputRow} onMouseDown={(e) => e.stopPropagation()}>
                        <EllipsisTextInput
                            value={draft}
                            maxLength={64}
                            theme={vanilla.lineNameInput}
                            className={styles.menuInput}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => commitRename(l)}
                            onKeyDown={(e) => { if (e.key === "Enter") commitRename(l); else if (e.key === "Escape") { setRenaming(false); onClose(); } }}
                            onClick={(e) => e.stopPropagation()}
                        />
                    </div>
                )}
                <Item label="Open in planner" onClick={() => onOpen(l)} />
                <Item label="Edit stops on the map…" onClick={() => onEdit(l)} />
                <Item label="Show only this line" onClick={() => onSolo(l)} />
                <Item label="Hide this line" onClick={() => onHide(l)} />
                <Item label="Highlight in the world" onClick={() => transport.toggleHighlight(l.entity)} />
                <Item label={l.inactive ? "Set active" : "Set inactive"} onClick={() => transport.setLineActive(l.entity, l.inactive)} />
                <Item label="Run day and night" onClick={() => transport.setLineSchedule(l.entity, RouteSchedule.DayAndNight)} />
                <Item label="Run by day only" onClick={() => transport.setLineSchedule(l.entity, RouteSchedule.Day)} />
                <Item label="Run at night only" onClick={() => transport.setLineSchedule(l.entity, RouteSchedule.Night)} />
                {!depotPick ? (
                    <div className={classNames(vanilla.gameDropdown.dropdownItem, styles.menuItem)} onMouseDown={(e) => { e.stopPropagation(); setDepotPick(true); }}>Bind to depot…</div>
                ) : (
                    <>
                        <Item label="Any depot (unbind)" onClick={() => bindLines([l.entity], NULL_ENTITY)} />
                        {(net.depots ?? []).map((d) => (
                            <Item key={d.entity.index} label={<span className={styles.menuIndent}><LocalizedEntityName value={d.name} /></span>} onClick={() => bindLines([l.entity], d.entity)} />
                        ))}
                    </>
                )}
            </>
        );
    } else if (target?.kind === "stop") {
        const s = target.stop;
        const picked = inSketch(s.entity);
        body = (
            <>
                <Title><LocalizedEntityName value={s.name} /></Title>
                <Item label="Go there" onClick={() => goTo(s.entity)} />
                <Item label={reachMode ? "Reach from here" : "Show reach from here"} onClick={() => onReach(s)} />
                {sketch.length === 0 && <Item label="Start a new line here" onClick={() => onSketchAdd(s)} />}
                {sketch.length > 0 && !picked && <Item label={`Add to new line (stop ${sketch.length + 1})`} onClick={() => onSketchAdd(s)} />}
                {sketch.length > 0 && picked && <Item label="Remove from new line" onClick={() => onSketchRemove(s)} />}
                {sketch.length > 0 && <Item label={`Create line (${sketch.length} stops)`} onClick={onSketchFinish} disabled={sketch.length < 2} />}
                {sketch.length > 0 && <Item label="Cancel new line" onClick={onSketchCancel} />}
            </>
        );
    } else if (target?.kind === "depot") {
        const d = target.depot;
        body = (
            <>
                <Title><LocalizedEntityName value={d.name} /></Title>
                <Item label="Go there" onClick={() => goTo(d.entity)} />
                <Item label={`Bind the ${shownLines.length} shown line${shownLines.length === 1 ? "" : "s"} here`} onClick={() => bindLines(shownLines.map((l) => l.entity), d.entity)} disabled={shownLines.length === 0} />
                <Item label="Unbind its lines" onClick={() => bindLines((d.boundLines ?? []).map((i) => net.lines[i]?.entity).filter((e): e is Entity => !!e), NULL_ENTITY)} disabled={(d.boundLines ?? []).length === 0} />
            </>
        );
    } else if (target?.kind === "vehicle") {
        body = (
            <>
                <Title>Vehicle</Title>
                <Item label="Follow" onClick={() => goTo(target.vehicle.entity)} />
            </>
        );
    } else {
        body = sketch.length > 0 ? (
            <>
                <Title>New line</Title>
                <Item label={`Create line (${sketch.length} stops)`} onClick={onSketchFinish} disabled={sketch.length < 2} />
                <Item label="Cancel new line" onClick={onSketchCancel} />
            </>
        ) : (
            <>
                <Title>Map</Title>
                <div className={styles.menuHint}>Right-click a stop to start a new line, a line for its actions.</div>
            </>
        );
    }
    return (
        // Rendered inside the canvas (a Portal landed under the game's own layers and took no
        // clicks): the backdrop covers the canvas and closes the menu when the press lands on it;
        // the menu is its child, so it is always painted above it. The map's hit-testing and
        // tooltip are suspended while it is open.
        <div className={styles.menuBackdrop} onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }} onContextMenu={(e) => e.preventDefault()}>
            <div className={classNames(vanilla.gameDropdown.dropdownMenu, styles.menu)} style={{ left: x, top: y }}>
                {body}
            </div>
        </div>
    );
};

/** The hovered line's 24 h load history as a small bar chart: one bar per hour, red past 100 %, gaps where unsampled. */
const Sparkline = ({ history }: { history?: number[] }) => {
    if (!history || !history.some((v) => v >= 0)) return <div className={styles.tipHint}>No load history yet</div>;
    const w = 168, h = 36, bw = w / 24;
    const max = Math.max(1, ...history.filter((v) => v >= 0));
    return (
        <div className={styles.spark}>
            <svg width={w} height={h + 12}>
                <line x1={0} x2={w} y1={h - h / max} y2={h - h / max} className={styles.sparkFull} />
                {history.map((v, i) => v < 0 ? null : (
                    <rect key={i} x={i * bw + 0.5} y={h - (h * v) / max} width={bw - 1} height={(h * v) / max} className={v >= 1 ? styles.sparkBarHot : styles.sparkBar} />
                ))}
                {[0, 6, 12, 18].map((hr) => <text key={hr} x={hr * bw} y={h + 10} className={styles.sparkAxis}>{`${hr}`}</text>)}
            </svg>
            <div className={styles.tipHint}>load by hour · line = 100 %</div>
        </div>
    );
};

/** A bar of a round length (1 m … 5 km) that fits in about 120 rem, with the zoom ratio beside it. */
const ScaleBar = ({ scale, rem }: { scale: number; rem: number }) => {
    const targetPx = rem * 120;
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let metres = steps[0];
    for (const s of steps) if (s * scale <= targetPx) metres = s;
    const label = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
    const ratio = scale >= 1 ? `${scale.toFixed(scale >= 10 ? 0 : 1)} px/m` : `1 px = ${(1 / scale).toFixed(1)} m`;
    return (
        <div className={styles.scaleBar}>
            <div className={styles.scaleLine} style={{ width: metres * scale }} />
            <span className={styles.scaleText}>{`${label} · ${ratio}`}</span>
        </div>
    );
};

/** Overview of the whole network in the corner, with the current viewport as a rectangle; click to centre there. */
const MiniMap = ({ net, bounds, view, W, H, rem, shownLine, onJump }: {
    net: { stops: NetStop[]; lines: NetLine[] };
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
    view: View; W: number; H: number; rem: number;
    shownLine: (l: NetLine) => boolean;
    onJump: (x: number, y: number) => void;
}) => {
    const mw = rem * 160, mh = rem * 120;
    const bw = Math.max(200, bounds.maxX - bounds.minX), bh = Math.max(200, bounds.maxY - bounds.minY);
    const s = 0.9 * Math.min(mw / bw, mh / bh);
    const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
    const p = (x: number, y: number) => ({ x: (x - cx) * s + mw / 2, y: (cy - y) * s + mh / 2 });
    // Viewport in world units → minimap.
    const vw = W / view.scale, vh = H / view.scale;
    const tl = p(view.cx - vw / 2, view.cy + vh / 2);
    const rw = Math.max(2, vw * s), rh = Math.max(2, vh * s);
    const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const lx = e.clientX - r.left, ly = e.clientY - r.top;
        onJump((lx - mw / 2) / s + cx, cy - (ly - mh / 2) / s);
    };
    return (
        <div className={styles.miniMap} style={{ width: mw, height: mh }} onMouseDown={onClick}>
            <svg width={mw} height={mh}>
                {net.lines.filter(shownLine).map((l) => {
                    const pts = l.stops.map((i) => p(net.stops[i].x, net.stops[i].y));
                    if (pts.length < 2) return null;
                    const d = pts.map((q, k) => `${k === 0 ? "M" : "L"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(" ") + " Z";
                    return <path key={l.entity.index} d={d} className={styles.miniLine} style={{ stroke: cssColor(l.color) }} />;
                })}
                <rect x={tl.x} y={tl.y} width={rw} height={rh} className={styles.miniView} />
            </svg>
        </div>
    );
};

const Tip = ({ hover, reachMinutes }: { hover: NonNullable<Hover>; reachMinutes?: number }) =>
    hover.kind === "vehicle" ? (
        <div className={styles.tip}>
            <div className={styles.tipTitle}>Vehicle</div>
            <div>{`${hover.vehicle.riders} / ${hover.vehicle.capacity} on board`}</div>
            <div>{hover.vehicle.boarding ? "Boarding" : hover.vehicle.returning ? "Returning to depot" : "En route"}</div>
            <div className={styles.tipHint}>Click to follow</div>
        </div>
    ) : hover.kind === "depot" ? (
        <div className={styles.tip}>
            <div className={styles.tipTitle}><LocalizedEntityName value={hover.depot.name} /></div>
            <div>{`${hover.depot.available} ready / ${hover.depot.owned} owned · ${hover.depot.boundLines.length} bound line${hover.depot.boundLines.length === 1 ? "" : "s"}`}</div>
            {hover.depot.starved && <div className={styles.tipWarn}>Starved: a bound line is short and nothing is spare</div>}
            <div className={styles.tipHint}>Click to go there</div>
        </div>
    ) : hover.kind === "stop" ? (
        <div className={styles.tip}>
            <div className={styles.tipTitle}><LocalizedEntityName value={hover.stop.name} /></div>
            <div>{`${hover.stop.waiting} waiting · ${hover.stop.lines} line${hover.stop.lines === 1 ? "" : "s"}`}</div>
            {reachMinutes !== undefined && <div>{Number.isFinite(reachMinutes) ? `${Math.round(reachMinutes)} min from the origin` : "Not reachable"}</div>}
        </div>
    ) : (
        <div className={styles.tip}>
            <div className={styles.tipTitle}><LocalizedEntityName value={hover.line.name} /></div>
            <div>{`${hover.line.fleet} vehicles · ${hover.line.riders}/${hover.line.capacity} riders · ${hover.line.stops.length} stops`}</div>
            <Sparkline history={hover.line.history} />
            {hover.line.notEnoughVehicles && <div className={styles.tipWarn}>Not enough vehicles</div>}
            {hover.line.inactive && <div>Inactive</div>}
        </div>
    );

const sameHover = (a: Hover, b: Hover) => {
    if (a === b) return true;
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === "stop" && b.kind === "stop") return sameEntity(a.stop.entity, b.stop.entity);
    if (a.kind === "line" && b.kind === "line") return sameEntity(a.line.entity, b.line.entity);
    if (a.kind === "vehicle" && b.kind === "vehicle") return sameEntity(a.vehicle.entity, b.vehicle.entity);
    if (a.kind === "depot" && b.kind === "depot") return sameEntity(a.depot.entity, b.depot.entity);
    return false;
};

const distToSegment = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
