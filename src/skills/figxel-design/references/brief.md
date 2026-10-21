# The brief, and looking before you design

## Why write it

The brief is the record every later step is judged against: each critique lens re-reads it, and the report quotes it as built. A request is not a brief: "a landing page for a bike repair co-op" names a format; the brief decides who it is for, what it must say, and how anyone will know it worked. One brief per problem, settled before the first frame.

You write it; you do not interview the user for it. Infer it from the request, the file and the subject. When the message or the audience is unclear, pick the more likely reading, write it into the brief (`assumptions`) and flag it first in the report. Do not stop to ask: a checkpoint shows the assumption for approval; without one, the report lists it.

## The seven lines

1. **Goal.** What should change for the business or the person: buy, book, sign up, understand, trust. One verb.
2. **Audience.** Who, where they meet the work (a phone in a feed, a laptop at a desk, a poster across a street, a projector in a meeting room), and what they already know. Then the scene, one sentence in `audience` too: who, where, under what light ("a dispatcher by a window, all day, two monitors"). The scene decides light or dark; dark needs its reason there (a dim room, night use, a picture that must glow), never "the category is dark". Dark the user asked for is a given, recorded with its scene.
3. **Message.** The one sentence a stranger should take away. If it needs "and", choose: the other half becomes proof, or it goes.
4. **Proof.** Two or three facts that make the message believable: a number, a material, a name, a place. When a fact belongs to the user (prices, clients, a bio), write a plausible placeholder and list it in the report.
5. **Constraints.** Format and size; mandatory content; the givens; the families the direction will use (section `directions`, Type). Then what every check will need:
   - **Givens: whose system is this?** Read the file's styles and variables (figma_get_styles, figma_get_variable_defs, and `stylesUsed` from figma_get_design_context on an existing screen), then say whose they are from their names, the file's name and the screens that use them. The first case that fits decides:
     1. The user pointed at them, or the work extends a design that uses them: givens, used and never re-decided.
     2. They belong to another brand or product: reference, read but never applied to this work and never edited.
     3. They are this brief's brand and match one of the six looks below on two or more features: ask the user once whether that look is the brand's own; it changes the whole result.
     4. They are this brief's brand, or nobody's, and match no look: givens.
     5. Nobody's, and they match a look: reference. A generated default saved as styles is still a default.

     Write the verdict in the brief's `givens` ("givens: none; the file's styles are another brand's, kept as reference") and among the report's assumptions.
   - **Text floor in frame pixels.** Sizes for a device are device pixels; a styleframe is built in frame pixels. Frame px = device px × frame width ÷ device width: a 16 px floor on a 390-wide phone is about 44 px on a 1080-wide frame. Write the result and pass it as `minTextSize` on every figma_check_layout. No text goes under it, and nothing sits just above it: the next size up is at least one ratio step higher (section `system`).
   - **Safe zones** exist only where something covers part of the frame: a platform's interface over a story or a reel, a screen's overscan, a print's trim. Read them from the placement's current published spec, with the source and the date. A client that cannot read the web uses figures registered here with their date (Meta's Stories figures, read 2026-10-13) marked "not re-read"; for a covered placement with no registered figures, write the zones you assume, marked "unverified, from memory, <date>", keep text, logo and CTA well inside them, pass them as `safeArea`, and put "safe zones unverified" first in the report.
   - **A web or app view has no safe zone:** pass no `safeArea`; its margins come from the grid (section `system`). Its fold is a success line instead: name the viewport the brief targets (say 1440 × 900, or 390 × 844) and what must show without scrolling, usually the message and the action. Measure it with figma_get_design_context { nodeId: <the view>, absolute: true }: each such node's bottom (`abs` y + height, less the view's `abs` y) is at most the viewport height. Never pass the fold as `safeArea`: everything meant to sit below it would be flagged.
6. **Success.** What the viewer does or remembers, then the checks that follow from it, written so a tool or a render can confirm them: "the price reads in the squint render", "the Book button is visible without scrolling on a 390 × 844 screen", "body text is 16 px or more on the device".
7. **Tone.** Three words, and one word it must not be. Take them from the subject and the audience, not from the words every default claims ("modern", "clean", "premium", "elegant").

