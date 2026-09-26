import { trigger, useValue } from "cs2/api";
import type { infoviewTypes, Color } from "cs2/bindings";

interface GradientStop { offset: number; color: string | Color }
interface Gradient { stops: GradientStop[] }
import { LocalizedEntityName, useLocalization } from "cs2/l10n";
import { getModule, ModuleRegistryExtend } from "cs2/modding";
import { Tooltip } from "cs2/ui";
import classNames from "classnames";
import { infoviewStats$ } from "../bindings";
import styles from "./infomode-item.module.scss";

// The Transit Planner infoview's legend rows. The game renders every infomode with its own
// InfomodeItem; this extension swaps a row of ours in for the four heatmap infomodes (id prefix
// "TransitPlanner") and returns vanilla's component untouched for everything else — rcav8tr's
// recipe (CS2Mod-VehicleUse, MIT). The row is built from vanilla's own classes (the infomode
// item theme, the transparent button, the checkbox) so it sits in the panel like a native one,
// with the gradient legend and a line of live figures under the title.

const PREFIX = "TransitPlanner";

// Resolved lazily: the registry is only complete once the game UI has loaded.
const classes = {
    get item() { return getModule("game-ui/game/components/infoviews/active-infoview-panel/components/infomode-item/infomode-item.module.scss", "classes") as Record<string, string>; },
    get button() { return getModule("game-ui/game/themes/transparent-button.module.scss", "classes") as Record<string, string>; },
    get checkbox() { return getModule("game-ui/common/input/toggle/checkbox/checkbox.module.scss", "classes") as Record<string, string>; },
    get sound() { return getModule("game-ui/common/data-binding/audio-bindings.ts", "UISound") as Record<string, string>; },
};

const css = (c: Color) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;
const gradientCss = (g: Gradient) => `linear-gradient(to right, ${g.stops.map((s: GradientStop) => `${typeof s.color === "string" ? s.color : css(s.color)} ${Math.round(100 * s.offset)}%`).join(", ")})`;

const icons: Record<string, string> = {
    TransitPlannerCoverage: "Media/Game/Icons/Transportation.svg",
    TransitPlannerFrequency: "Media/Game/Icons/Bus.svg",
    TransitPlannerWaiting: "Media/Game/Icons/Citizen.svg",
    TransitPlannerReach: "Media/Game/Icons/Transportation.svg",
    TransitPlannerWait: "Media/Game/Icons/Citizen.svg",
    TransitPlannerUnserved: "Media/Game/Icons/ZoneResidentialLow.svg",
    TransitPlannerBuildingCoverage: "Media/Game/Icons/Transportation.svg",
    TransitPlannerBuildingReach: "Media/Game/Icons/Transportation.svg",
    TransitPlannerBuildingFrequency: "Media/Game/Icons/Bus.svg",
    TransitPlannerVehicleLoad: "Media/Game/Icons/Bus.svg",
    TransitPlannerVehicleState: "Media/Game/Icons/Bus.svg",
};

// The vehicle-state mode's values as fixed points on its gradient (TP_InfoviewSystem.kState*),
// so the legend can name them instead of showing Low → High.
const STATES: { label: string; value: number }[] = [
    { label: "Running", value: 0 },
    { label: "Boarding", value: 96 / 255 },
    { label: "Held", value: 160 / 255 },
    { label: "Bunched", value: 1 },
];
const sampleGradient = (g: Gradient, t: number): string => {
    const stops = g.stops.map((s) => ({ offset: s.offset, color: typeof s.color === "string" ? null : s.color }));
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i + 1 < stops.length; i++) if (t >= stops[i].offset && t <= stops[i + 1].offset) { a = stops[i]; b = stops[i + 1]; break; }
    if (!a.color || !b.color) return "#888";
    const f = b.offset > a.offset ? (t - a.offset) / (b.offset - a.offset) : 0;
    const mix = (x: number, y: number) => x + (y - x) * f;
    return css({ r: mix(a.color.r, b.color.r), g: mix(a.color.g, b.color.g), b: mix(a.color.b, b.color.b), a: 1 });
};

