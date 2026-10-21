// Safe co-editing in the plugin (trust spec §2.1–§2.3, §2.5): who changed
// what, what the agent has seen, the stale-write guard the dispatcher runs
// before a write, and the get_changes, savepoint and rollback ops.
//
// Figma does not say whose a change is. A change's origin is LOCAL for
// everything done in this Figma window, the plugin's own writes included, and
// REMOTE for another user's [C-392]. So the plugin attributes changes itself,
// by content, with time as a hint:
//
//  - Time first: a LOCAL change inside an op's footprint, while the op runs or
//    within SETTLE_MS after it ends, is the agent's.
//  - Then content (echo.ts): any other change, LOCAL or REMOTE, that leaves
//    the node as the agent last saw it — what its last write left behind, or
//    what its last read returned — is the agent's own late echo.
//  - Anything else is a person's at this window (LOCAL) or a collaborator's
//    (REMOTE).
//
// Change events arrive batched [C-393], and in the live role tests seconds to
// minutes after the write, some of the agent's own with origin REMOTE (role
// tests, findings 6, 6b, 6c) [C-394]: the window alone took the agent's own
// changes for a person's and answered false STALEs. The content rule is what
// decides; the window still covers what content cannot vouch for, such as a
// reflow beyond what a write records.
//
// A write to variables or styles names no node, yet re-colours every node
// bound to them. Its footprint covers the whole watched page for the op and
// its settle window (PAGE_WIDE_OPS), and the node hashes are binding-aware
// (echo.ts), so a late re-colouring matches what the agent last saw. A change
// to a variable or style itself is caught by the resource watch (RESOURCE_OPS,
// savepoint, rollback): what changed and was not the agent's blocks a rollback.
//
// Honest limits (spec §2.1): only the current page is watched; figma_eval's
// writes have no footprint, so they read as a person's; a person editing a
// node inside the agent's footprint during the settle window — or inside a
// variable or style write's window, anywhere on the page — is attributed to
// the agent; a person's edit to a node the agent was writing, made just before
// the write and reported after it, reads as part of what the write left; and a
// node a person deletes is placed by the ancestry last seen for it, so the
// deletion of a layer never seen before counts for itself only.
//
// Rollback undoes with figma.triggerUndo(), which also reverts a person's
// edits made since [C-024]. So it refuses whenever anyone but the agent
// changed anything, and counts the steps from the dispatcher's own commitUndo
// calls [C-059]; whether N undos take back exactly N calls is to-verify
// [C-395], and UNDO holds the one assumption it makes. Several agents can
// share one plugin (a hub and its proxies), and one undo counter cannot tell
// their steps apart: every commit records the agent that sent it (the guard's
// `agent`), and rollback refuses when another agent's call came since.
//
// Structural types only (no plugin typings), so tests import this as it is.
// Every Figma read is guarded: this module watches; it must never break an op.

import { BridgeError, ErrorCode } from "../shared/errors.js";
import { toolName } from "../shared/ops.js";
import { childrenOf, field, type NodeLike } from "./board-read.js";
import {
  changedBetween, dependentsOf, explainedBy, newContext, noteChange, readResources, removedRecord, snapshot, unchangedSince,
  type HashContext, type Resources, type Scope, type Seen,
} from "./echo.js";
import { beforeMutating } from "./guard.js";
import { changedNothing, type StoredResult } from "./idempotency.js";
import type { OpContext, PluginOp } from "./ops/index.js";
import { figmaGlobal } from "./safe.js";

// ── constants a live run calibrates ─────────────────────────────────────────

/**
 * How long after an op ends a change in its footprint is still the agent's by
 * time alone [C-394]. Not raised for the late deliveries the role tests saw:
 * content decides those (echo.ts), and a longer window would only give the
 * agent more of a person's edits.
 */
export const SETTLE_MS = 1_500;

/**
 * Auto-layout reflow: a write inside an auto-layout moves the siblings that
 * follow it, and a hugging parent moves its own siblings in turn. With this on,
 * a footprint also covers everything under each auto-layout ancestor up the
 * chain (stopping at the first that is not auto-layout). Whether Figma reports
 * those moves as changes is part of [C-394].
 */
export const REFLOW = true;

/**
 * The undo model rollback counts with [C-395]. Every write op ends with one
 * commitUndo. Whether a commit after an op that provably changed nothing (a
 * refusal: partial.created is []) is an undo step of its own is unmeasured.
 * Counting it as one when it is not would undo a step from before the
 * savepoint — someone's work — so it is not counted until a live run says it
 * is: an undo too few leaves agent work behind, which the verification
 * reports; an undo too many takes back what came before.
 */
export const UNDO = { emptyCommitIsAStep: false };

/** Memory bounds: the plugin runs for hours in a file people work in. */
export const LIMITS = {
  /** People's and collaborators' changes: the latest per node, for this many nodes. */
  changes: 2_000,
  /** Ids indexed for "did anything under X change". */
  under: 20_000,
  /** Nodes with a view time. */
  views: 5_000,
  /** Last known ancestry and name, for a node that is deleted later. */
  known: 5_000,
  /** Changes held while a write runs, until its footprint is complete. */
  pending: 2_000,
  pageSwitches: 200,
  /** Commits remembered for rollback. */
  commits: 5_000,
  /** get_changes lists at most this many changes and conflicts. */
  listed: 200,
  /** Node lookups per op for its footprint's ancestry. */
  lookups: 100,
  footprints: 50,
  /** Nodes whose content the agent last saw (echo.ts): about 0.5 kB each. */
  seen: 6_000,
  /** Nodes a write records the after-state of: what it named or made first, then their surroundings. */
  record: 500,
  /** Nodes a read records, breadth first from its roots. */
  readRecord: 250,
  /** Children of one parent recorded as reflowed siblings. */
  siblings: 200,
  /** Variables and styles the agent's own writes changed, with all that resolves through them. */
  affected: 5_000,
  /** Variable and style changes found that were not the agent's. */
  resourceChanges: 200,
};

/** Reads that return a node's content (spec §2.2): each records a view of its roots. */
export const VIEW_OPS: ReadonlySet<string> = new Set([
  "get_node", "get_nodes_info", "get_design_context", "get_selection", "export_node", "check_layout", "get_brief",
  "scan_text_nodes", "get_motion_context", "check_motion",
]);

/**
 * Ops that switch the page on purpose: a page switch while one runs, or within
 * the settle window after it, is the agent's. create_page switches with
 * `activate: true`.
 */
export const PAGE_OPS: ReadonlySet<string> = new Set(["navigate_page", "select", "zoom_to", "create_page"]);

