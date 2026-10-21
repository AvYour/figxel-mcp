// figma_stress_test in the plugin (trust spec §3): each case's transformation
// on its own, the IBM expansion bands [C-396], and the op end to end on a fake
// page whose geometry follows the content — a text that hugs grows with its
// characters, a vertical auto-layout stacks its items — so checkLayout finds
// what each case breaks, and the baseline diff maps it back by layer path.

import { afterEach, describe, expect, it } from "vitest";
import type { OpContext } from "../src/plugin/ops/index.js";
import {
  CASES, COMPOUND_LENGTH, EXPANSION, LIST_MIN, MANY_FACTOR, NUMBERS, STRESS_OPS, accent, compound, expandText, expansionFactor,
  largeNumbers, longText, pathOf,
} from "../src/plugin/stress.js";

// ── the transformations ─────────────────────────────────────────────────────

describe("expand: translation growth by the top of each IBM band [C-396]", () => {
  it("300 % up to 10 characters, 200 % to 20, 180 % to 30, 160 % to 50, 150 % to 70, 130 % beyond", () => {
    const at = (n: number) => expansionFactor(n);
    expect([1, 10, 11, 20, 21, 30, 31, 50, 51, 70, 71, 500].map(at)).toEqual([3, 3, 2, 2, 1.8, 1.8, 1.6, 1.6, 1.5, 1.5, 1.3, 1.3]);
    expect(EXPANSION.map((b) => b.factor)).toEqual([3, 2, 1.8, 1.6, 1.5, 1.3]);
  });

  it("the text at its translated length, accented and bracketed so it reads as a test", () => {
    expect(expandText("Send now")).toBe("[Ŝéñð ñöŵ Ŝéñð ñöŵ Ŝéñð]");
    expect(expandText("Send now")).toHaveLength(24);
    for (const len of [1, 7, 10, 15, 25, 40, 60, 90]) {
      const s = "word ".repeat(30).slice(0, len);
      const out = expandText(s);
      expect(out, `length ${len}`).toHaveLength(Math.ceil(len * expansionFactor(len)));
      expect(out.startsWith("[") && out.endsWith("]")).toBe(true);
    }
    expect(accent("Hello, World 42")).toBe("Ĥéļļö, Ŵöŕļð 42");
    expect(expandText("")).toBe("");
    expect(expandText("   ")).toBe("   ");
  });
});

describe("long, numbers", () => {
  it("long: several words doubled in words, one word a 24-character compound, no word left alone", () => {
    expect(longText("Send now")).toBe("Send now Send now");
    expect(longText("Pricing")).toBe("Pricingpricingpricingpri");
    expect(compound("Pricing")).toHaveLength(COMPOUND_LENGTH);
    expect(longText("Supercalifragilisticexpialidocious")).toBe("Supercalifragilisticexpialidocious");
    expect(longText("$9.99")).toBe("$9.99");
    expect(longText("2026-10-19")).toBe("2026-10-19");
    expect(longText("")).toBe("");
  });

  it("numbers: every run of digits a large value of the same form", () => {
    expect(largeNumbers("9")).toBe(NUMBERS.integer);
    expect(largeNumbers("$9.99")).toBe("$12,345.99");
    expect(largeNumbers("3%")).toBe("100%");
    expect(largeNumbers("12.5 %")).toBe("100.0 %");
    expect(largeNumbers("Step 2 of 3")).toBe("Step 12,345 of 12,345");
    expect(largeNumbers("1,234,567 views")).toBe("1,234,567,000 views");
    expect(largeNumbers("No digits")).toBe("No digits");
  });
});

// ── a page whose geometry follows the content ───────────────────────────────

type Font = { family: string; style: string };
const MISSING = "Missing Sans";

class World {
  seq = 0;
  readonly nodes = new Map<string, FNode>();
  readonly loaded = new Set<string>();
  page: FNode;
  failInsert = false;
  readonly figma: Record<string, unknown>;
  constructor() {
    this.page = new FNode(this, "PAGE", "Page 1");
    (this.page as unknown as { selection: FNode[] }).selection = [];
    this.figma = {
      editorType: "figma",
      currentPage: this.page,
      root: { name: "Stress", children: [this.page] },
      getNodeByIdAsync: async (id: string) => this.nodes.get(id) ?? null,
      loadFontAsync: async (f: Font) => {
        if (f.family === MISSING) throw new Error(`The font "${f.family} ${f.style}" could not be loaded`);
        this.loaded.add(`${f.family} ${f.style}`);
      },
    };
  }
}

