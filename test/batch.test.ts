// figma_batch: several edits in one call and one undo step [C-096].
//
// Plugin side: steps run in order as the real ops, stop at the first failure,
// and say how far they got; anything a batch may not hold is refused before
// the first step runs. Server side: every step is validated against the shape
// its own tool registered, so a bad step fails with its path and nothing is
// forwarded.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import { OPS } from "../src/shared/ops.js";
import type { OpContext, PluginOp } from "../src/plugin/ops/index.js";
import { makeBatchOp, notBatchable } from "../src/plugin/ops/batch.js";
import { MODIFY_OPS } from "../src/plugin/ops/modify.js";
import type { Bridge } from "../src/server/bridge.js";
import { batchRefusal, createShapeRecorder, registerBatch, validateSteps } from "../src/server/tools/batch.js";
import { registerModify } from "../src/server/tools/modify.js";
import { registerStyle } from "../src/server/tools/style.js";

const ctx = (params: Record<string, unknown>, cancelled = () => false): OpContext => ({
  requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: cancelled,
});

const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as BridgeError;
  }
  throw new Error("expected a failure");
};

// ── plugin ───────────────────────────────────────────────────────────────────

describe("the batch op", () => {
  let ran: string[];
  /** Stub ops under real batchable names; `fail` makes one throw. */
  function table(fail?: { op: string; err: BridgeError }): Record<string, PluginOp> {
    const stub = (op: string): PluginOp => ({
      write: true,
      async run(c) {
        ran.push(`${op}:${JSON.stringify(c.params)}`);
        if (fail?.op === op) throw fail.err;
        return { op, ok: true };
      },
    });
    return { rename_node: stub("rename_node"), set_opacity: stub("set_opacity"), set_visible: stub("set_visible"), delete_nodes: stub("delete_nodes") };
  }
  beforeEach(() => {
    ran = [];
  });

  it("is one write op, and runs its steps in order with their own params", async () => {
    const op = makeBatchOp(() => table());
    expect(op.write).toBe(true);
    const r = (await op.run(ctx({ steps: [
      { op: "rename_node", params: { nodeId: "1:2", name: "Card" } },
      { op: "figma_set_opacity", params: { nodeIds: ["1:2"], opacity: 0.5 } },
    ] }))) as { steps: Array<{ index: number; op: string; ok: boolean }>; completed: number };
    expect(ran).toEqual(['rename_node:{"nodeId":"1:2","name":"Card"}', 'set_opacity:{"nodeIds":["1:2"],"opacity":0.5}']);
    expect(r.completed).toBe(2);
    expect(r.steps.map((s) => `${s.index}:${s.op}:${s.ok}`)).toEqual(["0:rename_node:true", "1:set_opacity:true"]);
  });

  it("passes each step's own progress on in batch units, so a long step does not read as stalled", async () => {
    // Six slow set_keyframes steps once answered STALLED: the batch muted its steps' progress, so
    // the bridge's idle timer saw nothing between step boundaries.
    const ticks: Array<[number, number | undefined]> = [];
    let yields = 0;
    const slow: PluginOp = {
      write: true,
      async run(c) {
        for (let k = 1; k <= 3; k++) c.progress(k, 3, "tracks");
        return { ok: true };
      },
    };
    const op = makeBatchOp(() => ({ ...table(), set_opacity: slow }));
    await op.run({
      ...ctx({ steps: [
        { op: "rename_node", params: { nodeId: "1:2", name: "Card" } },
        { op: "figma_set_opacity", params: { nodeIds: ["1:2"], opacity: 0.5 } },
      ] }),
      progress: (done, total) => void ticks.push([done, total]),
      yieldToHost: async () => void yields++,
    });
    expect(ticks).toContainEqual([1 + 2 / 3, 2]);
    expect(ticks.at(-1)).toEqual([2, 2]);
    expect(yields).toBeGreaterThanOrEqual(2);
  });

  it("stops at the first failure and reports what was applied and where it stopped", async () => {
    const op = makeBatchOp(() => table({ op: "set_opacity", err: new BridgeError(ErrorCode.INVALID_PARAM, "`opacity` must be between 0 and 1.", { partial: { created: [] } }) }));
    const e = await fails(op.run(ctx({ steps: JSON.stringify([
      { op: "rename_node", params: { nodeId: "1:2", name: "A" } },
      { op: "set_opacity", params: { opacity: 3 } },
      { op: "set_visible", params: { nodeIds: ["1:2"], visible: false } },
    ]) })));
    expect(ran.map((r) => r.split(":")[0])).toEqual(["rename_node", "set_opacity"]);
    expect(e.message).toMatch(/^steps\[1\] \(set_opacity\): /);
    // Step 0 changed the document, so the batch did too — even though step 1 changed nothing.
    expect(e.partial).toMatchObject({ failedAt: 1, steps: [{ index: 0, op: "rename_node", ok: true }], stepPartial: { created: [] } });
    expect((e.partial as { created?: unknown }).created).toBeUndefined();
  });

  it("only a first step that changed nothing makes the whole batch unchanged", async () => {
    const untouched = makeBatchOp(() => table({ op: "rename_node", err: new BridgeError(ErrorCode.NODE_NOT_FOUND, "No node.", { partial: { created: [] } }) }));
    expect((await fails(untouched.run(ctx({ steps: [{ op: "rename_node", params: {} }] })))).partial).toEqual({ created: [], failedAt: 0 });
    const unknown = makeBatchOp(() => table({ op: "rename_node", err: new BridgeError(ErrorCode.INTERNAL, "boom") }));
    expect((await fails(unknown.run(ctx({ steps: [{ op: "rename_node", params: {} }] })))).partial).toEqual({ steps: [], failedAt: 0 });
  });

  it.each([
    [[{ op: "delete_nodes", params: {} }], /destructive/],
    [[{ op: "create_frame", params: {} }], /create op/],
    [[{ op: "group_nodes", params: {} }], /new ids/],
    [[{ op: "batch", params: {} }], /cannot hold another batch/],
    [[{ op: "teleport", params: {} }], /not a Figxel op/],
    [[{ op: "rename_node", params: [] }], /params` must be an object/],
    [[{ op: "rename_node", extra: 1 }], /not a step field/],
    [[], /1–50/],
  ])("refuses %j before any step runs", async (steps, message) => {
    const e = await fails(makeBatchOp(() => table()).run(ctx({ steps: [{ op: "rename_node", params: {} }, ...steps].slice(steps.length ? 0 : 1) })));
    expect(e.message).toMatch(message);
    expect(e.partial).toEqual({ created: [] });
    expect(ran).toEqual([]);
  });

  it("an op this plugin window does not implement is refused up front, with the restart hint", async () => {
    const e = await fails(makeBatchOp(() => ({})).run(ctx({ steps: [{ op: "set_opacity", params: {} }] })));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.partial).toEqual({ created: [] });
  });

  it("a cancel between steps stops the batch with what was done", async () => {
    let n = 0;
    const e = await fails(makeBatchOp(() => table()).run(ctx({ steps: [
      { op: "rename_node", params: {} }, { op: "set_visible", params: {} },
    ] }, () => n++ > 0)));
    expect(e.code).toBe("CANCELLED");
    expect(e.partial).toMatchObject({ failedAt: 1, steps: [{ op: "rename_node" }] });
  });

  describe("with the real ops", () => {
    const nodes = new Map<string, Record<string, unknown>>();
    beforeEach(() => {
      nodes.clear();
      nodes.set("1:2", { id: "1:2", name: "Frame 1", type: "FRAME", opacity: 1, visible: true });
      (globalThis as { figma?: unknown }).figma = { getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null };
    });
    afterEach(() => {
      delete (globalThis as { figma?: unknown }).figma;
    });

    it("runs MODIFY_OPS steps as if each were its own call", async () => {
      const r = (await makeBatchOp(() => MODIFY_OPS).run(ctx({ steps: [
        { op: "rename_node", params: { nodeId: "1:2", name: "Hero" } },
        { op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 0.4 } },
        { op: "set_visible", params: { nodeIds: ["1:2", "9:9"], visible: false } },
      ] }))) as { steps: Array<{ ok: boolean; result: { items?: Array<{ ok: boolean }> } }>; itemsFailed?: unknown };
      expect(nodes.get("1:2")).toMatchObject({ name: "Hero", opacity: 0.4, visible: false });
      expect(r.steps[2]!.result.items!.map((i) => i.ok)).toEqual([true, false]); // per-item results survive
      // The step ran, so it is ok; the node it could not change is listed where it cannot be missed [C-203].
      expect(r.steps[2]!.ok).toBe(true);
      expect(r.itemsFailed).toEqual([{ step: 2, op: "set_visible", id: "9:9", error: "not found" }]);
    });

    it("a batch whose every node changed has no itemsFailed", async () => {
      const r = (await makeBatchOp(() => MODIFY_OPS).run(ctx({ steps: [{ op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 0.4 } }] }))) as Record<string, unknown>;
      expect(r).toEqual({ steps: [expect.objectContaining({ index: 0, op: "set_opacity", ok: true })], completed: 1 });
    });
  });
});

describe("plugin and server agree on what a batch may hold", () => {
  it("for every op in the catalog", () => {
    for (const op of OPS.keys()) expect(`${op}:${notBatchable(op) === null}`).toBe(`${op}:${batchRefusal(op) === null}`);
    expect(notBatchable("set_fills")).toBeNull();
    expect(notBatchable("undo_step")).toMatch(/destructive/);
  });
});

// ── server ───────────────────────────────────────────────────────────────────

describe("figma_batch on the server", () => {
  type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
  const tools = new Map<string, { config: { inputSchema?: unknown }; cb: Handler }>();
  const forwarded: Array<{ op: string; params: Record<string, unknown> }> = [];
  const fakeServer = {
    registerTool(name: string, config: { inputSchema?: unknown }, cb: Handler) {
      tools.set(name, { config, cb });
    },
  } as unknown as McpServer;
  const bridge = {
    request: async (op: string, params: Record<string, unknown>) => {
      forwarded.push({ op, params });
      return { steps: [], completed: 0 };
    },
    statusAsync: async () => ({ sessions: [] }),
    status: () => ({ sessions: [] }),
  } as unknown as Bridge;
  const extra = { _meta: {}, sendNotification: async () => {}, signal: new AbortController().signal };
  const everything = () => true;
  // The integration order: record shapes first, register the groups, batch last.
  const shapeOf = createShapeRecorder(fakeServer);
  registerModify(fakeServer, bridge, everything);
  registerStyle(fakeServer, bridge, everything);
  registerBatch(fakeServer, bridge, everything, shapeOf);
  const call = (args: Record<string, unknown>) => tools.get("figma_batch")!.cb(args, extra);

  beforeEach(() => {
    forwarded.length = 0;
  });

  it("records each tool's own shape as it registers", () => {
    expect(Object.keys(shapeOf("set_opacity") ?? {})).toEqual(expect.arrayContaining(["nodeIds", "opacity"]));
    expect(shapeOf("create_frame")).toBeUndefined();
  });

  it("a schema-invalid step is refused with its path, nothing is forwarded, and a retry is safe", async () => {
    const r = await call({ steps: JSON.stringify([
      { op: "set_visible", params: { nodeIds: ["1:2"], visible: true } },
      { op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 2 } },
    ]) });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/steps\[1\]\.params\.opacity/);
    expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    expect(forwarded).toEqual([]);
  });

  it("refuses an unknown param, a per-step session or key, and an op outside the toolset", () => {
    const steps = (s: unknown) => JSON.stringify([s]);
    expect(() => validateSteps(steps({ op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 1, opactiy: 1 } }), shapeOf, everything)).toThrow(/steps\[0\]\.params`?: .*opactiy|Unrecognized key/);
    expect(() => validateSteps(steps({ op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 1, idempotencyKey: "k" } }), shapeOf, everything)).toThrow(/at the top level/);
    expect(() => validateSteps(steps({ op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 1 } }), shapeOf, (op) => op !== "set_opacity")).toThrow(/not registered/);
    expect(() => validateSteps(steps({ op: "delete_nodes", params: { nodeIds: ["1:2"] } }), shapeOf, everything)).toThrow(/destructive/);
    expect(() => validateSteps("[not json", shapeOf, everything)).toThrow(/not valid JSON/);
  });

  it("the new schemas stay inside the portable subset (they register only once the catalog lists them)", async () => {
    const server = new McpServer({ name: "portability", version: "0" });
    const record = createShapeRecorder(server);
    registerModify(server, bridge, (op) => op === "set_clips_content" || op === "set_opacity");
    registerBatch(server, bridge, () => true, record);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "check", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools: listed } = await client.listTools();
    expect(listed.map((t) => t.name).sort()).toEqual(["figma_batch", "figma_set_clips_content", "figma_set_opacity"]);
    // The same rule as test/schema-portability.test.ts; the top-level $schema is
    // removed by createApp (src/server/schema-dialect.ts), so it is here too.
    const forbidden = ["$ref", "$defs", "anyOf", "oneOf", "allOf", "not", "const", "format", "patternProperties", "propertyNames", "prefixItems"];
    const walk = (s: Record<string, unknown>, at: string): string[] => [
      ...Object.keys(s).filter((k) => forbidden.includes(k)).map((k) => `${at}: ${k}`),
      ...Object.entries((s.properties ?? {}) as Record<string, Record<string, unknown>>).flatMap(([k, v]) => walk(v, `${at}.${k}`)),
      ...(s.items ? walk(s.items as Record<string, unknown>, `${at}[]`) : []),
    ];
    for (const t of listed) {
      expect(walk(t.inputSchema as Record<string, unknown>, t.name)).toEqual([]);
      expect((t.description ?? "").length).toBeLessThanOrEqual(1024);
    }
    await client.close();
  });

  it("valid steps are forwarded as one `batch` op, parsed, with the top-level session and key", async () => {
    const r = await call({
      steps: JSON.stringify([{ op: "figma_set_opacity", params: { nodeIds: ["1:2"], opacity: 0.5 } }]),
      idempotencyKey: "polish-1",
    });
    expect(r.isError).toBeFalsy();
    expect(forwarded).toEqual([{ op: "batch", params: { steps: [{ op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 0.5 } }] } }]);
  });
});
