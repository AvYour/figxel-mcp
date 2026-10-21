// figma_sign_off on the server (spec §3.6): the bar per role and gear — the
// brief complete for its gear, every lens at 8 with verdict pass or, at the
// round budget, an exception that lists what remains — the blockers with the
// calls that clear them (S2), what is forwarded to the plugin's sign_off, the
// motion audit recorded for the final render (§3.10), S1, and the brief
// leaving force on a pass.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GEARS, ROLE_IDS, ROLES, signOffSet, type BriefRecord, type Gear, type LensScore, type RoleId } from "../src/shared/roles.js";
import { VERSION } from "../src/shared/version.js";
import { planKey } from "../src/server/motion-process.js";
import { SKILLS_VERSION } from "../src/server/skills.js";
import { briefGaps, issueBlockers, judgeLenses } from "../src/server/tools/brief.js";
import { writeEpoch } from "../src/server/tools/forward.js";
import { brief, RoleWorld, serve, type Served } from "./role-fakes.js";

/** Every lens the role's sign-off at `gear` asks for, at `score` with `verdict`. */
const lensesFor = (role: RoleId, gear: Gear, score = 9, verdict: "pass" | "fix" = "pass"): LensScore[] => signOffSet(role, gear)!.lenses.map((lens) => ({ lens, score, verdict }));

/** A ux page brief complete for sign-off: the seven lines, the details, the directions, a styleframe, the system. */
function complete(over: Partial<BriefRecord> = {}): BriefRecord {
  return brief({
    id: "12:40",
    lines: {
      goal: "members book a bench slot online",
      message: "You fix your own bike here, with a mechanic beside you.",
      success: ["a visitor books within one scroll at 390 x 844", "every text 16 px or more"],
      audience: "neighbours on a phone",
      proof: ["six repair stands"],
      constraints: ["390 px first"],
      givens: "none",
      tone: { words: ["hands-on", "plain", "welcoming"], not: "cute" },
      format: "390x844 px phone",
      assumptions: ["prices are placeholders"],
    },
    details: { platform: "web", viewport: ["390x844"], task: "book a slot", screens: [{ name: "Slots", states: ["empty"] }] },
    direction0: "a lifestyle photo",
    directions: [{ name: "Timetable", idea: "the timetable", total: 41 }, { name: "Log", idea: "the repair log", total: 37 }],
    chosen: "Timetable",
    styleframes: ["20:1"],
    system: { bodySize: 16, ratio: 1.25, spacingBase: 8, palette: [{ hex: "#1F6F43", role: "action" }] },
    deliverables: ["12:345"],
    ...over,
  });
}

describe("the lenses: the bar, or the round budget with what remains (§3.6 step 2)", () => {
  it("every role and gear: all its lenses at 8 or more with verdict pass clear the bar", () => {
    for (const role of ROLE_IDS) {
      for (const gear of GEARS) {
        if (!signOffSet(role, gear)) continue;
        expect(judgeLenses(role, gear, lensesFor(role, gear, 8), 1), `${role} ${gear}`).toEqual({ blockers: [], exceptions: [] });
      }
    }
  });

  it("the role's lens sets: ux section, ux page, brand, design-system, board, motion piece", () => {
    expect(signOffSet("ux", "section")!.lenses).toEqual(["message", "accessibility", "type and composition", "finish QA"]);
    expect(signOffSet("ux", "page")!.lenses).toContain("usability");
    expect(signOffSet("brand", "top")!.lenses).toContain("mark");
    expect(signOffSet("design-system", "page")!.lenses).toEqual(["completeness", "naming", "tokens", "documentation", "finish QA"]);
    expect(signOffSet("board", "page")!.lenses).toEqual(["purpose and reading order", "structure", "copy", "finish QA"]);
    expect(signOffSet("motion", "piece")!.lenses).toContain("originality");
  });

  it("a lens missing, under the bar in an early round, or marked fix at 9, is a blocker with its call; names match whatever their case", () => {
    const lenses = lensesFor("ux", "page").filter((l) => l.lens !== "copy").map((l) => (l.lens === "usability" ? { ...l, score: 7, verdict: "fix" as const } : l));
    lenses[0] = { ...lenses[0]!, lens: "MESSAGE", verdict: "fix" };
    const { blockers, exceptions } = judgeLenses("ux", "page", lenses, 1);
    expect(exceptions).toEqual([]);
    expect(blockers.map((b) => `${b.what}: ${b.call}`)).toEqual([
      "lens message scored 9 with verdict fix in round 1 of 2: run round 2, or at the budget list what remains",
      "lens usability scored 7 with verdict fix in round 1 of 2: run round 2, or at the budget list what remains",
      'lens copy has no score: score it with the critique skill (figma_get_guide { topic: "critique", section: "lenses" }) and pass it in lenses',
    ]);
  });

  it("at the budget (section 1, page 2, top 3; sting 1, piece 3) a lens under the bar with what remains is an exception; without it, a blocker", () => {
    const low = (role: RoleId, gear: Gear, remaining?: string[]) =>
      lensesFor(role, gear).map((l, i) => (i === 0 ? { ...l, score: 6, verdict: "fix" as const, ...(remaining ? { remaining } : {}) } : l));
    const kept = low("ux", "page", ["the hero crop is still tight"]);
    expect(judgeLenses("ux", "page", kept, 2)).toEqual({ blockers: [], exceptions: [kept[0]] });
    expect(judgeLenses("ux", "page", kept, 1).blockers).toHaveLength(1);
    expect(judgeLenses("graphic", "top", low("graphic", "top", ["x"]), 2).blockers).toHaveLength(1);
    expect(judgeLenses("graphic", "top", low("graphic", "top", ["x"]), 3).exceptions).toHaveLength(1);
    expect(judgeLenses("ux", "section", low("ux", "section", ["x"]), 1).exceptions).toHaveLength(1);
    expect(judgeLenses("motion", "sting", low("motion", "sting", ["x"]), 1).exceptions).toHaveLength(1);
    expect(judgeLenses("motion", "piece", low("motion", "piece", ["x"]), 2).blockers).toHaveLength(1);
    expect(judgeLenses("ux", "page", low("ux", "page"), 2).blockers.map((b) => `${b.what}: ${b.call}`)).toEqual([
      "lens message scored 6 with verdict fix at the round budget (2 of 2): fix it, or list what remains in its `remaining` to report it as an exception",
    ]);
  });
});

