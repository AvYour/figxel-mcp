// Unknown keys are refused, not dropped — through MCP, where it matters. The
// SDK parses a tool's arguments with zod and hands the tool the PARSED copy, and
// zod's default object strips a key it does not know. Every plugin-side key
// check (onlyKeys, the whole-node refusal on a range) only ever saw that copy,
// so `angel: 180` was gone before anything could object to it and the call
// "succeeded" with the default. These tests go through a real MCP client, the
// registration hook (tools/batch.ts createShapeRecorder) and the shared shapes
// (tools/params.ts), with a bridge that records what would reach Figma.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toPaint } from "../src/plugin/ops/style.js";
import type { Bridge } from "../src/server/bridge.js";
import { loadConfig } from "../src/server/config.js";
import { registerTools } from "../src/server/tools/index.js";

const forwarded: Array<{ op: string; params: Record<string, unknown> }> = [];
const bridge = {
  request: async (op: string, params: Record<string, unknown>) => {
    forwarded.push({ op, params });
    return { updated: 1, items: [] };
  },
  statusAsync: async () => ({ sessions: [] }),
  status: () => ({ sessions: [] }),
} as unknown as Bridge;

let client: Client;
let server: McpServer;

beforeAll(async () => {
  server = new McpServer({ name: "strict", version: "0" });
  const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-strict-")), BRIDGE_PORT: "0", BRIDGE_ALLOW_EVAL: "1", BRIDGE_ENABLE_AUDIO: "1" });
  registerTools(server, bridge, config, Date.now());
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "strict-check", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterAll(async () => {
  await client.close();
});
beforeEach(() => {
  forwarded.length = 0;
});

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
const text = (r: Result) => r.content.map((c) => c.text ?? "").join("\n");
const stops = [
  { position: 0, color: "#000000" },
  { position: 1, color: "#ffffff" },
];

describe("a key a tool does not take is refused before anything is forwarded", () => {
  it("nested: a gradient's misspelt angle, an image's wrong field, a shadow's blur, a side's typo", async () => {
    const refused = [
      ["figma_set_fills", { nodeIds: ["1:2"], fills: [{ gradient: { type: "linear", angel: 180, stops } }] }, "angel"],
      ["figma_set_fills", { nodeIds: ["1:2"], fills: [{ gradient: { type: "linear", stops: [{ position: 0, colour: "#000" }, ...stops] } }] }, "colour"],
      ["figma_set_fills", { nodeIds: ["1:2"], fills: [{ image: { hash: "h", scale: "fit" } }] }, "scale"],
      ["figma_set_fills", { nodeIds: ["1:2"], fills: [{ color: "#fff", blend: "MULTIPLY" }] }, "blend"],
      ["figma_set_effects", { nodeIds: ["1:2"], effects: [{ type: "DROP_SHADOW", blur: 24 }] }, "blur"],
      ["figma_set_effects", { nodeIds: ["1:2"], effects: [{ type: "LAYER_BLUR", progressive: { startOffset: { x: 0, y: 0, z: 1 } } }] }, "z"],
      ["figma_set_strokes", { nodeIds: ["1:2"], color: "#000", sides: { bottom: 1, lft: 1 } }, "lft"],
      ["figma_set_text_range", { nodeId: "1:2", match: "Pro", variables: { fontWeigth: "type/weight/bold" } }, "fontWeigth"],
      ["figma_create_paint_style", { name: "Hero", fills: [{ gradient: { type: "radial", stops, centre: { x: 0.2, y: 0.2 } } }] }, "centre"],
    ] as const;
    for (const [tool, args, key] of refused) {
      const r = await call(tool, args as Record<string, unknown>);
      expect(r.isError, `${tool} ${key}`).toBe(true);
      expect(text(r)).toMatch(new RegExp(key));
    }
    expect(forwarded).toEqual([]);
  });

  it("nested, in the token, component and motion tools too (C-2)", async () => {
    const refused = [
      ["figma_create_variables", { collectionId: "c", variables: [{ name: "color/bg", type: "COLOR", values: [{ mode: "Light", value: "#fff" }], scope: ["ALL_FILLS"] }] }, "scope"],
      ["figma_create_variables", { collectionId: "c", variables: [{ name: "color/bg", type: "COLOR", values: [{ mode: "Light", valeu: "#fff", value: "#fff" }] }] }, "valeu"],
      ["figma_create_grid_style", { name: "Grid/12", grids: [{ pattern: "columns", count: 12, gap: 24 }] }, "gap"],
      ["figma_update_variable_collection", { collectionId: "c", renameModes: [{ mode: "Mode 1", name: "Light", to: "Light" }] }, "to"],
      ["figma_update_style", { styleName: "Grid/12", grids: [{ pattern: "rows", colour: "#000" }] }, "colour"],
      ["figma_update_style", { styleName: "Body", variables: [{ field: "fontSize", variableName: "type/size/body", mode: "Dark" }] }, "mode"],
      ["figma_import_library_assets", { assets: [{ kind: "component", key: "abc", name: "Button" }] }, "name"],
      ["figma_set_keyframes", { nodeId: "1:2", tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1" }], loop: true }] }, "loop"],
      ["figma_set_keyframes", { nodeId: "1:2", tracks: [{ field: "OPACITY", keyframes: [{ t: 0, value: "1", ease: "LINEAR" }] }] }, "ease"],
      ["figma_set_prototype_flows", { flows: [{ nodeId: "1:2", name: "Main", start: true }] }, "start"],
    ] as const;
    for (const [tool, args, key] of refused) {
      const r = await call(tool, args as Record<string, unknown>);
      expect(r.isError, `${tool} ${key}`).toBe(true);
      expect(text(r)).toMatch(new RegExp(key));
    }
    expect(forwarded).toEqual([]);
  });

  it("top level: a whole-node field on a range, and a typo on any tool", async () => {
    const align = await call("figma_set_text_range", { nodeId: "1:2", match: "Pro", weight: "Bold", align: "center" });
    expect(align.isError).toBe(true);
    expect(text(align)).toMatch(/align/);
    const typo = await call("figma_set_opacity", { nodeIds: ["1:2"], opactiy: 0.5 });
    expect(typo.isError).toBe(true);
    expect(text(typo)).toMatch(/opactiy/);
    expect(forwarded).toEqual([]);
  });

  it("a batch step's nested key is refused as well, not only its top-level one", async () => {
    const steps = JSON.stringify([{ op: "set_fills", params: { nodeIds: ["1:2"], fills: [{ gradient: { type: "linear", angel: 180, stops } }] } }]);
    const r = await call("figma_batch", { steps });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/steps\[0\]\.params\.fills\.0\.gradient.*angel|angel/);
    expect(forwarded).toEqual([]);
  });

  it("what a tool does take still goes through whole", async () => {
    const fills = [{ gradient: { type: "angular", stops, center: { x: 0.3, y: 0.3 } }, opacity: 0.8 }];
    const r = await call("figma_set_fills", { nodeIds: ["1:2"], fills, idempotencyKey: "k-1" });
    expect(r.isError).toBeFalsy();
    expect(forwarded).toEqual([{ op: "set_fills", params: { nodeIds: ["1:2"], fills, idempotencyKey: "k-1" } }]);
  });
});

describe("the plugin refuses the same keys on its own", () => {
  it("a fill entry and a gradient stop take only their own fields", () => {
    expect(() => toPaint({ color: "#ffffff", blend: "MULTIPLY" }, 2)).toThrow(/`fills\[2\]` takes only .* \(got blend\)/);
    expect(() => toPaint({ gradient: { type: "linear", stops: [{ position: 0, color: "#000", offset: 1 }, stops[1]] } }, 0)).toThrow(
      /`fills\[0\]\.gradient\.stops\[0\]` takes only `position`, `color` \(got offset\)/,
    );
    expect(() => toPaint({ gradient: { type: "linear", stops: ["#000", "#fff"] } }, 0)).toThrow(/stops\[0\]` must be an object/);
  });
});

describe("the wire says so too", () => {
  /** Every object schema under `s` that has properties and does not close them. */
  const open = (s: Record<string, unknown>, at: string): string[] => {
    const out: string[] = [];
    const props = s.properties as Record<string, Record<string, unknown>> | undefined;
    if (s.type === "object" && props && Object.keys(props).length && s.additionalProperties !== false) out.push(at);
    for (const [k, v] of Object.entries(props ?? {})) out.push(...open(v, `${at}.${k}`));
    if (s.items) out.push(...open(s.items as Record<string, unknown>, `${at}[]`));
    // An object inside a union (a sizing word or { width, height }) is forwarded just the same.
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      for (const [i, v] of ((s[key] as Record<string, unknown>[] | undefined) ?? []).entries()) out.push(...open(v, `${at}|${i}`));
    }
    return out;
  };

  it("every tool's top level, and every object any tool forwards, is closed", async () => {
    const { tools } = await client.listTools();
    expect(tools.flatMap((t) => open(t.inputSchema as Record<string, unknown>, t.name))).toEqual([]);
  });
});
