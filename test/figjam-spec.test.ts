// create_from_spec's FigJam types — sticky, shape, table, code, connector —
// against the spec-types contract (src/plugin/spec-types.ts), and then through
// the real builder.
//
// The contract half runs each handler the way the builder promises to: validate
// every node before the first exists (a refusal names its path and says
// nothing exists), then build — record, append into the final parent, write,
// place. The builder half needs WP-E's create.ts, which consults the spec-type
// registry and knows `ref` and a section's `arrange`; until that lands those two
// tests fail (today: "`spec.arrange` is not a field of a section"), which is
// expected (plan § Integration). Run against WP-E's work in progress on
// 2026-10-09, all ten passed. One zone per call is the official rhythm
// [C-155]; connectors come last, in their final parent [C-149].

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import { FIGJAM_SPEC_TYPES, registerFigjamSpecTypes } from "../src/plugin/figjam/spec-types.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import { specType, specTypeRunsIn, type SpecBuild, type SpecCheck, type SpecFields } from "../src/plugin/spec-types.js";
import { parseColor, type NodeLikeW } from "../src/plugin/write.js";
import { board, BoardFigma, BoardTable, FakeConnector, FakeSection, FakeShapeWithText, FakeSticky, opContext, solid, type FakeNode } from "./figjam-fakes.js";

let fake: BoardFigma;
let restore: () => void;

beforeEach(() => {
  ({ fake, restore } = board());
  registerFigjamSpecTypes();
});
afterEach(() => restore());

function check(refs: string[] = []): SpecCheck {
  return {
    editor: "figjam",
    refs: new Set(refs),
    refuse(path, message, hint) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, message, { ...(hint ? { hint } : {}), partial: { created: [], failedAt: path } });
    },
    parseColor,
  };
}

/** A SpecBuild that keeps the contract and logs every step it is asked for. */
function builder(refs: Record<string, FakeNode> = {}) {
  const log: string[] = [];
  const created: string[] = [];
  const b: SpecBuild = {
    editor: "figjam",
    record(node) {
      log.push(`record ${node.id}`);
      created.push(node.id);
      return node;
    },
    append(parent, child) {
      log.push(`append ${child.id} → ${parent.id}`);
      parent.appendChild!(child);
    },
    place(node, x, y) {
      log.push(`place ${node.id}`);
      const at = node as unknown as { x: number; y: number };
      if (x !== undefined) at.x = x;
      if (y !== undefined) at.y = y;
    },
    async resolveRef(refOrId) {
      log.push(`resolve ${refOrId}`);
      const node = refs[refOrId] ?? (await fake.getNodeByIdAsync(refOrId));
      if (!node) throw new Error(`no ${refOrId}`);
      return node as unknown as NodeLikeW;
    },
    loadFont: (font) => fake.loadFontAsync(font),
    yieldToHost: async () => {},
  };
  return { b, log, created };
}

/** The refusal a call makes, whether it throws at once (a sync validate) or rejects. */
async function refused(call: () => unknown): Promise<BridgeError> {
  try {
    await call();
  } catch (err) {
    return err as BridgeError;
  }
  throw new Error("expected a refusal");
}

const handler = (type: string) => specType(type)!;

