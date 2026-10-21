// Trust in the plugin (trust spec §2.1–§2.3, §2.5; the trust contract's part
// A): who changed what, the agent's view times, the stale-write guard, and the
// get_changes, savepoint and rollback ops — against a fake `figma` whose
// nodechange events the test emits, on a fake clock. The last block runs the
// BUILT sandbox (dist/plugin/code.js), as test/plugin-bundle.test.ts does, so
// the dispatcher's own wiring is what is tested there.

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { changedNothing, type StoredResult } from "../src/plugin/idempotency.js";
import {
  LIMITS, SETTLE_MS, Trust, UNDO, agentOf, clock, namedIds, targetsOf, trustOps, withConflicts, type ChangeLike, type Conflict, type Guard,
} from "../src/plugin/trust.js";
import { notBatchable } from "../src/plugin/ops/batch.js";
import { sleep } from "./helpers.js";

// ── a small world ───────────────────────────────────────────────────────────

type N = {
  id: string;
  name: string;
  type: string;
  parent: N | null;
  children: N[];
  layoutMode?: string;
  removed?: boolean;
  /** Any other property a test gives a node (characters, fills, effects, resolvedVariableModes). */
  [prop: string]: unknown;
};

function world() {
  const nodes = new Map<string, N>();
  const add = (id: string, name: string, type: string, parent: N | null, layoutMode?: string): N => {
    const n: N = { id, name, type, parent, children: [], ...(layoutMode ? { layoutMode } : {}) };
    parent?.children.push(n);
    nodes.set(id, n);
    return n;
  };
  const doc = add("0:0", "Document", "DOCUMENT", null);
  const page = add("0:1", "Page 1", "PAGE", doc);
  const section = add("1:0", "Hero section", "FRAME", page);
  const card = add("1:1", "Card", "FRAME", section);
  const title = add("1:2", "Title", "TEXT", card);
  const body = add("1:3", "Body", "TEXT", card);
  const other = add("2:1", "Other", "FRAME", page);
  title.characters = "Hello";
  body.characters = "Body copy";
  const undos: number[] = [];
  const figma: {
    currentPage: { id: string; name: string; selection: N[] };
    getNodeByIdAsync(id: string): Promise<N | null>;
    triggerUndo(): void;
    variables?: { getLocalVariablesAsync(): Promise<unknown[]> };
  } = {
    currentPage: { id: page.id, name: page.name, selection: [] as N[] },
    getNodeByIdAsync: async (id: string) => {
      const n = nodes.get(id);
      return n && !n.removed ? n : null;
    },
    triggerUndo: () => void undos.push(undos.length + 1),
  };
  const move = (n: N, to: N) => {
    if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
    n.parent = to;
    to.children.push(n);
  };
  const remove = (n: N) => {
    if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
    n.parent = null;
    n.removed = true;
  };
  return { nodes, add, doc, page, section, card, title, body, other, figma, undos, move, remove };
}

let now = 1_000_000_000;
const advance = (ms: number) => (now += ms);

function setup() {
  const w = world();
  const trust = new Trust({ now: () => now, figma: () => w.figma });
  return { w, trust, ops: trustOps(trust) };
}

/**
 * A change as an event that does not say what changed reports it: the live
 * node, or a RemovedNode for a deletion. Past every window it is the agent's
 * only when a full record of the node still matches it whole.
 */
const local = (n: N): ChangeLike => ({ id: n.id, origin: "LOCAL", node: n.removed ? { id: n.id, type: n.type, removed: true } : n });
const remote = (n: N): ChangeLike => ({ id: n.id, origin: "REMOTE", node: n });
/** A property change as Figma reports it: what changed, by name (NodeChangeProperty), without changing anything here. */
const changed = (n: N, properties: string[], origin = "LOCAL"): ChangeLike => ({ id: n.id, origin, type: "PROPERTY_CHANGE", properties, node: n });
/** A real edit: `prop` gets a new value (by default the old one with "*" added), and the change says so. */
const edit = (n: N, prop = "characters", value?: unknown, origin = "LOCAL"): ChangeLike => {
  n[prop] = value !== undefined ? value : `${String(n[prop] ?? "")}*`;
  return changed(n, [prop], origin);
};
const emit = (t: Trust, ...changes: ChangeLike[]) => t.nodesChanged({ nodeChanges: changes });

const ctxFor = (params: Record<string, unknown>, touched?: (ids: readonly string[]) => void): OpContext => ({
  requestId: "r",
  params,
  yieldToHost: async () => {},
  progress: () => {},
  isCancelled: () => false,
  ...(touched ? { touched } : {}),
});

function stored(err: unknown): StoredResult {
  const e = err as BridgeError;
  return { ok: false, error: { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }, ...(e.partial !== undefined ? { partial: e.partial } : {}) };
}

/**
 * What code.ts does around one request: the guard before a write, begin, the
 * op, one commit after a write, end. `commits` counts the commitUndo calls.
 */
async function dispatch(
  trust: Trust,
  op: string,
  params: Record<string, unknown>,
  opts: { write: boolean; guard?: Guard; run?: (ctx: OpContext) => Promise<unknown> },
): Promise<StoredResult & { commits: number }> {
  let commits = 0;
  let conflicts: Conflict[] = [];
  let result: StoredResult | null = null;
  if (opts.write && opts.guard) {
    const g = await trust.guard(op, params, opts.guard);
    if (g.refusal) result = stored(g.refusal);
    conflicts = g.conflicts;
  }
  if (!result) {
    const span = await trust.begin(op, params, opts.write, agentOf(opts.guard));
    try {
      const data = await (opts.run ?? (async () => ({})))(ctxFor(params, (ids) => trust.touched(span, ids)));
      result = { ok: true, data: withConflicts(data, conflicts) };
    } catch (err) {
      result = stored(err);
    }
    if (opts.write) {
      commits++;
      trust.committed(result);
    }
    await trust.end(span, result);
  }
  return { ...result, commits };
}

const read = (t: Trust, op: string, params: Record<string, unknown>) => dispatch(t, op, params, { write: false });
const write = (t: Trust, op: string, params: Record<string, unknown>, run?: (ctx: OpContext) => Promise<unknown>, guard?: Guard) =>
  dispatch(t, op, params, { write: true, ...(run ? { run } : {}), ...(guard ? { guard } : {}) });
const changesOf = (t: Trust, since = 0) => t.changes(since).changes.map((c) => `${c.nodeId}:${c.by}`);

// ── attribution ─────────────────────────────────────────────────────────────

