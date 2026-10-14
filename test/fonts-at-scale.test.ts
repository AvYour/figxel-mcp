// Fonts on a machine with many of them — the 2026-10-13 acceptance run, where
// Figma listed 10,038 font styles in 2,284 families:
//   - figma_suggest_fonts was declared STALLED twice. It grouped the whole list
//     on every call without a yield, then read the page yielding every 300
//     layers with no progress — and while Figma is in the background each yield
//     costs about a second [C-124], so 30 s passed with nothing reported.
//   - figma_get_fonts { scope: "available" } answered with 465,683 characters,
//     past what an MCP client takes, and had no way to ask for less.
//
// The fakes keep time on a clock the test owns: reading a font or a text layer
// costs a little of it, and a yield costs what a background yield costs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { PLUGIN_OPS } from "../src/plugin/ops/index.js";
import { TEXT_SCAN } from "../src/plugin/ops/typography.js";
import { resetFontCache } from "../src/plugin/write.js";

type Font = { family: string; style: string };

/** The fake clock, in ms. */
let clock = 0;
const STYLE_COST = 0.005; // reading one listed font: 10,038 of them are ~50 ms, four 12 ms slices
const TEXT_COST = 0.02; // reading one text layer's fonts (a host call)

const STYLES = ["Regular", "Medium", "Semi Bold", "Bold", "Italic"];
const KNOWN = ["Inter", "Playfair Display", "Roboto", "Poppins", "Space Grotesk", "Lora", "JetBrains Mono"];

/** The run's machine: 10,038 styles in 2,284 families — seven known faces, 2,277 synthetic ones, 902 of them with an italic. */
function machine(): Font[] {
  const out: Font[] = [];
  for (const family of KNOWN) for (const style of STYLES.slice(0, 4)) out.push({ family, style });
  for (let i = 0; i < 2_277; i++) {
    const family = `${["Grotesk", "Serif", "Sans"][i % 3]} Foundry ${String(i).padStart(4, "0")}`;
    for (const style of STYLES.slice(0, i < 902 ? 5 : 4)) out.push({ family, style });
  }
  return out;
}
const FONTS = machine();
const NAMES = [...new Set(FONTS.map((f) => f.family))];

/** What listAvailableFontsAsync hands back: reading a font's name costs clock time. */
const listed = (fonts: Font[]) =>
  fonts.map((fn) => ({
    get fontName() {
      clock += STYLE_COST;
      return fn;
    },
  }));

/** A page of `n` text layers whose fonts cost clock time to read. */
function page(n: number) {
  const children = Array.from({ length: n }, (_, i) => ({
    id: `9:${i + 1}`,
    type: "TEXT",
    name: `T${i}`,
    fontSize: i % 10 === 0 ? 32 : 16,
    characters: "Hello",
    fontName: { family: "Inter", style: i % 10 === 0 ? "Bold" : "Regular" },
    getRangeAllFontNames() {
      clock += TEXT_COST;
      return [this.fontName];
    },
  }));
  return { id: "0:1", type: "PAGE", name: "Big page", selection: [] as unknown[], children };
}

let calls: { list: number };
let fonts: Font[];

function install(pageNode = page(10)) {
  calls = { list: 0 };
  fonts = FONTS;
  (globalThis as { figma?: unknown }).figma = {
    currentPage: pageNode,
    root: { name: "File", children: [pageNode] },
    async listAvailableFontsAsync() {
      calls.list++;
      return listed(fonts);
    },
    async getNodeByIdAsync(id: string) {
      return id === pageNode.id ? pageNode : null;
    },
  };
}

/**
 * The op context of a plugin whose window is behind another one: every yield
 * costs `yieldMs` [C-124]. It records when each yield and each progress
 * message happened, on the fake clock.
 */
function host(yieldMs = 0) {
  const at = { yields: [] as number[], progress: [] as number[], phases: new Set<string>() };
  let cancelAt = Infinity;
  const ctx = (params: Record<string, unknown>): OpContext => ({
    requestId: "r",
    params,
    async yieldToHost() {
      at.yields.push(clock);
      clock += yieldMs;
    },
    progress(_done, _total, phase) {
      at.progress.push(clock);
      if (phase) at.phases.add(phase);
    },
    isCancelled: () => at.yields.length >= cancelAt,
  });
  return { at, ctx, cancelAfterYields: (n: number) => void (cancelAt = n) };
}

