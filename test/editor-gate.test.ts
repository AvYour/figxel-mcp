// The editor gate [C-129]: which op runs in Figma Design, FigJam and Figma
// Slides files, enforced at the bridge (authoritative, before "plugin too old")
// and again in the plugin for "no" cells, with the refusal saying which file
// does run the tool. Also the seams that make it usable: the description
// suffix, figma_status per session, editor-aware session choice, /slides/
// links and the link-editor mismatch.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  callRefusal,
  EDITOR_SUPPORT,
  EDITORS,
  editorRefusal,
  editorsSuffix,
  refusedTools,
  supportOf,
  unverifiedTools,
  type EditorRow,
} from "../src/shared/editors.js";
import { BridgeError } from "../src/shared/errors.js";
import { OPS, selectOps, toolName } from "../src/shared/ops.js";
import { makeBatchOp } from "../src/plugin/ops/batch.js";
import type { PluginOp } from "../src/plugin/ops/index.js";
import type { Bridge, BridgeStatus } from "../src/server/bridge.js";
import { ConfigError, loadConfig } from "../src/server/config.js";
import { extractFileKey, normalizeIdParams, toNodeId } from "../src/server/figma-url.js";
import { buildIdOnDisk } from "../src/server/plugin-build.js";
import { errorResult } from "../src/server/results.js";
import { SessionRegistry, type SessionState } from "../src/server/sessions.js";
import { forwardTool, type Extra } from "../src/server/tools/forward.js";
import { registerTools } from "../src/server/tools/index.js";
import { buildStatus } from "../src/server/tools/meta.js";
import { fitDescription } from "../src/server/tools/params.js";
import { FakeFigma, installFigma, opContext } from "./editor-fakes.js";
import { connectedMock, newToken, quietLogger, sleep, startBridge, type MockPlugin } from "./helpers.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const requestsSeen = (mock: MockPlugin) => mock.received.filter((m) => m.t === "request");

async function rejection(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a rejection");
}

/** A cell flipped for one test, then restored: the table is data, and no batchable op is measured outside Design yet. */
async function withCell<T>(op: string, cells: Partial<EditorRow>, run: () => Promise<T> | T): Promise<T> {
  const table = EDITOR_SUPPORT as Record<string, EditorRow>;
  const before = table[op]!;
  table[op] = { ...before, ...cells };
  try {
    return await run();
  } finally {
    table[op] = before;
  }
}

// ── the table ───────────────────────────────────────────────────────────────

