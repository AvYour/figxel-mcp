# The brief, and looking before you design

## Why write it

The brief is the record every later step is judged against: each critique lens re-reads it before it scores, and the report quotes it at the end. A request is not a brief. "A landing page for a bike repair co-op" names a format; the brief decides who it is for, what it must say, and how anyone will know it worked. Write one brief per problem, and settle the strategy before the first frame.

You write it; you do not interview the user for it. Infer it from the request, the file and the subject. When the message or the audience is unclear (two products and no hint which one leads, a page that could be for buyers or for investors), pick the more likely reading, write that assumption into the brief block, and flag it at the top of the report. Do not stop to ask: with a checkpoint, the assumption is shown there for approval; without one, the report lists what you assumed.

## The seven lines

1. **Goal.** What should change for the business or the person: buy, book, sign up, understand, trust. One verb.
2. **Audience.** Who, where they meet the work (a phone in a feed, a laptop at a desk, a poster across a street, a projector in a meeting room), and what they already know.
3. **Message.** The one sentence a stranger should take away. If it needs "and", choose: the other half becomes proof, or it goes.
4. **Proof.** Two or three facts that make the message believable: a number, a material, a name, a place. When a fact belongs to the user (prices, clients, a bio), write a plausible placeholder and list it in the report.
5. **Constraints.** Format and size; mandatory content; the givens; the families the direction will use (section `directions`, Type). Then what every check will need:
   - **Givens: whose system is this?** Read the file's styles and variables (figma_get_styles, figma_get_variable_defs, and `stylesUsed` from figma_get_design_context on an existing screen), then say whose they are from their names, the file's name and the screens that use them. The first case that fits decides:
     1. The user pointed at them, or the work extends a design that uses them: givens, used and never re-decided.
     2. They belong to another brand or product: reference, read but never applied to this work and never edited.
     3. They are this brief's brand and match one of the five looks below on two or more features: ask the user once whether that look is the brand's own; it changes the whole result.
     4. They are this brief's brand, or nobody's, and match no look: givens.
     5. Nobody's, and they match a look: reference. A generated default saved as styles is still a default.

     Write the verdict in the brief block ("givens: none; the file's styles are another brand's, kept as reference") and among the report's assumptions.
   - **Text floor in frame pixels.** Sizes for a device are device pixels; a styleframe is built in frame pixels. Frame px = device px × frame width ÷ device width: a 16 px floor on a 390-wide phone is about 44 px on a 1080-wide frame. Write the result and pass it as `minTextSize` on every figma_check_layout. No text goes under it, and nothing sits just above it: the next size up is at least one ratio step higher (section `system`).
   - **Safe zones** exist only where something covers part of the frame: a platform's interface over a story or a reel, a screen's overscan, a print's trim. Read them from the placement's current published spec, with the source and the date. A client that cannot read the web uses figures registered here with their date (Meta's Stories figures, read 2026-10-13) marked "not re-read"; for a covered placement with no registered figures, write the zones you assume, marked "unverified, from memory, <date>", keep text, logo and CTA well inside them, pass them as `safeArea`, and put "safe zones unverified" first in the report.
   - **A web or app view has no safe zone:** pass no `safeArea`; its margins come from the grid (section `system`). Its fold is a success line instead: name the viewport the brief targets (say 1440 × 900, or 390 × 844) and what must show without scrolling, usually the message and the action. Measure it with figma_get_design_context { nodeId: <the view>, absolute: true }: each such node's bottom (`abs` y + height, less the view's `abs` y) is at most the viewport height. Never pass the fold as `safeArea`: every line meant to sit below it would be flagged, and `unbalanced_space` would judge the fold instead of the frame.
6. **Success.** What the viewer does or remembers, then the checks that follow from it, written so a tool or a render can confirm them: "the price reads in the squint render", "the Book button is visible without scrolling on a 390 × 844 screen", "body text is 16 px or more on the device".
7. **Tone.** Three words, and one word it must not be. Take them from the subject and the audience, not from the words every default claims ("modern", "clean", "premium", "elegant").

