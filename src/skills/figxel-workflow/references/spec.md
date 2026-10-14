# figma_create_from_spec — the spec grammar

The way to build anything new that is larger than a few nodes: one call per section (a header, a hero, a card, a grid of cards, a footer), placed into a wrapper frame by `parentId`. Each call is one undo step, and `created[]` returns every id with its path in the spec.

Node fields (all optional except as noted):
  type        "frame" | "text" | "button" | "rectangle" | "ellipse" | "polygon" | "star" | "line" | "vector"
              | "svg" | "image" | "component" | "instance" | "section"   (default "frame")
              On a FigJam board also "sticky" | "shape" | "table" | "code" | "connector" (see below).
              Only frame, button, component and section take children.
  name        layer name — name every layer for what it is; a section takes "" (no label)
  ref         a name for this node, unique in the call (letters, digits, _ and -). A connector names it as an end,
              and the result's `refs` maps every ref to its id.
  width, height, x, y      (x/y only inside a frame without auto-layout: deliberate overlap, decoration)
  layout      "vertical" | "horizontal" | "none"   (auto-layout)
  sizing      "fixed" | "hug" | "fill", or { "width": ..., "height": ... } per axis. An axis with a number is
              fixed; an auto-layout axis without one hugs, so { "height": 28 } is a fixed-height row that grows
              sideways. "fill" on a child takes the parent's space: along the parent's layout it absorbs the
              leftover room, across it it stretches. hug: auto-layout frames and text; fill: children of an
              auto-layout — anything else is refused.
  positioning "absolute" — a child that leaves its auto-layout parent's flow (a badge, a floating button); x/y place it
  gap, padding   padding: number or [top, right, bottom, left]
  wrap        true: a horizontal layout wraps into rows; rowGap (default: gap) between the rows,
              alignContent "auto" | "space-between" for the rows
  alignX, alignY  "start" | "center" | "end" | "space-between" (screen directions; space-between only along the layout);
              alignY "baseline" lines up the text baselines of a row
  background  hex colour, e.g. "#ffffff"; without it a nested frame is transparent, a frame on the page white
  fill        same as background (shapes)
  cornerRadius, stroke, strokeWeight, opacity, visible, locked, rotation (degrees)
  clipsContent   default false, so shadows are not cut off at the frame edge
  content     text content (type "text")
  fontFamily, fontSize, weight (number or style name), color, align (left | center | right | justified)
  lineHeight  "auto" | "24" (px) | "150%", at least 0;  letterSpacing  "0.5" (px) | "-2%". The strings
              figma_set_text_properties takes and figma_get_design_context reads back ("32px" too); a bare number
              is px, never a multiplier
  pointCount  polygon sides / star spikes (>= 3);  innerRadius  star, 0–1
  path        type "vector": SVG path data, e.g. "M0 40 C60 0 120 80 180 40 L180 80 L0 80 Z"
  svg         type "svg": SVG markup (an icon); width or height scales it, color recolours it, or colorVariable
              binds it to a COLOR variable (name or id; not together with color)
  url         type "image": http(s) PNG/JPEG/GIF, fetched before anything is built; scaleMode fill | fit | crop | tile
  width + cap type "line": width is the length, rotation turns it; stroke/color, strokeWeight;
              cap none | round | square | arrow | arrow-filled | triangle | circle | diamond
  componentId type "instance" (no children): a COMPONENT or COMPONENT_SET id — or componentKey / componentSetKey
              for a library component, with variant "Size=Large, State=Hover" to pick one of a set
  properties  instance: { "Label": "Buy now", "Show icon": false } — set in the same call
  nested      instance: { "<nested instance layer name>": { "Label": "…" } } for instances inside it
  variableModes  frame / button / component / section: { "<collection name>": "<mode name>" }, e.g. { "Theme": "Dark" }
  variables   bind by variable name or id, e.g. { "fill": "color/bg", "radius": "radius/md", "gap": "space/4" }
              (an svg binds its colour with colorVariable, not variables.fill)
  style       apply a local style by name or id: { "fill" | "stroke" | "text" | "effect" | "grid": "Style name" }
              (a library style: apply it afterwards by id with figma_apply_style_to_node)
  children    array of the same shape, nested (a "component" is converted after its children are built)
  list        text: "unordered" | "ordered" | "none" — every line of the content becomes a bullet or a number. A
              list is ONE text with lines separated by \n, never a dot shape beside each line.

