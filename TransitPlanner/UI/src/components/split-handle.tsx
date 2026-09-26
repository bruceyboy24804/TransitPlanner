import { useCallback, useRef, useState } from "react";
import styles from "./planner.module.scss";

// A draggable divider between a table and the section under it (the Timetable and Depots tabs):
// drag it up or down to give the lower section more or less of the height. The height is the
// lower section's, in pixels, kept per key for the session so switching tabs does not reset it.

const remembered = new Map<string, number>();

/** The lower section's height and the handle that resizes it. */
export const useSplit = (key: string, initial: number, min = 80, max = 2000) => {
    const [height, setHeight] = useState(() => remembered.get(key) ?? initial);
    const set = useCallback((h: number) => {
        const v = Math.max(min, Math.min(max, h));
        remembered.set(key, v);
        setHeight(v);
    }, [key, min, max]);
    return [height, set] as const;
};

/**
 * The divider: press and drag. Document-level move/up listeners (like the timeline's scrollbar),
 * so the drag keeps going when the pointer leaves the thin bar.
 */
export const SplitHandle = ({ height, onHeight }: { height: number; onHeight: (h: number) => void }) => {
    const start = useRef<{ y: number; h: number; max: number } | null>(null);
    const self = useRef<HTMLDivElement | null>(null);
    const [active, setActive] = useState(false);
    const onMouseDown = (e: React.MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // The cap is measured, not CSS: a max-height % resolved against a box smaller than the
        // panel here and pinned the section. Leave the table above at least 120 px.
        const container = self.current?.parentElement?.getBoundingClientRect().height ?? 2000;
        start.current = { y: e.clientY, h: height, max: Math.max(80, container - 120) };
        setActive(true);
        // Dragging up grows the lower section.
        const move = (ev: MouseEvent) => {
            const st = start.current;
            if (st) onHeight(Math.min(st.max, st.h - (ev.clientY - st.y)));
        };
        const up = () => {
            start.current = null;
            setActive(false);
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    };
    return (
        <div ref={self} className={styles.splitHandle} onMouseDown={onMouseDown}>
            <div className={active ? styles.splitGripActive : styles.splitGrip} />
        </div>
    );
};
