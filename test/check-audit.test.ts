// figma_check_layout: the look the official screenshot check asks for, as
// numbers — a FILL child in a HUG parent, text collapsed into a thread,
// template copy, stacked frames — and the QA audits: raw values where a design
// system exists (including one that lives only in a library), duplicate
// component and variant names, and fonts outside the expected families.
// Plus the scope fix: every selected root is checked, not the page; the
// contrast exceptions and platform floor of the role spec (§4.0); and the
// brief block, which no check reads as design.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CHECK_OPS, checkLayout, type AuditKind } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import type { Bridge } from "../src/server/bridge.js";
import { registerRead } from "../src/server/tools/read.js";
import { BRIEF_KEY, BRIEF_NAMESPACE, type BriefRecord } from "../src/shared/roles.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `3:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const ink = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const check = (root: N, audit: AuditKind[] = [], expectFonts?: string[]) =>
  checkLayout(root as never, 1000, noYield, { audit: new Set(audit), ...(expectFonts ? { expectFonts } : {}) });
const kinds = (issues: Array<{ kind: string; name: string }>) => issues.map((i) => `${i.kind}:${i.name}`);

afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("what the official screenshot check looks for", () => {
  it("fill_in_hug: a FILL child of a parent that HUGS that axis", async () => {
    const col = mk("FRAME", "Column", [0, 0, 300, 100], { layoutMode: "VERTICAL", layoutSizingHorizontal: "HUG", layoutSizingVertical: "FIXED" }, [
      mk("FRAME", "Row", [0, 0, 300, 20], { layoutSizingHorizontal: "FILL", layoutSizingVertical: "FILL" }),
    ]);
    const r = await check(col);
    const found = r.issues.filter((i) => i.kind === "fill_in_hug");
    expect(found).toHaveLength(1); // the vertical axis is FIXED on the parent: no trap there
    expect(found[0]).toMatchObject({ severity: "warning", name: "Row" });
    expect(found[0]!.detail).toMatch(/fills the width of "Column", which hugs/);
  });

  it("fill_in_hug: silent when a sibling sizes the axis — a heading over a 1000 px row (measured live)", async () => {
    const page = mk("FRAME", "Pricing", [0, 0, 1000, 447], { layoutMode: "VERTICAL", layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG" }, [
      mk("TEXT", "Heading", [0, 0, 1000, 48], { characters: "Simple pricing", fills: ink, layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG" }),
      mk("FRAME", "Plans", [0, 80, 1000, 255], { layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG" }),
    ]);
    expect((await check(page)).issues.filter((i) => i.kind === "fill_in_hug")).toEqual([]);
  });

  it("fill_in_hug: still found when every child fills — a price and its period in a hugging row", async () => {
    const row = mk("FRAME", "Price row", [0, 0, 200, 53], { layoutMode: "HORIZONTAL", layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG" }, [
      mk("TEXT", "Price", [0, 0, 60, 53], { characters: "$9", fills: ink, layoutSizingHorizontal: "HUG", layoutSizingVertical: "FILL" }),
      mk("TEXT", "Period", [66, 0, 50, 53], { characters: "/month", fills: ink, layoutSizingHorizontal: "HUG", layoutSizingVertical: "FILL" }),
    ]);
    expect(kinds((await check(row)).issues.filter((i) => i.kind === "fill_in_hug"))).toEqual(["fill_in_hug:Price", "fill_in_hug:Period"]);
  });

  it("text_collapsed: a narrow, tall thread of text — not a short label", async () => {
    const f = mk("FRAME", "Card", [0, 0, 400, 600], {}, [
      mk("TEXT", "Thread", [0, 0, 6, 420], { characters: "Hello world", fontSize: 14, fills: ink }),
      mk("TEXT", "OK", [0, 0, 6, 16], { characters: "Hi", fontSize: 14, fills: ink }),
    ]);
    const r = await check(f);
    expect(kinds(r.issues.filter((i) => i.kind === "text_collapsed"))).toEqual(["text_collapsed:Thread"]);
    expect(r.issues.find((i) => i.kind === "text_collapsed")!.severity).toBe("error");
  });

  it("placeholder_text: the whole text is a stand-in word", async () => {
    const f = mk("FRAME", "Card", [0, 0, 400, 600], {}, [
      mk("TEXT", "A", [0, 0, 200, 20], { characters: "Title", fills: ink }),
      mk("TEXT", "B", [0, 30, 200, 20], { characters: "Lorem ipsum dolor sit amet", fills: ink }),
      mk("TEXT", "C", [0, 60, 200, 20], { characters: "Title of the talk", fills: ink }),
    ]);
    expect(kinds((await check(f)).issues.filter((i) => i.kind === "placeholder_text"))).toEqual(["placeholder_text:A", "placeholder_text:B"]);
  });

  it("sibling_overlap: frames stacked in a parent without layout, but not absolute ones, masks or layout children", async () => {
    const plain = mk("FRAME", "Board", [0, 0, 1000, 1000], { layoutMode: "NONE" }, [
      mk("FRAME", "Card A", [0, 0, 100, 100]),
      mk("FRAME", "Card B", [10, 10, 100, 100]),
      mk("FRAME", "Card C", [500, 0, 100, 100]),
      mk("INSTANCE", "Mask", [0, 0, 100, 100], { isMask: true }),
    ]);
    const r = await check(plain);
    const found = r.issues.filter((i) => i.kind === "sibling_overlap");
    expect(kinds(found)).toEqual(["sibling_overlap:Card A"]);
    expect(found[0]!.severity).toBe("info");
    expect(found[0]!.detail).toMatch(/"Card B".*81%/);
    const row = mk("FRAME", "Row", [0, 0, 1000, 100], { layoutMode: "HORIZONTAL" }, [mk("FRAME", "X", [0, 0, 100, 100]), mk("FRAME", "Y", [0, 0, 100, 100])]);
    expect((await check(row)).issues.filter((i) => i.kind === "sibling_overlap")).toEqual([]);
  });
});

describe("audit: tokens", () => {
  /** A figma with no local tokens, a variable to resolve, and a library style. */
  function api(opts: { localStyles?: number } = {}) {
    (globalThis as { figma?: unknown }).figma = {
      getLocalPaintStylesAsync: async () => Array.from({ length: opts.localStyles ?? 0 }, (_, i) => ({ id: `S:${i}` })),
      getLocalTextStylesAsync: async () => [],
      getStyleByIdAsync: async (id: string) => (id === "S:lib," ? { id, name: "Brand/Blue", remote: true } : null),
      variables: {
        getLocalVariablesAsync: async () => [],
        getVariableByIdAsync: async (id: string) => (id === "VariableID:lib/1" ? { id, name: "color/brand" } : null),
      },
    };
  }

  it("with no design system anywhere, raw values are not findings — there is nothing to bind them to", async () => {
    api();
    const f = mk("FRAME", "Card", [0, 0, 100, 100], { fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }], cornerRadius: 8 });
    const r = await check(f, ["tokens"]);
    expect(r.issues.filter((i) => i.kind.startsWith("unbound_"))).toEqual([]);
    expect(r.system).toMatchObject({ found: false });
  });

  it("a library-themed file (no local tokens, but bound nodes) is audited, with the inferred variable as the fix", async () => {
    api();
    const card = mk("FRAME", "Card", [0, 0, 300, 200], {
      layoutMode: "VERTICAL", itemSpacing: 16, paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24, cornerRadius: 12,
      fills: [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 1 } }],
      inferredVariables: { fills: [[{ type: "VARIABLE_ALIAS", id: "VariableID:lib/1" }]] },
      boundVariables: { paddingTop: { id: "x" } },
    }, [
      mk("FRAME", "Chip", [0, 0, 50, 20], { fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { id: "V" } } }] }),
      mk("INSTANCE", "Button", [0, 40, 80, 30], { fills: ink }, [mk("TEXT", "Label", [0, 40, 80, 30], { characters: "Go", fills: ink })]),
    ]);
    const r = await check(card, ["tokens"]);
    expect(r.system).toMatchObject({ found: true });
    const color = r.issues.find((i) => i.kind === "unbound_color")!;
    expect(color).toMatchObject({ name: "Card", severity: "warning", suggest: "color/brand" });
    expect(color.detail).toMatch(/fill #3366ff .*Bind it to "color\/brand"/);
    const spacing = r.issues.find((i) => i.kind === "unbound_spacing")!;
    expect(spacing.detail).toMatch(/itemSpacing 16, paddingRight 24, paddingBottom 24, paddingLeft 24/); // paddingTop is bound
    expect(r.issues.find((i) => i.kind === "unbound_radius")!.severity).toBe("info");
    // The bound chip and the instance (its component's business) are not findings.
    expect(r.issues.filter((i) => i.kind.startsWith("unbound_") && i.name !== "Card")).toEqual([]);
  });

  it("a library style on a node is evidence of a system too", async () => {
    api();
    const f = mk("FRAME", "Hero", [0, 0, 100, 100], { fillStyleId: "S:lib,", fills: ink }, [
      mk("RECTANGLE", "Raw", [0, 0, 10, 10], { fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 0 } }] }),
    ]);
    const r = await check(f, ["tokens"]);
    expect(r.system!.why).toMatch(/library styles/);
    expect(kinds(r.issues.filter((i) => i.kind === "unbound_color"))).toEqual(["unbound_color:Raw"]);
  });
});

