// The export group (tools.md § export), Phase 1 subset: figma_export_node.
//
// The plugin renders and encodes; it never writes a file. `saveTo` never
// reaches it (protocol.md §3 — bridge-only parameters): the bridge holds it,
// validates the path and writes. A payload over `chunkBytes` is split into
// `chunk` frames by ui.ts, so nothing here is rejected for being large.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { OpContext, PluginOp } from "./index.js";
import { num, r2 } from "../dialect.js";
import { bool, byId, selectionOf, str, strList, walk, type FigmaLike, type NodeLike } from "../read.js";
import { tryGet } from "../safe.js";
import { requireGrid } from "../slides/grid.js";

const api = () => (globalThis as unknown as { figma: FigmaLike }).figma;

/**
 * `nodeId`, or else the one selected layer. Never the page: a page render of
 * a real file is enormous, and "what I selected" is what a screenshot of the
 * selection means (the official get_screenshot works the same way).
 */
async function exportTarget(params: Record<string, unknown>): Promise<NodeLike> {
  const id = str(params, "nodeId");
  if (id) return byId(api(), id);
  const sel = selectionOf(api());
  if (sel.length === 1) return sel[0]!;
  throw new BridgeError(ErrorCode.INVALID_PARAM, `Pass nodeId, or select exactly one layer (${sel.length} selected).`);
}

/**
 * Pixel size of an encoded PNG or JPEG, read from its header: PNG's IHDR
 * (bytes 16–23, big-endian) or the first JPEG start-of-frame marker. Anything
 * else is undefined — the caller estimates and says so.
 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const b = bytes;
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const u32 = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
    return { width: u32(16), height: u32(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      const len = (b[i + 2]! << 8) + b[i + 3]!;
      // SOF0–SOF15 carry the frame size; C4 (huffman), C8 (reserved) and CC (arithmetic) do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b[i + 5]! << 8) + b[i + 6]!, width: (b[i + 7]! << 8) + b[i + 8]! };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

type Box = { x: number; y: number; width: number; height: number };

/** Where and how big the node is, in the dialect every read uses. */
function boundsOf(node: NodeLike): Box | undefined {
  const n = node as unknown as Record<string, unknown>;
  const [x, y, w, h] = [num(n.x), num(n.y), num(n.width), num(n.height)];
  return w !== undefined && h !== undefined ? { x: r2(x ?? 0), y: r2(y ?? 0), width: r2(w), height: r2(h) } : undefined;
}

function rectOf(v: unknown): Box | undefined {
  const r = v as Record<string, unknown> | null | undefined;
  const [x, y, w, h] = [num(r?.x), num(r?.y), num(r?.width), num(r?.height)];
  return x !== undefined && y !== undefined && w !== undefined && h !== undefined ? { x, y, width: w, height: h } : undefined;
}

function union(a: Box | undefined, b: Box | undefined): Box | undefined {
  if (!a || !b) return a ?? b;
  const [x, y] = [Math.min(a.x, b.x), Math.min(a.y, b.y)];
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * The box the picture covers, which is what a pixel cap must be worked out
 * from [C-126]. width/height are the size before rotation, and shadows and
 * thick strokes render past them — absoluteRenderBounds counts both, and is
 * null on an invisible node. On text it can be the glyphs alone (check.ts
 * relies on that), so the layer's own box is kept in the union: a box
 * measured too big caps a little early, one measured too small lets an
 * oversized picture through. A page has no width or height at all (PageNode
 * has no DimensionAndPositionMixin), so its box is the union of its visible
 * children's; an empty page has none.
 */
function renderBox(node: NodeLike): Box | undefined {
  const drawn = (n: NodeLike) => {
    const m = n as unknown as Record<string, unknown>;
    return union(rectOf(m.absoluteRenderBounds), rectOf(m.absoluteBoundingBox)) ?? boundsOf(n);
  };
  if (node.type !== "PAGE") return drawn(node);
  return (node.children ?? []).reduce<Box | undefined>(
    (box, c) => ((c as unknown as { visible?: unknown }).visible === false ? box : union(box, drawn(c))),
    undefined,
  );
}

export const EXPORT_MIME = {
  PNG: "image/png",
  JPG: "image/jpeg",
  SVG: "image/svg+xml",
  PDF: "application/pdf",
} as const;
export type ExportFormat = keyof typeof EXPORT_MIME;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Bytes per encoding slice — a multiple of 3, so slices concatenate without padding in between. */
const SLICE = 3 * 128 * 1024;

/**
 * Base64 in plain JS, one slice at a time with a yield between slices. `btoa`
 * does exist in the sandbox on this Figma version (Phase 0 API probe), but it
 * takes a binary string, not bytes, and one call on a multi-megabyte PNG would
 * hold the main thread for the whole run.
 */
export async function encodeBase64(bytes: Uint8Array, yieldToHost: () => Promise<void> = async () => {}): Promise<string> {
  const parts: string[] = [];
  for (let start = 0; start < bytes.length; start += SLICE) {
    const end = Math.min(start + SLICE, bytes.length);
    const out: string[] = [];
    let i = start;
    for (; i + 2 < end; i += 3) {
      const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
      out.push(ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + ALPHABET[(n >> 6) & 63]! + ALPHABET[n & 63]!);
    }
    if (i < end) {
      const rest = end - i; // 1 or 2 — only ever in the final slice
      const n = (bytes[i]! << 16) | (rest === 2 ? bytes[i + 1]! << 8 : 0);
      out.push(ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]! + (rest === 2 ? ALPHABET[(n >> 6) & 63]! : "=") + "=");
    }
    parts.push(out.join(""));
    if (end < bytes.length) await yieldToHost();
  }
  return parts.join("");
}

