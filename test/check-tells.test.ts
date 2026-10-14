// figma_check_layout { audit: ["tells"] }: the census of the generated look
// [C-217] [C-218] [C-219] [C-220] — each rule on a fixture that should fire,
// one that should not, and the boundary. Every tell is info until
// spikes/calibrate-tells.mjs shows it separates generic from finished work
// [C-248]. Plus the always-on placeholder_text, which now also knows stand-in
// people, brands and domains.

import { describe, expect, it } from "vitest";
import { CHECK_OPS, checkLayout, type AuditKind } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";

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
    const tells = ["default_typeface", "flat_hierarchy", "too_many_sizes", "mostly_centred", "centred_block", "eyebrow_everywhere", "measure", "leading",
      "card_trio", "nested_cards", "one_radius", "nested_radius", "same_shadow", "default_gradient", "glow", "emoji_icon", "chrome_string", "divider_everywhere"];
    expect((await check(generic(), [])).issues.filter((i) => tells.includes(i.kind))).toEqual([]);
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
