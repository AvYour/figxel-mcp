# Roles: a mandatory, tool-enforced professional process for every Figxel agent — design spec

> **Saved to the repository on 2026-10-16.** Written in a session's scratch folder on 2026-10-14 and kept as it was. Since then the motion gate it builds on was committed (0.1.1) and the three audio tools were held back behind `BRIDGE_ENABLE_AUDIO`, so the tool counts in §0 item 5 and §6.5 and the byte budgets in §1.1 must be measured again before implementation. The [next releases plan](2026-10-16-next-releases.md) schedules it.

Research and design only, 2026-10-14. Nothing in the repository was edited. This builds on the motion gate as it stood in the working tree on 2026-10-14 (uncommitted: `src/server/motion-process.ts`, `src/server/motion-plan.ts`, `src/shared/motion-plan.ts`, `src/server/tools/motion-plan.ts`, `src/plugin/ops/motion-plan.ts`, `ErrorCode.PROCESS_REQUIRED`, `Config.processMode`, the `final` flag on `figma_export_video`, ADR #41). Where that work is still moving, this spec says what it assumes.

---

## 0. Decisions in brief

1. **A role is not a skill.** A role is a row in one table (`src/shared/roles.ts`): its triggers, the skills it must read, the brief lines it must record, the audits and lenses its sign-off runs, and its deliverables. Nine roles; seven are gated (ux, graphic, illustration, brand, presentation, design-system, board) plus motion, which keeps its own gate and joins this one. UX writing is a stage and lens of ux, not a gated role.
2. **Three new skills, no more:** `figxel-ux`, `figxel-graphic` (it also carries illustration and icons), `figxel-brand`. Presentation, design-system, board and motion keep their skills and gain a few lines; slides gains one reference (`story`). Everything shared (brief, directions, system, finish, critique) stays in the design and critique skills, which every still role reads at the page and top gears.
3. **One routing rule** decides the role: *people operate it* (tap, click, type, scroll) → ux; *it is looked at in a fixed format* → graphic; *it is the mark or the system of a brand* → brand; *it is a deck* → presentation; *tokens and components* → design-system; *a FigJam board* → board; *it moves* → motion.
4. **Gate only new work.** Under `BRIDGE_PROCESS=strict` (the motion gate's variable and default), a new top-level frame, component or section, a `figma_create_from_spec` into an empty top-level target, a first slide of an empty deck, a new board wrapper and a new storyboard are refused until a brief is in force for that file in this process. Edits to existing content, clones, pages, single shapes, texts and images are never gated.
5. **Three new tools (134 → 137 in the catalog, 136 registered by default, assuming the motion gate lands at 134):** `figma_set_brief` (style group, write), `figma_get_brief` (read group), `figma_sign_off` (style group, write). `figma_export_node` and `figma_export_frames_to_pdf` gain `final?: boolean`, mirroring `figma_export_video { final: true }`.
6. **The brief lives in the file**, in shared plugin data under the storyboard namespace the motion plan already uses (`figmamcp`): on a brief block `figma_set_brief` draws at an empty spot (it replaces the hand-built brief block the design skill asks for today), or on a node the agent names, plus an index on the document root so a second session can find and adopt open briefs. The motion plan stays its own record on the animated frame and inherits audience, message and format from a role-motion brief.
7. **"Done" is `figma_sign_off`.** It runs the role's measured checks (hard floor: `figma_check_layout` ok with the role's audits; `figma_check_motion` ok for motion), checks the brief is complete for its gear (Direction 0, directions, the choice, styleframes, the system's numbers), takes the agent's lens scores, rounds and an answer for every kept info, then records the result with a content fingerprint on each deliverable, stamps the brief block "Signed off", closes the brief, and selects and zooms to the work. A final export refuses a deliverable whose sign-off is missing, failing or older than its last change. A tool cannot stop an agent from writing "done" in chat; what it can do is make the honest path the only one that leaves a record, and show the user which work is unsigned (`figma_status`, the brief block).
8. **Eight new `figma_check_layout` audits** (`a11y`, `states`, `copy`, `system`, `deck`, `mark`, `icons`, `library`), each finding measurable from the plugin; severities follow the evidence (warning only where a verified standard sets the number, info elsewhere until calibrated, as C-248 did for `tells`). Two fixes to existing behaviour: `low_contrast` must exempt inactive components and logotypes (WCAG 2.2 SC 1.4.3 exceptions).
9. **Guided** runs every gated call and adds the refusal's sentences as `processWarnings`; **off** tracks nothing and gates nothing, while the three tools keep working. Strict degrades to guided, and says so in `figma_status`, wherever it could not be satisfied: the toolset lacks `figma_set_brief` (e.g. `BRIDGE_TOOLSET=core`), the editor's `set_brief` cell is not `yes`, or the gate's read fails.
10. **One implementer, two waves, after the motion gate lands:** wave A is the enforcement core plus the ux role (records, tools, gates, `a11y` / `states` / `system` / `copy` audits, `figxel-ux`); wave B is graphic, illustration, brand and presentation (their skills and the `grid`-in-`system`, `deck`, `mark`, `icons` kinds) plus `library`.

---

## 1. Baseline found

### 1.1 Skills and their budgets (measured 2026-10-14)

Budgets from `test/skills.test.ts` T1: an index ≤ 5,000 bytes and ≤ 120 lines; a reference ≤ 10,000 bytes; a skill ≤ 60,000 bytes; a description ≤ 300 bytes, a plain YAML scalar (no `": "`, no `" #"`, no leading special character). A guide answer's footer ≤ 1,200 bytes, a section answer ≤ 11,200, a prompt ≤ 16,000. Section slugs are unique across the tree and never a skill's short name.

| Skill | Index body (bytes, of 5,000) | Whole skill (of 60,000) | Room |
|---|---|---|---|
| workflow | 4,988 | 38,612 | index full |
| design | 4,968 | 49,106 | index full; one ~10 KB reference fits |
| critique | 4,975 | 33,194 | index full |
| motion | ~4,990 (being rewritten by the motion gate) | 45,950 | index full |
| storyboard | 4,967 | 32,690 | index full |
| slides | 4,872 | 8,217 | ~120 bytes |
| figjam | 4,633 | 7,326 | ~360 bytes |
| design-system | 4,480 | 13,177 | ~520 bytes |
| design-to-code | 3,752 | 5,943 | — |
| prototype | 3,964 | 4,250 | — |
| code-to-design | 2,570 | 2,845 | — |

Other full surfaces: `SERVER_INSTRUCTIONS` is 1,994 of 2,000 bytes after the motion gate's edit (T7; its first 512 bytes must name figma_status, figma_get_guide, design, storyboard, motion and critique; `test/agent-guidance.test.ts` pins "owns the brief", "Do not ask permission step by step", "One section per call", "build.restart", "figma_check_layout", "figma_get_guide", "Figma Design, FigJam and Slides files: figma_status shows each file's editor" and "topic figjam or slides"). `figma_get_guide`'s description is ~935 of 1,024 characters after the motion gate's sentence. `figma_check_layout`'s description is ~970 of 1,024.

Footer growth was measured with a copy of `guideFooter`: today's worst footer is 935 bytes (motion index); with three more skills it is ~1,045, with four ~1,089 — three new skills fit under 1,200 with margin, five would not.

### 1.2 Checks that exist

- `figma_check_layout` (plugin `src/plugin/ops/check.ts`): text overflow, overlap, covered, clipped, collapsed, outside parent, fill-in-hug, low contrast (WCAG 4.5:1 / 3:1, C-075), zero size, empty frame/text, default names, placeholder copy, sibling overlap; slide kinds (out_of_slide, text_cut_by_slide, bleed); audits `tokens`, `names`, `fonts`, `board`, `craft` (`src/plugin/craft.ts`: near_size 1.12×, no_shared_edge, tangent, glyph_gaps, oldstyle_figures, unbalanced_space, safe_area, low_contrast_over_shape, min_text, stroke_crosses_text, edge_slices_text, weak_graphic_contrast 3:1 for hairlines ≤ 2 px), `tells` (`src/plugin/tells.ts`, info only, C-248). The audit enum is capped at `.max(6)`.
- `figma_check_motion` (`src/server/motion-audit.ts`, 23 rules) and `figma_review_video`.
- **Missing entirely:** touch/click target size, interactive states (focus, hover, pressed, disabled, error), screen states (empty, loading, error), focus visibility, input boundaries, error-by-colour-only, UX copy rules, grid adherence, type-scale and spacing-scale conformance, format/size conformance, deck density, mark legibility at size, icon-set consistency, variable-mode completeness. No skill mentions touch targets, focus states, empty or loading states, or heuristic evaluation (grep of `src/skills`, 2026-10-14). Disabled text and logotypes are flagged by `low_contrast` although WCAG exempts both.

### 1.3 The motion gate this builds on (as read on 2026-10-14)

- `MotionProcess` (per MCP server process): `noteSkill(short, via)` is fed by `figma_get_guide` (any topic or section, by the skill it resolves to), by prompts (`registerPrompts(..., onUse)`) and by `skill://` resources (`registerSkillResources(..., onRead)`); only `motion` and `storyboard` count for it.
- `keyframeGate` reads the plan with one `get_motion_context` read (`scope.topLevelFrameIds`, `motionPlans`), refuses with `PROCESS_REQUIRED` (in `NEVER_REACHED`, so retry-safe) and `partial: { created: [], missing }`; `finalGate` needs the last full `figma_check_motion` at the render's fps with no keyframe write since (in-process counters). `withProcessWarnings` adds `processWarnings` in guided mode. `figma_batch` gates keyframe steps and refuses `set_motion_plan` as a step.
- Message style: "`<tool>` was refused before any change: a motion designer plans before animating, and this session skipped a step. Missing: …" with hint "First …, then …. Then send this call again." This spec follows that style.

---

## 2. The roles (task part 1)

### 2.1 Routing rule and role table

Ask in order; the first yes decides. A request that spans two roles is two briefs (a landing page and its logo are ux and brand, signed off separately).

1. Does it move on a timeline? → **motion**
2. Is it the mark, name styling or identity system of a brand? → **brand**
3. Is it a slide deck? → **presentation**
4. Is it tokens, styles or reusable components as such? → **design-system**
5. Is it a FigJam board? → **board**
6. Do people operate it (tap, click, type, scroll, navigate)? → **ux** (web pages included: they have states, targets and a fold)
7. Is it an icon, pictogram or illustration? → **illustration**
8. Is it looked at in a fixed format (print, post, ad, poster, cover)? → **graphic**

| Role id | The professional | Trigger words (request or file) | Skills read before the brief (strict) | Brief `details` key |
|---|---|---|---|---|
| `ux` | Senior UI/UX (product) designer | screen, app, web app, website, landing page, dashboard, onboarding, sign-up, log-in, checkout, settings, form, flow, user journey (as screens), wireframe, modal, dialog, drawer, navigation, empty state, mobile, iOS, Android, desktop app, admin | `ux`; at page/top also `design` | `ux` |
| `graphic` | Senior graphic designer | poster, flyer, ad (static), banner, social post, carousel, story (static), thumbnail, cover, editorial, spread, magazine, menu, invitation, certificate, infographic, label, print, billboard, OOH, signage | `graphic`; at page/top also `design` | `graphic` |
| `illustration` | Senior illustrator / iconographer | icon, icon set, pictogram, illustration, spot illustration, hero illustration, pattern, mascot, sticker, badge | `graphic` (section `illustration`); at page/top also `design` | `illustration` |
| `brand` | Senior brand / identity designer | logo, wordmark, logotype, monogram, lettermark, symbol, brand mark, identity, rebrand, brand guidelines, brand colours, favicon, app icon, business card, letterhead | `brand`; at page/top also `design` | `brand` |
| `presentation` | Senior presentation designer | deck, slides, presentation, pitch deck, keynote, investor deck, sales deck, webinar, a figma.com/slides file | `slides`; at page/top also `design` | `presentation` |
| `design-system` | Senior design-system designer | design system, tokens, variables, theme, light/dark mode, component library, UI kit, components with variants, documentation | `design-system` | `designSystem` |
| `board` | Workshop / information designer for boards | FigJam, board, workshop, retro, brainstorm, journey map, affinity map, flowchart (board), sitemap (board), kanban, plan board | `figjam` | `board` |
| `motion` | Senior motion designer (existing gate) | animate, animation, motion, reel, video ad, title, end card, logo sting, loop, animated icon, micro-interaction, GIF, MP4 | `storyboard` or `motion` | `motion` (plus `figma_set_motion_plan`) |
| (ux writer) | Content designer — a stage of `ux`, not gated | microcopy, button labels, error messages, empty-state text, tone of voice, rewrite the copy | `ux` section `content` | — |

**Judged not necessary now:** a data-visualization role (charts sit inside ux, graphic and presentation work; a `chart` audit — colour as the only cue, direct labels, axis contrast — is a candidate for later), a packaging/dieline role (Figma is not the tool for dielines), a service-design role (journey maps are the board role), a creative-director role (the design skill's directions and the critique already play it), a marketing copywriter (the copy rules of ux and graphic cover what a design needs).

### 2.2 Shared stage skeleton

Every still role runs the same skeleton; each role card below says what its stages contain. **[T]** marks a stage the tools enforce under strict; the rest are taught by the skill and verified at sign-off.

| # | Stage | Exit gate | Enforced by |
|---|---|---|---|
| S0 | Role and gear stated | one line in the reply | skill |
| S1 | Read the role's skill (and the design skill at page/top) | the skill served in this process | **[T]** `figma_set_brief` refuses until read |
| S2 | Brief recorded | `figma_set_brief` stored; lint clean | **[T]** new work refused until a brief is in force |
| S3 | Role research (flow, medium, positioning, story, inventory, purpose) | role-specific, recorded in `details` | sign-off checks the fields |
| S4 | Direction 0, two or three directions, styleframes (page/top) | recorded with `figma_set_brief { briefId, direction0, directions, chosen, styleframes }` | **[T]** sign-off blocker if missing |
| S5 | The system as numbers (page/top) | `figma_set_brief { briefId, system }` | **[T]** sign-off blocker if missing; the `system` audit measures the build against it |
| S6 | Build, one section per call, a check after each | `figma_check_layout` ok per section | skill (workflow loop) |
| S7 | The role's own passes (states and accessibility; grid and optical finish; mark tests; density; tokens and states; board audit) | the role's audits clean | **[T]** sign-off runs them |
| S8 | Critique rounds with the role's lenses | the sign-off bar, or the round budget (1 / 2 / 3) with what is left listed | **[T]** sign-off takes the scores and rounds |
| S9 | Sign-off | `figma_sign_off` ok | **[T]** a final export refuses otherwise |
| S10 | Report, quoting the sign-off | — | skill |

### 2.3 Role cards

#### R1 — UI/UX designer (`ux`)

- **Voice.** "You are a senior product designer who owns the brief: the user's task is the brief, a flow comes before screens, and a screen is not done until every state of it exists and anyone can operate it."
- **Responsibilities.** The user's task and context; the flow and information architecture; one screen per step at the target viewports; every interactive state; platform conventions (safe areas, system bars, navigation patterns); accessibility in numbers; the content (labels, errors, empty states); components and auto-layout ready for handoff; a prototype when asked.
- **Stages.** S3 = the flow: the task in one sentence, the steps, a screen per step and the states each screen needs (`details.screens`); the fold at the target viewport (C-270). S7 = three passes: states (every interactive component has its state variants, every data screen has empty / loading / error), accessibility (the `a11y` audit, then a keyboard walk: is there a focus state on every control, in a logical order), content (the `copy` audit, then a read of every label and error). S8 adds two lenses: usability (a walk through the task against Nielsen's ten heuristics, findings rated 0–4) and accessibility.
- **Quality bar (sign-off).** `figma_check_layout` ok with `craft`, `a11y`, `states`, `copy` (plus `tells` and `system` at page/top, `tokens` when the file has a system). Text 4.5:1, large text 3:1 (C-075); UI boundaries and states 3:1 except inactive components (C-221, extended); targets at or above the platform minimum (web 24×24 CSS px AA; iOS 28×28 pt minimum, 44×44 pt default; Android 48×48 dp); a focus state on every interactive component; an error state that says what is wrong in text, not only in colour; no text under the platform minimum (iOS 11 pt) or the brief's floor; the primary action above the fold at the target viewport; every declared screen state present; no usability finding of severity 3 or 4 left; lenses ≥ 8 or the round budget spent with the remainder listed.
- **Deliverables.** Screens as top-level frames named `<Flow> / <nn> <Screen>[ / <State>]`; components with state variants; a flow overview when there are more than three screens; prototype flows when asked; the report with an accessibility summary.
- **Served by.** `ux` (index; sections `flows`, `states`, `accessibility`, `content`, `usability`); design `brief`, `directions`, `system`, `finish`; workflow `build`, `spec`, `check`; design-system (when the file has one); prototype; critique `lenses`, `rounds`. Tools: figma_set_brief, figma_create_from_spec, figma_combine_as_variants, figma_add_component_property, figma_check_layout (audits above), figma_set_reactions, figma_set_prototype_flows, figma_sign_off.
- **Gears.** `section` (a component or part, rarely new work), `page` (one screen or a flow of up to about five), `top` (a product concept or a site that must stand out), `replica` (code-to-design: the code is the brief).

#### R2 — Graphic designer (`graphic`)

- **Voice.** "You are a senior graphic designer: the format and the moment of viewing set every decision, and the grid and the type scale are written as numbers before the first element."
- **Responsibilities.** The medium and its specification (size, bleed, safe zones, delivery format) with source and date; the viewing moment (a phone feed in under two seconds, a street at distance); the idea; a grid, a type scale and a spacing scale as numbers; image direction; optical finish (ink alignment, rag, figures, punctuation); adaptations to other placements.
- **Stages.** S3 = the medium: format with units, bleed for print, the placement's safe zones (from the design `brief` rules), the viewing time. S7 = the optical pass: the `system` audit (format, grid, scale, spacing, palette, optical margin), then the details pass of design `finish`. Adaptations: each placement is its own deliverable frame, signed off with the same brief.
- **Quality bar.** `figma_check_layout` ok with `craft`, `tells`, `system`; frame size equals the brief's format; nothing in the safe zone's cover; type sizes on the recorded scale; blocks on the recorded grid (or each break declared); bleed present for print (frame = trim + 2 × bleed when the brief says so); lenses ≥ 8 (message, type and composition, colour and imagery, copy, originality, finish QA).
- **Deliverables.** One frame per placement at delivery size, named `<Piece> / <placement> <size>`; print as PDF through `figma_export_frames_to_pdf { final: true }`.
- **Served by.** `graphic` (index; sections `placements`, `grid`); design `brief`, `directions`, `system`, `tells`, `finish`; critique. Tools: figma_set_brief, figma_set_layout_grids, figma_create_from_spec, figma_check_layout, figma_export_node / figma_export_frames_to_pdf `final`, figma_sign_off.
- **Gears.** `page` (one piece for people who come to it), `top` (it must stop a stranger), `section` (an adaptation of a signed piece to another size).

#### R3 — Illustrator / iconographer (`illustration`)

- **Voice.** "You are a senior illustrator: one construction system — grid, keylines, stroke, corners — and every drawing in the set obeys it, so the set reads as one hand."
- **Responsibilities.** The metaphor for each concept (recognisable without its label, never instead of the label, C-214); the construction grid (canvas, live area, padding, stroke, corner radius); vector construction with figma_create_vector, figma_boolean_nodes, figma_flatten_nodes; consistency across the set; testing at every size it will render.
- **Stages.** S3 = the set list and the metaphor per item, with the generic first idea struck out (design `brief` "look" rule). S5 = the construction grid recorded in `details.grid`. S7 = the `icons` audit plus renders at each `details.sizes` value.
- **Quality bar.** `icons` audit clean (one canvas size, one stroke weight unless declared, ink inside the live area, whole-pixel geometry at small sizes); renders at the smallest size readable; lenses ≥ 8 (recognition, consistency, craft, originality).
- **Deliverables.** Components on one page, one per icon, named `icon/<name>`, combined as variants when they have sizes or styles.
- **Served by.** `graphic` section `illustration`; design-system `library` (components); critique.

#### R4 — Brand / identity designer (`brand`)

- **Voice.** "You are a senior brand designer: positioning before form, wide exploration before refinement, and a mark is only finished when it survives the smallest size, one colour and a reversed ground."
- **Responsibilities.** Positioning in one sentence and three attributes; the mark type decision (wordmark, lettermark, symbol, combination, emblem) with a reason; a wide exploration (at least three different routes, each from a different origin — design `directions`); construction and optical corrections; versions (full colour, one colour, reversed); lockups and clear space; minimum size; colour with values and roles; typography; a brand sheet with applications.
- **Stages.** S3 = positioning, attributes, competitors' marks named with what each does (the category default), the applications list with their smallest size. S7 = the mark tests: the `mark` audit, renders at each application's smallest size, the one-colour and reversed versions, the swap test of critique `originality`.
- **Quality bar.** `mark` audit clean (no detail under 1 px at the smallest application size, every declared version present and truly one colour where it says so, clear space as recorded); `system` palette conformance; lenses ≥ 8 (positioning, mark, type and composition, colour, originality, finish QA). Logotypes are exempt from text contrast (WCAG 1.4.3), so mark contrast is judged against 3:1 for graphics as guidance, at info.
- **Deliverables.** Mark components with version variants; a brand sheet frame (versions, clear space, minimum size, colours with hex and roles, type, do/don't, two applications); an app icon at 1,024 × 1,024 px when the applications include one (Apple HIG).
- **Served by.** `brand` (index; sections `identity`, `guidelines`); design `brief`, `directions`, `system`; design-system (saving the palette and type as styles); critique.
- **Gears.** `top` for a new mark; `page` for an application of an existing identity (a card, a letterhead).

#### R5 — Presentation designer (`presentation`)

- **Voice.** "You are a senior presentation designer: the takeaway and the arc come first, every slide says one thing in a sentence headline, and nothing is shrunk that could be cut."
- **Responsibilities.** The takeaway (the message line), the room (projected, read on screen, both), the arc (sections), one idea per slide, assertion headlines on content slides, evidence as visuals rather than bullet lists, density budgets by room, speaker notes when presented, the tonal arc and colour roles (slides `deck-recipes`).
- **Stages.** S3 = the outline: the arc, a sentence per slide, the room and its floor. S7 = the `deck` audit, then the side-by-side render of every batch (slides index step 4).
- **Quality bar.** `figma_check_layout` ok with `craft`, `deck`, `copy`, `system` on every slide; no text under the brief's floor (for a projected deck the default floor is derived in §4.5); lenses ≥ 8 (story, type and composition, colour and imagery, copy, originality, finish QA).
- **Deliverables.** The deck (Figma Slides) or 1920 × 1080 frames (Design); a PDF through `figma_export_frames_to_pdf { deck: true, final: true }`.
- **Served by.** `slides` (index; sections `deck-recipes`, new `story`); design `brief`, `directions`, `system`; critique.

#### R6 — Design-system designer (`design-system`)

- **Voice.** "You are a senior design-system designer: tokens before styles before components, every value bound, every component with all its states, and nothing shipped undocumented."
- **Responsibilities.** Whose system the file holds (design `brief` givens); primitives and semantic tokens with modes, scopes and code syntax; styles bound to tokens; components with properties and complete state variants; documentation (descriptions, a foundations page); naming that matches code.
- **Stages.** S3 = the inventory (`details.components`, `details.modes`, `details.platforms`, the code source if any). S7 = the `tokens`, `names`, `fonts`, `states`, `library` and component-level `a11y` audits.
- **Quality bar.** No `unbound_color`; every semantic variable valued in every mode, no broken alias; every interactive component set has default, focus and disabled (plus hover on pointer platforms and error on inputs); no variant property left as Figma's default name; every component set described; targets and focus rings of the components meet the ux numbers; lenses ≥ 8 (completeness, naming, tokens, documentation, finish QA).
- **Served by.** `design-system` (index; sections `library`, `typography`) and ux `states` (cross-skill read: no duplicate).
- **Gears.** `section` (one component), `page` (a family or the token set), `top` (a whole system), `replica` (from code).

#### R7 — Board designer (`board`)

- **Voice.** "You are a workshop designer: the board exists for what people will do on it, in the order they will do it."
- **Brief.** Purpose, participants (who and how many), the activity, the outcome, minutes.
- **Quality bar.** `board` audit clean (existing kinds), every zone people fill sized for the activity with example stickies, reading order matching the activity; lenses ≥ 8 (purpose and reading order, structure, copy, finish QA).
- **Served by.** `figjam` (index; `board-recipes`).
- **Gears.** `section` (a zone in an existing board: not gated), `page` (a board).

#### R8 — Motion designer (`motion`, existing)

- Keeps its gate and skills. Joins this one at two points: a role-motion brief comes before the Storyboard page's first frame and the piece's frame (both are new work), and `figma_sign_off` runs `figma_check_motion` at the delivery fps (feeding `MotionProcess.noteCheck`), so one sign-off satisfies both the role gate and the motion gate's final render. The plan inherits audience, message and format from the brief (§3.10).
- Gears: the motion skill's `micro`, `sting`, `piece` (and `edit`, never gated).

#### R9 — UX writer (content designer; a stage of ux)

- Copy-only work is an edit and is never gated. The `ux` skill's `content` section carries the rules: a button says what happens with a verb (Apple HIG Writing; C-215); one capitalisation style per element type, used everywhere (Apple HIG Writing); errors near their source, in plain words, saying what went wrong and how to fix it, keeping the input (NN/g error messages; WCAG 3.3.1); empty states that say what will appear and how to start (NN/g empty states); no interjections ("Oops"); labels for every input (WCAG 3.3.2). The `copy` audit measures what can be measured.

### 2.4 What each role's brief must contain

All fields are strings unless shown. "Always" applies at every gear; "page/top" adds the design skill's seven lines; `details` is validated per role by a strict schema (an unknown key is refused, because the SDK would otherwise strip it silently).

| Role | Always | Page/top add | `details` (required ✱) | Recorded later, required at sign-off (page/top) |
|---|---|---|---|---|
| all still roles | `role`, `gear`, `title`, `goal`, `message`, `success[]` | `audience`, `proof[]`, `constraints[]`, `givens`, `tone { words[3], not }`, `format` | — | `direction0`, `directions[≥2] { name, idea, total }`, `chosen`, `styleframes[]` (page ≥1, top ≥3), `system { bodySize, ratio, spacingBase, grid?, palette[] }` |
| ux | as above | as above | `platform`✱ (web, ios, android, desktop, responsive), `viewport`✱ ("390x844" or a list), `task`✱, `screens[] { name, states[] }` (✱ at page/top), `a11y` ("AA" default, "AAA") | as above |
| graphic | as above | as above | `medium`✱ (print, social, ooh, web, editorial, packaging), `viewing`✱ ("a phone feed, under 2 s"), `bleedMm` (✱ for print), `placements[]` | as above |
| illustration | as above | as above | `set[]`✱, `grid { size, padding, stroke?, corner? }`✱, `sizes[]`✱ (px it renders at), `style`✱ | `direction0`, `directions`, `chosen` |
| brand | as above | as above | `name`✱, `positioning`✱, `attributes[3]`✱, `markType`✱, `applications[] { name, sizePx }`✱, `versions[]` (default full colour, one colour, reversed), `clearSpace` ("1x = cap height") | as above, `system.palette` ✱ |
| presentation | as above | as above | `room`✱ (projected, screen, both), `minutes`, `slides` (target count), `arc[]`✱, `notes` (boolean) | as above |
| design-system | as above | — | `scope`✱ (tokens, components, both), `platforms[]`, `modes[]`, `source` (a code path or "none"), `components[]` | — |
| board | as above | — | `purpose`✱, `participants`✱, `activity`✱, `outcome`✱, `minutes` | — |
| motion | as above | as above | `placement`✱, `durationS`✱, `fps`✱ | the motion plan on the frame |
| `replica` gear (ux, design-system) | `role`, `gear`, `title`, `details.source`✱ (the code path), `details.platform`, `details.viewport` | — | — | none (the code decides) |

Optional on every brief: `assumptions[]`, `minTextSize` (frame px), `safeArea` ("x,y,width,height"), `references[]`, `defaultToAvoid` (the design brief's one line).

### 2.5 Overlaps and the smallest skill change

| Change | Why it is the smallest | Bytes (target) | Tests touched |
|---|---|---|---|
| **NEW `figxel-ux`**: index + `flows`, `states`, `accessibility`, `content`, `usability` | No skill teaches flows, states, targets, focus, errors or heuristics today; spreading them over design, critique and workflow would overflow three full indexes | index ≤ 4.9 KB; refs ~6 / 8 / 9 / 6 / 7 KB; skill ~41 KB | T1–T5, T8 automatically; add `ux` to `IN_SCOPE` in `test/skills-acceptance.test.ts` |
| **NEW `figxel-graphic`**: index + `placements`, `grid`, `illustration` | Media specs, bleed, grids as numbers, optical finish and icon construction have no home; `formats` is taken by motion, so the slug is `placements` | index ≤ 4.8 KB; refs ~7 / 8 / 8 KB | as above; `graphic` in `IN_SCOPE` |
| **NEW `figxel-brand`**: index + `identity`, `guidelines` | Identity work (marks, versions, lockups, clear space, minimum size, brand sheet) is absent; the design skill's gears assume a page | index ≤ 4.7 KB; refs ~9 / 7 KB | as above; `brand` in `IN_SCOPE` |
| design index: a **Role first** paragraph (the routing rule, the role's skill read too, figma_set_brief before the first new frame, figma_sign_off ends it); stage 8 exit "figma_sign_off ok" | The gear is chosen here, so the role must be too | +~450, offset by trims of the intro, "No house style", the checkpoint paragraph and section blurbs (all unpinned) | keep every pinned sentence of `skills-acceptance` (gear rows, Read column, "Two calls start any gear…", "a hero asked for…", "Styles merely saved…", "never rebuild…", row 6, NO_SESSION words) |
| design `brief`: "Where the brief lives" uses `figma_set_brief` instead of a hand-built block | The tool draws the block and stores the record | net −200 (brief.md is 9,806 of 10,000) | T8: the block's JSON example disappears; confirm ≥ 9 examples and ≥ 2 spec examples remain |
| design `finish`: the final check ends with figma_sign_off; the report quotes it | — | +~250 (6,070 → ~6,320) | none pinned |
| critique index: one line, "a role skill adds its lenses (ux usability and accessibility, brand the mark, slides the story)"; the sign-off bar ends with "figma_sign_off records it" | Lenses stay in critique; the role's own lens text lives in its skill | +~170 offset by shortening the intro anecdote | `skills-acceptance` critique Read column unchanged |
| workflow index: "State the role and the gear"; step 5 ends with figma_sign_off (it selects and zooms on a pass); `tools` reference rows for the 3 tools; `check` reference lists the 8 audits | the loop is where an agent finishes | index +~80 / −80; tools +~600; check +~1.5 KB | `REWRITTEN.workflow`, `.tools`, `.check` reasons extended; `agent-guidance` `NEW_TOOLS` += 3 |
| slides: NEW reference `story` (arc, assertion headlines, density by room, notes, the `deck` audit) + one index line | the deck principles exist; the story and density rules do not | index +~110 (4,872 → ~4,980; trim a little); story ~6 KB | `REWRITTEN.slides` reason extended |
| design-system index: the role paragraph, the states requirement (pointing at ux `states`), sign-off | the skill already is the role | +~400 (4,480 → ~4,880) | `REWRITTEN["design-system"]` extended |
| figjam index: one line (brief role board before a new board; sign-off at the end) | — | +~160 | **new** `REWRITTEN.figjam` entry (turns off figjam's block-order check, as slides already is) |
| code-to-design: one line (`figma_set_brief { role: "ux", gear: "replica", … }`) | the code is the brief, so the brief is three fields | +~120 | `REWRITTEN["code-to-design"]` extended |
| storyboard / motion: one line each after the motion gate lands (role-motion brief first; the plan inherits; sign-off before the final render) | — | +~150 each, inside their own trims | `REWRITTEN.motion` extended |
| `SERVER_INSTRUCTIONS`: name the role topics in the head; replace the motion-only gate sentence with a general one | the only surface every client sees | draft in §6.3: 1,969 bytes, head checked | T7 and `agent-guidance` pins checked on the draft |
| `figma_get_guide` description: generalise the motion gate's last sentence ("Under BRIDGE_PROCESS=strict new work waits for its role skill and figma_set_brief, keyframes for the motion skill.") | — | same length ±10 chars; ~955 with three new skill names | T10 (≤ 1,024) |
| `figma_check_layout` description: list audit names only, details move to the `audit` param description and workflow `check` | 14 audits do not fit in prose | ≤ 1,024 | T10, `agent-guidance` "not cut off" |
| AGENTS.md (locked): the ids-out-of-prose rule names ux, graphic and brand; Status paragraph (tool count, 14 skills) | convention parity | — | unlock, edit, `lock-docs --update`, relock |
| Prompts (optional, wave B): `design_ux`, `design_graphic`, `design_brand` rows (brief?, checkpoint?), each carrying its skill index + first section | a prompt counts as reading the skill | ≤ 16 KB each | new test block; the old prompt tests are unchanged |

No change to: design-to-code (reads only), prototype (used by ux as is), the design gear table rows.

---

## 3. Enforcement (task part 2)

### 3.1 Principles

1. Only new work is gated; an edit never is. A wrong refusal costs one call; a wrong pass costs the whole process — but a refusal that blocks edits would make the tool unusable, so the classifier errs toward "edit".
2. A refusal is answered before anything is sent (`PROCESS_REQUIRED`, `partial.created: []`, safe to retry with the same `idempotencyKey`), names what is missing, and gives the exact calls that satisfy it.
3. The gate asks for steps that leave a record, never for prose: a skill served, a brief stored, a sign-off stored. What cannot be measured (directions, rounds, lens scores) is recorded by the agent and checked for presence and coherence at sign-off, then shown to the user.
4. Strict only where it can be satisfied; otherwise guided, said once in `figma_status`.
5. Honest limit, as the docs lock states its own: `figma_eval`, edits by hand and another client's writes are not seen; self-reported lens scores can be inflated. The measured checks are the floor; the record makes skipping visible.

### 3.2 State and records

**Per process (server, beside `MotionProcess`):** `RoleProcess` holds
- `skillsRead: Map<short, via>` — every skill served (generalise `noteSkill`: one ledger, both gates read it);
- `inForce: Map<fileKey, BriefRef>` — the open brief this process set or adopted per Figma file (`fileKey` = the session's file key, else file name + editor type); a brief signed off leaves `inForce`;
- the mode, the registered tools, and the per-editor degradation flags.

**In the file (shared plugin data, namespace `figmamcp`, the one `MOTION_PLAN_NAMESPACE` reuses):**

| Key | On | Record |
|---|---|---|
| `brief` | the brief block (a frame "Brief · <title>"), or `nodeId` | `{ v: 1, id, role, gear, title, status: "open" \| "signed", createdAt, updatedAt, lines: { goal, audience, message, proof, constraints, givens, success, tone, format, minTextSize, safeArea, assumptions, defaultToAvoid }, details, direction0, directions, chosen, styleframes, system, deliverables: [nodeId], lastSignOff: { at, ok } }` — `id` is the storing node's id; ≤ 90,000 bytes like the motion plan (C-188's 100 kB cap) |
| `signOff` | each deliverable (top-level frame, component set, section, or the page for a deck) | `{ v: 1, briefId, role, gear, at, ok, fingerprint, checks: [{ name, ok, errors, warnings, infos, unanswered }], lenses: [{ lens, score, verdict }], rounds, answers: [{ kind, nodeId, reason }], exceptions: [...], placeholders: [...], build: { server, skills } }` |
| `briefIndex` | the document root (`figma.root`) | `[{ id, title, role, gear, pageId, status, deliverables, updatedAt }]`, newest first, pruned to 200 entries |

`PageNode` and `DocumentNode` both extend `BaseNodeMixin`, which carries `setSharedPluginData` (plugin typings 1.141.0) — live behaviour unmeasured, so the spike in §6 measures it before the Design cell turns `yes`; until then the index falls back to the current page.

**Fingerprint.** A 32-bit FNV-1a hash the plugin computes over the deliverable's subtree in walk order: id, type, visible, x / y / width / height rounded to 0.5 px, characters, font family / style / size per run, solid fill and stroke hex with opacity, stroke weight, corner radius, effects count, layout mode, gap and padding, image hashes. It is stored with the sign-off and recomputed by `figma_get_brief { nodeId, fingerprint: true }` before a final export. Unlike the motion gate's in-process write counters, it survives sessions and sees edits made by hand.

### 3.3 What counts as new work

The gate runs only while **no brief is in force** for the call's file. With one in force it reads nothing and adds no latency. Without one, it classifies the call; where the parent is not obvious it asks the plugin once (`get_brief { target }`, which answers the target's type, whether it is top level, its child count and, in Slides, whether the deck has any slide with content).

| Call | New work when | Never gated |
|---|---|---|
| `figma_create_frame` | parent is a page (no `parentId` in Design/FigJam, or `parentId` resolves to a PAGE) | inside any frame, section or slide; in Slides (frames go on slides) |
| `figma_create_from_spec` | a root lands at page level (no `parentId` in Design/FigJam, `pageId`, or a PAGE `parentId`) and is a frame, component or section; or `parentId` is a top-level frame or section with 0 children; or, in Slides, the target slide is in a deck where no slide has content | a spec into a frame or slide that has content; single texts or shapes at page level |
| `figma_create_section` | at page level (a FigJam board wrapper, or a Design section) | a section inside a section |
| `figma_create_slides` | the deck has no slide with content (a new deck) | adding slides to a deck with content |
| `figma_create_storyboard` | always (a new top-level board; role motion) | — |
| `figma_batch` | per step, as the step's own op; strict refuses the whole batch at the first gated step, as the motion gate does | — |
| `figma_clone_node`, `figma_create_page`, `figma_create_text`, shapes, `figma_import_image`, `figma_import_svg`, `figma_create_instance`, `figma_convert_to_component`, `figma_combine_as_variants`, `figma_create_animatic`, every modify and style tool | — | always (copies, pages, single elements and edits of existing content) |
| `figma_eval` | not seen (opt-in, honest limit) | — |

A brief **in force** means: this process stored it (`figma_set_brief`) or adopted it (`figma_get_brief` returned it open) for this file, and it has not been signed off since. When the file holds exactly one open brief and this process has adopted none, the refusal offers it by name (a second agent continuing the work adopts it with one read).

### 3.4 `figma_set_brief`

Group style, write, not batchable (like `set_motion_plan`: checked by the server on its own call). Editor rows: Design `yes` after the spike; FigJam and Slides unmeasured until the spike (block as a section with a text in FigJam; no block in Slides, record on the page).

Parameters (top level; `details`, `tone`, `system`, `directions` are strict nested objects):

```
role: "ux" | "graphic" | "illustration" | "brand" | "presentation" | "design-system" | "board" | "motion"
gear: "section" | "page" | "top" | "replica" | "micro" | "sting" | "piece"   (compatibility table below)
title, goal, message, audience?, proof?[], constraints?[], givens?, success[], tone? { words[3], not }, format?,
minTextSize?, safeArea?, assumptions?[], defaultToAvoid?, details? { per role, §2.4 },
direction0?, directions?[] { name, idea, total? }, chosen?, styleframes?[], system? { bodySize, ratio?, sizes?[], spacingBase?, grid? { columns, gutter, margin }, palette?[] { hex, role } },
briefId?   — update that brief: the fields given are merged, the block redrawn
reopen?    — with briefId: a signed brief becomes open again (new work on a signed piece)
nodeId?    — store on this node instead of drawing a block (an existing target frame, a section, a slide)
block?     — default true at page/top in Design and FigJam, false at section, always false in Slides
pageId?, x?, y?, session?, idempotencyKey?
```

Gear compatibility: ux, design-system: section, page, top, replica; graphic, illustration, brand, presentation: section, page, top; board: section, page; motion: micro, sting, piece.

Validation, in this order:

1. **Skill read (PROCESS_REQUIRED in strict, warning in guided):** the role's skill (§2.1 table) served in this process; at page/top for ux, graphic, illustration, brand and presentation, the design skill too.
2. **Structure (INVALID_PARAM in every mode):** `role`, `gear`, `title`, `goal`, `message`, `success` present (for `replica`: `title`, `details.source`); `gear` compatible with `role`; `details` matches the role's schema.
3. **Gear lines (INVALID_PARAM in strict, warning in guided):** the page/top lines and the role's required `details` (§2.4), on a new brief; an update may supply them later, but sign-off requires them.
4. **Lint (INVALID_PARAM in strict, warning in guided):**
   - `message` is one sentence: no sentence end (`.`, `!`, `?` followed by a space and more text) before its last character; at most 200 characters.
   - `tone.words` are exactly three and none is "modern", "clean", "premium" or "elegant" — the words the design skill's brief already forbids as defaults.
   - `format` (page/top, all roles but board and design-system) contains a size with a unit (`px`, `pt`, `dp`, `mm`, `in`), so `format_mismatch` can measure it.
   - `details.viewport` parses as `WxH`.
   - Warnings only, in every mode: no `success` line contains a number or a tool name; `success` has fewer than two lines at page/top.
5. **Size:** the record ≤ 90,000 bytes.

Result: `{ briefId, blockId?, stored: "block" | "node" | "page", status, missingForSignOff: [ ... ], lint: [ ... ] }` — `missingForSignOff` tells the agent now what sign-off will ask for at the end (directions, styleframes, system), so it is never a surprise.

The block: a frame (FigJam: a section) "Brief · <title>" at an empty spot (the storyboard op's `emptySpot`) on `pageId`, else a page named "Explorations" when one exists, else the current page; 720 wide, vertical auto-layout, the tool's default font; lines Role · gear, Message, Goal, Audience, Success, Tone, Default to avoid, and a last line "Status: open — not signed off" that sign-off rewrites. It is a working note, never a deliverable, and every audit skips a node that carries a `brief` record.

Description (≤ 1,024 characters, draft):

> Record the brief of new work before its first frame, as a senior designer writes one: role, gear, title, goal, message and success, plus the lines the gear and the role need (audience, proof, constraints, givens, tone, format, `details`). Roles, and the skill each reads first: ux (screens, flows, anything people operate), graphic (posters, ads, posts, print), illustration (icons, illustration; skill graphic), brand (logos, identity), presentation (decks; skill slides), design-system (tokens, components), board (FigJam; skill figjam), motion (skill storyboard). Stored in the file on a brief block drawn at an empty spot, or on `nodeId`; `briefId` updates one with directions, the choice, styleframes and the system. Under BRIDGE_PROCESS=strict a new top-level frame, a spec into an empty frame, a new deck or a new board waits for a brief, and figma_sign_off ends it.

### 3.5 `figma_get_brief`

Group read. Everywhere (reads). Parameters: `nodeId?` (a node: its own record, else its top-level frame's, else the brief listing it as a deliverable, else its page's), `briefId?`, `fingerprint?` (recompute the deliverable's fingerprint and compare with its sign-off), `target?` (server use: the gate's facts; documented as "the facts the process gate reads"), `session?`. No arguments: every open brief in the file from `briefIndex`. Result: `{ brief, signOff?, motionPlan?, fresh?, open: [...], target? }`. Reading an open brief adopts it for this process (it becomes in force). Description:

> Read the brief a frame was made from — role, gear, lines, directions, system, status — with its last sign-off (and whether the frame changed since) and its motion plan; with no node, every open brief in the file. Reading an open brief adopts it for this session, so a second agent can continue the work. Reads only.

### 3.6 `figma_sign_off`

Group style, write (it stores records), not batchable. Parameters: `nodeId?` | `nodeIds?` (≤ 50) | `deck?` (Slides: the whole deck); `briefId?` (default: the brief in force, else the one listing the node); `lenses[] { lens, score (1–10), verdict ("pass" | "fix"), remaining? }`; `rounds` (integer); `answers?[] { kind, nodeId, reason }` (an info kept on purpose); `placeholders?[]` (every invented fact, or `["none"]`); `fps?` (motion: the delivery rate); `session?`, `idempotencyKey?`.

Server first (no plugin call), in this order — each failure becomes a blocker, not an error:
1. A brief exists and is complete for its gear: the always lines, the page/top lines, the role's required `details`; at page/top `direction0`, two or more `directions`, `chosen`, `styleframes` (page ≥ 1, top ≥ 3) that resolve, and `system` (ux, graphic, presentation, brand palette; illustration `details.grid`).
2. Lenses: every lens the role and gear require is present (table below); each ≥ 8 with verdict pass — or, when `rounds` equals the gear's budget (section 1, page 2, top 3; sting 1, piece 3), a lens under 8 is accepted as an **exception** if it lists its `remaining` findings (the critique skill's "stop at the bar or the budget, then report what is left").
3. Motion: the frame has a plan; the server runs the motion audit at `fps` over the whole timeline (as `figma_check_motion` does) and records it with `MotionProcess.noteCheck`; it must be ok.

Then one plugin op `sign_off` (write): runs `checkLayout` on each deliverable with the role's audits and the brief's floors (`minTextSize`, `safeArea`, platform and viewport for `a11y`, the system's numbers for `system`), requires `ok: true` (no error, no warning), requires an answer for every `craft` info (and, at page/top, every `tells` info) that remains, computes the fingerprint, writes `signOff` on each deliverable (also a failing attempt, so the user sees it), rewrites the block's status line, updates `briefIndex`, and on a pass selects and zooms to the deliverables (replacing the finish step's `figma_select` + `figma_zoom_to`).

Role sign-off sets:

| Role, gear | Audits run | Lenses required |
|---|---|---|
| ux section | craft, a11y, states, copy | message, accessibility, type and composition, finish QA |
| ux page/top | + tells, system (+ tokens when the file has a system) | message, usability, accessibility, type and composition, colour and imagery, copy, originality, finish QA |
| ux replica | craft, fonts (`expectFonts` from the brief's source), a11y (infos only reported) | finish QA |
| graphic section | craft, system | message, type and composition, finish QA |
| graphic page/top | craft, tells, system, copy | message, type and composition, colour and imagery, copy, originality, finish QA |
| illustration | craft, icons, system (palette) | recognition, consistency, finish QA (+ originality at page/top) |
| brand | craft, tells, mark, system (palette) | positioning, mark, type and composition, colour, originality, finish QA |
| presentation | craft, tells, deck, copy, system | story, type and composition, colour and imagery, copy, originality, finish QA |
| design-system | tokens, names, fonts, states, library, a11y | completeness, naming, tokens, documentation, finish QA |
| board | board | purpose and reading order, structure, copy, finish QA |
| motion | craft on the styleframes; the motion audit at `fps` | motion craft, design and type, technical QA, the brief's own lens (+ originality for a piece) |

Result: `{ ok, signOffId?, blockers: [{ what, call }], exceptions, checks: [...], unanswered: [{ kind, nodeId, name, detail }], report: { assumptions, briefAsBuilt, direction, scores, kept, placeholders, where } }` — the `report` object is the design `finish` report's skeleton filled from the records, so the agent's closing message quotes it.

Description (draft):

> End a piece of new work the way a studio signs it off. Runs the role's checks on the deliverables (figma_check_layout with the role's audits and the brief's floors; for motion the frame-by-frame check at the delivery fps), checks the brief is complete for its gear (directions, the choice, styleframes, the system), takes your critique lens scores, rounds and a reason for every info you keep, then records the result and a fingerprint on each deliverable and on the brief block, closes the brief, and selects and zooms to the work on a pass. `ok: false` lists each blocker with the call that clears it. A final export (figma_export_node, figma_export_frames_to_pdf or figma_export_video with `final: true`) needs a passing sign-off newer than the last change. Writes plugin data only.

### 3.7 Final exports

`figma_export_node { …, final?: boolean }` and `figma_export_frames_to_pdf { …, final?: boolean }` (the deck form included). With `final: true` under strict, every exported node that belongs to a brief (its own record, its top-level frame's, or a brief's `deliverables`) needs a passing sign-off whose fingerprint equals the node's now (one `get_brief { fingerprint: true }` read per call). A node that belongs to no brief exports (an edit-only session has nothing to sign). Without `final`, nothing is gated: renders for judging and saved review files always run. `figma_export_video { final: true }` keeps the motion gate's rule and, when the frame belongs to a role-motion brief, also needs its sign-off — which, having run the motion audit, already satisfies the motion gate.

### 3.8 Messages

All refusals: `code: PROCESS_REQUIRED`, `safeToRetry: true`, `partial: { created: [], missing: [...] }`. The sentences are written so guided mode can reuse each `missing` item plus its call as one `processWarnings` entry.

**N1 — new work, no brief in force, no open brief in the file**
- message: `figma_create_frame was refused before any change: a designer writes the brief before the first frame, and no brief is in force for this file in this session. Missing: a brief (figma_set_brief).`
- hint: `Name the role the request needs and read its skill: figma_get_guide { topic: "ux" } for screens, flows and anything people operate; "graphic" for posters, ads, posts, print, icons and illustration; "brand" for logos and identity; "slides" for decks; "design-system" for tokens and components; "figjam" for boards; "storyboard" for anything that moves. Then figma_set_brief { role, gear, title, goal, message, success } (a page or more adds the design skill's brief lines) and send this call again with the same idempotencyKey. Edits inside existing frames are never gated.`

**N2 — new work, no brief in force, one open brief in the file**
- message: `… and no brief is in force for this file in this session; the file holds an open brief, "Bench booking page" (12:40), from an earlier session. Missing: a brief in force.`
- hint: `To continue that work, read it: figma_get_brief { briefId: "12:40" }. For different work, write its own: figma_set_brief { role, gear, … }. Then send this call again.`

**B1 — `figma_set_brief` before the role's skill**
- message: `figma_set_brief was refused before any change: a senior UI/UX designer works from the ux skill's process, and this session has not read it. Missing: the ux skill.`
- hint (page/top): `First figma_get_guide { topic: "ux" }, then figma_get_guide { topic: "design", section: "brief" }. Then send this call again.`

**B2 — gear lines missing (strict; INVALID_PARAM)**
- message: `The page gear's ux brief is missing: audience, tone, format, details.viewport, details.screens.`
- hint: `Example: figma_set_brief { role: "ux", gear: "page", title: "Bench booking", goal: "members book a bench slot online", audience: "neighbours on a phone, next to a broken bike", message: "You fix your own bike here, with a mechanic beside you.", success: ["a visitor books within one scroll at 390 x 844"], tone: { words: ["hands-on", "plain", "welcoming"], not: "cute" }, format: "390x844 px phone, 1440x900 px desktop", details: { platform: "responsive", viewport: ["390x844", "1440x900"], task: "book a 45-minute bench slot", screens: [{ name: "Slots", states: ["empty", "loading", "error"] }] } }`

**B3 — lint (strict; INVALID_PARAM)**
- `message has 2 sentences; a stranger takes away one. Keep the first and move the rest to proof.`
- `tone uses "clean", a word every default claims; take the three words from the subject and the audience (the design skill's brief section).`
- `format has no size with a unit (px, pt, dp, mm, in), so the format check cannot measure the frame. Example: "1080x1350 px Instagram feed".`

**E1 — final export, no sign-off**
- message: `A final export of "Bench booking / 01 Slots" (12:345) waits for a passing sign-off; nothing was written: it has no sign-off.`
- hint: `Run figma_sign_off { nodeId: "12:345", lenses, rounds }, fix what it lists until ok: true, then figma_export_node { nodeId: "12:345", saveTo, final: true }. An export without \`final\` writes now.`

**E2 — final export, stale or failing sign-off**: the same message ending `: it changed after its sign-off at 2026-10-14T13:05Z (fingerprint 8f3a01c2, now 1c9e77d0).` or `: its last sign-off did not pass (3 blockers).`

**S1 — `figma_sign_off` with no brief (strict)**
- message: `figma_sign_off was refused before any change: a sign-off checks work against its brief, and none covers 12:345. Missing: a brief for 12:345.`
- hint: `If this is new work, figma_set_brief { role, gear, … } then figma_set_brief { briefId, styleframes, … } as the work goes; if it is an edit of existing work, it needs no sign-off.`

**S2 — sign-off blockers (a result, `ok: false`, in every mode)**, one line each with its call, e.g.:
- `figma_check_layout found 2 warnings: target_size on "Book" (12:400) is 36 × 36 pt, under iOS's 44 × 44 pt default — grow its frame (figma_resize_nodes) or its padding.`
- `3 craft infos are unanswered (near_size 12:410, tangent 12:411, unbalanced_space 12:300): fix them, or pass answers: [{ kind, nodeId, reason }].`
- `lens usability scored 7 with verdict fix in round 1 of 2: run round 2, or at the budget list what remains.`
- `the brief records no directions: the page gear needs Direction 0 and two or more — figma_set_brief { briefId: "12:40", direction0, directions, chosen }.`
- `the brief declares the screen state "Slots / Empty" and no deliverable is named for it.`

**Guided.** The call runs; its result gains `processWarnings: ["no brief is in force for this file: figma_get_guide { topic: \"ux\" }, then figma_set_brief { … }.", …]` through the motion gate's `withProcessWarnings`. `figma_set_brief` stores a brief that fails the gear lines or the lint, returning them under `lint`. A final export without a passing sign-off runs and warns. Sign-off still answers `ok: false` with blockers and records the attempt.

**Off.** Nothing is tracked or gated; the three tools work as tools (briefs and sign-offs are still worth having).

**`figma_status`** gains `process: { mode, roles: "strict" | "guided (<reason>)", skillsRead: [...], briefs: [{ briefId, title, role, gear, status, deliverables, signedAt }] }`, and its hint adds one sentence while this process has an open brief: `1 brief is open and not signed off: "Bench booking page" (12:40) — figma_sign_off ends it.`

### 3.9 Degradation and edge cases

- **Toolset:** if `figma_set_brief` or `figma_get_guide` is not registered (`BRIDGE_TOOLSET=core`, or groups without `style`), the role gate runs guided and `figma_status` says why; same for final exports when `figma_sign_off` is absent. The core tier stays at 20 tools.
- **Editor:** where `set_brief` is not `yes` for the session's editor (FigJam and Slides until the spike) and `BRIDGE_ALLOW_UNVERIFIED` is off, guided for that session.
- **Plugin too old** (no `get_brief` op): strict refuses new work with the motion gate's re-run hint (`build.restart` is already "plugin" in that case); guided warns.
- **Read failure** in the gate: strict refuses with the failure, as `lookupFailed` does for motion.
- **Several files:** briefs are in force per file; a link in a call picks the session as `addressCall` does today.
- **Several agents:** each process has its own `inForce`; the file's `briefIndex` lets a second agent adopt (N2).
- **Proxies:** the gate runs in the process the client talks to, before forwarding (the motion gate's rule).
- **A signed piece edited later:** edits run; the final export finds the sign-off stale (E2); `figma_sign_off` again; new top-level work on it needs `figma_set_brief { briefId, reopen: true }`.
- **Tests and spikes:** everything that creates top-level frames through the server (`test/server.e2e.test.ts`, `test/write-tools.test.ts`, `test/export.test.ts`, `test/editors-write.test.ts`, `spikes/live-*.mjs`, `spikes/live-all-tools.py`) sets `BRIDGE_PROCESS=off` or records a brief first; the gate's own tests set each mode explicitly.

### 3.10 Relation to the motion gate

- **One ledger.** `noteSkill` already receives every skill short; `RoleProcess` reads the same ledger (refactor: a `SkillLedger` both classes hold, or `registerGuide` / prompts / resources fan out to both).
- **One variable**, `BRIDGE_PROCESS`; no per-role override in v1.
- **The plan extends the brief.** `figma_set_motion_plan` accepts `briefId` (or finds the role-motion brief in force for the file) and, when it does, `brief.audience`, `brief.message` and `brief.format` become optional and are copied from the brief; `durationS` and `fps` stay required (they may default to the brief's `details`). The two records stay separate keys (`brief` on the block, `motionPlan` on the animated frame), because a brief precedes the frame and a plan belongs to one frame.
- **Sign-off feeds the final render.** `figma_sign_off` for motion runs the audit and calls `noteCheck(frameId, { ok, fps, full: true })`, so `finalGate` passes after it unless a keyframe write follows.
- **ADR.** The motion gate is ADR #41; this is ADR #42, "the role process: new work needs a role brief, done is a sign-off".

---

## 4. New and extended checks (task part 3)

All are `figma_check_layout` audits judged after the existing walk from the census (`src/plugin/craft.ts`'s `Census` / `Index`), plain functions over boxes, paints and node properties, with every threshold in one exported table per audit for calibration (as `CRAFT` and `TELLS` are). Where an audit needs the brief's numbers (platform, viewport, floors, system), `figma_check_layout` gains `briefId?` (default: the brief in force, which the server fills in). Unit conversion everywhere is the design brief's rule: device units = frame px × device width ÷ frame width, the device width coming from `details.viewport`.

### 4.0 Fixes to existing kinds

| Kind | Change | Why |
|---|---|---|
| `low_contrast` | Skip text inside a component or instance whose state is inactive (variant or property value matching disabled / inactive), and report logotype text (a node or ancestor named logo / logotype / wordmark / lockup — craft's `PROTECTED` names) as info, not warning | WCAG 2.2 SC 1.4.3 exempts inactive components and logotypes |
| `weak_graphic_contrast` | Skip inactive components | SC 1.4.11 exempts inactive components |
| `min_text` | Default floor from `details.platform` when no `minTextSize`: iOS 11 pt minimum (Apple HIG), converted to frame px | Apple's table; the brief's own floor still wins |

### 4.1 `a11y` (ux, design-system)

Interactive nodes are found in this order: a node with a reaction whose trigger is ON_CLICK, ON_PRESS, ON_DRAG, MOUSE_UP or MOUSE_DOWN (`node.reactions`); an instance or component whose own, main-component or component-set name matches `button|btn|link|tab|toggle|switch|checkbox|radio|chip|input|field|text ?field|select|dropdown|combo|menu ?item|slider|stepper|search|icon ?button|fab`; names listed in `details.controls`. A text run with a hyperlink inside a paragraph is inline and exempt.

| Kind | Severity | Measures | Threshold (source) |
|---|---|---|---|
| `target_size` | warning below the hard minimum, info below the recommended size | the interactive node's box in device units | web: < 24 × 24 CSS px warning (SC 2.5.8 AA), < 44 × 44 info (SC 2.5.5 AAA); iOS: < 28 × 28 pt warning, < 44 × 44 pt info (Apple's minimum and default control sizes); Android: < 48 × 48 dp warning (Android developers, Google Accessibility Help) |
| `target_spacing` | warning (web), info (Android) | web: for each target under 24 × 24, a 24 px circle centred on its box must intersect no other target and no other undersized target's circle (SC 2.5.8 spacing exception); Android: the gap to the nearest target | web as stated; Android 8 dp (Google Accessibility Help) |
| `focus_state_missing` | warning on web and desktop, info on iOS and Android | an interactive component set with no variant value matching `focus|focused|focus-visible|keyboard` | SC 2.4.7 AA requires a visible focus indicator |
| `focus_indicator_weak` | info | the focus variant vs the default: no stroke, outline or effect added at least 2 px thick, or its colour under 3:1 against the default variant's pixels there | SC 2.4.13 AAA (2 CSS px perimeter, 3:1 change) |
| `weak_boundary` | warning | an input-like control's stroke (or, with none, its fill) against the backdrop under 3:1; inactive variants skipped | SC 1.4.11 AA |
| `error_colour_only` | warning | an `error` variant of an input whose texts equal the default variant's (only paints changed) | SC 1.4.1 (colour never the only cue) and SC 3.3.1 (the error described in text) |
| `input_unlabelled` | info | an input-like instance with no TEXT sibling within one spacing step above or left of it, and no text inside other than its placeholder | SC 3.3.2 |
| `text_fixed_box` | info | a text inside an interactive component with `textAutoResize` NONE, or truncation ENDING | SC 1.4.4 (200 %) and SC 1.4.12 (text spacing): a fixed box clips grown text |
| `safe_area_platform` | info | on iOS / Android viewports, interactive nodes inside the top or bottom inset band the brief records (`details.insets`, with its source; no defaults, since Apple publishes no inset table) | Apple HIG Layout (respect safe areas); Android edge-to-edge since API 35 |

### 4.2 `states` (ux, design-system)

From `ComponentSetNode.variantGroupProperties` (typings 1.141.0): a property named `state`, `status` or `interaction` (any case); values normalised (default / enabled / rest → default; hover / hovered; focus / focused / focus-visible; pressed / active / down; disabled / inactive; error / invalid; loading / busy; selected / checked / on).

| Kind | Severity | Measures |
|---|---|---|
| `state_missing` | warning for focus (web/desktop) and error (inputs); info for hover (pointer platforms only), pressed, disabled, loading (buttons that submit) | required states per control type: buttons, links, tabs, chips, menu items — default, hover, focus, pressed, disabled; inputs — default, focus, filled, error, disabled; toggles, checkboxes, radios, switches — plus selected |
| `state_property_missing` | info | an interactive component set with variants but no state-like property |
| `variant_default_name` | warning | a variant property still called "Property 1" (or a value "Variant2") |
| `screen_state_missing` | warning when declared, else none | every `details.screens[].states` entry has a top-level frame among the deliverables named `<screen> / <state>` (case-insensitive) |

Grounding: the state set follows Material's state layers (hover, focus, pressed, dragged) and its disabled tokens (material-web token files); empty, loading and error screens follow NN/g (empty states; response-time limits 0.1 / 1 / 10 s; skeleton screens for waits under 10 s).

### 4.3 `copy` (ux, graphic, presentation)

| Kind | Severity | Measures |
|---|---|---|
| `generic_label` | info | text in a button-like node equal (case-insensitive, trimmed) to Submit, OK, Click here, Learn more, Read more, Go, Yes, No, Continue — "a button says what happens" (design `system` Copy; Apple HIG Writing: a verb) |
| `label_case_mixed` | info | button labels of one deliverable mixing title case and sentence case (Apple HIG Writing: one style per element type) |
| `error_interjection` | info | text matching Oops, Uh-oh, Whoops (Apple HIG Writing) |
| `error_code_only` | info | text matching an error code with no words around it (NN/g: human-readable) |
| `copy_variants` | info | two strings equal after normalising case, punctuation, dashes and quote marks, but different as written (design `finish`: "one wording, one dash, one kind of quote mark", measured today only by reading figma_scan_text_nodes) |

### 4.4 `system` (ux, graphic, illustration, brand, presentation)

Needs the brief (or a frame's own layout grids for `off_grid`).

| Kind | Severity | Measures |
|---|---|---|
| `format_mismatch` | warning | the deliverable's size against the brief's `format` size (or, with several sizes, the nearest) beyond 0.5 px; print: trim + 2 × `bleedMm` converted at the frame's scale |
| `off_scale` | info | a text size not within max(1 px, 2 %) of `bodySize × ratio^k` for an integer k, or not in `sizes[]` when given (C-211 modular scale; design rule "every number from a stated rule") |
| `off_spacing` | info | an auto-layout gap or padding not a multiple of `spacingBase` |
| `off_grid` | info; warning when 1–4 px off (a slip, as `no_shared_edge`'s near miss) | each block's left and right edges against the column edges computed from the frame's `layoutGrids` (COLUMNS: `count`, `gutterSize`, `offset`, `sectionSize`, `alignment`), else from `system.grid`; only absolutely placed blocks and auto-layout containers, never children inside a flow |
| `off_palette` | info | a solid fill or stroke whose hex is not in `system.palette` (ΔE76 under 2 counts as equal); images, the brief block and FigJam board defaults skipped |
| `optical_margin` | info | left-aligned texts sharing a box edge (±1 px) whose ink edges (absoluteRenderBounds) differ by more than max(1 px, 0.03 × the larger size); the fix is the difference as an x nudge — design `finish`'s "align ink, not boxes", measured |
| `hanging_punctuation` | info | a display text (≥ the tells heading step × body) whose first character is an opening quote, bullet or dash, with its ink inside the column edge |

### 4.5 `deck` (presentation)

Each slide (Slides) or each 1920 × 1080 top-level frame (Design) is one unit.

| Kind | Severity | Measures | Threshold |
|---|---|---|---|
| `slide_words` | info (warning above `details.maxWords` when the brief sets one) | words on the slide, notes excluded | default 40 projected, 90 screen — a decision to calibrate, no published standard |
| `topic_title` | info | a content slide (not the first or a section slide) whose largest text has 3 words or fewer — a topic, not an assertion | assertion-evidence approach (Penn State): a succinct assertion, visual evidence |
| `two_focal` | info | two texts at heading size, or two largest elements within `near_size`, on one slide: two ideas compete | slides `deck-recipes`: one idea per slide |
| `repeated_skeleton` | info | three or more consecutive content slides whose direct children's boxes match within 2 % of the slide | C-218 "one structure repeated on every slide" |
| `bullets_dense` | info | a list text with more than 5 items, or items over 2 lines | decision: "cut before you shrink" |
| `notes_missing` | info | `details.notes` true and a slide with no speaker notes | — |
| (floor) `min_text` | warning | the brief's floor; for a projected deck with none given, 60 px on a 1920 slide | decision from Kawasaki's 30 pt minimum and Microsoft's 13.333 in widescreen slide (960 pt wide, so 2 px per pt on a 1920 px slide) |

### 4.6 `mark` (brand)

| Kind | Severity | Measures |
|---|---|---|
| `mark_detail_lost` | warning under 1 px, info under 2 px | the mark's smallest feature — the least of its vectors' stroke weights and its shapes' smaller box sides, and the smallest gap between sibling shapes' boxes — scaled to each `applications[].sizePx` |
| `version_missing` | warning | each `details.versions` entry has a deliverable (component, variant or frame) named for it; a "one colour" version whose descendants use more than one solid colour also counts as missing |
| `clear_space` | warning | a lockup frame whose padding around the mark's bounds is less than `details.clearSpace` resolved in px (e.g. "1x = cap height" from the wordmark's text size) |
| `mark_contrast` | info | each version's mark colour against its ground under 3:1 (graphics guidance; logotypes are exempt from text contrast, SC 1.4.3) |
| `app_icon_text` | info | an app-icon deliverable containing a text node (Apple HIG: text only when essential) |

### 4.7 `icons` (illustration)

| Kind | Severity | Measures |
|---|---|---|
| `icon_size_mixed` | warning | icon components in the set whose frame size differs from `details.grid.size` |
| `stroke_mixed` | warning | more than one distinct stroke weight across the set's vectors, unless `details.grid.stroke` lists several |
| `live_area` | info | ink (absoluteRenderBounds) outside the frame inset by `details.grid.padding` |
| `off_pixel` | info | in icons ≤ 32 px, vector boxes at fractional positions or sizes (blurry at 1x) |
| `corner_mixed` | info | more than one corner radius across the set's shapes, unless declared |

### 4.8 `library` (design-system)

| Kind | Severity | Measures |
|---|---|---|
| `mode_value_missing` | warning | a semantic variable with no value in one of its collection's modes (`getLocalVariablesAsync`, `valuesByMode`) |
| `alias_broken` | warning | an alias value whose target no longer resolves |
| `scope_all` | info | a semantic variable left at ALL_SCOPES (design-system `library`: scopes by role) |
| `code_syntax_missing` | info | `details.platforms` names WEB / iOS / ANDROID and a variable has no code syntax there |
| `description_missing` | info | a component set or main component with no description |

### 4.9 Calibration

As C-248 did for `tells`: every info kind stays info until `spikes/calibrate-roles.mjs` shows it separates the owner's finished frames (the portfolio file, a UI kit, a real deck) from generated ones. A warning is allowed from day one only where a verified standard sets the number (target sizes, focus visible, non-text contrast, colour as the only cue, format size, declared states and versions).

---

## 5. External facts these rules rest on (task part 4)

Accessed 2026-10-14. "verified" = read today on the source named; wording is paraphrased here (the registrar pastes the exact sentence from the URL when registering). Section letters are `docs/reference/claims.md`'s: C (plugin runtime), I (our decisions), J (design-quality standards).

```
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 2.5.8 Target Size (Minimum), Level AA: a pointer target is at least 24 by 24 CSS pixels, except (spacing) an undersized target whose 24 CSS px diameter circle, centred on its bounding box, intersects no other target and no other undersized target's circle; (equivalent) another control on the page does the same; (inline) it sits in a sentence or is constrained by the line height of non-target text; (user agent) its size is the browser's, unmodified; (essential) the presentation is essential or legally required || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html (the SC text and the spacing measurement) || EXISTING none
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 2.5.5 Target Size (Enhanced), Level AAA: at least 44 by 44 CSS pixels, except an equivalent 44 px control on the page, a target in a sentence or block of text, a user-agent-sized target, or an essential presentation || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html || EXISTING none
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 2.4.7 Focus Visible, Level AA: any keyboard-operable interface has a mode in which the keyboard focus indicator is visible || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html || EXISTING none
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 2.4.11 Focus Not Obscured (Minimum), Level AA: a component that receives keyboard focus is not entirely hidden by author-created content || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html || EXISTING none
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 2.4.13 Focus Appearance, Level AAA: when the focus indicator is visible, an area of it is at least as large as a 2 CSS px thick perimeter of the unfocused component and has at least 3:1 contrast between the same pixels in the focused and unfocused states || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html || EXISTING none
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 3.3.1 Error Identification, Level A: an automatically detected input error identifies the item in error and describes the error to the user in text || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html || EXISTING none
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 3.3.2 Labels or Instructions, Level A: labels or instructions are provided when content requires user input || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/labels-or-instructions.html || EXISTING none
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 1.4.10 Reflow, Level AA: content works without two-dimensional scrolling at a width equivalent to 320 CSS px (vertical scrolling content) or a height of 256 CSS px (horizontal), except parts that need a two-dimensional layout || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/reflow.html || EXISTING none
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 1.4.12 Text Spacing, Level AA: no loss of content or function when line height is set to 1.5 times the font size, paragraph spacing to 2 times, letter spacing to 0.12 times and word spacing to 0.16 times || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html || EXISTING none
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 1.4.4 Resize Text, Level AA: except captions and images of text, text can be resized to 200 percent without assistive technology and without loss of content or function || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html || EXISTING none
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 2.2.2 Pause, Stop, Hide, Level A: moving, blinking or scrolling information that starts automatically, lasts more than five seconds and is shown in parallel with other content has a way to pause, stop or hide it, unless the movement is essential || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html || EXISTING none (C-223 covers SC 2.3.3 only)
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 1.4.3 exceptions: text in an inactive user interface component, pure decoration, invisible text or text inside a picture with significant other content has no contrast requirement (Incidental), and text that is part of a logo or brand name has none (Logotypes) || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html || EXISTING C-075 (extend it with the two exceptions)
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 1.4.11 Non-text Contrast, Level AA: visual information needed to identify UI components and their states needs 3:1 against adjacent colours, except inactive components and components whose appearance the user agent determines unmodified; graphics needed to understand content need 3:1 unless a particular presentation is essential || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html || EXISTING C-221 (extend it with the inactive-component exception)
SECTION J || STATUS verified || CLAIM WCAG 2.2 SC 1.4.1 Use of Color, Level A: colour is not the only visual means of conveying information, indicating an action, prompting a response or distinguishing an element || SOURCE https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html || EXISTING C-221
SECTION J || STATUS verified || CLAIM Apple HIG (Accessibility, "Offer sufficiently sized controls"): default / minimum control sizes — iOS and iPadOS 44x44 pt / 28x28 pt; macOS 28x28 / 20x20; tvOS 66x66 / 56x56; visionOS 60x60 / 28x28; watchOS 44x44 / 28x28; and about 12 pt of padding around bezeled elements, about 24 pt around bezel-less ones || SOURCE https://developer.apple.com/design/human-interface-guidelines/accessibility (read through https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json; the HTML page renders client-side) || EXISTING none
SECTION J || STATUS verified || CLAIM Apple HIG (Accessibility): default / minimum sizes of the system type styles — iOS and iPadOS 17 / 11 pt; macOS 13 / 10; tvOS 29 / 23; visionOS 17 / 12; watchOS 16 / 12; ideally text can be enlarged at least 200 percent (140 percent on watchOS) || SOURCE same page and JSON as above || EXISTING none
SECTION J || STATUS verified || CLAIM Apple HIG (Layout): a safe area is the part of a window not covered at its edges by hardware features or other views (toolbar, tab bar, status bar); respecting it keeps system UI and hardware such as the Dynamic Island from obscuring content and controls; tvOS content is inset 60 pt top and bottom and 80 pt at the sides; the page gives no per-device inset table || SOURCE https://developer.apple.com/design/human-interface-guidelines/layout (read through https://developer.apple.com/tutorials/data/design/human-interface-guidelines/layout.json) || EXISTING none
SECTION J || STATUS verified || CLAIM Android developers (Make apps more accessible): each interactive element should have a touch target of at least 48dp x 48dp, larger is better, and precise pointers may use smaller ones; text under 18sp (or bold under 14sp) needs 4.5:1, other text 3:1 || SOURCE https://developer.android.com/guide/topics/ui/accessibility/apps || EXISTING none
SECTION J || STATUS verified || CLAIM Google Accessibility Help (Touch target size): interactive elements should be at least 48dp wide and high; a 24x24dp icon can carry a 48x48dp target through its padding; targets should be separated by 8dp or more; 48dp is about 9 mm on any screen, within the 7-10 mm recommended for touch || SOURCE https://support.google.com/accessibility/android/answer/7101858?hl=en || EXISTING none
SECTION J || STATUS verified || CLAIM Android edge-to-edge: an app targeting SDK 35 on Android 15 or later draws behind the status, caption and navigation bars; it must handle insets, and tappable views use the system-bar insets so the bars do not obscure them || SOURCE https://developer.android.com/develop/ui/views/layout/edge-to-edge || EXISTING none
SECTION J || STATUS verified || CLAIM Material Web's token files (version v0_192) set state-layer opacities hover 0.08, focus 0.12, pressed 0.12, dragged 0.16, and the filled button's disabled container 0.12 and disabled label 0.38 opacity, with a 40px container height (the 48dp touch target comes from padding) || SOURCE https://raw.githubusercontent.com/material-components/material-web/main/tokens/versions/v0_192/_md-sys-state.scss and .../_md-comp-filled-button.scss || EXISTING none (C-224 covers Material motion tokens only)
SECTION J || STATUS verified || CLAIM Nielsen's 10 usability heuristics: visibility of system status; match between the system and the real world; user control and freedom; consistency and standards; error prevention; recognition rather than recall; flexibility and efficiency of use; aesthetic and minimalist design; help users recognize, diagnose and recover from errors; help and documentation (Jakob Nielsen, 1994-04-24, last updated 2024-01-30) || SOURCE https://www.nngroup.com/articles/ten-usability-heuristics/ || EXISTING none
SECTION J || STATUS verified || CLAIM NN/g heuristic evaluation: ideally three to five people evaluate the same interface independently, without seeing each other's findings until done (Moran and Gordon, 2023-06-25) || SOURCE https://www.nngroup.com/articles/how-to-conduct-a-heuristic-evaluation/ || EXISTING none
SECTION J || STATUS verified || CLAIM Nielsen's severity ratings for usability problems: 0 not a problem, 1 cosmetic, 2 minor, 3 major, 4 catastrophe (fix before release); severity combines frequency, impact and persistence (1994-11-01) || SOURCE https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/ || EXISTING none
SECTION J || STATUS verified || CLAIM NN/g error-message guidelines: show the message next to the error's source; use human-readable language; describe the problem concisely and precisely; offer constructive advice; preserve the user's input (Neusesser and Sunwall, 2023-05-14) || SOURCE https://www.nngroup.com/articles/error-message-guidelines/ || EXISTING none
SECTION J || STATUS verified || CLAIM NN/g response-time limits: about 0.1 s feels instantaneous, about 1 s keeps the flow of thought, about 10 s holds attention; operations longer than about 10 s need a percent-done indicator (Nielsen, 1993) || SOURCE https://www.nngroup.com/articles/response-times-3-important-limits/ || EXISTING none
SECTION J || STATUS verified || CLAIM NN/g empty states: use them to communicate system status, give learning cues, and offer direct pathways to the key tasks that fill them; do not default to totally empty states (Kaplan, 2021-09-19) || SOURCE https://www.nngroup.com/articles/empty-state-interface-design/ || EXISTING none
SECTION J || STATUS verified || CLAIM NN/g skeleton screens: spinners suit a single module loading for about 2-10 s; skeleton screens suit full-screen loads under 10 s; progress bars are strongly recommended beyond 10 s (Tankala, 2023-06-04, reviewed 2026-09-02) || SOURCE https://www.nngroup.com/articles/skeleton-screens/ || EXISTING none
SECTION J || STATUS verified || CLAIM Apple HIG (Writing): label buttons and links with a verb; avoid cute or clever labels; choose one capitalization style per element type and use it consistently; cut every word that is not needed; show an error close to the problem, without blame, saying how to fix it; interjections such as "oops" are unnecessary || SOURCE https://developer.apple.com/design/human-interface-guidelines/writing (read through .../writing.json) || EXISTING none (C-215 is the NN/g copy study)
SECTION J || STATUS verified || CLAIM Apple HIG (App icons): the iOS, iPadOS and macOS icon layout is 1024x1024 px; include text only when essential; prefer illustration to photos; do not replicate standard UI components or screenshots || SOURCE https://developer.apple.com/design/human-interface-guidelines/app-icons (read through .../app-icons.json) || EXISTING none
SECTION J || STATUS verified || CLAIM Guy Kawasaki's 10/20/30 rule (blog, 2005-12-30): ten slides, twenty minutes, no font smaller than thirty points (or the oldest audience member's age divided by two) — a practitioner's rule, not a study || SOURCE https://guykawasaki.com/the_102030_rule/ || EXISTING none
SECTION J || STATUS verified || CLAIM Microsoft PowerPoint's Widescreen (16:9) slide is 13.333 in x 7.5 in (33.867 x 19.05 cm), i.e. 960 x 540 pt, so on Figma's 1920 x 1080 slide one point is two pixels || SOURCE https://support.microsoft.com/en-us/office/change-the-size-of-your-slides-040a811c-be43-40b9-8d04-0de5ed79987e || EXISTING none (C-134 gives the 1920 x 1080 slide)
SECTION J || STATUS verified || CLAIM The assertion-evidence approach (Leonhard Center, Penn State; Michael Alley, content editor) builds slides on succinct messages (assertions) rather than phrase topics, with visual evidence rather than bulleted lists; the page itself cites no study || SOURCE https://www.assertion-evidence.com/ || EXISTING none
SECTION J || STATUS verified || CLAIM Adobe's InDesign tutorial: bleed values of 0.125 in (3 mm) are standard, though some print providers require a larger bleed || SOURCE https://www.adobe.com/learn/indesign/web/set-print-bleed || EXISTING none
SECTION C || STATUS verified || CLAIM PageNode and DocumentNode extend BaseNodeMixin, which extends PluginDataMixin, so setSharedPluginData / getSharedPluginData exist on a page and on figma.root, under the same 100 kB per-entry cap as any node || SOURCE node_modules/@figma/plugin-typings/plugin-api.d.ts 1.141.0 lines 6306 (BaseNodeMixin), 6466-6514 (PluginDataMixin), 10404 (DocumentNode), 10563-10564 (PageNode) || EXISTING C-188 (extend it to pages and the document; live behaviour still to measure in spikes/live-roles.mjs)
SECTION C || STATUS verified || CLAIM ComponentSetNode exposes variantGroupProperties and ComponentNode / InstanceNode expose variantProperties, readable by a plugin, so state variants can be listed without reading componentPropertyDefinitions on a variant (which throws, C-114) || SOURCE plugin-api.d.ts 1.141.0 lines 9655 (variantProperties), 11133 (variantGroupProperties) || EXISTING C-114 (related)
SECTION C || STATUS verified || CLAIM A frame's layoutGrids is readable; a COLUMNS or ROWS grid carries alignment (MIN, MAX, STRETCH, CENTER), gutterSize, count, sectionSize (ignored when STRETCH) and offset (ignored when CENTER) || SOURCE plugin-api.d.ts 1.141.0 lines 5008-5024 (RowsColsLayoutGrid), 9400 (layoutGrids) || EXISTING none (C-108 covers grid styles)
SECTION C || STATUS to-verify || CLAIM Whether node.clone() copies shared plugin data to the copy (the typings do not say); the design does not depend on it, because sign-off writes its own record, but a cloned styleframe would otherwise carry a stale record || SOURCE plugin-api.d.ts 1.141.0 lines 10766 (FrameNode.clone, silent on plugin data); to measure in spikes/live-roles.mjs || EXISTING none
SECTION C || STATUS to-verify || CLAIM setSharedPluginData on a PageNode, on figma.root, on a FigJam SECTION and on a Slides SLIDE persists and reads back across a plugin restart (typings say the members exist; not measured live) || SOURCE plugin typings as above; spikes/live-roles.mjs to write || EXISTING C-188 (frames only measured, via the storyboard record)
SECTION J || STATUS to-verify || CLAIM Material's system icon grid: a 24dp canvas with a 20dp live area and 2dp padding (the Material 2 page renders client-side and could not be read; the Google Fonts Material Symbols page gives only 24 px as the preferred size and optical sizes 20-48dp) || SOURCE https://m2.material.io/design/iconography/system-icons.html (unreadable); https://developers.google.com/fonts/docs/material_symbols (partial) || EXISTING none — not used as a load-bearer: the illustration brief records its own grid
SECTION J || STATUS to-verify || CLAIM InDesign's Optical Margin Alignment lets punctuation and the edges of letters hang outside the text frame so the edge looks flush (Adobe's help page answered 403; only third-party pages were read) || SOURCE https://helpx.adobe.com/indesign/using/text-composition.html (403) || EXISTING none — not used as a load-bearer: optical_margin automates the design skill's existing "align ink, not boxes" rule
SECTION J || STATUS to-verify || CLAIM Material Design 3's own pages give 48x48dp as the minimum touch target (m3.material.io renders client-side and could not be read; the number is verified through the Android developer and Google Accessibility Help pages above) || SOURCE https://m3.material.io/foundations/designing/structure (unreadable) || EXISTING none
```

Decisions to register at the same time (status `decision`, section I):

```
SECTION I || STATUS decision || CLAIM The role table and routing rule: nine roles (ux, graphic, illustration, brand, presentation, design-system, board, motion; ux writing as a stage of ux), first matching question decides, a request spanning two roles is two briefs || SOURCE this spec §2.1; src/shared/roles.ts || EXISTING none
SECTION I || STATUS decision || CLAIM The role gate: under BRIDGE_PROCESS=strict only new work is gated (§3.3 table), a brief in force is per process and file and closes on sign-off, refusals are PROCESS_REQUIRED before anything is sent; guided warns; off tracks nothing; strict degrades to guided where it cannot be satisfied || SOURCE this spec §3; ADR #42 || EXISTING none (C-246-style decision; relates to the motion gate's ADR #41)
SECTION I || STATUS decision || CLAIM Records in shared plugin data, namespace figmamcp: brief (on the brief block or a named node), signOff (on each deliverable, with a 32-bit FNV-1a content fingerprint), briefIndex (on the document root); a final export needs a passing sign-off whose fingerprint matches || SOURCE this spec §3.2, §3.7 || EXISTING none
SECTION I || STATUS decision || CLAIM The sign-off bar per role and gear: the measured checks are a hard floor; lenses at 8 or more, or the round budget spent with what remains listed; every kept craft info answered (tells too at page and top) || SOURCE this spec §3.6; C-239 (gears and budgets) || EXISTING C-239 (extend)
SECTION I || STATUS decision || CLAIM Target-size thresholds and severities: web 24 CSS px warning / 44 info; iOS 28 pt warning / 44 info; Android 48 dp warning; spacing per SC 2.5.8 (web) and 8 dp (Android, info); converted with device width ÷ frame width || SOURCE this spec §4.1, from the J claims above || EXISTING none
SECTION I || STATUS decision || CLAIM Required states per control type, hover only on pointer platforms, and declared screen states (empty, loading, error) checked by frame names || SOURCE this spec §4.2 || EXISTING none
SECTION I || STATUS decision || CLAIM Deck defaults: 60 px text floor on a 1920 projected slide when the brief gives none; word budgets 40 projected / 90 screen; all deck kinds info until calibrated || SOURCE this spec §4.5 || EXISTING none
SECTION I || STATUS decision || CLAIM Brief lint: the message is one sentence; tone words are three and never "modern", "clean", "premium" or "elegant"; a page-gear format carries a size with a unit || SOURCE this spec §3.4; src/skills/figxel-design/references/brief.md (line 7 of the seven lines) || EXISTING none
SECTION I || STATUS decision || CLAIM New audit kinds report info until spikes/calibrate-roles.mjs shows they separate finished frames from generated ones, except where a verified standard sets the number || SOURCE this spec §4.9; mirrors C-248 || EXISTING C-248 (related)
```

---

## 6. Implementation plan (task part 5)

### 6.1 Order (one implementer, after the motion gate is committed)

**Wave A — the enforcement core and the ux role**

1. **Rebase and read.** Read the committed `motion-process.ts`, `motion-plan.ts`, `tools/motion-plan.ts`, `tools/batch.ts`, `tools/guide.ts`, `prompts.ts`, `resources.ts`; confirm the catalog count (assumed 134) and the style group count (assumed 19).
2. **Claims first** (locked file: `attrib -R`, edit, `node scripts/lock-docs.mjs --update`, `attrib +R`): the J and C facts of §5 with their exact quotes, the I decisions, C-075 / C-188 / C-221 / C-239 extended. `node scripts/check-claims.mjs`. Only verified, measured or decision ids may be cited in skills (T5).
3. **Shared tables** `src/shared/roles.ts` (no runtime dependencies; the plugin bundles it): `ROLES` (id, label, skills, gears, required lines per gear, `details` schema keys, audits per gear, lenses per gear, deliverable kinds), `PLATFORM_TARGETS`, `BRIEF_KEYS` (`brief`, `signOff`, `briefIndex` in `STORYBOARD_NAMESPACE`), `BriefRecord`, `SignOffRecord`, `parseBrief`, `parseSignOff`, `ROUND_BUDGET`.
4. **Plugin ops** `src/plugin/ops/brief.ts`: `set_brief` (write: block via `emptySpot` and the create helpers; record; index; redraw on update), `get_brief` (read: records by node / brief / page / index; `target` facts; `fingerprint`), `sign_off` (write: `checkLayout` with audits; answers; fingerprint; records; block status; select and zoom). `src/plugin/fingerprint.ts`. Register in `PLUGIN_OPS`. Audits skip any node carrying a `brief` record.
5. **Audits, wave A:** `src/plugin/a11y.ts`, `src/plugin/states.ts`, `src/plugin/copy.ts`, `src/plugin/system.ts` (format, scale, spacing, grid, palette, optical margin, hanging punctuation); the §4.0 fixes in `check.ts` / `craft.ts`; `AUDITS` extended; `check_layout` schema: `audit` enum + `.max(14)`, `briefId?`; description compressed to audit names.
6. **Server** `src/server/role-process.ts`: `RoleProcess` (ledger shared with `MotionProcess`, `inForce`, degradation flags), `classifyNewWork(op, params)`, `newWorkGate`, `briefSkillGate`, `finalExportGate`, the §3.8 message builders, reuse of `withProcessWarnings`. Wire it where the motion process is created (`mcp.ts`) and into `create.ts` (create_frame, create_from_spec, create_section), `figjam.ts`, `slides.ts` (create_slides), `storyboard.ts`, `batch.ts` (per step; `set_brief` and `sign_off` refused as steps), `export.ts` (`final` on export_node and export_frames_to_pdf), and the motion export (sign-off requirement when the frame has a role-motion brief).
7. **Server tools** `src/server/tools/brief.ts`: `figma_set_brief` (zod + per-role `details` strict schemas + lint + skill check; fills `inForce`), `figma_get_brief` (adoption), `figma_sign_off` (pre-checks, motion audit + `noteCheck`, forward `sign_off`, then drop the brief from `inForce` on a pass). `figma_status` `process` block and hint (`tools/meta.ts`).
8. **Registry:** `src/shared/ops.ts` `BY_GROUP` (read += `get_brief`; style += `set_brief`, `sign_off`); `tools/index.ts` `IMPLEMENTED_*`; `src/shared/editors.ts` rows (`set_brief`, `sign_off`: Design `yes` from the spike, FigJam and Slides unmeasured; `get_brief`: everywhere); annotations (sign_off not destructive).
9. **Skills, wave A:** `figxel-ux` (index + 5 references); design index and `brief` / `finish`; critique index; workflow index, `tools`, `check`; design-system index; code-to-design line; `SERVER_INSTRUCTIONS` (§6.3); `figma_get_guide` description sentence. Declared rewrites in `test/skills.test.ts` `REWRITTEN` (workflow, tools, check, design-system, code-to-design; reasons extended with "the role process (2026-10-xx)"); `IN_SCOPE` += `ux` in `test/skills-acceptance.test.ts`; `NEW_TOOLS` += the three in `test/agent-guidance.test.ts`.
10. **Tests, wave A** (new files): `test/role-process.test.ts` (classifier table row by row, each mode, every §3.8 message pinned, degradation, batch, adoption), `test/brief-tools.test.ts` (schemas, lint, merge, reopen, block drawing on `WriteFigma`, index), `test/sign-off.test.ts` (bar per role and gear, exceptions at budget, answers, fingerprint staleness, motion path), `test/a11y-audit.test.ts`, `test/states-audit.test.ts`, `test/copy-audit.test.ts`, `test/system-audit.test.ts`, `test/fingerprint.test.ts`. Updated: `test/editor-gate.test.ts`, `test/editor-integration.test.ts`, `test/ops.test.ts` (via tools.md), `test/schema-portability.test.ts`, `test/strict-params.test.ts`, `test/check-audit.test.ts` (low_contrast exemptions), and `BRIDGE_PROCESS: "off"` in the env of `server.e2e`, `write-tools`, `export`, `editors-write`, `agent-guidance` where they create top-level work.
11. **Spike** `spikes/live-roles.mjs` → `spikes/results/live-roles.json`: shared plugin data on a frame, a page, `figma.root`, a FigJam section, a Slides slide (write, re-run plugin, read back); `clone()` and plugin data; fingerprint stable across a plugin restart and a font load; the `a11y` and `states` audits on a real UI kit file. Flip the editor cells only from the result.
12. **Docs (locked; same unlock / update / relock):** `docs/reference/tools.md` (3 rows, `final` on two rows, `briefId` and the audit list on `check_layout`; counts 134 → 137, "136 registered by default"; read 22 → 23, style 19 → 21; editor support rows), `README.md` (BRIDGE_PROCESS now gates new work too; how to turn it off), `docs/clients.md` (the variable), `docs/agents/using-the-mcp.md` (roles, brief, sign-off), the spec (ADR #42, §12 roadmap line), `AGENTS.md` (Status: 137 tools, 14 skills; the ids-out-of-prose rule names ux, graphic, brand), `docs/reference/roadmap.md`, `CHANGELOG.md`. Then all six gates of AGENTS.md "Before committing".
13. **Acceptance run** (as acceptance run 1): "a booking flow for a bike repair co-op" with the ux role in a clean session, recording every refusal, the calls added, false positives and the sign-off; fix the skills from its report.

**Wave B — the other still roles**

14. Audits: `src/plugin/deck.ts`, `src/plugin/mark.ts`, `src/plugin/icons.ts`, `src/plugin/library.ts` (variables read with `getLocalVariablesAsync`), each with its test file.
15. Skills: `figxel-graphic` (index + `placements`, `grid`, `illustration`), `figxel-brand` (index + `identity`, `guidelines`), slides `story` + index line, figjam line (new `REWRITTEN.figjam`), storyboard / motion lines (`REWRITTEN.motion` extended); `IN_SCOPE` += graphic, brand; optional prompts `design_ux`, `design_graphic`, `design_brand` with a test block.
16. `figma_set_motion_plan` inherits from a role-motion brief (§3.10), with tests in the motion gate's test file.
17. `spikes/calibrate-roles.mjs` on the owner's files; acceptance runs for a poster (graphic), a wordmark (brand) and a deck (presentation).

### 6.2 Size

| Area | New code (approx. lines) | Tests (approx.) |
|---|---|---|
| shared/roles.ts, fingerprint | 350 | 150 |
| plugin ops brief / get / sign-off | 450 | 350 |
| audits wave A (a11y, states, copy, system) + fixes | 900 | 700 |
| server role-process + tools + wiring | 800 | 700 |
| audits wave B (deck, mark, icons, library) | 700 | 500 |
| skills: 3 new skills ~105 KB of Markdown; edits to 9 others | — | acceptance blocks ~150 |

Wave A is about the size of the motion gate plus the craft audit; wave B about two thirds of it.

### 6.3 Draft `SERVER_INSTRUCTIONS` (measured: 1,969 bytes; head contains figma_status, figma_get_guide, design, storyboard, motion, critique; keeps every sentence `test/agent-guidance.test.ts` pins)

```
Figxel drives the Figma file open in Figma desktop (plugin "Figxel"). Call figma_status first; follow its build.restart ("plugin" = re-run the plugin, "client" = restart the MCP client). Before you design, animate or review, read figma_get_guide. State the role and the gear first: topic ux (screens, flows), graphic (posters, ads, print, icons), brand (logos, identity), slides, design-system, figjam; a page or more also runs the design skill. Topic storyboard plans a motion piece, motion animates, critique reviews in measured rounds.

You are the senior designer who owns the brief. A short request is enough: decide structure, copy, imagery and decoration yourself, build it all, report at the end. Do not ask permission step by step or stop for missing content — use realistic placeholders and list what to replace. Ask only when a choice changes the whole result or a code token disagrees with Figma's.

New work is gated as professionals work: read the role's skill, figma_set_brief before the first new frame, figma_sign_off before a final export. Motion adds figma_set_motion_plan before keyframes and a passing figma_check_motion.

The loop:
1. Orient: figma_get_selection, figma_get_pages; learn the system from an existing screen (figma_get_design_context).
2. Wrapper: one frame at an empty spot (figma_create_frame, vertical auto-layout).
3. One section per call: figma_create_from_spec builds a whole header, hero or card grid. Repeated parts become a component once, then instances.
4. After each section: figma_check_layout (fix every error/warning) and one figma_export_node to judge. Fix with targeted edits, not rebuilds.
5. Finish with check_layout ok:true, then figma_sign_off.

Safety: build at an empty spot; delete only ids your own calls returned. Retry with your idempotencyKey.

Works in Figma Design, FigJam and Slides files: figma_status shows each file's editor. On a board or a deck read figma_get_guide topic figjam or slides first.
```

It drops "no arguments gives the loop" and "Every answer ends with the calls for its sections and other skills" (every guide answer still ends with them) and "figma_select + figma_zoom_to" (sign-off does both on a pass).

### 6.4 Skill outlines (for the implementer)

**`figxel-ux` index** (≤ 4.9 KB): the voice line; the routing rule's ux half; a gear table in the design index's shape (Gear | Choose it when | Read | Process | Rounds) with rows Section, Page, Top, Replica, each Read cell naming 2–3 sections (`flows`, design `brief`; `states`, `accessibility`; …) so the acceptance-test pattern can be reused; the stage table S0–S10 with ux exits; the brief call (`figma_set_brief { role: "ux", gear, title, goal, message, success, details }`, keys only, so T4 checks them); hard rules (a flow before screens; every interactive component has its states; targets and focus in numbers; an error says what and how, in text; check after each section; sign-off ends it); the sign-off set; sections list. Ids on the last line.

- `flows`: the task sentence; the flow as steps; one screen per step; information architecture; viewports and the fold (pointing at design `brief`, never restating the frame-px formula); platform patterns (iOS tab bar and navigation, Android system bars and edge-to-edge, web responsive breakpoints); naming of screen frames.
- `states`: the state matrix per control type; building variants in one spec, combining, property naming; screen states (empty, loading, error, success, offline) with the NN/g numbers; the `states` audit kinds and fixes.
- `accessibility`: the numbers per platform (contrast, targets, spacing, focus, text minimums and resize, motion and pause), the exemptions (inactive, logotypes), the `a11y` kinds and their fixes, the keyboard walk.
- `content`: UX writing rules with examples; the `copy` kinds.
- `usability`: the heuristic walk (each step of the task against the ten heuristics), the 0–4 severity scale mapped to the critique schema (4 → blocker, 3 → major, 1–2 → minor), when to give it to a subagent (3–5 independent evaluators is the NN/g ideal; one agent runs it as a separate pass, a subagent with only the brief when the client has one).

**`figxel-graphic` index**: voice; routing; gears; stages with medium-first S3; the brief call with `details.medium`, `viewing`, `bleedMm`; the `system` audit; sign-off set; sections. `placements`: print (trim, bleed 3 mm default per Adobe, safety margin, PDF delivery), social (feed and story sizes come from the placement's current spec, with the design brief's safe-zone rule), OOH, web banners; adaptations as separate deliverables. `grid`: grids as numbers (columns, gutters, margins, baseline), the type scale from the body (C-211), the spacing scale, one deliberate break, optical margins and hanging punctuation, `layoutGrids` with figma_set_layout_grids. `illustration`: icons and illustrations (construction grid, live area, stroke and corner systems, metaphors and labels, vector tools, sizes, the `icons` kinds).

**`figxel-brand` index**: voice; gears (top for a new mark); stages (positioning, the category default, wide routes, refinement on a construction grid, the mark tests, versions, lockups, the brand sheet); the brief call with `details`; sign-off set. `identity`: mark types and when each fits; exploring wide; construction and optical corrections; small-size, one-colour and reversed tests; clear space and minimum size; the `mark` kinds. `guidelines`: the brand sheet's contents; saving colours and type as styles (design-system skill); app icon (Apple 1024 px, no text unless essential).

**slides `story`**: the takeaway and arc; a sentence per slide before any layout; assertion headlines on content slides; evidence as visuals; density by room with the floor; speaker notes; the `deck` kinds.

### 6.5 Tool counts

| | Before (motion gate assumed) | After |
|---|---|---|
| Catalog | 134 | 137 |
| Registered by default | 133 | 136 |
| read | 22 | 23 (`get_brief`) |
| style | 19 | 21 (`set_brief`, `sign_off`) |
| core tier | 20 | 20 (the gate degrades to guided there) |
| Changed tools | — | `check_layout` (audits, `briefId`), `export_node` and `export_frames_to_pdf` (`final`), `set_motion_plan` (wave B, `briefId`), `status` (`process`), `get_guide` (description) |

### 6.6 Risks

1. **Friction on small requests.** A user asks for "a frame for an icon" and gets refused. Mitigation: only container types at page level are gated; the section gear needs six fields; N1's hint is one paragraph with the exact call; the acceptance run counts added calls (target: ≤ 2 extra calls for a section-gear task, ≤ 5 for a page).
2. **The classifier is wrong.** A user-drawn empty frame filled by spec is gated (intended); a wrapper frame created inside another frame is not (intended); a component built at page level by the design-system role is gated (intended). Each row is pinned in `test/role-process.test.ts`.
3. **Self-reported lenses are inflated.** The measured checks are the floor; the scores and exceptions are written into the file and the report where the user sees them. Stated as an honest limit in README, like the docs lock.
4. **Full budgets.** Design, critique, workflow, motion and storyboard indexes and `SERVER_INSTRUCTIONS` are within 35 bytes of their caps; every edit there must trim first and keep the pinned sentences. `figma_check_layout`'s description must be rewritten to fit.
5. **Heuristic detection is noisy.** Interactive nodes and states are found by names and reactions. Mitigation: info until calibrated, `details.controls` to name controls explicitly, a reason in `answers` to keep one.
6. **Unmeasured plugin data on pages, the document root, FigJam and Slides.** Strict degrades to guided there until the spike passes; the index falls back to the current page.
7. **Strict by default surprises upgrading users and breaks scripts.** Tests and spikes must set `BRIDGE_PROCESS=off`; README and CHANGELOG say how to turn it off; `figma_status` shows the mode.
8. **Two gates for motion.** A motion piece could be asked for the same facts twice. Mitigation: the plan inherits from the brief; one sign-off satisfies both final rules.
9. **Fingerprint false staleness** (layout reflow after a font loads, sub-pixel drift). Mitigation: round to 0.5 px, exclude computed-only fields; the spike measures stability; a stale sign-off costs one `figma_sign_off`.
10. **Work in progress by other agents.** The motion gate was uncommitted while this was written; names (`MotionProcess`, `withProcessWarnings`, `PROCESS_REQUIRED`, `lookUpPlan` via `get_motion_context`) and counts must be re-read before wave A starts.
11. **Copy and claims.** Exact quotes go into claims.md only from the primary sources listed; three facts stay to-verify and must not be cited in skills (T5).
