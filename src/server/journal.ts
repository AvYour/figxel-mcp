// The change journal (trust spec §2.4): every write call this server process
// sends to Figma, per file, the last 1,000. It is what an agent reports to the
// person at the end of an instruction ("what I changed"), what a person reads
// to review the agent's work (figma_get_changes), and where figma_rollback
// learns which nodes the agent made since a savepoint (spec §2.5).
//
// It is fed from the forwarding path (tools/forward.ts), so no write tool can
// skip it: per call the tool, a one-line summary of its params (never image
// data or long text), the nodes it made (from the result shapes the create
// tools return) and the nodes it named to change (from its params), whether it
// succeeded, and later whether a rollback took it back. figma_savepoint and
// figma_rollback write their own entries (tools/trust.ts).
//
// The state is this process's, as the motion and role gates' is: a proxy keeps
// its own journal of its own client's calls, and a restart forgets it. The
// plugin's own change log (what people did) is the other half figma_get_changes
// merges in.

import type { Bridge } from "./bridge.js";
import { toolName } from "../shared/ops.js";

/** Entries kept per file; older ones are dropped first (spec §2.4). */
export const JOURNAL_LIMIT = 1000;
/** Savepoints kept per file; a rollback to an older one is refused as unknown. */
export const SAVEPOINT_LIMIT = 100;

export interface JournalEntry {
  /** Per file, from 1, never reused. */
  seq: number;
  /** When the call answered (epoch ms). */
  at: number;
  tool: string;
  /** The session it went to: the id changes when the plugin reconnects, the file does not. */
  sessionId: string | null;
  summary: string;
  ok: boolean;
  /** A failed call's error code. */
  error?: string;
  /** A failed call that provably changed nothing (refused before it ran, or `created: []`). */
  unchanged?: boolean;
  /** Nodes the call made (createdIdsOf): what a rollback checks are gone, and the safe fallback deletes. */
  created: string[];
  /** Existing nodes the call named to act on (targetIdsOf). */
  targets: string[];
  /** Taken back by figma_rollback. */
  rolledBack: boolean;
  /** The savepoint this entry marks: figma_savepoint's own entry. */
  savepointId?: string;
}

export interface Savepoint {
  id: string;
  label: string;
  /** The journal's key of the file it was made in. */
  file: string;
  fileName: string | null;
  /** The plugin's commitUndo count at the savepoint. */
  commits: number;
  /** The plugin's clock at the savepoint (epoch ms): the changes since it are judged from here. */
  at: number;
  pageId: string | null;
  /** The seq of the savepoint's own entry: the calls after it are the ones a rollback takes back. */
  journalSeq: number;
  sessionId: string | null;
  /** The plugin run it was made in: a run's commit count starts at 0 again. */
  instanceId: string | null;
}

/** The file a call goes to, as the journal keys it. */
export interface CallFile {
  key: string;
  name: string | null;
  sessionId: string;
  instanceId: string | null;
}

/** What a call adds to the journal; the journal numbers and times it. */
export interface CallRecord {
  tool: string;
  summary: string;
  ok: boolean;
  error?: string | undefined;
  unchanged?: boolean | undefined;
  created?: readonly string[] | undefined;
  targets?: readonly string[] | undefined;
  savepointId?: string | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The entries a rollback leaves alone: a savepoint changed nothing, and a rollback cannot be taken back by another. */
const MARKS = new Set([toolName("savepoint"), toolName("rollback")]);

interface FileJournal {
  entries: JournalEntry[];
  next: number;
  savepoints: Savepoint[];
}

export class Journal {
  private readonly files = new Map<string, FileJournal>();
  private readonly byId = new Map<string, Savepoint>();
  /** A savepoint call retried with its idempotencyKey answers the savepoint it made, not a second one. */
  private readonly byKey = new Map<string, string>();
  private nextSavepoint = 1;

  constructor(readonly limit = JOURNAL_LIMIT) {}

  private journal(key: string): FileJournal {
    let f = this.files.get(key);
    if (!f) this.files.set(key, (f = { entries: [], next: 1, savepoints: [] }));
    return f;
  }

