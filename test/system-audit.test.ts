// figma_check_layout { audit: ["system"] } (role spec §4.4): the work against
// the numbers its brief wrote down — the format's size, the type scale, the
// spacing base, the grid's columns, the palette — and two optical corrections
// (ink aligned, punctuation hung). A warning only where a number was stated
// and missed: the format, and a block 1–4 px off a column edge. Without a
// brief or a grid it measures nothing it would have to guess, and says so once.

import { describe, expect, it } from "vitest";
import { checkLayout } from "../src/plugin/ops/check.js";
import { SYSTEM, columnEdges, deltaE, parseFormat } from "../src/plugin/system.js";
import type { BriefRecord, SystemNumbers } from "../src/shared/roles.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `24:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const solid = (hex: string) => {
  const v = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [{ type: "SOLID", color: { r: v(1), g: v(3), b: v(5) } }];
};
const white = solid("#ffffff");
const ink = solid("#111111");
const txt = (name: string, box: [number, number, number, number], chars: string, size: number, props: Record<string, unknown> = {}) =>
  mk("TEXT", name, box, { characters: chars, fontSize: size, fontName: { family: "Inter", style: "Regular" }, fills: ink, ...props });
/** A top-level frame: on a page, so it is a deliverable. */
const onPage = (frame: N) => {
  mk("PAGE", "Page", [0, 0, 0, 0], {}, [frame]);
  return frame;
};

function brief(over: { format?: string; system?: SystemNumbers; role?: BriefRecord["role"]; details?: Record<string, unknown> } = {}): BriefRecord {
  return {
    v: 1, id: "9:1", role: over.role ?? "graphic", gear: "page", title: "Spring poster", status: "open",
    createdAt: "2026-10-16T09:00:00Z", updatedAt: "2026-10-16T09:00:00Z",
    lines: { goal: "fill the spring workshop", message: "Fix your own bike this spring.", success: ["read in 2 s"], ...(over.format ? { format: over.format } : {}) },
    details: over.details ?? {}, deliverables: [], ...(over.system ? { system: over.system } : {}),
  };
}
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const check = (root: N, b?: BriefRecord) => checkLayout(root as never, 3000, noYield, { audit: new Set(["system"]), ...(b ? { brief: b } : {}) });
type Issue = { kind: string; name: string; severity: string; detail: string; nodeId: string };
const of = (issues: Issue[], kind: string) => issues.filter((i) => i.kind === kind);

