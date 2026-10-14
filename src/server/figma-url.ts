// Helpers ported from the old REST server (~/figma-mcp/server.py, current-state §1),
// plus the node addressing every plugin-backed tool runs through (forward.ts).
//
// The official flow is link-first: a user copies the link to a layer and the
// agent passes it on. Figma writes the node id in that link as "12-34" (and an
// instance id as "I12-34%3B56-78"), while the Plugin API only knows "12:34" —
// getNodeByIdAsync returns null for the URL form, so an unconverted id reads as
// "not found". The conversion therefore happens here, once, before any op runs.

import type { Editor } from "../shared/editors.js";
import { BridgeError, ErrorCode } from "../shared/errors.js";

/** Accept "1:2" (canonical) or "1-2" (URL form) and normalize to "1:2". */
export function normalizeNodeId(nodeId: string): string {
  // Figma node ids contain no "-" internally, so a full replacement is safe —
  // the same reasoning as the Python original. Instance ids ("I1:2;3:4") keep
  // their shape.
  return nodeId.trim().replaceAll("-", ":");
}

/** Pull the file key out of a bare key or a full Figma URL. */
export function extractFileKey(ref: string): string {
  const s = ref.trim();
  const m = /figma\.com\/(?:design|file|proto|board|slides)\/([A-Za-z0-9]+)/.exec(s);
  return m ? m[1]! : s;
}

/** A node id as the plugin wants it, plus what a link said about its file. */
export interface NodeRef {
  id: string;
  /** The file-name part of a link ("Landing-Page"), decoded; absent for a bare id. */
  fileSlug?: string;
  fileKey?: string;
  branchKey?: string;
  /** The editor the link's path names: /board/ is FigJam, /slides/ is Slides, the rest Design. */
  editor?: Editor;
}

