// Node addressing at the one chokepoint every plugin-backed tool goes through.
//
// Found 2026-10-08 (gap G-01): tools.md promised that "1-2" is normalized, but
// normalizeNodeId was imported only by its own unit test. forwardTool passed
// ids through untouched, the plugin asked getNodeByIdAsync for "12-34", got
// null, and a link-based prompt — the official flow — failed as NODE_NOT_FOUND.

import { describe, expect, it } from "vitest";
import type { Bridge } from "../src/server/bridge.js";
import { extractNodeIdFromUrl, normalizeIdParams, toNodeId } from "../src/server/figma-url.js";
import { forwardTool, type Extra } from "../src/server/tools/forward.js";

interface Call {
  op: string;
  p: Record<string, unknown>;
  opts: Record<string, unknown>;
}

function fakeBridge(sessions: Array<{ sessionId: string; file: { name: string }; active?: boolean }> = [], data: unknown = { ok: true }) {
  const calls: Call[] = [];
  let statusCalls = 0;
  const bridge = {
    request: async (op: string, p: Record<string, unknown>, opts: Record<string, unknown>) => {
      calls.push({ op, p, opts });
      return data;
    },
    statusAsync: async () => {
      statusCalls++;
      return { sessions };
    },
  } as unknown as Bridge;
  return { bridge, calls, statusCalls: () => statusCalls };
}

const extra = { signal: new AbortController().signal, sendNotification: async () => {}, _meta: {} } as unknown as Extra;

const LINK = "https://www.figma.com/design/AbC123xyz/Landing-Page?node-id=12-34&t=abc";

describe("ids reach the plugin in the form it resolves", () => {
  it("'12-34', a design link and a branch link all arrive as 12:34", async () => {
    for (const nodeId of ["12-34", LINK, "https://www.figma.com/design/AbC123xyz/branch/BrK987/Landing-Page?node-id=12-34"]) {
      const { bridge, calls } = fakeBridge();
      const r = await forwardTool(bridge, "get_node", { nodeId }, extra);
      expect(r.isError).toBeUndefined();
      expect(calls[0]!.p.nodeId).toBe("12:34");
    }
  });

  it("normalizes every entry of an id array", async () => {
    const { bridge, calls } = fakeBridge();
    await forwardTool(bridge, "get_nodes_info", { nodeIds: ["1-2", "3:4", LINK] }, extra);
    expect(calls[0]!.p.nodeIds).toEqual(["1:2", "3:4", "12:34"]);
  });

  it("an instance id, %3B-encoded, keeps its path", () => {
    expect(toNodeId("I12-34%3B56-78").id).toBe("I12:34;56:78");
    expect(toNodeId("https://www.figma.com/design/K/F?node-id=I12-34%3B56-78").id).toBe("I12:34;56:78");
    expect(toNodeId("I1:2;3:4").id).toBe("I1:2;3:4");
  });

  it("other id grammars pass through unchanged", async () => {
    expect(toNodeId("S:abc123,12:3").id).toBe("S:abc123,12:3");
    expect(toNodeId("VariableID:1:2").id).toBe("VariableID:1:2");
    expect(toNodeId("a1b2c3d4e5").id).toBe("a1b2c3d4e5");
    const { bridge, calls } = fakeBridge();
    await forwardTool(bridge, "set_description", { targetId: "VariableID:1:2", styleId: "S:abc,1:2" }, extra);
    expect(calls[0]!.p).toEqual({ targetId: "VariableID:1:2", styleId: "S:abc,1:2" });
  });

  it("reaches ids inside a parsed spec", async () => {
    const { bridge, calls } = fakeBridge();
    const spec = { type: "frame", children: [{ type: "instance", componentId: "5-6" }, { type: "text", content: "12-34" }] };
    await forwardTool(bridge, "create_from_spec", { spec, parentId: LINK }, extra);
    const sent = calls[0]!.p as { spec: { children: Array<Record<string, unknown>> }; parentId: string };
    expect(sent.spec.children[0]!.componentId).toBe("5:6");
    expect(sent.spec.children[1]!.content).toBe("12-34"); // not an id key: text stays text
    expect(sent.parentId).toBe("12:34");
    expect(spec.children[0]!.componentId).toBe("5-6"); // the caller's object is not mutated
  });
});

