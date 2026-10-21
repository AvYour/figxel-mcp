// The role process's plugin ops (roles spec §3.4–§3.6; the contract in
// docs/superpowers/plans/2026-10-16-roles-contract.md) against the write
// fakes: set_brief draws, redraws and stores; get_brief resolves a node to its
// brief by every path and reads the gate's facts; sign_off measures each
// deliverable, records every attempt, and closes the brief only on a pass.
//
// Independent of the shared op catalog (src/shared/ops.ts): the ops are run
// directly from BRIEF_OPS.

import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import { OPS } from "../src/shared/ops.js";
import {
  BRIEF_INDEX_KEY,
  BRIEF_KEY,
  BRIEF_NAMESPACE,
  SIGN_OFF_KEY,
  parseBrief,
  parseBriefIndex,
  parseSignOff,
  type AuditName,
  type BriefRecord,
} from "../src/shared/roles.js";
import { CRAFT_SEVERITY } from "../src/plugin/craft.js";
import { notBatchable } from "../src/plugin/ops/batch.js";
import { AUDIT_KINDS, BRIEF_OPS, blockLines, utf8Bytes } from "../src/plugin/ops/brief.js";
import { AUDITS, CHECK_OPS } from "../src/plugin/ops/check.js";
import { PLUGIN_OPS } from "../src/plugin/ops/index.js";
import { FakeContainer, FakeNode, installFigma, opContext, type FakeFigmaOptions } from "./editor-fakes.js";
import { GEAR_PIECE_MOVED, SAFE_AREA, gearPiece } from "./motion-piece.js";
import { WriteFigma } from "./write-fakes.js";

type Any = Record<string, unknown>;

// Shared and private plugin data on every fake node, as Figma gives every node [C-188].
const shared = new WeakMap<object, Map<string, string>>();
const priv = new WeakMap<object, Map<string, string>>();
function getShared(this: object, ns: string, key: string): string {
  return shared.get(this)?.get(`${ns}/${key}`) ?? "";
}
function setShared(this: object, ns: string, key: string, value: string): void {
  if (!shared.has(this)) shared.set(this, new Map());
  shared.get(this)!.set(`${ns}/${key}`, value);
}
function getPrivate(this: object, key: string): string {
  return priv.get(this)?.get(key) ?? "";
}
function setPrivate(this: object, key: string, value: string): void {
  if (!priv.has(this)) priv.set(this, new Map());
  priv.get(this)!.set(key, value);
}
const proto = FakeNode.prototype as unknown as Any;
beforeAll(() => {
  Object.assign(proto, { getSharedPluginData: getShared, setSharedPluginData: setShared, getPluginData: getPrivate, setPluginData: setPrivate });
});
afterAll(() => {
  for (const k of ["getSharedPluginData", "setSharedPluginData", "getPluginData", "setPluginData"]) delete proto[k];
});

/** The Design file: a viewport and a page switch for sign-off's select + zoom, and local styles on demand. */
class World extends WriteFigma {
  readonly shown: string[][] = [];
  paintStyles: Any[] = [];
  viewport = { zoom: 1, scrollAndZoomIntoView: (nodes: Array<{ id: string }>) => void this.shown.push(nodes.map((n) => n.id)) };
  constructor(opts: FakeFigmaOptions = {}) {
    super(opts);
  }
  async setCurrentPageAsync(page: FakeContainer): Promise<void> {
    this.currentPage = page as World["currentPage"];
  }
  async getLocalPaintStylesAsync(): Promise<Any[]> {
    return this.paintStyles;
  }
}

let fake: World;
let restore: (() => void) | undefined;
function file(opts: FakeFigmaOptions = {}): World {
  fake = new World(opts);
  restore = installFigma(fake);
  return fake;
}
afterEach(() => {
  restore?.();
  restore = undefined;
});

const run = (op: "set_brief" | "get_brief" | "sign_off", params: Any, extra: Parameters<typeof opContext>[1] = {}) =>
  BRIEF_OPS[op]!.run(opContext(params, extra)) as Promise<Any & { record?: BriefRecord }>;
async function refusal(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a refusal");
}
const node = (id: string) => fake.nodes.get(id) as unknown as Any & { id: string; name: string; type: string; children?: Any[] };
const sharedOf = (n: unknown, key: string) => getShared.call(n as object, BRIEF_NAMESPACE, key);
const recordOn = (n: unknown): BriefRecord => {
  const parsed = parseBrief(sharedOf(n, BRIEF_KEY));
  if (!("brief" in parsed)) throw new Error(parsed.invalid);
  return parsed.brief;
};
const rootIndex = () => parseBriefIndex(sharedOf(fake.root, BRIEF_INDEX_KEY));
const textsOf = (id: string) => (node(id).children ?? []) as Array<Any & { id: string; name: string; characters: string }>;
const statusText = (blockId: string) => textsOf(blockId).find((t) => t.name === "Status")!.characters;

const BRIEF = {
  role: "ux",
  gear: "page",
  title: "Bench booking",
  lines: {
    goal: "members book a bench slot online",
    message: "You fix your own bike here, with a mechanic beside you.",
    success: ["a visitor books within one scroll at 390 x 844", "the price is read before the button"],
    audience: "neighbours on a phone, next to a broken bike",
    tone: { words: ["hands-on", "plain", "welcoming"], not: "cute" },
    format: "390x844 px phone",
    defaultToAvoid: "a stock photo of a smiling cyclist",
  },
  details: { platform: "responsive", viewport: ["390x844"], task: "book a 45-minute bench slot" },
};

// ── deliverables as plain trees, the way the check tests build them ──────────

type N = Any & { id: string; name: string; type: string; children: N[]; parent?: unknown };
let seq = 0;
const solid = (hex: string) => [{ type: "SOLID", color: { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 } }];
function mk(type: string, name: string, box: [number, number, number, number], props: Any = {}, children: N[] = []): N {
  const [x, y, width, height] = box;
  const n: N = {
    id: `7:${++seq}`, type, name, x, y, width, height, visible: true, absoluteBoundingBox: { x, y, width, height }, ...props, children,
    getSharedPluginData: getShared, setSharedPluginData: setShared, getPluginData: getPrivate, setPluginData: setPrivate,
  };
  for (const c of children) c.parent = n;
  return n;
}
const text = (name: string, box: [number, number, number, number], chars: string, size: number, color = "#111111") =>
  mk("TEXT", name, box, { characters: chars, fontName: { family: "Inter", style: "Regular" }, fontSize: size, fills: solid(color), textAutoResize: "HEIGHT" });
