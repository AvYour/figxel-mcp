// figma_check_layout { audit: ["a11y"] } (role spec §4.1): whether anyone can
// operate what was drawn — target size and spacing (WCAG 2.2 SC 2.5.8 and
// 2.5.5, Apple HIG, Android's 48 dp), a focus state and how visible it is
// (SC 2.4.7, 2.4.13), an input's edge (SC 1.4.11), an error said in words
// (SC 1.4.1, 3.3.1), a label (SC 3.3.2), text that survives enlarging (SC
// 1.4.4, 1.4.12), and controls clear of the system insets. Each kind on a
// fixture that fires and one that does not; how controls are found; the unit
// conversion per platform; and the brief read through the op.

import { afterEach, describe, expect, it } from "vitest";
import { CHECK_OPS, checkLayout } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { READ_KEYS } from "../src/plugin/board-read.js";
import { A11Y, controlWord, parseViewports } from "../src/plugin/a11y.js";
import { BRIEF_KEY, BRIEF_NAMESPACE, PLATFORM_TARGETS, type BriefRecord } from "../src/shared/roles.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `21:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const solid = (hex: string) => {
  const v = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return [{ type: "SOLID", color: { r: v(1), g: v(3), b: v(5) } }];
};
const white = solid("#ffffff");
const ink = solid("#111111");
const txt = (name: string, box: [number, number, number, number], chars: string, props: Record<string, unknown> = {}) =>
  mk("TEXT", name, box, { characters: chars, fontName: { family: "Inter", style: "Regular" }, fontSize: 16, fills: ink, ...props });
const click = [{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: "1:1" }] }];
/** A main component as getMainComponentAsync returns it: a variant of `set`, or a lone component. */
const main = (name: string, set: N | null = null) => ({ id: `m:${++seq}`, name, type: "COMPONENT", parent: set, remote: false });
const instanceOf = (name: string, box: [number, number, number, number], m: ReturnType<typeof main>, props: Record<string, unknown> = {}, children: N[] = []) =>
  mk("INSTANCE", name, box, { getMainComponentAsync: async () => m, ...props }, children);

function brief(details: Record<string, unknown> = {}, over: Partial<BriefRecord> = {}): BriefRecord {
  return {
    v: 1, id: "9:1", role: "ux", gear: "page", title: "Bench booking", status: "open",
    createdAt: "2026-10-16T09:00:00Z", updatedAt: "2026-10-16T09:00:00Z",
    lines: { goal: "members book a bench", message: "You fix your own bike here.", success: ["books within one scroll"] },
    details, deliverables: [], ...over,
  };
}
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const check = (root: N, b?: BriefRecord, audit = ["a11y"]) =>
  checkLayout(root as never, 3000, noYield, { audit: new Set(audit) as never, ...(b ? { brief: b } : {}) });
type Issue = { kind: string; name: string; severity: string; detail: string; nodeId: string };
const of = (issues: Issue[], kind: string) => issues.filter((i) => i.kind === kind);
const pairs = (issues: Issue[], kind: string) => of(issues, kind).map((i) => `${i.name}:${i.severity}`);

afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("finding controls (§4.1)", () => {
  it("a click reaction, a control name on an instance or its main component or set, and details.controls — not a frame named Button, an icon, or a paragraph", async () => {
    const set = mk("COMPONENT_SET", "Button", [0, 0, 10, 10]);
    const f = mk("FRAME", "Screen", [0, 0, 1000, 600], { fills: white }, [
      mk("FRAME", "Card", [0, 0, 30, 30], { fills: white, reactions: click }),
      instanceOf("Book", [100, 0, 30, 30], main("State=Default", set)),
      instanceOf("Save", [200, 0, 30, 30], main("Primary button")),
      mk("FRAME", "Button", [300, 0, 30, 30], { fills: white }), // a frame by name alone: not found (spec §4.1)
      mk("FRAME", "Promo tile", [400, 0, 30, 30], { fills: white }),
      instanceOf("Icon / Search", [500, 0, 30, 30], main("Icon / Search")),
      txt("Terms", [600, 0, 300, 60], "Read the terms before you book, then agree to them below.", { reactions: click, lineHeight: { unit: "PIXELS", value: 20 } }),
      txt("Link", [600, 100, 40, 20], "Help", { reactions: click }),
    ]);
    const r = await check(f, brief({ controls: ["Promo tile"] }));
    expect(of(r.issues, "target_size").map((i) => i.name).sort()).toEqual(["Book", "Card", "Link", "Promo tile", "Save"]);
  });

  it("controlWord takes the head noun and leaves icons out", () => {
    expect(controlWord("IconButton/Primary")).toBe("icon button");
    expect(controlWord("Search button")).toBe("button");
    expect(controlWord("Text Field / Filled")).toBe("text field");
    expect(controlWord("Icon / Search")).toBeNull();
    expect(controlWord("Selected tablet")).toBeNull();
  });

  it("a control inside a control of its kind is part of it; a button inside an input is its own target", async () => {
    const f = mk("FRAME", "Form", [0, 0, 600, 400], { fills: white }, [
      instanceOf("Book", [0, 0, 120, 48], main("Button"), {}, [instanceOf("Base", [0, 0, 120, 48], main("Button base"), {}, [txt("Label", [10, 10, 80, 20], "Book")])]),
      instanceOf("Email", [0, 100, 300, 48], main("Text field"), { fills: white, strokes: solid("#555555") }, [
        txt("Value", [10, 110, 200, 20], "you@moku.bike"),
        instanceOf("Clear", [270, 112, 20, 20], main("Icon button")),
      ]),
    ]);
    const sizes = of((await check(f)).issues, "target_size").map((i) => i.name);
    expect(sizes).toContain("Clear");
    expect(sizes).not.toContain("Base");
  });
});

