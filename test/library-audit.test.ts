// figma_check_layout { audit: ["library"] } (role spec §4.8): what a
// design-system designer checks before the system ships — every semantic
// token valued in every mode, no alias pointing at nothing, semantic tokens
// scoped by role, code syntax for the platforms the brief names, and every
// component described. The tokens are the file's, read through a fake
// figma.variables (getLocalVariablesAsync, getLocalVariableCollectionsAsync,
// getVariableByIdAsync); each kind fires on one fixture and stays quiet on its
// look-alike; and the brief is read through the op.

import { afterEach, describe, expect, it } from "vitest";
import { CHECK_OPS, checkLayout } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { LIBRARY, readLibrary } from "../src/plugin/library.js";
import { BRIEF_KEY, BRIEF_NAMESPACE, type BriefRecord } from "../src/shared/roles.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `34:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const white = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
const page = (...kids: N[]) => {
  const p = mk("PAGE", "Components", [0, 0, 0, 0], { selection: [] }, kids);
  delete p.absoluteBoundingBox;
  return p;
};

type Mode = { modeId: string; name: string };
type Col = { id: string; name: string; modes: Mode[]; isExtension?: boolean; remote?: boolean };
type Var = { id: string; name: string; variableCollectionId: string; resolvedType: string; valuesByMode: Record<string, unknown>; scopes: string[]; codeSyntax: Record<string, string> };
const alias = (id: string) => ({ type: "VARIABLE_ALIAS", id });
const rgb = { r: 0.1, g: 0.2, b: 0.9, a: 1 };

/** A small system: primitives in one mode, semantic tokens in Light and Dark aliasing them. */
function system() {
  const prim: Col = { id: "VariableCollectionId:1", name: "Primitives", modes: [{ modeId: "1:0", name: "Value" }] };
  const sem: Col = { id: "VariableCollectionId:2", name: "Semantic", modes: [{ modeId: "2:0", name: "Light" }, { modeId: "2:1", name: "Dark" }] };
  const v = (id: string, name: string, col: Col, values: Record<string, unknown>, more: Partial<Var> = {}): Var => ({
    id, name, variableCollectionId: col.id, resolvedType: "COLOR", valuesByMode: values, scopes: [], codeSyntax: { WEB: `var(--${name.replace(/\//g, "-")})` }, ...more,
  });
  const vars: Var[] = [
    v("VariableID:1:1", "blue/500", prim, { "1:0": rgb }, { scopes: ["ALL_SCOPES"] }),
    v("VariableID:1:2", "grey/900", prim, { "1:0": rgb }),
    v("VariableID:2:1", "color/bg/default", sem, { "2:0": alias("VariableID:1:1"), "2:1": alias("VariableID:1:2") }, { scopes: ["FRAME_FILL", "SHAPE_FILL"] }),
    v("VariableID:2:2", "color/text/default", sem, { "2:0": alias("VariableID:1:2"), "2:1": alias("VariableID:1:1") }, { scopes: ["TEXT_FILL"] }),
  ];
  return { prim, sem, vars, v };
}

function install(vars: Var[], cols: Col[], remote: Record<string, unknown> = {}) {
  (globalThis as { figma?: unknown }).figma = {
    currentPage: page(),
    getNodeByIdAsync: async () => null,
    variables: {
      getLocalVariablesAsync: async () => vars,
      getLocalVariableCollectionsAsync: async () => cols,
      getVariableByIdAsync: async (id: string) => vars.find((x) => x.id === id) ?? remote[id] ?? null,
    },
  };
}

function brief(platforms?: string[]): BriefRecord {
  return {
    v: 1, id: "9:6", role: "design-system", gear: "page", title: "Bench UI", status: "open",
    createdAt: "2026-10-16T09:00:00Z", updatedAt: "2026-10-16T09:00:00Z",
    lines: { goal: "one system for the app", message: "Every value from a token.", success: ["no raw values"] },
    details: { scope: "both", ...(platforms ? { platforms } : {}) }, deliverables: [],
  };
}
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
/** The checked subtree: one described component on a page. */
const described = () => {
  const c = mk("COMPONENT", "Badge", [0, 0, 80, 24], { fills: white, description: "A count on an icon." });
  page(c);
  return c;
};
const check = (root: N = described(), b?: BriefRecord) => checkLayout(root as never, 5000, noYield, { audit: new Set(["library"]), ...(b ? { brief: b } : {}) });
type Issue = { kind: string; name: string; severity: string; detail: string; nodeId: string };
const of = (issues: Issue[], kind: string) => issues.filter((i) => i.kind === kind);
const pairs = (issues: Issue[], kind: string) => of(issues, kind).map((i) => `${i.name}:${i.severity}`);

afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("a clean system", () => {
  it("valued, live, scoped and described: nothing to report (the primitive at ALL_SCOPES is not semantic)", async () => {
    const { prim, sem, vars } = system();
    install(vars, [prim, sem]);
    const r = await check(described(), brief(["web"]));
    expect(r.issues).toEqual([]);
  });
});

