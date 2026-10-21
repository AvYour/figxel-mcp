// An independent reviewer in the sign-off (role quality plan W4; base
// workflow decisions §10.1, §10.2, §10.6): who scored each lens, the gate at
// the top gear (and motion's piece) that the builder's own scores of message
// and originality do not pass, the page gear's honest `selfReviewed`, the
// record's reviewers and `independent` flag, the critique_cold prompt a cold
// reviewer starts from, and figma_get_brief's `next` stage.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROMPTS, promptText } from "../src/server/prompts.js";
import { judgeReviewers, nextStep, reviewedLine, STAGES } from "../src/server/tools/brief.js";
import {
  coldLenses,
  GEARS,
  INDEPENDENT_GEARS,
  isReviewer,
  REVIEWER_FORM,
  reviewOf,
  ROLE_IDS,
  signOffSet,
  type BriefRecord,
  type Gear,
  type LensScore,
  type Reviewer,
  type RoleId,
} from "../src/shared/roles.js";
import { brief, RoleWorld, serve, signOffOf, type Served } from "./role-fakes.js";

/** Every lens of the role's sign-off at `gear`, at 9 with verdict pass; `by` names a reviewer per lens. */
const lensesFor = (role: RoleId, gear: Gear, by: Record<string, Reviewer> = {}): LensScore[] =>
  signOffSet(role, gear)!.lenses.map((lens) => ({ lens, score: 9, verdict: "pass" as const, ...(by[lens] ? { reviewer: by[lens] } : {}) }));

/** A ux brief complete for sign-off at `gear`: the lines, the details, the directions, the styleframes, the system. */
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
    },
    details: { platform: "web", viewport: ["390x844"], task: "book a slot", screens: [{ name: "Slots", states: ["empty"] }] },
    direction0: "a lifestyle photo",
    directions: [{ name: "Timetable", idea: "the timetable", total: 41 }, { name: "Log", idea: "the repair log", total: 37 }],
    chosen: "Timetable",
    styleframes: ["20:1", "20:2", "20:3"],
    system: { bodySize: 16, ratio: 1.25, spacingBase: 8, palette: [{ hex: "#1F6F43", role: "action" }] },
    deliverables: ["12:345"],
    ...over,
  });
}

const COLD = { message: "agent:critic-1", originality: "agent:critic-1" } as const;

// ── who scored a lens ───────────────────────────────────────────────────────