/** Put a tree on a page and make every node in it findable by id. */
function onPage<T extends N>(n: T, page: FakeContainer = fake.currentPage): T {
  page.appendChild(n as unknown as FakeNode);
  const reg = (x: N) => {
    fake.nodes.set(x.id, x as unknown as FakeNode);
    x.children.forEach(reg);
  };
  reg(n);
  return n;
}
/** A screen that passes: dark text on white, one size. */
const cleanScreen = (name: string, at = 0) => onPage(mk("FRAME", name, [at, 0, 400, 120], { fills: solid("#FFFFFF") }, [text("Heading", [at + 40, 31, 320, 58], "Book a bench", 48)]));
/** A screen with text a reader cannot make out: #777 on #888 (low_contrast, a warning). */
const greyScreen = (name: string, at = 1000) => onPage(mk("FRAME", name, [at, 0, 400, 120], { fills: solid("#888888") }, [text("Price", [at + 40, 31, 320, 58], "Twelve euros an hour", 48, "#777777")]));

async function newBrief(extra: Any = {}, brief: Any = BRIEF): Promise<Any & { record: BriefRecord }> {
  return (await run("set_brief", { brief, ...extra })) as Any & { record: BriefRecord };
}
const LENSES = [{ lens: "message", score: 8, verdict: "pass" }];
const signParams = (briefId: string, extra: Any = {}) => ({
  briefId, audits: ["craft"], answerKinds: [], answers: [], lenses: LENSES, rounds: 1, exceptions: [], placeholders: ["none"],
  serverBlockers: [], build: { server: "0.1.1", skills: "abc123" }, ...extra,
});

// ── set_brief ───────────────────────────────────────────────────────────────