/**
 * Writes that can change the file's local variables, collections or styles:
 * the resource watch reads them before and after each, so what changed in
 * between is the agent's, and what changed anywhere else is someone else's.
 * figma_eval can change anything, so it is one too.
 */
export const RESOURCE_OPS: ReadonlySet<string> = new Set([
  "create_variable_collection", "create_variable", "create_variables", "create_paint_style", "create_text_style",
  "create_effect_style", "create_grid_style", "import_library_assets", "add_variable_mode", "set_variable_value",
  "set_variable_properties", "update_variable_collection", "update_style", "delete_variable", "delete_variable_collection",
  "delete_style", "eval",
]);

/**
 * Of those, the writes that re-resolve the nodes bound to what they change —
 * a new value, a removed mode, an updated or deleted style. They name no node,
 * so their footprint is the whole watched page for the op and its settle
 * window (finding 6b). Finding exactly the bound nodes would mean walking the
 * page on every such write; the cost of the wider cover is that a person's edit
 * anywhere on the page in those 1.5 s counts as the agent's.
 */
export const PAGE_WIDE_OPS: ReadonlySet<string> = new Set([
  "set_variable_value", "create_variables", "update_variable_collection", "update_style", "delete_variable",
  "delete_variable_collection", "delete_style",
]);

/** Params naming a node the op reads but does not change: never a target (clone_node's source, the stress test's frame). */
const SOURCE_PARAMS: Readonly<Record<string, readonly string[]>> = { clone_node: ["nodeId"], stress_test: ["nodeId"] };

/** The keys that name nodes in params, at the top and inside lists of objects. */
const ID_KEYS = ["nodeId", "nodeIds", "slideId", "slideIds"] as const;

/** A node id: `12:34`, or an instance sublayer's `I12:34;56:78`. */
const NODE_ID = /^I?\d+:\d+(;\d+:\d+)*$/;
/** Result keys that hold node ids; `pageId` is left out — a page in a footprint would cover the whole page. */
const RESULT_ID_KEY = /^(id|ids|created|kept|(?!page)[a-z][A-Za-z]*Ids?)$/;
/** Result keys that hold what a write made or changed: the view a write records. */
const WRITTEN_KEY = /^(id|created|kept|createdIds)$/;

// ── types ───────────────────────────────────────────────────────────────────

export type By = "person" | "collaborator";

/** A person's or a collaborator's change, with the ancestry it had when it arrived. */
export interface ChangeRecord {
  nodeId: string;
  name: string;
  by: By;
  at: number;
  /** The node and every ancestor up to the document, at change time. */
  ancestry: readonly string[];
}

/** contract: a target changed by someone else after the agent's view of it. */
export interface Conflict {
  nodeId: string;
  name: string;
  by: By;
  at: number;
  viewedAt: number;
}

export interface PageSwitch {
  at: number;
  pageId: string;
  by: "agent" | "person";
}

/** One change as nodechange reports it (plugin typings 1.141.0, NodeChange) [C-392]. */
export interface ChangeLike {
  id: string;
  origin: string;
  /** CREATE, DELETE or PROPERTY_CHANGE. */
  type?: string;
  /** A PROPERTY_CHANGE's changed properties (NodeChangeProperty). */
  properties?: readonly string[];
  node?: unknown;
}

/**
 * A write request's guard: BRIDGE_CONFLICTS, the call's force, and `agent`,
 * one id per server process. A hub passes a proxy's guard on unchanged, so it
 * tells apart the agents sharing this plugin where the request id cannot (the
 * hub re-sends a proxy's call under its own id). Absent from an older server.
 */
export type Guard = { conflicts: string; force?: boolean; agent?: string } | undefined;

/** The agent a request's guard names, if any. */
export function agentOf(guard: unknown): string | undefined {
  const agent = isObject(guard) ? guard.agent : undefined;
  return typeof agent === "string" && agent ? agent : undefined;
}

interface Footprint {
  start: number;
  /** Infinity while the op runs; its end plus SETTLE_MS after. */
  until: number;
  /** Every LOCAL change is the agent's: an undo, whose nodes nobody named. */
  all: boolean;
  /** A page switch in the window is the agent's. */
  pages: boolean;
  seeds: Set<string>;
  /** Ancestors of the seeds, up to the document. */
  above: Set<string>;
  /** Auto-layout ancestors whose whole subtree reflows with the seeds (REFLOW). */
  reflow: Set<string>;
}

interface Raw {
  id: string;
  origin: string;
  at: number;
  name: string;
  ancestry: string[];
  /** CREATE, DELETE, PROPERTY_CHANGE; absent from an event that does not say. */
  kind: string | undefined;
  /** What the change names: a property change's properties; none for a creation, a deletion or an older event. */
  props: string[] | undefined;
  /** The node, live (or a RemovedNode): judged by its content when the change is judged. */
  node: unknown;
}

/** One running op, from the dispatcher's begin to its end. */
export interface Span {
  op: string;
  params: Record<string, unknown>;
  write: boolean;
  start: number;
  footprint: Footprint | null;
  /** The selection when a content read named no node: what it read. */
  selection: string[];
  /** The server process that sent it (Guard.agent). */
  agent: string | undefined;
  /** A write's commit, filled in at its end with what it wrote. */
  commit?: Commit;
  /** Nodes it declared through ctx.touched: made and deleted again. */
  touched: string[];
  /** A RESOURCE_OPS write: the variables and styles before it ran (null: this editor has none). */
  resources?: Resources | null;
}

interface Commit {
  n: number;
  /** Counted as an undo step (UNDO). */
  step: boolean;
  /** Who sent the op: two agents can share one plugin, and an undo cannot tell their steps apart. */
  agent: string | undefined;
  op: string;
  at: number;
  /** What it wrote, for a refusal to name. */
  ids: string[];
}

/**
 * What rollback refuses on: someone else's edit, another agent's tool call,
 * or a variable or style that changed and was not the agent's ("someone
 * else": Figma does not say who changed a variable; `nodeId` is its id).
 */
export interface Changed {
  nodeId: string;
  name: string;
  by: By | "another agent" | "someone else";
  at: number;
  /** For another agent's call: the tool it ran. */
  op?: string;
}

interface NodeInfo {
  /** The node and its ancestors, nearest first. */
  ids: string[];
  name: string;
  type: string;
  /** Auto-layout ancestors up the chain, stopping at the first that is not one. */
  reflow: string[];
  label: string;
}

interface TrustFigma {
  currentPage?: { id?: string; name?: string; selection?: ReadonlyArray<{ id: string }> };
  getNodeByIdAsync?(id: string): Promise<unknown>;
  triggerUndo?(): void;
}