describe("the editor table", () => {
  it("has exactly one row per op, and every row names an op (deny by default)", () => {
    expect(Object.keys(EDITOR_SUPPORT).sort()).toEqual([...OPS.keys()].sort());
    for (const [op, row] of Object.entries(EDITOR_SUPPORT)) {
      for (const e of EDITORS) expect(["yes", "no", "unmeasured"], `${op}.${e}`).toContain(row[e]);
      // A "no" says why; that sentence is the second half of its refusal.
      if (EDITORS.some((e) => row[e] === "no")) expect(row.why, op).toBeTruthy();
    }
  });

  it("runs every op in Design except the board and deck tools; fit_sections and the new motion and storyboard tools wait for a spike", () => {
    const notYes = (cell: string) => Object.keys(EDITOR_SUPPORT).filter((op) => EDITOR_SUPPORT[op]!.figma === cell).sort();
    // createSticky, createConnector, … are "only available in FigJam"; createSlide and the grid "only in Figma Slides" [C-132] [C-134].
    expect(notYes("no")).toEqual([
      "create_code_block", "create_connectors", "create_link_preview", "create_shapes_with_text", "create_slides", "create_stickies",
      "create_table", "edit_connectors", "edit_table", "get_slide_grid", "move_slides", "set_board_properties", "set_slide_grid",
      "set_slide_properties", "set_slide_transition",
    ]);
    // A new tool starts unmeasured until its spike records it under spikes/results/.
    expect(notYes("unmeasured")).toEqual(["check_motion", "create_animatic", "fit_sections"]);
    // The whole catalog before FigJam and Slides, plus figma_review_video, which never reaches Figma,
    // figma_create_storyboard, measured by spikes/results/live-storyboard.json, figma_set_motion_plan,
    // whose one write that run measured too, and the three audio tools, which work on files
    // (generate_audio's nodeId goes through check_motion's own row); then the role process's three:
    // figma_get_brief reads, figma_set_brief and figma_sign_off write as the motion plan does; then
    // trust's four, yes ahead of spikes/live-trust.mjs as the role tools are.
    expect(notYes("yes")).toHaveLength(126);
    expect(["analyze_audio", "add_audio", "generate_audio"].map((op) => EDITOR_SUPPORT[op])).toEqual([
      { figma: "yes", figjam: "yes", slides: "yes" },
      { figma: "yes", figjam: "yes", slides: "yes" },
      { figma: "yes", figjam: "yes", slides: "yes" },
    ]);
  });

  it("refuses only where the typings and Figma's pages agree [C-133] [C-134]", () => {
    const no = (e: "figjam" | "slides") => Object.keys(EDITOR_SUPPORT).filter((op) => EDITOR_SUPPORT[op]![e] === "no").sort();
    expect(no("figjam")).toEqual([
      "check_motion", "combine_as_variants", "convert_to_component", "create_animatic", "create_effect_style", "create_grid_style",
      "create_paint_style", "create_slides", "create_text_style", "export_video", "get_motion_context", "get_slide_grid", "move_slides",
      "set_motion_plan", "set_slide_grid", "set_slide_properties", "set_slide_transition",
    ]);
    expect(no("slides")).toEqual([
      "check_motion", "create_animatic", "create_code_block", "create_connectors", "create_effect_style", "create_grid_style",
      "create_link_preview", "create_paint_style", "create_stickies", "create_text_style", "edit_connectors", "export_video",
      "get_motion_context", "set_motion_plan",
    ]);
    // Working in Slides lists createShapeWithText and createTable as supported, against the typings [C-137].
    for (const op of ["create_shapes_with_text", "create_table", "edit_table", "set_board_properties", "fit_sections"]) {
      expect(EDITOR_SUPPORT[op]!.slides, op).toBe("unmeasured");
    }
    // Contradicted facts stay unmeasured, never "no" [C-137] [C-142].
    expect(EDITOR_SUPPORT.create_page!.figjam).toBe("unmeasured");
    expect(EDITOR_SUPPORT.create_section!.slides).toBe("unmeasured");
    expect(EDITOR_SUPPORT.convert_to_component!.slides).toBe("unmeasured");
  });

  it("equals docs/reference/tools.md § Editor support, cell for cell", () => {
    const doc = readFileSync(new URL("../docs/reference/tools.md", import.meta.url), "utf8");
    const section = doc.split(/^## Editor support\s*$/m)[1]!.split(/^##\s/m)[0]!;
    const rows = new Map<string, string[]>();
    for (const line of section.split(/\r?\n/)) {
      const m = /^\|\s*`figma_([a-z_]+)`\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|/.exec(line);
      if (m) {
        expect(rows.has(m[1]!), `duplicate row ${m[1]}`).toBe(false);
        rows.set(m[1]!, [m[2]!, m[3]!, m[4]!]);
      }
    }
    expect([...rows.keys()].sort()).toEqual(Object.keys(EDITOR_SUPPORT).sort());
    for (const [op, row] of Object.entries(EDITOR_SUPPORT)) expect(rows.get(op), op).toEqual([row.figma, row.figjam, row.slides]);
  });
});

describe("editorRefusal: the truth table", () => {
  const bridge = { allowUnverified: false, layer: "bridge" } as const;
  const plugin = { allowUnverified: false, layer: "plugin" } as const;

  it("'no' refuses a read and a write, at both layers, whatever the flag", () => {
    for (const opts of [bridge, plugin, { ...bridge, allowUnverified: true }]) {
      expect(editorRefusal("get_motion_context", "figjam", opts), opts.layer).not.toBeNull();
      expect(editorRefusal("create_paint_style", "slides", opts), opts.layer).not.toBeNull();
    }
  });

  it("'unmeasured' refuses a write at the bridge only, runs a read, and the flag lets the write through", () => {
    expect(supportOf("set_fills", "figjam")).toBe("unmeasured");
    expect(editorRefusal("set_fills", "figjam", bridge)).not.toBeNull();
    expect(editorRefusal("set_fills", "figjam", { ...bridge, allowUnverified: true })).toBeNull();
    expect(editorRefusal("set_fills", "figjam", plugin)).toBeNull();
    expect(supportOf("get_styles", "slides")).toBe("unmeasured");
    expect(editorRefusal("get_styles", "slides", bridge)).toBeNull();
  });

  it("'yes' runs; Design runs everything but the board and deck tools", () => {
    for (const op of OPS.keys()) if (EDITOR_SUPPORT[op]!.figma === "yes") expect(editorRefusal(op, "figma", bridge), op).toBeNull();
    expect(editorRefusal("create_stickies", "figma", bridge)!.message).toMatch(/^figma_create_stickies does not run in Figma Design files. The Plugin API creates stickies only in FigJam files.$/);
    expect(editorRefusal("get_slide_grid", "figjam", bridge)!.hint).toMatch(/^Runs in: Figma Slides. In FigJam: read the board with figma_get_metadata./);
    expect(editorRefusal("get_slide_grid", "slides", bridge)).toBeNull();
    expect(editorRefusal("get_design_context", "slides", bridge)).toBeNull();
    expect(editorRefusal("export_frames_to_pdf", "figjam", bridge)).toBeNull();
  });

  it("an unknown editor refuses everything at the bridge except the bridge's own ops; the plugin leaves it to the bridge", () => {
    for (const editor of ["dev", "buzz", undefined]) {
      expect(editorRefusal("get_node", editor, bridge)?.message).toMatch(/cannot run here: the plugin reports editorType/);
      expect(editorRefusal("status", editor, bridge)).toBeNull();
      expect(editorRefusal("get_guide", editor, bridge)).toBeNull();
      expect(editorRefusal("get_node", editor, plugin)).toBeNull();
    }
    expect(editorRefusal("get_node", "dev", bridge)!.hint).toBe("Open one of those files and run the plugin there.");
  });

  it("an op outside the catalog is left to the 'too old' check", () => {
    expect(editorRefusal("no_such_op", "figjam", bridge)).toBeNull();
  });

  it("says which editor and file, why, and where it does run", () => {
    const r = editorRefusal("create_paint_style", "figjam", {
      ...bridge,
      session: { sessionId: "s-4", file: "Retro board" },
      others: [
        { sessionId: "s-2", file: "Landing", editorType: "figma" },
        { sessionId: "s-5", file: "Deck", editorType: "slides" },
      ],
    })!;
    expect(r.message).toBe(
      'figma_create_paint_style does not run in FigJam files (session s-4, "Retro board"). The Plugin API creates local styles only in Figma Design files.',
    );
    expect(r.hint).toBe('Runs in: Figma Design. Connected files where it runs: "Landing" (Figma Design, s-2) — pass session: "Landing".');
    const unmeasured = editorRefusal("set_layout_grids", "figjam", { ...bridge, session: { sessionId: "s-4", file: "Retro board" } })!;
    expect(unmeasured.message).toBe(
      'figma_set_layout_grids has not been verified in FigJam files yet, so Figxel refuses its writes there (session s-4, "Retro board").',
    );
    expect(unmeasured.hint).toBe("Runs in: Figma Design. Open a Figma Design file and run the plugin there.");
    expect(editorRefusal("export_video", "slides", bridge)!.hint).toMatch(/In Figma Slides: export a still image with figma_export_node, or the deck/);
  });

  it("a batch is refused whole at its first step that may not run, prefixed steps[i]", async () => {
    const steps = [{ op: "set_fills", params: {} }, { op: "figma_set_layout_grids", params: {} }];
    expect(callRefusal("batch", { steps }, "figjam", bridge)!.message).toMatch(/^steps\[0\]: figma_set_fills has not been verified/);
    await withCell("set_fills", { figjam: "yes" }, () => {
      expect(callRefusal("batch", { steps }, "figjam", bridge)!.message).toMatch(/^steps\[1\]: figma_set_layout_grids has not been verified/);
      expect(callRefusal("batch", { steps: JSON.stringify(steps) }, "figjam", bridge)!.message).toMatch(/^steps\[1\]/);
    });
    expect(callRefusal("batch", { steps }, "figma", bridge)).toBeNull();
    expect(callRefusal("batch", { steps: "[not json" }, "figjam", bridge)).toBeNull(); // the plugin names the field
  });
});

describe("the Editors sentence at the end of a description", () => {
  it("has one form per kind of row", () => {
    expect(editorsSuffix("get_node")).toBe("");
    expect(editorsSuffix("set_fills")).toBe(" Editors: Design; unverified: FigJam, Slides.");
    expect(editorsSuffix("create_paint_style")).toBe(" Editors: Design only.");
    expect(editorsSuffix("convert_to_component")).toBe(" Editors: Design; unverified: Slides.");
    return withCell("set_fills", { figma: "no", figjam: "unmeasured", slides: "no" }, async () => {
      expect(editorsSuffix("set_fills")).toBe(" Editors: FigJam only, unverified.");
      await withCell("set_fills", { figma: "unmeasured", figjam: "unmeasured", slides: "unmeasured" }, () => {
        expect(editorsSuffix("set_fills")).toBe(" Editors: unverified in Design, FigJam, Slides.");
      });
      await withCell("set_fills", { figma: "no", figjam: "no", slides: "yes" }, () => {
        expect(editorsSuffix("set_fills")).toBe(" Editors: Slides only.");
      });
      await withCell("set_fills", { figma: "yes", figjam: "yes", slides: "no" }, () => {
        expect(editorsSuffix("set_fills")).toBe(" Editors: Design, FigJam.");
      });
    });
  });

  it("every registered tool ends with its sentence, stays within 1024, and no body is cut", async () => {
    // Eval and the held-back audio group too: their descriptions obey the same cap.
    const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-editors-")), BRIDGE_PORT: "0", BRIDGE_ALLOW_EVAL: "1", BRIDGE_ENABLE_AUDIO: "1" });
    const bridge = { request: async () => ({}), statusAsync: async () => ({ sessions: [] }), status: () => ({ sessions: [] }) } as unknown as Bridge;
    // The bodies as each module wrote them: a server that ignores the recorder's wrapper.
    const bodies = new Map<string, string>();
    const capture = (name: string, config: { description?: string }) => void bodies.set(name, config.description ?? "");
    const rawServer = { get registerTool() { return capture; }, set registerTool(_wrapped: unknown) {}, registerPrompt() {} } as unknown as McpServer;
    registerTools(rawServer, bridge, config, Date.now(), quietLogger);

    const server = new McpServer({ name: "editors", version: "0" });
    registerTools(server, bridge, config, Date.now(), quietLogger);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "editors-check", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    cleanup.push(() => client.close());
    const { tools } = await client.listTools();
    expect(tools.length).toBe(bodies.size);
    expect(tools.length).toBe(selectOps({ kind: "full" }, true, true).length);
    for (const t of tools) {
      const suffix = editorsSuffix(t.name.replace(/^figma_/, ""));
      const body = bodies.get(t.name)!;
      expect(fitDescription(body, 1024 - suffix.length), `${t.name} would lose text to its Editors sentence`).toBe(body);
      expect(t.description, t.name).toBe(body + suffix);
      expect(t.description!.length, t.name).toBeLessThanOrEqual(1024);
    }
  });
});

// ── the bridge gate ─────────────────────────────────────────────────────────

describe("the bridge refuses before anything reaches Figma", () => {
  async function twoFiles(bridgeOpts: { allowUnverified?: boolean } = {}, boardOps?: string[]) {
    const token = newToken();
    const bridge = await startBridge({ token, ...bridgeOpts });
    cleanup.push(() => bridge.close());
    const design = await connectedMock(bridge, token, { fileName: "Landing", ops: ["create_page", "create_frame", "create_paint_style", "get_metadata"] });
    cleanup.push(() => design.close());
    // Connected last, so it is the active (most recent) file.
    const board = await connectedMock(bridge, token, {
      fileName: "Retro board",
      editorType: "figjam",
      ops: boardOps ?? ["create_page", "create_frame", "create_paint_style", "get_metadata", "batch"],
    });
    cleanup.push(() => board.close());
    return { token, bridge, design, board };
  }

  it("a board asked for an unverified write: UNSUPPORTED, created [], safeToRetry, no frame sent, hint names the Design file", async () => {
    const { bridge, design, board } = await twoFiles();
    const err = await rejection(bridge.request("create_page", { name: "P2" }));
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toMatch(/^figma_create_page has not been verified in FigJam files yet/);
    expect(err.message).toContain('"Retro board"');
    expect(err.hint).toContain(`"Landing" (Figma Design, ${design.state.sessionId}) — pass session: "Landing"`);
    expect(err.partial).toEqual({ created: [] });
    expect(err.idempotencyKey).toMatch(/^k-/);
    expect(errorResult(err).structuredContent).toMatchObject({ code: "UNSUPPORTED", safeToRetry: true, partial: { created: [] } });
    expect(requestsSeen(board)).toHaveLength(0);
    expect(requestsSeen(design)).toHaveLength(0);
  });

  it("a 'no' cell gets the editor's reason, not 'plugin too old', even when the plugin lacks the op", async () => {
    const { bridge, board } = await twoFiles({}, ["get_metadata"]);
    const err = await rejection(bridge.request("create_paint_style", { name: "x", color: "#fff" }));
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.message).toMatch(/does not run in FigJam files/);
    expect(err.hint).not.toMatch(/plugin is older than this server/);
    expect(requestsSeen(board)).toHaveLength(0);
    // A read the editor runs still meets the ordinary check.
    expect((await rejection(bridge.request("get_pages", {}))).hint).toMatch(/plugin is older than this server/);
  });

  it("a 'no' read is refused too, and carries no created marker (reads are always safe to retry)", async () => {
    const { bridge, board } = await twoFiles({}, ["get_motion_context"]);
    const err = await rejection(bridge.request("get_motion_context", {}));
    expect(err.message).toMatch(/does not run in FigJam files/);
    expect(err.partial).toBeUndefined();
    expect(requestsSeen(board)).toHaveLength(0);
  });

  it("a batch with one unverified step is refused whole, prefixed steps[i], and no frame is sent", async () => {
    const { bridge, board } = await twoFiles();
    const steps = [{ op: "set_fills", params: { nodeIds: ["1:2"], fills: [{ color: "#fff" }] } }, { op: "set_layout_grids", params: { nodeIds: ["1:2"] } }];
    await withCell("set_fills", { figjam: "yes" }, async () => {
      const err = await rejection(bridge.request("batch", { steps }));
      expect(err.code).toBe("UNSUPPORTED");
      expect(err.message).toMatch(/^steps\[1\]: figma_set_layout_grids has not been verified in FigJam files/);
      expect(err.partial).toEqual({ created: [] });
    });
    expect(requestsSeen(board)).toHaveLength(0);
  });

  it("BRIDGE_ALLOW_UNVERIFIED lets an unverified write reach the plugin, and still refuses a 'no'", async () => {
    const { bridge, board } = await twoFiles({ allowUnverified: true });
    const made = (await bridge.request("create_frame", { name: "Measured" })) as { name: string };
    expect(made.name).toBe("Measured");
    expect(requestsSeen(board)).toHaveLength(1);
    const err = await rejection(bridge.request("create_paint_style", { name: "x", color: "#fff" }));
    expect(err.message).toMatch(/does not run in FigJam files/);
    expect(requestsSeen(board)).toHaveLength(1);
  });

  it("a name two files share picks the one whose editor runs the op; no name keeps the active file", async () => {
    const token = newToken();
    const bridge = await startBridge({ token });
    cleanup.push(() => bridge.close());
    const design = await connectedMock(bridge, token, { fileName: "Same" });
    cleanup.push(() => design.close());
    const board = await connectedMock(bridge, token, { fileName: "Same", editorType: "figjam" });
    cleanup.push(() => board.close());
    await bridge.request("create_frame", { name: "In Design" }, { session: "Same" });
    expect(requestsSeen(design)).toHaveLength(1);
    expect(requestsSeen(board)).toHaveLength(0);
    // A read runs in both: the most recent of the two, as before.
    await bridge.request("get_metadata", {}, { session: "Same" });
    expect(requestsSeen(board)).toHaveLength(1);
    // No session: the active file (the board), never a silent reroute.
    const err = await rejection(bridge.request("create_frame", {}));
    expect(err.message).toMatch(/FigJam/);
    expect(err.hint).toContain('pass session: "Same"');
  });
});

