// Real assets on the canvas: icons from SVG, pictures from images. A design
// built only from rectangles and text looks like a wireframe; these are how an
// agent places the icons and photographs a designer would.
//
// API per @figma/plugin-typings 1.141.0: figma.createNodeFromSvg(svg) returns a
// FrameNode of vectors; LayoutMixin.rescale(scale) resizes a node WITH its
// children (a plain resize would leave the vectors at their old size);
// figma.createImageAsync(url) and figma.createImage(bytes) return an Image
// handle used as an IMAGE paint — PNG, JPEG or GIF, at most 4096 px a side
// [C-076]; a layer's own exportAsync PNG bytes are one more such source, so a
// styleframe can be snapshotted into a storyboard thumbnail inside the sandbox.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { OpContext, PluginOp } from "./index.js";
import { str } from "../read.js";
import { append, applySizing, num, parentFor, parseColor, parseSizing, type FigmaWrite, type NodeLikeW } from "../write.js";
import { findVariable } from "../bind.js";

const api = () => (globalThis as unknown as { figma: FigmaWrite & Record<string, unknown> }).figma;
type Any = Record<string, unknown>;

function failedBeforeCreating(err: unknown): never {
  const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INVALID_PARAM, err instanceof Error ? err.message : String(err));
  throw new BridgeError(e.code, e.message, { ...(e.hint ? { hint: e.hint } : {}), partial: { created: [] } });
}

function place(node: NodeLikeW, ctx: OpContext): void {
  const x = num(ctx.params, "x");
  const y = num(ctx.params, "y");
  const at = node as unknown as { x: number; y: number };
  if (x !== undefined) at.x = x;
  if (y !== undefined) at.y = y;
}

/**
 * The painted layers inside an icon and which of their paint lists show. A
 * frame is passed over — it is the wrapper, and painting it would draw a box
 * behind the icon; so is a list with nothing visible, which keeps a
 * stroke-only icon stroke-only.
 */
function paintedLayers(node: Any): Array<{ layer: Any; keys: Array<"fills" | "strokes"> }> {
  const out: Array<{ layer: Any; keys: Array<"fills" | "strokes"> }> = [];
  const visit = (x: Any) => {
    const keys = (["fills", "strokes"] as const).filter((key) => {
      const list = x[key];
      return x.type !== "FRAME" && Array.isArray(list) && list.length > 0 && list.some((p) => (p as Any).visible !== false);
    });
    if (keys.length) out.push({ layer: x, keys });
    for (const c of (x.children as Any[] | undefined) ?? []) visit(c);
  };
  visit(node);
  return out;
}

/** Recolour every painted vector inside an icon — the usual "make this icon our brand colour". */
export function recolour(node: Any, paint: unknown): number {
  let n = 0;
  for (const { layer, keys } of paintedLayers(node)) {
    for (const key of keys) {
      layer[key] = [paint];
      n++;
    }
  }
  return n;
}

/** recolour, reporting which layers took the paint — the ids a later binding or edit needs. */
export function recolourIds(node: Any, paint: unknown): string[] {
  const hit = paintedLayers(node);
  for (const { layer, keys } of hit) for (const key of keys) layer[key] = [paint];
  return hit.map(({ layer }) => String(layer.id));
}

/**
 * A solid paint bound to a COLOR variable, so the icon follows the token —
 * a theme switch or a new brand colour recolours it with no further call.
 */
