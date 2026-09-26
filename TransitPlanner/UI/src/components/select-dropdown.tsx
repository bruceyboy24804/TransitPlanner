import classNames from "classnames";
import { vanilla } from "../vanilla";
import styles from "./planner.module.scss";

// A single-choice dropdown, the Options screen's recipe (menu/widgets/dropdown-field): the game's
// Dropdown on the menu dropdown theme, a DropdownToggle carrying the field's `dropdown` class, and
// plain DropdownItems the theme draws (selected state, hover, sounds, close on pick). Never a
// <select>: that kills the whole cohtml UI.

export interface SelectDropdownProps<T> {
    options: [string, T][];
    value: T;
    onChange: (v: T) => void;
    className?: string;
    /** Traffic's editor dropdown: a grey pill, 200rem wide, instead of the Options-screen box. */
    pill?: boolean;
}

/**
 * The menu theme with our item size added: the option list is portalled out of the host, so the
 * host's 13rem rule cannot reach it; the theme's own item class can. Built once.
 */
let itemTheme: Record<string, string> | null = null;
const theme = () => (itemTheme ??= { ...vanilla.menuDropdown, dropdownItem: classNames(vanilla.menuDropdown.dropdownItem, styles.selectItem) });

export function SelectDropdown<T>({ options, value, onChange, className, pill }: SelectDropdownProps<T>) {
    const { Dropdown, DropdownToggle, DropdownItem } = vanilla;
    const current = options.findIndex(([, v]) => v === value);
    const content = options.map(([label, v], i) => (
        <DropdownItem key={i} value={i} focusKey={i} selected={i === current} closeOnSelect
            onChange={() => onChange(v)} onToggleSelected={() => onChange(v)}>
            {label}
        </DropdownItem>
    ));
    return (
        <div className={classNames(pill ? styles.pillHost : styles.selectHost, className)}>
            <Dropdown theme={theme()} content={content} initialFocused={current >= 0 ? current : undefined}>
                <DropdownToggle className={pill ? styles.pillToggle : vanilla.menuDropdownField.dropdown}>
                    {current >= 0 ? options[current][0] : "—"}
                </DropdownToggle>
            </Dropdown>
        </div>
    );
}
