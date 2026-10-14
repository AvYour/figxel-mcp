// The style group (tools.md § style), Phase 2 subset: fills, strokes, corner
// radius — the three spec §12 lists for core write. Named styles, variable
// binding, effects and reactions follow in Phase 3.
//
// Same conventions as the modify group: per-item results (one node that cannot
// take a fill does not fail the batch), and the caller commits one undo step.
// Every op checks its parameters inside beforeMutating (guard.ts), so a refusal
// before the first write says it changed nothing; a node is checked for every
// property the call needs before any of them is written to it.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { OpContext, PluginOp } from "./index.js";
import { num, parseColor, type SolidPaint } from "../write.js";
import { requireIds, resolveAll, type ItemResult } from "./modify.js";
import { applyStyle, bindingFor, bindNodeField, findStyle, isStyleTarget, targetFor } from "../bind.js";
import { str } from "../read.js";
import { beforeMutating } from "../guard.js";
import { has } from "../safe.js";
import { linearTransform, radialTransform, transformFromList, type Transform } from "../gradient.js";

type Rgba = { r: number; g: number; b: number; a: number };

interface GradientPaint {
  type: "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND";
  gradientTransform: Transform;
  gradientStops: Array<{ position: number; color: Rgba }>;
  opacity?: number;
}

/** plugin-api.d.ts ImagePaint / ImageFilters [C-104]. */
interface ImagePaint {
  type: "IMAGE";
  imageHash: string;
  scaleMode: "FILL" | "FIT" | "CROP" | "TILE";
  rotation?: number;
  filters?: Record<string, number>;
  opacity?: number;
}

export type Paint = SolidPaint | GradientPaint | ImagePaint;

/** A paint not yet fitted to a node: gradients are drawn in the node's own box, so its size decides the transform. */
export type PaintFor = (width: number, height: number) => Paint;

const GRADIENT_TYPES: Record<string, GradientPaint["type"]> = {
  linear: "GRADIENT_LINEAR",
  radial: "GRADIENT_RADIAL",
  angular: "GRADIENT_ANGULAR",
  diamond: "GRADIENT_DIAMOND",
};

function unit(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be a number from 0 to 1.`);
  }
  return v;
}

function rgba(hex: unknown, field: string): Rgba {
  const p = parseColor(hex, field);
  return { ...p.color, a: p.opacity ?? 1 };
}

function plainObject(v: unknown, field: string, shape: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be an object ${shape}.`);
  return v as Record<string, unknown>;
}

/** A key nobody reads would be accepted and then dropped — the one thing tools.md § Conventions rules out. */
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const extra = Object.keys(o).filter((k) => o[k] !== undefined && !allowed.includes(k));
  if (extra.length) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` takes only ${allowed.map((k) => `\`${k}\``).join(", ")} (got ${extra.join(", ")}).`);
  }
}

/**
 * One gradient object → a paint for a node of a given size. Every check runs
 * here, before the first node is measured; only the transform waits for the
 * node, because the same angle needs a different matrix on a wide frame than
 * on a square one [C-100]. No angle is the identity — left → right, the one
 * transform measured on Figma's own export [C-057].
 */
function gradientFor(raw: unknown, field: string, opacity?: number): (w: number, h: number) => GradientPaint {
  const g = plainObject(raw, field, "{ type, stops, angle?, center?, radius?, transform? }");
  onlyKeys(g, ["type", "stops", "angle", "center", "radius", "transform"], field);
  const type = GRADIENT_TYPES[String(g.type)];
  if (!type) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.type\` must be linear, radial, angular or diamond.`);
  if (!Array.isArray(g.stops) || g.stops.length < 2) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.stops\` needs at least two { position, color } stops.`);
  }
  const gradientStops = g.stops.map((s: unknown, k: number) => {
    const at = `${field}.stops[${k}]`;
    const stop = plainObject(s, at, "{ position, color }");
    onlyKeys(stop, ["position", "color"], at);
    return { position: unit(stop.position, `${at}.position`), color: rgba(stop.color, `${at}.color`) };
  });
  const paint = (gradientTransform: Transform): GradientPaint => {
    const p: GradientPaint = { type, gradientTransform, gradientStops };
    if (opacity !== undefined && opacity !== 1) p.opacity = opacity;
    return p;
  };
  const given = (k: string) => g[k] !== undefined;

  if (given("transform")) {
    const clash = ["angle", "center", "radius"].filter(given);
    if (clash.length) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.transform\` is the whole matrix — give it alone, without \`${clash.join("`, `")}\`.`);
    }
    const t = transformFromList(g.transform, `${field}.transform`);
    return () => paint(t);
  }
  if (type === "GRADIENT_LINEAR") {
    const misplaced = ["center", "radius"].filter(given);
    if (misplaced.length) {
      // Each key names its own owners: an angular gradient takes a centre but refuses a radius (below).
      const owners = misplaced[0] === "center" ? "radial, angular and diamond" : "radial and diamond";
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.${misplaced[0]}\` is for ${owners} gradients; a linear one takes \`angle\`.`);
    }
    if (given("angle") && (typeof g.angle !== "number" || !Number.isFinite(g.angle))) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.angle\` must be a number of degrees (90 = left → right, 180 = top → bottom).`);
    }
    const angle = given("angle") ? (g.angle as number) : 90;
    return (w, h) => paint(linearTransform(angle, w, h));
  }
  if (given("angle")) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.angle\` is for linear gradients; turn a ${g.type} one with \`transform\`.`);
  }
  if (type === "GRADIENT_ANGULAR" && given("radius")) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.radius\` is for radial and diamond gradients; an angular one sweeps the whole node.`);
  }
  let center = { x: 0.5, y: 0.5 };
  if (given("center")) {
    const c = plainObject(g.center, `${field}.center`, "{ x, y }");
    onlyKeys(c, ["x", "y"], `${field}.center`);
    center = { x: unit(c.x, `${field}.center.x`), y: unit(c.y, `${field}.center.y`) };
  }
  let radius = 0.5;
  if (given("radius")) {
    radius = unit(g.radius, `${field}.radius`);
    if (radius === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.radius\` must be greater than 0.`);
  }
  // An angular gradient keeps the identity's scale: only its centre moves.
  return (w, h) => paint(radialTransform(center, type === "GRADIENT_ANGULAR" ? 0.5 : radius, w, h));
}