  record(file: CallFile, call: CallRecord, at = Date.now()): JournalEntry {
    const f = this.journal(file.key);
    const entry: JournalEntry = {
      seq: f.next++,
      at,
      tool: call.tool,
      sessionId: file.sessionId,
      summary: call.summary,
      ok: call.ok,
      ...(call.error !== undefined ? { error: call.error } : {}),
      ...(call.unchanged ? { unchanged: true } : {}),
      created: [...(call.created ?? [])],
      targets: [...(call.targets ?? [])],
      rolledBack: false,
      ...(call.savepointId !== undefined ? { savepointId: call.savepointId } : {}),
    };
    f.entries.push(entry);
    if (f.entries.length > this.limit) f.entries.splice(0, f.entries.length - this.limit);
    return entry;
  }

  /** The kept entries after `afterSeq`, oldest first. */
  since(file: string, afterSeq = 0): JournalEntry[] {
    return (this.files.get(file)?.entries ?? []).filter((e) => e.seq > afterSeq);
  }

  entry(file: string, seq: number): JournalEntry | undefined {
    return this.files.get(file)?.entries.find((e) => e.seq === seq);
  }

  /** The newest seq given in this file; 0 before the first call. */
  lastSeq(file: string): number {
    const f = this.files.get(file);
    return f ? f.next - 1 : 0;
  }

  /** The oldest seq still kept: entries before it were dropped past the limit. */
  firstSeq(file: string): number {
    const f = this.files.get(file);
    return f?.entries[0]?.seq ?? (f ? f.next : 1);
  }

  /**
   * figma_savepoint: the plugin's mark (its commit count, its clock, its
   * page) stored with the journal's position, as an entry of its own. A retry
   * under the same idempotencyKey returns the savepoint it made.
   */
  savepoint(file: CallFile, mark: { label: string; commits: number; at: number; pageId: string | null; idempotencyKey?: string | undefined }): Savepoint {
    const known = mark.idempotencyKey !== undefined ? this.byId.get(this.byKey.get(mark.idempotencyKey) ?? "") : undefined;
    if (known) return known;
    const id = `sp-${this.nextSavepoint++}`;
    const entry = this.record(file, { tool: toolName("savepoint"), summary: `${toolName("savepoint")} ${id} ${JSON.stringify(mark.label)}`, ok: true, savepointId: id });
    const sp: Savepoint = {
      id,
      label: mark.label,
      file: file.key,
      fileName: file.name,
      commits: mark.commits,
      at: mark.at,
      pageId: mark.pageId,
      journalSeq: entry.seq,
      sessionId: file.sessionId,
      instanceId: file.instanceId,
    };
    const f = this.journal(file.key);
    f.savepoints.push(sp);
    this.byId.set(id, sp);
    if (mark.idempotencyKey !== undefined) this.byKey.set(mark.idempotencyKey, id);
    while (f.savepoints.length > SAVEPOINT_LIMIT) this.forget(f.savepoints.shift()!);
    return sp;
  }

  findSavepoint(id: string): Savepoint | undefined {
    return this.byId.get(id);
  }

  /** This file's savepoints, oldest first. */
  savepoints(file: string): Savepoint[] {
    return [...(this.files.get(file)?.savepoints ?? [])];
  }

  /** The calls a rollback to `sp` takes back: after it, not taken back already, and not a savepoint or a rollback. */
  undoable(sp: Savepoint): JournalEntry[] {
    return this.since(sp.file, sp.journalSeq).filter((e) => !e.rolledBack && !MARKS.has(e.tool));
  }

  /** The nodes the calls since `sp` made, in the order they were made. */
  createdSince(sp: Savepoint): string[] {
    return [...new Set(this.undoable(sp).flatMap((e) => e.created))];
  }

  /**
   * A rollback to `sp` ran: its calls are marked taken back (those that
   * provably changed nothing are left as they were), and the savepoints made
   * after it are forgotten — the states they marked no longer exist. Returns
   * the entries marked.
   */
  rolledBackTo(sp: Savepoint): JournalEntry[] {
    const marked = this.undoable(sp).filter((e) => !e.unchanged);
    for (const e of marked) e.rolledBack = true;
    const f = this.journal(sp.file);
    for (const later of f.savepoints.filter((s) => s.journalSeq > sp.journalSeq)) this.forget(later);
    f.savepoints = f.savepoints.filter((s) => s.journalSeq <= sp.journalSeq);
    return marked;
  }