describe("the FigJam spec types — contract", () => {
  it("register five FigJam-only types; connectors are deferred, none takes children; registering twice is harmless", () => {
    registerFigjamSpecTypes();
    expect(Object.keys(FIGJAM_SPEC_TYPES).sort()).toEqual(["code", "connector", "shape", "sticky", "table"]);
    for (const [name, h] of Object.entries(FIGJAM_SPEC_TYPES)) {
      expect(specType(name)).toBe(h);
      expect(h.container).toBe(false);
      expect(specTypeRunsIn(h, "figjam")).toBe(true);
      expect(specTypeRunsIn(h, "figma")).toBe(false);
      expect(!!h.deferred).toBe(name === "connector");
    }
  });

  it("validate refuses before anything exists, naming the field: a sticky's size, a connector's box, a bad colour", async () => {
    const sized = await refused(() => handler("sticky").validate({ type: "sticky", content: "a", width: 300 }, "spec.children[0]", check()));
    expect(sized.partial).toEqual({ created: [], failedAt: "spec.children[0].width" });
    expect(sized.hint).toMatch(/wide/);
    const boxed = await refused(() => handler("connector").validate({ type: "connector", from: "1:2", to: "1:3", x: 10 }, "spec.children[3]", check()));
    expect(boxed.partial).toEqual({ created: [], failedAt: "spec.children[3].x" });
    const colour = await refused(() => handler("shape").validate({ type: "shape", shape: "diamond", content: "?", color: "light-sticky" }, "spec", check()));
    expect(colour.partial).toEqual({ created: [], failedAt: "spec.color" });
    expect(fake.nodes.size).toBe(2); // the document and its page
  });

  it("a connector end names a declared ref or an existing node; anything else is refused with its path", async () => {
    const c = handler("connector");
    const unknown = await refused(() => c.validate({ type: "connector", from: "card_a", to: "card_b@top" }, "spec.children[2]", check(["card_a"])));
    expect(unknown.partial).toEqual({ created: [], failedAt: "spec.children[2].to" });
    expect(unknown.hint).toMatch(/card_a/);
    await expect(Promise.resolve(c.validate({ type: "connector", from: "card_a", to: "card_b@top" }, "spec", check(["card_a", "card_b"])))).resolves.toBeUndefined();
    const missing = await refused(() => c.validate({ type: "connector", from: "404:1", to: "card_a" }, "spec.children[1]", check(["card_a"])));
    expect(missing.partial).toEqual({ created: [], failedAt: "spec.children[1].from" });
    const line = fake.createConnector();
    const onLine = await refused(() => c.validate({ type: "connector", from: line.id, to: "card_a" }, "spec", check(["card_a"])));
    expect(onLine.message).toMatch(/is a connector/);
  });

  it("build records, appends into the final parent, writes, then places", async () => {
    const section = fake.section();
    const { b, log, created } = builder();
    const node = (await handler("sticky").build({ type: "sticky", content: "Ship it", color: "green", x: 40, y: 50, name: "Win" }, section as unknown as NodeLikeW, b)) as unknown as FakeSticky;
    expect(log).toEqual([`record ${node.id}`, `append ${node.id} → ${section.id}`, `place ${node.id}`]);
    expect(created).toEqual([node.id]);
    expect(node.parent).toBe(section);
    expect([node.x, node.y, node.name, node.text.characters]).toEqual([40, 50, "Win", "Ship it"]);
    expect((node.fills as Array<{ color: unknown }>)[0]!.color).toEqual(solid("#B3EFBD").color);
  });

  it("a connector resolves its refs and is in its parent before its ends are set [C-149]", async () => {
    const section = fake.section();
    const a = fake.createSticky();
    const z = fake.createSticky();
    section.appendChild(a);
    section.appendChild(z);
    const { b, log } = builder({ start: a, finish: z });
    const node = (await handler("connector").build({ type: "connector", from: "start@right", to: "finish", label: "then", strokeWeight: 4 }, section as unknown as NodeLikeW, b)) as unknown as FakeConnector;
    expect(log.slice(0, 2)).toEqual(["resolve start", "resolve finish"]);
    expect(log.indexOf(`append ${node.id} → ${section.id}`)).toBeGreaterThan(log.indexOf(`record ${node.id}`));
    expect(node.parent).toBe(section);
    expect(node.connectorStart).toEqual({ endpointNodeId: a.id, magnet: "RIGHT" });
    expect(node.connectorEnd).toEqual({ endpointNodeId: z.id, magnet: "AUTO" });
    expect([node.connectorStartStrokeCap, node.connectorEndStrokeCap, node.strokeWeight, node.text.characters]).toEqual(["NONE", "ARROW_LINES", 4, "then"]);
  });

  it("a ref that turns out to be a connector is refused at build — nodes exist by then, so no `created: []` [C-148]", async () => {
    const line = fake.createConnector();
    const z = fake.createSticky();
    const { b } = builder({ line, z });
    const e = await refused(() => handler("connector").build({ type: "connector", from: "line", to: "z" }, fake.currentPage as unknown as NodeLikeW, b));
    expect(e.message).toMatch(/is a connector/);
    expect(e.partial).toBeUndefined();
  });

  it("shape, table and code build through the same builders as the tools", async () => {
    const section = fake.section();
    const parent = section as unknown as NodeLikeW;
    const { b } = builder();
    const shape = (await handler("shape").build({ type: "shape", shape: "label", content: "7", color: "violet" }, parent, b)) as unknown as FakeShapeWithText;
    expect([shape.shapeType, shape.width, shape.text.fontSize]).toEqual(["ELLIPSE", 48, 20]);
    const fitted = (await handler("shape").build({ type: "shape", shape: "rounded-rectangle", content: "Review the draft" }, parent, b)) as unknown as FakeShapeWithText;
    expect([fitted.width, fitted.height]).toEqual([200, 120]);
    expect(fake.texts.every((t) => t.removed)).toBe(true); // the measurer never outlives a build
    const table = (await handler("table").build({ type: "table", rows: [["Owner", "Task"], ["Ada", "Draft"]], columnWidths: [120, 260] }, parent, b)) as unknown as BoardTable;
    expect([table.numRows, table.columnWidths]).toEqual([2, [120, 260]]);
    expect(table.cellAt(1, 1).text.characters).toBe("Draft");
    const code = (await handler("code").build({ type: "code", content: "SELECT 1", language: "sql" }, parent, b)) as unknown as { codeLanguage: string; parent: unknown };
    expect([code.codeLanguage, code.parent]).toEqual(["SQL", section]);
  });

  it("a table's font is loaded exactly, or the build fails with FONT_LOAD_FAILED", async () => {
    fake.unloadable.add("Nope Sans|Bold");
    const { b } = builder();
    const spec: SpecFields = { type: "table", numRows: 1, numColumns: 1, fontFamily: "Nope Sans", weight: "700" };
    await expect(handler("table").build(spec, fake.currentPage as unknown as NodeLikeW, { ...b, loadFont: async (f) => {
      try {
        await fake.loadFontAsync(f);
      } catch (err) {
        throw new BridgeError(ErrorCode.FONT_LOAD_FAILED, String(err));
      }
    } })).rejects.toMatchObject({ code: ErrorCode.FONT_LOAD_FAILED });
  });
});