const Row = ({ infomode }: { infomode: infoviewTypes.Infomode }) => {
    const { translate } = useLocalization();
    const stats = useValue(infoviewStats$.binding);
    const item = classes.item, button = classes.button, checkbox = classes.checkbox;
    const title = translate(`Infoviews.INFOMODE[${infomode.id}]`, infomode.id) ?? infomode.id;
    const tooltip = translate(`Infoviews.INFOMODE_TOOLTIP[${infomode.id}]`, "") ?? "";
    const toggle = () => {
        trigger("audio", "playSound", classes.sound.toggleInfoMode, 1);
        trigger("infoviews", "setInfomodeActive", infomode.entity, !infomode.active, infomode.priority);
    };

    // The figures under each row: what the heatmap is summarising, city-wide.
    let figures: React.ReactNode;
    switch (infomode.id) {
        case "TransitPlannerCoverage": {
            const pct = stats.buildings > 0 ? Math.round((100 * stats.buildingsCovered) / stats.buildings) : 0;
            figures = <span>{`${stats.stops} stops · ${stats.lines} lines · ${pct}% of buildings within 400 m`}</span>;
            break;
        }
        case "TransitPlannerFrequency":
            figures = <span>{`${stats.avgFrequency.toFixed(1)} departures/h per stop on average · best ${stats.bestFrequency.toFixed(0)}/h`}</span>;
            break;
        case "TransitPlannerWaiting":
            figures = (
                <span>
                    {`${stats.waiting} waiting · worst ${stats.worstWaiting} at `}
                    {stats.worstStopName ? <LocalizedEntityName value={stats.worstStopName} /> : "—"}
                </span>
            );
            break;
        case "TransitPlannerWait":
            figures = <span>{`${stats.stops} stops · long waits show red`}</span>;
            break;
        case "TransitPlannerUnserved": {
            const pct = stats.buildings > 0 ? Math.round((100 * (stats.buildings - stats.buildingsCovered)) / stats.buildings) : 0;
            figures = <span>{`${stats.buildings - stats.buildingsCovered} buildings (${pct}%) beyond 400 m of any stop`}</span>;
            break;
        }
        case "TransitPlannerBuildingCoverage":
        case "TransitPlannerBuildingFrequency":
            figures = <span>{`${stats.buildings} buildings coloured · ${stats.stops} stops`}</span>;
            break;
        case "TransitPlannerVehicleLoad":
            figures = <span>{stats.vehicles > 0 ? `${stats.vehicles} vehicles · ${Math.round(stats.avgLoad * 100)}% full on average` : "No transit vehicles out"}</span>;
            break;
        case "TransitPlannerVehicleState":
            figures = <span>{stats.vehicles > 0 ? `${stats.vehicles} vehicles · ${stats.boarding} boarding · ${stats.held} held · ${stats.bunched} bunched` : "No transit vehicles out"}</span>;
            break;
        case "TransitPlannerBuildingReach":
        case "TransitPlannerReach":
            figures = stats.reachMax > 0 && stats.reachOriginName ? (
                <span>
                    {`${stats.reachStops} stops within ${Math.round(stats.reachMax)} min of `}
                    <LocalizedEntityName value={stats.reachOriginName} />
                </span>
            ) : (
                <span>Click a stop in the world to set the origin</span>
            );
            break;
    }

    return (
        <Tooltip direction="right" tooltip={tooltip}>
            <button className={classNames(button.button, item.infomodeItem, infomode.active && item.active, styles.row)} onClick={toggle}>
                <div className={item.header}>
                    <div className={classNames(item.title, item.activeOpacity)}>
                        <img className={styles.icon} src={icons[infomode.id] ?? "Media/Game/Icons/Transportation.svg"} />
                        <div className={item.titleText}>{title}</div>
                    </div>
                    <div className={item.type}>
                        <div className={item.activeOpacity}>{infomode.id.includes("Vehicle") ? "Vehicle color" : infomode.id.includes("Building") ? "Building color" : "Heatmap"}</div>
                        <div className={classNames(checkbox.toggle, item.checkbox, infomode.active ? "checked" : "unchecked")}>
                            <div className={classNames(checkbox.checkmark, infomode.active && "checked")} />
                        </div>
                    </div>
                </div>
                {infomode.gradientLegend && infomode.id === "TransitPlannerVehicleState" ? (
                    <div className={classNames(styles.states, item.activeOpacity)}>
                        {STATES.map((st) => (
                            <div key={st.label} className={styles.state}>
                                <div className={styles.swatch} style={{ backgroundColor: sampleGradient(infomode.gradientLegend!.gradient, st.value) }} />
                                <span>{st.label}</span>
                            </div>
                        ))}
                    </div>
                ) : infomode.gradientLegend && (
                    <div className={classNames(item.legend, item.activeOpacity)}>
                        <div className={item.label}>{translate("Infoviews.LABEL[Low]", "Low")}</div>
                        <div className={item.gradient} style={{ backgroundImage: gradientCss(infomode.gradientLegend.gradient) }} />
                        <div className={item.label}>{translate("Infoviews.LABEL[High]", "High")}</div>
                    </div>
                )}
                <div className={classNames(styles.figures, item.activeOpacity)}>{figures}</div>
            </button>
        </Tooltip>
    );
};

export const InfomodeItemExtend: ModuleRegistryExtend = (Component: React.ComponentType<any>) => (props: { infomode: infoviewTypes.Infomode; focusKey?: unknown }) =>
    props.infomode?.id?.startsWith(PREFIX) ? <Row infomode={props.infomode} /> : <Component {...props} />;
