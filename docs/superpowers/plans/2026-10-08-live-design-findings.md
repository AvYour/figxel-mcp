# Live Design Findings — Backlog

Defects found by an agent designing real portfolio pages through the tools, one element per call, on 2026-10-08. Each entry says what happened on the canvas, why the code allowed it, and what the fix should be. Fixed entries keep their proof; open entries are the work queue.

Parent: [spec §12](../specs/2026-10-06-figma-mcp-design.md#12-roadmap) · previous log: [Phases 1–2](2026-10-07-phases-1-2-log.md).

## Open

| Item | Why open | Next step |
|---|---|---|
| FigJam and Slides | **Built** on 2026-10-09 (the user decided it; spec ADR #33): the manifest widened, 16 board and deck tools, about 25 tools extended, an editor table and gate — [plan record](2026-10-09-figjam-slides.md). No live run has happened, so the editor cells are unmeasured until the live runs record them: FigJam and Slides writes stay refused, reads run | The five spikes and the user steps in the plan record's [live runs](2026-10-09-figjam-slides.md#live-runs-still-to-do); flip cells and re-status claims only from `spikes/results/` |
| Four tool defects from the motion-ad build | Reported on 2026-10-09 while agents built a 197-track motion ad, not yet reproduced: multi-track `figma_set_keyframes` keeping only the last track without an error; `figma_move_nodes` with x and y moving only y; a move inside `figma_batch` reporting ok without moving; twin `45:` ids that read but cannot be written | Reproduce, test, fix — see [defects found while building the motion ad](2026-10-09-figjam-slides.md#defects-found-while-building-the-motion-ad). The keyframe defect comes first: it silently loses work |
| `download_assets` with export presets, live | Stalled once in the live run because the hub that forwarded it predates the op and gave it the 30 s read timeout instead of the export timeout; an identical re-run succeeded | Re-run `spikes/live-wpA-read.mjs` once the MCP client has restarted onto the current build (`figma_status` → `build.restart: "client"`) |

## Parity pass — the official Figma MCP's reach, 2026-10-08/09

A gap analysis against the official server — its tool list on 2026-10-08 `[C-087]` and every skill in its plugin — found 85 candidate gaps; adversarial verification kept 70 (22 P1, 26 P2, 22 P3). Six packages added 23 tools and extended about 30 (90 → 113 in the catalog), then six live spikes (`spikes/live-wp{A..F}-*.mjs`, about 350 steps) and a 12-agent review ran against the result.

### Found by the live spikes on the real canvas

| Finding | Cause | Fix and proof |
|---|---|---|
| `figma_create_vector` crashed with *"The node with id … does not exist"* | `createNodeFromSvg` returns a GROUP for an unsized `<svg>`, and Figma deletes the group when its vector moves out `[C-086]` | Remove the wrapper only if it still exists — `test/parity-tools.test.ts`, fake made to behave like the measured API |
| Boolean results came out grey | Figma paints every boolean `#D9D9D9` `[C-086]` | The lowest shape's paint is copied onto the result — same file |
| A TEXT property bound in one variant did nothing after a variant switch | Only the given layer was wired | Same-named layers in every variant are wired, a variant without one is reported — same file |
| A page scan stalled for 30 s, and every call behind it | A walk yielded every 200 nodes; in the background each timer yield costs about a second, and no progress was reported `[C-124]` | Yield by time (12 ms slices) and report progress at each yield — `test/walk-slicing.test.ts` |
| A 300 px wrapping row grew to 793 px on one line | Turning auto-layout on leaves the primary axis hugging, and a given width was never written as FIXED `[C-125]` | `test/live-fixes-2026-10-09.test.ts` |
| Every NOISE effect was refused | Figma's validator refuses `blendMode` on a noise although the typings declare it `[C-102]` | Not sent; a key-naming refusal is no longer blamed on an old build — `test/style-ops.test.ts` |
| A style's markdown description threw *"object is not extensible"* | A paint style has no `descriptionMarkdown` in this runtime `[C-111]` | Feature-detected, written as plain text with a note — `test/components.test.ts` |
| "/month" next to "$9" sat at the top of the price row, not on its baseline | `create_from_spec` stretched every text across its auto-layout parent; across a ROW that fills a hugging row's height | Stretch only across a column — `test/text-wrapping.test.ts`. Found by an end-to-end pricing page built through the session's own tools after the client restart |
| `check_layout` warned `fill_in_hug` on a heading that rendered fine | It warned on any FILL child of a hugging parent; a sibling that sizes the axis (a 1000 px row) makes the fill well-defined | Warn only when no in-flow sibling sizes that axis — `test/check-audit.test.ts` |

Measured along the way and recorded: CSS from `getCSSAsync` (500 nodes in 476 ms) `[C-091]`, dev resources in a design-mode plugin `[C-094]`, the CSS-angle gradient mapping against Figma's own SVG export `[C-100]`, variables bound to a text node's `fontSize` and `fontFamily` `[C-109]`, a property rename carrying its references `[C-113]`, the motion beta on this account plus MP4 / GIF / WEBM export `[C-115]` `[C-116]`, and fixed children being the last ones `[C-118]`.

### Found by the review (46 confirmed of 50; 9 major)

Fixed in six file-disjoint groups, each with a test that fails on the old code (827 → 941 tests): the export cap measured on what renders (a page, a rotated layer) `[C-126]`; `create_from_spec` reporting every node it made before a refusal, so a failure is never "safe to retry" with a stray node left; unknown nested keys refused instead of stripped by the MCP SDK; `figma_update_variable_collection` (mode removal) and `figma_reset_slot` flagged destructive and kept out of batches; fonts loaded before a variable value changes text; `figma_get_motion_context` reading a screen's layers by default; a write refused when a link names another file than the one open; trigger `timeout` / `delay` documented in milliseconds `[C-122]`; fixed layers refused on an instance `[C-123]`; variable and mode names checked against Figma's rules `[C-127]`; and the guides' wrong advice on style values, export folders and screenshot scale corrected.

## Fixed — live design session, 2026-10-08

### F-1 — `figma_check_layout` missed a painted layer covering text — **fixed**

**Seen on:** `v2 / 03 About`. The "Cursor chat" bubble (a frame with a solid `Theme/Blue` fill) sat on top of the "Place" text "Studio Kumo · Tokyo" (a fictional studio in the sample copy) in an Experience row and hid its first word. `check_layout` returned `ok: true`; the problem was only visible in the `figma_export_node` render.

**Why:** the overlap pass in `src/plugin/ops/check.ts` compared **text against text** only (rendered glyph bounds since the previous fix). The two texts involved did not overlap each other — the bubble's own message sat below the row's glyphs. What covered the text was the bubble's **fill**, a non-text layer, and no pass looked at that.

**Fix:** every visible painted non-text layer is now collected with its coverage — a fill covers its whole box, a stroke covers only the band its ink occupies, so a hollow outline is not mistaken for a solid one. A text is reported as `covered` (severity `error`) when a layer that is neither its ancestor nor painted below it intersects the text's glyph bounds by more than 2 px, and the layer is at least 60% opaque. The comparison runs as its own pass after the walk, because a text is always visited before the layer that covers it.

**Proof:** `test/open-findings.test.ts` — 6 cases (reported when above, silent when below, silent inside its own card, silent for a hollow selection outline, silent with no paint, silent for a 15% wash). The first case **fails against the old code**.

### F-2 — `figma_set_text` flattened mixed styling without saying so — **fixed**

**Seen on:** `v2 / 03 About`. Cloning `v2 / 02 Index` and calling `set_text` on its title ("IND" Michroma + "EX" Krona One) produced "ABOUT" entirely in Michroma; the intro lost its bold Krona One phrase. Both were restored by hand with `figma_set_text_range`.

**Why:** assigning `characters` on a whole node is Figma's own behaviour: the new text takes the style of the first character. The earlier fix made `set_text` **load** every font of a mixed node (so it no longer fails or forces Inter), but it cannot know where the old runs should land in new text, and it did not say anything was lost.

**Fix:** the node's styled segments are read before the write. When there was more than one distinct run, the result carries `flattened: { note, runs }` — the old segments with their text, font, size, and fill — so the caller sees exactly what it lost and can reapply it. No mapping from old runs to new text is guessed: a wrong guess would be worse than an honest report.

**Proof:** `test/open-findings.test.ts` — a mixed node returns both runs, a single-style node returns no `flattened`, and every font of a mixed node is still loaded. The first **fails against the old code**.

## Fixed — review of the F-1/F-2 fixes and the parity pass, 2026-10-08

| Finding | Fix | Proof |
|---|---|---|
| `figma_status` compared the plugin with the build id the server **started** with, so after a rebuild a current plugin read as stale and the advice "re-run the plugin" could never succeed `[C-084]` | `dist/build-id.json` is read at call time; `build.restart` says `"plugin"` or `"client"` | `test/parity-tools.test.ts` § figma_status |
| `covered` reported the size of the covering layer ("15600 px²"), not how much of the text it hid | the message gives the hidden area and its share of the text | same file § covered — fails on the old code |
| A layer cropped by a clipping parent was judged on its full box, so text beside a cropped photo read as covered | the cover is cut to every clipping ancestor first | same file § covered — fails on the old code |
| `flattened.runs` ignored text decoration, so a lost link underline went unreported | runs carry `decoration` | same file § set_text |
| The `spec` guide documented a `grow: true` field the builder has never read | removed; the guide describes `sizing: "fill"`, which is what the builder implements | `src/server/guides.ts` |
| The agent waited to be told each next element (rule: one element per call) | own the brief, one section per call, as the official skills do `[C-082]` `[C-085]`; 11 tools for shapes, boolean operations, masks, grids, variants and component properties `[C-083]` | `test/agent-guidance.test.ts`, `test/parity-tools.test.ts` |

## Fixed

Found by the same kind of live session earlier the same day; each fix has a unit test that failed on the old code (`test/live-findings.test.ts`).

| Finding | Fix |
|---|---|
| `clone_node` left the copy at the page root | the copy is inserted right after the source, or appended to `parentId` |
| `set_text` replaced a mixed-font text's fonts with Inter | every font of the node is loaded; none is forced |
| `figma_status` reported `build.plugin: null` | `hello` keeps `buildId` |
| `check_layout` flagged every path inside an icon for its default name | `Vector` / `Line` / `Polygon` / `Star` are no longer default-name findings |
| No way to remove a stroke | `set_strokes { remove: true }` |
| Text overlap judged on text boxes, not glyphs (false positives) | `absoluteRenderBounds` is used when present |
| Library styles were invisible, so new pages used raw values | `stylesUsed` carries `id` and `remote`; `apply_style_to_node` takes that id |
