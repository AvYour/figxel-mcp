// figma_check_layout { audit: ["mark"] } (role spec §4.6): the tests a brand
// designer puts a mark through — its smallest feature at each application's
// size, every declared version drawn (and the one-colour one truly one
// colour), the lockup's clear space, the mark against its ground (3:1 as
// graphics guidance: WCAG 2.2 SC 1.4.3 exempts logotypes), and text in an
// app icon (Apple HIG: only when essential). Each kind on a fixture that
// fires and one that must not; and the brief read through the op.

import { afterEach, describe, expect, it } from "vitest";
import { CHECK_OPS, checkLayout } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { MARK } from "../src/plugin/mark.js";
import { BRIEF_KEY, BRIEF_NAMESPACE, type BriefRecord } from "../src/shared/roles.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `32:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const solid = (hex: string) => {
  const v = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [{ type: "SOLID", color: { r: v(1), g: v(3), b: v(5) } }];
};
const white = solid("#ffffff");
const ink = solid("#111111");
const page = (...kids: N[]) => {
  const p = mk("PAGE", "Identity", [0, 0, 0, 0], { selection: [] }, kids);
  delete p.absoluteBoundingBox;
  return p;
};
/** The drawing of a mark at (x, y): a symbol, a wordmark, a rule `rule` px thick, two dots `gap` px apart. */
const drawing = (x: number, y: number, fill: Array<Record<string, unknown>> = ink, rule = 2, gap = 6) => [
  mk("VECTOR", "Symbol", [x + 20, y + 20, 160, 160], { fills: fill }),
  mk("TEXT", "Wordmark", [x + 200, y + 110, 180, 48], { characters: "Kiln", fontSize: 40, fontName: { family: "Inter", style: "Bold" }, fills: fill }),
  mk("LINE", "Rule", [x + 20, y + 190, 360, 0], { strokes: fill, strokeWeight: rule, fills: [] }),
  mk("VECTOR", "Dot A", [x + 200, y + 50, 40, 40], { fills: fill }),
  mk("VECTOR", "Dot B", [x + 240 + gap, y + 50, 40, 40], { fills: fill }),
];
const logo = (rule = 2, gap = 6) => mk("COMPONENT", "Logo", [0, 0, 400, 200], { fills: white }, drawing(0, 0, ink, rule, gap));
/** A component set "Logo" with one variant per version, each drawn in `fills[i]` on `grounds[i]`. */
function versionSet(names: string[], fills: Array<Array<Record<string, unknown>>> = [], grounds: Array<Array<Record<string, unknown>>> = []): N {
  const variants = names.map((v, i) => mk("COMPONENT", `Version=${v}`, [0, 300 * i, 400, 200], { fills: grounds[i] ?? white, variantProperties: { Version: v } }, drawing(0, 300 * i, fills[i] ?? ink, 8, 20)));
  return mk("COMPONENT_SET", "Logo", [0, 0, 400, 300 * names.length], {}, variants);
}

function brief(details: Record<string, unknown> = {}): BriefRecord {
  return {
    v: 1, id: "9:4", role: "brand", gear: "top", title: "Kiln identity", status: "open",
    createdAt: "2026-10-16T09:00:00Z", updatedAt: "2026-10-16T09:00:00Z",
    lines: { goal: "a mark for the studio", message: "Fired by hand.", success: ["reads at 16 px"] },
    details: { name: "Kiln", ...details }, deliverables: [],
  };
}
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const check = (root: N, b?: BriefRecord) => checkLayout(root as never, 5000, noYield, { audit: new Set(["mark"]), ...(b ? { brief: b } : {}) });
type Issue = { kind: string; name: string; severity: string; detail: string; nodeId: string };
const of = (issues: Issue[], kind: string) => issues.filter((i) => i.kind === kind);
const pairs = (issues: Issue[], kind: string) => of(issues, kind).map((i) => `${i.name}:${i.severity}`);

afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("mark_detail_lost", () => {
  it("the smallest feature under 1 px at an application's size is a warning, naming the sizes; under 2 px only, info", async () => {
    const m = logo();
    page(m);
    const apps = [{ name: "favicon", sizePx: 16 }, { name: "business card", sizePx: 300 }];
    const found = of((await check(m, brief({ applications: apps }))).issues, "mark_detail_lost");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["Logo:warning"]);
    expect(found[0]!.detail).toMatch(/its smallest feature, the stroke of "Rule" .* is 2 px on a 400 px mark: at favicon \(16 px: 0\.08 px\) it renders under 1 px.*; at business card \(300 px: 1\.5 px\) under 2 px/);
    const soft = of((await check(m, brief({ applications: [{ name: "business card", sizePx: 300 }] }))).issues, "mark_detail_lost");
    expect(soft.map((i) => i.severity)).toEqual(["info"]);
  });

  it("a mark whose every feature holds at its smallest application is quiet; so is the gap and the parts inside a component", async () => {
    const m = logo(8, 20);
    page(m);
    expect(of((await check(m, brief({ applications: [{ name: "header", sizePx: 120 }] }))).issues, "mark_detail_lost")).toEqual([]);
    // The narrowest gap is a feature too: 6 px dots at 120 px is 1.8 px.
    const tight = logo(8, 6);
    page(tight);
    const gap = of((await check(tight, brief({ applications: [{ name: "header", sizePx: 120 }] }))).issues, "mark_detail_lost");
    expect(gap[0]!.detail).toMatch(/the gap to "Dot B" of "Dot A"/);
  });

  it("a sheet of marks is judged mark by mark, a variant at a time; a layer named for a usage panel is not a mark", async () => {
    const set = versionSet(["Full colour", "One colour", "Reversed"]);
    const usage = mk("FRAME", "Logo usage", [1000, 0, 800, 400], { fills: white }, [mk("FRAME", "Example", [1000, 0, 2, 2], { fills: ink })]);
    page(set, usage);
    const r = await check(set, brief({ applications: [{ name: "favicon", sizePx: 16 }] }));
    expect(pairs(r.issues, "mark_detail_lost")).toEqual(["Version=Full colour:warning", "Version=One colour:warning", "Version=Reversed:warning"]);
    expect(of((await check(usage, brief({ applications: [{ name: "favicon", sizePx: 16 }] }))).issues, "mark_detail_lost")).toEqual([]);
  });
});