type Exportable = { exportAsync(settings: Record<string, unknown>): Promise<Uint8Array> };

const exportNode: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const format = (str(ctx.params, "format") ?? "PNG").toUpperCase();
    if (!(format in EXPORT_MIME)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`format` must be PNG, JPG, SVG or PDF.");
    }
    const raw = ctx.params.scale;
    if (raw !== undefined && (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`scale` must be a number greater than 0.");
    }
    const maxRaw = ctx.params.maxSize;
    if (maxRaw !== undefined && (typeof maxRaw !== "number" || !Number.isFinite(maxRaw) || maxRaw < 1)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`maxSize` must be a number of pixels, 1 or more.");
    }
    const node = await exportTarget(ctx.params);
    if (typeof (node as Partial<Exportable>).exportAsync !== "function") {
      throw new BridgeError(ErrorCode.UNSUPPORTED, `A ${node.type} cannot be exported — pick a frame, group or layer inside it.`);
    }
    // A scale constraint belongs to raster formats; vector output has no pixel size.
    const raster = format === "PNG" || format === "JPG";
    const box = boundsOf(node);
    // Sized on what renders, not on width/height: a page has none, and a
    // 1600×200 banner turned 90° capped on its unrotated width is 1024×8192.
    const drawn = raster ? renderBox(node) : undefined;
    let scale = typeof raw === "number" ? raw : 1;
    let constraint: { type: string; value: number } = { type: "SCALE", value: scale };
    let capped = false;
    // The longest side is held to maxSize, the way the official screenshot
    // caps at 1024 px [C-092] — an uncapped 1440×5000 page breaks a vision
    // request. Only when no scale was asked for (an explicit scale is a
    // deliberate size), and never upward: a small node renders at 1×.
    if (raster && raw === undefined && typeof maxRaw === "number" && drawn) {
      const long = Math.max(drawn.width, drawn.height);
      if (long > maxRaw) {
        constraint = { type: drawn.width >= drawn.height ? "WIDTH" : "HEIGHT", value: Math.floor(maxRaw) };
        scale = maxRaw / long;
        capped = true;
      }
    }
    const settings = raster ? { format, constraint } : { format };
    ctx.progress(0, undefined, "rendering");
    const bytes = await (node as unknown as Exportable).exportAsync(settings);
    ctx.progress(0, bytes.length, "encoding");
    const base64 = await encodeBase64(bytes, ctx.yieldToHost);
    const px = raster ? imageSize(bytes) : undefined;
    return {
      nodeId: node.id,
      name: node.name,
      format,
      ...(raster ? { scale: capped ? r2(scale) : scale } : {}),
      mime: EXPORT_MIME[format as ExportFormat],
      bytes: bytes.length,
      ...(box ? { bounds: box } : {}),
      ...(px ? { pixelWidth: px.width, pixelHeight: px.height } : {}),
      // No header to read: the size the constraint asked for, marked as such.
      ...(raster && !px && drawn ? { pixelWidth: Math.round(drawn.width * scale), pixelHeight: Math.round(drawn.height * scale), pixelEstimate: true } : {}),
      ...(capped ? { capped: true } : {}),
      base64,
    };
  },
};

/**
 * Batch export to files.
 *
 * The path handling is the bridge's job (protocol.md §3: `dir` never reaches the
 * plugin, the bridge validates and writes). This op renders and encodes only, so
 * a sandbox with no filesystem access can still serve it.
 *
 * Sequential by design: rendering several large frames at once is what makes
 * Figma stutter, and the loop yields between nodes so the editor stays alive.
 */
