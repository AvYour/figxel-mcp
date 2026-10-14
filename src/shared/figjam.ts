// FigJam vocabulary shared by the reads (what a board says back) and the
// writes (what an agent may ask for): shape types, connector magnets, caps and
// line types, code-block languages, and the connector endpoint grammar.
//
// Pure: no `figma`, so the server, the plugin and the tests use the same table.
// Values follow @figma/plugin-typings 1.141.0 [C-135]. Every parser accepts
// Figma's spelling or kebab case, case-insensitively ("rounded-rectangle" →
// ROUNDED_RECTANGLE), and refuses anything else with INVALID_PARAM naming the
// field and listing the values — nothing is accepted and then dropped.

import { BridgeError, ErrorCode } from "./errors.js";

/** ShapeWithTextNode.shapeType (plugin-api.d.ts:11507-11537). */
export const SHAPE_TYPES = [
  "SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT",
  "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER", "TRAPEZOID", "PREDEFINED_PROCESS",
  "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON",
  "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT", "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE",
] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

/** ConnectorEndpointEndpointNodeIdAndMagnet.magnet (plugin-api.d.ts:6278). */
export const MAGNETS = ["NONE", "AUTO", "TOP", "LEFT", "BOTTOM", "RIGHT", "CENTER"] as const;
export type Magnet = (typeof MAGNETS)[number];

/** ConnectorStrokeCap (plugin-api.d.ts:6290-6302). */
export const STROKE_CAPS = [
  "NONE", "ARROW_EQUILATERAL", "ARROW_LINES", "TRIANGLE_FILLED", "DIAMOND_FILLED", "CIRCLE_FILLED",
  "ERD_ZERO_OR_ONE", "ERD_EXACTLY_ONE", "ERD_ZERO_OR_MORE", "ERD_ONE_OR_MORE", "ERD_ONE", "ERD_MANY",
] as const;
export type StrokeCap = (typeof STROKE_CAPS)[number];

/** ConnectorNode.connectorLineType (plugin-api.d.ts:11634). */
export const LINE_TYPES = ["ELBOWED", "STRAIGHT", "CURVED"] as const;
export type LineType = (typeof LINE_TYPES)[number];

/**
 * CodeBlockNode.codeLanguage (plugin-api.d.ts:11585-11602): 17 values. The
 * official skill lists 16, without DART [C-143] — a contradiction, so DART stays
 * accepted but flagged in UNCONFIRMED_LANGUAGES until a live run settles it.
 */
export const CODE_LANGUAGES = [
  "TYPESCRIPT", "CPP", "RUBY", "CSS", "JAVASCRIPT", "HTML", "JSON", "GRAPHQL", "PYTHON", "GO", "SQL", "SWIFT",
  "KOTLIN", "RUST", "BASH", "PLAINTEXT", "DART",
] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];
export const UNCONFIRMED_LANGUAGES: ReadonlySet<CodeLanguage> = new Set<CodeLanguage>(["DART"]);

/** FigJam's default text colour, Charcoal [C-156]. */
export const FIGJAM_TEXT_DEFAULT = "#1E1E1E";

/** "rounded-rectangle", "Rounded Rectangle", "ROUNDED_RECTANGLE" → "ROUNDED_RECTANGLE". */
function canonical(input: string): string {
  return input.trim().toUpperCase().replace(/[-\s]+/g, "_");
}

/** A Figma enum value as an agent writes it: ROUNDED_RECTANGLE → "rounded-rectangle". */
export function kebab(value: string): string {
  return value.toLowerCase().replace(/_/g, "-");
}

function enumParser<T extends string>(values: readonly T[], what: string) {
  const known = new Set<string>(values);
  return (input: unknown, path: string): T => {
    const value = typeof input === "string" ? canonical(input) : "";
    if (known.has(value)) return value as T;
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}\`: ${JSON.stringify(input)} is not a ${what}.`, {
      hint: `Use one of: ${values.map(kebab).join(", ")} (Figma's own spelling works too).`,
    });
  };
}

export const parseShapeType = enumParser(SHAPE_TYPES, "FigJam shape type");
export const parseStrokeCap = enumParser(STROKE_CAPS, "connector cap");
export const parseLineType = enumParser(LINE_TYPES, "connector line type");
export const parseCodeLanguage = enumParser(CODE_LANGUAGES, "code-block language");
export const parseMagnet = enumParser(MAGNETS, "connector magnet");

// ── connector endpoints ─────────────────────────────────────────────────────

export interface XY {
  x: number;
  y: number;
}

