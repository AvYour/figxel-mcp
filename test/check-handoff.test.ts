// figma_check_layout { audit: ["handoff"] }: whether a frame can be handed on —
// the share of its solid paints, texts, auto-layout spacing and corner radii
// bound to the file's variables or styles, the frames detached from a
// component [C-343], and the local styles it uses that repeat another style or
// a variable. Asked for by a designer after the 0.1.1 launch post.

import { afterEach, describe, expect, it } from "vitest";
import { CHECK_OPS, checkLayout } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `7:${++seq}`, type, name, absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 40 }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const MIXED = Symbol("mixed");
const solid = (r: number, g: number, b: number, extra: Record<string, unknown> = {}) => ({ type: "SOLID", color: { r, g, b }, ...extra });
const bound = { boundVariables: { color: { type: "VARIABLE_ALIAS", id: "V:1" } } };
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const tally = async (root: N) => (await checkLayout(root as never, 1000, noYield, { audit: new Set(["handoff"]) })).handoff!;
const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });

afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("what the handoff audit counts", () => {
  it("solid paints: a style binds its whole list, a variable binds one paint, gradients are not counted", async () => {
    const f = mk("FRAME", "Card", { fills: [solid(1, 1, 1)], fillStyleId: "S:bg", strokes: [solid(0, 0, 0), solid(1, 0, 0, bound)] }, [
      mk("RECTANGLE", "Raw", { fills: [solid(0.2, 0.2, 0.2)] }),
      mk("RECTANGLE", "Gradient", { fills: [{ type: "GRADIENT_LINEAR" }] }),
      mk("RECTANGLE", "Hidden paint", { fills: [solid(0, 0, 1, { visible: false })] }),
    ]);
    expect((await tally(f)).paints).toEqual({ bound: 2, total: 4 });
  });

  it("texts: a text style, every segment styled, or typography bound to variables", async () => {
    const segs = (ids: string[]) => () => ids.map((textStyleId) => ({ textStyleId }));
    const f = mk("FRAME", "Copy", {}, [
      mk("TEXT", "Styled", { textStyleId: "T:body" }),
      mk("TEXT", "All segments", { textStyleId: MIXED, getStyledTextSegments: segs(["T:a", "T:b"]) }),
      mk("TEXT", "Some segments", { textStyleId: MIXED, getStyledTextSegments: segs(["T:a", ""]) }),
      mk("TEXT", "Bound size", { textStyleId: "", boundVariables: { fontSize: { id: "V:fs" } } }),
      mk("TEXT", "Raw", { textStyleId: "" }),
    ]);
    expect((await tally(f)).texts).toEqual({ bound: 3, total: 5 });
  });

  it("spacing: gaps and paddings over 0 in auto-layout, and no gap under space-between", async () => {
    const f = mk("FRAME", "Row", {
      layoutMode: "HORIZONTAL", itemSpacing: 16, paddingTop: 24, paddingRight: 24, paddingBottom: 0, paddingLeft: 24,
      boundVariables: { itemSpacing: { id: "V:gap" }, paddingTop: { id: "V:pad" } },
    }, [
      mk("FRAME", "Spread", { layoutMode: "VERTICAL", primaryAxisAlignItems: "SPACE_BETWEEN", itemSpacing: 40, paddingTop: 8 }),
      mk("FRAME", "No layout", { layoutMode: "NONE", itemSpacing: 12, paddingTop: 12 }),
    ]);
    // Row: gap, top, right, left (bottom is 0) → 4, 2 bound; Spread: its top only.
    expect((await tally(f)).spacing).toEqual({ bound: 2, total: 5 });
  });

  it("radii: one radius, or each corner when they differ", async () => {
    const f = mk("FRAME", "Shapes", { cornerRadius: 12, boundVariables: { topLeftRadius: { id: "V:r" } } }, [
      mk("RECTANGLE", "Square", { cornerRadius: 0 }),
      mk("RECTANGLE", "Mixed", { cornerRadius: MIXED, topLeftRadius: 8, topRightRadius: 8, bottomRightRadius: 0, bottomLeftRadius: 4, boundVariables: { topRightRadius: { id: "V:r" } } }),
    ]);
    expect((await tally(f)).radii).toEqual({ bound: 2, total: 4 });
  });

  it("an instance counts as a use of the system, and what is inside it is the component's business", async () => {
    const inst = mk("INSTANCE", "Button", { fills: [solid(0, 0, 0)] }, [mk("TEXT", "Label", { textStyleId: "" })]);
    const f = mk("FRAME", "Bar", {}, [inst, mk("FRAME", "Hidden", { visible: false, fills: [solid(0, 0, 0)] })]);
    const t = await tally(f);
    expect(t.instances).toBe(1);
    expect(t.paints.total).toBe(0);
    expect(t.texts.total).toBe(0);
  });

  it("detached frames, local or from a library [C-343]; components and plain frames are not", async () => {
    const f = mk("FRAME", "Page", {}, [
      mk("FRAME", "Was a card", { detachedInfo: { type: "local", componentId: "1:5" } }),
      mk("FRAME", "Was a library chip", { detachedInfo: { type: "library", componentKey: "abc123" } }),
      mk("FRAME", "Plain", { detachedInfo: null }),
      mk("COMPONENT", "Card", { detachedInfo: null }),
    ]);
    expect((await tally(f)).detached.map((d) => [d.name, d.info.type])).toEqual([["Was a card", "local"], ["Was a library chip", "library"]]);
  });
});

