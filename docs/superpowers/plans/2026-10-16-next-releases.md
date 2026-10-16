# Next releases — plan, 2026-10-16

Where Figxel goes after 0.1.1, in the order the owner chose on 2026-10-16. A working plan: it changes as the work lands.

## Where things stand

- **0.1.1** is tagged and on GitHub Releases with the npm tarball and the plugin zip. Publishing to npm waits for the owner's npm account, which is suspended until about 2026-10-17; the README's Quickstart runs setup from the release tarball until then.
- **Figma Community** rejected the plugin on 2026-10-15 for overlapping with the Figma MCP server (`docs/reference/claims.md`, C-342). The plugin stays a development plugin installed by `setup`.
- **Feedback from the launch post** asked for a handoff number (how much of a build is bound to the file's variables and styles, and which instances were detached), confirmed that reading the file's own components and variables first matters, and asked about checking the built code (outside Figxel's scope).
- **The owner's direction for roles:** every role has its own workflow, with planning before the work and testing after it. The [role spec](2026-10-14-roles-spec.md) already has that shape: a shared stage skeleton (S0–S10, §2.2) whose stages each role card fills in (§2.3); for UI/UX, a flow before the screens, and states, accessibility, content and a usability walk against Nielsen's ten heuristics before sign-off.

## 0.1.2 — small, no Figma session needed

1. **Handoff check.** `figma_check_layout` reports, for a frame: the share of solid fills and strokes bound to a variable or style, of text nodes with a text style or bound typography, of auto-layout gaps and paddings bound to variables, and of corner radii bound; the detached instances; and local styles that duplicate an existing style or variable. Counts and percentages first, then the nodes (capped). Detached instances need the Plugin API's detach record: verify it and add a claim before relying on it. Decide during the work whether this is a new audit kind (`handoff`) or a summary line of the `tokens` audit. Tests with mock nodes; `docs/reference/tools.md`, the workflow `check` reference and the design-system skill updated.
2. **Stable tests.** The tests that assert wall-clock limits fail on a loaded machine (the audio synthesis speed test, 5 s; one Ubuntu job on the v0.1.1 tag). Replace fixed waits with readiness checks, as `test/server.e2e.test.ts` now does, and give speed tests a margin or an opt-in.
3. **Roadmap refresh.** `docs/reference/roadmap.md`: status as of this plan, Next steps from this file, the release work done since 2026-10-14.
4. **After npm publishes 0.1.1:** the Quickstart's first step back to `figxel-mcp@latest`, and the temporary notes removed from the README, `docs/clients.md` and the v0.1.1 release notes.

## One live session — the owner at Figma desktop, about 60–90 minutes

Batched so the owner's time is spent once:

1. **FigJam and Slides.** The five spikes in the [FigJam and Slides plan record](2026-10-09-figjam-slides.md#live-runs-still-to-do). Their results turn editor cells to yes or no, which is what lets the 16 board and deck tools write.
2. **The motion gate end to end**, as the roadmap's Next steps describe: a refused and then allowed keyframe write, a passing check, a final render refused after an edit by hand, and the delivery.
3. **Rendering with the window minimized or covered:** `spikes/live-window-state.mjs`.

The results ship as 0.1.3, or fold into 0.2.0 if that is close.

## 0.2.0 — roles, wave A: the enforcement core and UI/UX

1. **Refresh the role spec** against the current tree: tool counts, skill byte budgets, and the motion gate as committed.
2. **Core:** the role table (`src/shared/roles.ts`), `figma_set_brief`, `figma_get_brief` and `figma_sign_off`, the gate on new work under `BRIDGE_PROCESS=strict`, and `final` on `figma_export_node` and `figma_export_frames_to_pdf`.
3. **The UI/UX workflow.** Before: the brief, then the flow (the task in one sentence, the steps, a screen per step, the states each screen needs). After: the states, accessibility and content passes, the usability walk, then sign-off. New audits `a11y`, `states`, `copy` and `system`; `low_contrast` exempts inactive components and logotypes. The `figxel-ux` skill.
4. **A live acceptance run:** one UI/UX brief from the first call to sign-off.

## 0.3.0 — roles, wave B

Graphic, illustration, brand and presentation, each with its own workflow from the role cards, the `deck`, `mark`, `icons` and `library` audits, and the `figxel-graphic` and `figxel-brand` skills. Each role gets an acceptance run.

## Parked

- macOS: a first live run and a green CI job (needs a Mac).
- Phase 5 hardening and the tool-description audit.
- Audio from the owner's licensed files ([audio held](2026-10-14-audio-held.md)).
- A mode on top of the official Figma MCP's `use_figma`, as Figma's rejection suggested: not now, by the owner's choice on 2026-10-16.
