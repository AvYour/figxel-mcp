// Options before the build, by default (C-422): a new brief at the page and
// top gears, and for a motion piece, records `checkpoint: "directions"`
// (BRIDGE_CHECKPOINT turns the default to "none" for an installation); the
// person's choice is recorded with figma_set_brief's `approvedBy` and holds
// for the direction it names; under BRIDGE_PROCESS=strict figma_sign_off and
// the clone of a styleframe into the build wait for it, guided warns, off
// checks nothing; figma_set_brief's `stop` and figma_get_brief's `next` say
// where the work waits; a plugin that predates checkpoints is asked to run
// again.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import { approvalHolds, awaitsChoice, checkpointOf, signOffSet, stopsByDefault, type BriefRecord, type Gear, type LensScore, type RoleId } from "../src/shared/roles.js";
import type { Bridge, BridgeStatus } from "../src/server/bridge.js";
import { ConfigError, loadConfig } from "../src/server/config.js";
import { checkpointWayOut } from "../src/server/role-process.js";
import { APPROVAL_FIELD, checkpointBlocker, missingForSignOff, nextStep, stopLine } from "../src/server/tools/brief.js";
import { buildStatus } from "../src/server/tools/meta.js";
import { brief, RoleWorld, serve, UX_PAGE, type Served } from "./role-fakes.js";

const AT = "2026-11-06T10:00:00.000Z";

/** Every lens the role's sign-off at `gear` asks for, at 9 with verdict pass. */
const lensesFor = (role: RoleId, gear: Gear): LensScore[] => signOffSet(role, gear)!.lenses.map((lens) => ({ lens, score: 9, verdict: "pass" as const }));

/** A ux page brief complete for sign-off; `over` adds the checkpoint and the approval. */
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
    styleframes: ["20:1"],
    system: { bodySize: 16, ratio: 1.25, spacingBase: 8, palette: [{ hex: "#1F6F43", role: "action" }] },
    deliverables: ["12:345"],
    ...over,
  });
}

/** A served process that has read every skill a brief can ask for. */
async function ready(mode: "strict" | "guided" | "off", world = new RoleWorld(), env: Record<string, string> = {}): Promise<Served & { world: RoleWorld }> {
  const s = await serve(mode, world, { env });
  for (const skill of ["ux", "design", "graphic", "brand", "slides", "design-system", "figjam", "storyboard"]) s.ledger.note(skill, "test");
  return Object.assign(s, { world });
}

/** What the last set_brief sent the plugin. */
const sentBrief = (world: RoleWorld) => (world.sent.filter((x) => x.op === "set_brief").at(-1)!.params.brief ?? {}) as Record<string, unknown>;

const WAY_OUT =
  'show the person the styleframes with the decision line (figma_select, figma_zoom_to), wait for their choice, then figma_set_brief { briefId: "12:40", chosen, approvedBy: "owner" }; ' +
  'only on their word to build without stopping, figma_set_brief { briefId: "12:40", checkpoint: "none" }';

// ── BRIDGE_CHECKPOINT ───────────────────────────────────────────────────────

describe("BRIDGE_CHECKPOINT", () => {
  const home = () => mkdtempSync(join(tmpdir(), "fmcp-checkpoint-"));

  it("is directions by default, takes none, and anything else stops the server", () => {
    expect(loadConfig({ BRIDGE_HOME: home() }).checkpoint).toBe("directions");
    expect(loadConfig({ BRIDGE_HOME: home(), BRIDGE_CHECKPOINT: " none " }).checkpoint).toBe("none");
    expect(loadConfig({ BRIDGE_HOME: home(), BRIDGE_CHECKPOINT: "directions" }).checkpoint).toBe("directions");
    expect(() => loadConfig({ BRIDGE_HOME: home(), BRIDGE_CHECKPOINT: "storyboard" })).toThrow(ConfigError);
    expect(() => loadConfig({ BRIDGE_HOME: home(), BRIDGE_CHECKPOINT: "nope" })).toThrow(/BRIDGE_CHECKPOINT="nope" must be one of directions, none/);
  });

  it("figma_status shows this process's setting beside BRIDGE_CONFLICTS", async () => {
    const st = { role: "hub", listening: true, reason: null, port: 0, host: "127.0.0.1", hubPid: 1, peers: 0, lastAuthFailureAt: null, serverBuild: "dev", allowUnverified: false, sessions: [] } as unknown as BridgeStatus;
    for (const value of ["directions", "none"]) {
      const config = loadConfig({ BRIDGE_HOME: home(), BRIDGE_PORT: "0", BRIDGE_CHECKPOINT: value });
      const out = (await buildStatus({ bridge: { statusAsync: async () => st } as unknown as Bridge, config, startedAt: Date.now(), selectedTools: [], registeredTools: [] })) as {
        bridge: Record<string, unknown>;
      };
      expect(out.bridge).toMatchObject({ conflicts: "refuse", checkpoint: value });
    }
  });
});

