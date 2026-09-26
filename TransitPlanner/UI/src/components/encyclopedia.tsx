import { useEffect, useState } from "react";
import { Panel, Portal, Scrollable, Tooltip } from "cs2/ui";
import classNames from "classnames";
import { useLocalization } from "cs2/l10n";
import { vanilla } from "../vanilla";
import { TextField } from "./text-field";
import { findSection, HELP_ENTRIES, HELP_TABS, HelpCategory, HelpSection, HelpTab } from "./encyclopedia-content";
import styles from "./encyclopedia.module.scss";

// The Transit Planner encyclopedia (XTM's glossary idea, in a window of our own): a nav column of
// tabs → categories → sections with a search box, and the chosen article beside it. It opens from
// the ? in the planner header or from any HelpButton, which jumps straight to a section.

// Open state lives at module level so a HelpButton anywhere can open the window at a section
// without threading callbacks through every panel.
let state = { open: false, section: HELP_ENTRIES[0].section.id };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Opens the encyclopedia, at a section when given. */
export const openHelp = (section?: string) => {
    state = { open: true, section: section && findSection(section) ? section : state.section };
    emit();
};
const closeHelp = () => { state = { ...state, open: false }; emit(); };
const selectHelp = (section: string) => { state = { ...state, section }; emit(); };

const useHelpState = () => {
    const [, force] = useState(0);
    useEffect(() => {
        const l = () => force((n) => n + 1);
        listeners.add(l);
        return () => { listeners.delete(l); };
    }, []);
    return state;
};

/**
 * Locale lookups for the articles. The English in encyclopedia-content.ts is the fallback, so a
 * translation only needs the keys it covers:
 *   TransitPlanner.Encyclopedia.TAB[<tab id>], .CATEGORY[<tab id>.<category id>],
 *   .TITLE[<section id>], .BODY[<section id>] (same markup as the English body).
 */
const useHelpText = () => {
    const { translate } = useLocalization();
    const t = (key: string, fallback: string) => translate(`TransitPlanner.Encyclopedia.${key}`, fallback) || fallback;
    return {
        tab: (x: HelpTab) => t(`TAB[${x.id}]`, x.title),
        category: (x: HelpTab, c: HelpCategory) => t(`CATEGORY[${x.id}.${c.id}]`, c.title),
        title: (s: HelpSection) => t(`TITLE[${s.id}]`, s.title),
        body: (s: HelpSection) => t(`BODY[${s.id}]`, s.body),
    };
};

/** A small round ? that opens the encyclopedia at `section`. `inline` spaces it after a control. */
export const HelpButton = ({ section, tooltip, inline }: { section: string; tooltip?: string; inline?: boolean }) => (
    <Tooltip tooltip={tooltip ?? "Explain this"}>
        <div className={classNames(styles.helpButton, inline && styles.helpInline)} onClick={(e) => { e.stopPropagation(); openHelp(section); }}>?</div>
    </Tooltip>
);

/** A section heading with its ? beside it; `className` is the heading's own style. */
export const HelpTitle = ({ title, section, className }: { title: string; section: string; className?: string }) => (
    <div className={styles.helpTitle}>
        <span className={className}>{title}</span>
        <HelpButton section={section} inline />
    </div>
);

// Images, XTM's recipe: `![caption](file.jpg)` on a line of its own, optionally
// `![caption](file.jpg height:200)`. A bare file name is looked up in the mod's
// Assets/Encyclopedia folder (copied next to the DLL by the build and served as
// coui://transitplanner/…); a full coui:// or Media/ path is used as is.
const IMAGE = /^!\[(.*?)\]\((\S+?)(?:\s+height:(\d+))?\)$/;
const IMAGE_MAX_WIDTH_REM = 620;
const IMAGE_DEFAULT_HEIGHT_REM = 300;
const PREVIEW_MAX = { w: 900, h: 560 };

const imageSrc = (path: string) =>
    /^(coui:|Media\/|https?:)/.test(path) ? path : `coui://transitplanner/Encyclopedia/${path}`;