async function variablePaint(figma: FigmaWrite & Record<string, unknown>, ref: string): Promise<unknown> {
  const v = await findVariable(ref.startsWith("VariableID:") ? { id: ref } : { name: ref }, "colorVariable");
  if (v.resolvedType !== "COLOR") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`colorVariable\` needs a COLOR variable; "${v.name}" is ${v.resolvedType}.`);
  const vars = figma.variables as { setBoundVariableForPaint?(p: unknown, f: string, v: unknown): unknown } | undefined;
  if (typeof vars?.setBoundVariableForPaint !== "function") {
    throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor cannot bind a paint to a variable (no setBoundVariableForPaint).");
  }
  return vars.setBoundVariableForPaint({ type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", v);
}

const importSvg: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    let parent: NodeLikeW;
    let paint: unknown;
    let sizing: ReturnType<typeof parseSizing>;
    const svg = typeof ctx.params.svg === "string" ? ctx.params.svg : "";
    try {
      if (!/<svg[\s>]/i.test(svg)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`svg` must be SVG markup (it contains no <svg> element).");
      if (svg.length > 2_000_000) throw new BridgeError(ErrorCode.INVALID_PARAM, "`svg` is over 2 MB — simplify it or export it as an image.");
      const colorVariable = str(ctx.params, "colorVariable");
      if (ctx.params.color !== undefined && colorVariable) throw new BridgeError(ErrorCode.INVALID_PARAM, "Give `color` or `colorVariable`, not both.");
      parent = await parentFor(figma, str(ctx.params, "parentId"));
      paint = colorVariable ? await variablePaint(figma, colorVariable) : ctx.params.color !== undefined ? parseColor(ctx.params.color, "color") : undefined;
      sizing = parseSizing(ctx.params.sizing);
    } catch (err) {
      failedBeforeCreating(err);
    }
    const create = figma.createNodeFromSvg as ((s: string) => NodeLikeW) | undefined;
    if (!create) throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot import SVG.");
    let node: NodeLikeW;
    try {
      node = create.call(figma, svg);
    } catch (err) {
      failedBeforeCreating(new BridgeError(ErrorCode.INVALID_PARAM, `Figma could not parse the SVG: ${err instanceof Error ? err.message : String(err)}`));
    }
    const n = node as unknown as Any & { width: number; height: number; rescale?: (s: number) => void };
    const name = str(ctx.params, "name");
    if (name) node.name = name;
    // Scale WITH the vectors: resize() would move the frame edge and leave the
    // drawing at its original size.
    const w = num(ctx.params, "width");
    const h = num(ctx.params, "height");
    const factor = w !== undefined && n.width > 0 ? w / n.width : h !== undefined && n.height > 0 ? h / n.height : undefined;
    if (factor !== undefined && factor > 0 && typeof n.rescale === "function") n.rescale(factor);
    // The wrapper is a FRAME, or a GROUP when the <svg> has no size or viewBox
    // [C-086]; either way the paint lands on the vectors inside it.
    const layers = paintedLayers(n);
    const recoloured = layers.reduce((sum, l) => sum + l.keys.length, 0);
    const vectorIds = paint ? recolourIds(n, paint) : layers.map(({ layer }) => String(layer.id));
    append(parent, node);
    place(node, ctx);
    try {
      applySizing(node, sizing);
    } catch (err) {
      node.remove?.();
      failedBeforeCreating(err);
    }
    return {
      id: node.id, name: node.name, type: node.type, width: Math.round(n.width * 100) / 100, height: Math.round(n.height * 100) / 100,
      ...(paint ? { recoloured } : {}),
      vectorIds,
    };
  },
};

const SCALE: Record<string, string> = { fill: "FILL", fit: "FIT", crop: "CROP", tile: "TILE" };

/** createImage takes at most this many pixels a side [C-076]. */
export const MAX_IMAGE_SIDE = 4096;

/** An Image handle: an IMAGE paint takes its hash. */
export type FigmaImage = { hash: string; getSizeAsync(): Promise<{ width: number; height: number }> };

type Renderable = NodeLikeW & { width?: unknown; height?: unknown; exportAsync?: (settings: Record<string, unknown>) => Promise<Uint8Array> };

