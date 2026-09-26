import { useMemo } from "react";
import { useValue } from "cs2/api";
import { presets$, setPresets } from "./bindings";
import { Band, BandMode, minutesToSeconds, TICKS_PER_DAY } from "./types";

// Schedule presets: the built-in ones below, plus the player's own, kept as JSON in the mod's
// settings (Setting.PresetsJson) so the same presets are there in every city. Presets carry
// bands only; per-band vehicle models are city-specific and are not saved in them.

export type PresetBand = Omit<Band, "primary" | "secondary">;
export interface Preset {
    name: string;
    bands: PresetBand[];
    /** The player's own (can be overwritten and deleted); built-ins cannot. */
    custom?: boolean;
    /** A freight preset: offered for cargo lines, not passenger ones. Custom presets suit both. */
    cargo?: boolean;
}
interface PresetFile {
    version: number;
    presets: Preset[];
}

const h = (hours: number) => (hours / 24) * TICKS_PER_DAY;
// Headways in the presets are clock minutes, stored as simulation seconds.
const m = minutesToSeconds;

/** Applied presets replace the whole day. Night is split at midnight; see timeline.tsx. */
export const builtinPresets: Preset[] = [
    {
        name: "Peak 5 / Off-peak 12 / Night 30",
        bands: [
            { start: h(0), end: h(6), mode: BandMode.Headway, headway: m(30), fleet: 0, fare: -1 },
            { start: h(6), end: h(9), mode: BandMode.Headway, headway: m(5), fleet: 0, fare: -1 },
            { start: h(9), end: h(16), mode: BandMode.Headway, headway: m(12), fleet: 0, fare: -1 },
            { start: h(16), end: h(19), mode: BandMode.Headway, headway: m(5), fleet: 0, fare: -1 },
            { start: h(19), end: h(22), mode: BandMode.Headway, headway: m(12), fleet: 0, fare: -1 },
            { start: h(22), end: h(24), mode: BandMode.Headway, headway: m(30), fleet: 0, fare: -1 },
        ],
    },
    {
        name: "Peak 3 / Off-peak 8 / Night 20",
        bands: [
            { start: h(0), end: h(6), mode: BandMode.Headway, headway: m(20), fleet: 0, fare: -1 },
            { start: h(6), end: h(9), mode: BandMode.Headway, headway: m(3), fleet: 0, fare: -1 },
            { start: h(9), end: h(16), mode: BandMode.Headway, headway: m(8), fleet: 0, fare: -1 },
            { start: h(16), end: h(19), mode: BandMode.Headway, headway: m(3), fleet: 0, fare: -1 },
            { start: h(19), end: h(22), mode: BandMode.Headway, headway: m(8), fleet: 0, fare: -1 },
            { start: h(22), end: h(24), mode: BandMode.Headway, headway: m(20), fleet: 0, fare: -1 },
        ],
    },
    // Freight: keep trains, ships and planes off the commuter peaks and run them hard overnight,
    // when the network and the roads around the terminals are quiet.
    {
        name: "Freight: avoid peaks",
        cargo: true,
        bands: [
            { start: h(0), end: h(6), mode: BandMode.Headway, headway: m(10), fleet: 0, fare: -1 },
            { start: h(6), end: h(9), mode: BandMode.Headway, headway: m(40), fleet: 0, fare: -1 },
            { start: h(9), end: h(16), mode: BandMode.Headway, headway: m(15), fleet: 0, fare: -1 },
            { start: h(16), end: h(19), mode: BandMode.Headway, headway: m(40), fleet: 0, fare: -1 },
            { start: h(19), end: h(24), mode: BandMode.Headway, headway: m(10), fleet: 0, fare: -1 },
        ],
    },
    {
        name: "Freight: night heavy",
        cargo: true,
        bands: [
            { start: h(0), end: h(6), mode: BandMode.Headway, headway: m(8), fleet: 0, fare: -1 },
            { start: h(6), end: h(22), mode: BandMode.Headway, headway: m(30), fleet: 0, fare: -1 },
            { start: h(22), end: h(24), mode: BandMode.Headway, headway: m(8), fleet: 0, fare: -1 },
        ],
    },
    {
        name: "Freight: follow the load",
        cargo: true,
        bands: [
            { start: h(0), end: h(24), mode: BandMode.TargetLoad, headway: 0, fleet: 0, fare: -1, loadMin: 0.5, loadMax: 0.85 },
        ],
    },
    {
        name: "Freight: steady",
        cargo: true,
        bands: [
            { start: h(0), end: h(24), mode: BandMode.Headway, headway: m(15), fleet: 0, fare: -1 },
        ],
    },
    { name: "Clear", bands: [] },
];

/** Presets that fit a line: freight ones for cargo lines, passenger ones otherwise; custom and Clear always. */
export const presetsFor = (all: Preset[], cargo: boolean) =>
    all.filter((p) => p.custom || p.bands.length === 0 || !!p.cargo === cargo);

const parse = (json: string): Preset[] => {
    try {
        const v = json ? (JSON.parse(json) as PresetFile) : null;
        return v && Array.isArray(v.presets) ? v.presets.filter((p) => p && typeof p.name === "string" && Array.isArray(p.bands)).map((p) => ({ ...p, custom: true })) : [];
    } catch {
        return [];
    }
};

const write = (custom: Preset[]) =>
    setPresets(JSON.stringify({ version: 1, presets: custom.map(({ name, bands }) => ({ name, bands })) } as PresetFile));

/** A band as a preset stores it: the models dropped. */
// MatchLine's `line` is an entity of this save, so presets (and rules) never carry it.
export const toPresetBand = ({ start, end, mode, headway, fleet, fare, loadMin, loadMax, value }: PresetBand): PresetBand => ({ start, end, mode, headway, fleet, fare, loadMin, loadMax, value });

/** Built-ins first, then the player's own; plus save (overwrites a custom preset of the same name) and remove. */
export const usePresets = () => {
    const json = useValue(presets$.binding);
    const custom = useMemo(() => parse(json), [json]);
    const all = useMemo(() => [...builtinPresets, ...custom], [custom]);
    const save = (name: string, bands: PresetBand[]) => {
        const n = name.trim();
        if (!n || builtinPresets.some((p) => p.name === n)) return false;
        write([...custom.filter((p) => p.name !== n), { name: n, bands: bands.map(toPresetBand), custom: true }]);
        return true;
    };
    const remove = (name: string) => write(custom.filter((p) => p.name !== name));
    return { all, custom, save, remove };
};

export const samePresetBands = (a: PresetBand[], b: PresetBand[]) =>
    a.length === b.length && a.every((x, i) => x.start === b[i].start && x.end === b[i].end && x.mode === b[i].mode && x.headway === b[i].headway && x.fleet === b[i].fleet && x.fare === b[i].fare);
