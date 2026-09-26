// Colours for inline styles and SVG attributes. Gameface (Cohtml 2.2) does not parse hsl():
// measured live, `background-color: hsl(120, 80%, 55%)` computes to rgba(0, 0, 0, 0), so an hsl
// colour silently draws nothing. Build hues here and hand the engine rgb().

/** hsl → "rgb(r, g, b)"; h in degrees, s and l in 0..1. */
export const hsl = (h: number, s: number, l: number) => {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    const m = l - c / 2;
    const to = (v: number) => Math.round((v + m) * 255);
    return `rgb(${to(r)}, ${to(g)}, ${to(b)})`;
};
