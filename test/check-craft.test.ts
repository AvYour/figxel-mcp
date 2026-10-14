// figma_check_layout { audit: ["craft"] }: the finish defects the critics of
// the 2026-10-09 run measured by hand [C-207] — each rule on a fixture tree
// that should fire, one that should not, and the boundary between them. Plus
// the parameters (`safeArea`, `minTextSize`), which imply the audit and are
// refused by name when malformed, and the note on an animated frame [C-192].

import { afterEach, describe, expect, it } from "vitest";
import { CHECK_OPS, checkLayout, type AuditKind } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { READ_KEYS } from "../src/plugin/board-read.js";
import { CRAFT_SEVERITY } from "../src/plugin/craft.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `7:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const solid = (hex: string, opacity?: number) => {
  const v = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [{ type: "SOLID", color: { r: v(1), g: v(3), b: v(5) }, ...(opacity !== undefined ? { opacity } : {}) }];
};
const ink = solid("#111111");
const white = solid("#ffffff");
/** A one-family text: box as given, render bounds `glyphs` when the test needs the ink. */
function txt(name: string, box: [number, number, number, number], chars: string, size: number, props: Record<string, unknown> = {}): N {
  return mk("TEXT", name, box, { characters: chars, fontName: { family: "Inter", style: "Regular" }, fontSize: size, fills: ink, ...props });
}
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const check = (root: N, audit: AuditKind[] = ["craft"], opts: Record<string, unknown> = {}) =>
  checkLayout(root as never, 3000, noYield, { audit: new Set(audit), ...opts });
const of = (issues: Array<{ kind: string; name: string; severity: string; detail: string }>, kind: string) => issues.filter((i) => i.kind === kind);
const names = (issues: Array<{ kind: string; name: string }>, kind: string) => issues.filter((i) => i.kind === kind).map((i) => i.name);

afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("near_size", () => {
  it("two sizes of one family 7 % apart read as a slip (56 and 60 in the run)", async () => {
    const f = mk("FRAME", "Offer", [0, 0, 1080, 800], { fills: white }, [
      txt("Line A", [0, 0, 800, 67], "Wood-fired", 56),
      txt("Line B", [0, 100, 800, 72], "Ash glaze", 60),
    ]);
    const found = of((await check(f)).issues, "near_size");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Line B", severity: "info" });
    expect(found[0]!.detail).toMatch(/Inter 60 px, and "Line A" .* Inter 56 px — 1\.07×/);
  });

  it("not across families, not at 1.12 or more, and a run mixing sizes names itself", async () => {
    const apart = mk("FRAME", "F", [0, 0, 800, 400], {}, [
      txt("A", [0, 0, 600, 60], "Fifty", 50),
      txt("B", [0, 100, 600, 68], "Fifty-six", 56), // exactly 1.12
      txt("C", [0, 200, 600, 72], "Sixty", 60, { fontName: { family: "Georgia", style: "Regular" } }),
    ]);
    expect(of((await check(apart)).issues, "near_size")).toEqual([]);
    const mixed = mk("FRAME", "F", [0, 0, 800, 400], {}, [
      txt("Mixed", [0, 0, 600, 70], "Big small", 0, {
        fontSize: Symbol("mixed"),
        getStyledTextSegments: () => [
          { start: 0, end: 3, fontName: { family: "Inter", style: "Bold" }, fontSize: 40 },
          { start: 4, end: 9, fontName: { family: "Inter", style: "Regular" }, fontSize: 42 },
        ],
      }),
    ]);
    expect(of((await check(mixed)).issues, "near_size")[0]!.detail).toMatch(/^mixes Inter 40 and 42 px/);
  });
});

