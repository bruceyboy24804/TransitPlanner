import { useEffect } from "react";
import { LocalizedEntityName } from "cs2/l10n";
import { Scrollable } from "cs2/ui";
import classNames from "classnames";
import { goTo } from "../bindings";
import { formatTimeOfDay, framesToMinutes, NetLine, NetStop, Network, secondsToMinutes, TICKS_PER_DAY } from "../types";
import { vanilla } from "../vanilla";
import { FlatButton } from "./flat-button";
import dd from "./model-dropdown.module.scss";
import { SliderField } from "./slider-field";
import panel from "./planner.module.scss";
import styles from "./network.module.scss";

// The Network tab's planning layers, kept out of network-panel.tsx: the time-of-day scrubber,
// the stop departure board, and the schematic (tube-map) layout.

export const cssColor = (c: NetLine["color"]) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;

// --- Time of day ---------------------------------------------------------------------------------

/** A line's scheduled headway at `hour` (null = live: the current headway), simulation seconds; 0 = not running. */
export const headwayAt = (l: NetLine, hour: number | null) =>
    hour === null ? (l.inactive ? 0 : l.headway) : (l.hourHeadway?.[hour] ?? l.headway);

/** Vehicles per clock hour at a headway (simulation seconds). */
export const perHour = (headwaySeconds: number) => (headwaySeconds > 0 ? 60 / Math.max(0.5, secondsToMinutes(headwaySeconds)) : 0);

/**
 * The scrubber under the map: Live, or an hour of the day the map shows the network as it is
 * scheduled then (closed lines faded, frequency as line width, load from the line's history).
 * Play steps an hour a second and wraps.
 */
export const TimeBar = ({ hour, onHour, playing, onPlaying, now }: {
    hour: number | null; onHour: (h: number | null) => void; playing: boolean; onPlaying: (p: boolean) => void; now: number;
}) => {
    useEffect(() => {
        if (!playing) return;
        const id = setInterval(() => onHour(((hour ?? Math.floor(framesToMinutes(now) / 60)) + 1) % 24), 1000);
        return () => clearInterval(id);
    }, [playing, hour, now]);
    const shown = hour ?? Math.floor(framesToMinutes(now) / 60);
    return (
        <div className={classNames(panel.row, styles.timeBar)}>
            <FlatButton selected={hour === null} onClick={() => { onPlaying(false); onHour(null); }} tooltip="The network as it is right now, with live vehicles">Live</FlatButton>
            <FlatButton selected={playing} onClick={() => { if (hour === null) onHour(shown); onPlaying(!playing); }} tooltip="Step through the day, an hour a second">{playing ? "Pause" : "Play"}</FlatButton>
            <SliderField compact label={hour === null ? `Now ${formatTimeOfDay(now)}` : `${String(shown).padStart(2, "0")}:00–${String((shown + 1) % 24).padStart(2, "0")}:00`}
                value={shown} min={0} max={23} onChange={(h) => { onPlaying(false); onHour(h); }} />
        </div>
    );
};

// --- Departure board -----------------------------------------------------------------------------

interface BoardRow { line: NetLine; at: number | null; every: number | null }

/**
 * The next departures from one stop across every line calling there, from `from` (frames of the
 * day). A timetabled line gives real times: its anchor departures plus the planned time from the
 * anchor to this stop. Any other line gives its headway ("every N min") at that hour.
 */
const board = (net: Network, stopIdx: number, from: number, hour: number | null, count = 10): BoardRow[] => {
    const rows: BoardRow[] = [];
    const stop = net.stops[stopIdx];
    for (const li of stop.lineIds ?? []) {
        const l = net.lines[li];
        if (!l) continue;
        const pos = l.stops.indexOf(stopIdx);
        if (pos < 0) continue;
        if (l.departures && l.departures.length > 0 && l.anchorStop >= 0) {
            // Planned seconds from the anchor round the loop to this stop, as frames.
            let secs = 0;
            for (let k = l.anchorStop; k !== pos; k = (k + 1) % l.stops.length) secs += l.legDurations?.[k] ?? 0;
            const offset = secs * 60;
            const times = l.departures.map((d) => (d + offset) % TICKS_PER_DAY).sort((a, b) => a - b);
            const next = times.filter((t) => t >= from).concat(times.map((t) => t + TICKS_PER_DAY));
            for (const t of next.slice(0, 4)) rows.push({ line: l, at: t, every: null });
        } else {
            const h = headwayAt(l, hour);
            rows.push({ line: l, at: null, every: h > 0 ? secondsToMinutes(h) : null });
        }
    }
    const timed = rows.filter((r) => r.at !== null).sort((a, b) => (a.at as number) - (b.at as number)).slice(0, count);
    const other = rows.filter((r) => r.at === null);
    return [...timed, ...other];
};