describe("target_size and target_spacing", () => {
  const bar = (...kids: N[]) => mk("FRAME", "Toolbar", [0, 0, 400, 100], { fills: white }, kids);
  const btn = (name: string, x: number, size: number, y = 10) => mk("INSTANCE", name, [x, y, size, size], { fills: white });

  it("web: under 24 × 24 with a neighbour inside its 24 px circle is a warning, with the neighbour named (SC 2.5.8)", async () => {
    const r = await check(bar(btn("Prev button", 0, 20), btn("Next button", 22, 20)));
    expect(pairs(r.issues, "target_size")).toEqual(["Prev button:warning", "Next button:warning"]);
    expect(pairs(r.issues, "target_spacing")).toEqual(["Prev button:warning", "Next button:warning"]);
    expect(of(r.issues, "target_spacing")[0]!.detail).toMatch(/24 CSS px circle centred on it crosses "Next button"/);
    expect(r.issues.filter((i) => i.severity !== "info").every((i) => ["target_size", "target_spacing"].includes(i.kind))).toBe(true);
  });

  it("web: under 24 × 24 but spaced is info — the spacing exception passes it; 24–44 is info (SC 2.5.5, AAA); 44 is fine", async () => {
    const r = await check(bar(btn("Prev button", 0, 20), btn("Next button", 40, 20), btn("Menu button", 100, 32), btn("Share button", 200, 44)));
    expect(pairs(r.issues, "target_size")).toEqual(["Prev button:info", "Next button:info", "Menu button:info"]);
    expect(of(r.issues, "target_size")[0]!.detail).toMatch(/passes WCAG 2\.2 SC 2\.5\.8 by its spacing/);
    expect(of(r.issues, "target_size")[2]!.detail).toMatch(/32 × 32 CSS px: it passes the 24 × 24 minimum .* not 44 × 44 \(SC 2\.5\.5, AAA\)/);
    expect(of(r.issues, "target_spacing")).toEqual([]);
  });

  it("a brief asking for AAA makes 44 the web's minimum, with no spacing exception", async () => {
    const r = await check(bar(btn("Menu button", 100, 32)), brief({ platform: "web", a11y: "AAA" }));
    expect(pairs(r.issues, "target_size")).toEqual(["Menu button:warning"]);
  });

  it("iOS: the box in pt at the viewport's scale — under 28 a warning, under 44 info (Apple HIG)", async () => {
    // A 390 pt phone drawn 1080 wide: 1 frame px = 390 ÷ 1080 ≈ 0.36 pt.
    const screen = mk("FRAME", "Slots", [0, 0, 1080, 2338], { fills: white }, [btn("Close button", 0, 72, 200), btn("Back button", 300, 100, 200), btn("Book button", 600, 130, 200)]);
    const r = await check(screen, brief({ platform: "ios", viewport: "390x844" }));
    expect(pairs(r.issues, "target_size")).toEqual(["Close button:warning", "Back button:info"]);
    expect(of(r.issues, "target_size")[0]!.detail).toMatch(/is 26 × 26 pt \(1 frame px = 0\.36 pt on the brief's viewport\), under iOS's 28 × 28 pt minimum/);
    // Drawn at device size, frame px are pt.
    const atSize = mk("FRAME", "Slots", [0, 0, 390, 844], { fills: white }, [btn("Close button", 0, 36, 200)]);
    expect(of((await check(atSize, brief({ platform: "ios", viewport: "390x844" }))).issues, "target_size")[0]!.detail).toMatch(/36 × 36 pt, under iOS's 44 × 44 pt default/);
  });

  it("Android: under 48 × 48 dp a warning; targets closer than 8 dp info (Google Accessibility Help)", async () => {
    const screen = mk("FRAME", "Home", [0, 0, 360, 800], { fills: white }, [btn("Like button", 0, 40, 200), btn("Share button", 44, 48, 200), btn("Save button", 200, 48, 200)]);
    const r = await check(screen, brief({ platform: "android", viewport: ["360x800", "1440x900"] }));
    expect(pairs(r.issues, "target_size")).toEqual(["Like button:warning"]);
    expect(pairs(r.issues, "target_spacing")).toEqual(["Share button:info"]);
    expect(of(r.issues, "target_spacing")[0]!.detail).toMatch(/sits 4 dp from "Like button"/);
  });

  it("several viewports: each frame takes the one whose width fits it best", async () => {
    expect(parseViewports(["390x844", "1440 × 900", { width: 768, height: 1024 }, "wide"])).toEqual([
      { width: 390, height: 844 }, { width: 1440, height: 900 }, { width: 768, height: 1024 },
    ]);
    const b = brief({ platform: "responsive", viewport: ["390x844", "1440x900"] });
    // 1440 wide is the desktop at 1:1, so 20 px stays 20 CSS px.
    const desk = mk("FRAME", "Desk", [0, 0, 1440, 900], { fills: white }, [btn("Close button", 0, 20)]);
    expect(of((await check(desk, b)).issues, "target_size")[0]!.detail).toMatch(/is 20 × 20 CSS px,/);
  });
});

describe("focus_state_missing and focus_indicator_weak", () => {
  const variant = (state: string, props: Record<string, unknown> = {}) =>
    mk("COMPONENT", `State=${state}`, [0, 0, 120, 48], { fills: solid("#2255dd"), variantProperties: { State: state }, ...props });
  const buttonSet = (...states: Array<[string, Record<string, unknown>?]>) => {
    const vs = states.map(([s, p]) => variant(s, p));
    return mk("COMPONENT_SET", "Button", [0, 0, 400, 200], {
      fills: white,
      variantGroupProperties: { State: { values: states.map(([s]) => s) } },
    }, vs);
  };

  it("an interactive set with no focus value: a warning on the web (SC 2.4.7), info on iOS", async () => {
    const set = buttonSet(["Default"], ["Hover"], ["Pressed"]);
    const web = of((await check(set)).issues, "focus_state_missing");
    expect(pairs(web, "focus_state_missing")).toEqual(["Button:warning"]);
    expect(web[0]!.detail).toMatch(/no focus variant .*State = Default, Hover, Pressed.*SC 2\.4\.7/);
    expect(pairs((await check(set, brief({ platform: "ios" }))).issues, "focus_state_missing")).toEqual(["Button:info"]);
    // Not a control: a set named for something else, with nothing pressable.
    const card = mk("COMPONENT_SET", "Card", [0, 0, 400, 200], { variantGroupProperties: { Type: { values: ["A", "B"] } } }, [mk("COMPONENT", "Type=A", [0, 0, 10, 10])]);
    expect(of((await check(card)).issues, "focus_state_missing")).toEqual([]);
  });

  it("a set reached through an instance on a screen is judged too, naming the instance", async () => {
    const set = buttonSet(["Default"], ["Hover"]);
    const screen = mk("FRAME", "Slots", [0, 0, 390, 844], { fills: white }, [instanceOf("Book", [20, 700, 350, 48], main("State=Default", set))]);
    const found = of((await check(screen)).issues, "focus_state_missing");
    expect(found.map((i) => i.nodeId)).toEqual([set.id]);
    expect(found[0]!.detail).toMatch(/used here by "Book"/);
  });

  it("focus_indicator_weak: a focus variant that adds no 2 px ring, or one under 3:1 against the default's pixels (SC 2.4.13)", async () => {
    const none = of((await check(buttonSet(["Default"], ["Focus"]))).issues, "focus_indicator_weak");
    expect(pairs(none, "focus_indicator_weak")).toEqual(["State=Focus:info"]);
    expect(none[0]!.detail).toMatch(/adds no stroke, outline or effect 2 px thick/);
    const pale = of((await check(buttonSet(["Default"], ["Focus", { strokes: solid("#3366ee"), strokeWeight: 2 }]))).issues, "focus_indicator_weak");
    expect(pale[0]!.detail).toMatch(/is 1\.\d\d:1 against the default variant's #2255dd/);
    const strong = await check(buttonSet(["Default"], ["Focus", { strokes: solid("#111111"), strokeWeight: 2 }]));
    expect(of(strong.issues, "focus_indicator_weak")).toEqual([]);
    expect(of(strong.issues, "focus_state_missing")).toEqual([]);
    // A spread shadow counts as a ring.
    const ring = { effects: [{ type: "DROP_SHADOW", visible: true, spread: 2, radius: 0, offset: { x: 0, y: 0 }, color: { r: 0, g: 0, b: 0, a: 1 } }] };
    expect(of((await check(buttonSet(["Default"], ["Focus visible", ring]))).issues, "focus_indicator_weak")).toEqual([]);
  });
});

describe("weak_boundary", () => {
  const form = (...kids: N[]) => mk("FRAME", "Form", [0, 0, 600, 400], { fills: white }, kids);
  const field = (stroke: string | null, props: Record<string, unknown> = {}, kids: N[] = []) =>
    instanceOf("Email", [0, 0, 300, 48], main("Text field"), { fills: white, ...(stroke ? { strokes: solid(stroke), strokeWeight: 1 } : {}), ...props }, kids);

  it("an input whose edge is under 3:1 against the ground is a warning (SC 1.4.11); a dark one or a disabled one is not", async () => {
    const found = of((await check(form(field("#dddddd")))).issues, "weak_boundary");
    expect(pairs(found, "weak_boundary")).toEqual(["Email:warning"]);
    expect(found[0]!.detail).toMatch(/1\.\d\d:1 .*#dddddd stroke on #ffffff.*3:1 \(WCAG 2\.2 SC 1\.4\.11\)/);
    expect(of((await check(form(field("#767676")))).issues, "weak_boundary")).toEqual([]);
    expect(of((await check(form(field("#dddddd", { componentProperties: { State: { type: "VARIANT", value: "Disabled" } } })))).issues, "weak_boundary")).toEqual([]);
    // A filled field that stands off the ground needs no stroke.
    expect(of((await check(form(field(null, { fills: solid("#666666") })))).issues, "weak_boundary")).toEqual([]);
  });

  it("an input drawn as an underline is judged by the underline", async () => {
    const line = (hex: string) => mk("RECTANGLE", "Underline", [0, 47, 300, 1], { fills: solid(hex) });
    expect(pairs((await check(form(field(null, { fills: [] }, [line("#eeeeee")])))).issues, "weak_boundary")).toEqual(["Email:warning"]);
    expect(of((await check(form(field(null, { fills: [] }, [line("#555555")])))).issues, "weak_boundary")).toEqual([]);
  });
});

describe("error_colour_only", () => {
  const variant = (state: string, texts: string[], stroke: string) =>
    mk("COMPONENT", `State=${state}`, [0, 0, 300, 72], { fills: white, strokes: solid(stroke), variantProperties: { State: state } },
      texts.map((t, i) => txt(`T${i}`, [10, 10 + 20 * i, 200, 18], t)));
  const set = (errorTexts: string[]) => mk("COMPONENT_SET", "Input", [0, 0, 700, 200], {
    fills: white, variantGroupProperties: { State: { values: ["Default", "Focus", "Error"] } },
  }, [variant("Default", ["Email", "you@moku.bike"], "#555555"), variant("Focus", ["Email", "you@moku.bike"], "#111111"), variant("Error", errorTexts, "#cc0000")]);

  it("an input's error variant that only changes colour is a warning (SC 1.4.1, 3.3.1); one that says what is wrong is not", async () => {
    const found = of((await check(set(["Email", "you@moku.bike"]))).issues, "error_colour_only");
    expect(pairs(found, "error_colour_only")).toEqual(["State=Error:warning"]);
    expect(found[0]!.detail).toMatch(/same text as "State=Default".*only its colours change/);
    expect(of((await check(set(["Email", "you@moku.bike", "Enter an address with an @"]))).issues, "error_colour_only")).toEqual([]);
  });
});

describe("input_unlabelled", () => {
  const input = (kids: N[]) => instanceOf("Email", [0, 100, 300, 48], main("Text field"), { fills: white, strokes: ink }, kids);

  it("an input with only a placeholder and no label beside it is info (SC 3.3.2); a label above, or one inside, answers it", async () => {
    const alone = mk("FRAME", "Form", [0, 0, 600, 400], { fills: white }, [input([txt("Placeholder", [10, 110, 200, 20], "you@moku.bike")])]);
    const found = of((await check(alone)).issues, "input_unlabelled");
    expect(pairs(found, "input_unlabelled")).toEqual(["Email:info"]);
    expect(found[0]!.detail).toMatch(/inside it only "you@moku\.bike", a placeholder/);
    const above = mk("FRAME", "Form", [0, 0, 600, 400], { fills: white }, [txt("Label", [0, 72, 100, 20], "Email"), input([txt("Placeholder", [10, 110, 200, 20], "you@moku.bike")])]);
    expect(of((await check(above)).issues, "input_unlabelled")).toEqual([]);
    const inside = mk("FRAME", "Form", [0, 0, 600, 400], { fills: white }, [input([txt("Label", [10, 102, 100, 14], "Email"), txt("Value", [10, 120, 200, 20], "you@moku.bike")])]);
    expect(of((await check(inside)).issues, "input_unlabelled")).toEqual([]);
    // Far above is not beside it.
    const far = mk("FRAME", "Form", [0, 0, 600, 400], { fills: white }, [txt("Label", [0, 0, 100, 20], "Email"), input([])]);
    expect(of((await check(far)).issues, "input_unlabelled")[0]!.detail).toMatch(/no text at all/);
  });
});

describe("text_fixed_box", () => {
  it("a control's text in a fixed box or cut with an ellipsis is info (SC 1.4.4, 1.4.12), once per component", async () => {
    const m = main("Button");
    const label = (props: Record<string, unknown>) => txt("Label", [10, 10, 80, 20], "Book now", props);
    const f = mk("FRAME", "Bar", [0, 0, 600, 100], { fills: white }, [
      instanceOf("Book", [0, 0, 120, 48], m, {}, [label({ textAutoResize: "NONE" })]),
      instanceOf("Book again", [200, 0, 120, 48], m, {}, [label({ textAutoResize: "NONE" })]),
      instanceOf("Pay", [400, 0, 120, 48], main("Button"), {}, [label({ textAutoResize: "HEIGHT", textTruncation: "ENDING" })]),
      instanceOf("Fine", [0, 60, 120, 48], main("Button"), {}, [label({ textAutoResize: "WIDTH_AND_HEIGHT" })]),
      mk("FRAME", "Not a control", [200, 60, 120, 30], {}, [label({ textAutoResize: "NONE" })]),
    ]);
    const found = of((await check(f)).issues, "text_fixed_box");
    expect(found).toHaveLength(2);
    expect(found[0]!.detail).toMatch(/fixed box \(textAutoResize NONE\).*200% \(WCAG 2\.2 SC 1\.4\.4\)/);
    expect(found[1]!.detail).toMatch(/cut with an ellipsis/);
    // Line height alone is never judged (SC 1.4.12 is about a user's override).
    const tight = mk("FRAME", "Bar", [0, 0, 600, 100], {}, [instanceOf("Book", [0, 0, 120, 48], main("Button"), {}, [label({ lineHeight: { unit: "PERCENT", value: 100 } })])]);
    expect(of((await check(tight)).issues, "text_fixed_box")).toEqual([]);
  });
});

describe("safe_area_platform", () => {
  const screen = () => mk("FRAME", "Slots", [0, 0, 390, 844], { fills: white }, [
    mk("INSTANCE", "Close button", [16, 20, 44, 44], { fills: white }),
    mk("INSTANCE", "Back button", [16, 100, 44, 44], { fills: white }),
    mk("INSTANCE", "Book button", [16, 790, 358, 44], { fills: white }),
  ]);
  const insets = { top: 59, bottom: 34, source: "the iPhone 15 safe area, measured 2026-10-14" };

  it("iOS: a control inside the inset band the brief records is info, with the source; none without insets or off mobile", async () => {
    const found = of((await check(screen(), brief({ platform: "ios", viewport: "390x844", insets }))).issues, "safe_area_platform");
    expect(pairs(found, "safe_area_platform")).toEqual(["Close button:info", "Book button:info"]);
    expect(found[0]!.detail).toMatch(/reaches 39 pt into the top inset \(59 pt, from the iPhone 15 safe area/);
    expect(found[1]!.detail).toMatch(/into the bottom inset \(34 pt/);
    expect(of((await check(screen(), brief({ platform: "ios", viewport: "390x844" }))).issues, "safe_area_platform")).toEqual([]);
    expect(of((await check(screen(), brief({ platform: "web", insets }))).issues, "safe_area_platform")).toEqual([]);
  });
});

describe("the brief through figma_check_layout { briefId }", () => {
  const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });
  function file(nodes: N[]) {
    (globalThis as { figma?: unknown }).figma = {
      currentPage: mk("PAGE", "P", [0, 0, 0, 0], { selection: [] }),
      getNodeByIdAsync: async (id: string) => nodes.find((n) => n.id === id) ?? null,
    };
  }
  const holding = (record: string) => mk("FRAME", "Brief · Bench booking", [2000, 0, 720, 400], {
    getSharedPluginData: (ns: string, key: string) => (ns === BRIEF_NAMESPACE && key === BRIEF_KEY ? record : ""),
  });
  type Out = { issues: Issue[]; audit: { ran: string[]; brief: unknown } };

  it("reads the record on the node, measures in its platform's units, and says which brief it used", async () => {
    const screen = mk("FRAME", "Slots", [0, 0, 1080, 2338], { fills: white }, [mk("INSTANCE", "Close button", [0, 200, 72, 72], { fills: white })]);
    const block = holding(JSON.stringify(brief({ platform: "ios", viewport: "390x844" })));
    file([screen, block]);
    const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: screen.id, audit: ["a11y"], briefId: block.id }))) as Out;
    expect(r.audit.brief).toEqual({ id: "9:1", title: "Bench booking", role: "ux", gear: "page", platform: "ios", from: "briefId" });
    expect(pairs(r.issues, "target_size")).toEqual(["Close button:warning"]);
    expect(of(r.issues, "target_size")[0]!.detail).toMatch(/26 × 26 pt/);
    // Without the brief the same frame is a web page in CSS px: 72 px passes.
    const plain = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: screen.id, audit: ["a11y"] }))) as Out;
    expect(of(plain.issues, "target_size")).toEqual([]);
    expect(plain.audit.brief).toMatch(/^none: a11y measures as for the web in CSS px/);
  });

  it("a node with no brief, or one that cannot be read, is refused by name", async () => {
    const screen = mk("FRAME", "Slots", [0, 0, 390, 844]);
    const empty = holding("");
    const broken = holding("{ not json");
    file([screen, empty, broken]);
    await expect(CHECK_OPS.check_layout!.run(ctx({ nodeId: screen.id, audit: ["a11y"], briefId: empty.id }))).rejects.toMatchObject({ code: "INVALID_PARAM", message: /carries no brief/ });
    await expect(CHECK_OPS.check_layout!.run(ctx({ nodeId: screen.id, audit: ["a11y"], briefId: broken.id }))).rejects.toMatchObject({ code: "INVALID_PARAM", message: /cannot be read: the stored brief is not JSON/ });
  });
});

