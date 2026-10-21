// The change journal (src/server/journal.ts, trust spec §2.4): numbering per
// file and the limit, savepoints and what a rollback takes back, the file a
// call goes to, and what a call made, named and did — the ids a rollback checks
// and the safe fallback deletes must be nodes the call made, never ones it found.

import { describe, expect, it } from "vitest";
import type { Bridge } from "../src/server/bridge.js";
import {
  callFile,
  createdIdsOf,
  entryView,
  Journal,
  journalKeyOf,
  journalOf,
  MAKES_NODES,
  SAVEPOINT_LIMIT,
  summarize,
  targetIdsOf,
  type CallFile,
} from "../src/server/journal.js";
import { OPS } from "../src/shared/ops.js";

const COOP: CallFile = { key: "Co-op (figma)", name: "Co-op", sessionId: "s-1", instanceId: "run-1" };
const BOARD: CallFile = { key: "Retro (figjam)", name: "Retro", sessionId: "s-2", instanceId: "run-2" };

const call = (tool: string, more: Partial<Parameters<Journal["record"]>[1]> = {}) => ({ tool, summary: tool, ok: true, ...more });

describe("the journal: entries per file", () => {
  it("numbers each file's calls from 1, and keeps what each call says", () => {
    const j = new Journal();
    const a = j.record(COOP, call("figma_create_frame", { created: ["5:1"], targets: [] }), 1000);
    const b = j.record(BOARD, call("figma_create_stickies"), 1001);
    const c = j.record(COOP, call("figma_set_fills", { targets: ["5:1"] }), 1002);
    expect([a.seq, b.seq, c.seq]).toEqual([1, 1, 2]);
    expect(a).toEqual({ seq: 1, at: 1000, tool: "figma_create_frame", sessionId: "s-1", summary: "figma_create_frame", ok: true, created: ["5:1"], targets: [], rolledBack: false });
    expect(j.since(COOP.key).map((e) => e.tool)).toEqual(["figma_create_frame", "figma_set_fills"]);
    expect(j.since(COOP.key, 1).map((e) => e.seq)).toEqual([2]);
    expect(j.entry(COOP.key, 2)?.targets).toEqual(["5:1"]);
    expect(j.lastSeq(COOP.key)).toBe(2);
    expect(j.lastSeq("unknown")).toBe(0);
  });

  it("records a failure with its code, and whether it provably changed nothing", () => {
    const j = new Journal();
    const e = j.record(COOP, call("figma_set_text", { ok: false, error: "STALE", unchanged: true, targets: ["12:34"] }));
    expect(e).toMatchObject({ ok: false, error: "STALE", unchanged: true });
    expect(entryView(e)).toMatchObject({ ok: false, error: "STALE", unchanged: true, targets: ["12:34"] });
  });

  it("keeps the last `limit` entries per file; seqs are never reused", () => {
    const j = new Journal(3);
    for (let i = 0; i < 5; i++) j.record(COOP, call(`figma_t${i}`));
    expect(j.since(COOP.key).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(j.firstSeq(COOP.key)).toBe(3);
    expect(j.lastSeq(COOP.key)).toBe(5);
    expect(j.record(COOP, call("figma_t5")).seq).toBe(6);
    expect(new Journal().firstSeq("empty")).toBe(1);
  });

  it("is one per bridge: a fresh bridge, a fresh journal", () => {
    const a = {};
    const b = {};
    expect(journalOf(a)).toBe(journalOf(a));
    expect(journalOf(a)).not.toBe(journalOf(b));
    expect(journalOf(a).limit).toBe(1000);
  });

  it("shows an entry with an ISO time and without its empty fields", () => {
    const j = new Journal();
    const e = j.record(COOP, call("figma_rename_node"), Date.UTC(2026, 9, 19, 9, 30));
    expect(entryView(e)).toEqual({ seq: 1, at: "2026-10-19T09:30:00.000Z", tool: "figma_rename_node", summary: "figma_rename_node", ok: true });
  });
});

describe("savepoints and what a rollback takes back", () => {
  it("a savepoint is an entry of its own, and the calls after it are the ones a rollback takes back", () => {
    const j = new Journal();
    j.record(COOP, call("figma_create_frame", { created: ["5:1"] }));
    const sp = j.savepoint(COOP, { label: "Hero copy", commits: 1, at: 5000, pageId: "0:1" });
    expect(sp).toEqual({ id: "sp-1", label: "Hero copy", file: COOP.key, fileName: "Co-op", commits: 1, at: 5000, pageId: "0:1", journalSeq: 2, sessionId: "s-1", instanceId: "run-1" });
    expect(j.entry(COOP.key, 2)).toMatchObject({ tool: "figma_savepoint", savepointId: "sp-1", summary: 'figma_savepoint sp-1 "Hero copy"' });
    j.record(COOP, call("figma_create_from_spec", { created: ["6:1", "6:2"] }));
    j.record(COOP, call("figma_clone_node", { created: ["6:1", "7:1"] }));
    j.record(COOP, call("figma_set_text", { ok: false, error: "STALE", unchanged: true }));
    expect(j.undoable(sp).map((e) => e.tool)).toEqual(["figma_create_from_spec", "figma_clone_node", "figma_set_text"]);
    // Once each, in the order made; nothing from before the savepoint.
    expect(j.createdSince(sp)).toEqual(["6:1", "6:2", "7:1"]);
    expect(j.findSavepoint("sp-1")).toBe(sp);
    expect(j.savepoints(COOP.key)).toEqual([sp]);
    expect(j.savepoints(BOARD.key)).toEqual([]);
  });

  it("a retry under the same idempotencyKey returns the savepoint it made", () => {
    const j = new Journal();
    const a = j.savepoint(COOP, { label: "A", commits: 0, at: 1, pageId: null, idempotencyKey: "sp-key" });
    const b = j.savepoint(COOP, { label: "A", commits: 0, at: 1, pageId: null, idempotencyKey: "sp-key" });
    expect(b).toBe(a);
    expect(j.savepoints(COOP.key)).toHaveLength(1);
    expect(j.lastSeq(COOP.key)).toBe(1);
  });

  it("a rollback marks its calls (not the refused ones), forgets the later savepoints and keeps its own", () => {
    const j = new Journal();
    const sp1 = j.savepoint(COOP, { label: "one", commits: 0, at: 1, pageId: null });
    j.record(COOP, call("figma_create_frame", { created: ["5:1"] }));
    j.record(COOP, call("figma_set_text", { ok: false, error: "STALE", unchanged: true }));
    const sp2 = j.savepoint(COOP, { label: "two", commits: 1, at: 2, pageId: null });
    j.record(COOP, call("figma_set_fills"));
    const marked = j.rolledBackTo(sp1);
    expect(marked.map((e) => e.tool)).toEqual(["figma_create_frame", "figma_set_fills"]);
    expect(j.since(COOP.key).map((e) => [e.tool, e.rolledBack])).toEqual([
      ["figma_savepoint", false], ["figma_create_frame", true], ["figma_set_text", false], ["figma_savepoint", false], ["figma_set_fills", true],
    ]);
    expect(j.findSavepoint(sp2.id)).toBeUndefined();
    expect(j.savepoints(COOP.key)).toEqual([sp1]);
    // Rolled back already: nothing left to take back, until new calls come.
    expect(j.createdSince(sp1)).toEqual([]);
    j.record(COOP, call("figma_rollback"));
    j.record(COOP, call("figma_create_text", { created: ["8:1"] }));
    expect(j.undoable(sp1).map((e) => e.tool)).toEqual(["figma_set_text", "figma_create_text"]);
    expect(j.createdSince(sp1)).toEqual(["8:1"]);
  });

  it(`keeps the last ${SAVEPOINT_LIMIT} savepoints per file`, () => {
    const j = new Journal();
    for (let i = 0; i < SAVEPOINT_LIMIT + 2; i++) j.savepoint(COOP, { label: `s${i}`, commits: i, at: i, pageId: null, idempotencyKey: `k${i}` });
    expect(j.savepoints(COOP.key)).toHaveLength(SAVEPOINT_LIMIT);
    expect(j.findSavepoint("sp-1")).toBeUndefined();
    expect(j.findSavepoint("sp-3")?.label).toBe("s2");
    // A forgotten one's key makes a new savepoint, not the old one back.
    expect(j.savepoint(COOP, { label: "again", commits: 0, at: 0, pageId: null, idempotencyKey: "k0" }).id).toBe(`sp-${SAVEPOINT_LIMIT + 3}`);
  });
});

describe("the file a call goes to", () => {
  const rows = [
    { sessionId: "s-1", active: false, instanceId: "run-1", editorType: "figma", file: { name: "Co-op", key: null } },
    { sessionId: "s-2", active: true, instanceId: "run-2", editorType: "figjam", file: { name: "Retro", key: "FILEKEY" } },
  ];
  const bridge = (sessions: unknown[]) => ({ statusAsync: async () => ({ sessions }) }) as unknown as Bridge;

  it("is the session named by id or file name, else the active one, else the only one", async () => {
    expect(await callFile(bridge(rows), undefined)).toEqual({ key: "FILEKEY", name: "Retro", sessionId: "s-2", instanceId: "run-2" });
    expect(await callFile(bridge(rows), "s-1")).toEqual({ key: "Co-op (figma)", name: "Co-op", sessionId: "s-1", instanceId: "run-1" });
    expect((await callFile(bridge(rows), "co-op"))?.sessionId).toBe("s-1");
    expect((await callFile(bridge([{ ...rows[0], active: false }]), undefined))?.sessionId).toBe("s-1");
    expect(await callFile(bridge(rows), "Elsewhere")).toBeNull();
    expect(await callFile(bridge([]), undefined)).toBeNull();
  });

  it("never throws: a bridge that cannot say is no file", async () => {
    expect(await callFile({ statusAsync: async () => Promise.reject(new Error("gone")) } as unknown as Bridge, undefined)).toBeNull();
    expect(await callFile({} as unknown as Bridge, undefined)).toBeNull();
  });

  it("keys a file as the role process does: its key, else its name and editor", () => {
    expect(journalKeyOf({ file: { name: "Co-op", key: "K" }, editorType: "figma" })).toBe("K");
    expect(journalKeyOf({ file: { name: "Co-op", key: null }, editorType: "figma" })).toBe("Co-op (figma)");
    expect(journalKeyOf({ file: null })).toBe("untitled (unknown editor)");
  });
});

describe("what a call made: only nodes it made, never ones it found", () => {
  it("reads every create result shape", () => {
    expect(createdIdsOf("create_frame", { id: "5:1", name: "Hero" })).toEqual(["5:1"]);
    expect(createdIdsOf("create_from_spec", { rootId: "6:1", created: [{ id: "6:1", name: "Card", path: "spec" }, { id: "6:2", name: "Title", path: "spec.children[0]" }], nodeCount: 2 })).toEqual(["6:1", "6:2"]);
    expect(createdIdsOf("create_from_spec", { rootId: "6:1", rootIds: ["6:1", "6:9"], created: [] })).toEqual(["6:1", "6:9"]);
    expect(createdIdsOf("create_stickies", { created: [{ index: 0, id: "7:1", x: 0, y: 0 }, { index: 1, id: "7:2" }], bounds: {} })).toEqual(["7:1", "7:2"]);
    expect(createdIdsOf("create_slides", { slides: [{ id: "8:1", row: 0 }, { id: "8:2", row: 0 }], rowCount: 1 })).toEqual(["8:1", "8:2"]);
    expect(createdIdsOf("create_slot", { slotId: "9:4", componentId: "9:1" })).toEqual(["9:4"]);
    expect(createdIdsOf("create_storyboard", { storyboardId: "10:1", panels: [{ id: "10:2" }], created: ["10:1", "10:7"] })).toEqual(["10:1", "10:7"]);
    // An animatic names the storyboard it was made from: that one is not new.
    expect(createdIdsOf("create_animatic", { animaticId: "11:1", storyboardId: "10:1" })).toEqual(["11:1"]);
    // A clone is new; its source is not.
    expect(createdIdsOf("clone_node", { id: "12:9", sourceId: "12:1" })).toEqual(["12:9"]);
    // An image placed is new; an image filled into the node it names is not.
    expect(createdIdsOf("import_image", { id: "14:1", type: "RECTANGLE", imageHash: "h" })).toEqual(["14:1"]);
    expect(createdIdsOf("import_image", { id: "14:2", imageHash: "h", applied: "fill" })).toEqual([]);
    expect(createdIdsOf("stress_test", { baseline: { ok: true }, cases: [], kept: ["13:1", "13:2"] })).toEqual(["13:1", "13:2"]);
  });

  it("reads a failure's partial: a build that stopped half-way says what exists", () => {
    expect(createdIdsOf("create_from_spec", { created: [{ id: "6:1", name: "Card", path: "spec" }], failedAt: "spec.children[1]" })).toEqual(["6:1"]);
    expect(createdIdsOf("create_frame", { created: [] })).toEqual([]);
  });

  it("names nothing for ops that wrap or replace existing nodes, or make no nodes", () => {
    for (const op of ["convert_to_component", "combine_as_variants", "group_nodes", "boolean_nodes", "flatten_nodes", "detach_instance", "set_fills", "batch", "create_variable", "create_paint_style", "import_library_assets", "set_brief"]) {
      expect(MAKES_NODES.has(op), op).toBe(false);
    }
    expect(createdIdsOf("group_nodes", { id: "5:9" })).toEqual([]);
    expect(createdIdsOf("set_fills", { updated: 1, items: [{ id: "5:1", ok: true }] })).toEqual([]);
  });

  it("keeps node ids only: no style, variable or instance-sublayer id", () => {
    expect(createdIdsOf("create_from_spec", { created: [{ id: "S:abc," }, { id: "VariableID:1:2" }, { id: "I1:2;3:4" }, { id: "6:3" }, "junk", 7] })).toEqual(["6:3"]);
    expect(createdIdsOf("create_frame", null)).toEqual([]);
    expect(createdIdsOf("create_frame", ["5:1"])).toEqual([]);
  });

  it("every op it names is a catalog op", () => {
    expect([...MAKES_NODES].filter((op) => !OPS.has(op))).toEqual([]);
  });
});

describe("what a call named", () => {
  it("the ids it acts on, at any depth but a spec's, reactions' and flows'", () => {
    expect(targetIdsOf({ nodeId: "1:2", parentId: "1:1", pageId: "0:1" })).toEqual(["1:2"]);
    expect(targetIdsOf({ nodeIds: ["1:2", "1:3"], fills: [{ color: "#fff" }] })).toEqual(["1:2", "1:3"]);
    expect(targetIdsOf({ steps: [{ op: "set_fills", params: { nodeIds: ["1:2"] } }, { op: "rename_node", params: { nodeId: "1:4", name: "x" } }] })).toEqual(["1:2", "1:4"]);
    expect(targetIdsOf({ items: [{ nodeId: "2:1", name: "a" }, { nodeId: "2:2" }] })).toEqual(["2:1", "2:2"]);
    expect(targetIdsOf({ spec: { type: "instance", nodeId: "9:9" }, parentId: "1:1" })).toEqual([]);
    expect(targetIdsOf({ nodeId: "3:1", reactions: [{ action: { nodeId: "3:9" } }] })).toEqual(["3:1"]);
    expect(targetIdsOf({ flows: [{ nodeId: "4:1", name: "Start" }] })).toEqual([]);
    expect(targetIdsOf({ targetId: "S:abc", slideIds: ["5:1"] })).toEqual(["S:abc", "5:1"]);
  });
});

describe("the one-line summary", () => {
  it("is the tool and its params in short form, without how it was sent", () => {
    expect(summarize("set_fills", { nodeIds: ["12:34"], fills: [{ color: "#fff" }], session: "Co-op", idempotencyKey: "k", force: true })).toBe('figma_set_fills nodeIds=[12:34] fills=[1]');
    expect(summarize("set_text", { nodeId: "12:34", content: "Book a bench slot online, with a mechanic beside you" })).toBe('figma_set_text nodeId="12:34" content="Book a bench slot online, with a…"');
    expect(summarize("create_from_spec", { spec: { type: "frame", name: "Pricing section" }, parentId: "1:1" })).toBe('figma_create_from_spec spec={frame "Pricing section"} parentId="1:1"');
    expect(summarize("move_nodes", { nodeIds: ["1:1", "1:2", "1:3", "1:4"], x: 10, y: null })).toBe("figma_move_nodes nodeIds=[4] x=10 y=null");
  });

  it("never carries image data: a long non-text string is only measured", () => {
    const base64 = "iVBORw0KGgo".repeat(40);
    const line = summarize("import_image", { base64, name: "Hero photo" });
    expect(line).toBe(`figma_import_image base64=<${base64.length} chars> name="Hero photo"`);
    expect(summarize("import_svg", { svg: `<svg>${"<path/>".repeat(20)}</svg>` })).toMatch(/^figma_import_svg svg=<\d+ chars>$/);
  });

  it("names a batch's steps, and stops at 200 characters", () => {
    expect(summarize("batch", { steps: [{ op: "set_fills" }, { op: "rename_node" }] })).toBe("figma_batch steps=2: set_fills, rename_node");
    expect(summarize("batch", { steps: Array.from({ length: 7 }, () => ({ op: "set_opacity" })) })).toBe("figma_batch steps=7: set_opacity, set_opacity, set_opacity, set_opacity, set_opacity, +2");
    const long = summarize("rename_node", Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "a value"])));
    expect(long.length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
  });
});