describe("who changed what (spec §2.1)", () => {
  it("a LOCAL change in a write's footprint is the agent's while it runs and for SETTLE_MS after; past that, only while the node is as the write left it", async () => {
    const { w, trust } = setup();
    await write(trust, "set_fills", { nodeId: w.card.id }, async () => {
      emit(trust, local(w.card), local(w.title)); // the target and a layer under it
      return { items: [{ id: w.card.id, ok: true }] };
    });
    advance(SETTLE_MS - 1);
    emit(trust, local(w.card), local(w.section)); // still settling; the section is an ancestor
    expect(changesOf(trust)).toEqual([]);
    advance(2);
    emit(trust, local(w.card)); // late, and the card is as the write left it: the write's own echo
    expect(changesOf(trust)).toEqual([]);
    emit(trust, edit(w.card, "name")); // renamed by hand
    expect(changesOf(trust)).toEqual(["1:1:person"]);
  });

  it("outside every footprint a LOCAL change is a person's, even while the agent writes; a REMOTE one is always a collaborator's", async () => {
    const { w, trust } = setup();
    await write(trust, "set_fills", { nodeId: w.card.id }, async () => {
      emit(trust, local(w.other), remote(w.title));
      return {};
    });
    expect(changesOf(trust)).toEqual(["2:1:person", "1:2:collaborator"]);
  });

  it("what a write created is in its footprint: its change, held while the op ran, is judged once the id is known", async () => {
    const { w, trust } = setup();
    const made = w.add("5:1", "New frame", "FRAME", w.page);
    await write(trust, "create_frame", { name: "New frame" }, async () => {
      emit(trust, local(made)); // a CREATE on the page, before the result names it
      return { id: made.id, name: made.name };
    });
    expect(changesOf(trust)).toEqual([]);
  });

  it("a page a result names is never a seed: it would cover everything on it", async () => {
    const { w, trust } = setup();
    const elsewhere: N = { id: "0:9", name: "Page 2", type: "PAGE", parent: w.doc, children: [] }; // not looked up
    const there: N = { id: "9:2", name: "Theirs", type: "FRAME", parent: elsewhere, children: [] };
    await write(trust, "create_frame", {}, async () => (emit(trust, local(there)), { id: "9:1", pageId: elsewhere.id }));
    expect(changesOf(trust)).toEqual(["9:2:person"]);
  });

  it("parentId is in the footprint: adding into a frame reflows it", async () => {
    const { w, trust } = setup();
    await write(trust, "create_text", { parentId: w.card.id, content: "Hi" }, async () => {
      emit(trust, local(w.card), local(w.body)); // the card resizes, a sibling inside it moves
      return { id: "9:1" };
    });
    expect(changesOf(trust)).toEqual([]);
  });

  it("auto-layout reflow: a sibling under an auto-layout ancestor is covered; under a plain frame it is not", async () => {
    const { w, trust } = setup();
    const list = w.add("3:0", "List", "FRAME", w.page, "VERTICAL");
    const a = w.add("3:1", "Item A", "INSTANCE", list, "HORIZONTAL");
    const label = w.add("3:2", "Label", "TEXT", a);
    const b = w.add("3:3", "Item B", "INSTANCE", list);
    await write(trust, "set_text", { nodeId: label.id, content: "Longer" }, async () => {
      emit(trust, local(b)); // B moves down as A grows
      return {};
    });
    expect(changesOf(trust)).toEqual([]);

    list.layoutMode = "NONE";
    advance(5_000);
    await write(trust, "set_text", { nodeId: label.id, content: "Longer still" }, async () => {
      emit(trust, local(b));
      return {};
    });
    expect(changesOf(trust)).toEqual(["3:3:person"]);
  });

  it("nodes an op declares through ctx.touched — copies it deleted again — are the agent's, deleted ones included", async () => {
    const { w, trust } = setup();
    const copy = w.add("8:1", "Card · stress: expand", "FRAME", w.page);
    const inner = w.add("8:2", "Title", "TEXT", copy);
    await write(trust, "stress_test", { nodeId: w.card.id }, async (ctx) => {
      ctx.touched!([copy.id, inner.id]);
      w.remove(copy);
      inner.removed = true;
      emit(trust, local(copy), local(inner));
      return { baseline: { ok: true }, cases: [] };
    });
    expect(changesOf(trust)).toEqual([]);
  });

  it("ancestry is recorded when the change arrives: a layer moved later still counts under its old parent", async () => {
    const { w, trust } = setup();
    await read(trust, "get_node", { nodeId: w.card.id });
    advance(1_000);
    emit(trust, edit(w.title));
    w.move(w.title, w.other);
    advance(1_000);
    const g = await trust.guard("set_fills", { nodeId: w.card.id }, { conflicts: "refuse" });
    expect(g.conflicts).toEqual([{ nodeId: "1:1", name: "Card", by: "person", at: now - 1_000, viewedAt: now - 2_000 }]);
  });

  it("a deleted layer is placed by the ancestry last seen for it", async () => {
    const { w, trust } = setup();
    await read(trust, "get_node", { nodeId: w.card.id });
    advance(1_000);
    emit(trust, local(w.title)); // seen once, under the card
    advance(1_000);
    w.remove(w.title);
    emit(trust, local(w.title));
    expect(trust.changes().changes).toEqual([{ nodeId: "1:2", name: "Title", by: "person", at: now }]);
    const g = await trust.guard("set_fills", { nodeId: w.card.id }, { conflicts: "refuse" });
    expect(g.conflicts.map((c) => c.at)).toEqual([now]);
  });

  it("memory is bounded: the latest change per node for LIMITS.changes nodes", () => {
    const { w, trust } = setup();
    for (let i = 0; i < LIMITS.changes + 100; i++) emit(trust, local(w.add(`7:${i}`, `N${i}`, "RECTANGLE", w.page)));
    expect((trust as unknown as { foreign: Map<string, unknown> }).foreign.size).toBe(LIMITS.changes);
    expect(trust.changes().changes).toHaveLength(LIMITS.listed);
    expect(trust.changes().changes[0]!.nodeId).toBe(`7:${LIMITS.changes + 100 - LIMITS.listed}`);
  });

  it("the constants a live run calibrates are where the spec says", () => {
    expect(SETTLE_MS).toBe(1_500);
    expect(UNDO.emptyCommitIsAStep).toBe(false);
  });
});

// ── content, not time (role tests 2026-10-19, findings 6, 6b, 6c) ──────────

const REFUSE: Guard = { conflicts: "refuse" };
const COLLECTION = "VariableCollectionId:9:0";
const LIGHT = { [COLLECTION]: "9:1" };
const DARK = { [COLLECTION]: "9:2" };

/** A solid fill whose colour is bound to `variableId`; `rgb` is what it resolves to now. */
const boundFill = (variableId: string, rgb: { r: number; g: number; b: number }) => [
  { type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: rgb, boundVariables: { color: { type: "VARIABLE_ALIAS", id: variableId } } },
];
const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };

/** A colour variable, and a fake variables API that lists it; `set` changes its value as the Variables panel would. */
function accentVariable(w: ReturnType<typeof world>) {
  const accent = { id: "VariableID:9:1", name: "color/accent", resolvedType: "COLOR", valuesByMode: { "9:1": { ...RED, a: 1 } } as Record<string, unknown> };
  w.figma.variables = { getLocalVariablesAsync: async () => [accent] };
  const set = (rgb: typeof RED, ...bound: N[]) => {
    accent.valuesByMode = { "9:1": { ...rgb, a: 1 } };
    for (const n of bound) n.fills = boundFill(accent.id, rgb);
  };
  return { accent, set };
}

