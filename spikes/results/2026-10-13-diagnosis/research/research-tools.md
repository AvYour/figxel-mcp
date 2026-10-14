# Tools for a professional design and motion process: spec draft

Status: draft, 2026-10-13. Branch `feat/figjam-slides` (129 tools). Nothing in the repository was changed to write this.
Scope: the **tools** half of "carry a designer's and a motion designer's process inside figma-mcp". The guidance half (brief, concept directions, critique, delivered over MCP from `src/server/guides.ts`) is a separate spec. This one only says which measurements and scaffolds those guides can call on.

Sources used throughout, with short names:

| Short name | What it is |
|---|---|
| journal | `<session>/subagents/workflows/wf_c23489f2-d18/journal.jsonl`, one JSON line per agent of the 2026-10-09 run. Line numbers below are 0-based lines of that file: judge:ad 12, judge:craft 13, judge:build 18, render 34, critic design/motion/qa r1 38/39/40, r2 46/47/48, r3 54/55/56, finish 60 |
| run record | `scratchpad/motion/` of session <session>: `inventory.md` (critique of the earlier ad), `final-spec.md` (the build bible), `tool-findings.md` (figma-mcp defects seen), `r1-work/mc-live.json`, `r1-work/mc-after.json`, `r2-work/mc-final.json` (figma_get_motion_context of the ad before the r1 fixes, after them, and after the r2 fixes) |
| prototype | `scratchpad/skills/proto/audit-proto2.mjs` and `calibration.txt`: a throwaway implementation of nine motion-audit rules, run on the three snapshots above to set thresholds (section 4.3.4) |

Claim IDs `[C-0xx]` up to C-167 are the registry's own entries. **C-168 to C-192 are new and are proposed in section 11** (C-190 to C-192 are decisions); only the main agent edits the registry.

---

## 0. Summary

**What the run shows.** The 2026-10-09 run climbed from 6.5 to 8 because three critics measured frames: per-frame diffs, edge positions, values sampled from keyframes, read times. A single pass never does this. Almost every finding was one of a few kinds: a move that carries most of its travel in one frame, a state that is on screen for one frame, blur that is out of phase with speed, a stretch where nothing moves, a punch with a one-frame peak, text that is not readable long enough, a graphic crossing live text, and near-misses in static layout. The critics measured each one by hand with ffmpeg and throwaway scripts. These tools make those measurements available to any agent, in one call, with a fix in the finding.

**Decisions on the candidates:**

| Candidate | Decision | Why |
|---|---|---|
| Storyboard builder | **Keep:** `figma_create_storyboard` (create). Panels, captions, timing and the layout in one call; Design first, FigJam after a spike | The plan needs derived data (timecodes, frames, bar.beat), snapshots of styleframes and a machine-readable record that later tools read. A `create_from_spec` node type cannot carry any of that |
| Animatic (HOLD keys) | **Keep, split out and changed:** `figma_create_animatic` (create). It uses **cut pairs, not HOLD** | Different editor (motion and video are Design-only `[C-133]`), separate beta gate, and it can be re-run after caption edits. HOLD timing is contradicted between Figma's own sources `[C-177]`, while cut pairs were measured to switch on the exact frame `[C-174]` |
| Motion audit | **Keep:** `figma_check_motion` (read). 23 track rules (P1), 7 geometry-over-time rules (P2) | Different parameters (fps, bpm, thresholds), editors (Design only) and a time axis. Folding it into `figma_check_layout` would overload that schema. The output contract is shared, and the prototype grounds the thresholds |
| Review renders | **Keep:** `figma_review_video` (export group, answered by the server alone). Contact sheet, close-ups, frame-exact stills, per-frame metrics | The official path says frame extraction is free once the render is paid for `[C-173]`. A separate tool lets an agent mine one render many times without rendering again |
| Progress during export | **Keep as a heartbeat, but it is not the fix.** The fix is **job mode** on `figma_export_video`: `wait` / `jobId` / `cancel` | A client on the SDK defaults cancels at 60 s whatever progress arrives (`resetTimeoutOnProgress` is off by default) `[C-169]`. A tool-level job returns before the timeout on every client `[C-168]` |
| Craft audit (static AI tells) | **Merge** into `figma_check_layout` as `audit: ["craft"]` plus two parameters | Same walk, same node tree, same output. A new tool would duplicate the traversal |
| Snapshot of a node as an image fill | **Add as a parameter:** `figma_import_image { renderNodeId }` | Storyboard thumbnails, animatic plates and refreshing a panel all need "render this node, use it as a fill". It is one more source for an existing tool, not a new tool |
| Separate frame-grab, beat-check or storyboard-reader tools | **Cut** | They are covered by `review_video` stills, `check_motion` rule M16, and `create_animatic` / `check_motion` reading the storyboard record |
| Auto-fix tool | **Cut** | Fixes are keyframe edits. `check_motion` returns a ready `figma_set_keyframes` payload per finding (P2), and the agent applies it |
| MCP Tasks | **Defer (P3)** | The spec marks Tasks experimental `[C-172]`, and client support cannot be assumed. The job parameters work everywhere, and Tasks can wrap the same job store later |

**Count:** 129 → **133 tools in the catalog** (132 registered by default): +`create_storyboard`, +`create_animatic` (create), +`check_motion` (read), +`review_video` (export). Changed: `figma_export_video`, `figma_check_layout`, `figma_import_image`.

**Priority:** P0 prerequisite defect fixes (section 3) → P1 `export_video` job mode, `review_video`, `check_motion` track rules, `create_storyboard` on Design → P2 `create_animatic`, geometry rules, `craft` audit, `renderNodeId`, the FigJam storyboard → P3 MCP Tasks, a cross-file animatic, measured named easings in the evaluator.

---

## 1. What the 2026-10-09 run tells the tools

### 1.1 Finding classes and whether a tool could have caught them

Every critic finding in journal lines 38–40, 46–48 and 54–56 falls into one of these classes. "Tool" is where the class lands in this spec.

| Class | Examples (journal line, frame) | Measurable from | Tool |
|---|---|---|---|
| Snap / strobe close: a collapse or exit carries ≥ 40 % of its travel in its last visible frame | iris close 60–75 % on the last frame, ring trim 63 % then cut, loop 63 %, slit 53 % (40: f101–f106, f65, f334); words exit 108 of 158 px in one frame (48: f102–f104) | tracks | check_motion M01, M03 |
| Pop-in: a shape appears at most of its size in one frame | arrow shaft 0.75, head 0.83 (40: f350, f353); a dot from scale 0 to 90 % of its peak (39: f45) | tracks + size | M02 |
| Arrival not held: a match-cut state on screen one frame or none | the Ø 96 dot visible only on f108 (39 blocker, 40); S2's 2.6× key falls on f180, which is never shown (55) | tracks (+ z-order for "never shown") | M08 |
| Strobe without blur: large per-frame steps, no or little blur | edge 280 px in one frame with no blur (inventory §4); logo flight 70–110 px/frame, no blur (46); plate wipe 474 px with 14 px blur, bloom 402/458 px with 12 px blur (56) | tracks + size | M04 |
| Blur out of phase with speed | blur peaks at f170, fastest frame f171 has half of it (56); on the dive the blur rose ahead of the speed (39) | tracks | M05 |
| One-frame peak (a punch as a cusp) | "down." width 732, 754, 776, 755: the peak lasts one frame (55, 56) | tracks | M07 |
| Dead span | collection scene diff 0.08–0.12 over f230–f276; end card 0.03–0.04 over 26 + 25 frames (39); end-card drift 0.2 px/frame reads as a freeze (46); frozen 1.07 s (inventory §4) | tracks + size, and render | M09, review_video |
| Hits off the beat | punches peak 66 ms after the beat, so the beat frame shows no change (46); 5-frame empty plate across a downbeat (39) | tracks + bpm | M16 |
| Template feel | one entry move on 15 of 23 animated layers; whole lines with no stagger; staggers of 4.5 frames, off the grid (inventory §4) | tracks | M11, M12, M13 |
| Read time | 5 words in 0.5 s, list items dimmed to 0.35 (47); "By hand." 0.63 s, rushed (38); CTA readable 1.63 s (inventory §4) | tracks + text | M17 |
| Graphic crosses live text over time | ripple through "moku.store" (47, 48); dimension line through "$" (38); brand bug over headline (38, 40) | tracks + geometry | check_motion G01 (P2) |
| Invisible clip line slices letters | headline masks 76 px inside the photo (56) | geometry | G02 (P2) |
| Static near-misses | 56 vs 60 px type sizes (54); a column with no shared edge (38); tangencies of 2–15 px (38, 54); top-heavy block, centre 780 against 915 (38); "IO%" from old-style figures (38); '$ 4 8' glyph gaps (38) | node tree | check_layout `craft` |
| Contrast over a shape that is not an ancestor | terracotta on band grey 2.8:1 (47); terracotta V over terracotta plate (48) | node tree | `craft` C08 |
| Flash on a cut (tone and mass jump) | whole-frame mean RGB 178,174,164 → 242,236,226, 97.7 % of pixels change (55) | **render only** | review_video `flash` |
| Export length | 433 frames for a 14.4 s timeline (40, 48) | render | export_video `frameCount`, M19 |

