// The node DTO's geometry.
//
// This file exists because of a specific class of bug found live: a parameter
// named `includeGeometry` that was accepted, echoed back as `true`, and never
// read anything. Tools could WRITE auto-layout, padding and corner radius, and
// there was no way to READ them back — so an agent could not check its own work,
// and `includeGeometry: true` in the response read as proof that it had.
//
// The tests therefore do not assert "a key exists". They assert that the values
// a write tool sets are the values a read returns, which is the property an
// agent actually depends on.

import { describe, expect, it } from "vitest";
import { toDto, solidFillHex } from "../src/plugin/read.js";

/** A stand-in with the field names the real Plugin API uses. */
function fakeNode(overrides: Record<string, unknown> = {}) {
  return {
    id: "1:2",
    name: "Card",
    type: "FRAME",
    ...overrides,
  } as never;
}

describe("geometry in the node DTO", () => {
  it("returns only id/name/type by default — geometry is opt-in, because a tree of it is bulky", () => {
    const dto = toDto(fakeNode({ layoutMode: "VERTICAL", width: 320, cornerRadius: 16 }), 0);
    expect(dto).toEqual({ id: "1:2", name: "Card", type: "FRAME" });
  });

  it("returns the layout the create tools can set", () => {
    const dto = toDto(
      fakeNode({
        layoutMode: "VERTICAL",
        itemSpacing: 12,
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 24,
        paddingLeft: 24,
        primaryAxisSizingMode: "AUTO",
        counterAxisSizingMode: "FIXED",
        width: 320,
        height: 180,
        x: 5200,
        y: 4000,
        cornerRadius: 16,
      }),
      0,
      50,
      true,
    );
    expect(dto.layoutMode).toBe("VERTICAL");
    expect(dto.itemSpacing).toBe(12);
    expect(dto.padding).toEqual({ top: 24, right: 24, bottom: 24, left: 24 });
    expect(dto.cornerRadius).toBe(16);
    // A VERTICAL stack: primary (AUTO) is the HEIGHT, counter (FIXED) the width.
    expect(dto.sizing).toEqual({ horizontal: "FIXED", vertical: "HUG" });
    expect([dto.width, dto.height, dto.x, dto.y]).toEqual([320, 180, 5200, 4000]);
  });

  it("omits layoutMode entirely when the node has none, rather than reporting NONE as a layout", () => {
    const dto = toDto(fakeNode({ layoutMode: "NONE", width: 100 }), 0, 50, true);
    expect(dto.layoutMode).toBeUndefined();
    expect(dto.padding).toBeUndefined();
    expect(dto.width).toBe(100); // other geometry still comes through
  });

  it("reports a uniform radius even when the API marks it mixed, by comparing the corners", () => {
    // `cornerRadius` is `number | figma.mixed`. A node can be mixed and still
    // have four equal corners; that IS one radius and worth reporting.
    const dto = toDto(
      fakeNode({
        cornerRadius: Symbol("figma.mixed"),
        topLeftRadius: 4,
        topRightRadius: 4,
        bottomLeftRadius: 4,
        bottomRightRadius: 4,
      }),
      0,
      50,
      true,
    );
    expect(dto.cornerRadius).toBe(4);
  });

  it("says nothing rather than picking one corner when the corners really differ", () => {
    // The failure this prevents: reporting the top-left as "the" radius, which
    // reads as a uniform radius the node does not have.
    const dto = toDto(
      fakeNode({
        cornerRadius: Symbol("figma.mixed"),
        topLeftRadius: 4,
        topRightRadius: 0,
        bottomLeftRadius: 16,
        bottomRightRadius: 0,
      }),
      0,
      50,
      true,
    );
    expect(dto.cornerRadius).toBeUndefined();
  });

  it("reports a solid fill as hex", () => {
    const dto = toDto(fakeNode({ fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] }), 0, 50, true);
    expect(dto.fill).toBe("#ffffff");
  });

  it("does not claim a hex for a gradient, because a lossy hex would be a lie", () => {
    const dto = toDto(fakeNode({ fills: [{ type: "GRADIENT_LINEAR" }] }), 0, 50, true);
    expect(dto.fill).toBeUndefined();
  });

  it("does not report a hidden fill as the node's colour", () => {
    expect(solidFillHex({ fills: [{ type: "SOLID", visible: false, color: { r: 1, g: 0, b: 0 } }] } as never)).toBeUndefined();
  });

  it("carries geometry into children when a tree is asked for", () => {
    const dto = toDto(
      fakeNode({
        children: [{ id: "1:3", name: "Inner", type: "FRAME", layoutMode: "HORIZONTAL", itemSpacing: 8 }],
      }),
      1,
      50,
      true,
    );
    expect(dto.children?.[0]?.layoutMode).toBe("HORIZONTAL");
    expect(dto.children?.[0]?.itemSpacing).toBe(8);
  });

  it("keeps non-default flags and drops the defaults, so their presence means something", () => {
    const shown = toDto(fakeNode({ opacity: 0.5, rotation: 15, visible: false, locked: true }), 0, 50, true);
    expect(shown.opacity).toBe(0.5);
    expect(shown.rotation).toBe(15);
    expect(shown.visible).toBe(false);
    expect(shown.locked).toBe(true);

    const defaults = toDto(fakeNode({ opacity: 1, rotation: 0, visible: true, locked: false }), 0, 50, true);
    expect(defaults.opacity).toBeUndefined();
    expect(defaults.rotation).toBeUndefined();
    expect(defaults.visible).toBeUndefined();
    expect(defaults.locked).toBeUndefined();
  });

  it("reports prototype scrolling and fixed layers only when a frame has them [C-117]", () => {
    const scrolling = toDto(fakeNode({ overflowDirection: "VERTICAL", numberOfFixedChildren: 2 }), 0, 50, true);
    expect(scrolling.overflow).toBe("vertical");
    expect(scrolling.fixedChildren).toBe(2);
    const still = toDto(fakeNode({ overflowDirection: "NONE", numberOfFixedChildren: 0 }), 0, 50, true);
    expect(still).not.toHaveProperty("overflow");
    expect(still).not.toHaveProperty("fixedChildren");
  });
});
