import { PropsWithChildren } from "react";
import classNames from "classnames";
import styles from "./planner.module.scss";

export interface FlatButtonProps {
    selected?: boolean;
    disabled?: boolean;
    className?: string;
    tooltip?: string;
    onClick?: () => void;
}

/**
 * A plain <button> on base.scss's mixins: looks like the game's own flat buttons (its palette
 * tokens, its selected gradient) without cs2/ui's Button focus controller, which can throw
 * "KeyFocusControllers can only host a single child" inside a panel.
 */
export const FlatButton = ({ selected, disabled, className, tooltip, onClick, children }: PropsWithChildren<FlatButtonProps>) => (
    <button
        className={classNames(styles.flatButton, selected && "selected", className)}
        disabled={disabled}
        title={tooltip}
        onClick={disabled ? undefined : onClick}
    >
        {children}
    </button>
);