const SCALE_MODES: Record<string, ImagePaint["scaleMode"]> = { fill: "FILL", fit: "FIT", crop: "CROP", tile: "TILE" };
const IMAGE_FILTERS = ["exposure", "contrast", "saturation", "temperature", "tint", "highlights", "shadows"] as const;

/**
 * An image already in the file, reused by its hash [C-104]. The hash is looked
 * up before any node changes: Figma would otherwise take an unknown hash and
 * paint nothing, which reads as success.
 */
function imageFor(raw: unknown, field: string, opacity?: number): ImagePaint {
  const im = plainObject(raw, field, "{ hash, scaleMode?, rotation?, filters? }");
  onlyKeys(im, ["hash", "scaleMode", "rotation", "filters"], field);
  const hash = typeof im.hash === "string" ? im.hash.trim() : "";
  if (!hash) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.hash\` is required: the imageHash of an image already in the file.`);
  const figma = (globalThis as unknown as { figma?: { getImageByHash?(hash: string): unknown } }).figma;
  if (typeof figma?.getImageByHash !== "function") {
    throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor has no figma.getImageByHash, so an image cannot be reused by its hash.");
  }
  if (!figma.getImageByHash(hash)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.hash\` names no image in this file: "${hash}".`, {
      hint: "figma_import_image places an image and returns its `imageHash`.",
    });
  }
  const scaleMode = SCALE_MODES[String(im.scaleMode ?? "fill").toLowerCase()];
  if (!scaleMode) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.scaleMode\` must be fill, fit, crop or tile.`);
  const paint: ImagePaint = { type: "IMAGE", imageHash: hash, scaleMode };
  if (im.rotation !== undefined) {
    if (![0, 90, 180, 270].includes(im.rotation as number)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.rotation\` must be 0, 90, 180 or 270.`);
    }
    // The typings: rotation applies to fill, fit and tile; a crop takes its own.
    if (scaleMode === "CROP") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.rotation\` does not apply to a crop — use fill, fit or tile.`);
    paint.rotation = im.rotation as number;
  }
  if (im.filters !== undefined) {
    const f = plainObject(im.filters, `${field}.filters`, `{ ${IMAGE_FILTERS.join(", ")} }`);
    onlyKeys(f, IMAGE_FILTERS, `${field}.filters`);
    const filters: Record<string, number> = {};
    for (const k of IMAGE_FILTERS) {
      if (f[k] === undefined) continue;
      const v = f[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < -1 || v > 1) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}.filters.${k}\` must be a number from -1 to 1.`);
      }
      filters[k] = v;
    }
    paint.filters = filters;
  }
  if (opacity !== undefined && opacity !== 1) paint.opacity = opacity;
  return paint;
}

/**
 * One `fills[i]` entry → a paint for any node size. Exactly one of `color`
 * (hex), `r/g/b` (0–1, optional `a`), `gradient` or `image` — the forms are
 * separate fields because a union schema is not portable across model
 * providers. Everything that can be wrong is refused here, before a node is
 * touched; what is left is arithmetic.
 */