A worked brief (the page gear), for a booking page of a community bike repair co-op:

- Goal: members book a bench slot online instead of queuing on Saturday morning.
- Audience: neighbours on a phone, often standing next to a broken bike; they know the co-op by sight, not its prices or hours. Scene: a yard in daylight, so a light ground.
- Message: you fix your own bike here, with a mechanic beside you.
- Proof: six repair stands; 45-minute slots for £8, tools included; 3,100 repairs last year (the numbers are placeholders).
- Constraints: 390 px first, 1440 px second; the co-op's logo and green are given; opening hours are mandatory; only fonts this file loads; text 16 px or more on the phone (the 390 frame is the device, so `minTextSize` 16); no safe zone, and the fold is 844 on the phone.
- Success: a visitor books within one scroll; the slot price reads in the squint render; every text 16 px or more on the phone.
- Tone: hands-on, plain, welcoming; not cute.

## Look before you design

Before any direction, one pass on where the design could come from, so it does not look like everything else.

- **The subject's world.** List eight or more of its materials, tools, words, artefacts, places and rhythms. Then strike out the first three you wrote: they are the associations every similar brief reaches first. Choose two or three from the rest that could carry a design. For the co-op, the first three were a wrench, a chain and a smiling volunteer; what is left includes the bench timetable cut into 45-minute blocks, the galvanised grey of the parts bins, hand-lettered bin labels, and the rhythm of six stands side by side.
- **The category default.** Name what three peers in the category all do. For bike shops: a rider at sunset as the hero, a centred headline over it, three icon cards for Repair, Service and Parts. Keep the conventions people rely on (the hours near the top, the price beside the button that books) and break the habits that are only habits.
- **The generated default.** Generated design falls into six looks: warm off-white with a high-contrast serif and a clay accent; near-black with one acid accent; the broadsheet of hairlines, square corners and dense columns; the software kit of identical rounded cards with one soft shadow; template chrome (tracked capital labels, middle-dot meta strings, an arrow on every button); the dashboard kit (icon tiles on cards, a sparkline per figure, a greeting title, accent on chrome). Note the one this brief would drift into; section `tells` counts their features when one comes close.
- **References, by name, with what you take.** "A railway timetable: take its dense grid of times for the slots; leave its tiny type." "A workshop manual: take numbered exploded diagrams for the four steps of a repair, a real sequence; leave its beige." Never copy a reference's layout or its assets into the work; take a principle. Without web access, name them from memory: their value is in what you take.

Write the default to avoid as one line of the brief (`defaultToAvoid`): "The default here is a lifestyle photo, a centred headline and three icon cards; this page avoids it by leading with the day's slots." Section `directions` turns it into Direction 0.

### The avoid list

Checks match `avoid`, not that line: record what it and Direction 0 name as tells kinds (section `tells`). For the line above, figma_set_brief { briefId, avoid: ["mostly_centred", "card_trio"] }; the photo stays prose. From the page gear up each is a warning that fails sign-off; only the owner takes one off.

## Where the brief lives

figma_set_brief records it before the first new frame.

- Section gear: lines 1, 3 and 6 in the reply, and figma_set_brief { role, gear: "section", title, goal, message, success, details }.
- Page gear and up: every line, figma_set_brief { role, gear, title, goal, message, success, audience, proof, constraints, givens, tone, format, defaultToAvoid, avoid, details }, `format` with a size and unit ("390x844 px phone"). It draws a "Brief · <title>" block at an empty spot on `pageId`, else on an "Explorations" page (figma_create_page; a section "Explorations" if a Starter file refuses a fourth page, said in the report). A motion piece uses its Storyboard page.
- Its result: `briefId` for every later call, `lint` to fix now, `missingForSignOff`, what sign-off will ask.
- Record each decision: figma_set_brief { briefId, direction0, directions, chosen, styleframes } after the choice, { briefId, system } once the numbers are set; from the page gear up, sign-off needs them.
- A later session reads it, never writes a second: figma_get_brief lists the open briefs, { briefId } adopts one.

The block is a working note: the audits skip it and its font is the tool's default, so never type-check it.

Evidence (claim ids, for maintainers): [C-236] [C-085] [C-233] [C-219] [C-048] [C-269] [C-270]