export interface TrustOptions {
  now?: () => number;
  figma?: () => unknown;
  /** Waits `ms`. Without one, rollback does not wait for late change events. */
  delay?: (ms: number) => Promise<void>;
}

// ── params ──────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function idsAt(obj: Record<string, unknown>, keys: readonly string[], skip: readonly string[], out: string[]): void {
  for (const k of keys) {
    if (skip.indexOf(k) >= 0) continue;
    const v = obj[k];
    if (typeof v === "string" && v.trim()) out.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x.trim()) out.push(x);
  }
}

/** A batch's `steps` as sent, or the JSON string a raw caller sends (ops/batch.ts parseSteps). */
function stepsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The op itself, or for a batch every step's op. */
function opsOf(op: string, params: Record<string, unknown>): string[] {
  if (op !== "batch") return [op];
  return stepsOf(params.steps).flatMap((s) => (isObject(s) && typeof s.op === "string" ? [s.op.trim().replace(/^figma_/, "")] : []));
}

/** The op, or a step of it, is in `set`. */
const anyOf = (set: ReadonlySet<string>, op: string, params: Record<string, unknown>) => opsOf(op, params).some((o) => set.has(o));

/**
 * The node ids an op names in its params: `nodeId`, `nodeIds` (and a deck's
 * `slideId`, `slideIds`) at the top and inside any list of objects — items,
 * connectors, slides — and, for a batch, in each step's own params.
 * `parentId` only with `parents`: adding into a frame overwrites nothing, so it
 * is never a target, though it is in the footprint. A source the op only reads
 * only with `sources`.
 */
export function namedIds(op: string, params: Record<string, unknown>, opts: { parents?: boolean; sources?: boolean } = {}): string[] {
  const out: string[] = [];
  const keys: string[] = [...ID_KEYS, ...(opts.parents ? ["parentId"] : [])];
  const skip = opts.sources ? [] : (SOURCE_PARAMS[op] ?? []);
  idsAt(params, keys, skip, out);
  for (const k of Object.keys(params)) {
    if (op === "batch" && k === "steps") {
      for (const s of stepsOf(params.steps)) {
        if (!isObject(s) || typeof s.op !== "string") continue;
        const stepOp = s.op.trim().replace(/^figma_/, "");
        if (isObject(s.params)) out.push(...namedIds(stepOp, s.params, opts));
      }
      continue;
    }
    const v = params[k];
    if (Array.isArray(v)) for (const item of v) if (isObject(item)) idsAt(item, keys, skip, out);
  }
  return unique(out);
}

/** The nodes a write modifies (spec §2.3): what the guard checks. */
export function targetsOf(op: string, params: Record<string, unknown>): string[] {
  return namedIds(op, params);
}

/** Node ids in a result under the keys `key` accepts, walked to a fixed depth. */
function idsIn(value: unknown, key: RegExp, out: Set<string>, depth = 0, budget = { left: 5_000 }): void {
  if (depth > 6 || budget.left <= 0 || value === null || typeof value !== "object") return;
  budget.left--;
  if (Array.isArray(value)) {
    for (const v of value) idsIn(v, key, out, depth + 1, budget);
    return;
  }
  for (const k of Object.keys(value)) {
    const v = (value as Record<string, unknown>)[k];
    if (key.test(k)) {
      if (typeof v === "string" && NODE_ID.test(v)) out.add(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && NODE_ID.test(x)) out.add(x);
    }
    if (v !== null && typeof v === "object") idsIn(v, key, out, depth + 1, budget);
  }
}

function unique(list: readonly string[]): string[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
}

/** Set `key` as the newest entry, dropping the oldest past `max`. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));
/** Local wall-clock time, as the person reads it. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const AUTO_LAYOUTS = new Set(["HORIZONTAL", "VERTICAL", "GRID"]);
const WHOLE = new Set(["PAGE", "DOCUMENT"]);

/** The node and its ancestors, its name, and the auto-layout chain above it. Null for a removed node. */
function describe(node: unknown): NodeInfo | null {
  if (!node || field(node, "removed") === true) return null;
  const ids: string[] = [];
  const names: string[] = [];
  const types: string[] = [];
  let at: unknown = node;
  for (let depth = 0; at && depth < 200; depth++) {
    const id = field(at, "id");
    if (typeof id !== "string") break;
    ids.push(id);
    names.push(String(field(at, "name") ?? ""));
    types.push(String(field(at, "type") ?? ""));
    at = field(at, "parent");
  }
  if (!ids.length) return null;
  // Up the chain while the parent is an auto-layout: its children reflow.
  const reflow: string[] = [];
  let p: unknown = field(node, "parent");
  while (p && AUTO_LAYOUTS.has(String(field(p, "layoutMode") ?? ""))) {
    const id = field(p, "id");
    if (typeof id === "string") reflow.push(id);
    p = field(p, "parent");
  }
  const name = names[0]!;
  // "Hero / Title": the parent's name too, unless the parent is the page.
  const label = names.length > 1 && !WHOLE.has(types[1]!) ? `${names[1]} / ${name}` : name;
  return { ids, name, type: types[0]!, reflow, label };
}

// ── the tracker ─────────────────────────────────────────────────────────────

export class Trust {
  private readonly now: () => number;
  private readonly api: () => TrustFigma;
  private delay: ((ms: number) => Promise<void>) | undefined;
  /** When this plugin run began: a savepoint older than this belongs to another run. */
  readonly startedAt: number;

  private footprints: Footprint[] = [];
  private pending: Raw[] = [];
  private current: Span | null = null;
  /** The latest person's or collaborator's change per node (spec §2.1). */
  private readonly foreign = new Map<string, ChangeRecord>();
  /** Per id, the latest such change to it or anything under it: "did anything under X change" in one lookup. */
  private readonly under = new Map<string, ChangeRecord>();
  /** The latest such change of all: what rollback refuses on even after the maps above forgot it. */
  private lastForeign: ChangeRecord | null = null;
  private readonly known = new Map<string, { ancestry: string[]; name: string }>();
  private readonly views = new Map<string, number>();
  private readonly pages: Array<PageSwitch & { name: string }> = [];
  private commitLog: Commit[] = [];
  /** commitUndo calls this plugin run has made, less the ones rollback undid. */
  private commitCount = 0;
  /** The last time figma_undo_step ran: the commit count no longer says what an undo takes back. */
  private undoStepAt = -Infinity;
  /** What the agent last saw of each node, per property (echo.ts): what a late change is matched against. */
  private readonly seen = new Map<string, Seen>();
  /** Variables and styles the agent's own writes changed, and all that resolves through them. */
  private readonly affected = new Set<string>();
  /** The variables and styles as the agent last knew them: a difference from this is someone else's. */
  private expected: Resources | null = null;
  /** Variable and style changes that were not the agent's, stamped when found. */
  private resourceChanges: Array<{ id: string; name: string; kind: string; at: number }> = [];

