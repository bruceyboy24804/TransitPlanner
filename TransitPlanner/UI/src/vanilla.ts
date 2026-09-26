import type { FC, ForwardRefExoticComponent, MutableRefObject, PropsWithChildren, RefAttributes } from "react";
import type { Context } from "react";
import { VC, VT } from "vanilla/Components";

// Registry paths for the vanilla widgets this mod uses beyond the shared base. Read out of the
// readable bundle (and confirmed by Traffic.mjs's use of the same ones); a wrong path resolves to
// undefined silently, so keep this the single place they are spelled.

export const extraModules = [
    { path: "game-ui/common/input/slider/slider.tsx", components: ["Slider", "useStepTransformer"] },
    { path: "game-ui/common/input/text/int-input.tsx", components: ["IntInput"] },
    // The editor's slider field: label + slider + number box in one row, which is what the game's
    // own tool panels use (and Network Tools builds its parameter rows from).
    { path: "game-ui/editor/widgets/fields/number-slider-field.tsx", components: ["IntSliderField", "FloatSliderField"] },
    // The game's SVG chart kit, the one its statistics graphs and Traffic's phase editor use.
    { path: "game-ui/common/svg/elements/svg.tsx", components: ["SVGcomponent"] },
    { path: "game-ui/common/svg/svg-context.ts", components: ["SVGContext", "useSVG"] },
    { path: "game-ui/common/svg/use-svg-interaction.tsx", components: ["useSVGInteraction"] },
    // The pieces Traffic builds its own viewport from (see components/svg-viewport.ts).
    { path: "game-ui/common/svg/utils/parse-paddings.ts", components: ["parsePadding"] },
    { path: "game-ui/common/svg/utils/svg-parent-context.tsx", components: ["useSVGParent"] },
    { path: "game-ui/common/hooks/resize-events.tsx", components: ["useElementRect"] },
    { path: "game-ui/common/svg/components/grid-lines.tsx", components: ["GridLines"] },
    // The transportation overview's building blocks, for the fleet tab.
    { path: "game-ui/common/input/button/icon-button.tsx", components: ["IconButton"] },
    { path: "game-ui/game/components/transportation-overview-panel/transport-type-item/transport-type-item.tsx", components: ["TransportTypeItem"] },
    { path: "game-ui/game/components/transportation-overview-panel/lines-utils.ts", components: ["getScheduleIcon"] },
    // The overview panel's header: title bar + tab strip (grepped from transportation-overview-panel.tsx).
    { path: "game-ui/common/panel/panel-title-bar.tsx", components: ["PanelTitleBar"] },
    { path: "game-ui/common/tabs/tabs.tsx", components: ["TabBar", "Tab", "TabNav"] },
    // The overview's two columns are common Sections (its `Ete`), not the tool-options Section
    // the shared base registers under the same export name.
    { path: "game-ui/common/section/section.tsx", components: ["Section"] },
    // The vanilla dropdown pair BTS uses for its vehicle picker.
    { path: "game-ui/common/input/dropdown/dropdown.tsx", components: ["Dropdown"] },
    { path: "game-ui/common/input/dropdown/dropdown-toggle.tsx", components: ["DropdownToggle"] },
    { path: "game-ui/common/input/dropdown/items/dropdown-item.tsx", components: ["DropdownItem"] },
    // The colour swatch + picker the overview row uses for a line's colour.
    { path: "game-ui/common/input/color-picker/color-field/color-field.tsx", components: ["ColorField"] },
    // A tooltip that follows the cursor; Traffic's choice for SVG content, where Tooltip cannot wrap.
    { path: "game-ui/common/tooltip/floating-mouse-tooltip/floating-mouse-tooltip.tsx", components: ["FloatingMouseTooltip"] },
    // The game's text input with the keyboard capture handled (the overview renames lines with it).
    { path: "game-ui/common/input/text/ellipsis-text-input/ellipsis-text-input.tsx", components: ["EllipsisTextInput"] },
    // A Name (custom / localized / formatted) as a plain string; what the overview seeds its rename input with.
    { path: "game-ui/common/localization/localized-entity-name.tsx", components: ["useLocalizedName", "useNameFormat"] },
    // The game's charts: Chart.js behind one canvas wrapper (statistics panel, traffic charts), and
    // the HTML legend / stacked bar the info panels use.
    { path: "game-ui/common/charts/responsive-chart/responsive-chart.tsx", components: ["ResponsiveChart"] },
    { path: "game-ui/common/charts/legends/color-legend.tsx", components: ["ColorLegend", "ColorLegendSymbol"] },
    { path: "game-ui/common/charts/bar-chart/bar-chart.tsx", components: ["BarChart"] },
    // Find It's search box: the game's plain TextInput (keeps its <input> visible, so a native
    // placeholder shows) on the editor-item theme's input class.
    { path: "game-ui/common/input/text/text-input.tsx", components: ["TextInput"] },
];

