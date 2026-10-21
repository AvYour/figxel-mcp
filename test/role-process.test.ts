// The role process, enforced by the tools (BRIDGE_PROCESS; spec ADR #42,
// docs/superpowers/plans/2026-10-14-roles-spec.md §3): what counts as new
// work, row by row of §3.3; the gate in front of each create in strict, guided
// and off; a brief in force (stored or adopted) reading nothing; the skill a
// brief waits for; the final exports; every §3.8 message pinned; and where
// strict runs as guided (§3.9).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import { selectOps, toolName } from "../src/shared/ops.js";
import type { Bridge, BridgeStatus } from "../src/server/bridge.js";
import { loadConfig } from "../src/server/config.js";
import { MotionProcess, SkillLedger } from "../src/server/motion-process.js";
import {
  briefIdInForce,
  classifyNewWork,
  finalAnswer,
  newWorkAnswer,
  newWorkHint,
  openBriefsSentence,
  RoleProcess,
  type TargetFacts,
} from "../src/server/role-process.js";
import { gateNewWorkSteps } from "../src/server/tools/batch.js";
import { buildStatus } from "../src/server/tools/meta.js";
import { ALL_SKILLS, brief, RoleWorld, serve, signOffOf, UX_PAGE, type Served } from "./role-fakes.js";

const page: TargetFacts = { type: "PAGE", topLevel: true, childCount: 3 };
const emptyFrame: TargetFacts = { type: "FRAME", topLevel: true, childCount: 0 };
const fullFrame: TargetFacts = { type: "FRAME", topLevel: true, childCount: 4 };
const nestedEmpty: TargetFacts = { type: "FRAME", topLevel: false, childCount: 0 };
const emptySection: TargetFacts = { type: "SECTION", topLevel: true, childCount: 0 };
const section: TargetFacts = { type: "SECTION", topLevel: true, childCount: 2 };
const emptyDeck: TargetFacts = { type: "SLIDE", topLevel: false, childCount: 0, deckHasContent: false };
const deck: TargetFacts = { type: "SLIDE", topLevel: false, childCount: 0, deckHasContent: true };

const kind = (op: string, params: Record<string, unknown>, facts: { editor?: string; target?: TargetFacts } = {}) => classifyNewWork(op, params, facts).kind;
const frameSpec = { type: "frame", name: "Hero" };

// ── §3.3, row by row ────────────────────────────────────────────────────────

