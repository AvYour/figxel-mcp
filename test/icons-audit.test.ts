// figma_check_layout { audit: ["icons"] } (role spec §4.7): whether an icon
// set was drawn as one construction system — one canvas (details.grid.size),
// one stroke weight, ink inside the live area (details.grid.padding), edges on
// whole pixels where an icon renders at 1x, one corner radius. Each kind on a
// fixture that fires and one that must not (a size variant, a centred odd
// stroke on a half pixel, an overshoot within tolerance); and the brief read
// through the op.

import { afterEach, describe, expect, it } from "vitest";
import { CHECK_OPS, checkLayout } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { ICONS, gridOf } from "../src/plugin/icons.js";
import { BRIEF_KEY, BRIEF_NAMESPACE, type BriefRecord } from "../src/shared/roles.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `33:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const ink = [{ type: "SOLID", color: { r: 0.07, g: 0.07, b: 0.07 } }];
/** A stroked path at (x, y) in the icon at `x0`. */
const path = (x0: number, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}) =>
  mk("VECTOR", name, [x0 + box[0], box[1], box[2], box[3]], { strokes: ink, strokeWeight: 2, strokeAlign: "CENTER", fills: [], ...props });
/** An icon component at x0, `size` px square, holding `kids(x0)`. */
const icon = (name: string, x0: number, size: number, kids: (x0: number) => N[], props: Record<string, unknown> = {}) =>
  mk("COMPONENT", name, [x0, 0, size, size], { fills: [], ...props }, kids(x0));
/** A plain 24 px icon: one path inside the live area, on whole pixels. */
const plain = (name: string, x0: number, props: Record<string, unknown> = {}) => icon(name, x0, 24, (x) => [path(x, "Path", [4, 4, 16, 16], props)]);
const page = (...kids: N[]) => {
  const p = mk("PAGE", "Icons", [0, 0, 0, 0], { selection: [] }, kids);
  delete p.absoluteBoundingBox;
  return p;
};
const set = (...icons: N[]) => {
  const f = mk("FRAME", "Icon set", [0, 0, 2000, 100], {}, icons);
  page(f);
  return f;
};

function brief(grid: Record<string, unknown> = { size: 24, padding: 2 }, more: Record<string, unknown> = {}): BriefRecord {
  return {
    v: 1, id: "9:5", role: "illustration", gear: "page", title: "Workshop icons", status: "open",
    createdAt: "2026-10-16T09:00:00Z", updatedAt: "2026-10-16T09:00:00Z",
    lines: { goal: "one set for the app", message: "Tools you know at a glance.", success: ["reads at 16 px"] },
    details: { set: ["wrench", "pump"], grid, sizes: [24], style: "outline", ...more }, deliverables: [],
  };
}
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const check = (root: N, b?: BriefRecord) => checkLayout(root as never, 5000, noYield, { audit: new Set(["icons"]), ...(b ? { brief: b } : {}) });
type Issue = { kind: string; name: string; severity: string; detail: string; nodeId: string };
const of = (issues: Issue[], kind: string) => issues.filter((i) => i.kind === kind);
const pairs = (issues: Issue[], kind: string) => of(issues, kind).map((i) => `${i.name}:${i.severity}`);

afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("the set", () => {
  it("icon components named icon/…, or in a set named for icons; every component when none is; a set of none says so", async () => {
    const f = set(plain("icon/wrench", 0), plain("Button", 100));
    const r = await check(f, brief());
    expect(of(r.issues, "icons_unmeasured")).toEqual([]);
    const variants = mk("COMPONENT_SET", "Icons / Pump", [0, 200, 200, 30], {}, [plain("Size=24", 0), plain("Size=24, Style=Fill", 30)]);
    page(variants);
    expect(of((await check(variants, brief())).issues, "icons_unmeasured")).toEqual([]);
    const empty = mk("FRAME", "Poster", [0, 0, 400, 400], {}, [mk("RECTANGLE", "Block", [0, 0, 100, 100], { fills: ink })]);
    page(empty);
    expect(of((await check(empty)).issues, "icons_unmeasured")[0]!.detail).toMatch(/found no icon here/);
  });

  it("gridOf reads numbers and strings, single values and lists", () => {
    expect(gridOf({ grid: { size: "24x24", padding: "2", stroke: [1.5, 2], corner: 2 } })).toEqual({ size: 24, padding: 2, strokes: [1.5, 2], corners: [2] });
    expect(gridOf({})).toEqual({});
  });
});

