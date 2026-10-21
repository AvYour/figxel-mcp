// figma_set_brief and figma_get_brief on the server (spec §3.4, §3.5): the
// schema with each role's own `details` (an unknown key refused, never
// stripped), the structure every mode refuses, the gear's lines (B2) and the
// lint (B3) that strict refuses and guided returns, the size, what is
// forwarded to the plugin's set_brief on a new brief, an update and a reopen,
// `missingForSignOff` from the record the plugin returns, and adoption.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gearLinesAnswer, gearLinesMissing, lintBrief, missingForSignOff, sentencesIn } from "../src/server/tools/brief.js";
import { brief, RoleWorld, serve, UX_PAGE, type Served } from "./role-fakes.js";

/** A served strict process that has read every skill a brief can ask for. */
async function ready(mode: "strict" | "guided" | "off" = "strict", world = new RoleWorld()): Promise<Served & { world: RoleWorld }> {
  const s = await serve(mode, world);
  for (const skill of ["ux", "design", "graphic", "brand", "slides", "design-system", "figjam", "storyboard"]) s.ledger.note(skill, "test");
  return Object.assign(s, { world });
}

const without = (k: string) => Object.fromEntries(Object.entries(UX_PAGE).filter(([key]) => key !== k));

describe("the brief's checks, as functions", () => {
  it("counts sentences the way §3.4 says: an end mark followed by more text", () => {
    expect(sentencesIn("You fix your own bike here, with a mechanic beside you.")).toBe(1);
    expect(sentencesIn("Fast. Cheap!  Near?")).toBe(3);
    expect(sentencesIn("Open 9–5 (Sat.)")).toBe(1);
  });

  it("B2: a page lacks the design skill's six lines and the role's required details", () => {
    expect(gearLinesMissing("ux", "page", { goal: "g", message: "m", success: ["s"], audience: "a", tone: { words: ["a", "b", "c"] }, format: "390x844 px" }, { platform: "web", task: "t" })).toEqual([
      "proof", "constraints", "givens", "details.viewport", "details.screens",
    ]);
    // A section asks only the role's details; design-system and board take no design lines.
    expect(gearLinesMissing("ux", "section", {}, {})).toEqual(["details.platform", "details.viewport", "details.task"]);
    expect(gearLinesMissing("design-system", "top", {}, {})).toEqual(["details.scope"]);
    expect(gearLinesMissing("board", "page", {}, { purpose: "p", participants: "8", activity: "a", outcome: "o" })).toEqual([]);
    // Print needs its bleed (§2.4).
    expect(gearLinesMissing("graphic", "section", {}, { medium: "print", viewing: "v" })).toEqual(["details.bleedMm"]);
    expect(gearLinesMissing("motion", "micro", {}, { placement: "p", durationS: 1, fps: 30 })).toEqual([]);
    expect(gearLinesMissing("motion", "piece", {}, { placement: "p", durationS: 6, fps: 30 })).toEqual(["audience", "proof", "constraints", "givens", "tone", "format"]);
  });

  it("B2's message lists what is missing; for ux at a page its hint is a call that passes", () => {
    const a = gearLinesAnswer("ux", "page", ["audience", "tone", "format", "details.viewport", "details.screens"]);
    expect(a.message).toBe("The page gear's ux brief is missing: audience, tone, format, details.viewport, details.screens.");
    expect(a.hint).toMatch(/^Example: figma_set_brief \{ role: "ux", gear: "page", title: "Bench booking", goal: "members book a bench slot online"/);
    for (const k of ["audience:", "proof:", "constraints:", "givens:", "tone:", "format:", "viewport:", "screens:"]) expect(a.hint).toContain(k);
    expect(gearLinesAnswer("board", "page", ["details.purpose"]).hint).toBe(
      'Add them and send this call again: figma_set_brief { role: "board", gear: "page", title, goal, message, success, details.purpose }. A board brief\'s details: purpose, participants, activity, outcome, minutes.',
    );
  });

  it("B3: the lint, hard in strict, and the two warnings of every mode", () => {
    const { hard, soft } = lintBrief("ux", "page", { message: "Fix it here. With a mechanic.", tone: { words: ["clean", "plain", "warm"] }, format: "phone and desktop", success: ["visitors book"] }, { viewport: ["390x844", "phone"] });
    expect(hard).toEqual([
      "message has 2 sentences; a stranger takes away one. Keep the first and move the rest to proof.",
      'tone uses "clean", a word every default claims; take the three words from the subject and the audience (the design skill\'s brief section).',
      'format has no size with a unit (px, pt, dp, mm, in), so the format check cannot measure the frame. Example: "1080x1350 px Instagram feed".',
      'details.viewport "phone" is not a size: write it as width x height, e.g. "390x844".',
    ]);
    expect(soft).toEqual([
      'success has no line with a number or a tool name, so no check can confirm it; write one a tool or a render can confirm, e.g. "the Book button is visible without scrolling at 390 x 844".',
      "success has 1 line; at the page gear write two or more: what the viewer does or remembers, then the checks that follow from it.",
    ]);
    expect(lintBrief("ux", "page", { tone: { words: ["modern", "Premium"] } }, {}).hard).toEqual([
      "tone has 2 words; it takes three, and one it must not be (the design skill's brief section).",
      'tone uses "modern" and "premium", words every default claims; take the three words from the subject and the audience (the design skill\'s brief section).',
    ]);
    // A format at a section, or on a board, is not linted for its unit.
    expect(lintBrief("ux", "section", { format: "phone" }, {}).hard).toEqual([]);
    expect(lintBrief("board", "page", { format: "a wall" }, {}).hard).toEqual([]);
    expect(lintBrief("ux", "page", UX_PAGE as never, UX_PAGE.details)).toEqual({ hard: [], soft: [] });
  });

  it("missingForSignOff: what sign-off will ask for, from the record", () => {
    expect(missingForSignOff(brief({ id: "1:1", lines: { goal: "g", message: "m", success: ["s"] } }))).toEqual([
      "audience", "proof", "constraints", "givens", "tone", "format",
      "details.platform", "details.viewport", "details.task", "details.screens",
      "direction0", "directions (two or more)", "chosen", "styleframes (one or more)",
      "system.bodySize", "system.ratio", "system.spacingBase", "system.palette",
    ]);
    expect(missingForSignOff(brief({ id: "1:1", role: "ux", gear: "replica", lines: { goal: "", message: "", success: [] }, details: { source: "src/App.tsx" } }))).toEqual([]);
    expect(missingForSignOff(brief({ id: "1:1", role: "board", gear: "page", details: { purpose: "p", participants: "8", activity: "a", outcome: "o" } }))).toEqual([]);
  });
});

describe("figma_set_brief: the schema and the structure, in every mode", () => {
  let s: Served & { world: RoleWorld };
  beforeEach(async () => (s = await ready("guided")));
  afterEach(async () => s.close());

  it("an unknown key is refused by the schema, top level and in details; a key of another role by name", async () => {
    const top = await s.call("figma_set_brief", { ...UX_PAGE, colour: "green" });
    expect(top.isError).toBe(true);
    const nested = await s.call("figma_set_brief", { ...UX_PAGE, details: { ...UX_PAGE.details, platfrom: "web" } });
    expect(nested.isError).toBe(true);
    const foreign = await s.call("figma_set_brief", { ...UX_PAGE, details: { ...UX_PAGE.details, medium: "print", bleedMm: 3 } });
    expect(foreign.structuredContent).toMatchObject({
      code: "INVALID_PARAM",
      message: "details.medium, details.bleedMm are not a ux brief's: its details are platform, viewport, task, screens, a11y, controls, insets, source.",
      safeToRetry: true,
    });
    expect(s.world.ops()).toEqual([]);
    // A viewport is a list, one per target; one alone may come as a string, and travels as a list.
    expect((await s.call("figma_set_brief", { ...UX_PAGE, details: { ...UX_PAGE.details, viewport: "390x844" } })).isError).toBeFalsy();
    expect(s.world.sent.at(-1)!.params).toMatchObject({ brief: { details: { viewport: ["390x844"] } } });
    expect((await s.call("figma_set_brief", { ...UX_PAGE, details: { ...UX_PAGE.details, viewport: 390 } })).isError).toBe(true);
  });

  it("a new brief names its role, gear, title, goal, message and success; the gear fits the role", async () => {
    expect((await s.call("figma_set_brief", without("role"))).structuredContent).toMatchObject({ code: "INVALID_PARAM", message: "A new brief names its role and gear." });
    expect((await s.call("figma_set_brief", without("goal"))).structuredContent).toMatchObject({
      code: "INVALID_PARAM",
      message: "A new ux brief needs goal.",
      hint: 'figma_set_brief { role: "ux", gear: "page", title, goal, message, success }',
    });
    expect((await s.call("figma_set_brief", { ...UX_PAGE, gear: "piece" })).structuredContent).toMatchObject({
      message: 'The ux role takes the gears section, page, top, replica; "piece" is not one of them.',
    });
    expect(s.world.ops()).toEqual([]);
  });

  it("a replica's brief is its title and the code's path; its goal and message travel empty", async () => {
    expect((await s.call("figma_set_brief", { role: "ux", gear: "replica", title: "Checkout" })).structuredContent).toMatchObject({
      message: "A new ux brief needs details.source.",
    });
    const r = await s.call("figma_set_brief", { role: "ux", gear: "replica", title: "Checkout", details: { source: "src/Checkout.tsx" } });
    expect(r.isError).toBeFalsy();
    expect(s.world.sent.at(-1)).toMatchObject({ op: "set_brief", params: { brief: { role: "ux", gear: "replica", title: "Checkout", details: { source: "src/Checkout.tsx" }, lines: { goal: "", message: "" } } } });
    expect(s.data(r).missingForSignOff).toEqual([]);
  });

  it("a record over 90,000 bytes is refused before it is sent", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `${"x".repeat(590)} ${i}`);
    const big = {
      ...UX_PAGE,
      proof: long, constraints: long, assumptions: long, references: long, success: long.map((l) => `${l} 1`),
      defaultToAvoid: "y".repeat(600), direction0: "z".repeat(600), givens: "w".repeat(600),
    };
    const r = await s.call("figma_set_brief", big);
    expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM", message: expect.stringMatching(/^The brief would be \d+ bytes; a brief holds at most 90000/) });
  });
});