Two classes can only be seen in the render: a flash on a cut, and anything that depends on what the picture contains (the photo's whites against linen, 38). That is why both a track audit and a render review exist. Each catches what the other cannot.

### 1.2 Measured facts the design rests on

- Figma samples frame k at exactly t = k / fps, and `cubic:` is CSS cubic-bezier: an edge's positions at frames 89–96 matched the curve to the pixel (journal 18) `[C-174]`. So a track can be evaluated exactly per frame, and cut pairs switch on frame k: the old value at `(k − 0.75)/fps`, the new value at `(k − 0.15)/fps`, both LINEAR. At 30 fps that is the run's `k/30 − 0.025` and `k/30 − 0.005` (final-spec §3.3). Written in frames, the pair stays inside the frame interval at 24 or 60 fps, where a fixed 0.025 s would reach back past frame k − 1 at 60 fps.
- A 14.4 s timeline at 30 fps exported 433 frames, f0–f432: the endpoint renders too `[C-175]`.
- ffmpeg `-ss` as an input option at (k + 0.5)/fps returns frame k + 1; at (k − 0.25)/fps it returns frame k (tool-findings) `[C-176]`. Today's `grabFrame` seeks at the exact second given, so a still can land one frame late.
- The client cancelled `figma_export_video` after about 60 s, which also cancelled the render. Renders of the ad took 28–47 s through a client with a long timeout, and one stalled for about 40 min while Figma was minimized `[C-170]`.
- `figma_set_keyframes` with several tracks in one call applied only the last one, and a call carrying `timelineDuration` once returned a foreign timeline id and dropped two of three tracks `[C-179]`. Writing keyframes also wrote the t = 0 OPACITY into the node's base opacity, so `figma_export_node` of a layer that starts hidden rendered 1 × 1 `[C-180]`.

---

## 2. Principles

1. **Tools measure and scaffold; guides decide.** No tool judges "good design". Each finding is a number with a threshold, and each threshold names the 2026-10-09 finding behind it `[C-190]`. A vision reading is not a measurement `[C-070]`. The render review returns numbers first and images second.
2. **Every client, every model.** No behaviour depends on a client feature: not resetting timeouts on progress, not MCP Tasks, not image rendering. A text-only model still gets every defect from the numbers, and images are extra.
3. **Portable schemas** (`test/schema-portability.test.ts`): no `anyOf` / `oneOf` / `allOf` / `const` / `format` / `$ref`. Every object has `properties`, so there are no free-form maps. A union travels as one string (`"x,y,width,height"`), and exclusivity ("exactly one of") is checked in code and refused with `INVALID_PARAM` naming the field. Nested objects are `.strict()`. Descriptions stay ≤ 1024 characters.
4. **Refuse before changing** (tools.md Conventions): the create tools check every panel, id and value before the first node exists. A failure that changed nothing carries `partial: { created: [] }`.
5. **Readback, not trust.** Because tracks were silently dropped `[C-179]`, any tool that writes keyframes reads them back in the same op and reports `verified` with the mismatches.
6. **Design first, other editors by measurement.** A new tool's cells start "unmeasured" and turn "yes" only from a recorded spike `[C-129]`.

---

## 3. P0: prerequisite fixes in existing tools

The new tools stand on these, so they come first. Each comes from tool-findings and has a failing test before the fix.

| Defect `[C-179]` | Fix | Test |
|---|---|---|
| `figma_set_keyframes`: several tracks in one call → only the last applied; the result echoed the old keys for the others | After each `applyManualKeyframeTrack`, read that field's binding back. If an earlier field changed, re-apply it, else write the merged `manualKeyframeTracks` object once. The result is built from a fresh read of every field sent, and any mismatch is `INVALID_PARAM` with `partial.applied` | a fake whose `applyManualKeyframeTrack` replaces the whole map (the observed behaviour) must still end with every track present |
| `figma_set_keyframes` with `timelineDuration` returned a foreign timeline id and dropped 2 of 3 tracks | Apply the tracks first, then the duration, then read every track back; take the timeline from `getTopLevelFrame().timelines` and refuse a timeline whose id is not the top-level frame's | fake that returns another frame's timeline on the first read |
| `figma_move_nodes` inside `figma_batch` → `ok: true`, nothing moved; given x and y, only y moved | Read the position back after the write, and report per item whether `x` and `y` match | fake where setting `x` then `y` on a constraint-bound node loses `x` |
| `figma_export_video` `frames` can land one frame late `[C-176]` | Grab a still at `(k − 0.25)/fps`, where k = round(t · fps), and report `frame` beside `t` | ffmpeg stub asserting the seek argument; live test in 4.1.6 |

---

## 4. Tool specs

### 4.1 `figma_export_video` (changed): job mode, heartbeat, frame-exact stills

#### 4.1.1 Problem

A render takes tens of seconds to minutes `[C-170]`, and the plugin renders one request at a time. An MCP client built on the TypeScript SDK times out a request at 60 s unless the caller raised it, and it resets that clock on progress only when the caller opted in `[C-169]`. The spec makes resetting optional and asks for a maximum timeout regardless `[C-168]`. On timeout, the client sends `notifications/cancelled`, which the server honours by cancelling the bridge job `[C-171]`, so the render is lost. Progress notifications alone cannot fix this for every client. A call that **returns before the timeout** and can be **re-attached** can.

#### 4.1.2 Parameters (new ones marked +)

| Param | Schema | Meaning |
|---|---|---|
| existing | — | `nodeId`, `format`, `fps`, `quality`, `loopCount`, `width` / `height` / `scale`, `saveTo`, `frames`, `session` are unchanged |
| + `wait` | integer 0–600, default 40 | Seconds to wait for the render in this call. If it is not done by then, the result is `status: "rendering"` with the `jobId`. 40 leaves margin under the SDK's 60 s default `[C-169]`; an agent whose client cuts calls sooner passes a lower value |
| + `jobId` | string 1–64, `[A-Za-z0-9._-]` (checked in code) | On a new render: an **agent-chosen** name, following the idempotency-key convention (choose your own for large ops), so a call cut off before it returned can still be re-attached. With nothing else: poll or collect that job. Omitted on a new render: the server generates one |
| + `cancel` | boolean | With `jobId`: drop that render and its result. The plugin is sent `cancel`, but Figma's `exportAsync` itself cannot be interrupted, so the plugin stays busy until it returns |
| + `frameIndices` | integer[] ≤ 12, each ≥ 0 | Frames to return as PNG, **frame-exact** `[C-176]`. `frames` (seconds) stays and is mapped to k = round(t · fps). The two together are refused |

Exclusivity (checked in code, refused with `INVALID_PARAM`): `jobId` + `cancel` takes no render settings. `jobId` alone with no job of that name and no `nodeId` is `INVALID_PARAM` ("no render named …; pass nodeId to start one"). A `nodeId` + `jobId` naming a job that already runs with **different** settings is refused. With the **same** settings, the call attaches to it.

#### 4.1.3 Behaviour

1. **Job store** (`src/server/video-jobs.ts`, in the server process that took the call, so it lives where the export roots and the MCP connection are). It is keyed by `jobId` and holds `{ settings, startedAt, state: rendering | done | failed | cancelled, promise, result? }`. At most 8 jobs are kept; finished ones expire 30 min after completion. **Dedupe:** a new call with the same `(session, exportedNodeId, settings, saveTo)` while one renders attaches to it instead of rendering twice.
2. **Starting and cancelling:** the bridge request is detached from the MCP call's `extra.signal`. A cancel of a waiting call (a user's stop, or a client's timeout, which sends the same notification `[C-168]`) ends **that call**: it stops waiting and sends no response, as the cancellation rules ask `[C-171]`. The render itself goes on, because Figma's `exportAsync` cannot be interrupted and the plugin stays busy until it returns either way. Dropping its result would only waste the render, so the result is kept for the TTL. A retry, with the agent's `jobId` or with the same settings (dedupe), collects it. Only `cancel: true` drops a job. This deliberately departs from the cancellation SHOULD-list's "free associated resources" for the job: the job is a resource the agent can name and re-attach to, separate from the request. Today's behaviour (cancel the bridge job and lose the render) is what made the 2026-10-09 renders fail `[C-170]`.
3. **Waiting:** `min(wait, remaining)` seconds, then one of:
   - done → the usual result (file written, frames extracted) plus `jobId`, `renderS`, `frameCount` (from `ffprobe -count_frames`, when available), `expectedFrames = round(duration · fps) + 1` `[C-175]`, and a `note` when they differ;
   - running → `{ status: "rendering", jobId, elapsedS, nodeId, exportedNodeId?, queuePosition?, hint }`. This is **not** an error (`isError: false`, `safeToRetry` is moot: the call only reads). The hint says to call `figma_export_video { jobId }` to collect it. After 2 min with no result it adds that renders stall while the Figma window is minimized `[C-170]`;
   - failed → the plugin's error as today (`UNSUPPORTED` with the existing hint).
4. **Heartbeat:** while a call waits, the server sends `notifications/progress` every 5 s to a caller that gave a `progressToken`, with `progress` = elapsed seconds (strictly increasing, `[C-029]`) and the message "rendering MP4: 35 s". It uses the existing `ProgressForwarder`, with a `heartbeatMs` option added to `forwardTool`. Clients that reset on progress `[C-168]` keep the call alive, and other clients are unaffected. A **plugin-side** heartbeat (`setInterval` during `exportAsync`, possible because the sandbox has timers `[C-012]`) would also keep the bridge's 600 s idle timer from firing on very long renders. Whether timers fire while `exportAsync` is pending is unmeasured `[C-188]`, so it is optional until the spike.
5. **Frame-exact stills:** `grabFrame(run, path, k, fps)` seeks at `max(0, (k − 0.25)/fps)` `[C-176]`. Each item in `frames` reports `{ frame, t, image | path | error }`.
6. **The plugin is busy while it renders.** Other Figma calls wait in the session queue. `figma_review_video` (server-only) runs meanwhile, and `figma_check_motion` waits like any plugin call. The description says this in one line.

#### 4.1.4 Description draft (≤ 1024 chars)

> Render the animation of a top-level frame to MP4, GIF or WEBM. This is the way to SEE motion, because figma_export_node shows only the resting state. Always writes a file. Waits up to `wait` seconds (default 40). A longer render returns `status: "rendering"` and a `jobId`, and figma_export_video { jobId } collects it, so no client timeout loses the render. Name your own `jobId` for long renders, so a call cut off early can be re-attached. `frameIndices` (or `frames`, in seconds) returns those frames as PNG, frame-exact, when ffmpeg is on PATH. `cancel` with `jobId` drops a render. The plugin renders one thing at a time, so other Figma calls wait until it ends. For contact sheets and per-frame metrics, call figma_review_video on the file. fps: MP4/WEBM 12|24|30|60, GIF 8|12|15|24|30. Needs keyframes; a still frame is refused. Editors: Design only.

#### 4.1.5 Plugin / server

Server only. The plugin op is unchanged, apart from the optional heartbeat after its spike.

#### 4.1.6 Tests

- `test/export-video-jobs.test.ts` with a fake bridge whose request resolves after a controlled delay (fake timers):
  - a render faster than `wait` returns the file;
  - a slower one returns `rendering` with a generated `jobId`, and the next call collects it;
  - an abort **while waiting** ends that call without a response but keeps the job: a retry with the agent-named `jobId`, or with the same settings and no `jobId`, collects the finished render, and no second render is requested;
  - `cancel: true` drops the job (the bridge sends `cancel`); different settings under one `jobId` are refused;
  - expiry after 30 min; the 8-job cap.
- Heartbeat: progress values strictly increase, nothing is sent after completion, and nothing goes to a caller without a token beyond the existing 5 s log.
- `frameIndices`: seek argument `(k − 0.25)/fps`; `frames` mapped to the nearest k; both together refused.
- `expectedFrames` against an ffprobe stub, and a `note` on a mismatch.
- Schema portability (existing test) passes with the new fields.
- Live (`spikes/live-review.mjs`, 4.2.6): a 1 s frame whose fill steps grey levels by frame; the stills of frames 0, 14, 15 and 29 return those exact levels.

---

### 4.2 `figma_review_video` (new, export group, server-only): see the motion

#### 4.2.1 Purpose

What the critics built by hand each round (r2-work/post.sh, r3-work/post.sh): a whole-piece contact sheet, every-frame close-ups of a window (where the spacing between frames is the speed graph, final-spec E.1), frame-exact stills, and per-frame difference numbers that locate freezes, pops and flashes. Once the render is paid for, mining it is free `[C-173]`. This tool does not touch Figma, so it runs while the plugin is busy and in any editor.

#### 4.2.2 Parameters

| Param | Schema | Default | Meaning |
|---|---|---|---|
| `path` | string, required | — | A video inside the export roots (same rules as `saveTo`); typically the `path` figma_export_video returned |
| `sheetEvery` | integer ≥ 1 | ceil(frames / 90) | One tile per this many frames, chosen by **frame index** (`select`), never by timestamp resampling |
| `sheetColumns` | integer 1–16 | 9 portrait, 6 landscape | |
| `tileWidth` | integer 64–480 | 180 portrait, 240 landscape | 180 is what the critics used |
| `labels` | boolean | true | Burn the frame number into each tile with `drawtext`. Skipped, with a `note`, when this ffmpeg has no `drawtext` or no font file is found `[C-183]`. The `tiles` map is returned either way |
| `closeups` | array ≤ 6 of `{ startFrame: int ≥ 0, frames?: int 2–48 (24), columns?: int 1–12 (8) }` | none | Every frame of a window, tiled: the speed graph |
| `stills` | integer[] ≤ 24 | none | Frame-exact full-size PNGs `[C-176]` |
| `metrics` | boolean | true | Per-frame analysis (4.2.3) |
| `regions` | array ≤ 8 of `{ name, x, y, width, height }` (video pixels) | none | The same metrics inside a box, for a handoff or a CTA (the region diffs the QA critic ran on each handoff, 48) |
| `cuts` | integer[] ≤ 64 | none | Frames where a cut is intended; a jump there is reported as `cut`, not as a defect |
| `stillWindows` | array ≤ 20 of `{ fromFrame, toFrame }` | none | Intended holds; not reported as freezes |
| `expectFrames` | integer | none | Compared with the counted frames (e.g. `round(duration · fps) + 1` `[C-175]`) |
| `thresholds` | object `{ freeze?, minFreezeS?, flicker?, flashLuma?, spike? }` | 0.15, 0.5, 1.0, 40, 20 | See 4.2.3 |
| `maxImages` | integer 0–8 | 4 | Images returned inline. Everything is also written to `saveDir` |
| `saveDir` | string | the video's folder | Same path rules as `figma_download_assets` `dir` |
| `session` | — | — | Not taken: no Figma file is involved |

#### 4.2.3 Metrics (pure TypeScript over one decode pass)

One `ffmpeg -v error -i <path> -vf scale=270:-2:flags=area,format=gray -f rawvideo -pix_fmt gray -` stream (spawned with an argument array, no shell), read frame by frame, keeping three frames in memory. 270 px grey is the scale the critics' numbers were measured at (39 states that scale), so the defaults transfer `[C-192]`.

| Metric | Definition | Default flag | Evidence for the default |
|---|---|---|---|
| `diff[k]` | mean \|Y_k − Y_{k−1}\| (0–255) | — | The run's own scale: cut 60.9 / 68, a wipe 26.1, the designed breath 0.22, dead spans 0.03–0.12 (39, 40, 55, 56) `[C-192]` |
| `changed[k]` | share of pixels with \|ΔY\| > 8 | — | The measure the r3 critic used (55) |
| `luma[k]` | mean Y | `flash` when \|Δluma\| ≥ 40 and `changed` ≥ 0.9 on a frame not in `cuts` | The push-through flash measured a 59/255 jump with 97.7 % of pixels changed (55) |
| freeze | a run of `diff < freeze` frames lasting ≥ `minFreezeS`, outside `stillWindows` | 0.15 for ≥ 0.5 s | Dead spans read 0.03–0.12 while the designed breath read 0.22 (39); the build bible allowed no freeze longer than 0.5 s (final-spec E.1) |
| flicker | frame k with `diff[k]` and `diff[k+1]` ≥ `flicker`, and `skip[k]` = mean \|Y_{k+1} − Y_{k−1}\| ≤ 0.35 · min of the two | 1.0 | The punch frame differed from both neighbours by about 1.55 while its neighbours differed from each other by 0.18 (56) |
| spike | `diff ≥ spike` and `changed < 0.9` on a frame not in `cuts` | 20 | The white flash of the iris close at 27.5 and the plate wipe at 26.1 were both defects (40, 56) |
| `frames`, `fps`, `durationS` | `ffprobe -count_frames` | `frameCount` note when ≠ `expectFrames` | 433 against 432 (40, 48) `[C-175]` |

Images: the sheet uses `select='not(mod(n-S\,E))'`, `scale=W:-1`, `tile=CxR` (`tile` takes a layout, padding and margin `[C-183]`). Close-ups select `between(n\,k0\,k1)`. Stills seek at `(k − 0.25)/fps`. Every image is written as a file, and the first `maxImages` are also returned as image blocks no larger than `INLINE_LIMIT` (5 MB, export.ts). A larger sheet is written but not inlined.

#### 4.2.4 Result

```jsonc
{
  "path": "…/ad-r2.mp4",
  "video": { "width": 1080, "height": 1920, "fps": 30, "frames": 433, "durationS": 14.433 },
  "frameCountNote": "433 frames; expected 433.",
  "sheet": { "path": "…/ad-r2-sheet.png", "image": 1, "every": 5, "columns": 9,
             "tiles": [{ "index": 0, "row": 0, "col": 0, "frame": 0, "t": 0 }, …], "labels": true },
  "closeups": [{ "path": "…", "image": 2, "frames": [105, 128] }],
  "stills": [{ "frame": 108, "path": "…", "image": 3 }],
  "metrics": {
    "analysisWidth": 270,
    "diff": [0.0, 4.93, 4.52, …],              // one number per frame, 2 decimals
    "summary": { "mean": 3.1, "p95": 18.4, "max": 60.9, "maxFrame": 180 },
    "freezes": [{ "from": 373, "to": 396, "s": 0.8, "meanDiff": 0.04 }],
    "flickers": [{ "frame": 36, "diff": 1.55, "skip": 0.18 }],
    "flashes": [{ "frame": 180, "lumaJump": 59, "changed": 0.977 }],
    "spikes": [{ "frame": 104, "diff": 27.5, "changed": 0.31 }],
    "cuts": [{ "frame": 216, "diff": 5.0, "declared": true }],
    "regions": [{ "name": "dot", "diff": […], "spikes": […] }]
  },
  "findings": [{ "kind": "flash", "severity": "warning", "frames": [179, 180],
                 "detail": "whole-frame luma jumps 59/255 and 98 % of pixels change on a frame not declared as a cut — reads as a blink; carry picture mass across the cut" }],
  "note": "drawtext unavailable: tiles are unlabelled; see sheet.tiles for frame numbers."
}
```

Images go in `content` after the JSON text block. There is no `structuredContent`, for the same reason as `shapeVideo`: a client that prefers structured content would drop the images.

#### 4.2.5 Errors

- No `ffmpeg` / `ffprobe` on PATH → `UNSUPPORTED`, with a hint to install ffmpeg, plus that `figma_check_motion` works without it.
- A path outside the roots → `INVALID_PARAM` before anything runs.
- A file that is not a video → `INVALID_PARAM` with ffprobe's message.
- `labels` with no `drawtext` → a note, not an error.

#### 4.2.6 Tests

- `test/video-metrics.test.ts` (pure): synthetic grey frames (`Uint8Array`) build a freeze (identical frames for 20 frames), a single-frame flicker, a flash (+60 luma, every pixel), a declared cut (not reported), a spike below the flash share, and a region diff. Each is asserted exactly, including the `stillWindows` exemption and the `skip` ratio.
- `test/review-video.test.ts`: a spawn stub checks argument arrays (paths with spaces and quotes, no shell), `select` expressions, the `(k − 0.25)/fps` seeks, ffprobe parsing, a missing ffmpeg → `UNSUPPORTED`, a missing drawtext → note, inline limit handling, and `maxImages`.
- Integration (runs when ffmpeg is present, skipped otherwise): generate a 30 fps, 2 s test clip with `nullsrc` + `geq` so frame n has luma 4n, with frames 20–39 frozen and frame 45 flashed white. Then assert the stills' mean luma equals 4k ± 2 for k = 0, 14, 15, 59 (frame-exactness), the freeze 20–39, the flash at 45, and `frames = 60`.
- Live: `spikes/live-review.mjs` renders a small animated frame through figma_export_video in job mode and reviews it; the result goes to `spikes/results/`.

---

### 4.3 `figma_check_motion` (new, read): a motion designer's frame-by-frame look, as data

#### 4.3.1 Purpose and shape

The motion counterpart of `figma_check_layout`, with the same output contract (`ok`, `counts`, `issues` with node, numbers and a fix, `minSeverity`, `limit`, `more`). It evaluates every keyframe track **per frame** (exact for `cubic:` and LINEAR `[C-174]`) and judges the result against rules that each name the 2026-10-09 finding they come from. It reads only. It works without ffmpeg and without rendering, so an agent can check after every keyframe pass and render only when the audit is clean.

#### 4.3.2 Parameters

| Param | Schema | Default | Meaning |
|---|---|---|---|
| `nodeId` | string | the selection's top-level frame | Any layer inside an animated top-level frame; the whole frame is audited. If nothing is selected and the page has several animated top-level frames, `INVALID_PARAM` lists them |
| `fps` | integer 1–60 | 30 | The render rate to judge at; it should match the planned export |
| `from`, `to` | number ≥ 0 (s) | whole timeline | Window |
| `bpm` | number 30–300 | none | Turns on M16 |
| `beatOffset` | number ≥ 0 (s) | 0 | Time of the first downbeat |
| `beatsPerBar` | integer 1–12 | 4 | |
| `rules` | enum[] ≤ 40 (the IDs below, e.g. `"vanish_mid_move"`) | all P1 rules | Only these |
| `minSeverity` | `error` / `warning` / `info` | `info` | |
| `limit` | integer 1–500 | 100 | |
| `maxNodes` | integer 1–5000 | 2000 | Layers read |
| `thresholds` | object, every field optional: `stepShare` (0.4), `stepPx` (24), `strobeInfoPx` (60), `strobeWarnPx` (150), `strobeAnyBlurPx` (400), `blurCap` (20), `aliveSpeedPx` (1), `deadSpanS` (0.5), `minHoldFrames` (3), `readSecondsPerWord` (0.3), `beatToleranceFrames` (1), `oneCurveShare` (0.7), `templateParents` (3), `templateShare` (0.4) | listed | Each default's evidence is in 4.3.3 |
| `stillWindows` | array ≤ 20 of `{ from, to }` (s) | none | Intended holds, exempt from M09 (the "breath", final-spec §2) |
| `brandId`, `ctaId` | string | none | Turn on M22 |
| `brandBy`, `ctaMinS` | number (s) | 2, 2.5 | Brief-level defaults `[C-191]` |
| `safeArea` | string `"x,y,width,height"` (frame pixels) | none | Turns on G04 (P2) |
| `matchCuts` | array ≤ 20 of `{ from: nodeId, to: nodeId, frame: int }` | none | Turns on G06 (P2) |
| `storyboardId` | string | none | P3: compare the plan's panel timing with when each scene container is visible |
| `includeActivity` | boolean | false | Adds the per-frame activity series (max on-screen px/frame) |
| `session` | — | — | |

#### 4.3.3 Rules

Severity, default threshold, and the finding that justifies it. "Calib." gives what the prototype returned on the three snapshots (section 4.3.4). Track rules (M) are P1, except where marked. Geometry rules (G) need composed boxes per frame and are P2.

Snapshot labels in the Calib. column: **r0** is the state the round-1 critics reviewed (`r1-work/mc-live.json`), **r1** the state after the round-1 fixes, which the round-2 critics reviewed (`r1-work/mc-after.json`), **r2** the state after the round-2 fixes, which the round-3 critics reviewed (`r2-work/mc-final.json`). No snapshot exists after the round-3 fixes.

Shared definitions:

- *Visible extent* of a layer at frame k is the product of:
  - its own and its ancestors' opacity;
  - its size fraction: \|scale\|, or WIDTH / HEIGHT over the base size;
  - its trim length: `PATH_TRIM_END − PATH_TRIM_START`.
- *Own cause*: the change comes from the layer's own tracks, while every ancestor's opacity is unchanged across the two frames. A scene container's cut is a scene cut, not a defect of each child.
- *Step* is per-frame displacement in px:
  - translation directly;
  - size and scale changes converted with the node's base size from the snapshot, using its farthest edge from the pivot (the node centre, `MOTION_LIMITS`).
- *Blur* is the node's own or an ancestor's `effect:i:RADIUS` value at that frame.

| ID | Name | Sev. | Rule (default) | Evidence | Calib. |
|---|---|---|---|---|---|
| M01 | `vanish_mid_move` | warning | Visible extent drops from ≥ 0.4 to ≤ 0.02 in one frame, own cause, blur < 6. A drop from full extent at rest is `cut_at_rest` (info): stop-motion swaps and covered cuts are deliberate (final-spec §3.3, D.4) | iris close 60–75 % then gone; ring trim 63 % then cut; loop 63 % (40) | r0: Ring path f101, Cream band f105, Clay band f106, Loop path f335: the three round-1 QA findings about closes that pop (iris close, ring, loop). r1: none. r2: none |
| M02 | `pop_in` | warning | Extent from ≤ 0.02 to ≥ 0.6 in one frame through own size / scale / trim tracks, with the jump ≥ `stepPx`, blur < 6 | arrow shaft 0.75, head 0.83 (40); a dot appearing at 90 % of its peak (39) | r0: Arrow shaft f350, Arrow head f353 (confirmed), plus two dimension ticks and the list pointer, which are small shapes the `stepPx` floor is meant to drop once base sizes are read (not yet verified). r1: the arrow findings are gone |
| M03 | `concentrated_step` | warning | One frame carries ≥ `stepShare` of a ≥ 4-frame segment's travel, the layer is visible in both frames, step ≥ `stepPx`, blur < 6. Excluded: the first frame of a TRANSLATION arrival into rest whose parent clips (a mask entry, whose big first step is hidden) | slit 53 % (40); words exit 68 % (48); plate wipe 48 % (56) | r0: Hands f104 75 % (424 px), By f102 69 % (108 px), Wheel f108 49 % (all confirmed). r1: Hands gone, "hand." f104 remains (named by the round-2 QA) |
| M04 | `strobe` | info / warning | info: step ≥ `strobeInfoPx` with blur < 2. warning: step ≥ `strobeWarnPx` with blur < 2, or step ≥ `strobeAnyBlurPx` with any blur, since a Gaussian blur capped at 20 cannot cover a 400 px jump | 280 px edge with no blur (inventory §4); logo flight 70–110 px/frame with no blur (46); 474 px with 14 px blur and 402/458 px with 12 px blur both strobed (56); build judge's 150 px/frame rule (18). Moves the critics accepted (a 186 px drop with blur 10, a 331 px collapse with blur 12) stay quiet | needs base sizes: not in the snapshots. Planned check: run on the live file |
| M05 | `blur_off_speed` | warning | For a segment whose fastest visible frame is ≥ 30 px, the blur on that frame is < 50 % of the blur peak within ± 6 **visible** frames, or the blur peak is ≥ 2 frames away from the speed peak | blur peak f170 against the fastest frame f171 (56); the blur leads the motion (39) | r2: Ash, Vase/V, a, s, e (f172–f176): the round-3 QA finding. Also flags Wheel f105 in r1 and r2, which no critic named (open; 4.3.4) |
| M06 | `blur_over_cap` | info | Blur > `blurCap` | the build judge's cap of 20 (18; final-spec App. B) | none in any snapshot (the run kept the cap) |
| M07 | `one_frame_extreme` | warning | A SCALE / size / translation track reverses direction with the extreme held for exactly 1 frame and the two adjacent steps within 2× of each other (a cusp) | punch widths 732, 754, 776, 755 (55, 56); peak lands 66 ms late (46) | r0, r1, r2: Down f36–38, Ten f306–308. Named by the round-2 and round-3 critics; present in every snapshot (the round-3 fix came after the last one) |
| M08 | `arrival_not_held` | warning | A segment arrives with ≥ 25 % of its travel in its last frame, and the arrived state stays on screen < `minHoldFrames` (it reverses, changes again or is cut) | the match-cut dot on screen 1 frame; fix: land 3 frames early and hold (39, 40) | r0: Wheel f108 (the r1 blocker). r1: gone (dot held 4 frames). r0, r1, r2: S2/Content f180, where the round-3 motion critic found the 2.6× key is never shown (55) |
| M09 | `dead_span` | warning | No visible layer moves faster than `aliveSpeedPx` per frame (scale converted by size) for ≥ `deadSpanS`, outside `stillWindows` | collection scene judged effectively dead at drifts of 0.13–0.5 px/frame (39); an end-card drift of about 0.2 px/frame read as a freeze (46); E.1's 0.5 s rule | r0: f373–f396 (0.80 s) at an absolute 0.3 px floor; that is the round-1 motion finding. With `aliveSpeedPx` 1 the r1 / r2 end card would stay flagged: a 1.035 scale over 2.87 s at 540 px half-width is 0.22 px/frame, matching the round-2 critic (computed by hand, not yet run) |
| M10 | `cold_open` | warning | Frame 0 shows only the background (every layer at extent ≤ 0.02), or nothing moves in the first 3 frames | a blank first frame followed by 0.3 s of stillness (inventory §4); every judge scored frame-0 motion (12, 13) | the run opens moving: none |
| M11 | `template_move` | info | One entry signature (field set, direction, duration ± 1 frame, easing) on layers under ≥ `templateParents` different parents, or on ≥ `templateShare` of animated layers. Siblings in one parent are a stagger, not a template | fade + slide on 15 of 23 layers (inventory §4); the craft judge named a three-panel rise as the most template-like move (13) | r0–r2: one group, Spec 1, Spec 2, Price 3 and URL (−40 px, 10 frames, expo-out) across 3 scenes. Stagger groups are excluded |
| M12 | `no_stagger` | info | ≥ 3 siblings start the same field's move on the same frame with the same duration and easing; also `stagger_off_grid`: offsets that are not whole frames | a title rising as one block; 0.15 s = 4.5-frame offsets (inventory §4); 2-frame stagger groups (final-spec App. B) | none (the run staggered by 2 frames) |
| M13 | `unrendered_extreme` | warning | A local-extremum key ≥ 0.25 frame off the grid, or on a frame where the layer is hidden. `off_grid` (info) counts other off-grid keys; cut pairs (two LINEAR keys < 1 frame apart) are exempt `[C-174]` | keys on half frames (inventory §4); the 2.6× key on a hidden frame (55) | 0 off-grid keys in all three: the run used whole frames and cut pairs |
| M14 | `easing_census` | info | Reports per-easing counts. Flags: one curve on ≥ `oneCurveShare` of moving segments; LINEAR on an entry or exit ≥ 4 frames and ≥ 24 px (mechanical); `_BACK` / BOUNCY / spring overshoot on ≥ 2 layers (stock overshoot); named presets present (evaluated approximately `[C-178]`) | the same arrival and exit pair on every layer, and two stock spring pops (inventory §4); hand-keyed accents instead of stock back-ease (App. B) | the run used cubics only |
| M15 | `hold_easing` | info | HOLD is used: which side of the segment the jump lands on is contradicted between sources `[C-177]`. Use a cut pair | — | none |
| M16 | `beat_offset` | info / warning | With `bpm`, accent events (extremes of SCALE punches, arrivals of the largest moving layers, scene-container cuts) whose landing frame is more than `beatToleranceFrames` from the nearest beat or eighth are listed (info). warning: a punch whose first change is on the beat frame, so the beat frame shows nothing and the peak lands ≥ 2 frames late. Also reports scene lengths and whether all are equal | punches peak 66 ms late (46); a 5-frame empty plate across the 9.6 downbeat (39); hits on no common interval and flat 2.9 s scenes (inventory §4) | to implement; the run's 100 BPM grid (final-spec §2) is the fixture |
| M17 | `read_time` | warning | A text is fully readable (opacity of self and ancestors ≥ 0.95, no self or ancestor moving ≥ 2 px/frame, blur < 1, extent ≥ 0.98) for less than words × `readSecondsPerWord`. Text held at opacity ≤ 0.5 counts as unreadable (`dimmed_text`). Covered-by-another-layer is P2 (needs G-geometry) | the 0.3 s/word floor (final-spec App. A); list at 0.1 s/word and dimmed to 0.35 (47); CTA 1.63 s (inventory §4) | needs the text characters (the plugin snapshot has them) |
| M18 | `rest_state_hidden` | info | The base opacity or scale is 0 (written by a t = 0 key `[C-180]`), so figma_export_node renders nothing. Check it with video frames, or rest it visible and hide it with keys | the 1 × 1 exports (tool-findings; final-spec §3.4) | — |
| M19 | `timeline_end` | info | Keys after the timeline end never play. Reports `expectedFrames = round(duration · fps) + 1` `[C-175]` | 433 frames (40, 48) | — |
| M20 | `unmeasured_transform` | info | TRANSLATION / ROTATION on a child of an auto-layout parent, or STACK_SPACING on a hugging row: behaviour not yet measured `[C-187]` | the build judge's risks (18) | — |
| M21 | `roundcap_zero_trim` | warning | A round-capped stroke whose trim length is 0 while its extent is visible leaves a stray dot | stray cap dots at zero trim length (18); opacity guards (final-spec §3.10) | — |
| M22 | `brand_late` / `cta_short` | warning | With `brandId`: first fully visible after `brandBy`. With `ctaId`: readable for less than `ctaMinS` | brand at 9.1 s and CTA 1.63 s (inventory §4); brand salience (12) | — |
| M23 | `first_key_late` | warning | A track whose first key is after t = 0 and whose value differs from the node's base value: what shows before the first key is undocumented `[C-182]`. Add a key at t = 0 | the run keyed every track at t = 0 (final-spec §3.11) | — |
| G01 | `crosses_text` (P2) | warning | A moving non-text layer's box intersects a text's glyph box (not an ancestor) on any frame where both have opacity ≥ 0.3; same-colour crossings are named | ripple through the URL (47, 48); dimension line through "$" (38); bug over headline (38, 40); terracotta V over terracotta plate (48) | needs geometry |
| G02 | `clip_slices_content` (P2) | warning | A clipping frame's edge passes through another painted layer's interior while text inside the clip moves across that edge | headline masks 76 px into the photo (56) | |
| G03 | `tangent_over_time` (P2) | info | Two edges within the C03 band for ≥ 0.5 s | headline baseline tangent to the band edge (54) | |
| G04 | `safe_area` (P2) | warning | Text leaves `safeArea` on any frame | drift carries type 17 px outside the margin (47); safe zones (final-spec §3.13) | |
| G05 | `revealed_edge` (P2) | warning | A full-bleed layer's per-frame box stops covering the frame, revealing the background | cream slivers during the 0.965 pull-back (47, 48) | |
| G06 | `handoff_mismatch` (P2) | warning | At each `matchCuts` frame, `from`'s last state and `to`'s first differ in centre > 2 px or size > 4 % | the dot 84 → 96 px on f108, +14 % (46, 48) | |
| G07 | `clamped_morph` (P2) | info | WIDTH and HEIGHT on different curves or durations with CORNER_RADIUS ≥ min/2: a stadium, not a circle | band burst renders as a stadium (56) | |

**Fix text.** Each finding names the change in the tool's own terms. For M01, M03 and M05 (P1) the engine **tries** a replacement and reports the recomputed number:

- M01, M03: re-evaluate with SOFT `cubic:0.45,0,0.55,1` and DRAW `cubic:0.65,0,0.35,1`, then name the one that brings the last visible extent ≤ 0.1. The round-1 QA's own fix gave 5–7 % (40).
- M05: compute the blur keys whose peak lands on the fastest frame.

In P2, each finding also carries `suggest: { nodeId, tracks }`, a payload `figma_set_keyframes` accepts as-is, verified by re-running the rule on it.

#### 4.3.4 Calibration (prototype, 2026-10-13)

`scratchpad/skills/proto/audit-proto2.mjs` evaluates the cubic and LINEAR tracks of the three run snapshots at 30 fps, with scene membership by name prefix, since the snapshots have no parent ids. `calibration.txt` holds the full output. What it established:

- Every round-1 QA finding about snapping closes and pop-ins (M01, M02), and the round-1 blocker (M08), **fires on r0 and goes quiet after the critics' own fixes**. So the thresholds separate the defect from its fix on real data.
- M07 already fires on r0, although the critics only named the punch cusp in round 2. M05 fires on the state the round-2 fix created (the headline's new blurred exit), before that state was rendered; the critics found it a round later.
- False positives in the prototype all trace to missing data the plugin snapshot will carry:
  - deliberate cuts at rest → the M01 / M02 severity split;
  - tiny shapes → the `stepPx` floor needs base sizes;
  - mask entries → the M03 exclusion needs `clipsContent`;
  - blur peaks on hidden frames → "visible frames" in M05.
- Open: M05 flags S1/Wheel at f105 in r1 and r2. The round-1 QA's fix had moved that blur to mid-move on purpose, and no critic objected. So either M05 is too strict for an accelerating collapse into a dot, or this is a real defect nobody looked at. The live calibration (4.3.7) settles it with the render.

#### 4.3.5 Plugin / server split

- **Plugin op `check_motion` (read).** It collects a snapshot and judges nothing:
  - the root top-level frame, its timeline duration, and up to `maxNodes` descendants;
  - per node: `id`, `name`, `type`, `parentId`, the base box (`x`, `y`, `width`, `height`, `rotation`, `absoluteBoundingBox`);
  - per node: base `opacity`, `visible`, `clipsContent`, `isMask`, the parent's `layoutMode` and the node's `layoutPositioning`;
  - for a stroke: `strokeCap` and `strokeWeight`;
  - for text: `characters` (the length and word count are what is used), `fontSize`, `absoluteRenderBounds`;
  - `effects` (type, radius);
  - the tracks through the existing `manualTracksToText`, plus each binding's base value where the API exposes it `[C-181]`, and `animationStyles` presence (not evaluable; listed in `limits`).
  - It is read through the guard in `board-read.ts`, like check_layout. A Motion-gated account → `UNSUPPORTED` with the existing hint `[C-115]`.
- **Server `shape`:** `src/server/motion-audit.ts` (pure TypeScript) runs the rules and shapes the result. The curve evaluator, cut-pair detection and frame sampling live in `src/shared/motion-curves.ts` (no dependencies), shared with `create_animatic`, which must produce cut pairs the audit recognises.
- **Why the judging happens on the server:** the rules are pure functions over a snapshot, so they are tested in Node against recorded fixtures without plugin fakes. The snapshot for a 98-layer frame is about 75 KB (the motion-context fixtures are 66–75 KB) and goes over the existing chunked transport.

#### 4.3.6 Result

```jsonc
{
  "root": { "id": "42:15039", "name": "…", "durationS": 14.4 },
  "fps": 30, "frames": 433, "checked": { "layers": 98, "tracks": 197, "keys": 778 },
  "ok": false, "counts": { "error": 0, "warning": 9, "info": 6 },
  "issues": [{
    "rule": "vanish_mid_move", "severity": "warning",
    "nodeId": "42:15863", "name": "S1/Ring path", "field": "PATH_TRIM_START",
    "frame": 101, "t": 3.3667, "frames": [100, 101],
    "detail": "visible extent 0.63 on f100, gone on f101: the ring pops off instead of closing",
    "fix": "Change the easing of the key at 3.3667 from cubic:0.7,0,0.84,0 to cubic:0.65,0,0.35,1: the last visible frame then shows 0.04."
  }],
  "census": { "easings": { "LINEAR": 452, "cubic:0.16,1,0.3,1": 77 }, "offGrid": 0, "cutPairs": 36, "curveUnknown": [] },
  "beats": { "bpm": 100, "hits": [{ "frame": 38, "nearestBeat": 36, "offsetFrames": 2, "nodeId": "…" }] },
  "limits": ["named easings are approximated [C-178]", "covered-by-other-layer is not computed (P2)", "loop mode not exposed"]
}
```

#### 4.3.7 Tests

- `test/motion-curves.test.ts`:
  - cubic evaluation against CSS reference values;
  - the sampling convention (frame k at k / fps `[C-174]`);
  - holding the first and last key values (`[C-182]`: the test pins the assumption and the spike confirms it);
  - cut-pair detection.
- `test/motion-audit.test.ts`, one test per rule on a minimal synthetic snapshot. Each test has a positive case, a negative case, the boundary of its threshold, and the exemption it documents (a scene cut, a mask entry, `stillWindows`, siblings in a stagger).
- `test/motion-audit-fixtures.test.ts`: the three run snapshots, committed to `test/fixtures/motion-2026-10-09/` with parent ids and base sizes added once by a live read of the same file. It asserts the calibration table: the finding set on r0, r1 and r2 per rule. This is the regression net: a threshold change that loses a confirmed finding fails.
- Plugin op with fakes: snapshot shape, `maxNodes` truncation, a Motion-gated account → `UNSUPPORTED`, a selection inside a frame resolves to its top-level frame.
- Editor gate: FigJam and Slides "no" (same reason as `get_motion_context`, `[C-133]`).
- Live: `spikes/live-check-motion.mjs` reads the run's ad (if it is still in the file), or a built probe with one example per rule. Then it renders the probe and checks each flagged frame with `figma_review_video` region metrics. This is where M04's px thresholds and the M05 open case are confirmed.

#### 4.3.8 Description draft

> A motion designer's frame-by-frame check of an animated top-level frame, as data. Every keyframe track is evaluated per frame at `fps` (exact for cubic and LINEAR easings). Each issue has the node, field, frame, the numbers and a fix:
> - layers that pop in, or vanish while still mid-move;
> - one frame carrying most of a move, and fast moves without blur;
> - blur out of phase with speed, and one-frame peaks;
> - arrivals that are never held, and stretches where nothing moves;
> - template-like repeated moves and missing staggers;
> - keys between frames, beat offsets (`bpm`), and text not readable long enough;
> - hidden rest states.
>
> Reads only; no render needed. Run it after every keyframe pass, before figma_export_video, then confirm with figma_review_video. `ok: true` means no errors or warnings. Motion is a Figma beta: UNSUPPORTED means this account does not have it. Editors: Design only.

---

### 4.4 `figma_check_layout` (changed): `audit: ["craft"]`

#### 4.4.1 Purpose

Static near-misses a design critic measures and that an AI-built frame typically leaves behind. They are added to the existing walk as an audit kind, so they run only when asked. Each rule is grounded in a 2026-10-09 design-critic finding. A rule without such grounding is listed as a candidate, not shipped.

#### 4.4.2 New parameters

- `audit` gains `"craft"`.
- `safeArea?`: string `"x,y,width,height"` in the root's coordinates.
- `minTextSize?`: number (px).

No preset safe zones: published Instagram Story safe zones disagree `[C-185]`, so the brief supplies them.

#### 4.4.3 Rules

| ID | Kind | Sev. | Rule | Evidence |
|---|---|---|---|---|
| C01 | `near_size` | info | Two text sizes in the same root, same family and colour, differing by less than 12 % (e.g. 56 and 60) | 56 against 60 px judged a mistake rather than a hierarchy (54) |
| C02 | `no_shared_edge` | info / warning | Vertically stacked text blocks that overlap ≥ 50 % horizontally but share no left, right or centre edge within 2 px. warning when the nearest edge is 1–6 px off (looks like an error) | price, specs and "32 cm" share no column edge; "Wood-fired" 31 px off "Hand-thrown" (38) |
| C03 | `tangent` | info | Two painted layers (render bounds, not ancestor and child) with a gap or overlap within max(8 px, 2 % of the larger side) | rim 7 px under the arch; plate rims 2–4 px from both sides (54); a letter nicking a window by 15 px (38); a descender 9–23 px over a ring (47) |
| C04 | `glyph_gaps` | warning | Sibling single-character TEXT nodes on one baseline with gaps > 0.15 em | "$48" with 40–50 px gaps at 220 px reads "$ 4 8" (38) |
| C05 | `oldstyle_figures` | warning | A TEXT of digits 0–2 only whose render height is < 0.55 × `fontSize`: the figures sit at x-height and read as letters | the "1" rendered 154 px tall at 400 px, so "10%" read "IO%" (38) |
| C06 | `unbalanced_space` | info | The content block's vertical centre is off the frame's (or `safeArea`'s) centre by > 6 % of the height, and the larger empty band is > 20 % | centre 780 against 915 with 435 px empty below (38) |
| C07 | `safe_area` | warning | With `safeArea`: text, or a layer named like a logo or CTA, outside it | safe zones (final-spec §3.13); bug 12 px under the app header (12) |
| C08 | `low_contrast_over_shape` | warning | Text whose glyph box lies on a solid-filled layer **painted below it in another branch** (not an ancestor, which `low_contrast` already covers), with contrast below the WCAG minimum `[C-075]` | terracotta on band grey 2.8:1 (47); terracotta V over a terracotta plate (48) |
| C09 | `min_text` | warning | With `minTextSize`: text smaller than it | a 22 px label judged unreadable on a phone (12); no Inter text under 28 px (final-spec §3.13) |
| C10 | `equal_tiles` (candidate, P3) | info | ≥ 3 identical sibling cards in a row inside a portrait root: a web grid in a story format | a 3-up product grid lifted from a web page into a 9:16 ad (inventory §4). Only one example, so it is not shipped until a labelled sample of 10+ frames shows it separates good from bad |

Every rule reads the static (base) geometry. Whether that is the base or the playhead state on an animated frame is `[C-187]`; until measured, the result's `note` says craft findings on an animated frame describe its rest state.

#### 4.4.4 Plugin / server

Plugin only, inside `checkLayout`'s existing walk (`src/plugin/ops/check.ts`), collected like the board rules and judged after the walk. C08 reuses `coverage`, `contrastRatio` and the paint-order index, which the `covered` pass already maintains.

#### 4.4.5 Tests

- `test/check-craft.test.ts`: one fixture tree per rule (bare node trees, as `checkLayout` already supports), each positive, negative and at its boundary.
- `audit` without `"craft"` reports none of them.
- `safeArea` parsing errors name the field.
- Existing `check-audit` tests stay green.
- Live: run on a scratch frame with one example per rule (`spikes/live-craft.mjs`).

---

### 4.5 `figma_create_storyboard` (new, create)

#### 4.5.1 Purpose

The pre-production artefact a motion designer works from: N panels in rows, each a frame for the thumbnail or styleframe, with captions. Timing is **derived** and therefore consistent: timecode, frame, and bar.beat when `bpm` is given. The board carries a machine-readable record, so the animatic, the motion audit and a later agent can read the plan back. It builds a scaffold; what goes into the thumbnails (sketches, styleframes) is the agent's or a person's work, through the existing create tools with `parentId` = a returned `thumbId`.

#### 4.5.2 Parameters

| Param | Schema | Default | Notes |
|---|---|---|---|
| `title` | string 1–120 | — | Board heading; also names the wrapper |
| `aspect` | enum `9:16` / `4:5` / `1:1` / `16:9` | — | Of every thumbnail |
| `fps` | integer 1–60 | 30 | For frame numbers |
| `bpm` | number 30–300 | none | Adds bar.beat per panel and an `offBeat` list |
| `beatsPerBar` | integer 1–12 | 4 | |
| `panels` | array 1–48 of objects (below) | — | |
| `captions` | enum[] of `timecode`, `duration`, `beat`, `action`, `camera`, `transition`, `audio`, `notes` | every field any panel fills, plus timecode and duration | Row order is fixed in that order |
| `columns` | integer 1–12 | 6 (9:16), 5 (4:5, 1:1), 4 (16:9) | |
| `thumbWidth` | number 96–1080 | 216 (9:16), 288 (4:5), 300 (1:1), 384 (16:9) | Height follows the aspect |
| `snap` | enum `frame` / `beat` / `none` | `frame` | Durations rounded to whole frames (or beats); a change is reported per panel |
| `parentId` / `pageId` / `x` / `y` | as `figma_create_from_spec` | an empty spot, as the guides advise | |
| `idempotencyKey`, `session` | standard | | |

A panel (strict object):

| Field | Schema | Notes |
|---|---|---|
| `durationS` | number > 0, ≤ 60 | Panels run back to back; start = sum of the earlier durations |
| `title` | string ≤ 80 | Shown in the panel header ("03 · Ash Vase") |
| `beat`, `action`, `camera`, `transition`, `audio`, `notes` | string ≤ 400 each | Caption rows. `beat` is the story beat ("hook", "product"), not the music beat |
| `source` | string, a node id in this file | A styleframe to snapshot into the thumbnail (render → image fill) |
| `image` | string, an `imageHash` already in the file | Exclusive with `source` |
| `styleframe` | boolean | Also create an empty full-size frame (e.g. 1080 × 1920) for this panel, in a row beside the board, named `SF 03 · <title>`. Its id comes back as `styleframeId` |

Refused before anything exists:

- a `source` that is not in this file, or an `image` hash it does not know;
- `source` together with `image`;
- more than 48 panels;
- a total longer than 600 s;
- an unknown caption field;
- an id that is an instance or inside one `[C-123]`.

#### 4.5.3 What it builds (Design)

- A wrapper FRAME `Storyboard / <title>`: vertical auto-layout, padding 64, gap 48, white.
- A header: the title (Inter Semi Bold 40), a meta line (`9:16 · 30 fps · 100 BPM · 14.4 s · 12 panels`), and a caption legend.
- A grid FRAME: horizontal auto-layout with `wrap`, `gap` 48 and `rowGap` 64 `[C-095]`.
- One card per panel, named `Panel 03 · 0:03.6`. Each card is a vertical auto-layout, fixed at `thumbWidth`, holding:
  - a header row (number, title, timecode);
  - the **thumb**: a FRAME `Panel 03 / Frame` at the aspect, clipping, with a neutral fill and a centred "draw or place here" label. The label is removed when `source` or `image` fills it;
  - caption rows: a small-caps label and a value, Inter Regular 13 / 18, wrapping at the card width.
- Text sizes and greys follow the file's styles when it has them, through the same path `create_from_spec` uses for `style` names. Otherwise they are raw values (`check_layout audit tokens` then reports them).

The planner (`src/shared/storyboard.ts`, pure) compiles all of this into one `create_from_spec` spec, so the build inherits that builder's checks, chunking, progress and single undo step. The plugin op then applies the snapshots: `exportAsync` of `source` at the thumb's pixel width × 2, then `createImage` (≤ 4096 px `[C-076]`), then an IMAGE fill. It writes the record (4.5.5) and returns.

#### 4.5.4 FigJam (P2, after the spike)

The same plan, rendered board-native:

- a wrapper SECTION, with one SECTION per panel arranged by the spec's `arrange` (64 px gap, 32 px padding `[C-166]`);
- the thumb is a FRAME if the spike shows FigJam builds frames `[C-189]`, else a white rounded rectangle that a person can sketch on;
- captions are text in Charcoal `[C-156]`;
- `notes` becomes a yellow sticky, so reviewers can answer it on the board.

`source` snapshots need `createImage` on a board, which is unmeasured `[C-150]`. Until measured, `source` and `image` are refused in FigJam before anything exists. Slides stays "unmeasured" and is not planned.

#### 4.5.5 The record

`setSharedPluginData("figmamcp", "storyboard", json)` on the wrapper `[C-184]`:

```jsonc
{ "v": 1, "title": "…", "aspect": "9:16", "fps": 30, "bpm": 100,
  "panels": [{ "index": 3, "id": "…", "thumbId": "…", "captionIds": { "duration": "…", "action": "…" }, "styleframeId": "…" }] }
```

The values themselves are **not** stored there: they live in the visible caption text, so a person who edits "1.2 s" on the canvas changes the plan. Readers (`create_animatic`, `check_motion { storyboardId }`) parse the duration caption first. When it does not parse, they fall back to the planner's value and report a `captionConflict`. Shared rather than private plugin data, so a re-imported dev plugin with a new id still reads it `[C-184]`. One entry is well under the 100 kB cap.

#### 4.5.6 Result

```jsonc
{ "storyboardId": "…", "durationS": 14.4, "durationFrames": 432, "fps": 30, "bpm": 100,
  "panels": [{ "index": 1, "id": "…", "thumbId": "…", "captionIds": { "action": "…" },
               "startS": 0, "endS": 1.5, "startFrame": 0, "endFrame": 45, "bar": "1.1", "styleframeId": "…" }],
  "offBeat": [{ "index": 4, "startS": 3.65, "nearestBeat": "2.3", "offsetFrames": 2 }],
  "snapped": [{ "index": 2, "from": 0.95, "to": 0.9667 }],
  "created": ["…"] }
```

#### 4.5.7 Description draft

> Build a storyboard: one panel per shot, in rows, each panel a thumbnail frame at `aspect` (9:16, 4:5, 1:1, 16:9) with captions for timecode, duration, story beat, action, camera, transition, audio/VO and notes. Timing is derived from each panel's `durationS`: start time, frame at `fps`, and bar.beat when `bpm` is given (off-beat panels are listed). A panel can snapshot an existing styleframe (`source`), show an image already in the file (`image`), or get an empty full-size styleframe beside the board (`styleframe`). Draw into a thumbnail with any create tool, `parentId` = its `thumbId`. Edit captions as text: figma_create_animatic and figma_check_motion read the durations back from them. One undo step. Editors: Design; unverified: FigJam (no snapshots there yet).

#### 4.5.8 Tests

- `test/storyboard-plan.test.ts` (pure planner):
  - cumulative timecodes, frame numbers, bar.beat at 100 BPM matching final-spec §2;
  - `snap` to frame and beat;
  - layout dimensions per aspect;
  - the compiled spec validates with the real `create_from_spec` parser;
  - refusals (48 panels, 600 s, exclusive fields, an unknown caption).
- Plugin op with the write fakes: builds the tree in one op, snapshots with a fake `exportAsync` / `createImage`, writes the record, and checks every refusal before the first node (`partial.created: []`).
- Reader: captions parsed back, a conflict reported, a missing caption tolerated.
- Editor gate and schema portability.
- Live `spikes/live-storyboard.mjs`: 12 panels at 9:16 on Design, one `source` snapshot. `check_layout` must return `ok: true` on the result, since the tool's own output must pass the house check. The FigJam run comes later, behind `BRIDGE_ALLOW_UNVERIFIED=1`.

---

### 4.6 `figma_create_animatic` (new, create, P2)

#### 4.6.1 Purpose

Turns a storyboard into a timed, renderable frame: each panel's picture fills the screen for exactly its duration, so `figma_export_video` produces the animatic a motion designer would cut before building. It reads the plan from the storyboard (4.5.5), so editing a caption and re-running updates it.

#### 4.6.2 Parameters

| Param | Schema | Default | Notes |
|---|---|---|---|
| `storyboardId` | string | — | A wrapper `figma_create_storyboard` made (the record must parse) |
| `width` | number 64–4096 | 1080 (9:16, 4:5, 1:1), 1920 (16:9) | Height follows the aspect |
| `burnIn` | enum `none` / `panel` / `full` | `panel` | Text strip at the bottom: `panel` = number, timecode and beat; `full` adds action and camera |
| `dissolveFrames` | integer 0–12 | 0 | Used where a panel's `transition` caption starts with "dissolve" (case-insensitive): an OPACITY ramp over that many frames instead of a cut |
| `drift` | boolean | false | A 3 % LINEAR push per panel, so a held panel is not a freeze (M09) |
| `pageId` / `x` / `y` | | an empty spot | It must be a top-level frame `[C-116]` |
| `idempotencyKey`, `session` | | | |

#### 4.6.3 Behaviour

1. Read the record and every panel's duration caption; refuse a missing or unparseable record before anything exists. Probe Motion: if it is gated, return `UNSUPPORTED` with nothing created `[C-115]`.
2. Create the top-level frame `Animatic · <title>` (`clipsContent`, black). Per panel, create a FRAME layer holding a RECT whose image comes from the best source:
   - the panel's styleframe, if it has content;
   - else its `source`;
   - else its thumb, rendered at `width` (soft, but an animatic).
   Add the burn-in text if asked.
3. Keyframes, **one track per call to the internal setter, never several in one call** `[C-179]`. Each panel gets OPACITY **cut pairs** at its boundaries: the old value at `(k − 0.75)/fps`, the new value at `(k − 0.15)/fps`, both LINEAR `[C-174]`. Every panel's track starts with a key at t = 0, so no track starts late (M23). HOLD is not used `[C-177]`. With dissolves, the outgoing ramp runs over `dissolveFrames`, ending on the boundary frame. With drift, a SCALE_XY track goes 1 → 1.03 LINEAR over the panel.
4. Set the timeline duration to the total. Then **read every track back**. Return `verified: true`, or `verified: false` with the mismatches and `partial`.
5. The resting state is the first panel visible and the rest at base opacity 0, written by their t = 0 keys `[C-180]`. The result says so, with the render command.

The cut pairs use `src/shared/motion-curves.ts`, the same module `check_motion` recognises them with, so an animatic always passes M13 and M15.

#### 4.6.4 Result

```jsonc
{ "animaticId": "…", "durationS": 14.4, "fps": 30, "expectedFrames": 433,
  "panels": [{ "index": 1, "layerId": "…", "inFrame": 0, "outFrame": 45, "image": "styleframe" }],
  "verified": true,
  "render": "figma_export_video { nodeId: \"…\", fps: 30, width: 540, jobId: \"animatic-<title>\" }",
  "note": "Panels 2–12 rest at opacity 0; figma_export_node shows panel 1 only." }
```

#### 4.6.5 Tests

- Cut-pair generation for boundary frames at 24, 30 and 60 fps, which `check_motion` evaluates frame-exactly (panel i visible exactly on frames [in, out)).
- Dissolve ramps; drift; burn-in content.
- A gated account → `UNSUPPORTED` with nothing created.
- Readback mismatch → `verified: false` and `partial`.
- Editor gate: FigJam and Slides "no" (motion and video are Design-only `[C-133]`).
- Live `spikes/live-animatic.mjs`:
  - a 6-panel storyboard, each thumb a distinct flat grey;
  - render through job mode and run `figma_review_video` stills on each boundary frame and the one before it;
  - each panel's grey must appear on exactly its frames: this is also where `[C-174]` is re-measured at 24 fps.

---

### 4.7 `figma_import_image` (changed): `renderNodeId`

- **New source:** `renderNodeId` (a node in this file) with `renderWidth?` (16–4096, default the target's width × 2).
- **Exclusivity:** `renderNodeId` is exclusive with `url` and `path`.
- **Behaviour:** the plugin renders the node (`exportAsync`, `constraint: WIDTH`) and calls `createImage`, all in the sandbox `[C-076]`; the target is `nodeId` (an existing node's fill), or a new rectangle as today.
- **Uses:** refreshing a storyboard thumb after its styleframe changed; animatic plates; mood boards from frames.
- **Editors:** as today (Design yes; FigJam and Slides unmeasured `[C-150]`).
- **Tests:** the render → createImage → fill path with fakes; the exclusivity refusals; the 4096 px cap refused before rendering.

---

## 5. Plugin / server split

| Tool | Server | Plugin | Shared (no dependencies) |
|---|---|---|---|
| `figma_export_video` | job store, `wait`, heartbeat, frame-exact stills, ffprobe count | unchanged (optional timer heartbeat after `[C-188]`) | `video.ts`: `frameSeek(k, fps)`, `expectedFrames(d, fps)` |
| `figma_review_video` | everything: spawn ffmpeg / ffprobe, metrics, sheets | — | — |
| `figma_check_motion` | `motion-audit.ts` rules, geometry composition (P2), fix suggestions | op `check_motion`: snapshot | `motion-curves.ts`: evaluation, sampling, cut pairs |
| `figma_check_layout` craft | — | `check.ts` walk | — |
| `figma_create_storyboard` | zod schema | op `create_storyboard`: plan → spec → builder → snapshots → record | `storyboard.ts`: planner and record reader |
| `figma_create_animatic` | zod schema | op `create_animatic`: read → frame → plates → keys → readback | `storyboard.ts`, `motion-curves.ts` |
| `figma_import_image` | path rules unchanged | `renderNodeId` path | — |

`ops.ts` (`BY_GROUP`):

- `create` += `create_storyboard`, `create_animatic`;
- `read` += `check_motion`;
- `export` += `review_video`;
- `BRIDGE_ONLY` += `review_video` (answered by the server, never forwarded);
- none is destructive, and `create_animatic` and `create_storyboard` are not batchable (create group).

---

## 6. Schema notes (portable subset)

| Field | Natural shape | Portable shape |
|---|---|---|
| `safeArea` | `{x,y,w,h}` or a preset name | one string `"x,y,width,height"`, parsed in code, `INVALID_PARAM` naming `safeArea` |
| `jobId` + `cancel` vs. render settings | oneOf | flat optional fields; exclusivity checked in code |
| `frames` vs `frameIndices` | oneOf | both optional; both together refused |
| panel `source` vs `image` | oneOf | both optional strings; together refused |
| `thresholds` | map of numbers | a strict object with every key listed (no `additionalProperties` map, which the test rejects: objects need `properties`) |
| `closeups[]`, `regions[]`, `matchCuts[]`, `stillWindows[]` | — | arrays of strict objects with listed properties |
| `rules` | — | `z.enum` of rule ids (an enum is allowed) |
| `sheet` on / off | boolean or object | flat `sheetEvery` / `sheetColumns` / `tileWidth` / `labels` |
| integers | — | `z.number().int()` with min / max; `jobId`'s character set is checked in code (no `format`) |

Every new nested object is `.strict()`, so an unknown key is refused with its path, never stripped (params.ts). Every description stays ≤ 1024 characters (drafts in 4.1.4, 4.3.8, 4.5.7). `test/schema-portability.test.ts` covers the new tools as soon as they are registered.

---

## 7. Editor support rows

| Tool | Design | FigJam | Slides | Note |
|---|---|---|---|---|
| `figma_create_storyboard` | unmeasured → yes after `live-storyboard` | unmeasured (`source` / `image` refused) | unmeasured | `[C-189]` `[C-150]` |
| `figma_create_animatic` | unmeasured → yes after `live-animatic` | no | no | motion and video are Design-only `[C-133]` |
| `figma_check_motion` | unmeasured → yes after `live-check-motion` | no | no | same reason as `figma_get_motion_context` |
| `figma_review_video` | yes | yes | yes | answered by the server; no Figma involved |

`editors.ts` gets one explicit row each (deny by default); `test/editor-gate.test.ts` pins these cells to tools.md § Editor support.

---

## 8. Tests and spikes, collected

Unit and integration tests (CI, no Figma):

- `export-video-jobs.test.ts`
- `video-metrics.test.ts`
- `review-video.test.ts` (with the ffmpeg-generated clip when ffmpeg is present)
- `motion-curves.test.ts`
- `motion-audit.test.ts`
- `motion-audit-fixtures.test.ts` (the 2026-10-09 snapshots)
- `check-craft.test.ts`
- `storyboard-plan.test.ts`
- the storyboard and animatic op tests with fakes
- the import-image `renderNodeId` test
- editor gate, schema portability, `ops.test.ts` (tools.md parity)

Live spikes (results under `spikes/results/`):

| Spike | Settles | Steps |
|---|---|---|
| `live-motion-semantics.mjs` | `[C-177]` HOLD timing, `[C-178]` named easing curves, `[C-182]` value before the first key, `[C-175]` frame count at 24 fps and for GIF, `[C-187]` base vs playhead geometry, `[C-188]` timers during `exportAsync` | 1. One frame, one layer per question. 2. Render once in job mode. 3. Read back with `figma_review_video` stills and regions. 4. Record the named easing curves as per-frame samples in `src/shared/easing-presets.ts`, so M-rules evaluate them exactly (P3) |
| `live-review.mjs` | frame-exact stills, metrics on a real export | — |
| `live-check-motion.mjs` | M04 px thresholds, M05 open case, G rules (P2) | — |
| `live-storyboard.mjs` | Design yes; later FigJam `[C-189]` `[C-150]` | — |
| `live-animatic.mjs` | Design yes; cut pairs at 24 / 30 fps | — |
| `live-craft.mjs` | craft rules on a real canvas | — |

---

## 9. Priority and order

| P | Work | Depends on | Size |
|---|---|---|---|
| P0 | the four defect fixes (section 3) | — | S each |
| P1 | `motion-curves.ts` + `check_motion` track rules M01–M23 (minus M16's scene lengths and M17's covered case) + fixtures | P0 not needed (reads only) | L |
| P1 | `review_video` | — | M |
| P1 | `export_video` job mode, heartbeat, frame-exact stills | P0 frame-exact | M |
| P1 | `create_storyboard` (Design) | — | M |
| P2 | `create_animatic` | P0 keyframe fixes, `motion-curves.ts` | M |
| P2 | `check_motion` geometry rules G01–G07, `suggest` payloads | the plugin snapshot from P1 | L |
| P2 | `craft` audit, `renderNodeId`, FigJam storyboard (after the spike) | — | M |
| P3 | MCP Tasks for `export_video` (`execution.taskSupport: "optional"` through the SDK's experimental API `[C-172]`, sharing the job store); a cross-file animatic (`fromSession`: thumbs exported from a FigJam session, imported into the Design session by the server); measured named easings; `check_motion { storyboardId }` plan-versus-build; `equal_tiles` | spikes | — |

Run order for an agent once P1 lands (for the guides spec):

1. brief and directions (guides);
2. `create_storyboard`;
3. styleframes (`create_from_spec` into `styleframeId`);
4. `check_layout { audit: ["craft"] }`;
5. `create_animatic` → `export_video` (job) → `review_video`;
6. build;
7. `check_motion` until `ok`;
8. `export_video` → `review_video`, critics read the sheet and metrics;
9. targeted fixes → back to step 7.

---

## 10. Changes to locked and unlocked documents (when this is implemented)

- `docs/reference/tools.md` (locked; unlock → edit → `lock-docs --update` → re-lock):
  - counts 129 → 133 (create 34, read 22, export 6), headline "133 tools in the catalog → 132 registered by default";
  - four new rows, and the changed rows for `export_video`, `check_layout`, `import_image`;
  - § Editor support rows;
  - the `figma_export_video` Official column also notes that the official tool is a polled job `[C-173]`.
- `src/shared/ops.ts`, `src/shared/editors.ts`, `src/server/tools/index.ts` wiring; `test/ops.test.ts` follows tools.md.
- `src/server/guides.ts` (owned by the guides spec): the `motion` topic gains "check_motion before rendering, review_video after", the job-mode call, and cut pairs instead of HOLD. A storyboard topic or prompt points at `create_storyboard` and `create_animatic`, and the `check` topic mentions `audit: ["craft"]`.
- `docs/reference/claims.md` (locked): C-168 to C-192 below, by the main agent only.

---

## 11. Claims (proposed C-168 to C-192)

Every external fact this design leans on, with the date checked 2026-10-13 unless stated. A "measured" entry was measured in the 2026-10-09 run and its source is the record; per the registry's statuses, "measured" means re-measure if the environment changes.

| ID | Claim | Status | Source | Checked |
|---|---|---|---|---|
| C-168 | MCP: senders SHOULD time out requests and then send a cancellation; implementations MAY reset the timeout on a progress notification, but SHOULD still enforce a maximum timeout | verified | [MCP 2025-11-25 Lifecycle § Timeouts](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) — *"MAY choose to reset the timeout clock when receiving a progress notification"* | 2026-10-13 |
| C-169 | The MCP TypeScript SDK 1.32.1 times a request out at 60 000 ms by default, and resets that timeout on progress only when the caller sets `resetTimeoutOnProgress` (default false). It sends a `progressToken` only when the caller passes `onprogress`. So on SDK defaults a 60 s+ tool call is cancelled whatever progress the server sends | verified | `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts` 1.32.1:57 (`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`), :78–83 (the reset-on-progress option is documented as off by default); `protocol.js` :671–677, :740–742 | 2026-10-13 |
| C-170 | A video render through figma-mcp was cancelled with the MCP call after about 60 s. Full renders of a 14.4 s, 1080 × 1920, 30 fps frame took 28–47 s through a client with a long timeout. A render stalled for about 40 min while the Figma window was minimized and progressed once it was restored | measured | run record `tool-findings.md` (NOTE environment ×2); `r2-work/render.mjs` | 2026-10-09 |
| C-171 | MCP cancellation: a receiver SHOULD stop processing the cancelled request, free its resources and not respond; for task-augmented requests `tasks/cancel` is used instead | verified | [MCP 2025-11-25 Cancellation § Behavior Requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation) (the receiver SHOULD-list in Behavior Requirements) | 2026-10-13 |
| C-172 | MCP Tasks (2025-11-25) are **experimental**: a `tools/call` augmented with `task` returns a `CreateTaskResult`, the requestor polls `tasks/get` and fetches `tasks/result`; a server declares `tasks.requests.tools.call` and each tool `execution.taskSupport` (`required` / `optional` / `forbidden`, default forbidden). Without an auth context, task ids must be unguessable. SDK 1.32.1 exposes `server.experimental.tasks.registerToolTask`, marked experimental | verified | [MCP 2025-11-25 Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) (the page opens by marking the feature experimental); `node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/mcp-server.d.ts` 1.32.1 | 2026-10-13 |
| C-173 | The official Figma MCP's `export_video` returns a job id with status processing and is polled; frames are extracted locally with ffmpeg once the render is paid for; render cost grows with pixels × frames, so verification renders are small and sample a few frames per phase | verified | official Figma plugin 2.2.120 skill `figma-use-motion/SKILL.md`:55–63 (verification section: polled job, local frame extraction, keep renders small) | 2026-10-13 |
| C-174 | Figma's video export samples frame k at exactly t = k / fps, and a `cubic:` easing matches CSS cubic-bezier: an edge's positions on frames 89–96 of an exported MP4 matched the curve evaluated at k/30 to the pixel (centre-of-frame sampling would not). Hence a cut pair (LINEAR keys at (k − 0.75)/fps and (k − 0.15)/fps, the run's k/30 − 0.025 and − 0.005) switches on frame k; other frame rates are re-measured by `spikes/live-animatic.mjs` | measured | journal line 18 (judge:build); run record `final-spec.md` §3.3 (measured on this account, not yet registered) | 2026-10-09 |
| C-175 | A 14.4 s timeline exported at 30 fps had 433 frames (f0–f432, 14.433 s): the endpoint t = duration renders as an extra frame | measured | journal line 34 (`durationS` 14.433), lines 40 and 48 (QA r1, r2: 433 frames, f432 ≈ f431) | 2026-10-09 |
| C-176 | ffmpeg's `-ss` as an input option at (k + 0.5)/fps returned frame k + 1, because frames before the seek point are dropped; seeking at (k − 0.25)/fps returned exactly frame k | measured | run record `tool-findings.md` (NOTE spec E.1); `r2-work/post.sh` | 2026-10-09 |
| C-177 | **HOLD timing is contradicted.** The Plugin API Motion page and the official skill describe HOLD as keeping the earlier value until the next keyframe and then stepping. Figma's help article on easing says a hold makes the object jump to its final position at once and stay there. So which frame shows the step is unsettled; the animatic uses cut pairs `[C-174]` and `check_motion` reports HOLD (M15) | contradiction | [Plugin API — Motion](https://developers.figma.com/docs/plugins/api/Motion/) (HOLD keeps the current value until the next keyframe); official skill `figma-use-motion/references/motion-easing.md`:106–116; [Help — Adjust an animation's easing](https://help.figma.com/hc/en-us/articles/41414048690839) (a hold makes the object jump to its end value at once and stay there). Settled by `spikes/live-motion-semantics.mjs` | 2026-10-13 |
| C-178 | The control points of Figma's named easings (`EASE_IN`, `EASE_OUT`, `EASE_IN_AND_OUT`, the `_BACK` forms) and the parameters of the spring presets (`GENTLE`, `QUICK`, `BOUNCY`, `SLOW`) are not published; only `cubic:` (and LINEAR) can be evaluated exactly. `check_motion` approximates the named ones and says so until a render measures them | to-verify | official skill `figma-use-motion/references/motion-easing.md`:15–30 (names and kinds only); [Help — Prototype easing and spring animations](https://help.figma.com/hc/en-us/articles/360051748654) (presets described by feel; seen via search, 2026-10-13). Settled by `spikes/live-motion-semantics.mjs` | 2026-10-13 |
| C-179 | figma-mcp defects seen while building: `figma_set_keyframes` with several tracks in one call (also inside `figma_batch`) applied only the last track while echoing the old keys for the others; a call with `timelineDuration` once returned another frame's timeline id and dropped 2 of 3 tracks; `figma_move_nodes` in a batch returned ok without moving, and with x and y moved only y | measured | run record `tool-findings.md` (S3 builder notes and NOTE figma-mcp defect ×2) | 2026-10-09 |
| C-180 | Writing keyframes writes a node's t = 0 OPACITY into its base opacity, so `figma_export_node` of a layer whose first key hides it renders a 1 × 1 image | measured | run record `tool-findings.md` (S3 builder); `final-spec.md` §3.4 | 2026-10-09 |
| C-181 | A manual keyframe binding includes the field's current base value together with its sorted keyframes; when a track is created the API derives the base value from the node | verified | [Plugin API — Motion](https://developers.figma.com/docs/plugins/api/Motion/) (the binding type is described as carrying the base value plus the sorted keyframes); official skill `figma-use-motion/references/motion-patterns.md` (omit `baseValue` when creating) | 2026-10-13 |
| C-182 | What a track shows **before its first keyframe** is not documented (the Motion page and the skills are silent). `check_motion` assumes the first key's value is held and flags any track whose first key is after t = 0 and differs from the base value (M23), which is correct whichever way it resolves | to-verify | [Plugin API — Motion](https://developers.figma.com/docs/plugins/api/Motion/) (not covered); settled by `spikes/live-motion-semantics.mjs` | 2026-10-13 |
| C-183 | The local ffmpeg (9.0, gyan.dev full build) provides `freezedetect` (noise 0.001, duration 2 s by default), `tile` (layout, padding, margin), `select`, `tblend` (difference), `scdet` (threshold 10) and `drawtext`, which draws with libfreetype and needs a font file. Other builds may lack `drawtext`, so tile labels are optional | verified | `ffmpeg -h filter=<name>` on this machine, 2026-10-13 (the drawtext help names libfreetype as its renderer) | 2026-10-13 |
| C-184 | `setSharedPluginData(namespace, key, value)` stores data on a node readable by every plugin; the namespace needs at least 3 alphanumeric characters and an entry is capped at 100 kB. `setPluginData` is private to the plugin id and becomes unreadable if that id changes | verified | `node_modules/@figma/plugin-typings/plugin-api.d.ts` 1.141.0:6470–6514 | 2026-10-13 |
| C-185 | Instagram Story / Reels safe zones are not settled in public sources: third-party guides give about 14 % at the top and either 20 % or 35 % at the bottom, and say Meta's own page is qualitative. figma-mcp has no preset; `safeArea` comes from the brief | contradiction | search results 2026-10-13 (pages not opened): adsuploader.com/blog/meta-ads-safe-zones, houseofmarketers.com/guide-to-safe-zones-tiktok-facebook-instagram-stories, creatorflow.so/blog/instagram-story-mockup-client-signoff | 2026-10-13 |
| C-186 | Animation export on a Starter plan may be capped at 1920 × 1080 or 30 fps (a third-party plugin's documentation says it retries renders above that). Not load-bearing; review renders use 30 fps and half size anyway | to-verify | docs.hypermatic.com (TinyImage, Figma Motion export), seen via search 2026-10-13 | 2026-10-13 |
| C-187 | Unknown until measured: whether a node's `x` / `y` / `absoluteBoundingBox` on an animated frame read the base values or the playhead's state; and how TRANSLATION / ROTATION on an auto-layout child and STACK_SPACING on a hugging row behave. Geometry-over-time rules (G01–G07) and the craft audit on animated frames depend on the first; M20 reports the second | to-verify | journal line 18 (the build judge lists both as unmeasured risks). Settled by `spikes/live-motion-semantics.mjs` | 2026-10-13 |
| C-188 | Unknown until measured: whether `setInterval` fires in the plugin sandbox while a video `exportAsync` is pending (the sandbox has timers `[C-012]`), which a plugin-side heartbeat needs | to-verify | `[C-012]`; settled by `spikes/live-motion-semantics.mjs` | 2026-10-13 |
| C-189 | Whether `figma.createFrame()` works on a FigJam board is unmeasured: the typings put no editor note on it (unlike the Design-only creators), and no FigJam spike has created one. The FigJam storyboard uses frames only after the spike, sections and rectangles otherwise | to-verify | `node_modules/@figma/plugin-typings/plugin-api.d.ts` 1.141.0:1068–1086 (no editor note); settled by `spikes/live-storyboard.mjs` | 2026-10-13 |

Decisions (not external facts, recorded so they can be revisited):

| ID | Decision | Status | Basis |
|---|---|---|---|
| C-190 | Every `check_motion` default threshold is taken from a 2026-10-09 critic or judge finding (section 4.3.3), calibrated on the run's three motion-context snapshots: the snapping-close, pop-in and dot rules fire before the critics' fixes and are quiet after them. A threshold changes only with a fixture test that keeps the confirmed findings | decision (calibration measured) | prototype `scratchpad/skills/proto/audit-proto2.mjs`, `calibration.txt`, 2026-10-13 |
| C-191 | Brief-level defaults: 0.3 s per word of fully readable text, brand fully visible by 2 s, CTA readable ≥ 2.5 s. These come from the run's brief and ad judge, not from a published standard, and are parameters | decision | run record `final-spec.md` Appendix A; journal line 12 |
| C-192 | `review_video` measures at 270 px grey, where the run's numbers were taken: dead spans 0.03–0.12, a designed breath 0.22, wipes about 26, cuts 60–68 (mean absolute difference, 0–255). Defaults: freeze < 0.15 for ≥ 0.5 s, flicker ≥ 1.0 with skip ≤ 0.35×, spike ≥ 20, flash ≥ 40 luma with ≥ 90 % changed | decision (values measured) | journal lines 39, 40, 46, 55, 56; `final-spec.md` E.1 |

Existing claims reused: C-012 (sandbox timers), C-029 (progress values), C-070 (measure, not vision), C-075 (WCAG), C-076 (createImage, 4096 px), C-095 (wrap), C-115 (Motion beta, gating), C-116 (video export), C-123 (instances), C-129 (editor gate), C-133 (Design-only motion and video), C-150 (images on boards), C-156 (FigJam colours), C-166 (board gaps).

---

## 12. Open questions

1. **M05 on the dot collapse:** the rule flags blur placed mid-move on purpose (the round-1 QA fix). Is an accelerating collapse into a point a legitimate exception? It is settled by rendering the probe and reading the region metrics around the dot (4.3.7).
2. **Default `wait` of 40 s:** right for SDK-default clients `[C-169]`. A client with a shorter limit needs the agent to pass less. Should `figma_status` report a client-specific hint? That would need the client's name from `initialize`, a client feature in disguise, so it is left out for now.
3. **Covered text in M17:** "readable" ignores layers painted over the text until the geometry rules land (P2). Until then, a text covered by a wipe counts as readable.
4. **`equal_tiles` and other template tells** (uniform radius, one shadow everywhere): plausible AI tells, but the run has one example. They need a labelled sample before they ship.
5. **Storyboards in Slides:** not planned. A deck could hold one board per slide, but nothing in the run asks for it.
