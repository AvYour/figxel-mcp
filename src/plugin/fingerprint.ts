// A deliverable's content fingerprint: what a sign-off records, and what a
// final export compares with it (roles spec §3.2, §3.7). Unlike the motion
// gate's in-process write counters it lives in the file, so it survives
// sessions and sees edits made by hand.
//
// A 32-bit FNV-1a hash over the subtree in walk order (pre-order, children in
// layer order), each node contributing the members the spec lists: id, type,
// visible, x / y / width / height rounded to 0.5 px, its text and the font
// family / style / size of each run, solid fill and stroke hex with opacity,
// stroke weight, corner radius, the effects count, layout mode, gap and
// padding, and image hashes. Its child count goes in too, so moving a layer
// from inside a frame to beside it is a change even when the order is not.
//
// Two decisions the spec leaves open:
//  - The root's own x / y are left out: moving the deliverable on the canvas
//    does not change what it exports, and a re-sign-off for tidying the page
//    would teach the user to ignore the gate.
//  - A node carrying a brief record is skipped with its subtree — the brief
//    block is a working note, and its status line changes at sign-off — but
//    never the root: a brief stored on the deliverable itself (`nodeId`, or the
//    page of a deck) must not blank out the whole fingerprint.
//
// Computed-only members (absoluteBoundingBox, absoluteRenderBounds,
// absoluteTransform) are never read: they follow from the ones that are, and
// plugin data is not content. Every read goes through `field`, so a FigJam or
// Slides node that throws on a member it lacks reads as absent [C-145].

import { BRIEF_KEY, BRIEF_NAMESPACE } from "../shared/roles.js";
import { OPAQUE_TYPES, childrenOf, field, heldText, type NodeLike } from "./board-read.js";

type Any = Record<string, unknown>;
type Rgb = { r: number; g: number; b: number };

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Separators no member value contains in practice: between fields, and after each node. */
const FIELD = "\u001f";
const NODE = "\u001e";

/** FNV-1a over the UTF-8 bytes of what is fed in, so the same text hashes the same in every engine. */
function fnv1a() {
  let h = FNV_OFFSET;
  const byte = (b: number) => {
    h ^= b;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  };
  return {
    add(s: string): void {
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        // A surrogate pair is one code point: four bytes, not two threes.
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
          const lo = s.charCodeAt(i + 1);
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
            i++;
          }
        }
        if (c < 0x80) byte(c);
        else if (c < 0x800) {
          byte(0xc0 | (c >> 6));
          byte(0x80 | (c & 63));
        } else if (c < 0x10000) {
          byte(0xe0 | (c >> 12));
          byte(0x80 | ((c >> 6) & 63));
          byte(0x80 | (c & 63));
        } else {
          byte(0xf0 | (c >> 18));
          byte(0x80 | ((c >> 12) & 63));
          byte(0x80 | ((c >> 6) & 63));
          byte(0x80 | (c & 63));
        }
      }
    },
    hex(): string {
      return ("00000000" + h.toString(16)).slice(-8);
    },
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Positions and sizes at 0.5 px: sub-pixel noise from centring is not an edit. */
const half = (v: unknown) => (isNum(v) ? String(Math.round(v * 2) / 2) : "");
const fixed = (v: unknown, places: number) => (isNum(v) ? String(Math.round(v * 10 ** places) / 10 ** places) : "");
/** A number, "mixed" for figma.mixed (a symbol), or nothing. */
const numOrMixed = (v: unknown, places = 2) => (typeof v === "symbol" ? "mixed" : fixed(v, places));

