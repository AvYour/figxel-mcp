// The seams between the FigJam and Slides packages, which no single package
// could test: every catalog op is implemented by the plugin with the same
// write flag, every tool registers exactly once (before figma_batch, so a batch
// step may name the new modify and style ops), a batch reaches them with its
// slide ids normalised, and the board spec types are registered at plugin load.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { PLUGIN_OPS } from "../src/plugin/ops/index.js";
import { specType, specTypeNames } from "../src/plugin/spec-types.js";
import type { Bridge } from "../src/server/bridge.js";
import { loadConfig } from "../src/server/config.js";
import { registerTools } from "../src/server/tools/index.js";
import { EDITOR_SUPPORT } from "../src/shared/editors.js";
import { OPS, selectOps, toolName } from "../src/shared/ops.js";
import { quietLogger } from "./helpers.js";

const FIGJAM = [
  "create_stickies", "create_shapes_with_text", "create_connectors", "create_table", "create_code_block", "create_link_preview",
  "edit_table", "edit_connectors", "set_board_properties", "fit_sections",
];
const SLIDES = ["get_slide_grid", "create_slides", "set_slide_grid", "move_slides", "set_slide_properties", "set_slide_transition"];

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

/** Every tool, eval and the held-back audio group included, unless `env` says otherwise. */
function registered(env: Record<string, string> = { BRIDGE_ALLOW_EVAL: "1", BRIDGE_ENABLE_AUDIO: "1" }) {
  const names: string[] = [];
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, cb: Handler) {
      names.push(name);
      handlers.set(name, cb);
    },
    registerPrompt() {},
  } as unknown as McpServer;
  const forwarded: Array<{ op: string; params: Record<string, unknown> }> = [];
  const bridge = {
    request: async (op: string, params: Record<string, unknown>) => (forwarded.push({ op, params }), { ok: true }),
    statusAsync: async () => ({ sessions: [] }),
    status: () => ({ sessions: [] }),
  } as unknown as Bridge;
  const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-integ-")), BRIDGE_PORT: "0", ...env });
  registerTools(server, bridge, config, Date.now(), quietLogger);
  return { names, handlers, forwarded };
}

const extra = { _meta: {}, sendNotification: async () => {}, signal: new AbortController().signal };

