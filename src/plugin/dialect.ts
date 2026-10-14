// The value dialect every read speaks: how a colour, a paint, an effect, a
// line height or a letter spacing is written as a short string a designer (and
// a model) can read — "#1a2b3c 50%", "drop-shadow 0 4 12 0 #0000001a", "150%".
//
// One place, so a value reads the same wherever it shows up: design context,
// style values, variable values. Everything here is sync and takes plain
// values; looking up a variable's or a style's NAME is async and stays with
// the caller.
//
// Honesty rules (from read.ts): a value Figma reports as `mixed` is written as
// "mixed", never as one of its parts, and a paint that is not solid is
// described, not approximated into a hex.

import { transformAngle, transformCenter, type Transform } from "./gradient.js";

type Any = Record<string, unknown>;

export const r2 = (v: number) => Math.round(v * 100) / 100;
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
export const isMixed = (v: unknown) => typeof v === "symbol";

export function hex(c: { r: number; g: number; b: number }, alpha = 1): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return alpha < 0.995 ? `${base} ${Math.round(alpha * 100)}%` : base;
}

export function describeValue(v: unknown): unknown {
  if (v && typeof v === "object" && "r" in (v as Any)) {
    const c = v as { r: number; g: number; b: number; a?: number };
    return hex(c, c.a ?? 1);
  }
  return v;
}

const pct = (v: number) => `${r2(v * 100)}%`;

/**
 * Where a gradient sits, in CSS words, from its transform and the node's box
 * [C-100]: a linear one by its angle ("180deg"), a radial or diamond one by its
 * centre ("at 25% 25%"), an angular one by both ("from 90deg at 50% 50%").
 * Empty when the paint carries no usable transform — nothing is guessed.
 */
function gradientPlacement(kind: string, t: unknown, width: number, height: number): string {
  if (!Array.isArray(t)) return "";
  const angle = transformAngle(t as Transform, width, height);
  const center = transformCenter(t as Transform);
  const at = center ? `at ${pct(center.x)} ${pct(center.y)}` : "";
  if (kind === "linear") return angle === undefined ? "" : `${r2(angle)}deg`;
  if (kind === "angular") return [angle === undefined ? "" : `from ${r2(angle)}deg`, at].filter(Boolean).join(" ");
  return at;
}

/** Image filters that are set, as "exposure 0.2 contrast -0.1"; empty when none is. */
function filtersText(f: unknown): string {
  if (!f || typeof f !== "object") return "";
  return Object.entries(f as Record<string, unknown>)
    .filter(([, v]) => typeof v === "number" && v !== 0)
    .map(([k, v]) => `${k} ${r2(v as number)}`)
    .join(" ");
}

/**
 * One paint as a designer would say it. `variable` is the NAME of the variable
 * bound to its colour, which the caller resolves (async). `width` / `height`
 * are the node's box: a gradient transform lives in the box's normalised space,
 * so its CSS angle depends on the box [C-100].
 *
 * An image is "image <scaleMode> <hash>" — the hash is what figma_download_assets
 * returns the original bytes for, and what a fill can reuse [C-093].
 */
export function paintText(p: Any, width = 1, height = 1, variable?: string): string {
  const op = num(p.opacity) ?? 1;
  let out: string;
  if (p.type === "SOLID") out = hex(p.color as { r: number; g: number; b: number }, op);
  else if (typeof p.type === "string" && p.type.startsWith("GRADIENT_")) {
    const kind = p.type.slice("GRADIENT_".length).toLowerCase();
    const stops = Array.isArray(p.gradientStops)
      ? (p.gradientStops as Array<{ position: number; color: { r: number; g: number; b: number; a: number } }>)
          .map((s) => `${hex(s.color, s.color.a)} ${Math.round(s.position * 100)}%`)
          .join(", ")
      : "";
    const where = gradientPlacement(kind, p.gradientTransform, width, height);
    out = `${kind}-gradient(${[where, stops].filter(Boolean).join(", ")})`;
    if (op < 0.995) out += ` ${Math.round(op * 100)}%`;
  } else if (p.type === "IMAGE") {
    const parts = ["image"];
    if (typeof p.scaleMode === "string") parts.push(p.scaleMode);
    if (typeof p.imageHash === "string" && p.imageHash) parts.push(p.imageHash);
    const rot = num(p.rotation);
    if (rot) parts.push(`rotation ${r2(rot)}`);
    const filters = filtersText(p.filters);
    if (filters) parts.push(`filters ${filters}`);
    if (op < 0.995) parts.push(`${Math.round(op * 100)}%`);
    out = parts.join(" ");
  } else out = String(p.type ?? "paint").toLowerCase();
  if (variable) out += ` (var: ${variable})`;
  if (p.visible === false) out += " (hidden)";
  return out;
}

const vec = (v: unknown) => {
  const o = (v ?? {}) as { x?: number; y?: number };
  return `${r2(num(o.x) ?? 0)},${r2(num(o.y) ?? 0)}`;
};

