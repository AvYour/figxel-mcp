// figma_move_nodes on a layer that Figma also lists under a second id.
//
// On 2026-10-09, while Figma listed the layers of an animated ad under second
// ids, three moves that set both x and y through the id the agent held kept
// y and lost x. Two were standalone moves of the S3 circles; one was a
// figma_batch step on the S3 Kiln mask. Each one answered ok: true. An x-only
// move through the same id worked, and so did x and y together through the
// listed id [C-203]. x and y are one stored value: x is relativeTransform[0][2]
// and y is relativeTransform[1][2] [C-186]. Two setters are therefore two
// rewrites of one matrix. The fake below rewrites the matrix from the state
// the node was resolved in, which reproduces every move in the record.
// rotate, reparent and clone wrote the same matrix through successive
// setters, so they are pinned here too. spikes/live-move-twins.mjs checks
// whether Figma really does this.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import { makeBatchOp } from "../src/plugin/ops/batch.js";
import { MODIFY_OPS } from "../src/plugin/ops/modify.js";

type Matrix = number[][];
interface Layer { name: string; type: string; x: number; y: number; width: number; height: number; rotation: number }

const ctx = (params: Record<string, unknown>): OpContext => ({
  requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
});

/** A layout-free container that can take children, as S3 · Collection was. */
const container = {
  id: "42:15042", name: "S3 · Collection", type: "FRAME", layoutMode: "NONE", children: [] as Array<{ id: string; parent?: unknown }>,
  insertChild(i: number, c: { id: string; parent?: unknown }) {
    this.children = this.children.filter((k) => k.id !== c.id);
    this.children.splice(i, 0, c);
    c.parent = this;
  },
  appendChild(c: { id: string; parent?: unknown }) {
    this.insertChild(this.children.length, c);
  },
};

const turn = (deg: number, x: number, y: number): Matrix => {
  const r = (deg * Math.PI) / 180;
  return [[Math.cos(r), Math.sin(r), x], [-Math.sin(r), Math.cos(r), y]];
};

/**
 * The layer reached through the id the agent held (the one its create call
 * returned). Reads are live. Each setter of x, y or rotation writes the whole
 * matrix, starting from the matrix as it was when this object was resolved.
 */
function held(id: string, layer: Layer) {
  const resolved = { ...layer };
  return {
    id, name: layer.name, type: layer.type, parent: container as unknown,
    get width() { return layer.width; },
    get height() { return layer.height; },
    get x() { return layer.x; },
    get y() { return layer.y; },
    get rotation() { return layer.rotation; },
    set x(v: number) { Object.assign(layer, { x: v, y: resolved.y, rotation: resolved.rotation }); },
    set y(v: number) { Object.assign(layer, { y: v, x: resolved.x, rotation: resolved.rotation }); },
    set rotation(v: number) { Object.assign(layer, { rotation: v, x: resolved.x, y: resolved.y }); },
    get relativeTransform(): Matrix { return turn(resolved.rotation, resolved.x, resolved.y); },
    set relativeTransform(m: Matrix) {
      Object.assign(layer, { rotation: (Math.atan2(-m[1]![0]!, m[0]![0]!) * 180) / Math.PI, x: m[0]![2]!, y: m[1]![2]! });
    },
    resize(w: number, h: number) { layer.width = w; layer.height = h; },
  };
}

/** The same layer through the id its parent lists: an ordinary node. */
function listed(id: string, layer: Layer) {
  return {
    id, name: layer.name, type: layer.type, parent: container as unknown,
    get width() { return layer.width; },
    get height() { return layer.height; },
    get x() { return layer.x; },
    set x(v: number) { layer.x = v; },
    get y() { return layer.y; },
    set y(v: number) { layer.y = v; },
    get rotation() { return layer.rotation; },
    set rotation(v: number) { layer.rotation = v; },
    get relativeTransform(): Matrix { return turn(layer.rotation, layer.x, layer.y); },
    set relativeTransform(m: Matrix) { layer.x = m[0]![2]!; layer.y = m[1]![2]!; },
    resize(w: number, h: number) { layer.width = w; layer.height = h; },
  };
}

