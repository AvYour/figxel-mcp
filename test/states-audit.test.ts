// figma_check_layout { audit: ["states"] } (role spec §4.2): every interactive
// component has the states people meet — read from a component set's variant
// properties with "Enabled", "Rest" and "Default" as one state — and every
// screen state the brief declares has its frame. Each kind fires on one
// fixture and not on another; severities follow the platform (hover only
// where there is a pointer, focus a warning on the web, WCAG 2.2 SC 2.4.7).

import { describe, expect, it } from "vitest";
import { CHECK_OPS, checkLayout } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { setStates, statesOf } from "../src/plugin/a11y.js";
import { STATES } from "../src/plugin/states.js";
import { BRIEF_KEY, BRIEF_NAMESPACE, type BriefRecord } from "../src/shared/roles.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `22:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const white = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
const ink = [{ type: "SOLID", color: { r: 0.07, g: 0.07, b: 0.07 } }];
const txt = (chars: string) => mk("TEXT", "Label", [10, 10, 80, 20], { characters: chars, fontSize: 16, fills: ink });

/** A component set from its property table: every combination is a variant. */
function set(name: string, groups: Record<string, string[]>, label = "Label"): N {
  const keys = Object.keys(groups);
  let combos: Array<Record<string, string>> = [{}];
  for (const k of keys) combos = combos.flatMap((c) => groups[k]!.map((v) => ({ ...c, [k]: v })));
  const variants = combos.map((c, i) =>
    mk("COMPONENT", keys.map((k) => `${k}=${c[k]}`).join(", "), [0, 60 * i, 120, 48], { fills: white, variantProperties: c }, [txt(label)]));
  const values: Record<string, { values: string[] }> = {};
  for (const k of keys) values[k] = { values: groups[k]! };
  return mk("COMPONENT_SET", name, [0, 0, 400, 60 * combos.length], { fills: white, variantGroupProperties: values }, variants);
}

function brief(details: Record<string, unknown> = {}, over: Partial<BriefRecord> = {}): BriefRecord {
  return {
    v: 1, id: "9:1", role: "ux", gear: "page", title: "Bench booking", status: "open",
    createdAt: "2026-10-16T09:00:00Z", updatedAt: "2026-10-16T09:00:00Z",
    lines: { goal: "members book a bench", message: "You fix your own bike here.", success: ["books within one scroll"] },
    details, deliverables: [], ...over,
  };
}
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const check = (root: N, b?: BriefRecord, audit = ["states"]) =>
  checkLayout(root as never, 3000, noYield, { audit: new Set(audit) as never, ...(b ? { brief: b } : {}) });
type Issue = { kind: string; name: string; severity: string; detail: string; nodeId: string };
const of = (issues: Issue[], kind: string) => issues.filter((i) => i.kind === kind);

describe("reading states", () => {
  it("normalises the words designers use for one state, and reads a boolean property named for a state", () => {
    expect([...statesOf("Enabled")]).toEqual(["default"]);
    expect([...statesOf("Focus visible")]).toEqual(["focus"]);
    expect([...statesOf("Hover / Selected")].sort()).toEqual(["hover", "selected"]);
    expect([...statesOf("Unchecked")]).toEqual([]);
    expect([...statesOf("Not selected")]).toEqual([]);
    expect([...setStates({ Disabled: ["False", "True"], Size: ["S", "L"] })]).toEqual(["disabled"]);
  });
});