export function toPaintFor(entry: unknown, i: number, defaultOpacity?: number): PaintFor {
  const field = `fills[${i}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be an object: { color } or { r, g, b } or { gradient } or { image }.`);
  }
  const e = entry as Record<string, unknown>;
  onlyKeys(e, ["color", "r", "g", "b", "a", "gradient", "image", "opacity"], field);
  const forms = [e.color !== undefined, e.r !== undefined || e.g !== undefined || e.b !== undefined, e.gradient !== undefined, e.image !== undefined];
  if (forms.filter(Boolean).length !== 1) {
    throw new BridgeError(
      ErrorCode.INVALID_PARAM,
      `\`${field}\` needs exactly one of \`color\`, \`r/g/b\`, \`gradient\`, or \`image\`.`,
    );
  }
  const opacity = e.opacity !== undefined ? unit(e.opacity, `${field}.opacity`) : defaultOpacity;

  if (e.color !== undefined) {
    const p = parseColor(e.color, `${field}.color`);
    const alpha = p.opacity ?? 1;
    const o = (opacity ?? 1) * alpha;
    const solid: SolidPaint = o === 1 ? { type: "SOLID", color: p.color } : { type: "SOLID", color: p.color, opacity: o };
    return () => solid;
  }
  if (e.gradient !== undefined) return gradientFor(e.gradient, `${field}.gradient`, opacity);
  if (e.image !== undefined) {
    const image = imageFor(e.image, `${field}.image`, opacity);
    return () => image;
  }
  const color = { r: unit(e.r, `${field}.r`), g: unit(e.g, `${field}.g`), b: unit(e.b, `${field}.b`) };
  const a = e.a !== undefined ? unit(e.a, `${field}.a`) : 1;
  const o = (opacity ?? 1) * a;
  const solid: SolidPaint = o === 1 ? { type: "SOLID", color } : { type: "SOLID", color, opacity: o };
  return () => solid;
}

/**
 * One `fills[i]` entry → a Figma paint, for a holder with no size of its own
 * (a paint style): an angle is then taken on a square box. Nothing better
 * exists — the style is drawn in each node's own box — so a diagonal is exact
 * only on a square node (135 reads about 163 on 1280×400); params.ts `angle`
 * tells the agent where it writes the value.
 */
export function toPaint(entry: unknown, i: number, defaultOpacity?: number): Paint {
  return toPaintFor(entry, i, defaultOpacity)(1, 1);
}

type Mutable = Record<string, unknown>;

/** The box a gradient is fitted to; a node without a size is measured as a square. */
function sizeOf(node: Mutable): [number, number] {
  return [typeof node.width === "number" ? node.width : 1, typeof node.height === "number" ? node.height : 1];
}

