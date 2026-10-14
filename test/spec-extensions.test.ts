// figma_create_from_spec beyond Figma Design: registered spec types (the seam
// the FigJam node types plug into, spec-types.ts), `ref`, deferred types built
// last, a section's `arrange` / `hug`, array roots, text `list`, per-editor
// refusals, and the top-down build into a slide that keeps x/y where the spec
// put them [C-146] — while the Design build order stays exactly as it was.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import { registerSpecType, unregisterSpecType, type SpecTypeHandler } from "../src/plugin/spec-types.js";
import { FakeSection, installFigma, opContext, type FakeNode } from "./editor-fakes.js";
import { WFrame, WRect, WText, WriteFigma } from "./write-fakes.js";

type Result = {
  rootId: string;
  rootIds?: string[];
  created: Array<{ id: string; name: string; path: string }>;
  nodeCount: number;
  refs?: Record<string, string>;
  drift?: Array<{ id: string; path: string; dx: number; dy: number }>;
};

let fake: WriteFigma;
let restore: (() => void) | undefined;
const registered: string[] = [];

function world(editorType = "figma"): WriteFigma {
  fake = new WriteFigma({ editorType });
  restore = installFigma(fake);
  return fake;
}
afterEach(() => {
  restore?.();
  restore = undefined;
  for (const t of registered.splice(0)) unregisterSpecType(t);
});