// ── through the real builder ────────────────────────────────────────────────
// Needs WP-E's create.ts (spec types, `ref`, section `arrange`). Fails until
// that merges — expected.

type Created = { id: string };
const fromSpec = (spec: unknown) => CREATE_OPS.create_from_spec!.run(opContext({ spec: JSON.stringify(spec) })) as Promise<{ rootId: string; created: Created[] }>;

describe("the FigJam spec types — through figma_create_from_spec", () => {
  it("builds a retro zone in one call: a grid of stickies, a table and two connectors by ref, connectors last", async () => {
    const zone = {
      type: "section",
      name: "Went well",
      arrange: "grid:3",
      gap: 64,
      children: [
        ...Array.from({ length: 9 }, (_, i) => ({ type: "sticky", ref: `s${i}`, content: i === 4 ? "a longer note ".repeat(20) : `Idea ${i}`, color: "green" })),
        { type: "table", ref: "votes", rows: [["Idea", "Votes"], ["Idea 0", "3"]] },
        { type: "connector", from: "s0", to: "s1" },
        { type: "connector", from: "s1@right", to: "votes", label: "tally" },
      ],
    };
    const r = await fromSpec(zone);
    const section = fake.nodes.get(r.rootId) as FakeSection;
    expect(section.type).toBe("SECTION");
    const kids = section.children;
    expect(kids).toHaveLength(12);
    expect(kids.slice(-2).map((k) => k.type)).toEqual(["CONNECTOR", "CONNECTOR"]);
    const stickies = kids.filter((k) => k.type === "STICKY") as FakeSticky[];
    const byText = (t: string) => stickies.find((s) => s.text.characters === t)!;
    expect((kids[10] as FakeConnector).connectorStart).toEqual({ endpointNodeId: byText("Idea 0").id, magnet: "AUTO" });
    expect((kids[11] as FakeConnector).connectorEnd).toEqual({ endpointNodeId: kids.find((k) => k.type === "TABLE")!.id, magnet: "AUTO" });
    for (let i = 0; i < stickies.length; i++) {
      for (let j = i + 1; j < stickies.length; j++) {
        const [a, b] = [stickies[i]!, stickies[j]!];
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${i}/${j}`).toBe(true);
      }
    }
    const ids = new Set(r.created.map((c) => c.id));
    expect(kids.every((k) => ids.has(k.id))).toBe(true);
    expect(fake.undoCommits).toBe(0); // the runner's one commitUndo is the only one
  });

  it("refuses a duplicate ref, and an endpoint naming no ref, before anything exists", async () => {
    const dup = await refused(() => fromSpec({ type: "section", children: [{ type: "sticky", ref: "a", content: "1" }, { type: "sticky", ref: "a", content: "2" }] }));
    expect(dup.code).toBe(ErrorCode.INVALID_PARAM);
    expect((dup.partial as { created: unknown[] }).created).toEqual([]);
    const unknown = await refused(() => fromSpec({ type: "section", children: [{ type: "sticky", ref: "a", content: "1" }, { type: "connector", from: "a", to: "ghost" }] }));
    expect(unknown.code).toBe(ErrorCode.INVALID_PARAM);
    expect(unknown.partial).toMatchObject({ created: [] });
    expect((unknown.partial as { failedAt: string }).failedAt).toMatch(/^spec\.children\[1\]/);
    expect([...fake.nodes.values()].filter((n) => n.type === "STICKY")).toEqual([]);
  });
});