describe("no_shared_edge", () => {
  const column = (dx: number, width = 400) =>
    mk("FRAME", "Column", [0, 0, 1000, 400], {}, [
      txt("Head", [100, 0, 400, 29], "Shop the kiln", 24),
      txt("Body", [100 + dx, 45, width, 19], "Wood-fired stoneware", 16),
    ]);

  it("an edge 1–6 px off is a near miss: a warning", async () => {
    for (const dx of [1, 3, 6]) {
      const found = of((await check(column(dx))).issues, "no_shared_edge");
      expect(found, `dx ${dx}`).toHaveLength(1);
      expect(found[0]).toMatchObject({ name: "Body", severity: "warning" });
      expect(found[0]!.detail).toMatch(new RegExp(`edge ${dx} px off — close enough to look like a slip`));
    }
  });

  it("more than 6 px off on every edge is info; under 1 px is one edge", async () => {
    const far = of((await check(column(40, 200))).issues, "no_shared_edge");
    expect(far).toHaveLength(1);
    expect(far[0]).toMatchObject({ severity: "info" });
    expect(far[0]!.detail).toMatch(/shares no left, right or centre edge .*nearest, left, is 40 px off/);
    expect(of((await check(column(6.5))).issues, "no_shared_edge")[0]!.severity).toBe("info");
    expect(of((await check(column(0.5))).issues, "no_shared_edge")).toEqual([]);
    expect(of((await check(column(0, 200))).issues, "no_shared_edge")).toEqual([]); // the left edge is shared
  });

  it("blocks far apart, or side by side, are not one column", async () => {
    const apart = mk("FRAME", "F", [0, 0, 1000, 800], {}, [
      txt("Head", [100, 0, 400, 29], "Shop the kiln", 24),
      txt("Footer", [103, 600, 400, 19], "Wood-fired stoneware", 16),
      txt("Side", [700, 45, 200, 19], "Elsewhere", 16),
    ]);
    expect(of((await check(apart)).issues, "no_shared_edge")).toEqual([]);
  });
});

describe("tangent", () => {
  const pair = (b: [number, number, number, number], props: Record<string, unknown> = {}, layout: Record<string, unknown> = {}) =>
    mk("FRAME", "Poster", [0, 0, 2000, 2000], layout, [
      mk("ELLIPSE", "Arch", [0, 0, 200, 200], { fills: ink }),
      mk("RECTANGLE", "Mug", b, { fills: ink, ...props }),
    ]);

  it("a gap or an overlap under max(8 px, 2 % of the larger side) is a near-touch", async () => {
    const gap = of((await check(pair([205, 50, 100, 100]))).issues, "tangent");
    expect(gap).toHaveLength(1);
    expect(gap[0]).toMatchObject({ name: "Arch", severity: "info" });
    expect(gap[0]!.detail).toMatch(/almost touches "Mug" .*sits 5 px from it, under 8 px/);
    const nick = of((await check(pair([195, 50, 100, 100]))).issues, "tangent");
    expect(nick[0]!.detail).toMatch(/overlaps it by only 5 px/);
    // 2 % of a 600 px side is 12 px: a 10 px gap is still a near-touch.
    expect(of((await check(pair([205 + 5, 0, 600, 600]))).issues, "tangent")).toHaveLength(1);
  });

  it("8 px clear, a decisive overlap, an inset, an abutment or a layout's own gap are not", async () => {
    expect(of((await check(pair([208, 50, 100, 100]))).issues, "tangent")).toEqual([]); // boundary: not under 8
    expect(of((await check(pair([150, 50, 100, 100]))).issues, "tangent")).toEqual([]); // 50 px overlap
    expect(of((await check(pair([50, 50, 100, 100]))).issues, "tangent")).toEqual([]); // inside the arch's box
    expect(of((await check(pair([200, 50, 100, 100]))).issues, "tangent")).toEqual([]); // touching edge to edge
    const row = pair([205, 50, 100, 100], {}, { layoutMode: "HORIZONTAL", itemSpacing: 5 });
    expect(of((await check(row)).issues, "tangent")).toEqual([]);
  });

  it("a full-bleed ground touches everything and is not judged", async () => {
    const f = mk("FRAME", "Poster", [0, 0, 1000, 1000], {}, [
      mk("RECTANGLE", "Ground", [0, 0, 1000, 1000], { fills: white }),
      mk("RECTANGLE", "Block", [4, 4, 300, 300], { fills: ink }),
    ]);
    expect(of((await check(f)).issues, "tangent")).toEqual([]);
  });
});

