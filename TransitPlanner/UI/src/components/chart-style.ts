import { useRem } from "cs2/utils";
import { vanilla } from "../vanilla";

// The statistics panel's chart style (statistics-graph.tsx), for charts drawn through the game's
// ResponsiveChart: 1 px grid/border in chartLineColor, ticks in chartFontColor at 10 × UI scale
// with 10 px padding, 3 px straight lines, no point markers. Chart.js tooltips, legends and mouse
// events are switched off game-wide, so hover text lives in HTML around the canvas.

export const useChartStyle = () => {
    const rem = useRem();
    const { line, font } = vanilla.chartColors;
    const axis = (extra: any = {}) => ({
        grid: { color: line, lineWidth: 1 },
        border: { color: line, width: 1 },
        ...extra,
        ticks: { font: { size: 10 * rem }, color: font, padding: 10, ...(extra.ticks ?? {}) },
    });
    return {
        axis,
        base: {
            layout: { padding: { top: 4, right: 12, bottom: 0, left: 4 } },
            elements: { line: { borderWidth: 3, tension: 0, fill: false }, point: { radius: 0 } },
        },
    };
};