  constructor(opts: TrustOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    const get = opts.figma ?? figmaGlobal;
    this.api = () => (get() ?? {}) as TrustFigma;
    this.delay = opts.delay;
    this.startedAt = this.now();
  }

  /** The wait rollback gives late change events (code.ts passes the UI scheduler's delay). */
  setDelay(delay: (ms: number) => Promise<void>): void {
    this.delay = delay;
  }

  get commits(): number {
    return this.commitCount;
  }

  // ── events (events.ts) ────────────────────────────────────────────────────

  /** The current page's nodechange: attribute each change, or hold it while a write's footprint is incomplete. */
  nodesChanged(e: { nodeChanges?: ReadonlyArray<ChangeLike> }): void {
    const at = this.now();
    // One batch is judged in one go, while nothing in the document moves: a parent's children are read once.
    const ctx = newContext();
    for (const c of e.nodeChanges ?? []) {
      if (!c || typeof c.id !== "string") continue;
      const raw = this.raw(c, at);
      if (this.current?.write) {
        // Bounded: past the cap the oldest is judged now, against what is known.
        if (this.pending.length >= LIMITS.pending) this.attribute(this.pending.shift()!, ctx);
        this.pending.push(raw);
      } else this.attribute(raw, ctx);
    }
  }

  /** currentpagechange: the agent's when a page op runs or just ran, else the person's. */
  pageChanged(page: { id: string; name?: string }): void {
    const at = this.now();
    const byAgent = this.footprints.some((f) => f.pages && at >= f.start && at <= f.until);
    this.pages.push({ at, pageId: page.id, by: byAgent ? "agent" : "person", name: page.name ?? "" });
    if (this.pages.length > LIMITS.pageSwitches) this.pages.shift();
  }

  private raw(c: ChangeLike, at: number): Raw {
    const kind = typeof c.type === "string" ? c.type : undefined;
    const props = kind === "PROPERTY_CHANGE" && Array.isArray(c.properties) ? c.properties.filter((p): p is string => typeof p === "string") : undefined;
    const info = describe(c.node);
    if (info) {
      remember(this.known, c.id, { ancestry: info.ids, name: info.name }, LIMITS.known);
      return { id: c.id, origin: c.origin, at, name: info.name, ancestry: info.ids, kind, props, node: c.node };
    }
    // Removed: RemovedNode has no parent. The ancestry it last had, if it was seen.
    const last = this.known.get(c.id);
    return { id: c.id, origin: c.origin, at, name: last?.name ?? "", ancestry: last ? last.ancestry : [c.id], kind, props, node: c.node };
  }

  /**
   * Whose a change is: the agent's by time (a LOCAL change in a footprint
   * window), else the agent's by content (it left the node as the agent last
   * saw it: a late echo, whatever its origin), else a person's or a
   * collaborator's.
   */
  private attribute(raw: Raw, ctx: HashContext): void {
    if (raw.origin !== "REMOTE") {
      for (const f of this.footprints) {
        if (raw.at >= f.start && raw.at <= f.until && covers(f, raw)) return this.noteEcho(raw, ctx);
      }
    }
    if (this.isEcho(raw, ctx)) return;
    this.keep(raw, raw.origin === "REMOTE" ? "collaborator" : "person");
  }

  /** The change leaves the node as the agent last saw it (echo.ts). */
  private isEcho(raw: Raw, ctx: HashContext): boolean {
    try {
      const node = raw.node;
      const gone = !node || field(node, "removed") === true;
      const rec = this.seen.get(raw.id);
      if (gone) return rec?.removed === true;
      if (!rec) return !!raw.props?.length && explainedBy(node, raw.props, this.affected, ctx);
      if (rec.removed) return false; // it is back: the agent last saw it deleted
      return unchangedSince(rec, node, raw.props, this.affected, ctx);
    } catch {
      return false; // unreadable: not shown to be the agent's
    }
  }

  /**
   * A change the timing gave to the agent: what it left is what the agent has
   * seen — the properties it names, a created node whole, a deleted one as
   * gone. A change that names nothing records nothing.
   */
  private noteEcho(raw: Raw, ctx: HashContext): void {
    try {
      const node = raw.node;
      if (!node || field(node, "removed") === true) return this.store(raw.id, removedRecord());
      if (raw.props?.length || raw.kind === "CREATE") this.store(raw.id, noteChange(node, raw.props, this.seen.get(raw.id), ctx));
    } catch {
      /* the attribution stands; only the record is missing */
    }
  }

  private store(id: string, rec: Seen): void {
    remember(this.seen, id, rec, LIMITS.seen);
  }

  /** Record `node` (null: gone) as the agent now sees it. A page or the document is never recorded. */
  private note(id: string, node: unknown, scope: Scope, ctx?: HashContext): void {
    try {
      if (!node || field(node, "removed") === true) return this.store(id, removedRecord());
      if (WHOLE.has(String(field(node, "type") ?? ""))) return;
      this.store(id, snapshot(node, scope, ctx, this.seen.get(id)));
    } catch {
      /* a node that cannot be read is not recorded: its changes stay unvouched for */
    }
  }

  private async nodeById(id: string): Promise<unknown> {
    const get = this.api().getNodeByIdAsync;
    if (typeof get !== "function") return null;
    try {
      return (await get.call(this.api(), id)) ?? null;
    } catch {
      return null;
    }
  }

  private keep(raw: Raw, by: By): void {
    const rec: ChangeRecord = { nodeId: raw.id, name: raw.name, by, at: raw.at, ancestry: raw.ancestry };
    remember(this.foreign, raw.id, rec, LIMITS.changes);
    for (const id of raw.ancestry) remember(this.under, id, rec, LIMITS.under);
    this.lastForeign = rec;
  }

  // ── the dispatcher's hooks (code.ts) ──────────────────────────────────────

