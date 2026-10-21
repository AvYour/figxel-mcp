// Tells while building (role quality plan W3): what figma_create_from_spec
// just built, measured for the generated look before the next section is
// stacked on it. At the page and top gears, with a brief in force, the server
// asks for it (`tells: { briefId }`, src/server/tools/create.ts) and the
// create's result carries a short summary: the tells kinds found in the new
// subtree with their counts, and each finding of a kind the brief avoids,
// which figma_check_layout reports as a warning and sign-off will not pass.
//
// Cheap: one census of the subtree just built, capped in layers, with the
// tells audit only. It never fails the build: when it cannot run, the result
// says why in one line (`tellsSkipped`) and the build stands as it is.

import { boundKinds } from "../shared/avoid.js";
import { BRIEF_KEY, BRIEF_NAMESPACE, parseBrief, type BriefRecord } from "../shared/roles.js";
import { isTellKind } from "../shared/tells-kinds.js";
import { field } from "./board-read.js";
import { checkLayout, type AuditKind, type Issue } from "./ops/check.js";
import type { OpContext } from "./ops/index.js";
import type { NodeLike } from "./read.js";

/** Layers measured at most, kinds and avoided findings listed at most. */
export const BUILD_TELLS = { nodes: 1500, kinds: 12, avoided: 10 } as const;

/**
 * No key here names a node but `avoided[].nodeId`, a layer just built: the
 * trust layer reads the ids a write returns as what it made (trust.ts
 * RESULT_ID_KEY), so the brief's own id is not echoed.
 */
export interface BuildTells {
  /** Layers measured. */
  checked: number;
  /** The layer cap stopped the census: what is past it is unmeasured. */
  truncated?: true;
  /** The tells kinds found, most frequent first. */
  kinds: Array<{ kind: string; count: number }>;
  moreKinds?: number;
  /** Each finding of a kind the brief avoids: a warning in figma_check_layout. */
  avoided: Array<{ kind: string; nodeId: string; name: string; detail: string }>;
  moreAvoided?: number;
}

export type BuildTellsResult = { tells: BuildTells } | { tellsSkipped: string };

/** The brief id of a create call's `tells: { briefId }`, or undefined when the server asked for none. */
export function tellsAsked(params: Record<string, unknown>): string | undefined {
  const t = params.tells;
  if (typeof t !== "object" || t === null) return undefined;
  const id = (t as { briefId?: unknown }).briefId;
  return typeof id === "string" && id ? id : undefined;
}

type Figma = { getNodeByIdAsync(id: string): Promise<unknown> };

async function briefAt(figma: Figma, id: string): Promise<BriefRecord | string> {
  const holder = await figma.getNodeByIdAsync(id);
  if (!holder) return `no node has the brief's id ${id}`;
  const get = field<(ns: string, key: string) => string>(holder, "getSharedPluginData");
  let raw = "";
  try {
    raw = typeof get === "function" ? String(get.call(holder, BRIEF_NAMESPACE, BRIEF_KEY) ?? "") : "";
  } catch {
    raw = "";
  }
  if (!raw) return `${id} carries no brief`;
  const parsed = parseBrief(raw);
  return "brief" in parsed ? parsed.brief : `the brief on ${id} cannot be read (${parsed.invalid})`;
}

/** The tells of the roots a create call built, against the brief `briefId`. Never throws. */
export async function buildTells(
  figma: Figma,
  rootIds: ReadonlyArray<string | undefined>,
  briefId: string,
  ctx: Pick<OpContext, "yieldToHost" | "isCancelled">,
): Promise<BuildTellsResult> {
  const skipped = (why: string): BuildTellsResult => ({
    tellsSkipped: `The tells of what was built were not measured: ${why.replace(/[.\s]+$/, "")}. figma_check_layout { nodeId, audit: ["tells"] } measures them.`,
  });
  try {
    const brief = await briefAt(figma, briefId);
    if (typeof brief === "string") return skipped(brief);
    const audit = new Set<AuditKind>(["tells"]);
    const found: Issue[] = [];
    let checked = 0;
    let truncated = false;
    for (const id of rootIds) {
      if (typeof id !== "string") continue;
      const budget = BUILD_TELLS.nodes - checked;
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const root = (await figma.getNodeByIdAsync(id)) as NodeLike | null;
      if (!root) continue;
      const r = await checkLayout(root, budget, ctx, { audit, brief });
      checked += r.checked;
      truncated ||= r.truncated;
      for (const i of r.issues) if (isTellKind(i.kind)) found.push(i);
    }
    if (ctx.isCancelled()) return skipped("the call was cancelled");
    const counts = new Map<string, number>();
    for (const i of found) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
    const kinds = [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    const bound = boundKinds(brief);
    const avoided = found.filter((i) => bound.indexOf(i.kind) >= 0).map((i) => ({ kind: i.kind, nodeId: i.nodeId, name: i.name, detail: i.detail }));
    return {
      tells: {
        checked,
        ...(truncated ? { truncated: true as const } : {}),
        kinds: kinds.slice(0, BUILD_TELLS.kinds),
        ...(kinds.length > BUILD_TELLS.kinds ? { moreKinds: kinds.length - BUILD_TELLS.kinds } : {}),
        avoided: avoided.slice(0, BUILD_TELLS.avoided),
        ...(avoided.length > BUILD_TELLS.avoided ? { moreAvoided: avoided.length - BUILD_TELLS.avoided } : {}),
      },
    };
  } catch (err) {
    return skipped(err instanceof Error ? err.message : String(err));
  }
}