describe("audit: names", () => {
  it("duplicate component names on the page, and a variant repeated inside a set in any order", async () => {
    const set = mk("COMPONENT_SET", "Button", [0, 0, 200, 100], {}, [
      mk("COMPONENT", "Size=Large, State=Default", [0, 0, 10, 10]),
      mk("COMPONENT", "State=Default, Size=Large", [20, 0, 10, 10]),
      mk("COMPONENT", "Size=Small, State=Default", [40, 0, 10, 10]),
    ]);
    const page = mk("PAGE", "Components", [0, 0, 0, 0], {}, [
      mk("COMPONENT", "Card", [0, 0, 10, 10]),
      mk("FRAME", "Group", [0, 0, 10, 10], {}, [mk("COMPONENT", "Card", [0, 0, 10, 10])]),
      set,
      mk("COMPONENT", "Badge", [0, 0, 10, 10]),
    ]);
    const r = await check(page.children![0]!, ["names"]);
    const dup = r.issues.filter((i) => i.kind === "duplicate_name");
    expect(dup).toHaveLength(2);
    expect(dup[0]!.detail).toMatch(/2 components on this page are named "Card"/);
    expect(dup[1]).toMatchObject({ name: "State=Default, Size=Large" });
  });
});

describe("audit: fonts", () => {
  it("counts families per text and, with expectFonts, tells free text from a design-system gap", async () => {
    const f = mk("FRAME", "Screen", [0, 0, 500, 500], {}, [
      mk("TEXT", "Title", [0, 0, 200, 40], { characters: "Pricing", fontName: { family: "Inter", style: "Bold" }, fills: ink }),
      mk("TEXT", "Mixed", [0, 50, 200, 40], {
        characters: "Pay less", fills: ink,
        getStyledTextSegments: () => [
          { start: 0, end: 3, fontName: { family: "Inter", style: "Regular" }, textStyleId: "" },
          { start: 4, end: 8, fontName: { family: "Roboto", style: "Regular" }, textStyleId: "" },
        ],
      }),
      mk("TEXT", "Styled", [0, 100, 200, 40], { characters: "Note", fontName: { family: "Roboto", style: "Regular" }, textStyleId: "S:body,", fills: ink }),
      mk("INSTANCE", "Button", [0, 150, 100, 40], {}, [
        mk("TEXT", "Label", [0, 150, 100, 40], { characters: "Go", fontName: { family: "Arial", style: "Regular" }, fills: ink }),
      ]),
    ]);
    const plain = await check(f, ["fonts"]);
    expect(plain.fonts).toEqual({ Inter: 2, Roboto: 2, Arial: 1 });
    expect(plain.issues.filter((i) => i.kind === "wrong_font" || i.kind === "ds_font_gap")).toEqual([]);

    const r = await check(f, ["fonts"], ["Inter"]);
    expect(kinds(r.issues.filter((i) => i.kind === "wrong_font"))).toEqual(["wrong_font:Mixed"]);
    expect(kinds(r.issues.filter((i) => i.kind === "ds_font_gap")).sort()).toEqual(["ds_font_gap:Label", "ds_font_gap:Styled"]);
  });
});

