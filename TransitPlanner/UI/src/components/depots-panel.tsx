import { useMemo, useState } from "react";
import { useValue } from "cs2/api";
import type { Entity } from "cs2/bindings";
import { LocalizedEntityName } from "cs2/l10n";
import { Scrollable, Tooltip } from "cs2/ui";
import classNames from "classnames";
import { bindLines, depotRows$, lines$, selected$ } from "../bindings";
import { byLine, DepotRow, LineRow, NULL_ENTITY, sameEntity } from "../types";
import { vanilla } from "../vanilla";
import { FlatButton } from "./flat-button";
import { SplitHandle, useSplit } from "./split-handle";
import { TypeSelection } from "./type-sidebar";
import { typeLabel } from "./planner-panel";
import styles from "./planner.module.scss";

// The Depots tab: the Fleet tab's table, one row per depot of the selected type — vehicles
// ready / owned / capacity, how many lines it serves, how many are bound to it, and whether a
// bound line is starving (short of vehicles while the depot has none spare). Selecting a row
// opens the depot's lines below: every line of the type, with a bind toggle per line and a
// "bind all shown" for the lot. Binding is TP_PreferredDepot, the hard depot restriction.

const cssColor = (c: LineRow["color"]) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;

type SortKey = "name" | "available" | "owned" | "lines" | "bound";
const sorters: Record<SortKey, (r: DepotRow) => number> = {
    name: (r) => r.entity.index,
    available: (r) => r.available,
    owned: (r) => r.owned,
    lines: (r) => r.lines.length,
    bound: (r) => r.lines.filter((l) => l.bound).length,
};

const DepotDetail = ({ depot, lines, onOpen, height }: { depot: DepotRow; lines: LineRow[]; onOpen: (l: LineRow) => void; height: number }) => {
    const boundHere = (l: LineRow) => depot.lines.some((d) => sameEntity(d.entity, l.entity) && d.bound);
    const here = (l: LineRow) => depot.lines.find((d) => sameEntity(d.entity, l.entity));
    const allBound = lines.length > 0 && lines.every(boundHere);
    return (
        <div className={classNames(styles.bulk, styles.ttDetail)} style={{ height }}>
            <div className={styles.row}>
                <span className={styles.sectionTitle}><LocalizedEntityName value={depot.name} /></span>
                <span className={styles.spacer} />
                <FlatButton onClick={() => bindLines(lines.map((l) => l.entity), depot.entity)} disabled={allBound || lines.length === 0}>
                    Bind all shown lines here
                </FlatButton>
                <FlatButton onClick={() => bindLines(lines.filter(boundHere).map((l) => l.entity), NULL_ENTITY)} disabled={!lines.some(boundHere)}>
                    Unbind all
                </FlatButton>
            </div>
            <div className={styles.hint}>A bound line takes vehicles from this depot only. Unbound lines use the nearest depot with vehicles to spare.</div>
            <Scrollable vertical className={classNames(styles.depotLines, styles.ttDetailScroll)}>
                {lines.map((l) => {
                    const d = here(l);
                    const bound = !!d?.bound;
                    return (
                        <div key={l.entity.index} className={classNames(styles.stopRow, styles.depotLine)}>
                            <div className={styles.swatch} style={{ backgroundColor: cssColor(l.color) }} />
                            <span className={styles.depotLineName} onClick={() => onOpen(l)}><LocalizedEntityName value={l.name} /></span>
                            <span className={classNames(styles.lineMeta, l.notEnoughVehicles && styles.warn)}>
                                {`${d?.vehicles ?? 0} from here · ${l.fleet}/${l.target} vehicles`}
                            </span>
                            <span className={styles.spacer} />
                            <FlatButton selected={bound} onClick={() => bindLines([l.entity], bound ? NULL_ENTITY : depot.entity)}>
                                {bound ? "Bound here" : "Bind"}
                            </FlatButton>
                        </div>
                    );
                })}
                {lines.length === 0 && <div className={styles.empty}>No lines of this type.</div>}
            </Scrollable>
        </div>
    );
};

