---
name: figxel-design
description: Design a page, screen, poster, slide or styleframe in Figma the way a senior designer does. Brief, real directions, styleframes, a system, the build, then measured critique rounds. State the gear first; a section runs the section gear, a page or more the whole skill.
---

# Design — from a brief to a signed-off design

A design made in one pass reads as generated: it lands where every similar request lands, and nobody measured its details. One agent runs this whole process as passes, each with an exit gate.

No house style: no typeface, palette, layout or effect is a default; each is decided from the brief and the subject, and the report says why.

## Gear: state it first

| Gear | Choose it when | Read | Process | Rounds |
|---|---|---|---|---|
| Edit | a word, a colour, one element | nothing more | match what is there; one check | 0 |
| Section | a part added to a design already on the canvas | workflow `build`, critique `lenses` | goal, message and success in the reply; two directions in words; lenses: message; type and composition; finish QA | 1 |
| Page | a new deliverable for people who come to it: a page, a screen, a deck, or one view on its own, such as a landing hero | `brief`, `directions`, `system` | full brief, two or three cards, a styleframe of the leading hero (two on a near tie) | 2 |
| Top | it must stop a stranger who did not come for it (a poster, an ad in a feed), or it carries a campaign or brand idea | `brief`, `directions`, `system` | the whole process, three styleframes | 3 |
| Storyboard styleframes | the storyboard skill asks for its 3–6 key frames | `system`, critique `lenses` | the system, the build, the still lenses; originality once, on the set | 1 |

The request picks the gear, not its size: a section joins a design already on the canvas, so a hero asked for with no design around it is a one-view page. Take the top gear only when its column holds.

**Reading.** Two calls start any gear but Edit: this index, then the first section in its Read column, such as figma_get_guide { topic: "design", section: "brief" } (another skill's section names that skill as the topic). Read each next one when its stage begins, never ahead; after the build, the stage table names what follows. figma_create_from_spec's own description carries the spec grammar.

**No plugin session** (figma_status lists none, or a call answers NO_SESSION): an agent cannot open the plugin. Tell the user to run the Figxel plugin in Figma desktop, call figma_status once more, then stop; never poll.

Every gear stops at the sign-off bar or its round budget, then reports what remains. What the user gave (a brand, a system, a reference) is decided: the directions vary only what it leaves open. Styles merely saved in the file are not: section `brief` decides whose they are.

**Checkpoint.** By default you own the brief and run to the end. With `checkpoint: "storyboard"`, or a brief that asks to see the work first, stop after the decision line, show it with the styleframes (at the section gear, the cards; figma_select, figma_zoom_to), and wait for approval.

## The stages

| # | Stage | Where | Exit gate |
|---|---|---|---|
| 0 | Gear | the reply | the gear is stated |
| 1 | Brief | `brief` | the message in one sentence; success as checks; whose system the file holds |
| 2 | Look | `brief` | the subject's world past the obvious; the default named |
| 3 | Directions | `directions` | Direction 0; cards apart from it and each other on two axes or more |
| 4 | Styleframes, choice | `directions` | the styleframes the gear asks for, scored; a decision line |
| 5 | System | `system` | every size, gap and colour traces to a stated rule |
| 6 | Build | the workflow loop; one view: the chosen styleframe, cloned | figma_check_layout ok for each section |
| 7 | Critique | the critique skill; one sample a round (`finish`) | the sign-off bar, or the gear's rounds |
| 8 | Finish | `finish` | details pass done; report delivered |

## Hard rules

1. Write the brief before the first node.
2. From the page gear up, never ship the first idea: write Direction 0 and two or more real directions, and test the choice on styleframes.
3. Every number comes from a stated rule in the system.
4. Measure, then look: figma_check_layout { nodeId, audit: ["craft", "tells"] } before the render, every info answered; positions and sizes come from the document, not the picture.
5. A tell that stays is a decision, written in the report with its reason (section `tells`).
6. Fix with targeted edits; never rebuild a section that is mostly right. A one-view deliverable's chosen styleframe is that section: clone it and refine it.

## Sections of this skill
- `brief` (references/brief.md) — the seven lines, whose system the file holds, the look.
- `directions` (references/directions.md) — Direction 0, cards and scores, styleframes, the choice.
- `system` (references/system.md) — type, grid, composition, colour, shape, imagery, copy as rules.
- `tells` (references/tells.md) — the clusters in numbers; what reads as generated.
- `finish` (references/finish.md) — renders per view, finish defects, details, the report.

Evidence (claim ids, for maintainers): [C-238] [C-239] [C-068] [C-085] [C-070]
