// figma_check_layout { audit: ["tells"] }: the census of the generated look
// [C-217] [C-218] [C-219] [C-220] — each rule on a fixture that should fire,
// one that should not, and the boundary. Every tell is info until
// spikes/calibrate-tells.mjs shows it separates generic from finished work
// [C-248]. Plus the always-on placeholder_text, which now also knows stand-in
// people, brands and domains. The kinds of the role quality plan's W2
// (2026-10-20) close the file: sameness, the dashboard kit, second-order
// defaults, the clusters, and a fixture shaped like a product settings page.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHECK_OPS, checkLayout, type AuditKind } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { REFLEX_DISPLAY_FACES, reflexFace } from "../src/plugin/tells.js";
import { TELL_KINDS_MEASURED, TELL_KINDS_PLANNED } from "../src/shared/tells-kinds.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `6:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const solid = (hex: string) => {
  const v = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [{ type: "SOLID", color: { r: v(1), g: v(3), b: v(5) } }];
};
const rgb = (hex: string) => solid(hex)[0]!.color;
const ink = solid("#111111");
const white = solid("#ffffff");
function txt(name: string, box: [number, number, number, number], chars: string, size: number, props: Record<string, unknown> = {}): N {
  return mk("TEXT", name, box, { characters: chars, fontName: { family: "Inter", style: "Regular" }, fontSize: size, fills: ink, ...props });
}
const LONG = "Wood-fired stoneware thrown by hand in small batches, glazed with ash from the kiln itself.";
/** Body copy: one line of 16 px Inter carrying most of the characters, so it sets the body size. */
const body = (name: string, y: number, chars = LONG) => txt(name, [0, y, 900, 19], chars, 16);
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const check = (root: N, audit: AuditKind[] = ["tells"]) => checkLayout(root as never, 3000, noYield, { audit: new Set(audit) });
const of = (issues: Array<{ kind: string; name: string; severity: string; detail: string }>, kind: string) => issues.filter((i) => i.kind === kind);

describe("type tells", () => {
  it("default_typeface: one default family in two styles or fewer, named on the root", async () => {
    const f = mk("FRAME", "Pricing", [0, 0, 1440, 900], {}, [
      txt("Head", [0, 0, 900, 58], "Plans for every team", 48, { fontName: { family: "Inter", style: "Bold" } }),
      body("P1", 100),
      body("P2", 140),
    ]);
    const found = of((await check(f)).issues, "default_typeface");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Pricing", severity: "info" });
    expect(found[0]!.detail).toMatch(/every text is Inter, in 2 styles \(Bold, Regular\)/);
    // A second family, a third style, or too few texts to say anything.
    const georgia = mk("FRAME", "F", [0, 0, 1440, 900], {}, [...f.children!.map((c) => ({ ...c })), txt("Serif", [0, 300, 400, 30], "Ash", 24, { fontName: { family: "Georgia", style: "Regular" } })]);
    expect(of((await check(georgia)).issues, "default_typeface")).toEqual([]);
    const three = mk("FRAME", "F", [0, 0, 1440, 900], {}, [...f.children!.map((c) => ({ ...c })), txt("M", [0, 300, 400, 30], "Ash", 24, { fontName: { family: "Inter", style: "Medium" } })]);
    expect(of((await check(three)).issues, "default_typeface")).toEqual([]);
    expect(of((await check(mk("FRAME", "F", [0, 0, 1440, 900], {}, [body("A", 0), body("B", 40)]))).issues, "default_typeface")).toEqual([]);
  });

  it("flat_hierarchy: largest ÷ body under 2 on a frame 1080 wide or more, under 1.6 elsewhere", async () => {
    const page = (width: number, display: number) =>
      mk("FRAME", "Page", [0, 0, width, 900], {}, [txt("Display", [0, 0, 380, display * 1.2], "Ash", display), body("P1", 200), body("P2", 240)]);
    const wide = of((await check(page(1440, 24))).issues, "flat_hierarchy");
    expect(wide).toHaveLength(1);
    expect(wide[0]).toMatchObject({ name: "Display", severity: "info" });
    expect(wide[0]!.detail).toMatch(/largest text at 24 px, 1\.50× the 16 px body; a frame 1080 px or wider wants 2× or more/);
    expect(of((await check(page(1440, 32))).issues, "flat_hierarchy")).toEqual([]); // exactly 2
    expect(of((await check(page(390, 24))).issues, "flat_hierarchy")[0]!.detail).toMatch(/wants 1\.6× or more/);
    expect(of((await check(page(390, 26))).issues, "flat_hierarchy")).toEqual([]);
  });

  it("too_many_sizes: more than six distinct sizes", async () => {
    const sizes = (list: number[]) => mk("FRAME", "F", [0, 0, 1440, 2000], {}, [body("P", 0), ...list.map((s, i) => txt(`S${s}`, [0, 100 + i * 60, 300, s * 1.2], "Ash", s))]);
    const found = of((await check(sizes([12, 14, 18, 20, 24, 32]))).issues, "too_many_sizes"); // with the body's 16: seven
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/uses 7 text sizes \(12, 14, 16, 18, 20, 24, 32 px\)/);
    expect(of((await check(sizes([12, 14, 18, 20, 24]))).issues, "too_many_sizes")).toEqual([]);
  });

  it("centred_block and mostly_centred: centred multi-line text", async () => {
    const block = (align: string, lines: number, extra: N[] = []) =>
      mk("FRAME", "Hero", [0, 0, 1440, 900], {}, [txt("Lede", [0, 0, 600, lines * 19.2], LONG, 16, { textAlignHorizontal: align }), ...extra]);
    const r = await check(block("CENTER", 3));
    expect(of(r.issues, "centred_block").map((i) => i.name)).toEqual(["Lede"]);
    expect(of(r.issues, "centred_block")[0]!.detail).toMatch(/centred block of about 3 lines/);
    expect(of(r.issues, "mostly_centred")[0]!.detail).toMatch(/^100% of the multi-line text is centred/);
    const two = await check(block("CENTER", 2));
    expect(of(two.issues, "centred_block")).toEqual([]);
    expect(of(two.issues, "mostly_centred")).toHaveLength(1);
    expect((await check(block("LEFT", 4))).issues.filter((i) => i.kind.includes("centred"))).toEqual([]);
    // A short centred block beside a long left one: under half the characters.
    const mixed = block("CENTER", 2, [txt("Story", [0, 100, 600, 77], LONG + LONG + LONG, 16)]);
    expect(of((await check(mixed)).issues, "mostly_centred")).toEqual([]);
  });

  it("eyebrow_everywhere: a small tracked caps label right above most headings", async () => {
    const tracked = { letterSpacing: { unit: "PERCENT", value: 10 } };
    const section = (eyebrowProps: Record<string, unknown>, next: N) =>
      mk("FRAME", "Section", [0, 0, 1440, 900], {}, [txt("Eyebrow", [0, 0, 200, 14], "FEATURES", 12, eyebrowProps), next, body("P1", 200), body("P2", 240)]);
    const heading = () => txt("Heading", [0, 30, 800, 48], "Built for speed", 40);
    const found = of((await check(section(tracked, heading()))).issues, "eyebrow_everywhere");
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/^1 of 1 heading has a small tracked all-caps label/);
    // Upper case by text case counts too; the heading may sit inside a group.
    const group = mk("FRAME", "Head group", [0, 30, 800, 100], {}, [heading()]);
    expect(of((await check(section({ ...tracked, characters: "Features", textCase: "UPPER" }, group))).issues, "eyebrow_everywhere")).toHaveLength(1);
    expect(of((await check(section({}, heading()))).issues, "eyebrow_everywhere")).toEqual([]); // not tracked
    // Card titles a step over the body are not section headings: they do not dilute the ratio.
    const withCards = section(tracked, heading());
    for (const [i, x] of [0, 320, 640].entries()) {
      const t = txt(`Card title ${i}`, [x, 400, 280, 24], "Fast setup", 20);
      t.parent = withCards;
      withCards.children!.push(t);
    }
    expect(of((await check(withCards)).issues, "eyebrow_everywhere")[0]!.detail).toMatch(/^1 of 1 heading/);
    expect(of((await check(section(tracked, body("Next", 30, "Short")))).issues, "eyebrow_everywhere")).toEqual([]); // not over a heading
  });

  it("measure: body text outside 45–90 characters per line [C-210]", async () => {
    const para = (chars: string, lines: number) =>
      mk("FRAME", "F", [0, 0, 1440, 900], {}, [txt("Para", [0, 0, 600, lines * 21.6], chars, 16, { lineHeight: { unit: "PERCENT", value: 135 } })]);
    const wide = of((await check(para("x".repeat(600), 5))).issues, "measure");
    expect(wide).toHaveLength(1);
    expect(wide[0]!.detail).toMatch(/about 133 characters per line over 5 lines.*Narrow its column/);
    expect(of((await check(para("x".repeat(150), 5))).issues, "measure")[0]!.detail).toMatch(/about 33 characters .*Widen/);
    expect(of((await check(para("x".repeat(300), 5))).issues, "measure")).toEqual([]);
    expect(of((await check(para("x".repeat(600), 2))).issues, "measure")).toEqual([]); // two lines say too little
  });

  it("leading: body line height outside 1.2–1.45× [C-210]", async () => {
    const para = (lineHeight: Record<string, unknown>, height: number) =>
      mk("FRAME", "F", [0, 0, 1440, 900], {}, [txt("Para", [0, 0, 600, height], LONG, 16, { lineHeight })]);
    const tight = of((await check(para({ unit: "PIXELS", value: 16 }, 48))).issues, "leading");
    expect(tight).toHaveLength(1);
    expect(tight[0]!.detail).toMatch(/body text at 1\.00× line height; body reads best at 1\.2–1\.45×/);
    expect(of((await check(para({ unit: "PIXELS", value: 22.4 }, 67.2))).issues, "leading")).toEqual([]);
    expect(of((await check(para({ unit: "PIXELS", value: 23.2 }, 69.6))).issues, "leading")).toEqual([]); // 1.45: the boundary
    expect(of((await check(para({ unit: "AUTO" }, 57.6))).issues, "leading")).toEqual([]); // AUTO depends on the face
    expect(of((await check(para({ unit: "PIXELS", value: 16 }, 16))).issues, "leading")).toEqual([]); // one line
  });
});