  /**
   * The stale-write guard (spec §2.3), before a write runs. Each target the
   * agent has a view time for is checked for a person's or a collaborator's
   * change to it or anything under it after that time. `refusal` is set only
   * for `refuse` without `force`; `conflicts` is what `warn` and `force` add to
   * the result. No guard (an older server) or `off`: nothing.
   */
  async guard(op: string, params: Record<string, unknown>, guard: Guard): Promise<{ conflicts: Conflict[]; refusal?: BridgeError }> {
    if (!guard || guard.conflicts === "off") return { conflicts: [] };
    const found: Array<Conflict & { label: string; changedId: string; changedName: string }> = [];
    try {
      for (const id of targetsOf(op, params)) {
        const c = await this.conflictFor(id);
        if (c) found.push(c);
      }
    } catch {
      return { conflicts: [] }; // the guard watches; a failure in it never blocks a write
    }
    const conflicts = found.map(({ nodeId, name, by, at, viewedAt }) => ({ nodeId, name, by, at, viewedAt }));
    if (!found.length || guard.conflicts === "warn" || guard.force === true) return { conflicts };
    return { conflicts, refusal: this.stale(op, found) };
  }

  private async conflictFor(id: string): Promise<(Conflict & { label: string; changedId: string; changedName: string }) | null> {
    const info = await this.lookup(id);
    if (!info) return null; // gone: the op reports that itself
    const viewedAt = this.viewedAt(info.ids);
    if (viewedAt === undefined) return null; // never read or written: nothing to overwrite unseen
    const c = this.under.get(id);
    if (!c || c.at <= viewedAt) return null;
    return { nodeId: id, name: info.name, by: c.by, at: c.at, viewedAt, label: info.label, changedId: c.nodeId, changedName: c.name };
  }

  private stale(op: string, found: Array<Conflict & { label: string; changedId: string; changedName: string }>): BridgeError {
    const first = found[0]!;
    const who = first.by === "person" ? "you" : "a collaborator";
    const inside = first.changedId !== first.nodeId ? ` (inside it, "${first.changedName}" ${first.changedId})` : "";
    const ago = Math.max(0, Math.round((this.now() - first.viewedAt) / 1000));
    const more = found.length > 1 ? `, and ${found.length - 1} more target(s) changed the same way (partial.conflicts)` : "";
    const message =
      `${toolName(op)} was refused before any change: "${first.label}" (${first.nodeId}) was edited by ${who}${inside} after the agent ` +
      `last read it (${clock(first.viewedAt)}, ${ago} s ago)${more}. Writing now could overwrite ${found.length > 1 ? "those edits" : "that edit"}.`;
    const hint =
      found.length > 1
        ? `Read them again (figma_get_nodes_info { nodeIds: [${found.map((c) => `"${c.nodeId}"`).join(", ")}] } or figma_get_design_context), ` +
          "then send the call again; or pass force: true to overwrite on purpose."
        : `Read it again (figma_get_node { nodeId: "${first.nodeId}" } or figma_get_design_context), then send the call again; ` +
          "or pass force: true to overwrite on purpose.";
    const conflicts = found.map(({ nodeId, name, by, at, viewedAt }) => ({ nodeId, name, by, at, viewedAt }));
    return new BridgeError(ErrorCode.STALE, message, { hint, partial: { created: [], conflicts } });
  }

  /**
   * An op starts. A write opens its footprint from the ids its params name
   * (their ancestors looked up now); figma_undo_step's covers every LOCAL
   * change, since an undo touches nodes nobody named; a page op opens a window
   * in which a page switch is the agent's.
   */
  async begin(op: string, params: Record<string, unknown>, write: boolean, agent?: string): Promise<Span> {
    const start = this.now();
    const span: Span = { op, params, write, start, footprint: null, selection: [], agent, touched: [] };
    // A variable or style write re-colours nodes it does not name: its window covers the page (PAGE_WIDE_OPS).
    const pageWide = write && anyOf(PAGE_WIDE_OPS, op, params);
    if (write || op === "undo_step" || PAGE_OPS.has(op)) {
      span.footprint = this.open(start, { all: op === "undo_step" || pageWide, pages: PAGE_OPS.has(op) });
    }
    this.current = span;
    try {
      if (write && span.footprint) await this.widen(span.footprint, namedIds(op, params, { parents: true, sources: true }));
      if (VIEW_OPS.has(op) && !namedIds(op, params).length) {
        const sel = this.api().currentPage?.selection;
        span.selection = Array.isArray(sel) ? sel.map((n) => n.id).filter((id) => typeof id === "string") : [];
      }
      // The variables and styles before it runs; a difference from the last known is someone else's.
      if (write && anyOf(RESOURCE_OPS, op, params)) span.resources = await this.checkResources(start);
    } catch {
      /* a lookup that failed leaves a narrower footprint, never a failed op */
    }
    return span;
  }

  /** Nodes an op made or changed that its result does not list — copies it deleted again (OpContext.touched). */
  touched(span: Span, ids: readonly string[]): void {
    if (!span.footprint) return;
    for (const id of ids) {
      if (typeof id !== "string") continue;
      span.footprint.seeds.add(id);
      if (span.touched.length < LIMITS.record) span.touched.push(id);
    }
  }

  /**
   * The dispatcher committed one undo step after a write. A refusal that
   * provably changed nothing is counted, but not as a step (UNDO).
   */
  committed(result: StoredResult): void {
    this.commitCount++;
    const span = this.current;
    const commit: Commit = {
      n: this.commitCount,
      step: !changedNothing(result) || UNDO.emptyCommitIsAStep,
      agent: span?.agent,
      op: span?.op ?? "",
      at: this.now(),
      ids: [],
    };
    this.commitLog.push(commit);
    if (this.commitLog.length > LIMITS.commits) this.commitLog.shift();
    if (span) span.commit = commit;
  }

  /**
   * An op ended. A write's footprint gains what it created or returned and
   * starts its settle window; the views are recorded at the op's start (spec
   * §2.2) — a read's roots, a write's targets and what it made — with the
   * content each view saw (echo.ts); and the changes held while it ran are
   * judged against the complete footprint and those records.
   */
  async end(span: Span, result: StoredResult): Promise<void> {
    const f = span.footprint;
    try {
      if (span.write && f) {
        const made = new Set<string>();
        idsIn(result.ok ? result.data : result.partial, RESULT_ID_KEY, made);
        await this.widen(f, [...made]);
      }
      if (result.ok && VIEW_OPS.has(span.op)) {
        const roots = namedIds(span.op, span.params);
        const read = roots.length ? roots : span.selection;
        for (const id of read) this.view(id, span.start);
        await this.recordRead(read);
      }
      if (span.write && !changedNothing(result)) {
        const written = new Set<string>(targetsOf(span.op, span.params));
        idsIn(result.ok ? result.data : result.partial, WRITTEN_KEY, written);
        for (const id of written) this.view(id, span.start);
        if (span.commit) span.commit.ids = [...written].slice(0, 20);
        await this.recordAfter(span, result);
        if (span.resources !== undefined) await this.resourcesAfter(span.resources);
      }
      if (span.op === "undo_step" && result.ok) {
        this.undoStepAt = span.start;
        // Whatever the undo took back, variables and styles included, was the agent's doing.
        this.expected = (await readResources(this.api())) ?? this.expected;
      }
    } catch {
      /* as begin: never fail the op */
    }
    if (f && f.until === Infinity) f.until = this.now() + SETTLE_MS;
    if (this.current === span) this.current = null;
    const held = this.pending;
    this.pending = [];
    const ctx = newContext();
    for (const raw of held) this.attribute(raw, ctx);
    this.prune();
  }

