// What makes an agent work like a designer rather than a code generator:
// guidance that reaches it over MCP, a way to check its own work without
// figma_eval, and granular tools whose defaults produce a good result.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import { loadConfig, readOrCreateToken } from "../src/server/config.js";
import { GUIDE_TOPICS, GUIDES, SERVER_INSTRUCTIONS } from "../src/server/guides.js";
import { GUIDE_TOPIC_NAMES } from "../src/server/skills.js";
import { OPS, toolName } from "../src/shared/ops.js";
import { connect, createApp, type App } from "../src/server/mcp.js";
import { checkLayout } from "../src/plugin/ops/check.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { toReaction } from "../src/plugin/ops/style.js";
import { applySizing, parseSizing } from "../src/plugin/write.js";
import { registerFigjamSpecTypes } from "../src/plugin/figjam/spec-types.js";
import { installFigma, opContext } from "./editor-fakes.js";
import { board } from "./figjam-fakes.js";
import { quietLogger } from "./helpers.js";
import { WriteFigma } from "./write-fakes.js";

// ── guidance over MCP ────────────────────────────────────────────────────────

/**
 * Every `figma_<tool> { key, key: value, … }` a playbook shows, with its
 * top-level keys. Nested braces, brackets and quoted strings are skipped, so a
 * spec's JSON or a `sizing: { horizontal }` value does not count as a key.
 */