describe("through a proxy: the flag belongs to the process the MCP client talks to", () => {
  async function hubWithBoard(hubOpts: { allowUnverified?: boolean } = {}) {
    const token = newToken();
    const hub = await startBridge({ token, ...hubOpts });
    cleanup.push(() => hub.close());
    const board = await connectedMock(hub, token, { fileName: "Board", editorType: "figjam", ops: ["create_frame", "create_paint_style"] });
    cleanup.push(() => board.close());
    const proxy = async (allowUnverified: boolean) => {
      const p = await startBridge({ token, port: hub.port, allowUnverified });
      cleanup.push(() => p.close());
      expect(p.role).toBe("proxy");
      return p;
    };
    return { hub, board, proxy };
  }

  it("the hub refuses a proxy's unverified write with partial intact; the proxy's own flag lets it through", async () => {
    const { board, proxy } = await hubWithBoard();
    const strict = await proxy(false);
    const err = await rejection(strict.request("create_frame", { name: "x" }, { idempotencyKey: "via-proxy" }));
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.partial).toEqual({ created: [] });
    expect(err.idempotencyKey).toBe("via-proxy");
    expect(requestsSeen(board)).toHaveLength(0);

    const measuring = await proxy(true);
    expect(((await measuring.request("create_frame", { name: "Measured" })) as { name: string }).name).toBe("Measured");
    expect(requestsSeen(board)).toHaveLength(1);
    // The flag rode on that one call only: the strict proxy is still refused.
    expect((await rejection(strict.request("create_frame", { name: "again" }))).code).toBe("UNSUPPORTED");
  });

  it("a 'no' cell is refused through a flagged proxy, and through a flagged hub", async () => {
    const { board, proxy } = await hubWithBoard({ allowUnverified: true });
    const measuring = await proxy(true);
    const err = await rejection(measuring.request("create_paint_style", { name: "x", color: "#fff" }));
    expect(err.message).toMatch(/does not run in FigJam files/);
    expect(requestsSeen(board)).toHaveLength(0);
  });

  it("a proxy reports the hub's build and flag", async () => {
    const { proxy } = await hubWithBoard({ allowUnverified: true });
    const st = await (await proxy(false)).statusAsync();
    expect(st.serverBuild).toBe("dev");
    expect(st.allowUnverified).toBe(true);
  });
});

