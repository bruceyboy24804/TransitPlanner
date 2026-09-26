// The encyclopedia's articles (XTM's glossary shape: tabs → categories → sections). Plain data so
// it can move to localisation later: every section has a stable id, and `glossary.*` style keys
// can be derived from it the way XTM does.
//
// Body markup is deliberately tiny, because Gameface lays every element out as a flex column and
// inline runs of mixed styling stack instead of flowing:
//   blank line  → new paragraph
//   "- text"    → bullet; "- **Term** rest" draws Term as a bold label beside the rest
//   "### text"  → sub-heading
//   "![caption](file.jpg)" or "![caption](file.jpg height:200)" on its own → an image (click to
//                enlarge). A bare name is TransitPlanner/Assets/Encyclopedia/<name>; coui:// and
//                Media/ paths are used as is. A missing file shows a dashed "Image missing" box.
// Any other ** is stripped.

export interface HelpSection { id: string; title: string; body: string; }
export interface HelpCategory { id: string; title: string; sections: HelpSection[]; }
export interface HelpTab { id: string; title: string; categories: HelpCategory[]; }

const s = (id: string, title: string, body: string): HelpSection => ({ id, title, body });

export const HELP_TABS: HelpTab[] = [
    {
        id: "start",
        title: "Start here",
        categories: [
            {
                id: "overview",
                title: "Overview",
                sections: [
                    s("start.what", "What Transit Planner adds",
`The vanilla game gives each transport line one slider, the vehicle count, and hides almost every number the simulation keeps about how the line is doing. Transit Planner gives every line a schedule, and shows whether that schedule is being met.

- **Schedules** Different headways, fleets and fares at different times of day.
- **Timetables** Departures on fixed times at a chosen stop, with timing points along the line.
- **Measurements** Load, waiting, lateness and leg times per hour, drawn over the schedule.
- **Fleet and depots** Vehicle models per line or per time band, and which depot supplies a line.
- **Rules** Automatic actions, for example "new bus lines get this preset".
- **Network** A map of every line of a type, with reach, gaps, catchment and live vehicles.

A line you have not touched runs exactly as in vanilla. Nothing changes until you give it a schedule.`),
                    s("start.open", "Opening the planner",
`The Transit Planner button sits with the game's own buttons in the top-left corner. It opens a floating window you can drag anywhere.

Selecting a line, stop or vehicle in the world while the window is open selects that line in the planner too. Clicking a stop or vehicle in the planner moves the camera to it.

The ? button in the window's header opens this encyclopedia at the article for the tab you are on.`),
                    s("start.layout", "Window layout",
`- **Tabs** Planner, Schedule, Timetable, Fleet, Depots, Network and Rules, across the top.
- **Public transport / Cargo** The strip under the tabs switches between passenger and freight types.
- **Type column** The column on the left picks the transport type (bus, tram, train…). Every tab shows lines of that type only.

![The planner window: tabs across the top, Public transport / Cargo, the type column, the line list and the line page](planner-line.jpg)`),
                    s("start.time", "How time works in the game",
`A game day is much shorter than it looks on the clock. The simulation measures intervals in its own seconds, and a whole day is about 4 370 of them. The planner converts every figure to clock minutes, so "every 10 min" means ten minutes on the in-game clock.

The game treats 06:00–22:00 as day and the rest as night. The timeline shades the night hours, and the vanilla day-only and night-only line policies use the same cut.`),
                ],
            },
        ],
    },
    {
        id: "planner",
        title: "Planner",
        categories: [
            {
                id: "lines",
                title: "Line page",
                sections: [
                    s("planner.list", "Line list",
`Every line of the chosen type, with its colour, fleet running / target and a load bar. A warning mark means the line is short of vehicles (the depots cannot send enough) or has been switched off.`),
                    s("planner.stats", "Line statistics",
`- **Headway** The spacing the game is actually running now.
- **Loop** How long one vehicle takes to go round the whole line.
- **Fleet** Vehicles on the line now, next to the number the game is aiming for.
- **Load** Passengers (or cargo) aboard against the capacity of the running fleet.
- **Leg times** Planned against achieved time for each leg. Legs that run slow show where traffic holds the line up.
- **Average wait per stop** Passengers waiting and how long they have waited on average. Click a row to go to the stop.

![The line page: statistics, the line map and the start of the schedule editor](planner-line.jpg)`),
                    s("planner.linemap", "Line map",
`The line unrolled into a strip: stops in order, the vehicles on it (fill = how full), and each leg coloured by how late it runs against the plan. Coloured dots under a stop are the other lines that stop there. Click a dot to open that line.`),
                    s("planner.marey", "Marey chart",
`A time–distance diagram: stops down the side, time across, one trace per vehicle. Steep means moving, flat means standing. Vehicles held at a terminus, queues behind a held vehicle and bunching are all easy to see. The chart records while the page is open, so it starts empty.`),
                ],
            },
            {
                id: "schedule",
                title: "Schedule",
                sections: [
                    s("planner.timeline", "The 24-hour timeline",
`The schedule editor draws the day from 00:00 to 24:00. Each coloured block is a band: a stretch of the day with its own rule for how often the line runs.

- Drag a band's edges to move its start or end, and its body to move it whole. Everything snaps to 5 minutes.
- Bands cannot overlap. Time not covered by any band runs as vanilla.
- The measured history is drawn behind the bands: a load area, the waiting queue, and a red tick on hours that ran over 100 % full. This shows which band is failing.`),
                    s("planner.bands", "Band modes",
`- **Vanilla** The line's own vehicle slider applies.
- **Headway** One vehicle every N minutes.
- **Frequency** N departures per game hour.
- **Ramp** The headway eases from one value to another across the band.
- **Fleet** Exactly N vehicles, however long the loop is.
- **Budget** A headway, but never more than N vehicles.
- **Target load** The fleet steps up or down, at most once a game hour, to keep this hour's load within a range.
- **Follow demand** The fleet is sized straight from this hour's history.
- **Crowding cap** Like Target load, but watches the fullest vehicle, not the average.
- **Target wait** The fleet follows the average wait at the stops (passenger lines).
- **Express** Buses drive past the stops ticked under Skip stops while the band runs.
- **Match line** Runs at a multiple of another line's headway.

Freight lines add Station stock, Cargo waiting and Convoy. See the Freight tab of this encyclopedia.`),
                    s("planner.limits", "Limits the game sets",
`- A running line always has at least one vehicle. To stop service, use closed hours instead of a huge headway.
- The game caps the headway at ten times the line's default. Longer values have no further effect.
- Every headway change makes the game re-plan the routes to each stop. Bands change on the game's line tick, not every frame, so switching bands costs little.`),
                    s("planner.closed", "Service hours and closed periods",
`Start band, End band and Closed band add grey blocks in which the line does not run. They drag like bands. Inside one, the line is switched off through the game's own Inactive policy, and the vehicles go back to their depot. Bands are clipped so they never run inside a closed block.

A line you switched off yourself stays off. The planner only undoes its own switch-off.`),
                    s("planner.fares", "Fares",
`Each band can carry its own fare. Giving a band a fare switches the line's vanilla Paid ticket policy on, which the game needs before it charges anything.

- **Fare rule: flat** The band's fare, or the line's fare.
- **Fare rule: by distance** A base price plus a price per kilometre ridden, measured along the line from the boarding stop to the exit stop.

Riders who board a train's trailing cars pay the fare too. In vanilla they ride free.`),
                    s("planner.unbunching", "Unbunching",
`When vehicles bunch, the game holds the one behind at a stop to space them out. The Unbunching row sets how strong that hold is, from 0 % (never hold) to 300 % of the vanilla hold. Vanilla keeps the game's own value.`),
                    s("planner.models", "Vehicle models per band",
`A band can ask for its own vehicle models, for example small buses early in the day and articulated ones at the peak. When the band starts, the line's model list is switched and the game replaces non-matching vehicles as they finish their trips. When no band asks for models, the line's own list comes back.`),
                    s("planner.presets", "Presets",
`A preset is a set of bands you can apply in one click, such as "Peak 5 / Off-peak 12 / Night 30". The built-in presets come with the mod. Save as preset… stores the current line's bands under a name. Your own presets are marked ★ and saved in the mod settings, so they are available in every city.`),
                    s("planner.waitload", "Wait for load",
`Wait at stops holds a vehicle at chosen stops until it is full enough:

- **At least** Always wait this long.
- **Wait until % full** Leave once the vehicle is this full.
- **Or at most** Leave after this long even if it is not full.

Vehicles behind a held one queue at the stop, so use it at termini and major stations.`),
                    s("planner.skipstops", "Skip stops (express)",
`Any passenger line can drive past chosen stops while the stops stay on the line. Tick the stops under Skip stops (express). If the line has Express bands, the stops are skipped while an Express band runs; otherwise choose All day or a time window.

- **Trips** As soon as a skip starts, new trips on this line stop starting or ending at the skipped stops. Passengers use another line or another stop.
- **Buses at ordinary stops** Buses already drive past a stop nobody asks for; while it is skipped, passengers waiting there stop asking. Riders aboard who want to get off there still stop the bus.
- **Everything else** Trains, trams, metro, ferries, planes, and buses at stations drive past a skipped stop once one full loop has gone by since the skip began, so riders who boarded before it have got off.
- **Saving** Skipped stops are put back on the line before every save and skipped again straight after, so a save is always the line as the game built it.

People who were already waiting at the stop when the skip started may wait a while before they give up and find another way. While a stop is being driven past, the line map and the Network tab may leave it out.`),
                ],
            },
        ],
    },
    {
        id: "timetable",
        title: "Timetable",
        categories: [
            {
                id: "tt",
                title: "Timetables",
                sections: [
                    s("timetable.basics", "Fixed departures",
`Normally the game spaces vehicles by headway only. A timetable holds vehicles at one stop, the anchor, until the next departure slot: first departure plus a whole number of intervals.

- **Anchor stop** Where departures are fixed. A terminus works best.
- **First departure** In 5-minute steps.
- **Interval** Time between departures.

The fleet size is still set by the schedule. The timetable only lines departures up with the clock.

![The Timetable tab: every line's timetable at a glance, the selected line's editor below](timetable-tab.jpg)`),
                    s("timetable.modes", "Following bands and set times",
`- **Follow bands** Slots restart at each band's start and use that band's headway, so the fleet the game sizes for the band matches the timetable.
- **Set times** A list of exact departure times instead of an interval.
- **Leave if late** A vehicle that arrives later than the tolerance leaves at once instead of waiting for the next slot.
- **Resync** After this many intervals without a departure the timetable starts counting slots again from scratch.`),
                    s("timetable.points", "Timing points",
`A timing point is a stop where a vehicle may not leave before its planned time: its departure slot plus the time to reach that stop. "All stops" fills every stop from the planned leg times plus a margin. The printed timetable shows stops against the next departures. Click a stop there to switch its timing point on or off.`),
                    s("timetable.punctuality", "Punctuality",
`Every timetabled departure is measured. Two clock minutes late or less counts as on time. The timeline shows lateness per hour, the Fleet tab has a Late column, and rules can react to it (Late above, On time below).`),
                    s("timetable.pulse", "Pulse at a station",
`Pulse copies a line's departures to every other line that serves the anchor stop or its station, so they all leave together and passengers can change between them.`),
                ],
            },
        ],
    },
    {
        id: "board",
        title: "Schedule board",
        categories: [
            {
                id: "board",
                title: "Schedule tab",
                sections: [
                    s("board.basics", "Every line on one axis",
`The Schedule tab shows every line of the type as a row on a shared 24-hour axis, like a signal-plan editor. Drag bands the same way as in the Planner. Drag a band or a closed block up or down onto another line to move it there, or hold Ctrl as you let go to copy it. A moved band trims the bands it lands on. A moved closed block joins the closed hours already there, and cuts the bands around it. The playhead (drag it, or Live to follow the clock) shows each line's headway and vehicles at that hour. The totals strip compares vehicles needed per hour with what the depots own.

![The Schedule tab: every bus line on one axis, with a draft from the wizard waiting to be applied](schedule-board.jpg)`),
                    s("board.draft", "Drafts and Apply",
`Edits on the board are a draft until you press Apply, because every headway change makes the game re-plan routes. Apply immediately writes each edit as you make it instead.`),
                    s("board.navigate", "Zoom, pan and select",
`Scroll over the axis to zoom, drag an empty stretch of track to pan, and double-click to fit the whole day. Tick rows to copy a band to them, apply a preset, or switch them on or off together.`),
                    s("board.templates", "Templates and groups",
`A template is a preset that lines follow. Editing the template row re-writes every line linked to it. A linked line that has been changed on its own shows ≠ tpl. Click that to bring it back in line. Groups file rows under collapsible headings with vehicles per hour.`),
                    s("board.plans", "Named plans",
`A line can keep several complete schedules, for example Weekday and Event. Switching plans stores the live bands under the current plan's name and loads the other one. A new name saves the current bands as that plan.`),
                    s("board.wizard", "Schedule wizard",
`The wizard builds schedules for many lines at once: pick lines, a day pattern with its peak hours, service hours and headways, plus options for Target load peaks, fares, unbunching and timetables. It can also shrink the result to what the depots can run. Generate drafts the result on the board for you to review and Apply.

![The schedule wizard](schedule-wizard.jpg)`),
                    s("board.problems", "Problems strip",
`Lists the hours where the depots are short, the lines that are short of vehicles, and templates that lines have drifted from. Click an item to jump to it.`),
                ],
            },
        ],
    },
    {
        id: "fleet",
        title: "Fleet & depots",
        categories: [
            {
                id: "fleet",
                title: "Fleet tab",
                sections: [
                    s("fleet.table", "The fleet table",
`The vanilla transportation overview's table, with more columns: fleet running / target, headway, load, ticket price, vehicle models, peak and quiet hours, and maximum wait. Click a column heading to sort. The row buttons (show, active, day/night) are the game's own.

![The Fleet tab](fleet.jpg)`),
                    s("fleet.bulk", "Bulk changes",
`Tick lines to change them together: switch policies such as Paid ticket and Day/Night, add or remove vehicle models (a model chip shows whether all, some or none of the ticked lines use it), or copy the first line's models to every line of the type. Changing models replaces vehicles gradually as they finish their trips.`),
                ],
            },
            {
                id: "depots",
                title: "Depots",
                sections: [
                    s("depots.tab", "Depots tab",
`Every depot of the type, with vehicles ready, owned and the depot's capacity, and the lines it serves. Select a depot to bind lines to it.

![The Depots tab with a depot selected and its lines listed below](depots.jpg)`),
                    s("depots.preferred", "Preferred depot",
`A line bound to a depot takes vehicles only from that depot. When the depot has none spare, the line waits and shows short of vehicles; it does not fall back to another depot. Such a line is marked starved. "Any depot" is the vanilla behaviour: the nearest suitable depot sends.`),
                ],
            },
        ],
    },
    {
        id: "network",
        title: "Network",
        categories: [
            {
                id: "map",
                title: "Map",
                sections: [
                    s("network.map", "The network map",
`A map of every line of the type, drawn on the city's terrain, water, roads, districts and buildings (each can be switched off). Scroll to zoom, drag to pan. Fit shows everything, and 1:1 shows one pixel per metre. The minimap shows where you are.

Stops are nodes. Larger nodes are interchanges, ringed in the colours of their lines. A halo shows how many people are waiting. Vehicles move live: the ring shows the line colour, the fill shows the load, and hollow means boarding.

![The Network tab: bus lines over terrain, water and roads, with waiting halos and the minimap](network.jpg)`),
                    s("network.list", "Line list and colours",
`The list beside the map filters everything: the checkbox hides a line, clicking its name shows only that line, and double-clicking opens it in the Planner. Problems only keeps lines that are short of vehicles or at least 90 % full. Colour: load colours each leg by how full the vehicles on it are.

![Colour: load — each leg from green (empty) to red (full)](network-load.jpg)`),
                    s("network.time", "Time scrubber",
`Pick an hour instead of Live to see the network at that time: lines that are closed fade, line width shows vehicles per hour, and load colours use that hour's history. Play steps an hour a second.`),
                ],
            },
            {
                id: "analysis",
                title: "Analysis",
                sections: [
                    s("network.reach", "Reach",
`In Reach mode, click a stop to see how many minutes it takes to reach every other stop: riding time plus half a headway to board or change. Stops are coloured in three bands up to the limit you set. Freeze keeps a result so you can change a schedule and compare: green is now closer, red further.`),
                    s("network.gaps", "Gaps and catchment",
`Catchment draws a circle of adjustable size around every stop. Gaps marks the places where many residents or workers live more than 400 m from any stop of the type. That is where a new stop would serve the most people.`),
                    s("network.board", "Departure board",
`Click a stop to open its departures in the side column: set times for timetabled lines, "every N min" for the others.`),
                ],
            },
            {
                id: "edit",
                title: "Planning on the map",
                sections: [
                    s("network.menu", "Right-click menu",
`Right-click a line to open it in the Planner, show it alone, hide it, highlight it in the world, switch it on/off or day/night, rename it, bind it to a depot, or edit its stops. Right-click a stop to go there, run Reach from it, or start a new line. Right-click a depot to bind the shown lines to it.`),
                    s("network.sketch", "Draw a new line",
`"Start a new line here" begins a sketch. Click stops in order to add them, click again to remove, then press Create. The line is built through the game's own route tool with a new colour. (Experimental.)`),
                    s("network.editstops", "Edit a line's stops",
`Click stops on the map to remove them from the line or insert them at the cheapest position, then Apply. Stops that are kept keep their history. (Experimental.)`),
                    s("network.schematic", "Schematic view",
`Redraws the network as a diagram with evenly spaced stops and straight or 45° legs, like a metro map.

![The schematic view](network-schematic.jpg)`),
                ],
            },
        ],
    },
    {
        id: "freight",
        title: "Freight",
        categories: [
            {
                id: "freight",
                title: "Cargo lines",
                sections: [
                    s("freight.page", "Freight page",
`Cargo lines get their own page: vehicles, headway, loop, utilisation, how many vehicles run empty, and the main cargo. The flow chart shows each leg as bands of cargo by resource, as thick as their tonnage. The station table shows what is arriving, held and stored, and the station's rating. Cargo is shown in kg, t or kt.

![The freight page of a cargo railway route](freight.jpg)

![The Flow view: each leg as bands of cargo by resource](freight-flow.jpg height:220)`),
                    s("freight.modes", "Freight band modes",
`- **Station stock** One vehicle more while stations are filling up, one fewer while they are emptying.
- **Cargo waiting** Follows the cargo the stations are waiting to send along the line, against what the fleet carries in one trip.
- **Convoy** Vehicles leave the departure stop only on fixed slots, and wait there to fill up, up to a limit.
- **Target load** Also works on freight: vehicles running fuller or emptier than the range add or remove one.`),
                    s("freight.wait", "Waiting for a full load",
`Tick Wait for load on a station to hold vehicles there until they are full enough or have waited long enough. The game keeps loading a held vehicle, so it leaves fuller. Removing vehicles from a cargo line never loses cargo: a vehicle leaving the line delivers what it carries first.`),
                ],
            },
        ],
    },
    {
        id: "rules",
        title: "Rules",
        categories: [
            {
                id: "rules",
                title: "Automatic rules",
                sections: [
                    s("rules.basics", "How rules work",
`A rule says: for lines of this type (optionally whose name contains some text), when this happens, do this. Rules are saved in the mod settings, not the city, so they carry over to every save. They run in list order, and a later rule wins when two change the same thing. Rules marked auto run by themselves every so often. Run all applies every enabled rule once.`),
                    s("rules.triggers", "Triggers",
`- **New line** Once, for each line the rules have not seen before.
- **Always** Every time rules run.
- **Peak load above / Quietest hour below / Load at hour above** Measured load, after at least six sampled hours.
- **Max wait above** The longest average wait at any stop.
- **Late above / On time below** Timetable punctuality.
- **Short of vehicles / Fleet above / Fleet below** The line's fleet.`),
                    s("rules.actions", "Actions",
`Each action can be left alone: vehicle models, a preset's bands, service hours, a timetable, and options (unbunching, Paid ticket, day/night, distance fare). A rule only writes when it would change something.`),
                ],
            },
        ],
    },
    {
        id: "infoview",
        title: "Infoview",
        categories: [
            {
                id: "infoview",
                title: "Transit Planner infoview",
                sections: [
                    s("infoview.basics", "The infoview",
`Transit Planner adds its own entry to the game's infoview menu. Its legend rows show live figures next to each mode, and each mode can be switched on or off.

![The Transit Planner infoview legend, with live figures under each mode](infoview-legend.jpg height:460)`),
                    s("infoview.heatmaps", "Heatmaps",
`- **Coverage** How close the ground is to a stop.
- **Frequency** Departures per hour available nearby.
- **Waiting** How many people are waiting nearby.
- **Worst wait** The longest waits nearby.
- **Unserved** Where people live or work far from any stop.
- **Reach** Minutes from the chosen stop.

At most four heatmaps show at once.`),
                    s("infoview.colours", "Buildings, vehicles and roads",
`Buildings can be coloured by coverage, reach or frequency. Vehicles can be coloured by load, or by state: running, boarding, held (by a timetable or unbunching) or bunched. Line load can colour the roads the lines run on, leg by leg.`),
                    s("infoview.reach", "Click to reach",
`While the infoview is on, click a stop in the world to make it the reach origin for the Reach heatmap and building colours.`),
                ],
            },
        ],
    },
];

/** Every section with the tab/category it sits in, for search and lookup. */
export interface HelpEntry { tab: HelpTab; category: HelpCategory; section: HelpSection; }

export const HELP_ENTRIES: HelpEntry[] = HELP_TABS.flatMap((tab) =>
    tab.categories.flatMap((category) => category.sections.map((section) => ({ tab, category, section }))));

export const findSection = (id: string) => HELP_ENTRIES.find((e) => e.section.id === id);