describe("set_brief: a new brief", () => {
  it("at page gear draws a block at an empty spot, stores the record on it and indexes it on the root", async () => {
    file();
    const work = fake.frame();
    work.resize(500, 300);
    work.x = 100;
    work.y = 50;
    const r = await newBrief();
    expect(r).toMatchObject({ stored: "block", status: "open", indexOn: "root" });
    expect(r.blockId).toBe(r.briefId);
    const block = node(r.briefId as string);
    expect(block).toMatchObject({ type: "FRAME", name: "Brief · Bench booking", layoutMode: "VERTICAL", width: 720, x: 1000, y: 50, primaryAxisSizingMode: "AUTO" });
    expect(block.parent).toBe(fake.currentPage);
    expect(textsOf(block.id).map((t) => t.name)).toEqual(["Role · gear", "Message", "Goal", "Audience", "Success", "Tone", "Default to avoid", "Status"]);
    expect(textsOf(block.id).map((t) => t.characters)).toEqual([
      "ux · page — senior UI/UX (product) designer",
      "Message: You fix your own bike here, with a mechanic beside you.",
      "Goal: members book a bench slot online",
      "Audience: neighbours on a phone, next to a broken bike",
      "Success:\n• a visitor books within one scroll at 390 x 844\n• the price is read before the button",
      "Tone: hands-on, plain, welcoming — not cute",
      "Default to avoid: a stock photo of a smiling cyclist",
      "Status: open — not signed off",
    ]);
    // Each line fills the 720 px column and wraps in it.
    expect(textsOf(block.id).every((t) => t.layoutSizingHorizontal === "FILL" && t.textAutoResize === "HEIGHT")).toBe(true);

    const stored = recordOn(block);
    expect(stored).toEqual(r.record);
    expect(stored).toMatchObject({ v: 1, id: block.id, role: "ux", gear: "page", title: "Bench booking", status: "open", deliverables: [] });
    expect(stored.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(stored.updatedAt).toBe(stored.createdAt);
    expect(stored.details).toEqual(BRIEF.details);
    expect(rootIndex()).toEqual([{ id: block.id, title: "Bench booking", role: "ux", gear: "page", pageId: fake.currentPage.id, status: "open", deliverables: [], updatedAt: stored.updatedAt }]);
    // The runner commits the one undo step; the op never does.
    expect(fake.undoCommits).toBe(0);
  });

  it("x, y and pageId place the block", async () => {
    file();
    const other = new FakeContainer("PAGE", "Explorations", fake);
    fake.root.appendChild(other);
    const r = await newBrief({ pageId: other.id, x: -2000, y: 300 });
    const block = node(r.briefId as string);
    expect(block.parent).toBe(other);
    expect([block.x, block.y]).toEqual([-2000, 300]);
    expect(rootIndex()[0]!.pageId).toBe(other.id);
  });

  it("at section gear stores on the page, with no block; block: false does the same at page gear", async () => {
    file();
    const before = fake.currentPage.children.length;
    const r = await newBrief({}, { ...BRIEF, gear: "section" });
    expect(r).toMatchObject({ stored: "page", briefId: fake.currentPage.id });
    expect(r.blockId).toBeUndefined();
    expect(fake.currentPage.children.length).toBe(before);
    expect(recordOn(fake.currentPage).gear).toBe("section");

    file();
    const p = await newBrief({ block: false });
    expect(p).toMatchObject({ stored: "page", briefId: fake.currentPage.id });
  });

  it("nodeId stores it on that node instead of drawing a block", async () => {
    file();
    const screen = cleanScreen("Slots");
    const r = await newBrief({ nodeId: screen.id });
    expect(r).toMatchObject({ stored: "node", briefId: screen.id });
    expect(recordOn(screen).id).toBe(screen.id);
    expect(fake.currentPage.children).toHaveLength(1);
  });

  it("refuses a node or page that already holds a brief, before any change", async () => {
    file();
    const screen = cleanScreen("Slots");
    await newBrief({ nodeId: screen.id });
    const e = await refusal(newBrief({ nodeId: screen.id }));
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toMatch(/already holds the brief "Bench booking"/);
    expect(e.hint).toContain(`briefId: "${screen.id}"`);
    expect(e.partial).toEqual({ created: [] });
  });

  it("refuses a malformed brief, a gear the role does not take, and a record over 90,000 bytes — drawing nothing", async () => {
    file();
    const count = () => fake.currentPage.children.length;
    const cases: Array<[Any, Any, RegExp]> = [
      [{ ...BRIEF, role: "painter" }, {}, /not a role/],
      [{ ...BRIEF, gear: "replica", role: "graphic" }, {}, /graphic role does not take the replica gear/],
      [{ ...BRIEF, colour: "red" }, {}, /brief\.colour` is not a field/],
      [{ ...BRIEF, lines: { ...BRIEF.lines, mood: "x" } }, {}, /lines\.mood` is not a line/],
      [{ ...BRIEF, lines: { ...BRIEF.lines, success: "one line" } }, {}, /lines\.success` must be a list/],
      [{ role: "ux", gear: "page", title: "No goal", lines: { message: "m" } }, {}, /needs `brief\.lines\.goal`/],
      [{ ...BRIEF, lines: { ...BRIEF.lines, assumptions: Array.from({ length: 100 }, () => "é".repeat(500)) } }, {}, /bytes; one record holds at most 90000/],
      [BRIEF, { reopen: true }, /`reopen` takes `briefId`/],
      [BRIEF, { nodeId: "1:1", block: true }, /not both/],
    ];
    for (const [brief, extra, message] of cases) {
      const e = await refusal(run("set_brief", { brief, ...extra }));
      expect(e.code, String(message)).toBe("INVALID_PARAM");
      expect(e.message).toMatch(message);
      expect(e.partial).toEqual({ created: [] });
    }
    expect(count()).toBe(0);
    expect(utf8Bytes("é€😀")).toBe(2 + 3 + 4);
  });

  it("falls back to the page for the index when the root cannot be written", async () => {
    file();
    (fake.root as unknown as Any).setSharedPluginData = () => {
      throw new Error("in setSharedPluginData: not supported on the document");
    };
    const r = await newBrief();
    expect(r.indexOn).toBe("page");
    expect(parseBriefIndex(sharedOf(fake.currentPage, BRIEF_INDEX_KEY)).map((e) => e.id)).toEqual([r.briefId]);
    // Reading still finds it: the index is the root's merged with the pages'.
    const g = await run("get_brief", {});
    expect((g.open as Any[]).map((e) => e.id)).toEqual([r.briefId]);
  });

  it("in FigJam the block is a section holding one text, sized to it", async () => {
    file({ editorType: "figjam" });
    const r = await newBrief({}, { ...BRIEF, role: "board", gear: "page", details: { purpose: "p", participants: "q", activity: "a", outcome: "o" } });
    const section = node(r.briefId as string) as unknown as Any & { id: string; resizes: Array<{ via: string; w: number; h: number }> };
    expect(section).toMatchObject({ type: "SECTION", name: "Brief · Bench booking" });
    const kids = textsOf(section.id);
    expect(kids.map((t) => t.name)).toEqual(["Brief"]);
    expect(kids[0]!.characters).toMatch(/^board · page — workshop and information designer\n\nMessage: /);
    expect(kids[0]!.characters).toMatch(/\n\nStatus: open — not signed off$/);
    expect([kids[0]!.x, kids[0]!.y]).toEqual([32, 32]);
    expect(section.resizes.at(-1)).toMatchObject({ via: "resizeWithoutConstraints", w: 720 });
    // FigJam's own text default, Charcoal [C-156].
    expect(kids[0]!.fills).toEqual([{ type: "SOLID", color: { r: 30 / 255, g: 30 / 255, b: 30 / 255 } }]);
  });

  it("in Slides there is never a block: the brief goes on the page, and asking for a block says so", async () => {
    file({ editorType: "slides" });
    const r = await newBrief({ block: true }, { ...BRIEF, role: "presentation", gear: "page", details: { room: "projected", arc: "problem, proof, ask" } });
    expect(r).toMatchObject({ stored: "page", briefId: fake.currentPage.id });
    expect(r.note).toMatch(/no brief block/);
  });
});

describe("set_brief: an update", () => {
  it("merges lines and details key by key, removes a line set to null, renames and redraws the block", async () => {
    file();
    const r = await newBrief();
    const id = r.briefId as string;
    const oldTexts = textsOf(id).map((t) => t.id);
    const u = await run("set_brief", {
      briefId: id,
      brief: {
        title: "Bench booking v2",
        lines: { audience: "regulars who book every week", defaultToAvoid: null },
        details: { task: "rebook last week's slot", screens: [{ name: "Slots", states: ["empty", "error"] }] },
        direction0: "a list of slots, like every booking page",
        directions: [{ name: "Workbench", idea: "the page is a pegboard" }, { name: "Receipt", idea: "a till roll", total: 31 }],
      },
    });
    expect(u).toMatchObject({ briefId: id, stored: "block", status: "open" });
    const rec = recordOn(node(id));
    expect(rec.lines).toMatchObject({ goal: BRIEF.lines.goal, message: BRIEF.lines.message, audience: "regulars who book every week" });
    expect(rec.lines.defaultToAvoid).toBeUndefined();
    expect(rec.details).toEqual({ ...BRIEF.details, task: "rebook last week's slot", screens: [{ name: "Slots", states: ["empty", "error"] }] });
    expect(rec.directions).toHaveLength(2);
    expect(rec.createdAt).toBe(r.record.createdAt);
    expect(node(id).name).toBe("Brief · Bench booking v2");
    const now = textsOf(id);
    expect(now.map((t) => t.name)).toEqual(["Role · gear", "Message", "Goal", "Audience", "Success", "Tone", "Status"]);
    expect(now.find((t) => t.name === "Audience")!.characters).toBe("Audience: regulars who book every week");
    expect(now.some((t) => oldTexts.includes(t.id))).toBe(false);
    expect(rootIndex()[0]).toMatchObject({ id, title: "Bench booking v2" });
  });

  it("keeps what a person added to the block", async () => {
    file();
    const r = await newBrief();
    const id = r.briefId as string;
    const sticker = text("Note from Ana", [0, 0, 100, 20], "ask about weekends", 12);
    (node(id) as unknown as FakeContainer).appendChild(sticker as unknown as FakeNode);
    await run("set_brief", { briefId: id, brief: { lines: { goal: "book a slot in two taps" } } });
    expect(textsOf(id).map((t) => t.name)).toContain("Note from Ana");
  });

  it("adds deliverables (each once, in order) and refuses an id that names nothing", async () => {
    file();
    const a = cleanScreen("Slots");
    const b = cleanScreen("Confirm", 500);
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id] });
    const id = r.briefId as string;
    await run("set_brief", { briefId: id, brief: { deliverables: [b.id, a.id] } });
    expect(recordOn(node(id)).deliverables).toEqual([a.id, b.id]);
    expect(rootIndex()[0]!.deliverables).toEqual([a.id, b.id]);
    const before = sharedOf(node(id), BRIEF_KEY);
    const e = await refusal(run("set_brief", { briefId: id, brief: { deliverables: ["404:404"] } }));
    expect(e.code).toBe("NODE_NOT_FOUND");
    expect(e.partial).toEqual({ created: [] });
    expect(sharedOf(node(id), BRIEF_KEY)).toBe(before);
    const self = await refusal(run("set_brief", { briefId: id, brief: { deliverables: [id] } }));
    expect(self.message).toMatch(/the brief block itself/);
  });

  it("refuses briefId and nodeId together, and a briefId with no brief on it", async () => {
    file();
    const screen = cleanScreen("Slots");
    expect((await refusal(run("set_brief", { briefId: screen.id, nodeId: screen.id, brief: {} }))).message).toMatch(/not both/);
    expect((await refusal(run("set_brief", { briefId: screen.id, brief: {} }))).message).toMatch(/No brief is stored on "Slots"/);
  });
});

describe("set_brief: the avoid list (role quality W1)", () => {
  /** A row of three identical icon + title + text cards: card_trio. */
  const trioScreen = () => {
    const card = (n: string, x: number) =>
      mk("FRAME", `Card ${n}`, [x, 100, 300, 200], { fills: solid("#F5F5F5"), cornerRadius: 12 }, [
        mk("RECTANGLE", `${n} icon`, [x + 24, 124, 24, 24], { fills: solid("#111111") }),
        text(`${n} title`, [x + 24, 164, 252, 24], "Fast setup", 20),
        text(`${n} body`, [x + 24, 196, 252, 19], "Connect everything in minutes.", 16),
      ]);
    return onPage(mk("FRAME", "Features", [0, 0, 1000, 400], { fills: solid("#FFFFFF") }, [card("A", 0), card("B", 320), card("C", 640)]));
  };

  it("stores the list, shows it on the block after the default to avoid, replaces it on update and removes it with null", async () => {
    file();
    const r = await newBrief({}, { ...BRIEF, avoid: ["card_trio", "one_radius"] });
    const id = r.briefId as string;
    expect(recordOn(node(id)).avoid).toEqual(["card_trio", "one_radius"]);
    expect(textsOf(id).map((t) => t.name)).toEqual(["Role · gear", "Message", "Goal", "Audience", "Success", "Tone", "Default to avoid", "Avoid", "Status"]);
    expect(textsOf(id).find((t) => t.name === "Avoid")!.characters).toBe("Avoid: card_trio, one_radius");
    await run("set_brief", { briefId: id, brief: { avoid: ["centred_stage"] } });
    expect(recordOn(node(id)).avoid).toEqual(["centred_stage"]);
    expect(textsOf(id).filter((t) => t.name === "Avoid").map((t) => t.characters)).toEqual(["Avoid: centred_stage"]);
    await run("set_brief", { briefId: id, brief: { avoid: null } });
    expect(recordOn(node(id)).avoid).toBeUndefined();
    expect(textsOf(id).map((t) => t.name)).not.toContain("Avoid");
  });

  it("refuses an entry that is not a tells kind, and a list over the cap, drawing nothing", async () => {
    file();
    const e = await refusal(newBrief({}, { ...BRIEF, avoid: ["card_trio", "boxed cards"] }));
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toBe('`brief.avoid` takes tells kinds, and "boxed cards" is not one.');
    expect(e.hint).toMatch(/^The kinds: default_typeface, /);
    expect(e.partial).toEqual({ created: [] });
    const over = await refusal(newBrief({}, { ...BRIEF, avoid: Array.from({ length: 25 }, () => "glow") }));
    expect(over.message).toMatch(/at most 24 tells kinds/);
    expect(fake.currentPage.children).toHaveLength(0);
  });

  it("sign-off: a finding the page brief avoids is a warning no answer clears; at the section gear the answer does", async () => {
    const sign = async (gear: string) => {
      file();
      const screen = trioScreen();
      const r = await newBrief({}, { ...BRIEF, gear, avoid: ["card_trio"], deliverables: [screen.id] });
      const answers = [{ kind: "card_trio", nodeId: screen.children[0]!.id, reason: "three equal plans, on purpose" }];
      return run("sign_off", signParams(r.briefId as string, { audits: ["craft", "tells"], answerKinds: ["craft", "tells"], answers }));
    };
    const page = await sign("page");
    expect(page.ok).toBe(false);
    const trio = (page.issues as Array<Any & { kind: string }>).filter((i) => i.kind === "card_trio");
    expect(trio.map((i) => i.severity)).toEqual(["warning"]);
    expect(String(trio[0]!.detail)).toMatch(/The brief's avoid list names card_trio/);
    expect((page.checks as Any[]).find((c) => c.name === "tells")).toMatchObject({ ok: false, warnings: 1 });

    const section = await sign("section");
    expect((section.issues as Array<{ kind: string }>).some((i) => i.kind === "card_trio")).toBe(false);
    expect((section.unanswered as Array<{ kind: string }>).some((i) => i.kind === "card_trio")).toBe(false);
  });

  it("sign-off: a role whose audits leave out tells is still judged on them when its avoid list binds", async () => {
    file();
    const screen = trioScreen();
    const r = await newBrief({}, { ...BRIEF, gear: "page", avoid: ["card_trio"], deliverables: [screen.id] });
    // The illustration and design-system sign-offs run no tells of their own.
    const out = await run("sign_off", signParams(r.briefId as string, { audits: ["craft"], answerKinds: ["craft"] }));
    expect(out.ok).toBe(false);
    expect((out.issues as Array<{ kind: string; severity: string }>).filter((i) => i.kind === "card_trio").map((i) => i.severity)).toEqual(["warning"]);
    expect((out.checks as Any[]).find((c) => c.name === "tells")).toMatchObject({ ok: false, warnings: 1 });
  });
});

// ── get_brief ───────────────────────────────────────────────────────────────

describe("get_brief", () => {
  it("briefId reads the record on that node", async () => {
    file();
    const r = await newBrief();
    const g = await run("get_brief", { briefId: r.briefId });
    expect(g.brief).toEqual(r.record);
    expect((g.open as Any[]).map((e) => e.id)).toEqual([r.briefId]);
  });

  it("nodeId: its own record, else the nearest above it", async () => {
    file();
    const screen = onPage(mk("FRAME", "Slots", [0, 0, 400, 400], {}, [mk("FRAME", "List", [0, 0, 400, 200], {}, [text("Row", [0, 0, 100, 20], "9:00", 16)])]));
    const r = await newBrief({ nodeId: screen.id });
    expect(await run("get_brief", { nodeId: screen.id })).toMatchObject({ brief: { id: r.briefId }, from: "node" });
    const row = screen.children[0]!.children[0]!;
    expect(await run("get_brief", { nodeId: row.id })).toMatchObject({ brief: { id: r.briefId }, from: "node" });
    // Read by briefId, the record says nothing of how it was found.
    expect((await run("get_brief", { briefId: r.briefId, nodeId: row.id })).from).toBeUndefined();
  });

  it("nodeId: else the brief whose deliverables list it or a frame around it", async () => {
    file();
    const screen = onPage(mk("FRAME", "Slots", [0, 0, 400, 400], {}, [text("Row", [0, 0, 100, 20], "9:00", 16)]));
    const r = await newBrief({}, { ...BRIEF, deliverables: [screen.id] });
    expect(await run("get_brief", { nodeId: screen.id })).toMatchObject({ brief: { id: r.briefId }, from: "node" });
    expect(await run("get_brief", { nodeId: screen.children[0]!.id })).toMatchObject({ brief: { id: r.briefId }, from: "node" });
  });

  it("nodeId: else its page's, said as from: \"page\"; and nothing with no brief anywhere", async () => {
    file();
    const loose = cleanScreen("Loose");
    const none = await run("get_brief", { nodeId: loose.id });
    expect([none.brief, none.from]).toEqual([undefined, undefined]);
    const r = await newBrief({}, { ...BRIEF, gear: "section" });
    expect(r.stored).toBe("page");
    expect(await run("get_brief", { nodeId: loose.id })).toMatchObject({ brief: { id: fake.currentPage.id }, from: "page" });
    // The page itself holds it: the page's own brief.
    expect((await run("get_brief", { nodeId: fake.currentPage.id })).from).toBe("node");
  });

  it("does not take a duplicated layer's copy of a brief for the brief", async () => {
    file();
    const screen = cleanScreen("Slots");
    await newBrief({ nodeId: screen.id });
    const copy = cleanScreen("Slots copy", 600);
    setShared.call(copy, BRIEF_NAMESPACE, BRIEF_KEY, sharedOf(screen, BRIEF_KEY));
    const g = await run("get_brief", { nodeId: copy.id });
    expect(g.brief).toBeUndefined();
    expect(g.invalid).toMatch(/carries a copy of the brief stored on/);
  });

  it("with no arguments lists the open briefs, newest first, not signed ones and not one whose block was deleted", async () => {
    file();
    const a = await newBrief({}, { ...BRIEF, title: "A" });
    const b = await newBrief({}, { ...BRIEF, title: "B" });
    const c = await newBrief({}, { ...BRIEF, title: "C" });
    const d = await newBrief({}, { ...BRIEF, title: "D" });
    // C is signed off; D's block was deleted by hand.
    const screen = cleanScreen("Slots", 5000);
    const signed = await run("sign_off", signParams(c.briefId as string, { nodeIds: [screen.id] }));
    expect(signed.ok).toBe(true);
    (node(d.briefId as string) as unknown as FakeNode).remove();
    const g = await run("get_brief", {});
    expect(g.brief).toBeUndefined();
    expect((g.open as Any[]).map((e) => e.title)).toEqual(["B", "A"]);
    expect([a.briefId, b.briefId]).toEqual((g.open as Any[]).map((e) => e.id).reverse());
  });

  it("target: the facts the process gate reads, in Design", async () => {
    file();
    const empty = fake.frame();
    const full = cleanScreen("Slots", 600);
    const inner = full.children[0]!;
    const sectioned = new FakeContainer("SECTION", "Zone", fake);
    fake.currentPage.appendChild(sectioned);
    const inSection = fake.frame(sectioned);
    const facts = async (target: Any) => (await run("get_brief", { target })).target;
    expect(await facts({})).toEqual({ type: "PAGE", topLevel: true, childCount: 3 });
    expect(await facts({ parentId: empty.id })).toEqual({ type: "FRAME", topLevel: true, childCount: 0 });
    expect(await facts({ parentId: full.id })).toEqual({ type: "FRAME", topLevel: true, childCount: 1 });
    expect(await facts({ parentId: inner.id })).toEqual({ type: "TEXT", topLevel: false, childCount: 0 });
    expect(await facts({ parentId: inSection.id })).toEqual({ type: "FRAME", topLevel: true, childCount: 0 });
    expect(await facts({ pageId: fake.currentPage.id })).toMatchObject({ type: "PAGE", topLevel: true });
    expect((await refusal(run("get_brief", { target: { parentId: "404:1" } }))).code).toBe("NODE_NOT_FOUND");
  });

  it("target: in Slides, the focused slide and whether any slide of the deck has content", async () => {
    file({ editorType: "slides" });
    expect((await run("get_brief", { target: {} })).target).toEqual({ type: "PAGE", topLevel: true, childCount: 1, deckHasContent: false });
    const s = fake.slide(true);
    expect((await run("get_brief", { target: {} })).target).toEqual({ type: "SLIDE", topLevel: false, childCount: 0, deckHasContent: false });
    s.appendChild(new FakeNode("TEXT", "Title", fake));
    expect(((await run("get_brief", { target: { parentId: s.id } })).target as Any).deckHasContent).toBe(true);
  });

  it("fingerprint needs nodeId", async () => {
    file();
    expect((await refusal(run("get_brief", { fingerprint: true }))).message).toMatch(/`fingerprint` needs `nodeId`/);
  });
});

// ── check_layout's default brief ────────────────────────────────────────────

describe("check_layout: the checked work's own brief wins over the brief in force", () => {
  // The live case of 2026-10-20: a UX screen listed in its brief (a 13 px
  // floor) was checked while a motion brief (a 32 px floor and a safe area)
  // was in force, and drew 171 false safe_area and min_text warnings.
  const MOTION = {
    role: "motion",
    gear: "piece",
    title: "Ferry sting",
    lines: { goal: "the 07:20 sailing reads at a glance", message: "The ferry leaves on time.", success: ["the time reads at 1080 wide"], minTextSize: 32, safeArea: "64,64,952,1166" },
    details: { placement: "story", durationS: 6, fps: 30 },
  };
  type Checked = Any & { issues: Array<Any & { kind: string }>; audit: Any & { brief: Any } };
  const check = (params: Any) => CHECK_OPS.check_layout!.run(opContext(params)) as Promise<Checked>;
  const floors = (r: Checked) => r.issues.map((i) => i.kind).filter((k) => k === "safe_area" || k === "min_text").sort();
  /** A timetable screen: 16 px text at 40, 31 — under the motion brief's floor and outside its safe area. */
  const timetable = (name: string, at = 0) =>
    onPage(mk("FRAME", name, [at, 0, 400, 120], { fills: solid("#FFFFFF") }, [text("Departures", [at + 40, 31, 320, 19], "07:20 Port Ellery", 16)]));
  async function live() {
    file();
    const screen = timetable("Timetable");
    const ux = await newBrief({}, { ...BRIEF, lines: { ...BRIEF.lines, minTextSize: 13 }, deliverables: [screen.id] });
    const motion = await newBrief({}, MOTION);
    return { screen, ux: ux.briefId as string, motion: motion.briefId as string };
  }

  it("a deliverable of a brief, or a layer inside one, is measured against that brief, and audit.brief names it", async () => {
    const { screen, ux, motion } = await live();
    for (const nodeId of [screen.id, screen.children[0]!.id]) {
      const r = await check({ nodeId, audit: ["craft"], briefInForce: motion });
      expect(floors(r), nodeId).toEqual([]);
      expect(r.audit.brief, nodeId).toMatchObject({ id: ux, title: "Bench booking", role: "ux", from: "node" });
    }
  });

  it("work no brief covers is measured against the brief in force; a briefId the call names wins over both", async () => {
    const { screen, motion } = await live();
    const loose = timetable("Sting", 3000);
    const inForce = await check({ nodeId: loose.id, audit: ["craft"], briefInForce: motion });
    expect(floors(inForce)).toEqual(["min_text", "safe_area"]);
    expect(inForce.audit.brief).toMatchObject({ id: motion, role: "motion", from: "in force" });
    const named = await check({ nodeId: screen.id, audit: ["craft"], briefId: motion });
    expect(floors(named)).toEqual(["min_text", "safe_area"]);
    expect(named.audit.brief).toMatchObject({ id: motion, from: "briefId" });
  });

  it("a brief stored on the page does not outrank the brief in force: only the work's own record or a brief listing it does", async () => {
    file();
    const section = await newBrief({}, { ...BRIEF, gear: "section" });
    expect(section.stored).toBe("page");
    const motion = await newBrief({}, MOTION);
    const loose = timetable("Sting");
    const r = await check({ nodeId: loose.id, audit: ["craft"], briefInForce: motion.briefId });
    expect(r.audit.brief).toMatchObject({ id: motion.briefId, from: "in force" });
  });

  it("roots of different briefs: measured against the first root's, and audit.brief names the roots it does not cover", async () => {
    const { screen, ux, motion } = await live();
    const loose = timetable("Sting", 3000);
    const r = await check({ nodeIds: [screen.id, loose.id], audit: ["craft"], briefInForce: motion });
    expect(r.audit.brief).toMatchObject({ id: ux, from: "node" });
    expect(r.audit.brief.note).toBe(`"Sting" (${loose.id}) belongs to "Ferry sting" (${motion}), the brief in force, not to this one: check it in its own call.`);
  });
});

// ── sign_off ────────────────────────────────────────────────────────────────

describe("sign_off", () => {
  it("a pass: records on every deliverable, the brief signed, the block's status line, the index, select + zoom", async () => {
    file();
    const a = cleanScreen("Slots");
    const b = cleanScreen("Confirm", 500);
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id, b.id] });
    const id = r.briefId as string;
    const s = await run("sign_off", signParams(id));
    expect(s).toMatchObject({ ok: true, briefStatus: "signed", issues: [], unanswered: [], indexOn: "root" });
    expect(s.checks).toEqual([{ name: "craft", ok: true, errors: 0, warnings: 0, infos: expect.any(Number), unanswered: 0 }]);
    const prints = s.fingerprints as Record<string, string>;
    expect(Object.keys(prints)).toEqual([a.id, b.id]);
    for (const d of [a, b]) {
      const parsed = parseSignOff(sharedOf(d, SIGN_OFF_KEY));
      if (!("signOff" in parsed)) throw new Error(parsed.invalid);
      expect(parsed.signOff).toMatchObject({
        v: 1, briefId: id, role: "ux", gear: "page", at: s.signedAt, ok: true, fingerprint: prints[d.id], lenses: LENSES, rounds: 1,
        placeholders: ["none"], build: { server: "0.1.1", skills: "abc123" },
      });
      expect(prints[d.id]).toMatch(/^[0-9a-f]{8}$/);
    }
    const rec = recordOn(node(id));
    expect(rec).toMatchObject({ status: "signed", lastSignOff: { at: s.signedAt, ok: true }, deliverables: [a.id, b.id], updatedAt: s.signedAt });
    expect(statusText(id)).toBe(`Status: signed off ${String(s.signedAt).slice(0, 10)}`);
    expect(rootIndex()[0]).toMatchObject({ id, status: "signed" });
    expect(fake.currentPage.selection.map((n) => n.id)).toEqual([a.id, b.id]);
    expect(fake.shown).toEqual([[a.id, b.id]]);
    expect(fake.undoCommits).toBe(0);
  });

  it("nodeIds names the deliverables and adds them to the brief on a pass; none at all is refused", async () => {
    file();
    const r = await newBrief();
    const id = r.briefId as string;
    const e = await refusal(run("sign_off", signParams(id)));
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toMatch(/lists no deliverables .* name the work/);
    expect(e.partial).toEqual({ created: [] });
    const a = cleanScreen("Slots");
    expect((await run("sign_off", signParams(id, { nodeIds: [a.id] }))).ok).toBe(true);
    expect(recordOn(node(id)).deliverables).toEqual([a.id]);
    const block = await refusal(run("sign_off", signParams(id, { nodeIds: [id] })));
    expect(block.message).toMatch(/is a brief block, a working note/);
  });

  it("a warning fails it: every deliverable still gets the failing record, and the brief stays open", async () => {
    file();
    const a = cleanScreen("Slots");
    const b = greyScreen("Price");
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id, b.id] });
    const id = r.briefId as string;
    const s = await run("sign_off", signParams(id));
    expect(s).toMatchObject({ ok: false, briefStatus: "open" });
    expect((s.issues as Any[]).map((i) => [i.kind, i.severity, i.nodeId])).toEqual([["low_contrast", "warning", b.children[0]!.id]]);
    // figma_check_layout's own look is counted with craft.
    expect(s.checks).toEqual([expect.objectContaining({ name: "craft", ok: false, warnings: 1 })]);
    for (const d of [a, b]) {
      const parsed = parseSignOff(sharedOf(d, SIGN_OFF_KEY));
      expect("signOff" in parsed && parsed.signOff.ok).toBe(false);
    }
    const rec = recordOn(node(id));
    expect(rec).toMatchObject({ status: "open", lastSignOff: { at: s.signedAt, ok: false }, updatedAt: r.record.updatedAt });
    expect(statusText(id)).toBe("Status: open — not signed off");
    expect(rootIndex()[0]!.status).toBe("open");
    expect(fake.currentPage.selection).toEqual([]);
    expect(fake.shown).toEqual([]);
  });

  it("infos of answerKinds left unanswered fail it; answers by kind and node let it pass", async () => {
    file();
    // 48 and 52 px of one family: near_size, a craft info [C-207].
    const screen = onPage(mk("FRAME", "Hero", [0, 0, 800, 300], { fills: solid("#FFFFFF") }, [
      text("Title", [40, 40, 700, 58], "Book a bench", 48),
      text("Subtitle", [40, 140, 700, 62], "With a mechanic beside you", 52),
    ]));
    const r = await newBrief({}, { ...BRIEF, deliverables: [screen.id] });
    const id = r.briefId as string;
    const first = await run("sign_off", signParams(id, { answerKinds: ["craft"] }));
    expect(first.ok).toBe(false);
    const open = first.unanswered as Array<{ kind: string; nodeId: string; severity: string }>;
    expect(open.every((i) => i.severity === "info" && (AUDIT_KINDS.craft as readonly string[]).includes(i.kind))).toBe(true);
    expect(open.map((i) => i.kind)).toContain("near_size");
    expect((first.checks as Any[])[0]).toMatchObject({ name: "craft", ok: false, unanswered: open.length });

    // An answer for a different node does not cover it.
    const wrong = await run("sign_off", signParams(id, { answerKinds: ["craft"], answers: open.map((i) => ({ kind: i.kind, nodeId: "9:9", reason: "x" })) }));
    expect((wrong.unanswered as Any[]).length).toBe(open.length);

    const answers = open.map((i) => ({ kind: i.kind, nodeId: i.nodeId, reason: "the subtitle is meant to sit this close to the title" }));
    const second = await run("sign_off", signParams(id, { answerKinds: ["craft"], answers }));
    expect(second).toMatchObject({ ok: true, unanswered: [] });
    const parsed = parseSignOff(sharedOf(screen, SIGN_OFF_KEY));
    expect("signOff" in parsed && parsed.signOff.answers).toEqual(answers);
  });

  it("a server blocker makes it fail however clean the checks, and is recorded as a failing attempt", async () => {
    file();
    const a = cleanScreen("Slots");
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id] });
    const s = await run("sign_off", signParams(r.briefId as string, { serverBlockers: ["the brief records no directions"] }));
    expect(s).toMatchObject({ ok: false, issues: [], unanswered: [], briefStatus: "open" });
    const parsed = parseSignOff(sharedOf(a, SIGN_OFF_KEY));
    expect("signOff" in parsed && parsed.signOff.ok).toBe(false);
  });

  it("the record keeps each lens's reviewer (\"self\" where none is given) and whether the cold lenses were independent", async () => {
    file();
    const a = cleanScreen("Slots");
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id] });
    const id = r.briefId as string;
    const recorded = () => {
      const parsed = parseSignOff(sharedOf(a, SIGN_OFF_KEY));
      if (!("signOff" in parsed)) throw new Error(parsed.invalid);
      return parsed.signOff;
    };
    // Page, the builder's own scores: it passes here, and the record says self-reviewed.
    await run("sign_off", signParams(id));
    expect(recorded()).toMatchObject({ lenses: [{ lens: "message", score: 8, verdict: "pass", reviewer: "self" }], independent: false, selfReviewed: true });
    await run("set_brief", { briefId: id, reopen: true });
    const cold = [
      { lens: "message", score: 9, verdict: "pass", reviewer: "agent:critic-1" },
      { lens: "originality", score: 8, verdict: "pass", reviewer: "owner" },
      { lens: "copy", score: 9, verdict: "pass" },
    ];
    await run("sign_off", signParams(id, { lenses: cold }));
    const rec = recorded();
    expect(rec.lenses.map((l) => l.reviewer)).toEqual(["agent:critic-1", "owner", "self"]);
    expect(rec.independent).toBe(true);
    expect(rec.selfReviewed).toBeUndefined();
  });

  it("refuses a reviewer outside self, owner and agent:<name> before recording anything", async () => {
    file();
    const a = cleanScreen("Slots");
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id] });
    const e = await refusal(run("sign_off", signParams(r.briefId as string, { lenses: [{ lens: "message", score: 9, verdict: "pass", reviewer: "critic" }] })));
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toMatch(/reviewer "self", "owner" or "agent:<name>"/);
    expect(sharedOf(a, SIGN_OFF_KEY)).toBe("");
  });

  it("tokensWhenSystem runs tokens only where the file has a system to bind to", async () => {
    file();
    const a = cleanScreen("Slots");
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id] });
    const id = r.briefId as string;
    const without = await run("sign_off", signParams(id, { tokensWhenSystem: true }));
    expect(without.ok).toBe(true);
    expect((without.checks as Any[]).map((c) => c.name)).toEqual(["craft"]);

    fake.paintStyles = [{ id: "S:1", name: "Brand/Ink" }];
    const withSystem = await run("sign_off", signParams(id, { tokensWhenSystem: true }));
    expect(withSystem.ok).toBe(false);
    expect((withSystem.checks as Any[]).map((c) => c.name)).toEqual(["craft", "tokens"]);
    expect((withSystem.issues as Any[]).every((i) => i.kind === "unbound_color")).toBe(true);
    expect((withSystem.checks as Any[])[1]).toMatchObject({ name: "tokens", ok: false, warnings: 2 });
  });

  it("an audit this plugin does not run yet is reported as not run, never as passed", async () => {
    file();
    const a = cleanScreen("Slots");
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id] });
    const asked: AuditName[] = ["craft", "a11y", "library"];
    const s = await run("sign_off", signParams(r.briefId as string, { audits: asked }));
    const unknown = asked.filter((x) => !(AUDITS as readonly string[]).includes(x));
    if (unknown.length) expect(s.notRun).toEqual(unknown);
    else expect(s.notRun).toBeUndefined();
    expect((s.checks as Any[]).map((c) => c.name)).toEqual(asked.filter((x) => !unknown.includes(x)));
  });

  it("names runs once per page, however many deliverables share it", async () => {
    file();
    onPage(mk("COMPONENT", "Button", [0, 500, 100, 40]));
    onPage(mk("COMPONENT", "Button", [200, 500, 100, 40]));
    const a = cleanScreen("Slots");
    const b = cleanScreen("Confirm", 500);
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id, b.id] });
    const s = await run("sign_off", signParams(r.briefId as string, { audits: ["names"] }));
    expect((s.issues as Any[]).filter((i) => i.kind === "duplicate_name")).toHaveLength(1);
    expect(s.checks).toEqual([expect.objectContaining({ name: "names", warnings: 1 })]);
  });

  it("refuses before recording anything when cancelled, or when the brief cannot be read", async () => {
    file();
    const a = cleanScreen("Slots");
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id] });
    const id = r.briefId as string;
    const before = sharedOf(node(id), BRIEF_KEY);
    const e = await refusal(run("sign_off", signParams(id), { isCancelled: () => true }));
    expect(e.code).toBe("CANCELLED");
    expect(e.partial).toEqual({ created: [] });
    expect(sharedOf(a, SIGN_OFF_KEY)).toBe("");
    expect(sharedOf(node(id), BRIEF_KEY)).toBe(before);
    const none = await refusal(run("sign_off", signParams(a.id)));
    expect(none.message).toMatch(/No brief is stored on "Slots"/);
  });

  it("get_brief compares the fingerprint now with the sign-off's: fresh until the work changes", async () => {
    file();
    const a = cleanScreen("Slots");
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id] });
    const s = await run("sign_off", signParams(r.briefId as string));
    const print = (s.fingerprints as Record<string, string>)[a.id];
    const fresh = await run("get_brief", { nodeId: a.id, fingerprint: true });
    expect(fresh).toMatchObject({ fingerprint: print, fresh: true });
    expect((fresh.signOff as Any).ok).toBe(true);
    expect((fresh.brief as BriefRecord).status).toBe("signed");
    // A layer inside reads its deliverable's sign-off, fingerprinted over the deliverable.
    const inner = a.children[0]!;
    expect(await run("get_brief", { nodeId: inner.id, fingerprint: true })).toMatchObject({ fingerprint: print, fresh: true });
    inner.characters = "Book a bench today";
    const stale = await run("get_brief", { nodeId: a.id, fingerprint: true });
    expect(stale.fresh).toBe(false);
    expect(stale.fingerprint).not.toBe(print);
    // No sign-off: a fingerprint, and no verdict.
    const loose = cleanScreen("Loose", 3000);
    const none = await run("get_brief", { nodeId: loose.id, fingerprint: true });
    expect(none.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(none.fresh).toBeUndefined();
  });

  it("reopen puts a signed brief back to open, on the record, the block and the index", async () => {
    file();
    const a = cleanScreen("Slots");
    const r = await newBrief({}, { ...BRIEF, deliverables: [a.id] });
    const id = r.briefId as string;
    await run("sign_off", signParams(id));
    expect(recordOn(node(id)).status).toBe("signed");
    const o = await run("set_brief", { briefId: id, reopen: true });
    expect(o.status).toBe("open");
    expect(recordOn(node(id)).status).toBe("open");
    expect(statusText(id)).toBe("Status: open — not signed off");
    expect(rootIndex()[0]!.status).toBe("open");
  });
});

// ── sign_off on a motion brief (found live, 2026-10-20) ─────────────────────
// Frame 4:262 passed figma_check_motion and two cold reviews, and sign-off
// still returned 72 blockers: craft judged the frame at rest, where its scenes
// stack. A motion brief judges layout where the viewer sees it (roles spec
// §3.6, "Motion: where the viewer sees it").

describe("sign_off on a motion brief: layout where the viewer sees it", () => {
  const MOTION_BRIEF = {
    role: "motion",
    gear: "piece",
    title: "Gear piece",
    lines: { goal: "people remember the gear", message: "Every gear turns for you.", success: ["the tag reads for 2 s"], safeArea: SAFE_AREA },
    details: { placement: "feed", durationS: 6, fps: 30 },
  };
  // What the server sends for motion: craft, with its infos answered (roles.ts MOTION).
  const motionParams = (briefId: string) => signParams(briefId, { audits: ["craft"], answerKinds: ["craft"] });
  const NOT_JUDGED = { clipped: 2, covered: 4, overlap: 2, safe_area: 1, sibling_overlap: 5, stroke_crosses_text: 1 };

  it("a multi-scene piece passes, and its result and record say what was left to the frames", async () => {
    file();
    const p = onPage(gearPiece(mk).root);
    const r = await newBrief({}, { ...MOTION_BRIEF, deliverables: [p.id] });
    const s = await run("sign_off", motionParams(r.briefId as string));
    expect(s).toMatchObject({ ok: true, issues: [], unanswered: [], briefStatus: "signed" });
    expect(s.restPose).toEqual({
      deliverables: [{ nodeId: p.id, name: "Gear piece", moved: GEAR_PIECE_MOVED, notJudged: NOT_JUDGED }],
      note: expect.stringMatching(/^Under a motion brief layout is judged where the viewer sees it: 20 layers here move with keys, and 15 findings .* were not made\./),
    });
    const parsed = parseSignOff(sharedOf(p, SIGN_OFF_KEY));
    if (!("signOff" in parsed)) throw new Error(parsed.invalid);
    expect(parsed.signOff).toMatchObject({ ok: true, role: "motion", restPose: { moved: GEAR_PIECE_MOVED, notJudged: NOT_JUDGED } });
  });

  it("the same piece under a still role's brief is judged at rest, and fails", async () => {
    file();
    const p = onPage(gearPiece(mk).root);
    const r = await newBrief({}, { ...MOTION_BRIEF, role: "graphic", gear: "section", details: { medium: "social", viewing: "a feed" }, deliverables: [p.id] });
    const s = await run("sign_off", signParams(r.briefId as string, { answerKinds: ["craft"] }));
    expect(s.ok).toBe(false);
    expect([...new Set((s.issues as Any[]).map((i) => i.kind))].sort()).toEqual(["clipped", "covered", "overlap", "safe_area", "stroke_crosses_text"]);
    expect(s.restPose).toBeUndefined();
  });

  it("a defect inside one scene still fails a motion sign-off", async () => {
    file();
    const piece = gearPiece(mk);
    // A second line run into scene B's title: the two move together, so they overlap in every frame.
    const clash = text("B clash", [80, 380, 560, 60], "Run into the title", 48, "#FFFFFF");
    clash.parent = piece.sceneB;
    piece.sceneB.children.push(clash);
    const p = onPage(piece.root);
    const r = await newBrief({}, { ...MOTION_BRIEF, deliverables: [p.id] });
    const s = await run("sign_off", motionParams(r.briefId as string));
    expect(s.ok).toBe(false);
    expect((s.issues as Any[]).map((i) => [i.kind, i.name])).toEqual([["overlap", "B title"]]);
  });
});

describe("the tables behind sign-off", () => {
  it("files every kind the existing audits emit under its audit", () => {
    expect([...AUDIT_KINDS.craft].sort()).toEqual(Object.keys(CRAFT_SEVERITY).sort());
    const tells = readFileSync(new URL("../src/plugin/tells.ts", import.meta.url), "utf8");
    const emitted = new Set([...tells.matchAll(/push\(\s*[^,()]+,\s*"([a-z_]+)"/g)].map((m) => m[1]!));
    expect(emitted.size).toBeGreaterThan(10);
    expect([...emitted].filter((k) => !AUDIT_KINDS.tells.includes(k))).toEqual([]);
    const check = readFileSync(new URL("../src/plugin/ops/check.ts", import.meta.url), "utf8");
    for (const k of [...AUDIT_KINDS.tokens, ...AUDIT_KINDS.names, ...AUDIT_KINDS.fonts, ...AUDIT_KINDS.board]) expect(check, k).toContain(`"${k}"`);
  });

  it("the block's lines leave out what a brief does not have", () => {
    const rec = { v: 1, id: "1:1", role: "graphic", gear: "section", title: "t", status: "open", createdAt: "", updatedAt: "", lines: { goal: "g", message: "m", success: [] }, details: {}, deliverables: [] } as BriefRecord;
    expect(blockLines(rec).map((l) => l.name)).toEqual(["Role · gear", "Message", "Goal", "Status"]);
  });

  it("the three ops are in the plugin's op table with their write flags", () => {
    expect([PLUGIN_OPS.set_brief?.write, PLUGIN_OPS.get_brief?.write, PLUGIN_OPS.sign_off?.write]).toEqual([true, false, true]);
  });

  it("a batch never runs set_brief or sign_off: the server checks them on their own call", () => {
    for (const op of ["set_brief", "sign_off"]) {
      const why = notBatchable(op);
      expect(why, op).not.toBeNull();
      // Once the catalog lists them (a style op), the reason is the server's checks.
      if (OPS.has(op)) expect(why).toMatch(/checked by the server and runs on its own call/);
    }
  });
});