/** The longest stretch of fake time between two moments in `marks`, from `start` to `end`. */
function longestGap(start: number, marks: number[], end: number): number {
  const all = [start, ...marks, end].sort((a, b) => a - b);
  let gap = 0;
  for (let i = 1; i < all.length; i++) gap = Math.max(gap, all[i]! - all[i - 1]!);
  return gap;
}

const run = (op: string, ctx: OpContext) => PLUGIN_OPS[op]!.run(ctx) as Promise<Record<string, any>>;

beforeEach(() => {
  clock = 0;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  resetFontCache();
  install();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { figma?: unknown }).figma;
});

describe("figma_suggest_fonts on 10,038 styles [C-124]", () => {
  it("indexes the fonts in time slices: it yields, and no stretch between yields outlasts a slice", async () => {
    expect(FONTS).toHaveLength(10_038);
    expect(NAMES).toHaveLength(2_284);
    const h = host();
    const started = performance.now();
    const r = await run("suggest_fonts", h.ctx({ mood: "modern", use: "marketing", limit: 3 }));
    expect(performance.now() - started).toBeLessThan(5_000); // real time, generous for CI
    expect(r.suggestions).toHaveLength(3);
    expect(r.availableFamilies).toBe(2_284);
    // 10,038 font reads are ~50 ms of host time here: several 12 ms slices, each ending in a yield.
    expect(h.at.yields.length).toBeGreaterThanOrEqual(3);
    expect(longestGap(0, h.at.yields, clock)).toBeLessThan(20);
    expect(h.at.phases).toContain("indexing fonts");
  });

  it("reports progress at every yield, so a background window is slow but never STALLED", async () => {
    install(page(30_000));
    const h = host(1_000); // a background yield costs about a second [C-124]
    const r = await run("suggest_fonts", h.ctx({ mood: "modern", use: "marketing", limit: 3 }));
    expect(h.at.progress.length).toBeGreaterThanOrEqual(h.at.yields.length);
    // The bridge declares STALLED after 30 s without progress; here no gap comes near it.
    expect(longestGap(0, h.at.progress, clock)).toBeLessThan(2_000);
    // And the whole call is bounded: the page read stops at its time cap, it does not read 30,000 layers.
    expect(clock).toBeLessThan(15_000);
    expect(r.scanned.complete).toBe(false);
    expect(r.scanned.layers).toBeLessThanOrEqual(TEXT_SCAN.maxNodes);
    expect(r.scanNote).toMatch(/Pass nodeId/);
    expect(r.inUse[0]).toMatchObject({ family: "Inter", available: true });
  });

  it("reads at most TEXT_SCAN.maxNodes layers of a page in front, and says it stopped", async () => {
    install(page(30_000));
    const h = host();
    const r = await run("suggest_fonts", h.ctx({}));
    expect(r.scanned).toEqual({ layers: TEXT_SCAN.maxNodes, textLayers: TEXT_SCAN.maxNodes - 1, complete: false });
    expect(r.applyPlan.headingNodeIds.length + r.applyPlan.bodyNodeIds.length).toBeLessThanOrEqual(1_000);
  });

  it("a whole small page is read whole, and says so", async () => {
    const r = await run("suggest_fonts", host().ctx({}));
    expect(r.scanned).toEqual({ layers: 11, textLayers: 10, complete: true });
    expect(r).not.toHaveProperty("scanNote");
  });

  it("asks Figma for the list once per session, not once per call", async () => {
    const h = host();
    await run("suggest_fonts", h.ctx({ mood: "modern" }));
    await run("suggest_fonts", h.ctx({ mood: "editorial", use: "editorial" }));
    await run("get_fonts", h.ctx({ scope: "available" }));
    expect(calls.list).toBe(1);
  });

  it("a cancel stops the call instead of ranking a half-read design", async () => {
    install(page(30_000));
    const h = host();
    h.cancelAfterYields(2);
    await expect(run("suggest_fonts", h.ctx({}))).rejects.toMatchObject({ message: expect.stringMatching(/Cancelled/) });
  });
});