// A design / file / prototype / board / slides link, with an optional /branch/<key>/.
const LINK = /figma\.com\/(design|file|proto|board|slides)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?(?:\/([^/?#]+))?/;
const LINK_EDITOR: Record<string, Editor> = { design: "figma", file: "figma", proto: "figma", board: "figjam", slides: "slides" };
// A node id in either separator, instance paths included ("I1:2;3:4").
const PLAIN_ID = /^I?\d+[-:]\d+(;I?\d+[-:]\d+)*$/;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The link's node-id, decoded and converted: `undefined` when it has none, `null` when it is not an id. */
function linkNodeId(url: string): string | null | undefined {
  const m = /[?&]node-id=([^&#]+)/.exec(url);
  if (!m) return undefined;
  const id = decode(m[1]!).trim().replace(/-/g, ":");
  return PLAIN_ID.test(id) ? id : null;
}

/**
 * One id-bearing value → the id the plugin can resolve.
 *
 *   "12:34" → "12:34"; "12-34" → "12:34"; "I12-34%3B56-78" → "I12:34;56:78";
 *   a figma.com design / file / proto / board / slides link → its node-id, converted.
 *
 * Anything else ("S:abc,", "VariableID:1:2", a component key) passes through
 * unchanged, so this can run on every id key without knowing which grammar the
 * tool expects. A link that names no node is refused — guessing the page or
 * the file root would act on something the user did not point at.
 */
export function toNodeId(value: string, field = "nodeId"): NodeRef {
  const raw = value.trim();
  const link = LINK.exec(raw);
  if (link) {
    const id = linkNodeId(raw);
    if (id === undefined) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` is a Figma link with no node-id, so it names no layer.`, {
        hint: "Copy the link to the layer itself (right-click → Copy/Paste as → Copy link to selection), or pass the node id.",
      });
    }
    if (id === null) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: the link's node-id is not a node id.`);
    const ref: NodeRef = { id, fileKey: link[2]!, editor: LINK_EDITOR[link[1]!]! };
    if (link[3]) ref.branchKey = link[3];
    if (link[4]) ref.fileSlug = decode(link[4]);
    return ref;
  }
  if (/^https?:\/\//i.test(raw) || /figma\.com\//i.test(raw)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\` is a link, but not to a Figma design, file, prototype, board or slide deck.`, {
      hint: "Pass a node id such as 12:34, or a figma.com/design/… link with ?node-id=.",
    });
  }
  const plain = /%[0-9A-Fa-f]{2}/.test(raw) ? decode(raw) : raw;
  if (PLAIN_ID.test(plain)) return { id: plain.replace(/-/g, ":") };
  return { id: value };
}

/** The `node-id` query parameter of a Figma URL, normalized; null when absent. */
export function extractNodeIdFromUrl(url: string): string | null {
  return linkNodeId(url) ?? null;
}

/**
 * Every param key that carries a node id. Other id grammars (collectionId,
 * variableId, styleId, modeId) are deliberately absent — and would pass
 * through toNodeId unchanged anyway.
 */
export const ID_KEYS: ReadonlySet<string> = new Set([
  "nodeId", "nodeIds", "parentId", "componentId", "componentIds", "pageId",
  "bindNodeIds", "unbindNodeIds", "fixedNodeIds", "targetId", "preferredValues",
  "destinationId",
  // The Slides tools name their slides by these (tools/slides.ts).
  "slideId", "slideIds", "afterSlideId", "beforeSlideId",
]);

/**
 * Params that reach the plugin as a JSON string with node ids inside:
 * figma_set_reactions' `reactions` (each action's `destinationId`), on its own
 * or as a batch step. No tool parses it first, so a "12-40" or a pasted link
 * there reached setReactionsAsync verbatim. Still forwarded as a string.
 */
const JSON_ID_KEYS: ReadonlySet<string> = new Set(["reactions"]);

/** What a link pointed at, beyond the node: the file it was copied from. */
export interface LinkedFile {
  slug?: string;
  key: string;
  branchKey?: string;
  editor?: Editor;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Normalize every id-bearing key, at any depth of plain objects and arrays —
 * a parsed `spec` or a batch's `steps` included. JSON still in a string is not
 * parsed here, except under JSON_ID_KEYS; the tools that take one parse it
 * before forwarding. Returns a copy and the files any links came from, so the
 * caller can pick the session.
 */
export function normalizeIdParams(params: Record<string, unknown>): { params: Record<string, unknown>; files: LinkedFile[] } {
  const files: LinkedFile[] = [];
  const note = (ref: NodeRef) => {
    if (!ref.fileKey) return;
    const f: LinkedFile = { key: ref.fileKey };
    if (ref.branchKey) f.branchKey = ref.branchKey;
    if (ref.fileSlug) f.slug = ref.fileSlug;
    if (ref.editor) f.editor = ref.editor;
    files.push(f);
  };
  const id = (v: string, path: string) => {
    const ref = toNodeId(v, path);
    note(ref);
    return ref.id;
  };
  // Invalid JSON passes through untouched: the plugin refuses it, naming the field.
  const json = (s: string, path: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      return s;
    }
    const out = JSON.stringify(visit(parsed, path));
    return out === JSON.stringify(parsed) ? s : out;
  };
  const visit = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((x, i) => visit(x, `${path}[${i}]`));
    if (!isPlain(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const at = path ? `${path}.${k}` : k;
      if (ID_KEYS.has(k) && typeof x === "string") out[k] = id(x, at);
      else if (ID_KEYS.has(k) && Array.isArray(x)) out[k] = x.map((e, i) => (typeof e === "string" ? id(e, `${at}[${i}]`) : visit(e, `${at}[${i}]`)));
      else if (JSON_ID_KEYS.has(k) && typeof x === "string") out[k] = json(x, at);
      else out[k] = visit(x, at);
    }
    return out;
  };
  return { params: visit(params, "") as Record<string, unknown>, files };
}

/** A file name or link slug reduced to what both share: "Landing-Page" and "Landing Page" match. */
export function fileNameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