class FNode {
  readonly id: string;
  parent: FNode | null = null;
  children: FNode[] = [];
  x = 0;
  y = 0;
  w = 100;
  h = 100;
  visible = true;
  removed = false;
  layoutMode = "NONE";
  itemSpacing = 0;
  clipsContent = false;
  fills: unknown[] = [];
  main: string | undefined;
  constructor(
    readonly world: World,
    readonly type: string,
    public name: string,
  ) {
    this.id = `${type === "PAGE" ? 0 : 10}:${++world.seq}`;
    world.nodes.set(this.id, this);
  }
  get width(): number {
    return this.w;
  }
  get height(): number {
    return this.h;
  }
  /** Where the parent puts it: a vertical auto-layout stacks its children; anything else keeps x/y. */
  get absoluteBoundingBox(): { x: number; y: number; width: number; height: number } {
    const p = this.parent;
    const base: { x: number; y: number } = p && p.type !== "PAGE" ? p.absoluteBoundingBox : { x: 0, y: 0 };
    let dx = this.x;
    let dy = this.y;
    if (p && p.layoutMode === "VERTICAL") {
      dx = 0;
      dy = 0;
      for (const s of p.children) {
        if (s === this) break;
        dy += s.height + p.itemSpacing;
      }
    }
    return { x: base.x + dx, y: base.y + dy, width: this.width, height: this.height };
  }
  appendChild(c: FNode): void {
    this.insertChild(this.children.length, c);
  }
  insertChild(i: number, c: FNode): void {
    if (this.world.failInsert && this.type !== "PAGE") throw new Error("Figma refused the insert");
    if (c.parent) c.parent.children = c.parent.children.filter((k) => k !== c);
    c.parent = this;
    this.children.splice(i, 0, c);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this);
    this.parent = null;
    this.removed = true;
    for (const n of [this, ...descendants(this)]) this.world.nodes.delete(n.id);
  }
  async getMainComponentAsync() {
    return this.main ? { id: this.main } : null;
  }
  /** A deep copy with new ids, parented under the current page as Figma does. */
  clone(): FNode {
    const copy = this.copy();
    this.world.page.appendChild(copy);
    return copy;
  }
  protected copy(): FNode {
    const c = new (this.constructor as new (w: World, t: string, n: string) => FNode)(this.world, this.type, this.name);
    for (const k of ["x", "y", "w", "h", "visible", "layoutMode", "itemSpacing", "clipsContent", "fills", "main"] as const) {
      (c as unknown as Record<string, unknown>)[k] = this[k];
    }
    if (this instanceof FText) Object.assign(c, { chars: this.chars, font: this.font, textAutoResize: this.textAutoResize });
    for (const k of this.children) {
      const kc = k.copy();
      kc.parent = c;
      c.children.push(kc);
    }
    return c;
  }
}

class FText extends FNode {
  chars = "";
  font: Font = { family: "Inter", style: "Regular" };
  textAutoResize = "WIDTH_AND_HEIGHT";
  fontSize = 16;
  get fontName(): Font {
    return this.font;
  }
  get characters(): string {
    return this.chars;
  }
  set characters(v: string) {
    if (!this.world.loaded.has(`${this.font.family} ${this.font.style}`)) throw new Error("unloaded font");
    this.chars = v;
  }
  override get width(): number {
    return this.textAutoResize === "WIDTH_AND_HEIGHT" ? 8 * this.chars.length : this.w;
  }
  override get height(): number {
    return 20;
  }
  getRangeAllFontNames(): Font[] {
    return [this.font];
  }
}

function descendants(n: FNode): FNode[] {
  return n.children.flatMap((k) => [k, ...descendants(k)]);
}

function frame(w: World, parent: FNode, name: string, box: [number, number, number, number], props: Partial<FNode> = {}): FNode {
  const f = Object.assign(new FNode(w, "FRAME", name), { x: box[0], y: box[1], w: box[2], h: box[3] }, props);
  parent.appendChild(f);
  return f;
}
function text(w: World, parent: FNode, name: string, at: [number, number], chars: string, font?: Font): FText {
  const t = Object.assign(new FText(w, "TEXT", name), { x: at[0], y: at[1], chars });
  if (font) t.font = font;
  parent.appendChild(t);
  return t;
}

/**
 * A card: a button, a price, a heading, a row of two texts side by side, a tag
 * already too narrow for its caption, a note in a font that will not load, and
 * a list of three instances of one component in a fixed, clipping auto-layout.
 */