describe("the brief complete for its gear (§3.6 step 1)", () => {
  it("a complete ux page brief has no gap", () => {
    expect(briefGaps(complete())).toEqual([]);
  });

  it("each gap is a blocker with the figma_set_brief call that clears it", () => {
    const b = complete({ lines: { goal: "g", message: "m", success: ["1 tap"] }, direction0: undefined, directions: undefined, chosen: undefined, styleframes: [], system: undefined, details: { platform: "web" } });
    expect(briefGaps(b).map((g) => `${g.what}: ${g.call}`)).toEqual([
      'the brief is missing audience, proof, constraints, givens, tone, format: the page gear needs them: figma_set_brief { briefId: "12:40", audience, proof, constraints, givens, tone, format }',
      'the brief\'s details are missing viewport, task, screens: figma_set_brief { briefId: "12:40", details: { viewport, task, screens } }',
      'the brief records no directions: the page gear needs Direction 0 and two or more: figma_set_brief { briefId: "12:40", direction0, directions, chosen }',
      'the brief records no styleframes: the page gear needs one or more: figma_set_brief { briefId: "12:40", styleframes }',
      'the brief records no system: the page gear writes it as numbers: figma_set_brief { briefId: "12:40", system: { bodySize, ratio, spacingBase, palette } }',
    ]);
  });

  it("top needs three styleframes; one direction short says so; a chosen direction alone", () => {
    expect(briefGaps(complete({ gear: "top" })).map((g) => g.what)).toEqual(["the brief records 1 styleframe: the top gear needs three or more"]);
    expect(briefGaps(complete({ directions: [{ name: "A", idea: "a" }] })).map((g) => g.what)).toEqual(["the brief records 1 direction: the page gear needs Direction 0 and two or more"]);
    expect(briefGaps(complete({ chosen: undefined })).map((g) => g.call)).toEqual(['figma_set_brief { briefId: "12:40", chosen }']);
    expect(briefGaps(complete({ system: { bodySize: 16, sizes: [16, 20, 25] } })).map((g) => g.what)).toEqual(["the brief's system is missing spacingBase, palette"]);
  });

  it("per role: brand records its palette; illustration its grid, no styleframes; design-system, board and a section nothing later", () => {
    const base = { lines: complete().lines, direction0: "d", directions: complete().directions, chosen: "Timetable" };
    expect(briefGaps(brief({ id: "1:1", role: "brand", gear: "top", ...base, styleframes: ["1", "2", "3"], details: { name: "Co-op", positioning: "p", attributes: ["a", "b", "c"], markType: "wordmark", applications: [{ name: "favicon", sizePx: 16 }] } })).map((g) => g.call)).toEqual([
      'figma_set_brief { briefId: "1:1", system: { palette } }',
    ]);
    expect(briefGaps(brief({ id: "1:1", role: "illustration", gear: "page", ...base, details: { set: ["bike"], sizes: [24], style: "line" } })).map((g) => g.what)).toEqual([
      "the brief's details are missing grid",
    ]);
    expect(briefGaps(brief({ id: "1:1", role: "design-system", gear: "top", details: { scope: "both" } }))).toEqual([]);
    expect(briefGaps(brief({ id: "1:1", role: "board", gear: "page", details: { purpose: "p", participants: "8", activity: "a", outcome: "o" } }))).toEqual([]);
    expect(briefGaps(brief({ id: "1:1", role: "ux", gear: "section", details: { platform: "web", viewport: ["390x844"], task: "t" } }))).toEqual([]);
    // A graphic print brief needs its bleed; a motion piece the design lines, no directions (its plan is on the frame).
    expect(briefGaps(brief({ id: "1:1", role: "graphic", gear: "section", details: { medium: "print", viewing: "v" } })).map((g) => g.what)).toEqual(["the brief's details are missing bleedMm"]);
    expect(briefGaps(brief({ id: "1:1", role: "motion", gear: "piece", lines: complete().lines, details: { placement: "IG", durationS: 6, fps: 30 } }))).toEqual([]);
    expect(ROLES.motion.later).toEqual([]);
  });
});