/** Fits w×h (any unit) into a box, keeping the ratio; returns rem. */
const fit = (w: number, h: number, maxW: number, maxH: number) => {
    const k = Math.min(maxW / w, maxH / h);
    return { width: w * k, height: h * k };
};

type Preview = { src: string; caption: string } | null;

/**
 * An article image, sized once it has loaded: its natural aspect ratio at the asked height,
 * narrowed to the column. Sizes are set in rem from JS because a percentage width inside the
 * scrollable is circular in Gameface. A missing file shows its caption in a dashed box, so a
 * forgotten screenshot is visible instead of an empty gap.
 */
const ArticleImage = ({ src, caption, height, onOpen }: { src: string; caption: string; height: number; onOpen: () => void }) => {
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);
    const [failed, setFailed] = useState(false);
    if (failed) return <div className={styles.imageMissing}>{`Image missing: ${caption || src}`}</div>;
    return (
        <div className={styles.figure}>
            <Tooltip tooltip="Click to enlarge">
                <img src={src} className={styles.image} onClick={onOpen}
                    style={size ? { width: `${size.width}rem`, height: `${size.height}rem` } : { height: `${height}rem` }}
                    onLoad={(e) => {
                        const img = e.currentTarget;
                        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
                        if (w > 0 && h > 0) setSize(fit(w, h, IMAGE_MAX_WIDTH_REM, height));
                    }}
                    onError={() => setFailed(true)} />
            </Tooltip>
            {caption && <div className={styles.caption}>{caption}</div>}
        </div>
    );
};

/** The enlarged image over the whole window; a click anywhere closes it. */
const ImagePreview = ({ preview, onClose }: { preview: NonNullable<Preview>; onClose: () => void }) => {
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);
    return (
        <div className={styles.preview} onClick={onClose}>
            <img src={preview.src} className={styles.previewImage}
                style={size ? { width: `${size.width}rem`, height: `${size.height}rem` } : undefined}
                onLoad={(e) => {
                    const img = e.currentTarget;
                    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
                    if (w > 0 && h > 0) setSize(fit(w, h, PREVIEW_MAX.w, PREVIEW_MAX.h));
                }} />
            {preview.caption && <div className={styles.previewCaption}>{preview.caption}</div>}
        </div>
    );
};

/**
 * One article body. Paragraphs and bullets are separate blocks, and a bullet's bold label is its
 * own element beside the text: Gameface stacks mixed inline runs (see encyclopedia-content.ts).
 */
const Article = ({ title, body, onImage }: { title: string; body: string; onImage: (p: NonNullable<Preview>) => void }) => (
    <>
        <div className={styles.articleTitle}>{title}</div>
        {body.split(/\n\s*\n/).map((block, i) => {
            const lines = block.split("\n").filter((l) => l.trim().length > 0);
            if (lines.length > 0 && lines.every((l) => l.startsWith("- "))) {
                return (
                    <div key={i} className={styles.list}>
                        {lines.map((l, j) => {
                            const m = /^- \*\*(.+?)\*\*\s*(.*)$/.exec(l);
                            return m ? (
                                <div key={j} className={styles.term}>
                                    <div className={styles.termLabel}>{m[1]}</div>
                                    <div className={styles.termText}>{m[2]}</div>
                                </div>
                            ) : (
                                <div key={j} className={styles.bullet}>{`•  ${l.slice(2).replace(/\*\*/g, "")}`}</div>
                            );
                        })}
                    </div>
                );
            }
            const img = lines.length === 1 ? IMAGE.exec(lines[0].trim()) : null;
            if (img) {
                const src = imageSrc(img[2]);
                return <ArticleImage key={`${i}:${src}`} src={src} caption={img[1]} height={img[3] ? Number(img[3]) : IMAGE_DEFAULT_HEIGHT_REM}
                    onOpen={() => onImage({ src, caption: img[1] })} />;
            }
            if (block.startsWith("### ")) return <div key={i} className={styles.subheading}>{block.slice(4)}</div>;
            return <div key={i} className={styles.paragraph}>{block.replace(/\*\*/g, "").replace(/\n/g, " ")}</div>;
        })}
    </>
);