describe("classifyNewWork: what counts as new work (spec §3.3)", () => {
  it("figma_create_frame: new at page level; inside a frame, section or slide, and in Slides, an edit", () => {
    expect(classifyNewWork("create_frame", {})).toEqual({ kind: "new", what: "a new top-level frame" });
    expect(classifyNewWork("create_frame", { parentId: "1:2" })).toEqual({ kind: "ask", target: { parentId: "1:2" } });
    expect(kind("create_frame", { parentId: "0:1" }, { target: page })).toBe("new");
    expect(kind("create_frame", { parentId: "1:2" }, { target: emptyFrame })).toBe("edit");
    expect(kind("create_frame", { parentId: "1:2" }, { target: section })).toBe("edit");
    expect(kind("create_frame", {}, { editor: "slides" })).toBe("edit");
    expect(kind("create_frame", {}, { editor: "figjam" })).toBe("new");
  });

  it("figma_create_from_spec: a frame, component or section root at page level, or any spec into an empty top-level frame or section", () => {
    for (const type of ["frame", "component", "section"]) expect(kind("create_from_spec", { spec: { type } }), type).toBe("new");
    // Single texts, shapes and a button at page level are elements, never gated.
    for (const type of ["text", "rectangle", "button", "svg", "image"]) expect(kind("create_from_spec", { spec: { type } }), type).toBe("edit");
    expect(kind("create_from_spec", { spec: [{ type: "text" }, { type: "frame" }], pageId: "0:2" })).toBe("new");
    expect(classifyNewWork("create_from_spec", { spec: frameSpec, parentId: "1:2" })).toEqual({ kind: "ask", target: { parentId: "1:2" } });
    expect(kind("create_from_spec", { spec: frameSpec, parentId: "0:1" }, { target: page })).toBe("new");
    expect(kind("create_from_spec", { spec: { type: "text" }, parentId: "0:1" }, { target: page })).toBe("edit");
    expect(kind("create_from_spec", { spec: { type: "text" }, parentId: "1:2" }, { target: emptyFrame })).toBe("new");
    expect(kind("create_from_spec", { spec: frameSpec, parentId: "1:9" }, { target: emptySection })).toBe("new");
    expect(kind("create_from_spec", { spec: frameSpec, parentId: "1:2" }, { target: fullFrame })).toBe("edit");
    expect(kind("create_from_spec", { spec: frameSpec, parentId: "1:3" }, { target: nestedEmpty })).toBe("edit");
  });

  it("figma_create_from_spec in Slides: new only in a deck where no slide has content", () => {
    expect(classifyNewWork("create_from_spec", { spec: [frameSpec], parentId: "3:1" }, { editor: "slides" })).toEqual({ kind: "ask", target: { parentId: "3:1" } });
    expect(classifyNewWork("create_from_spec", { spec: frameSpec }, { editor: "slides" })).toEqual({ kind: "ask", target: {} });
    expect(kind("create_from_spec", { spec: frameSpec }, { editor: "slides", target: emptyDeck })).toBe("new");
    expect(kind("create_from_spec", { spec: frameSpec }, { editor: "slides", target: deck })).toBe("edit");
  });

  it("figma_create_section: new at page level; a section inside a section is an edit", () => {
    expect(kind("create_section", {})).toBe("new");
    expect(kind("create_section", { parentId: "0:1" }, { target: page })).toBe("new");
    expect(kind("create_section", { parentId: "1:9" }, { target: section })).toBe("edit");
    expect(classifyNewWork("create_section", { parentId: "1:9" })).toEqual({ kind: "ask", target: { parentId: "1:9" } });
  });

  it("figma_create_slides: the first slides of an empty deck; slides added to a deck with content are an edit", () => {
    expect(classifyNewWork("create_slides", { slides: [{}] }, { editor: "slides" })).toEqual({ kind: "ask", target: {} });
    expect(kind("create_slides", { slides: [{}] }, { editor: "slides", target: emptyDeck })).toBe("new");
    expect(kind("create_slides", { slides: [{}] }, { editor: "slides", target: deck })).toBe("edit");
    // Outside Slides the editor gate refuses it in its own words.
    expect(kind("create_slides", { slides: [{}] }, { editor: "figma" })).toBe("edit");
  });

  it("figma_create_storyboard is always new work", () => {
    expect(kind("create_storyboard", { title: "Reel" })).toBe("new");
  });

  it("copies, pages, single elements and every edit are never new work", () => {
    for (const op of [
      "clone_node", "create_page", "create_text", "create_rectangle", "create_ellipse", "create_vector", "import_image", "import_svg",
      "create_instance", "convert_to_component", "combine_as_variants", "create_animatic", "create_stickies", "set_fills", "move_nodes", "batch", "eval",
    ]) {
      expect(kind(op, {}), op).toBe("edit");
    }
  });

  it("a fact the read did not bring reads as an edit: the classifier errs toward edit (§3.1)", () => {
    // Asked once; without the facts on the second pass it never asks again.
    expect(classifyNewWork("create_frame", { parentId: "1:2" }, { target: undefined }).kind).toBe("ask");
    expect(kind("create_frame", { parentId: "1:2" }, { target: { type: "GROUP", topLevel: true, childCount: 0 } })).toBe("edit");
  });
});

// ── the gate through an MCP client ──────────────────────────────────────────

const N1_MESSAGE =
  "figma_create_frame was refused before any change: a designer writes the brief before the first frame, and no brief is in force for this file in this session. Missing: a brief (figma_set_brief).";
const N1_HINT =
  'Name the role the request needs and read its skill: figma_get_guide { topic: "ux" } for screens, flows and anything people operate; "graphic" for posters, ads, posts, print, icons and illustration; "brand" for logos and identity; "slides" for decks; "design-system" for tokens and components; "figjam" for boards; "storyboard" for anything that moves. Then figma_set_brief { role, gear, title, goal, message, success } (a page or more adds the design skill\'s brief lines) and send this call again with the same idempotencyKey. Edits inside existing frames are never gated.';

