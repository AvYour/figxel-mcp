# Building a design, section by section

The mechanics of one section, from a short brief to a checked result. The names and numbers below stand for what YOUR file and brief give: none of them is a default to copy, and the two examples reach opposite answers because their briefs differ. For a page or more, the design skill comes first (figma_get_guide { topic: "design" }); its brief, directions and system decide what this loop builds.

Example 1 — a pricing section for a shift-scheduling app used by small clinics, in a file whose screens already have a system:

1. figma_savepoint { label: "Pricing section" }, then the brief, three lines (the section gear): goal "clinic managers, comparing tools at a desk, start a trial"; message "most clinics need Team, which covers 40 staff for $96 a month"; success "Team is the first thing the squint render shows". The default to avoid: three identical cards with a "Most popular" badge on the middle one. Two directions, in words: three plan cards with Team given the room, or a comparison table led by Team's column. The cards win: the audience compares three prices before any feature.
2. figma_get_design_context on an existing screen → spacing 8 / 16 / 24 / 48 / 96, radius 6 on controls and 12 on cards, text styles "Display/M", "Heading/S", "Body/M", "Label/S", paint styles "Surface", "Text", "Border", "Brand", and stylesUsed ids.
3. Wrapper: figma_create_frame { name: "Pricing", x: <empty spot>, y: 0, width: 1440, layout: "vertical", padding: "96,120,96,120", gap: 48, background: <the hex behind "Surface"> } → WRAP
4. Heading section, one call — the file's other sections start at the grid's left edge, so this one does too; no label above it, a width set from the measure:
   figma_create_from_spec { parentId: WRAP, spec: {"type":"frame","name":"Heading","layout":"vertical","gap":16,"sizing":{"width":"fill"},"children":[
     {"type":"text","name":"Title","content":"Most clinics run on Team","style":{"text":"Display/M"},"width":760},
     {"type":"text","name":"Subtitle","content":"Free for up to 5 staff. Team covers 40 staff for $96 a month, billed monthly; cancel from the settings page.","style":{"text":"Body/M"},"width":560}]} }
5. The card, ONCE, as a component — no stock icon; the plan's own facts carry it:
   figma_create_from_spec { parentId: WRAP, spec: {"type":"component","name":"Plan card","layout":"vertical","width":320,"gap":16,"padding":32,"cornerRadius":12,"style":{"fill":"Surface","stroke":"Border"},"children":[
     {"type":"text","name":"Plan","content":"Free","style":{"text":"Heading/S"}},
     {"type":"text","name":"Price","content":"$0","style":{"text":"Display/M"}},
     {"type":"text","name":"Fit","content":"Up to 5 staff, one location","style":{"text":"Body/M"},"sizing":{"width":"fill"}},
     {"type":"text","name":"Features","content":"Shift swaps by text message\nOne rota template\nEmail support","list":"unordered","style":{"text":"Body/M"},"sizing":{"width":"fill"}},
     {"type":"button","name":"CTA","sizing":{"width":"fill"},"cornerRadius":6,"style":{"fill":"Text"},"alignX":"center","children":[{"type":"text","name":"CTA label","content":"Start with 5 staff","style":{"text":"Label/S","fill":"Surface"}}]}]} } → CARD
   Then figma_add_component_property { componentId: CARD, name: "Plan", type: "TEXT", defaultValue: "Free", bindNodeIds: [<Plan text id>] } (and Price, Fit, Features, CTA label) so instances change copy without detaching.