describe("the role audits as a whole", () => {
  it("the thresholds are the platform table's", () => {
    expect(A11Y.targets).toBe(PLATFORM_TARGETS);
    expect([A11Y.spacingCircle, A11Y.focusThickness, A11Y.focusContrast, A11Y.boundaryContrast]).toEqual([24, 2, 3, 3]);
  });

  it("read only members the guarded view exposes, so FigJam and Slides lose nothing [C-145]", async () => {
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
    const set = mk("COMPONENT_SET", "Button", [0, 300, 400, 100], { fills: white, variantGroupProperties: { State: { values: ["Default", "Error"] } } }, [
      mk("COMPONENT", "State=Default", [0, 300, 120, 48], { fills: white, variantProperties: { State: "Default" } }, [txt("L", [10, 310, 80, 20], "Submit")]),
      mk("COMPONENT", "State=Error", [200, 300, 120, 48], { fills: white, variantProperties: { State: "Error" } }, [txt("L", [210, 310, 80, 20], "Submit")]),
    ]);
    const root = record(mk("FRAME", "Screen", [0, 0, 600, 800], { fills: white, layoutGrids: [{ pattern: "COLUMNS", alignment: "STRETCH", count: 4, gutterSize: 16, offset: 24, visible: true }] }, [
      mk("INSTANCE", "Close button", [0, 0, 20, 20], { fills: white, reactions: click, componentProperties: {} }),
      txt("Oops", [100, 0, 200, 20], "Oops, try again", { textAutoResize: "NONE" }),
      set,
    ]));
    await checkLayout(root as never, 3000, noYield, { audit: new Set(["a11y", "states", "copy", "system"]), brief: brief({ platform: "web", screens: [{ name: "Slots", states: ["empty"] }] }, { system: { bodySize: 16, ratio: 1.25, spacingBase: 8, palette: [{ hex: "#ffffff", role: "ground" }] }, lines: { goal: "g", message: "m", success: ["s"], format: "600x800 px" } }) });
    const keys = new Set<string>(READ_KEYS);
    expect([...touched].filter((k) => !keys.has(k))).toEqual([]);
    for (const k of ["reactions", "variantGroupProperties", "variantProperties", "getSharedPluginData", "layoutGrids"]) expect(touched).toContain(k);
  });
});