describe("content decides, time is a hint (findings 6, 6b, 6c)", () => {
  it("(a) a write whose nodechange arrives after the settle window, then a second write to the node: no STALE, nothing listed", async () => {
    const { w, trust } = setup();
    w.title.width = 120;
    await read(trust, "get_node", { nodeId: w.card.id });
    advance(1_000);
    await write(trust, "set_text", { nodeId: w.title.id, content: "New" }, async () => {
      w.title.characters = "New";
      w.title.width = 64;
      return { id: w.title.id };
    }, REFUSE);
    advance(SETTLE_MS + 60_000); // a minute late, as Figma delivered them in the background
    emit(trust, changed(w.title, ["characters", "width"]), changed(w.title, ["characters"], "REMOTE"), changed(w.card, ["height"]));
    expect(trust.changes()).toMatchObject({ changes: [], conflicts: [] });
    const again = await write(trust, "set_text", { nodeId: w.title.id, content: "Newer" }, async () => ((w.title.characters = "Newer"), { id: w.title.id }), REFUSE);
    expect(again.ok).toBe(true);
    expect((await trust.guard("set_fills", { nodeId: w.card.id }, REFUSE)).conflicts).toEqual([]);
  });

  it("(a) a write's after-state covers its reflowed siblings and hugging parent, and a deletion's late event", async () => {
    const { w, trust } = setup();
    const list = w.add("3:0", "List", "FRAME", w.section, "VERTICAL");
    const a = w.add("3:1", "Item A", "TEXT", list);
    const b = w.add("3:2", "Item B", "TEXT", list);
    for (const [n, y] of [[list, 0], [a, 0], [b, 20]] as const) Object.assign(n, { x: 0, y, width: 100, height: 20 });
    a.characters = "A";
    await read(trust, "get_node", { nodeId: w.section.id });
    advance(1_000);
    await write(trust, "set_text", { nodeId: a.id, content: "A, longer, on two lines" }, async () => {
      Object.assign(a, { characters: "A, longer, on two lines", height: 40 });
      b.y = 40; // the sibling reflows
      list.height = 60; // the list hugs
      return { id: a.id };
    }, REFUSE);
    advance(SETTLE_MS + 10_000);
    emit(trust, changed(b, ["y", "relativeTransform"]), changed(list, ["height"]));
    await write(trust, "delete_nodes", { nodeIds: [b.id] }, async () => (w.remove(b), { deleted: [b.id] }), REFUSE);
    advance(SETTLE_MS + 10_000);
    emit(trust, { id: b.id, origin: "LOCAL", type: "DELETE", node: { id: b.id, type: "TEXT", removed: true } });
    expect(trust.changes().changes).toEqual([]);
    expect((await write(trust, "set_auto_layout", { nodeId: list.id }, undefined, REFUSE)).ok).toBe(true);
  });

  it("(b) a variable value change re-colouring bound nodes, then a text write to one of them: no STALE", async () => {
    const { w, trust } = setup();
    const { accent, set } = accentVariable(w);
    const badge = w.add("2:2", "Badge", "RECTANGLE", w.other); // bound too, never read by the agent
    for (const n of [w.title, w.body, badge]) Object.assign(n, { fills: boundFill(accent.id, RED), resolvedVariableModes: LIGHT });
    await read(trust, "get_node", { nodeId: w.card.id });
    advance(1_000);
    await write(trust, "set_variable_value", { variableId: accent.id, value: "#0000ff" }, async () => {
      set(BLUE, w.title, w.body, badge);
      emit(trust, changed(w.title, ["fills"])); // on time
      return { variableId: accent.id, name: accent.name, modeId: "9:1", type: "COLOR" };
    }, REFUSE);
    advance(SETTLE_MS + 30_000);
    emit(trust, changed(w.body, ["fills"]), changed(badge, ["fills"])); // late: one the agent read, one it never saw
    expect(trust.changes().changes).toEqual([]);
    const r = await write(trust, "set_text", { nodeId: w.body.id, content: "Still mine to write" }, async () => ({ id: w.body.id }), REFUSE);
    expect(r.ok).toBe(true);
    expect((await trust.guard("set_fills", { nodeId: w.card.id }, REFUSE)).conflicts).toEqual([]);
  });

  it("(b) a variable write's window covers the whole page, and only its window: the documented trade-off", async () => {
    const { w, trust } = setup();
    const { accent, set } = accentVariable(w);
    await write(trust, "set_variable_value", { variableId: accent.id, value: "#0000ff" }, async () => (set(BLUE), { variableId: accent.id }), REFUSE);
    advance(SETTLE_MS - 1);
    emit(trust, edit(w.other, "name")); // a person's rename inside the window reads as the agent's
    expect(changesOf(trust)).toEqual([]);
    advance(2);
    emit(trust, edit(w.other, "name"));
    expect(changesOf(trust)).toEqual(["2:1:person"]);
  });

  it("(b) a re-colouring is the agent's only through the variables it changed: a raw recolour, a rebinding or another variable is not", async () => {
    const { w, trust } = setup();
    const { accent, set } = accentVariable(w);
    const lone = w.add("2:3", "Lone", "RECTANGLE", w.other); // never read: no record
    lone.fills = [{ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: RED }];
    const other = w.add("2:4", "Bound elsewhere", "RECTANGLE", w.other);
    other.fills = boundFill("VariableID:9:7", RED);
    w.title.fills = boundFill(accent.id, RED);
    await read(trust, "get_node", { nodeId: w.card.id });
    await write(trust, "set_variable_value", { variableId: accent.id, value: "#0000ff" }, async () => (set(BLUE), { variableId: accent.id }), REFUSE);
    advance(SETTLE_MS + 10_000);
    lone.fills = [{ type: "SOLID", visible: true, opacity: 1, blendMode: "NORMAL", color: BLUE }];
    other.fills = boundFill("VariableID:9:7", BLUE);
    w.title.fills = boundFill("VariableID:9:7", BLUE); // the person rebinds the title
    emit(trust, changed(lone, ["fills"]), changed(other, ["fills"]), changed(w.title, ["fills"]));
    expect(changesOf(trust)).toEqual(["2:3:person", "2:4:person", "1:2:person"]);
  });

  it("(c) a person's real edit between two agent calls is still STALE, however late it is reported", async () => {
    const { w, trust } = setup();
    await read(trust, "get_node", { nodeId: w.card.id });
    advance(1_000);
    await write(trust, "set_text", { nodeId: w.title.id, content: "Agent" }, async () => ((w.title.characters = "Agent"), { id: w.title.id }), REFUSE);
    advance(10_000);
    w.title.characters = "Mine"; // typed by hand; Figma reports it two minutes later, with the agent's own change
    advance(120_000);
    emit(trust, changed(w.title, ["characters"]));
    const r = await write(trust, "set_text", { nodeId: w.title.id, content: "Agent again" }, async () => ({ id: w.title.id }), REFUSE);
    expect(r.ok ? "" : r.error.code).toBe("STALE");
    expect(w.title.characters).toBe("Mine");
    // On time, and as a collaborator's: the same.
    await read(trust, "get_node", { nodeId: w.card.id });
    advance(1_000);
    emit(trust, edit(w.body, "characters", "Theirs", "REMOTE"));
    const g = await trust.guard("set_text", { nodeId: w.body.id }, REFUSE);
    expect(g.refusal?.code).toBe("STALE");
    expect(g.conflicts).toEqual([expect.objectContaining({ nodeId: w.body.id, by: "collaborator" })]);
  });

  it("(c) a change the agent made that a person then changed again is the person's, even reported as one event", async () => {
    const { w, trust } = setup();
    await write(trust, "rename_node", { nodeId: w.card.id, name: "Agent card" }, async () => ((w.card.name = "Agent card"), { id: w.card.id }), REFUSE);
    advance(SETTLE_MS + 5_000);
    emit(trust, edit(w.card, "name", "Person card"));
    expect((await trust.guard("rename_node", { nodeId: w.card.id }, REFUSE)).refusal?.code).toBe("STALE");
  });

  it("(d) create_from_spec, then set_effects and set_variable_mode on what it made, every echo late and REMOTE: no STALE", async () => {
    const { w, trust } = setup();
    const { accent } = accentVariable(w);
    let hero: N | undefined;
    let label: N | undefined;
    const made = await write(trust, "create_from_spec", { parentId: w.section.id, spec: { type: "frame", name: "Hero" } }, async () => {
      hero = w.add("5:1", "Hero", "FRAME", w.section, "VERTICAL");
      label = w.add("5:2", "Label", "TEXT", hero);
      Object.assign(hero, { effects: [], resolvedVariableModes: LIGHT });
      Object.assign(label, { characters: "Book a table", effects: [], fills: boundFill(accent.id, RED), resolvedVariableModes: LIGHT });
      return { rootId: hero.id, created: [{ id: hero.id, name: "Hero", path: "0" }, { id: label.id, name: "Label", path: "0.0" }], nodeCount: 2 };
    }, REFUSE);
    expect(made.ok).toBe(true);
    advance(SETTLE_MS + 5_000);
    emit(trust, { id: hero!.id, origin: "REMOTE", type: "CREATE", node: hero }, changed(label!, ["characters", "fills"], "REMOTE"));

    const effects = await write(trust, "set_effects", { nodeIds: [label!.id] }, async () => {
      label!.effects = [{ type: "DROP_SHADOW", radius: 4, visible: true }];
      return { items: [{ id: label!.id, ok: true }] };
    }, REFUSE);
    expect(effects.ok).toBe(true);
    advance(SETTLE_MS + 5_000);
    emit(trust, changed(label!, ["effects"], "REMOTE"));

    const mode = await write(trust, "set_variable_mode", { nodeIds: [hero!.id], collectionId: COLLECTION, mode: "Dark" }, async () => {
      hero!.resolvedVariableModes = DARK;
      label!.resolvedVariableModes = DARK; // the label inside re-resolves: its bound fill shows the Dark value
      label!.fills = boundFill(accent.id, BLUE);
      return { updated: 1, items: [{ id: hero!.id, ok: true }] };
    }, REFUSE);
    expect(mode.ok).toBe(true);
    advance(SETTLE_MS + 5_000);
    emit(trust, changed(label!, ["fills"]), changed(label!, ["fills"], "REMOTE"));
    expect(trust.changes()).toMatchObject({ changes: [], conflicts: [] });

    // Finding 6c's last case: a batch calling set_effects again on the label.
    const again = await write(trust, "batch", { steps: [{ op: "set_effects", params: { nodeIds: [label!.id] } }] }, async () => ({ results: [{ ok: true }] }), REFUSE);
    expect(again.ok).toBe(true);
    // A person switching the mode by hand is not the agent's: the label's modes differ from what the agent last saw.
    advance(SETTLE_MS + 5_000);
    label!.resolvedVariableModes = LIGHT;
    label!.fills = boundFill(accent.id, RED);
    emit(trust, changed(label!, ["fills"]));
    expect(changesOf(trust)).toEqual(["5:2:person"]);
  });

  it("(e) rollback: the agent's own late echoes do not block it; a person's real edit, reported late, still does", async () => {
    for (const personToo of [false, true]) {
      const s = setup();
      const sp = (await s.ops.savepoint!.run(ctxFor({}))) as { commits: number; at: number };
      advance(10);
      await write(s.trust, "set_text", { nodeId: s.w.title.id, content: "Agent" }, async () => ((s.w.title.characters = "Agent"), { id: s.w.title.id }), REFUSE);
      if (personToo) s.w.title.characters = "Mine";
      advance(SETTLE_MS + 30_000);
      emit(s.trust, changed(s.w.title, ["characters"]));
      const r = await dispatch(s.trust, "rollback", { commits: sp.commits, sinceMs: sp.at, createdIds: [] }, { write: false, run: (ctx) => s.ops.rollback!.run(ctx) });
      if (personToo) {
        expect(r.ok ? "" : r.error.code).toBe("ROLLBACK_BLOCKED");
        expect(s.w.undos).toEqual([]);
      } else {
        expect(r).toMatchObject({ ok: true, data: { undone: 1 } });
      }
    }
  });

  it("(e) rollback: a variable someone else changed blocks it, though its bound layers read as unchanged; the agent's own does not", async () => {
    for (const who of ["person", "agent"] as const) {
      const s = setup();
      const { accent, set } = accentVariable(s.w);
      s.w.title.fills = boundFill(accent.id, RED);
      await read(s.trust, "get_node", { nodeId: s.w.card.id });
      const sp = (await s.ops.savepoint!.run(ctxFor({}))) as { commits: number; at: number };
      advance(10);
      await write(s.trust, "rename_node", { nodeId: s.w.other.id, name: "Renamed" }, async () => ((s.w.other.name = "Renamed"), { id: s.w.other.id }), REFUSE);
      if (who === "agent") {
        await write(s.trust, "set_variable_value", { variableId: accent.id, value: "#0000ff" }, async () => (set(BLUE, s.w.title), { variableId: accent.id }), REFUSE);
      } else set(BLUE, s.w.title); // in the Variables panel
      advance(SETTLE_MS + 5_000);
      emit(s.trust, changed(s.w.title, ["fills"]));
      // Not a conflict for a write: the title itself was not edited.
      expect((await s.trust.guard("set_text", { nodeId: s.w.title.id }, REFUSE)).conflicts).toEqual([]);
      const r = await dispatch(s.trust, "rollback", { commits: sp.commits, sinceMs: sp.at, createdIds: [] }, { write: false, run: (ctx) => s.ops.rollback!.run(ctx) });
      if (who === "agent") {
        expect(r).toMatchObject({ ok: true, data: { undone: 2 } });
        continue;
      }
      expect(s.w.undos).toEqual([]);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.code).toBe("ROLLBACK_BLOCKED");
      expect(r.error.message).toMatch(/someone other than the agent changed 1 variable\(s\), collection\(s\) or style\(s\) \("color\/accent"\)/);
      expect(r.partial).toMatchObject({ changed: [{ nodeId: accent.id, name: "color/accent", by: "someone else" }] });
    }
  });

  it("(e) a variable changed before the savepoint does not block a rollback to it", async () => {
    const s = setup();
    const { set } = accentVariable(s.w);
    await s.ops.savepoint!.run(ctxFor({})); // the agent knows the variables from here
    advance(10);
    set(BLUE); // the person, before the next savepoint
    advance(10);
    const sp = (await s.ops.savepoint!.run(ctxFor({}))) as { commits: number; at: number };
    advance(10);
    await write(s.trust, "set_fills", { nodeId: s.w.card.id }, undefined, REFUSE);
    advance(SETTLE_MS + 1);
    const r = await dispatch(s.trust, "rollback", { commits: sp.commits, sinceMs: sp.at, createdIds: [] }, { write: false, run: (ctx) => s.ops.rollback!.run(ctx) });
    expect(r).toMatchObject({ ok: true, data: { undone: 1 } });
  });
});