describe("layout tells", () => {
  const card = (name: string, x: number, height = 200, contents?: N[]) =>
    mk("FRAME", name, [x, 0, 300, height], { fills: white, cornerRadius: 12, layoutMode: "VERTICAL" }, contents ?? [
      mk("VECTOR", "Icon", [x + 24, 24, 24, 24], { strokes: ink }),
      txt("Title", [x + 24, 64, 252, 24], "Fast setup", 20),
      txt("Body", [x + 24, 96, 252, 38], "Connect your kiln log in minutes.", 16),
    ]);
  const row = (cards: N[]) => mk("FRAME", "Features", [0, 0, 1440, 400], { layoutMode: "HORIZONTAL" }, cards);

  it("card_trio: three or more identical icon + title + text siblings", async () => {
    const found = of((await check(row([card("A", 0), card("B", 320), card("C", 640)]))).issues, "card_trio");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "A", severity: "info" });
    expect(found[0]!.detail).toMatch(/^"A", "B", "C" are 3 identical cards of icon \+ title \+ text/);
    expect(of((await check(row([card("A", 0), card("B", 320), card("C", 640), card("D", 960)]))).issues, "card_trio")[0]!.detail).toMatch(/and 1 more are 4 identical/);
  });

  it("not when one card differs, there is no icon, or the media is large", async () => {
    expect(of((await check(row([card("A", 0), card("B", 320, 260), card("C", 640)]))).issues, "card_trio")).toEqual([]);
    const textOnly = (n: string, x: number) => card(n, x, 200, [txt("Title", [x, 0, 252, 24], "Fast", 20), txt("Body", [x, 30, 252, 19], "Copy", 16)]);
    expect(of((await check(row([textOnly("A", 0), textOnly("B", 320), textOnly("C", 640)]))).issues, "card_trio")).toEqual([]);
    const media = (n: string, x: number) => card(n, x, 200, [mk("RECTANGLE", "Photo", [x, 0, 300, 160], { fills: ink }), txt("T", [x, 170, 252, 24], "Vase", 20), txt("B", [x, 194, 252, 19], "$48", 16)]);
    expect(of((await check(row([media("A", 0), media("B", 320), media("C", 640)]))).issues, "card_trio")).toEqual([]);
  });

  it("nested_cards: a filled, rounded card inside another", async () => {
    const inner = (props: Record<string, unknown>, box: [number, number, number, number] = [40, 40, 400, 200]) =>
      mk("FRAME", "Inner", box, { fills: solid("#f4f4f4"), cornerRadius: 12, ...props }, [txt("T", [60, 60, 200, 19], "Copy", 16)]);
    const outer = (child: N) => mk("FRAME", "Root", [0, 0, 1440, 900], {}, [mk("FRAME", "Outer", [0, 0, 600, 400], { fills: white, cornerRadius: 16 }, [child])]);
    const found = of((await check(outer(inner({})))).issues, "nested_cards");
    expect(found.map((i) => i.name)).toEqual(["Inner"]);
    expect(found[0]!.detail).toMatch(/inside the card "Outer"/);
    expect(of((await check(outer(inner({}, [40, 40, 100, 30])))).issues, "nested_cards")).toEqual([]); // a chip
    expect(of((await check(outer(inner({ fills: [] })))).issues, "nested_cards")).toEqual([]);
    expect(of((await check(outer(inner({ cornerRadius: 0 })))).issues, "nested_cards")).toEqual([]);
  });
});

describe("surface tells", () => {
  it("one_radius: one radius on four or more painted containers; pills are a shape of their own", async () => {
    const rects = (radii: number[]) => mk("FRAME", "F", [0, 0, 1440, 900], {}, radii.map((r, i) => mk("RECTANGLE", `R${i}`, [i * 120, 0, 100, 100], { fills: ink, cornerRadius: r })));
    const found = of((await check(rects([12, 12, 12, 12]))).issues, "one_radius");
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/^4 containers all have radius 12/);
    expect(of((await check(rects([12, 12, 12, 8]))).issues, "one_radius")).toEqual([]);
    expect(of((await check(rects([12, 12, 12]))).issues, "one_radius")).toEqual([]);
    expect(of((await check(rects([12, 12, 12, 12, 50, 50]))).issues, "one_radius")[0]!.detail).toMatch(/^4 containers/); // the pills do not count
    expect(of((await check(rects([12, 12, 12, 50, 50]))).issues, "one_radius")).toEqual([]);
  });

  it("nested_radius: an inset child as round as its parent", async () => {
    const nest = (r: number, box: [number, number, number, number]) =>
      mk("FRAME", "Root", [0, 0, 1440, 900], {}, [mk("FRAME", "Card", [0, 0, 400, 300], { fills: white, cornerRadius: 16 }, [mk("RECTANGLE", "Photo", box, { fills: ink, cornerRadius: r })])]);
    const found = of((await check(nest(16, [12, 12, 376, 200]))).issues, "nested_radius");
    expect(found.map((i) => i.name)).toEqual(["Photo"]);
    expect(found[0]!.detail).toMatch(/radius 16 inside "Card" \(radius 16\), inset 12 px .*about 4/);
    expect(of((await check(nest(4, [12, 12, 376, 200]))).issues, "nested_radius")).toEqual([]);
    expect(of((await check(nest(16, [0, 0, 400, 200]))).issues, "nested_radius")).toEqual([]); // flush with the parent
  });

  it("same_shadow: one drop shadow on 80 % or more of the filled containers", async () => {
    const shadow = [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0 }];
    const cards = (withShadow: number, total: number) =>
      mk("FRAME", "F", [0, 0, 1440, 900], {}, Array.from({ length: total }, (_, i) => mk("RECTANGLE", `C${i}`, [i * 120, 0, 100, 100], { fills: white, ...(i < withShadow ? { effects: shadow } : {}) })));
    const found = of((await check(cards(4, 5))).issues, "same_shadow");
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/^4 of 5 filled containers carry the same drop shadow \(#000000 10% 0,4 blur 12\)/);
    expect(of((await check(cards(3, 5))).issues, "same_shadow")).toEqual([]);
    expect(of((await check(cards(2, 2))).issues, "same_shadow")).toEqual([]); // too few to be a habit
  });

  it("default_gradient: a blue-violet wash over a quarter of the frame or on a button", async () => {
    const grad = (a: string, b: string) => [{ type: "GRADIENT_LINEAR", gradientStops: [{ position: 0, color: { ...rgb(a), a: 1 } }, { position: 1, color: { ...rgb(b), a: 1 } }] }];
    const frame = (child: N) => mk("FRAME", "Hero", [0, 0, 1000, 1000], {}, [child]);
    const wash = of((await check(frame(mk("RECTANGLE", "Wash", [0, 0, 600, 600], { fills: grad("#6366f1", "#a855f7") })))).issues, "default_gradient");
    expect(wash).toHaveLength(1);
    expect(wash[0]!.detail).toMatch(/blue-violet gradient \(hue 239–271°\) over 36% of the frame/);
    expect(of((await check(frame(mk("RECTANGLE", "Wash", [0, 0, 600, 600], { fills: grad("#f97316", "#facc15") })))).issues, "default_gradient")).toEqual([]);
    const button = mk("FRAME", "Get started", [0, 0, 160, 48], { fills: grad("#6366f1", "#a855f7"), cornerRadius: 8 }, [txt("L", [20, 14, 120, 19], "Get started", 16)]);
    expect(of((await check(frame(button))).issues, "default_gradient")[0]!.detail).toMatch(/on a button/);
    expect(of((await check(frame(mk("RECTANGLE", "Chip", [0, 0, 100, 40], { fills: grad("#6366f1", "#a855f7") })))).issues, "default_gradient")).toEqual([]);
  });

  it("glow: a heavy blur or a radial gradient behind text", async () => {
    const hero = (blob: N, textBox: [number, number, number, number] = [500, 300, 400, 60]) =>
      mk("FRAME", "Hero", [0, 0, 1440, 900], {}, [blob, txt("Heading", textBox, "Fire and ash", 48)]);
    const blurred = (radius: number) => mk("ELLIPSE", "Blob", [400, 100, 600, 600], { fills: solid("#7c3aed"), effects: [{ type: "LAYER_BLUR", radius, visible: true }] });
    const found = of((await check(hero(blurred(120)))).issues, "glow");
    expect(found.map((i) => i.name)).toEqual(["Blob"]);
    expect(found[0]!.detail).toMatch(/a 120 px layer blur glows behind "Heading"/);
    expect(of((await check(hero(blurred(20)))).issues, "glow")).toEqual([]);
    expect(of((await check(hero(blurred(120), [1100, 800, 200, 40]))).issues, "glow")).toEqual([]); // nothing over it
    const radial = mk("RECTANGLE", "Aura", [0, 0, 1440, 900], { fills: [{ type: "GRADIENT_RADIAL", gradientStops: [] }] });
    expect(of((await check(hero(radial))).issues, "glow")[0]!.detail).toMatch(/^a radial gradient glows behind/);
  });
});

