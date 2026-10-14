# Typography — choosing fonts that fit, and applying them

1. Criteria before candidates. From the subject and the direction, write what the face must have: its construction
   (geometric, humanist, grotesque, slab, script; a serif's contrast), its width, its era, and any lettering already in
   the subject's world (a sign, a label, a stamp, a timetable). Words like "modern", "elegant", "premium" or "luxury"
   are not criteria: every default claims them.
2. Candidates: name two to four families that meet the criteria, then check that each loads: figma_get_fonts with
   `scope: "available"` and `families` set to the exact names, or `query` for part of a name, with a `limit`. Never ask
   for the unfiltered list: it holds every style of every installed font. When figma_get_fonts offers no such filter,
   or a family is not listed, try it: figma_create_text { content, fontFamily, weight } answers `fellBack: true`,
   naming the font it used, when the family does not load (a probe at an empty spot, deleted with figma_delete_nodes,
   or the first real text in that family). Pick at most two families.
3. figma_suggest_fonts { mood, use, nodeId? } is optional, and nothing below depends on it: when it does not answer,
   go on without it and never retry it. It returns ranked heading/body pairings with the exact style names, a type
   scale, and `applyPlan` (the existing text split into heading and body ids). Its ranking comes from mood words and a
   catalogue of the commonest web faces, so its top pairing is the default to beat, never the answer; and its
   typeScale is a fixed table, not your system: sizes come from the design skill's `system` section (a ratio on the
   device's body size). Hold the pairing you choose against the clusters in the design skill's `tells` section.
4. A font the design already uses: keep it when it is a given (the design skill's `brief` section): a design the work
   extends, a screen of this brief's brand, or the user's files. Not your own working notes (a brief block set in the
   default font is not a brand), and not another brand's screens. Changing type is a whole-design decision: do it
   everywhere at once.
5. Apply a choice to existing text, with the heading and body ids from figma_get_design_context or
   figma_scan_text_nodes (or applyPlan, when the optional figma_suggest_fonts answered):
   figma_set_text_properties { nodeIds: <heading ids>, fontFamily: <heading>, weight: <heading style> }
   figma_set_text_properties { nodeIds: <body ids>, fontFamily: <body> }
   A new family keeps each run's own weight (bold words stay bold). Check `fellBack` in the result.
6. For new text, pass fontFamily / weight / fontSize / lineHeight from the system's scale to figma_create_text or a
   figma_create_from_spec text. lineHeight and letterSpacing take the strings figma_set_text_properties takes ("24",
   "-1%"); a bare number is px, never a multiplier: body leading of 1.35× on 16 px is "22". Or create text styles
   once (figma_create_text_style) and apply them with figma_apply_style_to_node, so the system stays consistent.
7. Emphasis inside a text: figma_set_text_range { nodeId, match: "Pro", weight: "Bold", color: … } — never split one
   sentence into several text nodes to bold a word. Emphasise the word that carries the message, or none: one
   coloured or italic word in every headline is a stock habit of generated design, not emphasis.

Rules that keep type looking designed:
- At most two families (one is often enough); hierarchy comes from size and weight first.
- Body 15–25 px on screen with line height about 1.2–1.45×, and 45–90 characters per line; headings tighter,
  optionally -1% to -2% letter spacing. On a frame larger than its device, sizes are in frame px, converted from
  the device's (the design skill's `brief` section).
- Few sizes, from one scale; at most two or three weights per screen. Adjacent sizes of one family stay at least
  1.12× apart (`near_size` reports anything closer), and none goes under the brief's floor: make two near sizes equal
  or clearly different.
- A display face (condensed, script, very bold) only at large sizes, never for paragraphs.
- Check the figures at display size in a render: some faces draw old-style figures by default, and "10%" read as
  "IO%" in a measured critique. Prices, statistics and offers need lining figures; change the face of the
  numerals when the chosen face has none.
- Check contrast: figma_check_layout reports text below 4.5:1 (3:1 for large text); its `craft` audit adds
  near-equal sizes and old-style figures.

Evidence (claim ids, for maintainers): [C-219] [C-210] [C-207] [C-267]