describe("glyph_gaps", () => {
  /** Letters of size 100 on one baseline, at the given x positions and widths. */
  const word = (letters: Array<[string, number, number]>) =>
    mk("FRAME", "Title", [0, 0, 2000, 400], {}, letters.map(([ch, x, w]) => txt(ch, [x, 0, w, 120], ch, 100)));

  it("a gap past 0.15 em inside a word set one letter per layer is a warning", async () => {
    const found = of((await check(word([["S", 0, 50], ["l", 50, 25], ["o", 93, 55], ["w", 148, 70]]))).issues, "glyph_gaps");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "o", severity: "warning" });
    expect(found[0]!.detail).toMatch(/sits 18 px \(0\.18 em\) after "l"/);
  });

  it("not at 0.15 em, not at a word space between tight letters, not on another baseline", async () => {
    expect(of((await check(word([["S", 0, 50], ["l", 65, 25]]))).issues, "glyph_gaps")).toEqual([]); // exactly 0.15 em
    const twoWords = word([["S", 0, 50], ["l", 50, 25], ["o", 75, 55], ["w", 130, 70], ["d", 225, 55], ["o", 280, 55], ["w", 335, 70]]);
    expect(of((await check(twoWords)).issues, "glyph_gaps")).toEqual([]); // the 25 px gap is the word space
    const stacked = mk("FRAME", "Title", [0, 0, 2000, 400], {}, [txt("A", [0, 0, 50, 120], "A", 100), txt("B", [70, 200, 50, 120], "B", 100)]);
    expect(of((await check(stacked)).issues, "glyph_gaps")).toEqual([]);
  });
});

describe("oldstyle_figures", () => {
  const figure = (chars: string, inkHeight: number | null) =>
    mk("FRAME", "Offer", [0, 0, 600, 300], {}, [
      txt("Price", [0, 0, 200, 120], chars, 100, inkHeight === null ? {} : { absoluteRenderBounds: { x: 4, y: 40, width: 180, height: inkHeight } }),
    ]);

  it("digits whose ink is under 0.55 × the size are old-style: a warning", async () => {
    const found = of((await check(figure("10", 50))).issues, "oldstyle_figures");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning" });
    expect(found[0]!.detail).toMatch(/"10" renders 50 px tall at 100 px \(0\.50× the size\): old-style figures/);
  });

  it("lining height, the boundary, text with letters or signs, and no ink reading are not", async () => {
    expect(of((await check(figure("10", 70))).issues, "oldstyle_figures")).toEqual([]);
    expect(of((await check(figure("10", 55))).issues, "oldstyle_figures")).toEqual([]);
    expect(of((await check(figure("10%", 50))).issues, "oldstyle_figures")).toEqual([]);
    expect(of((await check(figure("10", null))).issues, "oldstyle_figures")).toEqual([]);
  });
});