describe("icon and copy tells", () => {
  const rocket = String.fromCodePoint(0x1f680);
  const bolt = String.fromCodePoint(0x26a1);
  const texts = (list: string[]) => mk("FRAME", "F", [0, 0, 1440, 900], {}, list.map((s, i) => txt(`T${i}`, [0, i * 40, 600, 19], s, 16)));

  it("emoji_icon: an emoji opening a heading or a list line, or standing alone", async () => {
    const r = await check(texts([`${rocket} Fast setup`, `Fast ${rocket}`, "Included", `Features\n${bolt} Fast`]));
    expect(of(r.issues, "emoji_icon").map((i) => i.name)).toEqual(["T0", "T3"]);
    expect(of(r.issues, "emoji_icon")[1]!.detail).toMatch(/^starts a line with/);
    // Typographic marks a text face draws are not emoji; with VS16 they are.
    const check1 = String.fromCodePoint(0x2713);
    const star = String.fromCodePoint(0x2605);
    const vs16 = String.fromCodePoint(0xfe0f);
    const marks = await check(texts([`${check1} Included`, star.repeat(5), `${star}${vs16} Top pick`]));
    expect(of(marks.issues, "emoji_icon").map((i) => i.name)).toEqual(["T2"]);
  });

  it("chrome_string: meta strings, an arrow on a label, LABEL — fragment, and 01/02 numbering", async () => {
    const r = await check(texts(["Hand-thrown · Wood-fired · 32 cm", "Shop the collection →", "CRAFT — made by hand", "Wood-fired stoneware", "Craft — made by hand"]));
    expect(of(r.issues, "chrome_string").map((i) => i.name)).toEqual(["T0", "T1", "T2"]);
    expect(of(r.issues, "chrome_string")[0]!.detail).toMatch(/an "A · B · C" meta string/);
    expect(of(r.issues, "chrome_string")[1]!.detail).toMatch(/an arrow appended to a label/);
    expect(of(r.issues, "chrome_string")[2]!.detail).toMatch(/"LABEL — fragment"/);
    const numbered = of((await check(texts(["01", "02 — Glaze", "Kiln"]))).issues, "chrome_string");
    expect(numbered).toHaveLength(1);
    expect(numbered[0]).toMatchObject({ name: "F" });
    expect(numbered[0]!.detail).toMatch(/^2 texts are numbered 01, 02/);
    expect(of((await check(texts(["01", "Kiln", "2024"]))).issues, "chrome_string")).toEqual([]);
  });

  it("chrome_string: a clock time is a timetable, not 01/02 numbering", async () => {
    // The live ferry timetable of 2026-10-20: departures read as "numbered 01, 02, …".
    const ferry = ["07:20", "07:38", "07:20 Port Ellery to Marrow Island", "08:05 Marrow Island to Port Ellery"];
    expect(of((await check(texts(ferry))).issues, "chrome_string")).toEqual([]);
    // Seconds, the French "h", and a 12-hour time with or without minutes.
    expect(of((await check(texts(["07:20:15 Gate closes", "06h45 Boarding", "07 am Coffee", "09 p.m. Last sailing", "7:05 Arrival"]))).issues, "chrome_string")).toEqual([]);
    // Real numbering beside times is still counted, and only it.
    const mixed = of((await check(texts(["01 Book", "02 Board", "07:20", "07:38"]))).issues, "chrome_string");
    expect(mixed).toHaveLength(1);
    expect(mixed[0]!.detail).toMatch(/^2 texts are numbered 01, 02, … \("T0", "T1"\)/);
    // A word that only starts like "am" or "pm" is not a time.
    expect(of((await check(texts(["01 amber glaze", "02 pmma resin"]))).issues, "chrome_string")).toHaveLength(1);
  });

  it("divider_everywhere: a hairline rule after 70 % or more of the headings", async () => {
    const rule = (y: number) => mk("LINE", "Rule", [0, y, 400, 0], { strokes: ink, strokeWeight: 1 });
    const page = (ruled: boolean[]) =>
      mk("FRAME", "Page", [0, 0, 1440, 1200], {}, ruled.flatMap((r, i) => [
        txt(`H${i}`, [0, i * 300, 600, 38], "Section heading", 32),
        ...(r ? [rule(i * 300 + 50)] : []),
        body(`P${i}`, i * 300 + 70),
      ]));
    const found = of((await check(page([true, true]))).issues, "divider_everywhere");
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/^2 of 2 headings have a hairline rule right after them/);
    expect(of((await check(page([true, false]))).issues, "divider_everywhere")).toEqual([]);
    expect(of((await check(page([true]))).issues, "divider_everywhere")).toEqual([]); // one heading is not "everywhere"
  });
});

