// figma_check_layout { audit: ["deck"] } (role spec §4.5): a presentation
// designer's look at every slide — words against the room's budget, a
// headline that asserts rather than names a topic, one idea instead of two,
// a structure that changes as the slides do, lists short enough to be heard,
// speaker notes where the brief asks for them, and the floor (60 px on a 1920
// slide for a projected deck: Kawasaki's 30 pt at 2 px per pt). Each kind on
// a fixture that fires and on a look-alike that must not; the deck's order
// read from its grid, so a slide checked by itself still knows its place; and
// the brief read through the op.

import { afterEach, describe, expect, it } from "vitest";
import { CHECK_OPS, checkLayout, type AuditKind } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { DECK, wordCount } from "../src/plugin/deck.js";
import { BRIEF_KEY, BRIEF_NAMESPACE, type BriefRecord } from "../src/shared/roles.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `31:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const white = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
const ink = [{ type: "SOLID", color: { r: 0.07, g: 0.07, b: 0.07 } }];
const photo = [{ type: "IMAGE", imageHash: "h", scaleMode: "FILL" }];
const words = (n: number, w = "bench") => Array.from({ length: n }, () => w).join(" ");
/** A text on the slide at `x0`, in slide coordinates. */
const txt = (x0: number, name: string, box: [number, number, number, number], chars: string, size: number, props: Record<string, unknown> = {}) =>
  mk("TEXT", name, [x0 + box[0], box[1], box[2], box[3]], { characters: chars, fontSize: size, fontName: { family: "Inter", style: "Regular" }, fills: ink, ...props });
const rect = (x0: number, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}) =>
  mk("RECTANGLE", name, [x0 + box[0], box[1], box[2], box[3]], { fills: photo, ...props });

/** Slide i of a deck: 1920 × 1080 at x = 2000 i, built by `kids(x0)`. */
const slide = (i: number, name: string, kids: (x0: number) => N[], props: Record<string, unknown> = {}) =>
  mk("SLIDE", name, [2000 * i, 0, 1920, 1080], { fills: white, ...props }, kids(2000 * i));
/** A Figma Slides deck: a page holding a grid with one row of `slides`. */
function deck(...slides: N[]): N {
  const row = mk("SLIDE_ROW", "Row 1", [0, 0, 0, 0], {}, slides);
  const grid = mk("SLIDE_GRID", "Grid", [0, 0, 0, 0], {}, [row]);
  const page = mk("PAGE", "Deck", [0, 0, 0, 0], { selection: [] }, [grid]);
  delete page.absoluteBoundingBox; // a page has no box
  return page;
}
/** A content slide: a 6-word headline and a 12-word body, and what else it holds. */
const content = (i: number, head = "Renewals carried the quarter for us", more: (x0: number) => N[] = () => []) =>
  slide(i, `Slide ${i + 1}`, (x0) => [
    txt(x0, "Headline", [120, 100, 1400, 86], head, 64),
    txt(x0, "Body", [120, 300, 1400, 120], words(12, "renewals"), 24),
    ...more(x0),
  ]);
const title = (i = 0) => slide(i, "Slide 1", (x0) => [txt(x0, "Title", [120, 400, 1400, 120], "Bench", 96)]);

function brief(details: Record<string, unknown> = {}, over: Partial<BriefRecord> = {}): BriefRecord {
  return {
    v: 1, id: "9:3", role: "presentation", gear: "page", title: "Member night", status: "open",
    createdAt: "2026-10-16T09:00:00Z", updatedAt: "2026-10-16T09:00:00Z",
    lines: { goal: "members come back", message: "Fixing your own bike is cheaper.", success: ["three sign-ups"] },
    details, deliverables: [], ...over,
  };
}
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const check = (root: N, b?: BriefRecord, audit: AuditKind[] = ["deck"]) =>
  checkLayout(root as never, 5000, noYield, { audit: new Set(audit), ...(b ? { brief: b } : {}) });
type Issue = { kind: string; name: string; severity: string; detail: string; nodeId: string };
const of = (issues: Issue[], kind: string) => issues.filter((i) => i.kind === kind);
const pairs = (issues: Issue[], kind: string) => of(issues, kind).map((i) => `${i.name}:${i.severity}`);

afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("units", () => {
  it("a Slides slide or a 1920 × 1080 top-level frame is a slide; anything else measures nothing, and says so", async () => {
    const nested = mk("FRAME", "Wrapper", [0, 0, 4000, 2000], {}, [mk("FRAME", "Not a slide", [0, 0, 1920, 1080], {}, [txt(0, "T", [0, 0, 400, 40], words(120), 24)])]);
    mk("PAGE", "P", [0, 0, 0, 0], {}, [nested]);
    const none = (await check(nested)).issues;
    expect(pairs(none, "deck_unmeasured")).toEqual(["Wrapper:info"]);
    expect(of(none, "deck_unmeasured")[0]!.detail).toMatch(/found no slide here/);
    expect(of(none, "slide_words")).toEqual([]);
    const frame = mk("FRAME", "Pitch 1", [0, 0, 1920, 1080], { fills: white }, [txt(0, "T", [0, 0, 1400, 400], words(120), 24)]);
    mk("PAGE", "P", [0, 0, 0, 0], {}, [frame]);
    expect(pairs((await check(frame)).issues, "slide_words")).toEqual(["Pitch 1:info"]);
  });

  it("wordCount counts runs with a letter or a digit: \"40%\" is a word, a dash is not", () => {
    expect(wordCount("Revenue rose 40% — on renewals")).toBe(5);
  });
});

describe("slide_words", () => {
  const dense = () => deck(title(), slide(1, "Dense", (x0) => [txt(x0, "Body", [120, 100, 1600, 600], words(50), 24)]), slide(2, "Light", (x0) => [txt(x0, "Body", [120, 100, 1600, 600], words(38), 24)]));

  it("over the room's budget is info (40 projected, 90 on screen); over the brief's maxWords a warning", async () => {
    expect(pairs((await check(dense(), brief({ room: "projected" }))).issues, "slide_words")).toEqual(["Dense:info"]);
    expect(of((await check(dense(), brief({ room: "projected" }))).issues, "slide_words")[0]!.detail).toMatch(/carries 50 words, over the 40 a projected deck carries/);
    expect(pairs((await check(dense(), brief({ room: "screen" }))).issues, "slide_words")).toEqual([]);
    const max = of((await check(dense(), brief({ room: "screen", maxWords: 45 }))).issues, "slide_words");
    expect(max.map((i) => `${i.name}:${i.severity}`)).toEqual(["Dense:warning"]);
    expect(max[0]!.detail).toMatch(/the brief's budget is 45 a slide \(details\.maxWords\)/);
  });

  it("no room: the screen budget, said so; a slide under every budget is quiet", async () => {
    expect(of((await check(dense())).issues, "slide_words")).toEqual([]);
    const long = deck(title(), slide(1, "Wall", (x0) => [txt(x0, "Body", [120, 100, 1600, 600], words(95), 24)]));
    expect(of((await check(long)).issues, "slide_words")[0]!.detail).toMatch(/the brief names no room; a projected deck carries 40/);
  });
});

describe("topic_title", () => {
  it("a content slide headed by three words or fewer is info; an assertion, the first slide and a section slide are not", async () => {
    const d = deck(
      title(),
      content(1, "Q3 results"),
      content(2, "Renewals carried Q3 as revenue rose 18 %"),
      slide(3, "Slide 4", (x0) => [txt(x0, "Section", [120, 400, 1400, 120], "Part two", 96)]),
    );
    const found = of((await check(d)).issues, "topic_title");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["Headline:info"]);
    expect(found[0]!.detail).toMatch(/heads the slide "Slide 2" with "Q3 results", 2 words: a topic, not an assertion\. The assertion-evidence approach/);
  });

  it("a big number is evidence, not the headline: the largest text with letters is judged; a slide with no headline above its body is not", async () => {
    const stat = deck(title(), content(1, "Renewals carried Q3 as revenue rose", (x0) => [txt(x0, "Stat", [120, 500, 600, 200], "40%", 160)]));
    expect(of((await check(stat)).issues, "topic_title")).toEqual([]);
    const flat = deck(title(), slide(1, "Table", (x0) => [txt(x0, "Head", [120, 100, 400, 30], "Plan", 24), txt(x0, "Body", [120, 200, 1400, 400], words(30), 24)]));
    expect(of((await check(flat)).issues, "topic_title")).toEqual([]);
  });

  it("a slide checked by itself knows its place in the deck: the first is still the title", async () => {
    const d = deck(slide(0, "Opening", (x0) => [txt(x0, "Title", [120, 100, 1400, 86], "Bench nights", 64), txt(x0, "Body", [120, 300, 1400, 120], words(12), 24)]), content(1, "Q3 results"));
    const [first, second] = (d.children![0]!.children![0]!.children!) as N[];
    expect(of((await check(first!)).issues, "topic_title")).toEqual([]);
    expect(pairs((await check(second!)).issues, "topic_title")).toEqual(["Headline:info"]);
  });
});