const build = (params: Record<string, unknown>) => CREATE_OPS.create_from_spec!.run(opContext(params)) as Promise<Result>;
async function refused(params: Record<string, unknown>): Promise<BridgeError> {
  try {
    await build(params);
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected create_from_spec to be refused");
}
const node = <T = FakeNode>(id: string) => fake.nodes.get(id) as unknown as T;
const made = () => fake.log.filter((l) => l.startsWith("create "));

// ── a registered type ──────────────────────────────────────────────────────

/** A leaf that builds a rectangle the way the contract says: record, append, write, place. */
function probe(editors: SpecTypeHandler["editors"] = ["figma", "figjam", "slides"], seen?: { refs?: ReadonlySet<string>; editor?: string }): SpecTypeHandler {
  return {
    fields: ["x", "y", "height", "label"],
    container: false,
    editors,
    validate(n, path, check) {
      if (seen) {
        seen.refs = check.refs;
        seen.editor = check.editor;
      }
      if (n.label !== undefined && typeof n.label !== "string") check.refuse(path, `\`${path}.label\` must be text.`);
    },
    async build(n, parent, b) {
      const r = b.record((globalThis as unknown as { figma: WriteFigma }).figma.createRectangle());
      b.append(parent, r);
      (r as unknown as WRect).resize(100, typeof n.height === "number" ? n.height : 50);
      b.place(r, n.x as number | undefined, n.y as number | undefined);
      return r;
    },
  };
}

/** A deferred type, like a connector: built after the tree, ends resolved by ref. */
function link(order: string[]): SpecTypeHandler {
  return {
    fields: ["from", "to"],
    container: false,
    editors: ["figma", "figjam", "slides"],
    deferred: true,
    validate(n, path, check) {
      for (const end of ["from", "to"] as const) {
        if (typeof n[end] !== "string" || !check.refs.has(n[end] as string)) check.refuse(path, `\`${path}.${end}\` must name a ref of this spec.`);
      }
    },
    async build(n, parent, b) {
      const from = await b.resolveRef(n.from as string);
      const to = await b.resolveRef(n.to as string);
      order.push(`link ${from.id}->${to.id} in ${parent.id}`);
      const line = b.record((globalThis as unknown as { figma: WriteFigma }).figma.createLine());
      b.append(parent, line);
      return line;
    },
  };
}

function register(type: string, handler: SpecTypeHandler): void {
  registerSpecType(type, handler);
  registered.push(type);
}

describe("registered spec types", () => {
  beforeEach(() => world("figjam"));

  it("build through their handler: recorded, appended once into their real parent, placed, and their name set", async () => {
    register("probe", probe());
    const section = fake.createSection();
    const r = await build({ parentId: section.id, spec: { type: "section", name: "Zone", children: [{ type: "probe", name: "Card", x: 40, y: 60, label: "A" }] } });
    const card = node<WRect>(r.created[1]!.id);
    expect(r.created.map((c) => c.path)).toEqual(["spec", "spec.children[0]"]);
    expect(card.name).toBe("Card");
    expect(card.parent?.id).toBe(r.rootId);
    expect([card.x, card.y]).toEqual([40, 60]);
  });

  it("a stray key is refused with the nearest field, naming its node, before anything exists", async () => {
    register("probe", probe());
    const e = await refused({ spec: { type: "section", children: [{ type: "probe", lable: "A" }] } });
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toMatch(/`spec.children\[0\].lable` is not a field of a probe/);
    expect(e.hint).toMatch(/Did you mean: label/);
    expect(e.partial).toEqual({ created: [], failedAt: "spec.children[0]" });
    expect(made()).toEqual([]);
  });

  it("its validate sees every ref of the call and the editor, and its refusal changes nothing", async () => {
    const seen: { refs?: ReadonlySet<string>; editor?: string } = {};
    register("probe", probe(undefined, seen));
    const e = await refused({ spec: { type: "section", ref: "zone", children: [{ type: "probe", ref: "a", label: 3 }] } });
    expect([...seen.refs!].sort()).toEqual(["a", "zone"]);
    expect(seen.editor).toBe("figjam");
    expect(e.message).toMatch(/label` must be text/);
    expect(e.partial).toEqual({ created: [], failedAt: "spec.children[0]" });
    expect(made()).toEqual([]);
  });

  it("a type for another editor is refused before the first node, as UNSUPPORTED", async () => {
    register("probe", probe(["slides"]));
    const e = await refused({ spec: { type: "section", children: [{ type: "probe" }] } });
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toMatch(/builds in Figma Slides files; this is a FigJam file/);
    expect(e.partial).toEqual({ created: [], failedAt: "spec.children[0]" });
  });

  it("an unknown type names the registered ones too", async () => {
    register("probe", probe());
    const e = await refused({ spec: { type: "sticker" } });
    expect(e.hint).toMatch(/section, polygon.*probe/);
  });
});

describe("ref and deferred types", () => {
  beforeEach(() => world("figjam"));

  it("refs come back as ids, and a deferred type is built last, in the container that declares it", async () => {
    const order: string[] = [];
    register("probe", probe());
    register("link", link(order));
    const r = await build({
      spec: {
        type: "section", ref: "zone",
        children: [{ type: "link", from: "a", to: "b" }, { type: "probe", ref: "a" }, { type: "probe", ref: "b" }],
      },
    });
    expect(Object.keys(r.refs!).sort()).toEqual(["a", "b", "zone"]);
    expect(r.created.map((c) => c.path)).toEqual(["spec", "spec.children[1]", "spec.children[2]", "spec.children[0]"]);
    expect(order).toEqual([`link ${r.refs!.a}->${r.refs!.b} in ${r.refs!.zone}`]);
    expect(node(r.created[3]!.id).parent?.id).toBe(r.refs!.zone);
  });

  it("a ref is a name, declared once in the whole call", async () => {
    const twice = await refused({ parentId: fake.currentPage.id, spec: [{ type: "rectangle", ref: "a", width: 1, height: 1 }, { type: "rectangle", ref: "a", width: 1, height: 1 }] });
    expect(twice.message).toMatch(/"a" is already the ref of spec\[0\]/);
    expect(twice.partial).toEqual({ created: [], failedAt: "spec[1]" });
    const bad = await refused({ spec: { type: "rectangle", ref: "1st", width: 1, height: 1 } });
    expect(bad.message).toMatch(/`spec.ref` must be a name/);
    expect(made()).toEqual([]);
  });

  it("a deferred type cannot be an auto-layout item", async () => {
    register("link", link([]));
    const e = await refused({ spec: { type: "frame", layout: "vertical", ref: "f", children: [{ type: "link", from: "f", to: "f" }] } });
    expect(e.message).toMatch(/cannot sit in an auto-layout/);
    expect(made()).toEqual([]);
  });
});

describe("a section's arrange and hug", () => {
  beforeEach(() => world("figjam"));

  it("grid:3 with mixed heights: rows never overlap, each row as tall as its tallest item", async () => {
    const r = await build({
      spec: {
        type: "section", arrange: "grid:3", gap: 20, padding: "10",
        children: [80, 200, 40, 120, 60].map((h) => ({ type: "rectangle", width: 100, height: h })),
      },
    });
    const boxes = r.created.slice(1).map((c) => node<WRect>(c.id)).map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }));
    expect(boxes.map((b) => [b.x, b.y])).toEqual([[10, 10], [130, 10], [250, 10], [10, 230], [130, 230]]);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i]!, boxes[j]!];
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${i} overlaps ${j}`).toBe(false);
      }
    }
  });

  it("hug fits each section to its children plus padding, inner sections first, through resizeWithoutConstraints [C-141]", async () => {
    const before = fake.createSection.bind(fake);
    fake.createSection = () => Object.assign(before(), { resizeThrows: true });
    const r = await build({
      spec: {
        type: "section", hug: true, padding: "32",
        children: [{ type: "section", x: 40, y: 40, arrange: "row", hug: true, children: [{ type: "rectangle", width: 100, height: 50 }, { type: "rectangle", width: 60, height: 90 }] }],
      },
    });
    const outer = node<FakeSection>(r.rootId);
    const inner = node<FakeSection>(r.created[1]!.id);
    // Inner: 32 + 100 + 64 + 60 + 32 wide, 32 + 90 + 32 tall; outer: 40 + inner + 32.
    expect([inner.width, inner.height]).toEqual([288, 154]);
    expect([outer.width, outer.height]).toEqual([360, 226]);
    expect(inner.resizes.map((x) => x.via)).toEqual(["resizeWithoutConstraints"]);
    expect(outer.resizes.at(-1)).toEqual({ via: "resizeWithoutConstraints", w: 360, h: 226 });
  });

  it("contentsHidden and an empty name are set; gap and padding alone, hug with a size, a bad arrange and x/y under arrange are refused", async () => {
    const r = await build({ spec: { type: "section", name: "", contentsHidden: true } });
    expect(node<FakeSection>(r.rootId).name).toBe("");
    expect(node<FakeSection>(r.rootId).sectionContentsHidden).toBe(true);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ type: "section", gap: 10 }, /`spec.gap` spaces the children `arrange` places/],
      [{ type: "section", padding: "10" }, /`spec.padding` insets what `arrange` or `hug` lays out/],
      [{ type: "section", hug: true, width: 400 }, /`hug` sizes the section from its children/],
      [{ type: "section", arrange: "diagonal" }, /is not an arrangement/],
      [{ type: "section", arrange: "row", children: [{ type: "rectangle", width: 1, height: 1, x: 5 }] }, /arrange` places this node/],
    ];
    for (const [spec, message] of cases) {
      const e = await refused({ spec });
      expect(e.message).toMatch(message);
      expect((e.partial as { created: unknown[] }).created).toEqual([]);
    }
  });
});

describe("array roots and text lists", () => {
  beforeEach(() => world());

  it("an array of roots builds into one parent and returns rootIds; without a parent it is refused", async () => {
    const wrapper = fake.frame();
    const r = await build({ parentId: wrapper.id, spec: JSON.stringify([{ type: "text", content: "Title" }, { type: "rectangle", width: 10, height: 10, x: 0, y: 40 }]) });
    expect(r.rootIds).toHaveLength(2);
    expect(r.rootId).toBe(r.rootIds![0]);
    expect(wrapper.children.map((c) => c.id)).toEqual(r.rootIds);
    const e = await refused({ spec: [{ type: "text", content: "x" }] });
    expect(e.message).toMatch(/array of roots needs `parentId` or `pageId`/);
  });

  it("text `list` makes the whole text one bulleted list; a wrong word is refused first", async () => {
    const r = await build({ spec: { type: "text", content: "One\nTwo\nThree", list: "unordered" } });
    expect(node<WText>(r.rootId).lists).toEqual([[0, 13, "UNORDERED"]]);
    expect((await refused({ spec: { type: "text", content: "x", list: "bullets" } })).message).toMatch(/must be unordered, ordered or none/);
  });
});

describe("per-editor refusals before the first node", () => {
  it("a FigJam file refuses a component — convert_to_component is a \"no\" cell there [C-133]", async () => {
    world("figjam");
    const e = await refused({ spec: { type: "frame", children: [{ type: "component", name: "Card" }] } });
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toMatch(/`spec.children\[0\]` \(component\): figma_convert_to_component does not run in FigJam files/);
    expect(e.partial).toEqual({ created: [], failedAt: "spec.children[0]" });
    expect(made()).toEqual([]);
  });

  it("FigJam text defaults to Inter Medium in Charcoal #1E1E1E [C-156]; Design keeps Inter Regular on black", async () => {
    world("figjam");
    const board = await build({ spec: { type: "text", content: "Note" } });
    const t = node<WText>(board.rootId);
    expect(t.fontName).toEqual({ family: "Inter", style: "Medium" });
    expect(t.fills).toEqual([{ type: "SOLID", color: { r: 0x1e / 255, g: 0x1e / 255, b: 0x1e / 255 } }]);
    restore?.();
    world("figma");
    const design = await build({ spec: { type: "text", content: "Note" } });
    expect(node<WText>(design.rootId).fontName).toEqual({ family: "Inter", style: "Regular" });
    expect(node<WText>(design.rootId).fills).toEqual([{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }]);
  });
});

describe("building into a slide [C-146]", () => {
  beforeEach(() => {
    world("slides");
    fake.slideDrift = true;
  });

  it("the fake reproduces the trap: x set before the append lands 240 px off", () => {
    const slide = fake.slide();
    const f = fake.createFrame();
    f.x = 100;
    slide.appendChild(f);
    expect(f.x).toBe(-140);
  });

  it("is top-down — each node in its real parent before any write — so nested x/y read back exactly: drift []", async () => {
    const slide = fake.slide();
    const r = await build({
      parentId: slide.id,
      spec: {
        type: "frame", name: "Card", x: 120, y: 260, width: 400, height: 200,
        children: [
          { type: "rectangle", name: "Bar", x: 32, y: 32, width: 100, height: 8 },
          { type: "frame", name: "Inner", x: 32, y: 80, width: 200, height: 80, children: [{ type: "text", name: "Label", content: "26.6%", x: 8, y: 8 }] },
          { type: "vector", name: "Wave", path: "M0 0 L10 10", x: 300, y: 20 },
        ],
      },
    });
    expect(r.drift).toEqual([]);
    const at = (name: string) => {
      const c = r.created.find((x) => x.name === name)!;
      const n = node<WFrame>(c.id);
      return [n.x, n.y];
    };
    expect([at("Card"), at("Bar"), at("Inner"), at("Label"), at("Wave")]).toEqual([[120, 260], [32, 32], [32, 80], [8, 8], [300, 20]]);
    // Every node is appended right after it is created, before its first resize or x/y.
    const card = r.rootId;
    expect(fake.log.slice(0, 3)).toEqual([`create FRAME ${card}`, `resize ${card} 400x200`, expect.stringMatching(/^create RECTANGLE/)]);
    expect(node(card).parent?.id).toBe(slide.id);
  });

  it("an array of roots onto a slide reads back without drift too", async () => {
    const slide = fake.slide();
    const r = await build({ parentId: slide.id, spec: [{ type: "text", content: "Title", x: 96, y: 80 }, { type: "rectangle", width: 10, height: 10, x: 96, y: 200 }] });
    expect(r.drift).toEqual([]);
    expect(r.rootIds!.map((id) => [node<WRect>(id).x, node<WRect>(id).y])).toEqual([[96, 80], [96, 200]]);
  });

  it("a root that fills is refused on a slide, which is never an auto-layout parent", async () => {
    const slide = fake.slide();
    const e = await refused({ parentId: slide.id, spec: { type: "frame", layout: "vertical", sizing: { width: "fill" } } });
    expect(e.message).toMatch(/a slide is not an auto-layout parent/);
    expect(e.partial).toEqual({ created: [], failedAt: "spec" });
    expect(made()).toEqual([]);
  });

  it("with no parentId the focused slide is the parent", async () => {
    const slide = fake.slide(true);
    const r = await build({ spec: { type: "rectangle", width: 10, height: 10, x: 5, y: 5 } });
    expect(node(r.rootId).parent?.id).toBe(slide.id);
    expect(r.drift).toEqual([]);
  });
});

describe("Design keeps its build order", () => {
  it("bottom-up exactly as before: children into their parent first, the root attached and placed last", async () => {
    world();
    const wrapper = fake.frame();
    fake.log.length = 0;
    const r = await build({
      parentId: wrapper.id,
      spec: {
        type: "frame", name: "Card", width: 300, height: 200, x: 10, y: 20, background: "#ffffff",
        children: [
          { type: "rectangle", name: "Media", width: 280, height: 120, x: 10, y: 10, fill: "#cccccc" },
          { type: "text", name: "Title", content: "Hello", x: 10, y: 140 },
          { type: "frame", name: "Badge", width: 40, height: 20, x: 250, y: 5, children: [{ type: "ellipse", name: "Dot", width: 8, height: 8, x: 2, y: 2 }] },
        ],
      },
    });
    const names = new Map(r.created.map((c) => [c.id, c.name]));
    names.set(wrapper.id, "Wrapper");
    const log = fake.log.map((l) => l.replace(/90:\d+/g, (id) => names.get(id) ?? id));
    // Captured from the builder before the editor work (the same fake, the same spec).
    expect(log).toEqual([
      "create FRAME Card", "resize Card 300x200",
      "create RECTANGLE Media", "resize Media 280x120", "append Media > Card", "x Media=10", "y Media=10",
      "create TEXT Title", "append Title > Card", "x Title=10", "y Title=140",
      "create FRAME Badge", "resize Badge 40x20",
      "create ELLIPSE Dot", "resize Dot 8x8", "append Dot > Badge", "x Dot=2", "y Dot=2",
      "append Badge > Card", "x Badge=250", "y Badge=5",
      "append Card > Wrapper", "x Card=10", "y Card=20",
    ]);
    expect(r.drift).toBeUndefined();
  });
});
