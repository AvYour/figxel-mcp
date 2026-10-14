// Auto-layout sizing, per axis.
//
// This file exists because of a bug a screenshot caught and no assertion did: a
// chip row described as `{ height: 28, layout: "horizontal", gap: 8 }` rendered
// 100 wide with its second chip clipped.
//
// The cause was an all-or-nothing rule — `sizing ?? (hasExplicitSize ? "fixed"
// : "hug")` — which decided both axes from one word. Giving a height therefore
// also pinned the width, and the width it pinned was a hard-coded 100.
//
// What a caller means by `height: 28` is a fixed height and a width that fits
// the content. Each case below names the live situation it came from, so the
// reasoning survives the code.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import type { OpContext } from "../src/plugin/ops/index.js";

class FakeNode {
  id = `9:${Math.floor(Math.random() * 1e6)}`;
  name: string;
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  layoutMode = "NONE";
  itemSpacing = 0;
  paddingTop = 0;
  paddingRight = 0;
  paddingBottom = 0;
  paddingLeft = 0;
  primaryAxisSizingMode = "FIXED";
  counterAxisSizingMode = "FIXED";
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

/** Build one frame from a spec and return the frame that was created. */
async function build(spec: Record<string, unknown>): Promise<FakeNode> {
  await CREATE_OPS.create_from_spec!.run(ctx({ spec }));
  return page.children[0] as FakeNode;
}

beforeEach(installFakeFigma);
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("auto-layout sizing per axis", () => {
  it("hugs both axes when neither is pinned", async () => {
    const f = await build({ type: "frame", layout: "horizontal", gap: 8 });
    expect(f.primaryAxisSizingMode).toBe("AUTO");
    expect(f.counterAxisSizingMode).toBe("AUTO");
  });

  it("pins only the axis that was given a number — the live chip-row case", async () => {
    // `{ height: 28, layout: "horizontal" }` is a row of fixed height whose width
    // follows its content. Treating the width as pinned too is what clipped the
    // second chip.
    const f = await build({ type: "frame", layout: "horizontal", gap: 8, height: 28 });
    expect(f.counterAxisSizingMode).toBe("FIXED"); // height pinned
    expect(f.primaryAxisSizingMode).toBe("AUTO"); // width hugs
  });

  it("pins the width and hugs the height when only a width is given", async () => {
    const f = await build({ type: "frame", layout: "horizontal", width: 200 });
    expect(f.primaryAxisSizingMode).toBe("FIXED");
    expect(f.counterAxisSizingMode).toBe("AUTO");
  });

  it("pins both when both are given", async () => {
    const f = await build({ type: "frame", layout: "vertical", width: 320, height: 180 });
    expect(f.primaryAxisSizingMode).toBe("FIXED");
    expect(f.counterAxisSizingMode).toBe("FIXED");
  });

  it("does not leave a large placeholder on the axis that will hug", async () => {
    // The 100-wide placeholder WAS the frame's width for the moment before
    // auto-layout took over, which is what clipped the chip. A small stand-in
    // cannot hide content the hug reveals a frame later.
    const f = await build({ type: "frame", layout: "horizontal", gap: 8, height: 28 });
    expect(f.width).toBeLessThan(28);
  });

  it("swaps the axes for a vertical layout", async () => {
    const f = await build({ type: "frame", layout: "vertical", gap: 12, height: 200 });
    // primary = vertical = height = pinned; counter = width = hugs
    expect(f.primaryAxisSizingMode).toBe("FIXED");
    expect(f.counterAxisSizingMode).toBe("AUTO");
  });

  it("lets a per-axis sizing object pin an axis that has no number", async () => {
    const f = await build({ type: "frame", layout: "horizontal", height: 28, sizing: { width: "fixed" } });
    expect(f.primaryAxisSizingMode).toBe("FIXED");
    expect(f.counterAxisSizingMode).toBe("FIXED");
  });

  it("lets a per-axis sizing object ask for a hug on a pinned axis", async () => {
    const f = await build({ type: "frame", layout: "horizontal", width: 200, sizing: { width: "hug" } });
    expect(f.primaryAxisSizingMode).toBe("AUTO");
  });

  it("still honours the one-word `sizing: \"hug\"` over both numbers", async () => {
    const f = await build({ type: "frame", layout: "vertical", width: 300, height: 100, sizing: "hug" });
    expect(f.primaryAxisSizingMode).toBe("AUTO");
    expect(f.counterAxisSizingMode).toBe("AUTO");
  });

  it("leaves a plain frame's size alone", async () => {
    // `layout` absent means a normal frame, not an auto-layout: the sizing modes
    // are meaningless there and must not be nudged.
    const f = await build({ type: "frame", width: 400, height: 300 });
    expect(f.width).toBe(400);
    expect(f.height).toBe(300);
  });
});