/** Run `apply` on every requested node that has `prop`, reporting the rest per item. */
async function perNode(
  ctx: OpContext,
  prop: string,
  apply: (node: Mutable) => void,
): Promise<{ updated: number; items: ItemResult[] }> {
  const items: ItemResult[] = [];
  let updated = 0;
  for (const { id, node } of await resolveAll(requireIds(ctx))) {
    if (!node) {
      items.push({ id, ok: false, error: "not found" });
      continue;
    }
    // has(), not `in`: touching a member a board or deck node lacks may throw [C-145].
    if (!has(node, prop)) {
      items.push({ id, ok: false, error: `a ${node.type} has no ${prop}` });
      continue;
    }
    try {
      apply(node as unknown as Mutable);
      items.push({ id, ok: true });
      updated++;
    } catch (err) {
      items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { updated, items };
}

const setFills: PluginOp = {
  write: true,
  async run(ctx) {
    // Validate every paint before touching any node: a bad entry fails the call
    // with nothing changed, rather than half a batch.
    const paints = await beforeMutating(() => {
      requireIds(ctx);
      const fills = ctx.params.fills;
      if (!Array.isArray(fills)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`fills` must be an array (empty removes all fills).");
      const defaultOpacity = ctx.params.opacity !== undefined ? unit(ctx.params.opacity, "opacity") : undefined;
      return fills.map((f, i) => toPaintFor(f, i, defaultOpacity));
    });
    return perNode(ctx, "fills", (node) => {
      const [w, h] = sizeOf(node);
      node.fills = paints.map((p) => p(w, h));
    });
  },
};

/** figma_create_line's `cap` vocabulary (shapes.ts CAPS), so one word means one end on every tool [C-101]. */
const STROKE_CAPS: Record<string, string> = {
  none: "NONE", round: "ROUND", square: "SQUARE",
  arrow: "ARROW_LINES", "arrow-filled": "ARROW_EQUILATERAL", triangle: "TRIANGLE_FILLED",
  circle: "CIRCLE_FILLED", diamond: "DIAMOND_FILLED",
};
const STROKE_JOINS: Record<string, string> = { miter: "MITER", bevel: "BEVEL", round: "ROUND" };
/** IndividualStrokesMixin [C-101]. */
const SIDE_WEIGHTS = { top: "strokeTopWeight", right: "strokeRightWeight", bottom: "strokeBottomWeight", left: "strokeLeftWeight" } as const;
type Side = keyof typeof SIDE_WEIGHTS;

/**
 * Per-side weights, all four written. A side left out is 0 — so `{ bottom: 1 }`
 * is a bottom border, the reason this exists — unless `weight` is given, which
 * then fills the sides left out.
 */
function sideWeights(raw: unknown, weight: number | undefined): Array<[string, number]> {
  const s = plainObject(raw, "sides", "{ top?, right?, bottom?, left? }");
  const sides = Object.keys(SIDE_WEIGHTS) as Side[];
  onlyKeys(s, sides, "sides");
  if (!sides.some((k) => s[k] !== undefined)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`sides` needs at least one of top, right, bottom, left.");
  return sides.map((k) => {
    const v = s[k];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`sides.${k}\` must be a number ≥ 0.`);
    }
    return [SIDE_WEIGHTS[k], (v as number | undefined) ?? weight ?? 0];
  });
}

function pick(raw: unknown, table: Record<string, string>, field: string): string | undefined {
  if (raw === undefined) return undefined;
  const v = table[String(raw).toLowerCase()];
  if (!v) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be one of: ${Object.keys(table).join(", ")}.`);
  return v;
}

const STROKE_FIELDS = ["color", "gradient", "weight", "align", "dashPattern", "sides", "cap", "join"] as const;

const setStrokes: PluginOp = {
  write: true,
  async run(ctx) {
    const p = await beforeMutating(() => {
      requireIds(ctx);
      const given = (k: string) => ctx.params[k] !== undefined;
      // `remove: true` takes the outline off — before this a stroke could be set
      // but never removed, so the only way out was a weight of 0 (found while
      // designing on the live canvas).
      if (ctx.params.remove === true) {
        const extra = STROKE_FIELDS.filter(given);
        if (extra.length) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `\`remove: true\` takes the stroke off — give it alone, without \`${extra.join("`, `")}\`.`);
        }
        return { remove: true as const };
      }
      if (given("color") === given("gradient")) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "Give exactly one of `color`, `gradient`, or `remove: true` to take the stroke off.");
      }
      let paint: (w: number, h: number) => Paint;
      if (given("color")) {
        const solid = parseColor(ctx.params.color, "color");
        paint = () => solid;
      } else {
        paint = gradientFor(ctx.params.gradient, "gradient");
      }
      const weight = num(ctx.params, "weight");
      if (weight !== undefined && weight < 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`weight` must be ≥ 0.");
      const align = ctx.params.align;
      if (align !== undefined && align !== "INSIDE" && align !== "CENTER" && align !== "OUTSIDE") {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`align` must be INSIDE, CENTER or OUTSIDE.");
      }
      const dash = ctx.params.dashPattern;
      if (dash !== undefined && (!Array.isArray(dash) || dash.some((d) => typeof d !== "number" || d < 0))) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`dashPattern` must be an array of non-negative numbers.");
      }
      return {
        remove: false as const,
        paint,
        weight,
        align: align as string | undefined,
        dash: dash as number[] | undefined,
        sides: given("sides") ? sideWeights(ctx.params.sides, weight) : undefined,
        cap: pick(ctx.params.cap, STROKE_CAPS, "cap"),
        join: pick(ctx.params.join, STROKE_JOINS, "join"),
      };
    });
    if (p.remove) {
      return perNode(ctx, "strokes", (node) => {
        node.strokes = [];
      });
    }
    return perNode(ctx, "strokes", (node) => {
      // Every refusal for this node before its first write, so a node that
      // cannot take part of the call is left exactly as it was.
      if (p.sides && !("strokeTopWeight" in node)) {
        throw new Error(`a ${String(node.type)} takes one stroke weight — per-side weights are for frames, rectangles, components and instances`);
      }
      if (p.cap && !("strokeCap" in node)) throw new Error(`a ${String(node.type)} has no strokeCap`);
      if (p.join && !("strokeJoin" in node)) throw new Error(`a ${String(node.type)} has no strokeJoin`);
      if (p.dash !== undefined && !("dashPattern" in node)) throw new Error(`this node has no dashPattern`);
      const [w, h] = sizeOf(node);
      node.strokes = [p.paint(w, h)];
      if (p.sides) for (const [prop, v] of p.sides) node[prop] = v;
      else if (p.weight !== undefined) node.strokeWeight = p.weight;
      if (p.align !== undefined) node.strokeAlign = p.align;
      if (p.dash !== undefined) node.dashPattern = p.dash;
      if (p.cap) node.strokeCap = p.cap;
      if (p.join) node.strokeJoin = p.join;
    });
  },
};