describe("mode_value_missing", () => {
  it("a semantic token with no value in one of its collection's modes is a warning, naming the mode; an extension inherits", async () => {
    const { prim, sem, vars, v } = system();
    vars.push(v("VariableID:2:3", "color/border/default", sem, { "2:0": alias("VariableID:1:2") }, { scopes: ["STROKE_COLOR"] }));
    const ext: Col = { id: "VariableCollectionId:3", name: "Brand B", modes: [{ modeId: "3:0", name: "Light" }, { modeId: "3:1", name: "Dark" }], isExtension: true };
    vars.push(v("VariableID:3:1", "color/accent", ext, { "3:0": alias("VariableID:1:1") }, { scopes: ["FRAME_FILL"] }));
    install(vars, [prim, sem, ext]);
    const found = of((await check()).issues, "mode_value_missing");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["color/border/default:warning"]);
    expect(found[0]!.nodeId).toBe("VariableID:2:3");
    expect(found[0]!.detail).toMatch(/has no value in the mode "Dark" of "Semantic"/);
  });

  it("a primitive in a one-mode collection is not semantic, and a null value counts as none", async () => {
    const { prim, sem, vars, v } = system();
    vars.push(v("VariableID:1:3", "green/500", prim, {}));
    vars.push(v("VariableID:2:4", "color/bg/muted", sem, { "2:0": alias("VariableID:1:1"), "2:1": null }, { scopes: ["FRAME_FILL"] }));
    install(vars, [prim, sem]);
    expect(pairs((await check()).issues, "mode_value_missing")).toEqual(["color/bg/muted:warning"]);
  });
});

describe("alias_broken", () => {
  it("an alias whose target resolves nowhere is a warning; one into a library this file reaches is not", async () => {
    const { prim, sem, vars, v } = system();
    vars.push(v("VariableID:2:5", "color/bg/danger", sem, { "2:0": alias("VariableID:gone"), "2:1": alias("VariableID:1:2") }, { scopes: ["FRAME_FILL"] }));
    vars.push(v("VariableID:2:6", "color/bg/brand", sem, { "2:0": alias("VariableID:lib/7"), "2:1": alias("VariableID:lib/7") }, { scopes: ["FRAME_FILL"] }));
    install(vars, [prim, sem], { "VariableID:lib/7": { id: "VariableID:lib/7", name: "brand/500" } });
    const found = of((await check()).issues, "alias_broken");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["color/bg/danger:warning"]);
    expect(found[0]!.detail).toMatch(/aliases VariableID:gone in "Light", which no longer resolves/);
  });

  it("readLibrary looks each foreign target up once, and never throws", async () => {
    const { prim, sem, vars, v } = system();
    vars.push(v("VariableID:2:7", "a", sem, { "2:0": alias("VariableID:x"), "2:1": alias("VariableID:x") }));
    let asked = 0;
    const api = { variables: { getLocalVariablesAsync: async () => vars, getLocalVariableCollectionsAsync: async () => [prim, sem], getVariableByIdAsync: async () => { asked++; throw new Error("gone"); } } };
    const lib = await readLibrary(api);
    expect(asked).toBe(1);
    expect([...lib.unresolved]).toEqual(["VariableID:x"]);
    expect((await readLibrary({ variables: { getLocalVariablesAsync: async () => { throw new Error("nope"); } } })).read).toBe(false);
  });
});

describe("scope_all", () => {
  it("semantic tokens at ALL_SCOPES are one info per collection, counting them; scoped tokens, primitives and booleans are not", async () => {
    const { prim, sem, vars, v } = system();
    vars.push(v("VariableID:2:8", "color/bg/raised", sem, { "2:0": alias("VariableID:1:1"), "2:1": alias("VariableID:1:2") }, { scopes: ["ALL_SCOPES"] }));
    vars.push(v("VariableID:2:9", "color/bg/sunken", sem, { "2:0": alias("VariableID:1:1"), "2:1": alias("VariableID:1:2") }, { scopes: ["ALL_SCOPES"] }));
    vars.push(v("VariableID:2:10", "flag/compact", sem, { "2:0": true, "2:1": false }, { resolvedType: "BOOLEAN", scopes: ["ALL_SCOPES"] }));
    install(vars, [prim, sem]);
    const found = of((await check()).issues, "scope_all");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["color/bg/raised:info"]);
    expect(found[0]!.detail).toMatch(/is a semantic token in "Semantic" left at ALL_SCOPES, as is 1 other \("color\/bg\/raised", "color\/bg\/sunken"\)/);
  });
});

