# Bug diagnosis: dropped keyframe tracks and video renders that die at the client timeout

Work package `bug-keyframes`, 2026-10-13. This is a read-only diagnosis of two defects reported while agents built the Moku IG Story ad through figma-mcp on 2026-10-09. The branch is `feat/figjam-slides`; the motion code has not changed since `4e52cf1`. No repo file was edited.

The harness refused to let this subagent write the requested `.md` file, so the whole report is here. The probe script is a `.mjs` file and was written:
- `scratchpad/skills/kfwork/live-keyframe-tracks.mjs` (syntax-checked, and dry-run against a fake Figma);
- analysis helpers in `scratchpad/skills/kfwork/` (`extract.js`, `compare.js`, `timeline.js`, and `dry/`).

New claim ids start at C-168 (section 9). Existing ids are cited where they already cover a fact.

## 0. Summary

- **Defect 1 is real loss, not just a stale echo.**
  - In a call that replaced several existing tracks, only the last one stuck; the others kept their old keys.
  - A separate read 6 s later confirmed the old keys (fix:r1, S1/Window).
  - The trigger is a frame state that comes and goes. In that state, the timeline id Figma reports is not the frame's own id.
  - How often it struck:
    - build phase: about 40 multi-track calls that only ADDED fields, all landed;
    - fix round 1: 20 of 21 multi-track calls landed;
    - first fix:r2 batch: 7 of 7 multi-track steps lost every track but the last.
- **`timelineDuration` is not the cause.**
  - The failing fix:r1 call had it, but the duration already equalled 14.4 s, so the code never called `setTimelineDuration`.
  - The fix:r2 failures had no duration at all.
  - The "31 s" those calls appear to take is how long the client spent streaming its parallel calls, not how long they ran.
- **The leading hypothesis is H1.** In the losing state, Figma computes each replacement from the node's track record as it stood before the current synchronous run, so successive replacements overwrite each other. figma-mcp applies all tracks in one synchronous loop through one node handle, so it hits this every time the state occurs.
- **The fix is safe whatever the cause:**
  1. Write the tracks.
  2. Give Figma one host turn.
  3. Read every track back through a fresh handle.
  4. Re-apply only the tracks that did not land, one per host turn, and verify again.
  5. Report a status for each track.
  6. Read the timeline after verification, and say when its id differs from the top-level frame's.
- **A live probe (section 4) separates the hypotheses in one run.** It also finds which trigger causes the state: a PNG export, a new layer, or a video export. Its logic was dry-run against a fake Figma with the defect built in, and it classified the cells correctly.
- **Defect 2 is mainly figma-mcp's own fault.**
  - The client cancelled after 60 s. The bridge then cancelled the plugin job, which threw away a render Figma could not stop and that would have finished in 28–47 s.
  - Progress notifications help only clients that opt in.
  - The client-agnostic fix:
    - never discard a finished render;
    - return `status: "rendering"` before about 45 s, and let a repeat call collect the file;
    - send heartbeat progress, under a hard cap.
  - The guide must tell agents to keep Figma's window restored during a render and never to loop retries when a render stalls.

## 1. What the record shows

Sources:
- `scratchpad/motion/tool-findings.md`;
- the agent transcripts under `subagents/workflows/wf_c23489f2-d18/`. Every `set_keyframes` call was compared, sent tracks against echoed tracks.

All times are UTC.

| When | Agent | Calls | Tracks per call | Outcome | Timeline id reported |
|---|---|---|---|---|---|
| 07:03 | rig | 1 batch (5 steps) | 4, then 1 each | all landed | `42:15039` (the frame) |
| 07:08 | scenes S1–S5 | 5 batches (~70 steps) | about 40 steps with 2–6 tracks, all NEW fields | all landed; each builder's `get_motion_context` matched | `42:15160` (builders called it the frame's "twin") |
| 07:46:48 | fix:r1, first call (S1/Window, timelineDuration 14.4) | 1 | 3 replacements | WIDTH and TRANSLATION_X kept their OLD keys; HEIGHT landed. A separate `get_motion_context` at 07:46:54 still showed WIDTH 240→480 and TRANSLATION_X 120→0, the old keys | `47:559`, the next free id after `47:558` (the rectangle created at 07:45:48). `get_nodes_info` on it 13 s later: not found |
| 07:46:49–07:48:17 | fix:r1, remaining calls | ~40 | 20 calls with 2–6 tracks, mostly replacements | all landed | `42:15039`, except S4 · End card (1 track, landed), which reported `47:1151` |
| 08:18:41 | fix:r2, one batch | 19 steps | 7 steps with 2–6 replacements (18 tracks) | all 7 kept only their last track (11 tracks lost); all 12 single-track steps landed | `47:2168` |
| 08:19:38 | fix:r2, retry | 34 steps | 1 each | all landed | `47:2168` |
| 08:20:52 and 09:02 | fix:r2 | 4 | 1 each | landed | `42:15039` |
| 09:30 | fix:r3 | 14 | two calls with 3 and 2 replacements | all landed | `42:15039` |

The record also shows the frame state that comes and goes, which this report calls "re-keying" [C-179]:
- From 07:05:48, `figma_get_node 42:15040` listed S1/Window as `42:15162`, though it was created as `42:15082`. Both ids resolved.
- At 08:09, frame `42:15039` listed its children as `47:2169…`, and the REST export of `42:15045` reported id `47:2339`.
- A handle fetched by an old id reports the old id. `get_nodes_info` on `42:15040` and on `47:2169` returned identical properties, opacity 0.665 included.
- Some intermediate ids stopped accepting writes: `45:442` was "not found" at 07:43. The originally created ids always worked.
- At 08:09, every layer stored the value its animation has at about 3.6 s. For example, S1 · Hook's opacity 0.665 lies between its keys of 1 at 3.6083 s and 0 at 3.6283 s. Something had evaluated the timeline at a playhead and written those values back as base values.
- The session id prefix changed several times during the day (42 → 45 → 47 → 50 → 52). At 08:10, `get_nodes_info` failed twice with Figma's "Unable to establish connection to Figma after 10 seconds", so Figma's own connection dropped at least once.

Defect 2 in the record:
- `figma_export_video` returned "Request timed out" after 60.4 s, twice (08:21:10 and 08:23:15).
- The same renders took 28–47 s when run through `spikes/mcp-client.mjs` with a long timeout.
- After the first timeout, the session's figma-mcp became a proxy to a new hub (pid 25804 → 24560, uptime 0).
- A render with Figma minimized stalled for about 40 minutes until the window was restored without taking focus (tool-findings.md:9) [C-174].

## 2. The code path today

