import { useValue } from "cs2/api";
import { transport } from "cs2/bindings";
import classNames from "classnames";
import { Tooltip } from "cs2/ui";
import { TransportType, transportTypeId } from "../types";
import { vanilla } from "../vanilla";
import styles from "./planner.module.scss";

// The transportation overview's type column, shared by both tabs: the game's own type buttons
// (TransportTypeItem, with its icons and lock state) fed by the game's own type lists, for the
// group — public transport or cargo — the group tabs select, exactly as the overview splits
// them. One type is always selected; there is no "all".

const { passengerTypes$, cargoTypes$ } = transport;

export interface TypeSelection {
    type: TransportType;
    cargo: boolean;
}

/** The overview's type ids are TransportType names; map one back to our enum. */
const typeFromId = (id: string): TransportType | undefined => {
    const hit = Object.entries(transportTypeId).find(([, name]) => name === id);
    return hit ? (Number(hit[0]) as TransportType) : undefined;
};

export const DEFAULT_TYPE: TypeSelection = { type: TransportType.Bus, cargo: false };

export const sameType = (a: TypeSelection, b: TypeSelection) => a.type === b.type && a.cargo === b.cargo;

/** Vanilla's wording: "Bus lines" for passengers, "Train routes" for cargo. */
export const typeTitle = (sel: TypeSelection, label: string) => `${label} ${sel.cargo ? "routes" : "lines"}`;

/** The first type of a group, for when the group tab changes; Bus / Train in practice. */
export const useFirstTypeOf = () => {
    const passenger = useValue(passengerTypes$);
    const cargo = useValue(cargoTypes$);
    return (isCargo: boolean): TypeSelection => {
        const list = isCargo ? cargo : passenger;
        for (const t of list) {
            const type = typeFromId(t.id);
            if (type !== undefined) return { type, cargo: isCargo };
        }
        return { type: isCargo ? TransportType.Train : TransportType.Bus, cargo: isCargo };
    };
};

/**
 * The PUBLIC TRANSPORT / CARGO row as a second-level strip, the way Find It draws its
 * sub-categories under its category tabs: the asset menu's category tab bar (`assetCategoryTabBar`
 * + `items`) holding item-grid buttons with a thumbnail, selected = the game's highlight gradient.
 * Icons are the game's own: the first type of each group.
 */
export const GroupTabs = ({ cargo, onSelect }: { cargo: boolean; onSelect: (cargo: boolean) => void }) => {
    const bar = vanilla.assetCategoryTabBar;
    const grid = vanilla.itemGrid;
    const passengerTypes = useValue(passengerTypes$);
    const cargoTypes = useValue(cargoTypes$);
    const groups = [
        { cargo: false, label: "Public transport", icon: passengerTypes[0]?.icon ?? "Media/Game/Icons/Transportation.svg", enabled: true },
        { cargo: true, label: "Cargo", icon: cargoTypes[0]?.icon ?? "Media/Game/Icons/Train.svg", enabled: cargoTypes.length > 0 },
    ];
    return (
        <div className={classNames(bar.assetCategoryTabBar, styles.groupStrip)}>
            <div className={bar.items}>
                {groups.map((g) => (
                    <Tooltip key={String(g.cargo)} tooltip={g.label}>
                        <button
                            className={classNames(grid.item, styles.groupTab, g.cargo === cargo && "selected")}
                            disabled={!g.enabled}
                            onClick={g.cargo === cargo || !g.enabled ? undefined : () => onSelect(g.cargo)}
                        >
                            {/* Icon-only like Find It's strip: the item-grid button is a fixed square. */}
                            <img src={g.icon} className={classNames(grid.thumbnail, styles.groupIcon)} />
                        </button>
                    </Tooltip>
                ))}
            </div>
        </div>
    );
};

export const TypeSidebar = ({ selected, onSelect }: { selected: TypeSelection; onSelect: (sel: TypeSelection) => void }) => {
    const page = vanilla.overviewPage;
    const { TransportTypeItem, PanelSection } = vanilla;
    const passenger = useValue(passengerTypes$);
    const cargo = useValue(cargoTypes$);

    const items = (list: transport.TransportType[], isCargo: boolean) =>
        list.map((t) => {
            const type = typeFromId(t.id);
            if (type === undefined) return null;
            const sel = { type, cargo: isCargo };
            return (
                <TransportTypeItem
                    key={`${isCargo}:${t.id}`}
                    type={t}
                    cargo={isCargo}
                    selected={sameType(sel, selected)}
                    onSelect={() => onSelect(sel)}
                />
            );
        });

    return (
        <PanelSection theme={vanilla.panelSection} className={classNames(page.types, styles.fleetTypes)}>
            {selected.cargo ? items(cargo, true) : items(passenger, false)}
        </PanelSection>
    );
};