function cardPage() {
  const w = new World();
  const card = frame(w, w.page, "Card", [0, 0, 400, 900], { fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] });
  const button = frame(w, card, "Button", [20, 20, 100, 40]);
  const label = text(w, button, "Label", [5, 10], "Send now");
  const price = frame(w, card, "Price", [20, 80, 60, 30]);
  text(w, price, "Amount", [0, 5], "$9.99");
  const heading = frame(w, card, "Heading", [20, 130, 120, 30]);
  text(w, heading, "Title", [0, 5], "Pricing");
  const row = frame(w, card, "Row", [20, 180, 360, 30]);
  text(w, row, "Left", [0, 5], "Send now");
  const right = text(w, row, "Right", [150, 5], "Go");
  const tag = frame(w, card, "Tag", [20, 230, 50, 30]);
  text(w, tag, "Caption", [0, 5], "Already far too long");
  const note = text(w, card, "Note", [20, 280], "Fine print", { family: MISSING, style: "Regular" });
  const list = frame(w, card, "List", [20, 330, 260, 300], { layoutMode: "VERTICAL", itemSpacing: 10, clipsContent: true });
  for (let i = 0; i < 3; i++) Object.assign(frame(w, list, "Item", [0, 0, 260, 80]), { type: "INSTANCE", main: "C:1" } as Partial<FNode>);
  frame(w, list, "Footer", [0, 0, 260, 10]); // not an instance: never one of the items
  (globalThis as { figma?: unknown }).figma = w.figma;
  return { w, card, button, label, list, note, right };
}

afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

type Result = {
  baseline: { ok: boolean; counts: Record<string, number> };
  cases: Array<{ case: string; broke: Array<{ kind: string; severity: string; path: string; detail: string }>; ok: boolean; changed: number; note?: string }>;
  kept?: string[];
  skipped?: Array<{ nodeId: string; path: string; fonts: string[] }>;
  note?: string;
};

function ctx(params: Record<string, unknown>, touched: string[] = []): OpContext {
  return {
    requestId: "r",
    params,
    yieldToHost: async () => {},
    progress: () => {},
    isCancelled: () => false,
    touched: (ids) => void touched.push(...ids),
  };
}
const run = (params: Record<string, unknown>, touched?: string[]) => STRESS_OPS.stress_test!.run(ctx(params, touched)) as Promise<Result>;
const caseOf = (r: Result, name: string) => r.cases.find((c) => c.case === name)!;
const where = (r: Result, name: string) => caseOf(r, name).broke.map((b) => `${b.kind} @ ${b.path}`);

