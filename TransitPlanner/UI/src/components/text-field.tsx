import { FOCUS_DISABLED } from "cs2/input";
import classNames from "classnames";
import { vanilla } from "../vanilla";
import styles from "./planner.module.scss";

// A text box the way Find It builds its search: the game's TextInput on the editor-item theme's
// input class, focus key disabled (the panel runs its own focus), with a real placeholder — the
// game's input stays visible here, unlike the ellipsis input, which shows a label until focused.

export const TextField = ({ value, placeholder, onChange, onBlur, onKeyDown, className }: {
    value: string; placeholder?: string; className?: string;
    onChange: (v: string) => void; onBlur?: () => void; onKeyDown?: (e: React.KeyboardEvent) => void;
}) => (
    <vanilla.TextInput value={value} type="text" multiline={1} placeholder={placeholder} focusKey={FOCUS_DISABLED}
        className={classNames(vanilla.editorItem.input, styles.textField, className)}
        onChange={(e) => onChange(e.target.value)} onBlur={onBlur} onKeyDown={onKeyDown} />
);
