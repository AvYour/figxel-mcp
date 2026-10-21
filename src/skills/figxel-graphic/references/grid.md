# Grid, scales and the optical pass

A fixed format holds together because its numbers come from a few rules written before the first element. This section turns the design skill's `system` rules into the numbers a poster, a post or a page needs, and ends with the optical pass that makes a measured layout look right. The worked numbers below are for the repair-night poster of section `placements`: 420 × 594 mm with 3 mm bleed, drawn at 4 px per mm, a 1704 × 2400 px frame.

## The grid as numbers

- **Margins first, from the format.** In print they sit inside the safety margin, measured from the frame's edge with the bleed included; on a post they keep the message clear of the edges at phone width; on a poster they are a share of the short side you decide and write down. The poster: 96 px, the 12 px bleed plus 21 mm.
- **Columns from the content, not from habit.** As many as the content has units that sit side by side: a headline, an image and a block of facts may need four or six to give each its width; a menu two; a story often one field with a few strong alignments. The poster: 6 columns.
- **Gutters from the spacing scale:** one step of it, the same everywhere. The poster: 24 px, so each column is 232 px.
- **Rows** when the format is tall and the content stacks in units (a poster, a story): they give the vertical rhythm a column grid does not. The poster: 8 rows of 255 px, gutter 24.
- **A baseline** when text runs in columns long enough to align across them (an editorial page, a menu): the body's leading is the unit.
- **Draw it on the frame**: figma_set_layout_grids { nodeIds: [<the frame>], grids: [{ pattern: "columns", count: 6, gutter: 24, margin: 96 }, { pattern: "rows", count: 8, gutter: 24, margin: 96 }] }. Layout grids are editor guides and never render. The system audit measures against a frame's own column grid first, then the brief's `system.grid`, so draw the one you recorded. A grid shared by a family of placements can be a style: figma_create_grid_style { name, grids }.

## The type scale from the body

- **The floor and the body first.** For print, decide them in pt from the reading distance and convert at your scale (1 pt is 1/72 in); for a screen placement, from the device, as the design skill's `brief` section converts it. The poster: a 9 pt floor is 13 px, a 24 pt body is 34 px.
- **A ratio from how far apart the levels must be.** A poster read from across a street needs its headline many times its body: a large ratio such as 1.5. A menu or an editorial page read in the hand needs gentle steps, such as 1.2 or 1.25.
- **Multiply and divide, round, then adjust by eye**, and record the sizes as built: the poster's 34 body and 1.5 ratio give 23, 34, 51, 76, 115, 172 and 258. A size you set by eye goes into `sizes`, so the audit checks the list instead of the formula.
- **Few levels.** About three in a view and at most two large elements; adjacent sizes clearly different (the design skill's `system` section has the measured threshold, `near_size` reports it).
- **Copy fits the measure,** not the other way: a headline is broken where the sense breaks, and a text that does not fit at its size is cut, not shrunk off the scale.

## The spacing scale

- One base unit and its multiples: tight inside a group, wider between groups, widest between a block and the margin. The poster: a 4 px base, one millimetre at its scale, so 24, 48, 96 are all steps.
- Auto-layout gaps and paddings are steps of it (the audit's `off_spacing`); absolutely placed blocks sit on column and row edges (`off_grid`).

## One deliberate break

The idea may need one element to cross the grid: a headline running into the margin, an image bleeding off two edges, one word set far above the scale. Choose the one place, write it in the brief's `constraints` ("break: the date bleeds off the right edge"), and name it in the report; the system audit reports it as an info, which is the question your sentence answers. A second break is drift.

## The optical pass

The grid places boxes; the eye reads ink. After the last critique round's fixes, before the sign-off:

- **Align ink, not boxes.** A round letter (O, C, G), a diagonal (A, V, W) or any display size sits visibly in from a straight edge its box shares. The system audit measures it: `optical_margin` compares the ink edges of left-aligned texts that share a box edge and gives the difference as an x nudge. Apply it with figma_move_nodes { nodeIds, x, relative: true }; a text inside an auto-layout moves only out of the flow, so nudge its wrapper's padding instead when the flow matters.
- **Hang the punctuation.** An opening quote, a bullet or a dash that starts a display line pushes its letters in from the column edge. Hang the mark outside the column so the letters align: `hanging_punctuation` reports it with the distance to move the text left.
- **Rag, figures and marks.** Break display lines where the sense breaks; one style of numerals, one dash, one kind of quote mark; read every mark cold. The design skill's `finish` section has the whole details pass.
- **The viewing render last.** Render each placement as it is seen (section `placements`) and the squint; the focal point still reads first.

## The system audit

figma_check_layout { nodeId, audit: ["craft", "system"], briefId } after each section: `briefId` hands it the format, the bleed and the system numbers. Without them it measures what it can and says what it skipped (`system_unmeasured`).

| Kind | Severity | Fix |
|---|---|---|
| `format_mismatch` | warning | the frame is not the format's size (print: not trim + 2 × bleed in proportion): figma_resize_nodes before anything else is placed |
| `off_grid` | warning when an edge misses a column edge by 1–4 px; info further off | snap the block to the edge; a far miss is the one break or a block that belongs to no column |
| `off_scale` | info | the nearest step of the scale, or add the size to `sizes` when it is a decision |
| `off_spacing` | info | a multiple of the spacing base |
| `off_palette` | info | a palette colour; a new colour joins `palette` with its role, or goes |
| `optical_margin` | info | the x nudge the detail gives |
| `hanging_punctuation` | info | move the text left by the distance the detail gives |
| `system_unmeasured` | info | record what is missing: figma_set_brief { briefId, system } |

Infos are questions until calibrated: fix each one, or keep it and say why in the report.

## Recording the system

Once the numbers are set, before the build: figma_set_brief { briefId, system: { bodySize: 34, ratio: 1.5, sizes: [23, 34, 51, 76, 115, 172, 258], spacingBase: 4, grid: { columns: 6, gutter: 24, margin: 96 }, palette: [{ hex: "#1F5F3A", role: "co-op green, given: the ground" }, { hex: "#F4F1EA", role: "type on the green" }, { hex: "#F2B705", role: "accent: the date only" }] } }. The sign-off needs it from the page gear up, and every later check measures the build against it.

Evidence (claim ids, for maintainers): [C-211] [C-380] [C-391] [C-075]