export const extraThemes = [
    { path: "game-ui/common/input/slider/themes/default.module.scss", name: "slider" },
    // Class maps of the transportation overview: page layout (types / lines / header / cells),
    // the line row (container, button, colorField, toggle/toggleOff, smallerIcon).
    { path: "game-ui/game/components/transportation-overview-panel/transportation-overview-page.module.scss", name: "overviewPage" },
    { path: "game-ui/game/components/transportation-overview-panel/transport-line-item/transport-line-item.module.scss", name: "lineItem" },
    // The panel theme the overview passes to Panel (its `yE`).
    { path: "game-ui/common/panel/themes/iceflake-panel.module.scss", name: "iceflakePanel" },
    // Section theme the overview passes to both columns (its `yte`).
    { path: "game-ui/common/section/themes/panel-section.module.scss", name: "panelSection" },
    // game-dropdown.module.scss, NOT common/input/dropdown/dropdown.module.scss (a different file
    // the shared base registers as "dropdown"): this is the theme the in-game selectors use.
    { path: "game-ui/game/themes/game-dropdown.module.scss", name: "gameDropdown" },
    // The Options screen's dropdown (menu/widgets/dropdown-field): this theme on the Dropdown,
    // the field's `dropdown` class on the toggle, plain DropdownItems drawn by the theme.
    { path: "game-ui/menu/themes/dropdown.module.scss", name: "menuDropdown" },
    { path: "game-ui/menu/widgets/dropdown-field/dropdown-field.module.scss", name: "menuDropdownField" },
    // Find It's sub-category strip: the asset menu's category tab bar holding item-grid buttons.
    { path: "game-ui/game/components/asset-menu/asset-category-tab-bar/asset-category-tab-bar.module.scss", name: "assetCategoryTabBar" },
    { path: "game-ui/game/components/item-grid/item-grid.module.scss", name: "itemGrid" },
    // The overview line row's rename input theme (input / label / container).
    { path: "game-ui/game/components/transportation-overview-panel/transport-line-item/text-input/text-input.module.scss", name: "lineNameInput" },
    // The statistics graph's module: chartLineColor / chartFontColor are exported as values.
    { path: "game-ui/game/components/statistics-panel/graph/statistics-graph.module.scss", name: "statisticsGraph" },
    { path: "game-ui/editor/widgets/item/editor-item.module.scss", name: "editorItem" },
];

export interface VanillaSliderProps {
    start: number;
    end: number;
    value: number;
    gamepadStep?: number;
    disabled?: boolean;
    noFill?: boolean;
    className?: string;
    style?: React.CSSProperties;
    theme?: Record<string, string>;
    valueTransformer?: unknown;
    onChange?: (value: number) => void;
}

/** game-ui/editor/widgets/fields/number-slider-field.tsx */
export interface VanillaSliderFieldProps {
    label: string;
    value: number;
    min: number;
    max: number;
    disabled?: boolean;
    tooltip?: string | null;
    onChange: (value: number) => void;
    onChangeStart?: () => void;
    onChangeEnd?: () => void;
    className?: string;
}

export interface VanillaIntInputProps {
    value: number;
    min?: number;
    max?: number;
    disabled?: boolean;
    className?: string;
    style?: React.CSSProperties;
    onChange?: (value: number) => void;
    onBlur?: () => void;
    onFocus?: () => void;
}

// --- SVG kit -------------------------------------------------------------------------------------
// Shapes read from use-svg-setup.tsx / use-svg-interaction.tsx in the readable bundle.

export interface SVGPoint {
    x: number;
    y: number;
}

