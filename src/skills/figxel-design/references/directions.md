# Directions, styleframes and the choice

## Why more than one

The first idea for a brief is usually the category default, because it is the most likely answer to the request. Broad prompts gave AI prototyping tools interchangeable, flat results, and only richer input moved them. Professional practice answers this with alternatives: make three or more, then merge the best of them, which in NN/g's case beat picking the single best. A measured test run did exactly that with three directions and three judges.

How many: two, in words, at the section gear; two or three at the page gear; three at the top gear. A storyboard's styleframes come after its own directions (the storyboard skill), so none are written here.

## Direction 0 — the one-pass answer

Before the real directions, write down the design you would have made in one pass, in concrete terms, so it can be measured against:

- **Face** — the family and weights you would have reached for.
- **Ground and accent** — two hex values.
- **Skeleton** — the layout in one line ("centred headline over a photo, three cards below").
- **Signature** — the one move it would rely on.

It is not a straw man: it is your own default, written so you can see it. Every real direction must differ from it on two or more of the axes below, and a choice that stays close to it on any axis (the same face, a ground within a few levels of the same hex, the same skeleton) needs a written reason with evidence: a given's style or variable id (section `brief` says what counts as a given), or the user's own words, quoted. Direction 0 sits on the Explorations page beside the cards, and the critique's originality lens compares the build with it.

## Start each one from a different place

Three variations of one idea are one direction. Give each a different origin:

- **From the subject's world** — take a principle from the look (section `brief`), not an object to dress the interface in. A rhythm, a density, a proportion, a colour taken from a real material: the co-op's 45-minute bench blocks set the grid's rows; the galvanised grey of the parts bins and the green the co-op already owns set the palette. Turning the repair tag into a card shape is a costume, and a costume dates fast.
- **From the message** — a typographic or compositional idea that says the message by itself: scale, a crop, a sequence, a contrast.
- **From the audience's moment** — where and how they meet the work: one thumb on a phone beside a bike, a glance across a street, a slide seen from the back of a room.

A reference's principle (section `brief`) can seed any of the three.

## They must really differ

Directions differ from Direction 0 and from each other in at least two of: the idea, the type, the composition, the colour, the imagery. A colour swap is not a direction: the same layout in different colours is one of the named patterns of design made without intent. If two cards share a layout, merge them and make a new one.

## The direction card

One card per direction, each a frame on the Explorations page (one figma_create_from_spec per card) or a block in the reply for a section:

- **Name** — two or three words.
- **Idea** — one sentence.
- **Why it fits** — which lines of the brief it serves, quoted.
- **Type** — the criteria first (construction, width, contrast, era, lettering already in the subject's world), then the families and their roles. Check that each loads: figma_get_fonts with `scope: "available"` and `families` set to the exact names (or `query` for part of a name, with a `limit`), never the unfiltered list, which holds every style of every installed font. When figma_get_fonts offers no such filter, or a family is not listed, try it: a figma_create_text or figma_create_from_spec text in that family answers `fellBack: true`, naming the font it used, when the family does not load. figma_suggest_fonts is optional: nothing waits on it, a call that does not answer is not retried, and its top pairing is the default to beat.
- **Palette** — the colours the roles need, each as hex with its role (lead, support, accent and the rule that earns it, neutrals, text) and its source: the brand, a material, a photo, a place.
- **Composition rule** — one sentence a builder can follow: "the slot grid fills the top two thirds; the headline sits low-left on the grid's edge".
- **Signature** — the one element someone would remember and describe.
- **Risk** — what could go wrong and how you would know.

## The default check

Write the answers on every card, before any styleframe:

1. **Swap test.** Put a competitor's name on the card. If nothing else would have to change, the card is generic: revise it and say what changed.
2. **Direction 0.** Name the axes on which the card differs from Direction 0. Fewer than two is a default.
3. **Clusters.** Hold the card against the five generated looks (section `brief`); for one that comes close, count its features in the cluster table of section `tells` and write "matches cluster N on k of m features".
4. **Trace.** Each choice traces to a line of the brief or to the subject's world. "Clean", "modern", "premium" and "elegant" are not reasons; every default claims them.
5. **Verdict.** A match is either "brand given", with its evidence (the style or variable id of a given, or the user's words, quoted), or revised. Never silent. A card made only by negating tells is a default too: name the brief line it answers.

## Judging the cards

Four scoring passes over all the cards, each starting by re-reading the brief, each scoring 1–10 in whole points with one line of reason:

- **Effectiveness** — does it carry the message to this audience, in the time they give it?
- **Craft** — can it be made excellent: type, composition, a signature that holds up at full size?
- **Originality** — the default check's answers: how far it is from Direction 0 and the clusters, by reason, not by novelty.
- **Buildability** — pass or fail, not a score: fonts that load, images that exist, effort, the risk on the card. A fail is revised or dropped; buildability never ranks a card above a better one.

Score anchors: 9–10, nothing a senior designer would change; 8, minor doubts only; 7, one real weakness; 5–6, it misses a line of the brief; 4 or less, it fails the message. These are the run's judges as passes of one agent, with originality added because no lens of the run asked it.

**Combining.** A card's total is effectiveness + craft + originality, 3 to 30, counted only once buildability passes. The highest total leads; on equal totals, the higher effectiveness, then the higher originality. A near tie is a runner-up whose total is 3 points or less below the leader's, one point per score: a gap of 3 is a near tie, a gap of 4 is not. Write each card's total and the gap on the card.

## Styleframes

A styleframe is one key frame of a direction, built for real: delivery size, the brief's real copy, real type, images or placeholders at the right proportions. A description hides problems a frame shows: 14 of the run's issues were visible on a still at rest, which a styleframe stage catches before the build.

- **How many.** The top gear: one per direction, three in all. The page gear: the hero of the leading card, and of the runner-up too on a near tie. The section gear: none; the cards decide.
- Put them side by side on the Explorations page, each a top-level frame named `Direction A · <name>`, `Direction B · <name>`.
- Build each with the workflow loop: a wrapper (figma_create_frame { parentId: <page id> }), then one figma_create_from_spec per part.
- Check each: figma_check_layout { nodeId, audit: ["craft", "tells"], minTextSize }, then the renders of section `finish` for one view: the read and the squint.
- Score each with the same critique lenses, at least message, originality, and type and composition (figma_get_guide { topic: "critique", section: "lenses" }). A styleframe's total is the sum of those lens scores.

## Choosing: a spine and grafts

- Take the strongest direction as the **spine**: the styleframe with the highest total, the higher message score breaking a tie; where the gear builds no styleframe, the card with the highest total.
- **Graft** the best single idea of each other direction onto it, at most one each; a graft that fights the spine's idea is dropped.
- Write **restraint rules**: what the design will not do ("one accent per view", "no second display face", "the grid breaks once, at the hero").
- Write the **decision line**, under the styleframes and in the reply:

  `Chosen: B, Slot board — the day's slots are the message's proof. Grafted: the bin-label lettering from A for the slot times. Rejected: C, Night ride — a mood, not a reason to book.`

With a checkpoint, stop here and wait (the design index, "Checkpoint").

**The spine's styleframe becomes the build.** It is already built at delivery size with the real copy, so never rebuild it. Clone it to where the design goes, figma_clone_node { nodeId: <styleframe>, parentId: <target page or wrapper id>, x, y, name }, at an empty spot; then the system, the grafts and the critique rounds reach it as targeted edits, and only a part that a graft replaces whole is rebuilt, with one figma_create_from_spec for that part. When the deliverable is one view (a landing hero, a poster, a single screen), the clone is the deliverable; with more views, it is the first section, and the workflow loop builds the rest beside it.

The explorations are your own frames: keep them, and say in the report where they are. Delete them only when the user asks.

Evidence (claim ids, for maintainers): [C-217] [C-216] [C-206] [C-208] [C-218] [C-219] [C-238] [C-267] [C-268]