const saveScreenshots: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const raw = ctx.params.nodeIds;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeIds` must be a non-empty array.");
    }
    const ids = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
    const format = (str(ctx.params, "format") ?? "PNG").toUpperCase();
    if (!["PNG", "JPG", "SVG"].includes(format)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`format` must be PNG, JPG or SVG for a batch of screenshots.");
    }
    const scaleRaw = ctx.params.scale;
    const scale = scaleRaw === undefined ? 2 : scaleRaw;
    if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`scale` must be a number greater than 0.");
    }
    const raster = format === "PNG" || format === "JPG";
    const settings = raster ? { format, constraint: { type: "SCALE", value: scale } } : { format };

    const shots: Array<{ nodeId: string; name: string; mime: string; bytes: number; base64: string }> = [];
    const failed: Array<{ nodeId: string; error: string }> = [];

    for (let i = 0; i < ids.length; i++) {
      const nodeId = ids[i]!;
      ctx.progress(i, ids.length, "rendering");
      try {
        const node = await byId(api(), nodeId);
        if (typeof (node as Partial<Exportable>).exportAsync !== "function") {
          throw new BridgeError(ErrorCode.UNSUPPORTED, `a ${node.type} cannot be exported`);
        }
        const bytes = await (node as unknown as Exportable).exportAsync(settings);
        const base64 = await encodeBase64(bytes, ctx.yieldToHost);
        shots.push({
          nodeId,
          name: node.name,
          mime: EXPORT_MIME[format as ExportFormat],
          bytes: bytes.length,
          base64,
        });
      } catch (err) {
        // Per-item: one unexportable node must not lose the other 39.
        failed.push({ nodeId, error: err instanceof Error ? err.message : String(err) });
      }
      await ctx.yieldToHost();
    }

    ctx.progress(ids.length, ids.length, "done");
    return { format, ...(raster ? { scale } : {}), count: shots.length, shots, failed };
  },
};

/**
 * A Slides deck in presentation order: row by row, slide by slide, from the
 * grid's node tree. A skipped slide is left out of playback (isSkippedSlide,
 * d.ts:12320) [C-136], so it is left out here unless asked for.
 */
export function deckOrder(includeSkipped: boolean): { slideIds: string[]; skippedSlides: string[] } {
  const read = requireGrid("`deck`");
  const slideIds: string[] = [];
  const skippedSlides: string[] = [];
  for (const r of read.rows) {
    for (const s of r.slides) {
      const skipped = tryGet(s, "isSkippedSlide");
      if (!includeSkipped && skipped.ok && skipped.value === true) skippedSlides.push(s.id);
      else slideIds.push(s.id);
    }
  }
  return { slideIds, skippedSlides };
}

/**
 * `nodeIds`, or with `deck` every slide of a Slides file in order — exactly one
 * of the two. The server checks the same first (tools/export.ts pdfParams);
 * this is the same rule for a caller that reaches the plugin another way.
 */
function pdfTargets(params: Record<string, unknown>): { ids: string[]; deck?: { slideIds: string[]; skippedSlides: string[] } } {
  const raw = params.nodeIds;
  const deck = params.deck;
  if (raw !== undefined && deck !== undefined) throw new BridgeError(ErrorCode.INVALID_PARAM, "Pass `nodeIds` or `deck`, not both.");
  if (params.includeSkipped !== undefined && deck !== true) throw new BridgeError(ErrorCode.INVALID_PARAM, "`includeSkipped` goes with `deck: true`.");
  if (deck !== undefined) {
    if (deck !== true) throw new BridgeError(ErrorCode.INVALID_PARAM, "`deck` must be true; to export some frames pass `nodeIds`.");
    const order = deckOrder(params.includeSkipped === true);
    if (!order.slideIds.length) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "The deck has no slides to export.", {
        hint: order.skippedSlides.length ? `All ${order.skippedSlides.length} slide(s) are skipped: pass includeSkipped: true.` : "figma_create_slides adds slides.",
      });
    }
    return { ids: order.slideIds, deck: order };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeIds` must be a non-empty array of frames.", { hint: "In a Figma Slides file, `deck: true` exports every slide in order." });
  }
  return { ids: raw.filter((v): v is string => typeof v === "string" && v.length > 0) };
}

/**
 * Several frames as one multi-page PDF.
 *
 * Each frame is exported as its own single-page PDF by `exportAsync`, and the
 * bridge merges them (it holds pdf-lib; the sandbox has no filesystem and no
 * dependency loading). The plugin's part is therefore N renders, done
 * sequentially with a yield between each.
 */