export interface SVGBounds {
    min: SVGPoint;
    max: SVGPoint;
}

/** The object useSVGSetup builds once the element has a size; undefined before then. */
export interface SVGViewport {
    size: { width: number; height: number };
    bounds: SVGBounds;
    inverted: boolean;
    padding: { top: number; right: number; bottom: number; left: number };
    /** rem -> px for this view. */
    rem: (value: number) => number;
    /** Data -> viewport px. Both call forms: (x, y) or ({x, y}). */
    posFromPoint: ((x: number, y: number) => SVGPoint) & ((p: SVGPoint) => SVGPoint);
    /** Viewport px -> data. */
    pointFromPos: ((x: number, y: number) => SVGPoint) & ((p: SVGPoint) => SVGPoint);
    posFromMouse: (e: MouseEvent) => SVGPoint;
    pointFromMouse: (e: MouseEvent) => SVGPoint;
    /** Data span -> px span. */
    scaleToViewport: ((x: number, y: number) => SVGPoint) & ((p: SVGPoint) => SVGPoint);
    /** px span -> data span. */
    scaleToPoint: ((x: number, y: number) => SVGPoint) & ((p: SVGPoint) => SVGPoint);
    resetViewport: () => void;
}

export interface SVGSetupOptions {
    bounds: SVGBounds;
    /** rem; a number, {x,y} or {top,right,bottom,left}. */
    padding?: number | SVGPoint | { top: number; right: number; bottom: number; left: number };
    /** y grows upward when true (the default, for charts). */
    inverted?: boolean;
    panable?: "x" | "y" | boolean;
    zoomable?: "x" | "y" | boolean;
}

/** A mouse event as the kit hands it to handlers: the DOM event plus both coordinate spaces. */
export type SVGMouseEvent = React.MouseEvent & { point: SVGPoint; position: SVGPoint; propagationStopped?: boolean };

export interface SVGInteractionHandlers {
    onClick?: (e: SVGMouseEvent) => void;
    onDoubleClick?: (e: SVGMouseEvent) => void;
    onMouseDown?: (e: SVGMouseEvent) => void;
    onMouseUp?: (e: SVGMouseEvent) => void;
    onMouseMove?: (e: SVGMouseEvent) => void;
    onMouseLeave?: (e: SVGMouseEvent) => void;
    onWheel?: (e: SVGMouseEvent) => void;
}

export interface SVGInteraction {
    events: { bindElement: (handlers: object, hitTest?: (pos: SVGPoint, e: SVGMouseEvent) => boolean) => () => void };
    bindings: Record<string, (e: React.MouseEvent) => void>;
    updateViewport: (viewport: SVGViewport | undefined) => void;
}

export interface SVGContextValue {
    viewport?: SVGViewport;
    events?: SVGInteraction["events"];
}

export interface SVGComponentProps {
    interaction: SVGInteraction;
    viewport: SVGViewport | undefined;
    className?: string;
    style?: React.CSSProperties;
}

export interface IconButtonProps {
    src: string;
    tinted?: boolean;
    selected?: boolean;
    disabled?: boolean;
    disableHint?: boolean;
    className?: string;
    theme?: Record<string, string>;
    onSelect?: () => void;
    onClick?: (e: React.MouseEvent) => void;
}

export interface TransportTypeItemProps {
    type: { id: string; icon: string; locked: boolean; requirements: unknown };
    cargo: boolean;
    selected: boolean;
    focusKey?: unknown;
    onSelect: (id: string) => void;
}

export interface TabProps {
    id: string | number;
    selectedId: string | number;
    onSelect: (id: string | number) => void;
    disabled?: boolean;
    locked?: boolean;
    className?: string;
}

export interface GridLinesProps {
    halfSteps?: boolean;
    overdraw?: boolean;
    /** true, or which axes: "x", "y", "xy". */
    drawAxes?: boolean | string;
    /** rem between ticks the "nice" tick count is derived from. */
    tickWidth?: number;
    tickHeight?: number;
    className?: string;
}