describe("figma_get_fonts { scope: \"available\" } on 10,038 styles", () => {
  it("answers 50 families with their styles by default, never the flat list", async () => {
    const r = await run("get_fonts", host().ctx({ scope: "available" }));
    expect(r).toMatchObject({ scope: "available", totalFamilies: 2_284, totalStyles: 10_038, total: 2_284, count: 50, truncated: true });
    expect(r.families).toHaveLength(50);
    expect(r.families[0]).toEqual({ family: expect.any(String), styles: expect.any(Array) });
    expect(r).not.toHaveProperty("fonts");
    expect(typeof r.nextCursor).toBe("string");
    expect(r.note).toMatch(/query/);
    // The run's answer was 465,683 characters; this one is a few thousand.
    expect(JSON.stringify(r).length).toBeLessThan(10_000);
  });

  it("pages with nextCursor to the end, sorted by name, every family once", async () => {
    const h = host();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r = await run("get_fonts", h.ctx({ scope: "available", limit: 500, ...(cursor ? { cursor } : {}) }));
      seen.push(...r.families.map((f: { family: string }) => f.family));
      cursor = r.nextCursor;
      if (!r.truncated) break;
    }
    expect(cursor).toBeUndefined();
    expect(seen).toHaveLength(2_284);
    expect(new Set(seen).size).toBe(2_284);
    expect(seen).toEqual([...seen].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
  });

  it("`query` keeps the names that contain it, case-insensitively, and implies scope available", async () => {
    const r = await run("get_fonts", host().ctx({ query: "GROTESK", limit: 5 }));
    expect(r.scope).toBe("available");
    expect(r.total).toBe(NAMES.filter((n) => n.toLowerCase().includes("grotesk")).length);
    expect(r.total).toBeGreaterThan(700); // Space Grotesk and every third synthetic family
    expect(r.families.every((f: { family: string }) => /grotesk/i.test(f.family))).toBe(true);
    // A cursor belongs to its query: another query refuses it.
    await expect(run("get_fonts", host().ctx({ query: "serif", cursor: r.nextCursor }))).rejects.toMatchObject({ code: "INVALID_PARAM" });
  });

  it("`families` answers for exact names — Figma's spelling and styles — and lists the rest as missing", async () => {
    const r = await run("get_fonts", host().ctx({ families: ["inter", "Playfair Display", "Comic Papyrus", "Inter"] }));
    expect(r.families).toEqual([
      { family: "Inter", styles: ["Regular", "Medium", "Semi Bold", "Bold"] },
      { family: "Playfair Display", styles: ["Regular", "Medium", "Semi Bold", "Bold"] },
    ]);
    expect(r.missing).toEqual(["Comic Papyrus"]);
    expect(r).toMatchObject({ total: 2, count: 2, truncated: false });
  });

  it("a family missing from a list over a minute old is looked for again, in a fresh list", async () => {
    const h = host();
    expect((await run("get_fonts", h.ctx({ families: ["New Face"] }))).missing).toEqual(["New Face"]);
    fonts = [...FONTS, { family: "New Face", style: "Regular" }]; // the user installs it
    expect((await run("get_fonts", h.ctx({ families: ["New Face"] }))).missing).toEqual(["New Face"]); // within the minute: the session's list
    clock += 61_000;
    const r = await run("get_fonts", h.ctx({ families: ["New Face"] }));
    expect(r.missing).toEqual([]);
    expect(r.families).toEqual([{ family: "New Face", styles: ["Regular"] }]);
  });

  it("refuses filters it would otherwise drop", async () => {
    const h = host();
    const refused = async (params: Record<string, unknown>) => {
      const e = await run("get_fonts", h.ctx(params)).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(BridgeError);
      return (e as BridgeError).code;
    };
    expect(await refused({ scope: "page", query: "inter" })).toBe("INVALID_PARAM");
    expect(await refused({ query: "inter", families: ["Inter"] })).toBe("INVALID_PARAM");
    expect(await refused({ families: ["Inter"], limit: 10 })).toBe("INVALID_PARAM");
  });

  it("limit is capped at 500", async () => {
    const r = await run("get_fonts", host().ctx({ scope: "available", limit: 5_000 }));
    expect(r.count).toBe(500);
  });
});
