# figma_move_nodes defects of 2026-10-09: diagnosis

Scope: the three defects reported while agents built the Moku motion ad (`motion/tool-findings.md`, plan record `docs/superpowers/plans/2026-10-09-figjam-slides.md` § Defects found while building the motion ad). Sources: every figma-mcp call and result in the 30 subagent transcripts under `subagents/workflows/wf_c23489f2-d18/agent-*.jsonl`, plus the code at `a6ebb06`. No repo file was edited. The test, the fix and the probe live next to this file in `skills/bugmove/`.

## Verdict

1. **Defects (1) and (2) are the same defect.** Neither one is in the batch path or the id normaliser. All three failing moves had two things in common:
   - Figma was listing the ad's layers under **second ids** at the time.
   - The move went through the id the create call had returned (the **held id**).

   The move wrote `x` and then `y`. `y` landed and `x` went back to its old value. `src/plugin/ops/modify.ts:449-450` writes them as two separate setters. Line 451 then reports `ok: true` without reading anything back:

   ```ts
   if (x !== undefined) movable.x = relative ? movable.x + x : x;   // 449
   if (y !== undefined) movable.y = relative ? movable.y + y : y;   // 450: x is back at its old value after this
   items.push(item);                                                // 451: ok: true, never checked
   ```

   The code follows the Plugin API contract. But x and y are both the translation of one matrix, the node's `relativeTransform` [C-168]. Writing them as two setters touches that matrix twice, and nothing checks the result. The fix writes the matrix once and reads it back.
2. **Defect (2) changed two things at once.** The batch step used the held id `42:15337`. The standalone call that "worked" used the listed id `42:15357`. The same fake gives identical results in a batch and in a standalone call.
3. **The `45:` ids were not "readable but not writable". They had expired.** They were second ids with the prefix 45. They resolved from 07:32 to 07:38. By 07:43, writes failed **and so did a read** of the same id 8 s later. Our normaliser passes `45:442` through unchanged, and `getNodeByIdAsync` resolved it to `null` [C-171].

## What the record shows

All times are UTC on 2026-10-09. A **period** is a stretch of time when Figma listed the ad's layers under second ids [C-169]. During a period:

- The parent's `children` list the second id.
- `getTopLevelFrame()` and `timelines[0].id` name a second root.
- `figma_get_node format:"rest"` returns the second id as `document.id`.
- For the first ad, the page listed **two** top-level frames with the same name. This was not checked during the v2 periods.
- The held id still resolves, and reads through either id agree.

