import { Tooltip } from "cs2/ui";
import classNames from "classnames";
import styles from "./planner.module.scss";
import { HelpButton } from "./encyclopedia";

// The toolbar parts taken from Traffic's editor, shared by the Schedule and Rules tabs: labelled
// sections (its uppercase left labels) and tinted glyph buttons with tooltips.

/** A toolbar section: a small uppercase label over its controls. */
export const Section = ({ label, children, help }: { label: string; children: React.ReactNode; help?: string }) => (
    <div className={styles.boardSection}>
        <div className={styles.boardSectionLabel}>{label}</div>
        <div className={styles.boardSectionBody}>{children}{help && <HelpButton section={help} inline />}</div>
    </div>
);

/**
 * A tinted glyph button with a tooltip (Traffic's Copy / Trash / Plus / Close actions). The mask
 * is inline and quoted: game paths can hold spaces ("Media/Tools/Area Tool/Edit.svg").
 */
export const Glyph = ({ src, tooltip, onClick, disabled }: { src: string; tooltip: string; onClick: () => void; disabled?: boolean }) => (
    <Tooltip tooltip={tooltip}>
        <div className={classNames(styles.boardGlyph, disabled && styles.boardGlyphOff)} onClick={disabled ? undefined : onClick}>
            <div className={styles.boardGlyphIcon} style={{ maskImage: `url("${src}")`, WebkitMaskImage: `url("${src}")` } as React.CSSProperties} />
        </div>
    </Tooltip>
);

/** A labelled step in a form (the Rules editor's IF / THEN parts): small caps over a rule. */
export const Step = ({ label }: { label: string }) => <div className={styles.formStep}>{label}</div>;

/**
 * Traffic's editor row (its sectionRow / titleRow / left / right): the label on the left in the
 * dim text colour, the controls pushed to the right edge. `dimmer` = its subRow.
 */
export const Row = ({ label, children, dimmer, help }: { label: React.ReactNode; children?: React.ReactNode; dimmer?: boolean; help?: string }) => (
    <div className={classNames(styles.tRow, dimmer && styles.tRowSub)}>
        <div className={styles.tLeft}>{label}</div>
        <div className={styles.tRight}>{children}{help && <HelpButton section={help} inline />}</div>
    </div>
);

/** Traffic's section title: centred, uppercase. */
export const Title = ({ label }: { label: string }) => <div className={styles.tTitle}>{label}</div>;