/**
 * One effect as a designer would say it. Shadows keep their long-standing
 * form; the newer kinds — progressive blur, noise, texture, glass [C-102] —
 * are written out field by field, so nothing a design sets is reduced to a
 * bare type name.
 */
export function effectText(e: Any): string {
  const vis = e.visible === false ? " (hidden)" : "";
  if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
    const o = (e.offset as { x: number; y: number }) ?? { x: 0, y: 0 };
    const c = e.color as { r: number; g: number; b: number; a: number };
    const kind = e.type === "DROP_SHADOW" ? "drop-shadow" : "inner-shadow";
    return `${kind} ${r2(o.x)} ${r2(o.y)} ${r2(num(e.radius) ?? 0)} ${r2(num(e.spread) ?? 0)} ${hex(c, c.a)}${vis}`;
  }
  if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
    const kind = e.type === "LAYER_BLUR" ? "blur" : "background-blur";
    if (e.blurType === "PROGRESSIVE") {
      return `${kind} progressive ${r2(num(e.startRadius) ?? 0)} to ${r2(num(e.radius) ?? 0)} from ${vec(e.startOffset)} to ${vec(e.endOffset)}${vis}`;
    }
    return `${kind} ${r2(num(e.radius) ?? 0)}${vis}`;
  }
  if (e.type === "NOISE") {
    const parts = ["noise", String(e.noiseType ?? "").toLowerCase()];
    const c = e.color as { r: number; g: number; b: number; a: number } | undefined;
    if (c) parts.push(hex(c, c.a));
    const second = e.secondaryColor as { r: number; g: number; b: number; a: number } | undefined;
    if (e.noiseType === "DUOTONE" && second) parts.push(hex(second, second.a));
    if (e.noiseType === "MULTITONE" && num(e.opacity) !== undefined) parts.push(`${Math.round(num(e.opacity)! * 100)}%`);
    parts.push(`size ${r2(num(e.noiseSize) ?? 0)}`, `density ${r2(num(e.density) ?? 0)}`);
    return `${parts.filter(Boolean).join(" ")}${vis}`;
  }
  if (e.type === "TEXTURE") {
    return `texture size ${r2(num(e.noiseSize) ?? 0)} radius ${r2(num(e.radius) ?? 0)}${e.clipToShape === true ? " clip" : ""}${vis}`;
  }
  if (e.type === "GLASS") {
    const f = (k: string) => r2(num(e[k]) ?? 0);
    return `glass light ${f("lightIntensity")} at ${f("lightAngle")}deg refraction ${f("refraction")} depth ${f("depth")} dispersion ${f("dispersion")} radius ${f("radius")}${vis}`;
  }
  return `${String(e.type).toLowerCase()}${vis}`;
}

/**
 * A layout grid as a designer reads it off the panel: "columns 12, gutter 24,
 * margin 64", "rows 4, gutter 16, section 80", "grid 8".
 */
export function layoutGridText(g: Any): string {
  const vis = g.visible === false ? " (hidden)" : "";
  if (g.pattern === "GRID") return `grid ${r2(num(g.sectionSize) ?? 0)}${vis}`;
  const count = g.count === Infinity ? "auto" : String(num(g.count) ?? "auto");
  const parts = [`${String(g.pattern ?? "").toLowerCase()} ${count}`, `gutter ${r2(num(g.gutterSize) ?? 0)}`];
  const align = typeof g.alignment === "string" ? g.alignment : "STRETCH";
  // Figma ignores the offset of a centred grid and the section size of a stretched one.
  if (align !== "CENTER" && num(g.offset) !== undefined) parts.push(`margin ${r2(num(g.offset)!)}`);
  if (align !== "STRETCH" && num(g.sectionSize) !== undefined) parts.push(`section ${r2(num(g.sectionSize)!)}`);
  if (align !== "STRETCH") parts.push(`align ${align.toLowerCase()}`);
  return `${parts.join(", ")}${vis}`;
}

/** Prototype scrolling as a designer says it ("vertical"); undefined when the frame does not scroll [C-117]. */
export function overflowText(v: unknown): string | undefined {
  return typeof v === "string" && v !== "NONE" ? v.toLowerCase() : undefined;
}

export function lineHeight(v: unknown): string | undefined {
  if (isMixed(v)) return "mixed";
  const lh = v as { unit?: string; value?: number } | undefined;
  if (!lh || lh.unit === "AUTO") return undefined;
  return lh.unit === "PERCENT" ? `${r2(lh.value ?? 0)}%` : `${r2(lh.value ?? 0)}px`;
}

export function letterSpacing(v: unknown): string | undefined {
  if (isMixed(v)) return "mixed";
  const ls = v as { unit?: string; value?: number } | undefined;
  if (!ls || !ls.value) return undefined;
  return ls.unit === "PERCENT" ? `${r2(ls.value)}%` : `${r2(ls.value)}px`;
}