const setCornerRadius: PluginOp = {
  write: true,
  async run(ctx) {
    const p = await beforeMutating(() => {
      requireIds(ctx);
      const radius = num(ctx.params, "radius");
      const radii = ctx.params.radii;
      const smoothing = ctx.params.smoothing !== undefined ? unit(ctx.params.smoothing, "smoothing") : undefined;
      if (radius !== undefined && radii !== undefined) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "Give `radius` (all corners) or `radii` [topLeft, topRight, bottomRight, bottomLeft], not both.");
      }
      if (radius === undefined && radii === undefined && smoothing === undefined) {
        throw new BridgeError(
          ErrorCode.INVALID_PARAM,
          "Give at least one of `radius` (all corners), `radii` [topLeft, topRight, bottomRight, bottomLeft], or `smoothing` (0–1).",
        );
      }
      if (radius !== undefined && radius < 0) throw new BridgeError(ErrorCode.INVALID_PARAM, "`radius` must be ≥ 0.");
      if (radii !== undefined && (!Array.isArray(radii) || radii.length !== 4 || radii.some((r) => typeof r !== "number" || r < 0))) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`radii` must be four non-negative numbers: [topLeft, topRight, bottomRight, bottomLeft].");
      }
      return { radius, radii: radii as number[] | undefined, smoothing };
    });
    // Smoothing on its own is a property of its own: a node is judged on that.
    const prop = p.radius === undefined && p.radii === undefined ? "cornerSmoothing" : "cornerRadius";
    return perNode(ctx, prop, (node) => {
      if (p.radii && !("topLeftRadius" in node)) throw new Error("this node only takes one radius for all corners — pass `radius`");
      if (p.smoothing !== undefined && !("cornerSmoothing" in node)) throw new Error(`a ${String(node.type)} has no cornerSmoothing`);
      if (p.radius !== undefined) node.cornerRadius = p.radius;
      if (p.radii) {
        const [tl, tr, br, bl] = p.radii;
        node.topLeftRadius = tl;
        node.topRightRadius = tr;
        node.bottomRightRadius = br;
        node.bottomLeftRadius = bl;
      }
      // CornerMixin.cornerSmoothing, 0–1; 0.6 is the iOS squircle [C-101].
      if (p.smoothing !== undefined) node.cornerSmoothing = p.smoothing;
    });
  },
};

// ── effects, blend mode ─────────────────────────────────────────────────────

const SHADOWS = new Set(["DROP_SHADOW", "INNER_SHADOW"]);
const BLURS = new Set(["LAYER_BLUR", "BACKGROUND_BLUR"]);
/** The effects newer than the shadows and blurs [C-102]: an older desktop build may refuse them. */
const RECENT = new Set(["NOISE", "TEXTURE", "GLASS"]);

const SHADOW_FIELDS = ["color", "x", "y", "radius", "spread", "opacity"];
/**
 * What each effect type takes besides `type` and `visible` — the typings'
 * shapes [C-102]. A field of another type is refused, never dropped: an agent
 * that sends `density` to a shadow believes it set something.
 */
const EFFECT_FIELDS: Record<string, readonly string[]> = {
  DROP_SHADOW: [...SHADOW_FIELDS, "showBehindNode"],
  INNER_SHADOW: SHADOW_FIELDS,
  LAYER_BLUR: ["radius", "progressive"],
  BACKGROUND_BLUR: ["radius", "progressive"],
  NOISE: ["noiseType", "color", "secondaryColor", "opacity", "noiseSize", "density"],
  TEXTURE: ["noiseSize", "radius", "clipToShape"],
  GLASS: ["lightIntensity", "lightAngle", "refraction", "depth", "dispersion", "radius"],
};
const EFFECT_KEYS = new Set(Object.values(EFFECT_FIELDS).flat());
const NOISE_TYPES: Record<string, string> = { monotone: "MONOTONE", duotone: "DUOTONE", multitone: "MULTITONE" };

function takes(type: string): string {
  if (BLURS.has(type)) return "`radius` and `visible`, plus `progressive` for a blur that ramps";
  const names = [...EFFECT_FIELDS[type]!, "visible"].map((k) => `\`${k}\``);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function numberOr(v: unknown, fallback: number, field: string, min = -Infinity): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be a number${min === 0 ? " ≥ 0" : min > -Infinity ? ` ≥ ${min}` : ""}.`);
  }
  return v;
}

function required(v: unknown, field: string, check: (n: number) => boolean, rule: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || !check(v)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, v === undefined ? `\`${field}\` is required (${rule}).` : `\`${field}\` must be ${rule}.`);
  }
  return v;
}

function offset(raw: unknown, fallback: { x: number; y: number }, field: string): { x: number; y: number } {
  if (raw === undefined) return fallback;
  const o = plainObject(raw, field, "{ x, y }");
  onlyKeys(o, ["x", "y"], field);
  const any = () => true;
  return { x: required(o.x, `${field}.x`, any, "a number"), y: required(o.y, `${field}.y`, any, "a number") };
}

/**
 * One effects[] entry → a Figma Effect, with exactly the fields the typings
 * give that effect type: an inner shadow has no showShadowBehindNode; a blur
 * has no colour or offset and carries blurType "NORMAL" (or "PROGRESSIVE");
 * a noise carries secondaryColor only as duotone and its own opacity only as
 * multitone. Shared by figma_set_effects and figma_create_effect_style.
 */