/**
 * A path of names joined by the game's arrow glyph (a masked div, so it takes the text colour;
 * the game font's › sits low and thin). Row-wise, since Gameface stacks children by default.
 */
const CHEVRON = "Media/Glyphs/ThickStrokeArrowRight.svg";
const Crumbs = ({ parts, className }: { parts: string[]; className?: string }) => (
    <div className={classNames(styles.crumbs, className)}>
        {parts.map((p, i) => [
            i > 0 && <div key={`c${i}`} className={styles.chevron} style={{ maskImage: `url("${CHEVRON}")`, WebkitMaskImage: `url("${CHEVRON}")` } as React.CSSProperties} />,
            <span key={`p${i}`}>{p}</span>,
        ])}
    </div>
);

/** The encyclopedia window. Mounted once next to the planner; renders nothing while closed. */
export const EncyclopediaPanel = () => {
    const { open, section } = useHelpState();
    const [query, setQuery] = useState("");
    const text = useHelpText();
    const [preview, setPreview] = useState<Preview>(null);
    useEffect(() => setPreview(null), [section, open]);
    const q = query.trim().toLowerCase();
    const hits = !q ? null : HELP_ENTRIES.filter((e) =>
        [text.title(e.section), text.body(e.section), text.category(e.tab, e.category)].some((v) => v.toLowerCase().includes(q)));
    if (!open) return null;
    const current = findSection(section) ?? HELP_ENTRIES[0];

    const header = (
        <div className={styles.header}>
            <div className={vanilla.iceflakePanel.title}>Transit Planner Encyclopedia</div>
        </div>
    );
    const item = (id: string, title: string | string[]) => (
        <div key={id} className={classNames(styles.navItem, id === current.section.id && styles.navItemSelected)} onClick={() => selectHelp(id)}>
            {Array.isArray(title) ? <Crumbs parts={title} /> : title}
        </div>
    );

    return (
        <Portal>
            <Panel
                draggable
                header={header}
                theme={vanilla.iceflakePanel}
                className={styles.panel}
                contentClassName={styles.content}
                initialPosition={{ x: 0.5, y: 0.5 }}
                onClose={closeHelp}
            >
                <div className={styles.body}>
                    <div className={styles.nav}>
                        <TextField value={query} placeholder="Search…" onChange={setQuery} className={styles.search} />
                        <Scrollable vertical className={styles.navScroll}>
                            {hits ? (
                                hits.length === 0 ? <div className={styles.none}>Nothing found.</div>
                                    : hits.map((e) => item(e.section.id, [text.tab(e.tab), text.title(e.section)]))
                            ) : HELP_TABS.map((tab) => (
                                <div key={tab.id} className={styles.navTab}>
                                    <div className={styles.navTabTitle}>{text.tab(tab)}</div>
                                    {tab.categories.map((cat) => (
                                        <div key={cat.id}>
                                            {tab.categories.length > 1 && <div className={styles.navCategory}>{text.category(tab, cat)}</div>}
                                            {cat.sections.map((s) => item(s.id, text.title(s)))}
                                        </div>
                                    ))}
                                </div>
                            ))}
                        </Scrollable>
                    </div>
                    <Scrollable vertical className={styles.article}>
                        <Crumbs className={styles.breadcrumb} parts={[text.tab(current.tab), text.category(current.tab, current.category)]} />
                        <Article title={text.title(current.section)} body={text.body(current.section)} onImage={setPreview} />
                    </Scrollable>
                    {/* Inside the window, not a Portal: a portalled layer lands under the game's
                        other UI and takes no clicks (the Network tab's context menu found this). */}
                    {preview && <ImagePreview preview={preview} onClose={() => setPreview(null)} />}
                </div>
            </Panel>
        </Portal>
    );
};
