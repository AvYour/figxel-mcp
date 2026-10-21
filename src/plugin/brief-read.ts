// Reading the role process's records off the file (roles spec §3.2): a brief
// on the node it is stored on, the file's index of briefs, and the brief a
// node belongs to. figma_get_brief and figma_sign_off (ops/brief.ts) and
// figma_check_layout's default brief (ops/check.ts) read through here, so a
// node resolves to the same brief in all three.

import { BRIEF_INDEX_KEY, BRIEF_KEY, BRIEF_NAMESPACE, parseBrief, parseBriefIndex, type BriefIndexEntry, type BriefRecord } from "../shared/roles.js";
import { childrenOf, field } from "./board-read.js";
import type { NodeLike } from "./read.js";

/** What these reads need of `figma`: the document root and a lookup by id. */
export interface BriefFile {
  root: unknown;
  getNodeByIdAsync(id: string): Promise<unknown>;
}

/** The value of `key` in the records' namespace on `node`; "" when it holds none or cannot be read. */
export function readShared(node: unknown, key: string): string {
  const get = field<(ns: string, key: string) => string>(node, "getSharedPluginData");
  if (typeof get !== "function") return "";
  try {
    return String(get.call(node, BRIEF_NAMESPACE, key) ?? "");
  } catch {
    return "";
  }
}

/** The brief stored on `node`, or why it cannot be read; neither when it holds none. */
export function briefOn(node: NodeLike): { brief?: BriefRecord; invalid?: string } {
  const raw = readShared(node, BRIEF_KEY);
  if (!raw) return {};
  const parsed = parseBrief(raw);
  if ("invalid" in parsed) return { invalid: `"${node.name}" (${node.id}): ${parsed.invalid}` };
  // Duplicating a layer copies its plugin data: the copy is not the brief.
  if (parsed.brief.id !== node.id) return { invalid: `"${node.name}" (${node.id}) carries a copy of the brief stored on ${parsed.brief.id}` };
  return { brief: parsed.brief };
}

export function pageOf(node: NodeLike): NodeLike | null {
  let n: NodeLike | null | undefined = node;
  while (n && n.type !== "PAGE") n = field<NodeLike | null>(n, "parent");
  return n ?? null;
}

/**
 * The file's index: the root's, merged with any a page holds (where it went
 * when the root could not be written), one row per brief — the newest — and
 * newest first.
 */
export function fileIndex(figma: BriefFile): BriefIndexEntry[] {
  const rows = new Map<string, BriefIndexEntry>();
  const owners: unknown[] = [figma.root, ...(childrenOf(figma.root as NodeLike) ?? [])];
  for (const owner of owners) {
    for (const e of parseBriefIndex(readShared(owner, BRIEF_INDEX_KEY))) {
      const had = rows.get(e.id);
      if (!had || String(e.updatedAt) > String(had.updatedAt)) rows.set(e.id, e);
    }
  }
  return [...rows.values()].sort((a, b) => (String(a.updatedAt) < String(b.updatedAt) ? 1 : String(a.updatedAt) > String(b.updatedAt) ? -1 : 0));
}

/** The ancestors of `node` below its page, nearest first. */
function ancestorsOf(node: NodeLike): NodeLike[] {
  const out: NodeLike[] = [];
  for (let p = field<NodeLike | null>(node, "parent"); p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = field<NodeLike | null>(p, "parent")) out.push(p);
  return out;
}

/**
 * The brief whose work `node` is: its own record; else the nearest record
 * above it (its top-level frame's, or a section's it sits in); else a brief
 * whose deliverables list it or a frame around it. Not its page's brief: a
 * page holds where the work sits, not what it is (briefFor adds it).
 */
export async function workBriefOf(figma: BriefFile, node: NodeLike, index: readonly BriefIndexEntry[]): Promise<{ brief?: BriefRecord; invalid?: string }> {
  let firstInvalid: string | undefined;
  const above = ancestorsOf(node);
  for (const n of [node, ...above]) {
    const r = briefOn(n);
    if (r.brief) return r;
    firstInvalid ??= r.invalid;
  }
  const ids = [node.id, ...above.map((n) => n.id)];
  for (const e of index) {
    if (!e.deliverables.some((d) => ids.indexOf(d) >= 0)) continue;
    const holder = await figma.getNodeByIdAsync(e.id);
    const r = holder ? briefOn(holder as NodeLike) : {};
    if (r.brief) return r;
    firstInvalid ??= r.invalid;
  }
  return firstInvalid ? { invalid: firstInvalid } : {};
}

/**
 * The brief a node belongs to (contract § get_brief): the brief whose work it
 * is (workBriefOf), `from: "node"`; else its page's, `from: "page"`.
 */
export async function briefFor(
  figma: BriefFile,
  node: NodeLike,
  index: readonly BriefIndexEntry[],
): Promise<{ brief?: BriefRecord; from?: "node" | "page"; invalid?: string }> {
  const work = await workBriefOf(figma, node, index);
  if (work.brief) return { brief: work.brief, from: "node" };
  const page = pageOf(node);
  if (!page || page === node) return work;
  const r = briefOn(page);
  if (r.brief) return { brief: r.brief, from: "page" };
  const invalid = work.invalid ?? r.invalid;
  return invalid ? { invalid } : {};
}