describe("strict: new work waits for a brief in force", () => {
  let world: RoleWorld;
  let s: Served;
  beforeEach(async () => {
    world = new RoleWorld();
    s = await serve("strict", world);
  });
  afterEach(async () => s.close());

  it("N1: a top-level frame with no brief anywhere is refused before any change, with one read and the exact message", async () => {
    const r = await s.call("figma_create_frame", { name: "Bench booking", idempotencyKey: "frame-1" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: "PROCESS_REQUIRED",
      message: N1_MESSAGE,
      hint: N1_HINT,
      idempotencyKey: "frame-1",
      partial: { created: [], missing: ["a brief (figma_set_brief)"] },
      safeToRetry: true,
    });
    // One read of the file's briefs, in the file the call goes to; the write never left the server.
    expect(world.sent).toEqual([{ op: "get_brief", params: {}, session: "s-1" }]);
  });

  it("N2: with one open brief in the file, the refusal offers it by name to adopt", async () => {
    world.briefs.set("12:40", brief({ id: "12:40" }));
    const r = await s.call("figma_create_from_spec", { spec: JSON.stringify(frameSpec) });
    expect(r.structuredContent).toMatchObject({
      code: "PROCESS_REQUIRED",
      message:
        'figma_create_from_spec was refused before any change: a designer writes the brief before the first frame, and no brief is in force for this file in this session; the file holds an open brief, "Bench booking page" (12:40), from an earlier session. Missing: a brief in force.',
      hint: 'To continue that work, read it: figma_get_brief { briefId: "12:40" }. For different work, write its own: figma_set_brief { role, gear, … }. Then send this call again.',
      partial: { created: [], missing: ["a brief in force"] },
    });
    // Reading it adopts it: the same call then runs, and reads nothing more.
    const read = await s.call("figma_get_brief", { briefId: "12:40" });
    expect(s.data(read)).toMatchObject({ brief: { id: "12:40" }, adopted: true });
    world.sent = [];
    const ran = await s.call("figma_create_from_spec", { spec: JSON.stringify(frameSpec) });
    expect(ran.isError).toBeFalsy();
    expect(world.ops()).toEqual(["create_from_spec"]);
  });

  it("several open briefs are listed, each with its id", () => {
    const roles = new RoleProcess("strict", new SkillLedger(), ALL_SKILLS);
    const two = [
      { id: "12:40", title: "Bench booking page", role: "ux" as const, gear: "page" as const, pageId: "0:1", status: "open" as const, deliverables: [], updatedAt: "" },
      { id: "14:2", title: "Co-op logo", role: "brand" as const, gear: "top" as const, pageId: "0:1", status: "open" as const, deliverables: [], updatedAt: "" },
    ];
    const a = newWorkAnswer(roles, "figma_create_frame", two);
    expect(a.message).toMatch(/; the file holds 2 open briefs, "Bench booking page" \(12:40\), "Co-op logo" \(14:2\), from earlier sessions\. Missing: a brief in force\.$/);
    expect(a.hint).toMatch(/^To continue one of them, read it: figma_get_brief \{ briefId: "12:40" \}, or another of the ids\./);
  });

  it("a brief stored here puts the file's new work in force: nothing more is read", async () => {
    s.ledger.note("ux", "test");
    s.ledger.note("design", "test");
    const stored = await s.call("figma_set_brief", UX_PAGE);
    expect(stored.isError).toBeFalsy();
    world.sent = [];
    for (const [tool, args] of [
      ["figma_create_frame", { name: "Slots" }],
      ["figma_create_section", {}],
      ["figma_create_from_spec", { spec: JSON.stringify(frameSpec) }],
      ["figma_create_storyboard", { title: "Reel", aspect: "9:16", panels: [{ durationS: 2 }] }],
    ] as const) {
      const r = await s.call(tool, args);
      expect(r.isError, tool).toBeFalsy();
    }
    expect(world.ops()).toEqual(["create_frame", "create_section", "create_from_spec", "create_storyboard"]);
    expect(await briefIdInForce(s.roles, world.bridge(), undefined)).toBe("12:40");
  });

  it("an edit runs: a frame inside a frame after one target read, a text with no read at all", async () => {
    world.targets.set("1:2", fullFrame);
    const inFrame = await s.call("figma_create_frame", { parentId: "1:2" });
    expect(inFrame.isError).toBeFalsy();
    expect(world.sent).toEqual([
      { op: "get_brief", params: { target: { parentId: "1:2" } }, session: "s-1" },
      { op: "create_frame", params: { parentId: "1:2" } },
    ]);
    world.sent = [];
    expect((await s.call("figma_create_text", { content: "Hi" })).isError).toBeFalsy();
    expect((await s.call("figma_clone_node", { nodeId: "1:2" })).isError).toBeFalsy();
    expect(world.ops()).toEqual(["create_text", "clone_node"]);
  });

  it("an empty top-level frame filled by spec is new work; the read names the parent (the link form too)", async () => {
    world.targets.set("1:2", emptyFrame);
    const r = await s.call("figma_create_from_spec", { spec: JSON.stringify({ type: "text", content: "Hi" }), parentId: "1-2" });
    expect(r.structuredContent).toMatchObject({ code: "PROCESS_REQUIRED" });
    expect(world.sent).toEqual([{ op: "get_brief", params: { target: { parentId: "1:2" } }, session: "s-1" }]);
  });

  it("a deck with no content: its first slides wait; slides added to a deck with content do not", async () => {
    world.sessions[0]!.editorType = "slides";
    world.targets.set("", emptyDeck);
    // Slides is unmeasured for figma_set_brief, so only BRIDGE_ALLOW_UNVERIFIED keeps strict there.
    s.roles.allowUnverified = true;
    const r = await s.call("figma_create_slides", { slides: [{ name: "Title" }] });
    expect(r.structuredContent).toMatchObject({ code: "PROCESS_REQUIRED", message: expect.stringMatching(/^figma_create_slides was refused before any change/) });
    world.targets.set("", deck);
    expect((await s.call("figma_create_slides", { slides: [{ name: "More" }] })).isError).toBeFalsy();
  });

  it("a plugin that predates briefs is said to be old, with the re-run hint (§3.9)", async () => {
    world.oldPlugin = true;
    const r = await s.call("figma_create_frame", {});
    expect(r.structuredContent).toMatchObject({
      code: "UNSUPPORTED",
      message:
        "Before figma_create_frame, Figxel reads the file's briefs (BRIDGE_PROCESS=strict), and that read failed: The connected plugin predates briefs, so the file's briefs cannot be read.",
      hint: "Ask the user to close the Figxel plugin window and run it again (Plugins → Development → Figxel).",
      partial: { created: [] },
      safeToRetry: true,
    });
    expect(world.ops()).toEqual(["get_brief"]);
  });

  it("any other failed read refuses with the failure, as the motion gate's does", async () => {
    world.briefReadError = new BridgeError(ErrorCode.TIMEOUT, "The plugin did not answer.");
    const r = await s.call("figma_create_section", {});
    expect(r.structuredContent).toMatchObject({
      code: "TIMEOUT",
      message: "Before figma_create_section, Figxel reads the file's briefs (BRIDGE_PROCESS=strict), and that read failed: The plugin did not answer.",
      safeToRetry: true,
    });
  });

  it("a batch of edits reads nothing, and refuses the role process's writes as steps", async () => {
    const edits = JSON.stringify([{ op: "set_opacity", params: { nodeIds: ["1:2"], opacity: 1 } }]);
    expect((await s.call("figma_batch", { steps: edits })).isError).toBeFalsy();
    expect(world.ops()).toEqual(["batch"]);
    for (const op of ["set_brief", "sign_off"]) {
      const r = await s.call("figma_batch", { steps: JSON.stringify([{ op, params: {} }]) });
      expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM", message: `\`steps[0].op\`: "${op}" is checked by the server and runs on its own call.` });
    }
  });

  it("a batch step that is new work is gated as its own op, the whole batch refused at the first", async () => {
    const roles = new RoleProcess("strict", new SkillLedger(), ALL_SKILLS);
    const steps = [
      { op: "set_fills", params: { nodeIds: ["1:2"], fills: [] } },
      { op: "create_frame", params: { name: "X" } },
    ];
    const gate = await gateNewWorkSteps(world.bridge(), roles, steps, undefined);
    expect(gate.refusal?.message).toBe(
      "steps[1]: figma_batch's figma_create_frame step was refused before any change: a designer writes the brief before the first frame, and no brief is in force for this file in this session. Missing: a brief (figma_set_brief).",
    );
    expect((await gateNewWorkSteps(world.bridge(), roles, [steps[0]!], undefined)).refusal).toBeUndefined();
  });
});

