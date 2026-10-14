# FigJam and Figma Slides — Plan Record (2026-10-09)

The record of Phase 6: what was built, the editor gate and its cell policy, the work packages, what is deferred and why, and the live runs that are still to do. The design itself lives in the spec ([§4.7 Editor types](../specs/2026-10-06-figma-mcp-design.md#47-editor-types), ADRs #33–#37 in [§13](../specs/2026-10-06-figma-mcp-design.md#13-decisions-adr-lite)); the tool list and every editor cell in [tools.md](../../reference/tools.md#editor-support).

**State:** implemented and unit-tested — 63 test files, 1263 tests passing; `npm run build` and `npm run typecheck` passed in the integration run. **No live run has happened yet**, so no FigJam or Slides cell has been flipped from its initial value. Committed on branch `feat/figjam-slides` as work in progress: not yet reviewed adversarially and not yet run live — see the [hand-off](#hand-off-on-2026-10-09) for where it stopped.

## Hand-off on 2026-10-09

**Done:**

- Five work packages built and integrated: the editor gate, the reads, the FigJam tools, the Slides tools, and the existing write tools across editors.
- Every gate passes: 1263 unit tests, typecheck and build. Every doc checker passes too: `check-docs`, `check-language`, `lock-docs`, and `check-claims` (161 claims, with C-128 to C-167 registered).
- The 8 contradiction claims are marked for a spike wherever they are cited.

**Not done, in this order:**

1. **Fix the defects below.** The keyframe one comes first, because it silently loses work. Each fix needs a reproduction and a test that fails on the old code. **Done on 2026-10-13** in the skills pass: the diagnosis, the fixes and their tests are in [its plan record](2026-10-13-skills.md#4-the-four-defects); the live probes that settle the mechanism are still to run.
2. **Review the FigJam / Slides diff adversarially**, the way the parity pass was reviewed: find, verify, then fix with tests.
3. **Run the five live spikes** with the user steps in [Live runs still to do](#live-runs-still-to-do). Figma desktop must not be minimized while a spike renders or exports.
4. **Flip the editor cells and re-status the claims** from `spikes/results/` only. Re-run the Design spikes, then open the pull request.

### Defects found while building the motion ad

Agents built a 98-layer, 197-track Instagram Story ad through the tools on 2026-10-09: the frame "Moku — IG Story Ad v2 (motion)" next to the first ad (Moku is a fictional demo brand). They reported these defects in our tools. None is reproduced live yet; each is diagnosed and fixed in the [skills plan record](2026-10-13-skills.md#4-the-four-defects), with a test that fails on the old code.

| Defect | Where it was seen | Next step | Diagnosis and fix |
|---|---|---|---|
| `figma_set_keyframes` with several tracks in one call applied only the last track, and raised no error. Its result echoed the old keys for the other tracks. Twice it was also given `timelineDuration`, and the call returned another timeline's id (47:559) and dropped 2 of its 3 tracks | Both rounds of fixes, including steps inside `figma_batch`. Sending one call per track landed every track, and a full read-back then matched | Reproduce on a node that already has tracks and on a fresh one: a write of the whole `manualKeyframeTracks` object per track would explain it. Whatever the cause, read the tracks back after the write and report any that did not land | [D1](2026-10-13-skills.md#d1--figma_set_keyframes-kept-only-the-last-of-several-tracks-with-timelineduration-it-returned-a-foreign-timeline-id) |
| `figma_move_nodes` given both `x` and `y` moved only `y` (x stayed at -1176) | Two circles inside a scene container | An x-only call worked. Check how `x` and `y` are applied per item | [D2](2026-10-13-skills.md#d2--figma_move_nodes-given-x-and-y-moved-only-y) |
| `figma_move_nodes` inside `figma_batch` answered `ok: true` without moving the node | A mask frame during the scene build | A standalone call worked. Check the batch step path | [D3](2026-10-13-skills.md#d3--figma_move_nodes-inside-figma_batch-answered-ok-true-without-moving) |
| Ids with a `45:` prefix (twins of `42:` nodes) could be read, but every write to them answered "not found" | During the fixes | Find where the twin ids come from before changing anything | [D4](2026-10-13-skills.md#d4--twin-ids-prefix-45-were-readable-then-every-write-said-not-found) |

**Seen along the way.** These were observations when this record was written; each has since been registered, and its ID follows it:

- **Keyframes overwrite the resting value.** Setting keyframes writes each track's value at t = 0 into the node's resting property (opacity, size, spacing). So `figma_export_node` of a layer that starts invisible renders blank. Render resting states before keyframing, or judge motion from `figma_export_video` frames. The motion guide should say this. Still to be verified: not reproduced on 2026-10-13 with a HEIGHT key `[C-204]`.
- **A minimized window stalls video export.** A render stalled for about 40 minutes until the window was restored `[C-198]`.
- **An MCP client can cancel a long render.** A client cancelled `figma_export_video` after about 60 s (its own request timeout), and the cancel also stopped the render `[C-197]`. Progress notifications during the export would keep a client's timeout from firing — but only in a client that opts in `[C-030]`, so the fix is job mode on `figma_export_video` `[C-249]` ([the related defect](2026-10-13-skills.md#related-defect-found-in-the-diagnosis--a-client-timeout-threw-away-a-running-render)).
- **An ffmpeg seek can land one frame late.** As an input seek, `ffmpeg -ss (k+0.5)/30` returns frame k+1. Cut an exact frame with `select=eq(n\,k)` instead `[C-195]`.

## What was built

**The plugin runs in three editors.** `src/plugin/manifest.json` declares `editorType: ["figma", "figjam", "slides"]` (ADR #33) `[C-128]`. Dev Mode stays out, and `["figjam", "dev"]` is not a valid combination anyway `[C-131]`. `documentAccess`, the permissions (`currentuser`, `teamlibrary`) and `networkAccess` are unchanged.

**16 new tools** — 129 in the catalog, 128 registered by default (`figma_eval` opt-in); groups meta 5, read 21, create 32, modify 47, style 18, export 5, eval 1. The `core` tier is unchanged at 20.

| Group | New tools | Editor |
|---|---|---|
| read | `figma_get_slide_grid` | Slides |
| create | `figma_create_stickies`, `figma_create_connectors`, `figma_create_code_block`, `figma_create_link_preview` | FigJam |
| create | `figma_create_shapes_with_text`, `figma_create_table` | FigJam; Slides unmeasured |
| create | `figma_create_slides` | Slides |
| modify | `figma_edit_connectors` | FigJam |
| modify | `figma_edit_table` (destructive, kept out of batches), `figma_set_board_properties` | FigJam; Slides unmeasured |
| modify | `figma_fit_sections` | Design, FigJam and Slides, all unmeasured |
| modify | `figma_set_slide_grid`, `figma_move_slides`, `figma_set_slide_properties` | Slides |
| style | `figma_set_slide_transition` | Slides |

**About 25 existing tools extended** to boards and decks:

- **Reads.** `figma_get_design_context` reads every FigJam node type (sticky, shape, connector with endpoints in the form the writers take, table cells, code block, section, link, embed, media, widget) and adds the board's `connectors` edge list; on a deck it reads slides, keeps the grid and rows opaque, and with nothing selected starts from the focused slide or the deck's outline. Every DTO (`figma_get_node`, `figma_get_nodes_info`, `figma_get_selection`, `figma_search_nodes`, `figma_scan_nodes_by_types`) gains a short preview on board and deck types; Design DTOs are unchanged. `figma_scan_text_nodes` covers every text holder, one item per table cell; `figma_search_nodes` gains `text`; `figma_get_metadata` adds a board or deck outline; `figma_get_fonts` counts sublayer fonts; `figma_get_annotations` tolerates members a board node lacks.
- **Checks.** `figma_check_layout` gains `audit: board` (`section_overflow`, `sticky_overlap`, `dangling_connector`, `label_too_long`, `text_not_charcoal`, `off_palette`, `section_name_duplicate`) `[C-156]` `[C-159]` `[C-160]`, slide bounds rules (`out_of_slide`, `bleed`, `text_cut_by_slide`) `[C-155]`, and `nodeIds` for a batch of slides.
- **Writes.** `figma_create_from_spec` gains the board node types (sticky, shape, table, code, connector — connectors built last by `ref`), `ref` / `refs`, section `arrange` and `hug` `[C-166]`, array roots for one spec per slide, text lists, and a top-down build on slides that reports `drift` `[C-146]`. Every create takes a SLIDE as `parentId` and defaults to the focused slide in a deck. `figma_create_section` (nesting, fill, `contentsHidden`, `resizeWithoutConstraints` only, the one resize the conflicting sources agree on `[C-141]`), `figma_create_text` (FigJam's Inter Medium in Charcoal), `figma_create_page` (`UNSUPPORTED` where the factory is missing; pages in FigJam wait for a spike `[C-142]`), `figma_set_text`, `figma_set_text_properties`, `figma_set_text_range` (`indent` `[C-167]`) and `figma_find_replace_text` reach sublayer text and table cells `[C-135]`; `figma_reparent_nodes` gains `x`, `y`, `keepPosition` and a connector warning `[C-149]`; `figma_clone_node`, `figma_delete_nodes`, `figma_move_nodes`, `figma_reorder_nodes` and `figma_resize_nodes` follow the slide and board rules per item.
- **Meta and export.** `figma_status` reports each file's editor, `unavailableTools` and `unverifiedTools`, and the bridge's `allowUnverified`; `figma_zoom_to` focuses a slide and switches the deck view (feature-detected, since the sources are conflicting `[C-140]`); `figma_export_frames_to_pdf` exports a whole deck in grid order; `figma_batch` checks every step's editor.

**Guides and prompts.** `figma_get_guide` gains the topics `figjam` and `slides` (condensed from the official FigJam and Slides skills: one zone per call and connectors last on a board; 3–5 slides per batch, one spec per slide, never delete slides to rebuild `[C-155]`); the `spec` topic documents the board types and array roots, with a worked retro example that a test builds; the server `instructions` say which editors run and point at those topics. Two prompts, `build_board` and `build_deck`, join `build_in_figma`, `design_to_code`, `create_design_system_rules` and `code_to_design`.

## The editor gate and the cell policy

One table in code, `src/shared/editors.ts`, holds one explicit row per op with a cell per editor `[C-129]`. `test/editor-gate.test.ts` fails on an op without a row (deny by default) and pins [tools.md § Editor support](../../reference/tools.md#editor-support) to the table cell for cell.

| Cell | Meaning | Used when |
|---|---|---|
| **yes** | Runs | Design for every tool verified there; reads whose code touches nothing editor-specific, everywhere |
| **no** | Refused for every call, read or write | Only where the typings **and** a Figma page agree it cannot run `[C-132]` `[C-133]` `[C-134]` |
| **unmeasured** | Reads run; writes are refused at the bridge | Everything else, and every fact the sources disagree on — a conflicting source is settled by a spike, never read as **no** |

**Where it is enforced** ([spec §4.7](../specs/2026-10-06-figma-mcp-design.md#47-editor-types)): the bridge refuses first, right after choosing the session and before the "plugin too old" check, with `UNSUPPORTED`, `partial: { created: [] }` on a write, `safeToRetry: true`, and a hint naming a connected file where the tool runs. A batch is refused whole at its first step that may not run. The plugin refuses the **no** cells again, before the idempotency store begins, for a hub build that predates the gate. A file name several files share picks the one whose editor runs the op; a `/board/` or `/slides/` link picks its editor.

**`BRIDGE_ALLOW_UNVERIFIED` belongs to the process the MCP client talks to**, exactly like `BRIDGE_ALLOW_EVAL`. A proxy forwards its own flag with each call it forwards; the hub applies its own flag OR the forwarding proxy's, for that call only. A **no** cell is refused whatever the flag. The reason: a live spike runs as a proxy (`spikes/mcp-client.mjs` spawns `node dist/server.js`, which joins the user's running hub), so it can measure without the user's MCP client being restarted, while that client stays strict. `test/editor-gate.test.ts` § "through a proxy" proves it: a proxy-forwarded unmeasured write runs with the proxy's flag and is refused without it, and a **no** cell is refused either way.

**The initial cells** (129 rows):

| Editor | yes | no | unmeasured |
|---|---|---|---|
| Design | 113 | 15 | 1 |
| FigJam | 23 | 14 | 92 |
| Slides | 24 | 11 | 94 |

- **Design:** every earlier tool is **yes**. The 15 board and deck tools are **no**; `figma_fit_sections` is **unmeasured** (it sizes Design sections too, and waits for its spike there).
- **FigJam no:** the four create-style tools, `figma_convert_to_component`, `figma_combine_as_variants`, `figma_get_motion_context`, `figma_export_video` `[C-133]`, and the six Slides tools `[C-134]`.
- **Slides no:** the four create-style tools, `figma_get_motion_context`, `figma_export_video` `[C-133]`, and the FigJam-only tools whose factories both sources place in FigJam alone — stickies, connectors, code blocks, link previews, connector edits `[C-132]` `[C-134]`.
- **yes outside Design:** the bridge-answered tools (`figma_status`, `figma_get_guide`), the view tools (`figma_select`, `figma_navigate_page`, `figma_zoom_to`), the editor-neutral reads (metadata, design context, nodes, selection, fonts, search, both scans, pages, font suggestions, `figma_check_layout`), `figma_batch` (every step is checked on its own), the export tools except video, `figma_eval` (two-key opt-in), and `figma_get_slide_grid` in Slides.

**Decisions left to confirm** (each is the plan's initial value; none was flipped):

- `figma_create_stickies` is Slides **no** on the typings' "only available in FigJam" `[C-132]`; Working in Slides names `createSticky` in neither list, so a stricter reading of AGENTS.md makes it **unmeasured**.
- `figma_set_board_properties` is Design **no**: Design files have `figma_set_fills` / `figma_set_strokes`.
- `figma_fit_sections` is Design **unmeasured**, so a Design file refuses its writes until a spike records them or `BRIDGE_ALLOW_UNVERIFIED` is set.

## Work packages

Five packages with disjoint file ownership; WP-A landed first, B–E branched from it and ran in parallel, and the main agent integrated.

| Package | Built | Files |
|---|---|---|
| **WP-A** platform and gate | The manifest; the editor table and the refusal text both gates use; the bridge gate, the plugin backstop and the batch step check; `BRIDGE_ALLOW_UNVERIFIED` with proxy forwarding; editor-aware session choice; `/slides/` links and link editors; `figma_status` fields; the `Editors:` description suffix within 1024 characters; the shared board vocabulary (30 shape types, 7 magnets, 12 caps, 17 code languages, the one-string endpoint grammar), `placeGrid`, `safe.ts`, `sublayer.ts`, the spec-type contract | `src/shared/editors.ts`, `figjam.ts`, `grid-layout.ts`, `src/plugin/safe.ts`, `sublayer.ts`, `spec-types.ts`, `src/server/bridge.ts`, `peer.ts`, `config.ts`, `sessions.ts`, `figma-url.ts`, `tools/forward.ts`, `meta.ts`, `batch.ts`, `src/plugin/code.ts`, `ops/batch.ts`, `spikes/live-editors.mjs` |
| **WP-B** reads and checks | Board and deck node types in every read, the connector edge list, opaque slide types, guarded member reads, the board audit and slide bounds rules | `src/plugin/board-read.ts`, `context.ts`, `read.ts`, `ops/read.ts`, `ops/check.ts`, `src/server/tools/read.ts`, `spikes/live-reads.mjs` |
| **WP-C** FigJam tools | The ten board tools, the per-type palettes, the board spec types | `src/plugin/figjam/*`, `ops/figjam.ts`, `src/server/tools/figjam.ts`, `spikes/live-figjam.mjs` |
| **WP-D** Slides tools | The six deck tools, the grid read and written through its tree, deck PDF export, slide focus and view | `src/plugin/slides/grid.ts`, `ops/slides.ts`, `src/server/tools/slides.ts`, export and zoom, `spikes/live-slides.mjs` |
| **WP-E** existing writes | Slide parents and the focused-slide default, the spec builder's registry, `ref`, deferred types, `arrange` / `hug`, array roots, lists and the top-down slide build, sublayer text in every text tool, the slide and board rules in the structure tools | `src/plugin/ops/create.ts`, `write.ts`, `modify.ts`, `typography.ts`, `shapes.ts`, `style.ts`, the matching server tools, `spikes/live-editors-write.mjs` |

**Integration** wired the registries (`src/shared/ops.ts`, `src/server/tools/index.ts` — the new tools register before `figma_batch`, so a batch step can name them — `src/plugin/ops/index.ts`, 16 rows in `editors.ts`), the guides and prompts, and `docs/reference/tools.md`. Seams it fixed after the merge:

- `off_palette` added to the board audit, once WP-C's palettes existed; sections are skipped until a spike measures their swatches `[C-144]`.
- Slide ids are normalised by the shared id normaliser (`figma-url.ts`), so a `/slides/` link still picks the deck's session and slide ids inside a batch step are normalised too.
- The plugin build id now hashes every file under `src/plugin` and `src/shared` (`tools/plugin-sources.mjs`): a fixed file list had left out new sources, so `figma_status` could have called a stale plugin current.
- One word for one view: the deck view reads `single-slide` everywhere.
- `test/editor-integration.test.ts` pins the cross-package seams (every catalog op in the plugin with the same write flag, every tool registered once, every `figma_*` name in a description real), and the guide examples are built in tests rather than trusted.

**Where the build differs from the plan:**

- `figma_set_slide_transition` is built now, with feature detection — each slide's transition is read before anything changes, and a build that does not implement it answers `UNSUPPORTED` with nothing changed. Its Slides cell is **unmeasured**; the sources are conflicting, and the live spike decides whether it stays `[C-139]`. (The plan made it conditional on a probe that has not run.)
- `DART` stays in the code-language list with a note citing the conflicting sources `[C-143]`; the live probe decides whether it stays. (The plan kept it only if accepted live.)
- `BRIDGE_ALLOW_UNVERIFIED` is per process with proxy forwarding, not a hub-only setting, and the spikes run as proxies instead of having to be the hub (see above, and the next section).
- No live run happened between WP-A and the parallel packages, so every existing tool's FigJam and Slides cell is still its initial value.

## Deferred, dropped and out of reach

**Deferred:**

- **A local diagram tool**, `figma_create_diagram` (a layered layout from a structured spec, a Mermaid subset compiled on the server, ERD later) — a tools.md candidate (ADR #36) `[C-130]`. Why: every input it rests on is unmeasured (connector endpoint units, defaults and routing `[C-148]` `[C-149]`, shape fit-to-text sizes); it is about as large as everything else in this pass; there is no baseline, since the official `generate_diagram` is hosted `[C-154]` and its server is not authorised here; and Mermaid's own parser package parses none of flowchart, sequence, state, ER or gantt, so Mermaid means a home-grown subset parser. **Re-entry criteria:** `[C-148]` and `[C-149]` re-statused to measured; WP-C's builders (`src/plugin/figjam/nodes.ts`) as its composition layer; three official renders (a 20-node flowchart, a state diagram, a 12-message sequence diagram) to compare against. Until then diagrams are hand-built: shapes with text and connectors joined by `ref` in one `figma_create_from_spec` per zone, split above about 20 nodes.
- **Section colour names** in `figma_create_section` and `figma_set_board_properties`: hex only until FigJam's section swatches are measured — the sources are conflicting, the spike settles it `[C-144]`.
- **Images on boards and slides:** `figma_import_image` stays unmeasured outside Design `[C-150]`; the official path is the hosted `upload_assets`.
- **GIFs** (`createGif`): they need an image hash first, so they wait on the same measurement `[C-150]`.
- **A connector attached to a connector:** refused until measured.

**Dropped or folded:**

- A separate board reader like the official `get_figjam`: `figma_get_design_context` reads every board node type and the edge list, plus `figma_export_node` for the picture `[C-153]`.
- A separate slide-row tool: `figma_create_slides` with `row` = the row count opens a new row.
- A `content` parameter on `figma_create_slides`: one `figma_create_from_spec` per slide instead (array roots); speaker notes go through `figma_set_slide_properties`.
- List levels on `figma_create_text`: `figma_set_text_range` `indent` instead.
- Moving slides by coordinates: one grid write gives one code path and one undo step.

**Out of reach or out of scope:** Dev Mode (decision `[C-128]`) and Figma Buzz; creating stamps, highlights, washi tape and widgets (no create API); a stamp's author (needs a permission not requested); another widget's synced state; writing a sticky's author name (impersonation, never offered); `figma.timer` and active users; hosted services (`generate_diagram`'s layout, `generate_deck` templates `[C-087]`, FigJam AI and templates, `create_new_file`); slide themes and template instantiation; creating interactive slide elements; presenting; a per-session tool list; `use_figma`'s no-change-on-error semantics (we keep partial results plus one undo step); components, styles, variables and libraries in Slides stay unmeasured and refused for writes until the spike settles the conflicting sources `[C-137]`.

## Live runs still to do

Each spike writes `spikes/results/<spike>.json`: one record per probe with the exact value or Figma's exact error message, so the editor cells and the claim statuses can be updated from that file alone. Only those files may turn a cell to **yes** or **no**.

**How every spike runs:**

- It connects as a **proxy** of whatever hub the user's MCP client started (`spikes/mcp-client.mjs` spawns `node dist/server.js`, which joins the running hub), with `BRIDGE_ALLOW_UNVERIFIED=1` and `figma_eval` registered in its own process. It does not require the hub role. With no MCP client running, the spike's own server is the hub, and that works the same way.
- It checks that the hub runs the current build (`figma_status` build fields). If `build.restart` is `"client"` it prints "restart the MCP client so the hub runs the current build" and exits 2; if a plugin window is stale it says which file to re-run the plugin in, and exits 2.
- It picks files by name: Design `fmcp-design-scratch`, FigJam `fmcp-board-scratch`, Slides `fmcp-deck-scratch`. A missing file prints which one to open and exits 2.
- The default run is fully automatic. Steps that need a human hand — clicking the board, choosing swatches in FigJam's colour picker, switching the Slides view when the API cannot, answering what the screen shows — run only with `INTERACTIVE=1`; without it they are recorded as skipped.
- Every node a spike makes is deleted unless `KEEP=1`. Exit 0: measured, every expectation about our own code held; 1: one failed; 2: the run could not start.

**Order:**

| # | Spike | Settles |
|---|---|---|
| 1 | `spikes/live-editors.mjs` (WP-A) | Which Plugin API members exist in each editor and which reads throw `[C-145]`; the conflicting facts on components, sections, shapes and tables in Slides, speaker notes, transitions, pages in FigJam, images `[C-137]` `[C-138]` `[C-139]` `[C-142]` `[C-150]` (each settled by this spike); DART `[C-143]`; the gate refusing cleanly without the flag; routing by file name; one undo step per call `[C-151]`; events `[C-152]`. Decides the existing tools' cells, whether `figma_set_slide_transition` stays, and whether DART stays |
| 2 | `spikes/live-editors-write.mjs` (WP-E) | The existing write tools on a board and a deck: the slide drift `[C-146]`, the focused slide as default parent, slides cloned into their row, sections nested and resized `[C-141]`, sublayer and cell text `[C-135]`, `keepPosition` and connector routing `[C-149]`, FigJam text defaults `[C-156]`, `arrange` / `hug` `[C-166]`, list indents `[C-167]`, and the structure and style tools still unmeasured there |
| 3 | `spikes/live-reads.mjs` (WP-B) | What each board node reads back as, the opaque grid and rows staying unread, the free endpoint's coordinate space `[C-148]`, the view property `[C-140]`, `figma_check_layout` on a board and a slide |
| 4 | `spikes/live-figjam.mjs` (WP-C) | The ten board tools read back through the document: sticky sizes `[C-147]`, connector defaults, endpoint units and routing `[C-148]` `[C-149]`, table minimum widths `[C-161]`, link previews `[C-162]`, DART `[C-143]`, `figma_fit_sections` in FigJam and in Design, and FigJam's own swatches `[C-144]` `[C-156]` (with `INTERACTIVE=1`) |
| 5 | `spikes/live-slides.mjs` (WP-D) | The grid on an empty deck, rows, regrouping and row names `[C-164]`, skipped slides, speaker notes `[C-138]`, transitions `[C-139]`, the deck as a PDF, the focused slide and the view `[C-140]`, one undo step per call `[C-151]` |

**After each run:**

1. Flip the cells in `src/shared/editors.ts` and the tools.md § Editor support table together (the test pins them), from the results file only.
2. Re-status the claims: to-verify → measured; a contradiction → measured with the side observed, or corrected. Grep each ID and update every document that uses it.
3. Fix any tool whose measured behaviour differs from its description — endpoint units, DART, the section palette, the view property, transitions.

**Then:** re-run every spike **without** the flag and confirm that unmeasured cells refuse cleanly and measured ones run; re-run the Design spikes (`spikes/live-parity.mjs`, `spikes/live-all-tools.py`, `spikes/live-wp*.mjs`) to prove Design is unchanged; commit only after that.

### User steps

What only a person in Figma desktop can do. The agent runs the build and the spikes.

1. **Keep your MCP client running.** The spikes join its hub as a proxy, with their own flag; your client stays strict. If a spike stops with "restart the MCP client so the hub runs the current build", restart the MCP client that started figma-mcp (Claude Code, Claude Desktop, …), then run the spike again.
2. **After `npm run build`** (done; the widened manifest is in `dist/`):
   - Close every open "figma-mcp bridge" plugin window — a running plugin keeps its old bundle.
   - Open any FigJam board and look under Plugins → Development. If "figma-mcp bridge" is missing there: Plugins → Development → Manage plugins in development → remove figma-mcp bridge → "Import plugin from manifest…" → `dist/plugin/manifest.json` in this repo.
   - Say whether you had to re-import: that settles part of `[C-152]`.
3. **Create three scratch files** with these exact names (the spikes pick files by name): a Design file `fmcp-design-scratch`; a FigJam board `fmcp-board-scratch`; a **new, empty** Slides deck `fmcp-deck-scratch` — add no slides yourself, the empty grid is part of the test.
4. **Run the plugin in each file** (Plugins → Development → figma-mcp bridge) and keep the windows open. If one asks for the token, paste it (`node dist/server.js --print-token`), and say which editors asked — whether the saved token is shared across editors `[C-152]`. Do not edit these files while a spike runs.
5. **For the steps that need a hand, run with `INTERACTIVE=1`:**
   - `live-editors`: when it prints "click the board now", click once on the board's canvas, so it becomes the most recently active file (the routing test).
   - `live-figjam`: when it asks, pick each named swatch in FigJam's colour picker for the selected probe section, sticky and connector, pressing Enter after each, and say whether the picker shows the colour as a named swatch — the spike's answer to the conflicting palette sources `[C-144]` `[C-156]`.
   - `live-editors-write` and `live-reads`: switch the deck between grid and single-slide view when asked — only asked when the API could not switch it.
   - `live-slides`: answer what the screen shows (a row's label, which view is showing).
6. **At the end:** in each file press Ctrl+Z once and say whether only the last spike change disappeared — one undo step per call `[C-151]`. Then delete the three scratch files, or keep them for a re-run.

The plan's optional step of inserting a poll by hand (an interactive slide element, which a plugin cannot create) has no spike reading it yet; a hand-inserted poll can be read with `figma_get_slide_grid` and `figma_get_node`, which report it as an opaque box `[C-136]`.
