# Checking your own work

figma_check_layout { nodeId } — run it after every section and before you call anything done.
- text_overflow (error): a text that hugs its content ran past its parent. Make it fill the column (figma_resize_nodes { sizing: { horizontal: "fill" } }) or give it a width.
- overlap (error): two texts on top of each other. Fix the structure (auto-layout, gap), do not nudge.
- covered (error): a filled layer painted above a text hides part of it (the detail says how much). Move one of them or reorder (figma_reorder_nodes).
- clipped (error for text): part of a node is cut off by a parent that clips content. Make room, or when the clipping itself is the mistake: figma_set_clips_content { nodeIds: [<parent>], clipsContent: false }.
- text_collapsed (error): a text squeezed to a sliver, a word or less per line. Give it the column (sizing fill) or a width.
- outside_parent (warning): sticks out of its parent.
- fill_in_hug (warning): a child set to fill inside a parent that hugs on that axis — it collapses. Give the parent a size, or the child a fixed or hug size.
- low_contrast (warning): text below 4.5:1 (3:1 for large text) against what is behind it.
- zero_size (warning); empty_text, empty_frame, default_name (info) — name layers, remove leftovers.
- placeholder_text (info): "Title", "Button", "Lorem ipsum", and placeholder people, brands and domains ("John Doe", "Acme", example.com) left in — write the real copy.
- sibling_overlap (info): frames stacked on each other outside auto-layout — deliberate (a badge, a collage) or a layout bug.
- rawColors: raw hex where the file has styles or variables to use instead.
`ok: true` means no errors and no warnings.

Audits, on request: figma_check_layout { nodeId, audit: ["tokens", "names", "fonts"], expectFonts: ["Inter"] }
- tokens: unbound_color (warning), unbound_spacing / unbound_radius (info) — raw values where the file has tokens; `suggest` names the variable to bind.
- names: duplicate_name (warning) — two components with one name on a page, or two variants with one name in a set.
- fonts: wrong_font (warning) for free text outside expectFonts, ds_font_gap (info) inside instances or text styles; without expectFonts, `fonts` counts text per family.
- handoff: before you hand a frame on. `handoff` gives the share of solid paints, texts, auto-layout spacing and corner radii bound to variables or styles, with a one-line verdict; detached_instance (warning) is a frame detached from a component — put an instance back; duplicate_style (info) is a local style that repeats another style or a variable — keep one source.

After a library or a code-to-design build, run tokens, names and fonts; before a handoff, add handoff.

## Craft and tells — the finish a critic measures