describe("format_mismatch", () => {
  it("a deliverable off the format's size is a warning; on it, none", async () => {
    const b = brief({ format: "1080x1350 px Instagram feed" });
    const off = of((await check(onPage(mk("FRAME", "Post", [0, 0, 1080, 1340], { fills: white })), b)).issues, "format_mismatch");
    expect(off.map((i) => [i.name, i.severity])).toEqual([["Post", "warning"]]);
    expect(off[0]!.detail).toMatch(/is 1080 × 1340 px; the brief's format is 1080 × 1350 px .*10 px shorter/);
    expect(of((await check(onPage(mk("FRAME", "Post", [0, 0, 1080, 1350], { fills: white })), b)).issues, "format_mismatch")).toEqual([]);
    // A frame inside the deliverable is not the deliverable.
    const inner = mk("FRAME", "Card", [0, 0, 500, 500]);
    onPage(mk("FRAME", "Post", [0, 0, 1080, 1350], {}, [inner]));
    expect(of((await check(inner, b)).issues, "format_mismatch")).toEqual([]);
  });

  it("several sizes: the nearest; a screen (role ux) scrolls, so it may be taller but not shorter or narrower", async () => {
    const b = brief({ role: "ux", format: "390x844 px phone, 1440x900 px desktop" });
    expect(parseFormat(b.lines.format!)).toEqual([{ w: 390, h: 844, unit: "px" }, { w: 1440, h: 900, unit: "px" }]);
    expect(of((await check(onPage(mk("FRAME", "Home", [0, 0, 1440, 3200])), b)).issues, "format_mismatch")).toEqual([]);
    expect(of((await check(onPage(mk("FRAME", "Home", [0, 0, 1440, 800])), b)).issues, "format_mismatch")[0]!.detail).toMatch(/100 px shorter/);
    expect(of((await check(onPage(mk("FRAME", "Home", [0, 0, 1400, 900])), b)).issues, "format_mismatch")[0]!.detail).toMatch(/40 px narrower/);
  });

  it("print: the proportion of trim + 2 × bleed at the frame's scale; the trim alone is named", async () => {
    const b = brief({ format: "A4 poster, 210x297 mm", details: { medium: "print", bleedMm: 3 } });
    expect(of((await check(onPage(mk("FRAME", "Poster", [0, 0, 2160, 3030])), b)).issues, "format_mismatch")).toEqual([]);
    const trim = of((await check(onPage(mk("FRAME", "Poster", [0, 0, 2100, 2970])), b)).issues, "format_mismatch");
    expect(trim[0]!.detail).toMatch(/with 3 mm bleed on each side .*It is the trim size: add the bleed\./);
  });
});

describe("off_scale and off_spacing", () => {
  const sys: SystemNumbers = { bodySize: 16, ratio: 1.25, spacingBase: 8 };

  it("a text size off body × ratio^k is info, once per size, naming the nearest step; sizes on the scale are not", async () => {
    const f = mk("FRAME", "Page", [0, 0, 1000, 1000], {}, [
      txt("Body", [0, 0, 600, 20], "Wood-fired stoneware", 16),
      txt("H3", [0, 40, 600, 24], "Kiln", 20),
      txt("H2", [0, 80, 600, 30], "Glaze", 25),
      txt("Near", [0, 120, 600, 23], "Rim", 19.5), // within max(1 px, 2 %) of 20
      txt("Odd", [0, 160, 600, 26], "Ash", 22),
      txt("Odd too", [0, 200, 600, 26], "Clay", 22),
    ]);
    const found = of((await check(f, brief({ system: sys }))).issues, "off_scale");
    expect(found.map((i) => [i.name, i.severity])).toEqual([["Odd", "info"]]);
    expect(found[0]!.detail).toMatch(/is 22 px \(and 1 other text\), off the brief's scale 16 × 1\.25\^k \(… 20, 25 …\); the nearest step is 20 px/);
  });

  it("with sizes listed, a size not in the list is off", async () => {
    const f = mk("FRAME", "Page", [0, 0, 1000, 1000], {}, [txt("A", [0, 0, 600, 20], "Ash", 16), txt("B", [0, 40, 600, 24], "Kiln", 20)]);
    const found = of((await check(f, brief({ system: { bodySize: 16, sizes: [12, 16, 24] } }))).issues, "off_scale");
    expect(found.map((i) => i.name)).toEqual(["B"]);
    expect(found[0]!.detail).toMatch(/the brief's sizes \(12, 16, 24 px\)/);
  });

  it("an auto-layout gap or padding off the spacing base is info; space-between gaps and instances are not judged", async () => {
    const f = mk("FRAME", "Page", [0, 0, 1000, 1000], { layoutMode: "VERTICAL", itemSpacing: 12, paddingTop: 24, paddingLeft: 20 }, [
      mk("FRAME", "Row", [0, 0, 1000, 100], { layoutMode: "HORIZONTAL", primaryAxisAlignItems: "SPACE_BETWEEN", itemSpacing: 37, paddingTop: 16 }),
      mk("INSTANCE", "Chip", [0, 200, 100, 40], { layoutMode: "HORIZONTAL", itemSpacing: 6 }),
    ]);
    const found = of((await check(f, brief({ system: sys }))).issues, "off_spacing");
    expect(found.map((i) => [i.name, i.severity])).toEqual([["Page", "info"]]);
    expect(found[0]!.detail).toMatch(/^itemSpacing 12, paddingLeft 20: not multiples of the brief's 8 px spacing base \(nearest 16, 24\)/);
  });
});

describe("off_grid", () => {
  const grid = { pattern: "COLUMNS", alignment: "STRETCH", count: 12, gutterSize: 24, offset: 64, visible: true };
  // 12 columns across 1440 with 64 px margins and 24 px gutters: each column 87.33 px, the first four ending at 485.33.
  const blocks = (props: Record<string, unknown>) => mk("FRAME", "Desktop", [0, 0, 1440, 1000], props, [
    mk("RECTANGLE", "Ground", [0, 0, 1440, 1000], { fills: white }),
    mk("RECTANGLE", "On", [64, 100, 421.33, 200], { fills: ink }),
    mk("RECTANGLE", "Slip", [66, 320, 419.33, 200], { fills: ink }),
    mk("RECTANGLE", "Off", [100, 540, 385.33, 200], { fills: ink }),
    mk("FRAME", "Flow", [700, 100, 600, 400], { layoutMode: "VERTICAL" }, [mk("RECTANGLE", "In a flow", [703, 100, 200, 100], { fills: ink })]),
  ]);

  it("1–4 px off a column edge is a warning (a slip), more is info; on the edge, full bleed and children in a flow are not judged", async () => {
    const r = await check(blocks({ layoutGrids: [grid] }));
    const found = of(r.issues, "off_grid");
    expect(found.map((i) => [i.name, i.severity])).toEqual([["Slip", "warning"], ["Off", "info"], ["Flow", "info"]]);
    expect(found[0]!.detail).toMatch(/its left edge 2 px off the column edge at 64 \(its layout grid on "Desktop": 12 columns, 24 px gutter, 64 px margin\)/);
  });

  it("without a layout grid, the brief's system.grid; without either, off_grid is not measured and says so", async () => {
    const r = await check(blocks({}), brief({ system: { bodySize: 16, grid: { columns: 12, gutter: 24, margin: 64 } } }));
    expect(of(r.issues, "off_grid").map((i) => i.name)).toEqual(["Slip", "Off", "Flow"]);
    expect(of(r.issues, "off_grid")[0]!.detail).toMatch(/the brief's system\.grid/);
    const none = await check(blocks({}));
    expect(of(none.issues, "off_grid")).toEqual([]);
  });

  it("columnEdges: stretch, centred and left-aligned grids", () => {
    const s = columnEdges(grid, 1440)!;
    expect(s.lefts[0]).toBe(64);
    expect(s.rights[11]).toBeCloseTo(1376, 6);
    const c = columnEdges({ pattern: "COLUMNS", alignment: "CENTER", count: 3, gutterSize: 20, sectionSize: 100 }, 400)!;
    expect(c.lefts).toEqual([30, 150, 270]);
    const auto = columnEdges({ pattern: "COLUMNS", alignment: "MIN", count: Infinity, gutterSize: 10, offset: 0, sectionSize: 90 }, 400)!;
    expect(auto.lefts).toEqual([0, 100, 200, 300]);
  });
});

describe("off_palette", () => {
  it("a solid paint not in the palette is info, once per colour; within ΔE 2 is the swatch; gradients and instances are skipped", async () => {
    const f = mk("FRAME", "Poster", [0, 0, 1000, 1000], { fills: white }, [
      mk("RECTANGLE", "Red", [0, 0, 10, 10], { fills: solid("#e11d48") }),
      mk("RECTANGLE", "Red again", [20, 0, 10, 10], { fills: solid("#e11d48") }),
      mk("RECTANGLE", "Near ink", [40, 0, 10, 10], { fills: solid("#121212") }),
      mk("RECTANGLE", "Wash", [60, 0, 10, 10], { fills: [{ type: "GRADIENT_LINEAR", gradientStops: [] }] }),
      mk("INSTANCE", "Badge", [80, 0, 10, 10], {}, [mk("RECTANGLE", "Inside", [80, 0, 10, 10], { fills: solid("#00ff00") })]),
    ]);
    const palette = [{ hex: "#111111", role: "ink" }, { hex: "#FFFFFF", role: "ground" }];
    const found = of((await check(f, brief({ system: { bodySize: 16, palette } }))).issues, "off_palette");
    expect(found.map((i) => [i.name, i.severity])).toEqual([["Red", "info"]]);
    expect(found[0]!.detail).toMatch(/paints #e11d48 \(2 paints here\), which is not in the brief's palette; the nearest swatch is/);
    expect(deltaE({ r: 0x11 / 255, g: 0x11 / 255, b: 0x11 / 255 }, { r: 0x12 / 255, g: 0x12 / 255, b: 0x12 / 255 })).toBeLessThan(SYSTEM.paletteDeltaE);
  });
});

describe("optical_margin and hanging_punctuation", () => {
  it("texts sharing a box edge whose ink starts apart are info, with the nudge; ink within max(1 px, 3 %) is aligned", async () => {
    const f = mk("FRAME", "Page", [0, 0, 1000, 1000], {}, [
      txt("Display", [100, 0, 700, 77], "Kiln", 64, { absoluteRenderBounds: { x: 106, y: 12, width: 300, height: 50 } }),
      txt("Body", [100, 100, 700, 20], "Wood-fired stoneware thrown by hand.", 16, { absoluteRenderBounds: { x: 101, y: 103, width: 400, height: 14 } }),
      txt("Close", [100, 140, 700, 20], "Ash glaze.", 18, { absoluteRenderBounds: { x: 101.5, y: 143, width: 100, height: 14 } }),
    ]);
    const found = of((await check(f)).issues, "optical_margin");
    expect(found.map((i) => [i.name, i.severity])).toEqual([["Display", "info"]]);
    expect(found[0]!.detail).toMatch(/its ink starts 5 px right of that text's.*Nudge it x by −5 px/);
  });

  it("a display text opening with a quote mark inside the column is info; one hung left of the column is not", async () => {
    const body = (y: number, x = 100) => txt(`Body ${y}`, [x, y, 700, 20], "Wood-fired stoneware thrown by hand in small batches.", 16);
    const quote = (x: number) => txt("Quote", [x, 0, 700, 58], "“Fix it yourself.”", 48);
    const inside = of((await check(mk("FRAME", "Page", [0, 0, 1000, 1000], {}, [quote(100), body(100), body(140)]))).issues, "hanging_punctuation");
    expect(inside.map((i) => [i.name, i.severity])).toEqual([["Quote", "info"]]);
    expect(inside[0]!.detail).toMatch(/opens with "“" set inside the column.*about 19\.2 px \(0\.4 em/);
    expect(of((await check(mk("FRAME", "Page", [0, 0, 1000, 1000], {}, [quote(82), body(100), body(140)]))).issues, "hanging_punctuation")).toEqual([]);
    // Body text opening with a dash is a list, not display type.
    expect(of((await check(mk("FRAME", "Page", [0, 0, 1000, 1000], {}, [txt("Item", [100, 0, 700, 20], "– one bench per member", 16), body(40), body(80)]))).issues, "hanging_punctuation")).toEqual([]);
  });
});

describe("system_unmeasured", () => {
  it("without a brief: one info naming what was not measured, never a warning", async () => {
    const r = await check(onPage(mk("FRAME", "Post", [0, 0, 1080, 1340], { fills: white }, [mk("RECTANGLE", "Red", [0, 0, 10, 10], { fills: solid("#e11d48") })])));
    expect(r.issues.filter((i) => i.severity !== "info")).toEqual([]);
    const found = of(r.issues, "system_unmeasured");
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/^not measured: format_mismatch, off_scale, off_spacing, off_grid .*, off_palette — no brief was given \(figma_check_layout \{ briefId \}\)/);
  });

  it("a brief with every number: nothing unmeasured", async () => {
    const b = brief({ format: "1080x1350 px", system: { bodySize: 16, ratio: 1.25, spacingBase: 8, grid: { columns: 4, gutter: 24, margin: 64 }, palette: [{ hex: "#ffffff", role: "ground" }] } });
    const r = await check(onPage(mk("FRAME", "Post", [0, 0, 1080, 1350], { fills: white })), b);
    expect(of(r.issues, "system_unmeasured")).toEqual([]);
  });
});
