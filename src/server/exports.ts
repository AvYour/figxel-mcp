// Export files on disk (spec §9, "Path traversal through export"). The plugin
// never writes a file; the bridge does, and only inside an allowed root:
//
//   - a relative `saveTo` resolves from BRIDGE_EXPORT_DIR;
//   - an absolute one must sit inside BRIDGE_EXPORT_DIR or a BRIDGE_EXPORT_ROOTS
//     entry — checked on the path as written AND after realpath, so a symlink
//     inside a root cannot carry the write outside it;
//   - anything else is INVALID_PARAM, and nothing is created on the way.

import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { BridgeError, ErrorCode } from "../shared/errors.js";

export interface ExportRoots {
  exportDir: string;
  exportRoots: string[];
}

/** File extension per export format. */
export const EXTENSION: Record<string, string> = { PNG: ".png", JPG: ".jpg", SVG: ".svg", PDF: ".pdf" };

/** The format a `saveTo` extension implies, if any (`.jpeg` counts as JPG). */
export function formatFromPath(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpeg") return "JPG";
  return Object.keys(EXTENSION).find((f) => EXTENSION[f] === ext);
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const outsideRoots = (saveTo: string, roots: ExportRoots) =>
  new BridgeError(ErrorCode.INVALID_PARAM, `\`saveTo\` must be inside the export directory or an allowed root: ${saveTo}`, {
    hint:
      `Relative paths resolve from ${roots.exportDir}. To write somewhere else (e.g. a project's public/ folder), ` +
      "add it to BRIDGE_EXPORT_ROOTS in the MCP client's server config.",
  });

/** The nearest ancestor of `path` that exists, realpath'd. */
async function realAncestor(path: string): Promise<string> {
  let p = path;
  for (;;) {
    try {
      return await realpath(p);
    } catch {
      const up = dirname(p);
      if (up === p) throw new BridgeError(ErrorCode.INVALID_PARAM, `No existing directory above ${path}.`);
      p = up;
    }
  }
}

/** Every allowed root that exists, realpath'd; the export dir is created on first use. */
async function realRoots(roots: ExportRoots): Promise<string[]> {
  await mkdir(roots.exportDir, { recursive: true });
  const out: string[] = [];
  for (const r of [roots.exportDir, ...roots.exportRoots]) {
    try {
      out.push(await realpath(r));
    } catch {
      // A configured root that does not exist cannot hold a file; skip it.
    }
  }
  return out;
}

/**
 * Resolve and validate a target path. Throws INVALID_PARAM — before anything is
 * created — when the path, as written or as it really resolves, leaves the roots.
 */
export async function resolveSavePath(saveTo: string, roots: ExportRoots): Promise<string> {
  const trimmed = saveTo.trim();
  if (trimmed === "") throw new BridgeError(ErrorCode.INVALID_PARAM, "`saveTo` is empty.");
  const target = isAbsolute(trimmed) ? resolve(trimmed) : resolve(roots.exportDir, trimmed);
  const lexical = [roots.exportDir, ...roots.exportRoots].map((r) => resolve(r));
  if (!lexical.some((r) => inside(r, target))) throw outsideRoots(saveTo, roots);

  const real = await realRoots(roots);
  const ancestor = await realAncestor(dirname(target));
  if (!real.some((r) => ancestor === r || inside(r, ancestor))) throw outsideRoots(saveTo, roots);
  try {
    // The file itself may already exist as a symlink pointing elsewhere.
    const existing = await realpath(target);
    if (!real.some((r) => inside(r, existing))) throw outsideRoots(saveTo, roots);
  } catch (err) {
    if (err instanceof BridgeError) throw err;
  }
  return target;
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/** A file name for an export the agent did not name: `<node name>-<id>-<time>.<ext>`. */
export function defaultExportName(nodeName: string, nodeId: string, format: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${safe(nodeName) || "node"}-${safe(nodeId.replace(/:/g, "-"))}-${stamp}${EXTENSION[format] ?? ""}`;
}

/**
 * The name of an asset render: `<node name>-<id><suffix>.<ext>`, with the
 * export setting's suffix kept as Figma writes it ("@2x"). No timestamp: an
 * asset is fetched again whenever the design changes, and a re-run must
 * replace the file the code already points at, not pile up beside it.
 */
export function assetFileName(nodeName: string, nodeId: string, suffix: string | undefined, ext: string): string {
  const tail = (suffix ?? "").replace(/[^A-Za-z0-9@._-]+/g, "-").slice(0, 40);
  return `${safe(nodeName) || "node"}-${safe(nodeId.replace(/[:;]/g, "-"))}${tail}${ext}`;
}

/** An image's real type from its first bytes — a fill's hash says nothing about the format it was uploaded in. */
export function sniffExt(bytes: Uint8Array): string {
  const at = (i: number, ...v: number[]) => v.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return ".png";
  if (at(0, 0xff, 0xd8, 0xff)) return ".jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return ".gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return ".webp";
  return ".bin";
}

/** Validate, create the directory, write. Returns the absolute path written. */
export async function writeExport(saveTo: string, bytes: Buffer, roots: ExportRoots): Promise<string> {
  const target = await resolveSavePath(saveTo, roots);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}
