// The export group on the server side (tools.md § export), Phase 1 subset:
// figma_export_node. Batch export and PDF merging arrive in Phase 4 (spec §12).
//
// `saveTo` is bridge-only (protocol.md §3): it is validated here before Figma
// is asked to render anything, and never forwarded — the plugin only returns
// bytes. The shaping follows spec §8 "Screenshot / export":
//
//   - no saveTo, PNG/JPG ≤ 5 MB → an image content block the model can see;
//   - no saveTo, SVG ≤ 5 MB     → the markup as text;
//   - saveTo, PDF, or > 5 MB   → a file in an allowed root; the result is its path.

import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { OPS } from "../../shared/ops.js";
import type { Bridge } from "../bridge.js";
import {
  assetFileName,
  defaultExportName,
  EXTENSION,
  formatFromPath,
  resolveSavePath,
  sniffExt,
  writeExport,
  type ExportRoots,
} from "../exports.js";
import { bytesOf } from "../binary.js";
import { withProcessWarnings } from "../motion-process.js";
import { errorResult, okResult } from "../results.js";
import { mergePdfs } from "../pdf.js";
import { fileOf, finalExportGate, type RoleGate, type RoleProcess } from "../role-process.js";
import { addressCall, forwardTool, type Extra } from "./forward.js";
import { fitDescription } from "./params.js";

/** Above this, a render goes to a file instead of into the context (spec §8). */
export const INLINE_LIMIT = 5 * 1024 * 1024;

/**
 * The longest side of an inline screenshot when the caller asks for no size —
 * the cap the official screenshot applies [C-092]. A full-scale 1440×5000 page
 * is past what a vision request takes once several images are in play.
 */
export const DEFAULT_MAX_SIZE = 1024;

const FORMATS = ["PNG", "JPG", "SVG", "PDF"] as const;

/**
 * This group's own refusals, made before Figma is asked. Every export tool only
 * reads, so a retry with a fixed argument needs no canvas read first [C-096];
 * without the flag an agent re-read the canvas just to correct a path.
 */
const refuse = (err: unknown): CallToolResult => errorResult(err, { readOnly: true, unchanged: true });

interface ExportData {
  nodeId: string;
  name: string;
  format: string;
  scale?: number;
  mime: string;
  bytes: number;
  bounds?: { x: number; y: number; width: number; height: number };
  pixelWidth?: number;
  pixelHeight?: number;
  pixelEstimate?: true;
  capped?: true;
}

/** The plugin's export and its bytes: inline `base64`, or `binary` once the bridge reassembled chunks (binary.ts). */
function asExport(data: unknown): { d: ExportData; bytes: Buffer } {
  const d = data as Partial<ExportData> | null;
  const bytes = bytesOf(data);
  if (!d || typeof d !== "object" || !bytes || typeof d.format !== "string") {
    throw new BridgeError(ErrorCode.INTERNAL, "The plugin's export result carried no bytes.");
  }
  return { d: d as ExportData, bytes };
}

/** Turn the plugin's bytes into the MCP result spec §8 describes. */
export async function shapeExport(data: unknown, saveTo: string | undefined, roots: ExportRoots): Promise<CallToolResult> {
  const { d, bytes } = asExport(data);
  // Where the node is and how big the picture is: the image alone says neither.
  const meta = {
    nodeId: d.nodeId,
    name: d.name,
    format: d.format,
    ...(d.scale !== undefined ? { scale: d.scale } : {}),
    mime: d.mime,
    bytes: d.bytes,
    ...(d.bounds ? { bounds: d.bounds } : {}),
    ...(d.pixelWidth !== undefined ? { pixelWidth: d.pixelWidth, pixelHeight: d.pixelHeight } : {}),
    ...(d.pixelEstimate ? { pixelEstimate: true } : {}),
    ...(d.capped ? { capped: true } : {}),
  };
  const small = d.bytes <= INLINE_LIMIT;
  if (saveTo === undefined && small && (d.format === "PNG" || d.format === "JPG")) {
    // No structuredContent: a client that prefers it over `content` would drop the image.
    return {
      content: [
        { type: "image", data: bytes.toString("base64"), mimeType: d.mime },
        { type: "text", text: JSON.stringify(meta) },
      ],
    };
  }
  if (saveTo === undefined && small && d.format === "SVG") {
    return {
      content: [
        { type: "text", text: JSON.stringify(meta) },
        { type: "text", text: bytes.toString("utf8") },
      ],
    };
  }
  const path = await writeExport(saveTo ?? defaultExportName(d.name, d.nodeId, d.format), bytes, roots);
  const why =
    saveTo !== undefined ? undefined : d.format === "PDF" ? "PDF is always written to a file" : "over 5 MB, so written to a file instead of inline";
  return okResult({ ...meta, path, ...(why ? { note: why } : {}) });
}