describe("guided and off never refuse new work", () => {
  it("guided runs the call and adds the step as processWarnings", async () => {
    const world = new RoleWorld();
    const s = await serve("guided", world);
    try {
      const r = await s.call("figma_create_frame", { name: "Bench booking" });
      expect(r.isError).toBeFalsy();
      expect(s.data(r).processWarnings).toEqual([
        'no brief is in force for this file: figma_get_guide { topic: "ux" } (or the skill of the role the work needs), then figma_set_brief { role, gear, title, goal, message, success }.',
      ]);
      expect(world.ops()).toEqual(["get_brief", "create_frame"]);
      world.briefs.set("12:40", brief({ id: "12:40" }));
      const n2 = await s.call("figma_create_section", {});
      expect(s.data(n2).processWarnings).toEqual([
        'no brief is in force for this file, which holds an open brief, "Bench booking page" (12:40): figma_get_brief { briefId: "12:40" } continues it, figma_set_brief { role, gear, … } starts different work.',
      ]);
    } finally {
      await s.close();
    }
  });

  it("off sends the call alone: no read, no warning", async () => {
    const world = new RoleWorld();
    const s = await serve("off", world);
    try {
      const r = await s.call("figma_create_frame", {});
      expect(r.isError).toBeFalsy();
      expect(s.data(r).processWarnings).toBeUndefined();
      expect(world.ops()).toEqual(["create_frame"]);
      // The tools still work, and nothing is held in force.
      const stored = await s.call("figma_set_brief", UX_PAGE);
      expect(stored.isError).toBeFalsy();
      expect(s.roles.briefs()).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

describe("where strict cannot be satisfied it runs as guided (§3.9)", () => {
  it("a toolset without figma_set_brief: the core tier", async () => {
    const world = new RoleWorld();
    const s = await serve("strict", world, { env: { BRIDGE_TOOLSET: "core" } });
    try {
      expect(s.roles.modeFor({ key: "", sessionId: undefined, editorType: "figma", name: undefined, pageId: undefined, selection: [], allowUnverified: false })).toEqual({
        mode: "guided",
        why: "figma_set_brief is not registered: BRIDGE_TOOLSET has no style group",
      });
      const r = await s.call("figma_create_frame", {});
      expect(r.isError).toBeFalsy();
      expect(s.data(r).processWarnings).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it("a file whose editor does not run figma_set_brief yet: FigJam and Slides, unless BRIDGE_ALLOW_UNVERIFIED", async () => {
    const world = new RoleWorld();
    world.sessions[0]!.editorType = "figjam";
    const s = await serve("strict", world);
    try {
      const r = await s.call("figma_create_section", { name: "Retro" });
      expect(r.isError).toBeFalsy();
      expect(s.data(r).processWarnings).toHaveLength(1);
      const file = { key: "k", sessionId: "s-1", editorType: "figjam", name: "Retro", pageId: "0:1", selection: [], allowUnverified: false };
      expect(s.roles.label(file)).toBe("guided (figma_set_brief is not verified in FigJam files yet)");
      expect(s.roles.label({ ...file, allowUnverified: true })).toBe("strict");
      expect(s.roles.label({ ...file, editorType: "slides" })).toBe("guided (figma_set_brief is not verified in Figma Slides files yet)");
      expect(s.roles.label({ ...file, editorType: "figma" })).toBe("strict");
    } finally {
      await s.close();
    }
  });

  it("final exports need figma_sign_off too", () => {
    const roles = new RoleProcess("strict", new SkillLedger(), ALL_SKILLS);
    roles.registered = new Set(["figma_get_guide", "figma_set_brief", "figma_export_node"]);
    const file = { key: "k", sessionId: "s-1", editorType: "figma", name: "Co-op", pageId: "0:1", selection: [], allowUnverified: false };
    expect(roles.modeFor(file)).toEqual({ mode: "strict" });
    expect(roles.modeFor(file, true)).toEqual({ mode: "guided", why: "figma_sign_off is not registered: BRIDGE_TOOLSET has no style group" });
    expect(new RoleProcess("guided").modeFor(file)).toEqual({ mode: "guided" });
  });
});

// ── the skill a brief waits for (B1) ────────────────────────────────────────

describe("figma_set_brief waits for the role's skill (§3.4 step 1, B1)", () => {
  let world: RoleWorld;
  let s: Served;
  beforeEach(async () => {
    world = new RoleWorld();
    s = await serve("strict", world);
  });
  afterEach(async () => s.close());

  it("B1 at the section gear: the role's skill", async () => {
    const r = await s.call("figma_set_brief", { role: "ux", gear: "section", title: "Slot card", goal: "g", message: "One slot, bookable.", success: ["books in 1 tap"], details: { platform: "web", viewport: ["390x844"], task: "book" } });
    expect(r.structuredContent).toEqual({
      code: "PROCESS_REQUIRED",
      message: "figma_set_brief was refused before any change: a senior UI/UX designer works from the ux skill's process, and this session has not read it. Missing: the ux skill.",
      hint: 'First figma_get_guide { topic: "ux" }. Then send this call again.',
      partial: { created: [], missing: ["the ux skill"] },
      safeToRetry: true,
    });
    expect(world.ops()).toEqual([]);
  });

  it("B1 at the page gear: the design skill too, by the call that reads its brief section", async () => {
    const r = await s.call("figma_set_brief", UX_PAGE);
    expect(r.structuredContent).toMatchObject({
      message:
        "figma_set_brief was refused before any change: a senior UI/UX designer works from the ux skill's process, and this session has not read it. Missing: the ux skill; the design skill.",
      hint: 'First figma_get_guide { topic: "ux" }, then figma_get_guide { topic: "design", section: "brief" }. Then send this call again.',
    });
    s.ledger.note("ux", "test");
    const design = await s.call("figma_set_brief", UX_PAGE);
    expect(design.structuredContent).toMatchObject({
      message:
        "figma_set_brief was refused before any change: at the page gear a senior UI/UX designer also works from the design skill's process, and this session has not read it. Missing: the design skill.",
      hint: 'First figma_get_guide { topic: "design", section: "brief" }. Then send this call again.',
    });
    await s.call("figma_get_guide", { topic: "design", section: "brief" });
    expect((await s.call("figma_set_brief", UX_PAGE)).isError).toBeFalsy();
  });

  it("a role whose skill is not bundled is satisfied by its fallback (graphic and brand until wave B)", async () => {
    const lean = await serve("strict", new RoleWorld(), { bundled: new Set(["design", "workflow", "critique"]) });
    try {
      const args = { role: "graphic", gear: "section", title: "Poster crop", goal: "g", message: "One idea.", success: ["reads at 2 m"], details: { medium: "print", viewing: "a street", bleedMm: 3 } };
      const r = await lean.call("figma_set_brief", args);
      expect(r.structuredContent).toMatchObject({
        message: "figma_set_brief was refused before any change: a senior graphic designer works from the design skill's process, and this session has not read it. Missing: the design skill.",
        hint: 'First figma_get_guide { topic: "design" }. Then send this call again.',
      });
      await lean.call("figma_get_guide", { topic: "design" });
      expect((await lean.call("figma_set_brief", args)).isError).toBeFalsy();
      // The N1 hint names the topic this build serves.
      expect(newWorkHint(lean.roles)).toContain('"design" for posters, ads, posts, print, icons and illustration; "design" for logos and identity;');
    } finally {
      await lean.close();
    }
  });

  it("motion reads the storyboard or the motion skill; illustration its section of the graphic skill", () => {
    const roles = new RoleProcess("strict", new SkillLedger(), ALL_SKILLS);
    expect(roles.missingSkills("motion", "piece")).toEqual([{ skill: "storyboard", call: 'figma_get_guide { topic: "storyboard" }' }]);
    roles.ledger.note("motion", "test");
    expect(roles.missingSkills("motion", "piece")).toEqual([]);
    expect(roles.missingSkills("illustration", "page")).toEqual([
      { skill: "graphic", call: 'figma_get_guide { topic: "graphic", section: "illustration" }' },
      { skill: "design", call: 'figma_get_guide { topic: "design", section: "brief" }' },
    ]);
    // design-system and board never ask for the design skill.
    expect(roles.missingSkills("design-system", "top")).toEqual([{ skill: "design-system", call: 'figma_get_guide { topic: "design-system" }' }]);
    expect(roles.missingSkills("board", "page")).toEqual([{ skill: "figjam", call: 'figma_get_guide { topic: "figjam" }' }]);
  });

  it("guided stores the brief and lists the unread skills as processWarnings", async () => {
    const g = await serve("guided", new RoleWorld());
    try {
      const r = await g.call("figma_set_brief", UX_PAGE);
      expect(r.isError).toBeFalsy();
      expect(g.data(r).processWarnings).toEqual([
        'the ux skill has not been read in this session: figma_get_guide { topic: "ux" }.',
        'the design skill has not been read in this session: figma_get_guide { topic: "design", section: "brief" }.',
      ]);
    } finally {
      await g.close();
    }
  });

  it("one ledger: a skill read through a prompt or a resource counts for both gates", async () => {
    await s.client.getPrompt({ name: "animate_in_figma", arguments: {} });
    expect(s.motion.skillRead).toBe("the prompt animate_in_figma");
    expect(s.roles.missingSkills("motion", "micro")).toEqual([]);
    await s.client.readResource({ uri: "skill://figxel-figjam/SKILL.md" });
    expect(s.roles.missingSkills("board", "page")).toEqual([]);
    expect(s.ledger.entries.map((e) => e.skill)).toEqual(["motion", "figjam"]);
  });
});

// ── final exports (§3.7, E1, E2) ────────────────────────────────────────────

describe("a final export waits for a passing, fresh sign-off on every node of a brief", () => {
  let world: RoleWorld;
  let s: Served;
  beforeEach(async () => {
    world = new RoleWorld();
    world.briefs.set("12:40", brief({ id: "12:40", deliverables: ["12:345"] }));
    s = await serve("strict", world);
  });
  afterEach(async () => s.close());

  it("E1: no sign-off — refused before Figma renders, with the exact message and calls", async () => {
    const r = await s.call("figma_export_node", { nodeId: "12:345", final: true });
    expect(r.structuredContent).toMatchObject({
      code: "PROCESS_REQUIRED",
      message: 'A final export of "Bench booking / 01 Slots" (12:345) waits for a passing sign-off; nothing was written: it has no sign-off.',
      hint: 'Run figma_sign_off { nodeId: "12:345", lenses, rounds }, fix what it lists until ok: true, then figma_export_node { nodeId: "12:345", saveTo, final: true }. An export without `final` writes now.',
      partial: { created: [], missing: ['"Bench booking / 01 Slots" (12:345): it has no sign-off'] },
      safeToRetry: true,
    });
    expect(world.sent).toEqual([
      { op: "get_brief", params: { nodeId: "12:345", fingerprint: true }, session: "s-1" },
      { op: "get_nodes_info", params: { nodeIds: ["12:345"], depth: 0, includeGeometry: false }, session: "s-1" },
    ]);
  });

  it("E2: a sign-off older than the node's last change, or one that did not pass", async () => {
    world.signOffs.set("12:345", signOffOf("12:40"));
    world.prints.set("12:345", "1c9e77d0");
    const stale = await s.call("figma_export_node", { nodeId: "12:345", saveTo: "slots.png", final: true });
    expect(stale.structuredContent).toMatchObject({
      message:
        'A final export of "Bench booking / 01 Slots" (12:345) waits for a passing sign-off; nothing was written: it changed after its sign-off at 2026-10-14T13:05Z (fingerprint 8f3a01c2, now 1c9e77d0).',
      hint: 'Run figma_sign_off { nodeId: "12:345", lenses, rounds }, fix what it lists until ok: true, then figma_export_node { nodeId: "12:345", saveTo: "slots.png", final: true }. An export without `final` writes now.',
    });
    world.signOffs.set("12:345", signOffOf("12:40", { ok: false, fingerprint: "1c9e77d0", checks: [{ name: "craft", ok: false, errors: 0, warnings: 2, infos: 4, unanswered: 1 }] }));
    const failing = await s.call("figma_export_node", { nodeId: "12:345", final: true });
    expect(failing.structuredContent!.message).toBe(
      'A final export of "Bench booking / 01 Slots" (12:345) waits for a passing sign-off; nothing was written: its last sign-off did not pass (3 blockers).',
    );
    expect(world.ops()).not.toContain("export_node");
  });

  it("a fresh, passing sign-off exports; a node of no brief exports; without `final` nothing is read", async () => {
    world.signOffs.set("12:345", signOffOf("12:40", { fingerprint: "1c9e77d0" }));
    world.prints.set("12:345", "1c9e77d0");
    expect((await s.call("figma_export_node", { nodeId: "12:345", final: true })).isError).toBeFalsy();
    expect((await s.call("figma_export_node", { nodeId: "77:1", final: true })).isError).toBeFalsy();
    world.sent = [];
    world.signOffs.clear();
    expect((await s.call("figma_export_node", { nodeId: "12:345" })).isError).toBeFalsy();
    expect(world.ops()).toEqual(["export_node"]);
  });

  it("a brief stored on the page covers only its deliverables in Design; a deck's page is its deliverable", async () => {
    world.briefs.set("0:1", brief({ id: "0:1", gear: "section", deliverables: ["30:1"] }));
    world.covers.set("31:1", "0:1");
    expect((await s.call("figma_export_node", { nodeId: "31:1", final: true })).isError).toBeFalsy();
    world.covers.set("30:1", "0:1");
    expect((await s.call("figma_export_node", { nodeId: "30:1", final: true })).structuredContent).toMatchObject({ code: "PROCESS_REQUIRED" });
  });

  it("the selection stands in for a missing nodeId; with no telling, strict refuses", async () => {
    const none = await s.call("figma_export_node", { final: true });
    expect(none.structuredContent).toMatchObject({ code: "INVALID_PARAM", message: "A final export names its deliverable, so its sign-off can be read: pass `nodeId` (or select one layer)." });
    world.sessions[0]!.selection = { nodeIds: ["12:345"], count: 1, at: 0 };
    expect((await s.call("figma_export_node", { final: true })).structuredContent).toMatchObject({ code: "PROCESS_REQUIRED" });
  });

  it("figma_export_frames_to_pdf: every page of a brief, and with deck the deck's page", async () => {
    const pdf = await s.call("figma_export_frames_to_pdf", { nodeIds: ["12:345", "77:1"], outputPath: "booking.pdf", final: true });
    expect(pdf.structuredContent).toMatchObject({
      code: "PROCESS_REQUIRED",
      message: 'A final export of "Bench booking / 01 Slots" (12:345) waits for a passing sign-off; nothing was written: it has no sign-off.',
      hint: 'Run figma_sign_off { nodeId: "12:345", lenses, rounds }, fix what it lists until ok: true, then figma_export_frames_to_pdf { nodeIds: ["12:345", "77:1"], outputPath: "booking.pdf", final: true }. An export without `final` writes now.',
    });
    world.sessions[0]!.editorType = "slides";
    world.briefs.set("0:1", brief({ id: "0:1", role: "presentation", gear: "page" }));
    s.roles.allowUnverified = true;
    const deckPdf = await s.call("figma_export_frames_to_pdf", { deck: true, outputPath: "deck.pdf", final: true });
    expect(deckPdf.structuredContent).toMatchObject({
      message: "A final export of 0:1 waits for a passing sign-off; nothing was written: it has no sign-off.",
      hint: 'Run figma_sign_off { deck: true, lenses, rounds }, fix what it lists until ok: true, then figma_export_frames_to_pdf { deck: true, outputPath: "deck.pdf", final: true }. An export without `final` writes now.',
    });
  });

  it("several blocked nodes are listed in one message", () => {
    const a = finalAnswer(
      [
        { nodeId: "1:2", name: "A", why: "it has no sign-off" },
        { nodeId: "1:3", why: "its last sign-off did not pass" },
      ],
      'figma_export_frames_to_pdf { nodeIds: ["1:2", "1:3"], outputPath, final: true }',
    );
    expect(a.message).toBe('A final export of 2 nodes waits for a passing sign-off; nothing was written: "A" (1:2): it has no sign-off; 1:3: its last sign-off did not pass.');
    expect(a.hint).toMatch(/^Run figma_sign_off \{ nodeIds: \["1:2", "1:3"\], lenses, rounds \}/);
  });

  it("guided exports and warns; off reads nothing", async () => {
    const g = await serve("guided", world);
    try {
      world.sent = [];
      const r = await g.call("figma_export_frames_to_pdf", { nodeIds: ["12:345"], outputPath: "booking.pdf", final: true });
      // The fake renders no page: the export ran, and its answer carries the warning after the error.
      expect(world.ops()).toContain("export_frames_to_pdf");
      expect(r.content.at(-1)!.text).toBe('processWarnings: "Bench booking / 01 Slots" (12:345): it has no sign-off: figma_sign_off { nodeId: "12:345", lenses, rounds }.');
    } finally {
      await g.close();
    }
    const off = await serve("off", world);
    try {
      world.sent = [];
      expect((await off.call("figma_export_node", { nodeId: "12:345", final: true })).isError).toBeFalsy();
      expect(world.ops()).toEqual(["export_node"]);
    } finally {
      await off.close();
    }
  });
});

// ── figma_status ────────────────────────────────────────────────────────────

describe("figma_status shows the process: the mode per file, the skills read, the briefs (§3.8)", () => {
  const row = (editorType: string) => ({
    sessionId: "s-1", instanceId: "s-1", pluginVersion: "0", apiVersion: "1.0.0", editorType, ops: [], file: { name: "Co-op", key: null },
    page: { id: "0:1", name: "Page 1" }, user: null, connectedAt: 0, lastSeenAt: 0, lastActiveAt: 0, selection: null, lastNodesChanged: null, active: true,
  });
  const st = (editorType: string) =>
    ({ role: "hub", listening: true, reason: null, port: 0, host: "127.0.0.1", hubPid: 1, peers: 0, lastAuthFailureAt: null, serverBuild: "dev", allowUnverified: false, sessions: [row(editorType)] }) as BridgeStatus;
  const status = async (roles: RoleProcess, editorType = "figma", env: Record<string, string> = {}) => {
    const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-roles-st-")), BRIDGE_PORT: "0", ...env });
    const registered = selectOps(config.toolset, config.allowEval, config.enableAudio).map(toolName);
    roles.registered = new Set(registered);
    return (await buildStatus({
      bridge: { statusAsync: async () => st(editorType) } as unknown as Bridge,
      config,
      startedAt: Date.now(),
      selectedTools: registered,
      registeredTools: registered,
      process: new MotionProcess("strict", roles.ledger),
      roles,
    })) as { process: Record<string, unknown>; hint: string };
  };

  it("an open brief is listed and named in the hint until it is signed off", async () => {
    const roles = new RoleProcess("strict", new SkillLedger(), ALL_SKILLS);
    roles.ledger.note("ux", "figma_get_guide { topic: \"ux\" }");
    roles.hold("Co-op (figma)", brief({ id: "12:40", deliverables: ["12:345"] }), "set");
    const out = await status(roles);
    expect(out.process).toEqual({
      mode: "strict",
      motionSkillRead: false,
      roles: "strict",
      skillsRead: ["ux"],
      briefs: [{ briefId: "12:40", title: "Bench booking page", role: "ux", gear: "page", status: "open", deliverables: ["12:345"], signedAt: null }],
    });
    expect(out.hint).toContain('1 brief is open and not signed off: "Bench booking page" (12:40) — figma_sign_off ends it.');
    roles.signedOff("Co-op (figma)", "12:40", "2026-10-16T10:00:00.000Z", ["12:345"]);
    const after = await status(roles);
    expect(after.process.briefs).toEqual([{ briefId: "12:40", title: "Bench booking page", role: "ux", gear: "page", status: "signed", deliverables: ["12:345"], signedAt: "2026-10-16T10:00:00.000Z" }]);
    expect(after.hint).not.toContain("brief is open");
    expect(openBriefsSentence(roles)).toBe("");
  });

  it("says why strict runs as guided: the toolset, the editor", async () => {
    expect((await status(new RoleProcess("strict"), "figma", { BRIDGE_TOOLSET: "core" })).process.roles).toBe("guided (figma_set_brief is not registered: BRIDGE_TOOLSET has no style group)");
    expect((await status(new RoleProcess("strict"), "figjam")).process.roles).toBe("guided (figma_set_brief is not verified in FigJam files yet)");
    expect((await status(new RoleProcess("off"))).process.roles).toBe("off");
    expect((await status(new RoleProcess("guided"))).process.roles).toBe("guided");
  });

  it("two open briefs are named together", () => {
    const roles = new RoleProcess("strict");
    roles.hold("f", brief({ id: "1:1", title: "Page" }), "set");
    roles.hold("f", brief({ id: "2:1", title: "Logo", role: "brand", gear: "top" }), "adopted");
    expect(openBriefsSentence(roles)).toBe('2 briefs are open and not signed off: "Page" (1:1), "Logo" (2:1) — figma_sign_off ends each.');
    expect(roles.inForce("f")?.briefId).toBe("2:1");
    roles.signedOff("f", "2:1", "now", []);
    // The earlier brief this process opened is in force again.
    expect(roles.inForce("f")?.briefId).toBe("1:1");
  });
});