// ── the plugin gate ─────────────────────────────────────────────────────────

describe("the plugin refuses 'no' cells itself, for an older hub", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  async function result(fake: FakeFigma, id: string) {
    for (let i = 0; i < 100; i++) {
      const hit = fake.posted.find((m) => (m as { msg?: { t?: string; id?: string } }).msg?.t === "result" && (m as { msg: { id: string } }).msg.id === id);
      if (hit) return (hit as { msg: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; hint?: string }; partial?: unknown } }).msg;
      await sleep(5);
    }
    throw new Error(`no result for ${id}`);
  }

  it("execute(): UNSUPPORTED with created [], no commitUndo, and the key is not pinned", async () => {
    const fake = new FakeFigma({ editorType: "slides", fileName: "Deck" });
    let styles = 0;
    Object.assign(fake, { createPaintStyle: () => ({ id: `S:${++styles}`, name: "", type: "PAINT" }) });
    uninstall = installFigma(fake);
    (globalThis as { __html__?: string }).__html__ = "<html></html>";
    // The runner wires itself to `figma` when it loads, so it is imported after the fake exists.
    const runner = ["..", "src", "plugin", "code.js"].join("/");
    await import(/* @vite-ignore */ runner);
    const send = (msg: Record<string, unknown>) => fake.ui.onmessage!({ kind: "wire", msg: { t: "request", idleTimeoutMs: 30_000, ...msg } });

    send({ id: "r-1", op: "create_paint_style", params: { name: "Brand", color: "#ff0000" }, idempotencyKey: "k-style" });
    const refused = await result(fake, "r-1");
    expect(refused.ok).toBe(false);
    expect(refused.error!.code).toBe("UNSUPPORTED");
    expect(refused.error!.message).toMatch(/^figma_create_paint_style does not run in Figma Slides files\. /);
    expect(refused.partial).toEqual({ created: [] });
    expect(fake.undoCommits).toBe(0);
    expect(styles).toBe(0);

    // The same key, in a Design file: it runs — it was never pinned to the refusal.
    fake.editorType = "figma";
    send({ id: "r-2", op: "create_paint_style", params: { name: "Brand", color: "#ff0000" }, idempotencyKey: "k-style" });
    const ran = await result(fake, "r-2");
    expect(ran.ok).toBe(true);
    expect(ran.data).toMatchObject({ id: "S:1", idempotencyKey: "k-style" });
    expect(ran.data!.replayed).toBeUndefined();
    expect(fake.undoCommits).toBe(1);

    // A 'no' read is refused without the write marker; an unverified write is the bridge's call, not the plugin's.
    fake.editorType = "figjam";
    send({ id: "r-3", op: "get_motion_context", params: {} });
    const read = await result(fake, "r-3");
    expect(read.error!.message).toMatch(/does not run in FigJam files/);
    expect(read.partial).toBeUndefined();
  });

  it("the batch op checks every step before the first runs", async () => {
    const fake = new FakeFigma({ editorType: "figjam" });
    uninstall = installFigma(fake);
    const ran: string[] = [];
    const stub = (name: string): PluginOp => ({ write: true, run: async () => void ran.push(name) });
    const batch = makeBatchOp(() => ({ set_opacity: stub("set_opacity"), set_fills: stub("set_fills") }));
    const steps = [{ op: "set_opacity", params: {} }, { op: "set_fills", params: {} }];
    // Unverified steps are the bridge's call: the plugin runs them.
    await batch.run(opContext({ steps }));
    expect(ran).toEqual(["set_opacity", "set_fills"]);
    ran.length = 0;
    await withCell("set_fills", { figjam: "no", why: "Test reason." }, async () => {
      const err = await batch.run(opContext({ steps })).catch((e: unknown) => e as BridgeError);
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).code).toBe("UNSUPPORTED");
      expect((err as BridgeError).message).toBe("steps[1]: figma_set_fills does not run in FigJam files. Test reason.");
      expect((err as BridgeError).partial).toEqual({ created: [] });
    });
    expect(ran).toEqual([]);
  });
});