// ── view times ──────────────────────────────────────────────────────────────

describe("what the agent has seen (spec §2.2)", () => {
  it("a read of a frame is a view of everything under it; the latest covering read counts", async () => {
    const { w, trust } = setup();
    await read(trust, "get_node", { nodeId: w.section.id });
    const first = now;
    expect(trust.viewedAt([w.title.id, w.card.id, w.section.id, w.page.id])).toBe(first);
    advance(10_000);
    await read(trust, "get_nodes_info", { nodeIds: [w.title.id] });
    expect(trust.viewedAt([w.title.id, w.card.id, w.section.id])).toBe(now);
    expect(trust.viewedAt([w.body.id, w.card.id, w.section.id])).toBe(first);
    expect(trust.viewedAt([w.other.id, w.page.id])).toBeUndefined();
  });

  it("a read that names no node reads the selection; a read that failed, or a read that returns no content, records nothing", async () => {
    const { w, trust } = setup();
    w.figma.currentPage.selection = [w.card];
    await read(trust, "get_selection", {});
    expect(trust.viewedAt([w.card.id])).toBe(now);
    await dispatch(trust, "get_node", { nodeId: w.other.id }, { write: false, run: async () => Promise.reject(new BridgeError("NODE_NOT_FOUND", "gone")) });
    await read(trust, "search_nodes", { nodeId: w.other.id });
    expect(trust.viewedAt([w.other.id])).toBeUndefined();
  });

  it("a write is a view of its targets and of what it created, at the op's start; a refusal is not", async () => {
    const { w, trust } = setup();
    await write(trust, "set_fills", { nodeIds: [w.card.id] }, async () => ({ items: [{ id: w.card.id, ok: true }] }));
    expect(trust.viewedAt([w.card.id])).toBe(now);
    await write(trust, "create_frame", {}, async () => ({ id: "5:5", parentId: w.section.id }));
    expect(trust.viewedAt(["5:5"])).toBe(now);
    expect(trust.viewedAt([w.section.id])).toBeUndefined(); // a parent named in a result is not seen
    await write(trust, "set_fills", { nodeId: w.other.id }, async () => {
      throw new BridgeError("INVALID_PARAM", "bad colour", { partial: { created: [] } });
    });
    expect(trust.viewedAt([w.other.id])).toBeUndefined();
  });
});

// ── the guard ───────────────────────────────────────────────────────────────

