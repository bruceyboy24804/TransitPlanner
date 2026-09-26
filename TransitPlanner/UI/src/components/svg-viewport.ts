import { MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shallowEqual, useRem } from "cs2/utils";
import { SVGBounds, SVGContextValue, SVGPoint, SVGViewport, vanilla } from "../vanilla";

// Our own viewport for the game's SVG kit, built the way Traffic builds its phase-editor viewport
// (Traffic.mjs, the `$t` component): the element's rect from the game's useElementRect, the UI
// scale from useRem, paddings through the kit's parsePadding, and the same conversion functions
// the kit's own useSVGSetup produces — so GridLines and everything else that reads the SVG
// context works unchanged. Zoom and pan are Traffic's too (its `At` / `Dt` hooks, grepped from
// Traffic.mjs): the wheel scales the bounds about their centre by 0.25 a notch (x10 with shift,
// ctrl skips the x axis), clamped to a zoom range; the middle mouse button pans, in px, clamped
// to the drawn area; the pan offset is turned into data units through the current scale.
//
// Why not the kit's useSVGSetup: it is what Traffic deliberately avoided, and mirroring Traffic
// keeps the timeline on the one composition known to work in Gameface.

export interface ViewportOptions {
    bounds: SVGBounds;
    /** rem; a number, {x,y} or {top,right,bottom,left}. */
    padding?: number | SVGPoint | { top: number; right: number; bottom: number; left: number };
    /** y grows upward when true. Off for the timeline: y = 0 is the top like the rest of the UI. */
    inverted?: boolean;
    /** Which axes the wheel zooms; Traffic's phase editor uses "x". */
    zoomable?: "x" | "y" | boolean;
    /** Which axes the middle mouse pans; Traffic's phase editor uses true. */
    panable?: "x" | "y" | boolean;
    /** Zoom factor range; Traffic's phase editor uses { min: 0.5, max: 3 }. */
    zoomRange?: { min: number; max: number };
}

const ZOOM_ONE = { x: 1, y: 1 };
const PAN_NONE = { x: 0, y: 0 };
const clamp = (v: number, lo: number, hi: number) => (v <= lo ? lo : v >= hi ? hi : v);

/** Traffic's `At`: wheel zoom, applied by scaling the bounds about their centre. */
const useZoomBounds = (ref: MutableRefObject<SVGSVGElement | null>, bounds: SVGBounds, axis: ViewportOptions["zoomable"], range: { min: number; max: number }) => {
    const [zoom, setZoom] = useState(ZOOM_ONE);
    const last = useRef(bounds);

    // Zoom is GEOMETRIC, and clamped into the range rather than gated by it. Both matter:
    //  - additive steps do not retrace themselves once either end clamps. The old code stepped by
    //    0.25, so 1 -> .75 -> .5 -> .25 -> .1 (clamped) zoomed in to 1000%, and coming back out
    //    gave .35, .6, .85 — 118% — where the next step (1.1) was outside the range and was
    //    rejected outright, stranding the view at 118% with no way home.
    //  - rejecting a step that leaves the range means the range's own end is unreachable; clamping
    //    to it means a few notches out always land exactly on it (100%).
    const step = useCallback((dx: number, dy: number, ctrl: boolean, shift: boolean) => {
        setZoom((z) => {
            if (ctrl) return z;
            const dir = Math.sign(axis === "y" ? dy : dx || dy);
            if (dir === 0) return z;
            const factor = Math.pow(shift ? 2 : 1.25, dir);
            const x = axis !== "y" ? clamp(z.x * factor, range.min, range.max) : z.x;
            const y = axis !== "x" ? clamp(z.y * factor, range.min, range.max) : z.y;
            return x === z.x && y === z.y ? z : { x, y };
        });
    }, [axis, range]);

    useEffect(() => {
        if (!axis) return;
        const el = ref.current;
        // The wheel is ours here: stop it before the column's Scrollable above sees it, or a zoom
        // also scrolls the panel column.
        const onWheel = (e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); step(e.deltaX, e.deltaY, e.ctrlKey, e.shiftKey); };
        el?.addEventListener("wheel", onWheel, { capture: true });
        return () => el?.removeEventListener("wheel", onWheel, { capture: true });
    }, [ref, axis, step]);

    const reset = useCallback(() => setZoom(ZOOM_ONE), []);
    const zoomed = useMemo(() => {
        const hx = ((bounds.max.x - bounds.min.x) / 2) * zoom.x;
        const cx = (bounds.max.x + bounds.min.x) / 2;
        const hy = ((bounds.max.y - bounds.min.y) / 2) * zoom.y;
        const cy = (bounds.max.y + bounds.min.y) / 2;
        let next: SVGBounds = { min: { x: cx - hx, y: cy - hy }, max: { x: cx + hx, y: cy + hy } };
        if (shallowEqual(last.current, next, 2)) next = last.current; else last.current = next;
        return next;
    }, [bounds, zoom]);
    return [zoomed, reset, zoom] as const;
};