describe("figma_set_brief: the gear's lines and the lint", () => {
  it("strict refuses a page brief without its lines (B2) and with a lint failure (B3), sending nothing", async () => {
    const s = await ready("strict");
    try {
      const r = await s.call("figma_set_brief", { ...without("tone"), details: { platform: "web", task: "t" } });
      expect(r.structuredContent).toMatchObject({
        code: "INVALID_PARAM",
        message: "The page gear's ux brief is missing: tone, details.viewport, details.screens.",
        hint: expect.stringMatching(/^Example: figma_set_brief \{ role: "ux", gear: "page"/),
        safeToRetry: true,
      });
      const lint = await s.call("figma_set_brief", { ...UX_PAGE, message: "Fix it here. With a mechanic.", tone: { words: ["clean", "plain", "warm"] } });
      expect(lint.structuredContent).toMatchObject({
        code: "INVALID_PARAM",
        message:
          "message has 2 sentences; a stranger takes away one. Keep the first and move the rest to proof. tone uses \"clean\", a word every default claims; take the three words from the subject and the audience (the design skill's brief section).",
        hint: "Correct those lines and send this call again.",
      });
      expect(s.world.ops()).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("guided stores it and returns each under `lint`; the warnings come back in strict too", async () => {
    const g = await ready("guided");
    try {
      const r = await g.call("figma_set_brief", { ...without("tone"), message: "Fix it here. With a mechanic.", success: ["visitors book"] });
      expect(r.isError).toBeFalsy();
      expect(g.data(r).lint).toEqual([
        "The page gear's ux brief is missing: tone.",
        "message has 2 sentences; a stranger takes away one. Keep the first and move the rest to proof.",
        'success has no line with a number or a tool name, so no check can confirm it; write one a tool or a render can confirm, e.g. "the Book button is visible without scrolling at 390 x 844".',
        "success has 1 line; at the page gear write two or more: what the viewer does or remembers, then the checks that follow from it.",
      ]);
    } finally {
      await g.close();
    }
    const s = await ready("strict");
    try {
      const r = await s.call("figma_set_brief", { ...UX_PAGE, success: ["visitors book", "they come back"] });
      expect(r.isError).toBeFalsy();
      expect(s.data(r).lint).toEqual([expect.stringMatching(/^success has no line with a number or a tool name/)]);
    } finally {
      await s.close();
    }
  });
});

describe("figma_set_brief: what reaches the plugin, and what comes back", () => {
  let s: Served & { world: RoleWorld };
  beforeEach(async () => (s = await ready("strict")));
  afterEach(async () => s.close());

  it("a new brief: the record's fields, its lines together, the block options; the result adds missingForSignOff and lint", async () => {
    const r = await s.call("figma_set_brief", { ...UX_PAGE, pageId: "0-2", x: 100, y: -40, idempotencyKey: "brief-1" });
    expect(r.isError).toBeFalsy();
    const { lines, ...rest } = (s.world.sent[0]!.params.brief ?? {}) as Record<string, unknown>;
    expect(s.world.sent[0]!.op).toBe("set_brief");
    expect(s.world.sent[0]!.params).toMatchObject({ pageId: "0:2", x: 100, y: -40 });
    expect(rest).toEqual({ role: "ux", gear: "page", title: "Bench booking page", details: UX_PAGE.details });
    expect(lines).toEqual({
      goal: UX_PAGE.goal, message: UX_PAGE.message, success: UX_PAGE.success, audience: UX_PAGE.audience, proof: UX_PAGE.proof,
      constraints: UX_PAGE.constraints, givens: UX_PAGE.givens, tone: UX_PAGE.tone, format: UX_PAGE.format,
    });
    expect(s.data(r)).toMatchObject({
      briefId: "12:40",
      stored: "block",
      status: "open",
      missingForSignOff: ["direction0", "directions (two or more)", "chosen", "styleframes (one or more)", "system.bodySize", "system.ratio", "system.spacingBase", "system.palette"],
      lint: [],
    });
    expect(s.roles.inForce("Co-op (figma)")?.briefId).toBe("12:40");
  });

  it("an update reads the brief first, sends only what changes, and needs no lines again", async () => {
    await s.call("figma_set_brief", UX_PAGE);
    s.world.sent = [];
    const r = await s.call("figma_set_brief", {
      briefId: "12-40",
      direction0: "a lifestyle photo, a centred headline, three icon cards",
      directions: [{ name: "Timetable", idea: "the bench timetable as the page", total: 41 }, { name: "Workshop", idea: "the repair log", total: 37 }],
      chosen: "Timetable",
      styleframes: ["https://www.figma.com/design/abc/Co-op?node-id=20-1"],
      system: { bodySize: 16, ratio: 1.25, spacingBase: 8, palette: [{ hex: "#1F6F43", role: "action" }] },
    });
    expect(r.isError).toBeFalsy();
    expect(s.world.sent.map((x) => x.op)).toEqual(["get_brief", "set_brief"]);
    expect(s.world.sent[1]!.params).toEqual({
      brief: {
        direction0: "a lifestyle photo, a centred headline, three icon cards",
        directions: [{ name: "Timetable", idea: "the bench timetable as the page", total: 41 }, { name: "Workshop", idea: "the repair log", total: 37 }],
        chosen: "Timetable",
        styleframes: ["20:1"],
        system: { bodySize: 16, ratio: 1.25, spacingBase: 8, palette: [{ hex: "#1F6F43", role: "action" }] },
      },
      briefId: "12:40",
    });
    expect(s.data(r).missingForSignOff).toEqual([]);
  });

  it("an update of a node with no brief is refused, naming it", async () => {
    const r = await s.call("figma_set_brief", { briefId: "9:9", chosen: "A" });
    expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM", message: "No brief to update on 9:9.", hint: "figma_get_brief with no arguments lists the file's open briefs." });
  });

  it("reopen goes with briefId, asks for the skills again, and puts a signed brief back in force", async () => {
    expect((await s.call("figma_set_brief", { ...UX_PAGE, reopen: true })).structuredContent).toMatchObject({
      code: "INVALID_PARAM",
      message: "`reopen` goes with `briefId`: it opens that brief again.",
    });
    s.world.briefs.set("12:40", brief({ id: "12:40", status: "signed" }));
    const fresh = await serve("strict", s.world);
    try {
      const refused = await fresh.call("figma_set_brief", { briefId: "12:40", reopen: true });
      expect(refused.structuredContent).toMatchObject({ code: "PROCESS_REQUIRED", partial: { missing: ["the ux skill", "the design skill"] } });
      fresh.ledger.note("ux", "test");
      fresh.ledger.note("design", "test");
      const r = await fresh.call("figma_set_brief", { briefId: "12:40", reopen: true });
      expect(r.isError).toBeFalsy();
      expect(s.world.sent.at(-1)!.params).toEqual({ brief: {}, briefId: "12:40", reopen: true });
      expect(fresh.roles.inForce("Co-op (figma)")?.briefId).toBe("12:40");
    } finally {
      await fresh.close();
    }
  });
});

describe("figma_get_brief", () => {
  it("forwards what it is asked, adopts an open brief, and adds a motion brief's plan", async () => {
    const world = new RoleWorld();
    world.briefs.set("12:40", brief({ id: "12:40" }));
    world.briefs.set("50:1", brief({ id: "50:1", role: "motion", gear: "piece", title: "Reel", deliverables: ["50:2"] }));
    world.plans.set("50:2", { v: 1, brief: { fps: 30 } });
    const s = await serve("strict", world);
    try {
      const list = await s.call("figma_get_brief", {});
      expect(s.data(list).open).toHaveLength(2);
      expect(s.data(list).adopted).toBeUndefined();
      expect(s.roles.inForce("Co-op (figma)")).toBeUndefined();
      const read = await s.call("figma_get_brief", { nodeId: "50:2", fingerprint: true });
      expect(world.sent.at(-2)).toEqual({ op: "get_brief", params: { nodeId: "50:2", fingerprint: true } });
      expect(s.data(read)).toMatchObject({ brief: { id: "50:1" }, adopted: true, motionPlan: { v: 1, brief: { fps: 30 } } });
      expect(s.roles.inForce("Co-op (figma)")?.briefId).toBe("50:1");
      // A signed brief is read, never adopted.
      world.briefs.set("60:1", brief({ id: "60:1", status: "signed" }));
      expect(s.data(await s.call("figma_get_brief", { briefId: "60:1" })).adopted).toBeUndefined();
      expect((await s.call("figma_get_brief", { fingerprint: true })).structuredContent).toMatchObject({ code: "INVALID_PARAM" });
    } finally {
      await s.close();
    }
  });

  it("off reads, and holds nothing in force", async () => {
    const world = new RoleWorld();
    world.briefs.set("12:40", brief({ id: "12:40" }));
    const s = await serve("off", world);
    try {
      expect(s.data(await s.call("figma_get_brief", { briefId: "12:40" })).adopted).toBeUndefined();
      expect(s.roles.inForce("Co-op (figma)")).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});

describe("registration", () => {
  it("get_brief reads; set_brief and sign_off write, none destructive, each description within the cap and ending whole", async () => {
    const s = await ready("strict");
    try {
      const { tools } = await s.client.listTools();
      const by = new Map(tools.map((t) => [t.name, t]));
      expect(by.get("figma_get_brief")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      for (const name of ["figma_set_brief", "figma_sign_off"]) {
        expect(by.get(name)!.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
        expect(by.get(name)!.description!.length, name).toBeLessThanOrEqual(1024);
        expect(by.get(name)!.description, name).toMatch(/Editors: Design; unverified: FigJam, Slides\.$/);
      }
      expect(by.get("figma_set_brief")!.description).toContain("and figma_sign_off ends it.");
      expect(by.get("figma_sign_off")!.description).toContain("Writes plugin data only.");
      expect(by.get("figma_get_brief")!.description).toMatch(/Reads only\.$/);
    } finally {
      await s.close();
    }
  });
});

describe("figma_check_layout measures against the brief in force", () => {
  it("sends the brief in force as briefInForce, which the checked work's own brief outranks in the plugin; a briefId the call gives goes as it is", async () => {
    const s = await ready("strict");
    try {
      const briefId = s.data(await s.call("figma_set_brief", UX_PAGE)).briefId as string;
      await s.call("figma_check_layout", { nodeId: "12:345" });
      await s.call("figma_check_layout", { nodeId: "12:345", briefId: "9:9" });
      const checks = s.world.sent.filter((x) => x.op === "check_layout").map((x) => [x.params.briefId, x.params.briefInForce]);
      expect(checks).toEqual([[undefined, briefId], ["9:9", undefined]]);
    } finally {
      await s.close();
    }
  });

  it("adds nothing with no brief in force, or with BRIDGE_PROCESS=off", async () => {
    for (const mode of ["strict", "off"] as const) {
      const s = await ready(mode);
      try {
        if (mode === "off") await s.call("figma_set_brief", UX_PAGE);
        await s.call("figma_check_layout", { nodeId: "12:345" });
        const sent = s.world.sent.find((x) => x.op === "check_layout")!.params;
        expect([sent.briefId, sent.briefInForce], mode).toEqual([undefined, undefined]);
      } finally {
        await s.close();
      }
    }
  });
});