**`src/plugin/ops/motion.ts`, `setKeyframes.run`**
- It validates first (`planTracks`, `requireMotion`, `checkTargets`).
- It then calls `node.applyManualKeyframeTrack` for each plan in one synchronous `for` loop on one node handle (lines 190–211).
- After the writes it reads `firstTimeline(node)` (line 217) and may call `setTimelineDuration(before.id, …)`.
- It builds the echo from `read(node, "manualKeyframeTracks")` in the same synchronous run (line 241).
- Nothing yields between the writes or before the echo, and a microtask is not a host turn [C-013]. So the echo can never show what Figma committed after the run.
- `firstTimeline` trusts `timelines[0]` blindly. A non-frame id is passed through without comment. `get_motion_context` keys `timelineCohorts` by that id, so one frame can split into two cohorts.

**`src/plugin/ops/batch.ts`**
- Steps run back to back (`await ops[op].run(...)`) with no `yieldToHost` between them.
- Each step does get a fresh handle (`byId` → `getNodeByIdAsync`) and its own synchronous run. That difference matters for telling H1a from H1b: on 2026-10-09, one track per step always landed.

**`exportVideo`** (motion.ts:458–498) and the path behind it:
- The plugin sends one progress message ("rendering MP4"), then waits on `exportAsync`, which reports no progress.
- `forwardTool` hands the client's `extra.signal` to `bridge.request`.
- On a client cancel, `Bridge.cancel` sends `{t:"cancel"}` and settles the job as CANCELLED.
- The plugin's `onCancel` cannot stop `exportAsync`. When the bytes arrive, the bridge ignores them ("no longer waiting", bridge.ts:624).
- So every retry starts a new render that meets the same timeout.
- The bridge queue is sequential per session, so a stalled render blocks every other figma-mcp call until `VIDEO_IDLE_TIMEOUT_MS` (600 s).

## 3. Hypotheses for defect 1, ranked

**H1a — run-scoped coalescing (most likely).**
- In the losing state, each replacement is computed from the node's record as committed before the current synchronous run, and committed when the host gets a turn. So the last replacement wins, and the other fields keep their old keys.
- For:
  - It matches the "last-only, others old" pattern exactly: 7 of 7 steps in fix:r2, and 1 call in fix:r1.
  - One track per step always landed.
  - The typings promise that an apply replaces the track for one field [C-175]; losing the others contradicts that [C-178].
- Against:
  - Build-phase multi-track calls landed. But they ADDED fields; adds may be incremental where replacements write the whole record. The probe's `adds` cell tests this.
- Unit tests can model it as a fake: pending writes flush on `ctx.yieldToHost`. Such a test checks the fix, not Figma.

**H1b — handle-scoped stale base.**
- A handle obtained through a re-keyed (alias) id holds a snapshot of the record, and every apply through it starts from that snapshot.
- For:
  - The losing states coincide with re-keyed frames (`47:2168`).
  - Batch steps, each with a fresh handle, landed.
  - Alias handles report the id they were fetched by, so they are distinct wrapper objects.
- Against:
  - Build handles were partly aliases, and their adds landed (the same caveat as H1a).
- Unit tests can model it as a fake: `getNodeByIdAsync` returns a new proxy that applies from its snapshot.

**H2 — the timeline forks on the first write.**
- The first apply creates a new timeline or record object. Writes split between the records, and only the one written last survives.
- For:
  - The failing fix:r1 call reported `47:559`, the session's next free id. It never resolved as a node and was gone on the next call.
  - `47:1151` (S4) behaved the same way.
- Against:
  - fix:r2 lost tracks while the reported id stayed `47:2168` for all 19 steps.
  - The S4 call reported a fresh id and still landed, but it had only one track.
- Unit tests can only partly model it: a fake can return a fresh id after the first apply, to check that the result reports and flags it.

**H3 — the echo is stale, but nothing was lost.**
- For: the echo is read in the same run as the writes.
- Against: refuted for fix:r1 by the separate read 6 s later. It is not refuted for fix:r2, where no read happened between the batch and the re-send. It may add to H1 or H2 but is not the whole cause.
- Unit tests can model it: reads return the committed state until a yield.

**H4 — a `setTimelineDuration` side effect.** Refuted. The code skipped the call because `target === before.duration`, and the fix:r2 failures had no duration.

**H5 — concurrent writers.** Refuted. The bridge serialises per session, a batch is one request, and the fix rounds ran a single agent.

**The trigger for the losing state is the open question** [C-179]. Candidates from the record:
- a video export: the 07:48:41 render came before the `47:2168` state, and the render phase came before the `45:xxx` ids;
- a Figma reconnect: the prefixes changed, and "Unable to establish connection" appeared at 08:10;
- timeline playback or scrubbing: base values had been evaluated at about 3.6 s;
- structural edits inside an animated frame: the first re-key, at 07:05, happened while five builders were adding layers.

No unit test can model the trigger.