  private open(start: number, opts: { all: boolean; pages: boolean }): Footprint {
    const f: Footprint = { start, until: Infinity, all: opts.all, pages: opts.pages, seeds: new Set(), above: new Set(), reflow: new Set() };
    this.footprints.push(f);
    return f;
  }

  /** Add seeds, looking up each one's ancestry while the lookup budget lasts. A page is never a seed. */
  private async widen(f: Footprint, ids: readonly string[]): Promise<void> {
    const page = this.api().currentPage?.id;
    let lookups = 0;
    for (const id of ids) {
      if (f.seeds.has(id) || id === page) continue;
      if (lookups >= LIMITS.lookups) {
        f.seeds.add(id);
        continue;
      }
      lookups++;
      const info = await this.lookup(id);
      if (info && WHOLE.has(info.type)) {
        f.above.add(id);
        continue;
      }
      f.seeds.add(id);
      if (!info) continue;
      for (const a of info.ids.slice(1)) f.above.add(a);
      if (REFLOW) for (const r of info.reflow) f.reflow.add(r);
    }
  }

  private async lookup(id: string): Promise<NodeInfo | null> {
    const get = this.api().getNodeByIdAsync;
    if (typeof get !== "function") return null;
    let node: unknown;
    try {
      node = await get.call(this.api(), id);
    } catch {
      return null;
    }
    const info = describe(node);
    if (info) remember(this.known, id, { ancestry: info.ids, name: info.name }, LIMITS.known);
    return info;
  }

  private view(id: string, at: number): void {
    const prev = this.views.get(id);
    if (prev !== undefined && prev >= at) return;
    remember(this.views, id, at, LIMITS.views);
  }

  /** The agent's view time for a node: the latest read or write of it or an ancestor. */
  viewedAt(ancestry: readonly string[]): number | undefined {
    let best: number | undefined;
    for (const id of ancestry) {
      const v = this.views.get(id);
      if (v !== undefined && (best === undefined || v > best)) best = v;
    }
    return best;
  }

  // ── what the agent has seen, by content (echo.ts) ─────────────────────────

  /**
   * What a write left behind, so its changes reported late match it. In full:
   * what it named and what it made, and everything under what it made (new
   * nodes, nobody else's yet). Their geometry: ancestors (a hugging parent
   * resizes) and the children of each direct parent and auto-layout ancestor
   * (siblings reflow, indices shift). Under what it named, their geometry and
   * bound values (a mode set on a frame re-resolves its subtree), never their
   * raw content: a person's edit there that is reported late must still read
   * as the person's. Within LIMITS.record nodes, nearest first.
   */
  private async recordAfter(span: Span, result: StoredResult): Promise<void> {
    const f = span.footprint;
    if (!f) return;
    const ctx = newContext();
    const done = new Set<string>();
    let left = LIMITS.record;
    const take = (id: string, node: unknown, scope: Scope): boolean => {
      if (done.has(id) || left <= 0) return false;
      done.add(id);
      left--;
      this.note(id, node, scope, ctx);
      return true;
    };
    const targets = new Set(targetsOf(span.op, span.params));
    const written = new Set<string>();
    idsIn(result.ok ? result.data : result.partial, WRITTEN_KEY, written);
    for (const id of span.touched) written.add(id);
    const queue: Array<[unknown, Scope]> = [];
    const parents = new Set<string>(f.reflow);
    for (const id of new Set([...targets, ...written])) {
      if (left <= 0) break;
      const node = await this.nodeById(id);
      if (!take(id, node, "full") || !node) continue;
      const parent = field(node, "parent");
      const pid = parent ? field(parent, "id") : undefined;
      if (typeof pid === "string") parents.add(pid);
      for (const kid of childrenOf(node as NodeLike) ?? []) queue.push([kid, targets.has(id) ? "binding" : "full"]);
    }
    const page = this.api().currentPage?.id;
    for (const id of f.above) {
      if (left <= 0) break;
      if (id === page || done.has(id)) continue;
      const node = await this.nodeById(id);
      if (node && !WHOLE.has(String(field(node, "type") ?? ""))) take(id, node, "geometry");
    }
    for (const id of parents) {
      if (left <= 0) break;
      if (id === page) continue;
      const parent = await this.nodeById(id);
      if (!parent || WHOLE.has(String(field(parent, "type") ?? ""))) continue;
      const kids = childrenOf(parent as NodeLike) ?? [];
      if (kids.length > LIMITS.siblings) continue;
      for (const kid of kids) {
        const kidId = field(kid, "id");
        if (typeof kidId === "string") take(kidId, kid, "geometry");
      }
    }
    for (let i = 0; i < queue.length && left > 0; i++) {
      const [node, scope] = queue[i]!;
      const id = field(node, "id");
      if (typeof id !== "string" || !take(id, node, scope)) continue;
      for (const kid of childrenOf(node as NodeLike) ?? []) queue.push([kid, scope]);
    }
  }

  /** What a read returned: its roots and what is under them, breadth first, within LIMITS.readRecord nodes. */
  private async recordRead(roots: readonly string[]): Promise<void> {
    const ctx = newContext();
    const done = new Set<string>();
    const queue: unknown[] = [];
    for (const id of roots) {
      const node = await this.nodeById(id);
      if (node) queue.push(node);
    }
    for (let i = 0; i < queue.length && done.size < LIMITS.readRecord; i++) {
      const node = queue[i];
      const id = field(node, "id");
      if (typeof id !== "string" || done.has(id)) continue;
      done.add(id);
      this.note(id, node, "full", ctx);
      for (const kid of childrenOf(node as NodeLike) ?? []) queue.push(kid);
    }
  }

  // ── the resource watch: variables and styles ──────────────────────────────

