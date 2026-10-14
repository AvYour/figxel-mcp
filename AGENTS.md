# Repository Conventions

Conventions for agents and humans working on Figxel in this repository. Figxel was called figma-mcp during development; dated documents (plans, spike results, the spec's filename) keep that name.

## Language

**Everything in this repository is written in English** — prose, headings, table content, comments, commit messages, script output.

This is enforced, not just stated: `scripts/check-language.mjs` runs in the pre-commit gate and fails on any non-Latin script or Indonesian wording. It exists because the rule leaked while it was only written down — two checkers printed Indonesian summaries for a whole phase and nobody noticed.

Technical identifiers are never translated: tool names (`figma_*`), environment variables (`BRIDGE_*`), Figma API identifiers (`commitUndo`, `exportAsync`), MCP method names (`notifications/progress`), file paths, and the contents of code blocks.

## Claims must be traceable

Any **external fact the design depends on** gets an entry in [`docs/reference/claims.md`](docs/reference/claims.md) with a `C-0xx` ID. Documents mark their use of a fact with `[C-0xx]` inline.

This is not bureaucracy — four mistakes in one design session were all the same failure mode: an untracked external claim. See [CONTRIBUTING.md § Tracked claims](CONTRIBUTING.md#tracked-claims).

Rules:

- **Never state a new external fact that shapes the design without a registry entry.** Add the claim first, then reference it.
- **Sources must be specific** — URL + what it says + date accessed. Date is `YYYY-MM-DD`.
- **`contradiction` and `to-verify` may not be used as load-bearers.** If official sources disagree, that is a signal to test, not to choose.
- **A claim changes → every document using its ID changes.** Grep the ID.
- **Only the main agent edits the registry.** Verification subagents report only — see the [verification contract](docs/agents/claim-verification.md).
- **In the skills, ids sit out of the prose.** In the `design`, `critique`, `workflow` and `design-system` skills under `src/skills/`, a file's ids sit on its last line, `Evidence (claim ids, for maintainers): [C-0xx] …`, not inline, because a client agent cannot resolve them. `test/skills-acceptance.test.ts` enforces that, and T5 in `test/skills.test.ts` still checks every id.

## Cross-document links

Relative links with `#anchors` are checked mechanically. **Anchors are derived from English heading text**, so changing a heading in English silently breaks every link pointing at it — unless the checker catches it first. Run the checkers before committing.

Headings referenced from other files are effectively API: treat them as stable identifiers.

## The documentation is locked

These documents were rewritten once by a parallel agent that introduced four
factual errors. To stop that recurring, the surface is locked in two layers.

**What is locked** (exactly what `scripts/lock-docs.mjs` hashes):
`README.md`, `AGENTS.md`, and every `.md`, `.mjs` and `.ps1` file under
`docs/` and `scripts/`, skipping dotfiles and `docs/superpowers/plans/`. The
`docs/` tree is walked whole, so a new document there (such as
`docs/reference/roadmap.md`) joins the lock at the next `--update`.

**What is not locked:** `docs/superpowers/plans/**` (working plans change by
design), the other root files (`CONTRIBUTING.md`, `LICENSE`, …),
`.githooks/`, `.github/`, and `src/`, `test/`, `tools/`, `spikes/`, `dist/`.

**Layer 1 — a recorded baseline.** `docs.lock.json` holds a line-ending
normalised sha256 for each file. `node scripts/lock-docs.mjs` verifies it and
exits 1 on any change. If the change is intentional:

```bash
node scripts/lock-docs.mjs --update
```

**Layer 2 — the filesystem (Windows only).** On Windows,
`node scripts/lock-docs.mjs --update` sets the read-only attribute on every
locked file and on `docs.lock.json`, so an edit fails with `PermissionError`
instead of merely being reported. On macOS and Linux the script changes no
file modes and layer 1 is the lock ([CONTRIBUTING.md § Locked
documents](CONTRIBUTING.md#locked-documents) has the commands there). To edit
one intentionally on Windows:

```bash
attrib -R <file>        # unlock
# ... edit ...
node scripts/lock-docs.mjs --update   # re-lock the baseline
attrib +R <file>        # re-lock
```

**The commit gate.** `.githooks/pre-commit` runs `check-docs`, `check-claims`,
`check-language` and `lock-docs`; any failure blocks the commit. It is enabled
with `git config core.hooksPath .githooks`. CI runs the same gates.

**Honest limit:** this stops accidents and silent drift, not a determined
process. A same-user process can run `attrib -R`, and a human can always
`git commit --no-verify`. That door is documented on purpose — a lock that
claims to be unbreakable is worse than one that admits it is not.

## Before committing

```bash
node scripts/check-docs.mjs      # links, anchors, tool counts, figma_* names
node scripts/check-claims.mjs    # claim IDs, statuses, sources, dates
node scripts/check-language.mjs  # everything is English
node scripts/lock-docs.mjs       # the locked surface matches docs.lock.json
npm run typecheck                # all three TypeScript projects
npx vitest run                   # the test suite (it rebuilds dist/ first)
```

All must exit 0; CI runs them on Node 22 and 24 on Ubuntu, Windows and macOS (macOS does not block until its first green run). The doc checkers catch administrative drift — not whether a claim is *true*. Truth needs a verifier from a separate context.

## Document roles

| Document | Role |
|---|---|
| [`README.md`](README.md) | Entry point for users: what Figxel does, requirements, Quickstart, configuration, privacy, troubleshooting. Shown on npm too, so it carries no internal history |
| [`docs/usage.md`](docs/usage.md) | **How to use Figxel, for people**: the first session, briefs and gears, example requests with what to expect, reviewing and undoing the agent's work, `BRIDGE_PROCESS`, tips |
| [`docs/reference/roadmap.md`](docs/reference/roadmap.md) | Status, phase plan, next steps, the Phase 0 order, locked decisions, and why Figxel uses a plugin |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup, conventions, tracked claims, locked documents, pull requests, releasing |
| [`SECURITY.md`](SECURITY.md) | How to report a security problem; the security design itself is spec §9 |
| [`docs/clients.md`](docs/clients.md) | Per-app setup: the server entry, config files per OS, tool limits, timeouts, installing the skills |
| [`docs/superpowers/specs/`](docs/superpowers/specs/) | The design spec — source of truth for architecture, safety, roadmap |
| [`docs/reference/tools.md`](docs/reference/tools.md) | **Source of truth for the tool list.** Counts in headings are parsed by a script |
| [`docs/reference/protocol.md`](docs/reference/protocol.md) | Wire-level protocol between bridge and plugin |
| [`docs/reference/claims.md`](docs/reference/claims.md) | **Source of truth for external facts** |
| [`docs/reference/current-state.md`](docs/reference/current-state.md) | Environment and prior art: the earlier work Figxel learned from, the first live run, and the measured version table (§5) |
| [`docs/agents/claim-verification.md`](docs/agents/claim-verification.md) | Contract for verification subagents |
| [`docs/agents/using-the-mcp.md`](docs/agents/using-the-mcp.md) | **Operating guide for an AI agent**, for people: own the brief, build one section per call, check each one, the process the skills teach, choose a tool, the prompts, resources and skill installation, and the safety rules that keep an agent from destroying work |
| [`src/skills/`](src/skills/) | **Source of all agent guidance**: one Agent Skills folder per skill, `figxel-<short>/` (`SKILL.md` plus `references/<section>.md`), bundled into the server and served by `figma_get_guide`, the prompts and the `skill://` resources. Budgets and drift checks live in `test/skills.test.ts`. Not locked: change guidance here, never in a copy |

When two documents disagree, the more specific one wins: `tools.md` over the spec on tool lists, `claims.md` over everything on external facts, `src/skills/` over `using-the-mcp.md` on what an agent is told.

## Status

Figxel ships as the npm package `figxel-mcp` (users run `npx -y figxel-mcp@latest setup`), with CI on Node 22 and 24 and a release workflow that publishes a pushed `v*` tag to npm and a GitHub Release. Phases 0–4 are implemented (spec §12): the bridge and plugin, the read group, core write, structure & system (components, styles, variables, constraints, effects, reactions), and parity (batch export, PDF, `figma_eval` opt-in, the selection resource). How an agent should work lives in eleven Agent Skills folders under `src/skills/` and is delivered over MCP from that one tree — the server `instructions`, `figma_get_guide`, ten prompts and `skill://` resources — and `figma_check_layout` and `figma_check_motion` let any agent verify its own work. A parity pass on 2026-10-08/09 matched the official Figma MCP's reach in design mode — 113 tools, from design tokens with scopes and modes, library import by key and component property editing to motion keyframes, video export and prototype flows — and is recorded in the [live design findings](docs/superpowers/plans/2026-10-08-live-design-findings.md). Phase 6 (2026-10-09) widened the plugin to FigJam and Figma Slides: 16 board and deck tools, 129 in the catalog, behind one editor table (`src/shared/editors.ts`) that refuses a write in an editor where it is not yet measured. The skills pass (2026-10-13) added four process skills — `design`, `storyboard`, `motion` and `critique` — and four tools for them (`figma_check_motion`, `figma_review_video`, `figma_create_storyboard`, `figma_create_animatic`), 133 in the catalog; it put `figma_export_video` in job mode, so a client timeout no longer discards a render, and fixed the keyframe and move defects found on 2026-10-09. Everything is unit-tested in CI; `spikes/live-all-tools.py` and `spikes/live-*.mjs` run the Design tools on a real canvas. Live runs still to do: FigJam and Slides — the [FigJam and Slides plan record](docs/superpowers/plans/2026-10-09-figjam-slides.md) lists them — and most of the skills pass's spikes and acceptance runs, listed in the [skills plan record](docs/superpowers/plans/2026-10-13-skills.md#results-of-wave-1-and-2). See [spec §12](docs/superpowers/specs/2026-10-06-figma-mcp-design.md#12-roadmap) and the roadmap's [Next steps](docs/reference/roadmap.md#next-steps).