describe("the handoff report through figma_check_layout", () => {
  const roots = new Map<string, unknown>();
  function file(opts: { paintStyles?: unknown[]; textStyles?: unknown[]; variables?: unknown[]; collections?: unknown[]; nodes?: Record<string, unknown> }) {
    (globalThis as { figma?: unknown }).figma = {
      currentPage: mk("PAGE", "P", { selection: [] }),
      getNodeByIdAsync: async (id: string) => roots.get(id) ?? opts.nodes?.[id] ?? null,
      getLocalPaintStylesAsync: async () => opts.paintStyles ?? [],
      getLocalTextStylesAsync: async () => opts.textStyles ?? [],
      getStyleByIdAsync: async () => null,
      variables: {
        getLocalVariablesAsync: async (type?: string) => (opts.variables ?? []).filter((v) => !type || (v as { resolvedType: string }).resolvedType === type),
        getLocalVariableCollectionsAsync: async () => opts.collections ?? [],
        getVariableByIdAsync: async () => null,
      },
    };
  }
  type Out = {
    ok: boolean;
    issues: Array<{ kind: string; severity: string; name: string; nodeId: string; detail: string }>;
    handoff: { paints: { percent: number | null }; texts: { percent: number | null }; detached: number; duplicateStyles: number; instances: number; verdict: string };
    audit: { ran: string[]; designSystem: string };
  };
  const run = async (root: N) => {
    roots.set(root.id, root);
    return (await CHECK_OPS.check_layout!.run(ctx({ nodeId: root.id, audit: ["handoff"] }))) as Out;
  };

  it("reports the shares, names the component a frame was detached from, and warns", async () => {
    const card = { id: "1:5", name: "Card", type: "COMPONENT" };
    file({ paintStyles: [{ id: "S:bg", name: "Surface", paints: [solid(1, 1, 1)] }], nodes: { "1:5": card } });
    const f = mk("FRAME", "Screen", { fills: [solid(1, 1, 1)], fillStyleId: "S:bg" }, [
      mk("FRAME", "Was a card", { detachedInfo: { type: "local", componentId: "1:5" }, fills: [solid(0, 0, 0)] }),
      mk("INSTANCE", "Button"),
    ]);
    const r = await run(f);
    expect(r.handoff.paints.percent).toBe(50);
    expect(r.handoff.instances).toBe(1);
    expect(r.handoff.detached).toBe(1);
    const d = r.issues.find((i) => i.kind === "detached_instance")!;
    expect(d).toMatchObject({ severity: "warning", name: "Was a card" });
    expect(d.detail).toMatch(/detached from the local component "Card" \(1:5\)/);
    expect(r.ok).toBe(false);
    expect(r.handoff.verdict).toMatch(/^Bound to the file's variables or styles: 50% of solid paints \(1\/2\)/);
    expect(r.handoff.verdict).toMatch(/audit: \["tokens"\] lists each raw value/);
    expect(r.audit.ran).toEqual(["handoff"]);
  });

  it("flags a used paint style that repeats another style or a variable's default value, not one bound to it", async () => {
    file({
      paintStyles: [
        { id: "S:brand", name: "Brand", paints: [solid(1, 0, 0)] },
        { id: "S:red", name: "Red copy", paints: [solid(1, 0, 0)] },
        { id: "S:ink", name: "Ink", paints: [solid(0, 0, 0)] },
        { id: "S:wrapped", name: "Wrapped", paints: [solid(0, 0, 0, bound)] },
      ],
      variables: [{ id: "V:ink", name: "color/ink", resolvedType: "COLOR", variableCollectionId: "C:1", valuesByMode: { "M:light": { r: 0, g: 0, b: 0, a: 1 } } }],
      collections: [{ id: "C:1", defaultModeId: "M:light" }],
    });
    const f = mk("FRAME", "Screen", {}, [
      mk("RECTANGLE", "A", { fills: [solid(1, 0, 0)], fillStyleId: "S:brand" }),
      mk("RECTANGLE", "B", { fills: [solid(0, 0, 0)], fillStyleId: "S:ink" }),
      mk("RECTANGLE", "C", { fills: [solid(0, 0, 0)], fillStyleId: "S:wrapped" }),
    ]);
    const r = await run(f);
    const dupes = r.issues.filter((i) => i.kind === "duplicate_style");
    expect(dupes.map((i) => i.name).sort()).toEqual(["Brand", "Ink"]); // "Red copy" is not used here; "Wrapped" is bound
    expect(dupes.find((i) => i.name === "Brand")!.detail).toMatch(/same colour \(#ff0000\) as the style "Red copy"/);
    expect(dupes.find((i) => i.name === "Ink")!.detail).toMatch(/as the variable "color\/ink".*figma_bind_variable_to_node/);
    expect(dupes.every((i) => i.severity === "info")).toBe(true);
    expect(r.handoff.duplicateStyles).toBe(2);
  });

  it("flags a used text style identical to another one", async () => {
    const body = { fontName: { family: "Inter", style: "Regular" }, fontSize: 16, lineHeight: { unit: "PERCENT", value: 150 }, letterSpacing: { unit: "PIXELS", value: 0 } };
    file({ textStyles: [{ id: "T:body", name: "Body", ...body }, { id: "T:p", name: "Paragraph", ...body }, { id: "T:h", name: "Heading", ...body, fontSize: 32 }] });
    const f = mk("FRAME", "Copy", {}, [mk("TEXT", "P", { textStyleId: "T:body" })]);
    const r = await run(f);
    const d = r.issues.filter((i) => i.kind === "duplicate_style");
    expect(d.map((i) => i.name)).toEqual(["Body"]);
    expect(d[0]!.detail).toMatch(/identical to "Paragraph"/);
  });

  it("says when there is nothing to bind to yet, instead of reading as a failing grade", async () => {
    file({});
    const f = mk("FRAME", "Sketch", { fills: [solid(1, 1, 1)] }, [mk("TEXT", "T", { textStyleId: "" })]);
    const r = await run(f);
    expect(r.handoff.paints.percent).toBe(0);
    expect(r.handoff.verdict).toMatch(/nothing to bind to yet/);
    expect(r.handoff.verdict).toMatch(/figma_get_guide \{ topic: "design-system" \}/);
    expect(r.audit.designSystem).toMatch(/^none/);
    expect(r.audit.designSystem).not.toMatch(/token findings skipped/);
    expect(r.ok).toBe(true); // shares are numbers, not findings
  });

  it("merges every root of a nodeIds check into one report", async () => {
    file({ paintStyles: [{ id: "S:bg", name: "Surface", paints: [solid(1, 1, 1)] }] });
    const a = mk("FRAME", "A", { fills: [solid(1, 1, 1)], fillStyleId: "S:bg" });
    const b = mk("FRAME", "B", { fills: [solid(0, 0, 0)] });
    roots.set(a.id, a);
    roots.set(b.id, b);
    const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeIds: [a.id, b.id], audit: ["handoff"] }))) as Out;
    expect(r.handoff.paints.percent).toBe(50);
  });
});