  /**
   * Read the variables and styles now; whatever differs from what the agent
   * last knew changed without it, and is kept, stamped `stamp`. Null when this
   * editor has no variables or styles API.
   */
  private async checkResources(stamp: number): Promise<Resources | null> {
    let now: Resources | null = null;
    try {
      now = await readResources(this.api());
    } catch {
      return null;
    }
    if (!now) return null;
    if (this.expected) {
      const changed = changedBetween(this.expected, now);
      for (const c of changed) this.resourceChanges.push({ ...c, at: stamp });
      if (this.resourceChanges.length > LIMITS.resourceChanges) this.resourceChanges.splice(0, this.resourceChanges.length - LIMITS.resourceChanges);
      // Someone else moved them: a re-colouring through them is no longer the agent's.
      for (const id of dependentsOf(changed.map((c) => c.id), now)) this.affected.delete(id);
    }
    this.expected = now;
    return now;
  }

  /** A variable or style write ended: what it changed, and all that resolves through it, is the agent's. */
  private async resourcesAfter(before: Resources | null): Promise<void> {
    let after: Resources | null = null;
    try {
      after = await readResources(this.api());
    } catch {
      return;
    }
    if (!after) return;
    if (before) {
      for (const id of dependentsOf(changedBetween(before, after).map((c) => c.id), after)) {
        this.affected.delete(id);
        this.affected.add(id);
      }
      while (this.affected.size > LIMITS.affected) {
        const oldest = this.affected.values().next();
        if (oldest.done) break;
        this.affected.delete(oldest.value);
      }
    }
    this.expected = after;
  }

  /** Footprints nothing can still fall into: ended past their window, before the oldest held change. */
  private prune(): void {
    const horizon = this.pending.length ? this.pending[0]!.at : this.now();
    this.footprints = this.footprints.filter((f) => f.until >= horizon);
    while (this.footprints.length > LIMITS.footprints) this.footprints.shift();
  }

  /** The running op (rollback) is about to undo: every LOCAL change from now is the agent's. */
  private coverAll(): void {
    const f = this.open(this.now(), { all: true, pages: false });
    if (this.current && !this.current.footprint) this.current.footprint = f;
    else if (!this.current) f.until = this.now() + SETTLE_MS;
  }

  // ── what the ops read ─────────────────────────────────────────────────────

  /** People's and collaborators' changes since `since`, oldest first. */
  private foreignSince(since: number): ChangeRecord[] {
    const out: ChangeRecord[] = [];
    for (const r of this.foreign.values()) if (r.at >= since) out.push(r);
    return out.sort((a, b) => a.at - b.at);
  }

  changes(since = 0) {
    const recs = this.foreignSince(since);
    const conflicts: Conflict[] = [];
    for (const r of recs) {
      const viewedAt = this.viewedAt(r.ancestry);
      if (viewedAt !== undefined && r.at > viewedAt) conflicts.push({ nodeId: r.nodeId, name: r.name, by: r.by, at: r.at, viewedAt });
    }
    return {
      watchedPageId: this.api().currentPage?.id ?? null,
      commits: this.commitCount,
      conflicts: conflicts.slice(-LIMITS.listed),
      changes: recs.slice(-LIMITS.listed).map(({ nodeId, name, by, at }) => ({ nodeId, name, by, at })),
      pageSwitches: this.pages.filter((s) => s.at >= since).map(({ at, pageId, by }) => ({ at, pageId, by })),
    };
  }

  /**
   * The commit count, the time and the page. The variables and styles are
   * read too: a change to them found now happened before the savepoint, so it
   * is stamped just before it and never blocks a rollback to it.
   */
  async savepoint() {
    const at = this.now();
    await this.checkResources(at - 1);
    return { commits: this.commitCount, at, pageId: this.api().currentPage?.id ?? null };
  }

  /** Why a rollback to (commits, sinceMs) is not safe, or null when it is. */
  private blockers(commits: number, sinceMs: number, agent: string | undefined) {
    const reasons: string[] = [];
    // Another agent's calls since: an undo cannot skip them. Without an agent
    // of its own (an older server) a rollback refuses only when the calls
    // since carry two different agents: it cannot tell which one it is.
    const since = this.commitLog.filter((c) => c.n > commits);
    const agents = unique(since.map((c) => c.agent).filter((a): a is string => a !== undefined));
    const theirs = agent !== undefined ? since.filter((c) => c.agent !== agent) : agents.length >= 2 ? since.filter((c) => c.agent !== undefined) : [];
    if (theirs.length) {
      const tools = unique(theirs.map((c) => toolName(c.op)));
      reasons.push(
        `another agent sharing this plugin made ${theirs.length} tool call(s) (${tools.slice(0, 3).join(", ")}${tools.length > 3 ? ", …" : ""}); ` +
          "an undo cannot skip them",
      );
    }
    const others: Changed[] = theirs.flatMap((c) =>
      (c.ids.length ? c.ids : [""]).map((id) => ({
        nodeId: id,
        name: (id && this.known.get(id)?.name) || "",
        by: "another agent" as const,
        at: c.at,
        op: toolName(c.op),
      })),
    );
    const changed = this.foreignSince(sinceMs);
    if (changed.length) {
      for (const by of ["person", "collaborator"] as const) {
        const mine = changed.filter((c) => c.by === by);
        if (!mine.length) continue;
        const names = unique(mine.map((c) => `"${c.name || c.nodeId}"`));
        reasons.push(
          `${by === "person" ? "you" : "a collaborator"} changed ${mine.length} layer(s) on this page (${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}); ` +
            "Figma's undo would take those edits back too",
        );
      }
    } else if (this.lastForeign && this.lastForeign.at >= sinceMs) {
      reasons.push("someone else changed layers on this page; Figma's undo would take those edits back too");
    }
    // Variables and styles: a re-colouring they cause is not a layer change, so they are watched themselves.
    const resources = this.resourceChanges.filter((r) => r.at > sinceMs);
    if (resources.length) {
      const names = unique(resources.map((r) => `"${r.name || r.id}"`));
      reasons.push(
        `someone other than the agent changed ${resources.length} variable(s), collection(s) or style(s) (${names.slice(0, 3).join(", ")}` +
          `${names.length > 3 ? ", …" : ""}); Figma's undo would take those edits back too`,
      );
    }
    const switched = this.pages.filter((s) => s.at >= sinceMs && s.by === "person");
    if (switched.length) {
      const to = switched[switched.length - 1]!;
      reasons.push(`the page was switched by you (to "${to.name || to.pageId}"), so an undo could reach a page the plugin cannot watch`);
    }
    if (this.undoStepAt >= sinceMs) reasons.push("figma_undo_step ran since, so the plugin can no longer count what is left to undo");
    if (sinceMs < this.startedAt) {
      reasons.push("the plugin was closed and run again since, so it cannot tell what happened before it started");
    } else if (commits > this.commitCount) {
      reasons.push("a rollback since already took back the steps after it, and more");
    } else if (this.commitLog.length && commits < this.commitLog[0]!.n - 1) {
      reasons.push(`more than ${LIMITS.commits} tool calls ran since, more than the plugin keeps count of`);
    }
    if (!reasons.length) return null;
    const people: Changed[] = changed.map(({ nodeId, name, by, at }) => ({ nodeId, name, by, at }));
    const held: Changed[] = resources.map(({ id, name, at }) => ({ nodeId: id, name, by: "someone else" as const, at }));
    return { reasons, changed: people.concat(others, held).sort((a, b) => a.at - b.at).slice(-LIMITS.listed) };
  }