function guideCalls(text: string): Array<{ tool: string; keys: string[] }> {
  const out: Array<{ tool: string; keys: string[] }> = [];
  for (const m of text.matchAll(/\b(figma_[a-z_]+) \{/g)) {
    const parts: string[] = [];
    let cur = "";
    let depth = 1;
    let quoted = false;
    for (let i = m.index! + m[0].length; i < text.length && depth > 0; i++) {
      const ch = text[i]!;
      if (quoted || ch === '"') quoted = ch === '"' ? !quoted : quoted;
      else if ("{[(".includes(ch)) depth++;
      else if ("}])".includes(ch)) depth--;
      if (depth === 1 && ch === "," && !quoted) {
        parts.push(cur);
        cur = "";
      } else if (depth > 0) cur += ch;
    }
    parts.push(cur);
    const keys = parts.map((p) => /^\s*([A-Za-z_]\w*)\??\s*(?::|$)/.exec(p)?.[1]).filter((k): k is string => k !== undefined);
    out.push({ tool: m[1]!, keys });
  }
  return out;
}

describe("guidance reaches the agent through MCP", () => {
  let app: App;
  let client: Client;
  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-guide-"));
    const config = loadConfig({ BRIDGE_HOME: home, BRIDGE_PORT: "0", BRIDGE_SESSION_WAIT_MS: "200" });
    app = await createApp(config, readOrCreateToken(config.tokenPath), quietLogger);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "guide-test", version: "0" });
    await Promise.all([connect(app, a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
    await app.close();
  });

  it("the server instructions carry the working loop, not a feature list", () => {
    const text = client.getInstructions() ?? "";
    expect(text).toBe(SERVER_INSTRUCTIONS);
    // Initiative, as the official Figma MCP skills ask for [C-082]: own the brief,
    // never wait to be told the next element, build a section per call.
    expect(text).toMatch(/owns the brief/);
    expect(text).toMatch(/Do not ask permission step by step/);
    expect(text).toMatch(/One section per call/);
    expect(text).not.toMatch(/ONE element/);
    expect(text).toMatch(/build\.restart/);
    expect(text).toMatch(/figma_check_layout/);
    expect(text).toMatch(/figma_get_guide/);
    // Sent before any file connects, so it cannot be per editor: it names the editors and points at their topics.
    expect(text).toMatch(/Figma Design, FigJam and Slides files: figma_status shows each file's editor/);
    expect(text).toMatch(/topic figjam or slides/);
    expect(text.length).toBeLessThan(2000);
  });

  it("figma_get_guide answers every topic without a plugin", async () => {
    for (const topic of new Set([...GUIDE_TOPICS, ...GUIDE_TOPIC_NAMES])) {
      const r = (await client.callTool({ name: "figma_get_guide", arguments: { topic } })) as { content: { text: string }[]; isError?: boolean };
      expect(r.isError).toBeFalsy();
      expect(r.content[0]!.text.length).toBeGreaterThan(300);
    }
    const spec = (await client.callTool({ name: "figma_get_guide", arguments: { topic: "spec" } })) as { content: { text: string }[] };
    expect(spec.content[0]!.text).toMatch(/children\s+array of the same shape/);
  });

  it("the spec grammar is no longer cut off in the tool description", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) expect(`${t.name}:${(t.description ?? "").endsWith("…")}`).toBe(`${t.name}:false`);
    const spec = tools.find((t) => t.name === "figma_create_from_spec")!;
    expect(spec.description).toMatch(/figma_get_guide \{ topic: "spec" \}/);
  });

  it("B-1: the spec guide names the text align words create_text takes, and where hug and fill work", async () => {
    const { tools } = await client.listTools();
    const text = tools.find((t) => t.name === "figma_create_text")!;
    const words = (text.inputSchema.properties as Record<string, { enum?: string[] }>).align!.enum!;
    const listed = /\balign \(([^)]+)\)/.exec(GUIDES.spec)![1]!.split(" | ");
    expect(listed).toEqual(words);
    expect(GUIDES.spec).toMatch(/hug: auto-layout frames and text; fill: children of an\s+auto-layout — anything else is refused/);
  });

  it("create_text advertises its text lengths as figma_set_text_properties does: one string type, a bare number still accepted", async () => {
    // A preprocess that turns a number into its string must reach the wire as
    // its output schema; a zod or SDK change that emits {} or a type array shows here.
    const { tools } = await client.listTools();
    const props = (name: string) => tools.find((t) => t.name === name)!.inputSchema.properties as Record<string, Record<string, unknown>>;
    const create = props("figma_create_text");
    const set = props("figma_set_text_properties");
    for (const key of ["lineHeight", "letterSpacing"]) {
      expect(Object.keys(create[key]!).sort(), key).toEqual(["description", "type"]);
      expect(create[key]!.type, key).toBe("string");
      expect(create[key]!.type, key).toBe(set[key]!.type);
    }
    // The SDK parses with the same schema: a number passes it and reaches the
    // bridge (no plugin is connected here), anything else is an input error.
    const call = async (args: Record<string, unknown>) =>
      JSON.stringify(await client.callTool({ name: "figma_create_text", arguments: { content: "Hi", ...args } }).catch((e: unknown) => String(e)));
    const request = vi.spyOn(app.bridge, "request");
    try {
      expect(await call({ lineHeight: 24, letterSpacing: -0.5 })).toMatch(/NO_SESSION/);
      expect(await call({ lineHeight: "150%", letterSpacing: "0.5px" })).toMatch(/NO_SESSION/);
      expect(await call({ lineHeight: "auto", letterSpacing: 1e-7 })).toMatch(/NO_SESSION/);
      // A px value reaches the bridge as a number, as before the string grammar:
      // a plugin started earlier applies only a number and drops a string silently.
      expect(request.mock.calls.map(([, p]) => [p.lineHeight, p.letterSpacing])).toEqual([[24, -0.5], ["150%", "0.5px"], ["auto", 1e-7]]);
    } finally {
      request.mockRestore();
    }
    expect(await call({ lineHeight: true })).toMatch(/Input validation error[^"]*expected string[^"]*lineHeight/);
  });

  it("offers the build, board, deck, design-to-code, code-to-design and rules prompts", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining([
      "build_board", "build_deck", "build_in_figma", "code_to_design", "create_design_system_rules", "design_to_code",
    ]));
    const r = await client.getPrompt({ name: "build_in_figma", arguments: { brief: "a pricing card" } });
    expect((r.messages[0]!.content as { text: string }).text).toMatch(/a pricing card[\s\S]*Own the brief[\s\S]*one\s+section per tool call/);
  });

  it("every figma_<tool> { … } call a playbook shows names only parameters that tool has", async () => {
    // The SDK strips an unknown key without an error, so a wrong name in a
    // playbook (copied into a project's rules file) fails silently forever.
    const { tools } = await client.listTools();
    const params = new Map(tools.map((t) => [t.name, new Set(Object.keys((t.inputSchema as { properties?: object }).properties ?? {}))]));
    const calls = [SERVER_INSTRUCTIONS, ...Object.values(GUIDES).filter((t): t is string => t !== undefined)].flatMap(guideCalls);
    expect(calls.length).toBeGreaterThan(40);
    const wrong = calls.flatMap((c) => (params.has(c.tool) ? c.keys.filter((k) => !params.get(c.tool)!.has(k)).map((k) => `${c.tool}.${k}`) : []));
    expect(wrong).toEqual([]);
  });

  const promptText = async (name: string, args: Record<string, string>) =>
    ((await client.getPrompt({ name, arguments: args })).messages[0]!.content as { text: string }).text;

  it("design_to_code takes the node as an id or a link", async () => {
    const link = "https://www.figma.com/design/AbC123/Site?node-id=12-34";
    expect(await promptText("design_to_code", { nodeId: link })).toContain(`the Figma node ${link}`);
    expect(await promptText("design_to_code", {})).toMatch(/the selected Figma design[\s\S]*## Verification/);
  });

  it("create_design_system_rules carries the official prompt's arguments, as strings", async () => {
    const text = await promptText("create_design_system_rules", { clientLanguages: "typescript,css", clientFrameworks: "react", rulesPath: "docs/figma-rules.md" });
    expect(text).toMatch(/the stack is typescript,css; react, and write them to docs\/figma-rules\.md/);
    expect(text).toMatch(/figma_get_variable_defs[\s\S]*Append; never overwrite/);
  });

  it("build_board and build_deck carry their editor's playbook and the spec grammar", async () => {
    const boardText = await promptText("build_board", { brief: "a sprint retro for six people" });
    expect(boardText).toMatch(/a sprint retro for six people[\s\S]*one zone per tool call/);
    expect(boardText).toContain(GUIDES.figjam);
    expect(boardText).toContain(GUIDES.spec);
    const deck = await promptText("build_deck", { brief: "a product update", slideCount: "8" });
    expect(deck).toMatch(/a product update\nNumber of slides: 8\.[\s\S]*3–5 slides\s+per batch/);
    expect(deck).toContain(GUIDES.slides);
    expect(await promptText("build_deck", { brief: "a product update" })).not.toMatch(/Number of slides/);
  });

  it("code_to_design takes the source, and asks when code and Figma disagree on a token", async () => {
    const text = await promptText("code_to_design", { source: "src/components/Hero.tsx" });
    expect(text).toMatch(/Build src\/components\/Hero\.tsx in the open Figma file/);
    expect(text).toMatch(/do not invent content/);
    expect(text).toMatch(/ASK the user which one wins/);
    expect(text).toMatch(/Use Inter only when the code names no font/);
  });
});

