# FigJam boards — planning, type and colour, diagrams, anti-patterns

## 2. Plan the board
- What is it for, who uses it, once or recurring? Match an archetype: retro (lanes), brainstorm (instructions plus zones people fill), decision (context | options | decision), review (a story left to right), flow (a diagram).
- Reading order is left to right, top to bottom: context first, evidence in the middle, the ask last; appendix below.
- Distance carries meaning: items of one thought 60–90 px apart, different topics 200–400, different parts of the board 1000 or more.
- Every board opens with a title at its top-left that reads at overview zoom; a template also gets a short "how to use" zone.

## 5. Type and colour
- Inter throughout. Board title 64–96 Bold, zone heading about 48 Bold, card title 28–32 Semi Bold, body 20–24 Regular (never below 20), metadata 16.
- Text is Charcoal #1E1E1E — the default here. Hierarchy comes from size, never from grey text.
- Colour by NAME, resolved per node type: a blue sticky, a blue connector and a blue shape are three different swatches, and a name lands on FigJam's exact swatch while a hex one channel off shows as a custom colour. Sections take a hex for now; light tints work (#F5FBFF, #EBFFEE, #FFF7F0, #F8F5FF) with white cards inside.
- Gold draws the eye; red means broken, never just "look here"; green only for small status marks.
- Sticky colours can carry meaning; one scheme gives yellow to questions, blue to discussion, green to what went well, pink to concerns, red to blockers, teal to decisions and violet to ideas.

## 8. Diagrams
The official Figma MCP's generate_diagram is a hosted service: it turns Mermaid or a description into a laid-out diagram. Figxel has no such layout engine yet; build diagrams from primitives — shapes with text, joined by connectors by `ref` — in figma_create_from_spec, one zone per call. Keep a call to about 15–20 nodes and split a bigger diagram into zones. Lay rows out with `arrange` ("row", "grid:N"); connectors are elbowed by default; a label is a few words.

## Anti-patterns
- Stickies for narrative text; shapes as decoration; more than one or two emphasis marks per zone.
- Stickies staggered, overlapping or touching a section's edge; one text per bullet.
- The whole board in one call; no wrapper; no title; section labels left on above their own title.
- Body text below 20 px; grey text for hierarchy; red for attention.
