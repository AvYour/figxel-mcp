---
name: figxel-design
description: Design a page, screen, poster, slide or styleframe in Figma the way a senior designer does. Brief, real directions, styleframes, a system, the build, then measured critique rounds. State the role and gear first; a section runs the section gear, a page or more the whole skill.
---

# Design — from a brief to a signed-off design

A design made in one pass reads as generated: it lands where every similar request lands. One agent runs this process as passes, each with an exit gate. No typeface, palette, layout or effect is a default; each comes from the brief and the subject.

## Role first

The first yes names it: it moves (motion; topic storyboard); a brand's mark (brand; topic brand); a deck (presentation; topic slides); tokens and components (design-system); a FigJam board (board; topic figjam); people operate it (ux; topic ux); an icon or illustration (illustration; topic graphic); a fixed format: a poster, an ad, print (graphic; topic graphic). Read the role's skill too. figma_set_brief { role, gear, title, goal, message, success } records the brief before the first new frame, and figma_sign_off ends the work. Two roles are two briefs.

## Gear: state it next

| Gear | Choose it when | Read | Process | Rounds |
|---|---|---|---|---|
| Edit | a word, a colour, one element | nothing more | match what is there; one check | 0 |
| Section | a part added to a design already on the canvas | workflow `build`, critique `lenses` | goal, message and success; two directions in words; three lenses | 1 |
| Page | a new deliverable for people who come to it: a page, a screen, a deck, or one view on its own, such as a landing hero | `brief`, `directions`, `system` | full brief, two or three cards, a styleframe of the leading hero (two on a near tie) | 2 |
| Top | it must stop a stranger who did not come for it (a poster, an ad in a feed), or it carries a campaign or brand idea | `brief`, `directions`, `system` | the whole process, three styleframes | 3 |
| Storyboard styleframes | the storyboard skill asks for its 3–6 key frames | `system`, critique `lenses` | the system, the build, the still lenses; originality once, on the set | 1 |

The request picks the gear, not its size: a section joins a design already on the canvas, so a hero asked for with no design around it is a one-view page.

**Reading.** Two calls start any gear but Edit: this index, then the first section in its Read column, such as figma_get_guide { topic: "design", section: "brief" }. Read each next one when its stage begins, never ahead.

**No plugin session** (none in figma_status, or NO_SESSION): you cannot open the plugin. Ask the user to run the Figxel plugin in Figma desktop, call figma_status once more, then stop; never poll.

What the user gave (a brand, a system, a reference) is decided: the directions vary only what it leaves open. Styles merely saved in the file are not: section `brief` decides whose they are.

**Checkpoint.** With `checkpoint: "storyboard"`, or a brief that asks to see the work first, stop after the decision line, show the styleframes (section gear: the cards) and wait for approval; otherwise run to the end.

## The stages

| # | Stage | Where | Exit gate |
|---|---|---|---|
| 0 | Role, gear | the reply | both stated |
| 1 | Brief | `brief` | figma_set_brief stored: the message, success as checks, whose system it is |
| 2 | Look | `brief` | the subject's world past the obvious; the default named |
| 3 | Directions | `directions` | Direction 0; cards apart from it and each other on two axes or more |
| 4 | Styleframes, choice | `directions` | styleframes scored; a decision line; both recorded on the brief |
| 5 | System | `system` | every size, gap and colour traces to a recorded rule |
| 6 | Build | the workflow loop; one view: the chosen styleframe, cloned | figma_check_layout ok for each section |
| 7 | Critique | the critique skill; one sample a round (`finish`) | the sign-off bar, or the gear's rounds |
| 8 | Finish | `finish` | details pass done; figma_sign_off ok; report delivered |

## Hard rules

1. Write the brief before the first node.
2. From the page gear up, never ship the first idea: Direction 0, two or more real directions, the choice tested on styleframes.
3. Every number comes from a stated rule in the system.
4. Measure, then look: figma_check_layout { nodeId, audit: ["craft", "tells"] } before the render; positions and sizes come from the document, not the picture. An info that stays is a decision, with its reason in the report.
5. Fix with targeted edits; never rebuild a section that is mostly right. A one-view deliverable's chosen styleframe is that section: clone it and refine it.

## Sections of this skill
- `brief` (references/brief.md) — the seven lines, whose system it is, the look, figma_set_brief.
- `directions` (references/directions.md) — Direction 0, cards, styleframes, the choice.
- `system` (references/system.md) — mode, type, grid, colour, shape, images, icons, copy as rules.
- `tells` (references/tells.md) — what reads as generated, in numbers.
- `finish` (references/finish.md) — renders, finish defects, details, sign-off, the report.

Evidence (claim ids, for maintainers): [C-238] [C-239] [C-068] [C-085] [C-070] [C-383] [C-384] [C-386]