  /** figma_rollback in the plugin (spec §2.5): refuse when unsafe, else undo the agent's steps and verify. */
  async rollback(params: Record<string, unknown>) {
    const p = await beforeMutating(() => rollbackParams(params));
    // A person's edit made just before this call may not be reported yet
    // [C-394]: give late events one settle window before judging.
    if (this.delay) await this.delay(SETTLE_MS);
    // A variable or style changed since the agent last looked is no layer event: read them.
    await this.checkResources(this.now());
    // The rollback's own agent: its request's guard, read at begin.
    const blocked = this.blockers(p.commits, p.sinceMs, this.current?.agent);
    if (blocked) {
      const shown = p.createdIds.slice(0, 20).map((id) => `"${id}"`).join(", ");
      throw new BridgeError(
        ErrorCode.ROLLBACK_BLOCKED,
        `figma_rollback was refused before any undo: since the savepoint (${clock(p.sinceMs)}) ${blocked.reasons.join("; ")}.`,
        {
          hint: p.createdIds.length
            ? `Nothing was undone. To remove only what the agent created since the savepoint, call figma_delete_nodes { nodeIds: [${shown}${p.createdIds.length > 20 ? ", …" : ""}] } ` +
              "(every id is in partial.safe): it touches nobody's edits. The agent's edits to existing layers stay; list them for the person (figma_get_changes)."
            : "Nothing was undone, and the agent created no layers since the savepoint. Its edits to existing layers stay; list them for the person " +
              "(figma_get_changes) and revert them with targeted writes if they ask.",
          partial: { created: [], changed: blocked.changed, safe: p.createdIds },
        },
      );
    }
    const steps = this.commitLog.filter((c) => c.n > p.commits && c.step).length;
    const api = this.api();
    if (steps > 0 && typeof api.triggerUndo !== "function") {
      throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot undo.", { partial: { created: [] } });
    }
    this.coverAll();
    let undone = 0;
    try {
      for (; undone < steps; undone++) {
        api.triggerUndo!.call(api);
        this.commitCount--;
      }
    } catch (err) {
      throw new BridgeError(ErrorCode.INTERNAL, `Undo ${undone + 1} of ${steps} failed: ${err instanceof Error ? err.message : String(err)}`, {
        hint: `${undone} step(s) were undone before it. Read the page again (figma_get_changes, figma_get_design_context) before anything else.`,
        partial: { undone },
      });
    }
    // The steps since the savepoint are gone, the uncounted ones with them.
    const undoneIds = unique(this.commitLog.filter((c) => c.n > p.commits).flatMap((c) => c.ids));
    this.commitLog = this.commitLog.filter((c) => c.n <= p.commits);
    this.commitCount = p.commits;
    // What the undos left is the agent's doing: its late echoes must match it, not the undone writes.
    for (const id of undoneIds.slice(0, LIMITS.record)) this.note(id, await this.nodeById(id), "full");
    this.expected = (await readResources(api).catch(() => null)) ?? this.expected;
    const stillThere: string[] = [];
    const get = api.getNodeByIdAsync;
    for (const id of p.createdIds) {
      let node: unknown = null;
      try {
        node = typeof get === "function" ? await get.call(api, id) : null;
      } catch {
        node = null;
      }
      if (node && field(node, "removed") !== true) stillThere.push(id);
    }
    return { undone, verified: stillThere.length === 0, stillThere };
  }
}

function covers(f: Footprint, raw: Raw): boolean {
  if (f.all || f.above.has(raw.id)) return true;
  for (const id of raw.ancestry) if (f.seeds.has(id) || f.reflow.has(id)) return true;
  return false;
}

function rollbackParams(params: Record<string, unknown>): { commits: number; sinceMs: number; createdIds: string[] } {
  const { commits, sinceMs, createdIds } = params;
  if (typeof commits !== "number" || !Number.isInteger(commits) || commits < 0) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "`commits` must be the savepoint's commit count: a whole number, 0 or more.");
  }
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs) || sinceMs < 0) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "`sinceMs` must be the savepoint's time (`at`, epoch ms).");
  }
  if (createdIds !== undefined && (!Array.isArray(createdIds) || createdIds.some((id) => typeof id !== "string"))) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "`createdIds` must list the node ids created since the savepoint.");
  }
  return { commits, sinceMs, createdIds: unique((createdIds as string[] | undefined) ?? []) };
}

/** An op's result with the conflicts it ran over (`warn`, or `force`): an object gains the key, anything else is wrapped. */
export function withConflicts(data: unknown, conflicts: readonly Conflict[]): unknown {
  if (!conflicts.length) return data;
  return isObject(data) ? { ...data, conflicts } : { result: data, conflicts };
}

// ── the ops ─────────────────────────────────────────────────────────────────

/**
 * get_changes (read), savepoint and rollback (style). savepoint writes
 * nothing to the document and rollback must not commit an undo step after its
 * undos, so neither is a write for the dispatcher — as figma_undo_step.
 */
export function trustOps(trust: Trust): Record<string, PluginOp> {
  return {
    get_changes: {
      write: false,
      async run(ctx: OpContext) {
        const since = ctx.params.sinceMs;
        if (since !== undefined && (typeof since !== "number" || !Number.isFinite(since) || since < 0)) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, "`sinceMs` must be a time in epoch ms (a savepoint's `at`).");
        }
        return trust.changes((since as number | undefined) ?? 0);
      },
    },
    savepoint: {
      write: false,
      async run() {
        return trust.savepoint();
      },
    },
    rollback: {
      write: false,
      async run(ctx: OpContext) {
        return trust.rollback(ctx.params);
      },
    },
  };
}

/** The plugin's one tracker: code.ts feeds it, and these ops read it. */
export const TRUST = new Trust();
export const TRUST_OPS = trustOps(TRUST);