describe("placeholder_text knows stand-in people, brands and domains (always on)", () => {
  it("John Doe, Acme, Your Company, example.com — but not a word that merely starts like one", async () => {
    const f = mk("FRAME", "F", [0, 0, 1440, 900], {}, [
      txt("Byline", [0, 0, 400, 19], "Written by John Doe", 16),
      txt("Mail", [0, 40, 400, 19], "hello@example.com", 16),
      txt("Brand", [0, 80, 400, 19], "Trusted by Acme Inc.", 16),
      txt("Real", [0, 120, 400, 19], "Acmeville Pottery", 16),
      txt("Old", [0, 160, 400, 19], "Title", 16),
    ]);
    const found = of((await check(f, [])).issues, "placeholder_text");
    expect(found.map((i) => i.name)).toEqual(["Byline", "Mail", "Brand", "Old"]);
    expect(found[0]!.detail).toMatch(/^names "John Doe" — a template's stand-in/);
    expect(found[3]!.detail).toMatch(/^still reads "Title"/); // the old rule, unchanged
    expect(found.every((i) => i.severity === "info")).toBe(true);
  });
});

describe("the tells audit", () => {
  /** A page that is every generated cliché at once. */
  function generic(): N {
    const shadow = [{ type: "DROP_SHADOW", visible: true, color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0 }];
    const card = (n: string, x: number) =>
      mk("FRAME", n, [x, 400, 300, 200], { fills: white, cornerRadius: 12, effects: shadow }, [
        txt(`${n} icon`, [x + 24, 424, 24, 24], String.fromCodePoint(0x1f680), 20),
        txt(`${n} title`, [x + 24, 464, 252, 24], "Fast setup", 20),
        txt(`${n} body`, [x + 24, 496, 252, 38], "Connect everything in minutes.", 16, { textAlignHorizontal: "CENTER" }),
      ]);
    return mk("FRAME", "Landing", [0, 0, 1440, 900], { fills: [{ type: "GRADIENT_LINEAR", gradientStops: [{ position: 0, color: { ...rgb("#6366f1"), a: 1 } }, { position: 1, color: { ...rgb("#a855f7"), a: 1 } }] }] }, [
      txt("Eyebrow", [0, 0, 200, 14], "FEATURES", 12, { letterSpacing: { unit: "PERCENT", value: 10 } }),
      txt("Head", [0, 30, 900, 34], "Unlock seamless workflows", 28, { textAlignHorizontal: "CENTER" }),
      mk("FRAME", "Row", [0, 400, 1440, 200], { layoutMode: "HORIZONTAL" }, [card("A", 0), card("B", 320), card("C", 640), card("D", 960)]),
    ]);
  }

  it("reports nothing without the audit", async () => {
    const tells: readonly string[] = TELL_KINDS_MEASURED;
    expect((await check(generic(), [])).issues.filter((i) => tells.includes(i.kind))).toEqual([]);
  });

  it("cluster_4: the generic page matches the software kit on every feature; varied cards with no shadow do not", async () => {
    const found = of((await check(generic())).issues, "cluster_4");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Landing", severity: "info" });
    expect(found[0]!.detail).toMatch(
      /^matches cluster 4, the software kit, on 4 of 4 features: 4 cards of one size and radius \(300×200, radius 12\); one radius on every container \(12\); one soft grey shadow on each card \(#000000 10% 0,4 blur 12\); a gradient wash\./,
    );
    const varied = mk("FRAME", "Shop", [0, 0, 1440, 900], {}, [
      mk("RECTANGLE", "Big", [0, 0, 600, 400], { fills: ink }),
      mk("RECTANGLE", "Small", [620, 0, 300, 200], { fills: ink, cornerRadius: 4 }),
      body("P1", 500),
      body("P2", 540),
    ]);
    expect(of((await check(varied)).issues, "cluster_4")).toEqual([]);
  });

  it("with it, a generic page lights up, and every tell is info", async () => {
    const r = await check(generic());
    const kinds = new Set(r.issues.map((i) => i.kind));
    const expected = ["default_typeface", "flat_hierarchy", "card_trio", "one_radius", "same_shadow", "default_gradient", "emoji_icon", "mostly_centred"];
    for (const k of expected) expect(kinds, k).toContain(k);
    expect(r.issues.filter((i) => expected.includes(i.kind)).every((i) => i.severity === "info")).toBe(true);
  });

  it("the op accepts it next to the others, and still refuses an unknown audit by name", async () => {
    const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });
    const f = generic();
    (globalThis as { figma?: unknown }).figma = { currentPage: mk("PAGE", "P", [0, 0, 0, 0], { selection: [] }), getNodeByIdAsync: async () => f };
    try {
      const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: f.id, audit: ["fonts", "tells", "craft"] }))) as { audit: { ran: string[] }; ok: boolean; issues: Array<{ kind: string }> };
      expect(r.audit.ran).toEqual(["fonts", "tells", "craft"]);
      expect(r.issues.some((i) => i.kind === "card_trio")).toBe(true);
      await expect(CHECK_OPS.check_layout!.run(ctx({ nodeId: f.id, audit: ["tells", "vibes"] }))).rejects.toMatchObject({
        code: "INVALID_PARAM",
        message: expect.stringMatching(/tokens, names, fonts, board, craft, tells/),
      });
    } finally {
      delete (globalThis as { figma?: unknown }).figma;
    }
  });
});

// ── W2 (2026-10-20): the kinds the product redesign showed ─────────────────────

const accent = solid("#ff6900");
const vector = (name: string, box: [number, number, number, number], props: Record<string, unknown> = {}) =>
  mk("VECTOR", name, box, { strokes: ink, strokeWeight: 1.5, ...props });
/** An icon in a small filled square: a frame holding a vector half its size. */
const tile = (x: number, y: number, size = 40) =>
  mk("FRAME", "Tile", [x, y, size, size], { fills: solid("#fde8d8"), cornerRadius: 8 }, [vector("Icon", [x + size / 4, y + size / 4, size / 2, size / 2])]);
const opCtx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });

describe("sameness and structure", () => {
  it("skeleton_repeat: three or more sections of one frame on one structure", async () => {
    const cardIn = (x: number, y: number) =>
      mk("FRAME", "Card", [x, y, 400, 200], { fills: white, cornerRadius: 12 }, [txt("T", [x, y, 300, 24], "Kiln", 20), txt("B", [x, y + 30, 300, 19], "Ash", 16)]);
    const section = (name: string, y: number, media?: N) => mk("FRAME", name, [0, y, 1440, 600], { layoutMode: "VERTICAL" }, [
      txt(`${name} heading`, [0, y, 800, 48], "A heading", 40),
      txt(`${name} lede`, [0, y + 60, 800, 19], "A line of copy.", 16),
      media ?? mk("FRAME", "Row", [0, y + 100, 1440, 200], { layoutMode: "HORIZONTAL" }, [cardIn(0, y + 100), cardIn(420, y + 100), cardIn(840, y + 100)]),
    ]);
    const page = (third?: N) => mk("FRAME", "Landing", [0, 0, 1440, 1800], { layoutMode: "VERTICAL" }, [section("Features", 0), section("Pricing", 600), section("Proof", 1200, third)]);
    const found = of((await check(page())).issues, "skeleton_repeat");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Features", severity: "info" });
    expect(found[0]!.detail).toMatch(/^"Features", "Pricing", "Proof" — 3 sections of this frame — share one structure: the same 3 blocks in the same order/);
    // The third composed for its own content: a photo, not the card row.
    expect(of((await check(page(mk("RECTANGLE", "Photo", [0, 1300, 1440, 480], { fills: ink })))).issues, "skeleton_repeat")).toEqual([]);
    // Rows of a list are not sections: too short to be one.
    const list = mk("FRAME", "List", [0, 0, 1440, 900], { layoutMode: "VERTICAL" }, [0, 1, 2, 3].map((i) =>
      mk("FRAME", `Row ${i}`, [0, i * 64, 1440, 64], { layoutMode: "HORIZONTAL" }, [txt("Name", [0, i * 64, 300, 19], "Kiln log", 16), txt("When", [400, i * 64, 200, 19], "Today", 14), vector("Chevron", [1400, i * 64, 16, 16])])));
    expect(of((await check(list)).issues, "skeleton_repeat")).toEqual([]);
  });

  it("skeleton_repeat across the roots of one check: three views or more on one structure, whatever their card counts", async () => {
    const view = (name: string, x: number, cards = 3) => mk("FRAME", name, [x, 0, 1440, 900], { fills: solid("#141414") }, [
      mk("FRAME", "Header", [x, 0, 1440, 64], { layoutMode: "HORIZONTAL" }, [txt("Crumb", [x + 24, 20, 200, 19], "Settings", 16)]),
      txt("Heading", [x + 24, 96, 600, 29], name, 24),
      mk("FRAME", "Grid", [x + 24, 160, 1392, 400], { layoutMode: "HORIZONTAL", layoutWrap: "WRAP" }, Array.from({ length: cards }, (_, i) =>
        mk("FRAME", `Card ${i}`, [x + 24 + (i % 3) * 472, 160 + Math.floor(i / 3) * 196, 456, 180], { fills: solid("#1c1c1c"), cornerRadius: 16 }, [txt("T", [x + 40, 176, 300, 19], "Option", 16)]))),
    ]);
    const roots = [view("Appearance", 0), view("Approvals", 1500, 5), view("Workspaces", 3000, 4), view("Billing", 4500)];
    const byId = new Map<string, N>(roots.map((r) => [r.id, r]));
    (globalThis as { figma?: unknown }).figma = { currentPage: mk("PAGE", "P", [0, 0, 0, 0], { selection: [] }), getNodeByIdAsync: async (id: string) => byId.get(id) ?? null };
    try {
      type Out = { issues: Array<{ kind: string; name: string; severity: string; detail: string }> };
      const run = async (ids: string[]) => ((await CHECK_OPS.check_layout!.run(opCtx({ nodeIds: ids, audit: ["tells"] }))) as Out).issues;
      const found = of(await run(roots.map((r) => r.id)), "skeleton_repeat");
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ name: "Appearance", severity: "info" });
      expect(found[0]!.detail).toMatch(/^"Appearance", "Approvals", "Workspaces" and 1 more — 4 views in this check — share one structure: the same 3 blocks/);
      // Two views are not a template yet; a view composed for its own content breaks the run.
      expect(of(await run(roots.slice(0, 2).map((r) => r.id)), "skeleton_repeat")).toEqual([]);
      const usage = mk("FRAME", "Usage", [6000, 0, 1440, 900], {}, [
        txt("Heading", [6024, 96, 600, 29], "Usage", 24), mk("RECTANGLE", "Chart", [6024, 160, 1392, 400], { fills: ink }), body("Note", 600), body("Note 2", 640),
      ]);
      byId.set(usage.id, usage);
      expect(of(await run([roots[0]!.id, roots[1]!.id, usage.id]), "skeleton_repeat")).toEqual([]);
      // One root is judged on its own sections, never against itself.
      expect(of(await run([roots[0]!.id]), "skeleton_repeat")).toEqual([]);
    } finally {
      delete (globalThis as { figma?: unknown }).figma;
    }
  });

  it("flat_rhythm: fewer than three levels of gap, or sections no further apart than their insides", async () => {
    const card = (name: string, x: number, y: number, gap: number) => mk("FRAME", name, [x, y, 300, 120], { layoutMode: "VERTICAL", itemSpacing: gap }, [
      txt(`${name} title`, [x, y, 300, 24], "Kiln", 20),
      txt(`${name} body`, [x, y + 24 + gap, 300, 19], "Ash glaze", 16),
    ]);
    const section = (name: string, y: number, rowGap: number, inner: number) => mk("FRAME", name, [0, y, 1440, 200], { layoutMode: "HORIZONTAL", itemSpacing: rowGap }, [
      card(`${name} A`, 0, y, inner),
      card(`${name} B`, 300 + rowGap, y, inner),
    ]);
    const page = (sectionGap: number, rowGap: number, inner: number) => mk("FRAME", "Page", [0, 0, 1440, 400 + sectionGap], { layoutMode: "VERTICAL", itemSpacing: sectionGap }, [
      section("S1", 0, rowGap, inner),
      section("S2", 200 + sectionGap, rowGap, inner),
    ]);
    const flat = of((await check(page(16, 16, 16))).issues, "flat_rhythm");
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({ name: "Page", severity: "info" });
    expect(flat[0]!.detail).toMatch(/^its spacing has one level \(16 px\) across 7 auto-layouts; and its sections \("S1", …\) sit 16 px apart, under 1\.5× the 16 px gap inside them — the spacing forms no groups/);
    expect(of((await check(page(24, 24, 8))).issues, "flat_rhythm")[0]!.detail).toMatch(/^its spacing has 2 levels \(8, 24 px\) across 7 auto-layouts; and its sections/);
    expect(of((await check(page(64, 24, 8))).issues, "flat_rhythm")).toEqual([]);
    // Three levels, but the sections sit closer than the gap inside them.
    expect(of((await check(page(24, 32, 8))).issues, "flat_rhythm")[0]!.detail).toMatch(/^its sections \("S1", …\) sit 24 px apart, under 1\.5× the 32 px gap inside them/);
    // Bands spaced by their padding at gap 0: the padding is the space between them, and a level of its own.
    const padded = page(0, 24, 8);
    for (const s of padded.children!) Object.assign(s, { paddingTop: 32, paddingBottom: 32 });
    expect(of((await check(padded)).issues, "flat_rhythm")).toEqual([]);
    // Too few auto-layouts to say anything.
    expect(of((await check(section("S", 0, 16, 16))).issues, "flat_rhythm")).toEqual([]);
  });

  it("boxiness: most text in boxes below the frame, or boxes three deep", async () => {
    const box = (name: string, b: [number, number, number, number], kids: N[]) => mk("FRAME", name, b, { fills: white, strokes: solid("#e5e5e5"), strokeWeight: 1 }, kids);
    const boxed = mk("FRAME", "Settings", [0, 0, 1440, 900], {}, [
      txt("Title", [0, 0, 400, 29], "Settings", 24),
      box("Card 1", [0, 60, 600, 200], [body("Card 1 copy", 80)]),
      box("Card 2", [0, 300, 600, 200], [body("Card 2 copy", 320)]),
    ]);
    const found = of((await check(boxed)).issues, "boxiness");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Settings", severity: "info" });
    expect(found[0]!.detail).toMatch(/^96% of the text \(by characters\) sits inside filled or stroked boxes below the frame — containers doing the grouping/);
    const deep = mk("FRAME", "Settings", [0, 0, 1440, 900], {}, [
      body("Intro", 0), body("Intro 2", 40), body("Intro 3", 80),
      box("Panel", [0, 200, 800, 600], [box("Card", [20, 220, 600, 400], [box("Row", [40, 240, 400, 120], [txt("Label", [60, 260, 200, 19], "Theme", 16)])])]),
    ]);
    expect(of((await check(deep)).issues, "boxiness")[0]!.detail).toMatch(/^boxes nest 3 deep \("Panel" > "Card" > "Row"\)/);
    // A full-width band is ground, a chip is too small to be a box.
    const open = mk("FRAME", "Settings", [0, 0, 1440, 900], {}, [
      mk("FRAME", "Band", [0, 0, 1440, 300], { fills: solid("#f4f4f4") }, [body("Lede", 40), body("Lede 2", 80)]),
      body("P1", 400), body("P2", 440),
      mk("FRAME", "Chip", [0, 500, 80, 28], { fills: solid("#f4f4f4") }, [txt("Chip label", [8, 504, 64, 19], "Beta", 14)]),
    ]);
    expect(of((await check(open)).issues, "boxiness")).toEqual([]);
  });

  it("centred_stage: on an app screen, a small block centred both ways in its region", async () => {
    const app = (stage: N, extra: N[] = []) => mk("FRAME", "New chat", [0, 0, 1440, 900], { fills: solid("#141414") }, [
      mk("FRAME", "Sidebar", [0, 0, 240, 900], { fills: solid("#1c1c1c") }, [txt("Nav", [24, 24, 120, 19], "Chats", 16)]),
      mk("FRAME", "Main", [240, 0, 1200, 900], {}, [...extra, stage]),
    ]);
    const stage = (y = 350, name = "Stage") => mk("FRAME", name, [600, y, 480, 200], {}, [
      txt("Prompt", [600, y, 480, 38], "What are we building?", 32),
      txt("Hint", [600, y + 60, 480, 19], "Ask about a run, a file or a plan.", 16),
    ]);
    const found = of((await check(app(stage()))).issues, "centred_stage");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Stage", severity: "info" });
    expect(found[0]!.detail).toMatch(/^sits centred on both axes in "Main" \(1200×900\), at 9% of its area — the centred stage/);
    // On a phone too.
    const phone = mk("FRAME", "Home", [0, 0, 390, 844], {}, [mk("FRAME", "Empty", [95, 372, 200, 100], {}, [txt("Line", [95, 372, 200, 19], "Nothing here yet", 16)])]);
    expect(of((await check(phone)).issues, "centred_stage")).toHaveLength(1);
    expect(of((await check(app(stage(80)))).issues, "centred_stage")).toEqual([]); // anchored at the top
    // A poster is not an app screen.
    const poster = mk("FRAME", "Poster", [0, 0, 1080, 1350], {}, [mk("FRAME", "Block", [340, 575, 400, 200], {}, [txt("Head", [340, 575, 400, 38], "Open studio", 32)])]);
    expect(of((await check(poster)).issues, "centred_stage")).toEqual([]);
    // A dialog over a scrim centres by design.
    const scrim = mk("RECTANGLE", "Shade", [240, 0, 1200, 900], { fills: [{ type: "SOLID", color: rgb("#000000"), opacity: 0.32 }] });
    expect(of((await check(app(stage(350, "Confirm"), [scrim]))).issues, "centred_stage")).toEqual([]);
    // Words above it in its column: one block of a stack.
    expect(of((await check(app(stage(), [txt("Heading", [600, 40, 480, 38], "Runs", 32)]))).issues, "centred_stage")).toEqual([]);
  });
});