**Unit tests cannot settle at all:**
- which of H1a, H1b or H2 Figma actually does;
- whether one `setTimeout(0)` turn is enough for Figma to commit [C-012] [C-013];
- whether passing the existing track `id` and `baseValue` (the official skill's advice for edits [C-176]) or writing the whole record changes the outcome;
- the cost of a host turn while Figma is in the background (about 1 s per chained timer turn [C-124]);
- what happens while the window is minimized.

All of that needs the live probe.

## 4. The live probe

Target path: `spikes/live-keyframe-tracks.mjs`. It writes `spikes/results/live-keyframe-tracks.json` and needs `figma_eval`, which `connect({ allowEval: true })` provides; if a hub is already running, the probe joins it as a proxy. It creates one sandbox frame of its own and deletes it at the end; `KEEP=1` keeps it.

**Pool.** 19 rectangles inside one top-level frame. Each starts with OPACITY, TRANSLATION_X and ROTATION tracks whose "old" end values are 0.5, 10 and 5. The seeding writes one apply per host turn, then verifies and repairs in a later request.

**Cells.** Each cell replaces the three tracks with "new" values (0.25, 77, 33) on its own rectangle, in its own way. Every cell is read back in a LATER `figma_eval` request.
- `sameSync`: one handle, three applies in one synchronous run — what figma-mcp does today. It records the echo and the timeline id after each apply, plus a document-id counter before and after.
- `sameYield`: one handle, with `await setTimeout(0)` after each apply. All-new here means a host turn between writes is enough: **H1a**.
- `freshHandle`: `await getNodeByIdAsync` before each apply, with no timer. All-new here means a fresh handle is enough: **H1b**.
- `realHandle`: applies through `parent.children[...]`, the tree's current object, which differs from the handle when the frame is re-keyed. All-new means the alias handle is at fault: **H1b**.
- `keepIds`: passes the existing track's `id` and `baseValue` [C-175] [C-176]. All-new makes this a fix option.
- `setter`: one whole-record write, `node.manualKeyframeTracks = {...existing, …}`. This tests a contradiction [C-177]. All-new makes an atomic write a fix option; otherwise the cell records Figma's refusal.
- `adds`: three NEW fields (CORNER_RADIUS, TRANSLATION_Y, SCALE_X), plus `cornerRadius` and `opacity` read before and after. All-new here, while replacements lose, explains the build phase. It also shows whether a key overwrites the base value.
- `tool`: `figma_set_keyframes` with the three replacements. Today it should match `sameSync`. After the fix it must be all-new in every phase; this is the regression gate.

**Phases.**
1. Phase A: every cell on a fresh frame.
2. Triggers, in order, each followed by the re-key detector and one `sameSync` check, stopping at the first that reproduces the loss:
   - `png`: `figma_export_node` of the frame;
   - `layer`: a new rectangle inside the frame;
   - `video`: `figma_export_video`, MP4, 12 fps, LOW quality, 320 px wide, with a 600 s client timeout.
3. Phase B: every cell again.

**Re-key detector.** It records:
- the created id, the id the parent lists, and the handle's own `.id`;
- the frame's REST id and a child's timeline id;
- `figma.motion.playheadPosition` and one stored opacity.

**Optional `MINIMIZE=1` (manual).** The operator minimizes Figma, and the probe measures:
- 10 chained timer turns;
- a 1 s render, with a 120 s client timeout;
- after the window is restored, how long the plugin takes to answer.

**Reading the result:**
- Phase A all-new and no trigger reproduces the loss: the losing state was not reached. Repeat after scrubbing or playing the timeline in Figma's UI (see section 10). The fix still applies.
- Phase B `sameSync` last-only and `sameYield` all-new: **H1a**.
- Phase B `freshHandle` and/or `realHandle` all-new while `sameSync` loses: **H1b**.
- The same-run `sameSync` echo already shows old values: the loss happens at apply time (H1b or H2).
- The echo is new but the readback is old: the loss happens at commit (H1a).
- The echo is old but the readback is new: **H3** only.
- The timeline id in `sameSync.seq` changes after the first apply: **H2**.
- Counter ids used by one `sameSync`: about 3 × (1 track + 2 keyframes) is normal; hundreds would mean the subtree is copied on write.
- `keepIds` or `setter` all-new in the losing state: a cheaper fix exists.
- `adds` all-new with its existing tracks still old: only replacements coalesce.
- `tool` must equal `sameSync` before the fix and be all-new after it.

**Dry run (2026-10-13).** The probe ran against a fake client plus a fake Figma whose replacements become last-wins after the video trigger (`kfwork/dry/`). Results:
- phase A: all-new;
- triggers: `png` and `layer` all-new, `video` last-only;
- phase B: `sameYield`, `setter` and `adds` all-new; `sameSync`, `freshHandle`, `realHandle`, `keepIds` and `tool` last-only.

That is the expected classification for an H1a fake. It validates the script, not Figma.

### Script text

```js
// Live probe: why figma_set_keyframes kept only the last of several tracks
// (2026-10-09), and what puts a frame into that state. One run tells apart:
//
//   H1a  replacements inside one synchronous run coalesce, last wins
//        -> cell sameYield (a host turn between applies) is all-new, sameSync is not
//   H1b  the node handle carries a stale base -> freshHandle / realHandle all-new
//   H2   the first write forks the timeline -> the timeline id changes inside sameSync
//   H3   only the echo is stale -> sameSync echo is old but the later readback is new
//   plus whether keeping the track `id`, writing the whole record, or adding new
//   fields (instead of replacing) accumulates, and how many document ids one
//   replacement run consumes (a copy of the subtree would consume hundreds).
//
// The triggers tried, in order, until one reproduces the loss: a PNG export of
// the animated frame, a new layer inside it, a video export of it.
//
// Everything lives in one top-level frame "figma-mcp keyframe probe (delete me)"
// at x 52000, y 24000, created here and deleted at the end (KEEP=1 keeps it).
// Keep the Figma window restored, not minimized: a minimized window stalls video export.
//
// Run:  npm run build, re-run the plugin in Figma, then
//       node spikes/live-keyframe-tracks.mjs              (KEEP=1 to leave the sandbox)
//       MINIMIZE=1 node spikes/live-keyframe-tracks.mjs   (adds the manual minimized-window check)

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.env.KEEP === "1";
const MINIMIZE = process.env.MINIMIZE === "1";
const OUT = path.join(HERE, "results", "live-keyframe-tracks.json");
const NAME = "figma-mcp keyframe probe (delete me)";

const REPL = ["OPACITY", "TRANSLATION_X", "ROTATION"]; // every pool layer starts with these tracks
const ADDS = ["CORNER_RADIUS", "TRANSLATION_Y", "SCALE_X"]; // fields no pool layer has yet
const BASE = { OPACITY: 1, TRANSLATION_X: 0, ROTATION: 0, CORNER_RADIUS: 0, TRANSLATION_Y: 0, SCALE_X: 1 };
const OLD = { OPACITY: 0.5, TRANSLATION_X: 10, ROTATION: 5 };
const NEW = { OPACITY: 0.25, TRANSLATION_X: 77, ROTATION: 33, CORNER_RADIUS: 12, TRANSLATION_Y: 21, SCALE_X: 1.5 };
const CELLS = ["sameSync", "sameYield", "freshHandle", "realHandle", "keepIds", "setter", "adds", "tool"];
const TRIGGERS = ["png", "layer", "video"];
const POOL = CELLS.length * 2 + TRIGGERS.length;

const report = { startedAt: new Date().toISOString(), phases: [], triggers: [] };
const mcp = await connect({ allowEval: true });
const tools = new Set((await mcp.list()).map((t) => t.name));
if (!tools.has("figma_eval")) {
  console.error("figma_eval is not registered (BRIDGE_ALLOW_EVAL); this probe needs it.");
  process.exit(2);
}
const st = await mcp.call("figma_status", {});
const sess = st.data?.sessions?.find((s) => s.active) ?? st.data?.sessions?.[0];
if (!sess) {
  console.error("No Figma session: run the plugin in Figma first.");
  process.exit(2);
}
console.log(`file "${sess.file?.name}", build ${JSON.stringify(sess.build)}, role ${st.data?.bridge?.role}`);

// ── eval plumbing ───────────────────────────────────────────────────────────
const PRE = `
const F = (name) => ({ type: "PROPERTY", name });
const track = (from, to) => ({ keyframes: [
  { timelinePosition: 0, value: { type: "FLOAT", value: from } },
  { timelinePosition: 0.8, value: { type: "FLOAT", value: to }, easing: { type: "EASE_OUT" } },
] });
const tick = () => new Promise((r) => setTimeout(r, 0));
const lastOf = (n, f) => { const t = n.manualKeyframeTracks[f]; const k = t && t.keyframes; return k && k.length ? k[k.length - 1].value.value : null; };
const tl = (n) => { try { return (n.timelines || []).map((t) => t.id + "/" + Math.round(t.duration * 1000) / 1000).join(","); } catch (e) { return "ERR " + e.message; } };
const counter = () => { const r = figma.createRectangle(); const id = r.id; r.remove(); return id; };
const REPL = ${JSON.stringify(REPL)}, ADDS = ${JSON.stringify(ADDS)};
const BASE = ${JSON.stringify(BASE)}, OLD = ${JSON.stringify(OLD)}, NEW = ${JSON.stringify(NEW)};
`;

async function evalJs(code, timeoutMs = 60_000) {
  const r = await mcp.call("figma_eval", { code: PRE + code, timeoutMs }, { timeoutMs: timeoutMs + 30_000 });
  if (!r.ok) throw new Error(`figma_eval: ${r.text.slice(0, 300)}`);
  return r.data && "value" in r.data ? r.data.value : r.data;
}

const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 1e-4;
function classify(v, f) {
  if (v === null || v === undefined) return "missing";
  if (near(v, NEW[f])) return "new";
  if (f in OLD && near(v, OLD[f])) return "old";
  return `other:${v}`;
}
/** "all-new", "last-only" (the loss seen on 2026-10-09), or the per-field pattern. */
function verdict(values, fields) {
  const c = fields.map((f) => classify(values[f], f));
  if (c.every((x) => x === "new")) return "all-new";
  if (c.slice(0, -1).every((x) => x === "old") && c[c.length - 1] === "new") return "last-only";
  return fields.map((f, i) => `${f}=${c[i]}`).join(" ");
}

// ── the cells: three replacements on one layer, each in its own manner ─────
const CELL_CODE = {
  sameSync: (id) => `
    const n = await figma.getNodeByIdAsync(${JSON.stringify(id)});
    const ids = [counter()]; const seq = [{ step: "before", tl: tl(n) }];
    for (const f of REPL) { n.applyManualKeyframeTrack(F(f), track(BASE[f], NEW[f])); seq.push({ step: f, tl: tl(n), echo: REPL.map((g) => lastOf(n, g)) }); }
    ids.push(counter());
    return { handleId: n.id, seq, ids };`,
  sameYield: (id) => `
    const n = await figma.getNodeByIdAsync(${JSON.stringify(id)});
    const seq = [{ step: "before", tl: tl(n) }];
    for (const f of REPL) { n.applyManualKeyframeTrack(F(f), track(BASE[f], NEW[f])); await tick(); seq.push({ step: f, tl: tl(n), echo: REPL.map((g) => lastOf(n, g)) }); }
    return { handleId: n.id, seq };`,
  freshHandle: (id) => `
    const seq = [];
    for (const f of REPL) { const h = await figma.getNodeByIdAsync(${JSON.stringify(id)}); h.applyManualKeyframeTrack(F(f), track(BASE[f], NEW[f])); seq.push({ step: f, tl: tl(h) }); }
    return { seq };`,
  realHandle: (id) => `
    const h = await figma.getNodeByIdAsync(${JSON.stringify(id)});
    const real = h.parent.children.find((c) => c.name === h.name);
    for (const f of REPL) real.applyManualKeyframeTrack(F(f), track(BASE[f], NEW[f]));
    return { handleId: h.id, realId: real.id, sameObject: real === h };`,
  keepIds: (id) => `
    const n = await figma.getNodeByIdAsync(${JSON.stringify(id)}); const errors = [];
    for (const f of REPL) {
      const ex = n.manualKeyframeTracks[f];
      try { n.applyManualKeyframeTrack(F(f), { id: ex.id, baseValue: ex.baseValue, keyframes: track(BASE[f], NEW[f]).keyframes }); }
      catch (e) { errors.push(f + ": " + e.message); }
    }
    return { errors };`,
  setter: (id) => `
    const n = await figma.getNodeByIdAsync(${JSON.stringify(id)}); let error = null;
    try { n.manualKeyframeTracks = Object.assign({}, n.manualKeyframeTracks, Object.fromEntries(REPL.map((f) => [f, track(BASE[f], NEW[f])]))); }
    catch (e) { error = e.message; }
    return { error };`,
  adds: (id) => `
    const n = await figma.getNodeByIdAsync(${JSON.stringify(id)});
    const before = { cornerRadius: n.cornerRadius, opacity: n.opacity };
    for (const f of ADDS) n.applyManualKeyframeTrack(F(f), track(BASE[f], NEW[f]));
    return { before, after: { cornerRadius: n.cornerRadius, opacity: n.opacity }, echo: ADDS.map((g) => lastOf(n, g)) };`,
};

async function runCell(cell, id) {
  if (cell === "tool") {
    const r = await mcp.call("figma_set_keyframes", {
      nodeId: id,
      tracks: REPL.map((f) => ({ field: f, keyframes: [{ t: 0, value: String(BASE[f]) }, { t: 0.8, value: String(NEW[f]), easing: "EASE_OUT" }] })),
    });
    return { ok: r.ok, timeline: r.data?.timeline, echo: r.ok ? r.data.tracks.map((t) => t.keyframes.at(-1)?.value) : r.text.slice(0, 300) };
  }
  try {
    return await evalJs(CELL_CODE[cell](id));
  } catch (err) {
    return { error: String(err.message ?? err) };
  }
}

/** Read every cell's layer back in a later plugin request than the one that wrote it. */
async function readBack(map) {
  const raw = await evalJs(`
    const map = ${JSON.stringify(map)}; const out = {};
    for (const [cell, id] of Object.entries(map)) {
      const n = await figma.getNodeByIdAsync(id);
      out[cell] = { tl: tl(n), values: Object.fromEntries(REPL.concat(ADDS).map((f) => [f, lastOf(n, f)])) };
    }
    return out;`);
  const rows = {};
  for (const [cell, r] of Object.entries(raw)) {
    rows[cell] = { tl: r.tl, verdict: verdict(r.values, cell === "adds" ? ADDS : REPL), values: r.values };
    // The adds cell must also leave the three existing tracks at their OLD keys.
    if (cell === "adds") rows[cell].kept = REPL.map((f) => `${f}=${classify(r.values[f], f)}`).join(" ");
  }
  return rows;
}

/** Are layers inside the frame listed under other ids than the ones they were created with? */
async function rekeyed(frameId, created) {
  return evalJs(`
    const fr = await figma.getNodeByIdAsync(${JSON.stringify(frameId)});
    const created = ${JSON.stringify(created)};
    const tree = Object.fromEntries(fr.children.map((c) => [c.name, c.id]));
    const rows = [];
    for (const [name, id] of Object.entries(created)) {
      const h = await figma.getNodeByIdAsync(id);
      rows.push({ name, created: id, handleId: h ? h.id : null, treeId: tree[name] ?? null });
    }
    let restId = null;
    try { restId = (await fr.exportAsync({ format: "JSON_REST_V1" })).document.id; } catch (e) { restId = "ERR " + e.message; }
    const first = await figma.getNodeByIdAsync(Object.values(created)[0]);
    let playhead = null;
    try { playhead = figma.motion ? (figma.motion.playheadPosition ?? "none") : "no figma.motion"; } catch (e) { playhead = "ERR " + e.message; }
    return { frameHandleId: fr.id, frameRestId: restId, childTimeline: tl(first), playhead, firstOpacity: first.opacity,
      rekeyed: rows.filter((r) => r.treeId !== r.created).length, of: rows.length,
      sample: rows.filter((r) => r.treeId !== r.created).slice(0, 3) };`);
}

function print(label, rows) {
  console.log(`\n-- ${label}`);
  for (const [cell, r] of Object.entries(rows)) console.log(`  ${cell.padEnd(12)} ${String(r.verdict).padEnd(40)} tl ${r.tl}${r.kept ? `  (existing tracks: ${r.kept})` : ""}`);
}

// ── sandbox ─────────────────────────────────────────────────────────────────
const built = await evalJs(`
  const fr = figma.createFrame(); fr.name = ${JSON.stringify(NAME)}; fr.x = 52000; fr.y = 24000; fr.resize(1240, 200);
  const ids = {};
  for (let i = 0; i < ${POOL}; i++) {
    const r = figma.createRectangle(); r.name = "P" + i; r.resize(40, 40);
    r.x = 20 + (i % 20) * 60; r.y = 20 + Math.floor(i / 20) * 60; fr.appendChild(r); ids[r.name] = r.id;
  }
  return { frame: fr.id, ids };`);
const FRAME = built.frame;
const ids = Object.values(built.ids);
report.sandbox = built;

try {
  // Seed the OLD tracks one apply per host turn, then verify in a later request and repair.
  await evalJs(`
    for (const id of ${JSON.stringify(ids)}) for (const f of REPL) {
      const n = await figma.getNodeByIdAsync(id); n.applyManualKeyframeTrack(F(f), track(BASE[f], OLD[f])); await tick();
    }
    const n0 = await figma.getNodeByIdAsync(${JSON.stringify(ids[0])}); const [t] = n0.timelines; if (t) n0.setTimelineDuration(t.id, 1);
    return true;`, 300_000).catch((err) => {
    if (/not a supported API/i.test(String(err.message))) console.log("Motion is not enabled for this account [C-115]; nothing to probe.");
    throw err;
  });
  const seeded = await evalJs(`
    const bad = [];
    for (const id of ${JSON.stringify(ids)}) for (const f of REPL) {
      let n = await figma.getNodeByIdAsync(id);
      for (let i = 0; i < 3 && lastOf(n, f) !== OLD[f]; i++) { n.applyManualKeyframeTrack(F(f), track(BASE[f], OLD[f])); await tick(); n = await figma.getNodeByIdAsync(id); }
      if (lastOf(n, f) !== OLD[f]) bad.push(id + " " + f);
    }
    return bad;`, 300_000);
  if (seeded.length) console.log(`  note: seeding did not stick on ${seeded.join(", ")}`);

  let next = 0;
  const take = () => ids[next++];

  // ── phase A: a fresh frame ──
  const phase = async (label) => {
    const map = {};
    const notes = {};
    for (const cell of CELLS) {
      map[cell] = take();
      notes[cell] = await runCell(cell, map[cell]);
    }
    const rows = await readBack(map);
    print(label, rows);
    report.phases.push({ label, map, notes, rows, rekey: await rekeyed(FRAME, built.ids) });
    return rows;
  };
  await phase("A: fresh frame");

  // ── triggers, until one puts the frame into the losing state ──
  let reproduced = false;
  for (const trig of TRIGGERS) {
    const t0 = Date.now();
    let outcome;
    if (trig === "png") outcome = await mcp.call("figma_export_node", { nodeId: FRAME, scale: 0.25 });
    if (trig === "layer") outcome = await mcp.call("figma_create_rectangle", { parentId: FRAME, name: "layer-trigger", x: 1200, y: 160, width: 10, height: 10, fill: "#000000" });
    if (trig === "video") {
      console.log("\n  rendering a 1 s video; keep the Figma window restored (not minimized) …");
      outcome = await mcp.call("figma_export_video", { nodeId: FRAME, format: "MP4", fps: 12, quality: "LOW", width: 320 }, { timeoutMs: 600_000 });
    }
    const id = take();
    const note = await runCell("sameSync", id);
    const rows = await readBack({ sameSync: id });
    const rk = await rekeyed(FRAME, built.ids);
    const row = { trigger: trig, ok: outcome.ok, ms: Date.now() - t0, rekey: rk, sameSync: rows.sameSync, note };
    report.triggers.push(row);
    console.log(`\n-- trigger ${trig}: ${outcome.ok ? "ok" : outcome.text.slice(0, 120)} in ${row.ms} ms; re-keyed ${rk.rekeyed}/${rk.of}; frame REST id ${rk.frameRestId}; child timeline ${rk.childTimeline}; sameSync ${rows.sameSync.verdict}`);
    if (rows.sameSync.verdict !== "all-new") {
      reproduced = true;
      break;
    }
  }
  if (!reproduced) console.log("\n  none of the triggers reproduced the loss; phase B runs anyway, after them.");
  next = CELLS.length + TRIGGERS.length;
  await phase(`B: after ${report.triggers.map((t) => t.trigger).join(" + ")}${reproduced ? " (loss reproduced)" : ""}`);

  // ── optional: the minimized window ──
  if (MINIMIZE) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("\nMinimize the Figma window now, then press Enter here. ");
    const timers = await evalJs(`const d = []; let t = Date.now(); for (let i = 0; i < 10; i++) { await tick(); const n = Date.now(); d.push(n - t); t = n; } return d;`).catch((e) => String(e.message));
    const t0 = Date.now();
    const v = await mcp.call("figma_export_video", { nodeId: FRAME, format: "MP4", fps: 12, quality: "LOW", width: 320 }, { timeoutMs: 120_000 });
    const minimized = { timerGapsMs: timers, videoOk: v.ok, videoMs: Date.now() - t0, videoText: v.ok ? undefined : v.text.slice(0, 200) };
    await rl.question("Restore the Figma window now (it may stay behind other windows), then press Enter. ");
    const t1 = Date.now();
    await evalJs("return 1;", 600_000);
    minimized.queueFreeAfterRestoreMs = Date.now() - t1;
    rl.close();
    report.minimized = minimized;
    console.log(`\n-- minimized: timer gaps ${JSON.stringify(timers)}; video ${v.ok ? "finished" : "did not finish"} in ${minimized.videoMs} ms; plugin answered ${minimized.queueFreeAfterRestoreMs} ms after restore`);
  }
} finally {
  if (!KEEP) {
    await evalJs(`
      const f = await figma.getNodeByIdAsync(${JSON.stringify(FRAME)});
      const mine = f ?? figma.currentPage.children.find((c) => c.name === ${JSON.stringify(NAME)} && c.x === 52000 && c.y === 24000);
      if (mine) mine.remove();
      return !!mine;`).catch((e) => console.log(`  cleanup: ${e.message}`));
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\nsaved ${path.relative(process.cwd(), OUT)}`);
  await mcp.close();
}
```

## 5. The fix for defect 1, safe whatever the cause

**Principle.** Never report a track as written until a read in a LATER host turn, through a FRESH handle, shows it. Repair what did not land one track per host turn.

**Cost.** The happy path costs one extra host turn: about 18–20 ms with Figma in front [C-050], about 1 s with it in the background [C-124]. A per-track yield would instead cost a turn per track; for the ad's 189 tracks in the background, that is about 3 minutes, so it is not proposed.

Sketch for `setKeyframes.run` (src/plugin/ops/motion.ts), after `beforeMutating` as today:

```ts
writeAll(node, plans);                        // 1. today's loop and refusal handling, unchanged
await ctx.yieldToHost();                      // 2. one host turn: covers H1a commit, H1b stale handle, H3 stale echo
let live = (await byId(api(), nodeId)) as Motion;
let missing = plans.filter((p) => !landed(read(live, "manualKeyframeTracks"), p));
const attempts = new Map(plans.map((p) => [p.text, 1]));
for (let round = 0; round < 2 && missing.length > 0; round++) {   // 3. repair, one track per turn, fresh handle
  for (const p of missing) {
    live = (await byId(api(), nodeId)) as Motion;
    live.applyManualKeyframeTrack!(p.field, { keyframes: p.keyframes });   // or { id, baseValue, keyframes } if the probe favours keepIds
    attempts.set(p.text, attempts.get(p.text)! + 1);
    await ctx.yieldToHost();
  }
  live = (await byId(api(), nodeId)) as Motion;
  missing = plans.filter((p) => !landed(read(live, "manualKeyframeTracks"), p));
}
const top = live.getTopLevelFrame?.();        // 4. timeline read AFTER the tracks settle, from the fresh handle
const tl = firstTimeline(live);               //    this is the id setTimelineDuration must get [C-175] [C-176]
// grow or apply the duration as today with tl.id read here; yield; read the duration back
if (missing.length) throw new BridgeError(ErrorCode.INTERNAL, `Figma did not keep ${missing.map((p) => `"${p.text}"`).join(", ")} after 3 attempts.`, {
  hint: "Send each of these tracks alone with figma_set_keyframes, then check figma_get_motion_context. Seen in frames whose layer ids Figma had changed [C-179].",
  partial: { applied: plans.filter((p) => !missing.includes(p)).map((p) => p.text), notApplied: missing.map((p) => p.text) },
});
return { nodeId, name,
  tracks: plans.map((p) => ({ field: p.text, status: attempts.get(p.text) === 1 ? "written" : "rewritten", keyframes })),
  timeline: { id: tl.id, duration, topLevelFrameId: top?.id ?? null },
  ...(tl.id !== top?.id ? { timelineNote: "Figma reports this frame's timeline under another id; inside an animated frame Figma can change layer ids — keep using the ids your create calls returned." } : {}),
  extended, verified: true,
  ...(rewritten ? { note: `Figma dropped ${rewritten} track(s) on the first write; they were written again and verified.` } : {}) };