/** A node this call can render to a picture: it exists, can be exported, and has an area. */
export async function renderSource(figma: FigmaWrite, id: string, field: string): Promise<Renderable & { width: number; height: number }> {
  const node = (await figma.getNodeByIdAsync(id)) as Renderable | null;
  if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `\`${field}\`: no node with id \`${id}\` in this file.`);
  if (typeof node.exportAsync !== "function") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: a ${node.type} cannot be rendered to a picture.`, { hint: "Pick a frame or a layer on a page." });
  const { width, height } = node;
  if (typeof width !== "number" || typeof height !== "number" || !(width > 0) || !(height > 0)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: "${node.name}" has no area to render.`);
  }
  return node as Renderable & { width: number; height: number };
}

/**
 * Render `node` to a PNG `width` px wide and add it to the file as an image —
 * both in the sandbox, so no bytes cross the bridge. The height follows the
 * node's proportions; a picture over the cap on either side is refused before
 * anything renders, naming the widest width that fits [C-076].
 */
export async function renderToImage(
  figma: FigmaWrite,
  node: Renderable & { width: number; height: number },
  width: number,
  field: string,
): Promise<{ image: FigmaImage; width: number; height: number }> {
  const w = Math.round(width);
  const h = Math.round((w * node.height) / node.width);
  if (w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE) {
    const fits = Math.floor(Math.min(MAX_IMAGE_SIDE, (MAX_IMAGE_SIDE * node.width) / node.height));
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: rendering "${node.name}" ${w} px wide makes a ${w} × ${h} px picture; Figma takes images up to ${MAX_IMAGE_SIDE} px a side.`, {
      hint: `Render it at most ${fits} px wide.`,
    });
  }
  const create = (figma as unknown as { createImage?: (bytes: Uint8Array) => FigmaImage }).createImage;
  if (typeof create !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot add images (no createImage).");
  let bytes: Uint8Array;
  try {
    bytes = await node.exportAsync!({ format: "PNG", constraint: { type: "WIDTH", value: w } });
  } catch (err) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: Figma could not render "${node.name}": ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    // The handle as Figma gives it: its methods may live on a prototype a copy would lose.
    return { image: create.call(figma, bytes), width: w, height: h };
  } catch (err) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: Figma could not use the render of "${node.name}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

function decodeBase64(b64: string): Uint8Array {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (A.indexOf(clean[i]!) << 18) | (A.indexOf(clean[i + 1] ?? "A") << 12) | (A.indexOf(clean[i + 2] ?? "A") << 6) | A.indexOf(clean[i + 3] ?? "A");
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

const importImage: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const url = str(ctx.params, "url");
    const b64 = typeof ctx.params.base64 === "string" ? ctx.params.base64 : undefined;
    const renderId = str(ctx.params, "renderNodeId");
    const targetId = str(ctx.params, "nodeId");
    let image: FigmaImage;
    let parent: NodeLikeW | undefined;
    let target: NodeLikeW | undefined;
    let sizing: ReturnType<typeof parseSizing>;
    // With renderNodeId: what was rendered, and the size a new rectangle takes by default.
    let rendered: { nodeId: string; width: number; height: number; size: { width: number; height: number } } | undefined;
    const scaleMode = SCALE[(str(ctx.params, "scaleMode") ?? "fill").toLowerCase()];
    try {
      if (!scaleMode) throw new BridgeError(ErrorCode.INVALID_PARAM, "`scaleMode` must be fill, fit, crop or tile.");
      if ((url ? 1 : 0) + (b64 ? 1 : 0) + (renderId ? 1 : 0) !== 1) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "Give exactly one image source: `url`, `path` or `renderNodeId`.");
      }
      if (url && !/^https?:\/\//i.test(url)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`url` must be http(s). For a local file use `path`.");
      const renderWidth = ctx.params.renderWidth;
      if (renderWidth !== undefined) {
        if (!renderId) throw new BridgeError(ErrorCode.INVALID_PARAM, "`renderWidth` sizes a `renderNodeId` render; give renderNodeId, or leave renderWidth out.");
        if (typeof renderWidth !== "number" || !Number.isInteger(renderWidth) || renderWidth < 16 || renderWidth > MAX_IMAGE_SIDE) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `\`renderWidth\` must be a whole number of pixels from 16 to ${MAX_IMAGE_SIDE}.`);
        }
      }
      sizing = parseSizing(ctx.params.sizing);
      if (targetId) {
        target = (await figma.getNodeByIdAsync(targetId)) ?? undefined;
        if (!target) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${targetId}\`.`);
        if (!("fills" in (target as object))) throw new BridgeError(ErrorCode.INVALID_PARAM, `A ${target.type} cannot take an image fill.`);
      } else {
        parent = await parentFor(figma, str(ctx.params, "parentId"));
      }
      // The image first: if Figma cannot read or render it, nothing has been created.
      if (renderId) {
        const source = await renderSource(figma, renderId, "renderNodeId");
        // Twice the size it is shown at, so it stays sharp on a 2x screen; a
        // default never exceeds the cap, an explicit width over it is refused.
        const shownW = num(ctx.params, "width");
        const shownH = num(ctx.params, "height");
        const targetW = target ? (target as unknown as { width?: unknown }).width : undefined;
        const shown = typeof targetW === "number" && targetW > 0 ? targetW
          : shownW ?? (shownH !== undefined ? (shownH * source.width) / source.height : source.width);
        const width = typeof renderWidth === "number"
          ? renderWidth
          : Math.max(1, Math.floor(Math.min(2 * shown, MAX_IMAGE_SIDE, (MAX_IMAGE_SIDE * source.width) / source.height)));
        const r = await renderToImage(figma, source, width, "renderNodeId");
        image = r.image;
        rendered = { nodeId: source.id, width: r.width, height: r.height, size: { width: source.width, height: source.height } };
      } else {
        try {
          image = url
            ? await (figma.createImageAsync as (u: string) => Promise<typeof image>).call(figma, url)
            : (figma.createImage as (d: Uint8Array) => typeof image).call(figma, decodeBase64(b64!));
        } catch (err) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma could not use this image: ${err instanceof Error ? err.message : String(err)}`, {
            hint: "PNG, JPEG or GIF, at most 4096 px on a side.",
          });
        }
      }
    } catch (err) {
      failedBeforeCreating(err);
    }
    const from = rendered ? { rendered: { nodeId: rendered.nodeId, width: rendered.width, height: rendered.height } } : {};
    const paint = { type: "IMAGE", imageHash: image.hash, scaleMode };

    if (target) {
      (target as unknown as Any).fills = [paint];
      return { id: target.id, name: target.name, imageHash: image.hash, applied: "fill", ...from };
    }
    // A new rectangle at the image's own proportions unless told otherwise; a
    // render defaults to the rendered node's own size, not its 2x pixels.
    const natural = rendered ? { width: rendered.width, height: rendered.height } : await image.getSizeAsync();
    const base = rendered ? rendered.size : natural;
    const w = num(ctx.params, "width");
    const h = num(ctx.params, "height");
    const width = w ?? (h !== undefined ? (h * base.width) / base.height : base.width);
    const height = h ?? (w !== undefined ? (w * base.height) / base.width : base.height);
    const rect = figma.createRectangle();
    const r = rect as unknown as Any & { resize(w: number, h: number): void };
    r.resize(Math.max(1, width), Math.max(1, height));
    r.fills = [paint];
    if (typeof ctx.params.cornerRadius === "number") r.cornerRadius = ctx.params.cornerRadius;
    rect.name = str(ctx.params, "name") ?? "Image";
    append(parent!, rect);
    place(rect, ctx);
    try {
      applySizing(rect, sizing);
    } catch (err) {
      rect.remove?.();
      failedBeforeCreating(err);
    }
    return { id: rect.id, name: rect.name, type: rect.type, width: Math.round(width), height: Math.round(height), imageHash: image.hash, natural, ...from };
  },
};

export const ASSET_OPS: Record<string, PluginOp> = {
  import_svg: importSvg,
  import_image: importImage,
};
