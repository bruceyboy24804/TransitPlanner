import { useEffect, useState } from "react";
import { useValue } from "cs2/api";
import { Tooltip } from "cs2/ui";
import classNames from "classnames";
import { lineMap$, timeOfDay$ } from "../bindings";
import { useChartStyle } from "./chart-style";
import type { Entity } from "cs2/bindings";
import { formatTimeOfDay, sameEntity, TICKS_PER_DAY } from "../types";
import { vanilla } from "../vanilla";
import { hsl } from "../colour";
import { FlatButton } from "./flat-button";
import styles from "./planner.module.scss";

// A Marey chart (time–distance diagram, Ibry/Marey 1878): stations down the side in loop order,
// time across, one line per vehicle. Steep = moving, flat = standing — so holds at a terminal,
// vehicles queued behind a held one and bunching all read at a glance.
// No simulation history is kept for it: the UI records the `lineMap` binding's vehicle positions
// (0..1 along the loop, every few frames) while the page is open. Session-only, per line.

/** One sample: monotonic frame, position 0..1, load share, boarding. */
type Sample = [number, number, number, boolean];

interface History {
    /** Last frame of day seen and the days added so far, to make a clock that does not wrap. */
    lastTod: number;
    dayOffset: number;
    vehicles: Map<number, Sample[]>;
}

const HOUR = TICKS_PER_DAY / 24;
const KEEP = 6 * HOUR;
const histories = new Map<string, History>();
const keyOf = (e: Entity) => `${e.index}:${e.version}`;

/** Records the selected line's vehicles on every lineMap update; returns the history and "now". */
export const useMareyHistory = (line: Entity) => {
    const map = useValue(lineMap$.binding);
    const tod = useValue(timeOfDay$.binding);
    const [, bump] = useState(0);
    useEffect(() => {
        if (!map.valid || !sameEntity(map.entity, line)) return;
        let h = histories.get(keyOf(line));
        if (!h) { h = { lastTod: tod, dayOffset: 0, vehicles: new Map() }; histories.set(keyOf(line), h); }
        if (tod < h.lastTod - TICKS_PER_DAY / 2) h.dayOffset += TICKS_PER_DAY;
        h.lastTod = tod;
        const now = h.dayOffset + tod;
        for (const v of map.vehicles) {
            if (v.returning) continue;
            let list = h.vehicles.get(v.entity.index);
            if (!list) { list = []; h.vehicles.set(v.entity.index, list); }
            const last = list[list.length - 1];
            if (last && last[0] === now) continue;
            list.push([now, v.at, v.capacity > 0 ? v.riders / v.capacity : 0, v.boarding]);
        }
        for (const [k, list] of h.vehicles) {
            let cut = 0;
            while (cut < list.length && list[cut][0] < now - KEEP) cut++;
            if (cut) list.splice(0, cut);
            if (list.length === 0) h.vehicles.delete(k);
        }
        bump((x) => x + 1);
    }, [map]);
    const h = histories.get(keyOf(line));
    return { map, history: h, now: h ? h.dayOffset + h.lastTod : tod };
};

const WINDOWS = [1, 2, 4, 6];

/** Load share → colour: dim grey-blue when empty, saturated blue when full. */
const loadColour = (load: number) => hsl(210, 0.15 + 0.7 * Math.min(1, load), 0.45 + 0.15 * Math.min(1, load));

export const MareyChart = ({ line }: { line: Entity }) => {
    const { map, history, now } = useMareyHistory(line);
    const [hours, setHours] = useState(2);
    const nameOf = vanilla.useNameFormat();
    const { axis, base } = useChartStyle();
    const span = hours * HOUR;
    const t0 = now - span;
    const ready = map.valid && sameEntity(map.entity, line);

    // One dataset per vehicle run, broken where it wraps past the end of the loop or a gap in
    // the recording (a NaN point ends a Chart.js line).
    const datasets: any[] = [];
    if (history) {
        for (const [id, list] of history.vehicles) {
            let pts: { x: number; y: number }[] = [], load = 0, count = 0, prev: Sample | null = null;
            for (const s of list) {
                if (s[0] < t0) { prev = s; continue; }
                // A gap is a point with y NaN: a bare null crashes Chart.js with parsing off.
                if (prev && (s[1] < prev[1] - 0.3 || s[0] - prev[0] > HOUR / 4)) pts.push({ x: (prev[0] + s[0]) / 2, y: NaN });
                pts.push({ x: s[0], y: s[1] });
                load += s[2]; count++;
                prev = s;
            }
            if (count > 1) datasets.push({ type: "line", label: `v${id}`, data: pts, borderColor: loadColour(load / count), spanGaps: false, parsing: false });
        }
    }
    const stops = ready ? map.stops : [];
    const nearestStop = (v: number) => {
        let best = -1, d = 0.02;
        stops.forEach((s, i) => { const e = Math.abs(s.at - v); if (e < d) { d = e; best = i; } });
        return best;
    };
    const step = hours <= 2 ? HOUR / 2 : HOUR;
    const options = {
        ...base,
        scales: {
            x: axis({
                type: "linear", min: t0, max: now,
                ticks: { stepSize: step, maxTicksLimit: 13, callback: (v: number) => formatTimeOfDay(((v % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY) },
            }),
            y: axis({
                type: "linear", min: 0, max: 1, reverse: true,
                // One tick per station, at its place along the loop.
                afterBuildTicks: (scale: any) => { scale.ticks = stops.map((s) => ({ value: s.at })); },
                ticks: {
                    autoSkip: false,
                    callback: (v: number) => { const i = nearestStop(v); return i < 0 ? "" : clip(nameOf(stops[i].name), 18); },
                },
            }),
        },
    };

    return (
        <>
            <div className={styles.row}>
                {WINDOWS.map((w) => <FlatButton key={w} selected={hours === w} onClick={() => setHours(w)}>{`${w} h`}</FlatButton>)}
            </div>
            {ready && <vanilla.ResponsiveChart type="line" data={{ datasets }} options={options} className={classNames(styles.chart, styles.chartTall)} />}
            <div className={styles.flowLegend}>
                <vanilla.ColorLegend color={loadColour(0)} label="empty" className={styles.flowKey} />
                <vanilla.ColorLegend color={loadColour(0.5)} label="half full" className={styles.flowKey} />
                <vanilla.ColorLegend color={loadColour(1)} label="full" className={styles.flowKey} />
            </div>
            <Tooltip tooltip="Recorded while this page is open, so it starts empty and fills in as the game runs.">
                <div className={styles.hint}>Each line is a vehicle: steep = moving, flat = standing at a station. Stacked flat lines at one station are vehicles queued behind a held one.</div>
            </Tooltip>
        </>
    );
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}\u2026` : s);