describe("unbalanced_space", () => {
  const story = (y: number, h = 400) =>
    mk("FRAME", "Story", [0, 0, 1080, 1920], { fills: white }, [
      mk("RECTANGLE", "Ground", [0, 0, 1080, 1920], { fills: white }),
      txt("Block", [100, y, 880, h], "Offer", 80),
    ]);

  it("a block whose centre of mass sits far off the frame's, over a wide empty band, is info on the root", async () => {
    const found = of((await check(story(200))).issues, "unbalanced_space");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Story", severity: "info" });
    expect(found[0]!.detail).toMatch(/560 px above the frame's centre \(29% of the height\), leaving 1320 px empty below/);
  });

  it("a centred block, or one only slightly off, is balanced", async () => {
    expect(of((await check(story(760))).issues, "unbalanced_space")).toEqual([]);
    expect(of((await check(story(660))).issues, "unbalanced_space")).toEqual([]); // 100 px off: under 6 % of 1920
  });

  it("with a safe area, the safe area is the field", async () => {
    // Centred on the frame (760–1160), but the safe area 250–1580 centres at 915.
    const r = await check(story(760), ["craft"], { safeArea: { x: 0, y: 250, width: 1080, height: 1330 } });
    expect(of(r.issues, "unbalanced_space")).toEqual([]); // 45 px off: under 6 %
    const low = await check(story(1100, 400), ["craft"], { safeArea: { x: 0, y: 250, width: 1080, height: 1330 } });
    expect(of(low.issues, "unbalanced_space")[0]!.detail).toMatch(/below the safe area's centre .*empty above/);
  });
});

describe("safe_area", () => {
  it("text, a logo or a CTA outside the brief's safe area is a warning; a CTA's own label is not reported twice", async () => {
    const f = mk("FRAME", "Story", [1000, 500, 1080, 1920], {}, [
      txt("Kicker", [1100, 600, 400, 40], "Autumn", 32),
      txt("Inside", [1100, 900, 400, 40], "Inside", 32),
      mk("RECTANGLE", "Logo", [1400, 2300, 200, 80], { fills: ink }),
      mk("FRAME", "CTA", [1100, 2000, 600, 120], { fills: ink }, [txt("Label", [1150, 2060, 300, 40], "Shop now", 32)]),
    ]);
    // In the root's coordinates: the frame sits at (1000, 500), so the area is x 1064–2016, y 750–2080.
    const r = await check(f, ["craft"], { safeArea: { x: 64, y: 250, width: 952, height: 1330 } });
    const found = of(r.issues, "safe_area");
    expect(found.map((i) => i.name)).toEqual(["Kicker", "Logo", "CTA"]);
    expect(found.every((i) => i.severity === "warning")).toBe(true);
    expect(found[0]!.detail).toMatch(/runs 150 px top outside the safe area/);
    expect(found[2]!.detail).toMatch(/runs 40 px bottom/);
  });

  it("without a safe area nothing is judged", async () => {
    const f = mk("FRAME", "Story", [0, 0, 1080, 1920], {}, [txt("Kicker", [100, 10, 400, 40], "Autumn", 32)]);
    expect(of((await check(f)).issues, "safe_area")).toEqual([]);
  });
});

describe("low_contrast_over_shape", () => {
  const scene = (band: [number, number, number, number], bandFill = solid("#222222"), first = true) => {
    const text = txt("Ash Vase", [100, 500, 300, 40], "Ash Vase", 32, { fills: solid("#444444") });
    const bandNode = mk("RECTANGLE", "Band", band, { fills: bandFill });
    return mk("FRAME", "Story", [0, 0, 1080, 1920], { fills: white }, first ? [bandNode, text] : [text, bandNode]);
  };

  it("text on a solid shape from another branch, below the WCAG minimum, is a warning naming the shape [C-075]", async () => {
    const r = await check(scene([0, 400, 1080, 400]));
    const found = of(r.issues, "low_contrast_over_shape");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Ash Vase", severity: "warning" });
    expect(found[0]!.detail).toMatch(/#444444 on #222222, the fill of "Band" .*needs 3:1/);
    // The ancestor backdrop (white) reads fine, so the old check stays silent: this is what it missed.
    expect(of(r.issues, "low_contrast")).toEqual([]);
  });

  it("not when the shape only partly holds the text, sits above it, reads fine, or lies under a filled ancestor", async () => {
    expect(of((await check(scene([0, 520, 1080, 400]))).issues, "low_contrast_over_shape")).toEqual([]); // straddles: an edge, not a ground
    expect(of((await check(scene([0, 400, 1080, 400], solid("#222222"), false))).issues, "low_contrast_over_shape")).toEqual([]);
    expect(of((await check(scene([0, 400, 1080, 400], solid("#f0f0f0")))).issues, "low_contrast_over_shape")).toEqual([]);
    const card = mk("FRAME", "Root", [0, 0, 1080, 1920], {}, [
      mk("RECTANGLE", "Band", [0, 400, 1080, 400], { fills: solid("#222222") }),
      mk("FRAME", "Card", [0, 300, 1080, 600], { fills: white }, [txt("T", [100, 500, 300, 40], "Text", 32, { fills: solid("#444444") })]),
    ]);
    expect(of((await check(card)).issues, "low_contrast_over_shape")).toEqual([]);
  });

  it("an image over the dark band is the ground: no one colour to judge, so no finding against the band", async () => {
    const f = mk("FRAME", "Story", [0, 0, 1080, 1920], { fills: white }, [
      mk("RECTANGLE", "Band", [0, 400, 1080, 400], { fills: solid("#222222") }),
      mk("RECTANGLE", "Photo", [0, 450, 1080, 200], { fills: [{ type: "IMAGE", imageHash: "h", scaleMode: "FILL" }] }),
      txt("Caption", [100, 500, 300, 40], "On the photo", 32, { fills: solid("#444444") }),
    ]);
    expect(of((await check(f)).issues, "low_contrast_over_shape")).toEqual([]);
  });
});

describe("min_text", () => {
  it("text under minTextSize is a warning; at it, none", async () => {
    const f = mk("FRAME", "Story", [0, 0, 1080, 1920], {}, [
      txt("Label", [100, 100, 400, 27], "22 px label", 22),
      txt("Ok", [100, 200, 400, 34], "28 px label", 28),
    ]);
    const found = of((await check(f, ["craft"], { minTextSize: 28 })).issues, "min_text");
    expect(found.map((i) => i.name)).toEqual(["Label"]);
    expect(found[0]!.detail).toMatch(/is 22 px, under this frame's floor of 28 px/);
    expect(of((await check(f)).issues, "min_text")).toEqual([]);
  });
});

describe("stroke_crosses_text", () => {
  const stroke = (type: string, box: [number, number, number, number], props: Record<string, unknown> = {}) =>
    mk(type, "Ring", box, { strokes: ink, strokeWeight: 2, fills: [], ...props });
  const withText = (shape: N, glyphs: [number, number, number, number]) =>
    mk("FRAME", "Poster", [0, 0, 2000, 2000], {}, [shape, txt("URL", glyphs, "moku.store", 24)]);

  it("a straight line through type is a warning; one under it is not", async () => {
    const through = of((await check(withText(stroke("LINE", [0, 110, 400, 0]), [50, 100, 200, 30]))).issues, "stroke_crosses_text");
    expect(through).toHaveLength(1);
    expect(through[0]).toMatchObject({ name: "URL", severity: "warning" });
    expect(through[0]!.detail).toMatch(/crossed by the stroke of "Ring"/);
    expect(of((await check(withText(stroke("LINE", [0, 140, 400, 0]), [50, 100, 200, 30]))).issues, "stroke_crosses_text")).toEqual([]);
  });

  it("a diagonal line runs corner to corner by its rotation", async () => {
    const corner: [number, number, number, number] = [0, 0, 20, 20];
    const rising = withText(stroke("LINE", [0, 0, 100, 100], { rotation: 45 }), corner);
    expect(of((await check(rising)).issues, "stroke_crosses_text")).toEqual([]); // bottom-left to top-right misses the top-left corner
    const falling = withText(stroke("LINE", [0, 0, 100, 100], { rotation: -45 }), corner);
    expect(of((await check(falling)).issues, "stroke_crosses_text")).toHaveLength(1);
  });

  it("a ring crosses text on its rim, not text inside it (the ring through a URL in the run)", async () => {
    const ring = () => stroke("ELLIPSE", [0, 0, 400, 400]);
    expect(of((await check(withText(ring(), [350, 190, 100, 20]))).issues, "stroke_crosses_text")).toHaveLength(1);
    expect(of((await check(withText(ring(), [150, 190, 100, 20]))).issues, "stroke_crosses_text")).toEqual([]);
    expect(of((await check(withText(ring(), [0, 0, 30, 20]))).issues, "stroke_crosses_text")).toEqual([]); // the box's corner, outside the ring
  });

  it("an outline around text, a filled shape and a stroked ancestor are not crossings", async () => {
    expect(of((await check(withText(stroke("RECTANGLE", [0, 0, 400, 400]), [100, 100, 100, 20]))).issues, "stroke_crosses_text")).toEqual([]);
    expect(of((await check(withText(stroke("RECTANGLE", [0, 0, 400, 400], { fills: white }), [390, 100, 100, 20]))).issues, "stroke_crosses_text")).toEqual([]);
    const card = mk("FRAME", "Card", [0, 0, 400, 400], { strokes: ink, strokeWeight: 2 }, [txt("T", [0, 0, 100, 20], "Edge", 16)]);
    expect(of((await check(card)).issues, "stroke_crosses_text")).toEqual([]);
  });
});

describe("edge_slices_text", () => {
  const scene = (shape: [number, number, number, number], textFirst = false) => {
    const t = txt("Ash Vase", [50, 100, 200, 40], "Ash Vase", 32);
    const s = mk("RECTANGLE", "Band", shape, { fills: solid("#e8e2da") });
    return mk("FRAME", "Story", [0, 0, 1080, 1920], {}, textFirst ? [t, s] : [s, t]);
  };

  it("a filled shape's edge between 10 % and 90 % of the text's height is info (the band through \"Ash Vase\")", async () => {
    const found = of((await check(scene([0, 120, 1080, 300]))).issues, "edge_slices_text");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Ash Vase", severity: "info" });
    expect(found[0]!.detail).toMatch(/the top edge of "Band" .*at 50% of its height/);
    expect(of((await check(scene([0, 104, 1080, 300]))).issues, "edge_slices_text")).toHaveLength(1); // 10 %: the boundary counts
    expect(of((await check(scene([0, 0, 100, 1000]))).issues, "edge_slices_text")[0]!.detail).toMatch(/right edge .*25% of its width/);
  });

  it("an edge near the text's own edge, a shape above the text, or one holding it whole is not", async () => {
    expect(of((await check(scene([0, 102, 1080, 300]))).issues, "edge_slices_text")).toEqual([]); // 5 %
    expect(of((await check(scene([0, 120, 1080, 300], true))).issues, "edge_slices_text")).toEqual([]); // painted above: `covered`
    expect(of((await check(scene([0, 50, 1080, 300]))).issues, "edge_slices_text")).toEqual([]);
  });
});

describe("weak_graphic_contrast", () => {
  const rule = (hex: string, weight: number, props: Record<string, unknown> = {}) =>
    mk("FRAME", "Story", [0, 0, 1080, 1920], { fills: white }, [mk("LINE", "Ripple", [0, 900, 1080, 0], { strokes: solid(hex), strokeWeight: weight, fills: [], ...props })]);

  it("a hairline under 3:1 against its ground is info [C-221]", async () => {
    const found = of((await check(rule("#dddddd", 1))).issues, "weak_graphic_contrast");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Ripple", severity: "info" });
    expect(found[0]!.detail).toMatch(/its 1 px stroke is 1\.\d\d:1 against the ground \(#dddddd on #ffffff\)/);
    // A translucent stroke is judged as it shows.
    expect(of((await check(rule("#000000", 1, { strokes: solid("#000000", 0.2) }))).issues, "weak_graphic_contrast")[0]!.detail).toMatch(/#cccccc on #ffffff/);
  });

  it("not a dark hairline, a thick stroke, or the border of a filled shape", async () => {
    expect(of((await check(rule("#555555", 1))).issues, "weak_graphic_contrast")).toEqual([]);
    expect(of((await check(rule("#dddddd", 3))).issues, "weak_graphic_contrast")).toEqual([]);
    expect(of((await check(rule("#dddddd", 1, { fills: white }))).issues, "weak_graphic_contrast")).toEqual([]);
  });
});

// ── the audit as a whole ─────────────────────────────────────────────────────

/** One frame that trips every craft rule that needs no parameter. */
function everything(): N {
  return mk("FRAME", "Poster", [0, 0, 1080, 1920], { fills: white }, [
    mk("RECTANGLE", "Band", [0, 600, 1080, 400], { fills: solid("#222222") }),
    txt("On band", [100, 700, 300, 40], "Dark on dark", 32, { fills: solid("#444444") }),
    txt("Head", [100, 100, 400, 67], "Wood-fired", 56),
    txt("Sub", [103, 180, 400, 72], "Ash glaze", 60),
    mk("ELLIPSE", "Arch", [600, 100, 200, 200], { fills: ink }),
    mk("RECTANGLE", "Mug", [805, 150, 100, 100], { fills: ink }),
    txt("1", [100, 1400, 30, 120], "1", 100),
    txt("2", [150, 1400, 30, 120], "2", 100),
    txt("Price", [400, 1400, 200, 120], "10", 100, { absoluteRenderBounds: { x: 404, y: 1440, width: 180, height: 50 } }),
    mk("LINE", "Strike", [90, 715, 400, 0], { strokes: solid("#333333"), strokeWeight: 1, fills: [] }),
    txt("Sliced", [100, 580, 300, 40], "Edge case", 32),
  ]);
}

describe("the craft audit", () => {
  it("reports nothing without the audit — the layout check is unchanged", async () => {
    const r = await check(everything(), []);
    expect(r.issues.filter((i) => i.kind in CRAFT_SEVERITY)).toEqual([]);
    expect(r.issues.filter((i) => ["tangent", "near_size"].includes(i.kind))).toEqual([]);
  });

  it("with it, every parameter-free rule fires on its own example", async () => {
    const kinds = new Set((await check(everything())).issues.map((i) => i.kind));
    for (const k of ["near_size", "no_shared_edge", "tangent", "glyph_gaps", "oldstyle_figures", "low_contrast_over_shape",
      "stroke_crosses_text", "edge_slices_text", "weak_graphic_contrast", "unbalanced_space"]) {
      expect(kinds, k).toContain(k);
    }
  });

  it("reads only members the guarded view exposes, so FigJam and Slides lose nothing [C-145]", async () => {
    const touched = new Set<string>();
    const record = (n: N): N => {
      const p = new Proxy(n, {
        get(t, k, r) {
          if (typeof k === "string") touched.add(k);
          return Reflect.get(t, k, r);
        },
      });
      n.children = (n.children ?? []).map(record);
      for (const c of n.children) c.parent = p;
      return p;
    };
    const root = record(everything());
    await checkLayout(root as never, 3000, noYield, { audit: new Set(["craft", "tells"]), safeArea: { x: 0, y: 0, width: 1080, height: 1600 }, minTextSize: 20 });
    const keys = new Set<string>(READ_KEYS);
    expect([...touched].filter((k) => !keys.has(k))).toEqual([]);
    for (const k of ["absoluteRenderBounds", "letterSpacing", "strokeWeight", "manualKeyframeTracks"]) expect(touched).toContain(k);
  });

  it("a page's own frames side by side on the canvas are not near-touches", async () => {
    const page = mk("PAGE", "Page", [0, 0, 0, 0], {}, [
      mk("FRAME", "Screen A", [0, 0, 390, 844], { fills: white }),
      mk("FRAME", "Screen B", [394, 0, 390, 844], { fills: white }),
    ]);
    expect(of((await check(page)).issues, "tangent")).toEqual([]);
  });

  it("a hidden layer is never judged", async () => {
    const f = mk("FRAME", "F", [0, 0, 1000, 1000], {}, [
      mk("ELLIPSE", "Arch", [0, 0, 200, 200], { fills: ink }),
      mk("RECTANGLE", "Mug", [205, 50, 100, 100], { fills: ink, visible: false }),
    ]);
    expect(of((await check(f)).issues, "tangent")).toEqual([]);
  });
});

describe("the check_layout op: craft parameters", () => {
  const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });
  type Result = { issues: Array<{ kind: string; name: string }>; audit?: { ran: string[]; note?: string }; ok: boolean };
  const install = (root: N) => {
    (globalThis as { figma?: unknown }).figma = { currentPage: mk("PAGE", "P", [0, 0, 0, 0], { selection: [] }), getNodeByIdAsync: async () => root };
  };
  const run = async (params: Record<string, unknown>) => (await CHECK_OPS.check_layout!.run(ctx(params))) as Result;

  it("safeArea and minTextSize each imply the craft audit", async () => {
    const f = mk("FRAME", "Story", [0, 0, 1080, 1920], {}, [txt("Kicker", [100, 10, 400, 27], "Autumn", 22)]);
    install(f);
    const a = await run({ nodeId: f.id, safeArea: "64,250,952,1330" });
    expect(a.audit!.ran).toEqual(["craft"]);
    expect(names(a.issues, "safe_area")).toEqual(["Kicker"]);
    expect(a.ok).toBe(false); // safe_area is a warning
    const b = await run({ nodeId: f.id, minTextSize: 28 });
    expect(b.audit!.ran).toEqual(["craft"]);
    expect(names(b.issues, "min_text")).toEqual(["Kicker"]);
    const c = await run({ nodeId: f.id, audit: ["tells"], minTextSize: 28 });
    expect(c.audit!.ran).toEqual(["tells", "craft"]);
  });

  it("the safe area is in the root's coordinates, wherever the root sits on the canvas", async () => {
    const f = mk("FRAME", "Story", [40000, 30000, 1080, 1920], {}, [txt("Inside", [40100, 30300, 400, 40], "Inside", 32)]);
    install(f);
    expect(names((await run({ nodeId: f.id, safeArea: "64,250,952,1330" })).issues, "safe_area")).toEqual([]);
  });

  it("a malformed safeArea or minTextSize is refused by name before anything is read", async () => {
    let read = false;
    (globalThis as { figma?: unknown }).figma = {
      currentPage: mk("PAGE", "P", [0, 0, 0, 0], { selection: [] }),
      getNodeByIdAsync: async () => {
        read = true;
        return null;
      },
    };
    for (const safeArea of ["10,20,30", "a,b,c,d", "0,0,0,100", "0,0,100,-5", "1,,2,3", 12, ["0", "0", "10", "10"]]) {
      await expect(run({ nodeId: "1:2", safeArea }), JSON.stringify(safeArea)).rejects.toMatchObject({ code: "INVALID_PARAM", message: expect.stringMatching(/^`safeArea` is "x,y,width,height"/) });
    }
    for (const minTextSize of [0, -4, "28", Number.NaN]) {
      await expect(run({ nodeId: "1:2", minTextSize }), String(minTextSize)).rejects.toMatchObject({ code: "INVALID_PARAM", message: expect.stringMatching(/^`minTextSize`/) });
    }
    expect(read).toBe(false);
  });

  it("an animated frame's findings say they measure one state, not the motion [C-192]", async () => {
    const still = mk("FRAME", "Still", [0, 0, 1080, 1920], {}, [txt("T", [100, 100, 400, 40], "Hello", 32)]);
    install(still);
    expect((await run({ nodeId: still.id, audit: ["craft"] })).audit!.note).toBeUndefined();
    const moving = mk("FRAME", "Ad", [0, 0, 1080, 1920], {}, [
      txt("T", [100, 100, 400, 40], "Hello", 32, { manualKeyframeTracks: { opacity: { keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] } } }),
    ]);
    install(moving);
    expect((await run({ nodeId: moving.id, audit: ["craft"] })).audit!.note).toMatch(/keyframes: craft and tells measure one state/);
    // Without craft or tells the walk never asks.
    expect((await run({ nodeId: moving.id, audit: ["fonts"] })).audit!.note).toBeUndefined();
  });

  it("a file without the Motion flag throws on every keyframe read: the walk stops asking after the first", async () => {
    let reads = 0;
    const throwing = (n: N) =>
      Object.defineProperty(n, "manualKeyframeTracks", {
        get() {
          reads++;
          throw new Error("in get_manualKeyframeTracks: manualKeyframeTracks is not a supported API");
        },
      });
    const f = mk("FRAME", "F", [0, 0, 1000, 1000], {}, [txt("A", [0, 0, 100, 20], "A text", 16), txt("B", [0, 40, 100, 20], "B text", 16)]);
    throwing(f);
    for (const k of f.children!) throwing(k);
    install(f);
    const r = await run({ nodeId: f.id, audit: ["craft"] });
    expect(r.audit!.note).toBeUndefined();
    expect(reads).toBe(1);
  });
});