describe("two_focal", () => {
  it("two texts at the slide's top size compete; one headline set as two stacked texts does not", async () => {
    const competing = deck(title(), slide(1, "Two", (x0) => [
      txt(x0, "Left", [100, 100, 800, 86], "Members fix their own bikes", 72),
      txt(x0, "Right", [1000, 100, 800, 82], "Mechanics teach on Tuesdays", 68),
      txt(x0, "Body", [100, 400, 1600, 200], words(30), 24),
    ]));
    const found = of((await check(competing)).issues, "two_focal");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["Two:info"]);
    expect(found[0]!.detail).toMatch(/both at its largest size \(72 and 68 px\): two headlines compete/);
    const stacked = deck(title(), slide(1, "One", (x0) => [
      txt(x0, "Line 1", [100, 100, 1200, 86], "Members fix their own bikes", 72),
      txt(x0, "Line 2", [100, 190, 1200, 86], "and teach each other", 72),
      txt(x0, "Body", [100, 400, 1600, 200], words(30), 24),
    ]));
    expect(of((await check(stacked)).issues, "two_focal")).toEqual([]);
  });

  it("two blocks of near one size with nothing else as large compete; a row of three equal cards, or one dominant picture, does not", async () => {
    const pair = deck(title(), content(1, undefined, (x0) => [rect(x0, "Before", [100, 450, 800, 600]), rect(x0, "After", [1000, 450, 780, 600])]));
    const found = of((await check(pair)).issues, "two_focal");
    expect(found[0]!.detail).toMatch(/its two largest blocks, "Before" and "After", are within 12 % of each other/);
    const row = deck(title(), content(1, undefined, (x0) => [rect(x0, "A", [100, 450, 560, 560]), rect(x0, "B", [700, 450, 560, 560]), rect(x0, "C", [1300, 450, 560, 560])]));
    expect(of((await check(row)).issues, "two_focal")).toEqual([]);
    const lead = deck(title(), content(1, undefined, (x0) => [rect(x0, "Hero", [100, 450, 1200, 600]), rect(x0, "Inset", [1400, 450, 400, 300])]));
    expect(of((await check(lead)).issues, "two_focal")).toEqual([]);
  });
});

describe("repeated_skeleton", () => {
  const same = (i: number, x = 1100) => content(i, undefined, (x0) => [rect(x0, "Picture", [x, 500, 700, 500])]);

  it("three consecutive content slides on one structure: one info on the first of the run", async () => {
    const d = deck(title(), same(1), same(2), same(3));
    const found = of((await check(d)).issues, "repeated_skeleton");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["Slide 2:info"]);
    expect(found[0]!.detail).toMatch(/starts 3 consecutive content slides \("Slide 2", "Slide 3", "Slide 4"\) built on one structure: their 3 blocks/);
  });

  it("a block moved, or a section slide between them, breaks the run", async () => {
    expect(of((await check(deck(title(), same(1), same(2, 200), same(3)))).issues, "repeated_skeleton")).toEqual([]);
    const section = slide(3, "Slide 4", (x0) => [txt(x0, "Section", [120, 400, 1400, 120], "Part two", 96)]);
    expect(of((await check(deck(title(), same(1), same(2), section, same(4), same(5)))).issues, "repeated_skeleton")).toEqual([]);
  });

  it("is judged over the deck, so a batch of its slides checked one by one reports it, each time the same", async () => {
    const d = deck(title(), same(1), same(2), same(3));
    const slides = d.children![0]!.children![0]!.children! as N[];
    const found = (await check(slides[3]!)).issues.filter((i) => i.kind === "repeated_skeleton");
    expect(found.map((i) => i.nodeId)).toEqual([slides[1]!.id]);
  });
});