describe("links that name no layer are refused before Figma is asked", () => {
  it("a link with no node-id is INVALID_PARAM naming the field", async () => {
    const { bridge, calls } = fakeBridge();
    const r = await forwardTool(bridge, "get_node", { nodeId: "https://www.figma.com/design/AbC123xyz/Landing-Page" }, extra);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM" });
    expect(String((r.structuredContent as { message: string }).message)).toContain("`nodeId`");
    expect(calls).toEqual([]);
  });

  it("names the array entry that failed", () => {
    expect(() => normalizeIdParams({ nodeIds: ["1:2", "https://figma.com/file/K/x"] })).toThrow(/nodeIds\[1\]/);
  });

  it("a link to something that is not a Figma design is refused too", () => {
    expect(() => toNodeId("https://example.com/?node-id=1-2", "parentId")).toThrow(/parentId/);
  });

  it("two links from different files in one call are refused", async () => {
    const { bridge, calls } = fakeBridge([{ sessionId: "s-1", file: { name: "Landing Page" } }]);
    const r = await forwardTool(bridge, "get_nodes_info", { nodeIds: [LINK, "https://www.figma.com/design/Other999/Docs?node-id=1-2"] }, extra);
    expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM" });
    expect(calls).toEqual([]);
  });
});

describe("a link's file name picks the session", () => {
  it("with two files open, the link goes to its own file", async () => {
    const { bridge, calls } = fakeBridge([
      { sessionId: "s-1", file: { name: "Design System" }, active: true },
      { sessionId: "s-2", file: { name: "Landing Page" } },
    ]);
    await forwardTool(bridge, "get_node", { nodeId: LINK }, extra);
    expect(calls[0]!.opts.session).toBe("s-2");
  });

  it("with two files open and neither linked, the call is refused with the open names", async () => {
    const { bridge, calls } = fakeBridge([
      { sessionId: "s-1", file: { name: "Design System" } },
      { sessionId: "s-2", file: { name: "Docs" } },
    ]);
    const r = await forwardTool(bridge, "get_node", { nodeId: LINK }, extra);
    expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM" });
    expect(String((r.structuredContent as { hint: string }).hint)).toContain('"Design System"');
    expect(calls).toEqual([]);
  });

  it("with one file open, a different name runs anyway and says so", async () => {
    const { bridge, calls } = fakeBridge([{ sessionId: "s-1", file: { name: "Renamed File" } }], { node: { id: "12:34" } });
    const r = await forwardTool(bridge, "get_node", { nodeId: LINK }, extra);
    expect(calls[0]!.opts.session).toBeUndefined();
    expect((r.structuredContent as { warning: string }).warning).toMatch(/Landing-Page.*Renamed File/);
    expect(r.content[0]!.type === "text" && JSON.parse(r.content[0]!.text).warning).toBeTruthy();
  });

  it("a shaped result (an image) carries the warning as one more block", async () => {
    const { bridge } = fakeBridge([{ sessionId: "s-1", file: { name: "Other" } }]);
    const r = await forwardTool(bridge, "export_node", { nodeId: LINK }, extra, {
      shape: () => ({ content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }),
    });
    expect(r.content).toHaveLength(2);
    expect(r.content[1]).toMatchObject({ type: "text" });
    expect((r.content[1] as { text: string }).text).toMatch(/^warning: /);
  });

  it("an explicit session wins and the bridge is not even asked", async () => {
    const f = fakeBridge([{ sessionId: "s-1", file: { name: "Other" } }]);
    await forwardTool(f.bridge, "get_node", { nodeId: LINK }, extra, { session: "s-9" });
    expect(f.calls[0]!.opts.session).toBe("s-9");
    expect(f.statusCalls()).toBe(0);
  });

  it("a plain id never asks for the session list", async () => {
    const f = fakeBridge([{ sessionId: "s-1", file: { name: "A" } }, { sessionId: "s-2", file: { name: "B" } }]);
    await forwardTool(f.bridge, "get_node", { nodeId: "12-34" }, extra);
    expect(f.statusCalls()).toBe(0);
  });
});

it("extractNodeIdFromUrl uses the same parser", () => {
  expect(extractNodeIdFromUrl("https://www.figma.com/proto/K/x?node-id=1-2&scaling=min")).toBe("1:2");
  expect(extractNodeIdFromUrl("https://www.figma.com/board/K/x?node-id=I1-2%3B3-4")).toBe("I1:2;3:4");
  expect(extractNodeIdFromUrl("https://www.figma.com/design/K/x")).toBeNull();
});