A worked brief (the page gear), for a booking page of a community bike repair co-op:

- Goal: members book a bench slot online instead of queuing on Saturday morning.
- Audience: neighbours on a phone, often standing next to a broken bike; they know the co-op by sight, not its prices or hours.
- Message: you fix your own bike here, with a mechanic beside you.
- Proof: six repair stands; 45-minute slots for £8, tools included; 3,100 repairs last year (the numbers are placeholders).
- Constraints: 390 px first, 1440 px second; the co-op's logo and green are given; opening hours are mandatory; only fonts this file loads; text 16 px or more on the phone (the 390 frame is the device, so `minTextSize` 16); no safe zone, and the fold is 844 on the phone.
- Success: a visitor books within one scroll; the slot price reads in the squint render; every text 16 px or more on the phone.
- Tone: hands-on, plain, welcoming; not cute.

A section gear needs only lines 1, 3 and 6, in the reply.

## Look before you design

Before any direction, spend one pass on where the design could come from. This is the step that keeps the work from looking like everything else.

- **The subject's world.** List eight or more of its materials, tools, words, artefacts, places and rhythms. Then strike out the first three you wrote: they are the associations every similar brief reaches first. Choose two or three from the rest that could carry a design. For the co-op, the first three were a wrench, a chain and a smiling volunteer; what is left includes the bench timetable cut into 45-minute blocks, the galvanised grey of the parts bins, hand-lettered bin labels, the repair log's running count, and the rhythm of six stands side by side.
- **The category default.** Name what three peers in the category all do. For bike shops: a rider at sunset as the hero, a centred headline over it, three icon cards for Repair, Service and Parts. That is the look this design will be mistaken for. Keep the conventions people rely on (the hours near the top, the price beside the button that books) and break the habits that are only habits.
- **The generated default.** Generated design falls into five looks: warm off-white with a high-contrast serif and a clay accent; near-black with one acid accent; the broadsheet of hairlines, square corners and dense columns; the software kit of identical rounded cards with one soft shadow; template chrome (tracked capital labels, middle-dot meta strings, an arrow on every button). Note the one this brief would drift into; section `tells` counts their features when one comes close.
- **References, by name, with what you take.** "A railway timetable: take its dense grid of times for the slots; leave its tiny type." "A workshop manual: take numbered exploded diagrams for the four steps of a repair, a real sequence; leave its beige." Each reference names what is taken and what is left. Never copy a reference's layout or its assets into the work; take a principle.
- **No web access** is no obstacle: name references from memory. Their value is in what you decide to take.

Write the default to avoid as one line of the brief: "The default here is a lifestyle photo, a centred headline and three icon cards; this page avoids it by leading with the day's slots." Section `directions` turns it into Direction 0.

## Where the brief lives

- Section gear: in the reply.
- Page gear and larger: a text block on an "Explorations" page, so the critique and the user can read it next to the work: figma_create_page once, then figma_create_from_spec { pageId } for the block, directions and styleframes. If the page is refused (a Starter file holds 3 pages), use a section "Explorations" at an empty spot on the current page (figma_create_section) and say so in the report. A motion piece uses its Storyboard page. One call builds the block, for example:

{"type":"frame","name":"Brief","layout":"vertical","width":720,"gap":12,"padding":40,"background":"#ffffff","children":[{"type":"text","name":"Brief / Message","content":"Message: you fix your own bike here, with a mechanic beside you.","fontSize":24,"sizing":{"width":"fill"}},{"type":"text","name":"Brief / Lines","content":"Goal: members book a bench slot online.\nAudience: neighbours on a phone, next to a broken bike.\nSuccess: a visitor books within one scroll.\nDefault to avoid: lifestyle photo, centred headline, three icon cards.","fontSize":16,"sizing":{"width":"fill"}}]}

The block is a working note, not part of the design: its font is the tool's default, not a brand, so never point a type check at it.

Update the block when a decision changes it. The finish report quotes the brief as built, not as first written.

Evidence (claim ids, for maintainers): [C-236] [C-085] [C-233] [C-219] [C-048] [C-269] [C-270]
