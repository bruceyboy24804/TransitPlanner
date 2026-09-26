import type { Entity } from "cs2/bindings";
import { Scrollable } from "cs2/ui";
import classNames from "classnames";
import { ModelInfo, sameEntity } from "../types";
import { vanilla } from "../vanilla";
import { useModelName } from "./fleet-panel";
import styles from "./model-dropdown.module.scss";

// The vehicle picker as a dropdown, BetterTransitSelector's recipe: the game's Dropdown +
// DropdownToggle on the game-dropdown theme, a menu body that paints its own plate (vanilla's
// popup box stretches to the screen, so its fill/border/blur are moved onto the body and the
// theme's menu made transparent), and rows of Checkbox + thumbnail + name.

export interface ModelDropdownProps {
    label: string;
    models: ModelInfo[];
    selected: Entity[];
    onToggle: (model: ModelInfo, selected: boolean) => void;
    /** Shown when nothing is selected. */
    emptyText?: string;
    /** Cargo models: capacity is cargo, not passengers. */
    cargo?: boolean;
}

const has = (list: Entity[], e: Entity) => list.some((x) => sameEntity(x, e));

export const ModelDropdown = ({ label, models, selected, onToggle, emptyText = "Any", cargo = false }: ModelDropdownProps) => {
    const { Dropdown, DropdownToggle, Checkbox } = vanilla;
    const name = useModelName();
    const picked = models.filter((m) => has(selected, m.entity));

    // The game's Scrollable, not overflow-y: Gameface does not scroll an overflowing div on its
    // own, which is how the list came out cut off at the popup's edge.
    const menu = (
        <div className={styles.menuBody}>
            <Scrollable vertical className={styles.listScroll}>
            {models.map((m) => {
                const on = has(selected, m.entity);
                return (
                    <div key={m.entity.index} className={classNames(styles.row, on && styles.rowOn)} onClick={() => onToggle(m, !on)}>
                        <Checkbox checked={on} onChange={() => onToggle(m, !on)} />
                        <div className={styles.thumb} style={{ backgroundImage: `url(${m.thumbnail})` }} />
                        <div className={styles.text}>
                            <div className={styles.name}>{name(m)}</div>
                            {m.capacity > 0 && <div className={styles.meta}>{cargo ? `${m.capacity} cargo capacity` : `${m.capacity} passengers`}</div>}
                        </div>
                    </div>
                );
            })}
            {models.length === 0 && <div className={styles.empty}>No models available</div>}
            </Scrollable>
        </div>
    );

    return (
        <div className={styles.host}>
            <Dropdown
                theme={{ ...vanilla.gameDropdown, dropdownMenu: classNames(vanilla.gameDropdown.dropdownMenu, styles.menuTransparent) }}
                content={menu}
            >
                <DropdownToggle showHint>
                    <div className={styles.toggle}>
                        <div className={styles.label}>{label}</div>
                        <div className={styles.summary}>
                            {picked.length === 0 ? emptyText : picked.length === 1 ? name(picked[0]) : `${picked.length} selected`}
                        </div>
                    </div>
                </DropdownToggle>
            </Dropdown>
        </div>
    );
};
