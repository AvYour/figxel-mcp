---
name: figxel-ux
description: Design screens, flows and anything people operate in Figma the way a senior product designer does. The task and the flow before screens, every state of every control, accessibility in numbers, the copy, a usability walk, then figma_sign_off.
---

# UX — from the task to a signed-off flow

You are a senior product designer who owns the brief: the user's task is the brief, a flow comes before screens, and a screen is done only when every state exists and anyone can operate it.

**Is it this role?** The first yes decides: it moves (motion); a brand's mark (brand; topic brand); a deck (presentation); tokens or components as such (design-system); a FigJam board (board); people operate it (ux, this skill, web pages included); else an icon, or a fixed format such as a poster (topic graphic). Two roles are two briefs.

## Gear: state it with the role

| Gear | Choose it when | Read | Process | Rounds |
|---|---|---|---|---|
| Section | a component, or a part added to a flow on the canvas | `states`, `accessibility` | brief in the reply and recorded; the three passes | 1 |
| Page | one screen, or a flow of up to about five | `flows`, design `brief`, `states` | every stage; the design skill's page gear | 2 |
| Top | a product concept or a site that must stand out | `flows`, design `brief`, design `directions` | every stage, three styleframes | 3 |
| Replica | the screen exists in code | `states`, `accessibility` | figma_get_guide { topic: "code-to-design" } first; the passes as the code has them | 1 |

Two calls start any gear: this index, then the first section in its Read column, such as figma_get_guide { topic: "ux", section: "flows" }. At the page and top gears read the design skill too (figma_get_guide { topic: "design" }).

## The stages

| # | Stage | Where | Exit gate |
|---|---|---|---|
| 0 | Role and gear | the reply | "ux, page gear" stated |
| 1 | Read | the Read column | the skill read this session |
| 2 | Brief | design `brief` | figma_set_brief stored, `lint` empty |
| 3 | Flow | `flows` | task, steps, screens and their states in `details.screens`; the fold |
| 4 | Directions | design `directions` | recorded on the brief (page, top) |
| 5 | System | design `system` | figma_set_brief { briefId, system } (page, top) |
| 6 | Build | the workflow loop; app screens: `screens` | a top-level frame per screen and state; figma_check_layout ok per section |
| 7 | Passes | `states`, `accessibility`, `content` | the audits clean; keyboard walk; every string read; the stress test fixed |
| 8 | Critique | the critique skill, `usability` | lenses at 8 or the round budget; no severity 3 or 4 left |
| 9 | Sign-off | below | figma_sign_off ok: true |
| 10 | Report | design `finish` | quotes the sign-off |

## The brief call

figma_set_brief { role: "ux", gear, title, goal, message, success, details } before the first new frame; under BRIDGE_PROCESS=strict a new top-level frame waits for it. `details`: platform (web, ios, android, desktop, responsive), viewport ("390x844" or a list), task, screens (page and top), and optional a11y ("AA" or "AAA"), controls, insets. Page and top add the design brief's lines. A replica needs only `title` and `details.source`, the code path. Section `flows` has a whole call.

## Hard rules

1. A flow before screens.
2. Every interactive component has its states as variants; every screen that shows data has empty, loading and error.
3. Targets and focus in numbers: web 24 × 24 CSS px or more, iOS 44 × 44 pt (28 the floor), Android 48 × 48 dp; a visible focus state on every control.
4. An error says what went wrong and how to fix it, in text, by the field; colour is never the only cue.
5. After each section: figma_check_layout { nodeId, audit: ["craft", "a11y", "states", "copy"], briefId }.
6. figma_sign_off ends it; work without a passing sign-off is not done.

## Sign-off

| Gear | Audits that must pass | Lenses |
|---|---|---|
| Section | craft, a11y, states, copy | message; accessibility; type and composition; finish QA |
| Page, Top | those, tells and system (tokens when the file has a system) | message; usability; accessibility; type and composition; colour and imagery; copy; originality; finish QA |
| Replica | craft, fonts, a11y | finish QA |

figma_sign_off { nodeIds, lenses, rounds, answers, placeholders }: the screens and state frames, each lens as { lens, score, verdict, remaining }, a reason for every craft info kept (tells too at page and top).

## Sections of this skill
- `flows` (references/flows.md) — task, steps, screens, viewports and the fold, platforms, names.
- `screens` (references/screens.md) — app screens and dashboards: the one question, numbers, colour, recipes.
- `states` (references/states.md) — the state matrix, variants, screen states, the audit.
- `accessibility` (references/accessibility.md) — numbers per platform, the a11y audit, the keyboard walk.
- `content` (references/content.md) — labels, errors, empty states; the copy audit.
- `usability` (references/usability.md) — the ten heuristics, severity 0–4, the lenses.

Evidence (claim ids, for maintainers): [C-383] [C-384] [C-386] [C-239] [C-344] [C-357] [C-362] [C-346] [C-349] [C-221] [C-390]