  private forget(sp: Savepoint): void {
    this.byId.delete(sp.id);
    for (const [key, id] of this.byKey) if (id === sp.id) this.byKey.delete(key);
  }
}

// ── one journal per bridge, so per server process ───────────────────────────

const journals = new WeakMap<object, Journal>();

/** This process's journal: one per bridge, which a test's fake bridge gets fresh. */
export function journalOf(bridge: object): Journal {
  let j = journals.get(bridge);
  if (!j) journals.set(bridge, (j = new Journal()));
  return j;
}

type Row = {
  sessionId: string;
  active?: boolean;
  instanceId?: string;
  editorType?: string;
  file?: { name?: string | null; key?: string | null } | null;
};

/**
 * The key a connected file's journal is kept under: the file's key, else its
 * name and editor. The same rule as role-process.ts fileKeyOf, written out here
 * so the forwarding path does not import the gates, which import it.
 */
export const journalKeyOf = (row: Pick<Row, "file" | "editorType">): string =>
  row.file?.key || `${row.file?.name ?? "untitled"} (${row.editorType ?? "unknown editor"})`;

/**
 * The file `session` names (an id or a file name), else the active one, as
 * the bridge picks for a call without it (role-process.ts fileOf). null when
 * no file is connected or the bridge cannot say. Answered by the bridge itself:
 * no plugin read, and it never throws.
 */
export async function callFile(bridge: Pick<Bridge, "statusAsync">, session: string | undefined): Promise<CallFile | null> {
  let rows: Row[];
  try {
    rows = ((await bridge.statusAsync()) as unknown as { sessions?: Row[] }).sessions ?? [];
  } catch {
    return null;
  }
  const picked =
    session === undefined
      ? (rows.find((s) => s.active) ?? (rows.length === 1 ? rows[0] : undefined))
      : (rows.find((s) => s.sessionId === session) ?? rows.find((s) => (s.file?.name ?? "").toLowerCase() === session.toLowerCase()));
  if (!picked) return null;
  return {
    key: journalKeyOf(picked),
    name: picked.file?.name ?? null,
    sessionId: picked.sessionId,
    instanceId: typeof picked.instanceId === "string" ? picked.instanceId : null,
  };
}

// ── what a call made, named and did ─────────────────────────────────────────

/** A node's id as Figma gives a node it just made; styles (S:…), variables and instance sublayers are not. */
const NODE_ID = /^\d+:\d+$/;

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const theId = (d: Record<string, unknown>) => [d.id];

/**
 * Per op, where its result names the nodes it made — and nothing it found:
 * deleting those ids takes back the call and never anyone's work. So not the
 * ops that wrap or replace existing nodes (convert_to_component,
 * combine_as_variants, group, boolean, flatten, detach), whose new node holds
 * what was there before; not styles, variables or library imports, which are
 * not nodes; and per op, not the ids a result names that were already there:
 * import_image into `nodeId` fills that node (`applied: "fill"`), and
 * create_animatic names the storyboard it was made from.
 */
const CREATED: Readonly<Record<string, (d: Record<string, unknown>) => unknown[]>> = {
  create_from_spec: (d) => [d.rootId, ...list(d.rootIds)],
  create_frame: theId,
  create_text: theId,
  create_rectangle: theId,
  create_ellipse: theId,
  create_line: theId,
  create_polygon: theId,
  create_star: theId,
  create_vector: theId,
  create_section: theId,
  create_page: theId,
  create_instance: theId,
  import_svg: theId,
  import_image: (d) => (d.applied === "fill" ? [] : [d.id]),
  create_slot: (d) => [d.slotId],
  create_stickies: () => [],
  create_shapes_with_text: () => [],
  create_connectors: () => [],
  create_table: theId,
  create_code_block: theId,
  create_link_preview: theId,
  create_slides: (d) => list(d.slides),
  create_storyboard: (d) => [d.storyboardId],
  create_animatic: (d) => [d.animaticId],
  // The copy; `sourceId` is what it was copied from.
  clone_node: theId,
  // The copies `keep: true` leaves.
  stress_test: (d) => list(d.kept),
};

/** The ops whose calls make nodes the journal records. */
export const MAKES_NODES: ReadonlySet<string> = new Set(Object.keys(CREATED));

/**
 * The nodes a call made, from its result — or, for a call that failed half-way,
 * from its error's `partial`. Either way `created` (a spec's every node, a
 * board tool's items, `{ id, name, path }` or plain ids) lists what was made.
 */
export function createdIdsOf(op: string, data: unknown): string[] {
  const named = CREATED[op];
  if (!named || !isObject(data)) return [];
  const out = new Set<string>();
  for (const v of [...named(data), ...list(data.created)]) {
    const id = typeof v === "string" ? v : isObject(v) && typeof v.id === "string" ? v.id : undefined;
    if (id !== undefined && NODE_ID.test(id)) out.add(id);
  }
  return [...out];
}

/** The params that name what a call acts on (the guard's targets, trust spec §2.3, plus slides and a description's target). */
const TARGET_KEYS = new Set(["nodeId", "nodeIds", "slideId", "slideIds", "targetId"]);
/** Never walked: a spec's nodes do not exist yet, and reactions and flows name where to go, not what changes. */
const NOT_TARGETS = new Set(["spec", "reactions", "flows"]);

/** The existing nodes a call named, at any depth of its params (a batch's steps, an edit's items) but a spec. */
export function targetIdsOf(params: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 5) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (!isObject(v)) return;
    for (const [k, x] of Object.entries(v)) {
      if (NOT_TARGETS.has(k)) continue;
      if (TARGET_KEYS.has(k)) {
        for (const id of Array.isArray(x) ? x : [x]) if (typeof id === "string" && id !== "") out.add(id);
      } else if (typeof x === "object" && x !== null) walk(x, depth + 1);
    }
  };
  walk(params, 0);
  return [...out];
}