/** Traffic's `Dt`: middle-mouse pan in px, clamped to the drawn width/height. */
const usePan = (ref: MutableRefObject<SVGSVGElement | null>, width: number, height: number, axis: ViewportOptions["panable"]) => {
    const [pan, setPan] = useState(PAN_NONE);
    const reset = useCallback(() => setPan(PAN_NONE), []);
    useEffect(() => {
        const el = ref.current;
        if (!el || !axis) return;
        let origin: SVGPoint | null = null;
        let grab = PAN_NONE;
        const move = (e: MouseEvent) => {
            const speed = e.shiftKey ? 2 : e.ctrlKey ? 0.5 : 1;
            setPan((p) => {
                origin = origin || p;
                return {
                    x: axis === "y" ? 0 : clamp(origin.x + (grab.x - e.x) * speed, -width, 2 * width),
                    y: axis === "x" ? 0 : clamp(origin.y + (grab.y - e.y) * speed, 0, Math.max(0, height)),
                };
            });
        };
        const down = (e: MouseEvent) => {
            if (e.button !== 1) return;
            grab = { x: e.x, y: e.y };
            const up = () => { origin = null; window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
        };
        el.addEventListener("mousedown", down);
        return () => el.removeEventListener("mousedown", down);
    }, [ref, axis, width, height]);
    return [axis ? pan : PAN_NONE, reset, setPan] as const;
};

/** Lets a conversion be called as f(x, y) or f({x, y}), like the kit's createPointConversion. */
const both = (f: (p: SVGPoint) => SVGPoint) =>
    ((a: number | SVGPoint, b?: number) => (typeof a === "number" ? f({ x: a, y: b as number }) : f(a))) as SVGViewport["posFromPoint"];

export const useTimelineViewport = (
    ref: MutableRefObject<SVGSVGElement | null>,
    { bounds: baseBounds, padding = 0, inverted = false, zoomable, panable, zoomRange = { min: 0.5, max: 3 } }: ViewportOptions,
) => {
    const [viewport, setViewport] = useState<SVGViewport | undefined>();
    const rect = vanilla.useElementRect(ref);
    const remScale = useRem();
    const [zoomed, resetZoom, zoom] = useZoomBounds(ref, baseBounds, zoomable, zoomRange);
    const [pan, resetPan, setPan] = usePan(ref, rect?.width ?? 0, rect?.height ?? 0, panable);
    const resetViewport = useCallback(() => { resetZoom(); resetPan(); }, [resetZoom, resetPan]);

    useEffect(() => {
        if (!rect || !rect.width || !rect.height) return;
        const rem = (v: number) => v * remScale;
        const { width, height } = rect;
        const pad = vanilla.parsePadding(padding, rem, width, height);
        const sx = (width - (pad.left + pad.right)) / (zoomed.max.x - zoomed.min.x);
        const sy = (height - (pad.top + pad.bottom)) / (zoomed.max.y - zoomed.min.y);
        const offset = { x: rect.x, y: rect.y };

        // The pan is px; shift the bounds by it in data units (Traffic: `f.x / s`), clamped so the
        // zoomed window stays inside the base bounds (Traffic lets it overshoot; a day does not).
        let bounds = zoomed;
        if (pan.x || pan.y) {
            const d = { x: pan.x / sx, y: (pan.y / sy) * (inverted ? -1 : 1) };
            d.x = clamp(d.x, baseBounds.min.x - zoomed.min.x, baseBounds.max.x - zoomed.max.x);
            bounds = { min: { x: zoomed.min.x + d.x, y: zoomed.min.y + d.y }, max: { x: zoomed.max.x + d.x, y: zoomed.max.y + d.y } };
        }

        // Data -> px. With `inverted`, data y grows upward from the bottom padding, as charts want.
        const vx = (x: number) => pad.left + (x - bounds.min.x) * sx;
        const vy = (y: number) => (inverted ? height - pad.bottom - (y - bounds.min.y) * sy : pad.top + (y - bounds.min.y) * sy);
        const px = (x: number) => (x - pad.left) / sx + bounds.min.x;
        const py = (y: number) => (inverted ? (height - pad.bottom - y) / sy + bounds.min.y : (y - pad.top) / sy + bounds.min.y);

        const posFromMouse = (e: MouseEvent) => ({ x: e.clientX - offset.x, y: e.clientY - offset.y });
        const pointFromPos = both((p) => ({ x: px(p.x), y: py(p.y) }));

        setViewport({
            size: { width, height },
            bounds,
            inverted,
            padding: pad,
            rem,
            posFromPoint: both((p) => ({ x: vx(p.x), y: vy(p.y) })),
            pointFromPos,
            posFromMouse,
            pointFromMouse: (e) => pointFromPos(posFromMouse(e)),
            scaleToViewport: both((p) => ({ x: p.x * sx, y: p.y * sy })),
            scaleToPoint: both((p) => ({ x: p.x / sx, y: p.y / sy })),
            resetViewport,
        });
    }, [rect?.x, rect?.y, rect?.width, rect?.height, remScale, zoomed, pan, padding, inverted, resetViewport, baseBounds]);

    /** Scrolls the zoomed window so its left edge sits at `fraction` (0..1) of the scrollable range. */
    const scrollTo = useCallback((fraction: number) => {
        const rectNow = rect;
        if (!rectNow || !rectNow.width) return;
        const pad = vanilla.parsePadding(padding, (v) => v * remScale, rectNow.width, rectNow.height);
        const sx = (rectNow.width - (pad.left + pad.right)) / (zoomed.max.x - zoomed.min.x);
        const range = (baseBounds.max.x - baseBounds.min.x) - (zoomed.max.x - zoomed.min.x);
        const targetMin = baseBounds.min.x + clamp(fraction, 0, 1) * range;
        setPan((p) => ({ x: (targetMin - zoomed.min.x) * sx, y: p.y }));
    }, [rect, padding, remScale, zoomed, baseBounds, setPan]);

    return [viewport, zoom, resetViewport, scrollTo] as const;
};

/** Registers the viewport with the kit's parent context, as Traffic does after building its own. */
export const useRegisterSVGContext = (context: SVGContextValue) => {
    const { registerSVGContext } = vanilla.useSVGParent();
    useMemo(() => {
        // Traffic defers the registration a frame so the provider has rendered.
        requestAnimationFrame(() => registerSVGContext(context));
        return context;
    }, [context, registerSVGContext]);
};
