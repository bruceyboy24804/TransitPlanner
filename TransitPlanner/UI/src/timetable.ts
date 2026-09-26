import { Band, BandMode, LegStat, Schedule, TICKS_PER_DAY, TimetableFlags } from "./types";

// The timetable's departure generator, the same algorithm as Domain/TimetableMath.cs (keep the
// two in step): frames of the day in, frames of the day out.

const DAY = TICKS_PER_DAY;
const fwd = (a: number, b: number) => (((b - a) % DAY) + DAY) % DAY;
const contains = (b: Band, f: number) => (b.start <= b.end ? f >= b.start && f < b.end : f >= b.start || f < b.end);

/** Frames from frame-of-day `f` until the line is in service again (0 when it is): past every closed period it is in (Domain/ClosedHours.UntilOpen). */
const untilOpen = (s: Schedule, f: number) => {
    const closed = s.closed ?? [];
    let waited = 0;
    for (let guard = 0; guard <= closed.length; guard++) {
        const c = closed.find((x) => f >= x.start && f < x.end);
        if (!c) return waited;
        waited += c.end - f;
        f = c.end % DAY;
    }
    return waited;
};

/** Frames from `t` to the first departure at or after it, or Infinity when there is none. Departures outside service hours are skipped. */
export const waitFrom = (s: Schedule, t: number): number => {
    t = ((t % DAY) + DAY) % DAY;
    let total = 0;
    for (let tries = 0; tries < 8; tries++) {
        const w = waitRaw(s, (t + total) % DAY);
        if (!isFinite(w)) return w;
        const at = (t + total + w) % DAY;
        const until = untilOpen(s, at);
        if (until === 0) return total + w;
        total += w + until;
        if (total >= 2 * DAY) break;
    }
    return Infinity;
};

const waitRaw = (s: Schedule, t: number): number => {
    t = ((t % DAY) + DAY) % DAY;
    if (s.timetableFlags & TimetableFlags.List) {
        if (s.timetableDepartures.length === 0) return Infinity;
        return Math.min(...s.timetableDepartures.map((d) => fwd(t, d % DAY)));
    }
    const follow = s.enabled && !!s.bands && (s.timetableFlags & TimetableFlags.FollowBands) !== 0 && s.bands.length > 0;
    let waited = 0;
    let d0 = t;
    for (let step = 0; step < 64 && waited < 2 * DAY; step++) {
        const b = follow ? s.bands.find((x) => contains(x, d0)) : undefined;
        if (b && (b.mode === BandMode.Headway || b.mode === BandMode.Off)) {
            const len = fwd(b.start, b.end) || DAY;
            const since = fwd(b.start, d0);
            const left = len - since;
            if (b.mode === BandMode.Headway && b.headway > 0) {
                const iv = Math.max(60, Math.floor(b.headway * 60));
                const off = (iv - (since % iv)) % iv;
                if (off < left) return waited + off;
            }
            waited += left;
            d0 = (d0 + left) % DAY;
            continue;
        }
        let until = DAY - d0;
        if (follow) {
            for (const x of s.bands) {
                if (x.mode !== BandMode.Headway && x.mode !== BandMode.Off) continue;
                const w = fwd(d0, x.start);
                if (w > 0 && w < until) until = w;
            }
        }
        const interval = Math.max(60, s.timetableInterval);
        const first = s.timetableFirst % DAY;
        let offset: number;
        if (d0 < first) offset = first - d0;
        else {
            const r = (d0 - first) % interval;
            offset = r === 0 ? 0 : interval - r;
        }
        if (offset < until) return waited + offset;
        waited += until;
        d0 = (d0 + until) % DAY;
    }
    return Infinity;
};

/** Every departure of the day from the anchor, frames of the day, in order (capped). */
export const departuresOfDay = (s: Schedule, cap = 600): number[] => {
    const out: number[] = [];
    let t = 0;
    while (out.length < cap) {
        const w = waitFrom(s, t);
        if (!isFinite(w) || t + w >= DAY) break;
        out.push(t + w);
        t = t + w + 1;
    }
    return out;
};

/**
 * Scheduled time from the anchor to each waypoint, in frames: the legs' measured duration
 * (planned when unmeasured), simulation seconds × 60, plus `slack` of it as recovery margin.
 * Legs are indexed by segment, and segment i runs from waypoint i to waypoint i + 1.
 */
export const offsetsFromAnchor = (legs: LegStat[], anchor: number, slack: number): number[] => {
    const n = legs.length;
    const out = new Array<number>(n).fill(0);
    let acc = 0;
    for (let k = 1; k < n; k++) {
        const leg = legs[(anchor + k - 1) % n];
        acc += (leg.achieved > 0 ? leg.achieved : leg.planned) * 60;
        out[(anchor + k) % n] = Math.round(acc * (1 + slack));
    }
    return out;
};
