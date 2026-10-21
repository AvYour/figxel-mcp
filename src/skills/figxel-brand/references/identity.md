# Identity — positioning, routes, construction and the mark tests

A mark is a small drawing asked to carry a whole brand, at sixteen pixels and on a shop sign, in one ink and on any ground. Most of the work happens before refinement: a positioning that gives the mark something to say, and routes wide enough that the chosen one was really chosen.

## Positioning first

- **One sentence**, in `details.positioning`: for whom, against what, and why this one. "For neighbours who would rather learn than pay, the co-op where you fix your own bike with a mechanic beside you."
- **Three attributes**, in `details.attributes`: words a member would use about it, taken from the positioning and the subject, never the words every default claims ("modern", "clean", "premium", "elegant"). Each route is judged against them.
- **The category default.** Name three peers and what their marks all do; for bike shops, a wheel or a chain ring, a bold italic name for speed, a mountain. That is the mark this one will be mistaken for: write it as `defaultToAvoid`.
- **The applications**, in `details.applications`: every place the mark will appear, each with its smallest size in px, measured or taken from that place's spec: a browser tab, a social avatar, a sticker on a repair tag, the shop sign. The smallest of them sets the mark tests.

## The mark type

| Type | What it is | Fits when |
|---|---|---|
| Wordmark | the name set as the logo | the name is short and distinctive and must be learned: the name is the asset |
| Lettermark | initials or one letter | the name is long, or people already use the initials |
| Symbol | a sign without the name | the brand is known, or the mark must work small, square and without language: an app icon, a favicon |
| Combination | a symbol and the name, locked up | a new brand that needs both: the symbol for small and square places, the name to be learned |
| Emblem | the name inside a shape: a badge, a seal | heritage, institutions, a stamp-like use; it loses detail small, so it needs a simplified version |

Record the type in `details.markType` and the reason in the decision line.

## Routes: explore wide

- **Direction 0 first** (the design skill's `directions` section): the mark you would have drawn in one pass, written down so the routes can be measured against it.
- **Three routes or more, each from a different origin**: the name itself (its letters, a ligature, a cut, a rhythm); the subject's world (the bench timetable's 45-minute blocks, a hand-lettered bin label: a principle taken, not a costume); the positioning (what the co-op does that others do not: you do it yourself); the audience's moment (a sticker read at arm's length on a greasy frame).
- **Draw each route in black on white, at one size,** with the same route at the smallest application size beside it: a route that dies small is out before any refinement. One figma_create_from_spec per route card; shapes with figma_create_vector, letters with figma_create_text.
- **Judge them** as the directions section scores cards, hold each against the category default and Direction 0, and run the swap test of the critique's originality lens: put a peer's name in the mark; if it still works for them, it says nothing about this brand.
- **Record** the routes and the choice: figma_set_brief { briefId, direction0, directions, chosen, styleframes }, the route frames as styleframes (three or more at the top gear).

## Construction and optical corrections

- **Rebuild the chosen route on a construction grid**: a unit the mark's parts share, so its stroke, its radii and its gaps are multiples of one number. Draw the grid in a frame named "Construction" beside the mark, a working note, never inside it.
- **Then correct by eye** what the grid gets wrong, and write each correction down: round and pointed shapes run slightly past the baseline and the cap height to look aligned; horizontal strokes a little thinner than vertical ones to look equal; counters and gaps opened so they do not fill in when small; a circle a little larger than the square it sits beside.
- **A wordmark** starts from a typeface chosen by the criteria in the design skill's `system` section, then is drawn: spaced pair by pair at display size, with one or two letters altered to make it ownable. Typing the name in a font is not yet a mark. Altered letters are vectors (figma_create_vector, figma_boolean_nodes); keep the unaltered text beside them for reference.

## The mark tests

Run them after every refinement round, not once at the end:

1. **Small.** In a test frame, an instance of the mark at each application's smallest size, rendered as it is: figma_export_node { nodeId: <the test frame> }. Nothing fills in, no detail vanishes, the idea still reads.
2. **One colour.** The whole mark in one solid colour: no gradient, no tint, no overlap that needs a second colour to read. A mark that fails depends on colour: simplify it.
3. **Reversed.** Light on a dark ground: what read as holes now reads as solids, and a counter may need opening.
4. **Cold read and swap.** Look at it as a stranger: what else could it be? (In a measured run, an arc under a wordmark read as a smile.) Then the swap test.
5. **In use.** The mark at size in two real applications from the brief, before the sign-off.

## Versions, lockups, clear space, minimum size

- **Versions**, as `details.versions` lists them (by default full colour, one colour, reversed): each a component named for its version ("Version=One colour"), combined into one set with figma_combine_as_variants { componentIds, name: "logo/mark" }. The one-colour version uses exactly one solid colour, or the mark audit counts it as missing. Keep logo, logotype, wordmark or lockup in the names: that is how the audits recognise a logotype.
- **Lockups**: the symbol and the name in fixed arrangements (horizontal, stacked), the space between them a unit of the construction grid, each a component in a set named "logo/lockup".
- **Clear space** (`details.clearSpace`, such as "1x = the cap height of the name"): the margin nothing may enter, as a multiple of a part of the mark so it scales with it. Build each lockup as an auto-layout frame whose padding is the clear space in px, so the frame's edge shows it: figma_set_auto_layout { nodeId, padding }.
- **Minimum size**: the smallest width at which the mark passed the small test, in px and, for print, in mm; below it, a simplified version or the symbol alone.
- `format` is the brand sheet's size; versions and lockups live in component sets, which the format check leaves alone.

## The mark audit

figma_check_layout { nodeId, audit: ["craft", "mark", "system"], briefId } — `briefId` hands it the applications, the versions and the clear space.

| Kind | Severity | Fix |
|---|---|---|
| `mark_detail_lost` | warning under 1 px at an application's size, info under 2 px | thicken the thinnest stroke, open the smallest gap, or draw a simplified version for that size |
| `version_missing` | warning | a declared version has no component named for it, or a one-colour version uses two colours: add it, or recolour it to one |
| `clear_space` | warning | a lockup's padding is under the recorded clear space: widen it |
| `mark_contrast` | info | a version's mark under 3:1 against its ground. Logotypes are exempt from text contrast, so 3:1 is guidance for a graphic: change the ground or the version |
| `app_icon_text` | info | text in an app icon: keep it only when it is essential (section `guidelines`) |

## The lenses

- **Positioning** — the mark says the positioning sentence, or at least does not contradict it, and carries the three attributes; a stranger's cold read names one of them.
- **Mark** — the tests above: small, one colour, reversed, cold read, in use. A failed test is a major finding.
- **Type and composition, colour, originality, finish QA** — as the critique skill's `lenses` section has them; originality is the swap test, against Direction 0 and the category default.

## The brief call for a new mark

figma_set_brief { role: "brand", gear: "top", title: "Co-op identity", goal: "neighbours recognise the co-op on the street, on a phone and on a repair tag", audience: "neighbours who pass the workshop, members who book on a phone", message: "You fix your own bike here, with a mechanic beside you.", proof: ["six repair stands", "3,100 repairs last year (placeholder)"], constraints: ["works in one ink on kraft-paper tags", "the name is fixed"], givens: "none; no brand styles in the file", success: ["the mark reads at 16 px in one colour", "the swap test fails for every peer's name", "the mark audit passes"], tone: { words: ["hands-on", "neighbourly", "patient"], not: "cute" }, format: "1600x1000 px brand sheet", defaultToAvoid: "a chain ring or a wheel beside a bold italic name", details: { name: "Spoke & Bench", positioning: "For neighbours who would rather learn than pay, the co-op where you fix your own bike with a mechanic beside you.", attributes: ["hands-on", "neighbourly", "patient"], markType: "combination", applications: [{ name: "browser tab", sizePx: 16 }, { name: "social avatar", sizePx: 48 }, { name: "repair tag sticker", sizePx: 120 }, { name: "shop sign", sizePx: 900 }], versions: ["full colour", "one colour", "reversed"], clearSpace: "1x = the cap height of the name" } }

Evidence (claim ids, for maintainers): [C-355] [C-221] [C-383] [C-386] [C-390] [C-391]
