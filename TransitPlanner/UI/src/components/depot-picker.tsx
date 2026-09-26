import { useValue } from "cs2/api";
import { Scrollable } from "cs2/ui";
import { LocalizedEntityName } from "cs2/l10n";
import classNames from "classnames";
import { depots$, preferredDepot$, setPreferredDepot } from "../bindings";
import { LineRow, NULL_ENTITY, sameEntity } from "../types";
import { vanilla } from "../vanilla";
import styles from "./model-dropdown.module.scss";
import panel from "./planner.module.scss";

// Depot: a single-select dropdown on the model-dropdown recipe. "Any depot" is the vanilla
// behaviour (cheapest pairing wins); a chosen depot is the only one allowed to send vehicles to
// the line — if it has none spare the line waits and shows NotEnoughVehicles.

export const DepotPicker = ({ line }: { line: LineRow }) => {
    const depots = useValue(depots$.binding);
    const preferred = useValue(preferredDepot$.binding);
    const { Dropdown, DropdownToggle } = vanilla;
    const chosen = depots.find((d) => sameEntity(d.entity, preferred));

    const row = (key: string, on: boolean, onClick: () => void, name: React.ReactNode, meta?: string) => (
        <div key={key} className={classNames(styles.row, on && styles.rowOn)} onClick={onClick}>
            <div className={styles.text}>
                <div className={styles.name}>{name}</div>
                {meta && <div className={styles.meta}>{meta}</div>}
            </div>
        </div>
    );

    const menu = (
        <div className={styles.menuBody}>
            <Scrollable vertical className={styles.listScroll}>
                {row("any", !chosen, () => setPreferredDepot(line.entity, NULL_ENTITY), "Any depot", "Vanilla dispatch: nearest available")}
                {depots.map((d) =>
                    row(
                        String(d.entity.index),
                        sameEntity(d.entity, preferred),
                        () => setPreferredDepot(line.entity, d.entity),
                        <LocalizedEntityName value={d.name} />,
                        `${d.available} ready / ${d.owned} owned` + (d.serving > 0 ? ` / ${d.serving} on this line` : ""),
                    ),
                )}
                {depots.length === 0 && <div className={styles.empty}>No depots of this type</div>}
            </Scrollable>
        </div>
    );

    return (
        <div className={panel.editor}>
            <div className={panel.sectionTitle}>Depot</div>
            <div className={panel.hint}>Only this depot sends vehicles to the line. If it has none spare the line waits (Not enough vehicles) instead of borrowing from another depot.</div>
            <div className={classNames(styles.host, styles.hostInColumn)}>
                <Dropdown
                    theme={{ ...vanilla.gameDropdown, dropdownMenu: classNames(vanilla.gameDropdown.dropdownMenu, styles.menuTransparent) }}
                    content={menu}
                >
                    <DropdownToggle showHint>
                        <div className={styles.toggle}>
                            <div className={styles.label}>Depot</div>
                            <div className={styles.summary}>{chosen ? <LocalizedEntityName value={chosen.name} /> : "Any depot"}</div>
                        </div>
                    </DropdownToggle>
                </Dropdown>
            </div>
        </div>
    );
};