/** `roles` gates a final export on its deliverables' sign-off (role-process.ts); without it `final` changes nothing. */
export function registerExport(server: McpServer, bridge: Bridge, roots: ExportRoots, wanted: (op: string) => boolean, roles?: RoleProcess): void {
  registerExportNode(server, bridge, roots, wanted, roles);
  registerSaveScreenshots(server, bridge, roots, wanted);
  registerFramesToPdf(server, bridge, roots, wanted, roles);
  registerDownloadAssets(server, bridge, roots, wanted);
}

/** `final` on figma_export_node and figma_export_frames_to_pdf, as figma_export_video takes it (spec §3.7). */
const FINAL = z
  .boolean()
  .optional()
  .describe("The delivery. Under BRIDGE_PROCESS=strict a node that belongs to a brief needs a passing figma_sign_off newer than its last change. Default false: a render to judge, never gated.");

/**
 * The final-export gate for the nodes an export names (role-process.ts
 * finalExportGate), after the tool's own checks and before Figma renders
 * anything. Addressed first, so a pasted link names the id the plugin reads.
 * With no ids: the deck's page, or the one selected layer; when there is no
 * telling, strict refuses and guided warns.
 */
async function gateFinal(
  bridge: Bridge,
  roles: RoleProcess,
  nodeIds: readonly string[] | undefined,
  session: string | undefined,
  again: (ids: readonly string[]) => string,
  opts: { deck?: boolean; signal: AbortSignal },
): Promise<RoleGate> {
  const addressed = await addressCall(bridge, "export_node", nodeIds ? { nodeIds: [...nodeIds] } : {}, session);
  const file = await fileOf(bridge, addressed.session);
  let ids = (addressed.params.nodeIds as string[] | undefined) ?? [];
  if (!nodeIds) ids = opts.deck ? (file.pageId ? [file.pageId] : []) : file.selection.length === 1 ? [file.selection[0]!] : [];
  if (ids.length === 0) {
    if (roles.modeFor(file, true).mode === "strict") {
      return {
        refusal: new BridgeError(ErrorCode.INVALID_PARAM, "A final export names its deliverable, so its sign-off can be read: pass `nodeId` (or select one layer).", {
          partial: { created: [] },
        }),
        warnings: [],
      };
    }
    return { warnings: ["a final export names its deliverable, so its sign-off can be read: this one named none and was not checked."] };
  }
  return finalExportGate(roles, bridge, ids, addressed.session, again(ids), { ...(opts.deck ? { deck: true } : {}), signal: opts.signal });
}

/** What the plugin's download_assets op returns (src/plugin/ops/export.ts). */
interface AssetsData {
  items?: Array<{ nodeId: string; name?: string; ok: boolean; error?: string; skipped?: string[] }>;
  files?: Array<{
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
  }>;
  imageErrors?: Array<{ imageHash: string; error: string; usedBy: string[] }>;
  rawImagesTruncated?: boolean;
  rawImagesNote?: string;
  truncated?: boolean;
  totalBytes?: number;
  base64?: string;
}

/**
 * Write what download_assets rendered and read: renders under deterministic
 * names (a re-run replaces them), original images under their hash with the
 * extension their own bytes declare. One payload, decoded once, sliced by the
 * manifest. A file that cannot be written fails its own item only.
 */