describe("targets (spec §2.3)", () => {
  it("nodeId, nodeIds and the ids inside lists of objects; never parentId", () => {
    expect(targetsOf("set_fills", { nodeId: "1:1", parentId: "9:9" })).toEqual(["1:1"]);
    expect(targetsOf("move_nodes", { nodeIds: ["1:1", "1:2", "1:1"] })).toEqual(["1:1", "1:2"]);
    expect(targetsOf("edit_connectors", { connectors: [{ nodeId: "4:1", to: { endpointNodeId: "4:9" } }, { nodeId: "4:2" }] })).toEqual(["4:1", "4:2"]);
    expect(targetsOf("set_slide_properties", { slides: [{ slideId: "6:1", skipped: true }] })).toEqual(["6:1"]);
    expect(targetsOf("move_slides", { slideIds: ["6:1", "6:2"] })).toEqual(["6:1", "6:2"]);
    expect(targetsOf("create_from_spec", { parentId: "1:0", spec: { type: "frame" } })).toEqual([]);
  });

  it("a batch's steps, sent parsed or as a JSON string, each step's own sources excepted", () => {
    const steps = [
      { op: "set_fills", params: { nodeId: "1:1" } },
      { op: "figma_rename_node", params: { nodeId: "1:2", name: "X" } },
      { op: "set_text", params: { items: [{ nodeId: "1:3" }], parentId: "1:0" } },
    ];
    expect(targetsOf("batch", { steps })).toEqual(["1:1", "1:2", "1:3"]);
    expect(targetsOf("batch", { steps: JSON.stringify(steps) })).toEqual(["1:1", "1:2", "1:3"]);
    expect(targetsOf("batch", { steps: "not json" })).toEqual([]);
  });

  it("a node an op only reads is not a target, but is in the footprint", () => {
    expect(targetsOf("clone_node", { nodeId: "1:1", parentId: "1:0" })).toEqual([]);
    expect(targetsOf("stress_test", { nodeId: "1:1" })).toEqual([]);
    expect(namedIds("clone_node", { nodeId: "1:1", parentId: "1:0" }, { parents: true, sources: true })).toEqual(["1:1", "1:0"]);
  });

  it("a person's edit to the frame a stress test reads never makes it answer STALE", async () => {
    const { w, trust } = setup();
    await read(trust, "get_node", { nodeId: w.card.id });
    advance(1_000);
    emit(trust, edit(w.title));
    expect(await trust.guard("stress_test", { nodeId: w.card.id }, { conflicts: "refuse" })).toEqual({ conflicts: [] });
    expect((await trust.guard("set_fills", { nodeId: w.card.id }, { conflicts: "refuse" })).refusal?.code).toBe("STALE");
  });
});

describe("the stale-write guard (spec §2.3)", () => {
  async function staleCard() {
    const s = setup();
    await read(s.trust, "get_node", { nodeId: s.w.card.id });
    advance(40_000);
    emit(s.trust, edit(s.w.title)); // the person retypes the title
    return { ...s, viewedAt: now - 40_000, changedAt: now };
  }

  it("refuse: STALE before the op runs, nothing changed, the spec's message and hint", async () => {
    const { w, trust, viewedAt, changedAt } = await staleCard();
    let ran = false;
    const r = await write(trust, "set_text", { nodeId: w.title.id, content: "Mine" }, async () => {
      ran = true;
      return {};
    }, { conflicts: "refuse" });
    expect(ran).toBe(false);
    expect(r.commits).toBe(0); // refused like the editor gate: no undo step
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("STALE");
    expect(r.error.message).toBe(
      `figma_set_text was refused before any change: "Card / Title" (1:2) was edited by you after the agent last read it ` +
        `(${clock(viewedAt)}, 40 s ago). Writing now could overwrite that edit.`,
    );
    expect(r.error.hint).toBe(
      'Read it again (figma_get_node { nodeId: "1:2" } or figma_get_design_context), then send the call again; or pass force: true to overwrite on purpose.',
    );
    expect(r.partial).toEqual({ created: [], conflicts: [{ nodeId: "1:2", name: "Title", by: "person", at: changedAt, viewedAt }] });
    expect(changedNothing(r)).toBe(true); // frees the idempotency key
  });

  it("a change under the target counts, and is named; a collaborator's says so", async () => {
    const { w, trust } = await staleCard();
    emit(trust, edit(w.body, "characters", undefined, "REMOTE"));
    const g = await trust.guard("set_fills", { nodeId: w.card.id }, { conflicts: "refuse" });
    expect(g.conflicts).toEqual([expect.objectContaining({ nodeId: "1:1", name: "Card", by: "collaborator" })]);
    expect(g.refusal!.message).toMatch(/^figma_set_fills was refused before any change: "Hero section \/ Card" \(1:1\) was edited by a collaborator \(inside it, "Body" 1:3\) after/);
  });

  it("several targets: one message, the rest counted, every id in the hint", async () => {
    const { w, trust } = await staleCard();
    emit(trust, edit(w.body));
    const g = await trust.guard("move_nodes", { nodeIds: [w.title.id, w.body.id] }, { conflicts: "refuse" });
    expect(g.refusal!.message).toMatch(/, and 1 more target\(s\) changed the same way \(partial\.conflicts\)\. Writing now could overwrite those edits\.$/);
    expect(g.refusal!.hint).toMatch(/^Read them again \(figma_get_nodes_info \{ nodeIds: \["1:2", "1:3"\] \}/);
  });

  it("warn, or force under refuse: the op runs and its result lists the conflicts", async () => {
    for (const guard of [{ conflicts: "warn" }, { conflicts: "refuse", force: true }]) {
      const { w, trust } = await staleCard();
      const r = await write(trust, "set_text", { nodeId: w.title.id }, async () => ({ id: w.title.id }), guard);
      expect(r).toMatchObject({ ok: true, commits: 1, data: { id: "1:2", conflicts: [{ nodeId: "1:2", by: "person" }] } });
    }
  });

  it("off, or no guard at all (an older server): nothing is checked and nothing added", async () => {
    for (const guard of [{ conflicts: "off" }, undefined]) {
      const { w, trust } = await staleCard();
      const r = await write(trust, "set_text", { nodeId: w.title.id }, async () => ({ id: w.title.id }), guard);
      expect(r).toEqual({ ok: true, data: { id: "1:2" }, commits: 1 });
    }
  });

  it("a target never read or written is not checked; a change before the view is no conflict; nor is the agent's own", async () => {
    const { w, trust } = setup();
    emit(trust, local(w.other));
    expect((await trust.guard("set_fills", { nodeId: w.other.id }, { conflicts: "refuse" })).conflicts).toEqual([]);
    advance(1_000);
    await read(trust, "get_node", { nodeId: w.other.id });
    expect((await trust.guard("set_fills", { nodeId: w.other.id }, { conflicts: "refuse" })).conflicts).toEqual([]);
    await write(trust, "set_fills", { nodeId: w.other.id }, async () => {
      advance(10);
      emit(trust, local(w.other));
      return {};
    });
    expect((await trust.guard("set_fills", { nodeId: w.other.id }, { conflicts: "refuse" })).conflicts).toEqual([]);
  });

  it("withConflicts: an object gains the key, anything else is wrapped, none leaves it as it was", () => {
    const c = [{ nodeId: "1:1", name: "Card", by: "person" as const, at: 2, viewedAt: 1 }];
    expect(withConflicts({ id: "1:1" }, c)).toEqual({ id: "1:1", conflicts: c });
    expect(withConflicts(["a"], c)).toEqual({ result: ["a"], conflicts: c });
    expect(withConflicts("done", c)).toEqual({ result: "done", conflicts: c });
    expect(withConflicts({ id: "1:1" }, [])).toEqual({ id: "1:1" });
  });
});

// ── get_changes and savepoint ───────────────────────────────────────────────

describe("get_changes and savepoint", () => {
  it("get_changes: the watched page, the commit count, conflicts, the latest change per node, and page switches", async () => {
    const { w, trust, ops } = setup();
    await read(trust, "get_node", { nodeId: w.card.id });
    const viewed = now;
    advance(1_000);
    emit(trust, edit(w.title));
    advance(1_000);
    emit(trust, edit(w.title), remote(w.other)); // Other was never seen: any change to it is not shown to be the agent's
    trust.pageChanged({ id: "0:2", name: "Page 2" });
    await write(trust, "set_fills", { nodeId: w.other.id });
    const r = (await ops.get_changes!.run(ctxFor({}))) as ReturnType<Trust["changes"]>;
    expect(r).toEqual({
      watchedPageId: "0:1",
      commits: 1,
      conflicts: [{ nodeId: "1:2", name: "Title", by: "person", at: now, viewedAt: viewed }],
      changes: [
        { nodeId: "1:2", name: "Title", by: "person", at: now },
        { nodeId: "2:1", name: "Other", by: "collaborator", at: now },
      ],
      pageSwitches: [{ at: now, pageId: "0:2", by: "person" }],
    });
    advance(1);
    expect(await ops.get_changes!.run(ctxFor({ sinceMs: now }))).toMatchObject({ changes: [], conflicts: [], pageSwitches: [] });
    await expect(ops.get_changes!.run(ctxFor({ sinceMs: "yesterday" }))).rejects.toMatchObject({ code: "INVALID_PARAM" });
  });

  it("savepoint: the commitUndo count, the time and the page; reads and savepoints do not count", async () => {
    const { w, trust, ops } = setup();
    await write(trust, "set_fills", { nodeId: w.card.id });
    await read(trust, "get_node", { nodeId: w.card.id });
    await dispatch(trust, "savepoint", {}, { write: false, run: (ctx) => ops.savepoint!.run(ctx) });
    await write(trust, "rename_node", { nodeId: w.card.id, name: "X" });
    expect(await ops.savepoint!.run(ctxFor({}))).toEqual({ commits: 2, at: now, pageId: "0:1" });
    expect(Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, v.write]))).toEqual({ get_changes: false, savepoint: false, rollback: false });
  });

  it("a savepoint and a stress test run on their own call, never as a batch step", () => {
    expect(notBatchable("savepoint")).toBe('"savepoint" runs on its own call');
    expect(notBatchable("stress_test")).toBe('"stress_test" runs on its own call');
  });

  it("a page switch while a page op runs, or within its settle window, is the agent's; any other is the person's", async () => {
    const { trust } = setup();
    await dispatch(trust, "navigate_page", { pageId: "0:2" }, { write: false, run: async () => (trust.pageChanged({ id: "0:2" }), {}) });
    advance(SETTLE_MS);
    trust.pageChanged({ id: "0:3" }); // a late event for the same switch
    advance(1);
    trust.pageChanged({ id: "0:1" });
    expect(trust.changes().pageSwitches.map((s) => s.by)).toEqual(["agent", "agent", "person"]);
  });
});