```

**Details:**
- **`landed(tracks, plan)`** compares through the existing string forms (`keyframesToText`, `valueToString` with r4 rounding). It checks:
  - the same number of keyframes;
  - each `t` within 1e-4;
  - each value as an equal string;
  - each easing only where the agent gave one, because Figma fills in the first key's easing (`cubic:0.5,0,0.5,1` in the run).
- **If the probe shows `keepIds` or `setter` accumulates** in the losing state, use that form in step 1 and keep the verification as a guard.
- **`partial` follows the repo convention**: `applied`, plus `notApplied` in place of `failedAt`. The call never claims `created: []`, because it wrote something.
- **`get_motion_context`**: key `timelineCohorts` by `getTopLevelFrame().id`, list every timeline id seen for that frame, and add a note when they differ. On 2026-10-09 one frame appeared under three ids: `42:15039`, `42:15160` and `47:2168`.
- **Tool description**: amend "each track replaces that field's keyframes; other tracks stay" to add "every track is read back; `tracks[].status` says written or rewritten".

**Unit tests to add (`test/motion.test.ts`).** They extend the fake class `M`. `run()` must pass a `yieldToHost` the fakes can hook.
1. **Coalescing fake (H1a).** Applies queue `{...committedAtRunStart, [field]: binding}`, and `yieldToHost` commits them. Assert:
   - all three replaced tracks end new;
   - two report `rewritten` and one `written`;
   - the echo matches the committed state.
2. **Stale-handle fake (H1b).** `getNodeByIdAsync` returns a new proxy that applies from its snapshot. Assert the call converges and the repair fetched a new handle for each track.
3. **Stale-read fake (H3).** Assert no re-applies (`applied.length === plans.length`) and that the echo comes from after the yield.
4. **Timeline-fork fake (H2).** Assert `topLevelFrameId` and `timelineNote` are present, and `setTimelineDuration` receives the id read after verification.
5. **Never-lands fake.** Assert an error with `partial {applied, notApplied}` (never `created: []`), at most 3 applies of the field, and a hint that names it.
6. **Cost bound.** On the normal fake, assert one apply per track and exactly one `yieldToHost` before verification.
7. **Batch.** Two `set_keyframes` steps under the coalescing fake are both verified.
8. **Cohorts.** One cohort per top-level frame, listing both timeline ids.

**Live acceptance.** The probe's `tool` cell is all-new in both phases, and `spikes/live-wpF-motion.mjs` stays green.

## 6. Defect 2: the client timeout and the minimized window

**What decides the timeout:**
- **The MCP spec** says senders should time out and cancel requests. They MAY reset the clock on progress, but should keep a maximum anyway [C-168]. So progress is permission, not a guarantee.
- **The installed TypeScript SDK (1.32.1)**:
  - defaults to 60 000 ms per request;
  - resets the timer on progress only when the caller sets `resetTimeoutOnProgress` (default false);
  - attaches a `progressToken` only if the caller passes `onprogress` [C-169] (this sharpens C-030).
- **figma-mcp without a progress token** falls back to `notifications/message`, which resets no timer (mcp-progress.ts).
- **Claude Code CLI (docs)** [C-170]:
  - the per-server `timeout` is a hard wall-clock limit that progress does not extend;
  - HTTP, SSE and connector servers also have a 60 s per-request timer;
  - stdio servers have no per-request timer, and their 30-minute idle check aborts only when a call sends neither a response nor progress.
- **The 2026-10-09 session** ran inside the Claude desktop app (entrypoint `claude-desktop`, using the server registered in claude_desktop_config.json over stdio). That path cut the call at 60.4 s, despite an initial progress notification. Which timer did it, and whether progress could have reset it, is unknown [C-171].

**Conclusion.** No server-side measure guarantees that a single request outlives every client's timer, so the fix must not depend on it.

**The fix, client-agnostic first:**
1. **Never discard a finished render.**
   - In `registerExportVideo`, do not pass `extra.signal` to the bridge; use a private AbortController that fires only if the session drops. The render cannot be stopped in Figma anyway (`exportAsync` has no cancel), so cancelling only wastes it.
   - When the bytes arrive, `shapeVideo` writes the file whether or not the caller still waits.
   - Keep a per-process registry: a fingerprint of (session, nodeId, format, fps, quality, loopCount, width, height, scale, saveTo) maps to `{ promise, startedAt, result? }`, kept for 15 minutes.
2. **Answer before the client gives up.**
   - Add a `waitS` budget, defaulting to `BRIDGE_VIDEO_WAIT_MS` = 45 000, which is under the 60 s seen. Race the render against it.
   - If the render is still running, return ok with `{ status: "rendering", elapsedS, path when saveTo is known, hint }`. The hint says: "Call figma_export_video again with the same arguments to collect the file. Do not start another render; other figma-mcp calls wait until it ends."
   - A repeat call with the same fingerprint attaches to the running render, or returns the finished one at once with `reused: true` — but only if no write tool ran through this process after the render started. Otherwise it renders again.
   - This mirrors the official server's job-and-poll pattern [C-176]. It works with 60 s clients, with Hermes (300 s and no Tasks [C-031] [C-043]), and with Claude Code over stdio.
3. **Heartbeat progress, capped.**
   - While `exportAsync` is pending, the plugin calls `ctx.progress(elapsedSeconds, undefined, "rendering MP4: 12 s")` every 5 s, through `timerDelay()` from chunk.ts. The values increase monotonically, as [C-029] requires.
   - This keeps a call alive in any client that resets its clock on progress, and satisfies Claude Code's idle check [C-170].
   - Heartbeats would also re-arm the bridge's idle timer forever, so add `Job.maxTotalMs` (15 minutes for video) and arm the idle timer with `min(idleTimeoutMs, deadline − now)`.
   - If timers stop while Figma is minimized [C-173], the heartbeats stop too, and the stall surfaces after the idle window — 120 s for video once heartbeats exist — rather than after 600 s.
4. **Explain a stall.** The STALLED hint for export_video becomes: "No render finished. A minimized Figma window stops video export [C-174]. Ask the user to restore Figma. Do not start another export; the first is still running in Figma."
5. **Later: MCP Tasks.** Return `CreateTaskResult` only to clients that declared the `tasks` capability [C-044].
6. **Later, after the probe: detect a minimized window.**
   - The plugin's UI iframe could report `document.visibilityState` and `visibilitychange` to `figma_status`.
   - MDN counts a minimized window as `hidden` [C-172]; whether Figma's plugin iframe follows that is unmeasured [C-173].
   - Until then, warn rather than refuse.

**Tests:**
- `test/export-video.test.ts` (fake bridge, fake timers):
  - a 90 s render with `waitS: 45` returns `rendering`; the file is written later; an identical second call returns it without a second `bridge.request`;
  - a client abort does not reach `bridge.request`;
  - a write between the two calls forces a new render;
  - different arguments never attach to another call's render.
- `test/motion.test.ts`:
  - with a 12 s fake `exportAsync`, progress arrives at about 5 s and 10 s with increasing values, and none after the result;
  - when `timerDelay()` returns null, there is no heartbeat and no crash.
- `test/bridge.test.ts`: a plugin that sends progress every second forever ends as STALLED at `maxTotalMs`, with the video hint. Progress re-arms the idle timer but not the cap.
- **Live:**
  - the probe in `MINIMIZE=1` mode;
  - a 15 s 1080×1920 render through a 60 s client (the Claude desktop path) must return `rendering`, then be collected.

## 7. Guide text proposals (`figma_get_guide motion`, src/server/guides.ts `MOTION`)

Add to Rules:
- One figma_set_keyframes call may carry several tracks. Every track is read back after writing, and a track Figma dropped is written again. `tracks[].status` says `written` or `rewritten`. If the call fails with `notApplied`, send those tracks one per call and check figma_get_motion_context.
- Inside an animated frame, Figma can list layers under new ids. The ids your create calls returned keep working for writes; ids read from the tree may not. When `timelineNote` appears, keep using your own ids.
- Setting keyframes can change a layer's stored values: for example, opacity becomes 0 when the first key is 0. Check the resting layout with figma_export_node BEFORE keyframing, and check motion with video frames after.

Replace Recipe step 4 with:

> 4. Verify with figma_export_video { nodeId: <frame>, format: "GIF", fps: 12, width: 480, frames: [0, 0.2, 0.4] }.
>    - A long or large render takes tens of seconds; a 14 s 1080×1920 ad took 28–47 s.
>    - If the tool answers `status: "rendering"`, call it again with exactly the same arguments to collect the file. Do not change the arguments, and do not start a second render. Every other figma-mcp call waits until the render ends.
>    - Keep Figma's window restored while a video renders. A minimized Figma window stops the render; one stalled about 40 minutes until the window was restored. If a render does not finish, ask the user to restore Figma. Never minimize or move it yourself, and never retry in a loop.
>    - Judge motion from the frames: one per phase (start, middle, settle), rendered small. Fix every problem before rendering again.

For `figma_get_guide safety`, or the client setup notes:
- Some MCP clients cancel any call after 60 s; figma_export_video answers before that.
- A user who wants one long call can raise the limit. In Claude Code, that is the per-server `timeout` in `.mcp.json` or `MCP_TOOL_TIMEOUT` [C-170].

## 8. Related defects in the same record (for triage, out of scope)

- **`figma_move_nodes` inside `figma_batch`** reported ok without moving the layer (S3/Kiln-mask). Given both x and y, it moved only y on the S3 circles (tool-findings.md:3 and :7; fix:r2 08:19:49–08:20:16). The moved layers may have been aliases at the time; the probe's re-key detector can tell.
- **Base values overwritten by keyframing**: by the t=0 keys at build time, and by values from about 3.6 s at 08:09. The probe's `adds` before/after reads and the detector's `playhead` and `firstOpacity` measure this. `baseValue` in `ManualKeyframeTrackInput` [C-175] may be the lever.
- **`figma_export_node` refused a `saveTo` inside the scratchpad** (every builder hit this). This is a roots or guide issue.

## 9. Claims

Only the main agent edits `docs/reference/claims.md`.

None of the `to-verify` or `contradiction` records carries a design decision. The fixes in sections 5 and 6 hold either way, and the guide's minimized-window line is a harmless warning if it proves wrong.

The records are in the structured `claims` list: C-168 to C-179.

Existing ids relied on:
- C-012 and C-013: a `setTimeout` turn yields to the host; a microtask does not;
- C-029: progress values must increase;
- C-030: now sharpened by C-169;
- C-031 and C-043: Hermes has 300 s and no Tasks;
- C-044: MCP Tasks;
- C-050: one host turn costs about one frame;
- C-115: the motion API;
- C-116: video export;
- C-124: background timer turns take about 1 s.

## 10. Open questions

- **If no trigger reproduces the loss**, the remaining candidates are:
  - a Figma reconnect, which should not be scripted on the user's machine;
  - playing or scrubbing the timeline in Figma's own Motion UI.

  Run the probe with `KEEP=1`, press play on the sandbox frame's timeline in Figma, and re-run phase B alone. That needs a small `PHASE=B FRAME=<id>` option.
- **Does the losing state also hit `removeManualKeyframeTrack` in one run?** `remove_keyframes` loops the same way, and the same verify-and-repair applies. A removal cell would settle it.
- **Should read-only calls bypass a long render in the bridge's sequential queue?** The plugin already runs requests concurrently. But this would touch protocol.md's sequencing guarantee, so it is not proposed here.

## Claims proposed

- (verified (2026-10-13)) C-168: MCP spec 2025-11-25 (Timeouts): senders SHOULD set timeouts and send a cancellation when one expires; they MAY reset the clock when a progress notification arrives, but SHOULD still enforce a maximum timeout.
  Source: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts says implementations "MAY choose to reset the timeout clock when receiving a progress notification"; accessed 2026-10-13
- (verified (2026-10-13)) C-169: Installed @modelcontextprotocol/sdk 1.32.1: DEFAULT_REQUEST_TIMEOUT_MSEC = 60000; a progress notification resets a request's timer only if the request set resetTimeoutOnProgress (default false); maxTotalTimeout caps it regardless; a progressToken is attached only when the caller passes onprogress. Sharpens C-030, whose source is vague.
  Source: node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js lines 8, 181-200, 452-466, 671-678, 740-742; protocol.d.ts lines 57, 75-89 (resetTimeoutOnProgress documented as 'Default: false'); read 2026-10-13
- (verified (2026-10-13)) C-170: Claude Code CLI: a per-server `timeout` in .mcp.json is a hard wall-clock limit per tool call that progress does not extend. HTTP, SSE and claude.ai connector servers also get a 60 s per-request timer (raised by a tool timeout or MCP_TIMEOUT above 60 s); stdio and WebSocket servers get none. An idle check aborts a call that sends no response and no progress for 5 min (network) or 30 min (stdio). MCP_TOOL_TIMEOUT defaults to about 28 h.
  Source: https://code.claude.com/docs/en/mcp (sections 'Per-server timeout and MCP_TOOL_TIMEOUT' and 'Idle timeout'; describes the per-server timeout as 'a hard wall-clock limit per tool call') and https://code.claude.com/docs/en/env-vars (MCP_TOOL_TIMEOUT, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT); accessed 2026-10-13
- (to-verify) C-171: In the 2026-10-09 run, figma-mcp reached the Claude Code session through the Claude desktop app's MCP config, and that path cancelled figma_export_video at 60.4 s ('Request timed out') despite an initial progress notification. Which timer did it, and whether progress could reset it, is unknown.
  Source: Transcript subagents/workflows/wf_c23489f2-d18/agent-a1777da56c7750563.jsonl, 08:21:10->08:22:10 and 08:23:15->08:24:15 UTC; %APPDATA%/Claude/claude_desktop_config.json (server figma-mcp over stdio); session entrypoint claude-desktop, version 2.1.293
- (verified (2026-10-13)) C-172: A page's document.visibilityState is 'hidden' when the document is part of a minimized window (also for a background tab or a locked screen).
  Source: https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilityState says hidden covers a document that is "part of a minimized window"; accessed 2026-10-13
- (to-verify) C-173: In Figma desktop, a plugin's UI iframe reports visibilityState 'hidden' while Figma is minimized, and sandbox timers keep firing there (possibly throttled, cf. C-124).
  Source: Unmeasured. The probe's MINIMIZE=1 mode measures the timers; reading the iframe's state needs a plugin change.
- (to-verify) C-174: Figma's video export does not progress while the Figma window is minimized; restoring the window lets the render finish.
  Source: Observed once on 2026-10-09: a stall of about 40 min that finished after a SW_SHOWNOACTIVATE restore (scratchpad/motion/tool-findings.md line 9). The probe's MINIMIZE=1 mode reproduces it under control.
- (verified (2026-10-13)) C-175: Plugin typings 1.141.0: ManualKeyframeTrackInput takes optional id and baseValue; ManualKeyframeInput takes an optional id; applyManualKeyframeTrack applies or replaces the track for ONE field; timelines currently returns the containing top-level frame's timeline; setTimelineDuration takes an id read from timelines; manualKeyframeTracks is declared readonly.
  Source: node_modules/@figma/plugin-typings/plugin-api.d.ts v1.141.0 lines 6033-6049, 6798, 6800-6812, 6853-6875, 6894-6908; read 2026-10-13
- (verified (2026-10-13)) C-176: The official figma-use-motion skill (figma plugin 2.2.120): when editing an existing track, keep its id, baseValue and keyframe ids; setTimelineDuration must get the timeline id returned by the same node; the official export_video returns a jobId with status 'processing' and is polled by calling it again.
  Source: ~/.claude/plugins/cache/claude-plugins-official/figma/2.2.120/skills/figma-use-motion/references/motion-patterns.md lines 59, 193, 551; SKILL.md line 63; read 2026-10-13
- (contradiction) C-177: Whether manualKeyframeTracks can be assigned: the official skill writes the whole object (node.manualKeyframeTracks = {...existing, ...}), but the typings declare the property readonly.
  Source: figma-use-motion/references/motion-patterns.md lines 130-146 vs plugin-api.d.ts v1.141.0 line 6798. The probe's 'setter' cell settles it.
- (contradiction) C-178: Several applyManualKeyframeTrack replacements on one node in one synchronous run can keep only the last; the other fields keep their previous keys. This contradicts 'replaces the track for one field' (C-175). On 2026-10-08 (C-115) and in the 2026-10-09 build phase, multi-track calls that added fields accumulated; the losing state is intermittent.
  Source: 2026-10-09 transcripts: agent-ac1159054d208b4a0.jsonl (fix:r1, 07:46:48; a separate read at 07:46:54 still showed old keys) and agent-a1777da56c7750563.jsonl (fix:r2, 08:18:41: 7 of 7 multi-track steps, 11 tracks lost). The live probe settles the mechanism.
- (to-verify) C-179: Inside an animated top-level frame, Figma can re-key layers. The parent lists them under new ids (with the current session's prefix); the originally created ids still resolve, and a handle reports the id it was fetched by; some intermediate ids later fail writes as 'not found'; timelines[0].id then reports the frame's newest id (42:15160, 47:2168) or a transient fresh id (47:559, 47:1151). Trigger unknown (candidates: video export, a Figma reconnect, timeline playback or scrubbing, structural edits).
  Source: 2026-10-09 transcripts: S1 builder agent-a37477464064c40cf 07:05:48 (42:15082 listed as 42:15162); fix:r1 07:43:49 (45:442 not found); fix:r2 08:09:30-08:13:43 (children 47:2169..., REST id 47:2339); fix:r3 notes (52:776). The probe's re-key detector measures it.