describe("icon_size_mixed", () => {
  it("a canvas off details.grid.size is a warning; on it (within 0.5 px), none", async () => {
    const f = set(plain("icon/wrench", 0), icon("icon/pump", 100, 20, (x) => [path(x, "Path", [4, 4, 12, 12])]), icon("icon/bell", 200, 24.3, (x) => [path(x, "Path", [4, 4, 16, 16])]));
    const found = of((await check(f, brief())).issues, "icon_size_mixed");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["icon/pump:warning"]);
    expect(found[0]!.detail).toMatch(/is 20 × 20 px; the set's grid is 24 × 24 px \(details\.grid\.size\)/);
  });

  it("a variant that names its own size is on the grid when the brief renders at that size", async () => {
    const small = (x: number) => mk("COMPONENT", "Size=16", [x, 0, 16, 16], { fills: [], variantProperties: { Size: "16" } }, [path(x, "Path", [3, 3, 10, 10], { strokeWeight: 1.5 })]);
    const setOf = () => {
      const s = mk("COMPONENT_SET", "icon/wrench", [0, 0, 100, 30], {}, [mk("COMPONENT", "Size=24", [0, 0, 24, 24], { fills: [], variantProperties: { Size: "24" } }, [path(0, "Path", [4, 4, 16, 16])]), small(50)]);
      page(s);
      return s;
    };
    expect(of((await check(setOf(), brief({ size: 24, padding: 2 }, { sizes: [16, 24] }))).issues, "icon_size_mixed")).toEqual([]);
    expect(pairs((await check(setOf(), brief({ size: 24, padding: 2 }, { sizes: [24, 32] }))).issues, "icon_size_mixed")).toEqual(["Size=16:warning"]);
  });
});

describe("stroke_mixed", () => {
  it("a second stroke weight among icons of one size is a warning on the rarer one; one weight is quiet", async () => {
    const f = set(plain("icon/a", 0), plain("icon/b", 100), plain("icon/c", 200, { strokeWeight: 1.5 }));
    const found = of((await check(f)).issues, "stroke_mixed");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["Path:warning"]);
    expect(found[0]!.detail).toMatch(/draws a 1\.5 px stroke \(1 shape in 1 icon, first "icon\/c"\) where the other 24 px icons draw 2 px \(2 shapes\)/);
    expect(of((await check(set(plain("icon/a", 0), plain("icon/b", 100)))).issues, "stroke_mixed")).toEqual([]);
  });

  it("against the grid's declared stroke: one weight off it is mixed; several declared are allowed; a smaller size is judged among its own", async () => {
    const off = set(plain("icon/a", 0, { strokeWeight: 1.5 }), plain("icon/b", 100, { strokeWeight: 1.5 }));
    const found = of((await check(off, brief({ size: 24, padding: 2, stroke: 2 }))).issues, "stroke_mixed");
    expect(found[0]!.detail).toMatch(/draws a 1\.5 px stroke \(2 shapes in 2 icons, first "icon\/a"\); the set's grid declares 2 px \(details\.grid\.stroke\)/);
    const both = set(plain("icon/a", 0, { strokeWeight: 1.5 }), plain("icon/b", 100));
    expect(of((await check(both, brief({ size: 24, padding: 2, stroke: [1.5, 2] }))).issues, "stroke_mixed")).toEqual([]);
    const sizes = set(plain("icon/a", 0), icon("icon/a-16", 100, 16, (x) => [path(x, "Path", [3, 3, 10, 10], { strokeWeight: 1.5 })]));
    expect(of((await check(sizes, brief({ size: 24, padding: 2, stroke: 2 }, { sizes: [16, 24] }))).issues, "stroke_mixed")).toEqual([]);
  });
});

