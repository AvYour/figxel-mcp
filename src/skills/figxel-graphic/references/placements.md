# Placements — the medium, its size and the moment of viewing

A graphic piece is judged where it lands: a phone feed scrolled past in under two seconds, a poster read across a street, a menu held at arm's length for a minute. Write the medium down before the first element; the format, the margins, the type sizes and the amount of copy all follow from it.

## The medium in the brief

- **Format** — every size the piece ships at, each with its unit, in the brief's `format`: "1080x1350 px feed post, 1080x1920 px story", "210x297 mm flyer". The system audit reads it: a frame that is not one of those sizes is `format_mismatch`, a warning.
- **Medium** — `details.medium`: print, social, ooh, web, editorial or packaging.
- **Viewing** — `details.viewing`: where, from how far, for how long: "a phone feed, under 2 s", "a shop window at 2 m, walking past", "a table menu at arm's length, a minute". The viewing sets the text floor, the number of words and the size of the focal point.
- **Placements** — `details.placements`: one entry per size it ships at, with where it runs: ["feed post 1080x1350 px", "story 1080x1920 px"].

**Sizes and safe zones come from the placement's current published spec**, read with its address and the date, as the design skill's `brief` section says for safe zones. This skill keeps no table of sizes: platforms change them, and a stale table is a wrong answer given with confidence. A client that cannot read the web writes the size it assumes, marked "unverified, from memory, <date>", and puts it first in the report.

## Print

- **Trim** is the finished size the printer cuts to: the brief's `format` in mm or in.
- **Bleed** is artwork carried past the trim on every side, so a cut that drifts never shows a white hairline. 3 mm (0.125 in) is the standard value; some printers ask for more, and the printer's figure wins. Record it in `details.bleedMm`. A photo or a colour field that touches the trim runs on to the frame's edge.
- **The frame is the trim plus the bleed on every side.** A 210 × 297 mm flyer with 3 mm bleed is a 216 × 303 mm frame, in proportion. Pick a scale, such as 4 px per mm (864 × 1212 px), write it in the brief's `constraints`, and size everything at it. The system audit compares the frame's proportion with trim + 2 × bleed, so any scale passes, and a frame drawn at the trim size is reported with "add the bleed".
- **The safety margin** keeps text, logos and anything that must not be cut inside the trim. The printer's spec gives it; when it gives none, take it from the grid's margin, never less than the bleed, and write it in the brief. Pass the area inside it as `safeArea` on every figma_check_layout, in frame px: for the flyer above, a 3 mm bleed (12 px) and a 5 mm margin (20 px) give "32,32,800,1148".
- **The text floor** comes from the reading distance: decide it in pt, convert it at your scale (1 pt is 1/72 in, about 0.353 mm), and pass it as `minTextSize`.
- **Images** are placed at their final size; one enlarged past its pixels prints soft. Check each image's pixel size against its placed size and the resolution the printer asks for, and list any that fall short in the report.
- **Colour on paper** is the printer's to match: when a colour must hold, say in the report that a proof is needed, with the brand's print values when it has them.
- **Delivery.** One frame per page, in reading order, named `<Piece> / <placement> <size>` ("Repair night / flyer 210x297 mm", its back "Repair night / flyer back 210x297 mm"). After a passing sign-off, figma_export_frames_to_pdf { nodeIds, outputPath, final: true } writes them as one PDF. Until then every render is a preview.

## Social

- **A feed post, a story and a carousel are different placements**: each its own frame at its own size, composed for its proportion (Adaptations, below).
- **Safe zones.** A story or a reel carries the platform's interface over its top and bottom. Read the zones from the platform's spec, pass them as `safeArea`, and keep the message, the logo and the action inside; the design skill's `brief` section says what to do when the figures cannot be read.
- **The viewing render.** A feed is scrolled with a thumb: render the post at the size a phone shows it and read it in the time `details.viewing` gives. A 1080 × 1350 post shown 390 px wide is figma_export_node { nodeId, maxSize: 488 }. One idea; the message legible at that size; the focal point found first in the squint.
- **The text floor** of a frame shown at phone width comes from the device, converted to frame px as the design skill's `brief` section says; pass it as `minTextSize`.
- **A carousel** is a set of frames of one size, named in order: the first card earns the swipe, the last carries the action, and the cards share one grid so the set reads as one piece.

## Out of home

- Billboards, shelters and posters are read at a distance and often in motion: one message, as few words as it allows, the largest type the format takes, strong contrast between the message and its ground. Write the word count you allow as a success line.
- Sizes, bleed and safe areas come from the media owner's spec, with its date; a large format is drawn at a scale, as print is.
- The viewing render is the squint, figma_export_node { nodeId, maxSize: <the long side ÷ 8> }: the message and the brand must both read in it. For a roadside site, read it at half that size too.

## Banners, editorial, packaging

- **A banner set** comes in the sizes the ad network lists, each its own frame composed for its proportion: a wide strip is not a squeezed rectangle. The file-size limit and the animation rules are the network's: write them in `constraints`. A banner that moves is the motion role.
- **An editorial spread** is two pages: the format is the spread's size ("420x297 mm spread"), with the bleed on every outer edge as in print. Keep text out of the gutter where the pages bind, give facing pages one grid, and put the folio and the running head in the same place on every spread.
- **Packaging** dielines come from the printer: draw the faces the user asks for as flat frames at their size, and say in the report that no dieline was drawn.

## Adaptations

- Each placement is its own deliverable: a frame at its delivery size, named for its placement, built from the same brief and the same system. Re-compose for the proportion: the message, the hierarchy and the palette stay; the layout moves. Never scale a frame to another size.
- Start from the signed master: clone it beside itself (figma_clone_node { nodeId, x, y, name }), resize the clone to the new placement (figma_resize_nodes), then move its blocks to the new grid and check it as a new section.
- Adapting a signed piece later is the section gear. Its brief is signed and no longer in force, so reopen it: figma_set_brief { briefId, reopen: true, format, details }, with `format` and `details.placements` naming every placement, the new one included. Then figma_sign_off { nodeIds, lenses, rounds } on the new frames only.

## The brief call for a piece

figma_set_brief { role: "graphic", gear: "top", title: "Repair night poster", goal: "neighbours bring a broken bike to the co-op's Thursday repair night", audience: "people walking past the co-op's window, and its followers scrolling a local feed", message: "Bring a broken bike on Thursday and ride it home.", proof: ["six repair stands", "mechanics on hand from 6 to 9 pm", "tools included"], constraints: ["4 px per mm", "the printer asks for 3 mm bleed and a 5 mm margin", "the date and the address are mandatory"], givens: "the co-op's logo and green; no other styles in the file", success: ["the date and the message read in the squint render", "no text under 9 pt at print size", "the feed post reads at 390 px wide in 2 s"], tone: { words: ["hands-on", "neighbourly", "direct"], not: "cute" }, format: "420x594 mm poster, 1080x1350 px feed post", defaultToAvoid: "a bike silhouette at sunset under a centred headline", details: { medium: "print", viewing: "a shop window at 2 m, walking past", bleedMm: 3, placements: ["poster 420x594 mm", "feed post 1080x1350 px"] } }

The result's `briefId` goes into every later figma_set_brief, figma_check_layout and figma_sign_off; `missingForSignOff` lists what the sign-off will still ask for.

Evidence (claim ids, for maintainers): [C-377] [C-270] [C-390] [C-385]
