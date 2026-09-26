import { useEffect, useMemo, useRef, useState } from "react";
import { useValue } from "cs2/api";
import type { Entity } from "cs2/bindings";
import { LocalizedEntityName } from "cs2/l10n";
import { Scrollable, Tooltip } from "cs2/ui";
import { useRem } from "cs2/utils";
import classNames from "classnames";
import { board$, deletePlan, setBoardOrder, setBoardType, setSchedule, setWorldHighlight, selected$, switchPlan, timeOfDay$ } from "../bindings";
import { Band, BandMode, BoardRow, TimetableFlags, formatTimeOfDay, LineRow, minutesToFrames, minutesToSeconds, NULL_ENTITY, sameEntity, Schedule, secondsToMinutes, steppingModes, TICKS_PER_DAY } from "../types";
import { vanilla } from "../vanilla";
import { hsl } from "../colour";
import { BandEditor } from "./schedule-editor";
import { bandLabel, clipToService, hatch, largestGap, sortBands } from "./timeline";
import { FlatButton } from "./flat-button";
import { SelectDropdown } from "./select-dropdown";
import { SplitHandle, useSplit } from "./split-handle";
import { TypeSelection } from "./type-sidebar";
import { typeLabel } from "./planner-panel";
import { presetsFor, samePresetBands, toPresetBand, usePresets } from "../presets";
import { departuresOfDay } from "../timetable";
import { withTimetableDefaults } from "./timetable-editor";
import { ScheduleWizard, WizardResult } from "./schedule-wizard";
import { Glyph, Section } from "./toolbar";
import { TextField } from "./text-field";
import styles from "./planner.module.scss";

// The Schedule tab — Traffic's signal-plan editor, for lines. Every line of the sidebar's type is
// a row on one time axis (zoom with the wheel over the axis, pan by dragging empty track), its
// bands and closed blocks drawn and dragged by their grips. Taken from Traffic's editor:
//  - draft editing: changes collect locally and reach the game on Apply (each headway change
//    re-pathfinds every stop of the line, so a drag must not write on every step); "Apply
//    immediately" restores the old behaviour;
//  - drag grips that light up, a dimmed band while dragging, a playhead with a time bubble (and a
//    second one for the clock), a zoomable axis;
//  - named plans per line (Weekday / Event day…), switched for many lines at once;
//  - template usage counts before a delete, a problems strip with go-to, hover preview in the
//    world, and rows reordered by dragging their grip.
// Data: `scheduleBoard` (TP_PlannerUISystem.Board.cs). Writes: setSchedule / setBoardOrder / switchPlan.

const cssColor = (c: LineRow["color"]) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;
const SNAP = minutesToFrames(5);
const HOUR = TICKS_PER_DAY / 24;
const snap = (f: number) => Math.max(0, Math.min(TICKS_PER_DAY, Math.round(f / SNAP) * SNAP));
type Closed = { start: number; end: number };
const clockOf = (f: number) => (f >= TICKS_PER_DAY ? "24:00" : formatTimeOfDay(f));

/** Band fill by what the mode does: a set headway, a set fleet, a fleet that follows a measure. */
const modeFill = (m: BandMode) =>
    m === BandMode.Default ? "rgba(255,255,255,0.18)"
        : steppingModes.includes(m) || m === BandMode.FollowDemand ? hsl(150, 0.55, 0.45)
        : m === BandMode.Fleet || m === BandMode.Capped || m === BandMode.MatchLine ? hsl(38, 0.85, 0.52)
        : hsl(212, 0.7, 0.55);

/** Vehicles a headway needs on a loop, as vanilla sizes it (max(1, round(loop / headway))). */
const fleetFor = (headway: number, stable: number) => (headway > 0 ? Math.max(1, Math.round(stable / Math.max(1, headway))) : 0);

/**
 * Headway and vehicles a row runs in hour `h`. Where no enabled band covers the hour the line runs
 * vanilla's own target fleet (sized from its configured interval), so that is what counts — the
 * live interval would size back to 1 on a short loop.
 */
const runAt = (r: BoardRow, h: number): { headway: number; fleet: number } => {
    const hw = r.hourHeadway[h] ?? 0;
    if (hw <= 0) return { headway: 0, fleet: 0 };
    const mid = (h + 0.5) * HOUR;
    const banded = r.schedule.enabled && (r.schedule.bands ?? []).some((b) => b.mode !== BandMode.Default && mid >= b.start && mid < b.end);
    if (!banded && r.target > 0) return { headway: r.stable / r.target, fleet: r.target };
    return { headway: hw, fleet: fleetFor(hw, r.stable) };
};

/** Puts `band` into `bands`, cutting whatever it overlaps, then clips to the line's open hours. */
const insertBand = (bands: Band[], band: Band, closed: Schedule["closed"]) => {
    const out: Band[] = [];
    for (const b of bands) {
        if (b.end <= band.start || b.start >= band.end) { out.push(b); continue; }
        if (b.start < band.start) out.push({ ...b, end: band.start });
        if (b.end > band.end) out.push({ ...b, start: band.end });
    }
    out.push({ ...band });
    return sortBands(clipToService(out, closed ?? []));
};

/** The visible stretch of the day, frames. */
type View = { from: number; to: number };
const FULL: View = { from: 0, to: TICKS_PER_DAY };
/** Axis tick step for a visible span: every 2 h at a full day down to 15 min zoomed in. */
const tickStep = (span: number) => (span > 12 * HOUR ? 2 * HOUR : span > 6 * HOUR ? HOUR : span > 2 * HOUR ? HOUR / 2 : HOUR / 4);

type Part = "start" | "end" | "body";
/** What is under the cursor: a band, or a closed block (index into the row's closed periods). */
type Hit = { band: number; part: Part; kind: "band" | "closed" };

/**
 * A drag in progress. Everything it needs is taken at mouse-down — the row's key and bands, and
 * the track's on-screen width and view — so the window listeners never read a stale closure.
 */
type Drag = {
    key: number; band: number; part: Part; kind: "band" | "closed";
    x0: number; boxWidth: number; span: number; start: number; end: number; min: number; max: number;
    bands: Band[];
};

/**
 * Lays a band into another line's day: the bands it overlaps are trimmed around it (split when it
 * lands inside one), and the result is cut to that line's closed hours.
 */
const layBand = (bands: Band[], band: Band, closed: Closed[]): Band[] => {
    const kept = bands.flatMap((b) => {
        if (b.end <= band.start || b.start >= band.end) return [b];
        const parts: Band[] = [];
        if (b.start < band.start) parts.push({ ...b, end: band.start });
        if (b.end > band.end) parts.push({ ...b, start: band.end });
        return parts;
    });
    return sortBands(clipToService([...kept, band], closed));
};

/** Closed blocks sorted, with overlapping or touching ones joined. */
const mergeClosed = (blocks: Closed[]): Closed[] => {
    const out: Closed[] = [];
    for (const c of [...blocks].sort((a, b) => a.start - b.start)) {
        const last = out[out.length - 1];
        if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
        else out.push({ ...c });
    }
    return out;
};

