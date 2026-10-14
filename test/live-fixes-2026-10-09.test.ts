// Defects the live spikes of the parity pass found on the real canvas, each
// pinned by a fake that behaves the way Figma was measured to behave.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import type { OpContext } from "../src/plugin/ops/index.js";

let seq = 0;

/** A frame whose auto-layout sizing behaves like Figma's. */
class Frame {
  id = `30:${++seq}`;
  name = "Frame";
  type = "FRAME";
  children: Frame[] = [];
  parent: Frame | null = null;
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  primaryAxisSizingMode = "FIXED";
  counterAxisSizingMode = "FIXED";
  private mode = "NONE";
  [k: string]: unknown;
  get layoutMode() {
    return this.mode;
  }
  // Measured: turning auto-layout on leaves the primary axis hugging (AUTO),
  // whatever size the frame was resized to just before.
  set layoutMode(v: string) {
    if (this.mode === "NONE" && v !== "NONE") this.primaryAxisSizingMode = "AUTO";
    this.mode = v;
  }
  private axis(horizontal: boolean) {
    return (this.mode === "HORIZONTAL") === horizontal ? "primaryAxisSizingMode" : "counterAxisSizingMode";
  }
  set layoutSizingHorizontal(v: string) {
    if (this.mode !== "NONE") this[this.axis(true)] = v === "HUG" ? "AUTO" : "FIXED";
  }
  get layoutSizingHorizontal() {
    return this[this.axis(true)] === "AUTO" ? "HUG" : "FIXED";
  }
  set layoutSizingVertical(v: string) {
    if (this.mode !== "NONE") this[this.axis(false)] = v === "HUG" ? "AUTO" : "FIXED";
  }
  get layoutSizingVertical() {
    return this[this.axis(false)] === "AUTO" ? "HUG" : "FIXED";
  }
  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  appendChild(c: Frame) {
    this.children.push(c);
    c.parent = this;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this);
  }
}

let page: Frame;
const run = (params: Record<string, unknown>): OpContext => ({
  requestId: "r", params, yieldToHost: async () => {}, progress() {}, isCancelled: () => false,
});

beforeEach(() => {
  page = new Frame();
  page.type = "PAGE";
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page,
    root: new Frame(),
    createFrame: () => {
      const f = new Frame();
      page.appendChild(f);
      return f;
    },
    getNodeByIdAsync: async () => null,
  };
});
afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("create_frame pins a given size on an auto-layout frame", () => {
  it("a wrapping row given width 300 stays 300 wide, so it can wrap", async () => {
    await CREATE_OPS.create_frame!.run(run({ layout: "horizontal", wrap: true, gap: 8, rowGap: 12, width: 300 }));
    const f = page.children[0]!;
    expect(f.primaryAxisSizingMode).toBe("FIXED");
    expect(f.width).toBe(300);
    expect(f.counterAxisSizingMode).toBe("AUTO"); // no height given: it hugs
  });

  it("a column given a height pins it, and hugs the width it was not given", async () => {
    await CREATE_OPS.create_frame!.run(run({ layout: "vertical", height: 200 }));
    const f = page.children[0]!;
    expect([f.primaryAxisSizingMode, f.counterAxisSizingMode]).toEqual(["FIXED", "AUTO"]);
  });

  it("an explicit sizing still wins over the number", async () => {
    await CREATE_OPS.create_frame!.run(run({ layout: "horizontal", width: 300, sizing: { horizontal: "hug" } }));
    expect(page.children[0]!.primaryAxisSizingMode).toBe("AUTO");
  });
});