export function toEffect(entry: unknown, i: number, field = "effects"): Record<string, unknown> {
  const at = `${field}[${i}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\` must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  const type = String(e.type ?? "DROP_SHADOW").toUpperCase();
  const visible = e.visible !== false;
  const own = EFFECT_FIELDS[type];
  if (!own) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.type\` must be DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR, NOISE, TEXTURE or GLASS.`);
  }
  const extra = Object.keys(e).filter((k) => e[k] !== undefined && EFFECT_KEYS.has(k) && !own.includes(k));
  if (extra.length) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\` is a ${type}: it takes only ${takes(type)} (got ${extra.join(", ")}).`);
  }

  if (SHADOWS.has(type)) {
    const base = e.color !== undefined ? parseColor(e.color, `${at}.color`) : { color: { r: 0, g: 0, b: 0 }, opacity: undefined };
    const alpha = e.opacity !== undefined ? unit(e.opacity, `${at}.opacity`) : (base.opacity ?? 0.25);
    const out: Record<string, unknown> = {
      type,
      color: { ...base.color, a: alpha },
      offset: { x: numberOr(e.x, 0, `${at}.x`), y: numberOr(e.y, 4, `${at}.y`) },
      radius: numberOr(e.radius, 8, `${at}.radius`, 0),
      spread: numberOr(e.spread, 0, `${at}.spread`),
      visible,
      blendMode: "NORMAL",
    };
    if (type === "DROP_SHADOW") out.showShadowBehindNode = e.showBehindNode === true;
    return out;
  }

  if (BLURS.has(type)) {
    const radius = numberOr(e.radius, 8, `${at}.radius`, 0);
    if (e.progressive === undefined) return { type, radius, visible, blurType: "NORMAL" };
    // BlurEffectProgressive: `radius` is where the ramp ends; offsets are 0–1 of
    // the node. With no offsets it ramps from the top edge to the bottom one.
    const p = plainObject(e.progressive, `${at}.progressive`, "{ startRadius?, startOffset?, endOffset? }");
    onlyKeys(p, ["startRadius", "startOffset", "endOffset"], `${at}.progressive`);
    return {
      type,
      radius,
      visible,
      blurType: "PROGRESSIVE",
      startRadius: numberOr(p.startRadius, 0, `${at}.progressive.startRadius`, 0),
      startOffset: offset(p.startOffset, { x: 0.5, y: 0 }, `${at}.progressive.startOffset`),
      endOffset: offset(p.endOffset, { x: 0.5, y: 1 }, `${at}.progressive.endOffset`),
    };
  }

  if (type === "NOISE") {
    const noiseType = pick(e.noiseType ?? "monotone", NOISE_TYPES, `${at}.noiseType`)!;
    if (noiseType === "DUOTONE" && e.secondaryColor === undefined) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\` is a duotone noise: it needs \`secondaryColor\`.`);
    }
    if (noiseType !== "DUOTONE" && e.secondaryColor !== undefined) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.secondaryColor\` is for a duotone noise only.`);
    }
    const base = parseColor(e.color ?? "#000000", `${at}.color`);
    const opacity = e.opacity !== undefined ? unit(e.opacity, `${at}.opacity`) : undefined;
    const out: Record<string, unknown> = {
      type,
      noiseType,
      // Monotone and duotone carry their opacity in the colour, as a shadow does;
      // multitone has an `opacity` field of its own.
      color: { ...base.color, a: noiseType === "MULTITONE" ? (base.opacity ?? 1) : (opacity ?? base.opacity ?? 0.25) },
      noiseSize: required(e.noiseSize, `${at}.noiseSize`, (n) => n > 0, "a grain size > 0"),
      density: required(e.density, `${at}.density`, (n) => n >= 0 && n <= 1, "a density from 0 to 1"),
      // No blendMode: the typings declare one, but measured live Figma's validator
      // refuses the key on a noise ("Unrecognized key(s) in object: 'blendMode'") [C-102].
      visible,
    };
    if (noiseType === "DUOTONE") out.secondaryColor = rgba(e.secondaryColor, `${at}.secondaryColor`);
    if (noiseType === "MULTITONE") out.opacity = opacity ?? 0.25;
    return out;
  }

  if (type === "TEXTURE") {
    return {
      type,
      noiseSize: required(e.noiseSize, `${at}.noiseSize`, (n) => n > 0, "a grain size > 0"),
      radius: numberOr(e.radius, 8, `${at}.radius`, 0),
      clipToShape: e.clipToShape !== false,
      visible,
    };
  }

  // GLASS. The typings bound lightIntensity, refraction and dispersion to 0–1
  // and depth to ≥ 1; the defaults are a clear pane lit from the top left.
  const bounded = (k: string, fallback: number) => (e[k] !== undefined ? unit(e[k], `${at}.${k}`) : fallback);
  return {
    type,
    lightIntensity: bounded("lightIntensity", 0.5),
    lightAngle: numberOr(e.lightAngle, -45, `${at}.lightAngle`),
    refraction: bounded("refraction", 0.5),
    depth: numberOr(e.depth, 20, `${at}.depth`, 1),
    dispersion: bounded("dispersion", 0),
    radius: numberOr(e.radius, 0, `${at}.radius`, 0),
    visible,
  };
}