| When | What was seen | Source (agent, call) |
|---|---|---|
| 02:58–03:01 | First ad: motion context names timeline `30:14989` for frame `30:14651`. The page lists both `30:14651` and `30:14989`, same name, same position. Both list the same children `30:14990…`. The REST export of `30:14651` says `document.id: "30:14989"` | inventory: get_motion_context 02:58:40, get_design_context(0:1) 03:01:01, get_nodes_info 03:01:06, get_node rest 03:01:13 |
| 07:05:26 | `30:14989` → NODE_NOT_FOUND (that period is over) | scene:S3 get_variable_defs |
| 07:05:29–07:05:32 | Period starts for the v2 ad. Ids `42:15110–42:15198` are minted while no figma-mcp call returns any of them. The second root is `42:15160`. Before 07:05:25 the REST id equals the plugin id; at 07:05:56 `42:15091` exports as `42:15184` | id ranges of all create calls; scene:S5 / S4 get_node rest |
| 07:05–07:09 | Every subtree created under the frame gets its second ids straight away: `42:15321–40` (S3/Type) then `42:15341–60`; `42:15421` (Cream circle) then `42:15422` | scene:S3 create results, get_node 07:08:20 |
| **07:06:55** | **figma_batch**: `resize_nodes 42:15337` to 236×144, then `move_nodes 42:15337 {x:243, y:452}`. Both steps answered `ok: true` | scene:S3 batch |
| 07:08:27 | `42:15337` and `42:15357` read identically: **x 260**, y 452, **w 236**. The resize landed and the x did not | scene:S3 get_nodes_info |
| 07:08:32 | `move_nodes 42:15357 {x:243, y:452}` (the **listed** id) → reads x 243 | scene:S3 |
| 07:26 | Period off: timeline `42:15039` | critic:design:r1 |
| 07:32–07:39 | Period on, prefix 45: frame `42:15039` lists `45:381…` and the timeline is `45:380`. `45:529…` read fine at 07:38:47. Figma stalls for 30 s at 07:37:49 | fix:r1 |
| **07:43:49–52** | Six `move_nodes` on `45:` ids → `"not found"` | fix:r1 |
| 07:43:57 | `get_nodes_info 45:442` → `"not found on the reachable pages"`: **the read fails too** | fix:r1 |
| 07:44:02 | `42:15039` lists `42:15040…` again (period off). Five x+y moves through 42: ids then land (e.g. S2/Price x 600 → 703) | fix:r1 |
| 07:45:48 / 07:46:17 | New node `47:558` (prefix 47). The next call returns timeline `47:559`, and at 07:46:18 it is `42:15039` again | fix:r1 |
| 08:03–08:20:05 | Period on, prefix 47: children `47:2169…`, root `47:2168`. REST of `42:15421` = `47:2283` | critic:design:r2, fix:r2 |
| **08:19:49** | `move_nodes [42:15421, 42:15423] {x:-1158, y:-241}` → both `ok: true`. Readback: **x -1176**, y -262 → -241 | fix:r2 |
| **08:19:56 / 08:20:02** | Repeated absolute; then `relative {x:18, y:0}` → x still -1176, both `ok: true` | fix:r2 |
| 08:20:15 / 08:20:28 | x-only moves → x -1158 on both circles | fix:r2 |
| 08:20:26 | Period off (`topLevelFrameId 42:15039`). By 08:20:34 new nodes carry `50:` | fix:r2 |
| 09:24–09:25:43 | Period on, prefix 52: S3 lists `52:814…`, REST `52:814` reads fine | fix:r3 |
| 09:29:17 / 09:30:03 | `52:791` → NODE_NOT_FOUND; `set_fills 52:814` → `"not found"`; `set_fills 42:15253` (the held id of the same layer) → ok | fix:r3 |

At least one period did not start in one of our calls. The `42:15160` set was minted while no figma-mcp write was creating ids, and S1's next create took 4 s instead of under 1 s. One short period (`47:559`) followed one of our creates within 30 s. Two periods ended around a change of prefix (45 → 47, 47 → 50). The trigger is unknown [C-172].

## Defects (1) and (2): root cause

### Best-supported hypothesis (H1): two writes, one stale matrix

`x` is `relativeTransform[0][2]` and `y` is `relativeTransform[1][2]` [C-168]. H1 makes two assumptions. First, each setter rewrites the whole matrix. Second, through a held id during a period, each rewrite starts from the matrix as it was when the node was resolved. The `y` write then puts the old `x` back. H1 accounts for every move in the record:

| Move | H1 predicts | Record |
|---|---|---|
| held id, x+y, absolute (×2) | x lost, y kept | x -1176, y -241 |
| held id, relative x+18, y+0 | x lost | x -1176 |
| held id, batch: resize step then move step | each step resolves the node again, so the resize lands and x is lost | w 236, x 260 |
| listed id, x+y | both land | x 243 |
| held id outside a period, x+y | both land | S2/Price, masks, S1/Window at 07:44 |
| held id, one write per field during a period (resize; two keyframe tracks at 07:08:03) | land | landed |

Not settled by the record:

- **Single-coordinate writes through a held id during a period.** The 08:20:15 x-only success is confounded: the period ended between 08:20:05 and 08:20:26.
- **Fresh lookups inside the same op.** We do not know whether a fresh `getNodeByIdAsync` in the same op sees the new value. The fix's readback assumes it does; the probe measures it.

### Other hypotheses, and why they rank lower

