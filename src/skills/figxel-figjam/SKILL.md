---
name: figxel-figjam
description: Build a FigJam board with Figxel. One white wrapper section, one zone per call, the right node for each need, connectors last, and a board audit after every zone. Use on any figma.com/board file.
---

# FigJam boards — a wrapper, zones, and connectors last

A board (a figma.com/board/ link) has one page: organise it with sections, not pages. Your work runs through the same loop as a design — plan, build one zone per call, check each zone — with FigJam's own node types.

Board writes are verified live one tool at a time: figma_status lists what this board refuses (`unavailableTools`). A refusal is UNSUPPORTED with safeToRetry true: nothing changed, so use another tool or pass `session` for a file where it runs — do not retry the same call.

## 1. Orient
- figma_status: the session's editor is FigJam. With a Design file connected too, pass `session` on every call.
- figma_get_design_context { absolute: true } reads every board type: stickies, shapes with text, connectors (`from` / `to` in the form the connector tools take, plus a `connectors` edge list), tables, code blocks, sections; `abs` is each node's box on the page. figma_get_metadata adds `board`: the top-level sections and counts by type.
- To find content: figma_search_nodes { text } and figma_scan_text_nodes also search sticky, shape, connector-label and table-cell text.

## 3. Structure
- One white wrapper section holds the whole board, so it moves as one unit. Zones are sections inside it; cards are sections inside zones. Frames only for small auto-layout pieces (a badge, a pill).
- A section whose title is a text inside it gets name "" (the label would repeat the title). Keep the name when there is no title text.
- Size from the content outward. A zone people will fill (votes, ideas, feedback) is sized for the expected activity, not for today's content, and gets a few example stickies to show what goes there.
- Spacing on a 4 px grid: zone padding about 68 top, 60 right, 100 bottom, 80 left; 60–64 between items; about 92 between sibling sections and 120 between rows of sections.

## 4. Which node for what
| Need | Node |
|---|---|
| One idea to discuss, vote on or move | sticky |
| Headings, narrative, instructions | text — never stickies |
| A flowchart step, decision, database | shape with text |
| A relation between two nodes | connector |
| Rows and columns of data | table — never a grid of shapes |
| Code | code block |
| A web page | link preview (figma_create_link_preview) |
| A zone or a card | section |
| A numbered marker | shape "label" |

## 6. Build: one zone per call
- First the wrapper: figma_create_from_spec { spec } with a white section (name "", a rough size); every zone then goes into it by parentId.
- Then each zone: figma_create_from_spec { parentId: <wrapper>, spec } — the section, its title, its stickies or cards (`arrange` lays them out from their real sizes, `hug` fits the section), and its connectors by `ref`. Topic "spec" has the fields and a worked retro zone.
- Stickies are 240×240, or 416×240 with `wide` (about 100 words or more); they grow taller with their text and never take a size.
- More stickies into an existing zone: figma_create_stickies { stickies, parentId, columns } — laid out from their real heights with a 64 px gap; `parentOverflow` says when they run past the zone.
- Connectors come LAST, made in their final parent, and are never moved or reparented afterwards: a moved connector keeps a stale route. In a spec they are built after everything else; with figma_create_connectors, after the nodes they join exist. Re-point or restyle one with figma_edit_connectors.
- Board copy: short phrases, no em dashes. A bulleted list is one text with `list`.

## 7. Check every zone
- figma_check_layout { nodeId: <zone>, audit: ["board"] }: section_overflow, sticky_overlap, dangling_connector, label_too_long, text_not_charcoal, off_palette, section_name_duplicate — fix every warning.
- figma_export_node { nodeId: <zone> } once, to judge it.
- figma_fit_sections { nodeIds: [<cards>, <zone>] } on zones holding finished content, inner sections in the same call (fitted first); then the wrapper with padding "68,60,100,80". Never fit a zone sized for people to fill, or one of a row of equal cards.

## 9. What a board refuses
- Local styles, components and variants (build them in a Design file), keyframe motion and video export: UNSUPPORTED.
- The Slides tools.
- A new page, images and every other write not yet verified on a board — figma_status `unavailableTools` lists them.

## Sections of this skill
- section `board-recipes` (references/board-recipes.md, or figma_get_guide { topic: "figjam", section: "board-recipes" }) — planning a board (archetypes, reading order, distance), type and colour, diagrams from primitives, and anti-patterns.