describe("the FigJam and Slides tools, wired", () => {
  it("are in the catalog in their groups, each with an editor row", () => {
    expect([...FIGJAM, ...SLIDES].filter((op) => !OPS.has(op))).toEqual([]);
    expect([...FIGJAM, ...SLIDES].filter((op) => !EDITOR_SUPPORT[op])).toEqual([]);
    expect(OPS.get("get_slide_grid")).toMatchObject({ group: "read", write: false });
    expect(OPS.get("set_slide_transition")).toMatchObject({ group: "style", write: true });
    expect(OPS.get("edit_table")!.destructive).toBe(true);
    // 129, plus figma_check_motion, figma_review_video, figma_create_storyboard and figma_create_animatic,
    // figma_set_motion_plan, and figma_analyze_audio, figma_add_audio and figma_generate_audio
    // (in the catalog, held back from default registration).
    expect(OPS.size).toBe(137);
  });

  it("every catalog op the plugin answers is implemented there, with the same write flag", () => {
    const missing = [...OPS].filter(([op, i]) => !i.bridgeOnly && !PLUGIN_OPS[op]).map(([op]) => op);
    expect(missing).toEqual([]);
    expect(Object.keys(PLUGIN_OPS).filter((op) => !OPS.has(op))).toEqual([]);
    // undo_step is the one exception, on purpose: it must not end in a commitUndo of its own (test/phase3-ops.test.ts).
    const flags = Object.entries(PLUGIN_OPS).filter(([op, p]) => p.write !== OPS.get(op)!.write).map(([op]) => op);
    expect(flags).toEqual(["undo_step"]);
  });

  it("every tool registers exactly once, eval and audio included; the 16 board and deck tools before figma_batch", () => {
    const { names } = registered();
    expect(names.length).toBe(new Set(names).size);
    expect(names.length).toBe(selectOps({ kind: "full" }, true, true).length);
    expect(names.length).toBe(OPS.size);
    const batchAt = names.indexOf("figma_batch");
    for (const op of [...FIGJAM, ...SLIDES]) {
      const at = names.indexOf(toolName(op));
      expect(at, op).toBeGreaterThanOrEqual(0);
      expect(at, op).toBeLessThan(batchAt);
    }
  });

  it("a batch reaches the new modify and style ops, slide ids normalised; edit_table stays out (destructive)", async () => {
    const { handlers, forwarded } = registered();
    const batch = handlers.get("figma_batch")!;
    const r = await batch(
      {
        steps: JSON.stringify([
          { op: "edit_connectors", params: { connectors: [{ nodeId: "1-2", label: "yes" }] } },
          { op: "set_board_properties", params: { nodeIds: ["3:4"], color: "yellow" } },
          { op: "fit_sections", params: { nodeIds: ["5:6"] } },
          { op: "move_slides", params: { slideIds: ["7-8"], afterSlideId: "9-10" } },
          { op: "set_slide_transition", params: { slideIds: ["7:8"], style: "DISSOLVE" } },
        ]),
      },
      extra,
    );
    expect(r.isError).toBeFalsy();
    const steps = (forwarded.at(-1)!.params as { steps: Array<{ op: string; params: Record<string, unknown> }> }).steps;
    expect(steps.map((s) => s.op)).toEqual(["edit_connectors", "set_board_properties", "fit_sections", "move_slides", "set_slide_transition"]);
    expect(steps[3]!.params).toEqual({ slideIds: ["7:8"], afterSlideId: "9:10" });

    const refused = await batch({ steps: JSON.stringify([{ op: "edit_table", params: { nodeId: "1:2", removeRows: [0] } }]) }, extra);
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as { text: string }).text).toMatch(/edit_table" is destructive/);
  });

  it("every tool a description or an editor row points to exists", () => {
    // Descriptions and refusal hints from one package name tools another package adds.
    const texts: string[] = [];
    const server = {
      registerTool: (_n: string, config: { description?: string }) => void texts.push(config.description ?? ""),
      registerPrompt() {},
    } as unknown as McpServer;
    const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-integ-")), BRIDGE_PORT: "0", BRIDGE_ALLOW_EVAL: "1", BRIDGE_ENABLE_AUDIO: "1" });
    registerTools(server, {} as Bridge, config, Date.now(), quietLogger);
    for (const r of Object.values(EDITOR_SUPPORT)) texts.push(r.why ?? "", ...Object.values(r.instead ?? {}));
    const known = new Set([...OPS.keys()].map(toolName));
    const named = new Set(texts.flatMap((t) => [...t.matchAll(/\bfigma_[a-z][a-z_]*[a-z]\b/g)].map((m) => m[0])));
    expect([...named].filter((n) => !known.has(n))).toEqual([]);
    expect(named.has("figma_edit_table")).toBe(true);
  });

  it("the board spec types are registered when the plugin's op table loads", () => {
    for (const t of ["sticky", "shape", "table", "code", "connector"]) expect(specType(t), t).toBeDefined();
    expect(specTypeNames()).toEqual(expect.arrayContaining(["sticky", "shape", "table", "code", "connector"]));
  });
});

// The motion check, the video review and the storyboard came from three
// packages; their seams are the registries, which none of them owned.
describe("figma_check_motion, figma_review_video and figma_create_storyboard, wired", () => {
  const NEW = ["check_motion", "review_video", "create_storyboard"];

  it("sit in their groups with the flags their groups give, and only the two plugin ops exist in the plugin", () => {
    expect(OPS.get("check_motion")).toMatchObject({ group: "read", readOnly: true, write: false, destructive: false, bridgeOnly: false });
    expect(OPS.get("review_video")).toMatchObject({ group: "export", readOnly: true, write: false, destructive: false, bridgeOnly: true });
    expect(OPS.get("create_storyboard")).toMatchObject({ group: "create", readOnly: false, write: true, destructive: false, bridgeOnly: false });
    expect(PLUGIN_OPS.check_motion?.write).toBe(false);
    expect(PLUGIN_OPS.create_storyboard?.write).toBe(true);
    // review_video reads a file on disk: a plugin op would be a second, unreachable path.
    expect(PLUGIN_OPS.review_video).toBeUndefined();
  });

  it("register once each, before figma_batch", () => {
    const { names } = registered();
    const batchAt = names.indexOf("figma_batch");
    for (const op of NEW) {
      expect(names.filter((n) => n === toolName(op)), op).toHaveLength(1);
      expect(names.indexOf(toolName(op)), op).toBeLessThan(batchAt);
    }
  });

  it("a batch refuses each of them by its group, before the plugin is asked", async () => {
    const { handlers, forwarded } = registered();
    const batch = handlers.get("figma_batch")!;
    for (const [op, params, group] of [
      ["check_motion", {}, "read"],
      ["review_video", { path: "a.mp4" }, "export"],
      ["create_storyboard", { title: "Ad", aspect: "9:16", panels: [{ durationS: 1 }] }, "create"],
    ] as const) {
      const r = await batch({ steps: JSON.stringify([{ op, params }]) }, extra);
      expect(r.isError, op).toBe(true);
      expect((r.content[0] as { text: string }).text, op).toContain(`"${op}" is a ${group} op`);
    }
    expect(forwarded).toEqual([]);
  });
});