/** One line's day: closed blocks, bands with grips, the hour grid, the clock and the scrub marker. */
const RowTrack = ({ row, width, height, view, picked, pickedClosed, dragging, now, scrub, onPick, onPickClosed, onDrag, onPan, onHover, onAdd, onSplit }: {
    row: BoardRow; width: number; height: number; view: View; picked: number; dragging: number;
    now: number; scrub: number | null;
    /** The selected closed block (−1 none) and its picker: a click selects it for removal. */
    pickedClosed: number; onPickClosed: (index: number) => void;
    onPick: (band: number) => void; onDrag: (d: Drag) => void; onPan: (x0: number, boxWidth: number) => void;
    onHover: (hit: Hit | null) => void;
    /** Double-click on empty track / inside a band, at a frame of the day. */
    onAdd: (frame: number) => void; onSplit: (band: number, frame: number) => void;
}) => {
    const rem = useRem();
    const span = view.to - view.from;
    const x = (f: number) => ((f - view.from) / span) * width;
    const bands = row.schedule.bands ?? [];
    const closed = row.schedule.closed ?? [];
    const edge = rem * 8;
    const [hover, setHover] = useState<Hit | null>(null);
    // Double-click, detected from two presses (the track already handles presses by hand, and
    // dblclick on an SVG is not something to trust in Gameface).
    const lastDown = useRef({ t: 0, x: 0 });
    /**
     * What is under the cursor. Gameface does not hit-test inside an SVG — a real click lands on
     * the <svg> itself, never on a band's <g>/<rect> (measured with elementFromPoint) — so the
     * band and the part of it are worked out from the x position, edges first.
     */
    const hitAt = (px: number): Hit | null => {
        // Edges: the nearest grip wins, bands and closed blocks alike. Each grip sits just inside
        // its own block, so measuring to the grip (not the shared boundary) lets a band's start
        // and the closed block ending there each be grabbed from their own side — checking bands
        // first made the band's grip always win.
        const inset = rem * 2 + (rem * 4) / 2; // grip offset from the edge + half its width
        let best: Hit | null = null, bestD = edge;
        const consider = (at: number, h: Hit) => { const d = Math.abs(px - at); if (d < bestD) { bestD = d; best = h; } };
        bands.forEach((b, i) => {
            consider(x(b.start) + inset, { band: i, part: "start", kind: "band" });
            consider(x(b.end) - inset, { band: i, part: "end", kind: "band" });
        });
        // Closed blocks drag like bands: edges (not at the day's ends, which are fixed) and body.
        closed.forEach((c, k) => {
            if (c.start > 0) consider(x(c.start) + inset, { band: k, part: "start", kind: "closed" });
            if (c.end < TICKS_PER_DAY) consider(x(c.end) - inset, { band: k, part: "end", kind: "closed" });
        });
        if (best) return best;
        const i = bands.findIndex((b) => px >= x(b.start) && px < x(b.end));
        if (i >= 0) return { band: i, part: "body", kind: "band" };
        const k = closed.findIndex((c) => px >= x(c.start) && px < x(c.end));
        return k >= 0 ? { band: k, part: "body", kind: "closed" } : null;
    };
    const move = (e: React.MouseEvent) => {
        const box = (e.currentTarget as Element).getBoundingClientRect();
        const hit = hitAt(e.clientX - box.left);
        if (hit?.band !== hover?.band || hit?.part !== hover?.part || hit?.kind !== hover?.kind) { setHover(hit); onHover(hit?.kind === "band" ? hit : null); }
    };
    const down = (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        const box = (e.currentTarget as Element).getBoundingClientRect();
        const px = e.clientX - box.left;
        const hit = hitAt(px);
        e.stopPropagation();
        const t = Date.now();
        const double = t - lastDown.current.t < 400 && Math.abs(e.clientX - lastDown.current.x) < rem * 6;
        lastDown.current = { t: double ? 0 : t, x: e.clientX };
        if (double) {
            const f = view.from + (px / Math.max(1, width)) * span;
            if (!hit) onAdd(f);
            else if (hit.kind === "band" && hit.part === "body") onSplit(hit.band, f);
            return;
        }
        if (!hit) { onPan(e.clientX, box.width); return; } // empty track pans the view
        if (hit.kind === "closed") {
            // A closed block is bounded by the other blocks only: moving it clips the bands.
            const c = closed[hit.band];
            onPickClosed(hit.band);
            const walls = [0, TICKS_PER_DAY, ...closed.filter((_, k) => k !== hit.band).flatMap((o) => [o.start, o.end])];
            onDrag({ key: row.entity.index, band: hit.band, part: hit.part, kind: "closed", x0: e.clientX, boxWidth: box.width, span, start: c.start, end: c.end,
                min: Math.max(...walls.filter((w) => w <= c.start)), max: Math.min(...walls.filter((w) => w >= c.end)), bands: [] });
            return;
        }
        const b = bands[hit.band];
        // Bounded by the neighbouring bands and closed blocks.
        const walls = [0, TICKS_PER_DAY, ...bands.filter((_, k) => k !== hit.band).flatMap((o) => [o.start, o.end]), ...closed.flatMap((c) => [c.start, c.end])];
        const min = Math.max(...walls.filter((w) => w <= b.start));
        const max = Math.min(...walls.filter((w) => w >= b.end));
        onPick(hit.band);
        onDrag({ key: row.entity.index, band: hit.band, part: hit.part, kind: "band", x0: e.clientX, boxWidth: box.width, span, start: b.start, end: b.end, min, max, bands });
    };
    const cursor = !hover ? "grab" : hover.part === "body" ? "move" : "ew-resize";
    const off = !row.schedule.enabled;
    const grid: number[] = [];
    for (let f = Math.ceil(view.from / HOUR) * HOUR; f <= view.to; f += HOUR) grid.push(f);
    const gripW = rem * 4, gripH = height - rem * 12;
    return (
        <svg width={width} height={height} className={styles.boardTrack} style={{ cursor }}
            onMouseDown={down} onMouseMove={move} onMouseLeave={() => { setHover(null); onHover(null); }}>
            {grid.map((f) => <line key={f} x1={x(f)} x2={x(f)} y1={0} y2={height} stroke="rgba(255,255,255,0.07)" strokeWidth={1} />)}
            {closed.map((c, i) => {
                const hot = hover?.kind === "closed" && hover.band === i;
                const chosen = pickedClosed === i;
                const w = Math.max(1, x(c.end) - x(c.start));
                // Grips on the edges that move — a Start block's 00:00 and an End block's 24:00 are fixed.
                const grips: Part[] = [];
                if (c.start > 0) grips.push("start");
                if (c.end < TICKS_PER_DAY) grips.push("end");
                return (
                    <g key={`c${i}`}>
                        <rect x={x(c.start)} y={2} width={w} height={height - 4}
                            fill={hot ? "rgba(233,95,73,0.32)" : "rgba(233,95,73,0.18)"} stroke={chosen ? "white" : "rgba(233,95,73,0.9)"} strokeWidth={hot || chosen ? 2 : 1} />
                        {/* The Planner timeline's look: diagonal hatching and what the block is. */}
                        <path d={hatch(x(c.start), 2, w, height - 4, rem * 9)} fill="none" stroke="rgba(235,70,60,0.55)" strokeWidth={1.5} />
                        {w > rem * 70 && (
                            <text x={x(c.start) + w / 2} y={height / 2 + rem * 4} textAnchor="middle" fontSize={`${11}rem`} fill="rgba(255,150,140,0.95)">
                                {`${c.start === 0 ? "start" : c.end >= TICKS_PER_DAY ? "end" : "closed"} · no service ${formatTimeOfDay(c.start)}–${formatTimeOfDay(c.end)}`}
                            </text>
                        )}
                        {w > gripW * 3 && grips.map((p) => {
                            const at = p === "start" ? x(c.start) + rem * 2 : x(c.end) - rem * 2 - gripW;
                            const lit = hot && hover!.part === p;
                            return <rect key={p} x={at} y={(height - gripH) / 2} width={gripW} height={gripH} rx={2}
                                fill={lit ? "white" : "rgba(255,190,180,0.7)"} />;
                        })}
                    </g>
                );
            })}
            {bands.map((b, i) => {
                const w = Math.max(2, x(b.end) - x(b.start));
                const lit = picked === i || dragging === i;
                return (
                    <g key={i} opacity={dragging === i ? 0.6 : 1}>
                        {/* A schedule that is switched off keeps its bands but runs vanilla: outlines. */}
                        <rect x={x(b.start)} y={3} width={w} height={height - 6} rx={3} fill={modeFill(b.mode)}
                            fillOpacity={off ? 0.12 : lit ? 0.95 : 0.7}
                            stroke={lit ? "white" : off ? modeFill(b.mode) : "none"} strokeWidth={1.5}
                            strokeDasharray={off && !lit ? `${rem * 4} ${rem * 3}` : undefined} />
                        {w > rem * 60 && (
                            <text x={x(b.start) + rem * 8} y={height / 2 + rem * 4} fontSize={`${11}rem`} fill="white" fillOpacity={off ? 0.6 : 1}>
                                {off ? `${bandLabel(b)} · schedule off` : bandLabel(b)}
                            </text>
                        )}
                        {/* Grips (Traffic's drag handles): white while hovered or dragged. */}
                        {(["start", "end"] as Part[]).map((p) => {
                            const at = p === "start" ? x(b.start) + rem * 2 : x(b.end) - rem * 2 - gripW;
                            const hot = (hover?.kind === "band" && hover.band === i && hover.part === p) || dragging === i;
                            return w > gripW * 3 && (
                                <rect key={p} x={at} y={(height - gripH) / 2} width={gripW} height={gripH} rx={2}
                                    fill={hot ? "white" : "rgba(255,255,255,0.45)"} />
                            );
                        })}
                    </g>
                );
            })}
        </svg>
    );
};

/**
 * Coordination: one game hour (the marker's) across the track, each row's departures as ticks —
 * timetabled lines at their real times (drag the row to shift its timetable), headway lines
 * evenly from the hour (no fixed phase, so drawn faint) — over a :00/:15/:30/:45 scale, and a
 * combined row where departures within a clock-minute of each other stack: a red tick with ×n,
 * the bunching the view is for.
 */