describe("version_missing", () => {
  it("a declared version with nothing named for it is a warning on the brief; the defaults are full colour, one colour and reversed", async () => {
    const set = versionSet(["Full colour", "One colour"]);
    page(set);
    const found = of((await check(set, brief())).issues, "version_missing");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(['brief "Kiln identity":warning']);
    expect(found[0]!.nodeId).toBe("9:4");
    expect(found[0]!.detail).toMatch(/missing: "reversed" \(no component, variant or frame is named for it\)/);
  });

  it("a one-colour version painting two colours counts as missing; a white plate under it does not count", async () => {
    const red = solid("#cc2200");
    const set = versionSet(["Full colour", "Mono", "Reverse"]);
    // The one-colour variant: its dots red, the rest ink.
    const mono = set.children![1]!;
    for (const k of mono.children!) if (k.name.startsWith("Dot")) k.fills = red;
    page(set);
    const found = of((await check(set, brief())).issues, "version_missing");
    expect(found[0]!.detail).toMatch(/missing: "one colour" \("Version=Mono" \([^)]*\) paints 2 colours \(#cc2200, #111111\), so it is not one colour\)/);
    for (const k of mono.children!) k.fills = ink;
    mono.children!.unshift(mk("RECTANGLE", "Plate", [0, 300, 400, 200], { fills: white }));
    mono.children![0]!.parent = mono;
    expect(of((await check(set, brief())).issues, "version_missing")).toEqual([]);
  });

  it("a version drawn as a top-level frame elsewhere on the page counts; declared versions replace the defaults; no brief, nothing declared", async () => {
    const set = versionSet(["Full colour", "One colour"]);
    page(set, mk("FRAME", "Logo / Reversed", [2000, 0, 400, 200], { fills: ink }, drawing(2000, 0, white)));
    expect(of((await check(set, brief())).issues, "version_missing")).toEqual([]);
    const custom = of((await check(set, brief({ versions: ["Full colour", "Stacked"] }))).issues, "version_missing");
    expect(custom[0]!.detail).toMatch(/missing: "Stacked"/);
    const none = await check(set);
    expect(of(none.issues, "version_missing")).toEqual([]);
    expect(of(none.issues, "mark_unmeasured")[0]!.detail).toMatch(/version_missing \(no brief was given\)/);
  });
});

describe("clear_space", () => {
  const lockup = (pad: number, caps = false) => {
    const word = mk("TEXT", "Wordmark", [pad + 100, pad + 10, 180, 48], {
      characters: caps ? "KILN" : "Kiln", fontSize: 40, fontName: { family: "Inter", style: "Bold" }, fills: ink,
      ...(caps ? { absoluteRenderBounds: { x: pad + 100, y: pad + 19, width: 170, height: 30 } } : {}),
    });
    return mk("FRAME", "Logo lockup", [0, 0, 280 + 2 * pad, 60 + 2 * pad], { fills: white }, [
      mk("RECTANGLE", "Plate", [0, 0, 280 + 2 * pad, 60 + 2 * pad], { fills: white }),
      mk("VECTOR", "Symbol", [pad, pad, 60, 60], { fills: ink }),
      word,
    ]);
  };

  it("padding under the clear space resolved from the wordmark's cap height is a warning, side by side", async () => {
    const tight = lockup(12);
    page(tight);
    const found = of((await check(tight, brief({ clearSpace: "1x = cap height" }))).issues, "clear_space");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["Logo lockup:warning"]);
    expect(found[0]!.detail).toMatch(/keeps 12 px left, .* the brief's clear space "1x = cap height" is 28 px here \(1× the cap height of "Wordmark" \(≈ 0\.7 × 40 px\)\)/);
    const roomy = lockup(32);
    page(roomy);
    expect(of((await check(roomy, brief({ clearSpace: "1x = cap height" }))).issues, "clear_space")).toEqual([]);
  });

  it("caps with ink measure the real cap height; px and the mark's height resolve too; a rule it cannot read is said, not guessed", async () => {
    const caps = lockup(29, true);
    page(caps);
    expect(of((await check(caps, brief({ clearSpace: "1x = cap height" }))).issues, "clear_space")[0]!.detail).toMatch(/is 30 px here .*\(its ink\)/);
    const l = lockup(20);
    page(l);
    expect(of((await check(l, brief({ clearSpace: "24 px" }))).issues, "clear_space")).toHaveLength(1);
    expect(of((await check(l, brief({ clearSpace: "0.25x mark height" }))).issues, "clear_space")).toEqual([]);
    const vague = await check(l, brief({ clearSpace: "generous" }));
    expect(of(vague.issues, "clear_space")).toEqual([]);
    expect(of(vague.issues, "mark_unmeasured")[0]!.detail).toMatch(/clear_space \("generous" names no size this audit can resolve/);
  });
});

describe("mark_contrast", () => {
  it("a mark under 3:1 against its own ground is info, naming the exemption; a reversed mark in white is not", async () => {
    const set = versionSet(["Full colour", "Reversed"], [ink, solid("#333333")], [white, ink]);
    page(set);
    const found = of((await check(set, brief())).issues, "mark_contrast");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["Version=Reversed:info"]);
    expect(found[0]!.detail).toMatch(/is 1\.\d\d:1 against its ground #111111.*SC 1\.4\.3 exempts logotypes/);
    const fine = versionSet(["Full colour", "Reversed"], [ink, white], [white, ink]);
    page(fine);
    expect(of((await check(fine, brief())).issues, "mark_contrast")).toEqual([]);
    expect(MARK.contrast).toBe(3);
  });
});

describe("app_icon_text", () => {
  it("an app icon holding text is info; one without, or text beside it, is not; a 1024 frame counts when an application is an app icon", async () => {
    const named = mk("FRAME", "App icon", [0, 0, 1024, 1024], { fills: ink }, [mk("TEXT", "Name", [100, 400, 800, 200], { characters: "Kiln", fontSize: 160, fills: white })]);
    const plain = mk("FRAME", "App icon", [2000, 0, 1024, 1024], { fills: ink }, [mk("VECTOR", "Symbol", [2200, 200, 600, 600], { fills: white })]);
    const sized = mk("FRAME", "iOS 1024", [4000, 0, 1024, 1024], { fills: ink }, [mk("TEXT", "Name", [4100, 400, 800, 200], { characters: "Kiln", fontSize: 160, fills: white })]);
    page(named, plain, sized);
    expect(pairs((await check(named)).issues, "app_icon_text")).toEqual(["App icon:info"]);
    expect(of((await check(named)).issues, "app_icon_text")[0]!.detail).toMatch(/Apple's HIG asks an app icon to carry text only when it is essential/);
    expect(of((await check(plain)).issues, "app_icon_text")).toEqual([]);
    expect(of((await check(sized)).issues, "app_icon_text")).toEqual([]);
    expect(pairs((await check(sized, brief({ applications: [{ name: "App icon", sizePx: 1024 }] }))).issues, "app_icon_text")).toEqual(["iOS 1024:info"]);
  });
});

describe("mark_unmeasured", () => {
  it("no mark, no applications, no brief: one info naming what was left out", async () => {
    const f = mk("FRAME", "Poster", [0, 0, 400, 400], { fills: white }, [mk("RECTANGLE", "Block", [0, 0, 100, 100], { fills: ink })]);
    page(f);
    const r = await check(f);
    expect(r.issues.filter((i) => i.severity !== "info")).toEqual([]);
    const found = of(r.issues, "mark_unmeasured");
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/^not measured: mark_detail_lost and mark_contrast \(no layer here is named for a mark/);
    const m = logo();
    page(m);
    expect(of((await check(m, brief())).issues, "mark_unmeasured")[0]!.detail).toMatch(/mark_detail_lost \(the brief lists no applications with their sizePx\)/);
  });

  it("a layer named for the brand is the mark", async () => {
    const m = mk("FRAME", "Kiln / Primary", [0, 0, 400, 200], { fills: white }, drawing(0, 0));
    page(m);
    expect(pairs((await check(m, brief({ applications: [{ name: "favicon", sizePx: 16 }] }))).issues, "mark_detail_lost")).toEqual(["Kiln / Primary:warning"]);
  });
});

describe("the brief through figma_check_layout { briefId }", () => {
  const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });

  it("reads the applications off the record: a detail lost at the favicon fails the check; without the brief it is not measured", async () => {
    const m = logo();
    const record = JSON.stringify(brief({ applications: [{ name: "favicon", sizePx: 16 }], versions: ["Full colour"] }));
    const block = mk("FRAME", "Brief · Kiln identity", [0, 1000, 720, 400], {
      getSharedPluginData: (ns: string, key: string) => (ns === BRIEF_NAMESPACE && key === BRIEF_KEY ? record : ""),
    });
    const p = page(m, block);
    const nodes = [m, block, p];
    (globalThis as { figma?: unknown }).figma = { currentPage: p, getNodeByIdAsync: async (id: string) => nodes.find((n) => n.id === id) ?? null };
    type Out = { ok: boolean; issues: Issue[]; audit: { brief: unknown } };
    const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: m.id, audit: ["mark"], briefId: block.id }))) as Out;
    expect(r.audit.brief).toMatchObject({ id: "9:4", role: "brand" });
    expect(pairs(r.issues, "mark_detail_lost")).toEqual(["Logo:warning"]);
    expect(r.ok).toBe(false);
    const plain = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: m.id, audit: ["mark"] }))) as Out;
    expect(of(plain.issues, "mark_detail_lost")).toEqual([]);
    expect(plain.ok).toBe(true);
  });
});