function hexOf(c: unknown): string {
  const rgb = c as Partial<Rgb> | undefined;
  if (!rgb || !isNum(rgb.r) || !isNum(rgb.g) || !isNum(rgb.b)) return "";
  const h = (v: number) => ("0" + Math.round(v * 255).toString(16)).slice(-2);
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

/** One paint: its type and visibility, then what the spec asks of it (solid colour and opacity, image hash). */
function paintKey(p: unknown): string {
  const paint = (p ?? {}) as Any;
  const head = `${String(paint.type)}:${paint.visible === false ? 0 : 1}:${fixed(paint.opacity ?? 1, 3)}`;
  switch (paint.type) {
    case "SOLID":
      return `${head}:${hexOf(paint.color)}`;
    case "IMAGE":
      return `${head}:${String(paint.imageHash ?? "")}:${String(paint.scaleMode ?? "")}`;
    case "VIDEO":
      return `${head}:${String(paint.videoHash ?? "")}`;
    default: {
      // A gradient: its stops, so a recoloured gradient is an edit like a recoloured fill.
      const stops = Array.isArray(paint.gradientStops) ? (paint.gradientStops as Any[]) : [];
      return `${head}:${stops.map((s) => `${hexOf(s.color)}/${fixed((s.color as Any | undefined)?.a, 3)}@${fixed(s.position, 3)}`).join(",")}`;
    }
  }
}

function paintsKey(list: unknown): string {
  if (typeof list === "symbol") return "mixed";
  return Array.isArray(list) ? list.map(paintKey).join(";") : "";
}

/** The font family / style / size of each run, with its length; the node's own font when it has no runs to give. */
function runsKey(n: NodeLike): string {
  const seg = field<(fields: string[]) => Array<Any>>(n, "getStyledTextSegments");
  if (typeof seg === "function") {
    try {
      return seg
        .call(n, ["fontName", "fontSize"])
        .map((s) => {
          const f = (s.fontName ?? {}) as Any;
          const len = isNum(s.end) && isNum(s.start) ? s.end - s.start : "";
          return `${String(f.family ?? "")}/${String(f.style ?? "")}/${fixed(s.fontSize, 2)}*${len}`;
        })
        .join(",");
    } catch {
      /* a text whose runs cannot be read: its own font below */
    }
  }
  const font = field<Any | symbol>(n, "fontName");
  const name = typeof font === "symbol" ? "mixed" : font ? `${String(font.family ?? "")}/${String(font.style ?? "")}` : "";
  return `${name}/${numOrMixed(field(n, "fontSize"))}`;
}

function radiusKey(n: NodeLike): string {
  const r = field(n, "cornerRadius");
  if (typeof r !== "symbol") return fixed(r, 2);
  return ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"].map((k) => fixed(field(n, k), 2)).join("/");
}

function strokeWeightKey(n: NodeLike): string {
  const w = field(n, "strokeWeight");
  if (typeof w !== "symbol") return fixed(w, 2);
  return ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"].map((k) => fixed(field(n, k), 2)).join("/");
}

/** True when the node carries a brief record (the block, or a node a brief was stored on). */
export function carriesBrief(n: NodeLike): boolean {
  const get = field<(ns: string, key: string) => string>(n, "getSharedPluginData");
  if (typeof get !== "function") return false;
  try {
    return !!get.call(n, BRIEF_NAMESPACE, BRIEF_KEY);
  } catch {
    return false;
  }
}

/** One node's contribution, in a fixed order. */
function nodeKey(n: NodeLike, isRoot: boolean, kids: number): string {
  const opaque = OPAQUE_TYPES.has(n.type);
  const parts: string[] = [
    n.id,
    n.type,
    field(n, "visible") === false ? "0" : "1",
    isRoot ? "" : half(field(n, "x")),
    isRoot ? "" : half(field(n, "y")),
    half(field(n, "width")),
    half(field(n, "height")),
    String(kids),
  ];
  // A slide grid or row has no paint or layout, and reading one throws [C-136].
  if (!opaque) {
    const effects = field(n, "effects");
    parts.push(
      heldText(n) ?? "",
      n.type === "TEXT" ? runsKey(n) : "",
      paintsKey(field(n, "fills")),
      paintsKey(field(n, "strokes")),
      strokeWeightKey(n),
      radiusKey(n),
      String(Array.isArray(effects) ? effects.length : 0),
      String(field(n, "layoutMode") ?? ""),
      fixed(field(n, "itemSpacing"), 2),
      ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((k) => fixed(field(n, k), 2)).join("/"),
    );
  }
  return parts.join(FIELD) + NODE;
}

export interface FingerprintOptions {
  /** Give the editor a turn every so many nodes (check.ts's walk does the same). */
  yieldToHost?: () => Promise<void>;
  yieldEvery?: number;
}

/**
 * The fingerprint of `root`'s subtree: 8 lowercase hex digits. The same for
 * an unchanged subtree, different after any edit of a member listed above.
 */
export async function fingerprint(root: NodeLike, opts: FingerprintOptions = {}): Promise<string> {
  const hash = fnv1a();
  const every = opts.yieldEvery ?? 500;
  const stack: NodeLike[] = [root];
  let seen = 0;
  while (stack.length) {
    const n = stack.pop()!;
    // Filtered before they are counted, so adding or deleting a brief block
    // inside a deliverable (a section) does not change it either.
    const kids = (childrenOf(n) ?? []).filter((k) => !carriesBrief(k));
    hash.add(nodeKey(n, n === root, kids.length));
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    if (opts.yieldToHost && ++seen % every === 0) await opts.yieldToHost();
  }
  return hash.hex();
}