let cream: Layer;
let kiln: Layer;
let ids: Record<string, () => unknown>;
beforeEach(() => {
  container.children = [];
  // Positions and ids from the record: S3/Cream circle and S3/Kiln-mask.
  cream = { name: "S3/Cream circle", type: "ELLIPSE", x: -1176, y: -262, width: 3000, height: 3000, rotation: 0 };
  kiln = { name: "S3/Kiln-mask", type: "FRAME", x: 260, y: 452, width: 250, height: 144, rotation: 0 };
  ids = {
    "42:15421": () => held("42:15421", cream), // held id (create returned it)
    "47:2283": () => listed("47:2283", cream), // listed id, as REST and the parent named it
    "42:15337": () => held("42:15337", kiln),
    "42:15357": () => listed("42:15357", kiln),
    [container.id]: () => container,
  };
  // A fresh object per lookup, as getNodeByIdAsync returns one per call.
  (globalThis as { figma?: unknown }).figma = { getNodeByIdAsync: async (id: string) => ids[id]?.() ?? null };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

type Items = { items: Array<{ id: string; ok: boolean; error?: string; pivot?: string }>; hint?: string };
type Moved = Items & { moved: number };

describe("move_nodes through a held id", () => {
  it("x and y together land both (the record: x stayed -1176, y moved to -241)", async () => {
    const r = (await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["42:15421"], x: -1158, y: -241 }))) as Moved;
    expect({ x: cream.x, y: cream.y }).toEqual({ x: -1158, y: -241 });
    expect(r.items[0]!.ok).toBe(true);
  });

  it("a relative move lands too (the record: x +18, y +0 left x at -1176)", async () => {
    const r = (await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["42:15421"], x: 18, y: 0, relative: true }))) as Moved;
    expect({ x: cream.x, y: cream.y }).toEqual({ x: -1158, y: -262 });
    expect(r.items[0]!.ok).toBe(true);
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

describe("ok means the layer is where it was asked to be [C-250]", () => {
  /** A layer whose writes are dropped: the worst case the record allows. */
  function stuck(parent: unknown = container) {
    const node = { id: "9:1", name: "Stuck", type: "ELLIPSE", parent, x: 10, y: 20, width: 5, height: 5, rotation: 0 };
    for (const [k, v] of [["x", 10], ["y", 20], ["rotation", 0]] as const) Object.defineProperty(node, k, { get: () => v, set: () => {} });
    Object.defineProperty(node, "relativeTransform", { get: () => [[1, 0, 10], [0, 1, 20]], set: () => {} });
    ids["9:1"] = () => node;
    return node;
  }

  it("a move Figma does not keep is ok: false with where the layer is, and the batch says so", async () => {
    stuck();
    const r = (await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["9:1"], x: 30, y: 40 }))) as Moved;
    expect(r.moved).toBe(0);
    expect(r.items[0]).toMatchObject({ id: "9:1", ok: false });
    expect(r.items[0]!.error).toMatch(/Figma kept it at x 10, y 20 \(asked x 30, y 40\)/);

    const b = (await makeBatchOp(() => MODIFY_OPS).run(ctx({ steps: [{ op: "move_nodes", params: { nodeIds: ["9:1"], x: 30, y: 40 } }] }))) as {
      steps: Array<{ ok: boolean }>;
      itemsFailed?: Array<{ step: number; op: string; id: string; error: string }>;
    };
    expect(b.steps[0]!.ok).toBe(true); // the step ran…
    expect(b.itemsFailed).toEqual([{ step: 0, op: "move_nodes", id: "9:1", error: expect.stringMatching(/Figma kept it at x 10/) }]); // …and its node did not move
  });

  it("an auto-layout child that ignores x/y says its layout places it", async () => {
    stuck({ id: "4:1", name: "Row", type: "FRAME", layoutMode: "HORIZONTAL" });
    const r = (await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["9:1"], x: 30 }))) as Moved;
    expect(r.items[0]!.error).toMatch(/auto-layout places it — positioning "absolute"/);
  });

  it("a turn Figma does not keep is ok: false too", async () => {
    stuck();
    const r = (await MODIFY_OPS.rotate_nodes!.run(ctx({ nodeIds: ["9:1"], angle: 30 }))) as Items;
    expect(r.items[0]).toMatchObject({ ok: false, error: expect.stringMatching(/Figma kept it at rotation 0, x 10, y 20 \(asked rotation 30/) });
  });

  it("an id that resolves to nothing says an id read from a listing can be temporary [C-199]", async () => {
    const r = (await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["45:442"], x: 1 }))) as Moved;
    expect(r.items).toEqual([{ id: "45:442", ok: false, error: "not found" }]);
    expect(r.hint).toMatch(/can be temporary.*Use the id your create call returned/);
    const fine = (await MODIFY_OPS.move_nodes!.run(ctx({ nodeIds: ["47:2283"], x: 1 }))) as Moved;
    expect(fine.hint).toBeUndefined();
  });
});

