// When Figma cannot fetch what the plugin asks for. On 2026-10-13
// figma_get_design_context { nodeId: "0:1" } — a page other than the open one,
// which the plugin must load first under dynamic-page [C-090] — failed twice
// with Figma's own text passed through as INTERNAL:
//   "Unable to establish connection to Figma after 10 seconds. Please check
//    your internet connection."
// figma_get_nodes_info failed the same way on 2026-10-09, the whole call for
// one id. The fakes below throw exactly that text.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { READ_OPS } from "../src/plugin/ops/read.js";
import { errorResult } from "../src/server/results.js";

const FIGMA_SAID = "Unable to establish connection to Figma after 10 seconds. Please check your internet connection.";

let loads: number;
let lookupFails: Set<string>;

beforeEach(() => {
  loads = 0;
  lookupFails = new Set();
  const open = { id: "0:2", type: "PAGE", name: "Work", selection: [], children: [{ id: "1:1", type: "FRAME", name: "Card", children: [] }] };
  const other = {
    id: "0:1",
    type: "PAGE",
    name: "Cover",
    children: [],
    async loadAsync() {
      loads++;
      throw new Error(FIGMA_SAID);
    },
  };
  const nodes = new Map<string, unknown>([["0:1", other], ["0:2", open], ["1:1", open.children[0]]]);
  (globalThis as { figma?: unknown }).figma = {
    currentPage: open,
    root: { name: "File", children: [other, open] },
    editorType: "figma",
    async getNodeByIdAsync(id: string) {
      if (lookupFails.has(id)) throw new Error(FIGMA_SAID);
      return nodes.get(id) ?? null;
    },
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

const run = (op: string, params: Record<string, unknown>) =>
  READ_OPS[op]!.run({ requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false } as OpContext) as Promise<
    Record<string, any>
  >;

async function failure(p: Promise<unknown>): Promise<BridgeError> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(BridgeError);
  return e as BridgeError;
}

describe("a page Figma could not load", () => {
  it("figma_get_design_context names the page, quotes Figma, and says what to try", async () => {
    const e = await failure(run("get_design_context", { nodeId: "0:1" }));
    expect(loads).toBe(1);
    expect(e.code).toBe("TIMEOUT");
    expect(e.message).toBe(`Figma could not load the page "Cover" (0:1) for the plugin. Figma said: "${FIGMA_SAID}"`);
    expect(e.hint).toMatch(/figma_navigate_page \{ pageId: "0:1" \}/);
    expect(e.hint).toMatch(/retry in a moment/);
  });

  it("reaches the agent as safe to retry, not as an INTERNAL fault", async () => {
    const r = errorResult(await failure(run("get_design_context", { nodeId: "0:1" })), { readOnly: true });
    expect(r.structuredContent).toMatchObject({ code: "TIMEOUT", safeToRetry: true });
    expect((r.content[0] as { text: string }).text).toMatch(/^TIMEOUT: Figma could not load the page "Cover"/);
  });

  it("a lookup Figma could not answer is said the same way", async () => {
    lookupFails.add("1:1");
    const e = await failure(run("get_node", { nodeId: "1:1" }));
    expect(e.code).toBe("TIMEOUT");
    expect(e.message).toMatch(/^Figma could not load the node `1:1` for the plugin/);
    expect(e.hint).toMatch(/figma_get_pages/);
  });

  it("figma_get_nodes_info reports it for that id only, as the tool promises", async () => {
    lookupFails.add("1:1");
    const r = await run("get_nodes_info", { nodeIds: ["0:2", "1:1", "0:1"] });
    expect(r.found).toBe(1);
    expect(r.items.map((i: { id: string; ok: boolean }) => [i.id, i.ok])).toEqual([["0:2", true], ["1:1", false], ["0:1", false]]);
    expect(r.items[1].error).toMatch(/^TIMEOUT: Figma could not load the node `1:1`/);
    expect(r.items[2].error).toMatch(/^TIMEOUT: Figma could not load the page "Cover" \(0:1\)/);
    expect(r.items[2].hint).toMatch(/figma_navigate_page/);
  });

  it("any other load failure keeps its code but gains the page and the advice", async () => {
    const figma = (globalThis as unknown as { figma: { root: { children: Array<{ loadAsync?: () => Promise<void> }> } } }).figma;
    figma.root.children[0]!.loadAsync = async () => {
      throw new Error("Something else");
    };
    const e = await failure(run("get_design_context", { nodeId: "0:1" }));
    expect(e.code).toBe("INTERNAL");
    expect(e.message).toMatch(/^Figma could not load the page "Cover" \(0:1\) for the plugin\. Figma said: "Something else"/);
  });
});