describe("bullets_dense", () => {
  const list = (n: number, lines: number) => {
    const items = Array.from({ length: n }, (_, i) => `• Item ${i + 1}`).join("\n");
    return deck(title(), slide(1, "List", (x0) => [txt(x0, "Headline", [120, 100, 1400, 86], "Three habits keep a bike on the road", 64), txt(x0, "Bullets", [120, 300, 1400, lines * 28.8], items, 24)]));
  };

  it("more than five items, or items running past two lines, is info; four one-line items or a plain paragraph is not", async () => {
    const many = of((await check(list(7, 7))).issues, "bullets_dense");
    expect(many.map((i) => `${i.name}:${i.severity}`)).toEqual(["Bullets:info"]);
    expect(many[0]!.detail).toMatch(/is a list of 7 items, more than the 5 a slide can carry/);
    const long = of((await check(list(3, 9))).issues, "bullets_dense");
    expect(long[0]!.detail).toMatch(/sets about 9 lines for 3 paragraphs, so at least one item runs past 2 lines/);
    expect(of((await check(list(4, 4))).issues, "bullets_dense")).toEqual([]);
    const prose = deck(title(), slide(1, "Prose", (x0) => [txt(x0, "Para", [120, 300, 1400, 10 * 28.8], words(80), 24)]));
    expect(of((await check(prose)).issues, "bullets_dense")).toEqual([]);
  });

  it("Figma's own list formatting counts as a list", async () => {
    const items = Array.from({ length: 6 }, (_, i) => `Item ${i + 1}`).join("\n");
    const seg = () => [{ start: 0, end: items.length, characters: items, listOptions: { type: "UNORDERED" } }];
    const d = deck(title(), slide(1, "List", (x0) => [txt(x0, "Bullets", [120, 300, 1400, 6 * 28.8], items, 24, { getStyledTextSegments: seg })]));
    expect(of((await check(d)).issues, "bullets_dense").map((i) => i.name)).toEqual(["Bullets"]);
  });
});

describe("notes_missing", () => {
  it("with details.notes, a presented slide with empty notes is info; one with notes, or a skipped one, is not; unreadable notes are said", async () => {
    const d = deck(
      slide(0, "Opening", (x0) => [txt(x0, "Title", [120, 400, 1400, 120], "Bench", 96)], { speakerNotes: "- welcome" }),
      slide(1, "Bare", (x0) => [txt(x0, "Title", [120, 400, 1400, 120], "Prices", 96)], { speakerNotes: "  " }),
      slide(2, "Skipped", (x0) => [txt(x0, "Title", [120, 400, 1400, 120], "Spare", 96)], { speakerNotes: "", isSkippedSlide: true }),
      slide(3, "Old build", (x0) => [txt(x0, "Title", [120, 400, 1400, 120], "Close", 96)]),
    );
    const r = await check(d, brief({ room: "projected", notes: true }));
    expect(pairs(r.issues, "notes_missing")).toEqual(["Bare:info"]);
    expect(of(r.issues, "deck_unmeasured")[0]!.detail).toMatch(/notes_missing on 1 slide \(this Figma build does not expose speaker notes\)/);
    expect(of((await check(d, brief({ room: "projected" }))).issues, "notes_missing")).toEqual([]);
  });

  it("Design frames carry no notes: not measured, and said", async () => {
    const f = mk("FRAME", "Pitch 1", [0, 0, 1920, 1080], { fills: white }, [txt(0, "T", [100, 100, 1400, 120], "Bench", 96)]);
    mk("PAGE", "P", [0, 0, 0, 0], {}, [f]);
    const r = await check(f, brief({ room: "projected", notes: true }));
    expect(of(r.issues, "notes_missing")).toEqual([]);
    expect(of(r.issues, "deck_unmeasured")[0]!.detail).toMatch(/a frame in Figma Design carries no speaker notes/);
  });
});