const exportFramesToPdf: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const { ids, deck } = pdfTargets(ctx.params);
    const parts: Array<{ nodeId: string; name: string; bytes: number; base64: string }> = [];
    const failed: Array<{ nodeId: string; error: string }> = [];

    for (let i = 0; i < ids.length; i++) {
      const nodeId = ids[i]!;
      ctx.progress(i, ids.length, "rendering");
      try {
        const node = await byId(api(), nodeId);
        if (typeof (node as Partial<Exportable>).exportAsync !== "function") {
          throw new BridgeError(ErrorCode.UNSUPPORTED, `a ${node.type} cannot be exported as PDF`);
        }
        const bytes = await (node as unknown as Exportable).exportAsync({ format: "PDF" });
        parts.push({ nodeId, name: node.name, bytes: bytes.length, base64: await encodeBase64(bytes, ctx.yieldToHost) });
      } catch (err) {
        failed.push({ nodeId, error: err instanceof Error ? err.message : String(err) });
      }
      await ctx.yieldToHost();
    }

    ctx.progress(ids.length, ids.length, "done");
    return { count: parts.length, pages: parts, failed, ...(deck ? { slideIds: deck.slideIds, skippedSlides: deck.skippedSlides } : {}) };
  },
};

// ── download_assets ──────────────────────────────────────────────────────────

/** The official download_assets limits: 20 raw images per call, and a flag when there were more [C-093]. */
export const ASSET_LIMITS = { nodes: 50, rawImages: 20, walkNodes: 2000, totalBytes: 256 * 1024 * 1024 } as const;

/** One file inside the packed payload; the bridge slices `base64` by offset and length. */
export interface AssetFile {
  kind: "render" | "image";
  offset: number;
  length: number;
  nodeId?: string;
  name?: string;
  format?: string;
  suffix?: string;
  imageHash?: string;
  width?: number;
  height?: number;
  usedBy?: string[];
}

type Setting = { format: string; suffix?: string; [k: string]: unknown };

/**
 * The renders a node asks for: its own export settings — the presets a
 * designer set up for handoff, each with its format and suffix — or one
 * default render when it has none (or the caller opted out).
 */
function settingsFor(node: NodeLike, useExportSettings: boolean, format: string, scale: number): { list: Setting[]; skipped: string[] } {
  const own = (node as unknown as { exportSettings?: ReadonlyArray<Setting> }).exportSettings;
  let skipped: string[] = [];
  if (useExportSettings && Array.isArray(own) && own.length > 0) {
    const list = own.filter((s) => s && typeof s.format === "string" && s.format in EXPORT_MIME);
    skipped = own.filter((s) => !list.includes(s)).map((s) => String(s?.format));
    if (list.length) return { list: list.map((s) => ({ ...s })), skipped };
  }
  if (format === "PNG" || format === "JPG") return { list: [{ format, constraint: { type: "SCALE", value: scale } }], skipped };
  return { list: [{ format }], skipped };
}

/**
 * Renders plus the ORIGINAL image bytes, for implementing a design with its
 * real assets. A render of a hero frame bakes its headline into the picture;
 * the image fill under it is the asset the code needs, and only
 * getImageByHash returns it untouched [C-093].
 *
 * Everything travels as ONE byte array with a manifest of offsets, so the
 * existing chunking (ui.ts, protocol.md §2) carries it whatever its size; the
 * bridge writes the files. Per item: one node that fails does not lose the rest.
 */
