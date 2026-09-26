import { useValue } from "cs2/api";
import { LocalizedEntityName } from "cs2/l10n";
import { Panel, Portal, Scrollable } from "cs2/ui";
import classNames from "classnames";
import { goTo, lines$, schedule$, selected$, stats$, timeOfDay$, visible$ } from "../bindings";
import { ScheduleEditor } from "./schedule-editor";
import { FreightDetail } from "./freight-detail";
import { PassengerWaits } from "./wait-settings";
import { SkipStops } from "./skip-stops";
import { TimetablePanel } from "./timetable-panel";
import { LineMap } from "./line-map";
import { RulesPanel } from "./rules-panel";
import { HelpButton, HelpTitle } from "./encyclopedia";
import { DepotPicker } from "./depot-picker";
import { FleetPanel } from "./fleet-panel";
import { DepotsPanel } from "./depots-panel";
import type { Entity } from "cs2/bindings";

import { NetworkPanel } from "./network-panel";
import { ScheduleBoardPanel } from "./schedule-board";

type TabId = "planner" | "schedule" | "timetable" | "fleet" | "depots" | "network" | "rules";

/** The encyclopedia article the header's ? opens on each tab. */
const helpFor: Record<TabId, string> = {
    planner: "planner.timeline", schedule: "board.basics", timetable: "timetable.basics", fleet: "fleet.table",
    depots: "depots.tab", network: "network.map", rules: "rules.basics",
};
import { DEFAULT_TYPE, GroupTabs, TypeSelection, TypeSidebar, useFirstTypeOf } from "./type-sidebar";
import { useEffect, useMemo, useRef, useState } from "react";
import { vanilla } from "../vanilla";
import { transport } from "cs2/bindings";
import { byLine, formatDuration, LineRow, sameEntity, TransportType } from "../types";
import styles from "./planner.module.scss";

export const typeLabel: Record<number, string> = {
    [TransportType.Bus]: "Bus",
    [TransportType.Train]: "Train",
    [TransportType.Taxi]: "Taxi",
    [TransportType.Tram]: "Tram",
    [TransportType.Ship]: "Ship",
    [TransportType.Post]: "Post",
    [TransportType.Helicopter]: "Helicopter",
    [TransportType.Airplane]: "Airplane",
    [TransportType.Subway]: "Subway",
    [TransportType.Rocket]: "Rocket",
    [TransportType.Ferry]: "Ferry",
};