// ── what an agent sees ──────────────────────────────────────────────────────

describe("figma_status per session", () => {
  const view = (sessionId: string, name: string, editorType: string, extra: Record<string, unknown> = {}) => ({
    sessionId, instanceId: sessionId, pluginVersion: "0", apiVersion: "1.0.0", editorType, ops: [], file: { name, key: null },
    page: null, user: null, connectedAt: 0, lastSeenAt: 0, lastActiveAt: 0, selection: null, lastNodesChanged: null, active: false, ...extra,
  });
  const status = (sessions: unknown[], extra: Partial<BridgeStatus> = {}) =>
    ({ role: "hub", listening: true, reason: null, port: 0, host: "127.0.0.1", hubPid: 1, peers: 0, lastAuthFailureAt: null, serverBuild: "dev", allowUnverified: false, sessions, ...extra }) as BridgeStatus;
  const run = async (st: BridgeStatus, env: Record<string, string> = {}) => {
    const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-st-")), BRIDGE_PORT: "0", ...env });
    const registered = selectOps(config.toolset, config.allowEval, config.enableAudio).map(toolName);
    return (await buildStatus({
      bridge: { statusAsync: async () => st } as unknown as Bridge,
      config,
      startedAt: Date.now(),
      selectedTools: registered,
      registeredTools: registered,
    })) as { bridge: Record<string, unknown>; sessions: Array<Record<string, unknown> & { unavailableTools: string[] }>; hint: string };
  };

  it("a board lists what it refuses; a Design file only the board and deck tools; the hint names each file's editor", async () => {
    const out = await run(status([view("s-1", "Landing", "figma", { active: true }), view("s-2", "Retro", "figjam")]));
    const [design, board] = out.sessions;
    expect(design!.editor).toBe("Figma Design");
    expect(design!.unavailableTools).toEqual(refusedTools("figma", false));
    expect(design!.unavailableTools).toContain("figma_create_stickies");
    expect(design!.unavailableTools).toContain("figma_get_slide_grid");
    expect(design!.unavailableTools).not.toContain("figma_create_page");
    expect(design!.unverifiedTools).toBe(3); // figma_fit_sections, figma_check_motion, figma_create_animatic
    expect(board!.unavailableTools).toContain("figma_create_slides");
    expect(board!.editor).toBe("FigJam");
    expect(board!.unavailableTools).toContain("figma_create_page");
    expect(board!.unavailableTools).toContain("figma_create_paint_style");
    expect(board!.unavailableTools).not.toContain("figma_get_node");
    expect(board!.unavailableTools).not.toContain("figma_status");
    expect(board!.unverifiedTools).toBe(unverifiedTools("figjam").length);
    expect(out.bridge.allowUnverified).toBe(false);
    expect(out.hint).toContain('"Retro" (FigJam, s-2)');
    expect(out.hint).toContain("pass `session`");
  });

  it("with the flag, only the 'no' cells stay unavailable; an unsupported editor refuses everything", async () => {
    const out = await run(status([view("s-2", "Retro", "figjam"), view("s-3", "Inspect", "dev")]), { BRIDGE_ALLOW_UNVERIFIED: "1" });
    expect(out.bridge.allowUnverified).toBe(true);
    expect(out.sessions[0]!.unavailableTools).toEqual(refusedTools("figjam", true));
    expect(out.sessions[0]!.unavailableTools).toContain("figma_create_paint_style");
    expect(out.sessions[0]!.unavailableTools).not.toContain("figma_create_page");
    expect(out.sessions[0]!.unavailableTools).not.toContain("figma_create_stickies");
    expect(out.sessions[0]!.unavailableTools).toContain("figma_get_slide_grid");
    expect(out.sessions[1]!.editor).toBe('unsupported (editorType "dev")');
    expect(out.sessions[1]!.unavailableTools).toContain("figma_get_node");
    expect(out.sessions[1]!.unavailableTools).not.toContain("figma_status");
  });

  it("a hub's flag counts for a proxy's calls too", async () => {
    const out = await run(status([view("s-2", "Retro", "figjam")], { role: "proxy", allowUnverified: true }));
    expect(out.bridge.allowUnverified).toBe(true);
  });

  it("a proxy joined to a hub that sends no build is told to restart the client that started the hub", async () => {
    const dist = buildIdOnDisk();
    if (!dist) return; // dist/ not built
    const out = await run(status([view("s-1", "Landing", "figma", { active: true, buildId: dist })], { role: "proxy", hubPid: 4242, serverBuild: null }));
    expect(out.sessions[0]!.build).toMatchObject({ server: "unknown", restart: "client" });
    expect(out.hint).toContain("holding the Figma connection (pid 4242) is older than the installed version");
    const current = await run(status([view("s-1", "Landing", "figma", { active: true, buildId: dist })], { role: "proxy", hubPid: 4242, serverBuild: dist }));
    expect((current.sessions[0]!.build as { restart?: string }).restart).toBeUndefined();
  });
});