const setEffects: PluginOp = {
  write: true,
  async run(ctx) {
    const effects = await beforeMutating(() => {
      requireIds(ctx);
      const raw = ctx.params.effects;
      if (!Array.isArray(raw)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`effects` must be an array (empty removes all effects).");
      return raw.map((e, i) => toEffect(e, i));
    });
    const recent = effects.some((x) => RECENT.has(String(x.type)) || x.blurType === "PROGRESSIVE");
    return perNode(ctx, "effects", (node) => {
      try {
        node.effects = effects;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        // A field Figma's validator names is a shape problem, not an old build:
        // pass its words through as they are [C-102].
        if (!recent || /Unrecognized key/i.test(why)) throw err;
        throw new Error(`${why} — NOISE, TEXTURE, GLASS and progressive blurs are recent Figma effects; an older desktop build refuses them`);
      }
    });
  },
};

/** @figma/plugin-typings 1.141.0, `type BlendMode`. */
export const BLEND_MODES = [
  "PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE",
  "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY",
] as const;

const setBlendMode: PluginOp = {
  write: true,
  async run(ctx) {
    const mode = await beforeMutating(() => {
      requireIds(ctx);
      const m = String(ctx.params.blendMode ?? "").toUpperCase();
      if (!(BLEND_MODES as readonly string[]).includes(m)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `\`blendMode\` must be one of ${BLEND_MODES.join(", ")}.`);
      }
      return m;
    });
    return perNode(ctx, "blendMode", (node) => {
      node.blendMode = mode;
    });
  },
};

// ── named styles, variables ─────────────────────────────────────────────────

/** perNode for appliers that are async or check the node themselves. */
async function perNodeAsync(
  ctx: OpContext,
  apply: (node: Mutable & { type: string }) => void | Promise<void>,
): Promise<{ updated: number; items: ItemResult[] }> {
  const items: ItemResult[] = [];
  let updated = 0;
  for (const { id, node } of await resolveAll(requireIds(ctx))) {
    if (!node) {
      items.push({ id, ok: false, error: "not found" });
      continue;
    }
    try {
      await apply(node as unknown as Mutable & { type: string });
      items.push({ id, ok: true });
      updated++;
    } catch (err) {
      items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { updated, items };
}

const applyStyleToNode: PluginOp = {
  write: true,
  async run(ctx) {
    const { style, target } = await beforeMutating(async () => {
      requireIds(ctx);
      const asked = ctx.params.type;
      if (asked !== undefined && !isStyleTarget(asked)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`type` must be fill, stroke, text, effect or grid.");
      }
      const found = await findStyle({ id: str(ctx.params, "styleId"), name: str(ctx.params, "styleName") }, asked);
      return { style: found, target: targetFor(found.kind, asked) };
    });
    const result = await perNodeAsync(ctx, (node) => applyStyle(node, style.id, target));
    return { ...result, style: { id: style.id, name: style.name, kind: style.kind }, appliedAs: target };
  },
};

const bindVariableToNode: PluginOp = {
  write: true,
  async run(ctx) {
    // The field, the index and the variable are all checked before the first
    // node changes; a refusal there says nothing changed (bind.ts bindingFor).
    const { field, index, variable } = await bindingFor(ctx.params);
    const result = await perNodeAsync(ctx, (node) => bindNodeField(node, field, variable, index));
    return { ...result, variable: { id: variable.id, name: variable.name, type: variable.resolvedType }, field, ...(index ? { index } : {}) };
  },
};

// ── prototype reactions ─────────────────────────────────────────────────────

const SIMPLE_TRIGGERS = new Set(["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG"]);
const SIMPLE_TRANSITIONS = new Set(["DISSOLVE", "SMART_ANIMATE", "SCROLL_ANIMATE"]);
const DIRECTIONAL_TRANSITIONS = new Set(["MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"]);

/**
 * Figma's own Reaction shape (what figma_get_reactions returns) is accepted as
 * is, plus the shorthands an agent is likely to write: `trigger: "ON_CLICK"`, a
 * single `action`, and a NODE action whose `transition` is just a type name with
 * optional `duration` (seconds — the typings' own example uses 0.2 and 0.5),
 * `easing` and `direction`. Figma validates the result; its message comes back
 * on refusal.
 */
export function toReaction(entry: unknown, i: number): Record<string, unknown> {
  const at = `reactions[${i}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\` must be an object.`);
  }
  const e = entry as Record<string, unknown>;
  let trigger = e.trigger;
  if (typeof trigger === "string") {
    const t = trigger.toUpperCase();
    if (!SIMPLE_TRIGGERS.has(t)) {
      // A trigger's timeout is in milliseconds [C-122]: the example waits one second.
      throw new BridgeError(
        ErrorCode.INVALID_PARAM,
        `\`${at}.trigger\` "${trigger}" needs the object form, e.g. { "type": "AFTER_TIMEOUT", "timeout": 1000 }.`,
      );
    }
    trigger = { type: t };
  } else if (!trigger || typeof trigger !== "object") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.trigger\` is required, e.g. "ON_CLICK".`);
  }
  const list = Array.isArray(e.actions) ? e.actions : e.action !== undefined ? [e.action] : null;
  if (!list || list.length === 0) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\` needs \`actions\` (or one \`action\`).`);
  return { trigger, actions: list.map((a, k) => toAction(a, `${at}.actions[${k}]`)) };
}

