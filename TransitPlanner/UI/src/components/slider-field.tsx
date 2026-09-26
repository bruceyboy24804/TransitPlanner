import classNames from "classnames";
import { vanilla } from "../vanilla";
import styles from "./slider-field.module.scss";

// One settings row: label, slider, number box, unit — the game's own `IntSliderField`
// (game-ui/editor/widgets/fields/number-slider-field.tsx), which is what its tool panels use and
// what Network Tools builds its parameter rows from. Replaces our hand-rolled "slider + a number
// beside it", which had no input box and did not match anything else in the game.
//
// The unit is ours: the vanilla field has no slot for one, so it is placed inside the right edge of
// the number box the way Network Tools does it (field flex: 1, unit absolute in the relative row).

export const SliderField = ({
    label,
    value,
    min,
    max,
    unit,
    compact,
    disabled,
    tooltip,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    /** Shown inside the number box, e.g. "min", "%", "₡". */
    unit?: string;
    /** No label column: the row already has a label or a toggle of its own. */
    compact?: boolean;
    disabled?: boolean;
    tooltip?: string;
    onChange: (value: number) => void;
}) => {
    const Field = vanilla.IntSliderField;
    return (
        <div className={classNames(styles.field, compact && styles.compact, unit && styles.withUnit)}>
            <Field label={label} value={value} min={min} max={max} disabled={disabled} tooltip={tooltip ?? null} onChange={onChange} />
            {unit && <span className={styles.unit}>{unit}</span>}
        </div>
    );
};