// The audio tools work on files: no plugin op of their own. generate_audio
// { nodeId } reads the frame through check_motion's op, gated by its own row.
// Held back from the release on 2026-10-14: registered only with BRIDGE_ENABLE_AUDIO=1.
describe("figma_analyze_audio, figma_add_audio and figma_generate_audio, wired", () => {
  const AUDIO = ["analyze_audio", "add_audio", "generate_audio"];

  it("sit in the audio group, answered by the bridge, with no plugin op", () => {
    for (const op of AUDIO) {
      expect(OPS.get(op), op).toMatchObject({ group: "audio", readOnly: true, write: false, destructive: false, bridgeOnly: true });
      expect(PLUGIN_OPS[op], op).toBeUndefined();
    }
  });

  it("are not registered by default, eval allowed or not; BRIDGE_ENABLE_AUDIO=1 registers all three", () => {
    const envs: Array<Record<string, string>> = [{}, { BRIDGE_ALLOW_EVAL: "1" }, { BRIDGE_ENABLE_AUDIO: "0" }];
    for (const env of envs) {
      const { names } = registered(env);
      expect(names.filter((n) => AUDIO.includes(n.replace(/^figma_/, ""))), JSON.stringify(env)).toEqual([]);
      // Everything else is still there: the default is the catalog less eval and the audio group.
      expect(names.length, JSON.stringify(env)).toBe(selectOps({ kind: "full" }, "BRIDGE_ALLOW_EVAL" in env).length);
    }
    expect(registered({}).names.length).toBe(OPS.size - 1 - AUDIO.length);
    const on = registered({ BRIDGE_ENABLE_AUDIO: "1" }).names;
    expect(on.filter((n) => AUDIO.includes(n.replace(/^figma_/, "")))).toEqual(AUDIO.map(toolName));
    // The toolset still decides: core never holds them, and a group list needs the audio group.
    expect(registered({ BRIDGE_ENABLE_AUDIO: "1", BRIDGE_TOOLSET: "core" }).names.filter((n) => n.endsWith("_audio"))).toEqual([]);
    expect(registered({ BRIDGE_ENABLE_AUDIO: "1", BRIDGE_TOOLSET: "export" }).names.filter((n) => n.endsWith("_audio"))).toEqual([]);
    expect(registered({ BRIDGE_ENABLE_AUDIO: "1", BRIDGE_TOOLSET: "audio" }).names.filter((n) => n.endsWith("_audio"))).toEqual(AUDIO.map(toolName));
  });

  it("register once each, before figma_batch, and a batch refuses them as audio ops", async () => {
    const { names, handlers, forwarded } = registered();
    const batchAt = names.indexOf("figma_batch");
    for (const op of AUDIO) {
      expect(names.filter((n) => n === toolName(op)), op).toHaveLength(1);
      expect(names.indexOf(toolName(op)), op).toBeLessThan(batchAt);
    }
    const r = await handlers.get("figma_batch")!({ steps: JSON.stringify([{ op: "generate_audio", params: { durationS: 1, cues: [{ t: 0, type: "tick" }] } }]) }, extra);
    expect((r.content[0] as { text: string }).text).toContain('"generate_audio" is a audio op');
    expect(forwarded).toEqual([]);
  });

  it("generate_audio { nodeId } asks the plugin for check_motion's snapshot, nothing else", async () => {
    const { handlers, forwarded } = registered();
    const r = await handlers.get("figma_generate_audio")!({ durationS: 1, nodeId: "12-34" }, extra);
    // The fake bridge answers { ok: true }: no snapshot, so the call fails after asking once.
    expect(r.isError).toBe(true);
    expect(forwarded).toEqual([{ op: "check_motion", params: { nodeId: "12:34" } }]);
  });
});