describe("the check_layout op", () => {
  const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });

  it("checks every selected root — the selection lives on the page — and never falls back to the page", async () => {
    const a = mk("FRAME", "A", [0, 0, 100, 100], {}, [mk("TEXT", "T", [0, 0, 50, 20], { characters: "Title", fills: ink })]);
    const b = mk("FRAME", "B", [200, 0, 100, 100], {}, [mk("TEXT", "U", [200, 0, 50, 20], { characters: "Button", fills: ink })]);
    const page = mk("PAGE", "Page", [0, 0, 0, 0], { selection: [a, b] }, [a, b, mk("FRAME", "Elsewhere", [900, 0, 10, 10])]);
    (globalThis as { figma?: unknown }).figma = { currentPage: page, getNodeByIdAsync: async () => null };
    const r = (await CHECK_OPS.check_layout!.run(ctx({}))) as { roots?: Array<{ id: string }>; scope?: string; issues: Array<{ kind: string; nodeId: string }> };
    expect(r.roots!.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(r.scope).toBe("selection");
    expect(r.issues.filter((i) => i.kind === "placeholder_text")).toHaveLength(2);
  });

  it("a page that is not the current one is loaded before it is walked [C-090]", async () => {
    const current = mk("PAGE", "Current", [0, 0, 0, 0], { selection: [] });
    let loaded = false;
    const other = mk("PAGE", "Other", [0, 0, 0, 0], { loadAsync: async () => void (loaded = true) }, [mk("FRAME", "F", [0, 0, 10, 10])]);
    (globalThis as { figma?: unknown }).figma = { currentPage: current, getNodeByIdAsync: async (id: string) => (id === other.id ? other : null) };
    const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: other.id }))) as { root: { id: string } };
    expect(loaded).toBe(true);
    expect(r.root.id).toBe(other.id);
  });

  // Judged per root, the unbound card's findings were dropped ("no system
  // here") while the bound card's verdict said the system exists — so the
  // merged result reported a design system and nothing for the card to fix.
  it("several selected roots are judged as one file: a root with nothing bound is audited beside a bound one", async () => {
    const raw = mk("FRAME", "Raw card", [0, 0, 100, 100], { fills: [{ type: "SOLID", color: { r: 0.31, g: 0.27, b: 0.9 } }] });
    const bound = mk("FRAME", "Bound card", [200, 0, 100, 100], {
      fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:lib/1" } } }],
    });
    const page = mk("PAGE", "Page", [0, 0, 0, 0], { selection: [raw, bound] }, [raw, bound]);
    // A library-themed file: no local styles or variables at all.
    (globalThis as { figma?: unknown }).figma = {
      currentPage: page,
      getNodeByIdAsync: async () => null,
      getLocalPaintStylesAsync: async () => [],
      getLocalTextStylesAsync: async () => [],
      variables: { getLocalVariablesAsync: async () => [], getVariableByIdAsync: async () => null },
    };
    const r = (await CHECK_OPS.check_layout!.run(ctx({ audit: ["tokens"] }))) as { issues: Array<{ kind: string; name: string }>; audit: { designSystem: string } };
    expect(r.audit.designSystem).toMatch(/^found: nodes here are bound to variables/);
    expect(kinds(r.issues.filter((i) => i.kind === "unbound_color"))).toEqual(["unbound_color:Raw card"]);
  });

  it("one root keeps its verdict: with no system anywhere, raw values are still not findings", async () => {
    const f = mk("FRAME", "Card", [0, 0, 100, 100], { fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] });
    (globalThis as { figma?: unknown }).figma = {
      currentPage: mk("PAGE", "P", [0, 0, 0, 0], { selection: [] }),
      getNodeByIdAsync: async () => f,
      getLocalPaintStylesAsync: async () => [],
      getLocalTextStylesAsync: async () => [],
      variables: { getLocalVariablesAsync: async () => [] },
    };
    const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: f.id, audit: ["tokens"] }))) as { issues: Array<{ kind: string }>; audit: { designSystem: string } };
    expect(r.audit.designSystem).toMatch(/^none \(/);
    expect(r.issues.filter((i) => i.kind.startsWith("unbound_"))).toEqual([]);
  });

  it("expectFonts implies the fonts audit, and an unknown audit is refused", async () => {
    const t = mk("TEXT", "T", [0, 0, 50, 20], { characters: "Hello there", fontName: { family: "Roboto", style: "Regular" }, fills: ink });
    const f = mk("FRAME", "F", [0, 0, 100, 100], {}, [t]);
    (globalThis as { figma?: unknown }).figma = { currentPage: mk("PAGE", "P", [0, 0, 0, 0], { selection: [] }), getNodeByIdAsync: async () => f };
    const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: f.id, expectFonts: ["Inter"] }))) as { fonts: Record<string, number>; audit: { ran: string[] }; ok: boolean };
    expect(r.fonts).toEqual({ Roboto: 1 });
    expect(r.audit.ran).toEqual(["fonts"]);
    expect(r.ok).toBe(false); // wrong_font is a warning
    await expect(CHECK_OPS.check_layout!.run(ctx({ nodeId: f.id, audit: ["spelling"] }))).rejects.toMatchObject({ code: "INVALID_PARAM" });
  });
});

