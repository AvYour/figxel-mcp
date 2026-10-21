# The system: rules every later number comes from

The chosen direction becomes a short set of rules. From here on, every size, gap, colour and radius is computed from them; a number in the build that traces to no rule means a missing rule or a wrong number. The rules are methods for deciding, not values to copy: the values come from the direction, the brief and the file.

**Givens first.** The brief's constraints line decided whose system the file holds (section `brief`). A given is used, never re-decided; the rules fill only what the givens leave open. Styles and variables the brief found to be another brand's, or a generated look saved as styles, are reference: never applied to this work, never edited. Read the givens with figma_get_design_context on an existing screen (`stylesUsed` includes library styles), figma_get_styles, figma_get_variable_defs and figma_get_local_components.

## Mode, then colour strategy

Both are named on the direction card before any face or hex (section `directions`); they set how loud every rule below may be.

- **Mode,** what the view is for: **persuade** (win attention and argue: a landing page, an ad, a poster), **operate** (worked in again and again: an app screen, a dashboard, settings), **read** (long text: an article, documentation) or **experience** (explored or felt: a campaign site, an exhibition). An operate view borrows only type, palette, density and one signature move from its world; the task decides the rest (the ux skill's `screens` section). A piece with two modes names one per view.
- **Colour strategy:** **restrained** (neutrals carry the view; one accent marks what earns it), **committed** (one colour owns a large part of the surface), **full palette** (several hues, each with a role and a rule) or **drenched** (one hue, its tints and shades, everywhere). None is the safe one: restrained on a working screen is as much a category default as one acid accent on black.

## Type

- **Criteria before candidates.** Decide from the subject and the direction what the face must have: its construction (geometric, humanist, grotesque, slab, script, a serif's contrast), its width, its era, and any lettering already in the subject's world (a sign, a label, a stamp). Then either one family with real range (weights, widths, optical sizes) or two that differ clearly in role, such as a display voice and a reading face. Two similar sans faces read as a mistake, not a pairing.
- **Candidates, then a reason.** The card's families, checked as section `directions` says (Type), each with its reason in one line against the criteria. Hold the pairing you choose against the clusters in section `tells`. A face picked because a tool set it is the `default_typeface` tell.
- **A scale from the body, above the floor.** Set the body size for the device first: 15–25 px on screen, then checked on the target device; the floor in frame px and `minTextSize` come from the brief. Pick a ratio from how far apart the levels must be: a poster or a hero needs its display many times the body; a dense tool needs gentle steps. Multiply and divide the body by the ratio, round, then adjust by eye. Never take sizes from a tool's fixed type scale.
- **The floor wins.** No size goes under the floor. When dividing the body by the ratio would land below it, build up from the floor instead: the smallest text on the floor, the body at least one ratio step above it, or the body on the floor itself when the view needs one small size. A 16 px floor and a 1.25 ratio give 16 and 20; an 18 px body over 16 px labels is off that scale.
- **Few levels, visible steps.** About three sizes in a view, and at most two large elements. Adjacent sizes of one family stay at least 1.12× apart, the larger divided by the smaller: figma_check_layout reports anything closer as `near_size`.
- **Measure and leading.** 45–90 characters per line, body leading 1.2–1.45; display lines tighter. Set the width of a text from its measure, not from its container.
- **Figures.** Lining figures for prices, statistics and offers. Check numerals in the render at display size: some faces draw old-style figures by default ("10%" can read "IO%").
- **Caps and centring.** Capitals only for labels shorter than a line, tracked 5–12 %; centre only short lines, never a block.
- **Emphasis.** Inside a line, emphasise the word that carries the message, or nothing (the design-system skill's typography section has the mechanics).

## Grid and spacing

- **Write the grid as numbers** for each format: columns, gutters, margins, and a baseline if there is one. Derive the margins from the device and the measure, and the gutters from the spacing scale. figma_set_layout_grids shows the grid in the editor; it never renders.
- **One spacing scale:** a base unit and its multiples. Tight inside a group, wider between groups, widest between sections.
- **One deliberate break.** If the idea needs something to cross the grid, choose the one place and write it down; a second break is drift.

## Composition

- **One focal point per view.** The squint render must find it first.
- **Balance follows the content.** One statement, a formal invitation or two equal things to compare can sit centred or symmetric; content of uneven weight starts from the edge the reading order begins at, with the space split by importance. Bleeds, overlaps and crops are tools for a reason the brief gives, not a style.
- **Proximity before containers.** Group with space and type; add a box only where grouping needs one.
- **Vary the skeleton between views.** Tokens carry across the pages of one piece; composition must not, or the pages read as one template filled twice.
- **Compose for the format.** A 9:16 story is not a web section.

## Colour

- **Roles, not swatches,** inside the strategy, on the ground the brief's scene chose (light or dark, never the category's): a lead colour that owns most of the area, a support, an accent with a written rule for what earns it, neutrals, and text. The number follows the roles the content needs; a data piece may need a categorical set, a poster one colour. Write the colour rule, and the critique checks the rule, not the count.
- **From the subject or the brand.** Write where each value comes from: a material, a photo, a place, a brand token.
- **Text stays readable.** Body text near-neutral and untinted; secondary text still meets the minimum. Text needs 4.5:1, large text 3:1, and graphics needed to understand the content 3:1. Colour is never the only cue.
- **Gradients and glows** only when the direction gives them a reason (light, a material, depth), built from the palette.

## Shape: radius, stroke, elevation

- **Radius by role and size, as a decision to test.** A stance from the direction (square, tight or soft), then a value per role: a control, a card, an image, a sheet. Figxel's starting point, to test in the styleframe's read: tight about 4–8 px, soft about 16–24 px on a card. A nested radius is the outer minus the inset while the inset is smaller than the radius; past that, the inner element takes its own role's value.
- **Strokes by role**, few weights. A hairline that carries meaning still meets 3:1.
- **Elevation only where something sits above something else**, in few levels. A shadow under every card is decoration.

## Imagery

- **Images that inform.** People look at images of the product, the real people and the real place, and skip decorative stock.
- **Art-direct each image:** its focal point, its crop, what it proves, its colour temperature. Grade a set to one temperature, and give a light image on a light ground an edge.
- **Missing photos** become placeholder frames at the right proportion, labelled with what goes there, and listed in the report. Never pass off stock as the user's own.

## Icons

- **Only where they speed recognition,** each with a visible label; no emoji as icons.
- **One set per piece, at its native sizes:** the codebase's set when there is one. Never two sets side by side, never a drawing scaled between its sizes (its stroke thins or thickens).
- **Outline at rest, filled when active or selected:** the current tab, a favourite that is on.
- **Stroke matched to the text beside it:** in a close-up render the icon's lines weigh what the label's stems weigh.
- **Bare by default:** no tinted chip behind an icon unless the brief gives it a job, such as a category colour.
- **Heroicons:** outline exists only at 24 px; at 20 and 16 px take the 20 or 16 px solid set. A small icon is then solid at rest and marks its active state another way: the accent, a weight, an indicator.

## Copy

- **Specific and objective:** names, numbers, materials, places; short and scannable, which measured far more usable than promotional copy.
- **A button says what happens** ("Book a 45-minute slot"), and a label names a thing the way its reader does.
- **Repeats are identical:** the same phrase, the same punctuation, everywhere.
- **Placeholders** for the user's facts are plausible and listed in the report.

## What to save

- A file that will keep growing (a site, a product, a series): make the rules into styles and variables, then build with them: figma_create_text_style, figma_create_paint_style, figma_create_effect_style, figma_create_variables (the design-system skill has the order). In a file whose styles belong to another brand, name yours for this work, beside theirs.
- Either way, record the numbers on the brief: figma_set_brief { briefId, system } with `bodySize`, `ratio`, `sizes`, `spacingBase`, `grid` { columns, gutter, margin } and `palette` [{ hex, role }]. The sign-off needs them from the page gear up, and the `system` audit measures the build against them.

Exit gate: you can name the rule behind every size, gap and colour in the build.

Evidence (claim ids, for maintainers): [C-210] [C-211] [C-212] [C-207] [C-248] [C-218] [C-073] [C-209] [C-075] [C-221] [C-213] [C-214] [C-215] [C-085] [C-399] [C-400]