- **H2: the last write through a held object wins, whatever the field.** Rejected by the S3 batch, where the resize and the move ran in one op and the resize landed. Also rejected by two keyframe tracks on one held object at 07:08:03, which both landed. One multi-track loss is on record: 07:46:17, three tracks with only the last kept. It came in the second a new root (`47:559`) was minted, so a period starting in the middle of the call fits it better. That belongs to the keyframe defect. The probe's `held: two keyframe tracks` row covers it.
- **H3: a timeline track drives x.** Ruled out: the circles carry OPACITY, SCALE_XY and blur, and the Kiln mask carries no track at all.
- **H4: the auto-layout ignores x.** Ruled out: both containers have `layout: "none"`.
- **H5: the batch path changes the move.** Ruled out. The server parses the step with the tool's own zod shape (`src/server/tools/batch.ts:127`). `normalizeIdParams` visits `steps` (`src/server/figma-url.ts:168-176`). The plugin runs `ops[op].run({ ...quiet, params })` (`src/plugin/ops/batch.ts:116`), which is the same op with the same params. The unit test below shows identical results.
- **H6: a stale plugin build.** Ruled out: lines 449–450 are unchanged since `3b99cfc` (2026-10-07), before the run.

### What still made the defects worse in our code

- `modify.ts:451` answers `ok: true` without reading the position back. All three failing moves reported success, and the agents found out only from later reads.
- `batch.ts:116,133`: a step's `ok: true` means "the step ran". The S3 builder took it to mean "the node moved". Here the item's own `ok` was also wrong, because of `modify.ts:451`. But even a correct `ok: false` item is easy to miss under a step that says `ok: true`.

## Defect (3): where the twin ids come from

Each candidate from the brief, checked against the record:

- **Instance sublayer ids.** No. Those have the form `I<instance>;<id>`, and these containers are plain frames.
- **A copied frame.** Not a plain copy:
  - Both ids of a pair read the same values.
  - The held frame lists the second children.
  - Writes through the held id show up through the second id: the resize at 07:06:55 shows as w 236 on `42:15357`.
  - The second ids disappear on their own.

  It does look like one in a single respect: during a period the page lists a second top-level frame with the same name.
- **The Motion timeline id.** Yes, this is the same thing. `30:14989` (the "timeline" of `30:14651`), `42:15160`, `45:380`, `47:559`, `47:1151`, `47:2168` and `52:740` are each the second root of a period. `getTopLevelFrame()` and `timelines[0].id` return the second root, not the frame the user sees.
- **The REST id against the plugin id.** Yes. During a period, `exportAsync({ format: "JSON_REST_V1" })` of a held id returns the second id as `document.id`. `figma_get_node format:"rest"` shows both at once: our `nodeId` (held) and `rest.document.id` (second). Examples: `42:15091` → `42:15184`, `42:15421` → `47:2283`, `30:14651` → `30:14989`.
- **Session-scoped minting.** The prefix changes over the run (30, 42, 45, 47, 52) and looks like the client's session:
  - Our plugin created `47:558` at 07:45:48. The second root `47:559` appeared right after it.
  - Our first node after the 47 period was `50:380` (08:20:34).

  The probe records `figma.currentUser.sessionId` to confirm this. The second ids are minted in DFS order (`45:380` frame, `45:381` S1 · Hook, `45:382` S1/Window, `45:383` S1/Photo …). The held ids, the ones create returned, worked from start to finish. The second ids stopped resolving when their period ended: 07:43:57, 07:47:01 (`47:559`), 09:29:17.

What our code does with them:

- `toNodeId` (`src/server/figma-url.ts:72`, the check is at :94) matches `45:442` against `PLAIN_ID` and only swaps `-` for `:`, so the id reaches the plugin unchanged.
- `resolveAll` (`modify.ts:56-61`) and `getNodesInfo` (`ops/read.ts:252`) call `figma.getNodeByIdAsync(id)`. That resolves to `null` for an id Figma no longer knows [C-171], which we report as `"not found"` / `"not found on the reachable pages"`.
- The `byId` hint (`src/plugin/read.ts:431`, "on another page, or deleted") is wrong for this case.

Nothing in our id handling creates, maps or loses these ids.

Practical rule (after the probe, for the guides): address layers by the ids your create calls returned. Under an animated frame, ids read from a listing (children, motion context, REST) may be temporary [C-169].

## The failing test

`test/move-held-id.test.ts`, a new file. It runs against the existing modify and batch ops, with a fake that models H1. The fake's numbers and ids come from the record.