export const DepotsPanel = ({ typeSel, onOpenInPlanner }: { typeSel: TypeSelection; onOpenInPlanner: (l: LineRow) => void }) => {
    const page = vanilla.overviewPage;
    const item = vanilla.lineItem;
    const { PanelSection } = vanilla;
    const depots = useValue(depotRows$.binding);
    const allLines = useValue(lines$.binding);
    const [picked, setPicked] = useState<Entity>(NULL_ENTITY);
    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [ascending, setAscending] = useState(true);
    const sortBy = (k: SortKey) => { if (k === sortKey) setAscending(!ascending); else { setSortKey(k); setAscending(k === "name"); } };

    // Depots are per transport type only (a train depot serves passenger and cargo alike); the
    // line list under a depot keeps the passenger/cargo split of the sidebar.
    const shown = useMemo(() => {
        const f = sorters[sortKey];
        return depots.filter((d) => d.type === typeSel.type).sort((a, b) => (ascending ? f(a) - f(b) : f(b) - f(a)));
    }, [depots, typeSel, sortKey, ascending]);
    const lines = useMemo(() => allLines.filter((l) => l.type === typeSel.type && (l.cargo ?? false) === typeSel.cargo).sort(byLine), [allLines, typeSel]);
    const current = shown.find((d) => sameEntity(d.entity, picked));
    const [detailH, setDetailH] = useSplit("depots", 320);

    const Head = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
        <div className={classNames(page.cellDouble, className)}>
            <button className={page.button} onClick={() => sortBy(k)}>
                <div className={page.buttonLabel}>{children}</div>
                {sortKey === k && <img className={page.sortIndicator} src={`Media/Glyphs/ThickStrokeArrow${ascending ? "Down" : "Up"}.svg`} />}
            </button>
        </div>
    );

    return (
        <div className={classNames(page.transportationOverviewPage, styles.fleetPage)}>
            <PanelSection theme={vanilla.panelSection} className={classNames(page.lines, styles.fleetLines)} header={
                <div className={page.header}>
                    <div className={page.title}>{`${typeLabel[typeSel.type] ?? "?"} depots`.toUpperCase()}</div>
                    <div className={page.legends}>
                        <div className={classNames(page.cellWide, page.alignLeft)}>
                            <button className={page.button} onClick={() => sortBy("name")}><div className={page.buttonLabel}>Name</div></button>
                        </div>
                        <Head k="available">Ready</Head>
                        <Head k="owned">Owned</Head>
                        <div className={page.cellDouble}><div className={page.buttonLabel}>Capacity</div></div>
                        <Head k="lines">Serves</Head>
                        <Head k="bound">Bound</Head>
                        <div className={page.cellDouble}><div className={page.buttonLabel}>Status</div></div>
                    </div>
                </div>}>
                <Scrollable vertical className={classNames(page.scrollable, styles.fleetScroll)}>
                    {shown.length === 0 && <div className={page.noLines}>No depots of this type</div>}
                    {shown.map((d) => {
                        const bound = d.lines.filter((l) => l.bound).length;
                        const on = sameEntity(d.entity, picked);
                        return (
                            <div key={d.entity.index} className={item.transportationLineItem}>
                                <div className={classNames(item.container, on && styles.pickedRow)} onClick={() => setPicked(on ? NULL_ENTITY : d.entity)}>
                                    <div className={classNames(page.cellWide, page.alignLeft)}><LocalizedEntityName value={d.name} /></div>
                                    <div className={classNames(page.cellDouble, !d.hasAvailable && styles.warn)}>{d.available}</div>
                                    <div className={page.cellDouble}>{d.owned}</div>
                                    <div className={page.cellDouble}>{d.capacity}</div>
                                    <div className={page.cellDouble}>{d.lines.length}</div>
                                    <div className={page.cellDouble}>{bound}</div>
                                    <div className={classNames(page.cellDouble, d.starved && styles.warn)}>
                                        {d.starved ? (
                                            <Tooltip tooltip="A line bound to this depot is short of vehicles and the depot has none spare. Buy vehicles here or bind the line elsewhere.">
                                                <span>Starved</span>
                                            </Tooltip>
                                        ) : d.hasAvailable ? "Ready" : "Empty"}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </Scrollable>

                {current ? (
                    <>
                        <SplitHandle height={detailH} onHeight={setDetailH} />
                        <DepotDetail depot={current} lines={lines} onOpen={onOpenInPlanner} height={detailH} />
                    </>
                ) : (
                    <div className={styles.bulk}>
                        <span className={styles.sectionTitle}>Select a depot to see and bind its lines</span>
                    </div>
                )}
            </PanelSection>
        </div>
    );
};
