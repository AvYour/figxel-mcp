// A brief's `avoid` list (role quality plan W1, W3): the rules in
// src/shared/avoid.ts; figma_set_brief refusing anything but a tells kind, in
// every mode, and forwarding the list; figma_check_layout making a finding the
// brief avoids a warning at the page and top gears only, and running tells by
// default under such a brief.

import { afterEach, describe, expect, it } from "vitest";
import { AVOID_MAX, avoidNote, avoidOf, avoidRefusal, bindAvoid, boundKinds, tellsByDefault } from "../src/shared/avoid.js";
import { BRIEF_KEY, BRIEF_NAMESPACE, type BriefRecord } from "../src/shared/roles.js";
import { TELL_KINDS } from "../src/shared/tells-kinds.js";
import { CHECK_OPS, checkLayout, type Issue } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { brief, RoleWorld, serve, UX_PAGE, type Served } from "./role-fakes.js";

// ── a generic landing section, the check tests' fixture ─────────────────────

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `31:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const solid = (hex: string) => {
  const v = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [{ type: "SOLID", color: { r: v(1), g: v(3), b: v(5) } }];
};
const txt = (name: string, box: [number, number, number, number], chars: string, size: number) =>
  mk("TEXT", name, box, { characters: chars, fontName: { family: "Inter", style: "Regular" }, fontSize: size, fills: solid("#111111") });

/** Three identical icon + title + text cards (card_trio), one radius on each (one_radius needs four: not here). */
function trio(): N {
  const card = (n: string, x: number) =>
    mk("FRAME", `Card ${n}`, [x, 100, 300, 200], { fills: solid("#F5F5F5"), cornerRadius: 12 }, [
      mk("RECTANGLE", `${n} icon`, [x + 24, 124, 24, 24], { fills: solid("#111111") }),
      txt(`${n} title`, [x + 24, 164, 252, 24], "Fast setup", 20),
      txt(`${n} body`, [x + 24, 196, 252, 19], "Connect everything in minutes.", 16),
    ]);
  return mk("FRAME", "Features", [0, 0, 1000, 400], { fills: solid("#FFFFFF") }, [card("A", 0), card("B", 320), card("C", 640)]);
}

const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const tells = (root: N, b?: BriefRecord) => checkLayout(root as never, 3000, noYield, { audit: new Set(["tells"]) as never, ...(b ? { brief: b } : {}) });
const of = (issues: Issue[], kind: string) => issues.filter((i) => i.kind === kind);

// ── the rules ───────────────────────────────────────────────────────────────

describe("the rules (shared/avoid.ts)", () => {
  it("an avoid list takes tells kinds, measured or planned; anything else is named, with the kind it probably meant", () => {
    expect(avoidRefusal(["card_trio", "centred_stage", "cluster_4"])).toBeNull();
    const r = avoidRefusal(["card_trio", "cluster:4", "Card Trio", "stacked boxed cards", 7]);
    expect(r!.message).toBe(
      '`avoid` takes tells kinds, and "cluster:4" (did you mean "cluster_4"?), "Card Trio" (did you mean "card_trio"?), "stacked boxed cards", 7 are not.',
    );
    expect(r!.hint).toContain(`The kinds: ${TELL_KINDS.join(", ")}.`);
    expect(r!.hint).toContain('figma_get_guide { topic: "design", section: "tells" }');
    expect(avoidRefusal(["glow!"])!.message).toBe('`avoid` takes tells kinds, and "glow!" is not one.');
  });

  it("avoidOf reads a stored list: tells kinds once each, nothing else", () => {
    expect(avoidOf({ avoid: ["card_trio", "x", "card_trio", 3, "one_radius"] })).toEqual(["card_trio", "one_radius"]);
    expect(avoidOf({ avoid: "card_trio" })).toEqual([]);
    expect(avoidOf({})).toEqual([]);
    expect(avoidOf(undefined)).toEqual([]);
  });

  it("the list binds at the page and top gears only", () => {
    const avoid = ["card_trio"];
    expect(boundKinds({ gear: "page", avoid })).toEqual(avoid);
    expect(boundKinds({ gear: "top", avoid })).toEqual(avoid);
    for (const gear of ["section", "replica", "micro", "sting", "piece"] as const) expect(boundKinds({ gear, avoid }), gear).toEqual([]);
    expect(boundKinds(undefined)).toEqual([]);
  });

  it("tells run by default at page and top where the role's sign-off judges them, or the brief avoids one", () => {
    for (const role of ["ux", "graphic", "brand", "presentation"] as const) {
      expect(tellsByDefault(role, "page", []), role).toBe(true);
      expect(tellsByDefault(role, "top", []), role).toBe(true);
      expect(tellsByDefault(role, "section", ["card_trio"]), role).toBe(false);
    }
    // These roles' sign-offs judge no tells: only an avoid list asks for them.
    expect(tellsByDefault("design-system", "page", [])).toBe(false);
    expect(tellsByDefault("design-system", "page", ["one_radius"])).toBe(true);
    expect(tellsByDefault("board", "page", [])).toBe(false);
    expect(tellsByDefault("illustration", "top", ["emoji_icon"])).toBe(true);
    expect(tellsByDefault("ux", "replica", ["card_trio"])).toBe(false);
  });

  it("bindAvoid makes a listed kind a warning with the reason, keeps an error an error, and binds once", () => {
    const issues = [
      { kind: "card_trio", severity: "info", detail: "three cards." },
      { kind: "one_radius", severity: "info", detail: "one radius." },
      { kind: "glow", severity: "error", detail: "a glow." },
    ];
    const b = { gear: "page" as const, avoid: ["card_trio", "glow"] };
    expect(bindAvoid(issues, b)).toBe(2);
    expect(issues[0]).toEqual({ kind: "card_trio", severity: "warning", detail: `three cards. ${avoidNote("card_trio")}` });
    expect(issues[1]).toEqual({ kind: "one_radius", severity: "info", detail: "one radius." });
    expect(issues[2]!.severity).toBe("error");
    expect(bindAvoid(issues, b)).toBe(0);
    expect(issues[0]!.detail.split(avoidNote("card_trio"))).toHaveLength(2);
    expect(bindAvoid([{ kind: "card_trio", severity: "info", detail: "x" }], { gear: "section", avoid: ["card_trio"] })).toBe(0);
  });
});

// ── figma_check_layout ──────────────────────────────────────────────────────

describe("figma_check_layout: what the brief avoids is a warning at page and top", () => {
  const page = (over: Partial<BriefRecord> = {}) => brief({ id: "9:1", avoid: ["card_trio"], ...over });

  it("a card trio is info with no brief, at section gear, and with no avoid list; a warning at page and top when the brief avoids it", async () => {
    const at = async (b?: BriefRecord) => of((await tells(trio(), b)).issues, "card_trio").map((i) => i.severity);
    expect(await at()).toEqual(["info"]);
    expect(await at(page({ gear: "section" }))).toEqual(["info"]);
    expect(await at(page({ avoid: undefined }))).toEqual(["info"]);
    expect(await at(page({ avoid: ["one_radius"] }))).toEqual(["info"]);
    expect(await at(page())).toEqual(["warning"]);
    expect(await at(page({ gear: "top" }))).toEqual(["warning"]);
  });

  it("the warning's detail keeps the finding and says the brief avoids it; the other tells stay info", async () => {
    const r = await tells(trio(), page());
    const trios = of(r.issues, "card_trio");
    expect(trios[0]!.detail).toMatch(/are 3 identical cards of icon \+ title \+ text/);
    expect(trios[0]!.detail.endsWith(avoidNote("card_trio"))).toBe(true);
    const others = r.issues.filter((i) => i.kind !== "card_trio" && (TELL_KINDS as readonly string[]).includes(i.kind));
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((i) => i.severity === "info")).toBe(true);
  });

  describe("through the op", () => {
    const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });
    const holding = (record: BriefRecord) =>
      mk("FRAME", "Brief · Bench booking", [2000, 0, 720, 400], {
        getSharedPluginData: (ns: string, key: string) => (ns === BRIEF_NAMESPACE && key === BRIEF_KEY ? JSON.stringify({ ...record, id: holderId }) : ""),
      });
    let holderId = "";
    async function run(record: BriefRecord | null, audit: string[] = ["a11y"]) {
      const screen = trio();
      const block = record ? holding(record) : null;
      if (block) holderId = block.id;
      (globalThis as { figma?: unknown }).figma = {
        currentPage: mk("PAGE", "P", [0, 0, 0, 0], { selection: [] }),
        getNodeByIdAsync: async (id: string) => [screen, block].find((n) => n?.id === id) ?? null,
      };
      return (await CHECK_OPS.check_layout!.run(ctx({ nodeId: screen.id, audit, ...(block ? { briefId: block.id } : {}) }))) as {
        ok: boolean;
        counts: { error: number; warning: number; info: number };
        issues: Issue[];
        audit?: { ran: string[]; brief?: Record<string, unknown> | string };
      };
    }
    afterEach(() => {
      delete (globalThis as { figma?: unknown }).figma;
    });

    it("a page or top brief adds tells to what was asked; a section brief, or none, does not", async () => {
      expect((await run(page({ avoid: undefined }))).audit!.ran).toEqual(["a11y", "tells"]);
      expect((await run(page({ gear: "top", avoid: undefined }))).audit!.ran).toEqual(["a11y", "tells"]);
      expect((await run(page({ gear: "section" }))).audit!.ran).toEqual(["a11y"]);
      expect((await run(null)).audit!.ran).toEqual(["a11y"]);
      // Asked for nothing else, a page brief still runs tells.
      expect((await run(page({ avoid: undefined }), [])).audit!.ran).toEqual(["tells"]);
      expect((await run(null, [])).audit).toBeUndefined();
    });

    it("a role whose sign-off judges no tells gets them only when its brief avoids one", async () => {
      const ds = (avoid?: string[]) => page({ role: "design-system", details: { scope: "components" }, avoid });
      expect((await run(ds())).audit!.ran).toEqual(["a11y"]);
      expect((await run(ds(["card_trio"]))).audit!.ran).toEqual(["a11y", "tells"]);
    });

    it("an avoided finding fails the check (ok: false) and the result names the kinds the brief binds", async () => {
      const r = await run(page());
      expect(r.ok).toBe(false);
      expect(of(r.issues, "card_trio").map((i) => i.severity)).toEqual(["warning"]);
      expect(r.counts.warning).toBeGreaterThanOrEqual(1);
      expect((r.audit!.brief as Record<string, unknown>).avoid).toEqual(["card_trio"]);
      const loose = await run(page({ avoid: undefined }));
      expect(of(loose.issues, "card_trio").map((i) => i.severity)).toEqual(["info"]);
      expect((loose.audit!.brief as Record<string, unknown>).avoid).toBeUndefined();
      expect((await run(page({ gear: "section" }))).issues.find((i) => i.kind === "card_trio")).toBeUndefined();
    });
  });
});

// ── figma_set_brief and figma_get_brief on the server ───────────────────────

async function ready(mode: "strict" | "guided" | "off" = "strict", world = new RoleWorld()): Promise<Served & { world: RoleWorld }> {
  const s = await serve(mode, world);
  for (const skill of ["ux", "design", "graphic", "brand", "slides", "design-system", "figjam", "storyboard"]) s.ledger.note(skill, "test");
  return Object.assign(s, { world });
}

describe("figma_set_brief { avoid }", () => {
  it("an entry that is not a tells kind is INVALID_PARAM in every mode, naming it and the kinds, and nothing is sent", async () => {
    for (const mode of ["strict", "guided", "off"] as const) {
      const s = await ready(mode);
      try {
        const r = await s.call("figma_set_brief", { ...UX_PAGE, avoid: ["card_trio", "stacked boxed cards"] });
        expect(r.structuredContent, mode).toMatchObject({
          code: "INVALID_PARAM",
          message: '`avoid` takes tells kinds, and "stacked boxed cards" is not one.',
          hint: expect.stringContaining("The kinds: default_typeface, flat_hierarchy"),
          safeToRetry: true,
        });
        expect(s.world.ops(), mode).toEqual([]);
      } finally {
        await s.close();
      }
    }
  });

  it(`takes at most ${AVOID_MAX} entries`, async () => {
    const s = await ready("guided");
    try {
      const many = Array.from({ length: AVOID_MAX + 1 }, (_, i) => TELL_KINDS[i % TELL_KINDS.length]!);
      expect((await s.call("figma_set_brief", { ...UX_PAGE, avoid: many })).isError).toBe(true);
      expect(s.world.ops()).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("sends the list once each, on a new brief and on an update, and figma_get_brief returns it", async () => {
    const s = await ready("strict");
    try {
      const r = await s.call("figma_set_brief", { ...UX_PAGE, defaultToAvoid: "three icon cards under a centred headline", avoid: ["card_trio", "mostly_centred", "card_trio"] });
      expect(r.isError).toBeFalsy();
      expect(s.world.sent.at(-1)).toMatchObject({ op: "set_brief", params: { brief: { avoid: ["card_trio", "mostly_centred"] } } });
      expect(s.data(r).lint).toEqual([]);
      const u = await s.call("figma_set_brief", { briefId: "12:40", avoid: ["one_radius"] });
      expect(u.isError).toBeFalsy();
      expect(s.world.sent.at(-1)).toEqual({ op: "set_brief", params: { brief: { avoid: ["one_radius"] }, briefId: "12:40" } });
      const g = await s.call("figma_get_brief", { briefId: "12:40" });
      expect((s.data(g).brief as BriefRecord).avoid).toEqual(["one_radius"]);
      // The process holds it too: a create's tells summary depends on it.
      expect(s.roles.inForce("Co-op (figma)")?.avoid).toEqual(["one_radius"]);
    } finally {
      await s.close();
    }
  });
});