describe("the dashboard kit", () => {
  const tiled = (name: string, x: number, lead: N) => mk("FRAME", name, [x, 0, 300, 200], { fills: white, cornerRadius: 12, layoutMode: "VERTICAL" }, [
    lead,
    txt(`${name} title`, [x + 24, 80, 252, 24], "Appearance", 20),
    txt(`${name} body`, [x + 24, 112, 252, 38], "Theme, density and the accent colour.", 16),
  ]);
  const row = (cards: N[]) => mk("FRAME", "Settings", [0, 0, 1440, 400], { layoutMode: "HORIZONTAL" }, cards);

  it("icon_tile: most of three or more sibling cards start with an icon in a small filled square or circle", async () => {
    const found = of((await check(row([tiled("A", 0, tile(24, 24)), tiled("B", 320, tile(344, 24)), tiled("C", 640, tile(664, 24))]))).issues, "icon_tile");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "A", severity: "info" });
    expect(found[0]!.detail).toMatch(/^3 of 3 sibling cards \("A", "B", "C"\) start with an icon in a 40 px filled square — the icon tile/);
    // A filled disc with the icon over it, in a group; two of three is most.
    const disc = (x: number) => mk("GROUP", "Badge", [x, 24, 40, 40], {}, [mk("ELLIPSE", "Disc", [x, 24, 40, 40], { fills: solid("#fde8d8") }), vector("Icon", [x + 10, 34, 20, 20])]);
    const two = of((await check(row([tiled("A", 0, disc(24)), tiled("B", 320, disc(344)), tiled("C", 640, vector("Icon", [664, 24, 24, 24]))]))).issues, "icon_tile");
    expect(two[0]!.detail).toMatch(/^2 of 3 sibling cards .* 40 px filled circle/);
  });

  it("icon_tile: not for a bare icon, a large image, initials in a circle, or one tile in three", async () => {
    const bare = (x: number) => vector("Icon", [x + 24, 24, 24, 24]);
    expect(of((await check(row([tiled("A", 0, bare(0)), tiled("B", 320, bare(320)), tiled("C", 640, bare(640))]))).issues, "icon_tile")).toEqual([]);
    const photo = (x: number) => mk("FRAME", "Photo", [x + 24, 24, 96, 96], { fills: ink }, [vector("Mark", [x + 48, 48, 48, 48])]);
    expect(of((await check(row([tiled("A", 0, photo(0)), tiled("B", 320, photo(320)), tiled("C", 640, photo(640))]))).issues, "icon_tile")).toEqual([]);
    const avatar = (x: number) => mk("FRAME", "Avatar", [x + 24, 24, 40, 40], { fills: solid("#fde8d8"), cornerRadius: 20 }, [txt("Initials", [x + 32, 34, 24, 19], "AD", 14)]);
    expect(of((await check(row([tiled("A", 0, avatar(0)), tiled("B", 320, avatar(320)), tiled("C", 640, avatar(640))]))).issues, "icon_tile")).toEqual([]);
    expect(of((await check(row([tiled("A", 0, tile(24, 24)), tiled("B", 320, bare(320)), tiled("C", 640, bare(640))]))).issues, "icon_tile")).toEqual([]);
  });

  const stat = (name: string, x: number, figure: string, extra: N[] = []) => mk("FRAME", name, [x, 0, 300, 160], { fills: white, cornerRadius: 12, layoutMode: "VERTICAL" }, [
    ...extra,
    txt(`${name} label`, [x + 24, 72, 200, 17], name, 14),
    txt(`${name} figure`, [x + 24, 96, 200, 38], figure, 32),
  ]);
  const strip = (stats: N[]) => mk("FRAME", "Overview", [0, 0, 1440, 900], {}, [
    mk("FRAME", "KPIs", [0, 0, 1440, 160], { layoutMode: "HORIZONTAL" }, stats),
    body("Note", 300),
    body("Note 2", 340),
  ]);

  it("kpi_tile: three or more stat tiles in a row, each a big figure and a small label with an icon tile or a sparkline", async () => {
    const found = of((await check(strip([stat("Revenue", 0, "$48.2k", [tile(24, 24)]), stat("Users", 320, "1,284", [tile(344, 24)]), stat("Churn", 640, "2.1%", [tile(664, 24)])]))).issues, "kpi_tile");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Revenue", severity: "info" });
    expect(found[0]!.detail).toMatch(/^"Revenue", "Users", "Churn" are 3 KPI tiles side by side, each a 32 px figure over a 14 px label with an icon tile — the dashboard kit's stat strip/);
    const line = (x: number) => mk("VECTOR", "Trend", [x + 180, 24, 96, 32], { strokes: ink, strokeWeight: 2 });
    const bars = (x: number) => mk("FRAME", "Bars", [x + 180, 24, 96, 32], {}, [0, 1, 2, 3, 4].map((i) =>
      mk("RECTANGLE", `Bar ${i}`, [x + 180 + i * 20, 56 - (8 + i * 5), 12, 8 + i * 5], { fills: ink })));
    expect(of((await check(strip([stat("Runs", 0, "12", [line(0)]), stat("Tokens", 320, "48k", [bars(320)]), stat("Errors", 640, "7", [line(640)])]))).issues, "kpi_tile")[0]!.detail)
      .toMatch(/with a sparkline —/);
  });

  it("kpi_tile: not for figures set as plain type, or for two tiles", async () => {
    expect(of((await check(strip([stat("Revenue", 0, "$48.2k"), stat("Users", 320, "1,284"), stat("Churn", 640, "2.1%")]))).issues, "kpi_tile")).toEqual([]);
    expect(of((await check(strip([stat("Revenue", 0, "$48.2k", [tile(24, 24)]), stat("Users", 320, "1,284", [tile(344, 24)])]))).issues, "kpi_tile")).toEqual([]);
  });

  it("greeting_title: the top heading greets, in any case", async () => {
    const page = (title: string) => mk("FRAME", "Home", [0, 0, 1440, 900], {}, [txt("Title", [0, 0, 900, 48], title, 40), body("P1", 100), body("P2", 140)]);
    const found = of((await check(page("Welcome back, Anna"))).issues, "greeting_title");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Title", severity: "info" });
    expect(found[0]!.detail).toMatch(/^reads "Welcome back, Anna" — a greeting as the view's title/);
    for (const g of ["GOOD MORNING", "Hi Anna", "hello", "How can I help you today?"]) expect(of((await check(page(g))).issues, "greeting_title"), g).toHaveLength(1);
    for (const g of ["Runs", "Highlights", "History", "Welcomed by 40 studios"]) expect(of((await check(page(g))).issues, "greeting_title"), g).toEqual([]);
    // A greeting in the running text is not the title.
    const inBody = mk("FRAME", "Home", [0, 0, 1440, 900], {}, [
      txt("Title", [0, 0, 900, 48], "Runs", 40), body("P1", 100, "Hello from the studio, and thanks for trying the beta."), body("P2", 140),
    ]);
    expect(of((await check(inBody)).issues, "greeting_title")).toEqual([]);
  });

  it("accent_share: the accent spent on navigation and decoration, not on data or the action", async () => {
    const icon = (name: string, y: number) => mk("VECTOR", name, [24, y, 20, 20], { strokes: accent, strokeWeight: 1.5 });
    const screen = (main: N[], nav: N[]) => mk("FRAME", "Runs", [0, 0, 1440, 900], { fills: solid("#141414") }, [
      mk("FRAME", "Sidebar", [0, 0, 240, 900], { fills: solid("#1c1c1c") }, nav),
      mk("FRAME", "Main", [240, 0, 1200, 900], {}, main),
    ]);
    const button = () => mk("FRAME", "New run button", [1300, 24, 120, 40], { fills: accent, cornerRadius: 8 }, [txt("Label", [1316, 34, 88, 19], "New run", 16, { fills: white })]);
    const figure = () => txt("Total", [280, 120, 200, 38], "1,284", 32, { fills: accent });
    const nav = [icon("Home icon", 24), icon("Runs icon", 64), icon("Settings icon", 104), mk("ELLIPSE", "Dot", [200, 24, 8, 8], { fills: accent })];
    const found = of((await check(screen([button(), figure()], nav))).issues, "accent_share");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Runs", severity: "info" });
    expect(found[0]!.detail).toMatch(/^the accent #ff6900 paints 6 layers: 4 on chrome or decoration \("Home icon", "Runs icon", "Settings icon", …\), 1 on data and 1 on an action/);
    // On the data, the chart and the action, with one icon in the nav: under the share.
    const chart = mk("FRAME", "Chart", [280, 200, 600, 300], {}, [mk("RECTANGLE", "Bar", [300, 300, 40, 200], { fills: accent }), mk("RECTANGLE", "Bar 2", [360, 250, 40, 250], { fills: accent })]);
    expect(of((await check(screen([button(), figure(), chart], [icon("Home icon", 24)]))).issues, "accent_share")).toEqual([]);
  });
});

describe("second-order defaults", () => {
  it("hue_pair: a primary and an accent within about 20° of hue", async () => {
    const chips = (colors: string[]) => mk("FRAME", "Palette", [0, 0, 1440, 900], {}, colors.map((c, i) => mk("RECTANGLE", `Chip ${i}`, [i * 120, 0, 100, 100], { fills: solid(c) })));
    const found = of((await check(chips(["#ff6900", "#ff6900", "#ff6900", "#f59e0b", "#f59e0b"]))).issues, "hue_pair");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Palette", severity: "info" });
    expect(found[0]!.detail).toMatch(/^its two main colours, #ff6900 \(hue 25°, on 3 layers\) and #f59e0b \(hue 38°, on 2 layers\), are 13° of hue apart — one hue pretending to be two/);
    expect(of((await check(chips(["#ff6900", "#ff6900", "#ff6900", "#2563eb", "#2563eb"]))).issues, "hue_pair")).toEqual([]); // two hues
    expect(of((await check(chips(["#ff6900", "#ff6900", "#ff6900", "#ff7a1a", "#ff7a1a"]))).issues, "hue_pair")).toEqual([]); // one colour's ramp
    expect(of((await check(chips(["#ff6900", "#ff6900", "#ff6900", "#f59e0b"]))).issues, "hue_pair")).toEqual([]); // used once: not the system's
  });

  it("reflex_display_face: the display in a face from the dated reflex list", async () => {
    const page = (family: string, size = 64) => mk("FRAME", "Hero", [0, 0, 1440, 900], {}, [
      txt("Display", [0, 0, 900, size * 1.2], "Fire and ash", size, { fontName: { family, style: "Regular" } }),
      body("P1", 200),
      body("P2", 240),
    ]);
    const found = of((await check(page("Fraunces"))).issues, "reflex_display_face");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Display", severity: "info" });
    expect(found[0]!.detail).toMatch(/^sets the display in Fraunces at 64 px — a face generated work reaches for by reflex \(a dated list of such faces, 2026-10-20\)/);
    for (const f of ["Cormorant Garamond", "DM Serif Display", "IBM Plex Sans", "Inter", "Space Grotesk"]) expect(of((await check(page(f))).issues, "reflex_display_face"), f).toHaveLength(1);
    for (const f of ["Canela", "GT Sectra", "Interstate"]) expect(of((await check(page(f))).issues, "reflex_display_face"), f).toEqual([]);
    expect(of((await check(page("Fraunces", 18))).issues, "reflex_display_face")).toEqual([]); // not a display
  });

  it("the reflex list is dated, sits beside DEFAULT_FACES, and matches a family's cuts", () => {
    expect(REFLEX_DISPLAY_FACES).toContain("inter");
    expect(reflexFace("Crimson Pro")).toBe(true);
    expect(reflexFace("Loretta")).toBe(false);
    const src = readFileSync(new URL("../src/plugin/tells.ts", import.meta.url), "utf8");
    expect(src).toMatch(/export const DEFAULT_FACES[\s\S]{0,400}as of\s+\/?\/?\s*\*?\s*2026-10-20[\s\S]{0,1200}export const REFLEX_DISPLAY_FACES/);
  });
});

describe("the clusters, computed", () => {
  it("cluster_1: warm off-white, a serif display and clay", async () => {
    const ad = (ground: string, family: string, clay: string) => mk("FRAME", "Ad", [0, 0, 1080, 1350], { fills: solid(ground) }, [
      txt("Display", [80, 80, 900, 77], "Ash Vase", 64, { fontName: { family, style: "Regular" } }),
      body("P1", 300),
      body("P2", 340),
      mk("FRAME", "Shop button", [80, 1200, 200, 56], { fills: solid(clay), cornerRadius: 4 }, [txt("Label", [100, 1216, 160, 19], "Shop", 16, { fills: white })]),
    ]);
    const found = of((await check(ad("#fbf9f6", "Cormorant Garamond", "#a4532f"))).issues, "cluster_1");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Ad", severity: "info" });
    expect(found[0]!.detail).toMatch(/^matches cluster 1, warm off-white with a serif and clay, on 3 of 3 features: a warm off-white ground \(#fbf9f6\); a serif display \(Cormorant Garamond\); a clay accent \(#a4532f\)\./);
    expect(of((await check(ad("#ffffff", "Inter", "#2563eb"))).issues, "cluster_1")).toEqual([]);
  });

  it("cluster_2: near-black with one acid accent", async () => {
    const dark = (marks: string[]) => mk("FRAME", "Product", [0, 0, 1440, 900], { fills: solid("#141414") }, [
      txt("Title", [24, 24, 400, 29], "Runs", 24, { fills: white }),
      body("P1", 100),
      body("P2", 140),
      ...marks.map((c, i) => mk("RECTANGLE", `Mark ${i}`, [24 + i * 40, 300, 24, 24], { fills: solid(c) })),
    ]);
    expect(of((await check(dark(["#ff6900", "#ff6900", "#ff6900"]))).issues, "cluster_2")[0]!.detail).toMatch(
      /^matches cluster 2, near-black with one acid accent, on 3 of 3 features: a near-black ground \(#141414\); an acid green or vermilion accent \(#ff6900, hue 25°\); no other saturated colour\./,
    );
    expect(of((await check(dark(["#ff6900", "#ff6900", "#2563eb"]))).issues, "cluster_2")[0]!.detail).toMatch(/on 2 of 3 features/);
    expect(of((await check(dark(["#7c3aed", "#7c3aed", "#2563eb"]))).issues, "cluster_2")).toEqual([]);
  });

  it("cluster_3: the broadsheet — hairlines, square corners, narrow columns", async () => {
    const col = (name: string, x: number) => txt(name, [x, 200, 300, 5 * 21.6], "x".repeat(150), 16, { lineHeight: { unit: "PERCENT", value: 135 } });
    const paper = (r: number) => mk("FRAME", "Paper", [0, 0, 1440, 900], {}, [
      mk("LINE", "Rule", [0, 100, 1440, 0], { strokes: ink, strokeWeight: 1 }),
      mk("LINE", "Rule 2", [0, 180, 1440, 0], { strokes: ink, strokeWeight: 0.5 }),
      col("Col 1", 0), col("Col 2", 340), col("Col 3", 680),
      ...[0, 1, 2].map((i) => mk("RECTANGLE", `Plate ${i}`, [i * 340, 400, 300, 200], { fills: solid("#eeeeee"), cornerRadius: r })),
    ]);
    expect(of((await check(paper(0))).issues, "cluster_3")[0]!.detail).toMatch(
      /^matches cluster 3, the broadsheet, on 3 of 3 features: 2 strokes and rules, all 1 px or less; radius 0 on all 3 painted containers; 3 narrow columns of body text \(under 45 characters a line\)\./,
    );
    expect(of((await check(paper(12))).issues, "cluster_3")[0]!.detail).toMatch(/on 2 of 3 features/);
    const plain = mk("FRAME", "Page", [0, 0, 1440, 900], {}, [body("P1", 0), body("P2", 40), mk("RECTANGLE", "Card", [0, 200, 300, 200], { fills: white, cornerRadius: 12 })]);
    expect(of((await check(plain)).issues, "cluster_3")).toEqual([]);
  });

  it("cluster_5: template chrome", async () => {
    const tracked = { letterSpacing: { unit: "PERCENT", value: 10 } };
    const page = mk("FRAME", "Journal", [0, 0, 1440, 900], {}, [
      txt("Kicker", [0, 0, 200, 14], "FIELD NOTES", 12, tracked),
      txt("Head", [0, 30, 900, 48], "Wood and ash", 40),
      txt("Meta", [0, 100, 600, 19], "Hand-thrown · Wood-fired · 32 cm", 16),
      txt("Label", [0, 140, 600, 19], "CRAFT — made by hand", 16),
      txt("SKU", [0, 180, 200, 14], "SKU 2041", 12, { fontName: { family: "JetBrains Mono", style: "Regular" } }),
      txt("Link", [0, 220, 200, 19], "Read the story →", 16),
      body("P1", 300),
      body("P2", 340),
    ]);
    expect(of((await check(page)).issues, "cluster_5")[0]!.detail).toMatch(
      /^matches cluster 5, template chrome, on 6 of 6 features: tracked capital labels over headings; middle-dot meta strings; "WORD — fragment" labels; near-black or tinted text \(#111111\); small monospaced labels \(JetBrains Mono\); an arrow on links and buttons\./,
    );
    // Near-black ink alone is one feature, not a look.
    expect(of((await check(mk("FRAME", "Page", [0, 0, 1440, 900], {}, [txt("Head", [0, 0, 900, 48], "Wood and ash", 40), body("P1", 100), body("P2", 140)]))).issues, "cluster_5")).toEqual([]);
  });

  it("cluster_6: the dashboard kit", async () => {
    const kpi = (name: string, x: number, figure: string, kit: boolean) => mk("FRAME", name, [x, 120, 300, 160], { ...(kit ? { fills: white, cornerRadius: 12 } : {}), layoutMode: "VERTICAL" }, [
      ...(kit ? [tile(x + 24, 144)] : []),
      txt(`${name} label`, [x + 24, 192, 200, 17], name, 14),
      txt(`${name} figure`, [x + 24, 216, 200, 38], figure, 32, kit ? { fills: accent } : {}),
      ...(kit ? [txt(`${name} delta`, [x + 200, 216, 60, 17], "+12%", 14)] : []),
    ]);
    const shell = (sidebar: string, title: string, kit: boolean) => mk("FRAME", "Dashboard", [0, 0, 1440, 900], { fills: solid("#f8fafc") }, [
      mk("FRAME", "Sidebar", [0, 0, 240, 900], { fills: solid(sidebar) }, [txt("Nav", [24, 24, 120, 19], "Overview", 16)]),
      mk("FRAME", "Main", [240, 0, 1200, 900], {}, [
        txt("Title", [264, 40, 600, 38], title, 32),
        mk("FRAME", "KPIs", [264, 120, 1000, 160], { layoutMode: "HORIZONTAL" }, [kpi("Revenue", 264, "$48.2k", kit), kpi("Users", 584, "1,284", kit), kpi("Churn", 904, "2.1%", kit)]),
        body("Note", 400),
        body("Note 2", 440),
      ]),
    ]);
    const found = of((await check(shell("#1e293b", "Welcome back, Anna", true))).issues, "cluster_6");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: "Dashboard", severity: "info" });
    expect(found[0]!.detail).toMatch(
      /^matches cluster 6, the dashboard kit, on 5 of 7 features: a navy, slate or saturated sidebar \("Sidebar", #1e293b\); an icon tile on every card or KPI; big KPI values in the brand colour \(3 of 3\); a "\+%" pill or a sparkline on every KPI; a greeting title\./,
    );
    expect(of((await check(shell("#f8fafc", "Usage", false))).issues, "cluster_6")).toEqual([]);
  });
});

describe("a page shaped like a product settings page", () => {
  it("reports icon_tile, card_trio and flat_rhythm: a header, then a grid of identical cards each opening on an icon tile, 16 px gaps everywhere", async () => {
    const card = (name: string, i: number) => {
      const x = 24 + (i % 3) * 469;
      const y = 104 + Math.floor(i / 3) * 196;
      return mk("FRAME", name, [x, y, 453, 180], { fills: solid("#1c1c1c"), cornerRadius: 16, layoutMode: "VERTICAL", itemSpacing: 16, paddingTop: 16, paddingLeft: 16 }, [
        mk("FRAME", "Icon tile", [x + 16, y + 16, 40, 40], { fills: solid("#2a2a2a"), cornerRadius: 8 }, [vector("Icon", [x + 26, y + 26, 20, 20], { strokes: accent })]),
        txt(`${name} title`, [x + 16, y + 72, 421, 24], name, 18, { fills: white }),
        txt(`${name} body`, [x + 16, y + 112, 421, 38], "Choose how the product looks and behaves in this workspace.", 14, { fills: solid("#a3a3a3") }),
      ]);
    };
    const names = ["Appearance", "Approvals", "Workspaces", "Models", "Keys", "Billing"];
    const page = mk("FRAME", "Settings", [0, 0, 1440, 900], { fills: solid("#141414"), layoutMode: "VERTICAL", itemSpacing: 16, paddingTop: 24, paddingLeft: 24 }, [
      mk("FRAME", "Header", [24, 24, 1392, 64], { layoutMode: "HORIZONTAL", itemSpacing: 16 }, [
        txt("Heading", [24, 40, 400, 29], "Settings", 24, { fills: white }),
        mk("FRAME", "Save button", [1296, 36, 120, 40], { fills: accent, cornerRadius: 8 }, [txt("Save", [1316, 46, 80, 19], "Save", 16)]),
      ]),
      mk("FRAME", "Grid", [24, 104, 1392, 376], { layoutMode: "HORIZONTAL", layoutWrap: "WRAP", itemSpacing: 16, counterAxisSpacing: 16 }, names.map(card)),
    ]);
    const r = await check(page);
    const kinds = new Set(r.issues.map((i) => i.kind));
    for (const k of ["icon_tile", "card_trio", "flat_rhythm"]) expect(kinds, k).toContain(k);
    expect(of(r.issues, "icon_tile")[0]!.detail).toMatch(/^6 of 6 sibling cards \("Appearance", "Approvals", "Workspaces", …\) start with an icon in a 40 px filled square/);
    expect(of(r.issues, "card_trio")[0]!.detail).toMatch(/^"Appearance", "Approvals", "Workspaces" and 3 more are 6 identical cards of icon \+ title \+ text/);
    expect(of(r.issues, "flat_rhythm")[0]!.detail).toMatch(/^its spacing has one level \(16 px\) across 9 auto-layouts; and its sections \("Header", …\) sit 16 px apart/);
    // The rest of what the plan's table names is reported too: boxed cards, the accent on chrome, the near-black look.
    for (const k of ["boxiness", "accent_share", "cluster_2"]) expect(kinds, k).toContain(k);
    expect(of(r.issues, "accent_share")[0]!.detail).toMatch(/^the accent #ff6900 paints 7 layers: 6 on chrome or decoration \("Icon"\), 0 on data and 1 on an action/);
    // Every tell is info, and the fixture itself is clean: nothing but tells.
    const tells: readonly string[] = TELL_KINDS_MEASURED;
    expect(r.issues.every((i) => tells.includes(i.kind) && i.severity === "info"), JSON.stringify(r.issues.filter((i) => !tells.includes(i.kind)))).toBe(true);
  });
});

describe("the shared list of tells kinds", () => {
  it("tells.ts reports every measured kind, and none is left planned", () => {
    const src = readFileSync(new URL("../src/plugin/tells.ts", import.meta.url), "utf8");
    for (const k of TELL_KINDS_MEASURED) {
      const cluster = /^cluster_(\d)$/.exec(k);
      expect(cluster ? new RegExp(`\\{ n: ${cluster[1]}, name:`).test(src) && src.includes("`cluster_${look.n}`") : src.includes(`"${k}"`), k).toBe(true);
    }
    expect(TELL_KINDS_PLANNED).toEqual([]);
  });
});