/** Figma's ConnectorEndpoint union (plugin-api.d.ts:6263-6286). */
export type ConnectorEndpoint =
  | { position: XY }
  | { endpointNodeId: string; magnet: Magnet }
  | { endpointNodeId: string; position: XY };

/**
 * parseEndpoint's result. With `ref: true` the node part was a spec ref, held
 * in endpointNodeId until the builder swaps in the id of the node it built.
 */
export type ParsedEndpoint = ConnectorEndpoint & { ref?: true };

// A node id in either separator, instance paths included — figma-url.ts PLAIN_ID.
const NODE_ID = /^I?\d+[-:]\d+(;I?\d+[-:]\d+)*$/;
// A spec ref: the token a create_from_spec node declares as `ref`.
export const REF_TOKEN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/i;

const GRAMMAR =
  'An endpoint is "<node>" (attach, magnet AUTO), "<node>@<magnet>", "<node>@<x>,<y>" (a point on the node) or "<x>,<y>" (a free point). ' +
  `<node> is a node id ("12:34" or "12-34"), or inside a spec the \`ref\` of a node it builds; magnets: ${MAGNETS.join(", ")}.`;

function refuse(path: string, message: string): never {
  throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}\`: ${message}`, { hint: GRAMMAR });
}

function point(text: string, path: string, input: string): XY {
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length !== 2 || !parts.every((p) => NUMBER.test(p))) {
    refuse(path, `${JSON.stringify(input)} is not an endpoint: a point is two numbers, "x,y".`);
  }
  return { x: Number(parts[0]), y: Number(parts[1]) };
}

/**
 * One endpoint string → Figma's endpoint. The union travels as one string
 * (tools.md § Conventions):
 *
 *   "12:34"          { endpointNodeId: "12:34", magnet: "AUTO" }
 *   "12-34@right"    { endpointNodeId: "12:34", magnet: "RIGHT" }
 *   "12:34@0.5,1"    { endpointNodeId: "12:34", position: { x: 0.5, y: 1 } }
 *   "120,340"        { position: { x: 120, y: 340 } }
 *   "card_a@top"     { endpointNodeId: "card_a", magnet: "TOP", ref: true }   (refs: true only)
 *
 * The node part is normalised here because the bridge's id pass does not look
 * inside these strings. Whether a node-relative position is 0–1 or pixels is
 * unmeasured [C-148], so the number is passed through as given.
 */
export function parseEndpoint(input: unknown, path: string, opts: { refs?: boolean } = {}): ParsedEndpoint {
  if (typeof input !== "string" || !input.trim()) refuse(path, "an endpoint must be a non-empty string.");
  const s = input.trim();
  const at = s.indexOf("@");
  if (at < 0 && s.includes(",")) return { position: point(s, path, s) };

  const nodePart = (at < 0 ? s : s.slice(0, at)).trim();
  let node: string;
  let ref = false;
  if (NODE_ID.test(nodePart)) node = nodePart.replace(/-/g, ":");
  else if (opts.refs && REF_TOKEN.test(nodePart)) {
    node = nodePart;
    ref = true;
  } else {
    refuse(path, `${JSON.stringify(nodePart)} is not a node id${opts.refs ? " or a ref" : ""}.`);
  }
  const tag = ref ? { ref: true as const } : {};
  if (at < 0) return { endpointNodeId: node, magnet: "AUTO", ...tag };

  const rest = s.slice(at + 1).trim();
  if (!rest) refuse(path, `nothing follows "@" in ${JSON.stringify(s)}: give a magnet (${MAGNETS.join(", ")}) or "x,y".`);
  if (rest.includes(",")) return { endpointNodeId: node, position: point(rest, path, s), ...tag };
  const magnet = canonical(rest);
  if (!(MAGNETS as readonly string[]).includes(magnet)) {
    refuse(path, `${JSON.stringify(rest)} is not a magnet: use ${MAGNETS.join(", ")}, or "x,y" for a point on the node.`);
  }
  return { endpointNodeId: node, magnet: magnet as Magnet, ...tag };
}

/** The exact inverse of parseEndpoint: reads return what writes take. AUTO is the default, so it is left out. */
export function formatEndpoint(e: ConnectorEndpoint): string {
  const xy = (p: XY) => `${p.x},${p.y}`;
  if (!("endpointNodeId" in e)) return xy(e.position);
  if ("position" in e) return `${e.endpointNodeId}@${xy(e.position)}`;
  return e.magnet === "AUTO" ? e.endpointNodeId : `${e.endpointNodeId}@${e.magnet}`;
}