describe("S2: the plugin's findings as blockers", () => {
  it("an error or warning per line, the unanswered infos together", () => {
    const blockers = issueBlockers(
      [{ kind: "target_size", severity: "warning", nodeId: "12:400", name: "Book", detail: "is 36 × 36 pt, under iOS's 44 × 44 pt default" }],
      [{ kind: "near_size", nodeId: "12:410" }, { kind: "tangent", nodeId: "12:411" }, { kind: "unbalanced_space", nodeId: "12:300" }],
      ["craft"],
    );
    expect(blockers.map((b) => `${b.what}: ${b.call}`)).toEqual([
      'figma_check_layout found a warning: target_size on "Book" (12:400): is 36 × 36 pt, under iOS\'s 44 × 44 pt default: fix it with a targeted edit, then figma_sign_off again',
      "3 craft infos are unanswered (near_size 12:410, tangent 12:411, unbalanced_space 12:300): fix them, or pass answers: [{ kind, nodeId, reason }]",
    ]);
  });
});

// ── through an MCP client ───────────────────────────────────────────────────

describe("figma_sign_off: the server's checks, then the plugin's", () => {
  let world: RoleWorld;
  let s: Served;
  beforeEach(async () => {
    world = new RoleWorld();
    world.names.set("20:1", "Styleframe");
    world.briefs.set("12:40", complete());
    world.prints.set("12:345", "1c9e77d0");
    s = await serve("strict", world);
  });
  afterEach(async () => s.close());

  it("a pass: everything forwarded, the record's fingerprint, the report; the brief leaves force", async () => {
    await s.call("figma_get_brief", { briefId: "12:40" });
    expect(s.roles.inForce("Co-op (figma)")?.briefId).toBe("12:40");
    world.sent = [];
    const lenses = lensesFor("ux", "page");
    const r = await s.call("figma_sign_off", { lenses, rounds: 1, placeholders: ["none"], idempotencyKey: "sign-1" });
    expect(r.isError).toBeFalsy();
    // The brief in force, read; its styleframes resolved; then one write.
    expect(world.ops()).toEqual(["get_brief", "get_nodes_info", "sign_off"]);
    expect(world.sent[2]!.params).toEqual({
      briefId: "12:40",
      nodeIds: ["12:345"],
      audits: ["craft", "a11y", "states", "copy", "tells", "system"],
      tokensWhenSystem: true,
      answerKinds: ["craft", "tells"],
      answers: [],
      // Each lens says who scored it; left out, the builder ("self").
      lenses: lenses.map((l) => ({ ...l, reviewer: "self" })),
      rounds: 1,
      exceptions: [],
      placeholders: ["none"],
      serverBlockers: [],
      build: { server: VERSION, skills: SKILLS_VERSION },
    });
    const d = s.data(r);
    expect(d).toMatchObject({
      ok: true,
      briefId: "12:40",
      signedAt: "2026-10-16T10:00:00.000Z",
      briefStatus: "signed",
      blockers: [],
      exceptions: [],
      unanswered: [],
      fingerprints: { "12:345": "1c9e77d0" },
      indexOn: "root",
      report: {
        assumptions: ["prices are placeholders"],
        briefAsBuilt: { role: "ux", gear: "page", title: "Bench booking page", message: "You fix your own bike here, with a mechanic beside you." },
        direction: { direction0: "a lifestyle photo", chosen: "Timetable" },
        scores: { rounds: 1, budget: 2 },
        kept: [],
        placeholders: ["none"],
        where: { deliverables: ["12:345"], brief: "12:40" },
      },
    });
    expect(s.roles.inForce("Co-op (figma)")).toBeUndefined();
    expect(s.roles.briefs()).toMatchObject([{ briefId: "12:40", status: "signed", signedAt: "2026-10-16T10:00:00.000Z" }]);
    // New work waits for a brief again.
    expect((await s.call("figma_create_frame", {})).structuredContent).toMatchObject({ code: "PROCESS_REQUIRED" });
    // And a final export of the signed node now runs.
    expect((await s.call("figma_export_node", { nodeId: "12:345", final: true })).isError).toBeFalsy();
  });

  it("blockers: the brief's gaps and the lenses are recorded with the attempt and make ok false; the brief stays in force", async () => {
    world.briefs.set("12:40", complete({ directions: undefined, direction0: undefined, chosen: undefined }));
    const lenses = lensesFor("ux", "page").map((l) => (l.lens === "usability" ? { ...l, score: 7, verdict: "fix" as const } : l));
    const r = await s.call("figma_sign_off", { nodeId: "12:345", lenses, rounds: 1 });
    expect(r.isError).toBeFalsy();
    const sent = world.sent.find((x) => x.op === "sign_off")!.params;
    expect(sent.serverBlockers).toEqual([
      'the brief records no directions: the page gear needs Direction 0 and two or more: figma_set_brief { briefId: "12:40", direction0, directions, chosen }',
      "lens usability scored 7 with verdict fix in round 1 of 2: run round 2, or at the budget list what remains",
    ]);
    const d = s.data(r);
    expect(d.ok).toBe(false);
    expect(d.signedAt).toBeUndefined();
    expect(d.blockers).toEqual([
      { what: "the brief records no directions: the page gear needs Direction 0 and two or more", call: 'figma_set_brief { briefId: "12:40", direction0, directions, chosen }' },
      { what: "lens usability scored 7 with verdict fix in round 1 of 2", call: "run round 2, or at the budget list what remains" },
    ]);
    // The brief was found by its deliverable, and is now held for the fixes.
    expect(s.roles.inForce("Co-op (figma)")?.briefId).toBe("12:40");
  });

  it("a deliverable of another brief is signed against its own brief, not the brief in force; work no brief covers falls back to the one in force", async () => {
    // The live case of 2026-10-20: a motion brief in force while the UX screen 12:345 is signed off.
    world.briefs.set("30:1", brief({ id: "30:1", role: "motion", gear: "piece", title: "Ferry sting", details: { placement: "story", durationS: 6, fps: 30 } }));
    await s.call("figma_get_brief", { briefId: "30:1" });
    expect(s.roles.inForce("Co-op (figma)")?.briefId).toBe("30:1");
    world.sent = [];
    const r = await s.call("figma_sign_off", { nodeId: "12:345", lenses: lensesFor("ux", "page"), rounds: 1, placeholders: ["none"] });
    expect(s.data(r)).toMatchObject({ ok: true, briefId: "12:40" });
    // The node's brief, read once; no read of the brief in force.
    expect(world.ops()).toEqual(["get_brief", "get_nodes_info", "sign_off"]);
    expect(world.sent[0]!.params).toEqual({ nodeId: "12:345" });
    expect(world.sent[2]!.params).toMatchObject({ briefId: "12:40", nodeIds: ["12:345"] });
    // The motion brief is still the one in force.
    expect(s.roles.inForce("Co-op (figma)")?.briefId).toBe("30:1");
    // A node no brief covers: the brief in force, read after the node's lookup found none.
    world.sent = [];
    const loose = await s.call("figma_sign_off", { nodeId: "77:1", lenses: lensesFor("motion", "piece"), rounds: 1 });
    expect(s.data(loose).briefId).toBe("30:1");
    expect(world.sent.filter((x) => x.op === "get_brief").map((x) => x.params)).toEqual([{ nodeId: "77:1" }, { briefId: "30:1" }]);
  });

  it("a brief found only on the node's page does not outrank the brief in force; with none in force it is the one", async () => {
    // A section brief stored on the page covers 77:1 by where it sits, not as its work.
    world.briefs.set("0:1", brief({ id: "0:1", gear: "section", title: "Timetable page" }));
    world.pageBriefs.add("0:1");
    world.covers.set("77:1", "0:1");
    world.briefs.set("30:1", brief({ id: "30:1", role: "motion", gear: "piece", title: "Ferry sting", details: { placement: "story", durationS: 6, fps: 30 } }));
    await s.call("figma_get_brief", { briefId: "30:1" });
    world.sent = [];
    const r = await s.call("figma_sign_off", { nodeId: "77:1", lenses: lensesFor("motion", "piece"), rounds: 1 });
    expect(s.data(r).briefId).toBe("30:1");
    expect(world.sent.filter((x) => x.op === "get_brief").map((x) => x.params)).toEqual([{ nodeId: "77:1" }, { briefId: "30:1" }]);
    // A fresh process holds no brief: the page's is the one, from the one read.
    const fresh = await serve("strict", world);
    try {
      world.sent = [];
      const d = fresh.data(await fresh.call("figma_sign_off", { nodeId: "77:1", lenses: lensesFor("ux", "section"), rounds: 1 }));
      expect(d.briefId).toBe("0:1");
      expect(world.ops().filter((op) => op === "get_brief")).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  });

  it("an exception at the budget passes, and is recorded as one", async () => {
    const lenses = lensesFor("ux", "page").map((l) => (l.lens === "originality" ? { ...l, score: 7, verdict: "fix" as const, remaining: ["the hero is close to the category default"] } : l));
    const r = await s.call("figma_sign_off", { nodeId: "12:345", lenses, rounds: 2 });
    expect(s.data(r)).toMatchObject({ ok: true, exceptions: [lenses.find((l) => l.lens === "originality")] });
    expect(world.sent.find((x) => x.op === "sign_off")!.params.exceptions).toEqual([{ ...lenses.find((l) => l.lens === "originality"), reviewer: "self" }]);
  });

  it("the plugin's findings become blockers; audits it does not run yet are listed, never blockers", async () => {
    world.signOffAnswer = () => ({
      ok: false,
      checks: [{ name: "a11y", ok: false, errors: 0, warnings: 1, infos: 0, unanswered: 0 }],
      issues: [{ kind: "target_size", severity: "warning", nodeId: "12:400", name: "Book", detail: "is 36 × 36 pt" }],
      moreIssues: 4,
      unanswered: [{ kind: "near_size", severity: "info", nodeId: "12:410", name: "Price", detail: "close sizes" }],
      fingerprints: { "12:345": "1c9e77d0" },
      signedAt: "2026-10-16T10:00:00.000Z",
      briefStatus: "open",
      notRun: ["deck"],
    });
    const d = s.data(await s.call("figma_sign_off", { nodeId: "12:345", lenses: lensesFor("ux", "page"), rounds: 1 }));
    expect(d.ok).toBe(false);
    expect(d.notRun).toEqual(["deck"]);
    expect(d.blockers).toEqual([
      { what: 'figma_check_layout found a warning: target_size on "Book" (12:400): is 36 × 36 pt', call: "fix it with a targeted edit, then figma_sign_off again" },
      { what: "1 craft and tells info is unanswered (near_size 12:410)", call: "fix them, or pass answers: [{ kind, nodeId, reason }]" },
      { what: "and 4 more errors and warnings past the 1 listed", call: "figma_check_layout on each deliverable lists them all" },
    ]);
    expect(d.unanswered).toEqual([{ kind: "near_size", nodeId: "12:410", name: "Price", detail: "close sizes" }]);
  });

  it("styleframes that no longer resolve are a blocker", async () => {
    world.names.delete("20:1");
    const d = s.data(await s.call("figma_sign_off", { nodeId: "12:345", lenses: lensesFor("ux", "page"), rounds: 1 }));
    expect(d.blockers).toEqual([{ what: "the brief's styleframes 20:1 no longer resolve", call: 'figma_set_brief { briefId: "12:40", styleframes }' }]);
  });

  it("S1: no brief covers the node — strict refuses before any write; guided says the same as INVALID_PARAM", async () => {
    const r = await s.call("figma_sign_off", { nodeId: "77:1", lenses: lensesFor("ux", "page"), rounds: 1 });
    expect(r.structuredContent).toEqual({
      code: "PROCESS_REQUIRED",
      message: "figma_sign_off was refused before any change: a sign-off checks work against its brief, and none covers 77:1. Missing: a brief for 77:1.",
      hint: "If this is new work, figma_set_brief { role, gear, … } then figma_set_brief { briefId, styleframes, … } as the work goes; if it is an edit of existing work, it needs no sign-off.",
      partial: { created: [], missing: ["a brief for 77:1"] },
      safeToRetry: true,
    });
    expect(world.ops()).toEqual(["get_brief"]);
    const g = await serve("guided", world);
    try {
      expect((await g.call("figma_sign_off", { nodeId: "77:1", lenses: lensesFor("ux", "page"), rounds: 1 })).structuredContent).toMatchObject({ code: "INVALID_PARAM", message: expect.stringMatching(/none covers 77:1/) });
    } finally {
      await g.close();
    }
  });

  it("deliverables: one of nodeId, nodeIds and deck; a brief with none and no node named is refused", async () => {
    expect((await s.call("figma_sign_off", { nodeId: "1:1", nodeIds: ["1:2"], lenses: lensesFor("ux", "page"), rounds: 1 })).structuredContent).toMatchObject({
      code: "INVALID_PARAM",
      message: "Pass one of `nodeId`, `nodeIds` and `deck`.",
    });
    world.briefs.set("12:40", complete({ deliverables: [] }));
    const r = await s.call("figma_sign_off", { briefId: "12:40", lenses: lensesFor("ux", "page"), rounds: 1 });
    expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM", message: "Name the deliverables: `nodeId`, `nodeIds` or `deck: true`. The brief lists none yet." });
    expect(world.ops()).not.toContain("sign_off");
  });

  it("a deck signs off its page", async () => {
    world.sessions[0]!.editorType = "slides";
    world.briefs.set("12:40", brief({ id: "12:40", role: "presentation", gear: "section", details: { room: "projected", arc: ["why", "how"] } }));
    s.roles.allowUnverified = true;
    await s.call("figma_get_brief", { briefId: "12:40" });
    const r = await s.call("figma_sign_off", { deck: true, lenses: lensesFor("presentation", "section"), rounds: 1 });
    expect(s.data(r).ok).toBe(true);
    expect(world.sent.find((x) => x.op === "sign_off")!.params).toMatchObject({ nodeIds: ["0:1"], audits: ["craft", "tells", "deck", "copy", "system"], answerKinds: ["craft", "tells"] });
  });
});

describe("figma_sign_off for motion runs the motion audit and clears the final render (§3.10)", () => {
  const snapshot = { root: { id: "1:1", name: "Hero", width: 1080, height: 1920, durationS: 6 }, nodes: [{ id: "1:1", name: "Hero", type: "FRAME", parentId: null, width: 1080, height: 1920 }], truncated: false, maxNodes: 2000 };
  const motionBrief = () => brief({ id: "40:1", role: "motion", gear: "sting", title: "End card", details: { placement: "IG Reels", durationS: 6, fps: 30 }, deliverables: ["1:1"] });

  it("a plan and a passing audit at the brief's fps: the check is recorded, and the delivery render may run", async () => {
    const world = new RoleWorld();
    world.snapshot = snapshot as never;
    world.plans.set("1:1", { v: 1, brief: { audience: "a", message: "m", format: "f", durationS: 6, fps: 30 }, beats: [] });
    world.briefs.set("40:1", motionBrief());
    const s = await serve("strict", world);
    try {
      const r = await s.call("figma_sign_off", { briefId: "40:1", lenses: lensesFor("motion", "sting"), rounds: 1 });
      const d = s.data(r);
      expect(d.ok).toBe(true);
      expect(d.checks).toContainEqual({ name: "motion", ok: true, errors: 0, warnings: 0, infos: 0, unanswered: 0 });
      expect(world.sent.find((x) => x.op === "check_motion")!.params).toEqual({ nodeId: "1:1" });
      expect(world.sent.find((x) => x.op === "sign_off")!.params).toMatchObject({ audits: ["craft"], answerKinds: ["craft"], serverBlockers: [] });
      expect(s.motion.lastCheck("1:1", "s-1")).toMatchObject({ ok: true, fps: 30, full: true, gaps: [] });
      const now = { epoch: writeEpoch(), changedAt: Number.NEGATIVE_INFINITY, plan: planKey(world.plans.get("1:1") as never) };
      expect(s.motion.finalBlockers("1:1", 30, "s-1", now)).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("a final render of a frame under a brief waits for its sign-off, even after a passing check (§3.7)", async () => {
    const world = new RoleWorld();
    world.snapshot = snapshot as never;
    world.plans.set("1:1", { v: 1, brief: { audience: "a", message: "m", format: "f", durationS: 6, fps: 30 }, beats: [] });
    world.briefs.set("40:1", motionBrief());
    world.names.set("1:1", "Hero");
    const s = await serve("strict", world);
    try {
      s.ledger.note("motion", "test");
      expect(s.data(await s.call("figma_check_motion", { nodeId: "1:1", fps: 30 })).ok).toBe(true);
      const refused = await s.call("figma_export_video", { nodeId: "1:1", fps: 30, final: true });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/PROCESS_REQUIRED/);
      expect(refused.content[0]!.text).toMatch(/waits for a passing sign-off/);
      expect(world.ops()).not.toContain("export_video");
      // Signed off, the same render is no longer held back by the role process.
      expect(s.data(await s.call("figma_sign_off", { briefId: "40:1", lenses: lensesFor("motion", "sting"), rounds: 1 })).ok).toBe(true);
      const again = await s.call("figma_export_video", { nodeId: "1:1", fps: 30, final: true });
      expect(again.content[0]!.text ?? "").not.toMatch(/PROCESS_REQUIRED/);
    } finally {
      await s.close();
    }
  });

  it("what the plugin left to the frames (restPose) reaches the result as it was measured", async () => {
    const world = new RoleWorld();
    world.snapshot = snapshot as never;
    world.plans.set("1:1", { v: 1, brief: { audience: "a", message: "m", format: "f", durationS: 6, fps: 30 }, beats: [] });
    world.briefs.set("40:1", motionBrief());
    const restPose = {
      deliverables: [{ nodeId: "1:1", name: "Hero", moved: 20, notJudged: { covered: 4, clipped: 2 } }],
      note: "Under a motion brief layout is judged where the viewer sees it: 20 layers here move with keys, and 6 findings … were not made.",
    };
    world.signOffAnswer = () => ({
      ok: true,
      checks: [{ name: "craft", ok: true, errors: 0, warnings: 0, infos: 0, unanswered: 0 }],
      issues: [],
      unanswered: [],
      fingerprints: { "1:1": "1c9e77d0" },
      signedAt: "2026-10-20T10:00:00.000Z",
      briefStatus: "signed",
      restPose,
    });
    const s = await serve("strict", world);
    try {
      const d = s.data(await s.call("figma_sign_off", { briefId: "40:1", lenses: lensesFor("motion", "sting"), rounds: 1 }));
      expect(d.ok).toBe(true);
      expect(d.restPose).toEqual(restPose);
    } finally {
      await s.close();
    }
  });

  it("no plan on the frame, or no delivery fps, is a blocker with its call", async () => {
    const world = new RoleWorld();
    world.snapshot = snapshot as never;
    world.briefs.set("40:1", motionBrief());
    const s = await serve("strict", world);
    try {
      const d = s.data(await s.call("figma_sign_off", { briefId: "40:1", lenses: lensesFor("motion", "sting"), rounds: 1 }));
      expect(d.ok).toBe(false);
      expect((d.blockers as Array<{ what: string; call: string }>)[0]).toEqual({
        what: '"Hero" (1:1) has no motion plan',
        call: 'figma_set_motion_plan { nodeId: "1:1", brief: { audience, message, format, durationS, fps }, beats: [{ name, from, to, onScreen, action, transition }] }',
      });
      world.briefs.set("40:1", { ...motionBrief(), details: { placement: "IG Reels", durationS: 6 } });
      const noFps = s.data(await s.call("figma_sign_off", { briefId: "40:1", lenses: lensesFor("motion", "sting"), rounds: 1 }));
      expect(noFps.blockers).toContainEqual({ what: "no delivery fps: the motion check runs at the rate the piece is delivered at", call: "figma_sign_off { …, fps }" });
    } finally {
      await s.close();
    }
  });

  it("a plan's brand layer listed under another id [C-199]: mapped, it is judged; not found, a blocker that says what clears it", async () => {
    const world = new RoleWorld();
    // The brand layer drifts across the piece, so the audit has a track of it to judge.
    const lockup = {
      id: "37:441",
      name: "Lockup",
      type: "FRAME",
      parentId: "1:1",
      x: 64,
      y: 34,
      width: 108,
      height: 52,
      tracks: [{ field: "TRANSLATION_X", keyframes: [{ t: 0, value: "0" }, { t: 6, value: "400" }] }],
    };
    const listed = { ...snapshot, nodes: [...snapshot.nodes, lockup] };
    world.plans.set("1:1", { v: 1, brief: { audience: "a", message: "m", format: "f", durationS: 6, fps: 30 }, beats: [], brandId: "14:4853" });
    world.briefs.set("40:1", motionBrief());
    const s = await serve("strict", world);
    const sign = async () => s.data(await s.call("figma_sign_off", { briefId: "40:1", lenses: lensesFor("motion", "sting"), rounds: 1 }));
    const brandBlockers = (d: Record<string, unknown>) => (d.blockers as Array<{ what: string; call: string }>).filter((b) => b.what.includes("14:4853"));
    const failed = { name: "motion", ok: false, errors: 1, warnings: 0, infos: 0, unanswered: 0 };
    const whole = 'figma_check_motion { nodeId: "1:1", fps: 30, maxNodes: 5000 }';
    try {
      world.snapshot = { ...listed, aliases: { "14:4853": "37:441" } } as never;
      const mapped = await sign();
      expect(mapped.checks).toContainEqual(expect.objectContaining({ name: "motion", ok: true }));
      expect(brandBlockers(mapped)).toEqual([]);
      // The plan's id resolves nowhere now: storing the plan again clears it.
      world.snapshot = { ...listed, aliases: {}, gone: ["14:4853"] } as never;
      const gone = await sign();
      expect(gone.checks).toContainEqual(failed);
      expect(brandBlockers(gone)).toEqual([
        { what: expect.stringMatching(/^the motion plan of "Hero" \(1:1\) names `brandId` 14:4853, which the check did not find: The id resolves to nothing/), call: expect.stringMatching(/^figma_set_motion_plan \{ nodeId: "1:1"/) },
      ]);
      // A plugin without the mapping: re-run it if figma_status asks, then check again.
      world.snapshot = listed as never;
      expect(brandBlockers(await sign())).toEqual([{ what: expect.stringMatching(/which the check did not find: If figma_status asks for a plugin re-run/), call: 'figma_check_motion { nodeId: "1:1", fps: 30 }' }]);
      // Part of the frame read: the whole read first, not a new plan — from a plugin without the mapping too.
      for (const extra of [{ aliases: {} }, {}]) {
        world.snapshot = { ...listed, ...extra, truncated: true } as never;
        const cut = await sign();
        expect(cut.checks).toContainEqual(failed);
        expect(brandBlockers(cut)).toEqual([{ what: expect.stringMatching(/which the check did not find: Raise `maxNodes`/), call: whole }]);
        expect((cut.blockers as Array<{ call: string }>).filter((b) => b.call === whole)).toHaveLength(1);
      }
      // A layer that is gone, in a cut read: a new plan, and the whole read too.
      world.snapshot = { ...listed, aliases: {}, gone: ["14:4853"], truncated: true } as never;
      const both = await sign();
      expect(brandBlockers(both)).toEqual([{ what: expect.stringMatching(/The id resolves to nothing/), call: expect.stringMatching(/^figma_set_motion_plan/) }]);
      expect(both.blockers).toContainEqual({ what: 'the motion check read only part of "Hero" (1:1) (maxNodes)', call: whole });
      // A frame the page lists twice: the check is recorded under both ids.
      world.snapshot = { ...listed, root: { ...listed.root, handles: ["1:1", "37:173"] }, aliases: { "14:4853": "37:441" } } as never;
      expect((await sign()).checks).toContainEqual(expect.objectContaining({ name: "motion", ok: true }));
      expect(s.motion.lastCheck("1:1", "s-1")).toMatchObject({ ok: true, full: true });
      expect(s.motion.lastCheck("37:173", "s-1")).toMatchObject({ ok: true, full: true });
    } finally {
      await s.close();
    }
  });
});

describe("figma_set_motion_plan takes the fields it leaves out from the motion brief (§3.10)", () => {
  const beats = [{ name: "hold", from: 0, to: 6, onScreen: "", action: "the end card settles", transition: "ends on the logo" }];
  const motionBrief = () =>
    brief({ id: "40:1", role: "motion", gear: "sting", title: "End card", lines: { goal: "g", message: "Run with us on Sunday.", success: ["s"], audience: "runners nearby", format: "1080x1920 px IG Reels" }, details: { placement: "IG Reels", durationS: 6, fps: 30 } });

  it("from the motion brief in force, or the one briefId names; what the call gives wins", async () => {
    const world = new RoleWorld();
    world.briefs.set("40:1", motionBrief());
    const s = await serve("strict", world);
    try {
      await s.call("figma_get_brief", { briefId: "40:1" });
      expect((await s.call("figma_set_motion_plan", { nodeId: "1:1", brief: {}, beats })).isError).toBeFalsy();
      const plan = world.sent.filter((x) => x.op === "set_motion_plan").at(-1)!.params.plan as { brief: Record<string, unknown> };
      expect(plan.brief).toMatchObject({ audience: "runners nearby", message: "Run with us on Sunday.", format: "1080x1920 px IG Reels", durationS: 6, fps: 30 });
      await s.call("figma_set_motion_plan", { nodeId: "1:1", briefId: "40:1", brief: { fps: 24, durationS: 6 }, beats });
      const again = world.sent.filter((x) => x.op === "set_motion_plan").at(-1)!.params.plan as { brief: Record<string, unknown> };
      expect(again.brief).toMatchObject({ fps: 24, message: "Run with us on Sunday." });
    } finally {
      await s.close();
    }
  });

  it("a brief of another role is refused by name; with no brief the plan names what is missing", async () => {
    const world = new RoleWorld();
    world.briefs.set("12:40", brief({ id: "12:40" }));
    const s = await serve("strict", world);
    try {
      const other = await s.call("figma_set_motion_plan", { nodeId: "1:1", briefId: "12:40", brief: {}, beats });
      expect(other.isError).toBe(true);
      expect(other.content[0]!.text).toMatch(/is a ux brief; a motion plan takes its fields from a motion brief/);
      const none = await s.call("figma_set_motion_plan", { nodeId: "1:1", brief: { fps: 30, durationS: 6 }, beats });
      expect(none.isError).toBe(true);
      expect(none.content[0]!.text).toMatch(/brief\.audience/);
      expect(world.ops()).not.toContain("set_motion_plan");
    } finally {
      await s.close();
    }
  });
});
