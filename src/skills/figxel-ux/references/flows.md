# Flows — the task, the steps, a screen per step

A screen drawn before its flow answers the wrong question: it shows what the product has, not what a person does with it. Plan the flow in the reply first, record it in the brief, then build.

## The task in one sentence

Who does what, in which situation: "a member books a 45-minute bench slot from a phone, standing next to a broken bike". It goes into `details.task`. Every success line follows from it: how many steps, what must show without scrolling, what the person has in hand when they finish. A request with two tasks ("book a slot and manage my membership") is two flows; at the page gear, design the one the brief's goal names and list the other as next work.

## The flow as steps

Write the steps from the person's side, each a verb: arrive, choose a day, pick a slot, confirm, see the booking. For each step, one line: what they see, what they decide, what they do next. Then add the paths a happy path hides:

- **The way back.** Every step can be left or undone: a back, a cancel, a change of mind before a commitment.
- **The error path.** Every step that takes input has a wrong input (a full slot, an expired card, a typo in the email) and what the screen says then.
- **The first time and the empty case.** A new account with nothing in it; a search with no result; a day with no free slot.
- **The wait.** Every step that fetches or saves has a moment with nothing yet to show.

Up to about five screens is the page gear; more is a top-gear concept or two briefs.

## One screen per step, with its states

Each step is a screen, and each screen lists the states it needs beyond its default:

| State | Needed when |
|---|---|
| empty | the screen shows a list or data that can be absent: first use, no results, all cleared |
| loading | anything is fetched or saved; a skeleton for a whole screen, a spinner for one part (section `states`) |
| error | the fetch can fail, or the screen takes input |
| success | an action commits something: say what happened and what comes next |
| offline | the product promises to work without a connection |

Declare them in the brief, each screen by its frame name, so the sign-off can find a frame for every state: `screens: [{ name: "Booking / 02 Slots", states: ["empty", "loading", "error"] }]`. The default state is the screen itself and is not listed.

## Information architecture

- Group by the person's words and tasks, not by the organisation's departments; a label is what the reader would call it.
- One primary action per screen, in the same place on every screen of the flow; secondary actions look secondary.
- Navigation shows where the person is and how to go back. A flow with steps shows the step and how many remain.
- What the person needs to decide sits on the screen where they decide it: the price beside the button that books, not two screens earlier.

## Viewports and the fold

Name the target viewports in `details.viewport`: "390x844" for one phone, or a list such as ["390x844", "1440x900"] for a responsive page. Build each screen at its viewport's width, so the frame's pixels are the device's units and the audits measure targets and text directly; at any other width they convert with the viewport, as the design skill's `brief` section describes.

The fold is a success line, not a safe zone: name what must show without scrolling at the target viewport (the message and the primary action, usually) and measure it as the design skill's `brief` section says. Never pass it as `safeArea`.

Responsive web: build the narrowest viewport first, then widen. A page must still read in one column at a width of 320 CSS px, with no sideways scrolling, except parts such as a data table or a map that need two dimensions.

## Platform patterns

- **iOS.** Content and controls stay inside the safe area, clear of the status bar, the Dynamic Island and the home indicator. Apple publishes no inset table per device, so record the insets you design to in `details.insets` ({ top, bottom, source }, in points), with where the numbers came from; the a11y audit reports a control inside them.
- **Android.** An app targeting SDK 35 draws edge to edge on Android 15 and later: behind the status bar and the navigation bar. Keep tappable controls out of the system-bar insets, recorded the same way, in dp.
- **Web and desktop.** No safe area: margins come from the grid (the design skill's `system` section). Pointer platforms have hover; touch ones do not, so nothing important lives only in a hover state.
- **Every platform.** Match the conventions the person already knows on it: where the back control sits, how a list item opens, what a destructive action looks like. Break one only when the brief needs it, and say why in the report.

## Names and layout on the canvas

- A screen is a top-level frame named `<Flow> / <nn> <Screen>`: "Booking / 02 Slots". A state is its own top-level frame named `<screen name> / <State>`: "Booking / 02 Slots / Empty", exactly the screen name the brief declares, so the `states` audit finds it.
- Lay the screens left to right in step order, each screen's states in a column below it, a spacing step apart.
- More than three screens: set the prototype's starting point with figma_set_prototype_flows { flows: [{ nodeId: <the first screen>, name: "Booking" }] }, and wire the steps with figma_set_reactions when the brief asks for a prototype (the prototype skill).

## The brief call for this flow

figma_set_brief { role: "ux", gear: "page", title: "Bench booking", goal: "members book a bench slot online", audience: "neighbours on a phone, next to a broken bike", message: "You fix your own bike here, with a mechanic beside you.", proof: ["six repair stands", "45-minute slots for £8, tools included"], constraints: ["opening hours on every screen", "only fonts this file loads"], givens: "the co-op's logo and green; no other styles in the file", success: ["a visitor books within one scroll at 390 x 844", "every screen state in details.screens has its frame"], tone: { words: ["hands-on", "plain", "welcoming"], not: "cute" }, format: "390x844 px phone, 1440x900 px desktop", details: { platform: "responsive", viewport: ["390x844", "1440x900"], task: "book a 45-minute bench slot", screens: [{ name: "Booking / 02 Slots", states: ["empty", "loading", "error"] }, { name: "Booking / 03 Confirm", states: ["error", "success"] }] } }

The result's `briefId` is the brief's id: pass it to every later figma_set_brief, to figma_check_layout and to figma_sign_off. `lint` names a line to fix now; `missingForSignOff` lists what sign-off will ask for at the end.

Evidence (claim ids, for maintainers): [C-383] [C-270] [C-351] [C-359] [C-364] [C-385] [C-388] [C-390]