describe("session choice by name", () => {
  type S = { state: SessionState };
  const session = (id: string, name: string, editorType: string, lastActiveAt: number): S => ({
    state: {
      sessionId: id, person: "local", instanceId: id, pluginVersion: "0", apiVersion: "1", editorType, ops: new Set(), file: { name, key: null },
      page: null, user: null, connectedAt: 0, lastSeenAt: 0, lastActiveAt, selection: null, lastNodesChanged: null,
    },
  });
  const runs = (op: string) => (s: S) => editorRefusal(op, s.state.editorType, { allowUnverified: false, layer: "bridge" }) === null;

  it("prefers the file whose editor runs the op among same-named files; no name means the most recent", () => {
    const reg = new SessionRegistry<S>();
    reg.add(session("s-1", "Plan", "figma", 1));
    reg.add(session("s-2", "Plan", "figjam", 2));
    expect(reg.select("Plan")!.state.sessionId).toBe("s-2");
    expect(reg.select("plan", runs("create_page"))!.state.sessionId).toBe("s-1");
    expect(reg.select("Plan", runs("get_node"))!.state.sessionId).toBe("s-2");
    expect(reg.select(undefined, runs("create_page"))!.state.sessionId).toBe("s-2");
    expect(reg.select("s-2", runs("create_page"))!.state.sessionId).toBe("s-2");
    // Neither runs it: still the named file (the most recent), so the refusal names it.
    reg.add(session("s-3", "Boards", "figjam", 3));
    reg.add(session("s-4", "Boards", "slides", 4));
    expect(reg.select("Boards", runs("create_page"))!.state.sessionId).toBe("s-4");
  });
});