describe("the other ops that wrote the matrix through successive setters", () => {
  it("rotate_nodes: the turn and the drift back are one write, so neither is lost through a held id", async () => {
    kiln.rotation = 0;
    const r = (await MODIFY_OPS.rotate_nodes!.run(ctx({ nodeIds: ["42:15337"], angle: 90 }))) as Items;
    // The centre (260 + 125, 452 + 72) stays put: a 90° turn puts the top-left at (385 - 72, 524 + 125).
    expect(kiln.rotation).toBeCloseTo(90, 6);
    expect([kiln.x, kiln.y].map((v) => Math.round(v * 1000) / 1000)).toEqual([313, 649]);
    expect(r.items[0]).toMatchObject({ ok: true, pivot: "center" });
  });

  it("rotate_nodes: a mirrored node keeps Figma's own setter, then one write for the drift", async () => {
    const writes: string[] = [];
    const node = {
      id: "9:2", name: "Mirrored", type: "RECTANGLE", parent: container, width: 100, height: 50, x: 10, y: 20, rotation: 0,
      get relativeTransform(): Matrix {
        const [[a, b], [c, d]] = turn(this.rotation, 0, 0) as [[number, number], [number, number]];
        return [[-a, b, this.x], [-c, d, this.y]]; // flipped horizontally
      },
      set relativeTransform(m: Matrix) {
        writes.push("relativeTransform");
        this.x = m[0]![2]!;
        this.y = m[1]![2]!;
      },
    };
    const logged: typeof node = new Proxy(node, {
      set(t, k, v): boolean {
        if (k === "rotation" || k === "x" || k === "y") writes.push(String(k));
        return Reflect.set(t, k, v, logged);
      },
    });
    ids["9:2"] = () => logged;
    const r = (await MODIFY_OPS.rotate_nodes!.run(ctx({ nodeIds: ["9:2"], angle: 90 }))) as Items;
    expect(writes.slice(0, 2)).toEqual(["rotation", "relativeTransform"]);
    expect(r.items[0]).toMatchObject({ ok: true, pivot: "center" });
  });

  it("reparent_nodes: x and y in the new parent land together through a held id", async () => {
    const r = (await MODIFY_OPS.reparent_nodes!.run(ctx({ nodeIds: ["42:15421"], parentId: container.id, x: -1158, y: -241 }))) as Items;
    expect({ x: cream.x, y: cream.y }).toEqual({ x: -1158, y: -241 });
    expect(r.items[0]!.ok).toBe(true);
  });

  it("clone_node: the copy's x and y land together, and a position Figma did not keep is a warning", async () => {
    const copy: Layer = { ...cream, name: "Copy" };
    const source = Object.assign(held("42:15421", cream), { clone: () => held("50:380", copy) });
    ids["42:15421"] = () => source;
    ids["50:380"] = () => held("50:380", copy);
    container.children = [source];
    const r = (await MODIFY_OPS.clone_node!.run(ctx({ nodeId: "42:15421", x: 40, y: 60 }))) as { id: string; warning?: string };
    expect(r.id).toBe("50:380");
    expect({ x: copy.x, y: copy.y }).toEqual({ x: 40, y: 60 });
    expect(r.warning).toBeUndefined();

    const frozen = { ...cream, name: "Frozen" };
    ids["42:15421"] = () => Object.assign(held("42:15421", cream), { clone: () => ({ ...held("50:381", frozen), id: "50:381" }) });
    ids["50:381"] = () => ({ id: "50:381", x: 0, y: 0 });
    const w = (await MODIFY_OPS.clone_node!.run(ctx({ nodeId: "42:15421", x: 40, y: 60 }))) as { warning?: string };
    expect(w.warning).toMatch(/Figma kept it at x 0, y 0 \(asked x 40, y 60\)/);
  });
});
