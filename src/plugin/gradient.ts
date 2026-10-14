// Gradient direction and position ⇄ Figma's gradientTransform.
//
// The model [C-100]: the transform T maps the node's normalised box (0–1 on
// each side) into gradient space, and a gradient is drawn in gradient space —
// a linear one along u from (0, 0.5) to (1, 0.5), a radial one centred on
// (0.5, 0.5) reaching 0.5. So T⁻¹ (M below) places those points on the node.
// Pinned: the identity runs left → right through the vertical centre, measured
// on Figma's own SVG export [C-057]; [[0,1,0],[-1,0,1]] runs top → bottom, per
// Figma's figma-use skill [C-100]. Every other angle, and the radial centre and
// reach, follow from the model and are checked live before anything relies on
// them; a mirrored sense is a sign flip in this file only.
//
// Angles use the CSS convention (0deg = to top, 90deg = to right, clockwise),
// so a value read off a design pastes straight into `linear-gradient()`.
// figma_set_fills and figma_set_strokes take `angle` for linear gradients only:
// where an angular gradient's sweep starts under the identity is unmeasured, so
// it takes a centre, and a rotation only through the raw `transform`.
//
// The transform lives in normalised space but the gradient is seen in pixels,
// which is why the angle functions take the node's width and height: the same
// 45deg needs a different transform on a 400×240 frame than on a square.

import { BridgeError, ErrorCode } from "../shared/errors.js";

/** Figma's 2×3 affine matrix, rows [[a, b, tx], [d, e, ty]] (`Transform` in the typings). */
export type Transform = [[number, number, number], [number, number, number]];

/** A zero or missing side (a line, an empty frame) is measured as 1 so nothing divides by zero. */
const side = (v: number) => (Number.isFinite(v) && v > 0 ? v : 1);
/**
 * Float noise snapped off (cos 90° = 6e-17; 90deg on 400×240 inverts to
 * 0.9999999999999998) and -0 written as 0, so a transform reads cleanly and
 * 90deg is exactly the measured identity on every box [C-057].
 */
const clean = (v: number) => {
  const r = Math.round(v * 1e12) / 1e12;
  return r === 0 ? 0 : r;
};

/** The six numbers of `t`, or undefined when it is not a finite 2×3 matrix — a value read off a paint is not trusted. */
function entries(t: Transform): number[] | undefined {
  const rows = t as unknown;
  if (!Array.isArray(rows) || !Array.isArray(rows[0]) || !Array.isArray(rows[1])) return undefined;
  const v: unknown[] = [rows[0][0], rows[0][1], rows[0][2], rows[1][0], rows[1][1], rows[1][2]];
  return v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as number[]) : undefined;
}

function invert(t: Transform): Transform | undefined {
  const v = entries(t);
  if (!v) return undefined;
  const [a, b, c, d, e, f] = v as [number, number, number, number, number, number];
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) return undefined;
  return [
    [clean(e / det), clean(-b / det), clean((b * f - c * e) / det)],
    [clean(-d / det), clean(a / det), clean((c * d - a * f) / det)],
  ];
}

/**
 * The transform for a linear gradient at `angleDeg` (CSS) on a `w`×`h` node.
 *
 * Start and end sit where CSS puts them: on the line through the centre at that
 * angle, `|w sinθ| + |h cosθ|` apart, so the first and last stop touch the
 * corners the way `linear-gradient(θ, …)` does. M's second column runs across
 * that line in pixel space — colour bands must stay square to the direction on
 * screen — and spans the box that way too, which makes 90deg exactly the
 * identity on any box.
 */
export function linearTransform(angleDeg: number, w: number, h: number): Transform {
  if (!Number.isFinite(angleDeg)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`angle` must be a number of degrees.");
  const W = side(w);
  const H = side(h);
  const rad = (angleDeg * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const along = Math.abs(W * sin) + Math.abs(H * cos);
  const across = Math.abs(W * cos) + Math.abs(H * sin);
  // Direction on screen (y down) is (sin, -cos); a quarter turn clockwise is (cos, sin).
  const c1 = { x: (along * sin) / W, y: (-along * cos) / H };
  const c2 = { x: (across * cos) / W, y: (across * sin) / H };
  const start = { x: 0.5 - c1.x / 2, y: 0.5 - c1.y / 2 };
  const m: Transform = [
    [c1.x, c2.x, start.x - c2.x / 2],
    [c1.y, c2.y, start.y - c2.y / 2],
  ];
  return invert(m)!; // never singular: the columns are square on screen and neither is zero
}

/**
 * The transform for a radial (or diamond) gradient centred on `center` (0–1 of
 * the node) whose edge is `radius` of each side away: 0.5 from the middle
 * reaches the edges, an ellipse that follows the box — Figma's own default,
 * which is the identity. `w` / `h` are taken so a circular radius can be added
 * without changing callers.
 */
export function radialTransform(center: { x: number; y: number }, radius: number, w: number, h: number): Transform {
  if (!(Number.isFinite(radius) && radius > 0)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`radius` must be greater than 0.");
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`center` needs a numeric x and y.");
  const k = 1 / (2 * radius);
  return [
    [clean(k), 0, clean(0.5 - center.x * k)],
    [0, clean(k), clean(0.5 - center.y * k)],
  ];
}

/**
 * The CSS angle a gradient is seen at on a `w`×`h` node, 0–360. It is the
 * normal of the colour bands — the gradient of u, T's first row, scaled to
 * pixels — not the direction between the handles, which differ once the node
 * has been resized since the gradient was drawn. `undefined` for a transform
 * with no direction.
 */
export function transformAngle(t: Transform, w: number, h: number): number | undefined {
  const v = entries(t);
  if (!v) return undefined;
  const [a, b] = v as [number, number];
  const gx = a / side(w);
  const gy = b / side(h);
  if (Math.hypot(gx, gy) < 1e-12) return undefined;
  const deg = Math.round(((Math.atan2(gx, -gy) * 180) / Math.PI) * 1e6) / 1e6;
  return ((deg % 360) + 360) % 360;
}

/** Where a radial, angular or diamond gradient is centred, 0–1 of the node; `undefined` for a singular transform. */
export function transformCenter(t: Transform): { x: number; y: number } | undefined {
  const m = invert(t);
  if (!m) return undefined;
  return { x: clean(m[0][0] * 0.5 + m[0][1] * 0.5 + m[0][2]), y: clean(m[1][0] * 0.5 + m[1][1] * 0.5 + m[1][2]) };
}

/**
 * Six numbers [a, b, c, d, e, f] as the matrix [[a, b, c], [d, e, f]] — the raw
 * escape hatch, flat because a nested array is one more shape a provider can
 * mangle. A singular matrix is refused here rather than handed to Figma: it
 * squeezes the gradient onto a line, so nothing can be drawn from it.
 */
export function transformFromList(list: unknown, field = "transform"): Transform {
  if (!Array.isArray(list) || list.length !== 6 || list.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` must be six numbers [a, b, c, d, e, f] — the rows [[a, b, c], [d, e, f]].`);
  }
  const [a, b, c, d, e, f] = list as [number, number, number, number, number, number];
  const t: Transform = [
    [a, b, c],
    [d, e, f],
  ];
  if (!invert(t)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` is singular (a·e − b·d = 0), so it has no direction to draw along.`);
  return t;
}
