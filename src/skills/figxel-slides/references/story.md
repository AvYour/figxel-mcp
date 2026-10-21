# Story — the takeaway, the arc and a sentence per slide

You are a senior presentation designer: the takeaway and the arc come first, every slide says one thing in a sentence headline, and nothing is shrunk that could be cut. A deck designed slide by slide before its story is written ends up as a template filled in; a deck whose headlines tell the story on their own can be designed in any direction.

## The takeaway and the room

- **The takeaway** is the brief's message: the one sentence the room should repeat afterwards. Every slide either proves it or leads to it.
- **The room**, `details.room`: projected (read from the back of a room while someone speaks), screen (read alone, as a PDF or a link), or both. It sets how much a slide carries and the smallest text.
- **The slot**: `details.minutes` and a target count, `details.slides`, when the talk has a length. More slides than minutes is fine when each says one thing; fewer slides that each say three things is not.

## The arc

- Write the sections of the story in order, in `details.arc`, as short phrases that say what each part does: ["what slowed us", "what we tried", "what changed", "what we ask"]. A situation, a complication and a resolution, or a problem, the evidence and the ask, are common shapes; choose the one the takeaway needs.
- Each section becomes a row of the deck (section `deck-recipes`, Sections), and the tonal arc follows the story: quiet slides around the moments that must land.

## A sentence per slide, before any layout

In the reply, with no tool call, write the outline: per slide its headline as a full sentence and the evidence that proves it (a chart, a photo, a diagram, one number). Then read the headlines alone, in order. They should tell the whole story; a slide whose headline adds nothing is cut or merged, and a gap in the story is a slide to add. Only then plan the layouts, as the index says.

## Assertion headlines, visual evidence

- **On content slides** (not the title, a section divider or the close) the headline is an assertion, a sentence that states the point ("Pairing halved our review time"), not a topic ("Code review").
- **The body is evidence for it, shown rather than listed**: a chart with the one comparison that matters labelled directly, a photo of the real thing, a diagram of the real sequence.
- This is the assertion-evidence approach: an approach practitioners teach, not a research finding. The deck audit's `topic_title` asks the question on each content slide; answer it by rewriting the headline, or keep a topic with the reason.
- **Bullets only when the content is a list** (steps, options): five items or fewer, each at most two lines. More is a second slide.

## Density by room, and the floor

- **Words.** The deck audit counts the words on each slide, notes excluded: an info above 40 on a projected deck and 90 on screen, both uncalibrated defaults. Set your own budget in `details.maxWords` when the room needs one; above it the count is a warning.
- **The floor.** A projected deck needs text the back row can read. Guy Kawasaki's rule of thumb is no type under 30 points, and a 1920 × 1080 slide is PowerPoint's widescreen slide at two pixels per point, so 30 pt is 60 px. Pass it as the brief's `minTextSize`: 60 for a projected deck unless the brief says why otherwise; a deck read on screen sets its floor from the reading distance and writes the reason. `min_text` holds every slide to it.
- **Cut before you shrink.** A slide over its budget becomes two slides, never smaller type.

## Speaker notes

With `details.notes: true` (a deck that will be presented) every content slide gets notes, as section `deck-recipes` writes them: what the slide does not say, the transition to the next, the source. The deck audit's `notes_missing` lists a slide without them.

## The deck audit

figma_check_layout { nodeIds: [<the batch's slide ids>], audit: ["craft", "deck", "copy", "system"], briefId } after each batch, beside the index's own check; `briefId` hands it the room, the budget, the floor and the system's numbers.

| Kind | Severity | Fix |
|---|---|---|
| `slide_words` | info; warning above `details.maxWords` | cut, or split the slide in two |
| `topic_title` | info | rewrite the headline as the slide's point in a sentence |
| `two_focal` | info | one idea per slide: shrink or move the second, or give it its own slide |
| `repeated_skeleton` | info | three content slides in a row share one layout: vary the composition with the content |
| `bullets_dense` | info | five items or fewer, two lines each, or a second slide |
| `notes_missing` | info | write the slide's notes |

Every deck kind is an info until calibrated: fix each one, or keep it and say why in the report.

## The story lens

The presentation role's own lens, scored as the critique skill scores the others: read the headlines alone, in order, cold. They state the takeaway; each slide says one thing; the arc builds to the ask without a gap or a repeat; the evidence on each slide proves its headline. A headline that is a topic, or a slide that proves nothing, is a major finding.

## The brief call for a deck

figma_set_brief { role: "presentation", gear: "page", title: "Q3 engineering update", goal: "leadership approves a pairing pilot on two more teams", audience: "the leadership team in a meeting room, projected, 20 minutes", message: "Pairing halved our review time, so we want it on two more teams.", proof: ["median review time fell from 2.1 to 1.0 days (placeholder)", "no rise in escaped bugs over the quarter"], constraints: ["the company's charcoal and signal orange", "ten slides at most"], givens: "the company brand: charcoal #2B2B2B and signal orange #E8572A", success: ["the headlines alone tell the story", "no text under 60 px", "the ask is on its own slide"], tone: { words: ["candid", "measured", "concrete"], not: "salesy" }, format: "1920x1080 px slides", minTextSize: 60, details: { room: "projected", minutes: 20, slides: 10, arc: ["what slowed us", "what we tried", "what changed", "what we ask"], notes: true } }

In Figma Slides no block is drawn: the brief is stored on the deck's page. Where figma_status lists figma_set_brief or figma_sign_off among `unavailableTools`, the gate only warns: write the brief in the reply and go on. At the end, figma_sign_off { deck: true, lenses, rounds, answers, placeholders } runs craft, tells, deck, copy and system on every slide with the lenses story, type and composition, colour and imagery, copy, originality and finish QA; then figma_export_frames_to_pdf { deck: true, outputPath, final: true } writes the delivery.

Evidence (claim ids, for maintainers): [C-376] [C-374] [C-375] [C-389] [C-391] [C-218] [C-383]