describe("links name an editor", () => {
  it("/slides/ links parse with editor slides; /board/ is FigJam; the rest Design", () => {
    expect(toNodeId("https://www.figma.com/slides/AbC123/Q4-Deck?node-id=1-2&t=x")).toEqual({ id: "1:2", fileKey: "AbC123", fileSlug: "Q4-Deck", editor: "slides" });
    expect(toNodeId("https://www.figma.com/board/K9/Retro?node-id=3-4").editor).toBe("figjam");
    expect(toNodeId("https://www.figma.com/design/K9/Landing?node-id=3-4").editor).toBe("figma");
    expect(toNodeId("https://www.figma.com/proto/K9/Landing?node-id=3-4").editor).toBe("figma");
    expect(extractFileKey("https://www.figma.com/slides/AbC123/Q4-Deck")).toBe("AbC123");
    expect(normalizeIdParams({ nodeId: "https://www.figma.com/slides/AbC123/Q4-Deck?node-id=1-2" }).files).toEqual([{ key: "AbC123", slug: "Q4-Deck", editor: "slides" }]);
    expect(() => toNodeId("https://www.figma.com/slides/AbC123/Q4-Deck")).toThrow(/no node-id/);
  });
});

describe("a link into another editor's file", () => {
  const extra = { signal: new AbortController().signal, sendNotification: async () => {}, _meta: {} } as unknown as Extra;
  function fakeBridge(sessions: Array<Record<string, unknown>>) {
    const calls: Array<{ op: string; opts: Record<string, unknown> }> = [];
    const bridge = {
      request: async (op: string, _p: Record<string, unknown>, opts: Record<string, unknown>) => {
        calls.push({ op, opts });
        return { node: { id: "1:2" } };
      },
      statusAsync: async () => ({ sessions }),
    } as unknown as Bridge;
    return { bridge, calls };
  }
  const BOARD = "https://www.figma.com/board/K9/Landing?node-id=1-2";

  it("with one Design file connected, a board link's write is refused unchanged and its read runs with a warning", async () => {
    const { bridge, calls } = fakeBridge([{ sessionId: "s-1", file: { name: "Landing" }, editorType: "figma" }]);
    const write = await forwardTool(bridge, "rename_node", { nodeId: BOARD, name: "x" }, extra);
    expect(write.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    expect((write.structuredContent as { message: string }).message).toMatch(/points at a FigJam file but the connected file "Landing" is Figma Design/);
    expect(calls).toEqual([]);
    const read = await forwardTool(bridge, "get_node", { nodeId: BOARD }, extra);
    expect(read.isError).toBeUndefined();
    expect((read.structuredContent as { warning: string }).warning).toMatch(/FigJam file.*Figma Design; ids were used as given/);
    expect(calls).toHaveLength(1);
  });

  it("with a Design file and a board of the same name, the board link goes to the board", async () => {
    const { bridge, calls } = fakeBridge([
      { sessionId: "s-1", file: { name: "Landing" }, editorType: "figma", active: true },
      { sessionId: "s-2", file: { name: "Landing" }, editorType: "figjam" },
    ]);
    await forwardTool(bridge, "rename_node", { nodeId: BOARD, name: "x" }, extra);
    expect(calls[0]!.opts.session).toBe("s-2");
  });

  it("a session that does not report its editor is judged by name, as before", async () => {
    const { bridge, calls } = fakeBridge([{ sessionId: "s-1", file: { name: "Landing" } }]);
    const r = await forwardTool(bridge, "rename_node", { nodeId: BOARD, name: "x" }, extra);
    expect(r.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("BRIDGE_ALLOW_UNVERIFIED", () => {
  it("is off by default, 1 turns it on, anything else refuses to start", () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-cfg-"));
    expect(loadConfig({ BRIDGE_HOME: home }).allowUnverified).toBe(false);
    expect(loadConfig({ BRIDGE_HOME: home, BRIDGE_ALLOW_UNVERIFIED: "1" }).allowUnverified).toBe(true);
    expect(loadConfig({ BRIDGE_HOME: home, BRIDGE_ALLOW_UNVERIFIED: "0" }).allowUnverified).toBe(false);
    expect(() => loadConfig({ BRIDGE_HOME: home, BRIDGE_ALLOW_UNVERIFIED: "yes" })).toThrow(ConfigError);
  });
});