// ── the playbooks name real tools ───────────────────────────────────────────

/** The tools the parity change added to the catalog; the tool chooser must route to each. */
const NEW_TOOLS = [
  "get_library_variables", "get_component", "get_motion_context",
  "create_variables", "create_grid_style", "import_library_assets", "create_slot",
  "set_clips_content", "batch", "set_variable_properties", "update_variable_collection", "edit_component_property", "delete_component_property", "reset_slot",
  "set_variable_mode", "update_style", "set_description", "set_keyframes", "remove_keyframes", "set_scroll_behavior", "set_prototype_flows",
  "download_assets", "export_video",
  // The role process (spec ADR #42).
  "set_brief", "get_brief", "sign_off",
  // Trust (ADR #43).
  "get_changes", "savepoint", "rollback", "stress_test",
];

/** The FigJam and Slides tools; the tool chooser must route to each too. */
const EDITOR_TOOLS = [
  "create_stickies", "create_shapes_with_text", "create_connectors", "create_table", "create_code_block", "create_link_preview",
  "edit_table", "edit_connectors", "set_board_properties", "fit_sections",
  "get_slide_grid", "create_slides", "set_slide_grid", "move_slides", "set_slide_properties", "set_slide_transition",
];

/** The spec examples a playbook shows: each a one-line JSON object, or an array of roots. */
const specExamples = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\[?\{"type":/.test(l));

describe("the playbooks", () => {
  const all = [SERVER_INSTRUCTIONS, ...Object.values(GUIDES)].join("\n");

  it("name only tools that exist", () => {
    const known = new Set([...OPS.keys()].map(toolName));
    const named = new Set([...all.matchAll(/\bfigma_[a-z_]+/g)].map((m) => m[0]));
    expect([...named].filter((n) => !known.has(n) && !n.endsWith("_"))).toEqual([]);
  });

  it("the tool chooser has a row for every new tool", () => {
    expect([...NEW_TOOLS, ...EDITOR_TOOLS].filter((op) => !OPS.has(op))).toEqual([]);
    expect([...NEW_TOOLS, ...EDITOR_TOOLS].map(toolName).filter((t) => !GUIDES.tools.includes(t))).toEqual([]);
  });

  it("figjam: a wrapper, one zone per call, connectors last, the board audit, diagrams from primitives [C-155] [C-149]", () => {
    // The skill's index and its recipes section, together.
    const fj = `${GUIDES.figjam}\n\n${GUIDES["board-recipes"]}`;
    expect(fj).toMatch(/One white wrapper section/);
    expect(fj).toMatch(/one zone per call/);
    expect(fj).toMatch(/Connectors come LAST[^\n]*never moved or reparented/);
    expect(fj).toMatch(/figma_check_layout \{ nodeId: <zone>, audit: \["board"\] \}/);
    expect(fj).toMatch(/off_palette/);
    expect(fj).toMatch(/Charcoal #1E1E1E/);
    expect(fj).toMatch(/generate_diagram is a hosted service/);
    expect(fj).toMatch(/UNSUPPORTED with safeToRetry true: nothing changed/);
  });

  it("slides: plan first, batches of 3–5, a check per batch, never delete to rebuild, never add the offset back [C-146]", () => {
    const sl = GUIDES.slides;
    expect(sl).toMatch(/never delete slides to rebuild them/);
    expect(sl).toMatch(/3–5 slides per batch/);
    expect(sl).toMatch(/figma_check_layout \{ nodeIds: \[<the batch's slide ids>\] \}/);
    expect(sl).toMatch(/after the FIRST batch[\s\S]*after the LAST/);
    expect(sl).toMatch(/Expect \[\]; never add an offset back by hand/);
    expect(sl).toMatch(/Bullets are ONE text with `list`/);
    expect(sl).toMatch(/figma_export_frames_to_pdf \{ deck: true, outputPath: "deck\.pdf" \}/);
  });

  it("the spec guide's board zone builds on a board in one call: refs resolved, connectors last [C-155]", async () => {
    const [zone] = specExamples(GUIDES.spec);
    expect(zone).toBeDefined();
    const { fake, restore } = board();
    try {
      registerFigjamSpecTypes();
      const r = (await CREATE_OPS.create_from_spec!.run(opContext({ spec: zone }))) as { rootId: string; refs?: Record<string, string> };
      expect(Object.keys(r.refs ?? {}).sort()).toEqual(["idea", "plan", "vote"]);
      const types = [...fake.nodes.values()].map((n) => n.type);
      expect(types.filter((t) => t === "STICKY")).toHaveLength(3);
      expect(types.filter((t) => t === "SHAPE_WITH_TEXT")).toHaveLength(3);
      const lines = [...fake.nodes.values()].filter((n) => n.type === "CONNECTOR") as unknown as Array<{ connectorStart: { endpointNodeId: string }; parent: { children: unknown[] } }>;
      expect(lines.map((l) => l.connectorStart.endpointNodeId)).toEqual([r.refs!.idea, r.refs!.vote]);
      // Built last in the section that declares them: its last two children.
      expect(lines[0]!.parent.children.slice(-2)).toEqual(lines);
    } finally {
      restore();
    }
  });

  it("the slides guide's example builds onto a slide as an array of roots, with no drift [C-146]", async () => {
    const [content] = specExamples(GUIDES.slides);
    expect(content).toBeDefined();
    const fake = new WriteFigma({ editorType: "slides" });
    const restore = installFigma(fake);
    try {
      fake.slideDrift = true;
      const slide = fake.slide();
      const r = (await CREATE_OPS.create_from_spec!.run(opContext({ parentId: slide.id, spec: content }))) as { rootIds: string[]; drift: unknown[] };
      expect(r.rootIds).toHaveLength(3);
      expect(r.drift).toEqual([]);
    } finally {
      restore();
    }
  });

  it("design-to-code: the render is the target, never an asset, and assets come from download_assets", () => {
    const d2c = GUIDES["design-to-code"];
    expect(d2c).toMatch(/## Context[\s\S]*## Implementation[\s\S]*## Verification/);
    expect(d2c).toMatch(/NEVER an asset/);
    expect(d2c).toMatch(/figma_download_assets/);
    expect(d2c).not.toMatch(/scale: 2/);
    expect(d2c).not.toMatch(/list the tokens with values/);
    expect(d2c).toMatch(/HOLD → steps\(1, jump-end\)/);
  });

  it("design-to-code: style values come from figma_get_variable_defs { nodeId }, which reads library styles too [C-081]", () => {
    const d2c = GUIDES["design-to-code"];
    // figma_get_styles is local only: on a library-styled file it has none of these values.
    expect(d2c).not.toMatch(/values come from figma_get_styles/);
    expect(d2c).toMatch(/`stylesUsed`[^\n]*figma_get_variable_defs \{ nodeId \} gives the values of every style/);
    expect(d2c).toMatch(/figma_get_styles lists only this file's local styles/);
  });

  it("design-to-code: motion is read from the screen's layers, which design context marks [C-115]", () => {
    const d2c = GUIDES["design-to-code"];
    expect(d2c).toMatch(/figma_get_motion_context \{ nodeId \} for animated layers — it reads every layer inside/);
    expect(d2c).toMatch(/marks each animated node with `motion`/);
  });

  it("renders for judging are held to the default cap: no playbook passes an explicit scale [C-092]", () => {
    // An explicit scale bypasses the 1024 px inline cap, and the per-section loop sends many renders.
    expect(all).not.toMatch(/figma_export_node \{[^}]*\bscale\b/);
    expect(GUIDES.workflow).toMatch(/figma_export_node \{ nodeId: <section> \} — held to 1024 px/);
  });

  it("rules: assets go to download_assets' real `dir`, inside an export root — there is no saveTo", () => {
    expect(GUIDES.rules).not.toMatch(/saveTo/);
    expect(GUIDES.rules).toMatch(/figma_download_assets \{ nodeIds, dir: <the project's asset folder> \}/);
    expect(GUIDES.rules).toMatch(/`dir` must sit inside the export directory or a BRIDGE_EXPORT_ROOTS entry/);
  });

  it("code-to-design: a local image path must be inside an export root, not anywhere in the repository", () => {
    const c2d = GUIDES["code-to-design"];
    expect(c2d).not.toMatch(/\{ path \} for a file in the repository/);
    expect(c2d).toMatch(/figma_import_image \{ url \}, or \{ path \} for a local file\. The bridge reads only inside the export directory or a BRIDGE_EXPORT_ROOTS entry/);
  });

  it("design-system: a variant changes through instance properties, a mode needs figma_set_variable_mode", () => {
    expect(GUIDES["design-system"]).toMatch(/Change an instance's variant with figma_set_instance_properties/);
    expect(GUIDES["design-system"]).toMatch(/figma_set_variable_mode/);
  });

  it("motion: Figma's easing names, no top-level frame, stop on UNSUPPORTED [C-115]", () => {
    // The old motion topic is the motion skill's mechanics section; the index says to stop too.
    const mechanics = GUIDES.mechanics!;
    expect(mechanics).toMatch(/EASE_IN_AND_OUT, not EASE_IN_OUT/);
    expect(mechanics).toMatch(/never the top-level frame itself/);
    expect(mechanics).toMatch(/UNSUPPORTED, stop/);
    expect(mechanics).toMatch(/figma_export_video/);
    expect(GUIDES.motion).toMatch(/answers UNSUPPORTED, stop/);
  });

  it("prototype: every reaction example is valid JSON", () => {
    const examples = GUIDES.prototype.split("\n").filter((l) => /^\s+\[\{"trigger".*\]$/.test(l));
    expect(examples.length).toBeGreaterThanOrEqual(6);
    // The multi-line conditional example, joined.
    const conditional = /\[\{"trigger":"ON_CLICK","actions":\[\{"type":"CONDITIONAL"[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*/.exec(GUIDES.prototype)![0];
    // Each parses, and figma_set_reactions' own parser accepts every entry.
    for (const e of [...examples, conditional]) {
      const parsed = JSON.parse(e.trim()) as unknown[];
      parsed.forEach((r, i) => expect(() => toReaction(r, i)).not.toThrow());
    }
  });

  it("prototype: a transition's duration is seconds, a trigger's timeout and delay milliseconds [C-056] [C-122]", () => {
    expect(GUIDES.prototype).not.toMatch(/Durations are seconds/);
    type R = { trigger: unknown; action?: Record<string, unknown>; actions?: Array<Record<string, unknown>> };
    const reactions = GUIDES.prototype
      .split("\n")
      .filter((l) => /^\s+\[\{"trigger".*\]$/.test(l))
      .flatMap((l) => JSON.parse(l.trim()) as R[]);
    const waits = reactions
      .map((r) => r.trigger as Record<string, unknown>)
      .flatMap((t) => (typeof t === "object" ? [t.timeout, t.delay].filter((v): v is number => typeof v === "number") : []));
    expect(waits.length).toBeGreaterThan(0);
    // 2 would fire after 2 ms: a splash screen nobody sees.
    for (const ms of waits) expect(ms).toBeGreaterThanOrEqual(100);
    const durations = reactions
      .flatMap((r) => [r.action, ...(r.actions ?? [])])
      .map((a) => a?.duration)
      .filter((d): d is number => typeof d === "number");
    expect(durations.length).toBeGreaterThan(0);
    for (const s of durations) expect(s).toBeLessThan(10);
  });
});

// ── figma_check_layout ───────────────────────────────────────────────────────

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `8:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const white = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
const ink = (v: number) => [{ type: "SOLID", color: { r: v, g: v, b: v } }];
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };

describe("figma_check_layout", () => {
  it("a clean card has no errors or warnings", async () => {
    const card = mk("FRAME", "Card", [0, 0, 300, 200], { fills: white }, [
      mk("TEXT", "Title", [24, 24, 200, 28], { characters: "Pro", fills: ink(0.1), fontSize: 20, textAutoResize: "HEIGHT" }),
    ]);
    const r = await checkLayout(card as never, 100, noYield);
    expect(r.issues.filter((i) => i.severity !== "info")).toEqual([]);
  });

  it("finds what made generated designs look bad, each with a number and a fix", async () => {
    const card = mk("FRAME", "Frame 12", [0, 0, 300, 200], { fills: white, clipsContent: true }, [
      mk("TEXT", "Long", [24, 24, 520, 20], { characters: "a paragraph that never wraps", fills: ink(0.1), fontSize: 14, textAutoResize: "WIDTH_AND_HEIGHT" }),
      mk("TEXT", "Faint", [24, 60, 100, 20], { characters: "faint", fills: ink(0.8), fontSize: 14 }),
      mk("TEXT", "A", [24, 100, 80, 20], { characters: "A", fills: ink(0) }),
      mk("TEXT", "B", [40, 104, 80, 20], { characters: "B", fills: ink(0) }),
      mk("RECTANGLE", "Rectangle 3", [10, 10, 0, 0]),
    ]);
    const r = await checkLayout(card as never, 100, noYield);
    const kinds = r.issues.map((i) => `${i.kind}:${i.name}`);
    expect(kinds).toContain("clipped:Long"); // the parent clips, so the overflow is hidden text
    expect(kinds).toContain("low_contrast:Faint");
    expect(kinds).toContain("overlap:A");
    expect(kinds).toContain("zero_size:Rectangle 3");
    expect(kinds).toContain("default_name:Rectangle 3");
    expect(r.issues.find((i) => i.kind === "low_contrast")!.detail).toMatch(/:1 .*needs 4.5:1/);
  });

  it("a hugging text that runs out of an unclipped parent is text_overflow, with the fix", async () => {
    const col = mk("FRAME", "Column", [0, 0, 300, 200], { fills: white }, [
      mk("TEXT", "Para", [0, 0, 900, 20], { characters: "x", fills: ink(0), textAutoResize: "WIDTH_AND_HEIGHT" }),
    ]);
    const issue = (await checkLayout(col as never, 100, noYield)).issues.find((i) => i.kind === "text_overflow")!;
    expect(issue.severity).toBe("error");
    expect(issue.detail).toMatch(/600 px right.*never wraps/);
  });

  it("raw colours are collected when nodes are not bound to a style or variable", async () => {
    const f = mk("FRAME", "Hero", [0, 0, 10, 10], { fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] }, [
      mk("RECTANGLE", "Bound", [0, 0, 5, 5], { fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1 }, boundVariables: { color: { id: "V:1" } } }] }),
    ]);
    const r = await checkLayout(f as never, 100, noYield);
    expect([...r.rawColors.keys()]).toEqual(["#ff0000"]);
  });
});

// ── granular tools whose defaults look right ─────────────────────────────────

class FakeNode {
  id = `9:${++seq}`;
  name: string;
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  [k: string]: unknown;
  constructor(readonly type: string) {
    this.name = type;
    if (type === "FRAME") Object.assign(this, { fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], layoutMode: "NONE", clipsContent: true, width: 100, height: 100 });
    if (type === "TEXT") Object.assign(this, { textAutoResize: "WIDTH_AND_HEIGHT", width: 10, height: 10 });
  }
  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  appendChild(c: FakeNode) {
    c.parent = this;
    this.children.push(c);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  set layoutSizingHorizontal(v: string) {
    this._h = v;
  }
  get layoutSizingHorizontal(): unknown {
    return this._h;
  }
  set layoutSizingVertical(v: string) {
    this._v = v;
  }
  get layoutSizingVertical(): unknown {
    return this._v;
  }
}

describe("create_frame / create_text defaults", () => {
  let page: FakeNode;
  beforeEach(() => {
    page = new FakeNode("PAGE");
    const all = (n: FakeNode): FakeNode[] => [n, ...n.children.flatMap(all)];
    (globalThis as { figma?: unknown }).figma = {
      currentPage: page,
      createFrame: () => new FakeNode("FRAME"),
      createText: () => new FakeNode("TEXT"),
      createRectangle: () => new FakeNode("RECTANGLE"),
      loadFontAsync: async () => {},
      listAvailableFontsAsync: async () => [],
      getNodeByIdAsync: async (id: string) => all(page).find((n) => n.id === id) ?? null,
    };
  });
  afterEach(() => {
    delete (globalThis as { figma?: unknown }).figma;
  });
  const run = (op: string, params: Record<string, unknown>) =>
    CREATE_OPS[op]!.run({ requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false } as OpContext) as Promise<Record<string, unknown>>;
  const byId = (id: unknown) => {
    const walk = (n: FakeNode): FakeNode | undefined => (n.id === id ? n : n.children.map(walk).find(Boolean));
    return walk(page)!;
  };

  it("an auto-layout frame hugs every axis it was given no size for, and does not clip", async () => {
    const r = await run("create_frame", { name: "Stack", layout: "vertical", gap: 12, padding: "24", width: 320, alignX: "center" });
    const f = byId(r.id);
    // width 320 given: pinned in so many words, since turning auto-layout on leaves the axis hugging
    expect(f.layoutSizingHorizontal).toBe("FIXED");
    expect(f.layoutSizingVertical).toBe("HUG");
    expect(f.clipsContent).toBe(false);
    expect(f.counterAxisAlignItems).toBe("CENTER");
    expect([f.paddingTop, f.paddingLeft, f.itemSpacing]).toEqual([24, 24, 12]);
  });

  it("text in a centred column fills it, wraps, and centres itself", async () => {
    const col = await run("create_frame", { layout: "vertical", width: 320, alignX: "center" });
    const r = await run("create_text", { parentId: col.id, content: "A heading that should wrap inside the card" });
    const t = byId(r.id);
    expect(t.layoutSizingHorizontal).toBe("FILL");
    expect(t.textAutoResize).toBe("HEIGHT");
    expect(t.textAlignHorizontal).toBe("CENTER");
    expect(r.align).toMatch(/follows the column/);
  });

  it("text with an explicit width wraps at that width; an explicit align wins", async () => {
    const r = await run("create_text", { content: "x", width: 240, align: "right" });
    const t = byId(r.id);
    expect([t.width, t.textAutoResize, t.textAlignHorizontal]).toEqual([240, "HEIGHT", "RIGHT"]);
  });

  it("sizing that cannot apply is refused, and nothing is left behind", async () => {
    let err: unknown;
    try {
      await run("create_rectangle", { width: 10, height: 10, sizing: { horizontal: "fill" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).message).toMatch(/needs a parent with auto-layout/);
    expect((err as BridgeError).partial).toEqual({ created: [] });
    expect(page.children).toHaveLength(0);
  });
});

describe("sizing parameter", () => {
  it("parses the panel vocabulary", () => {
    expect(parseSizing("fill")).toEqual({ horizontal: "FILL", vertical: "FILL" });
    expect(parseSizing({ horizontal: "hug" })).toEqual({ horizontal: "HUG", vertical: undefined });
    expect(() => parseSizing({ horizontal: "stretch" })).toThrow(/fixed", "hug" or "fill/);
  });

  it("hug is refused on a node that cannot hug", () => {
    const rect = new FakeNode("RECTANGLE");
    expect(() => applySizing(rect as never, { horizontal: "HUG" })).toThrow(/auto-layout frames and text/);
  });
});