figma_check_layout { nodeId, audit: ["craft", "tells"] } — run it on every new design, styleframe and finished section. The design skill's `tells` and `finish` sections say what each kind means and what to do instead. Six craft kinds report info, so ok: true can stand while they remain: near_size, no_shared_edge (unless the edges almost meet), tangent, unbalanced_space, edge_slices_text and weak_graphic_contrast. On new design, answer each one: fix it, or keep it and say why in your report.
- craft: finish defects measured in a real critique. near_size (two sizes of one family less than 1.12× apart), no_shared_edge (stacked blocks a few px off a common edge), tangent (shapes or text almost touching), glyph_gaps (single letters spaced apart), oldstyle_figures (digits drawn at x-height), unbalanced_space (a block sitting off its field), low_contrast_over_shape (text on a shape it does not belong to, below the minimum), stroke_crosses_text and edge_slices_text (a line or an edge through live text), weak_graphic_contrast (faint hairlines that carry meaning).
- minTextSize, the device's smallest readable size converted to frame px (the design skill's `brief` section), flags smaller text (min_text). safeArea "x,y,width,height" in the frame's own coordinates, from the brief — there are no presets — flags text, logos and buttons outside it (safe_area); pass it only where a placement's interface covers part of the frame (a story, a reel, an overscan). A web or app view has none: its fold is a success line measured from figma_get_design_context { nodeId, absolute: true }, never passed as safeArea, which would flag every line meant to sit below it. Either parameter turns craft on.
- tells: a census of the generated look, all `info` until calibrated: default_typeface, flat_hierarchy, too_many_sizes, mostly_centred, centred_block, eyebrow_everywhere, measure, leading, card_trio, nested_cards, one_radius, nested_radius, same_shadow, default_gradient, glow, emoji_icon, chrome_string, divider_everywhere. An info is a question: fix it, or keep it and say why in your report.
- Under a page or top brief (the checked work's own, else the one in force, or `briefId`; `audit.brief` names it) tells run by default, and a kind on the brief's `avoid` list is a warning that no answer clears: fix the work. figma_create_from_spec's result (`tells`) lists those matches as each section is built.
- On an animated frame they do not judge the motion: collisions during a move show only in a render.

figma_export_node — the render, for judgement: spacing rhythm, alignment, hierarchy, colour, polish. A vision reading of a render has disagreed with the document about where things were, so take positions and sizes from figma_get_design_context or figma_get_node, not from the picture. figma_export_node { nodeId: <one view>, maxSize: <its long side ÷ 8> } is the squint test, one view (a section, a slide, a story frame) at a time: the focal point and the groups must still read.

Motion: figma_check_motion { nodeId, fps } checks the keyframes frame by frame with no render — pops, one frame carrying most of a move, dead stretches, read times — and figma_review_video measures a rendered file. The critique skill runs all of it in rounds.

## The role audits — what a sign-off runs

figma_sign_off runs the audits of the brief's role and gear, and passes only when they report no error and no warning. Run them yourself first, after each section and before the sign-off: figma_check_layout { nodeId, audit: ["a11y", "states", "copy", "system"], briefId }. `briefId` hands them the brief's numbers: the platform and viewport (targets are measured in the platform's units), the declared screens and states, the format and the system; pass it every time. Every audit skips the brief block. Infos are uncalibrated questions until measured otherwise: fix each, or keep it and give the reason at sign-off (`answers`).
- a11y (the ux skill's `accessibility` section): target_size (warning under the platform's minimum — 24 × 24 CSS px on the web and desktop, 28 × 28 pt on iOS, 48 × 48 dp on Android; info under 44 px, 44 pt), target_spacing (warning on the web, info on Android), focus_state_missing (warning on the web and desktop, info on iOS and Android), weak_boundary (warning: an input's edge under 3:1), error_colour_only (warning: an error variant that changes only colour), focus_indicator_weak, input_unlabelled, text_fixed_box, safe_area_platform (info). Fix: a bigger hit area, a gap, a Focus variant, a stroke, the error in words, a visible label.
- states (the ux skill's `states` section): state_missing (warning for Focus on the web and desktop and for Error on inputs; info for Hover, Pressed, Disabled, Loading), variant_default_name (warning: "Property 1"), state_property_missing (info), screen_state_missing (warning: a state the brief declares has no frame named `<screen name> / <State>`). Fix: add the variant or the frame, or rename the property.
- copy (the ux skill's `content` section): generic_label (Submit, OK, Learn more…), label_case_mixed, error_interjection (Oops), error_code_only, copy_variants (one phrase written two ways) — all info. Fix: a verb that says what happens, one capitalisation, words a person can act on, one wording.
- system, with the brief's `format` and `system` (figma_set_brief { briefId, system }): format_mismatch (warning: the frame is not the format's size), off_grid (warning when a block's edge misses a column edge by 1–4 px, else info), off_scale (a text size off the type scale), off_spacing (a gap or padding off the spacing base), off_palette (a colour outside the palette), optical_margin (left edges whose ink does not align), hanging_punctuation — info. Fix: the frame's size, the nearest step of the scale, a column edge, a palette colour, an x nudge by the measured difference.

Evidence (claim ids, for maintainers): [C-207] [C-248] [C-212] [C-270] [C-343] [C-386] [C-387] [C-388] [C-391] [C-344] [C-357] [C-362] [C-346] [C-349] [C-356] [C-360]