```ts
// figma_move_nodes on a layer that Figma also lists under a second id.
//
// On 2026-10-09, while Figma listed the layers of an animated ad under second
// ids, three moves that set both x and y through the id the agent held kept
// y and lost x. Two were standalone moves of the S3 circles; one was a
// figma_batch step on the S3 Kiln mask. Each one answered ok: true. An x-only
// move through the same id worked, and so did x and y together through the
// listed id [C-170]. x and y are one stored value: x is relativeTransform[0][2]
// and y is relativeTransform[1][2] [C-168]. Two setters are therefore two
// rewrites of one matrix. The fake below rewrites the matrix from the state
// the node was resolved in, which reproduces every move in the record.
// spikes/live-move-twins.mjs checks whether Figma really does this.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { makeBatchOp } from "../src/plugin/ops/batch.js";
import { MODIFY_OPS } from "../src/plugin/ops/modify.js";

type Matrix = number[][];
interface Layer { name: string; type: string; x: number; y: number; width: number; height: number }

const ctx = (params: Record<string, unknown>): OpContext => ({
  requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
});
const container = { id: "42:15042", name: "S3 · Collection", type: "FRAME", layoutMode: "NONE" };

/**
 * The layer reached through the id the agent held (the one its create call
 * returned). Reads are live. Each x / y setter writes the whole matrix,
 * starting from the matrix as it was when this object was resolved.
 */
function held(id: string, layer: Layer) {
  const resolved = { x: layer.x, y: layer.y };
  return {
    id, name: layer.name, type: layer.type, parent: container,
    get width() { return layer.width; },
    get height() { return layer.height; },
    get x() { return layer.x; },
    get y() { return layer.y; },
    set x(v: number) { layer.x = v; layer.y = resolved.y; },
    set y(v: number) { layer.y = v; layer.x = resolved.x; },
    get relativeTransform(): Matrix { return [[1, 0, resolved.x], [0, 1, resolved.y]]; },
    set relativeTransform(m: Matrix) { layer.x = m[0]![2]!; layer.y = m[1]![2]!; },
    resize(w: number, h: number) { layer.width = w; layer.height = h; },
  };
}

/** The same layer through the id its parent lists: an ordinary node. */
function listed(id: string, layer: Layer) {
  return {
    id, name: layer.name, type: layer.type, parent: container,
    get width() { return layer.width; },
    get height() { return layer.height; },
    get x() { return layer.x; },
    set x(v: number) { layer.x = v; },
    get y() { return layer.y; },
    set y(v: number) { layer.y = v; },
    get relativeTransform(): Matrix { return [[1, 0, layer.x], [0, 1, layer.y]]; },
    set relativeTransform(m: Matrix) { layer.x = m[0]![2]!; layer.y = m[1]![2]!; },
    resize(w: number, h: number) { layer.width = w; layer.height = h; },
  };
}

let cream: Layer;
let kiln: Layer;
beforeEach(() => {
  // Positions and ids from the record: S3/Cream circle and S3/Kiln-mask.
  cream = { name: "S3/Cream circle", type: "ELLIPSE", x: -1176, y: -262, width: 3000, height: 3000 };
  kiln = { name: "S3/Kiln-mask", type: "FRAME", x: 260, y: 452, width: 250, height: 144 };
  const ids: Record<string, () => unknown> = {
    "42:15421": () => held("42:15421", cream), // held id (create returned it)
    "47:2283": () => listed("47:2283", cream), // listed id, as REST and the parent named it
    "42:15337": () => held("42:15337", kiln),
    "42:15357": () => listed("42:15357", kiln),
  };
  // A fresh object per lookup, as getNodeByIdAsync returns one per call.
  (globalThis as { figma?: unknown }).figma = { getNodeByIdAsync: async (id: string) => ids[id]?.() ?? null };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

type Moved = { moved: number; items: Array<{ id: string; ok: boolean; error?: string }> };

describe("move_nodes through a held id", () => {
  it("x and y together land both (the record: x stayed -1176, y moved to -241)", async () => {
    const r = (await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["42:15421"], x: -1158, y: -241 }))) as Moved;
    expect({ x: cream.x, y: cream.y }).toEqual({ x: -1158, y: -241 });
    expect(r.items[0]!.ok).toBe(true);
  });

  it("a relative move lands too (the record: x +18, y +0 left x at -1176)", async () => {
    await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["42:15421"], x: 18, y: 0, relative: true }));
    expect({ x: cream.x, y: cream.y }).toEqual({ x: -1158, y: -262 });
  });

  it("x alone already worked, and still does", async () => {
    await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["42:15421"], x: -1158 }));
    expect({ x: cream.x, y: cream.y }).toEqual({ x: -1158, y: -262 });
  });

  it("the listed id already worked with x and y, and still does", async () => {
    await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["47:2283"], x: -1158, y: -241 }));
    expect({ x: cream.x, y: cream.y }).toEqual({ x: -1158, y: -241 });
  });
});

describe("the same move as a figma_batch step", () => {
  const steps = (id: string) => [
    { op: "resize_nodes", params: { nodeIds: [id], width: 236, height: 144 } },
    { op: "move_nodes", params: { nodeIds: [id], x: 243, y: 452 } },
  ];

  it("lands both coordinates (the record: Kiln-mask resized to 236 but stayed at x 260)", async () => {
    await makeBatchOp(() => MODIFY_OPS).run(ctx({ steps: steps("42:15337") }));
    expect({ x: kiln.x, y: kiln.y, width: kiln.width }).toEqual({ x: 243, y: 452, width: 236 });
  });

  it("behaves exactly like the standalone call: the batch path is not the cause", async () => {
    await MODIFY_OPS.resize_nodes!.run(ctx({ nodeIds: ["42:15337"], width: 236, height: 144 }));
    await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["42:15337"], x: 243, y: 452 }));
    const standalone = { ...kiln };
    kiln.x = 260;
    kiln.width = 250;
    await makeBatchOp(() => MODIFY_OPS).run(ctx({ steps: steps("42:15337") }));
    expect(kiln).toEqual(standalone);
  });
});

describe("ok means the layer is where it was asked to be", () => {
  it("a move Figma does not keep is ok: false with where the layer is, and the batch says so", async () => {
    // A layer whose writes are dropped: the worst case the record allows.
    const stuck = { id: "9:1", name: "Stuck", type: "ELLIPSE", parent: container, x: 10, y: 20, width: 5, height: 5 };
    Object.defineProperty(stuck, "x", { get: () => 10, set: () => {} });
    Object.defineProperty(stuck, "y", { get: () => 20, set: () => {} });
    Object.defineProperty(stuck, "relativeTransform", { get: () => [[1, 0, 10], [0, 1, 20]], set: () => {} });
    (globalThis as { figma?: unknown }).figma = { getNodeByIdAsync: async (id: string) => (id === "9:1" ? stuck : null) };

    const r = (await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["9:1"], x: 30, y: 40 }))) as Moved;
    expect(r.moved).toBe(0);
    expect(r.items[0]).toMatchObject({ id: "9:1", ok: false });
    expect(r.items[0]!.error).toMatch(/x is 10.*y is 20|x 10.*y 20/);

    const b = (await makeBatchOp(() => MODIFY_OPS).run(ctx({ steps: [{ op: "move_nodes", params: { nodeIds: ["9:1"], x: 30, y: 40 } }] }))) as {
      itemsFailed?: Array<{ step: number; op: string; id: string }>;
    };
    expect(b.itemsFailed).toEqual([expect.objectContaining({ step: 0, op: "move_nodes", id: "9:1" })]);
  });
});
```