export const DepartureBoard = ({ net, stopIdx, from, hour, onClose }: { net: Network; stopIdx: number; from: number; hour: number | null; onClose: () => void }) => {
    const stop: NetStop | undefined = net.stops[stopIdx];
    if (!stop) return null;
    const rows = board(net, stopIdx, from, hour);
    return (
        <div className={styles.board}>
            <div className={panel.row}>
                <span className={panel.sectionTitle}><LocalizedEntityName value={stop.name} /></span>
                <span className={panel.spacer} />
                <FlatButton onClick={() => goTo(stop.entity)}>Go there</FlatButton>
                <FlatButton onClick={onClose}>Close</FlatButton>
            </div>
            <div className={panel.hint}>{`${stop.waiting} waiting · ${stop.lines} line${stop.lines === 1 ? "" : "s"} · from ${formatTimeOfDay(from)}`}</div>
            <Scrollable vertical className={styles.boardList}>
                {rows.map((r, i) => (
                    <div key={i} className={styles.boardRow}>
                        <span className={styles.sideSwatch} style={{ backgroundColor: cssColor(r.line.color) }} />
                        <span className={styles.boardName}><LocalizedEntityName value={r.line.name} /></span>
                        <span className={panel.spacer} />
                        {r.at !== null
                            ? <span className={styles.boardTime}>{`${formatTimeOfDay(r.at % TICKS_PER_DAY)} · in ${Math.max(0, Math.round(framesToMinutes(r.at - from)))} min`}</span>
                            : <span className={panel.dim}>{r.every ? `every ${Math.round(r.every)} min` : "not running"}</span>}
                    </div>
                ))}
                {rows.length === 0 && <div className={panel.empty}>No lines call here.</div>}
            </Scrollable>
        </div>
    );
};

// --- Schematic -----------------------------------------------------------------------------------

/**
 * A simplified tube-map layout, in world-like metres so the map's fit and zoom still work: every
 * stop snapped to a grid the size of the typical stop spacing (collisions pushed to the nearest
 * free cell, interchanges placed first so they keep their spot), and each leg drawn octilinear —
 * a 45° run then a straight one. Not an optimised metro-map layout, but readable at a glance.
 */
export const schematicLayout = (net: Network): { x: number; y: number }[] => {
    const n = net.stops.length;
    if (n === 0) return [];
    // Grid: the median nearest-neighbour distance, clamped.
    const nn: number[] = [];
    for (let i = 0; i < n; i++) {
        let best = Infinity;
        for (let j = 0; j < n; j++) if (i !== j) best = Math.min(best, Math.hypot(net.stops[i].x - net.stops[j].x, net.stops[i].y - net.stops[j].y));
        if (Number.isFinite(best)) nn.push(best);
    }
    nn.sort((a, b) => a - b);
    const g = Math.max(150, Math.min(800, nn[Math.floor(nn.length / 2)] ?? 300));
    const taken = new Set<string>();
    const out: { x: number; y: number }[] = new Array(n);
    const order = net.stops.map((s, i) => i).sort((a, b) => net.stops[b].lines - net.stops[a].lines);
    for (const i of order) {
        const s = net.stops[i];
        const cx = Math.round(s.x / g), cy = Math.round(s.y / g);
        let placed = false;
        for (let r = 0; r < 12 && !placed; r++) {
            for (let dy = -r; dy <= r && !placed; dy++) for (let dx = -r; dx <= r && !placed; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const k = `${cx + dx},${cy + dy}`;
                if (taken.has(k)) continue;
                taken.add(k);
                out[i] = { x: (cx + dx) * g, y: (cy + dy) * g };
                placed = true;
            }
        }
        if (!placed) out[i] = { x: cx * g, y: cy * g };
    }
    return out;
};

/** Octilinear points from a to b: a 45° run for the shorter axis, then straight. */
export const octilinear = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.min(Math.abs(dx), Math.abs(dy));
    const mid = { x: a.x + Math.sign(dx) * d, y: a.y + Math.sign(dy) * d };
    return mid.x === a.x && mid.y === a.y ? [a, b] : [a, mid, b];
};

/** Where to insert `stop` into a line's stop order: the position that adds the least distance. */
export const bestInsert = (order: { x: number; y: number }[], p: { x: number; y: number }) => {
    if (order.length < 2) return order.length;
    let best = 0, bestCost = Infinity;
    for (let k = 0; k < order.length; k++) {
        const a = order[k], b = order[(k + 1) % order.length];
        const cost = Math.hypot(p.x - a.x, p.y - a.y) + Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(b.x - a.x, b.y - a.y);
        if (cost < bestCost) { bestCost = cost; best = k + 1; }
    }
    return best;
};

// --- Layers dropdown -----------------------------------------------------------------------------

export interface LayerToggle { label: string; on: boolean; set: (on: boolean) => void; extra?: string }

/**
 * The map's on/off layers in one dropdown, so the toolbar fits: the model picker's recipe (the
 * game's Dropdown and DropdownToggle, our own menu plate) with a Checkbox row per layer. The menu
 * stays open while toggling; the toggle reads how many layers are on.
 */
export const LayersDropdown = ({ layers }: { layers: LayerToggle[] }) => {
    const { Dropdown, DropdownToggle, Checkbox } = vanilla;
    const on = layers.filter((l) => l.on).length;
    const menu = (
        <div className={dd.menuBody}>
            <Scrollable vertical className={dd.listScroll}>
                {layers.map((l) => (
                    <div key={l.label} className={classNames(dd.row, l.on && dd.rowOn)} onClick={() => l.set(!l.on)}>
                        <Checkbox checked={l.on} onChange={() => l.set(!l.on)} />
                        <div className={dd.text}>
                            <div className={dd.name}>{l.label}</div>
                            {l.extra && <div className={dd.meta}>{l.extra}</div>}
                        </div>
                    </div>
                ))}
            </Scrollable>
        </div>
    );
    return (
        <div className={classNames(dd.host, styles.layersHost)}>
            <Dropdown theme={{ ...vanilla.gameDropdown, dropdownMenu: classNames(vanilla.gameDropdown.dropdownMenu, dd.menuTransparent) }} content={menu}>
                <DropdownToggle showHint>
                    <div className={dd.toggle}>
                        <div className={dd.summary}>{`Layers (${on}/${layers.length})`}</div>
                    </div>
                </DropdownToggle>
            </Dropdown>
        </div>
    );
};