function toAction(a: unknown, at: string): Record<string, unknown> {
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}\` must be an object.`);
  const act = { ...(a as Record<string, unknown>) };
  if (typeof act.type !== "string") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.type\` is required (NODE, BACK, CLOSE, URL, …).`);
  }
  act.type = act.type.toUpperCase();
  if (act.type !== "NODE") return act;
  act.navigation = typeof act.navigation === "string" ? act.navigation.toUpperCase() : "NAVIGATE";
  const tr = act.transition;
  if (tr === undefined || tr === null) {
    act.transition = null;
  } else if (typeof tr === "string") {
    const type = tr.toUpperCase();
    const easing = { type: typeof act.easing === "string" ? act.easing.toUpperCase() : "EASE_OUT" };
    const duration = numberOr(act.duration, 0.3, `${at}.duration`, 0);
    if (SIMPLE_TRANSITIONS.has(type)) {
      act.transition = { type, easing, duration };
    } else if (DIRECTIONAL_TRANSITIONS.has(type)) {
      const direction = typeof act.direction === "string" ? act.direction.toUpperCase() : "LEFT";
      act.transition = { type, direction, matchLayers: false, easing, duration };
    } else {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${at}.transition\` "${tr}" is not a transition type.`);
    }
  }
  delete act.duration;
  delete act.easing;
  delete act.direction;
  return act;
}

type Reactive = { id: string; type: string; setReactionsAsync?(r: unknown[]): Promise<void> };

async function reactiveNode(ctx: OpContext): Promise<Reactive> {
  const id = str(ctx.params, "nodeId");
  if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeId` is required.");
  const [hit] = await resolveAll([id]);
  if (!hit?.node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`);
  const r = hit.node as unknown as Reactive;
  if (typeof r.setReactionsAsync !== "function") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${hit.node.type} cannot have prototype reactions.`);
  }
  return r;
}

const setReactions: PluginOp = {
  write: true,
  async run(ctx) {
    const { reactions, node } = await beforeMutating(async () => {
      let raw = ctx.params.reactions;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          throw new BridgeError(ErrorCode.INVALID_PARAM, "`reactions` is not valid JSON.");
        }
      }
      if (!Array.isArray(raw)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`reactions` must be a JSON array.");
      return { reactions: raw.map((r, i) => toReaction(r, i)), node: await reactiveNode(ctx) };
    });
    try {
      await node.setReactionsAsync!(reactions);
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma refused the reactions: ${err instanceof Error ? err.message : String(err)}`, {
        hint: "figma_get_reactions on a node that already has the interaction shows the exact shape Figma expects.",
      });
    }
    return { nodeId: node.id, count: reactions.length };
  },
};

const removeReactions: PluginOp = {
  write: true,
  async run(ctx) {
    const node = await beforeMutating(() => reactiveNode(ctx));
    await node.setReactionsAsync!([]);
    return { nodeId: node.id, count: 0 };
  },
};

// ── deleting a local style (BaseStyle.remove() — typings 1.141.0) ───────────

const deleteStyle: PluginOp = {
  write: true,
  async run(ctx) {
    const ids = Array.isArray(ctx.params.styleIds) ? (ctx.params.styleIds as unknown[]).filter((s): s is string => typeof s === "string") : [];
    if (!ids.length) throw new BridgeError(ErrorCode.INVALID_PARAM, "`styleIds` must be a non-empty array.");
    const get = (globalThis as unknown as { figma: { getStyleByIdAsync?: (id: string) => Promise<{ remove(): void } | null> } }).figma.getStyleByIdAsync;
    if (!get) throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type has no styles.");
    const items: ItemResult[] = [];
    for (const id of ids) {
      // Same comma tolerance as findStyle: the id Figma hands out ends in one,
      // and stripping it — the natural move for an id that reads like a typo —
      // otherwise reports "not found" for a style that exists.
      const style = (await get(id)) ?? (await get(id.endsWith(",") ? id.slice(0, -1) : `${id},`));
      if (!style) {
        items.push({ id, ok: false, error: "not found" });
        continue;
      }
      try {
        style.remove();
        items.push({ id, ok: true });
      } catch (err) {
        items.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { deleted: items.filter((i) => i.ok).length, items };
  },
};

export const STYLE_OPS: Record<string, PluginOp> = {
  delete_style: deleteStyle,
  set_fills: setFills,
  set_strokes: setStrokes,
  set_corner_radius: setCornerRadius,
  set_effects: setEffects,
  set_blend_mode: setBlendMode,
  apply_style_to_node: applyStyleToNode,
  bind_variable_to_node: bindVariableToNode,
  set_reactions: setReactions,
  remove_reactions: removeReactions,
};