6. The row of plans, one call — prices ascending, as readers compare them. The message names Team, so Team must lead without a badge: here it is wider and on the brand colour; for another brief, position or a larger price could do the same job. Each instance sets its own properties in the spec: figma_create_from_spec { parentId: WRAP, spec: {"type":"frame","name":"Plans","layout":"horizontal","gap":24,"children":[{"type":"instance","componentId":CARD},{"type":"instance","componentId":CARD,"width":440,"style":{"fill":"Brand"},"properties":{"Plan":"Team","Price":"$96 / month","Fit":"Up to 40 staff, three locations","CTA label":"Start a 30-day Team trial"}},{"type":"instance","componentId":CARD,"properties":{"Plan":"Clinic group","Price":"From $310 / month","Fit":"Over 40 staff, any number of locations","CTA label":"Talk to us about your rota"}}]} }. figma_set_instance_properties changes one later.
7. Check and critique, one round (the section gear): figma_check_layout { nodeId: WRAP, audit: ["craft", "tells"] } → fix every error and warning, and answer every info, the craft ones included (fix it, or say why it stays); then the read and the squint of the section (figma_export_node { nodeId: WRAP } and figma_export_node { nodeId: WRAP, maxSize: 180 }) and the three lenses in turn: message (does Team read first?), type and composition, finish QA (figma_get_guide { topic: "critique", section: "lenses" }).
8. Fix with targeted edits: emphasis inside a text with figma_set_text_range only on a word that carries the message; a library style by id with figma_apply_style_to_node; many small edits in one undo step with figma_batch.
9. Finish: check_layout ok:true with every info answered, figma_select + figma_zoom_to, then report what changed (figma_get_changes { since: <the savepoint id> }), the brief, the choices, the default avoided, and the placeholders (every price and limit above is the user's to replace).

Example 2 — the sign-up section of a city library's summer reading challenge for children aged 6 to 11, read by parents on a phone; the library's sticker sheet gives four round stickers, numbered 1 to 4, in four colours held as variables:

1. Brief: goal "parents sign a child up"; message "read four books this summer and collect all four stickers"; success "the four stickers and the button read in the squint render on a 390-wide phone". The default to avoid: a stock photo of a child reading under a centred headline. Two directions: the four stickers as the whole section, or a reading log the child fills in. The stickers win: they are the reward the message names.
2. The answer here is centred, symmetric, many-coloured and soft, each for a reason: one statement and four equal rewards are symmetric content; the four colours are the four stickers the child collects, each carrying its number, so colour is not the only cue; the stickers are round on the library's own sheet. A design in which every tell is negated would have missed all four.
3. One call into the wrapper: figma_create_from_spec { parentId: WRAP, spec: {"type":"frame","name":"Challenge","layout":"vertical","alignX":"center","gap":24,"padding":24,"sizing":{"width":"fill"},"children":[{"type":"text","name":"Title","content":"Read four books, collect four stickers","style":{"text":"Display/S"},"width":320},{"type":"frame","name":"Stickers","layout":"horizontal","gap":12,"children":[{"type":"ellipse","name":"Sticker 1 (artwork to place)","width":64,"height":64,"fill":"<sticker 1 hex>"},{"type":"ellipse","name":"Sticker 2","width":64,"height":64,"fill":"<sticker 2 hex>"},{"type":"ellipse","name":"Sticker 3","width":64,"height":64,"fill":"<sticker 3 hex>"},{"type":"ellipse","name":"Sticker 4","width":64,"height":64,"fill":"<sticker 4 hex>"}]},{"type":"button","name":"CTA","sizing":{"width":"fill"},"cornerRadius":24,"style":{"fill":"Text"},"alignX":"center","children":[{"type":"text","name":"CTA label","content":"Sign up for the challenge","style":{"text":"Label/M","fill":"Surface"}}]}]} }, then bind each sticker's fill to its variable (figma_bind_variable_to_node).
4. Check, critique and finish as in Example 1, with `minTextSize` 16 for the phone.

## Auto-layout, the way designers use it
- Structure is nested auto-layout: page (column) → sections (column, fill width) → rows (row) → items. Absolute x/y only for deliberate overlap (decoration, badges): inside a frame with layout "none", or as one child of an auto-layout frame that leaves the flow — "positioning": "absolute" in the spec, or figma_move_nodes { nodeIds, positioning: "absolute", x, y } on an existing layer.
- Spacing from gap and padding on one scale — the file's, or the one the design skill's system sets — never from nudging.
- Sizing per axis: a number = fixed, "hug" fits content, "fill" takes the parent's space. Text in a column fills and wraps; a paragraph in a row needs a width.
- Hierarchy: sizes from one scale, few levels with steps you can see, body leading about 1.2–1.45× and headings tighter; at most two families.
- Contrast: body text at least 4.5:1, large text 3:1.

## Making it look designed, not generated
- A brief and a direction before the first node: for a page or more, the design skill. Its `tells` section lists what reads as generated and how figma_check_layout measures it.
- One focal point per section, and quieter support around it.
- Every element earns its place. A decorative motif carries the idea at full strength, or it is removed; a faint blob behind a hero is a tell.
- Real content instead of grey boxes: images (image url) cropped with cornerRadius and scaleMode "fill" for what they show; icons (svg) only where they speed recognition, each with a label.
- Radius, stroke and shadow by role: a control, a card and an image may differ, a nested radius is the outer radius minus the inset, and a shadow marks only what sits above something else.
- Copy that is specific: numbers, names, limits; objective copy reads better than promotion.

Evidence (claim ids, for maintainers): [C-221] [C-210] [C-075] [C-215]