describe("state_missing", () => {
  it("a button on the web lacking focus is a warning (SC 2.4.7); hover, pressed and disabled are info", async () => {
    const r = await check(set("Button", { State: ["Default"] }));
    const found = of(r.issues, "state_missing");
    expect(found.map((i) => i.severity)).toEqual(["warning", "info"]);
    expect(found[0]!.detail).toMatch(/lacks Focus \(where the keyboard is \(WCAG 2\.2 SC 2\.4\.7\)\)/);
    expect(found[1]!.detail).toMatch(/lacks Hover .*Pressed .*Disabled/);
  });

  it("a full button set has none; Enabled, Rest and Active count as Default and Pressed", async () => {
    const r = await check(set("Button", { State: ["Enabled", "Hovered", "Focused", "Active", "Inactive"] }));
    expect(of(r.issues, "state_missing")).toEqual([]);
  });

  it("on iOS there is no hover, and a missing focus state is info", async () => {
    const r = await check(set("Button", { State: ["Default", "Pressed", "Disabled"] }), brief({ platform: "ios" }));
    const found = of(r.issues, "state_missing");
    expect(found.map((i) => i.severity)).toEqual(["info"]);
    expect(found[0]!.detail).toMatch(/lacks Focus/);
    expect(found[0]!.detail).not.toMatch(/Hover/);
  });

  it("an input needs filled and error — error a warning (SC 3.3.1); a toggle needs selected", async () => {
    const input = of((await check(set("Text field", { State: ["Default", "Focus", "Disabled"] }))).issues, "state_missing");
    expect(input.map((i) => i.severity)).toEqual(["warning", "info"]);
    expect(input[0]!.detail).toMatch(/lacks Error/);
    expect(input[1]!.detail).toMatch(/lacks Filled/);
    const toggle = of((await check(set("Switch", { State: ["Default", "Hover", "Focus", "Pressed", "Disabled"] }))).issues, "state_missing");
    expect(toggle.map((i) => [i.severity, /Selected/.test(i.detail)])).toEqual([["info", true]]);
    expect(of((await check(set("Checkbox", { State: ["Default", "Hover", "Focus", "Pressed", "Disabled"], Checked: ["False", "True"] }))).issues, "state_missing")).toEqual([]);
  });

  it("a button that submits also needs loading (NN/g response times)", async () => {
    const full = { State: ["Default", "Hover", "Focus", "Pressed", "Disabled"] };
    expect(of((await check(set("Button", full, "Book a bench"))).issues, "state_missing").map((i) => i.detail).join()).toMatch(/lacks Loading/);
    expect(of((await check(set("Button", full, "Read the story"))).issues, "state_missing")).toEqual([]);
  });

  it("with a11y running too, a missing focus state is a11y's focus_state_missing, said once", async () => {
    const r = await check(set("Button", { State: ["Default", "Hover", "Pressed", "Disabled"] }), undefined, ["states", "a11y"]);
    expect(of(r.issues, "state_missing")).toEqual([]);
    expect(of(r.issues, "focus_state_missing")).toHaveLength(1);
  });

  it("not on a set that is not a control", async () => {
    expect(of((await check(set("Card", { Type: ["Plain", "Featured"] }))).issues, "state_missing")).toEqual([]);
    expect(of((await check(set("Card", { Type: ["Plain", "Featured"] }))).issues, "state_property_missing")).toEqual([]);
  });
});

describe("state_property_missing and variant_default_name", () => {
  it("an interactive set with variants but no state property is info", async () => {
    const found = of((await check(set("Button", { Size: ["Small", "Large"], Type: ["Primary", "Secondary"] }))).issues, "state_property_missing");
    expect(found.map((i) => [i.name, i.severity])).toEqual([["Button", "info"]]);
    expect(of((await check(set("Button", { Size: ["Small", "Large"], Type: ["Primary", "Secondary"] }))).issues, "state_missing")).toEqual([]);
  });

  it("\"Property 1\" or \"Variant2\" left as Figma named them is a warning, on any set", async () => {
    const found = of((await check(set("Card", { "Property 1": ["Default", "Variant2"] }))).issues, "variant_default_name");
    expect(found.map((i) => [i.name, i.severity])).toEqual([["Card", "warning"]]);
    expect(found[0]!.detail).toMatch(/the property "Property 1" and the value "Property 1 = Variant2"/);
    expect(of((await check(set("Card", { Type: ["Plain", "Featured"] }))).issues, "variant_default_name")).toEqual([]);
  });
});