Sections (Design and FigJam) have no auto-layout. Instead:
  arrange     "row" | "column" | "grid:N" — places the children from their real sizes (a sticky grows with its
              text), rows as tall as their tallest item; a child of an arranged section takes no x/y
  gap         space between arranged children (default 64); padding  inset for arrange and hug (default 32)
  hug         true — the section fits its children plus padding, inner sections first; not with width/height
  contentsHidden   true hides what the section holds
  background  a hex (FigJam's section swatch names are not confirmed yet)

On a FigJam board, five more types (none takes children):
  sticky      content, color (white, gray, green, teal, blue, violet, pink, red, orange, yellow, or a hex), wide
              (416 wide instead of 240; a sticky has no width or height), authorVisible, x, y
  shape       shape (rounded-rectangle, square, ellipse, diamond, triangle-up, parallelogram-right, eng-database,
              eng-queue, eng-file, hexagon, chevron, speech-bubble, …, or "label" for a 1–2 character marker),
              content, color (a preset that sets fill, stroke and text: light-blue, green, gray, …) or fill /
              stroke / textColor as hex, width + height (default: fitted to the text), fontSize, x, y
  table       rows (an array of rows of strings; row 0 is the header) or numRows + numColumns, header,
              headerColor, fill, columnWidths, rowHeights, fontFamily, weight, fontSize, x, y
  code        content, language (typescript, javascript, python, sql, json, bash, …, plaintext), x, y
  connector   from, to — "<ref>", "<ref>@right" (magnets top, bottom, left, right, center), a node id, or "x,y";
              label, lineType (elbowed | straight | curved), startCap, endCap (none, arrow-lines, triangle-filled,
              erd-one-or-more, …), color, strokeWeight, dash ("dashed", "dotted", "10,6"), labelBackground.
              Built after every other node of the call, in the container that declares it, and never moved:
              it takes no x, y, width or height.

A whole board zone in one call — a section with a title, a grid of stickies, and a decision flow:
  figma_create_from_spec { parentId: <the board's wrapper section>, spec }
  {"type":"section","name":"","background":"#F5FBFF","arrange":"column","gap":40,"padding":[68,60,100,80],"hug":true,"children":[{"type":"text","content":"What went well","fontSize":48,"weight":"Bold"},{"type":"section","name":"","background":"#FFFFFF","arrange":"grid:3","hug":true,"children":[{"type":"sticky","content":"Shipped the beta on time","color":"green"},{"type":"sticky","content":"Pairing on the hard bugs","color":"green"},{"type":"sticky","content":"Reviews done within a day","color":"green"}]},{"type":"section","name":"","background":"#FFFFFF","arrange":"row","gap":120,"hug":true,"children":[{"type":"shape","ref":"idea","shape":"rounded-rectangle","content":"Keep pairing?","color":"light-blue"},{"type":"shape","ref":"vote","shape":"diamond","content":"Team agrees","color":"light-yellow"},{"type":"shape","ref":"plan","shape":"rounded-rectangle","content":"Pair every Tuesday","color":"light-green"},{"type":"connector","from":"idea@right","to":"vote@left"},{"type":"connector","from":"vote@right","to":"plan@left","label":"yes"}]}]}

Several roots: `spec` may be a JSON ARRAY of 1–50 roots when parentId or pageId says where they go — the whole
content of one slide, or the cards of one zone. Still one validation and one undo step; the result adds `rootIds`.

Editors:
  - A type the file's editor cannot build is refused before the first node, UNSUPPORTED with `failedAt` naming
    it: a component on a board, a sticky in a Design file, or a type whose create function the file's editor
    does not offer.
  - On a board, text defaults to Inter Medium in Charcoal #1E1E1E; in Design, Inter Regular in black.
  - On a slide, every node goes into its parent before its x/y is set, and the result's `drift` lists any
    position Figma moved. Expect []; never add an offset back by hand.

Notes that matter:
  - Fonts fall back Inter → Roboto → Arial → Helvetica Neue. A text entry in `created[]` carries `font` with
    `fellBack: true` when the font used is not the one asked for — never a silent substitution.
  - Types, layout, alignment, padding, colours, paths, image URLs and the variables/style maps are checked before
    anything is built; such a failure creates nothing.
  - A field the node type does not take is refused, with the nearest valid name — never silently ignored.
  - A mid-way failure does NOT roll back. You get `created[]`, the path in the spec that failed, and the ids built
    so far, so the user can press Ctrl+Z once (the whole call is one undo step) or you can continue from there.
  - Supply your own idempotencyKey for a large spec.