const cssColor = (c: LineRow["color"]) =>
    `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;

const LineListRow = ({ line, selected }: { line: LineRow; selected: boolean }) => {
    const load = line.capacity > 0 ? Math.min(1, line.riders / line.capacity) : 0;
    return (
        <div
            className={classNames(styles.lineRow, selected && styles.selected)}
            onClick={() => selected$.set(line.entity)}
        >
            <div className={styles.swatch} style={{ backgroundColor: cssColor(line.color) }} />
            <div className={styles.lineMain}>
                <div className={styles.lineName}>
                    <LocalizedEntityName value={line.name} />
                </div>
                <div className={styles.lineMeta}>
                    <span>{typeLabel[line.type] ?? "?"}</span>
                    <span className={line.notEnoughVehicles ? styles.warn : undefined}>
                        {line.fleet}/{line.target} vehicles
                    </span>
                    <span>every {formatDuration(line.headway)}</span>
                    {line.scheduled && <span className={styles.badge}>scheduled</span>}
                </div>
                <div className={styles.loadBar}>
                    <div className={styles.loadFill} style={{ width: `${load * 100}%` }} />
                </div>
            </div>
        </div>
    );
};

const Stat = ({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
    <div className={styles.stat}>
        <div className={styles.statLabel}>{label}</div>
        <div className={classNames(styles.statValue, warn && styles.warn)}>{value}</div>
    </div>
);

const LineDetail = ({ line, onOpenTimetable }: { line: LineRow; onOpenTimetable: () => void }) => {
    const stats = useValue(stats$.binding);
    const schedule = useValue(schedule$.binding);
    const now = useValue(timeOfDay$.binding);
    if (!stats.valid || !sameEntity(stats.entity, line.entity)) {
        return <div className={styles.empty}>Reading line…</div>;
    }

    const load = stats.capacity > 0 ? Math.round((100 * stats.riders) / stats.capacity) : 0;

    // One scroll for the whole column: the band editor grows when a band is selected, and it is
    // this column that should move, never the panel.
    return (
        <Scrollable vertical className={styles.detail}>
            <div className={classNames(styles.detailTitle, styles.row)}>
                <vanilla.ColorField value={line.color} className={styles.detailColor} onChange={(c) => transport.setLineColor(line.entity, c)} />
                <LocalizedEntityName value={line.name} />
            </div>

            <div className={styles.statGrid}>
                <Stat label="Headway" value={formatDuration(stats.headway)} />
                <Stat label="Default" value={formatDuration(stats.defaultHeadway)} />
                <Stat label="Loop" value={formatDuration(stats.stableDuration)} />
                <Stat label="Vehicles" value={`${stats.fleet} / ${stats.target}`} warn={stats.notEnoughVehicles} />
                <Stat label="Load" value={`${load}% (${stats.riders}/${stats.capacity})`} />
                <Stat label="Unbunching" value={stats.unbunching.toFixed(2)} />
                <Stat label="Fare" value={stats.paidTicket ? `${stats.ticketPrice}` : "free"} />
                <Stat label="Stops" value={`${stats.stops.length}`} />
            </div>

            <HelpTitle className={styles.sectionTitle} title="Line map" section="planner.linemap" />
            <LineMap />

            {sameEntity(schedule.entity, line.entity) && <ScheduleEditor schedule={schedule} now={now} line={line} stats={stats} onOpenTimetable={onOpenTimetable} />}

            {sameEntity(schedule.entity, line.entity) && <PassengerWaits schedule={schedule} stops={stats.stops} />}
            {sameEntity(schedule.entity, line.entity) && <SkipStops schedule={schedule} stops={stats.stops} />}

            <DepotPicker line={line} />


            <HelpTitle className={styles.sectionTitle} title="Average wait per stop" section="planner.stats" />
            {stats.stops.map((s) => (
                <div key={s.stop.index} className={styles.stopRow} onClick={() => goTo(s.stop)}>
                    <LocalizedEntityName value={s.name} />
                    <span>{`${s.waiting} waiting · ${formatDuration(s.averageWait)}`}</span>
                </div>
            ))}
        </Scrollable>
    );
};

/** The floating planner window. Rendered through a Portal so it floats over the game UI. */
export const PlannerPanel = () => {
    const visible = useValue(visible$.binding);
    const unsorted = useValue(lines$.binding);
    const lines = useMemo(() => [...unsorted].sort(byLine), [unsorted]);
    const selected = useValue(selected$.binding);
    const [tab, setTab] = useState<TabId>("planner");
    const [typeSel, setTypeSel] = useState<TypeSelection>(DEFAULT_TYPE);
    const firstTypeOf = useFirstTypeOf();
    const current = lines.find((l) => sameEntity(l.entity, selected));
    // A selection made outside the list (world follow, an interchange dot) may be of another
    // type: move the sidebar to it so the line is visible in the list. Hooks come before the
    // visibility early-return, or React counts a different number of them per render.
    useEffect(() => {
        if (current && (current.type !== typeSel.type || (current.cargo ?? false) !== typeSel.cargo)) {
            setTypeSel({ type: current.type, cargo: current.cargo ?? false });
        }
    }, [current?.entity.index]);
    // The vanilla Panel wraps its children in its own Scrollable, whose wrapper is block-level
    // and sized to content, so nothing below ever filled the panel. Its class is the game's
    // hashed one, so it is reached from the body up rather than named: content → scrollable.
    // No dependency list: the Panel builds its Scrollable wrapper after our first effect ran, so
    // the styles are (re)applied after every render — two string compares when already set.
    const bodyRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const content = bodyRef.current?.parentElement;
        const scrollable = content?.parentElement;
        for (const el of [content, scrollable]) {
            if (!el || el.style.height === "100%") continue;
            el.style.height = "100%";
            el.style.flex = "1 1 auto";
            el.style.minHeight = "0";
        }
    });
    if (!visible) return null;

    const shownLines = lines.filter((l) => l.type === typeSel.type && (l.cargo ?? false) === typeSel.cargo);
    // The transportation overview's header, verbatim: a PanelTitleBar over a TabBar of Tabs.
    // (PanelTitleBar would add a second close button from the panel context, and the draggable
    // header lays its children out in a row, so: the theme's title class in a column wrapper.)
    const { TabBar, Tab } = vanilla;
    const select = (id: string | number) => setTab(id as TabId);
    const openInPlanner = (r: { entity: Entity; type: TransportType; cargo?: boolean }) => {
        selected$.set(r.entity);
        setTypeSel({ type: r.type, cargo: r.cargo ?? false });
        setTab("planner");
    };
    const header = (
        <div className={styles.header}>
            <div className={vanilla.iceflakePanel.title}>Transit Planner</div>
            <div className={styles.headerHelp}><HelpButton section={helpFor[tab]} tooltip="Encyclopedia" /></div>
            {/* Seven tabs at the theme's 200rem minimum overflow the panel (Rules ran under the
                close button): headerTabs lets them share the width. */}
            <div className={styles.headerTabs}>
            <TabBar>
                <Tab id="planner" selectedId={tab} onSelect={select}>Planner</Tab>
                <Tab id="schedule" selectedId={tab} onSelect={select}>Schedule</Tab>
                <Tab id="timetable" selectedId={tab} onSelect={select}>Timetable</Tab>
                <Tab id="fleet" selectedId={tab} onSelect={select}>Fleet</Tab>
                <Tab id="depots" selectedId={tab} onSelect={select}>Depots</Tab>
                <Tab id="network" selectedId={tab} onSelect={select}>Network</Tab>
                <Tab id="rules" selectedId={tab} onSelect={select}>Rules</Tab>
            </TabBar>
            </div>
        </div>
    );

    return (
        <Portal>
            <Panel
                draggable
                header={header}
                theme={vanilla.iceflakePanel}
                contentClassName={styles.content}
                className={styles.panel}
                initialPosition={{ x: 0.5, y: 0.5 }}
                onClose={() => visible$.set(false)}
            >
                <GroupTabs cargo={typeSel.cargo} onSelect={(cargo) => setTypeSel(firstTypeOf(cargo))} />
                <div ref={bodyRef} className={styles.body}>
                <TypeSidebar selected={typeSel} onSelect={setTypeSel} />
                {tab === "rules" ? <RulesPanel typeSel={typeSel} /> : tab === "schedule" ? (
                    <ScheduleBoardPanel typeSel={typeSel} onOpenInPlanner={(entity) => openInPlanner({ entity, type: typeSel.type, cargo: typeSel.cargo })} />
                ) : tab === "timetable" ? (
                    <TimetablePanel typeSel={typeSel} />
                ) : tab === "network" ? (
                    <NetworkPanel typeSel={typeSel} onOpenInPlanner={(entity, type, cargo) => openInPlanner({ entity, type, cargo })} />
                ) : tab === "depots" ? (
                    <DepotsPanel typeSel={typeSel} onOpenInPlanner={openInPlanner} />
                ) : tab === "fleet" ? (
                    <FleetPanel typeSel={typeSel} onOpenInPlanner={openInPlanner} />
                ) : (
                <>
                    <div className={styles.lineList}>
                        <Scrollable vertical className={styles.lineListScroll}>
                            {shownLines.length === 0 && <div className={styles.empty}>No lines of this type.</div>}
                            {shownLines.map((line) => (
                                <LineListRow
                                    key={line.entity.index}
                                    line={line}
                                    selected={sameEntity(line.entity, selected)}
                                />
                            ))}
                        </Scrollable>
                    </div>
                    {!current ? <div className={styles.empty}>Select a line.</div>
                        : current.cargo ? <FreightDetail line={current} onOpenTimetable={() => setTab("timetable")} />
                        : <LineDetail line={current} onOpenTimetable={() => setTab("timetable")} />}
                </>
                )}
                </div>
            </Panel>
        </Portal>
    );
};