// Role spec §4.0: the exceptions WCAG 2.2 makes to contrast (SC 1.4.3, 1.4.11)
// and the platform's own text floor; and the brief block, a working note every
// check skips.
describe("contrast exceptions, the platform floor and the brief block", () => {
  const grey = [{ type: "SOLID", color: { r: 0.8, g: 0.8, b: 0.8 } }];
  const white = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  const faint = (name = "Label") => mk("TEXT", name, [10, 10, 80, 20], { characters: "Book", fills: grey, fontSize: 14 });
  const brief = (over: Partial<BriefRecord> = {}): BriefRecord => ({
    v: 1, id: "9:1", role: "ux", gear: "page", title: "Bench booking", status: "open",
    createdAt: "2026-10-16T09:00:00Z", updatedAt: "2026-10-16T09:00:00Z",
    lines: { goal: "members book a bench", message: "You fix your own bike here.", success: ["books within one scroll"] },
    details: {}, deliverables: [], ...over,
  });
  const lowContrast = async (root: N, audit: AuditKind[] = []) => (await check(root, audit)).issues.filter((i) => i.kind === "low_contrast");

  it("low_contrast skips text in a disabled variant, a disabled instance, or one with a Disabled boolean on — and still finds the rest", async () => {
    const variant = (state: string) =>
      mk("COMPONENT", `State=${state}`, [0, 0, 100, 40], { fills: white, variantProperties: { State: state } }, [faint(`${state} label`)]);
    const set = mk("COMPONENT_SET", "Button", [0, 0, 300, 100], { fills: white }, [variant("Default"), variant("Disabled")]);
    expect(kinds(await lowContrast(set))).toEqual(["low_contrast:Default label"]);

    const inst = (props: Record<string, unknown>) => mk("INSTANCE", "Book", [0, 0, 100, 40], { fills: white, componentProperties: props }, [faint()]);
    expect(await lowContrast(inst({ State: { type: "VARIANT", value: "Inactive" } }))).toEqual([]);
    expect(await lowContrast(inst({ "Disabled#12:3": { type: "BOOLEAN", value: true } }))).toEqual([]);
    expect(await lowContrast(inst({ "Disabled#12:3": { type: "BOOLEAN", value: false } }))).toHaveLength(1);
  });

  it("low_contrast on a logotype — the node or an ancestor named logo, wordmark or lockup — is info, as SC 1.4.3 exempts it", async () => {
    const f = mk("FRAME", "Header", [0, 0, 400, 80], { fills: white }, [
      mk("FRAME", "Logo lockup", [0, 0, 120, 40], {}, [faint("Brand")]),
      faint("Nav item"),
    ]);
    const found = await lowContrast(f);
    expect(found.map((i) => [i.name, i.severity])).toEqual([["Brand", "info"], ["Nav item", "warning"]]);
    expect(found[0]!.detail).toMatch(/part of a logo, which WCAG 2\.2 SC 1\.4\.3 exempts/);
  });

  it("weak_graphic_contrast skips a hairline in an inactive variant (SC 1.4.11)", async () => {
    const rule = () => mk("LINE", "Divider", [0, 20, 100, 0], { strokes: grey, strokeWeight: 1, fills: [] });
    const set = mk("COMPONENT_SET", "Row", [0, 0, 300, 100], { fills: white }, [
      mk("COMPONENT", "State=Default", [0, 0, 100, 40], { fills: white, variantProperties: { State: "Default" } }, [rule()]),
      mk("COMPONENT", "State=Disabled", [0, 50, 100, 40], { fills: white, variantProperties: { State: "Disabled" } }, [rule()]),
    ]);
    const found = (await check(set, ["craft"])).issues.filter((i) => i.kind === "weak_graphic_contrast");
    expect(found).toHaveLength(1);
    expect(found[0]!.nodeId).toBe(set.children![0]!.children![0]!.id);
  });

  it("min_text takes iOS's 11 pt minimum at the frame's scale when no floor is given; the brief's own floor wins", async () => {
    const phone = () => mk("FRAME", "Slots", [0, 0, 1080, 2338], { fills: white }, [
      mk("TEXT", "Caption", [40, 40, 400, 30], { characters: "Open now", fills: ink, fontSize: 24 }),
      mk("TEXT", "Body", [40, 100, 400, 40], { characters: "Book a bench", fills: ink, fontSize: 32 }),
    ]);
    const ios = brief({ details: { platform: "ios", viewport: "390x844" } });
    const run = (b: BriefRecord | undefined, more: Record<string, unknown> = {}) =>
      checkLayout(phone() as never, 1000, noYield, { audit: new Set(["craft"]), ...(b ? { brief: b } : {}), ...more });
    // 11 pt on a 390 pt phone drawn 1080 wide is 11 × 1080 ÷ 390 ≈ 30.5 frame px.
    const found = (await run(ios)).issues.filter((i) => i.kind === "min_text");
    expect(found.map((i) => i.name)).toEqual(["Caption"]);
    expect(found[0]!.detail).toMatch(/is 24 px, under this frame's floor of 30\.5 px \(iOS's 11 pt minimum, Apple HIG, at this frame's scale/);
    // Drawn at device size, the floor is 11 px.
    const atSize = mk("FRAME", "Slots", [0, 0, 390, 844], { fills: white }, [mk("TEXT", "Tiny", [10, 10, 100, 12], { characters: "Terms", fills: ink, fontSize: 10 })]);
    expect((await checkLayout(atSize as never, 100, noYield, { audit: new Set(["craft"]), brief: ios })).issues.filter((i) => i.kind === "min_text")).toHaveLength(1);
    expect((await run(brief({ details: { platform: "web" } }))).issues.filter((i) => i.kind === "min_text")).toEqual([]);
    expect((await run(undefined)).issues.filter((i) => i.kind === "min_text")).toEqual([]);
    expect((await run({ ...ios, lines: { ...ios.lines, minTextSize: 20 } })).issues.filter((i) => i.kind === "min_text")).toEqual([]);
    expect((await run(ios, { minTextSize: 28 })).issues.filter((i) => i.kind === "min_text").map((i) => i.name)).toEqual(["Caption"]);
  });

  it("every check skips the brief block, but never the root or a node the brief lists as its own deliverable", async () => {
    const record = (deliverables: string[] = []) => JSON.stringify(brief({ deliverables }));
    const block = mk("FRAME", "Brief · Bench booking", [0, 0, 720, 400], { fills: white }, [faint("Status line")]);
    block.getSharedPluginData = (ns: string, key: string) => (ns === BRIEF_NAMESPACE && key === BRIEF_KEY ? record() : "");
    const screen = mk("FRAME", "Slots", [800, 0, 390, 844], { fills: white }, [faint("Caption")]);
    const page = mk("PAGE", "Flow", [0, 0, 0, 0], {}, [block, screen]);
    const r = await check(page, ["craft", "a11y", "states", "copy", "system"]);
    expect(r.issues.filter((i) => i.nodeId === block.id || i.name === "Status line")).toEqual([]);
    expect(kinds(r.issues.filter((i) => i.kind === "low_contrast"))).toEqual(["low_contrast:Caption"]);
    // Checked by itself, the block is the root: what was asked for is checked.
    expect(kinds(await lowContrast(block))).toEqual(["low_contrast:Status line"]);
    // A brief stored on the work, which lists the work as a deliverable, is not a note.
    screen.getSharedPluginData = (ns: string, key: string) => (ns === BRIEF_NAMESPACE && key === BRIEF_KEY ? record([screen.id]) : "");
    expect(kinds(await lowContrast(page))).toEqual(["low_contrast:Caption"]);
  });
});

// The tool as a client sees it, on a server with nothing but the read group:
// the new passes and parameters pass the schema and reach the plugin as sent.
describe("the figma_check_layout schema", () => {
  const forwarded: Array<{ op: string; params: Record<string, unknown> }> = [];
  const bridge = {
    request: async (op: string, params: Record<string, unknown>) => {
      forwarded.push({ op, params });
      return { ok: true };
    },
    statusAsync: async () => ({ sessions: [] }),
    status: () => ({ sessions: [] }),
  } as unknown as Bridge;
  let client: Client;
  beforeAll(async () => {
    const server = new McpServer({ name: "check-schema", version: "0" });
    registerRead(server, bridge, (op) => op === "check_layout");
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "check-schema", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterAll(async () => {
    await client.close();
  });
  const call = async (args: Record<string, unknown>) => (await client.callTool({ name: "figma_check_layout", arguments: args })) as { isError?: boolean };

  it("takes every audit, the role audits and briefId included, a safe area and a size floor, and forwards them as sent", async () => {
    forwarded.length = 0;
    const args = {
      nodeId: "1:2",
      audit: ["tokens", "names", "fonts", "board", "craft", "tells", "handoff", "a11y", "states", "copy", "system", "deck", "mark", "icons", "library"],
      safeArea: "64,250,952,1330",
      minTextSize: 28,
      briefId: "12:40",
    };
    expect((await call(args)).isError).toBeFalsy();
    expect(forwarded).toEqual([{ op: "check_layout", params: expect.objectContaining(args) }]);
  });

  // Fifteen audits now (the role spec's wave A adds a11y, states, copy and
  // system, wave B deck, mark, icons and library), so a sixteenth entry is the
  // one past the cap.
  it("refuses a sixteenth audit, an unknown one, a safe area that is not a string and a floor under 1 — before the plugin is asked", async () => {
    forwarded.length = 0;
    const all = ["craft", "tells", "tokens", "names", "fonts", "board", "handoff", "a11y", "states", "copy", "system", "deck", "mark", "icons", "library"];
    expect((await call({ audit: [...all, "craft"] })).isError).toBe(true);
    expect((await call({ audit: ["craft", "vibes"] })).isError).toBe(true);
    expect((await call({ safeArea: [64, 250, 952, 1330] })).isError).toBe(true);
    expect((await call({ minTextSize: 0.5 })).isError).toBe(true);
    expect(forwarded).toEqual([]);
  });

  it("names the new passes and its neighbour, and fits 1024 characters", async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "figma_check_layout")!;
    expect(t.description!.length).toBeLessThanOrEqual(1024);
    expect(t.description).toMatch(/craft \(finish:.*`safeArea`, `minTextSize`\), tells \(generated look; warning if the brief avoids it\)/);
    expect(t.description).toMatch(/figma_export_node shows the picture/);
    expect(t.description).toMatch(/Reads only\.$/);
    for (const name of ["a11y", "states", "copy", "system", "deck", "mark", "icons", "library", "`briefId`"]) expect(t.description).toContain(name);
    expect(Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(
      expect.arrayContaining(["audit", "safeArea", "minTextSize", "briefId"]),
    );
  });
});