/** Never in a summary: they say how the call was sent, not what it did (`tells`: the server asked a create to measure its tells). */
const LEAVE_OUT = new Set(["session", "idempotencyKey", "force", "tells"]);
/** Text a person wrote, shown by its start; any other long string (base64, SVG, a data URL) is only measured. */
const TEXT_KEYS = new Set(["content", "name", "title", "label", "text", "find", "replace", "description", "message", "goal"]);
const SUMMARY_MAX = 200;

function short(key: string, v: unknown): string {
  if (typeof v === "string") {
    if (v.length <= 40) return JSON.stringify(v);
    return TEXT_KEYS.has(key) ? `${JSON.stringify(v.slice(0, 32)).slice(0, -1)}…"` : `<${v.length} chars>`;
  }
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  if (Array.isArray(v)) {
    return v.length > 0 && v.length <= 3 && v.every((x) => typeof x === "string" && x.length <= 24) ? `[${v.join(", ")}]` : `[${v.length}]`;
  }
  if (isObject(v)) {
    const what = [typeof v.type === "string" ? v.type : "", typeof v.name === "string" ? JSON.stringify(v.name.slice(0, 24)) : ""].filter(Boolean).join(" ");
    return `{${what || "…"}}`;
  }
  return "…";
}

/**
 * One line for the call: the tool and its params in short form —
 * `figma_set_text nodeId="12:34" content="Book a bench slot online, wi…"`;
 * a batch names its steps' tools. At most 200 characters.
 */
export function summarize(op: string, params: Record<string, unknown>): string {
  const parts = [toolName(op)];
  if (op === "batch" && Array.isArray(params.steps)) {
    const ops = params.steps.map((s) => (isObject(s) && typeof s.op === "string" ? s.op : "?"));
    parts.push(`steps=${ops.length}: ${ops.slice(0, 5).join(", ")}${ops.length > 5 ? `, +${ops.length - 5}` : ""}`);
  } else {
    for (const [k, v] of Object.entries(params)) if (!LEAVE_OUT.has(k) && v !== undefined) parts.push(`${k}=${short(k, v)}`);
  }
  const line = parts.join(" ");
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

/** An entry as figma_get_changes shows it: ISO time, and the empty fields left out. */
export function entryView(e: JournalEntry): Record<string, unknown> {
  return {
    seq: e.seq,
    at: new Date(e.at).toISOString(),
    tool: e.tool,
    summary: e.summary,
    ok: e.ok,
    ...(e.error !== undefined ? { error: e.error } : {}),
    ...(e.unchanged ? { unchanged: true } : {}),
    ...(e.created.length ? { created: e.created } : {}),
    ...(e.targets.length ? { targets: e.targets } : {}),
    ...(e.rolledBack ? { rolledBack: true } : {}),
    ...(e.savepointId !== undefined ? { savepointId: e.savepointId } : {}),
  };
}