const Coordination = ({ rows, hour, width, nameCol, onShift }: {
    rows: BoardRow[]; hour: number; width: number; nameCol: number;
    /** Shift a timetabled line's departures by `frames` (the board drafts it). */
    onShift: (row: BoardRow, frames: number) => void;
}) => {
    const rem = useRem();
    const h0 = hour * HOUR, span = HOUR;
    const MIN = TICKS_PER_DAY / 1440; // one clock-minute in frames
    const x = (f: number) => ((f - h0) / span) * width;
    // A departure in the last half-minute is really the next hour's first: leave it out.
    const inHour = (f: number) => f >= h0 && f < h0 + span - MIN / 2;
    const [drag, setDrag] = useState<{ key: number; df: number } | null>(null);

    const timetabled = (r: BoardRow) => !!r.schedule.timetable;
    /** Only a plain grid or a list of set times can be shifted; a band-following grid runs from the bands. */
    const shiftable = (r: BoardRow) => timetabled(r) && (withTimetableDefaults(r.schedule).timetableFlags & TimetableFlags.FollowBands) === 0;
    const ticksOf = (r: BoardRow): { at: number[]; fixed: boolean } => {
        if (timetabled(r)) {
            const off = drag && drag.key === r.entity.index ? drag.df : 0;
            const deps = departuresOfDay(withTimetableDefaults(r.schedule))
                .map((f) => (((f + off) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY).filter(inHour);
            return { at: deps, fixed: true };
        }
        const hw = runAt(r, hour).headway;
        if (hw <= 0) return { at: [], fixed: false };
        const step = hw * 60; // seconds → frames
        const at: number[] = [];
        for (let f = h0; inHour(f) && at.length < 120; f += step) at.push(f);
        return { at, fixed: false };
    };
    const all = rows.map(ticksOf);
    const merged = all.flatMap((t) => t.at).sort((a, b) => a - b);
    // Stacks: real (timetabled) departures within a clock-minute of each other. Headway lines'
    // ticks are placed from :00 by us, not by the game, so they must not count as bunching.
    const fixedTicks = all.filter((t) => t.fixed).flatMap((t) => t.at).sort((a, b) => a - b);
    const floating = all.filter((t) => !t.fixed).flatMap((t) => t.at);
    const stacks: { at: number; n: number }[] = [];
    for (const f of fixedTicks) {
        const last = stacks[stacks.length - 1];
        if (last && f - last.at < MIN) last.n++;
        else stacks.push({ at: f, n: 1 });
    }
    const gaps = stacks.map((st, i) => (i === 0 ? st.at - h0 : st.at - stacks[i - 1].at));
    const widest = stacks.length ? Math.max(...gaps, h0 + span - stacks[stacks.length - 1].at) : span;
    // Gaps are only known between real departures; with none, fall back to everything drawn.
    const even = fixedTicks.length ? span / fixedTicks.length : merged.length ? span / merged.length : span;
    const bunched = stacks.filter((st) => st.n > 1).length;
    const mins = (f: number) => Math.round(f / MIN);
    const h = rem * 16;
    const quarters = [0, 15, 30, 45, 60].map((m) => h0 + m * MIN);
    const grid = quarters.map((f, k) => <line key={`q${k}`} x1={x(f)} x2={x(f)} y1={0} y2={h} stroke="rgba(255,255,255,0.1)" strokeWidth={1} />);

    /** Drag a timetabled row sideways: the preview follows, release drafts the shift (whole minutes). */
    const startShift = (e: React.MouseEvent, r: BoardRow) => {
        if (e.button !== 0 || !shiftable(r)) return;
        e.stopPropagation();
        const x0 = e.clientX;
        const box = (e.currentTarget as Element).getBoundingClientRect();
        let df = 0;
        const move = (ev: MouseEvent) => {
            df = Math.round((((ev.clientX - x0) / Math.max(1, box.width)) * span) / MIN) * MIN;
            setDrag({ key: r.entity.index, df });
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            setDrag(null);
            if (df !== 0) onShift(r, df);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    };

    return (
        <div className={styles.coord}>
            <div className={styles.boardGroup}>{`Coordination ${formatTimeOfDay(h0)}–${formatTimeOfDay(h0 + span)} · ${rows.length} line${rows.length === 1 ? "" : "s"}`}</div>
            {/* Minute scale. */}
            <div className={styles.boardRow}>
                <div style={{ width: `${nameCol}px` }} />
                <div className={styles.coordScale} style={{ width: `${width}px` }}>
                    {quarters.map((f, k) => (
                        <div key={k} className={styles.boardTick} style={{ left: `${x(f)}px` }}>{k === 4 ? "" : `:${String(k * 15).padStart(2, "0")}`}</div>
                    ))}
                </div>
            </div>
            {rows.map((r, i) => (
                <div key={r.entity.index} className={styles.boardRow}>
                    <div style={{ width: `${nameCol}px` }} className={styles.boardName}>
                        <div className={styles.swatch} style={{ backgroundColor: cssColor(r.color) }} />
                        <LocalizedEntityName value={r.name} />
                        {!all[i].fixed && all[i].at.length > 0 && <span className={styles.dim} style={{ marginLeft: `${rem * 6}px` }}>headway</span>}
                        {drag && drag.key === r.entity.index && <span className={styles.warn} style={{ marginLeft: `${rem * 6}px` }}>{`${drag.df > 0 ? "+" : ""}${mins(drag.df)} min`}</span>}
                    </div>
                    <svg width={width} height={h} onMouseDown={(e) => startShift(e, r)}
                        style={{ cursor: shiftable(r) ? "ew-resize" : "default" }}>
                        {grid}
                        <line x1={0} x2={width} y1={h / 2} y2={h / 2} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
                        {all[i].at.map((f, k) => <line key={k} x1={x(f)} x2={x(f)} y1={2} y2={h - 2} stroke={cssColor(r.color)} strokeWidth={2} strokeOpacity={all[i].fixed ? 1 : 0.45} />)}
                    </svg>
                </div>
            ))}
            <div className={styles.boardRow}>
                <div style={{ width: `${nameCol}px` }} className={classNames(styles.boardInfo, (widest > even * 1.5 || bunched > 0) && styles.warn)}>
                    {merged.length
                        ? `Combined: ${merged.length}/h${fixedTicks.length ? ` · timetabled widest gap ${mins(widest)} min (even: ${mins(even)})` : ""}${bunched ? ` · ${bunched} bunched` : ""}`
                        : "No departures this hour"}
                </div>
                <svg width={width} height={h + rem * 12}>
                    {grid}
                    <line x1={0} x2={width} y1={h / 2} y2={h / 2} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
                    {floating.map((f, k) => <line key={`f${k}`} x1={x(f)} x2={x(f)} y1={4} y2={h - 4} stroke="white" strokeWidth={1.5} strokeOpacity={0.35} />)}
                    {stacks.map((st, k) => (
                        <g key={k}>
                            <line x1={x(st.at)} x2={x(st.at)} y1={2} y2={h - 2} stroke={st.n > 1 ? "#e95f49" : "white"} strokeWidth={st.n > 1 ? 3 : 2} />
                            {st.n > 1 && <text x={x(st.at) + rem * 3} y={h + rem * 10} fontSize={`${10}rem`} fill="#e95f49">{`×${st.n}`}</text>}
                        </g>
                    ))}
                </svg>
            </div>
            <div className={styles.hint}>Timetabled lines show their real departures — drag a row sideways to shift its timetable (whole minutes; drafted like any edit). Headway lines have no fixed times, so their faint ticks only show how often they run. Red ×n in the combined row = n lines leaving together.</div>
        </div>
    );
};

/** A small text box + confirm, for naming a group or a plan. */
const NameBar = ({ label, action, onDone, onCancel, extra, initial = "", taken }: {
    label: string; action: string; onDone: (name: string) => void; onCancel: () => void; extra?: React.ReactNode;
    /** Text the box starts with (a rename starts from the old name). */
    initial?: string;
    /** Names already in use: the action is refused for these, with a note. */
    taken?: string[];
}) => {
    const [name, setName] = useState(initial);
    const clash = !!taken && taken.includes(name.trim()) && name.trim() !== initial;
    return (
        <div className={styles.boardBar}>
            <span className={styles.inlineHint}>{label}</span>
            <TextField value={name} placeholder="Name" onChange={setName}
                onKeyDown={(e) => { if (e.key === "Enter" && name.trim() && !clash) onDone(name.trim()); else if (e.key === "Escape") onCancel(); }} />
            <FlatButton onClick={() => onDone(name.trim())} disabled={!name.trim() || clash}>{action}</FlatButton>
            {clash && <span className={classNames(styles.inlineHint, styles.warn)}>That name is taken</span>}
            {extra}
            <FlatButton onClick={onCancel}>Cancel</FlatButton>
        </div>
    );
};

export const ScheduleBoardPanel = ({ typeSel, onOpenInPlanner }: { typeSel: TypeSelection; onOpenInPlanner: (e: LineRow["entity"]) => void }) => {
    const page = vanilla.overviewPage;
    const { PanelSection, FloatingMouseTooltip } = vanilla;
    const rem = useRem();
    useEffect(() => { setBoardType(typeSel.type, typeSel.cargo); }, [typeSel.type, typeSel.cargo]);
    const board = useValue(board$.binding);
    const ready = board.type === typeSel.type && board.cargo === typeSel.cargo;
    const now = useValue(timeOfDay$.binding);
    const selectedLine = useValue(selected$.binding);
    const { all: allPresets, custom, save: savePreset, remove: removePreset } = usePresets();

    // --- Draft (Traffic's "editing plan"): edits collect here until Apply. ---------------------
    const [draft, setDraft] = useState<Record<number, Schedule>>({});
    const [tplDraft, setTplDraft] = useState<Record<string, Band[]>>({});
    const [immediate, setImmediate] = useState(false);
    const pending = Object.keys(draft).length + Object.keys(tplDraft).length;
    useEffect(() => { setDraft({}); setTplDraft({}); }, [typeSel.type, typeSel.cargo]);

    // Lines: the game's rows with the draft laid over, sorted by group, dragged order, entity.
    const lines = useMemo(() => (ready ? board.rows.map((r) => (draft[r.entity.index] ? { ...r, schedule: draft[r.entity.index] } : r)) : [])
        .sort((a, b) => (a.schedule.group ?? "").localeCompare(b.schedule.group ?? "")
            || (a.schedule.order || 1e9) - (b.schedule.order || 1e9) || a.entity.index - b.entity.index), [board, ready, draft]);

    // Shared templates are the player's own presets. A template row shows each one some line of
    // this type follows; editing it re-saves the preset and pushes its bands to every line on it.
    const used = useMemo(() => new Set(lines.map((r) => r.schedule.template).filter((t): t is string => !!t)), [lines]);
    const templateBands = (name?: string): Band[] | undefined =>
        name === undefined ? undefined : tplDraft[name] ?? custom.find((p) => p.name === name)?.bands.map((b) => ({ primary: [], secondary: [], ...b }));
    const templateRows: BoardRow[] = custom.filter((p) => used.has(p.name)).map((p, k) => ({
        entity: { index: -1 - k, version: 0 }, name: { __Type: "Game.UI.NameSystem+Name", nameType: 0, name: p.name } as unknown as BoardRow["name"],
        color: { r: 1, g: 1, b: 1, a: 1 }, fleet: 0, target: 0, headway: 0, stable: 0, notEnoughVehicles: false, hourHeadway: [],
        schedule: { entity: { index: -1 - k, version: 0 }, enabled: true, bands: templateBands(p.name) ?? [], closed: [], template: p.name } as unknown as Schedule,
    }));
    const isTemplate = (r: BoardRow) => r.entity.index < 0;

    // Drag preview: the dragged row's bands, until release writes them to the draft. While a band
    // is dragged onto another row, `drop` previews that row with the band laid in.
    const [preview, setPreview] = useState<{ key: number; bands: Band[]; band: number; closed?: Closed[] } | null>(null);
    const [drop, setDrop] = useState<{ key: number; bands: Band[]; band: number; copy: boolean; closed?: Closed[] } | null>(null);
    const shown = [...templateRows, ...lines].map((r) => (drop && drop.key === r.entity.index
        ? { ...r, schedule: { ...r.schedule, bands: drop.bands, closed: drop.closed ?? r.schedule.closed } }
        : preview && preview.key === r.entity.index
        ? { ...r, schedule: { ...r.schedule, bands: preview.bands, closed: preview.closed ?? r.schedule.closed } } : r));

    /** Clips a template's bands onto a line (its closed hours). */
    const fitTo = (l: BoardRow, bands: Band[]) =>
        sortBands(clipToService(bands.filter((b) => b.mode !== BandMode.Off).map((b) => ({ ...b, primary: [], secondary: [] })), l.schedule.closed ?? []));

    /** Sends one line's schedule, or queues it in the draft. */
    const writeLine = (next: Schedule) => {
        if (immediate) setSchedule(next);
        else setDraft((d) => ({ ...d, [next.entity.index]: next }));
    };
    /** Writes a row: a line as itself, a template by re-saving it and re-fitting every line on it. */
    const write = (r: BoardRow, next: Schedule) => {
        if (!isTemplate(r)) { writeLine(next); return; }
        const name = r.schedule.template!;
        if (immediate) savePreset(name, next.bands.map(toPresetBand));
        else setTplDraft((d) => ({ ...d, [name]: next.bands }));
        for (const l of lines) if (l.schedule.template === name) writeLine({ ...l.schedule, enabled: true, bands: fitTo(l, next.bands) });
    };
    const apply = () => {
        for (const [name, bands] of Object.entries(tplDraft)) savePreset(name, bands.map(toPresetBand));
        for (const s of Object.values(draft)) setSchedule(s);
        setDraft({}); setTplDraft({});
    };
    const discard = () => { setDraft({}); setTplDraft({}); setPick(null); };

    /** A linked line whose bands no longer match its template (edited in the planner, or clipped). */
    const drifted = (l: BoardRow) => {
        const t = templateBands(l.schedule.template || undefined);
        if (!t) return false;
        return !samePresetBands(fitTo(l, t).map(toPresetBand), l.schedule.bands.map(toPresetBand));
    };

    // --- View (zoom / pan), scrub, selection. -----------------------------------------------------
    const [view, setView] = useState<View>(FULL);
    const span = view.to - view.from;
    const clampView = (from: number, to: number): View => {
        const len = Math.max(HOUR, Math.min(TICKS_PER_DAY, to - from));
        const f = Math.max(0, Math.min(TICKS_PER_DAY - len, from));
        return { from: f, to: f + len };
    };
    const zoomAt = (f: number, factor: number) => setView((v) => clampView(f - (f - v.from) * factor, f + (v.to - f) * factor));

    const [checked, setChecked] = useState<number[]>([]);
    const [collapsed, setCollapsed] = useState<string[]>([]);
    const [naming, setNaming] = useState<"" | "group" | "plan" | "renamePlan" | "template" | "renameTemplate">("");
    const [coord, setCoord] = useState(false);
    // The wizard opens by itself on a board where no line has a schedule yet (once per type), and
    // from the Wizard… button any time.
    const [wizard, setWizard] = useState(false);
    const [wizardSeen, setWizardSeen] = useState<string[]>([]);
    const typeKey = `${typeSel.type}:${typeSel.cargo}`;
    const blank = ready && board.rows.length > 0 && board.rows.every((r) => !(r.schedule.bands ?? []).length && !(r.schedule.closed ?? []).length);
    useEffect(() => {
        if (blank && !wizardSeen.includes(typeKey)) { setWizard(true); setWizardSeen((w) => [...w, typeKey]); }
    }, [blank, typeKey]);
    const applyWizard = (out: WizardResult[], template: string | null) => {
        for (const { line, bands, closed, extra } of out) {
            writeLine({ ...line.schedule, ...extra, enabled: true, bands: sortBands(bands), closed, ...(template ? { template } : {}) });
        }
    };
    const [pick, setPickBand] = useState<{ key: number; band: number } | null>(null);
    // A band or a closed block is selected, never both.
    const [pickClosed, setPickClosed] = useState<{ key: number; index: number } | null>(null);
    const setPick = (p: { key: number; band: number } | null) => { setPickBand(p); if (p) setPickClosed(null); };
    const [scrub, setScrub] = useState<number | null>(null);
    const [hoverTip, setHoverTip] = useState<{ row: BoardRow; band: Band } | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const hourAt = Math.min(23, Math.floor((scrub ?? now) / HOUR));

    const track = useRef<HTMLDivElement | null>(null);
    const rect = vanilla.useElementRect(track);
    // The rows' box, to lay one clock / scrub line over all of them (Traffic draws its playhead
    // once over the whole timeline; a line per row breaks at every row gap).
    const rowsBox = useRef<HTMLDivElement | null>(null);
    const rowsRect = vanilla.useElementRect(rowsBox);
    // The axis sits in the header, the rows in the Scrollable under it, whose scrollbar takes
    // room on the right: leave that gutter so 24:00 (and the band edge there) is not under it.
    const width = Math.max(0, (rect?.width ?? 0) - rem * 18);
    const rowH = rem * 26;
    const x = (f: number) => ((f - view.from) / span) * width;

    // Wheel over the axis zooms around the cursor (a native, non-passive listener: the list's own
    // Scrollable would otherwise take the wheel).
    useEffect(() => {
        const el = track.current;
        if (!el) return;
        const wheel = (e: WheelEvent) => {
            const b = el.getBoundingClientRect();
            const w = Math.max(1, b.width - rem * 18);
            e.preventDefault(); e.stopPropagation();
            // Shift + wheel (or a sideways wheel) pans a tenth of the view per notch.
            if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
                const d = (e.shiftKey ? e.deltaY : e.deltaX) > 0 ? 1 : -1;
                setView((v) => clampView(v.from + d * (v.to - v.from) / 10, v.to + d * (v.to - v.from) / 10));
                return;
            }
            setView((v) => {
                const f = v.from + ((e.clientX - b.left) / w) * (v.to - v.from);
                const k = e.deltaY > 0 ? 1.25 : 0.8;
                return clampView(f - (f - v.from) * k, f + (v.to - f) * k);
            });
        };
        el.addEventListener("wheel", wheel, { passive: false, capture: true } as AddEventListenerOptions);
        return () => el.removeEventListener("wheel", wheel, { capture: true } as EventListenerOptions);
    }, [track.current, rem]);

    // --- Dragging bands, panning, reordering rows: window listeners, released on mouse-up. -------
    const rowsRef = useRef(shown);
    rowsRef.current = shown;
    const listen = (move: (e: MouseEvent) => void, up: (e: MouseEvent) => void) => {
        const u = (e: MouseEvent) => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", u); up(e); };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", u);
    };
    /**
     * The row under a screen point (lines and template rows), or null: the engine's own hit test
     * up to the row's data-row. (Comparing y with each row's rect picked a row too low in a live
     * test; the hit test is what the engine will deliver the next click to.)
     */
    const rowAt = (x: number, y: number) => {
        let el = document.elementFromPoint(x, y) as HTMLElement | null;
        while (el && el.dataset?.row === undefined) el = el.parentElement;
        if (!el) return null;
        const key = Number(el.dataset.row);
        return rowsRef.current.find((r) => r.entity.index === key) ?? null;
    };
    const startDrag = (g: Drag) => {
        let next: Band[] | null = null;
        let nextClosed: Closed[] | null = null;
        // A band's body dragged onto another row: that row, its bands with the band laid in, and
        // whether it is a copy (Ctrl held at release) or a move.
        let target: { row: BoardRow; bands: Band[]; copy: boolean; closed?: Closed[] } | null = null;
        const r0 = rowsRef.current.find((x) => x.entity.index === g.key);
        listen((e) => {
            const df = ((e.clientX - g.x0) / Math.max(1, g.boxWidth)) * g.span;
            let st = g.start, en = g.end;
            if (g.part === "start") st = Math.min(Math.max(g.min, snap(g.start + df)), g.end - SNAP);
            else if (g.part === "end") en = Math.max(Math.min(g.max, snap(g.end + df)), g.start + SNAP);
            else { const len = g.end - g.start; st = Math.min(Math.max(g.min, snap(g.start + df)), g.max - len); en = st + len; }
            if (g.kind === "closed" && r0) {
                const over = g.part === "body" ? rowAt(e.clientX, e.clientY) : null;
                if (over && over.entity.index !== g.key) {
                    // A block dragged onto another line: merged into its closed hours (overlaps
                    // join into one block), its bands cut to what stays open.
                    const len = g.end - g.start;
                    const s2 = Math.min(Math.max(0, snap(g.start + df)), TICKS_PER_DAY - len);
                    const closedTo = mergeClosed([...(over.schedule.closed ?? []), { start: s2, end: s2 + len }]);
                    const bandsTo = sortBands(clipToService(over.schedule.bands ?? [], closedTo));
                    target = { row: over, bands: bandsTo, copy: e.ctrlKey, closed: closedTo };
                    setDrop({ key: over.entity.index, bands: bandsTo, band: -1, copy: e.ctrlKey, closed: closedTo });
                    nextClosed = e.ctrlKey ? (r0.schedule.closed ?? []) : (r0.schedule.closed ?? []).filter((_, i) => i !== g.band);
                    next = r0.schedule.bands ?? [];
                    setPreview({ key: g.key, bands: next, band: -1, closed: nextClosed });
                    return;
                }
                target = null;
                setDrop(null);
                nextClosed = (r0.schedule.closed ?? []).map((c, i) => (i === g.band ? { start: st, end: en } : c));
                next = clipToService(r0.schedule.bands ?? [], nextClosed);
                setPreview({ key: g.key, bands: next, band: -1, closed: nextClosed });
            } else {
                const over = g.part === "body" ? rowAt(e.clientX, e.clientY) : null;
                if (over && over.entity.index !== g.key) {
                    // Across rows the band keeps its length but not the source's neighbours: its
                    // time follows the pointer over the whole day, clipped by the target itself.
                    const len = g.end - g.start;
                    const s2 = Math.min(Math.max(0, snap(g.start + df)), TICKS_PER_DAY - len);
                    const moved = { ...g.bands[g.band], start: s2, end: s2 + len };
                    const placed = layBand(over.schedule.bands ?? [], moved, over.schedule.closed ?? []);
                    target = { row: over, bands: placed, copy: e.ctrlKey };
                    setDrop({ key: over.entity.index, bands: placed, band: placed.findIndex((b) => b.start >= s2), copy: e.ctrlKey });
                    next = e.ctrlKey ? g.bands : g.bands.filter((_, i) => i !== g.band);
                    setPreview({ key: g.key, bands: next, band: -1 });
                    return;
                }
                target = null;
                setDrop(null);
                next = g.bands.map((b, i) => (i === g.band ? { ...b, start: st, end: en } : b));
                setPreview({ key: g.key, bands: next, band: g.band });
            }
        }, () => {
            setPreview(null);
            setDrop(null);
            if (!next) return;
            const r = rowsRef.current.find((x) => x.entity.index === g.key);
            if (!r) return;
            if (target) {
                const to = target.row;
                write(to, target.closed
                    ? { ...to.schedule, closed: target.closed, bands: target.bands }
                    : { ...to.schedule, enabled: true, bands: target.bands });
                if (!target.copy) {
                    if (target.closed && nextClosed) write(r, { ...r.schedule, closed: nextClosed });
                    else write(r, { ...r.schedule, bands: sortBands(next) });
                }
                setPick(null);
                return;
            }
            if (nextClosed) setClosedFor(r, nextClosed);
            else write(r, { ...r.schedule, bands: sortBands(next) });
        });
    };

    /** A line's closed blocks replaced; the bands are cut to what stays open, in the same write. */
    const setClosedFor = (r: BoardRow, closed: Closed[]) => {
        const sorted = [...closed].sort((a, b) => a.start - b.start);
        write(r, { ...r.schedule, closed: sorted, bands: sortBands(clipToService(r.schedule.bands ?? [], sorted)) });
        setPick(null);
    };
    /**
     * Service hours on the ticked lines (or the selected one): a closed block at the start of the
     * day (to 05:00) or its end (from 23:00), up to the next block — or, pressed again, removed —
     * and a one-hour block in the middle of the widest open stretch. As the Planner's buttons.
     */
    const edgeBlock = (side: "start" | "end") => {
        for (const r of closedScope) {
            const closed = [...(r.schedule.closed ?? [])].sort((a, b) => a.start - b.start);
            const at = side === "start" ? closed.findIndex((c) => c.start === 0) : closed.findIndex((c) => c.end >= TICKS_PER_DAY);
            if (at >= 0) { setClosedFor(r, closed.filter((_, i) => i !== at)); continue; }
            const block = side === "start"
                ? { start: 0, end: Math.min(5 * HOUR, closed[0]?.start ?? TICKS_PER_DAY) }
                : { start: Math.max(23 * HOUR, closed[closed.length - 1]?.end ?? 0), end: TICKS_PER_DAY };
            if (block.end - block.start >= minutesToFrames(15)) setClosedFor(r, [...closed, block]);
        }
    };
    const middleBlock = () => {
        for (const r of closedScope) {
            const closed = r.schedule.closed ?? [];
            const gap = largestGap([], closed);
            if (!gap) continue;
            const len = Math.min(HOUR, gap.end - gap.start), mid = (gap.start + gap.end) / 2;
            setClosedFor(r, [...closed, { start: snap(mid - len / 2), end: snap(mid + len / 2) }]);
        }
    };
    const startPan = (x0: number, boxWidth: number) => {
        const v0 = view;
        listen((e) => {
            const df = ((e.clientX - x0) / Math.max(1, boxWidth)) * (v0.to - v0.from);
            setView(clampView(v0.from - df, v0.to - df));
        }, () => { });
    };
    const rowEls = useRef<Record<number, HTMLDivElement | null>>({});
    const [reorder, setReorder] = useState<{ key: number; over: number } | null>(null);
    const startReorder = (key: number, group: string) => {
        const peers = lines.filter((l) => (l.schedule.group ?? "") === group).map((l) => l.entity.index);
        let over = key;
        setReorder({ key, over });
        listen((e) => {
            for (const k of peers) {
                const el = rowEls.current[k];
                if (!el) continue;
                const b = el.getBoundingClientRect();
                if (e.clientY >= b.top && e.clientY < b.bottom) { over = k; setReorder({ key, over }); break; }
            }
        }, () => {
            setReorder(null);
            if (over === key) return;
            const order = peers.filter((k) => k !== key);
            order.splice(order.indexOf(over) + (peers.indexOf(over) > peers.indexOf(key) ? 1 : 0), 0, key);
            setBoardOrder(order.map((k) => lines.find((l) => l.entity.index === k)!.entity));
        });
    };

    /** A new Headway band filling the gap around `f` (between neighbouring bands and closed blocks). */
    const addAt = (r: BoardRow, f: number) => {
        const bands = r.schedule.bands ?? [], closed = r.schedule.closed ?? [];
        if (closed.some((c) => f >= c.start && f < c.end) || bands.some((b) => f >= b.start && f < b.end)) return;
        const walls = [0, TICKS_PER_DAY, ...bands.flatMap((b) => [b.start, b.end]), ...closed.flatMap((c) => [c.start, c.end])];
        const start = snap(Math.max(...walls.filter((w) => w <= f)));
        const end = snap(Math.min(...walls.filter((w) => w > f)));
        if (end - start < SNAP) return;
        const band: Band = { start, end, mode: BandMode.Headway, headway: minutesToSeconds(10), fleet: 0, fare: -1, primary: [], secondary: [] };
        const next = sortBands([...bands, band]);
        write(r, { ...r.schedule, enabled: true, bands: next });
        setPick({ key: r.entity.index, band: next.findIndex((b) => b.start === start) });
    };
    /** Cuts band `i` in two at `f` (snapped); each half keeps the band's settings. */
    const splitAt = (r: BoardRow, i: number, f: number) => {
        const bands = r.schedule.bands ?? [];
        const b = bands[i], at = snap(f);
        if (!b || at - b.start < SNAP || b.end - at < SNAP) return;
        const next = [...bands.slice(0, i), { ...b, end: at }, { ...b, start: at }, ...bands.slice(i + 1)];
        write(r, { ...r.schedule, bands: next });
        setPick({ key: r.entity.index, band: i + 1 });
    };

    const pickedRow = pick ? shown.find((r) => r.entity.index === pick.key) : undefined;
    const pickedBand = pickedRow && pick ? pickedRow.schedule.bands[pick.band] : undefined;
    const patch = (p: Partial<Band>) => {
        if (!pickedRow || !pick) return;
        write(pickedRow, { ...pickedRow.schedule, bands: pickedRow.schedule.bands.map((b, i) => (i === pick.band ? { ...b, ...p } : b)) });
    };
    const targets = lines.filter((r) => checked.includes(r.entity.index));
    // Closed-hours buttons act on the ticked lines, or else on the line whose band is selected.
    const closedScope = targets.length ? targets : lines.filter((l) => pick && l.entity.index === pick.key);
    const scope = targets.length ? targets : lines; // plan actions: the ticked lines, else all

    // --- Bulk actions over the ticked rows (drafted like any edit). ------------------------------
    const copyBand = () => {
        if (!pickedBand) return;
        for (const r of targets) {
            if (pickedRow && sameEntity(r.entity, pickedRow.entity)) continue;
            writeLine({ ...r.schedule, enabled: true, bands: insertBand(r.schedule.bands, { ...pickedBand, line: undefined }, r.schedule.closed) });
        }
    };
    const presets = presetsFor(allPresets, typeSel.cargo);
    const applyPreset = (name: string) => {
        const p = presets.find((x) => x.name === name);
        if (!p) return;
        for (const r of targets) writeLine({ ...r.schedule, enabled: true, bands: fitTo(r, p.bands.map((b) => ({ primary: [], secondary: [], ...b }))) });
    };
    const setEnabled = (on: boolean) => { for (const r of targets) writeLine({ ...r.schedule, enabled: on }); };
    const linkTemplate = (name: string) => {
        const t = templateBands(name);
        if (!t) return;
        for (const r of targets) writeLine({ ...r.schedule, template: name, enabled: true, bands: fitTo(r, t) });
    };
    const unlink = () => { for (const r of targets) writeLine({ ...r.schedule, template: "" }); };
    /** Saves the selected line's bands as a new template and links that line to it. */
    const newTemplate = (name: string) => {
        if (!pickedRow || isTemplate(pickedRow)) return;
        if (savePreset(name, pickedRow.schedule.bands.map(toPresetBand))) writeLine({ ...pickedRow.schedule, template: name });
        setNaming("");
    };
    /** A free "Template N" to start the name box from. */
    const nextTemplateName = () => { let n = 1; while (allPresets.some((p) => p.name === `Template ${n}`)) n++; return `Template ${n}`; };
    /**
     * Renames a template: the bands saved under the new name, every line on it relinked, the old
     * name removed. Links go to the game at once (like a delete), not through the draft.
     */
    const renameTemplate = (from: string, to: string) => {
        const t = custom.find((p) => p.name === from);
        if (!t || !savePreset(to, t.bands)) return;
        for (const l of lines) if (l.schedule.template === from) setSchedule({ ...l.schedule, template: to });
        removePreset(from);
        setNaming(""); setPick(null);
    };
    /**
     * Renames the live plan of the lines in scope: switching them to the new name keeps their bands
     * as that plan and stashes a copy under the old one, which is then dropped.
     */
    const renamePlan = (from: string, to: string) => {
        const on = scope.filter((l) => (l.schedule.plan ?? "Default") === from).map((l) => l.entity);
        if (!on.length) return;
        switchPlan(on, to);
        deletePlan(on, from);
        setNaming("");
    };
    /** Deletes a template: its lines keep their bands and stop following it. */
    const deleteTemplate = (name: string) => {
        removePreset(name);
        for (const l of lines) if (l.schedule.template === name) setSchedule({ ...l.schedule, template: "" });
        setConfirmDelete(null); setPick(null);
    };
    const setGroup = (g: string) => { for (const r of targets) writeLine({ ...r.schedule, group: g }); setNaming(""); };

    // Plans (Traffic's timing plans): names across the shown lines, the live one per line.
    const planNames = useMemo(() => [...new Set(lines.flatMap((l) => l.schedule.plans ?? []))], [lines]);
    const livePlans = [...new Set(scope.map((l) => l.schedule.plan ?? "Default"))];
    const planUsers = (name: string) => lines.filter((l) => (l.schedule.plans ?? []).includes(name)).length;

    // --- Totals and problems. -------------------------------------------------------------------
    const totals = useMemo(() => Array.from({ length: 24 }, (_, h) => lines.reduce((a, r) => a + runAt(r, h).fleet, 0)), [lines]);
    const peak = Math.max(1, board.depotCapacity, ...totals);
    const barH = rem * 44;
    const short = lines.filter((l) => l.notEnoughVehicles);
    const drift = lines.filter(drifted);
    const overHours = board.depotCapacity > 0 ? totals.map((t, h) => (t > board.depotCapacity ? h : -1)).filter((h) => h >= 0) : [];
    const worstHour = overHours.length ? overHours.reduce((a, h) => (totals[h] > totals[a] ? h : a), overHours[0]) : -1;

    // Hover preview: the hovered row's line highlighted in the world.
    const [hoverLine, setHoverLine] = useState<Entity>(NULL_ENTITY);
    useEffect(() => { setWorldHighlight(hoverLine); }, [hoverLine.index]);
    useEffect(() => () => setWorldHighlight(NULL_ENTITY), []);

    const lineRow = (r: BoardRow): LineRow => ({ entity: r.entity, name: r.name, color: r.color, type: typeSel.type, cargo: typeSel.cargo, fleet: r.fleet, target: r.target, headway: r.headway } as LineRow);
    const [inspectH, setInspectH] = useSplit("board", 380);
    const nameCol = rem * 150, infoCol = rem * 110, gripCol = rem * 14;
    const lead = gripCol + rem * 22 + nameCol; // grip + checkbox + name
    const ticks: number[] = [];
    const step = tickStep(span);
    for (let f = Math.ceil(view.from / step) * step; f <= view.to + 1; f += step) ticks.push(f);
    const inView = (f: number) => f >= view.from && f <= view.to;

    return (
        <div className={classNames(page.transportationOverviewPage, styles.fleetPage)}>
            <FloatingMouseTooltip screenSpacePosition alwaysVisible disabled={!hoverTip} tooltip={hoverTip ? (
                <div className={styles.boardTip}>
                    <div>{`${clockOf(hoverTip.band.start)}–${clockOf(hoverTip.band.end)} · ${bandLabel(hoverTip.band)}`}</div>
                    {!isTemplate(hoverTip.row) && (() => {
                        const hs = Array.from({ length: 24 }, (_, h) => h).filter((h) => (h + 0.5) * HOUR >= hoverTip.band.start && (h + 0.5) * HOUR < hoverTip.band.end);
                        const fl = hs.map((h) => runAt(hoverTip.row, h).fleet);
                        return fl.length ? <div className={styles.dim}>{`${Math.min(...fl)}${Math.max(...fl) !== Math.min(...fl) ? `–${Math.max(...fl)}` : ""} vehicles`}</div> : null;
                    })()}
                </div>) : null} />
            <PanelSection theme={vanilla.panelSection} className={classNames(page.lines, styles.fleetLines)} header={
                <div className={page.header}>
                    <div className={page.title}>{`${typeLabel[typeSel.type] ?? "?"} schedules`.toUpperCase()}</div>

                    {/* Toolbar in Traffic's manner: labelled sections (its uppercase left labels),
                        glyph buttons with tooltips for the actions an icon says clearly. */}
                    <div className={classNames(styles.boardTools, pending > 0 && styles.boardDraft)}>
                        <Section label="Changes" help="board.draft">
                            <vanilla.Checkbox checked={immediate} onChange={() => { if (!immediate) apply(); setImmediate(!immediate); }} />
                            <span className={styles.inlineHint}>Apply immediately</span>
                            {!immediate && (
                                <>
                                    <FlatButton disabled={pending === 0} onClick={apply} tooltip="Send every change to the game">{pending ? `Apply ${pending}` : "Nothing to apply"}</FlatButton>
                                    <Glyph src="Media/Glyphs/ArrowCircular.svg" tooltip="Discard the changes not applied yet" disabled={pending === 0} onClick={discard} />
                                </>
                            )}
                        </Section>
                        <Section label="Plan" help="board.plans">
                            <SelectDropdown<string> className={styles.boardSelect}
                                options={[[livePlans.length === 1 ? `${livePlans[0]} (live)` : "Mixed", ""] as [string, string]].concat(planNames.map((p) => [`${p} · ${planUsers(p)} line${planUsers(p) === 1 ? "" : "s"}`, p] as [string, string]))}
                                value="" onChange={(n) => n && pending === 0 && switchPlan(scope.map((l) => l.entity), n)} />
                            <Glyph src="Media/Glyphs/Plus.svg" disabled={pending > 0} onClick={() => setNaming(naming === "plan" ? "" : "plan")}
                                tooltip={`New plan: save the ${targets.length ? "ticked" : "shown"} lines' current bands under a new name`} />
                            <Glyph src="Media/Tools/Area Tool/Edit.svg" disabled={pending > 0 || livePlans.length !== 1} onClick={() => setNaming(naming === "renamePlan" ? "" : "renamePlan")}
                                tooltip={livePlans.length === 1 ? `Rename the plan "${livePlans[0]}"` : "The lines run different plans — tick the lines of one plan to rename it"} />
                            <SelectDropdown<string> className={styles.boardSelectSmall}
                                options={[["Delete…", ""] as [string, string]].concat(planNames.filter((p) => !livePlans.includes(p)).map((p) => [`${p} (${planUsers(p)} lines)`, p] as [string, string]))}
                                value="" onChange={(n) => n && deletePlan(scope.map((l) => l.entity), n)} />
                        </Section>
                        <Section label="Tools" help="board.wizard">
                            <FlatButton selected={wizard} onClick={() => setWizard(!wizard)} tooltip="Build schedules for many lines at once">Wizard</FlatButton>
                            <FlatButton selected={coord} onClick={() => setCoord(!coord)} tooltip="How the ticked lines' departures interleave in the hour at the marker">Coordination</FlatButton>
                        </Section>
                    </div>
                    {naming === "plan" && (
                        <NameBar label={`New plan for ${targets.length ? `${targets.length} ticked` : "all shown"} lines`} action="Save plan"
                            onDone={(n) => { switchPlan(scope.map((l) => l.entity), n); setNaming(""); }} onCancel={() => setNaming("")} taken={planNames} />
                    )}
                    {naming === "renamePlan" && livePlans.length === 1 && (
                        <NameBar label={`Rename plan "${livePlans[0]}"`} action="Rename" initial={livePlans[0]} taken={planNames}
                            onDone={(n) => renamePlan(livePlans[0], n)} onCancel={() => setNaming("")} />
                    )}
                    {naming === "template" && pickedRow && !isTemplate(pickedRow) && (
                        <NameBar label="New template from the selected line" action="Create" initial={nextTemplateName()} taken={allPresets.map((p) => p.name)}
                            onDone={newTemplate} onCancel={() => setNaming("")} />
                    )}
                    {naming === "renameTemplate" && pickedRow && isTemplate(pickedRow) && (
                        <NameBar label={`Rename template "${pickedRow.schedule.template}"`} action="Rename" initial={pickedRow.schedule.template} taken={allPresets.map((p) => p.name)}
                            onDone={(n) => renameTemplate(pickedRow.schedule.template!, n)} onCancel={() => setNaming("")} />
                    )}

                    <div className={styles.boardTools}>
                        <Section label={`Lines · ${checked.length} ticked`}>
                            <FlatButton onClick={() => setChecked(checked.length === lines.length ? [] : lines.map((r) => r.entity.index))}>
                                {checked.length === lines.length && lines.length > 0 ? "None" : "All"}
                            </FlatButton>
                            <FlatButton disabled={targets.length === 0} onClick={() => setEnabled(true)} tooltip="Switch the ticked lines' schedules on">On</FlatButton>
                            <FlatButton disabled={targets.length === 0} onClick={() => setEnabled(false)} tooltip="Switch them off: the lines run as vanilla">Off</FlatButton>
                            <FlatButton disabled={targets.length === 0} onClick={() => setNaming(naming === "group" ? "" : "group")} tooltip="File the ticked lines under a group">Group</FlatButton>
                        </Section>
                        <Section label="Bands">
                            <Glyph src="Media/Glyphs/Copy.svg" disabled={!pickedBand || targets.length === 0} onClick={copyBand}
                                tooltip="Copy the selected band, at the same times, onto every ticked line (overlapping bands are cut)" />
                            <SelectDropdown<string> className={styles.boardSelect}
                                options={[["Apply preset…", ""] as [string, string]].concat(presets.map((p) => [p.custom ? `${p.name} ★` : p.name, p.name] as [string, string]))}
                                value="" onChange={(n) => n && applyPreset(n)} />
                        </Section>
                        <Section label="Closed hours" help="planner.closed">
                            <FlatButton disabled={closedScope.length === 0} onClick={() => edgeBlock("start")}
                                tooltip="Close from midnight to the first service (again: remove it). Ticked lines, or the selected one.">Start</FlatButton>
                            <FlatButton disabled={closedScope.length === 0} onClick={() => edgeBlock("end")}
                                tooltip="Close from the last service to midnight (again: remove it)">End</FlatButton>
                            <FlatButton disabled={closedScope.length === 0} onClick={middleBlock}
                                tooltip="A closed hour in the middle of the widest open stretch; drag it into place">Block</FlatButton>
                        </Section>
                        <Section label="Template" help="board.templates">
                            <SelectDropdown<string> className={styles.boardSelect}
                                options={[["Link to…", ""] as [string, string]].concat(custom.map((p) => [p.name, p.name] as [string, string]))}
                                value="" onChange={(n) => n && targets.length > 0 && linkTemplate(n)} />
                            <Glyph src="Media/Glyphs/Plus.svg" disabled={!pickedRow || isTemplate(pickedRow)} onClick={() => setNaming(naming === "template" ? "" : "template")}
                                tooltip="New template from the selected line's bands (the line is linked to it)" />
                            <Glyph src="Media/Glyphs/Close.svg" disabled={targets.length === 0} onClick={unlink}
                                tooltip="Unlink the ticked lines: they keep their bands, stop following the template" />
                        </Section>
                    </div>
                    {naming === "group" && (
                        <NameBar label="Group name" action="Group ticked" onDone={setGroup} onCancel={() => setNaming("")}
                            extra={<FlatButton onClick={() => setGroup("")}>Ungroup ticked</FlatButton>} />
                    )}

                    {/* Problems (Traffic's error list): each jumps to where it is. */}
                    {ready && (short.length > 0 || drift.length > 0 || worstHour >= 0) && (
                        <div className={styles.boardBar}>
                            {worstHour >= 0 && (
                                <span className={classNames(styles.boardProblem, styles.warn)} onClick={() => setScrub(worstHour * HOUR + HOUR / 2)}>
                                    {`Peak needs ${totals[worstHour]} of ${board.depotCapacity} depot vehicles at ${formatTimeOfDay(worstHour * HOUR)}`}
                                </span>
                            )}
                            {short.length > 0 && (
                                <span className={classNames(styles.boardProblem, styles.warn)} onClick={() => { setChecked(short.map((l) => l.entity.index)); selected$.set(short[0].entity); }}>
                                    {`${short.length} line${short.length === 1 ? "" : "s"} short of vehicles`}
                                </span>
                            )}
                            {drift.length > 0 && (
                                <span className={styles.boardProblem} onClick={() => { for (const l of drift) { const t = templateBands(l.schedule.template); if (t) writeLine({ ...l.schedule, enabled: true, bands: fitTo(l, t) }); } }}>
                                    {`${drift.length} line${drift.length === 1 ? "" : "s"} changed from their template — click to re-sync`}
                                </span>
                            )}
                        </div>
                    )}

                    {/* Axis: click or drag to scrub, wheel to zoom, double-click to fit. Bubbles
                        (Traffic's value caps) carry the clock and the scrub time. */}
                    <div className={styles.boardRow}>
                        <div style={{ width: `${lead}px` }} className={styles.boardZoom}>
                            <FlatButton onClick={() => zoomAt((view.from + view.to) / 2, 1.25)}>−</FlatButton>
                            <FlatButton onClick={() => zoomAt((view.from + view.to) / 2, 0.8)}>+</FlatButton>
                            <FlatButton selected={span >= TICKS_PER_DAY} onClick={() => setView(FULL)}>Day</FlatButton>
                            <FlatButton selected={scrub === null} onClick={() => setScrub(null)} tooltip="Follow the game clock">Live</FlatButton>
                        </div>
                        <div style={{ width: `${infoCol}px` }} className={styles.dim}>{`${scrub === null ? "Now" : "At"} ${formatTimeOfDay(scrub ?? now)}`}</div>
                        <div ref={track} className={styles.boardAxis}
                            onDoubleClick={() => setView(FULL)}
                            onMouseDown={(e) => {
                                // The scrub marker follows the pointer, and on a zoomed axis the view
                                // follows the marker: within a twentieth of either edge (or past it)
                                // the view pans so the marker stays that far inside.
                                let v = view;
                                const set = (cx: number) => {
                                    const b = track.current!.getBoundingClientRect();
                                    const len = v.to - v.from;
                                    const f = snap(Math.max(0, Math.min(TICKS_PER_DAY, v.from + ((cx - b.left) / Math.max(1, width)) * len)));
                                    const margin = len / 20;
                                    if (len < TICKS_PER_DAY && (f < v.from + margin || f > v.to - margin)) {
                                        const from = f < v.from + margin ? f - margin : f + margin - len;
                                        v = clampView(from, from + len);
                                        setView(v);
                                    }
                                    setScrub(f);
                                };
                                set(e.clientX);
                                listen((ev) => set(ev.clientX), () => { });
                            }}>
                            {ticks.map((f) => (
                                <div key={f} className={styles.boardTick} style={{ left: `${x(f)}px` }}>{clockOf(f)}</div>
                            ))}
                            {inView(now) && <div className={classNames(styles.boardBubble, styles.boardBubbleNow)} style={{ left: `${x(now)}px` }}>{formatTimeOfDay(now)}</div>}
                            {scrub !== null && inView(scrub) && <div className={styles.boardBubble} style={{ left: `${x(scrub)}px` }}>{formatTimeOfDay(scrub)}</div>}
                        </div>
                    </div>
                    {/* The scrollbar under a zoomed axis (the Planner timeline's): drag the thumb,
                        or press the track to jump there. Shift + wheel over the hours pans too. */}
                    {span < TICKS_PER_DAY && width > 0 && (
                        <div className={styles.boardRow}>
                            <div style={{ width: `${lead + infoCol}px` }} />
                            <div className={styles.boardScrollTrack} style={{ width: `${width}px` }}
                                onMouseDown={(e) => {
                                    if (e.button !== 0) return;
                                    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                    const thumbL = (view.from / TICKS_PER_DAY) * box.width, thumbW = (span / TICKS_PER_DAY) * box.width;
                                    const px = e.clientX - box.left;
                                    // On the thumb: drag it. Elsewhere: centre the view there, then drag on.
                                    const v0 = px >= thumbL && px < thumbL + thumbW ? view
                                        : clampView((px / box.width) * TICKS_PER_DAY - span / 2, (px / box.width) * TICKS_PER_DAY + span / 2);
                                    setView(v0);
                                    listen((ev) => {
                                        const df = ((ev.clientX - e.clientX) / Math.max(1, box.width)) * TICKS_PER_DAY;
                                        setView(clampView(v0.from + df, v0.to + df));
                                    }, () => { });
                                }}>
                                <div className={styles.boardScrollThumb}
                                    style={{ left: `${(view.from / TICKS_PER_DAY) * width}px`, width: `${Math.max(rem * 12, (span / TICKS_PER_DAY) * width)}px` }} />
                            </div>
                        </div>
                    )}
                </div>}>
                <Scrollable vertical className={classNames(page.scrollable, styles.fleetScroll)}>
                    {wizard && ready && (
                        <ScheduleWizard lines={lines} ticked={checked} depotCapacity={board.depotCapacity} freight={typeSel.cargo}
                            onGenerate={applyWizard} onClose={() => setWizard(false)}
                            saveTemplate={(name, bands) => savePreset(name, bands.map(toPresetBand))} />
                    )}
                    <div ref={rowsBox} className={styles.boardRows} onMouseLeave={() => setHoverLine(NULL_ENTITY)}>
                        {ready && lines.length === 0 && <div className={page.noLines}>No lines</div>}
                        {!ready && <div className={page.noLines}>Reading lines…</div>}
                        {templateRows.length > 0 && <div className={classNames(styles.boardGroup, styles.dim)}>Templates</div>}
                        {shown.map((r, i) => {
                            const tpl = isTemplate(r);
                            const run = tpl ? { headway: 0, fleet: 0 } : runAt(r, hourAt);
                            const on = checked.includes(r.entity.index);
                            const group = tpl ? null : r.schedule.group ?? "";
                            const prev = i > 0 && !isTemplate(shown[i - 1]) ? shown[i - 1].schedule.group ?? "" : null;
                            const header = !tpl && group !== prev ? (
                                <div key={`g${group}`} className={styles.boardGroup} onClick={() => setCollapsed(collapsed.includes(group!) ? collapsed.filter((g) => g !== group) : [...collapsed, group!])}>
                                    {/* The game font has no ▸ / ▾: the game's own arrow glyph. */}
                                    <img className={styles.boardChevron} src={`Media/Glyphs/ThickStrokeArrow${collapsed.includes(group!) ? "Right" : "Down"}.svg`} />
                                    {group || "Ungrouped"}
                                    <span className={styles.dim}>{` · ${lines.filter((x) => (x.schedule.group ?? "") === group).reduce((a, x) => a + runAt(x, hourAt).fleet, 0)} vehicles at ${formatTimeOfDay(hourAt * HOUR)}`}</span>
                                </div>
                            ) : null;
                            if (!tpl && collapsed.includes(group!)) return header;
                            const users = tpl ? lines.filter((l) => l.schedule.template === r.schedule.template).length : 0;
                            const drafted = tpl ? !!tplDraft[r.schedule.template!] : !!draft[r.entity.index];
                            return [header,
                                <div key={r.entity.index} data-row={r.entity.index} ref={(el) => { rowEls.current[r.entity.index] = el; }}
                                    className={classNames(styles.boardRow, !tpl && sameEntity(r.entity, selectedLine) && styles.pickedRow, ((reorder?.over === r.entity.index && reorder.key !== r.entity.index) || drop?.key === r.entity.index) && styles.boardDropTarget)}
                                    onMouseEnter={() => setHoverLine(tpl ? NULL_ENTITY : r.entity)}>
                                    {/* Row grip: drag to reorder within the group (Traffic's reorderSignalGroup). */}
                                    <div className={styles.boardGrip} style={{ width: `${gripCol}px` }}
                                        onMouseDown={(e) => { if (!tpl) { e.stopPropagation(); startReorder(r.entity.index, group!); } }}>
                                        {!tpl && <><div /><div /><div /></>}
                                    </div>
                                    {/* The vanilla Checkbox takes the click itself: toggle in its onChange. */}
                                    {tpl ? <div style={{ width: `${rem * 22}px` }} /> : (
                                        <vanilla.Checkbox checked={on} onChange={() => setChecked((c) => (c.includes(r.entity.index) ? c.filter((x) => x !== r.entity.index) : [...c, r.entity.index]))} />
                                    )}
                                    <div className={styles.boardName} style={{ width: `${nameCol}px` }}
                                        onClick={() => !tpl && selected$.set(r.entity)} onDoubleClick={() => !tpl && onOpenInPlanner(r.entity)}>
                                        {tpl ? <span className={styles.badge}>template</span> : <div className={styles.swatch} style={{ backgroundColor: cssColor(r.color) }} />}
                                        {tpl ? <span>{r.schedule.template}</span> : <LocalizedEntityName value={r.name} />}
                                        {drafted && <Tooltip tooltip="Changed here, not applied yet"><span className={styles.boardDot} /></Tooltip>}
                                        {!tpl && r.schedule.template && (
                                            <Tooltip tooltip={drifted(r) ? `Follows "${r.schedule.template}" but its bands were changed — click to re-sync` : `Follows template "${r.schedule.template}"`}>
                                                <span className={classNames(styles.badge, drifted(r) && styles.warn)}
                                                    onClick={(e) => { e.stopPropagation(); const t = templateBands(r.schedule.template); if (t && drifted(r)) writeLine({ ...r.schedule, enabled: true, bands: fitTo(r, t) }); }}>
                                                    {drifted(r) ? "≠ tpl" : "tpl"}
                                                </span>
                                            </Tooltip>
                                        )}
                                    </div>
                                    {tpl ? (
                                        <div style={{ width: `${infoCol}px` }} className={classNames(styles.boardInfo, styles.dim)}>{`used by ${users}`}</div>
                                    ) : (
                                        <Tooltip tooltip={`${r.schedule.enabled ? "Schedule on" : "Schedule off (vanilla)"} · plan ${r.schedule.plan ?? "Default"} · running ${r.fleet} of ${r.target}${r.notEnoughVehicles ? " — short of vehicles" : ""}`}>
                                            <div style={{ width: `${infoCol}px` }} className={classNames(styles.boardInfo, !r.schedule.enabled && styles.dim, r.notEnoughVehicles && styles.warn)}>
                                                {run.headway > 0 ? `${Math.max(1, Math.round(secondsToMinutes(run.headway)))} min · ${run.fleet} veh` : "closed"}
                                            </div>
                                        </Tooltip>
                                    )}
                                    {width > 0 && (
                                        <RowTrack row={r} width={width} height={rowH} view={view} now={now} scrub={scrub}
                                            picked={pick && pick.key === r.entity.index ? pick.band : -1}
                                            dragging={drop && drop.key === r.entity.index ? drop.band : preview && preview.key === r.entity.index ? preview.band : -1}
                                            pickedClosed={pickClosed && pickClosed.key === r.entity.index ? pickClosed.index : -1}
                                            onPickClosed={(index) => { setPickBand(null); setPickClosed({ key: r.entity.index, index }); }}
                                            onPick={(band) => setPick({ key: r.entity.index, band })} onDrag={startDrag} onPan={startPan}
                                            onHover={(hit) => setHoverTip(hit ? { row: r, band: r.schedule.bands[hit.band] } : null)}
                                            onAdd={(f) => addAt(r, f)} onSplit={(band, f) => splitAt(r, band, f)} />
                                    )}
                                </div>];
                        })}
                        {/* The playheads: one line each across every row, from the axis's own x. */}
                        {rect && rowsRect && width > 0 && [[now, styles.boardPlayheadNow], ...(scrub !== null ? [[scrub, styles.boardPlayhead]] : [])].map(([f, cls]) => (
                            inView(f as number) && <div key={cls as string} className={cls as string} style={{ left: `${rect.x - rowsRect.x + x(f as number)}px` }} />
                        ))}
                    </div>
                    {coord && width > 0 && <Coordination rows={(targets.length ? targets : lines).slice(0, 12)} hour={hourAt} width={width} nameCol={lead + infoCol}
                        onShift={(r, df) => {
                            const t = withTimetableDefaults(r.schedule);
                            const wrap = (f: number) => (((f + df) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
                            writeLine((t.timetableFlags & TimetableFlags.List)
                                ? { ...r.schedule, timetableDepartures: (t.timetableDepartures ?? []).map(wrap).sort((a, b) => a - b) }
                                : { ...r.schedule, timetableFirst: wrap(t.timetableFirst) });
                        }} />}
                    {/* Totals strip: vehicles the shown schedules need each hour; the dashed line is
                        what the type's depots can hold. */}
                    {ready && lines.length > 0 && width > 0 && (
                        <div className={styles.boardRow}>
                            <div style={{ width: `${lead}px` }} className={styles.dim}>Vehicles needed</div>
                            <div style={{ width: `${infoCol}px` }} className={classNames(styles.boardInfo, totals[hourAt] > board.depotCapacity && board.depotCapacity > 0 && styles.warn)}>
                                {`${totals[hourAt]} / ${board.depotCapacity}`}
                            </div>
                            <svg width={width} height={barH}>
                                {totals.map((t, h) => {
                                    const x0 = x(h * HOUR), x1 = x((h + 1) * HOUR);
                                    if (x1 < 0 || x0 > width) return null;
                                    const bh = (t / peak) * (barH - 4);
                                    const over = board.depotCapacity > 0 && t > board.depotCapacity;
                                    return <rect key={h} x={x0 + 1} y={barH - bh} width={Math.max(1, x1 - x0 - 2)} height={bh} fill={over ? "#e95f49" : "#4b91e2"} fillOpacity={h === hourAt ? 1 : 0.6} />;
                                })}
                                {board.depotCapacity > 0 && (
                                    <line x1={0} x2={width} y1={barH - (board.depotCapacity / peak) * (barH - 4)} y2={barH - (board.depotCapacity / peak) * (barH - 4)}
                                        stroke="rgba(255,255,255,0.6)" strokeWidth={1} strokeDasharray={`${rem * 4} ${rem * 3}`} />
                                )}
                            </svg>
                        </div>
                    )}
                </Scrollable>

                {pickedBand && pickedRow && <SplitHandle height={inspectH} onHeight={setInspectH} />}
                {pickedBand && pickedRow ? (
                    <div className={classNames(styles.bulk, styles.ttDetail)} style={{ height: inspectH }}>
                        <div className={styles.row}>
                            <div className={styles.swatch} style={{ backgroundColor: cssColor(pickedRow.color) }} />
                            <span className={styles.sectionTitle}>{isTemplate(pickedRow) ? pickedRow.schedule.template : <LocalizedEntityName value={pickedRow.name} />}</span>
                            <span className={styles.inlineHint}>{`${clockOf(pickedBand.start)}–${clockOf(pickedBand.end)}`}</span>
                            <span className={styles.spacer} />
                            <FlatButton onClick={() => { write(pickedRow, { ...pickedRow.schedule, bands: pickedRow.schedule.bands.filter((_, k) => k !== pick!.band) }); setPick(null); }}>Remove band</FlatButton>
                            {!isTemplate(pickedRow) && <FlatButton onClick={() => onOpenInPlanner(pickedRow.entity)}>Open in planner</FlatButton>}
                            {isTemplate(pickedRow) && <FlatButton onClick={() => setNaming("renameTemplate")}>Rename</FlatButton>}
                            {isTemplate(pickedRow) && (() => {
                                const name = pickedRow.schedule.template!;
                                const n = lines.filter((l) => l.schedule.template === name).length;
                                return confirmDelete === name ? (
                                    <>
                                        <span className={classNames(styles.inlineHint, styles.warn)}>{`Used by ${n} line${n === 1 ? "" : "s"} — they keep their bands.`}</span>
                                        <FlatButton onClick={() => deleteTemplate(name)}>Delete</FlatButton>
                                        <FlatButton onClick={() => setConfirmDelete(null)}>Keep</FlatButton>
                                    </>
                                ) : <FlatButton onClick={() => setConfirmDelete(name)}>{`Delete template (used by ${n})`}</FlatButton>;
                            })()}
                        </div>
                        <Scrollable vertical className={styles.ttDetailScroll}>
                            <BandEditor band={pickedBand} patch={patch} freight={typeSel.cargo} line={lineRow(pickedRow)} autoFleet={pickedRow.schedule.autoFleet} />
                        </Scrollable>
                    </div>
                ) : pickClosed && shown.find((r) => r.entity.index === pickClosed.key)?.schedule.closed?.[pickClosed.index] ? (() => {
                    // A selected closed block: its times and a way to remove it (the bands are not
                    // restored into the freed hours — double-click the gap to add one).
                    const r = shown.find((x) => x.entity.index === pickClosed.key)!;
                    const c = r.schedule.closed![pickClosed.index];
                    return (
                        <div className={styles.bulk}>
                            <div className={styles.row}>
                                <div className={styles.swatch} style={{ backgroundColor: cssColor(r.color) }} />
                                <span className={styles.sectionTitle}><LocalizedEntityName value={r.name} /></span>
                                <span className={styles.inlineHint}>{`Closed ${clockOf(c.start)}–${clockOf(c.end)}`}</span>
                                <span className={styles.spacer} />
                                <FlatButton onClick={() => { setClosedFor(r, (r.schedule.closed ?? []).filter((_, k) => k !== pickClosed.index)); setPickClosed(null); }}>Remove closed block</FlatButton>
                                <FlatButton onClick={() => setPickClosed(null)}>Done</FlatButton>
                            </div>
                        </div>
                    );
                })() : (
                    <div className={styles.bulk}>
                        <span className={styles.sectionTitle}>Double-click empty track to add a band, inside a band to split it · red closed blocks drag like bands · click a band to edit it · drag its grips or body · drag a band or closed block up or down onto another line to move it there (hold Ctrl to copy) · drag empty track or the scrollbar to pan, wheel over the hours to zoom, Shift + wheel to pan</span>
                    </div>
                )}
            </PanelSection>
        </div>
    );
};
