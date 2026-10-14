// Text inside an auto-layout, and the clipping default.
//
// Two failures found by looking at a screenshot of a generated landing page,
// both of which every assertion had passed:
//
//   1. A subheadline rendered 1427 px wide inside a 1040 px content area, so it
//      ran off the frame and was cut. `createText` leaves `textAutoResize` at
//      WIDTH_AND_HEIGHT, which means "grow forever on one line": a text node in
//      a stack never wraps unless it is told to fill the cross axis.
//   2. `figma.createFrame()` starts with `clipsContent === true`, so every drop
//      shadow and overhanging badge was silently trimmed at the frame edge. The
//      user saw a shadow cut in half and read it as a rendering bug.
//
// Both are asserted here as properties of the node the builder produces, not as
// text in a description, because a default that quietly fights the caller is
// exactly what no test was watching.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import type { OpContext } from "../src/plugin/ops/index.js";

class FakeNode {
  id = `9:${Math.floor(Math.random() * 1e6)}`;
  name: string;
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  width = 100;
  height = 100;
  layoutMode = "NONE";
  layoutAlign = "INHERIT";
  layoutGrow = 0;
  primaryAxisSizingMode = "FIXED";
  counterAxisSizingMode = "FIXED";
  textAutoResize = "WIDTH_AND_HEIGHT";
  // Like the real API: a frame created through the plugin starts CLIPPING.
  clipsContent = true;
  [k: string]: unknown;
  constructor(readonly type: string) {
    this.name = type.charAt(0) + type.slice(1).toLowerCase();
  }
  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  appendChild(child: FakeNode) {
    this.children.push(child);
    child.parent = this;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
    this.parent = null;
  }
  findAll() {
    return [];
  }
}

let page: FakeNode;

function installFakeFigma() {
  page = new FakeNode("PAGE");
  const make = (type: string) => () => {
    const n = new FakeNode(type);
    page.appendChild(n);
    return n;
  };
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    root: new FakeNode("DOCUMENT"),
    createFrame: make("FRAME"),
    createText: make("TEXT"),
    createRectangle: make("RECTANGLE"),
    createEllipse: make("ELLIPSE"),
    createSection: make("SECTION"),
    async loadFontAsync() {},
    async listAvailableFontsAsync() {
      return [];
    },
    async getNodeByIdAsync(id: string) {
      const all: FakeNode[] = [];
      const walk = (n: FakeNode) => n.children.forEach((c) => (all.push(c), walk(c)));
      walk(page);
      return all.find((n) => n.id === id) ?? null;
    },
    commitUndo() {},
  };
}

function ctx(params: Record<string, unknown>): OpContext {
  return { requestId: "r-1", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false };
}

async function build(spec: Record<string, unknown>): Promise<FakeNode> {
  await CREATE_OPS.create_from_spec!.run(ctx({ spec }));
  return page.children[0] as FakeNode;
}

beforeEach(installFakeFigma);
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("text inside an auto-layout wraps", () => {
  it("stretches a text child across the parent's cross axis", async () => {
    // Without this the text stays at its natural single-line width and is
    // clipped by the frame — the 1427-in-1040 case.
    const card = await build({
      type: "frame",
      layout: "vertical",
      width: 240,
      children: [{ type: "text", content: "A sentence that is far longer than the panel is wide." }],
    });
    const text = card.children[0]!;
    expect(text.layoutAlign).toBe("STRETCH");
  });

  it("does not stretch a text child that declared its own width", async () => {
    // An explicit width is a deliberate choice, and that path already sets
    // textAutoResize itself. Stretching it would silently override the caller.
    const card = await build({
      type: "frame",
      layout: "vertical",
      width: 240,
      children: [{ type: "text", content: "fixed", width: 80 }],
    });
    expect(card.children[0]!.layoutAlign).not.toBe("STRETCH");
  });

  it("does NOT stretch a text across a row: there the cross axis is the height", async () => {
    // Measured live: "$9" and "/month" in a hugging price row both filled the
    // row's height (check_layout fill_in_hug), so "/month" sat at the top of the
    // row instead of on the baseline. Stretching across a row wraps nothing.
    const row = await build({
      type: "frame",
      layout: "horizontal",
      width: 400,
      children: [{ type: "text", content: "label" }],
    });
    expect(row.children[0]!.layoutAlign).not.toBe("STRETCH");
  });

  it("leaves text alone when the parent has no auto-layout", async () => {
    // `layoutAlign` on a plain frame throws in the real API, so it must not be
    // set there; a positioned frame is not a stack.
    const plain = await build({
      type: "frame",
      width: 400,
      height: 300,
      children: [{ type: "text", content: "free floating", x: 10, y: 10 }],
    });
    expect(plain.children[0]!.layoutAlign).toBe("INHERIT");
  });

  it("does not stretch a non-text child", async () => {
    const card = await build({
      type: "frame",
      layout: "vertical",
      width: 240,
      children: [{ type: "rectangle", width: 40, height: 40 }],
    });
    expect(card.children[0]!.layoutAlign).toBe("INHERIT");
  });

  it("grows a child that asked to fill along the parent's axis", async () => {
    // The vertical stack whose body should absorb the leftover height. STRETCH
    // cannot express this: it only works across the axis, so the primary axis
    // needs layoutGrow.
    const card = await build({
      type: "frame",
      layout: "vertical",
      width: 240,
      height: 400,
      children: [
        { type: "text", content: "header" },
        { type: "frame", name: "Body", sizing: "fill" },
      ],
    });
    const body = card.children.find((c) => c.name === "Body")!;
    expect(body.layoutGrow).toBe(1);
  });

  it("fills only the axis the per-axis form names", async () => {
    // `{ width: "fill" }` in a HORIZONTAL row is the primary axis → layoutGrow,
    // and it must NOT also stretch the cross axis.
    const row = await build({
      type: "frame",
      layout: "horizontal",
      width: 400,
      children: [
        { type: "frame", name: "Fixed", width: 80, height: 20 },
        { type: "frame", name: "Grower", width: 80, height: 20, sizing: { width: "fill" } },
      ],
    });
    const grower = row.children.find((c) => c.name === "Grower")!;
    expect(grower.layoutGrow).toBe(1);
    expect(grower.layoutAlign).not.toBe("STRETCH");
  });

  it("maps a counter-axis fill to STRETCH, not layoutGrow", async () => {
    // In a HORIZONTAL row, `height: fill` is across the axis.
    const row = await build({
      type: "frame",
      layout: "horizontal",
      width: 400,
      children: [{ type: "frame", name: "Tall", width: 80, height: 20, sizing: { height: "fill" } }],
    });
    const tall = row.children.find((c) => c.name === "Tall")!;
    expect(tall.layoutAlign).toBe("STRETCH");
    expect(tall.layoutGrow).toBe(0);
  });
});

describe("clipping is opt-in", () => {
  it("turns clipsContent off, because it starts on and cuts shadows", async () => {
    const card = await build({ type: "frame", width: 200, height: 100 });
    expect(card.clipsContent).toBe(false);
  });

  it("keeps clipping when the spec explicitly asks for it", async () => {
    const card = await build({ type: "frame", width: 200, height: 100, clipsContent: true });
    expect(card.clipsContent).toBe(true);
  });

  it("applies the same default to nested frames", async () => {
    // The stat cards are nested frames with shadows; a nested default of `true`
    // would cut them exactly the same way.
    const outer = await build({
      type: "frame",
      layout: "vertical",
      children: [{ type: "frame", name: "Inner", width: 100, height: 40 }],
    });
    expect(outer.children[0]!.clipsContent).toBe(false);
  });
});