export async function shapeAssets(data: unknown, dir: string | undefined, roots: ExportRoots): Promise<CallToolResult> {
  const d = (data ?? {}) as AssetsData;
  const all = bytesOf(d);
  if (!all || !Array.isArray(d.files)) {
    throw new BridgeError(ErrorCode.INTERNAL, "The plugin's download_assets result carried no payload.");
  }
  const prefix = dir !== undefined ? `${dir.replace(/[\\/]+$/, "")}/` : "";
  const items = (d.items ?? []).map((i) => ({ ...i, files: [] as Array<Record<string, unknown>> }));
  const byNode = new Map(items.map((i) => [i.nodeId, i]));
  const rawImages: Array<Record<string, unknown>> = [];
  const taken = new Set<string>();
  let written = 0;
  for (const f of d.files) {
    const bytes = all.subarray(f.offset, f.offset + f.length);
    let name: string;
    if (f.kind === "image") name = `${f.imageHash ?? "image"}${sniffExt(bytes)}`;
    else {
      const base = assetFileName(f.name ?? "node", f.nodeId ?? "", f.suffix, EXTENSION[f.format ?? ""] ?? ".bin");
      name = base;
      // Two presets with the same suffix would land on one file; keep both.
      for (let n = 2; taken.has(name); n++) name = base.replace(/(\.[^.]+)$/, `-${n}$1`);
    }
    taken.add(name);
    try {
      const path = await writeExport(prefix + name, bytes, roots);
      written += bytes.length;
      if (f.kind === "image") {
        rawImages.push({ imageHash: f.imageHash, path, bytes: bytes.length, width: f.width, height: f.height, usedBy: f.usedBy ?? [] });
      } else {
        byNode.get(f.nodeId ?? "")?.files.push({
          kind: "render",
          path,
          bytes: bytes.length,
          format: f.format,
          ...(f.suffix ? { suffix: f.suffix } : {}),
          ...(f.width !== undefined ? { width: f.width, height: f.height } : {}),
        });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (f.kind === "image") rawImages.push({ imageHash: f.imageHash, error, usedBy: f.usedBy ?? [] });
      else {
        const item = byNode.get(f.nodeId ?? "");
        if (item) Object.assign(item, { ok: false, error });
      }
    }
  }
  for (const e of d.imageErrors ?? []) rawImages.push({ imageHash: e.imageHash, error: e.error, usedBy: e.usedBy });
  return okResult({
    dir: dirname(await resolveSavePath(`${prefix}probe.png`, roots)),
    items: items.map((i) => (i.files.length ? i : (({ files: _f, ...rest }) => rest)(i))),
    rawImages,
    ...(d.rawImagesTruncated ? { rawImagesTruncated: true } : {}),
    ...(d.rawImagesNote ? { rawImagesNote: d.rawImagesNote } : {}),
    ...(d.truncated ? { truncated: true, note: "Stopped at 256 MB; ask for fewer nodes per call." } : {}),
    totalBytes: written,
  });
}

/**
 * The asset half of design-to-code: each node's renders (its own export
 * presets, or one default) plus the original bytes of every image fill in its
 * subtree, written to disk [C-093]. Not a screenshot — figma_export_node is.
 */
export function registerDownloadAssets(server: McpServer, bridge: Bridge, roots: ExportRoots, wanted: (op: string) => boolean): void {
  if (!wanted("download_assets")) return;
  const info = OPS.get("download_assets");
  server.registerTool(
    "figma_download_assets",
    {
      title: "Download assets",
      description: fitDescription(
        "Write a design's ASSETS to disk for implementing it in code: per node, its export presets as the designer set them " +
          "(format and suffix each), or one render in `format` at `scale` when it has none; plus the ORIGINAL bytes of every " +
          "image fill in its subtree (deduplicated by hash, at most 20 per call, `rawImagesTruncated` when there were more) — " +
          "the photo under a hero's headline without the headline baked in. Re-runs overwrite the same files. Paths follow " +
          "`figma_export_node`'s `saveTo` rules. To SEE a design use figma_export_node; this one is for files the code ships.",
      ),
      inputSchema: {
        nodeIds: z.array(z.string()).min(1).max(50).describe("Nodes (ids or Figma links) whose assets to write."),
        format: z.enum(FORMATS).optional().describe("Render format for nodes with no export presets. Default PNG."),
        scale: z.number().min(0.01).max(4).optional().describe("Raster scale for those renders, default 2. Ignored for SVG/PDF."),
        useExportSettings: z.boolean().optional().describe("Use each node's own export presets when it has any. Default true."),
        rawImages: z.boolean().optional().describe("Also write the original bytes of image fills. Default true."),
        dir: z.string().optional().describe("Directory for the files. Defaults to the export directory."),
        session: z
          .string()
          .optional()
          .describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
      },
      annotations: { readOnlyHint: info?.readOnly ?? true, destructiveHint: false, openWorldHint: false },
    },
    async (args: Record<string, unknown>, extra: Extra) => {
      const dir = typeof args.dir === "string" ? args.dir : undefined;
      // A bad destination is refused before Figma renders anything (see save_screenshots).
      try {
        await resolveSavePath(join(dir ?? "", "probe.png"), roots);
      } catch (err) {
        return refuse(err);
      }
      const params: Record<string, unknown> = { nodeIds: args.nodeIds };
      for (const k of ["format", "scale", "useExportSettings", "rawImages"]) if (args[k] !== undefined) params[k] = args[k];
      return forwardTool(bridge, "download_assets", params, extra, {
        session: args.session as string | undefined,
        shape: (data) => shapeAssets(data, dir, roots),
      });
    },
  );
}

/**
 * Batch render to files.
 *
 * The plugin renders and returns base64; the BRIDGE writes the files, because
 * the sandbox has no filesystem (C-014). The saving happens in the `shape` hook,
 * so the wire is an ordinary forwarded call.
 */
function registerSaveScreenshots(server: McpServer, bridge: Bridge, roots: ExportRoots, wanted: (op: string) => boolean): void {
  if (!wanted("save_screenshots")) return;
  const info = OPS.get("save_screenshots");
  server.registerTool(
    "figma_save_screenshots",
    {
      title: "Save screenshots",
      description: fitDescription(
        "Render several nodes to image files and return their paths — cheaper for your context than returning image data, " +
          "and the way to hand a user a set of screenshots. The plugin renders; the bridge writes, so paths follow the same " +
          "rules as `figma_export_node`'s `saveTo` (relative lands in the export directory, other folders must be in " +
          "BRIDGE_EXPORT_ROOTS). One node failing does not lose the others: the result carries `failed[]`.",
      ),
      inputSchema: {
        nodeIds: z.array(z.string()).min(1).max(200).describe("Nodes to render."),
        format: z.enum(["PNG", "JPG", "SVG"]).optional().describe("Default PNG."),
        scale: z.number().positive().optional().describe("Raster scale, default 2. Ignored for SVG."),
        dir: z.string().optional().describe("Directory for the files. Defaults to the export directory."),
        session: z
          .string()
          .optional()
          .describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
      },
      annotations: { readOnlyHint: info?.readOnly ?? true, destructiveHint: false, openWorldHint: false },
    },
    async (args: Record<string, unknown>, extra: Extra) => {
      const dir = typeof args.dir === "string" ? args.dir : undefined;
      // Validate the destination BEFORE handing anything to Figma. Rendering is
      // the expensive half of this tool, and the probe caught the version of
      // this code that rendered first and discovered the bad path at write time:
      // a wasted render, and the failure arrived as a per-item entry that looks
      // like a rendering problem rather than a path problem.
      if (dir !== undefined) {
        try {
          await resolveSavePath(join(dir, "probe.png"), roots);
        } catch (err) {
          return refuse(err);
        }
      }
      const params: Record<string, unknown> = { nodeIds: args.nodeIds };
      if (args.format !== undefined) params.format = args.format;
      if (args.scale !== undefined) params.scale = args.scale;
      return forwardTool(bridge, "save_screenshots", params, extra, {
        session: args.session as string | undefined,
        shape: async (data) => {
          const d = data as { shots?: Array<{ nodeId: string; name: string; mime: string; bytes: number; base64: string }>; failed?: unknown[]; format?: string; scale?: number };
          const shots = d.shots ?? [];
          const written: Array<{ nodeId: string; name: string; path: string; bytes: number }> = [];
          const failed: Array<{ nodeId: string; error: string }> = [...((d.failed as Array<{ nodeId: string; error: string }>) ?? [])];
          for (const shot of shots) {
            try {
              const ext = (shot.mime.split("/")[1] ?? "png").replace("svg+xml", "svg");
              const named = dir !== undefined ? `${dir.replace(/\/+$/, "")}/${defaultExportName(shot.name, shot.nodeId, (d.format ?? "PNG").toUpperCase())}` : defaultExportName(shot.name, shot.nodeId, (d.format ?? "PNG").toUpperCase());
              void ext;
              const path = await writeExport(named, Buffer.from(shot.base64, "base64"), roots);
              written.push({ nodeId: shot.nodeId, name: shot.name, path, bytes: shot.bytes });
            } catch (err) {
              failed.push({ nodeId: shot.nodeId, error: err instanceof Error ? err.message : String(err) });
            }
          }
          return okResult({
            format: d.format ?? "PNG",
            ...(d.scale !== undefined ? { scale: d.scale } : {}),
            count: written.length,
            files: written,
            ...(failed.length ? { failed } : {}),
          });
        },
      });
    },
  );
}

/**
 * Which pages a PDF call names: `nodeIds`, or `deck: true` — every slide of a
 * Figma Slides file in presentation order, the plugin reading the grid — with
 * `includeSkipped` only beside `deck`. Exactly one of the two, checked here
 * before Figma is asked.
 */
export function pdfParams(args: Record<string, unknown>): Record<string, unknown> {
  const hasIds = args.nodeIds !== undefined;
  if (hasIds && args.deck !== undefined) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "Pass `nodeIds` or `deck`, not both.", { hint: "`deck: true` already exports every slide in order." });
  }
  if (args.includeSkipped !== undefined && args.deck !== true) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, "`includeSkipped` goes with `deck: true`.");
  }
  if (hasIds) return { nodeIds: args.nodeIds };
  if (args.deck === true) return { deck: true, ...(args.includeSkipped !== undefined ? { includeSkipped: args.includeSkipped } : {}) };
  throw new BridgeError(ErrorCode.INVALID_PARAM, "Pass `nodeIds` (frames, in page order), or `deck: true` in a Figma Slides file.");
}

