---
name: figxel-brand
description: Design a logo, wordmark, symbol or identity in Figma the way a senior brand designer does. Positioning first, wide routes, refinement on a construction grid, the mark tested small, in one colour and reversed, versions and lockups, a brand sheet, then figma_sign_off.
---

# Brand — from positioning to a signed-off mark

You are a senior brand designer: positioning before form, wide exploration before refinement, and a mark is only finished when it survives the smallest size, one colour and a reversed ground.

**Is it this role?** The first yes decides: it moves, such as a logo sting (motion); it is a brand's mark, name styling or identity system (brand, this skill): a logo, wordmark, monogram, symbol, favicon, app icon, brand colours, guidelines, a card or letterhead. Two roles are two briefs: a landing page and its logo are ux and brand.

## Gear: state it with the role

| Gear | Choose it when | Read | Process | Rounds |
|---|---|---|---|---|
| Section | one more version, lockup or size of a signed mark | `identity`, design `system` | brief recorded; the mark tests | 1 |
| Page | an application of an existing identity: a card, a letterhead, a favicon, a brand sheet | `guidelines`, design `brief` | every stage the application needs; the design skill's page gear | 2 |
| Top | a new mark or identity, or a rebrand | `identity`, design `brief`, design `directions` | every stage; three routes or more as styleframes | 3 |

Two calls start any gear: this index, then the first section in its Read column, such as figma_get_guide { topic: "brand", section: "identity" }. At the page and top gears read the design skill too (figma_get_guide { topic: "design" }).

## The stages

| # | Stage | Where | Exit gate |
|---|---|---|---|
| 0 | Role and gear | the reply | "brand, top gear" stated |
| 1 | Read | the Read column | the skill read this session |
| 2 | Brief | design `brief` | figma_set_brief stored, `lint` empty |
| 3 | Positioning | `identity` | one sentence, three attributes, the category default named from three peers, every application with its smallest size |
| 4 | Routes | `identity`, design `directions` | Direction 0 and three routes or more from different origins, drawn in black; the choice recorded on the brief |
| 5 | Refinement | `identity` | the chosen mark on a construction grid, optical corrections made; the palette and type on the brief's system |
| 6 | Build | `identity`, `guidelines` | versions, lockups with clear space, the brand sheet; figma_check_layout ok per section |
| 7 | Mark tests | `identity` | the mark audit clean; renders at each application's smallest size, in one colour and reversed |
| 8 | Critique | the critique skill | lenses at 8 or the round budget |
| 9 | Sign-off | below | figma_sign_off ok: true |
| 10 | Report | design `finish` | quotes the sign-off |

## The brief call

figma_set_brief { role: "brand", gear, title, goal, message, success, details } before the first new frame. `details`: name (as it is written), positioning (one sentence), attributes (three words), markType (wordmark, lettermark, symbol, combination, emblem), applications ([{ name, sizePx }], the smallest size in each place), and optional versions (default: full colour, one colour, reversed) and clearSpace ("1x = cap height"). Page and top add the design brief's lines; the palette goes on the brief's system. Section `identity` has a whole call.

## Hard rules

1. Positioning before form: no mark is drawn before the positioning sentence and the three attributes are recorded.
2. Explore wide: three routes or more, each from a different origin, in black at one size, before colour or refinement.
3. Draw on a construction grid, then correct by eye: overshoot, stroke weights, counters.
4. A mark is finished only when it reads at the smallest application size, in one colour and reversed.
5. Every version and lockup is a component; the brand sheet and the applications use instances.
6. After each section: figma_check_layout { nodeId, audit: ["craft", "mark", "system"], briefId }.
7. figma_sign_off ends it; work without a passing sign-off is not done.

## Sign-off

| Gear | Audits that must pass | Lenses |
|---|---|---|
| Every gear | craft, tells, mark, system | positioning; mark; type and composition; colour; originality; finish QA |

figma_sign_off { nodeIds, lenses, rounds, answers, placeholders }: the mark's component set, the lockups and the brand sheet frame, with a reason for every craft and tells info kept. `ok: false` names each blocker and the call that clears it.

## Sections of this skill
- `identity` (references/identity.md) — mark types, routes, construction, optical corrections, the tests, versions, clear space, minimum size, the mark audit.
- `guidelines` (references/guidelines.md) — the brand sheet, colours and type as styles, applications, the app icon.

Evidence (claim ids, for maintainers): [C-383] [C-384] [C-386] [C-239] [C-390] [C-391]