describe("live_area", () => {
  it("ink past the canvas less its padding is info, naming the side and the layer; inside it, or within 0.5 px, none", async () => {
    const f = set(
      icon("icon/out", 0, 24, (x) => [path(x, "Wheel", [1, 4, 18, 16], { absoluteRenderBounds: { x: x + 0, y: 3, width: 20, height: 18 } })]),
      icon("icon/in", 100, 24, (x) => [path(x, "Wheel", [4, 4, 16, 16])]),
      icon("icon/near", 200, 24, (x) => [path(x, "Wheel", [3, 3, 18, 18], { absoluteRenderBounds: { x: x + 1.7, y: 2, width: 20, height: 20 } })]),
    );
    const found = of((await check(f, brief())).issues, "live_area");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["icon/out:info"]);
    expect(found[0]!.detail).toMatch(/its ink runs 2 px past the live area on the left \("Wheel"\): the 24 px canvas less 2 px padding/);
  });

  it("without details.grid.padding it is not measured, and said", async () => {
    const r = await check(set(plain("icon/a", 0)), brief({ size: 24 }));
    expect(of(r.issues, "live_area")).toEqual([]);
    expect(of(r.issues, "icons_unmeasured")[0]!.detail).toMatch(/live_area \(the brief gives no details\.grid\.padding\)/);
  });
});

describe("off_pixel", () => {
  it("in an icon of 32 px or less, a shape between pixels is info; whole pixels, a centred 1 px stroke on a half pixel, or a 48 px icon are not", async () => {
    const f = set(
      icon("icon/blur", 0, 24, (x) => [path(x, "Arc", [3.25, 4, 16, 16]), path(x, "Bar", [4, 4, 16.5, 2])]),
      icon("icon/sharp", 100, 24, (x) => [path(x, "Arc", [4, 4, 16, 16])]),
      icon("icon/hair", 200, 24, (x) => [path(x, "Line", [4.5, 4.5, 15, 15], { strokeWeight: 1 })]),
      icon("icon/large", 300, 48, (x) => [path(x, "Arc", [8.25, 8, 32, 32])]),
    );
    const found = of((await check(f)).issues, "off_pixel");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["icon/blur:info"]);
    expect(found[0]!.detail).toMatch(/renders at 1x at 24 px, and 2 of its shapes sit between pixels \("Arc" at x 3\.25; "Bar" at 16\.5 wide\)/);
  });
});

describe("corner_mixed", () => {
  const rounded = (name: string, x0: number, r: number) => icon(name, x0, 24, (x) => [mk("RECTANGLE", "Body", [x + 4, 4, 16, 16], { strokes: ink, strokeWeight: 2, fills: [], cornerRadius: r })]);

  it("a second corner radius in the set is info; declared radii are allowed; square corners do not count", async () => {
    const f = set(rounded("icon/a", 0, 2), rounded("icon/b", 100, 2), rounded("icon/c", 200, 3), rounded("icon/d", 300, 0));
    const found = of((await check(f)).issues, "corner_mixed");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["Body:info"]);
    expect(found[0]!.detail).toMatch(/draws a 3 px corner radius .* where the other 24 px icons draw 2 px/);
    expect(of((await check(f, brief({ size: 24, padding: 2, corner: [2, 3] }))).issues, "corner_mixed")).toEqual([]);
    expect(ICONS.smallIcon).toBe(32);
  });
});

describe("the brief through figma_check_layout { briefId }", () => {
  const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });

  it("reads the grid off the record: a canvas off it fails the check; without the brief the canvas is not measured", async () => {
    const f = set(plain("icon/wrench", 0), icon("icon/pump", 100, 20, (x) => [path(x, "Path", [4, 4, 12, 12])]));
    const record = JSON.stringify(brief({ size: 24, padding: 2, stroke: 2 }));
    const block = mk("FRAME", "Brief · Workshop icons", [0, 1000, 720, 400], {
      getSharedPluginData: (ns: string, key: string) => (ns === BRIEF_NAMESPACE && key === BRIEF_KEY ? record : ""),
    });
    const nodes = [f, block];
    (globalThis as { figma?: unknown }).figma = { currentPage: f.parent, getNodeByIdAsync: async (id: string) => nodes.find((n) => n.id === id) ?? null };
    type Out = { ok: boolean; issues: Issue[]; audit: { brief: unknown } };
    const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: f.id, audit: ["icons"], briefId: block.id }))) as Out;
    expect(r.audit.brief).toMatchObject({ id: "9:5", role: "illustration" });
    expect(pairs(r.issues, "icon_size_mixed")).toEqual(["icon/pump:warning"]);
    expect(r.ok).toBe(false);
    const bare = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: f.id, audit: ["icons"] }))) as Out;
    expect(of(bare.issues, "icon_size_mixed")).toEqual([]);
    expect(of(bare.issues, "icons_unmeasured")[0]!.detail).toMatch(/icon_size_mixed \(no brief was given/);
    expect(bare.ok).toBe(true);
  });
});
