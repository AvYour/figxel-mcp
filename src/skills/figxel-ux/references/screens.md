# Screens — app screens and dashboards people work in

An app screen is opened to answer a question and to do a job, many times a week. It is judged by how fast it does both, not by how full it looks. The generated default is a dashboard kit: a greeting for a title, a row of tiles each with an icon, a big coloured number, a "+%" pill and a sparkline, a navy sidebar, the accent on every tab and border. Each part is a habit, not a decision. This section is what a product designer decides instead, for app screens, dashboards, admin and settings areas; a page that persuades is the design skill's.

An app screen is an operate view (the design skill's `system` section, Mode): it borrows only type, palette, density and one signature move from its world, and the task decides the rest. Light or dark comes from the brief's scene sentence (design `brief`), never from "dashboards are dark".

## One question, one finding

Before the layout, write two lines for every screen of the flow (section `flows`), in the reply and in the report:

- **The question** the person opens it with, in their words: "Which benches are free in the next hour?"
- **The finding** the screen leads with, as it would read on a real day: "Bench 4 frees up at 10:45; two bookings are running late."

Then build to them:

- **The largest block answers the question.** It is the largest block of the content area and the first in reading order; everything else is smaller and later. Compare the blocks' sizes in figma_get_design_context { nodeId: <the screen> }, then look at the squint render (the design skill's `finish` section): the answer leads, or the layout is wrong.
- **The main job is one click away.** The action people take most often from this screen is a visible control above the fold at the target viewport (section `flows`): never inside a menu, never only on hover.
- **A title that names, no greeting.** The title is the screen's noun, as the navigation calls it: "Bench schedule", "Late bookings". A greeting ("Good morning, Sam") takes the top line from the finding; a personal touch, when the brief wants one, sits lower and smaller.
- **One element only this product has.** Name it in the reply: a part that would make no sense in a competitor's product, taken from the subject's world (design `brief`, the look). For the co-op it is the six stands as a row of bench blocks across the day, which can carry the finding itself. A screen built only from the kit's parts (cards, tiles, a line chart) passes the swap test for any product, and the originality lens scores that as a major.

## Chrome and colour

- **The sidebar on the page ground.** Navigation shares the page's ground, or one step of its neutral ramp, set apart by a hairline or by space. A saturated or navy sidebar spends the strongest colour on the part people look at least.
- **The accent on data, not chrome.** The accent marks what needs attention in the data (the late booking, the series being compared, a value over its limit) and the main action. Headers, the sidebar, tabs, icons and borders stay neutral. List every fill in the accent with figma_get_design_context: each one points at data or at the main action, or it is chrome to take back to neutral.
- **The current place by more than colour:** a weight, a neutral fill or an indicator bar on the current navigation item, and the filled icon where the set has one (design `system`, Icons).
- **Status with a second cue.** Late, failed or over the limit is said in words or with an icon as well as a colour (section `accessibility`).

## Numbers

- **KPIs as type, in one container.** The headline figures sit in one row, each a label and a value set in the type scale, divided by hairlines or space inside a single container. Not a row of tiles, each with an icon chip, a coloured value, a "+%" pill and a sparkline. Figxel's starting point, to test against the brief: four figures or fewer in the row; more is a table.
- **A change only where someone acts on it.** A delta is text with its sign and its period ("+12 % on last week"); colour is its second cue, never its only one. A trend that is the finding gets a real chart, with axes and labels, in the largest block; a sparkline on every figure is decoration.
- **Tabular figures, right-aligned.** Figures in a column are right-aligned under a header aligned the same way, with the unit in the header and one count of decimals per column. Their digits need one width each (tabular figures), or the column wobbles. Figxel's tools do not set OpenType features, so test the face: two texts, "1111" and "0000", at the same size and weight, then figma_get_nodes_info { nodeIds }: equal widths mean tabular figures. When they differ, set the figures in a face whose digits share a width, or keep it with the reason in the report.
- **Lining figures** for every number, as the design skill's `system` section says.

## Zero, empty and first use

- **An honest zero.** A count of nothing shows 0 and says what it means: "0 late bookings today". A measure with no data yet says so ("No bookings yet this week") instead of a 0 that pretends to be a measurement.
- **Empty leads to the first action.** A new account's screen gives its largest block to the first job (book the first slot, import the members, connect a calendar), with one button that does it; never a grid of empty tiles and zeros. Section `content` has the words, section `states` the frames.

## Pattern recipes

Each recipe is one good answer to a common need, not a house style: another brief may need another answer. Each says when it fits, what it is, and how it is measured.

### A settings area

- **When:** options someone changes rarely and scans to find one: account, workspace, notifications, billing.
- **What:** grouped rows with inline controls. A heading per group; one row per setting, its label and a line of description at the start and its control (a switch, a select, a button) at the end of the same row; rows divided by hairlines or space, not each in a card. Dangerous settings in their own group, last. Say how a change saves: at once for a switch, one save per group otherwise. Compose each page for its content: billing leads with the plan and a table of invoices, members with a table, notifications with rows. One row component, never one skeleton eight times.
- **Measured:** every control shares its row with its label; a group's controls share one end edge (`no_shared_edge` otherwise); no `card_trio` or `nested_cards`; the keyboard walk reaches the rows in reading order (section `accessibility`).

### A dense data table

- **When:** people compare, sort or scan many records of one shape: bookings, invoices, members.
- **What:** a header row in the reader's words, units in the header; text left, figures right and tabular; the identifying column first and widest; row dividers or alternating fills, never both; row actions at the row's end, visible without hover on touch; a selection box first when rows are acted on together; a header that stays put while the body scrolls; the count at the end ("1–50 of 1,284"). Each row is an instance of one row component (figma_create_instance). Figxel's starting point for the row height, to test against the brief: about 36 px for a tool used all day, about 48 px for occasional use, both at desktop 1x.
- **Measured:** each figure column's cells and header share one end edge; figma_stress_test { nodeId: <the table> } passes `numbers` (large values fit) and `many` (the body scrolls: figma_set_scroll_behavior { nodeId, overflow: "vertical" }); the states audit finds its empty, loading and error frames.

### An empty state

- **When:** a list, a table or a screen that can hold nothing: first use, a filter that matches nothing, everything done.
- **What:** in the content's place and at its size, say which of the three it is, what will appear, and the one action that changes it: create or import for first use, clear the filter for no match, nothing to do when all is done ("Every booking is checked in"). An illustration only when the direction has one, and smaller than the words.
- **Measured:** a frame named `<screen name> / Empty` (the states audit); its action names what it does (the copy audit's `generic_label`); the stress test's `empty` case shows it instead of a collapsed layout.

### A command bar

- **When:** a tool with many actions or records that returning people reach by name, on the desktop or the web with a keyboard.
- **What:** one field over the content, opened by a shortcut written beside a visible trigger, so pointer and touch users have a way in too. Results grouped by kind (actions, records, places), each row its name, its kind and its shortcut; the first result selected, so Enter runs it; recent items for an empty query; a no-result row that repeats the query and offers the nearest action.
- **Measured:** a frame for each state: open and empty, with results, no result; the selected row marked by more than colour; focus in the field when it opens, written in the notes for the developer (section `accessibility`, the keyboard walk).

## After each screen

figma_check_layout { nodeId: <the screen>, audit: ["craft", "a11y", "states", "copy", "tells"], briefId }, then the read and the squint. The answer leads; the accent sits only on data and the main action; the title names; the element only this product has is there.

Evidence (claim ids, for maintainers): [C-400]
