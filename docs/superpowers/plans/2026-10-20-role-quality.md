# Role quality: work that reads as a professional's — plan, 2026-10-20

The role process (ADR #42) makes an agent work like a designer: a brief, directions, styleframes, a system, audits and a sign-off. After the product redesign of 2026-10-19 (recorded in the [role tests](2026-10-19-role-tests.md)) the owner's verdict was that the result still reads as AI-generated, not professional. This plan traces why and lists what Figxel adds so that the process stops that outcome instead of only describing it.

## What happened

The design skill's [tells](../../../src/skills/figxel-design/references/tells.md) already name the generated look. The product's screens matched most of it, and nothing in the process said so:

| Tell in the skill | What the product's screens did |
|---|---|
| Cluster 2: near-black with one saturated accent | `#141414` with one orange accent. The palette was the owner's (a given), but it was never named as the cluster |
| Cluster 4, the software kit: three or more cards of one size and radius, one radius on every container | Every card 16 px radius and 16 px padding, in grids of 309 or 472 |
| `card_trio`: icon, title, two lines, three times | The New chat starters, Appearance, Approvals, Workspaces |
| A line icon on every card | A 40 px icon tile in almost every settings card |
| One skeleton on every view | Eight settings pages: header, heading, card grid |
| Even spacing everywhere | A 16 px gap almost everywhere |

The brief's own `defaultToAvoid` read: "a centred greeting, and admin pages built as stacked boxed cards". The build ended as exactly that.

## Why the process let it through

1. **The tells do not bind.** Every `tells` kind is `info` until calibrated [C-248]. At sign-off an info only needs a written reason, so a generic design signs off with reasons.
2. **The tells were not run while building.** Hard rule 4 of the design skill asks for `craft` and `tells` after each section; nothing enforces it, and the run checked `craft` only.
3. **`defaultToAvoid` is free text.** Nothing compares the build with it.
4. **The builder scores its own work.** The critique skill suggests a subagent for the message and originality lenses; sign-off accepts lens scores from anyone, including the agent that built the piece.
5. **No taste anchor.** `references` is an optional brief field that no check reads. The agent starts from its own average instead of from named professional work.
6. **Feedback skipped the directions step.** "Too much text" was answered with the first idea (cards with icons), not with two alternatives.

## Goal

On a re-run of the product brief, the patterns the brief names to avoid are caught while the section is built, and a top-gear piece cannot sign off on the builder's own scores alone.

Not a goal: a house style. Every tell can be right for some brief (the design skill says so). The aim is that a generated default is a decision someone made and can defend, not an accident.

## Workstreams

### W1 · An avoid list that binds

- `figma_set_brief` gains `avoid[]`: structured entries the audits can match, such as tell kinds (`card_trio`, `centred_stage`), cluster ids (`cluster:4`), and the new kinds of W2.
- `defaultToAvoid` and `direction0` stay as prose; the design skill's `brief` section tells the agent to translate them into `avoid` entries.
- At page and top gear, a finding that matches the brief's own `avoid` list is a **warning** in `figma_check_layout`, whatever the kind's default severity. A warning cannot be answered away at sign-off; only changing the brief, on the owner's word, lifts it.
- Files: `src/shared/roles.ts`, `src/server/tools/brief.ts`, `src/plugin/ops/brief.ts`, `src/plugin/tells.ts`, `src/plugin/ops/check.ts`, the design skill's `brief` and `tells` sections.

### W2 · Detectors for what slipped through

New `tells` kinds, info until calibrated (W7), warnings through W1:

| Kind | Measures |
|---|---|
| `skeleton_repeat` | The same structure fingerprint (child order, container types, sizes rounded) across three or more deliverables; the deck audit has a slide version of this |
| `icon_tile` | An icon in a filled square or circle at the start of most cards in a view |
| `flat_rhythm` | The gaps of a view form fewer than three distinct levels, or sections sit no further apart than the items inside them |
| `boxiness` | The share of content area inside filled or stroked containers, and the deepest nesting |
| `centred_stage` | On an app screen, the main content centred both ways in its region |
| `kpi_tile`, `greeting_title`, `accent_share` | The rest of the dashboard kit: stat tiles with an icon or sparkline, a greeting as the title, the accent on chrome |
| `hue_pair`, `reflex_display_face` | Second-order defaults: one hue pretending to be two; a display face generated work reaches for |
| `cluster_1` … `cluster_6` | "Matches cluster N on k of m features", computed instead of judged by eye; cluster 6 is the dashboard kit |

Each kind gets fixtures in `test/` (one positive and one negative case built from the product's screens).

**Built 2026-10-20:**

- **W1 and W3:** the avoid list, tells by default, and tells in each create result.
- **W2:** every kind above, info until calibrated [C-400].
- **W4:** the reviewer on each lens, the top-gear gate, the `critique_cold` prompt and the brief's `next`.
- **W9 skills:** the ux `screens` section, the scene sentence, the mode and colour strategy, and the critique's verdict before numbers.

### W3 · Tells while building

- At page and top gear, the result of `figma_create_from_spec` carries a short `tells` delta for the created subtree: the kinds this section added, and any that match the brief's `avoid`.
- `figma_check_layout` runs `tells` with `craft` by default when a page or top brief is in force.

### W4 · An independent reviewer

- Lens scores in `figma_sign_off` carry a `reviewer`: `self`, `agent:<id>` (another agent, which receives only the brief and the renders), or `owner`.
- At top gear, `message` and `originality` must come from a reviewer other than the builder. At page gear a self-review is allowed, but the report and the sign-off record say "self-reviewed".
- A `critique-cold` prompt sets up the reviewer: the brief, the renders, the references (W5), and nothing from the build.
- Where the client cannot run a second agent, the owner scores the two lenses (a short form in the report).
- Possible later: MCP sampling, so the server can ask the client's model for a cold review. Whether clients support it is unverified and needs a claim before any design depends on it.

### W4b · A panel, for judging and for planning

One reviewer is better than none; several with different jobs see more. The owner asked for agents that judge and plan together (2026-10-20).

**Judging.**

- At top gear the critique runs as a panel. Each reviewer sees only the brief, the renders and the references, never the build notes or the other reviewers' findings.

  | Reviewer | Judges |
  |---|---|
  | Art director | Message, originality, the generated look |
  | UX | The task, the flow, the states, the heuristics |
  | Accessibility | Contrast, targets, focus, labels |
  | Engineer | Whether the system (tokens, components) can build it as drawn |
  | Owner's proxy | The goal and the success checks in the brief |

- A chair merges the findings:
  - It resolves conflicting fixes.
  - It keeps a disagreement visible when it cannot be resolved.
  - It writes one list of fixes.
- Each reviewer's scores go into the sign-off record under its own `reviewer` id.
- The roles a panel needs come from the role table: a graphic piece swaps UX and engineer for a print or placement reviewer.

**Planning.**

- At page and top gear, two or three directions come from separate agents, each given only the brief. One agent asked for three directions tends to make three variations of one idea.
- The panel scores the directions on the styleframes before the choice.

**How it runs.**

- Figxel is an MCP server and cannot start agents.
- It provides:
  - a `critique-panel` prompt and a `directions-panel` prompt;
  - the record format;
  - the gate: at top gear, sign-off counts distinct reviewers.
- Where it runs:
  - In a client with subagents, the panel runs in parallel.
  - Elsewhere, it runs one reviewer at a time in a fresh context, or the owner scores.
- What the report shows: who reviewed, and where the panel disagreed.

### W5 · References as a taste anchor

- At top gear `references` is required: three or more real products or works, each with what it lends (density, type, grid, colour).
- The design skill's `brief` section places them on a moodboard frame (`figma_import_image`).
- The critique renders the piece beside its references at the same scale; originality and type-and-composition are judged against them.

### W6 · Owner feedback opens two alternatives

- `figma_set_brief { briefId, revision }` records the owner's redirection and which screens it touches.
- For those screens, sign-off asks for two alternatives in words or small styleframes, and the choice, before the rebuild, as the section gear already does.

### W7 · Calibration

- Build a corpus: finished professional files (with permission, or the owner's own) and agent output, with the product redesign as the first labelled generated sample.
- Run `spikes/calibrate-tells.mjs` on it; promote the kinds that separate the two to warnings at page and top gear, as the roadmap already plans.

### W8 · Icon sets: Heroicons first

Generated design draws icons badly or uses emoji (`emoji_icon`). Heroicons is MIT-licensed and ships 24 px outline, 24 px solid, 20 px solid and 16 px solid sets [C-399].

- **`figma_search_icons { query, set? }`:** names and synonyms, with a short preview list.
- **`figma_insert_icon { name, style, size, parentId, colorVariable? }`:**
  - The first use of an icon creates a component on an "Icons" page or frame; later uses make instances.
  - The colour is bound to a variable when one is given.
- **Packaging:** the SVGs ship inside the npm package with the MIT notice [C-399]. The SVG-only `heroicons` package's layout is checked before it is chosen as the source.
- **Skills:** the `graphic` and `ux` skills say when an icon earns its place, one set and one weight per piece, and "match the codebase's set when there is one".
- **Later:** other sets, each with its licence recorded as a claim first.

### W9 · Ideas from published design skills

The [design skills research](2026-10-20-design-skills-research.md) is the record. What it adds here:

- **An app-screen chapter for the ux skill:**
  - the screen's one question;
  - KPIs as type, not tiles;
  - a noun title, no greeting;
  - the accent on data;
  - tabular figures.
- **A dashboard-kit cluster** for W2.
- **A light-or-dark scene sentence, a mode and a colour strategy** in the brief and the system.
- **A substance guard** in the critique: a page made clean by being empty fails.
- **Sameness checks inside one view** for W2.
- **Icon rules with numbers** for W8.

Its numbers come from small studies judged by models, so each is tested before it becomes a rule, and registered as a claim if it carries the design. Text is rewritten, not copied.

### W10 · From the live session

These come from the [role tests](2026-10-19-role-tests.md):

- **Findings 6, 6b and 6c (blocker for 0.2.0):** false `STALE` on the agent's own changes.
- **Finding 24:** a budget and progress reports for `figma_check_layout` over several roots.
- **Finding 25:** centred text made fill-width.
- **Findings 18 and 26:** overlays, menus and sticky bars counted as `covered`.
- **A handoff pack:** one call that gives a coding agent what the product run assembled by hand:
  - tokens per mode,
  - text styles,
  - components,
  - a render and the measurements of each screen.

One more came from the showcase session of 2026-10-20:

- **Motion sign-off judged at rest (fixed 2026-10-20).** A multi-scene piece (frame 4:262 in "Figxel Showcase") passed `figma_check_motion` and two cold reviews, and sign-off still returned 72 blockers, so the final render was refused. Craft judged the animated frame at rest, where its scenes stack on one another. Under a motion brief, `figma_check_layout` and `figma_sign_off` now judge layout where the viewer sees it, and count in `restPose` what they leave to the frames. The options weighed and the rule are in the [roles spec](2026-10-14-roles-spec.md#motion-where-the-viewer-sees-it).

## Order

Revised on 2026-10-20 by the [base workflow decisions](2026-10-20-base-workflow.md#10-decisions-2026-10-20): the quality levers come first; the false `STALE` fix lands before 0.2.0 is released.

| Step | Workstreams | Why in this place |
|---|---|---|
| 1 | W1, W3 | Small, and they change what the agent does during the build |
| 2 | W2, with the dashboard-kit cluster and the kinds from the [design skills research](2026-10-20-design-skills-research.md) | Gives W1 the kinds the product run needed |
| 3 | The app-screen chapter of the ux skill; the light-or-dark scene sentence and the mode in the brief (W9) | The guidance the product's screens had none of |
| 4 | W4: one cold reviewer, verdict before numbers | The largest lever on judgement; W4b's panel only if the benchmark shows a gain |
| 5 | The benchmark's first three briefs | Measures what steps 1–4 changed |
| 6 | W8 | Self-contained and visible to users |
| 7 | W5, W6 | Process changes in the skills, with light tool support |
| 8 | W7 | Needs a corpus; turns infos into warnings |
| Before 0.2.0 | W10 finding 6 | The release's trust claim depends on it |

## Acceptance

- **The product brief, re-run:**
  - The centred New chat stage, the settings card grids and the icon tiles are reported during the build as warnings that match the brief's `avoid`.
  - The sign-off fails while they stand.
- **A top-gear sign-off with only self-scored lenses** fails, naming the two lenses that need another reviewer.
- **`figma_insert_icon`:**
  - It places a Heroicons icon as an instance of a component made once.
  - Its colour is bound to the given variable.
  - The package carries the MIT notice.
- **Gates:** unit tests for each new kind, and the full suite and the doc checkers green.

## Open questions for the owner

1. Should role quality ship in 0.2.0 with trust, or as the next release after it?
2. W4: is a short owner score acceptable as the fallback reviewer in clients without subagents?
3. W7: which finished professional files may go into the calibration corpus?
4. W8: Heroicons as the only bundled set at first, or Heroicons plus one more?