const downloadAssets: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const ids = strList(ctx.params, "nodeIds");
    if (!ids) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeIds` must be a non-empty array of node ids.");
    if (ids.length > ASSET_LIMITS.nodes) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`nodeIds\` takes at most ${ASSET_LIMITS.nodes} nodes per call.`);
    const format = (str(ctx.params, "format") ?? "PNG").toUpperCase();
    if (!(format in EXPORT_MIME)) throw new BridgeError(ErrorCode.INVALID_PARAM, "`format` must be PNG, JPG, SVG or PDF.");
    const rawScale = ctx.params.scale;
    const scale = rawScale === undefined ? 2 : rawScale;
    if (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0.01 || scale > 4) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`scale` must be between 0.01 and 4.");
    }
    const useExportSettings = bool(ctx.params, "useExportSettings", true);
    const wantImages = bool(ctx.params, "rawImages", true);

    const parts: Uint8Array[] = [];
    const files: AssetFile[] = [];
    let offset = 0;
    let truncated = false;
    const add = (bytes: Uint8Array, file: Omit<AssetFile, "offset" | "length">): boolean => {
      if (offset + bytes.length > ASSET_LIMITS.totalBytes) {
        truncated = true;
        return false;
      }
      parts.push(bytes);
      files.push({ ...file, offset, length: bytes.length });
      offset += bytes.length;
      return true;
    };

    const items: Array<{ nodeId: string; name?: string; ok: boolean; error?: string; skipped?: string[] }> = [];
    const roots: NodeLike[] = [];
    for (let i = 0; i < ids.length && !truncated; i++) {
      const nodeId = ids[i]!;
      ctx.progress(i, ids.length, "rendering");
      if (ctx.isCancelled()) throw new BridgeError(ErrorCode.CANCELLED, "Cancelled while rendering assets.");
      try {
        const node = await byId(api(), nodeId);
        roots.push(node);
        if (typeof (node as Partial<Exportable>).exportAsync !== "function") throw new Error(`a ${node.type} cannot be exported`);
        const { list, skipped } = settingsFor(node, useExportSettings, format, scale);
        for (const s of list) {
          const bytes = await (node as unknown as Exportable).exportAsync(s);
          const f = s.format.toUpperCase();
          const px = f === "PNG" || f === "JPG" ? imageSize(bytes) : undefined;
          if (!add(bytes, { kind: "render", nodeId: node.id, name: node.name, format: f, ...(s.suffix ? { suffix: s.suffix } : {}), ...(px ?? {}) })) break;
        }
        items.push({ nodeId: node.id, name: node.name, ok: true, ...(skipped.length ? { skipped } : {}) });
      } catch (err) {
        items.push({ nodeId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      await ctx.yieldToHost();
    }

    const imageErrors: Array<{ imageHash: string; error: string; usedBy: string[] }> = [];
    let rawImagesTruncated = false;
    let rawImagesNote: string | undefined;
    if (wantImages && !truncated) {
      // hash → the layers whose fill shows it; first-seen order, so a re-run picks the same 20.
      const used = new Map<string, string[]>();
      for (const root of roots) {
        let seen = 0;
        await walk(
          root,
          (n) => {
            if (++seen > ASSET_LIMITS.walkNodes) {
              rawImagesTruncated = true;
              return false;
            }
            const fills = (n as unknown as { fills?: unknown }).fills;
            if (!Array.isArray(fills)) return; // none, or figma.mixed on mixed text
            for (const p of fills as Array<{ type?: string; imageHash?: string | null; visible?: boolean }>) {
              if (p?.type !== "IMAGE" || !p.imageHash || p.visible === false) continue;
              const by = used.get(p.imageHash) ?? [];
              if (!by.includes(n.id)) by.push(n.id);
              used.set(p.imageHash, by);
            }
          },
          ctx,
          { yieldEvery: 200 },
        );
      }
      const hashes = [...used.keys()];
      if (hashes.length > ASSET_LIMITS.rawImages) rawImagesTruncated = true;
      const getImage = (api() as unknown as { getImageByHash?: (h: string) => { getBytesAsync(): Promise<Uint8Array>; getSizeAsync(): Promise<{ width: number; height: number }> } | null }).getImageByHash;
      if (hashes.length && typeof getImage !== "function") {
        rawImagesNote = "figma.getImageByHash is not available in this editor, so original image bytes cannot be read.";
      } else {
        for (const hash of hashes.slice(0, ASSET_LIMITS.rawImages)) {
          const usedBy = used.get(hash)!;
          try {
            const img = getImage!.call(api(), hash);
            if (!img) throw new Error("no image with this hash in the file");
            const bytes = await img.getBytesAsync();
            const size = await img.getSizeAsync();
            if (!add(bytes, { kind: "image", imageHash: hash, width: size.width, height: size.height, usedBy })) break;
          } catch (err) {
            imageErrors.push({ imageHash: hash, error: err instanceof Error ? err.message : String(err), usedBy });
          }
          await ctx.yieldToHost();
        }
      }
    }

    const packed = new Uint8Array(offset);
    let at = 0;
    for (const p of parts) {
      packed.set(p, at);
      at += p.length;
    }
    ctx.progress(ids.length, ids.length, "encoding");
    return {
      items,
      files,
      ...(imageErrors.length ? { imageErrors } : {}),
      ...(rawImagesTruncated ? { rawImagesTruncated: true } : {}),
      ...(rawImagesNote ? { rawImagesNote } : {}),
      ...(truncated ? { truncated: true } : {}),
      totalBytes: offset,
      base64: await encodeBase64(packed, ctx.yieldToHost),
    };
  },
};

export const EXPORT_OPS: Record<string, PluginOp> = {
  export_node: exportNode,
  save_screenshots: saveScreenshots,
  export_frames_to_pdf: exportFramesToPdf,
  download_assets: downloadAssets,
};
