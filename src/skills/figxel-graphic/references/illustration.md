# Illustration and icons — one construction system

An icon set reads as one hand when every drawing obeys the same rules: one canvas, one live area, one stroke, one corner system, one point of view. An illustration does the same at a larger scale: one line, one light, one level of detail. Write the rules before the first drawing; the icons audit measures them after, and renders at every size test what no rule can.

## The set and its metaphors

- **List the set** in `details.set`: every item by the concept it stands for ("book a slot", "repair log", "tools included"), not by the picture.
- **One metaphor per item,** in a word or two. Write the first idea, then strike it out: it is the one every set reaches (the design skill's `brief` section, the look). A wrench for "repair" is the default; a wheel clamped in a stand is this co-op's.
- **Labels stay.** An icon is recognised from what people have seen before, and only a few are near-universal (home, search, print). So in the product every icon keeps a visible label: the drawing speeds recognition, it never replaces the word.
- **Test it cold:** hide the labels and name each icon as a stranger would. An icon nobody names gets a new metaphor, or is kept with its label and the reason in the report.

## The construction grid

Decide it from the sizes the set renders at and the style, record it in `details.grid`, and keep it for every drawing. A grid is a decision written down, not a platform's figure copied: there is no standard to cite, and the brief says why these numbers.

- **Canvas** (`size`) — the frame every icon sits in, in px at 1x: usually the size it renders at most often.
- **Live area** (`padding`) — the inset that ink stays inside, so icons of different shapes sit in a row with even margins.
- **Keyline shapes** — a circle, a square and an upright and a wide rectangle drawn inside the live area and sized by eye to look equal in weight: a circle the square's width looks smaller, so it gets a little more. Each icon starts from the keyline closest to its silhouette.
- **Stroke** (`stroke`) — one weight for the set at the canvas size; a set redrawn per size records one weight per size and says so.
- **Corners** (`corner`) — one outer radius; an inner corner is the outer radius minus the stroke, so both curves stay concentric; a sharp corner only where the metaphor needs a point.
- **Caps, joins and angles** — one cap and one join style (round, or square) and a short list of angles (0, 45 and 90 degrees, plus one if the style needs it).
- **Point of view** — front, or one isometric angle, never mixed in a set.
- **Detail** — about the same number of parts in every icon at the same size; one busy icon reads heavier than its neighbours.

## Building

- Each icon is a frame of the canvas size. Show its live area with a layout grid, one column and one row inset by the padding: figma_set_layout_grids { nodeIds: [<the icon frames>], grids: [{ pattern: "columns", count: 1, margin: 2 }, { pattern: "rows", count: 1, margin: 2 }] }. Grids never render.
- Draw with the vector tools: figma_create_vector { path, width, height, stroke, strokeWeight, parentId, name } for strokes and curves from SVG path data; figma_create_ellipse and figma_create_rectangle for primitives; figma_boolean_nodes { nodeIds, operation } to join and cut (union, subtract, intersect, exclude); figma_import_svg { svg, parentId, name } for paths drawn elsewhere; figma_flatten_nodes { nodeIds, name } when a drawing is done.
- Apply the system to every vector at once: figma_set_strokes { nodeIds, color, weight, cap, join } and figma_set_corner_radius { nodeIds, radius }.
- One component per icon, named `icon/<name>` ("icon/book-slot"): figma_convert_to_component { nodeId, name }. Sizes or styles that change the drawing are variants: name each component "Size=16", "Size=24", then figma_combine_as_variants { componentIds, name: "icon/book-slot" }.
- All icons on one page, in a row on the spacing scale, in the order of `details.set`.

## Whole pixels, and every size

- **Whole pixels.** In icons of 32 px and under, keep every vector's position and size on whole pixels: a fractional edge renders soft at 1x. The icons audit lists the ones that are not.
- **A specimen.** Build one frame with every icon as an instance at each size in `details.sizes`, on the ground it will sit on, with its label, and render it: figma_export_node { nodeId: <the specimen> }. Judge the smallest row at its true size: each icon still names its concept, no two read alike, counters and gaps stay open. Where a size fails, redraw a variant for it with fewer parts rather than scaling the large one down.

## Illustrations

- **A spot or hero illustration** follows the same idea at a larger scale: colours from the brief's palette only (the system audit's `off_palette` checks), one line weight or none, one light direction, one level of detail. Build it from the same vector tools, grouped and named by part, and render it at the size it is placed and at the smallest size it ships at.
- **A pattern** is one tile repeated by instances on the grid; check the seams in a render of four tiles, two by two.
- **A mascot, a sticker or a badge** reads in silhouette: render it filled in one colour, and if the shape no longer says what it is, the outline needs work before the detail does.

## The icons audit

figma_check_layout { nodeId: <the section or frame that holds the set>, audit: ["craft", "icons"], briefId } — `briefId` hands it `details.grid`.

| Kind | Severity | Fix |
|---|---|---|
| `icon_size_mixed` | warning | a component's frame differs from the grid's size: resize the frame, never the drawing (figma_resize_nodes) |
| `stroke_mixed` | warning | more than one stroke weight across the set: set the recorded one, or record the weights per size in `details.grid` |
| `live_area` | info | ink outside the live area: redraw inside it, or keep a deliberate overshoot (a round shape a little past its keyline) with its reason |
| `off_pixel` | info | in icons of 32 px and under, a vector at a fractional position or size: round it |
| `corner_mixed` | info | more than one corner radius: the recorded one, or declare the second |

## The lenses

- **Recognition** — with the labels hidden, a stranger names each concept at the smallest size, and no two icons read alike. A concept nobody names is a major finding.
- **Consistency** — the set as one hand: canvas, stroke, corners, caps, angles, point of view and detail. Side by side in the specimen, no icon looks heavier, busier or borrowed from another set.
- **Finish QA**, and **originality** at the page and top gears, as the critique skill's `lenses` section has them.

## The brief call for a set

figma_set_brief { role: "illustration", gear: "page", title: "Co-op icon set", goal: "members find the co-op's six services at a glance in its booking app", audience: "members on a phone, often with oily hands", message: "Every service the co-op offers has one clear sign.", proof: ["six services, each with its own screen", "the icons sit beside their labels in a tab bar and a list"], constraints: ["labels always shown", "drawn with Figxel's vector tools, no icon font"], givens: "the co-op's green; no icon set in the file", success: ["a stranger names each icon cold at 16 px", "the icons audit passes with one canvas and one stroke"], tone: { words: ["sturdy", "practical", "friendly"], not: "childish" }, format: "24x24 px icons", details: { set: ["book a slot", "repair stand", "tools included", "parts bin", "repair log", "opening hours"], grid: { size: 24, padding: 2, stroke: 2, corner: 2 }, sizes: [16, 24, 32], style: "outline, round caps and joins, front view" } }

The numbers in `grid` are this set's decision, written down so every drawing and the audit share them.

Evidence (claim ids, for maintainers): [C-214] [C-383] [C-391] [C-390]