/**
 * Frames to one multi-page PDF.
 *
 * The plugin renders each frame as a single-page PDF; the merge happens here via
 * pdf-lib (see src/server/pdf.ts for why a dependency was the right call). Page
 * order follows `nodeIds`, as documented — or the deck's own order.
 */
function registerFramesToPdf(server: McpServer, bridge: Bridge, roots: ExportRoots, wanted: (op: string) => boolean, roles?: RoleProcess): void {
  if (!wanted("export_frames_to_pdf")) return;
  const info = OPS.get("export_frames_to_pdf");
  server.registerTool(
    "figma_export_frames_to_pdf",
    {
      title: "Export frames to PDF",
      description: fitDescription(
        "Export frames to one multi-page PDF, one frame per page, in the order of `nodeIds`. In a Figma Slides file, " +
          "`deck: true` instead exports every slide in presentation order, leaving out skipped slides unless " +
          "`includeSkipped`; the result lists `slideIds` in page order. Each frame is rendered by the plugin and the " +
          "pages are merged by the bridge. A frame that cannot be rendered is reported in `failed[]` and the rest still " +
          "merge — an unreadable page is worse than a missing one, so nothing is silently substituted. `final: true` " +
          "marks the delivery: under BRIDGE_PROCESS=strict every page that belongs to a brief needs a passing " +
          "figma_sign_off newer than its last change.",
      ),
      inputSchema: {
        nodeIds: z.array(z.string()).min(1).max(200).optional().describe("Frames to export, in page order. Not with `deck`."),
        deck: z.boolean().optional().describe("Figma Slides: true exports every slide of the deck, in order, instead of nodeIds."),
        includeSkipped: z.boolean().optional().describe("With deck: also the slides skipped in the presentation. Default false."),
        outputPath: z.string().describe("Where to write the merged PDF. Same path rules as `figma_export_node`'s `saveTo`."),
        final: FINAL,
        session: z
          .string()
          .optional()
          .describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
      },
      annotations: { readOnlyHint: info?.readOnly ?? true, destructiveHint: false, openWorldHint: false },
    },
    async (args: Record<string, unknown>, extra: Extra) => {
      const outputPath = typeof args.outputPath === "string" ? args.outputPath : undefined;
      if (!outputPath) {
        return refuse(new BridgeError(ErrorCode.INVALID_PARAM, "`outputPath` is required."));
      }
      let params: Record<string, unknown>;
      // Fail on bad targets or a bad path before Figma renders anything.
      try {
        params = pdfParams(args);
        await resolveSavePath(outputPath, roots);
      } catch (err) {
        return refuse(err);
      }
      let warnings: string[] = [];
      if (args.final === true && roles?.active) {
        const deck = params.deck === true;
        let gate: RoleGate;
        try {
          gate = await gateFinal(
            bridge,
            roles,
            deck ? undefined : (params.nodeIds as string[]),
            args.session as string | undefined,
            (ids) =>
              deck
                ? `figma_export_frames_to_pdf { deck: true, outputPath: "${outputPath}", final: true }`
                : `figma_export_frames_to_pdf { nodeIds: [${ids.map((id) => `"${id}"`).join(", ")}], outputPath: "${outputPath}", final: true }`,
            { deck, signal: extra.signal },
          );
        } catch (err) {
          return refuse(err);
        }
        if (gate.refusal) return refuse(gate.refusal);
        warnings = gate.warnings;
      }
      const exported = await forwardTool(bridge, "export_frames_to_pdf", params, extra, {
        session: args.session as string | undefined,
        shape: async (data) => {
          const d = data as {
            pages?: Array<{ nodeId: string; name: string; bytes: number; base64: string }>;
            failed?: Array<{ nodeId: string; error: string }>;
            slideIds?: string[];
            skippedSlides?: string[];
          };
          const pages = (d.pages ?? []).map((p) => ({
            nodeId: p.nodeId,
            name: p.name,
            bytes: Buffer.from(p.base64, "base64"),
          }));
          const failed = [...(d.failed ?? [])];
          // Returned, not thrown, so forwardTool's read-only marking never sees
          // these: say it here. Figma rendered, but nothing was changed.
          if (pages.length === 0) {
            return errorResult(
              new BridgeError(ErrorCode.INTERNAL, "No frame could be rendered as a PDF.", {
                hint: failed.length ? failed.map((f) => `${f.nodeId}: ${f.error}`).join(" | ").slice(0, 300) : undefined,
              }),
              { readOnly: true },
            );
          }
          let merged;
          try {
            merged = await mergePdfs(pages);
          } catch (err) {
            return errorResult(err, { readOnly: true });
          }
          const path = await writeExport(outputPath, merged.bytes, roots);
          return okResult({
            path,
            pageCount: merged.pageCount,
            bytes: merged.bytes.length,
            pages: pages.map((p) => ({ nodeId: p.nodeId, name: p.name })),
            ...(failed.length ? { failed } : {}),
            ...(d.slideIds ? { slideIds: pages.map((p) => p.nodeId) } : {}),
            ...(d.skippedSlides?.length ? { skippedSlides: d.skippedSlides } : {}),
            ...(args.final === true ? { final: true } : {}),
          });
        },
      });
      return withProcessWarnings(exported, warnings);
    },
  );
}

