# Roadmap

Where Figxel stands, how it got here, what comes next, the decisions that are locked, and why it reaches Figma through a plugin. For using Figxel, start at the [README](../../README.md).

Figxel was called figma-mcp during development. The dated records this page links to (plans, spike results, the design spec's file name) keep that name.

**Status on 2026-10-16.** Phases 0–3 are done. Phase 4 (parity and polish) is implemented. Phase 6 (FigJam and Figma Slides) is implemented, and its live runs are still to do. Phase 7 (the design, storyboard, motion and critique skills) is implemented, and part of its live runs are done. On 2026-10-14 the project was renamed Figxel and released: the `figxel-mcp` package with its `setup` command, CI on Node 22 and 24 across Ubuntu, Windows and macOS, and a release workflow driven by tags. 0.1.0 is on npm; 0.1.1 (the motion process gate, `setup --register`) is on GitHub Releases and waits for npm publishing. The plugin stays a development plugin: Figma Community rejected it on 2026-10-15 `[C-342]`. 0.1.2, in progress, adds `figma_check_layout`'s `handoff` audit. The order of the work after it is in the [next releases plan](../superpowers/plans/2026-10-16-next-releases.md).

The Design-mode tools run on a real canvas through `spikes/live-all-tools.py` and `spikes/live-*.mjs`. The board and deck tools are unit-tested, and the FigJam and Slides writes not yet measured stay refused until their live runs record them. The records: the [FigJam and Slides plan record](../superpowers/plans/2026-10-09-figjam-slides.md), the [skills plan record](../superpowers/plans/2026-10-13-skills.md), [current state](current-state.md) and the [Phase 0 log](../superpowers/plans/2026-10-07-phase-0-walking-skeleton.md).

## Phase plan

| Phase | Contents | Outcome | State |
|---|---|---|---|
| 0 | Yield spike, scaffold, protocol, handshake, `figma_status`, mock plugin, CI (auto-launch attempted, then removed) | Proven alive, with numbers | **done** |
| 1 | Read: design context, node, selection, export and screenshot, variables, styles, fonts, search | An agent understands a design and generates code from it | **done** |
| 2 | Core write: `figma_create_from_spec`, basic create, modify and style, one undo step per op | An agent builds and reshapes whole screens | **done** |
| 3 | Structure and system: components and instances, styles, variables, full auto-layout | An agent manages the design system | **done** |
| 4 | Parity and polish: `figma_eval`, batch export, PDF, MCP resources, tool-description audit | "Equivalent to `use_figma`" verified | **implemented**; the description audit is not done |
| 5 | Hardening: multi-session, reconnect storm, load tests, final quickstart | Used daily | not started |
| 6 | FigJam and Figma Slides: the manifest widened, the editor table and gate, 16 board and deck tools, about 25 tools extended, the `figjam` and `slides` playbooks | An agent builds boards and decks | **implemented**; the live runs are not done ([plan record](../superpowers/plans/2026-10-09-figjam-slides.md)) |
| 7 | Skills: guidance moved into `src/skills/` and served five ways; the `design`, `storyboard`, `motion` and `critique` skills; `figma_check_motion`, `figma_review_video`, `figma_create_storyboard`, `figma_create_animatic`; job mode on `figma_export_video`; the four defects of 2026-10-09 fixed | An agent designs from a brief through directions, styleframes and measured critique, and plans, builds and reviews a motion piece | **implemented**; `figma_create_storyboard` is measured in Design, and `figma_create_animatic` and most acceptance runs are not done ([plan record](../superpowers/plans/2026-10-13-skills.md#results-of-wave-1-and-2)) |

"**done**" means a live probe exercised every tool in the group against a real canvas (`spikes/live-all-tools.py`). Phase 4's MCP resource (`figxel://session/<id>/selection`) is still open, so that phase is "implemented", not done.

After phase 7 came the public release work of 2026-10-14: the rename to Figxel, the npm package, `setup`, the CI matrix and the release workflow. Per-phase detail: [spec §12](../superpowers/specs/2026-10-06-figma-mcp-design.md#12-roadmap).

## Next steps

Each live run's results file is what turns an editor cell to **yes** or **no** and re-statuses a claim. Until then an unmeasured cell keeps refusing writes.

- **Publish 0.1.1 to npm**, then point the Quickstart back at `figxel-mcp@latest` and remove the temporary notes ([CONTRIBUTING.md § Releasing](../../CONTRIBUTING.md#releasing)).
- **Release 0.1.2:** the `handoff` audit, measured live once (a detached frame, a duplicate style), with the stable tests.
- **Live runs for FigJam and Slides.** Five spikes in order, plus a few steps only a person in Figma desktop can do ([plan record § Live runs still to do](../superpowers/plans/2026-10-09-figjam-slides.md#live-runs-still-to-do)).
- **The rest of the skills pass.** The spikes still open, among them the one that flips `figma_create_animatic`'s Design cell; a tools-only client walking every skill through `figma_get_guide`; the motion acceptance run; and re-runs of the earlier Design spikes ([skills plan record § Results of wave 1 and 2](../superpowers/plans/2026-10-13-skills.md#results-of-wave-1-and-2)). The record dates from 2026-10-13, and some runs have finished since: `spikes/results/live-storyboard.json` and the first design acceptance run, `spikes/results/2026-10-13-acceptance-design-1.md`.
- **The motion process, live.** A spike that stores a plan on an animated frame, reads it back through `figma_get_motion_context` and `figma_check_motion`'s snapshot (by a layer id as well, during a second-id period `[C-199]`), and runs the gate end to end: a keyframe write refused and then allowed, a passing check, a final render refused after an edit by hand, and the delivery. `figma_set_motion_plan`'s Design cell is yes ahead of this run (spec ADR #41).
- **macOS.** A first live run (setup, the plugin import and one Design spike) and a green CI run, after which the macOS job stops being non-blocking.
- **Roles.** A brief before new work and a sign-off after it, each role with its own workflow: the core and UI/UX in 0.2.0, then graphic, illustration, brand and presentation in 0.3.0 ([role spec](../superpowers/plans/2026-10-14-roles-spec.md), [next releases plan](../superpowers/plans/2026-10-16-next-releases.md)).
- **Phase 5, hardening.** Real multi-session use, reconnect storms and load tests of 10,000+ nodes ([spec §12](../superpowers/specs/2026-10-06-figma-mcp-design.md#12-roadmap)).

## Phase 0 — Walking Skeleton

State: **complete** (2026-10-07). The gate below passed; the record is the [Phase 0 log](../superpowers/plans/2026-10-07-phase-0-walking-skeleton.md). Later phases: [AGENTS.md § Status](../../AGENTS.md#status). Verified stack and versions: [current-state.md §5](current-state.md#5-verified-environment).

The order, with **two spikes up front** because their results could change the design:

| # | Step | Why first |
|---|---|---|
| **1** | **Spike: yield primitive.** A small test plugin that modifies 5,000 nodes under option A (timer), B (iframe ping-pong) and C (microtask), while trying to close the plugin, draw, and open menus | The whole anti-freeze strategy rests on it ([spec §14.1](../superpowers/specs/2026-10-06-figma-mcp-design.md#14-to-verify-during-implementation)). The old draft relied on microtasks, which by JavaScript semantics almost certainly never yield to the host |
| **2** | **Spike: auto-launch.** Measure the 4 metrics in spec §5.7.5, including while Figma is **not** in the foreground | **Ran, then the feature was removed.** Input was fixed (SendInput, `strayRisk: false`), but the premise, taking the screen from the person using it, was the wrong price. No further attempts |
| **3** | **Claim verification.** Run subagents per the [contract](../agents/claim-verification.md) over `C-012`, `C-013`, `C-021` and `C-025` (all `contradiction` or `to-verify` then); update the registry | So the facts the design rests on are confirmed before code depends on them |
| 4 | Scaffold: `package.json` (versions from current-state §5), tsconfig, esbuild (spec §4.5), Vitest, CI | — |
| 5 | `src/shared/`: protocol and per-op zod schemas | The contract both sides share |
| 6 | `src/server/`: WebSocket, MCP, token, origin check, idle timer, `figma_status` without a plugin, `PORT_IN_USE` behaviour | — |
| 7 | `src/plugin/`: `code.ts`, `ui.html`, `chunk.ts` with `yieldToHost`, `idempotency.ts`, `progress` plumbing | Belongs in Phase 0, not deferred (spec §12) |
| 8 | `tools/mock-plugin.mjs` with `--slow`, `--stall` and `--drop` scenarios | What makes TDD possible |
| 9 | `figma_status` end-to-end in Figma desktop, and verify spec §14.2–§14.7 | "Plugin connected, proven alive" |
| 10 | Register with an MCP client (any; see [docs/clients.md](../clients.md)), raise its timeout, and test the connection | Installed and usable by the agent |

**Phase 0 gate:** plugin connected, `figma_status` answers (also while no plugin is connected), all tests green, `node scripts/check-docs.mjs` and `node scripts/check-claims.mjs` pass, the `contradiction` and `to-verify` claims tested and the registry updated, and **both spikes producing written numbers** in the spec, not assumptions.

Once the gate passed, Phase 1 (Read) followed with its own implementation plan under `docs/superpowers/plans/`.

## Locked decisions

| # | Decision | Value |
|---|---|---|
| 1 | **Name** | Product **Figxel**. MCP server name `figxel`; npm package and bin `figxel-mcp`; plugin name in Figma `Figxel`. The plugin's manifest id stays `figma-mcp-bridge`, because Figma keys a plugin's saved data, the token included, by that id `[C-276]`. The public wording says Figxel works with Figma and is not affiliated with it `[C-272]`. During development the project was called figma-mcp |
| 2 | **Toolset** | **Every catalog tool active by default: 133** (+`figma_eval` when opted in; the three tools of the `audio` group, held back from the release on 2026-10-14, only with `BRIDGE_ENABLE_AUDIO=1`; 137 in the catalog). Trim through the client's tool picker or `BRIDGE_TOOLSET`, which apps with a tool limit need (VS Code 128 `[C-286]`, Windsurf 100 `[C-289]`) |
| 3 | **Port** | `38452`, loopback only `[C-037]` |
| 4 | ~~**Auto-launch**~~ | **Removed 2026-10-07** (ADR #32). `BRIDGE_AUTOLAUNCH` is parsed but inert |
| 5 | **`figma_eval`** | Present, opt-in (`BRIDGE_ALLOW_EVAL=1`) `[C-041]` |
| 6 | **Reverse-engineering route** | Deliberately rejected (ADR #21) |
| 7 | **Editors** | Figma Design, FigJam and Figma Slides; Dev Mode stays out (ADR #33) `[C-128]`. Which tool runs where is one table ([tools.md § Editor support](tools.md#editor-support)); a write not yet verified in an editor is refused there `[C-129]`. `BRIDGE_ALLOW_UNVERIFIED=1` (default `0`) lets the process that sets it run those writes, for a measuring run, never a **no** cell ([spec §4.7](../superpowers/specs/2026-10-06-figma-mcp-design.md#47-editor-types)) |
| 8 | **Agent guidance** | Eleven Agent Skills folders in `src/skills/`, one source served five ways: `figma_get_guide` (every client has it), the server `instructions`, ten prompts, `skill://` resources, and the folders installed as skills (ADR #38) `[C-237]` |
| 9 | **Distribution** | The npm package `figxel-mcp`, which an AI app starts as `npx -y figxel-mcp@latest` `[C-283]`. `setup` copies the plugin to `~/.figxel/plugin`, a path that stays the same across updates, and the server refreshes that copy when it starts; a re-run of the plugin loads it `[C-275]`. The home folder is `~/.figxel` (`BRIDGE_HOME`), and a token from `~/.figma-mcp` is copied once |
| 10 | **Licence** | MIT |

**Why every tool is active rather than trimmed on the server:** the best trimming happens in the client, because the person using it knows which tools they need, and a client's tool picker selects tools per server without touching Figxel's code. For clients with no picker, or with a hard tool limit, `BRIDGE_TOOLSET` registers a smaller set.

## Why a plugin

Software can reach a Figma file in three documented ways. Figures checked against Figma's docs on the dates in the registry:

| Path | Writes to the canvas? | What it needs | Limits |
|---|---|---|---|
| Official Figma MCP server (remote or desktop) | Yes, through `use_figma`, which runs Plugin API JavaScript in the file `[C-008]` `[C-010]` | A Full seat to write; a Dev seat gets read-only workflows `[C-007]` | Read tools are rate-limited per seat: View and Collab seats 20 calls a month on every plan `[C-001]`, Dev and Full seats 200–600 a day plus a per-minute limit `[C-003]`. Write tools are exempt `[C-004]` |
| REST API | **No**, read-only `[C-005]` | An access token | Rate-limited per tier `[C-006]` |
| **A plugin** (Figxel's path) | **Yes**, through the Plugin API directly | Figma desktop `[C-274]`, and a person who runs the plugin `[C-016]` | Your plan's feature limits apply as in the editor `[C-045]`: a Starter file has at most 3 pages `[C-048]` and no variable modes `[C-047]` |

Figxel takes the plugin path because it works inside the editor, on the files you already have open, in Figma Design, FigJam and Figma Slides alike. It reaches the same Plugin API that `use_figma` runs `[C-008]`, and it lets the server offer typed tools with schemas and validation where the official server takes raw JavaScript ([tool catalog](tools.md)).

**Figxel is not a way around Figma's plans, seats or fees.** Figma's Acceptable Use Policy forbids circumventing service limits and using the services to avoid fees owed `[C-036]`. A plugin works within your plan as the editor does `[C-045]`, and Figxel is meant to be used within your plan and Figma's terms.

Figxel does not use Figma's private, internal protocol either: that route was rejected ([ADR #21](../superpowers/specs/2026-10-06-figma-mcp-design.md#13-decisions-adr-lite)).

**The plugin stays a development plugin, installed by `setup`.** Figma Community does not list plugins that give AI programmatic access to files outside the official MCP server `[C-303]`; Figxel's plugin was submitted on 2026-10-15 and rejected the same day for overlapping with the Figma MCP server `[C-342]`.

### Opening the plugin

**The plugin needs to be opened once per Figma session**, not per tool call and not per agent session. A plugin that does not close itself keeps running `[C-011]`, and Figxel's plugin reconnects to the server within 3 s every time an app starts it. Open Figma in the morning, run the plugin once, and the agent can work all day without a click.

There is **no auto-launch**. Figma offers no command line or link that runs a plugin `[C-016]`. A launcher that drives Figma's window was built, measured and removed: Figma's window drops keyboard input sent in the background, so any launcher has to take focus `[C-052]`, and no idle threshold tells "the person is away" from "the person is thinking" `[C-053]`. Raising Figma over someone's work is the wrong price for opening a panel ([spec §5.7](../superpowers/specs/2026-10-06-figma-mcp-design.md#57-removing-friction-auto-connect), ADR #32).

### Long work in a plugin

A plugin runs on Figma's main thread, and every MCP client has its own timeout. This is how Figxel keeps long work responsive and safe:

| Limit | How Figxel handles it |
|---|---|
| A plugin runs on Figma's main thread, so heavy work freezes the editor | **Yield to Figma every 12 ms** with a timer, the mechanism a Phase 0 spike settled `[C-012]` `[C-013]` |
| Big work means many requests | **Batching**: one spec builds N nodes in one call |
| Huge documents flood the context | **Compact results with depth, limit and cursor**: split, never rejected |
| Timeouts end long work | **An idle-based bridge timeout**, reset by every progress signal `[C-029]`; the bridge sets no duration ceiling |
| Each MCP client has its own tool-call timeout, and the defaults differ: Hermes 300 s `[C-031]`, Codex 60 s `[C-287]`, Gemini CLI 10 minutes `[C-288]`, Claude Code about 28 hours `[C-279]` | **Raise the client's timeout** ([docs/clients.md](../clients.md)); Hermes, for one, accepts up to about 49.7 days `[C-042]`. A video render answers with a job id before a short timeout. And **`idempotencyKey`**: a retry never runs twice, and a finished result is returned |
| Machine time and memory | Work is accepted and runs, with progress, cancel and partial results |

**The principle:** the bridge limits how long a call may sit idle, not how much work it does, and a timeout never discards finished work. No error means "too big"; the only load-based refusal is `BUSY` (a full queue, or a video render holding Figma). The cost is time: a real yield costs about one rendered frame, so a heavy operation that keeps Figma usable runs **2.8×–3.7×** longer than one that freezes it `[C-050]`. Details: [design spec §5.5](../superpowers/specs/2026-10-06-figma-mcp-design.md).

### What a plugin cannot do

**What can be promised:** everything the official `use_figma` does is doable here, through typed tools or `figma_eval` `[C-008]`, plus reading design context, screenshots and variables.

**What cannot:**

- Tool-for-tool parity with the official server. Code Connect, hosted AI services and hosted generation (`generate_diagram`'s layout, `generate_deck` templates), library search for components and styles, Slides templates and themes, and creating interactive slide elements are out of a plugin's reach; Dev Mode is out by decision `[C-128]` ([tools.md § Not implemented](tools.md#not-implemented)).
- Every tool in every editor today. FigJam and Figma Slides are in reach, but a write not yet measured on a real board or deck is refused there until a live run records it ([tools.md § Editor support](tools.md#editor-support)).
- Paid-plan features on a Starter file `[C-045]`: a Starter file still allows only 3 pages `[C-048]` and no variable modes `[C-047]`. Variables themselves work on any plan `[C-046]`.
- Responsive **and** fast at once `[C-050]`.
- That a single tool call may run as long as it needs in a client whose timeout is unknown.
