import { ModRegistrar } from "cs2/modding";
import { initialize } from "vanilla/Components";
import { PlannerButton } from "./components/planner-button";
import { PlannerPanel } from "./components/planner-panel";
import { EncyclopediaPanel } from "./components/encyclopedia";
import { InfomodeItemExtend } from "./components/infomode-item";
import { extraModules, extraThemes } from "./vanilla";

const register: ModRegistrar = (moduleRegistry) => {
    // Resolves the shared set of vanilla components into VC/VT/VF plus this mod's extras
    // (Slider, IntInput and the slider theme; see vanilla.ts).
    initialize(moduleRegistry, extraModules, extraThemes);

    // The toggle sits with the game's own top-left buttons; the window itself portals out of
    // that container so it can float and drag anywhere.
    moduleRegistry.append("GameTopLeft", PlannerButton);
    moduleRegistry.append("GameTopLeft", PlannerPanel);
    moduleRegistry.append("GameTopLeft", EncyclopediaPanel);

    // The infoview panel's legend rows: ours get a row with live figures, vanilla's pass through
    // untouched (rcav8tr's InfomodeItem extension recipe, CS2Mod-VehicleUse).
    moduleRegistry.extend(
        "game-ui/game/components/infoviews/active-infoview-panel/components/infomode-item/infomode-item.tsx",
        "InfomodeItem",
        InfomodeItemExtend,
    );

    // Registration is otherwise silent, and a silent no-op is indistinguishable from a bundle that
    // never loaded.
    console.log("TransitPlanner UI module registered.");
};

export default register;
