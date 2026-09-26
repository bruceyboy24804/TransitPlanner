import { useValue } from "cs2/api";
import { Button, Icon, Tooltip } from "cs2/ui";
import { visible$ } from "../bindings";
import styles from "./planner.module.scss";

/** The GameTopLeft toggle: opens and closes the planner window. The game's own Button, so it
 *  matches the strip it sits in; base.scss buttons are for inside the panel. */
export const PlannerButton = () => {
    const visible = useValue(visible$.binding);
    return (
        <Tooltip tooltip="Transit Planner">
            <Button
                variant="floating"
                selected={visible}
                onSelect={() => visible$.set(!visible)}
            >
                <Icon tinted src="Media/Game/Icons/Transportation.svg" className={styles.toggleIcon} />
            </Button>
        </Tooltip>
    );
};