// Accessors rather than constants: VC is filled by initialize() at registration time, after this
// module has been evaluated.
export const vanilla = {
    get Slider() {
        return VC.Slider as FC<VanillaSliderProps>;
    },
    get useStepTransformer() {
        return VC.useStepTransformer as (step: number) => unknown;
    },
    get IntSliderField() {
        return VC.IntSliderField as FC<VanillaSliderFieldProps>;
    },
    get FloatSliderField() {
        return VC.FloatSliderField as FC<VanillaSliderFieldProps & { fractionDigits?: number }>;
    },
    get IntInput() {
        return VC.IntInput as FC<VanillaIntInputProps>;
    },
    get sliderTheme() {
        return VT.slider as Record<string, string>;
    },
    get SVGcomponent() {
        return VC.SVGcomponent as ForwardRefExoticComponent<PropsWithChildren<SVGComponentProps> & RefAttributes<SVGSVGElement>>;
    },
    get SVGContext() {
        return VC.SVGContext as Context<SVGContextValue>;
    },
    get useSVG() {
        return VC.useSVG as () => SVGContextValue;
    },
    get parsePadding() {
        return VC.parsePadding as (
            padding: SVGSetupOptions["padding"],
            rem: (v: number) => number,
            width: number,
            height: number,
        ) => { top: number; right: number; bottom: number; left: number };
    },
    get useSVGParent() {
        return VC.useSVGParent as () => { registerSVGContext: (ctx: SVGContextValue) => void };
    },
    /** The element's bounding rect, re-read on resize; undefined until it has one. */
    get useElementRect() {
        return VC.useElementRect as (ref: MutableRefObject<Element | null>) => { x: number; y: number; width: number; height: number } | undefined;
    },
    get useSVGInteraction() {
        return VC.useSVGInteraction as (handlers: SVGInteractionHandlers) => SVGInteraction;
    },
    get GridLines() {
        return VC.GridLines as FC<GridLinesProps>;
    },
    get IconButton() {
        return VC.IconButton as FC<PropsWithChildren<IconButtonProps>>;
    },
    get TransportTypeItem() {
        return VC.TransportTypeItem as FC<TransportTypeItemProps>;
    },
    /** 0 = day, 1 = night, anything else = day and night (Game.UI.InGame.RouteSchedule). */
    get getScheduleIcon() {
        return VC.getScheduleIcon as (schedule: number) => string;
    },
    get PanelTitleBar() {
        return VC.PanelTitleBar as FC<PropsWithChildren<{ className?: string }>>;
    },
    get TabBar() {
        return VC.TabBar as FC<PropsWithChildren<{ className?: string }>>;
    },
    get Tab() {
        return VC.Tab as FC<PropsWithChildren<TabProps>>;
    },
    /** The common Section: a themed box with an optional header (section.tsx, not the tool-options one). */
    get PanelSection() {
        return VC.Section as FC<PropsWithChildren<{ header?: React.ReactNode; className?: string; theme?: Record<string, string>; focusKey?: unknown }>>;
    },
    get panelSection() {
        return VT.panelSection as Record<string, string>;
    },
    get Dropdown() {
        return VC.Dropdown as FC<PropsWithChildren<{ theme?: Record<string, string>; content: React.ReactNode; alignment?: "left" | "right"; focusKey?: unknown; initialFocused?: unknown; onToggle?: (open: boolean) => void }>>;
    },
    /** Read from dropdown-item.tsx: onSelect calls onChange(value) (or onToggleSelected when selected) and hides the menu unless closeOnSelect is false. */
    get DropdownItem() {
        return VC.DropdownItem as FC<PropsWithChildren<{ value: unknown; focusKey?: unknown; selected?: boolean; disabled?: boolean; closeOnSelect?: boolean; theme?: Record<string, string>; className?: string; onChange?: (value: any) => void; onToggleSelected?: (value: any) => void }>>;
    },
    get DropdownToggle() {
        return VC.DropdownToggle as FC<PropsWithChildren<{ showHint?: boolean; theme?: Record<string, string>; className?: string }>>;
    },
    get menuDropdown() {
        return VT.menuDropdown as Record<string, string>;
    },
    get menuDropdownField() {
        return VT.menuDropdownField as Record<string, string>;
    },
    get gameDropdown() {
        return VT.gameDropdown as Record<string, string>;
    },
    get Checkbox() {
        return VC.Checkbox as FC<{ checked: boolean; disabled?: boolean; onChange?: () => void; className?: string }>;
    },
    get assetCategoryTabBar() {
        return VT.assetCategoryTabBar as Record<string, string>;
    },
    get itemGrid() {
        return VT.itemGrid as Record<string, string>;
    },
    get useLocalizedName() {
        return VC.useLocalizedName as (name: unknown) => string;
    },
    /** The hook behind useLocalizedName: returns a stable (name) => string, for formatting many names in one render. */
    get useNameFormat() {
        return VC.useNameFormat as () => (name: unknown) => string;
    },
    get lineNameInput() {
        return VT.lineNameInput as Record<string, string>;
    },
    /** Props read from ellipsis-text-input.tsx: a TextInput (value/onChange/onBlur/maxLength…) with an ellipsis label over it. */
    get EllipsisTextInput() {
        return VC.EllipsisTextInput as FC<{
            value: string;
            maxLength?: number;
            theme?: Record<string, string>;
            className?: string;
            disableHint?: boolean;
            onChange?: (e: { target: { value: string } }) => void;
            onBlur?: () => void;
            onFocus?: () => void;
            onClick?: (e: React.MouseEvent) => void;
            onKeyDown?: (e: React.KeyboardEvent) => void;
            vkTitle?: React.ReactNode;
        }>;
    },
    /** Props read from color-field.tsx: value/onChange are RGBA 0..1 colours. */
    get ColorField() {
        return VC.ColorField as FC<{
            value: { r: number; g: number; b: number; a: number };
            onChange?: (c: { r: number; g: number; b: number; a: number }) => void;
            onClick?: (e: React.MouseEvent) => void;
            className?: string;
            disabled?: boolean;
            alpha?: boolean;
            popupDirection?: "up" | "down";
            hideHint?: boolean;
            colorWheel?: boolean;
            hexInput?: boolean;
            focusKey?: unknown;
        }>;
    },
    /** Props read from floating-mouse-tooltip.tsx; with screenSpacePosition it tracks the mouse and needs no children. */
    get FloatingMouseTooltip() {
        return VC.FloatingMouseTooltip as FC<PropsWithChildren<{
            tooltip: React.ReactNode;
            disabled?: boolean;
            alwaysVisible?: boolean;
            forceVisible?: boolean;
            screenSpacePosition?: boolean;
            position?: { x: number; y: number };
            className?: string;
        }>>;
    },
    get iceflakePanel() {
        return VT.iceflakePanel as Record<string, string>;
    },
    get overviewPage() {
        return VT.overviewPage as Record<string, string>;
    },
    get lineItem() {
        return VT.lineItem as Record<string, string>;
    },
    /** Chart.js on a canvas sized to its div; `options` are Chart.js options (tooltips/events are off game-wide). */
    get ResponsiveChart() {
        return VC.ResponsiveChart as FC<{ type: string; data: { labels?: unknown[]; datasets: any[] }; options: any; className?: string; style?: React.CSSProperties }>;
    },
    get ColorLegend() {
        return VC.ColorLegend as FC<PropsWithChildren<{ color: string; label: React.ReactNode; className?: string }>>;
    },
    /** A stacked horizontal bar: `values` as shares of `total`, one colour each. */
    get BarChart() {
        return VC.BarChart as FC<{ colors: string[]; data: { values: number[]; total: number }; className?: string }>;
    },
    /** The game's plain text input (Find It's search box). Extra props go to the <input>. */
    get TextInput() {
        return VC.TextInput as FC<{
            value: string; type?: string; multiline?: number; placeholder?: string; className?: string; focusKey?: unknown; disabled?: boolean;
            onChange?: (e: { target: { value: string } }) => void; onBlur?: () => void; onKeyDown?: (e: React.KeyboardEvent) => void;
        }>;
    },
    get editorItem() {
        return (VT.editorItem ?? {}) as Record<string, string>;
    },
    /** The statistics graph's chart colours (grid / tick text), with fallbacks if the module moves. */
    get chartColors() {
        const t = (VT.statisticsGraph ?? {}) as Record<string, string>;
        return { line: t.chartLineColor ?? "rgba(255, 255, 255, 0.1)", font: t.chartFontColor ?? "rgba(255, 255, 255, 0.6)" };
    },
};