describe("a reviewer: self, owner or agent:<name>", () => {
  it("takes the three forms and refuses anything else", () => {
    for (const ok of ["self", "owner", "agent:critic-1", "agent:a", "agent:Art.Director_2", `agent:${"x".repeat(40)}`]) expect(isReviewer(ok), ok).toBe(true);
    for (const bad of ["", "Self", "OWNER", "builder", "agent", "agent:", "agent: critic", "agent:-critic", "agent:critic one", "Agent:critic", `agent:${"x".repeat(41)}`, "agent:critic\n"]) {
      expect(isReviewer(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(isReviewer(undefined)).toBe(false);
    expect(REVIEWER_FORM.source).toBe("^(self|owner|agent:[A-Za-z0-9][A-Za-z0-9._-]{0,39})$");
  });

  it("the cold lenses: message and originality, or the role's own lens for what the work says; none for a design system or a board", () => {
    expect(coldLenses("ux", "top")).toEqual(["message", "originality"]);
    expect(coldLenses("ux", "page")).toEqual(["message", "originality"]);
    expect(coldLenses("ux", "section")).toEqual(["message"]);
    expect(coldLenses("graphic", "top")).toEqual(["message", "originality"]);
    expect(coldLenses("illustration", "top")).toEqual(["recognition", "originality"]);
    expect(coldLenses("brand", "top")).toEqual(["positioning", "originality"]);
    expect(coldLenses("presentation", "top")).toEqual(["story", "originality"]);
    expect(coldLenses("motion", "piece")).toEqual(["the brief's own lens", "originality"]);
    expect(coldLenses("motion", "sting")).toEqual(["the brief's own lens"]);
    expect(coldLenses("design-system", "top")).toEqual([]);
    expect(coldLenses("board", "page")).toEqual([]);
    expect(INDEPENDENT_GEARS).toEqual(["top", "piece"]);
    // Every role that takes the top gear (or piece) and scores a lens for what the work says has two cold lenses there.
    for (const role of ROLE_IDS) {
      for (const gear of INDEPENDENT_GEARS) {
        if (!signOffSet(role, gear) || role === "design-system") continue;
        expect(coldLenses(role, gear), `${role} ${gear}`).toHaveLength(2);
      }
    }
  });
});

// ── the gate ────────────────────────────────────────────────────────────────

describe("the gate: at top and piece the cold lenses come from a reviewer other than the builder", () => {
  it("self-scored at top: one blocker naming the two lenses and the way out", () => {
    const { blockers, review } = judgeReviewers("ux", "top", lensesFor("ux", "top"));
    expect(review).toMatchObject({ cold: ["message", "originality"], notIndependent: ["message", "originality"], independent: false, required: true, selfReviewed: false });
    expect(blockers).toEqual([
      {
        what: 'at the top gear the lenses "message" and "originality" need a reviewer other than the builder, and both were scored by "self"',
        call:
          'run the critique_cold prompt in a fresh context (a subagent, or a new conversation) and pass its scores with reviewer: "agent:<name>", ' +
          'or have the owner score them and pass reviewer: "owner"',
      },
    ]);
  });

  it("names only what is not independent; a cold lens with no score is said so", () => {
    const half = judgeReviewers("ux", "top", lensesFor("ux", "top", { message: "owner" }));
    expect(half.blockers.map((b) => b.what)).toEqual(['at the top gear the lenses "message" and "originality" need a reviewer other than the builder, and "originality" was scored by "self"']);
    const missing = judgeReviewers("ux", "top", lensesFor("ux", "top").filter((l) => l.lens !== "originality"));
    expect(missing.blockers.map((b) => b.what)).toEqual([
      'at the top gear the lenses "message" and "originality" need a reviewer other than the builder, and "message" was scored by "self", "originality" has no score',
    ]);
    // The explicit "self" is the default's same answer.
    expect(judgeReviewers("ux", "top", lensesFor("ux", "top", { message: "self", originality: "self" })).blockers).toHaveLength(1);
  });

  it("an agent or the owner on both clears it; lens names match whatever their case", () => {
    expect(judgeReviewers("ux", "top", lensesFor("ux", "top", COLD))).toMatchObject({ blockers: [], review: { independent: true, notIndependent: [] } });
    expect(judgeReviewers("graphic", "top", lensesFor("graphic", "top", { message: "owner", originality: "agent:art-director" })).blockers).toEqual([]);
    const shouted = lensesFor("ux", "top", COLD).map((l) => ({ ...l, lens: l.lens.toUpperCase() }));
    expect(judgeReviewers("ux", "top", shouted).blockers).toEqual([]);
  });

  it("motion's piece and a brand's top name their own cold lenses", () => {
    expect(judgeReviewers("motion", "piece", lensesFor("motion", "piece")).blockers.map((b) => b.what)).toEqual([
      'at the piece gear the lenses "the brief\'s own lens" and "originality" need a reviewer other than the builder, and both were scored by "self"',
    ]);
    expect(judgeReviewers("brand", "top", lensesFor("brand", "top")).blockers.map((b) => b.what)).toEqual([
      'at the top gear the lenses "positioning" and "originality" need a reviewer other than the builder, and both were scored by "self"',
    ]);
    expect(judgeReviewers("motion", "piece", lensesFor("motion", "piece", { "the brief's own lens": "agent:critic", originality: "owner" })).blockers).toEqual([]);
  });

  it("below top nothing is asked: page passes and says selfReviewed; section, replica, micro and sting ask nothing; a design system never", () => {
    const page = judgeReviewers("ux", "page", lensesFor("ux", "page"));
    expect(page.blockers).toEqual([]);
    expect(page.review).toMatchObject({ required: false, independent: false, selfReviewed: true });
    expect(judgeReviewers("ux", "page", lensesFor("ux", "page", COLD)).review).toMatchObject({ independent: true, selfReviewed: false });
    for (const [role, gear] of [["ux", "section"], ["ux", "replica"], ["motion", "micro"], ["motion", "sting"], ["design-system", "top"], ["board", "page"]] as Array<[RoleId, Gear]>) {
      const r = judgeReviewers(role, gear, lensesFor(role, gear));
      expect(r.blockers, `${role} ${gear}`).toEqual([]);
      expect(r.review.selfReviewed, `${role} ${gear}`).toBe(false);
    }
    // Every role and gear: the gate asks something only at top and piece.
    for (const role of ROLE_IDS) {
      for (const gear of GEARS) {
        if (!signOffSet(role, gear)) continue;
        expect(reviewOf(role, gear, []).required, `${role} ${gear}`).toBe(INDEPENDENT_GEARS.includes(gear) && coldLenses(role, gear).length > 0);
      }
    }
  });
});

describe("the report's line: who reviewed, and \"Self-reviewed\" first when the cold lenses were the builder's", () => {
  it("every lens self-scored", () => {
    expect(reviewedLine("ux", "section", lensesFor("ux", "section"))).toBe("Self-reviewed: the builder scored every lens (message, accessibility, type and composition, finish QA).");
  });

  it("independent, with the other lenses self-reviewed", () => {
    expect(reviewedLine("ux", "top", lensesFor("ux", "top", { ...COLD, copy: "owner" }))).toBe(
      "Independent review: agent:critic-1 scored message, originality; the owner scored copy; self-reviewed: usability, accessibility, type and composition, colour and imagery, finish QA.",
    );
  });

  it("a cold lens left to the builder opens the line", () => {
    expect(reviewedLine("ux", "page", lensesFor("ux", "page", { originality: "agent:critic-1" }))).toBe(
      'Self-reviewed: "message" was not scored by a reviewer other than the builder. Reviewers: agent:critic-1 scored originality; ' +
        "self-reviewed: message, usability, accessibility, type and composition, colour and imagery, copy, finish QA.",
    );
  });

  it("a role with no cold lens names its reviewers", () => {
    const lenses = lensesFor("design-system", "page", { completeness: "owner" });
    expect(reviewedLine("design-system", "page", lenses)).toBe("Reviewers: the owner scored completeness; self-reviewed: naming, tokens, documentation, finish QA.");
  });
});

// ── through an MCP client ───────────────────────────────────────────────────

describe("figma_sign_off: the reviewer, the gate, the record and the report", () => {
  let world: RoleWorld;
  let s: Served;
  beforeEach(async () => {
    world = new RoleWorld();
    for (const id of ["20:1", "20:2", "20:3"]) world.names.set(id, "Styleframe");
    world.prints.set("12:345", "1c9e77d0");
    s = await serve("strict", world);
  });
  afterEach(async () => s.close());

  const signOffParams = () => world.sent.find((x) => x.op === "sign_off")!.params;

  it("top, self-scored: ok false with the blocker, recorded with the attempt; the result says not independent", async () => {
    world.briefs.set("12:40", complete({ gear: "top" }));
    const r = await s.call("figma_sign_off", { briefId: "12:40", lenses: lensesFor("ux", "top"), rounds: 1 });
    expect(r.isError).toBeFalsy();
    const d = s.data(r);
    expect(d.ok).toBe(false);
    expect(d.independent).toBe(false);
    expect(d.selfReviewed).toBeUndefined();
    expect(d.blockers).toEqual([
      {
        what: 'at the top gear the lenses "message" and "originality" need a reviewer other than the builder, and both were scored by "self"',
        call: 'run the critique_cold prompt in a fresh context (a subagent, or a new conversation) and pass its scores with reviewer: "agent:<name>", or have the owner score them and pass reviewer: "owner"',
      },
    ]);
    expect(signOffParams().serverBlockers).toEqual([`${(d.blockers as Array<{ what: string; call: string }>)[0]!.what}: ${(d.blockers as Array<{ what: string; call: string }>)[0]!.call}`]);
    expect((d.report as { reviewed: string }).reviewed).toMatch(/^Self-reviewed: the builder scored every lens/);
    // The report opens with who reviewed.
    expect(Object.keys(d.report as object)[0]).toBe("reviewed");
  });

  it("top, the cold lenses by another agent: it passes, independent, every forwarded lens with its reviewer", async () => {
    world.briefs.set("12:40", complete({ gear: "top" }));
    const lenses = lensesFor("ux", "top", COLD);
    const d = s.data(await s.call("figma_sign_off", { briefId: "12:40", lenses, rounds: 1 }));
    expect(d).toMatchObject({ ok: true, independent: true, blockers: [] });
    expect(d.selfReviewed).toBeUndefined();
    expect(signOffParams().lenses).toEqual(lenses.map((l) => ({ ...l, reviewer: l.reviewer ?? "self" })));
    expect((d.report as { reviewed: string; scores: { lenses: LensScore[] } }).reviewed).toMatch(/^Independent review: agent:critic-1 scored message, originality; self-reviewed: usability/);
    expect((d.report as { scores: { lenses: LensScore[] } }).scores.lenses.every((l) => l.reviewer !== undefined)).toBe(true);
  });

  it("page, self-scored: it passes, and the result and the report say self-reviewed", async () => {
    world.briefs.set("12:40", complete());
    const d = s.data(await s.call("figma_sign_off", { briefId: "12:40", lenses: lensesFor("ux", "page"), rounds: 1 }));
    expect(d).toMatchObject({ ok: true, independent: false, selfReviewed: true, blockers: [] });
    expect((d.report as { reviewed: string }).reviewed).toMatch(/^Self-reviewed: /);
  });

  it("section: nothing changes but the reviewer written out", async () => {
    world.briefs.set("12:40", brief({ id: "12:40", gear: "section", details: { platform: "web", viewport: ["390x844"], task: "t" }, deliverables: ["12:345"] }));
    const d = s.data(await s.call("figma_sign_off", { briefId: "12:40", lenses: lensesFor("ux", "section"), rounds: 1 }));
    expect(d).toMatchObject({ ok: true, independent: false, blockers: [] });
    expect(d.selfReviewed).toBeUndefined();
  });

  it("a reviewer outside the three forms is an input error, and nothing is sent", async () => {
    world.briefs.set("12:40", complete({ gear: "top" }));
    for (const reviewer of ["critic", "agent:", "agent: critic", "the owner"]) {
      const lenses = lensesFor("ux", "top", COLD).map((l) => (l.lens === "message" ? { ...l, reviewer } : l));
      const r = await s.call("figma_sign_off", { briefId: "12:40", lenses, rounds: 1 }).catch((e: unknown) => ({ isError: true, content: [{ type: "text", text: String(e) }] }));
      expect(r.isError, reviewer).toBe(true);
      expect(r.content[0]!.text, reviewer).toMatch(/Input validation error[\s\S]*reviewer is \\?"self\\?", \\?"owner\\?" or \\?"agent:<name>\\?"/);
    }
    expect(world.ops()).not.toContain("sign_off");
  });

  it("the schema says the forms", async () => {
    const { tools } = await s.client.listTools();
    type LensesSchema = { items: { properties: Record<string, { pattern?: string; description?: string }> } };
    const props = tools.find((t) => t.name === "figma_sign_off")!.inputSchema.properties as Record<string, LensesSchema>;
    const lens = props.lenses!.items.properties;
    expect(lens.reviewer!.pattern).toBe(REVIEWER_FORM.source);
    expect(lens.reviewer!.description).toMatch(/critique_cold/);
  });
});

// ── the critique_cold prompt ────────────────────────────────────────────────

describe("the critique_cold prompt", () => {
  const row = PROMPTS.find((p) => p.name === "critique_cold")!;

  it("is a row: the node or brief id and the lenses, both optional; the critique skill with its lenses section; no checkpoint", () => {
    expect(row).toBeDefined();
    expect(row.args.map((a) => `${a.name}${a.required ? "" : "?"}`)).toEqual(["nodeId?", "lenses?"]);
    expect(row.checkpoint).toBeFalsy();
    expect(row.skill).toBe("critique");
    expect(row.section).toBe("lenses");
  });

  it("sets up a cold reviewer: fresh context, brief, references and renders only, the verdict before the numbers, no writes, scores with an agent reviewer", () => {
    const text = promptText(row, { nodeId: "12:345" });
    const steps = [
      "Review the Figma node 12:345 cold, as a reviewer who did not build it",
      "Run in a fresh context: a subagent or a new conversation that saw nothing of the build.",
      'say so first and mark every score reviewer: "self"',
      'figma_get_brief { nodeId: "12:345" }',
      "the references it names",
      "figma_export_node { nodeId }",
      "Nothing from the build",
      "before any check: the cold read (the reading order, first to third, and the one-sentence takeaway)",
      'Only then figma_check_layout { nodeId, audit: ["craft", "tells"] }',
      "say what each missed",
      "Never write to the canvas",
      'reviewer: "agent:<your name>"',
    ];
    let at = -1;
    for (const step of steps) {
      const i = text.indexOf(step);
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
  });

  it("names the default cold lenses, or the ones asked for; with no node, the selection", () => {
    const plain = promptText(row, {});
    expect(plain).toMatch(/^Review the selected design cold/);
    expect(plain).toContain("message and originality, or the role's own lens for what the work says");
    expect(plain).toContain('figma_get_guide { topic: "critique", section: "motion-checks" }');
    expect(plain).toContain("figma_get_brief { nodeId: <the selection> }");
    expect(promptText(row, { lenses: "message, originality" })).toContain("with these lenses: message, originality.");
    expect(promptText(row, { lenses: "all" })).toContain("the lenses its gear gives a cold reviewer");
  });

  it("stays within the 16,000-byte prompt budget with its longest arguments", () => {
    const link = `https://www.figma.com/design/${"A".repeat(22)}/${"Long-file-name-".repeat(6)}?node-id=12345-67890&t=${"x".repeat(16)}`;
    for (const args of [{}, { nodeId: link }, { nodeId: link, lenses: "message, originality, type and composition, colour and imagery" }]) {
      expect(Buffer.byteLength(promptText(row, args), "utf8"), JSON.stringify(args)).toBeLessThanOrEqual(16_000);
    }
  });

  it("is listed by the server with its two arguments, and counts as reading the critique skill", async () => {
    const world = new RoleWorld();
    const s = await serve("strict", world);
    try {
      const { prompts } = await s.client.listPrompts();
      const listed = prompts.find((p) => p.name === "critique_cold");
      expect(listed?.arguments?.map((a) => [a.name, a.required ?? false])).toEqual([["nodeId", false], ["lenses", false]]);
      expect(s.ledger.has("critique")).toBe(false);
      await s.client.getPrompt({ name: "critique_cold", arguments: { nodeId: "12:345" } });
      expect(s.ledger.has("critique")).toBe(true);
    } finally {
      await s.close();
    }
  });
});

// ── the plugin's record ─────────────────────────────────────────────────────

// The plugin op's record is tested with the write fakes in brief-ops.test.ts; here the shared rule it uses.
describe("the record's flags come from the shared rule", () => {
  it("reviewOf: independent only when every cold lens has another reviewer; selfReviewed only at page", () => {
    expect(reviewOf("ux", "page", lensesFor("ux", "page"))).toMatchObject({ independent: false, selfReviewed: true });
    expect(reviewOf("ux", "page", lensesFor("ux", "page", COLD))).toMatchObject({ independent: true, selfReviewed: false });
    expect(reviewOf("ux", "top", lensesFor("ux", "top"))).toMatchObject({ independent: false, selfReviewed: false });
    expect(reviewOf("ux", "section", lensesFor("ux", "section", { message: "owner" }))).toMatchObject({ independent: true, required: false });
    // No cold lens: never independent, never self-reviewed.
    expect(reviewOf("design-system", "page", lensesFor("design-system", "page", { completeness: "owner" }))).toMatchObject({ cold: [], independent: false, selfReviewed: false });
  });
});

// ── figma_get_brief's next stage ────────────────────────────────────────────

describe("next: the stage an open brief's record shows, and what moves it on", () => {
  it("the stages, in the base workflow's order", () => {
    expect(STAGES).toEqual(["brief", "directions", "choice", "system", "build", "critique", "sign-off"]);
  });

  it("brief: the lines and details the gear still needs", () => {
    const b = complete({ lines: { goal: "g", message: "m", success: ["1 tap"] }, details: { platform: "web" }, direction0: undefined, directions: undefined, chosen: undefined, styleframes: [], system: undefined });
    const next = nextStep(b);
    expect(next.stage).toBe("brief");
    expect(next.missing).toEqual(["audience", "proof", "constraints", "givens", "tone", "format", "details.viewport", "details.task", "details.screens"]);
    expect(next.call).toBe('figma_set_brief { briefId: "12:40", audience, proof, constraints, givens, tone, format, details: { viewport, task, screens } }');
    // What sign-off asks for is the whole list, in figma_set_brief's words.
    expect(next.forSignOff).toEqual([
      "audience", "proof", "constraints", "givens", "tone", "format", "details.viewport", "details.task", "details.screens",
      "direction0", "directions (two or more)", "chosen", "styleframes (one or more)",
      "system.bodySize", "system.ratio", "system.spacingBase", "system.palette",
    ]);
  });

  it("directions, then the choice, then the system", () => {
    const directions = nextStep(complete({ direction0: undefined, directions: undefined, chosen: undefined, styleframes: [] }));
    expect(directions).toMatchObject({
      stage: "directions",
      missing: ["direction0", "directions (two or more)", "styleframes (one or more)"],
      call: 'figma_get_guide { topic: "design", section: "directions" }, then figma_set_brief { briefId: "12:40", direction0, directions, styleframes }',
    });
    // Recorded directions with their styleframes, no choice yet.
    expect(nextStep(complete({ chosen: undefined }))).toMatchObject({ stage: "choice", missing: ["chosen"], call: 'figma_get_guide { topic: "design", section: "directions" }, then figma_set_brief { briefId: "12:40", chosen }' });
    // A choice without enough styleframes goes back to them first.
    expect(nextStep(complete({ gear: "top", chosen: undefined, styleframes: ["20:1"] })).stage).toBe("directions");
    expect(nextStep(complete({ system: { bodySize: 16 } }))).toMatchObject({
      stage: "system",
      missing: ["system.ratio", "system.spacingBase", "system.palette"],
      call: 'figma_get_guide { topic: "design", section: "system" }, then figma_set_brief { briefId: "12:40", system: { ratio, spacingBase, palette } }',
    });
  });

  it("build: a complete brief with no deliverables recorded", () => {
    expect(nextStep(complete({ deliverables: [] }))).toEqual({
      stage: "build",
      missing: ["deliverables"],
      call: 'one section per call, each checked with figma_check_layout; then record the frames: figma_set_brief { briefId: "12:40", deliverables }, or name them at sign-off',
      forSignOff: [],
    });
    expect(nextStep(brief({ id: "40:1", role: "motion", gear: "sting", details: { placement: "IG", durationS: 6, fps: 30 } })).call).toMatch(/^figma_set_motion_plan on the piece's frame before its first keyframe/);
  });

  it("critique: the lens scores, and at top the independent review, with the prompt that gives it", () => {
    const page = nextStep(complete());
    expect(page.stage).toBe("critique");
    expect(page.missing).toEqual(["lens scores: message, usability, accessibility, type and composition, colour and imagery, copy, originality, finish QA"]);
    expect(page.call).toMatch(/"message" and "originality" from the critique_cold prompt in a fresh context when you can \(a self-review passes at this gear and is recorded as self-reviewed\)/);
    expect(page.forSignOff).toEqual([]);
    const top = nextStep(complete({ gear: "top" }));
    const independent = 'independent review: "message" and "originality" scored by a reviewer other than the builder (the critique_cold prompt in a fresh context, or the owner)';
    expect(top).toMatchObject({ stage: "critique", forSignOff: [independent] });
    expect(top.missing).toEqual([expect.stringMatching(/^lens scores: /), independent]);
    expect(top.call).toBe(
      'once every section is built and checked: "message" and "originality" from the critique_cold prompt in a fresh context, or from the owner; ' +
        'the other lenses with the critique skill (figma_get_guide { topic: "critique" }), up to 3 rounds; then figma_sign_off { briefId: "12:40", lenses, rounds }',
    );
    const section = nextStep(brief({ id: "1:1", gear: "section", details: { platform: "web", viewport: ["390x844"], task: "t" }, deliverables: ["1:2"] }));
    expect(section).toMatchObject({ stage: "critique", forSignOff: [] });
    expect(section.call).toMatch(/up to 1 round; then figma_sign_off/);
  });

  it("sign-off: the last attempt failed; the deliverable's record, when read, names what failed", () => {
    const failed = complete({ gear: "top", lastSignOff: { at: "2026-10-20T09:00:00.000Z", ok: false } });
    expect(nextStep(failed)).toMatchObject({
      stage: "sign-off",
      missing: ["a passing sign-off: the attempt at 2026-10-20T09:00:00.000Z did not pass", expect.stringMatching(/^independent review: /)],
    });
    const record = signOffOf("12:40", {
      ok: false, gear: "top", at: "2026-10-20T09:00:00.000Z", independent: true,
      checks: [{ name: "craft", ok: false, errors: 0, warnings: 2, infos: 0, unanswered: 0 }, { name: "a11y", ok: true, errors: 0, warnings: 0, infos: 0, unanswered: 0 }],
    });
    const read = nextStep(failed, record);
    expect(read.missing).toEqual(["a passing sign-off: the attempt at 2026-10-20T09:00:00.000Z did not pass (craft not ok)"]);
    expect(read.call).toBe('fix what that attempt listed, with "message" and "originality" from the critique_cold prompt in a fresh context or the owner, then figma_sign_off { briefId: "12:40", lenses, rounds }');
    // Another brief's record, or an older attempt, is not this one's.
    expect(nextStep(failed, { ...record, briefId: "9:9" }).missing[0]).toBe("a passing sign-off: the attempt at 2026-10-20T09:00:00.000Z did not pass");
    expect(nextStep(failed, { ...record, at: "2026-10-19T09:00:00.000Z" }).missing).toHaveLength(2);
    // A gap in the brief comes first, whatever the last attempt.
    expect(nextStep({ ...failed, chosen: undefined }).stage).toBe("choice");
  });

  it("figma_get_brief answers next for an open brief only, and changes nothing", async () => {
    const world = new RoleWorld();
    world.briefs.set("12:40", complete({ gear: "top", deliverables: [] }));
    world.briefs.set("60:1", complete({ id: "60:1", status: "signed" }));
    const s = await serve("strict", world);
    try {
      const open = s.data(await s.call("figma_get_brief", { briefId: "12:40" }));
      expect(open.next).toEqual(nextStep(world.briefs.get("12:40")!));
      expect(open.next).toMatchObject({ stage: "build", missing: ["deliverables"] });
      expect(s.data(await s.call("figma_get_brief", { briefId: "60:1" })).next).toBeUndefined();
      expect(s.data(await s.call("figma_get_brief", {})).next).toBeUndefined();
      expect(world.ops()).toEqual(["get_brief", "get_brief", "get_brief"]);
      // Read by a deliverable, the deliverable's failing record names what failed.
      world.briefs.set("12:40", complete({ gear: "top", lastSignOff: { at: "2026-10-20T09:00:00.000Z", ok: false } }));
      world.signOffs.set("12:345", signOffOf("12:40", { ok: false, at: "2026-10-20T09:00:00.000Z", checks: [{ name: "tells", ok: false, errors: 0, warnings: 1, infos: 0, unanswered: 0 }] }));
      const byNode = s.data(await s.call("figma_get_brief", { nodeId: "12:345" }));
      expect((byNode.next as { missing: string[] }).missing[0]).toBe("a passing sign-off: the attempt at 2026-10-20T09:00:00.000Z did not pass (tells not ok)");
    } finally {
      await s.close();
    }
  });
});