describe("code_syntax_missing", () => {
  it("a platform the brief names with no code syntax is one info per collection and platform; WEB present is quiet", async () => {
    const { prim, sem, vars } = system();
    vars[3]!.codeSyntax = {};
    install(vars, [prim, sem]);
    const r = await check(described(), brief(["web", "ios"]));
    const found = of(r.issues, "code_syntax_missing");
    expect(found.map((i) => i.detail.match(/has no (\w+) code syntax/)![1])).toEqual(["WEB", "iOS", "iOS"]);
    expect(found[0]!.name).toBe("color/text/default");
    expect(found[1]!.detail).toMatch(/nor has 1 other token in "Primitives" \("blue\/500", "grey\/900"\)/);
    expect(of((await check(described(), brief(["web"]))).issues, "code_syntax_missing").map((i) => i.name)).toEqual(["color/text/default"]);
  });

  it("without details.platforms it is not measured, and said", async () => {
    const { prim, sem, vars } = system();
    install(vars, [prim, sem]);
    const r = await check(described(), brief());
    expect(of(r.issues, "code_syntax_missing")).toEqual([]);
    expect(of(r.issues, "library_unmeasured")[0]!.detail).toMatch(/code_syntax_missing \(the brief lists no details\.platforms\)/);
    expect(LIBRARY.platforms.ios).toBe("iOS");
  });
});

describe("description_missing", () => {
  it("a component set or a lone component with no description is info; a described one, a variant, or one whose description cannot be read is not", async () => {
    install([], []);
    const set = mk("COMPONENT_SET", "Button", [0, 0, 300, 100], { description: "" }, [
      mk("COMPONENT", "State=Default", [0, 0, 120, 40], { fills: white, description: "" }),
      mk("COMPONENT", "State=Hover", [150, 0, 120, 40], { fills: white, description: "" }),
    ]);
    const frame = mk("FRAME", "Library", [0, 0, 1000, 400], {}, [
      set,
      mk("COMPONENT", "Badge", [400, 0, 80, 24], { fills: white, description: "  " }),
      mk("COMPONENT", "Chip", [500, 0, 80, 24], { fills: white, description: "A filter people toggle." }),
      mk("COMPONENT", "Tag", [600, 0, 80, 24], { fills: white }),
    ]);
    page(frame);
    const found = of((await check(frame)).issues, "description_missing");
    expect(found.map((i) => `${i.name}:${i.severity}`)).toEqual(["Button:info", "Badge:info"]);
    expect(found[0]!.detail).toMatch(/figma_set_description/);
  });
});

describe("library_unmeasured", () => {
  it("no figma.variables: the token rules are not run, said once; descriptions still are", async () => {
    const r = await check(mk("COMPONENT", "Badge", [0, 0, 80, 24], { description: "" }));
    expect(of(r.issues, "library_unmeasured")[0]!.detail).toMatch(/^not measured: mode_value_missing, alias_broken, scope_all and code_syntax_missing \(this file's variables cannot be read here/);
    expect(pairs(r.issues, "description_missing")).toEqual(["Badge:info"]);
    expect(r.issues.filter((i) => i.severity !== "info")).toEqual([]);
  });
});

describe("the brief through figma_check_layout { briefId }", () => {
  const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });

  it("reads the platforms off the record; the broken token fails the check with or without the brief", async () => {
    const { prim, sem, vars, v } = system();
    vars.push(v("VariableID:2:11", "color/bg/danger", sem, { "2:0": alias("VariableID:gone"), "2:1": alias("VariableID:1:2") }, { scopes: ["FRAME_FILL"], codeSyntax: {} }));
    const c = described();
    const record = JSON.stringify(brief(["web"]));
    const block = mk("FRAME", "Brief · Bench UI", [0, 1000, 720, 400], {
      getSharedPluginData: (ns: string, key: string) => (ns === BRIEF_NAMESPACE && key === BRIEF_KEY ? record : ""),
    });
    install(vars, [prim, sem]);
    const g = (globalThis as unknown as { figma: Record<string, unknown> }).figma;
    g.currentPage = c.parent;
    g.getNodeByIdAsync = async (id: string) => [c, block].find((n) => n.id === id) ?? null;
    type Out = { ok: boolean; issues: Issue[]; audit: { brief: unknown } };
    const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: c.id, audit: ["library"], briefId: block.id }))) as Out;
    expect(r.audit.brief).toMatchObject({ id: "9:6", role: "design-system" });
    expect(pairs(r.issues, "alias_broken")).toEqual(["color/bg/danger:warning"]);
    expect(pairs(r.issues, "code_syntax_missing")).toEqual(["color/bg/danger:info"]);
    expect(r.ok).toBe(false);
    const bare = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: c.id, audit: ["library"] }))) as Out;
    expect(of(bare.issues, "code_syntax_missing")).toEqual([]);
    expect(pairs(bare.issues, "alias_broken")).toEqual(["color/bg/danger:warning"]);
    expect(bare.audit.brief).toMatch(/and library skips what needs the brief's numbers/);
  });
});