**On the current code (`a6ebb06`), 4 tests fail and 3 pass.** Each failure matches the record:

```
× x and y together land both …         expected { x: -1176, y: -241 } to deeply equal { x: -1158, y: -241 }
× a relative move lands too …          expected { x: -1176, y: -262 } to deeply equal { x: -1158, y: -262 }
× lands both coordinates (batch) …     expected { x: 260, y: 452, width: 236 } to deeply equal { x: 243, y: 452, width: 236 }
× a move Figma does not keep …         expected 1 to be +0   (moved: 1, ok: true)
✓ x alone · ✓ listed id · ✓ batch behaves exactly like the standalone call
```

## The fix

Full patch: `skills/bugmove/fix.diff`. `git apply --check` passes on the repo. It touches `src/plugin/ops/modify.ts`, `src/plugin/ops/batch.ts`, `test/layout-structure.test.ts` and the new test.

1. **One write for both coordinates** (`modify.ts`, new `place()`). When both are given, write `relativeTransform = [[m00, m01, tx], [m10, m11, ty]]` once, keeping the 2×2 part as read. When only one is given, the single setter stays as it is.
2. **Read back before saying ok** (`modify.ts`, new `offTarget()`). The op looks the id up again with `getNodeByIdAsync` and compares x and y within 0.01 px. A miss becomes `ok: false` with an error that says where the layer is, for example `Figma kept it at x -1176, y -241 (asked x -1158, y -241)`. For an auto-layout child that is not absolute, the error says the layout places it. Today such a write is silently ignored and reported as success; C-098 already records that Figma ignores it.
3. **The batch lists failures inside completed steps** (`batch.ts`). The success result gains `itemsFailed: [{ step, op, id, error }]` when any item failed, so a step's `ok: true` can no longer hide one.
4. **Test fake** (`test/layout-structure.test.ts`). The `N` class gets a `relativeTransform` setter that writes through `x` and `y`, so the existing write-order test still records `x=280, y=-8` after `layoutPositioning=ABSOLUTE`.

