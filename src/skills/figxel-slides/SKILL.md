---
name: figxel-slides
description: Build or restyle a Figma Slides deck with Figxel. Pick the gear, plan every slide, build three to five slides per batch, check each batch, and leave the deck's grid intact. Use on any figma.com/slides file.
---

# Figma Slides decks — plan, then build in batches of slides

A deck (a figma.com/slides/ link) is a grid: rows (its sections) of 1920×1080 slides. A slide is a frame you build into; the grid and its rows are opaque.

Deck writes are verified live one tool at a time: figma_status lists what this deck refuses (`unavailableTools`). A refusal is UNSUPPORTED with safeToRetry true: nothing changed, so use another tool — do not retry the same call.

## Pick the gear first
- An edit (a word, a colour, a number): make it and match what is there.
- Adding to, improving or restyling a deck: read it first (figma_get_slide_grid, figma_export_node on two or three slides) and match its palette, type and habits. Restyle in place: never delete slides to rebuild them unless the user asks to start over.
- A new deck: design it fully, below.

## Orient
- figma_status: the session's editor is Figma Slides.
- figma_get_slide_grid — rows of slides with ids, names, skipped, notes, title and background. An empty deck has no rows: the first figma_create_slides makes row 0.
- figma_get_design_context { nodeId: <slide id> } for a slide's layers. With nothing selected it reads the focused slide, else the deck's outline.

## A new deck of 5 or more slides
It is the design skill's page gear (figma_get_guide { topic: "design" }), done before the first slide: the brief, two or three direction cards, and styleframes (the title slide and one content slide for each leading direction) on an Explorations page or section. A brand, a palette or a reference file the user gave you are decisions already made. Then plan, without a tool call:
- Per slide: its job, its layout in words ("title upper-left, chart over the right two thirds"), its background.
- The palette as the roles this deck needs, each with its source; the fonts; a recurring element only if the direction has one.
- Read the layouts in order: if they repeat, vary them now — this is the cheapest moment.

Then build, 3–5 slides per batch, without re-planning between batches unless one fails:
1. figma_create_slides { slides: [{ "name": "Title", "background": "<the hex the plan gives>" }, …] } — the batch's empty slides, in order.
2. One figma_create_from_spec { parentId: <slide id>, spec } per slide: `spec` is a JSON array of the slide's roots (title, body, shapes, images), placed with x/y.
3. figma_check_layout { nodeIds: [<the batch's slide ids>] }: out_of_slide, text_cut_by_slide, overlap, low_contrast; bleed is info (deliberate when a shape runs off the edge). Fix before the next batch.
4. Run the critique lenses on the slides so far after the FIRST batch (does the look work?) and again after the LAST (figma_get_guide { topic: "critique" }), comparing the slides' renders side by side for a repeated skeleton — not after every batch.

An example slide for an engineering team whose company brand gives charcoal #2B2B2B and signal orange #E8572A, as `spec`:
  [{"type":"rectangle","name":"Accent field","width":760,"height":1080,"x":1160,"y":0,"fill":"#E8572A"},{"type":"text","name":"Title","content":"Pairing halved our review time","fontSize":96,"weight":"Bold","color":"#2B2B2B","width":980,"x":120,"y":160},{"type":"text","name":"Points","content":"Two people on every hard bug\nReviews done within a day\nFewer late surprises","list":"unordered","fontSize":36,"color":"#2B2B2B","width":900,"x":120,"y":560}]

## Rules a deck enforces
- A slide is 1920×1080 and is never resized; a slide is not an auto-layout parent, so its direct children use x/y, not "fill" sizing.
- A background goes on the slide (`background` in figma_create_slides, or figma_set_fills on the slide): rows and the grid take no paint and are never read.
- Each node goes into its parent before its x/y is set; the create result's `drift` lists any position Figma moved. Expect []; never add an offset back by hand.
- Bullets are ONE text with `list` ("unordered" or "ordered") and lines separated by \n — never a dot shape beside each line.
- The whole deck as one PDF: figma_export_frames_to_pdf { deck: true, outputPath: "deck.pdf" } (skipped slides left out unless includeSkipped).
- Reordering, copying, skipping and showing slides: section `deck-recipes`.

## Out of reach
- Templates and themes; creating interactive elements (polls, embeds — they are read and can be moved, never created); presenting.
- Transitions: figma_set_slide_transition is unverified, and is refused with nothing changed where this Figma build does not implement them.
- Local styles in a deck are refused; components and variables are unverified writes.

## Sections of this skill
- section `deck-recipes` (references/deck-recipes.md, or figma_get_guide { topic: "slides", section: "deck-recipes" }) — organising a deck into sections, arranging slides, speaker notes, and the design decisions of a deck that reads well.