describe("screen_state_missing", () => {
  const screens = [{ name: "Slots", states: ["empty", "loading", "error"] }];
  const page = (...names: string[]) => mk("PAGE", "Flow", [0, 0, 0, 0], {}, names.map((n, i) => mk("FRAME", n, [i * 500, 0, 390, 844], { fills: white })));

  it("a declared state with no frame named <screen> / <state> is a warning on the brief; a flow name and a step number may come first", async () => {
    const p = page("Bench booking / 01 Slots", "Bench booking / 01 Slots / Empty", "bench booking / 1. slots / LOADING");
    const found = of((await check(p.children![0]!, brief({ screens }))).issues, "screen_state_missing");
    expect(found.map((i) => [i.nodeId, i.severity])).toEqual([["9:1", "warning"]]);
    expect(found[0]!.detail).toMatch(/declares the screen "Slots" with the state "error", and no top-level frame is named "Slots \/ Error"/);
    const all = page("Slots / Empty", "Slots / Loading", "Slots / Error");
    expect(of((await check(all.children![0]!, brief({ screens }))).issues, "screen_state_missing")).toEqual([]);
  });

  it("a screen declared by its full frame name: the state frame equals or ends with \"<screen name> / <State>\", case-insensitive", async () => {
    const full = [{ name: "Booking / 02 Slots", states: ["empty", "loading", "error"] }];
    const p = page("Booking / 02 Slots", "Booking / 02 Slots / Empty", "booking / 02 slots / loading", "Release 2 / Booking / 02 Slots / Error");
    expect(of((await check(p.children![0]!, brief({ screens: full }))).issues, "screen_state_missing")).toEqual([]);
    const short = page("Booking / 02 Slots", "Booking / 02 Slots / Empty", "Booking / 03 Slots / Loading", "Booking / Slots and more / Error");
    const found = of((await check(short.children![0]!, brief({ screens: full }))).issues, "screen_state_missing");
    expect(found[0]!.detail).toMatch(/the states "loading", "error", and no top-level frame is named "Booking \/ 02 Slots \/ Loading" and so on.*named "Booking \/ 02 Slots \/ <State>"/);
  });

  it("none without declared screens, and none without a brief", async () => {
    const p = page("Slots");
    expect(of((await check(p.children![0]!, brief())).issues, "screen_state_missing")).toEqual([]);
    expect(of((await check(p.children![0]!)).issues, "screen_state_missing")).toEqual([]);
  });

  it("a deliverable on another page counts, and checking several roots reports it once", async () => {
    const elsewhere = mk("FRAME", "Slots / Error", [0, 0, 390, 844]);
    const a = mk("FRAME", "Slots", [0, 0, 390, 844], { fills: white });
    const b = mk("FRAME", "Slots / Empty", [500, 0, 390, 844], { fills: white });
    const p = mk("PAGE", "Flow", [0, 0, 0, 0], { selection: [] }, [a, b]);
    const record = JSON.stringify(brief({ screens }, { deliverables: [a.id, b.id, elsewhere.id] }));
    const block = mk("FRAME", "Brief · Bench booking", [2000, 0, 720, 400], { getSharedPluginData: (ns: string, k: string) => (ns === BRIEF_NAMESPACE && k === BRIEF_KEY ? record : "") });
    const nodes = [a, b, elsewhere, block];
    (globalThis as { figma?: unknown }).figma = { currentPage: p, getNodeByIdAsync: async (id: string) => nodes.find((n) => n.id === id) ?? null };
    const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });
    try {
      const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeIds: [a.id, b.id], audit: ["states"], briefId: block.id }))) as { issues: Issue[] };
      const found = of(r.issues, "screen_state_missing");
      expect(found).toHaveLength(1);
      expect(found[0]!.detail).toMatch(/the state "loading"/);
    } finally {
      delete (globalThis as { figma?: unknown }).figma;
    }
  });
});

describe("the table", () => {
  it("states each control needs, per the spec's lists", () => {
    expect(STATES.required.button).toEqual(["default", "hover", "focus", "pressed", "disabled"]);
    expect(STATES.required.input).toEqual(["default", "focus", "filled", "error", "disabled"]);
    expect(STATES.required.toggle).toEqual(["default", "hover", "focus", "pressed", "disabled", "selected"]);
  });
});