describe("the floor (min_text)", () => {
  const small = () => deck(slide(0, "Opening", (x0) => [txt(x0, "Title", [120, 100, 1400, 120], "Bench nights for members", 96), txt(x0, "Caption", [120, 900, 900, 48], "Photo by the club", 40), txt(x0, "Body", [120, 500, 1400, 72], "Every Tuesday, seven to nine", 64)]));

  it("a projected deck with no floor in the brief reads at 60 px on a 1920 slide: under it is a warning; a screen deck has none", async () => {
    const found = of((await check(small(), brief({ room: "projected" }))).issues, "min_text");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["Caption:warning"]);
    expect(found[0]!.detail).toMatch(/is 40 px, under this slide's floor of 60 px \(a projected deck's floor when the brief gives none: Kawasaki's 30 pt minimum, at 2 px per pt/);
    expect(of((await check(small(), brief({ room: "both" }))).issues, "min_text")).toHaveLength(1);
    expect(of((await check(small(), brief({ room: "screen" }))).issues, "min_text")).toEqual([]);
    expect(DECK.projectedFloor).toBe(60);
  });

  it("the brief's own floor wins; with craft running too, craft reports it once", async () => {
    const own = brief({ room: "projected" }, { lines: { goal: "g", message: "m", success: ["s"], minTextSize: 36 } });
    expect(of((await check(small(), own)).issues, "min_text")).toEqual([]);
    const higher = brief({ room: "screen" }, { lines: { goal: "g", message: "m", success: ["s"], minTextSize: 48 } });
    const deckOnly = of((await check(small(), higher)).issues, "min_text");
    expect(deckOnly.map((i) => i.name)).toEqual(["Caption"]);
    expect(deckOnly[0]!.detail).toMatch(/\(the brief's minTextSize\)/);
    const both = of((await check(small(), higher, ["craft", "deck"])).issues, "min_text");
    expect(both).toHaveLength(1);
    expect(both[0]!.detail).not.toMatch(/the brief's minTextSize\)/);
  });

  it("without a brief: no floor, and said once", async () => {
    const r = await check(small());
    expect(of(r.issues, "min_text")).toEqual([]);
    expect(of(r.issues, "deck_unmeasured")[0]!.detail).toMatch(/the min_text floor and notes_missing \(no brief was given/);
  });
});

describe("a deck in Figma Design", () => {
  it("1920 × 1080 frames read in reading order, whatever their layer order: the leftmost is the title", async () => {
    const frame = (x: number, name: string, head: string) => mk("FRAME", name, [x, 0, 1920, 1080], { fills: white }, [
      txt(x, "Headline", [120, 100, 1400, 86], head, 64),
      txt(x, "Body", [120, 300, 1400, 120], words(12), 24),
    ]);
    const page = mk("PAGE", "Pitch", [0, 0, 0, 0], {}, [frame(4000, "Third", "Q4 plan"), frame(0, "First", "Q3 results"), frame(2000, "Second", "Q3 numbers")]);
    const found = of((await check(page)).issues, "topic_title");
    expect(found.map((i) => i.detail.match(/heads the slide "([^"]+)"/)![1])).toEqual(["Third", "Second"]);
  });
});

describe("the brief through figma_check_layout { briefId }", () => {
  const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });

  it("reads the room and the budget off the record, and without it measures with the screen budget", async () => {
    const d = deck(title(), slide(1, "Dense", (x0) => [txt(x0, "Body", [120, 100, 1600, 600], words(50), 24)]));
    const record = JSON.stringify(brief({ room: "projected", maxWords: 45 }));
    const block = mk("FRAME", "Brief · Member night", [0, 2000, 720, 400], {
      getSharedPluginData: (ns: string, key: string) => (ns === BRIEF_NAMESPACE && key === BRIEF_KEY ? record : ""),
    });
    const nodes = [d, block];
    (globalThis as { figma?: unknown }).figma = {
      currentPage: mk("PAGE", "Other", [0, 0, 0, 0], { selection: [] }),
      getNodeByIdAsync: async (id: string) => nodes.find((n) => n.id === id) ?? null,
    };
    type Out = { ok: boolean; issues: Issue[]; audit: { ran: string[]; brief: unknown } };
    const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: d.id, audit: ["deck"], briefId: block.id }))) as Out;
    expect(r.audit.brief).toMatchObject({ id: "9:3", role: "presentation" });
    expect(pairs(r.issues, "slide_words")).toEqual(["Dense:warning"]);
    expect(r.ok).toBe(false);
    const plain = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: d.id, audit: ["deck"] }))) as Out;
    expect(of(plain.issues, "slide_words")).toEqual([]);
    expect(plain.audit.brief).toMatch(/and deck skips what needs the brief's numbers \(pass briefId\)/);
    expect(plain.ok).toBe(true);
  });
});
