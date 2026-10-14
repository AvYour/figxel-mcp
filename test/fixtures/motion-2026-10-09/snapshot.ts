// The 2026-10-09 ad as figma_check_motion would read it, rebuilt from what the
// run recorded: three figma_get_motion_context snapshots and the build bible.
//
//   r0.json  the state the round-1 critics reviewed      (scratchpad motion/r1-work/mc-live.json)
//   r1.json  after the round-1 fixes, reviewed in round 2 (r1-work/mc-after.json)
//   r2.json  after the round-2 fixes, reviewed in round 3 (r2-work/mc-final.json)
//
// A motion-context snapshot lists only the animated layers, with no parents
// and no boxes. layers.json supplies both from the bible's layer tables (its
// `source` says how), and a layer the bible does not list joins the scene its
// name prefix names. Layers that carry no keys come from the bible alone, so
// masks, clipping and text are there for the rules that need them.

import { readFileSync } from "node:fs";
import type { MotionSnapshot, SnapshotNode, SnapshotTrack } from "../../../src/shared/motion-curves.js";

export const SNAPSHOTS = ["r0", "r1", "r2"] as const;
export type SnapshotName = (typeof SNAPSHOTS)[number];

interface Layer {
  name: string;
  type: string;
  parent: string | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  clipsContent?: boolean;
  strokeCap?: string;
  strokeWeight?: number;
  cornerRadius?: number;
  layoutMode?: string;
  characters?: string;
  fontSize?: number;
}

interface Sidecar {
  source: string;
  frame: { name: string; width: number; height: number };
  scenes: Record<string, string>;
  layers: Layer[];
}

interface ContextNode {
  nodeId: string;
  name: string;
  type: string;
  timeline: { id: string; durationS: number } | null;
  tracks: SnapshotTrack[];
}

const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as T;

export const FRAME_ID = "fixture:frame";

export function loadSnapshot(name: SnapshotName): MotionSnapshot {
  const side = read<Sidecar>("./layers.json");
  const context = read<{ nodes: ContextNode[] }>(`./${name}.json`).nodes;
  const animated = new Map(context.map((n) => [n.name, n]));
  const layers = new Map(side.layers.map((l) => [l.name, l]));
  for (const n of context) {
    if (layers.has(n.name)) continue;
    const scene = Object.entries(side.scenes).find(([prefix]) => n.name.startsWith(prefix))?.[1] ?? null;
    layers.set(n.name, { name: n.name, type: n.type, parent: scene });
  }
  const kids = new Map<string | null, string[]>();
  for (const l of layers.values()) kids.set(l.parent, [...(kids.get(l.parent) ?? []), l.name]);
  const idOf = (layer: string) => animated.get(layer)?.nodeId ?? `bible:${layer}`;

  const nodes: SnapshotNode[] = [
    {
      id: FRAME_ID,
      name: side.frame.name,
      type: "FRAME",
      parentId: null,
      width: side.frame.width,
      height: side.frame.height,
      clipsContent: true,
      childCount: kids.get(null)?.length ?? 0,
    },
  ];
  // Parents before children, in the bible's z-order.
  const visit = (parent: string | null) => {
    for (const child of kids.get(parent) ?? []) {
      const l = layers.get(child)!;
      const c = animated.get(child);
      const { name: _n, parent: _p, type: _t, ...box } = l;
      nodes.push({
        id: idOf(child),
        name: child,
        type: c?.type ?? l.type,
        parentId: parent === null ? FRAME_ID : idOf(parent),
        ...box,
        ...((kids.get(child)?.length ?? 0) > 0 ? { childCount: kids.get(child)!.length } : {}),
        ...(c?.tracks.length ? { tracks: c.tracks } : {}),
      });
      visit(child);
    }
  };
  visit(null);
  const durationS = context.find((n) => n.timeline)?.timeline?.durationS ?? null;
  return { root: { id: FRAME_ID, name: side.frame.name, width: side.frame.width, height: side.frame.height, durationS }, nodes, truncated: false, maxNodes: 2000 };
}