describe("the stress test op", () => {
  it("is a write with one undo step (the dispatcher's), and runs every case by default", async () => {
    expect(STRESS_OPS.stress_test!.write).toBe(true);
    const { card } = cardPage();
    const r = await run({ nodeId: card.id });
    expect(r.cases.map((c) => c.case)).toEqual([...CASES]);
  });

  it("each case reports what it broke, by the original's layer path; the baseline's own findings are not repeated", async () => {
    const { card } = cardPage();
    const r = await run({ nodeId: card.id });
    expect(r.baseline.ok).toBe(false); // the caption already overflows its tag
    expect(where(r, "expand")).toEqual(expect.arrayContaining([
      "text_overflow @ Card / Button / Label", "text_overflow @ Card / Price / Amount", "text_overflow @ Card / Heading / Title",
    ]));
    expect(where(r, "long")).toEqual(expect.arrayContaining(["text_overflow @ Card / Button / Label", "text_overflow @ Card / Heading / Title"]));
    expect(where(r, "long")).not.toContain("text_overflow @ Card / Price / Amount"); // a price has no word to lengthen
    expect(where(r, "numbers")).toContain("text_overflow @ Card / Price / Amount");
    expect(where(r, "numbers")).not.toContain("text_overflow @ Card / Button / Label");
    expect(where(r, "many")).toContain("clipped @ Card / List / Item");
    for (const c of r.cases) expect(where(r, c.case)).not.toContain("text_overflow @ Card / Tag / Caption");
    expect(caseOf(r, "expand").ok).toBe(false);
    expect(caseOf(r, "many").broke.find((b) => b.kind === "clipped")!.severity).toBe("warning");
  });

  it("a finding's detail names the original's layers, never the copy's", async () => {
    const { card, right } = cardPage();
    const r = await run({ nodeId: card.id, cases: ["expand"] });
    const overlap = caseOf(r, "expand").broke.find((b) => b.kind === "overlap")!;
    expect(overlap.path).toBe("Card / Row / Left");
    expect(overlap.detail).toContain(`"Right" (${right.id})`);
    for (const b of caseOf(r, "expand").broke) expect(b.detail).not.toMatch(/stress:/);
  });

  it("many: a list of three or more instances of one component gets three times as many; empty: none, the rest stays", async () => {
    const { card, w } = cardPage();
    const counts: Record<string, number> = {};
    const ids: string[] = [];
    const r = await run({ nodeId: card.id, cases: ["many", "empty"], keep: true }, ids);
    for (const id of r.kept!) {
      const copy = w.nodes.get(id)!;
      const list = copy.children.find((k) => k.name === "List")!;
      counts[copy.name] = list.children.filter((k) => k.type === "INSTANCE").length;
      expect(list.children.some((k) => k.name === "Footer"), copy.name).toBe(true);
      expect(copy.children.some((k) => k.name === "Note"), copy.name).toBe(true);
    }
    expect(counts).toEqual({ "Card · stress: many": LIST_MIN * MANY_FACTOR, "Card · stress: empty": 0 });
    expect(caseOf(r, "many").changed).toBe(1);
    // A copy a case made is the agent's: its own and its new items' ids reached ctx.touched.
    const manyList = w.nodes.get(r.kept![0]!)!.children.find((k) => k.name === "List")!;
    for (const item of manyList.children) expect(ids).toContain(item.id);
  });

  it("a case with nothing to act on says so instead of passing silently", async () => {
    const { card, list } = cardPage();
    list.children.slice(1).forEach((k) => k.type === "INSTANCE" && k.remove());
    const r = await run({ nodeId: card.id, cases: ["many"] });
    expect(caseOf(r, "many")).toMatchObject({ changed: 0, ok: true, broke: [], note: expect.stringMatching(/^No auto-layout list of 3 or more instances/) });
  });

  it("copies are deleted unless keep; with keep they stay, beside the original, named, and selected", async () => {
    {
      const { card, w } = cardPage();
      const before = w.page.children.length;
      const touched: string[] = [];
      const r = await run({ nodeId: card.id }, touched);
      expect(r.kept).toBeUndefined();
      expect(w.page.children.length).toBe(before);
      expect(touched.length).toBeGreaterThan(CASES.length); // every copy's layers, for the change attribution
    }
    {
      const { card, w } = cardPage();
      const r = await run({ nodeId: card.id, cases: ["expand", "numbers"], keep: true });
      expect(r.kept).toHaveLength(2);
      const copies = r.kept!.map((id) => w.nodes.get(id)!);
      expect(copies.map((c) => c.name)).toEqual(["Card · stress: expand", "Card · stress: numbers"]);
      for (const c of copies) {
        expect(c.parent).toBe(w.page);
        expect(c.absoluteBoundingBox.x).toBeGreaterThanOrEqual(card.absoluteBoundingBox.x + card.width); // an empty spot, to the right
      }
      expect(copies[1]!.x).toBeGreaterThan(copies[0]!.x);
      expect((w.page as unknown as { selection: FNode[] }).selection).toEqual(copies);
      // The original is never touched.
      expect(card.children.find((k) => k.name === "Button")!.children[0]).toMatchObject({ chars: "Send now" });
    }
  });

  it("fonts are loaded once per run; a text whose font is missing is skipped in every copy and listed", async () => {
    const { card, note, w } = cardPage();
    const r = await run({ nodeId: card.id, cases: ["expand", "long"], keep: true });
    expect(r.skipped).toEqual([{ nodeId: note.id, path: "Card / Note", fonts: [`${MISSING} Regular`] }]);
    for (const id of r.kept!) expect(w.nodes.get(id)!.children.find((k) => k.name === "Note")).toMatchObject({ chars: "Fine print" });
  });

  it("`names` is never run (every copy repeats every name); bad params are refused before any copy exists", async () => {
    const { card, w } = cardPage();
    const r = await run({ nodeId: card.id, cases: ["numbers"], audits: ["names"] });
    expect(r.note).toMatch(/`names` was not run/);
    const before = w.page.children.length;
    for (const params of [{}, { nodeId: card.id, cases: ["rtl"] }, { nodeId: card.id, cases: [] }, { nodeId: card.id, audits: ["vibes"] }, { nodeId: card.id, keep: "yes" }, { nodeId: "404:1" }, { nodeId: w.page.id }]) {
      await expect(run(params), JSON.stringify(params)).rejects.toMatchObject({ partial: { created: [] } });
    }
    expect(w.page.children.length).toBe(before);
  });

  it("a failure mid-run takes its copies away again and says the original is unchanged", async () => {
    const { card, w } = cardPage();
    const before = w.page.children.length;
    w.failInsert = true; // the many case cannot insert its items
    type Failure = { message: string; hint: string; partial: { created: string[]; cases: unknown[] } };
    const err = (await run({ nodeId: card.id, cases: ["expand", "many"] }).then(
      () => { throw new Error("expected a failure"); },
      (e: unknown) => e,
    )) as Failure;
    expect(err.message).toMatch(/^The stress test stopped: /);
    expect(err.hint).toMatch(/Its copies were removed again; the original is unchanged/);
    expect(err.partial.created).toEqual([]);
    expect(err.partial.cases).toHaveLength(1); // expand finished before
    expect(w.page.children.length).toBe(before);
  });

  it("pathOf names the frame as the original is named", () => {
    const { card, label } = cardPage();
    expect(pathOf(label as never, card as never, "Card")).toBe("Card / Button / Label");
    expect(pathOf(card as never, card as never, "Card")).toBe("Card");
  });
});