// ── the rules, as functions ─────────────────────────────────────────────────

describe("where the work stops, and when the person's choice holds", () => {
  it("stops by default at page and top for the roles with directions, and at motion's piece; nowhere else", () => {
    for (const role of ["ux", "graphic", "illustration", "brand", "presentation"] as const) {
      expect([stopsByDefault(role, "section"), stopsByDefault(role, "page"), stopsByDefault(role, "top")], role).toEqual([false, true, true]);
    }
    expect(stopsByDefault("ux", "replica")).toBe(false);
    expect([stopsByDefault("design-system", "page"), stopsByDefault("design-system", "top"), stopsByDefault("board", "page")]).toEqual([false, false, false]);
    expect([stopsByDefault("motion", "micro"), stopsByDefault("motion", "sting"), stopsByDefault("motion", "piece")]).toEqual([false, false, true]);
  });

  it("a record without a checkpoint runs to the end; an approval holds only for the direction it names", () => {
    expect(checkpointOf({})).toBe("none");
    expect(checkpointOf({ checkpoint: "directions" })).toBe("directions");
    expect(awaitsChoice({})).toBe(false);
    expect(awaitsChoice({ checkpoint: "none" })).toBe(false);
    expect(awaitsChoice({ checkpoint: "directions", chosen: "Timetable" })).toBe(true);
    // Matched as the person said it, case and spaces aside.
    expect(approvalHolds({ chosen: "Timetable", approval: { by: "owner", direction: " timetable ", at: AT } })).toBe(true);
    expect(awaitsChoice({ checkpoint: "directions", chosen: "Log", approval: { by: "owner", direction: "Timetable", at: AT } })).toBe(true);
  });

  it("missingForSignOff asks for the person's choice while the work waits, after the brief's own gaps", () => {
    expect(missingForSignOff(complete())).toEqual([]);
    expect(missingForSignOff(complete({ checkpoint: "directions" }))).toEqual([APPROVAL_FIELD]);
    expect(missingForSignOff(complete({ checkpoint: "directions", approval: { by: "owner", direction: "Timetable", at: AT } }))).toEqual([]);
    expect(missingForSignOff(complete({ checkpoint: "none" }))).toEqual([]);
    expect(missingForSignOff(complete({ checkpoint: "directions", system: undefined }))).toEqual([
      "system.bodySize", "system.ratio", "system.spacingBase", "system.palette", APPROVAL_FIELD,
    ]);
  });

  it("the blocker says what is missing and the call that clears it; an approval of another direction is named", () => {
    expect(checkpointBlocker(complete())).toBeNull();
    expect(checkpointBlocker(complete({ checkpoint: "directions" }))).toEqual({
      what: 'the brief stops after the directions for the person\'s choice (checkpoint "directions"), and their choice is not recorded',
      call: WAY_OUT,
    });
    expect(checkpointBlocker(complete({ checkpoint: "directions", chosen: "Log", approval: { by: "owner", direction: "Timetable", at: AT } }))!.what).toBe(
      'the brief stops after the directions for the person\'s choice (checkpoint "directions"), and the person chose "Timetable", and the brief now builds "Log"',
    );
    // Motion shows the board, the styleframes and the probe, once they exist.
    expect(checkpointWayOut("30:1", "motion")).toMatch(/^show the person the board, the styleframes and the probe's results once they exist \(figma_select, figma_zoom_to\)/);
  });

  it("stop: once the decision line names the chosen direction, until the person's choice is recorded", () => {
    expect(stopLine(complete({ checkpoint: "directions", chosen: undefined }))).toBeUndefined();
    expect(stopLine(complete({ checkpoint: "directions" }))).toBe(
      `The brief stops after the directions for the person's choice (checkpoint "directions"): ${WAY_OUT}. Until then, build nothing past what the person is shown.`,
    );
    expect(stopLine(complete({ checkpoint: "directions", approval: { by: "owner", direction: "Timetable", at: AT } }))).toBeUndefined();
    expect(stopLine(complete())).toBeUndefined();
  });
});

// ── figma_get_brief's next ──────────────────────────────────────────────────

describe("next: the choice is the person's at a checkpoint", () => {
  it("after the directions and styleframes, the stage is the choice, and the call is the stop", () => {
    const next = nextStep(complete({ checkpoint: "directions", system: undefined, deliverables: [] }));
    expect(next).toMatchObject({ stage: "choice", missing: [APPROVAL_FIELD], call: WAY_OUT });
    expect(next.forSignOff).toEqual(["system.bodySize", "system.ratio", "system.spacingBase", "system.palette", APPROVAL_FIELD]);
  });

  it("without a decision line, the decision line comes first; the directions before both", () => {
    expect(nextStep(complete({ checkpoint: "directions", chosen: undefined }))).toMatchObject({
      stage: "choice",
      missing: ["chosen", APPROVAL_FIELD],
      call: `figma_get_guide { topic: "design", section: "directions" }, then figma_set_brief { briefId: "12:40", chosen } with the decision line; then ${WAY_OUT}`,
    });
    expect(nextStep(complete({ checkpoint: "directions", directions: undefined, direction0: undefined, chosen: undefined })).stage).toBe("directions");
  });

  it("once the person chose, the work moves on; a motion piece waits for its plan to be chosen before the build", () => {
    expect(nextStep(complete({ checkpoint: "directions", approval: { by: "owner", direction: "Timetable", at: AT } })).stage).toBe("critique");
    const piece = nextStep(
      brief({
        id: "30:1", role: "motion", gear: "piece", checkpoint: "directions",
        lines: { goal: "g", message: "m", success: ["s"], audience: "a", proof: ["p"], constraints: ["c"], givens: "none", tone: { words: ["a", "b", "c"] }, format: "1080x1920 px" },
        details: { placement: "IG story", durationS: 6, fps: 30 },
      }),
    );
    expect(piece).toMatchObject({ stage: "choice", missing: [APPROVAL_FIELD] });
    expect(piece.call).toMatch(/^show the person the board, the styleframes and the probe's results once they exist/);
  });
});

// ── figma_set_brief ─────────────────────────────────────────────────────────

describe("figma_set_brief records the checkpoint and the person's choice", () => {
  let s: Served & { world: RoleWorld };
  beforeEach(async () => (s = await ready("guided")));
  afterEach(async () => s.close());

  const minimal = (role: string, gear: string, extra: Record<string, unknown> = {}) => ({ role, gear, title: `${role} ${gear}`, goal: "g", message: "One line.", success: ["1 tap"], ...extra });

  it("a new brief records the default at the stopping gears, and nothing below them", async () => {
    const cases: Array<[string, string, Record<string, unknown>, string | undefined]> = [
      ["ux", "page", {}, "directions"],
      ["ux", "top", {}, "directions"],
      ["graphic", "page", {}, "directions"],
      ["illustration", "top", {}, "directions"],
      ["brand", "page", {}, "directions"],
      ["presentation", "page", {}, "directions"],
      ["motion", "piece", {}, "directions"],
      ["ux", "section", {}, undefined],
      ["ux", "replica", { details: { source: "src/App.tsx" } }, undefined],
      ["design-system", "page", {}, undefined],
      ["board", "page", {}, undefined],
      ["motion", "sting", {}, undefined],
      ["motion", "micro", {}, undefined],
    ];
    for (const [role, gear, extra, want] of cases) {
      s.world.briefs.clear();
      const r = await s.call("figma_set_brief", minimal(role, gear, extra));
      expect(r.isError, `${role} ${gear}`).toBeFalsy();
      expect(sentBrief(s.world).checkpoint, `${role} ${gear}`).toBe(want);
    }
  });

  it("the call's own checkpoint wins; none sends no field; storyboard is stored as directions; a section can ask for the stop", async () => {
    // "none" is a record without a checkpoint, as before checkpoints: nothing new reaches the plugin.
    const none = await s.call("figma_set_brief", { ...UX_PAGE, checkpoint: "none" });
    expect(none.isError).toBeFalsy();
    expect(sentBrief(s.world)).not.toHaveProperty("checkpoint");
    expect(s.data(none).missingForSignOff).not.toContain(APPROVAL_FIELD);
    s.world.briefs.clear();
    await s.call("figma_set_brief", minimal("motion", "piece", { checkpoint: "storyboard" }));
    expect(sentBrief(s.world).checkpoint).toBe("directions");
    s.world.briefs.clear();
    await s.call("figma_set_brief", minimal("ux", "section", { checkpoint: "directions" }));
    expect(sentBrief(s.world).checkpoint).toBe("directions");
    expect((await s.call("figma_set_brief", { ...UX_PAGE, checkpoint: "later" })).isError).toBe(true);
  });

  it("an update sends no default; a stopping gear without a checkpoint keeps none, unless the brief moves there from a gear that does not stop", async () => {
    s.world.briefs.set("12:40", complete({ chosen: undefined }));
    await s.call("figma_set_brief", { briefId: "12:40", chosen: "Timetable" });
    expect(sentBrief(s.world)).toEqual({ chosen: "Timetable" });
    // From page to top: the brief was begun without a stop (before checkpoints, or on the person's word).
    await s.call("figma_set_brief", { briefId: "12:40", gear: "top" });
    expect(sentBrief(s.world)).toEqual({ gear: "top" });
    s.world.briefs.set("1:1", brief({ id: "1:1", gear: "section", details: { platform: "web", viewport: ["390x844"], task: "t" } }));
    await s.call("figma_set_brief", { briefId: "1:1", gear: "page" });
    expect(sentBrief(s.world)).toEqual({ gear: "page", checkpoint: "directions" });
  });

  it("a stored stop turned off on the person's word is removed (null), and the work no longer waits", async () => {
    s.world.briefs.set("12:40", complete({ checkpoint: "directions" }));
    const r = await s.call("figma_set_brief", { briefId: "12:40", checkpoint: "none" });
    expect(sentBrief(s.world)).toEqual({ checkpoint: null });
    expect(s.data(r).missingForSignOff).toEqual([]);
    expect(s.data(r).stop).toBeUndefined();
  });

  it("approvedBy records the person's choice with the direction it names: the one sent, else the one stored", async () => {
    s.world.briefs.set("12:40", complete({ checkpoint: "directions" }));
    const before = Date.now();
    const r = await s.call("figma_set_brief", { briefId: "12:40", chosen: "Log", approvedBy: "owner" });
    expect(r.isError).toBeFalsy();
    const sent = sentBrief(s.world);
    expect(sent).toMatchObject({ chosen: "Log", approval: { by: "owner", direction: "Log" } });
    expect(Date.parse((sent.approval as { at: string }).at)).toBeGreaterThanOrEqual(before - 1000);
    expect(s.data(r).missingForSignOff).toEqual([]);
    await s.call("figma_set_brief", { briefId: "12:40", approvedBy: "owner" });
    expect(sentBrief(s.world)).toMatchObject({ approval: { by: "owner", direction: "Log" } });
  });

  it("approvedBy with no direction to name is refused before anything is sent", async () => {
    s.world.briefs.set("12:40", complete({ checkpoint: "directions", chosen: undefined }));
    s.world.sent = [];
    const r = await s.call("figma_set_brief", { briefId: "12:40", approvedBy: "owner" });
    expect(r.structuredContent).toMatchObject({
      code: "INVALID_PARAM",
      message: "`approvedBy` records the person's choice of a direction, and the brief names none: pass `chosen`, the direction they chose, with it.",
      hint: 'figma_set_brief { briefId: "12:40", chosen: "<their direction>", approvedBy: "owner" }',
      safeToRetry: true,
    });
    expect(s.world.ops()).toEqual(["get_brief"]);
    expect((await s.call("figma_set_brief", { briefId: "12:40", approvedBy: "agent" })).isError).toBe(true);
  });

  it("BRIDGE_CHECKPOINT=none makes none the default for the installation, with no field sent; a call may still ask for the stop", async () => {
    const off = await ready("strict", new RoleWorld(), { BRIDGE_CHECKPOINT: "none" });
    try {
      await off.call("figma_set_brief", UX_PAGE);
      expect(sentBrief(off.world)).not.toHaveProperty("checkpoint");
      off.world.briefs.clear();
      await off.call("figma_set_brief", { ...UX_PAGE, checkpoint: "directions" });
      expect(sentBrief(off.world).checkpoint).toBe("directions");
    } finally {
      await off.close();
    }
  });

  it("a plugin that predates checkpoints still stores every brief that does not stop; one that stops asks for it to run again, nothing changed", async () => {
    // As the plugin before checkpoints answers: any key it does not take is refused by name.
    const world = s.world as unknown as { setBrief: (p: Record<string, unknown>) => unknown };
    const own = world.setBrief.bind(s.world);
    world.setBrief = (p) => {
      for (const k of ["checkpoint", "approval"]) {
        if (k in ((p.brief ?? {}) as object)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`brief.${k}\` is not a field a brief takes.`, { partial: { created: [] } });
      }
      return own(p);
    };
    for (const args of [minimal("ux", "section"), { ...UX_PAGE, checkpoint: "none" }, minimal("motion", "sting")]) {
      s.world.briefs.clear();
      expect((await s.call("figma_set_brief", args)).isError, JSON.stringify(args).slice(0, 40)).toBeFalsy();
    }
    s.world.briefs.clear();
    const r = await s.call("figma_set_brief", { ...UX_PAGE, idempotencyKey: "old-1" });
    expect(r.structuredContent).toMatchObject({
      code: "UNSUPPORTED",
      message: "The connected plugin predates checkpoints, so it cannot store this brief's checkpoint or the person's choice.",
      idempotencyKey: "old-1",
      safeToRetry: true,
    });
    expect((r.structuredContent as { hint: string }).hint).toMatch(/close the Figxel plugin window and run it again/);
  });
});

// ── figma_sign_off ──────────────────────────────────────────────────────────

describe("figma_sign_off waits for the person's choice at a checkpoint", () => {
  const signOff = (s: Served) => s.call("figma_sign_off", { nodeId: "12:345", lenses: lensesFor("ux", "page"), rounds: 1, placeholders: ["none"] });

  it("strict: a blocker naming the call that clears it, recorded with the attempt; the brief stays in force", async () => {
    const world = new RoleWorld();
    world.names.set("20:1", "Styleframe");
    world.briefs.set("12:40", complete({ checkpoint: "directions" }));
    const s = await serve("strict", world);
    try {
      const d = s.data(await signOff(s));
      expect(d.ok).toBe(false);
      expect(d.blockers).toEqual([{ what: 'the brief stops after the directions for the person\'s choice (checkpoint "directions"), and their choice is not recorded', call: WAY_OUT }]);
      expect(world.sent.find((x) => x.op === "sign_off")!.params.serverBlockers).toEqual([
        `the brief stops after the directions for the person's choice (checkpoint "directions"), and their choice is not recorded: ${WAY_OUT}`,
      ]);
      expect(s.roles.inForce("Co-op (figma)")?.briefId).toBe("12:40");
    } finally {
      await s.close();
    }
  });

  it("strict: with the person's choice recorded it passes, and the report says who chose", async () => {
    const world = new RoleWorld();
    world.names.set("20:1", "Styleframe");
    const approval = { by: "owner" as const, direction: "Timetable", at: AT };
    world.briefs.set("12:40", complete({ checkpoint: "directions", approval }));
    const s = await serve("strict", world);
    try {
      const d = s.data(await signOff(s));
      expect(d).toMatchObject({ ok: true, blockers: [], report: { direction: { chosen: "Timetable", checkpoint: "directions", approval } } });
      expect(d.processWarnings).toBeUndefined();
    } finally {
      await s.close();
    }
  });

  it("guided: the missing choice is a process warning, not a blocker; off says nothing", async () => {
    for (const mode of ["guided", "off"] as const) {
      const world = new RoleWorld();
      world.names.set("20:1", "Styleframe");
      world.briefs.set("12:40", complete({ checkpoint: "directions" }));
      const s = await serve(mode, world);
      try {
        const d = s.data(await signOff(s));
        expect(d.ok, mode).toBe(true);
        expect(d.blockers, mode).toEqual([]);
        expect(d.processWarnings, mode).toEqual(
          mode === "guided" ? [`the brief stops after the directions for the person's choice (checkpoint "directions"), and their choice is not recorded: ${WAY_OUT}.`] : undefined,
        );
      } finally {
        await s.close();
      }
    }
  });
});

// ── the clone of a styleframe ───────────────────────────────────────────────

describe("the clone of a styleframe into the build waits for the person's choice", () => {
  let s: Served & { world: RoleWorld };
  beforeEach(async () => (s = await ready("strict")));
  afterEach(async () => s.close());

  /** The brief stored here with the decision line recorded, its styleframes 20:1 and 20:2. */
  const decided = async (extra: Record<string, unknown> = {}) => {
    await s.call("figma_set_brief", UX_PAGE);
    await s.call("figma_set_brief", { briefId: "12:40", direction0: "a photo", directions: [{ name: "A", idea: "a" }, { name: "B", idea: "b" }], chosen: "A", styleframes: ["20:1", "20:2"], ...extra });
    s.world.sent = [];
  };

  it("strict refuses a styleframe's clone before any change, naming the brief and the calls; other clones run", async () => {
    await decided();
    const r = await s.call("figma_clone_node", { nodeId: "20-2", parentId: "0:1", idempotencyKey: "clone-1" });
    expect(r.structuredContent).toMatchObject({
      code: "PROCESS_REQUIRED",
      message:
        'figma_clone_node was refused before any change: the brief "Bench booking page" (12:40) stops after the directions for the person\'s choice, and 20:2 is one of its styleframes, which becomes the build once they choose. Missing: the person\'s choice of direction (approvedBy).',
      hint: `First ${WAY_OUT}. Then send this call again with the same idempotencyKey.`,
      idempotencyKey: "clone-1",
      partial: { created: [], missing: ["the person's choice of direction (approvedBy)"] },
      safeToRetry: true,
    });
    expect((await s.call("figma_clone_node", { nodeId: "5:5" })).isError).toBeFalsy();
    expect(s.world.ops()).toEqual(["clone_node"]);
  });

  it("once the person's choice is recorded the clone runs; so it does with no checkpoint", async () => {
    await decided();
    await s.call("figma_set_brief", { briefId: "12:40", approvedBy: "owner" });
    expect((await s.call("figma_clone_node", { nodeId: "20:1" })).isError).toBeFalsy();
    s.world.briefs.clear();
    await decided({ checkpoint: "none" });
    expect((await s.call("figma_clone_node", { nodeId: "20:1" })).isError).toBeFalsy();
  });

  it("before the decision line names a direction, styleframes are still being made: a clone runs", async () => {
    await s.call("figma_set_brief", UX_PAGE);
    await s.call("figma_set_brief", { briefId: "12:40", styleframes: ["20:1"] });
    expect((await s.call("figma_clone_node", { nodeId: "20:1" })).isError).toBeFalsy();
  });

  it("guided runs the clone and warns; off checks nothing", async () => {
    for (const mode of ["guided", "off"] as const) {
      const other = await ready(mode);
      try {
        await other.call("figma_set_brief", UX_PAGE);
        await other.call("figma_set_brief", { briefId: "12:40", chosen: "A", styleframes: ["20:1"] });
        const r = await other.call("figma_clone_node", { nodeId: "20:1" });
        expect(r.isError, mode).toBeFalsy();
        expect(other.data(r).processWarnings, mode).toEqual(
          mode === "guided" ? [`20:1 is a styleframe of "Bench booking page" (12:40), whose work waits for the person's choice of direction: ${WAY_OUT}.`] : undefined,
        );
      } finally {
        await other.close();
      }
    }
  });
});
