# The lenses

Each lens is one pass: re-read the brief, look and write its verdict, then measure and merge, then write findings in the schema. A lens judges only its own question; a problem another lens owns gets one line pointing there, not a second finding. Measurements come from the document (figma_check_layout, figma_get_design_context, figma_get_nodes_info, figma_scan_text_nodes), never from reading positions off a picture.

## Message

Does a stranger get the single message in the time they give it, and does the eye land where the brief needs it? Judge from the renders and the brief first; measure after.

- **The cold read.** The set-up wrote, from the renders alone, the reading order and the takeaway. Compare them with the brief: the first element against the focal point the system named, the takeaway against the message line. Either mismatch is a major finding.
- **Squint test.** The squint render of each view (the design skill's `finish` section: maxSize about the view's long side ÷ 8): what leads, and do the groups hold? A strong colour or a large shape can win over the headline without anyone intending it.
- **Proof.** Is each proof fact on the page, near the claim it supports?
- **Substance.** Is there enough here to act on? A view made "clean" by being mostly empty ground, running text set small or grey to look quiet, or an idea that stops after the first view: each is a major (the critique index's severity triggers).
- **Action.** Does the button or the call to action say what happens, and can it be reached where the audience meets the work?
- **Format.** Is the work composed for where it lives? A story, a slide and a desktop page read differently.
- **Then the numbers.** For a fold the brief names, measure it: its bottom in figma_get_design_context { nodeId: <the view>, absolute: true } is at most the viewport height; the fold is never passed as `safeArea`. figma_check_layout's `min_text` and `low_contrast` test the substance verdict. Write what the eye missed and what the numbers missed.

## Type and composition

Is there a clear order to read in, and do the parts hold together?

- **Levels:** count the sizes and their ratios. About three levels in a view and at most two large elements; adjacent sizes of one family 1.12× apart or more, and none under the brief's floor; `flat_hierarchy`, `too_many_sizes`, `near_size` and `min_text` measure it.
- **Reading:** measure 45–90 characters, body leading 1.2–1.45, centring only on short lines; `measure`, `leading`, `mostly_centred`, `centred_block`.
- **Edges:** blocks in a column share an edge exactly; `no_shared_edge`. Margins hold everywhere.
- **Space:** tight inside groups, wider between them; a block centred on its field, then lifted on purpose (`unbalanced_space`).
- **Contact:** nothing almost touches (`tangent`), and no edge or stroke slices text by accident (`edge_slices_text`, `stroke_crosses_text`).
- **Figures:** numerals read correctly at display size (`oldstyle_figures`, and the read).
- **Skeleton:** the views of one piece do not share one layout.
- **Rules:** every size and gap traces to the system's rules; compare the built numbers with the rules, since in the run the build differed from its own spec.

## Colour and imagery

Do colour and pictures do a job, by a rule?

- **The colour rule:** read the system's written rule (what each colour marks, what earns the accent) and check the build against it, colour by colour, with figma_get_design_context. The finding is a colour used outside its rule, not a count of colours.
- **Contrast:** text 4.5:1, large text 3:1, graphics people need 3:1; `low_contrast`, `low_contrast_over_shape`, `weak_graphic_contrast`. Colour is never the only cue.
- **Images:** each one informs (product, people, place) rather than decorates; its crop serves its focal point; the set shares one colour temperature; a light image has an edge on a light ground.
- **Icons:** each speeds recognition and carries a visible label; one set at its native sizes, bare unless the brief gives a chip a job (the design skill's `system` section); no emoji (`emoji_icon`).
- **Effects:** gradients, glows and shadows each have a reason the direction gives (`default_gradient`, `glow`, `same_shadow`).

## Copy

Would a reader believe it, understand it, and find it consistent?

- **Specific:** names, numbers, materials, places, instead of benefit words.
- **Short and scannable:** headlines that say one thing; body in short paragraphs or real lists.
- **Consistent:** figma_scan_text_nodes { nodeId: <wrapper> } lists every string; every repeated phrase is identical, punctuation included, with one dash and one kind of quote mark.
- **Labels:** a button names its outcome; navigation and labels use the reader's words.
- **No filler:** `placeholder_text` clean; invented facts listed for the report; no template chrome strings (`chrome_string`).

## Originality

Is the direction a decision, or the default any similar request would produce? In a measured test run the lenses never asked this, and the look matched two known clusters of generated design unnoticed. It runs at the directions, on the styleframes, and on the build; for motion, in review round 1 on the render too. Steps 1 to 5 judge from the renders and the brief and end in a written verdict; steps 6 and 7 bring the numbers.

1. **Swap test.** Put a competitor's name on the design. If nothing else would have to change, it is generic: major.
2. **Direction 0.** Compare the build with the one-pass answer written before the directions (section `directions` of the design skill). Fewer than two axes of difference is a major.
3. **Trace.** For the face, the palette, the composition and the signature: which line of the brief, or which thing from the subject's world, did it come from? A choice that traces to "clean", "modern" or "premium" is a default.
4. **Negation.** A design made only by negating tells (no cards, no shadows, no centring, a bled field) is a default too: each choice must name the brief line it answers.
5. **Self-repetition.** Compare with the other frames in the file and the directions you rejected: the same skeleton, signature or move again is a default of your own.
6. **Clusters, in numbers.** Read the values (figma_get_design_context for fills, fonts, radii, effects and text; figma_get_styles for the palette) and compare them with the cluster table (figma_get_guide { topic: "design", section: "tells" }). Report "matches cluster N on k of m features". Two or more features of one cluster that no one named is a major.
7. **The tells census.** figma_check_layout { nodeId, audit: ["tells"] } lists the measurable tells (info, uncalibrated). Each is fixed, or kept with a reason in the report.

Then merge: a cluster or a tell the verdict missed becomes a finding of its own, and a verdict no number can see (a failed swap test with no tell firing) stands.

A match is never silent. "Brand given" carries its evidence: the style or variable id it came from, or the user's words, quoted; and the style must be a given by the design skill's `brief` section, not merely saved in the file, or the match is a finding. Score 8 or more only when nothing in the direction is an unexamined default.

## Finish QA

Is anything broken, cut, misplaced or inconsistent?

- figma_check_layout { nodeId, audit: ["craft", "tells"] }: no error or warning, and every info answered, the craft infos included (near_size, no_shared_edge, tangent, unbalanced_space, edge_slices_text, weak_graphic_contrast report info, so ok: true does not mean they are gone).
- `minTextSize`, the brief's floor in frame px; `safeArea` only for a placement whose interface covers part of the frame, as the brief gives it. A web view passes none.
- The design skill's finish defects, row by row (figma_get_guide { topic: "design", section: "finish" }): near-misses, tangencies, slicing edges, near-equal sizes, figures, associations, repeats.
- Names: no default layer names, no empty frames or texts left behind.

## Lenses for motion

A motion piece runs four lenses on each round's render: motion craft, design and type, technical QA, and the brief's own lens (for an ad, does it make someone act). Their checklists are in section `motion-checks`, which maps each checklist group to its lens. Originality runs at the directions and on the styleframes before anything moves, then once more in round 1 on the render, where it answers figma_check_motion's `template_move` and `easing_census` infos and holds the piece's transitions and accents against the storyboard's card 0 and the bible. The design and type lens also applies the type, composition and colour checks above to the frames where the piece rests.

Evidence (claim ids, for maintainers): [C-070] [C-212] [C-210] [C-207] [C-073] [C-075] [C-221] [C-213] [C-214] [C-215] [C-208] [C-219] [C-248]