// ── rollback ────────────────────────────────────────────────────────────────

describe("rollback (spec §2.5)", () => {
  async function session() {
    const s = setup();
    await write(s.trust, "set_fills", { nodeId: s.w.other.id }); // before the savepoint
    const sp = (await s.ops.savepoint!.run(ctxFor({}))) as { commits: number; at: number };
    advance(10);
    const made = s.w.add("5:1", "New card", "FRAME", s.w.page);
    await write(s.trust, "create_frame", {}, async () => (emit(s.trust, local(made)), { id: made.id }));
    advance(10);
    await write(s.trust, "set_fills", { nodeId: s.w.card.id }, async () => (emit(s.trust, local(s.w.card)), {}));
    const rollback = (createdIds: string[] = [made.id]) =>
      dispatch(s.trust, "rollback", { commits: sp.commits, sinceMs: sp.at, createdIds }, { write: false, run: (ctx) => s.ops.rollback!.run(ctx) });
    return { ...s, sp, made, rollback };
  }

  it("undoes exactly the agent's steps since the savepoint, verifies what it created is gone, and counts back to the savepoint", async () => {
    const { w, trust, made, sp, rollback } = await session();
    w.figma.triggerUndo = () => {
      w.undos.push(w.undos.length + 1);
      if (w.undos.length === 2) w.remove(made); // the second undo takes back the create
    };
    advance(SETTLE_MS + 1);
    const r = await rollback();
    expect(w.undos).toEqual([1, 2]);
    expect(r).toMatchObject({ ok: true, data: { undone: 2, verified: true, stillThere: [] } });
    expect(trust.commits).toBe(sp.commits);
  });

  it("an undo that leaves a created node behind is reported, not hidden", async () => {
    const { w, rollback } = await session();
    advance(SETTLE_MS + 1);
    const r = await rollback(["5:1", "1:1"]);
    expect(w.undos).toHaveLength(2);
    expect(r).toMatchObject({ ok: true, data: { undone: 2, verified: false, stillThere: ["5:1", "1:1"] } });
  });

  it("a write refused before it changed anything is committed but not undone (UNDO.emptyCommitIsAStep)", async () => {
    const { w, trust, rollback } = await session();
    await write(trust, "set_fills", { nodeId: w.card.id }, async () => {
      throw new BridgeError("INVALID_PARAM", "bad colour", { partial: { created: [] } });
    });
    advance(SETTLE_MS + 1);
    expect(trust.commits).toBe(4);
    await rollback();
    expect(w.undos).toHaveLength(2);
  });

  it("with UNDO.emptyCommitIsAStep, the same refusal is one more undo", async () => {
    UNDO.emptyCommitIsAStep = true;
    try {
      const { w, trust, rollback } = await session();
      await write(trust, "set_fills", { nodeId: w.card.id }, async () => {
        throw new BridgeError("INVALID_PARAM", "bad colour", { partial: { created: [] } });
      });
      advance(SETTLE_MS + 1);
      await rollback();
      expect(w.undos).toHaveLength(3);
    } finally {
      UNDO.emptyCommitIsAStep = false;
    }
  });

  it("refused before any undo after a person's change: ROLLBACK_BLOCKED, what changed, and the safe part", async () => {
    const { w, trust, made, sp, rollback } = await session();
    advance(SETTLE_MS + 1);
    emit(trust, edit(w.body));
    const r = await rollback();
    expect(w.undos).toEqual([]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ROLLBACK_BLOCKED");
    expect(r.error.message).toBe(
      `figma_rollback was refused before any undo: since the savepoint (${clock(sp.at)}) you changed 1 layer(s) on this page ("Body"); ` +
        "Figma's undo would take those edits back too.",
    );
    expect(r.error.hint).toMatch(/^Nothing was undone\. To remove only what the agent created since the savepoint, call figma_delete_nodes \{ nodeIds: \["5:1"\] \}/);
    expect(r.partial).toEqual({ created: [], changed: [{ nodeId: "1:3", name: "Body", by: "person", at: now }], safe: [made.id] });
    expect(trust.commits).toBe(3); // nothing moved
  });

  it("refused when a collaborator changed something, or the person switched the page; an agent's page switch is fine", async () => {
    {
      const { w, trust, rollback } = await session();
      advance(SETTLE_MS + 1);
      emit(trust, edit(w.other, "name", undefined, "REMOTE"));
      const r = await rollback();
      expect(r.ok ? "" : r.error.message).toMatch(/a collaborator changed 1 layer\(s\)/);
    }
    {
      const { trust, w, rollback } = await session();
      advance(SETTLE_MS + 1);
      trust.pageChanged({ id: "0:2", name: "Page 2" });
      const r = await rollback([]);
      expect(r.ok ? "" : r.error.message).toMatch(/the page was switched by you \(to "Page 2"\), so an undo could reach a page the plugin cannot watch/);
      expect(r.ok ? "" : r.error.hint).toMatch(/^Nothing was undone, and the agent created no layers since the savepoint\./);
      expect(w.undos).toEqual([]);
    }
    {
      const { trust, w, rollback } = await session();
      await dispatch(trust, "navigate_page", { pageId: "0:2" }, { write: false, run: async () => (trust.pageChanged({ id: "0:2" }), {}) });
      advance(SETTLE_MS + 1);
      expect((await rollback()).ok).toBe(true);
      expect(w.undos).toHaveLength(2);
    }
  });

  it("a person's edit reported only during the settle wait still blocks it", async () => {
    const s = setup();
    const trust = new Trust({
      now: () => now,
      figma: () => s.w.figma,
      delay: async (ms) => {
        advance(ms);
        emit(trust, edit(s.w.body)); // made just before the call, reported late [C-394]
      },
    });
    const ops = trustOps(trust);
    const sp = (await ops.savepoint!.run(ctxFor({}))) as { commits: number; at: number };
    await write(trust, "set_fills", { nodeId: s.w.card.id });
    advance(SETTLE_MS + 1);
    const r = await dispatch(trust, "rollback", { commits: sp.commits, sinceMs: sp.at, createdIds: [] }, { write: false, run: (ctx) => ops.rollback!.run(ctx) });
    expect(r.ok ? "" : r.error.code).toBe("ROLLBACK_BLOCKED");
    expect(s.w.undos).toEqual([]);
  });

  it("the undo's own changes are the agent's: they block nothing afterwards", async () => {
    const { w, trust, rollback } = await session();
    w.figma.triggerUndo = () => {
      w.undos.push(1);
      emit(trust, local(w.card), local(w.other));
    };
    advance(SETTLE_MS + 1);
    await rollback();
    advance(SETTLE_MS - 1);
    emit(trust, local(w.title)); // late events of the undo
    expect(trust.changes().changes).toEqual([]);
  });

  it("refused after figma_undo_step, after a plugin restart, or past what the plugin keeps", async () => {
    {
      const { trust, rollback } = await session();
      await dispatch(trust, "undo_step", { confirm: true }, { write: false });
      advance(SETTLE_MS + 1);
      const r = await rollback();
      expect(r.ok ? "" : r.error.message).toMatch(/figma_undo_step ran since, so the plugin can no longer count what is left to undo/);
    }
    {
      const s = setup();
      const r = await dispatch(s.trust, "rollback", { commits: 0, sinceMs: now - 60_000, createdIds: [] }, { write: false, run: (ctx) => s.ops.rollback!.run(ctx) });
      expect(r.ok ? "" : r.error.message).toMatch(/the plugin was closed and run again since/);
      const ahead = await dispatch(s.trust, "rollback", { commits: 7, sinceMs: now, createdIds: [] }, { write: false, run: (ctx) => s.ops.rollback!.run(ctx) });
      expect(ahead.ok ? "" : ahead.error.message).toMatch(/a rollback since already took back the steps after it/);
    }
    {
      // Two savepoints; a rollback to the first, then one to the second, which no longer exists.
      const { trust, ops, rollback } = await session();
      const later = (await ops.savepoint!.run(ctxFor({}))) as { commits: number; at: number };
      advance(SETTLE_MS + 1);
      expect((await rollback()).ok).toBe(true);
      const r = await dispatch(trust, "rollback", { commits: later.commits, sinceMs: later.at, createdIds: [] }, { write: false, run: (ctx) => ops.rollback!.run(ctx) });
      expect(r.ok ? "" : r.error.message).toMatch(/a rollback since already took back the steps after it/);
    }
  });

  it("malformed params are refused before anything, as changing nothing", async () => {
    const { ops } = setup();
    for (const params of [{ commits: -1, sinceMs: 1 }, { commits: 1.5, sinceMs: 1 }, { commits: 0 }, { commits: 0, sinceMs: 1, createdIds: [3] }]) {
      await expect(ops.rollback!.run(ctxFor(params))).rejects.toMatchObject({ code: "INVALID_PARAM", partial: { created: [] } });
    }
  });
});

describe("rollback with several agents on one plugin (a hub and its proxies)", () => {
  const A: Guard = { conflicts: "refuse", agent: "agent-a" };
  const B: Guard = { conflicts: "refuse", agent: "agent-b" };
  const OLDER = undefined; // a server that sends no guard: agent unknown

  /** A savepoint, then one set_fills per guard given, then a rollback under `by`. */
  async function shared(calls: Guard[], by: Guard) {
    const s = setup();
    const sp = (await s.ops.savepoint!.run(ctxFor({}))) as { commits: number; at: number };
    for (const g of calls) {
      advance(10);
      await write(s.trust, "set_fills", { nodeId: s.w.card.id }, async () => ({ items: [{ id: s.w.card.id, ok: true }] }), g);
    }
    advance(SETTLE_MS + 1);
    const r = await dispatch(s.trust, "rollback", { commits: sp.commits, sinceMs: sp.at, createdIds: ["5:1"] }, {
      write: false,
      ...(by ? { guard: by } : {}),
      run: (ctx) => s.ops.rollback!.run(ctx),
    });
    return { ...s, r };
  }

  it("only its own agent's calls since the savepoint: it undoes them", async () => {
    const { r, w } = await shared([A, A], A);
    expect(r).toMatchObject({ ok: true, data: { undone: 2 } });
    expect(w.undos).toHaveLength(2);
  });

  it("another agent's call since: ROLLBACK_BLOCKED, listed by tool and layer, the safe part kept", async () => {
    const { r, w } = await shared([A, B, A], A);
    expect(w.undos).toEqual([]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ROLLBACK_BLOCKED");
    expect(r.error.message).toMatch(/another agent sharing this plugin made 1 tool call\(s\) \(figma_set_fills\); an undo cannot skip them\.$/);
    expect(r.partial).toMatchObject({
      created: [],
      changed: [{ nodeId: "1:1", name: "Card", by: "another agent", op: "figma_set_fills" }],
      safe: ["5:1"],
    });
  });

  it("calls with no agent recorded, under a rollback that has one, are not its own", async () => {
    const { r } = await shared([OLDER, A], A);
    expect(r.ok ? "" : r.error.code).toBe("ROLLBACK_BLOCKED");
  });

  it("a rollback with no agent (an older server) refuses only when the calls since carry two agents", async () => {
    expect((await shared([A, B], OLDER)).r.ok).toBe(false);
    expect((await shared([A, A], OLDER)).r.ok).toBe(true);
    expect((await shared([OLDER, A], OLDER)).r.ok).toBe(true);
  });

  it("agentOf reads the guard's agent, and nothing else", () => {
    expect(agentOf({ conflicts: "refuse", agent: "agent-a" })).toBe("agent-a");
    expect(agentOf({ conflicts: "refuse" })).toBeUndefined();
    expect(agentOf({ conflicts: "refuse", agent: "" })).toBeUndefined();
    expect(agentOf(undefined)).toBeUndefined();
  });
});

// ── the dispatcher, in the built bundle ─────────────────────────────────────

const CODE = readFileSync(new URL("../dist/plugin/code.js", import.meta.url), "utf8");

type Posted = { kind: string; id?: number; ms?: number; msg?: { t: string; id: string; ok?: boolean; data?: Record<string, unknown>; error?: { code: string; message: string }; partial?: unknown } };

/** The built sandbox, with a fake `figma` whose clock, nodechange and undo the test drives. */
function sandbox() {
  let clockMs = 2_000_000_000;
  class TestDate extends Date {
    static override now() {
      return clockMs;
    }
  }
  const posted: Posted[] = [];
  let onmessage: ((m: unknown) => void) | null = null;
  let onNodeChange: ((e: unknown) => void) | null = null;
  const nodes = new Map<string, Record<string, unknown>>();
  const page: Record<string, unknown> = {
    id: "0:1", name: "Page 1", type: "PAGE", selection: [], children: [], parent: null,
    on: (ev: string, fn: (e: unknown) => void) => {
      if (ev === "nodechange") onNodeChange = fn;
    },
    off: () => {},
  };
  const card: Record<string, unknown> = { id: "1:1", name: "Card", type: "FRAME", parent: page, children: [], visible: true };
  const title: Record<string, unknown> = { id: "1:2", name: "Title", type: "TEXT", parent: card, children: [], visible: true, characters: "Hello" };
  (card.children as unknown[]).push(title);
  (page.children as unknown[]).push(card);
  for (const n of [page, card, title]) nodes.set(n.id as string, n);
  const counts = { commits: 0, undos: 0 };
  const figma = {
    apiVersion: "1.0.0",
    editorType: "figma",
    root: { name: "Trust", children: [page] },
    currentPage: page,
    currentUser: null,
    showUI: () => {},
    commitUndo: () => void counts.commits++,
    triggerUndo: () => void counts.undos++,
    on: () => {},
    clientStorage: { getAsync: async () => undefined, setAsync: async () => {} },
    getNodeByIdAsync: async (id: string) => nodes.get(id) ?? null,
    ui: {
      postMessage: (m: Posted) => {
        posted.push(m);
        // The UI's scheduler: a delay passes on the fake clock.
        if (m.kind === "tick-request") setImmediate(() => ((clockMs += m.ms ?? 0), onmessage?.({ kind: "tick", id: m.id })));
      },
      set onmessage(fn: (m: unknown) => void) {
        onmessage = fn;
      },
    },
  };
  runInContext(CODE, createContext({ figma, __html__: "<html></html>", Date: TestDate }));
  let seq = 0;
  return {
    title,
    counts,
    advance: (ms: number) => void (clockMs += ms),
    get now() {
      return clockMs;
    },
    /** The person retypes a text: its characters change, and the change says so. */
    personEdits: (n: Record<string, unknown>) => {
      n.characters = `${String(n.characters ?? "")}!`;
      onNodeChange!({ nodeChanges: [{ id: n.id, origin: "LOCAL", type: "PROPERTY_CHANGE", properties: ["characters"], node: n }] });
    },
    /** A change Figma reports for `n` without anything in it having changed: the agent's own write, reported late. */
    echo: (n: Record<string, unknown>, properties: string[], origin = "LOCAL") =>
      onNodeChange!({ nodeChanges: [{ id: n.id, origin, type: "PROPERTY_CHANGE", properties, node: n }] }),
    async request(op: string, params: Record<string, unknown>, guard?: { conflicts: string; force?: boolean; agent?: string }) {
      const id = `r${++seq}`;
      onmessage!({ kind: "wire", msg: { t: "request", id, op, params, idleTimeoutMs: 30_000, ...(guard ? { guard } : {}) } });
      for (let i = 0; i < 500; i++) {
        const hit = posted.find((p) => p.kind === "wire" && p.msg?.t === "result" && p.msg.id === id);
        if (hit) return hit.msg!;
        await sleep(2);
      }
      throw new Error(`no result for ${op}`);
    },
  };
}

describe("the dispatcher (built sandbox)", () => {
  it("with no guard every write runs as before; with one, refuse stops it before commitUndo and warn lists the conflict", async () => {
    const s = sandbox();
    expect((await s.request("get_node", { nodeId: "1:2" })).ok).toBe(true);
    s.advance(40_000);
    s.personEdits(s.title);

    const plain = await s.request("rename_node", { nodeId: "1:2", name: "Old guard" });
    expect(plain).toMatchObject({ ok: true, data: { id: "1:2", name: "Old guard" } });
    expect(plain.data).not.toHaveProperty("conflicts");
    expect(s.counts.commits).toBe(1);

    s.advance(SETTLE_MS + 1_000);
    s.personEdits(s.title);
    const refused = await s.request("rename_node", { nodeId: "1:2", name: "Mine" }, { conflicts: "refuse" });
    expect(refused).toMatchObject({ ok: false, error: { code: "STALE" }, partial: { created: [], conflicts: [{ nodeId: "1:2", by: "person" }] } });
    expect(refused.error!.message).toMatch(/^figma_rename_node was refused before any change: "Card \/ Old guard" \(1:2\) was edited by you after the agent last read it/);
    expect(s.title.name).toBe("Old guard");
    expect(s.counts.commits).toBe(1);

    const warned = await s.request("rename_node", { nodeId: "1:2", name: "Mine" }, { conflicts: "warn" });
    expect(warned).toMatchObject({ ok: true, data: { name: "Mine", conflicts: [{ nodeId: "1:2", by: "person" }] } });
    expect(s.counts.commits).toBe(2);

    // The write was a view: the same edit is no longer a conflict.
    expect((await s.request("rename_node", { nodeId: "1:2", name: "Again" }, { conflicts: "refuse" })).ok).toBe(true);
  });

  it("savepoint counts the commits; rollback undoes the ones since, through the UI's delay, and get_changes reads the same tracker", async () => {
    const s = sandbox();
    await s.request("rename_node", { nodeId: "1:2", name: "A" });
    const sp = (await s.request("savepoint", {})).data as { commits: number; at: number; pageId: string };
    expect(sp).toEqual({ commits: 1, at: s.now, pageId: "0:1" });
    s.advance(10);
    await s.request("rename_node", { nodeId: "1:2", name: "B" });
    s.personEdits(s.title); // the rename's own event, inside its settle window
    await s.request("rename_node", { nodeId: "1:2", name: "C" });
    expect(s.counts.commits).toBe(3);
    expect((await s.request("get_changes", {})).data).toMatchObject({ watchedPageId: "0:1", commits: 3, changes: [] });

    const r = await s.request("rollback", { commits: sp.commits, sinceMs: sp.at, createdIds: [] });
    expect(r).toMatchObject({ ok: true, data: { undone: 2, verified: true, stillThere: [] } });
    expect(s.counts.undos).toBe(2);
    expect(s.counts.commits).toBe(3); // rollback commits no undo step of its own
    expect((await s.request("savepoint", {})).data).toMatchObject({ commits: 1 });
  });

  it("the agent's own change reported long after its settle window is not a person's: no STALE, get_changes lists nothing", async () => {
    const s = sandbox();
    expect((await s.request("get_node", { nodeId: "1:2" })).ok).toBe(true);
    expect((await s.request("rename_node", { nodeId: "1:2", name: "Agent" }, { conflicts: "refuse" })).ok).toBe(true);
    s.advance(SETTLE_MS + 60_000);
    s.echo(s.title, ["name"]);
    s.echo(s.title, ["name"], "REMOTE");
    expect((await s.request("get_changes", {})).data).toMatchObject({ changes: [], conflicts: [] });
    expect((await s.request("rename_node", { nodeId: "1:2", name: "Agent 2" }, { conflicts: "refuse" })).ok).toBe(true);
    s.advance(SETTLE_MS + 1);
    s.personEdits(s.title);
    expect(await s.request("rename_node", { nodeId: "1:2", name: "Agent 3" }, { conflicts: "refuse" })).toMatchObject({ ok: false, error: { code: "STALE" } });
    expect(s.title.name).toBe("Agent 2");
  });

  it("the guard's agent reaches the commit count: one agent cannot roll back another's calls", async () => {
    const s = sandbox();
    const mine = { conflicts: "refuse", agent: "agent-a" };
    const sp = (await s.request("savepoint", {}, mine)).data as { commits: number; at: number };
    s.advance(10);
    await s.request("rename_node", { nodeId: "1:2", name: "Theirs" }, { conflicts: "refuse", agent: "agent-b" });
    const r = await s.request("rollback", { commits: sp.commits, sinceMs: sp.at, createdIds: [] }, mine);
    expect(r).toMatchObject({ ok: false, error: { code: "ROLLBACK_BLOCKED" }, partial: { changed: [{ nodeId: "1:2", by: "another agent", op: "figma_rename_node" }] } });
    expect(s.counts.undos).toBe(0);
  });
});