Core of the change:

```ts
function place(node: Movable, tx: number | undefined, ty: number | undefined): void {
  const m = tx !== undefined && ty !== undefined ? node.relativeTransform : undefined;
  if (isMatrix(m)) {
    node.relativeTransform = [[m[0]![0]!, m[0]![1]!, tx!], [m[1]![0]!, m[1]![1]!, ty!]];
    return;
  }
  if (tx !== undefined) node.x = tx;
  if (ty !== undefined) node.y = ty;
}
// in the loop, replacing lines 449-451:
const tx = x === undefined ? undefined : relative ? movable.x + x : x;
const ty = y === undefined ? undefined : relative ? movable.y + y : y;
place(movable, tx, ty);
const off = tx === undefined && ty === undefined ? null : await offTarget(id, tx, ty);
if (off) { items.push({ id, ok: false, error: /* where it is, and what to do */ }); continue; }
items.push(item);
```

**Verified in a scratch copy of the repo** (`skills/bugmove/copy`, with a junction to the repo's `node_modules`):

- Before the patch: 63 files, 1263 tests pass.
- After the patch, with the new test: 64 files, **1270 tests pass**.
- `tsc -p tsconfig.json` and `tsc -p src/plugin/tsconfig.sandbox.json` both exit 0.

The one assumption only the live probe can settle is that a fresh `getNodeByIdAsync` in the same op returns the new value through a held id. If the probe shows it does not, `offTarget` should read the listed node instead: `parent.children` matched by name, or `exportAsync JSON_REST_V1`.

### Follow-ups the patch does not cover

- **The same two-setter pattern exists elsewhere.**
  - `rotate_nodes` (`modify.ts:1021-1025`: `rotation`, then `x +=`, then `y +=`, which is three rewrites of the matrix). It can compute one final matrix and write it once.
  - `reparent_nodes` (`modify.ts:904-908`).
  - `clone_node` (`modify.ts:773-774`), though that writes a fresh copy.

  Moving `place()` into `src/plugin/write.ts` and using it in those ops covers all of them.
- **Tool descriptions.**
  - `figma_move_nodes` (`src/server/tools/modify.ts:89-101`): x and y are written in one assignment and read back, and an item whose position did not land is `ok: false`.
  - `figma_batch` (`src/server/tools/batch.ts:152`): the success shape gains `itemsFailed?`.
  - The same two lines in `docs/reference/tools.md:239` and `:267`. That file is locked: `attrib -R`, edit, `node scripts/lock-docs.mjs --update`, `attrib +R`.
- **"Not found" hint, after the probe.** Add to the `byId` hint and to the per-item "not found": an id read from a listing of an animated frame can be temporary, so use the id the create call returned or read the parent again [C-169].
- **Guides.** Add the practical rule above to the motion topic of `src/server/guides.ts`.
- **Keyframe defect owner.** The only multi-track loss on record (07:46:17) came together with a fresh second root (`47:559`), minted right after the layer fix:r1 had just created (`47:558`, S3/Warm, 07:45:48). Treat it as a period starting during the call. The probe has a row for it.
- **Aside.** Reads of an animated property were not stable between calls with no write in between: Terracotta circle `opacity` was 0 at 08:19:52 and 1 at 08:20:21. Worth checking alongside the "keyframes overwrite the resting value" note.

## The live probe

File: `skills/bugmove/live-move-twins.mjs`. Copy it to `spikes/live-move-twins.mjs`. It uses `spikes/mcp-client.mjs` and needs `figma_eval`: `connect({ allowEval: true })` sets `BRIDGE_ALLOW_EVAL=1`. Run it with `npm run build`, re-run the plugin, then `node spikes/live-move-twins.mjs` (optional `WAIT_S=900 KEEP=1`). Do not minimise the Figma window.

What it does:

1. **Sandbox.** One top-level frame, `figma-mcp move-twin probe (delete me)`, at x 46000 / y 26000, holding a `layout: none` container. Inside the container:
   - a 3000 px ellipse at (-1176, -262), like the record's circles;
   - a 250×144 clipping frame at (260, 452), like the Kiln mask;
   - a keyed rectangle, so the frame is animated.

   The probe deletes the frame at the end unless `KEEP=1`. It deletes nothing else.
2. **Detector** (raw Plugin API through `figma_eval`). Each reading records:
   - `figma.currentUser.sessionId`;
   - the circle's REST `document.id`, `getTopLevelFrame().id`, `timelines[0].id` and parent chain;
   - the parent's listed child ids;
   - the page's frames with the probe's name.

   A period is on when the REST id or listed id differs from the held id, or when the page shows two frames with the probe's name.
3. **Baseline matrix** (expected to pass everywhere), then **wait for a period**. Nudges, in this order:
   - re-key the timeline (`timelineDuration`);
   - create two layers and record the id gap (during a period, every creation is followed at once by its second id);
   - export a GIF;
   - print "press Play on the probe frame's timeline in Figma", then poll every 5 s.
4. **The matrix during a period.** Each row starts from (-1176, -262), restored with single-coordinate moves. Each row is read back three ways: the same object, a fresh lookup in the same eval, and `figma_get_nodes_info` on both ids in a later call.

   | Row | Isolates |
   |---|---|
   | `held: x then y (setters)`, raw | whether Figma itself loses x (H1), with no figma-mcp code involved |
   | `held: one relativeTransform`, raw | whether the fix's single write lands |
   | `held: x, fresh lookup, then y`, raw | whether a fresh resolution between the writes is enough |
   | `listed: x then y (setters)`, raw | the record's working path |
   | `held: rename then x`, raw | whether the loss is limited to the matrix (H1) or affects any earlier write (H2) |
   | `held: two keyframe tracks`, raw | the keyframe defect's shape through a held id |
   | `tool: move_nodes x+y (held / listed)`, `tool: batch move_nodes x+y (held)` | the shipped tool. The old build should reproduce (1) and (2); the patched build should land, or answer `ok: false` |

5. **Lifetime.** Keep the listed ids and poll until the period ends. Then read and write (`figma_set_opacity 1`) both kinds of id. This checks whether the second ids expire for reads and writes alike, and whether the held ids keep working.

Output: `spikes/results/live-move-twins.json`.

How to read it:

| Result | Conclusion |
|---|---|
| raw `held: x then y` loses x; `one relativeTransform` lands | H1 is confirmed; ship the fix as is; register C-170's mechanism as `measured` |
| raw rows all land, `tool:` held row loses x | the cause is in our code path after all; diff the eval against `moveNodes` |
| `rename then x` loses the name as well | H2: every op that writes twice through a held id is exposed. Resolve the listed node once per item and write through it |
| fresh lookup in the same eval reads stale values | change `offTarget` to read the listed node |
| no period within `WAIT_S` | only the baseline ran; the result is inconclusive. Re-run while Figma shows the timeline |

## Proposed claim records (next free id: C-168)

| ID | Claim | Status | Source | Checked |
|---|---|---|---|---|
| C-168 | In the Plugin API, `x` is the node's `relativeTransform[0][2]` and `y` is `relativeTransform[1][2]`, so both are the translation column of one matrix. (That each setter rewrites the whole matrix is our inference, H1, and the probe tests it.) For a child of an auto-layout frame, setting either is a no-op | verified | `node_modules/@figma/plugin-typings/plugin-api.d.ts` v1.141.0:7240 (*"The position of the node. Identical to `relativeTransform[0][2]`."*), :7248 (the same for y, `[1][2]`), :7244 and :7252 (the auto-layout no-op remark); see also https://developers.figma.com/docs/plugins/api/node-properties (the `@see` at :7236) | 2026-10-13 |
| C-169 | For periods lasting from about a second to about 20 minutes, Figma lists the layers of an animated top-level frame under **second ids**. These are minted in DFS order from a second root and carry the id prefix that new nodes get at that time (`47:558` new, then `47:559` second root). During a period: the parent's `children`, `getTopLevelFrame()`, `timelines[0].id` and the `JSON_REST_V1` `document.id` give the second ids; each layer created under the frame gets its second id at once; for the first ad, the page listed a second top-level frame with the same name. The id returned at creation keeps resolving, reads through either id agree, and writes through it show through the second id. When the period ends, the second ids stop resolving for reads and writes, and the created ids are listed again | measured | 2026-10-09 run, transcripts `subagents/workflows/wf_c23489f2-d18/agent-*.jsonl`: inventory 03:01:01–03:01:13 (`30:14651` / `30:14989`), scene:S3 07:08:20–07:08:27, fix:r1 07:32:40 / 07:43:49–07:44:02, fix:r2 08:09:30 / 08:20:05, fix:r3 09:25:43 / 09:29:17–09:30:06 | 2026-10-09 |
| C-170 | During such a period, `figma_move_nodes` with both x and y through the created id kept y and lost x three times: two circles (x stayed -1176, y -262 → -241; repeated absolute and relative), and the Kiln mask as a `figma_batch` step after a resize step that landed (x stayed 260, width 236). Each answered `ok: true`. The same move through the listed id landed, and so did x+y moves through created ids outside periods. Whether Figma rewrites the matrix from the resolved state (H1) is for the probe to show | measured | Same transcripts: scene:S3 07:06:55, 07:08:27, 07:08:32; fix:r2 08:19:49–08:20:29; fix:r1 07:44:06–07:45:16 | 2026-10-09 |
| C-171 | `figma.getNodeByIdAsync(id)` resolves to `null` when the id is invalid or the node cannot be found. figma-mcp reports that as `"not found"` / NODE_NOT_FOUND | verified | `plugin-api.d.ts` v1.141.0:418-421 (*"returns a promise containing null"*) | 2026-10-13 |
| C-172 | What starts and ends a C-169 period is unknown. One started while no figma-mcp call was creating ids (07:05:29–07:05:32); two ended around a change of session prefix (45 → 47, 47 → 50). Playback, video export, reconnection and our own keyframe writes are all candidates | to-verify | Same transcripts; `spikes/live-move-twins.mjs` must be run to settle it | 2026-10-13 |

C-168 and C-171 can carry the fix now. C-169 and C-170 are measurements on this machine (`measured` is the registry's status for that). C-172 must not carry anything until the probe runs. The main agent has to add these rows before the test or code comments citing them are committed, because `check-claims` fails on an unknown id.

## Files

- `skills/bugmove/move-held-id.test.ts`: the failing test, ready for `test/`.
- `skills/bugmove/fix.diff`: the patch (modify.ts, batch.ts, layout-structure test fake, new test).
- `skills/bugmove/live-move-twins.mjs`: the probe, ready for `spikes/`.
- `skills/bugmove/copy/`: the scratch copy where the suite was run before and after. Its `node_modules` junction was removed afterwards, so a recursive delete of the scratchpad cannot reach the repo. To run it again: `New-Item -ItemType Junction -Path copy/node_modules -Target <repo>/node_modules`. `skills/bugmove/run-old/` holds the run of the new test against the unmodified repo.
- `skills/tx.mjs`, `window.mjs`, `byname.mjs`, `timeline.mjs`, `tree.mjs`: the transcript queries behind the timeline table.