function registerExportNode(server: McpServer, bridge: Bridge, roots: ExportRoots, wanted: (op: string) => boolean, roles?: RoleProcess): void {
  if (!wanted("export_node")) return;
  const info = OPS.get("export_node");
  server.registerTool(
    "figma_export_node",
    {
      title: "Export / screenshot a node",
      description: fitDescription(
        "Render a node so you can see it — the screenshot to compare against. No `nodeId`: the one selected layer. " +
          "Without `saveTo`, PNG/JPG come back as an image (≤ 5 MB) with its bounds and pixel size, and SVG as markup; " +
          "an inline PNG/JPG with no `scale` is held to 1024 px on its longest side (`maxSize` changes that; `capped` says " +
          "it happened; `scale` asks for an exact size instead). With `saveTo`, or for PDF, or when larger than 5 MB, the " +
          "file is written and its path returned. A relative `saveTo` lands in the export directory; other folders must be " +
          "listed in BRIDGE_EXPORT_ROOTS. If `format` is omitted, the `saveTo` extension decides, else PNG. An animated " +
          "frame renders at rest: see its motion with figma_export_video, then figma_review_video. `final: true` marks " +
          "the delivery: under BRIDGE_PROCESS=strict a node of a brief needs a passing figma_sign_off newer than its last " +
          "change. Skill: critique (figma_get_guide). For files a codebase ships (presets, original images), use " +
          "figma_download_assets.",
      ),
      inputSchema: {
        nodeId: z.string().optional().describe("The node to render: an id (\"12:34\") or a Figma link. Default: the one selected layer."),
        format: z.enum(FORMATS).optional().describe("PNG (default), JPG, SVG or PDF."),
        scale: z.number().positive().optional().describe("Exact pixel scale for PNG/JPG; bypasses the size cap."),
        maxSize: z.number().int().min(16).max(4096).optional().describe("Longest side in pixels for PNG/JPG (never upscales). Default 1024 inline."),
        saveTo: z.string().optional().describe("Write to this file instead of returning the render inline."),
        final: FINAL,
        session: z
          .string()
          .optional()
          .describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
      },
      annotations: { readOnlyHint: info?.readOnly ?? true, destructiveHint: false, openWorldHint: false },
    },
    async (args: Record<string, unknown>, extra: Extra) => {
      const saveTo = typeof args.saveTo === "string" ? args.saveTo : undefined;
      const implied = saveTo !== undefined ? formatFromPath(saveTo) : undefined;
      const asked = args.format as string | undefined;
      if (asked !== undefined && implied !== undefined && asked !== implied) {
        return refuse(
          new BridgeError(ErrorCode.INVALID_PARAM, `\`saveTo\` ends in a ${implied} extension but \`format\` is ${asked}.`, {
            hint: "Make them agree, or omit `format` and let the extension decide.",
          }),
        );
      }
      if (args.scale !== undefined && args.maxSize !== undefined) {
        return refuse(
          new BridgeError(ErrorCode.INVALID_PARAM, "Pass `scale` or `maxSize`, not both: a scale is an exact size, maxSize a limit.", {
            hint: "Drop one of them.",
          }),
        );
      }
      const format = asked ?? implied ?? "PNG";
      if (saveTo !== undefined) {
        // Fail on a bad path before Figma spends time rendering.
        try {
          await resolveSavePath(saveTo, roots);
        } catch (err) {
          return refuse(err);
        }
      }
      const params: Record<string, unknown> = { format };
      if (args.nodeId !== undefined) params.nodeId = args.nodeId;
      if (args.scale !== undefined) params.scale = args.scale;
      const raster = format === "PNG" || format === "JPG";
      // An inline look gets the cap by default; a file asked for by path keeps its full size.
      if (args.maxSize !== undefined) params.maxSize = args.maxSize;
      else if (raster && args.scale === undefined && saveTo === undefined) params.maxSize = DEFAULT_MAX_SIZE;
      let warnings: string[] = [];
      if (args.final === true && roles?.active) {
        let gate: RoleGate;
        try {
          gate = await gateFinal(
            bridge,
            roles,
            args.nodeId !== undefined ? [args.nodeId as string] : undefined,
            args.session as string | undefined,
            ([id]) => `figma_export_node { nodeId: "${id}", ${saveTo !== undefined ? `saveTo: "${saveTo}"` : "saveTo"}, final: true }`,
            { signal: extra.signal },
          );
        } catch (err) {
          return refuse(err);
        }
        if (gate.refusal) return refuse(gate.refusal);
        warnings = gate.warnings;
      }
      const exported = await forwardTool(bridge, "export_node", params, extra, {
        session: args.session as string | undefined,
        shape: (data) => shapeExport(data, saveTo, roots),
      });
      return withProcessWarnings(exported, warnings);
    },
  );
}
