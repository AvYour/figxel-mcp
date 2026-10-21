// figma_check_layout — the look a designer gives a frame before calling it done,
// as data an agent can act on.
//
// Why a tool and not a screenshot: a vision model reading a render disagreed
// with the Plugin API about where things were, twice on one image [C-070]; and
// the defects that made builds look bad were each measurable — a paragraph that
// never wrapped ran 2061 px wide in a 1920 px frame [C-072], a row title crossed
// the next column by 8 px [C-074]. The other session measured these with
// figma_eval, which is off by default; this makes the same measurements
// available to every agent.
//
// Reads only. Each finding names the node, says what is wrong in numbers, and
// says what to do — the agent should not have to interpret a picture to fix it.
//
// In a deck it checks a slide the way the official batch validator does
// (slide-gotchas.md:241-301) [C-155]; on a board, `audit: ["board"]` adds the
// official board rules [C-156] [C-159] [C-160]. Outside Figma Design every
// member is read through board-read.ts's guard, since a missing one may throw
// there [C-145], and the opaque SLIDE_GRID / SLIDE_ROW are never read at all.
//
// `audit: ["craft"]` adds the finish defects a critic measures (craft.ts) and
// `["tells"]` the census of the generated look (tells.ts). Both are judged
// after the walk from a census of every visible layer, collected only when
// one of them is asked for, so the other checks cost what they did. So are
// the role audits (role spec §4): `a11y` (a11y.ts), `states` (states.ts),
// `copy` (copy.ts), `system` (system.ts), `deck` (deck.ts), `mark` (mark.ts),
// `icons` (icons.ts) and `library` (library.ts), which read the brief's
// numbers — platform, viewport, floors, system, room, applications, grid,
// platforms — when `briefId` (or, from sign-off, CheckOptions.brief) names
// one. `library` also reads the file's variables, once, before it judges.
// Without `briefId`, the server sends the brief in force as `briefInForce`,
// and the brief the checked work belongs to outranks it (briefOfCheck).
//
// A brief at the page or top gear binds its `avoid` list (shared/avoid.ts):
// a finding of a kind it names is a warning, whatever its own severity, and
// the tells audit runs by default under it (role quality plan W1, W3).
//
// A brief block is a working note, not the design: every check skips a node
// that carries a brief record (src/shared/roles.ts) unless it is the root or
// one of that brief's own deliverables.
//
// Under a motion brief layout is judged where the viewer sees it (roles spec
// §3.6, decided after the live sign-off of 2026-10-20). A keyed layer's rest
// pose is one state of the motion and not a frame anyone need see: before a
// track's first key the first key's value holds and the base value never
// shows [C-191]. A piece whose scenes stack in one frame rests with every scene
// on top of the last. So a finding that rests on where keys park a layer —
// two layers keys move apart, or a moved layer against its clip or the safe
// area — is counted in `restPose`, not made; static layers, and layers one key
// moves together, are judged as before. The frames judge the rest.

import { avoidOf, bindAvoid, boundKinds, tellsByDefault } from "../../shared/avoid.js";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { FIGJAM_TEXT_DEFAULT } from "../../shared/figjam.js";
import { BRIEF_KEY, BRIEF_NAMESPACE, parseBrief, type BriefRecord } from "../../shared/roles.js";
import type { OpContext, PluginOp } from "./index.js";
import { A11Y, type MainInfo, judgeA11y, roleContext, shownInactive, textFloorOf } from "../a11y.js";
import { OPAQUE_TYPES, childrenOf, connectorLabel, endpointNode, field, guardAll, readView } from "../board-read.js";
import { fileIndex, workBriefOf } from "../brief-read.js";
import { contrastRatio } from "../context.js";
import { judgeCopy } from "../copy.js";
import { type Census, type Layer, inLogotype, indexCensus, judgeCraft, parseMinTextSize, parseSafeArea, textFacts } from "../craft.js";
import { judgeDeck } from "../deck.js";
import { judgeIcons } from "../icons.js";
import { judgeLibrary, readLibrary } from "../library.js";
import { judgeMark } from "../mark.js";
import { judgeStates } from "../states.js";
import { judgeSystem } from "../system.js";
import { paletteNameOf, paletteNames, type PaletteKind } from "../figjam/palette.js";
import { tracksToFieldNames } from "../motion-fields.js";
import { byId, int, str, strList, type FigmaLike, type NodeLike } from "../read.js";
import { ensureLoaded } from "../pages.js";
import { tryGet } from "../safe.js";
import { emptyTally, handoffReport, mergeTally, tallyNode, type HandoffTally } from "../handoff.js";
import { judgeTells, skeletonAcross, structureOf } from "../tells.js";
import { selectionOf } from "./modify.js";

const api = () => (globalThis as unknown as { figma: FigmaLike }).figma;
/** The API when there is one: checkLayout itself also runs on bare node trees (tests, other ops). */
const maybeApi = () => (globalThis as unknown as { figma?: FigmaLike & Any }).figma;

export type AuditKind =
  | "tokens" | "names" | "fonts" | "board" | "craft" | "tells" | "handoff"
  | "a11y" | "states" | "copy" | "system" | "deck" | "mark" | "icons" | "library";
export const AUDITS: readonly AuditKind[] = [
  "tokens", "names", "fonts", "board", "craft", "tells", "handoff", "a11y", "states", "copy", "system", "deck", "mark", "icons", "library",
];
/** The audits a role's sign-off adds (role spec §4): judged from the census, with the brief's numbers when there is one. */
const ROLE_AUDITS: readonly AuditKind[] = ["a11y", "states", "copy", "system", "deck", "mark", "icons", "library"];
/** The role audits that skip what needs the brief's numbers when no brief is given (named in the result's `audit.brief`). */
const NEEDS_BRIEF: readonly AuditKind[] = ["system", "deck", "mark", "icons", "library"];

export interface CheckOptions {
  /** The QA passes beyond the layout look: unbound tokens, duplicate names, font families. */
  audit?: ReadonlySet<AuditKind>;
  /** Font families the design should use; anything else is reported. */
  expectFonts?: readonly string[];
  /** craft: the area text, logos and calls to action must stay inside, in the root's coordinates. */
  safeArea?: Rect;
  /** craft: the smallest text size, in px of the frame, that reads on its device. */
  minTextSize?: number;
  /**
   * The brief the work answers to (role spec §3.2). The role audits read its
   * platform, viewport, screens, controls, insets, format and system; craft
   * takes its minTextSize and safeArea when the caller gives none, and on iOS
   * the platform's text minimum as min_text's floor.
   */
  brief?: BriefRecord;
  /**
   * Return the token findings unjudged (`tokenFindings`) instead of deciding
   * here whether a design system exists. Several roots must be judged
   * together: one root with nothing bound, beside one bound to library
   * variables, is in a file with a system all the same.
   */
  deferTokens?: boolean;
}

/** An unbound value the tokens audit found, before anyone has decided it matters. */
export interface TokenFinding {
  issue: Issue;
  aliasId?: string;
}

type Severity = "error" | "warning" | "info";
export interface Issue {
  kind: string;
  severity: Severity;
  nodeId: string;
  name: string;
  detail: string;
  /** Token audit: the variable Figma infers for the raw value, when it infers exactly one. */
  suggest?: string;
}

type Any = Record<string, unknown>;
type Rect = { x: number; y: number; width: number; height: number };
type Rgb = { r: number; g: number; b: number };

const CONTAINERS = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "SLIDE"]);
// Not Vector / Line / Polygon / Star: the shapes inside an icon keep those names
// in designers' own files too, and flagging every path of every icon buried the
// findings that matter (measured live: all 24 infos on a pricing section).
const DEFAULT_NAME = /^(Frame|Rectangle|Ellipse|Group|Text|Component|Instance|Section|Image)( \d+)?$/;
const r1 = (v: number) => Math.round(v * 10) / 10;

/** A node's members as checkLayout reads them: the node itself in Design, its guarded view elsewhere. */
type View = (n: NodeLike) => Any;

function rect(n: unknown): Rect | null {
  const b = field<Rect | null>(n, "absoluteBoundingBox");
  return b && Number.isFinite(b.width) ? b : null;
}

function visibleSolid(paints: unknown): { color: Rgb; opacity: number } | null {
  if (!Array.isArray(paints)) return null;
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i] as Any;
    if (p.visible === false) continue;
    if (p.type === "SOLID") return { color: p.color as Rgb, opacity: typeof p.opacity === "number" ? p.opacity : 1 };
    return null; // a gradient or image on top: the colour behind is not one colour
  }
  return null;
}

function hex(c: Rgb): string {
  const h = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * The solid colour actually behind a node: the nearest ancestor with an opaque
 * solid fill. A slide ends the search — it is the backdrop of everything on it
 * — and the opaque row and grid above it are never read: they have no fills,
 * and reading one throws (slide-gotchas.md:192) [C-136].
 */
function backdrop(n: NodeLike, view: View): Rgb | null {
  let p = field<NodeLike | null>(n, "parent");
  while (p && p.type !== "PAGE" && p.type !== "DOCUMENT" && !OPAQUE_TYPES.has(p.type)) {
    const a = view(p);
    if (a.visible !== false) {
      const fills = a.fills;
      if (Array.isArray(fills) && fills.some((f) => (f as Any).visible !== false)) {
        const s = visibleSolid(fills);
        if (!s) return null; // painted, but not with a single colour
        if (s.opacity >= 0.99 && (typeof a.opacity === "number" ? (a.opacity as number) : 1) >= 0.99) return s.color;
        return null; // a translucent backdrop blends with something further down
      }
    }
    if (p.type === "SLIDE") return null;
    p = field<NodeLike | null>(p, "parent");
  }
  return null;
}

function isLargeText(t: Any): boolean {
  const size = typeof t.fontSize === "number" ? t.fontSize : 0;
  const style = (t.fontName as { style?: string } | undefined)?.style ?? "";
  const bold = /(^|\s)(Bold|Black|Heavy|ExtraBold|Extra Bold)$/i.test(style);
  return size >= 24 || (size >= 18.66 && bold);
}

/** What a non-text layer paints, and where. `hole` is the see-through middle of a stroked box. */
type Cover = { outer: Rect; hole: Rect | null; opacity: number };

/**
 * What a non-text layer actually covers, or null if it paints nothing visible.
 *
 * A fill covers the node's whole box. A stroke does not: its ink is a band around
 * the edge, so treating the bounding box as coverage would report a hollow outline
 * as hiding everything inside it — the same mistake the text pass already had to
 * fix when it judged overlap on boxes instead of glyphs [C-070].
 */
function coverage(n: Any, box: Rect | null): Cover | null {
  if (!box || box.width <= 0 || box.height <= 0) return null;
  const nodeOpacity = typeof n.opacity === "number" ? (n.opacity as number) : 1;
  if (nodeOpacity <= 0.01) return null;

  const fills = Array.isArray(n.fills) ? (n.fills as Any[]).filter((f) => f.visible !== false) : [];
  const top = fills[fills.length - 1];
  if (top) {
    // A solid fill covers its box; so does a gradient or an image, and text behind
    // one is no more readable. Opacity decides whether it hides the text or tints it.
    const paintOpacity = typeof top.opacity === "number" ? (top.opacity as number) : 1;
    return { outer: box, hole: null, opacity: nodeOpacity * paintOpacity };
  }

  const strokes = Array.isArray(n.strokes) ? (n.strokes as Any[]).filter((s) => s.visible !== false) : [];
  if (!strokes.length) return null;
  const last = strokes[strokes.length - 1]!;
  const paintOpacity = typeof last.opacity === "number" ? (last.opacity as number) : 1;
  const weight = typeof n.strokeWeight === "number" ? (n.strokeWeight as number) : 1;
  const align = String(n.strokeAlign ?? "CENTER");
  const out = align === "INSIDE" ? 0 : align === "OUTSIDE" ? weight : weight / 2;
  const inset = align === "OUTSIDE" ? 0 : align === "INSIDE" ? weight : weight / 2;
  const outer: Rect = { x: box.x - out, y: box.y - out, width: box.width + 2 * out, height: box.height + 2 * out };
  const hole: Rect | null =
    box.width > 2 * inset && box.height > 2 * inset
      ? { x: box.x + inset, y: box.y + inset, width: box.width - 2 * inset, height: box.height - 2 * inset }
      : null;
  return { outer, hole, opacity: nodeOpacity * paintOpacity };
}

const OVERLAP = (a: Rect, b: Rect, gap: number) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > gap &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > gap;

/** The overlap of two rectangles, or null. */
function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.width, b.x + b.width) - x;
  const h = Math.min(a.y + a.height, b.y + b.height) - y;
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
}

/**
 * Cut a cover down to what its clipping ancestors let through. A cropped image
 * whose box runs past its card is invisible outside the card, so judging the
 * box would report text next to the card as covered.
 */
function clipToAncestors(c: Cover, n: NodeLike, view: View): Cover | null {
  let outer: Rect | null = c.outer;
  for (let p = field<NodeLike | null>(n, "parent"); p && outer; p = field<NodeLike | null>(p, "parent")) {
    if (OPAQUE_TYPES.has(p.type)) continue; // a row or grid clips nothing, and is not read
    const a = view(p);
    if (a.clipsContent === true) {
      const box = rect(a);
      if (box) outer = intersect(outer, box);
    }
  }
  return outer ? { ...c, outer } : null;
}

/** True when the layer's ink reaches the text — inside a hollow shape it does not. */
function hides(c: Cover, text: Rect): boolean {
  if (!OVERLAP(c.outer, text, 2)) return false;
  if (c.hole && !OVERLAP(c.hole, text, 2)) return false; // the text sits inside the hollow
  return true;
}

// ── what the official screenshot check looks for, measured ──────────────────
//
// The official figma-use validation asks the agent to look at a render for
// clipped text, overlapping content and leftover placeholder copy, and its
// gotchas name two layout traps: a FILL child in a HUG parent, and text that
// collapses into a one-character-wide thread. Each is a number here, so no
// picture has to be interpreted to find it.

/** Copy a template leaves behind: the whole text is a stand-in word. */
const PLACEHOLDER = /^(title|heading|subtitle|button|label|text|lorem ipsum[\s\S]*)$/i;
/** A stand-in person, brand or domain anywhere in a text: nobody wrote this content. */
const STAND_IN = /\b(?:John|Jane) Doe\b|\bAcme\b|\b(?:Your|My) (?:Company|Brand|Name)\b|\bCompany Name\b|\bexample\.(?:com|org|net)\b/i;

/** One line's height in px: PIXELS as given, PERCENT of the size, AUTO about 1.2 × the size. */
function lineHeightPx(t: Any): number {
  const size = typeof t.fontSize === "number" ? t.fontSize : 12;
  const lh = t.lineHeight as { unit?: string; value?: number } | undefined;
  if (lh && typeof lh === "object" && typeof lh.value === "number") {
    if (lh.unit === "PIXELS") return lh.value;
    if (lh.unit === "PERCENT") return (size * lh.value) / 100;
  }
  return size * 1.2;
}

/** Keyframe fields that move, turn, resize, fade or trim a layer: where it is seen, or whether, changes over the timeline. */
const MOVES = /^(TRANSLATION_(X|Y|XY)|SCALE_(X|Y|XY)|ROTATION|WIDTH|HEIGHT|OPACITY|PATH_TRIM_(START|END))$/;
/** Keyframe fields of a container that move its children against it: its size (its clip, its constraints) and its layout's gaps and padding. */
const MOVES_CHILDREN = /^(WIDTH|HEIGHT|STACK_[A-Z_]+|GRID_[A-Z_]+)$/;

/** What `restPose` says, for figma_check_layout and figma_sign_off alike. */
export function restPoseNote(moved: number, notJudged: Readonly<Record<string, number>>): string {
  const n = Object.values(notJudged).reduce((a, b) => a + b, 0);
  const layers = moved === 1 ? "1 layer here moves" : `${moved} layers here move`;
  const left =
    n === 0
      ? "no finding rested on where they sit at rest."
      : `${n} finding${n === 1 ? "" : "s"} that rested on where they sit at rest (stacked scenes, parked layers, a strip behind its clip window) ` +
        `${n === 1 ? "was" : "were"} not made. Judge ${n === 1 ? "it" : "them"} on frames: figma_review_video, or figma_export_video frames.`;
  return `Under a motion brief layout is judged where the viewer sees it: ${layers} with keys, and ${left} Static layers, and layers one key moves together, were judged as usual.`;
}

const AUTO_LAYOUT = new Set(["HORIZONTAL", "VERTICAL"]);
/** Layouts that place their children: spacing there is the layout's rhythm, not a hand-made gap. */
const FLOW_LAYOUT = new Set(["HORIZONTAL", "VERTICAL", "GRID"]);
const STACKABLE = new Set(["FRAME", "COMPONENT", "INSTANCE"]);

/** True when `n` sits inside an INSTANCE: its text and paint come from a component. */
function insideInstance(n: NodeLike): boolean {
  for (let p = n.parent as NodeLike | null | undefined; p; p = p.parent as NodeLike | null | undefined) {
    if (p.type === "INSTANCE") return true;
  }
  return false;
}

/** Text segments by font family and text style, or the node's own font when it has one. */
function fontSegments(t: Any): Array<{ family: string; textStyleId: string }> {
  const seg = t.getStyledTextSegments as ((f: string[]) => Array<{ fontName?: { family?: string }; textStyleId?: unknown }>) | undefined;
  if (typeof seg === "function") {
    try {
      return seg.call(t, ["fontName", "textStyleId"])
        .filter((s) => typeof s.fontName?.family === "string")
        .map((s) => ({ family: s.fontName!.family!, textStyleId: typeof s.textStyleId === "string" ? s.textStyleId : "" }));
    } catch {
      /* a text with nothing loaded: fall back to the node's own font */
    }
  }
  const font = t.fontName as { family?: unknown } | undefined;
  return font && typeof font === "object" && typeof font.family === "string"
    ? [{ family: font.family, textStyleId: typeof t.textStyleId === "string" ? t.textStyleId : "" }]
    : [];
}

/** One visible layer as the craft and tells audits read it: its paint, its place, and a text's facts. */
function layerOf(n: NodeLike, a: Any, box: Rect, order: number, parent: Any | undefined, view: View, inactive: boolean): Layer {
  const isText = n.type === "TEXT";
  // A connector's ink is its routed line, not its box (as for `covered`).
  const raw = isText || n.type === "CONNECTOR" ? null : coverage(a, box);
  const shown = (list: unknown) => Array.isArray(list) && list.some((p) => (p as Any).visible !== false);
  const fg = isText ? visibleSolid(a.fills) : null;
  return {
    node: n,
    a,
    box,
    order,
    inInstance: insideInstance(n),
    inactive,
    flow: !!parent && FLOW_LAYOUT.has(String(parent.layoutMode)) && a.layoutPositioning !== "ABSOLUTE",
    cover: raw ? clipToAncestors(raw, n, view) : null,
    solid: visibleSolid(a.fills),
    strokeSolid: visibleSolid(a.strokes),
    filled: shown(a.fills),
    stroked: shown(a.strokes),
    ...(isText ? { text: textFacts(a, box, fg && fg.opacity >= 0.99 ? fg.color : null, isLargeText(a) ? 3 : 4.5) } : {}),
  };
}

/**
 * True when `n` carries a brief record and is not among that brief's own
 * deliverables: the brief block, a working note every check skips. A brief
 * stored on the work itself (figma_set_brief { nodeId }) names the node as a
 * deliverable once the work is listed, and the root is never skipped. Cheap:
 * one shared-data read per node, a parse only where a brief is.
 */
function isBriefNote(n: NodeLike, a: Any): boolean {
  const get = a.getSharedPluginData;
  if (typeof get !== "function") return false;
  let raw: unknown;
  try {
    raw = (get as (ns: string, key: string) => string).call(a, BRIEF_NAMESPACE, BRIEF_KEY);
  } catch {
    return false;
  }
  if (typeof raw !== "string" || !raw) return false;
  const parsed = parseBrief(raw);
  return !("brief" in parsed && parsed.brief.deliverables.indexOf(n.id) >= 0);
}

/** The brief stored on `id`, read for figma_check_layout { briefId }; refused by name when there is none or it cannot be read. */
async function briefOn(figma: FigmaLike, id: string): Promise<BriefRecord> {
  const node = await byId(figma, id);
  const get = field<(ns: string, key: string) => string>(node, "getSharedPluginData");
  let raw = "";
  try {
    raw = typeof get === "function" ? String(get.call(node, BRIEF_NAMESPACE, BRIEF_KEY) ?? "") : "";
  } catch {
    raw = "";
  }
  if (!raw) {
    throw new BridgeError(ErrorCode.INVALID_PARAM,
      `"${node.name}" (${node.id}) carries no brief. Pass the briefId figma_set_brief returned; figma_get_brief lists the open briefs.`);
  }
  const parsed = parseBrief(raw);
  if ("invalid" in parsed) throw new BridgeError(ErrorCode.INVALID_PARAM, `The brief on "${node.name}" (${node.id}) cannot be read: ${parsed.invalid}.`);
  return parsed.brief;
}

/** The brief a check measures against, why that one, and the roots it does not cover. */
interface ChosenBrief {
  brief: BriefRecord;
  /** The call named it, the checked work belongs to it, or it is the brief in force. */
  from: "briefId" | "node" | "in force";
  note?: string;
}

/**
 * The brief a check measures against: the one `briefId` names; else, when
 * the server sends the brief in force, the brief the checked work belongs to
 * — a root's own record, its top-level frame's or a section's, or a brief
 * listing it (workBriefOf, as figma_get_brief resolves a node, less the
 * page's brief) — with the brief in force for a root that belongs to none.
 * A UX screen checked while a motion brief is in force is measured as the
 * UX screen it is. Roots of different briefs are measured against the first
 * root's, and `note` names the others. Neither sent: no brief.
 */
async function briefOfCheck(figma: FigmaLike, roots: readonly NodeLike[], briefId: string | undefined, inForce: string | undefined): Promise<ChosenBrief | undefined> {
  if (briefId) return { brief: await briefOn(figma, briefId), from: "briefId" };
  if (!inForce) return undefined;
  const index = fileIndex(figma);
  const owns: Array<BriefRecord | undefined> = [];
  for (const root of roots) owns.push((await workBriefOf(figma, root, index)).brief);
  // Read only when a root needs it; one whose node is gone is refused by name, as before.
  let forced: BriefRecord | undefined;
  const of = async (own: BriefRecord | undefined) => own ?? (forced ??= await briefOn(figma, inForce));
  const brief = await of(owns[0]);
  const others: string[] = [];
  for (let i = 1; i < roots.length; i++) {
    const b = await of(owns[i]);
    if (b.id !== brief.id) others.push(`"${roots[i]!.name}" (${roots[i]!.id}) belongs to "${b.title}" (${b.id})${owns[i] ? "," : ", the brief in force,"} not to this one`);
  }
  const listed = others.slice(0, 3).join("; ") + (others.length > 3 ? `; and ${others.length - 3} more roots` : "");
  return {
    brief,
    from: owns[0] ? "node" : "in force",
    ...(others.length ? { note: `${listed}: check ${others.length === 1 ? "it in its" : "them in their"} own call.` } : {}),
  };
}

/**
 * Each instance's main component, looked up once after the walk for the role
 * audits: a control is often named only by its component ("Button", a set's
 * name), and its states live on that component's set. getMainComponentAsync,
 * because this plugin's document access is dynamic-page.
 */
async function mainsOf(c: Census): Promise<Map<NodeLike, MainInfo>> {
  const out = new Map<NodeLike, MainInfo>();
  let looked = 0;
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) {
    if (l.node.type !== "INSTANCE") continue;
    if (++looked > A11Y.mainCap) break;
    const get = l.a.getMainComponentAsync;
    if (typeof get !== "function") continue;
    let main: NodeLike | null = null;
    try {
      main = ((await (get as () => Promise<NodeLike | null>).call(l.a)) ?? null) as NodeLike | null;
    } catch {
      main = null; // a component that no longer resolves names nothing
    }
    if (!main) continue;
    const parent = field<NodeLike | null>(main, "parent");
    out.set(l.node, { id: main.id, name: main.name, remote: field(main, "remote") === true, set: parent?.type === "COMPONENT_SET" ? parent : null });
  }
  return out;
}

/**
 * The frames a brief's screen states (screen_state_missing) or a mark's
 * versions (version_missing) may be drawn as: the root, the top-level frames
 * of its page and of the sections on it, and the brief's deliverables
 * wherever they are. `versions`: the mark audit asks, whatever the screens.
 */
async function framesFor(root: NodeLike, brief: BriefRecord | undefined, versions = false): Promise<Array<{ id: string; name: string; node: NodeLike }>> {
  if (!brief || (!versions && !Array.isArray((brief.details as Any).screens))) return [];
  const out = new Map<string, NodeLike>();
  const add = (n: NodeLike) => out.set(n.id, n);
  add(root);
  let page: NodeLike | null | undefined = root;
  while (page && page.type !== "PAGE") page = field<NodeLike | null>(page, "parent");
  for (const k of (page ? childrenOf(page) : undefined) ?? []) {
    add(k);
    if (k.type === "SECTION") for (const kk of childrenOf(k) ?? []) add(kk);
  }
  const f = maybeApi();
  const get = f?.getNodeByIdAsync as ((id: string) => Promise<NodeLike | null>) | undefined;
  for (const id of brief.deliverables.slice(0, 200)) {
    if (out.has(id) || typeof get !== "function") continue;
    try {
      const n = await get.call(f, id);
      if (n) add(n);
    } catch {
      /* a deliverable that no longer exists names no frame */
    }
  }
  return [...out].map(([id, node]) => ({ id, name: node.name, node }));
}

/** True when anything on the node is bound to a variable — the evidence a library-themed file leaves. */
function hasBinding(a: Any): boolean {
  const bv = a.boundVariables as Any | undefined;
  if (bv && Object.keys(bv).length) return true;
  return [a.fills, a.strokes].some((l) => Array.isArray(l) && l.some((p) => Object.keys(((p as Any).boundVariables as Any | undefined) ?? {}).length > 0));
}

/** A variant name as a set of pairs, so "A=1, B=2" and "B=2, A=1" are the same variant. */
const variantKey = (name: string) => name.split(",").map((p) => p.split("=").map((s) => s.trim()).join("=")).sort().join(", ");

type Alias = { id?: string };
type Inferred = Partial<Record<string, Alias[]>> & { fills?: Alias[][]; strokes?: Alias[][] };

/**
 * The raw values on one node that a design system would hold: a solid colour
 * with no style or variable, spacing and radius with no variable. Each carries
 * the variable Figma infers for that exact value, when it infers exactly one
 * (SceneNode.inferredVariables, typings 1.141.0) — the fix, not just the fault.
 */
function unboundTokens(n: NodeLike, a: Any): Array<{ issue: Issue; aliasId?: string }> {
  const out: Array<{ issue: Issue; aliasId?: string }> = [];
  const inferred = a.inferredVariables as Inferred | undefined;
  const found = (kind: string, severity: Severity, detail: string, aliasId?: string) =>
    out.push({ issue: { kind, severity, nodeId: n.id, name: n.name, detail }, ...(aliasId ? { aliasId } : {}) });
  for (const [list, styleKey, word, slot] of [[a.fills, "fillStyleId", "fill", "fills"], [a.strokes, "strokeStyleId", "stroke", "strokes"]] as const) {
    if (!Array.isArray(list) || (typeof a[styleKey] === "string" && a[styleKey] !== "")) continue;
    const i = (list as Any[]).findIndex((p) => p.type === "SOLID" && p.visible !== false && !(p.boundVariables as Any | undefined)?.color);
    if (i < 0) continue;
    found("unbound_color", "warning", `${word} ${hex((list as Any[])[i]!.color as Rgb)} is bound to no style or variable.`, inferred?.[slot]?.[i]?.[0]?.id);
  }
  const bound = (a.boundVariables ?? {}) as Any;
  if (AUTO_LAYOUT.has(String(a.layoutMode))) {
    const raw = ["itemSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].filter((k) => typeof a[k] === "number" && (a[k] as number) > 0 && !bound[k]);
    if (raw.length) {
      found("unbound_spacing", "info", `${raw.map((k) => `${k} ${a[k]}`).join(", ")}: raw numbers, not spacing variables.`, inferred?.[raw[0]!]?.[0]?.id);
    }
  }
  if (typeof a.cornerRadius === "number" && a.cornerRadius > 0 && !bound.topLeftRadius && !bound.cornerRadius) {
    found("unbound_radius", "info", `corner radius ${a.cornerRadius} is a raw number, not a radius variable.`, (inferred?.topLeftRadius ?? inferred?.cornerRadius)?.[0]?.id);
  }
  return out;
}

/**
 * Whether there is a design system to bind to. Local styles or variables
 * count — and so does a subtree already bound to variables or using library
 * styles, which is how a library-themed file looks: no local tokens at all,
 * and before this every raw value in it went unreported.
 */
async function designSystem(signals: { bound: boolean; styleIds: Set<string> }): Promise<{ found: boolean; why: string }> {
  if (signals.bound) return { found: true, why: "nodes here are bound to variables" };
  const f = maybeApi();
  if (!f) return { found: false, why: "no Figma API to ask" };
  const count = async (owner: unknown, read: unknown) => {
    try {
      return typeof read === "function" ? (((await (read as () => Promise<unknown[]>).call(owner)) ?? []) as unknown[]).length : 0;
    } catch {
      return 0;
    }
  };
  const styles = (await count(f, f.getLocalPaintStylesAsync)) + (await count(f, f.getLocalTextStylesAsync));
  const vars = f.variables as Any | undefined;
  const variables = await count(vars, vars?.getLocalVariablesAsync);
  if (styles + variables > 0) return { found: true, why: `this file defines ${styles} paint/text style(s) and ${variables} variable(s)` };
  const getStyle = f.getStyleByIdAsync as ((id: string) => Promise<{ remote?: boolean } | null>) | undefined;
  for (const id of [...signals.styleIds].slice(0, 20)) {
    try {
      if ((await getStyle?.call(f, id))?.remote) return { found: true, why: "nodes here use library styles" };
    } catch {
      /* an id that no longer resolves says nothing either way */
    }
  }
  return { found: false, why: "no local styles or variables, and nothing here is bound to one" };
}

/**
 * The token findings that count, each naming the variable to bind when Figma
 * inferred one. No system means every raw value would be "unbound" — noise,
 * not a finding.
 */
async function judgeTokens(findings: readonly TokenFinding[], system: { found: boolean }): Promise<Issue[]> {
  if (!system.found) return [];
  const out: Issue[] = [];
  const names = new Map<string, string>();
  const getVar = (maybeApi()?.variables as Any | undefined)?.getVariableByIdAsync as ((id: string) => Promise<{ name?: string } | null>) | undefined;
  for (const { issue, aliasId } of findings) {
    if (aliasId && getVar) {
      if (!names.has(aliasId)) {
        let name = aliasId;
        try {
          name = (await getVar.call(maybeApi()!.variables, aliasId))?.name ?? aliasId;
        } catch {
          /* keep the id: it still names the variable */
        }
        names.set(aliasId, name);
      }
      issue.suggest = names.get(aliasId)!;
      issue.detail += ` Bind it to "${issue.suggest}" (figma_bind_variable_to_node).`;
    }
    out.push(issue);
  }
  return out;
}

/** COMPONENT / COMPONENT_SET names used twice on `page`, and variant names repeated inside a set. */
async function duplicateNames(page: NodeLike, add: (n: NodeLike, kind: string, severity: Severity, detail: string) => void): Promise<void> {
  if (maybeApi()) await ensureLoaded(page as never); // the root's page may not be the current one [C-090]
  const p = page as unknown as { findAllWithCriteria?: (c: { types: string[] }) => NodeLike[] };
  let found: NodeLike[];
  if (typeof p.findAllWithCriteria === "function") {
    found = p.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] }).slice(0, 5000);
  } else {
    found = [];
    const stack = [...(page.children ?? [])];
    for (let seen = 0; stack.length && seen < 5000; seen++) {
      const n = stack.pop()!;
      if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") found.push(n);
      stack.push(...(n.children ?? []));
    }
  }
  const byName = new Map<string, NodeLike[]>();
  for (const n of found) {
    if (n.type === "COMPONENT" && n.parent?.type === "COMPONENT_SET") continue; // a variant: judged within its set
    byName.set(n.name, [...(byName.get(n.name) ?? []), n]);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    add(list[0]!, "duplicate_name", "warning",
      `${list.length} components on this page are named "${name}" (${list.map((n) => n.id).join(", ")}) — an instance, a swap or a library search cannot tell them apart. Rename all but one.`);
  }
  for (const set of found.filter((n) => n.type === "COMPONENT_SET")) {
    const seen = new Map<string, NodeLike>();
    for (const v of set.children ?? []) {
      const key = variantKey(v.name);
      const first = seen.get(key);
      if (first) add(v, "duplicate_name", "warning", `repeats the variant "${v.name}" of "${set.name}" (also ${first.id}): one of them can never be picked.`);
      else seen.set(key, v);
    }
  }
}

type Add = (n: NodeLike, kind: string, severity: Severity, detail: string) => void;

/** How far `box` runs past `outer` on each side, as "12 px right" phrases (over 1 px only). */
function overSides(box: Rect, outer: Rect): string[] {
  const over = {
    left: outer.x - box.x,
    right: box.x + box.width - (outer.x + outer.width),
    top: outer.y - box.y,
    bottom: box.y + box.height - (outer.y + outer.height),
  };
  return Object.entries(over).filter(([, v]) => v > 1).map(([side, v]) => `${r1(v)} px ${side}`);
}

/**
 * A slide's direct child against the slide's box (1920 × 1080 [C-134]) — the
 * official batch validator's bounds check (slide-gotchas.md:286-291) [C-155].
 * Wholly outside, nothing of it shows: out_of_slide. Partly outside is a bleed,
 * a deliberate device (slide-design.md:72, :98), so info — except text, which
 * the edge cuts mid-word: text_cut_by_slide.
 */
function slideBounds(n: NodeLike, box: Rect, slide: Rect | null, slideNode: NodeLike, add: Add, offSlide: Set<NodeLike>): void {
  if (!slide) return;
  const hit = intersect(box, slide);
  if (!hit || hit.width < 1 || hit.height < 1) {
    offSlide.add(n);
    add(n, "out_of_slide", "warning",
      `lies wholly outside the slide "${slideNode.name}" (at ${r1(box.x - slide.x)}, ${r1(box.y - slide.y)} on a ` +
        `${r1(slide.width)} × ${r1(slide.height)} slide) — it never shows. Move it onto the slide, or delete it.`);
    return;
  }
  const sides = overSides(box, slide);
  if (!sides.length) return;
  if (n.type === "TEXT") {
    add(n, "text_cut_by_slide", "error",
      `runs ${sides.join(", ")} past the edge of the slide "${slideNode.name}", which cuts it off. Move it in, or give it a width so it wraps.`);
  } else {
    add(n, "bleed", "info", `bleeds ${sides.join(", ")} off the slide "${slideNode.name}" — fine when deliberate (a shape cropped by the edge).`);
  }
}

/**
 * The paint a board node's palette governs, per type: a sticky's and a shape's
 * fill, a connector's line. Sections are left out until their swatches are
 * measured [C-144]; TEXT has its own rule (text_not_charcoal).
 */
const PALETTE_PAINT: Readonly<Record<string, { kind: PaletteKind; key: "fills" | "strokes"; what: string }>> = {
  STICKY: { kind: "sticky", key: "fills", what: "sticky" },
  SHAPE_WITH_TEXT: { kind: "shape", key: "fills", what: "shape" },
  CONNECTOR: { kind: "connector", key: "strokes", what: "connector" },
};

/**
 * FigJam shows a colour as a named swatch only when its channels match the
 * palette exactly (figjam-colors.md:24-26) [C-156]: anything else reads as a
 * custom colour beside the board's own.
 */
function offPalette(n: NodeLike, a: Any, add: Add): void {
  const rule = PALETTE_PAINT[n.type];
  if (!rule) return;
  const paint = visibleSolid(a[rule.key]);
  if (!paint) return;
  const h = hex(paint.color).toUpperCase();
  if (paletteNameOf(rule.kind, h) !== undefined) return;
  const names = paletteNames(rule.kind);
  add(n, "off_palette", "info",
    `is ${h}, not one of FigJam's ${rule.what} colours, so it reads as a custom colour on the board. Pick one by name ` +
      `with figma_set_board_properties color (${names.slice(0, 6).join(", ")}, …) unless the brief asks for this one.`);
}

/**
 * The official board rules, judged after the walk [C-160] [C-159]: stickies
 * never overlap (plan-board-content.md:229); a connector attached to a node
 * that is gone; a label longer than a few words (flowchart.md:315-316); two
 * sections with one name. Endpoint lookups are one per distinct id, capped.
 */
async function boardRules(
  found: { stickies: ReadonlyMap<NodeLike, NodeLike[]>; connectors: readonly NodeLike[]; sections: ReadonlyMap<string, NodeLike[]> },
  view: View,
  add: Add,
): Promise<void> {
  for (const list of found.stickies.values()) {
    for (let i = 0; i < list.length && i < 200; i++) {
      for (let j = i + 1; j < list.length && j < 200; j++) {
        const A = rect(view(list[i]!));
        const B = rect(view(list[j]!));
        const hit = A && B ? intersect(A, B) : null;
        if (!hit || hit.width <= 2 || hit.height <= 2) continue;
        add(list[j]!, "sticky_overlap", "warning",
          `overlaps the sticky "${list[i]!.name}" (${list[i]!.id}) by ${r1(hit.width)} × ${r1(hit.height)} px. Stickies sit in a ` +
            "grid with a 64 px gap and never touch (figma_move_nodes).");
      }
    }
  }

  const lookup = maybeApi()?.getNodeByIdAsync as ((id: string) => Promise<unknown>) | undefined;
  const exists = new Map<string, boolean>();
  for (const c of found.connectors) {
    const a = view(c);
    for (const [side, endpoint] of [["start", a.connectorStart], ["end", a.connectorEnd]] as const) {
      const id = endpointNode(endpoint);
      if (!id || typeof lookup !== "function") continue;
      if (!exists.has(id)) {
        if (exists.size >= 500) continue;
        exists.set(id, Boolean(await lookup.call(maybeApi(), id).catch(() => null)));
      }
      if (exists.get(id) === false) {
        add(c, "dangling_connector", "error",
          `its ${side} is attached to ${id}, which no longer exists — the line points at nothing. Attach it to a node ` +
            "(figma_edit_connectors) or delete it.");
      }
    }
    const { label } = connectorLabel(c);
    if (label.length > 40) {
      add(c, "label_too_long", "info",
        `its label is ${label.length} characters; a connector label is a few words (a verb from the source's side). ` +
          "Put the detail in a sticky or a note beside it.");
    }
  }

  for (const [name, list] of found.sections) {
    if (list.length < 2) continue;
    add(list[1]!, "section_name_duplicate", "info",
      `${list.length} sections are named "${name}" (${list.map((s) => s.id).join(", ")}) — a reader cannot tell the zones apart. Rename all but one.`);
  }
}

export async function checkLayout(
  root: NodeLike,
  maxNodes: number,
  ctx: Pick<OpContext, "yieldToHost" | "isCancelled">,
  opts: CheckOptions = {},
) {
  const issues: Issue[] = [];
  const texts: Array<{ id: string; name: string; box: Rect; order: number; node: NodeLike }> = [];
  const rawColors = new Map<string, number>();
  let checked = 0;
  let truncated = false;
  const add = (n: NodeLike, kind: string, severity: Severity, detail: string) =>
    issues.push({ kind, severity, nodeId: n.id, name: n.name, detail });
  const audit = opts.audit ?? new Set<AuditKind>();
  const expected = opts.expectFonts?.map((f) => f.trim().toLowerCase());
  // Token findings wait for the walk to end: whether the file has a system to
  // bind to is only known once every node has been seen (designSystem()).
  const tokenFindings: TokenFinding[] = [];
  const fonts = new Map<string, number>();
  const signals = { bound: false, styleIds: new Set<string>() };
  // Outside Figma Design a member a node lacks may throw on read [C-145]: read
  // every node through the guard there (and FigJam / Slides types anywhere).
  const guard = guardAll();
  const views = new Map<NodeLike, Any>();
  const view: View = (x) => {
    let v = views.get(x);
    if (!v) views.set(x, (v = readView(x, guard)));
    return v;
  };
  // audit "board": what the official board rules need after the walk.
  const board = audit.has("board");
  const stickies = new Map<NodeLike, NodeLike[]>(); // parent → its stickies
  const connectors: NodeLike[] = [];
  const sections = new Map<string, NodeLike[]>(); // name → sections
  // Slides: direct children of a slide reported as wholly outside it, and for
  // each node on a slide, the slide and the slide's child it sits under. Filled
  // as the walk goes down, so a Design file pays nothing for it.
  const offSlide = new Set<NodeLike>();
  const onSlide = new Map<NodeLike, { slide: NodeLike; top: NodeLike }>();
  {
    // The root itself may sit on a slide (a card checked on its own).
    let top: NodeLike = root;
    let p = field<NodeLike | null>(root, "parent");
    while (p && p.type !== "SLIDE" && p.type !== "PAGE" && p.type !== "DOCUMENT" && !OPAQUE_TYPES.has(p.type)) {
      top = p;
      p = field<NodeLike | null>(p, "parent");
    }
    if (p?.type === "SLIDE") onSlide.set(root, { slide: p, top });
  }
  // The brief's numbers, where the caller gave none: its floor and safe area
  // (frame px, as the parameters), and on a platform with a text minimum
  // that minimum at each frame's scale (role spec §4.0). The safe area is in
  // a deliverable's coordinates, so it applies only to a top-level root.
  const brief = opts.brief;
  const briefFloor = typeof brief?.lines.minTextSize === "number" && brief.lines.minTextSize > 0 ? brief.lines.minTextSize : undefined;
  const minTextSize = opts.minTextSize ?? briefFloor;
  let safe = opts.safeArea;
  const rootParent = field<NodeLike | null>(root, "parent");
  if (!safe && brief?.lines.safeArea && (rootParent?.type === "PAGE" || rootParent?.type === "SECTION")) {
    try {
      safe = parseSafeArea(brief.lines.safeArea);
    } catch {
      safe = undefined; // the brief's own line is malformed: no safe area to judge, not a failed check
    }
  }
  const textFloor = minTextSize === undefined && brief ? textFloorOf(roleContext({ brief })) : undefined;
  // audit "craft" / "tells" and the role audits: every visible layer, judged once the walk is done.
  const census: Census | null = audit.has("craft") || audit.has("tells") || ROLE_AUDITS.some((k) => audit.has(k))
    ? {
        rootNode: root, root: null, layers: [], backdrop: (x) => backdrop(x, view),
        ...(minTextSize !== undefined ? { minTextSize } : {}),
        ...(textFloor ? { textFloor } : {}),
      }
    : null;
  if (census && safe) {
    // In the root's coordinates; a page has no box, so its origin is the canvas's.
    const o = rect(view(root));
    const s = safe;
    census.safeArea = { x: (o?.x ?? 0) + s.x, y: (o?.y ?? 0) + s.y, width: s.width, height: s.height };
    census.safeAreaText = `"${s.x},${s.y},${s.width},${s.height}"`;
  }
  // Inactive components and logotypes: the exceptions WCAG 2.2 SC 1.4.3 and
  // 1.4.11 make to contrast (role spec §4.0). One verdict per node, shared
  // by its descendants.
  const inactiveMemo = new Map<NodeLike, boolean>();
  const isInactive = (n: NodeLike): boolean => {
    const known = inactiveMemo.get(n);
    if (known !== undefined) return known;
    const p = field<NodeLike | null>(n, "parent");
    const v = ((n.type === "COMPONENT" || n.type === "INSTANCE") && shownInactive(n, view(n)))
      || (!!p && p.type !== "PAGE" && p.type !== "DOCUMENT" && !OPAQUE_TYPES.has(p.type) && isInactive(p));
    inactiveMemo.set(n, v);
    return v;
  };
  // audit "handoff": how much of what is here is bound to the file's system (handoff.ts).
  const handoff: HandoffTally | null = audit.has("handoff") ? emptyTally() : null;
  // Keyframes anywhere: the census measures one state of the motion, not the motion.
  const motion = { found: false, off: false };
  const keyed = new Map<NodeLike, string[]>();
  /** The fields `n`'s keyframe tracks animate, read once; none once the Motion flag is known to be off. */
  const keyedFields = (n: NodeLike): string[] => {
    let f = keyed.get(n);
    if (f) return f;
    f = [];
    // A page, a slide grid or a row carries no keys, and the opaque ones are never read [C-136].
    if (!motion.off && n.type !== "PAGE" && !OPAQUE_TYPES.has(n.type)) {
      // Without the per-user Motion flag every read throws this: ask no more.
      const tracks = tryGet(view(n), "manualKeyframeTracks");
      if (tracks.ok) f = tracksToFieldNames(tracks.value).map((x) => x.toUpperCase());
      else motion.off = /not a supported API/i.test(tracks.message);
    }
    if (f.length) motion.found = true;
    keyed.set(n, f);
    return f;
  };
  // Under a motion brief: which layer's keys carry each layer where it is seen (the file's head comment).
  const seen = brief?.role === "motion";
  const carriers = new Map<NodeLike, NodeLike | null>();
  /** `n` when its own keys move it or its parent's keys move its children; else its parent's carrier; null for the root. */
  const carrierOf = (n: NodeLike): NodeLike | null => {
    if (n === root) return null;
    const known = carriers.get(n);
    if (known !== undefined) return known;
    const p = field<NodeLike | null>(n, "parent");
    const own = keyedFields(n).some((f) => MOVES.test(f));
    const byParent = !!p && keyedFields(p).some((f) => MOVES_CHILDREN.test(f));
    const c = own || byParent ? n : p ? carrierOf(p) : null;
    carriers.set(n, c);
    return c;
  };
  const notJudged = new Map<string, number>();
  const unjudged = (kind: string) => notJudged.set(kind, (notJudged.get(kind) ?? 0) + 1);
  /** Under a motion brief: true, and counted, when keys move one of the two and not the other with it. */
  const apart = (kind: string, a: NodeLike, b: NodeLike): boolean => {
    if (!seen || carrierOf(a) === carrierOf(b)) return false;
    unjudged(kind);
    return true;
  };
  let moved = 0;
  if (census && seen) {
    census.carrier = carrierOf;
    census.unjudged = unjudged;
  }

  // Document order, root first, so "later in paint order" is comparable by index:
  // a later sibling of any ancestor paints above the whole subtree before it.
  const painted: Array<{ node: NodeLike; cover: Cover; order: number }> = [];
  const ancestorsOf = (n: NodeLike): Set<string> => {
    const out = new Set<string>();
    let p = field<NodeLike | null>(n, "parent");
    while (p) {
      out.add(p.id);
      p = field<NodeLike | null>(p, "parent");
    }
    return out;
  };

  const stack: NodeLike[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (OPAQUE_TYPES.has(n.type)) {
      // A slide grid or row: no paint, no layout, and reading either throws
      // [C-136] — walk through to the slides, read nothing.
      if (++checked > maxNodes) {
        truncated = true;
        break;
      }
      const kids = childrenOf(n) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
      continue;
    }
    const a = view(n);
    if (a.visible === false) continue; // hidden: nothing of it is seen, so nothing of it is wrong
    if (n !== root && isBriefNote(n, a)) continue; // the brief block: a note about the work, not the work
    if (++checked > maxNodes) {
      truncated = true;
      break;
    }
    if (checked % 200 === 0) {
      if (ctx.isCancelled()) break;
      await ctx.yieldToHost();
    }
    const box = rect(a);
    const parentNode = field<NodeLike | null>(n, "parent");
    const parent = parentNode && !OPAQUE_TYPES.has(parentNode.type) ? view(parentNode) : undefined;
    // Document order is paint order (a later sibling paints above), so a running
    // counter decides which of two overlapping layers is actually on top.
    const order = checked;
    // Every painted non-text layer counts, frames included: the layer that hid the
    // text in the reported case was a frame with a solid fill. A frame that is an
    // ancestor of the text paints behind it and is excluded below.
    // A connector is not one: its ink is the routed line, not its box, so text
    // beside an elbow would read as covered.
    if (n !== root && n.type !== "TEXT" && n.type !== "CONNECTOR") {
      const c = coverage(a, box);
      if (c) painted.push({ node: n, cover: c, order });
    }
    if (census && box) {
      const layer = layerOf(n, a, box, order, parent, view, isInactive(n));
      if (n === root) census.root = layer;
      else census.layers.push(layer);
    }
    if (seen) {
      if (n !== root && carrierOf(n)) moved++;
    } else if (census && !motion.found) keyedFields(n);
    if (box && parentNode && parent && n !== root && parentNode.type === "SLIDE") {
      slideBounds(n, box, rect(parent), parentNode, add, offSlide);
    } else if (box && parentNode && parent && n !== root && CONTAINERS.has(parentNode.type)) {
      const pb = rect(parent);
      if (pb) {
        const sides = overSides(box, pb);
        if (sides.length) {
          if (parent.clipsContent === true) {
            if (!apart("clipped", n, parentNode)) {
              add(n, "clipped", n.type === "TEXT" ? "error" : "warning",
                `${sides.join(", ")} of it is cut off by "${parentNode.name}" (clips content). Make room, let it wrap or shrink, ` +
                  "or stop the parent clipping (figma_set_clips_content).");
            }
          } else if (n.type === "TEXT" && a.textAutoResize === "WIDTH_AND_HEIGHT") {
            if (!apart("text_overflow", n, parentNode)) {
              add(n, "text_overflow", "error",
                `runs ${sides.join(", ")} past "${parentNode.name}": it hugs its text, so it never wraps. Give it a width ` +
                  "(figma_resize_nodes) or let it fill the column, then it wraps.");
            }
          } else if (board && parentNode.type === "SECTION") {
            // A board's sections must encompass their children (position-figjam-nodes.md:25-27) [C-160].
            add(n, "section_overflow", "warning",
              `sticks out of the section "${parentNode.name}" by ${sides.join(", ")}. Grow the section to hold it ` +
                "(figma_fit_sections, or figma_resize_nodes on the section), or move it inside.");
          } else if (a.layoutPositioning !== "ABSOLUTE" && !apart("outside_parent", n, parentNode)) {
            add(n, "outside_parent", "warning", `sticks out of "${parentNode.name}" by ${sides.join(", ")}.`);
          }
        }
      }
    }
    // Text deeper in a slide that the slide's edge cuts — the frame holding it
    // bleeds, the text in it is cut. A direct child was judged above, and a
    // branch already reported as wholly off the slide is not reported again.
    const place = onSlide.get(n);
    if (n.type === "TEXT" && box && place && place.top !== n && !offSlide.has(place.top)) {
      const slideBox = rect(view(place.slide));
      const sides = slideBox ? overSides(box, slideBox) : [];
      if (sides.length) {
        add(n, "text_cut_by_slide", "error",
          `runs ${sides.join(", ")} past the edge of the slide "${place.slide.name}", which cuts it off. Move it in, or give it a width so it wraps.`);
      }
    }

    // A FILL child of an auto-layout that HUGS that same axis: each waits for
    // the other's size, and the child collapses (the official gotchas' trap).
    // Only when no sibling in the flow sizes that axis: a hugging column with a
    // 1000 px row in it is 1000 px wide, and a heading filling it renders fine
    // (measured live, 2026-10-09) — the trap is when every child fills.
    if (parentNode && parent && AUTO_LAYOUT.has(String(parent.layoutMode))) {
      const flow = (childrenOf(parentNode) ?? []).filter((s) => view(s).visible !== false && view(s).layoutPositioning !== "ABSOLUTE");
      for (const [axis, word] of [["Horizontal", "width"], ["Vertical", "height"]] as const) {
        const sized = flow.some((s) => s !== n && view(s)[`layoutSizing${axis}`] !== "FILL");
        if (a[`layoutSizing${axis}`] === "FILL" && parent[`layoutSizing${axis}`] === "HUG" && !sized) {
          add(n, "fill_in_hug", "warning",
            `fills the ${word} of "${parentNode.name}", which hugs its content on that axis — the two sizes wait on each other and it collapses. ` +
              `Give "${parentNode.name}" a fixed or fill ${word} (figma_resize_nodes sizing), or let this one hug.`);
        }
      }
    }

    if (n.type === "TEXT") {
      const chars = typeof a.characters === "string" ? a.characters : "";
      if (!chars.trim()) add(n, "empty_text", "info", "has no text.");
      const size = typeof a.fontSize === "number" ? a.fontSize : 12;
      // A thread: so narrow that each line holds a character or two, so tall it
      // is clearly many lines. zero_size never sees it (8 × 3000 is not zero).
      if (box && chars.trim().length > 3 && box.width < Math.max(8, 2 * size) && box.height > 4 * lineHeightPx(a)) {
        add(n, "text_collapsed", "error",
          `is ${r1(box.width)} px wide and ${r1(box.height)} px tall — collapsed into a thread, about one character per line. ` +
            "Give it a width, or let it fill its column (figma_resize_nodes sizing { horizontal: \"fill\" }).");
      }
      const standIn = STAND_IN.exec(chars);
      if (PLACEHOLDER.test(chars.trim())) add(n, "placeholder_text", "info", `still reads "${chars.trim().slice(0, 40)}" — template copy, not content.`);
      else if (standIn) {
        add(n, "placeholder_text", "info",
          `names "${standIn[0]}" — a template's stand-in person, brand or domain, not content. Write a plausible specific one and list it as a placeholder to replace.`);
      }
      // Overlap is judged on the rendered glyphs (absoluteRenderBounds): a text
      // that fills a row has a box as wide as the row, and judging that box flagged
      // a cursor bubble sitting over empty space as covering the title (measured live).
      const glyphs = (a.absoluteRenderBounds as Rect | null | undefined) ?? box;
      if (glyphs && chars.trim()) texts.push({ id: n.id, name: n.name, box: glyphs, order, node: n });
      const fg = visibleSolid(a.fills);
      const bg = backdrop(n, view);
      // WCAG 2.2 SC 1.4.3 sets no contrast for text in an inactive component,
      // and none for a logotype: a disabled label is meant to recede, and a
      // brand's mark is drawn as the brand draws it (role spec §4.0).
      if (fg && bg && fg.opacity >= 0.99 && !isInactive(n)) {
        const ratio = contrastRatio(fg.color, bg);
        const need = isLargeText(a) ? 3 : 4.5;
        if (ratio < need) {
          const logo = inLogotype(n);
          add(n, "low_contrast", logo ? "info" : "warning",
            `contrast ${ratio.toFixed(2)}:1 (${hex(fg.color)} on ${hex(bg)}); ` +
              (logo
                ? "it is part of a logo, which WCAG 2.2 SC 1.4.3 exempts from text contrast — fine if this is the logotype."
                : `text this size needs ${need}:1 to read comfortably.`));
        }
      }
      // FigJam text is Charcoal unless the brief says otherwise (create-text.md:143-145) [C-156].
      if (board && fg && hex(fg.color).toLowerCase() !== FIGJAM_TEXT_DEFAULT.toLowerCase()) {
        add(n, "text_not_charcoal", "info",
          `is ${hex(fg.color)}; board text is Charcoal ${FIGJAM_TEXT_DEFAULT} unless the brief asks otherwise — hierarchy comes from size, not colour.`);
      }
    }

    if (DEFAULT_NAME.test(n.name) && n !== root) add(n, "default_name", "info", `still has Figma's default name — name it for what it is.`);
    // A straight connector is as flat as a line: no height is not invisible.
    if (box && (box.width < 1 || box.height < 1) && !["LINE", "VECTOR", "CONNECTOR"].includes(n.type)) {
      add(n, "zero_size", "warning", `is ${r1(box.width)} × ${r1(box.height)} px — invisible.`);
    }
    if (board) {
      offPalette(n, a, add);
      if (n.type === "STICKY" && parentNode) stickies.set(parentNode, [...(stickies.get(parentNode) ?? []), n]);
      if (n.type === "CONNECTOR") connectors.push(n);
      if (n.type === "SECTION" && n.name.trim()) sections.set(n.name.trim(), [...(sections.get(n.name.trim()) ?? []), n]);
    }
    const kids = childrenOf(n) ?? [];
    if (n.type === "FRAME" && kids.length === 0) {
      const painted = [a.fills, a.strokes, a.effects].some((l) => Array.isArray(l) && l.some((p) => (p as Any).visible !== false));
      if (!painted) add(n, "empty_frame", "info", "is empty and paints nothing.");
    }

    // Raw colours: a solid paint bound to neither a style nor a variable.
    for (const [list, styleKey] of [[a.fills, "fillStyleId"], [a.strokes, "strokeStyleId"]] as const) {
      if (!Array.isArray(list) || (typeof a[styleKey] === "string" && a[styleKey] !== "")) continue;
      for (const p of list as Any[]) {
        if (p.type !== "SOLID" || p.visible === false) continue;
        if ((p.boundVariables as Any | undefined)?.color) continue;
        const key = hex(p.color as Rgb);
        rawColors.set(key, (rawColors.get(key) ?? 0) + 1);
      }
    }

    // Stacked cards or variants: frames on top of each other in a parent with
    // no layout. Info, not a warning — deliberate overlap is a documented recipe.
    // Slides are never STACKABLE, and their rows are never read: slides side by
    // side in a row are a deck, not a stack.
    if (a.layoutMode === "NONE" || n.type === "PAGE") {
      const stacked = kids.filter((k) => STACKABLE.has(k.type) && view(k).visible !== false
        && view(k).layoutPositioning !== "ABSOLUTE" && view(k).isMask !== true);
      for (let i = 0; i < stacked.length && i < 200; i++) {
        for (let j = i + 1; j < stacked.length && j < 200; j++) {
          const A = rect(view(stacked[i]!));
          const B = rect(view(stacked[j]!));
          const hit = A && B ? intersect(A, B) : null;
          if (!hit) continue;
          const smaller = Math.min(A!.width * A!.height, B!.width * B!.height);
          const share = smaller > 0 ? (hit.width * hit.height) / smaller : 0;
          if (share > 0.5 && !apart("sibling_overlap", stacked[i]!, stacked[j]!)) {
            add(stacked[i]!, "sibling_overlap", "info",
              `sits under "${stacked[j]!.name}" (${stacked[j]!.id}), ${Math.round(share * 100)}% of the smaller one covered — stacked rather than laid out. ` +
                "Move one, or give the parent auto-layout.");
          }
        }
      }
    }

    // What a library-themed file leaves behind even with no local tokens.
    if (hasBinding(a)) signals.bound = true;
    for (const k of ["fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId"]) {
      if (typeof a[k] === "string" && a[k] !== "") signals.styleIds.add(a[k] as string);
    }
    // An instance's paint and spacing are its component's: judged there, once,
    // not again on every copy of it.
    if (audit.has("tokens") && n.type !== "INSTANCE" && !insideInstance(n)) tokenFindings.push(...unboundTokens(n, a));
    if (handoff && !insideInstance(n)) tallyNode(handoff, n, a);

    if (audit.has("fonts") && n.type === "TEXT") {
      const fromSystem = insideInstance(n);
      const families = new Map<string, string>();
      for (const s of fontSegments(a)) if (!families.has(s.family)) families.set(s.family, s.textStyleId);
      for (const [family, styleId] of families) {
        fonts.set(family, (fonts.get(family) ?? 0) + 1);
        if (!expected || expected.includes(family.toLowerCase())) continue;
        // Inside a component or under a text style the family came from the
        // system: a gap to fix there, not a free-text slip to fix here.
        if (fromSystem || styleId) {
          add(n, "ds_font_gap", "info", `uses ${family} from ${fromSystem ? "its component" : "its text style"}, not ${opts.expectFonts!.join(" / ")} — a design-system gap; fix it in the ${fromSystem ? "component" : "style"}.`);
        } else {
          add(n, "wrong_font", "warning", `uses ${family}; this design expects ${opts.expectFonts!.join(" / ")}. figma_set_text_properties { fontFamily } changes it.`);
        }
      }
    }

    const below = n.type === "SLIDE" ? n : place?.slide;
    if (below) for (const k of kids) onSlide.set(k, { slide: below, top: n.type === "SLIDE" ? k : place!.top });
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }

  // Text a painted layer sits on top of. Judging text against text alone missed
  // this completely: a bubble's fill covered a row's first word while both texts
  // stayed clear of each other, and check_layout still returned ok: true.
  //
  // Run after the walk, not while it goes: a text is visited before the layer that
  // covers it, because the covering layer is painted later — that is what covering
  // means. Comparing during the walk would only ever see the layers behind.
  const ancestors = new Map<string, Set<string>>();
  for (const t of texts) {
    if (!ancestors.has(t.id)) ancestors.set(t.id, ancestorsOf(t.node));
    const anc = ancestors.get(t.id)!;
    for (const p of painted) {
      if (p.node.id === t.id || anc.has(p.node.id)) continue; // its own card paints behind it
      if (p.order < t.order) continue; // painted below this text: it cannot hide it
      // A little translucency tints the text; a lot of it hides the text.
      if (p.cover.opacity < 0.6) continue;
      const cover = clipToAncestors(p.cover, p.node, view);
      if (!cover || !hides(cover, t.box)) continue;
      if (apart("covered", t.node, p.node)) continue;
      // The area of the TEXT that is hidden — not the size of the covering layer.
      const hidden = intersect(cover.outer, t.box)!;
      const area = Math.max(1, Math.round(hidden.width * hidden.height));
      const share = Math.round((100 * area) / Math.max(1, t.box.width * t.box.height));
      issues.push({
        kind: "covered", severity: "error", nodeId: t.id, name: t.name,
        detail: `is painted over by "${p.node.name}" (${p.node.id}), which hides ${area} px² of it (${share}% of the text). ` +
          `The text is still in the file and still reads correctly in the layer list — it just cannot be seen. ` +
          `Move one of them, or reorder so this text is painted above.`,
      });
    }
  }

  // Text over text is never intended: two labels cannot both be read.
  const cap = Math.min(texts.length, 400);
  for (let i = 0; i < cap; i++) {
    for (let j = i + 1; j < cap; j++) {
      const A = texts[i]!.box;
      const B = texts[j]!.box;
      const ox = Math.min(A.x + A.width, B.x + B.width) - Math.max(A.x, B.x);
      const oy = Math.min(A.y + A.height, B.y + B.height) - Math.max(A.y, B.y);
      if (ox > 2 && oy > 2 && !apart("overlap", texts[i]!.node, texts[j]!.node)) {
        issues.push({
          kind: "overlap", severity: "error", nodeId: texts[i]!.id, name: texts[i]!.name,
          detail: `overlaps the text "${texts[j]!.name}" (${texts[j]!.id}) by ${r1(ox)} × ${r1(oy)} px.`,
        });
      }
    }
  }

  // ── audits ────────────────────────────────────────────────────────────────
  let system: { found: boolean; why: string } | undefined;
  if (audit.has("tokens") && !opts.deferTokens) {
    system = await designSystem(signals);
    issues.push(...(await judgeTokens(tokenFindings, system)));
  }
  if (audit.has("names")) {
    let page: NodeLike | null | undefined = root;
    while (page && page.type !== "PAGE") page = page.parent as NodeLike | null | undefined;
    if (page) await duplicateNames(page, add);
  }
  if (board) await boardRules({ stickies, connectors, sections }, view, add);
  // tells: the root's structure, for skeleton_repeat across the roots of one call (the op compares them).
  let structure: string | null = null;
  if (census) {
    const ix = indexCensus(census);
    if (audit.has("craft")) issues.push(...judgeCraft(census, ix));
    if (audit.has("tells")) {
      issues.push(...judgeTells(census, ix));
      structure = structureOf(census, ix);
    }
    if (ROLE_AUDITS.some((k) => audit.has(k))) {
      const named = audit.has("a11y") || audit.has("states") || audit.has("copy");
      const rc = roleContext({
        ...(brief ? { brief } : {}),
        mains: named ? await mainsOf(census) : new Map(),
        audits: audit,
        frames: audit.has("states") || audit.has("mark") ? await framesFor(root, brief, audit.has("mark")) : [],
      });
      if (audit.has("a11y")) issues.push(...judgeA11y(census, ix, rc));
      if (audit.has("states")) issues.push(...judgeStates(census, ix, rc));
      if (audit.has("copy")) issues.push(...judgeCopy(census, ix, rc));
      if (audit.has("system")) issues.push(...judgeSystem(census, ix, rc));
      if (audit.has("deck")) issues.push(...judgeDeck(census, ix, rc));
      if (audit.has("mark")) issues.push(...judgeMark(census, ix, rc));
      if (audit.has("icons")) issues.push(...judgeIcons(census, ix, rc));
      // The file's tokens: read once here, the one lookup the library audit makes.
      if (audit.has("library")) issues.push(...judgeLibrary(census, ix, rc, await readLibrary(maybeApi())));
    }
  }
  // What the brief avoids is a warning at the page and top gears, here and at sign-off.
  bindAvoid(issues, brief);

  return {
    issues,
    checked: Math.min(checked, maxNodes),
    truncated,
    rawColors,
    signals,
    ...(motion.found ? { animated: true as const } : {}),
    // Under a motion brief: how many layers keys move, and the findings left to the frames, by kind.
    ...(seen && moved > 0 ? { restPose: { moved, notJudged: Object.fromEntries([...notJudged].sort((x, y) => (x[0] < y[0] ? -1 : 1))) } } : {}),
    ...(system ? { system } : {}),
    ...(audit.has("tokens") && opts.deferTokens ? { tokenFindings } : {}),
    ...(audit.has("fonts") ? { fonts: Object.fromEntries([...fonts].sort((x, y) => y[1] - x[1])) } : {}),
    ...(handoff ? { handoff } : {}),
    ...(structure !== null ? { structure } : {}),
  };
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** What the role audits measured without a brief: a11y as for the web, and the audits that need its numbers skip them. */
function noBrief(audit: ReadonlySet<AuditKind>): string {
  const ran = NEEDS_BRIEF.filter((k) => audit.has(k));
  const named = ran.length ? ran : ["system"];
  const list = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}` : named[0]!;
  return `none: a11y measures as for the web in CSS px, and ${list} skip${named.length > 1 ? "" : "s"} what needs the brief's numbers (pass briefId)`;
}

/** `audit` as sent: an array of the AUDITS names; anything else is refused by name. */
function auditParam(params: Record<string, unknown>): Set<AuditKind> {
  const raw = params.audit;
  if (raw === undefined) return new Set();
  if (!Array.isArray(raw) || raw.some((k) => !(AUDITS as readonly unknown[]).includes(k))) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`audit\` lists any of: ${AUDITS.join(", ")}.`);
  }
  return new Set(raw as AuditKind[]);
}

const checkLayoutOp: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const figma = api();
    const id = str(ctx.params, "nodeId");
    const ids = ctx.params.nodeIds === undefined ? undefined : strList(ctx.params, "nodeIds");
    if (ctx.params.nodeIds !== undefined && (!ids || ids.length > 100)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeIds` must list 1–100 node ids.");
    }
    if (id && ids) throw new BridgeError(ErrorCode.INVALID_PARAM, "Pass `nodeId` or `nodeIds`, not both.");
    const audit = auditParam(ctx.params);
    const expectFonts = strList(ctx.params, "expectFonts");
    if (expectFonts) audit.add("fonts"); // naming the fonts is asking for the font check
    // A safe area or a size floor is asking for the craft audit, which judges both.
    const safeArea = parseSafeArea(ctx.params.safeArea);
    const minTextSize = parseMinTextSize(ctx.params.minTextSize);
    if (safeArea || minTextSize !== undefined) audit.add("craft");
    // Every selected root, not the page: three selected cards are three cards to
    // check, and falling back to the whole page silently checked something else.
    // Read from the page, where the selection lives [C-097]. In a deck with
    // nothing selected, the slide on screen; `nodeIds` checks a batch of 3–5
    // slides in one call (figma-use-slides/SKILL.md:87-91) [C-155].
    const selected = selectionOf(figma);
    let note: string | undefined;
    let roots: NodeLike[];
    if (ids) {
      roots = [];
      for (const one of ids) roots.push(await byId(figma, one));
    } else if (id) roots = [await byId(figma, id)];
    else if (selected.length) roots = [...(selected as unknown as NodeLike[])];
    else {
      const slide = field((figma as unknown as Any) ?? {}, "editorType") === "slides" ? tryGet<NodeLike | null>(figma.currentPage, "focusedSlide") : undefined;
      if (slide?.ok && slide.value?.type === "SLIDE") {
        roots = [slide.value];
        note = `Nothing is selected, so this checks the focused slide "${slide.value.name}". Pass nodeIds to check a batch of slides.`;
      } else {
        roots = [figma.currentPage];
        if (slide) note = "Nothing is selected and no slide is focused, so this checks the whole deck. Pass nodeIds to check a batch of slides.";
      }
    }
    // The brief whose numbers the audits measure against (role spec §4), read
    // off the node it is stored on (briefOfCheck). Naming one asks for no audit
    // by itself, but tells at the page and top gears (shared/avoid.ts tellsByDefault).
    const chosen = await briefOfCheck(figma, roots, str(ctx.params, "briefId"), str(ctx.params, "briefInForce"));
    const brief = chosen?.brief;
    if (brief && tellsByDefault(brief.role, brief.gear, avoidOf(brief))) audit.add("tells");
    const maxNodes = int(ctx.params, "maxNodes", 3000, 50000);
    const limit = int(ctx.params, "limit", 100, 1000);
    const minSeverity = (str(ctx.params, "minSeverity") ?? "info") as Severity;

    const issues: Issue[] = [];
    const rawColors = new Map<string, number>();
    const fonts = new Map<string, number>();
    const signals = { bound: false, styleIds: new Set<string>() };
    const tokenFindings: TokenFinding[] = [];
    const handoff = emptyTally();
    const seen = new Set<string>();
    // tells: each root's structure, for skeleton_repeat across the roots (tells.ts skeletonAcross).
    const structures: Array<{ node: NodeLike; structure: string }> = [];
    let checked = 0;
    let truncated = false;
    let animated = false;
    const rest = { moved: 0, notJudged: {} as Record<string, number> };
    for (const root of roots) {
      // Another page's children cannot be read until it is loaded [C-090].
      await ensureLoaded(root as never);
      const budget = maxNodes - checked;
      if (budget <= 0) {
        truncated = true;
        break;
      }
      // Names are a page-wide check: once is enough however many roots share the page.
      const runAudit = new Set([...audit].filter((k) => k !== "names" || root === roots[0]));
      const r = await checkLayout(root, budget, ctx, {
        audit: runAudit,
        deferTokens: true,
        ...(expectFonts ? { expectFonts } : {}),
        ...(safeArea ? { safeArea } : {}),
        ...(minTextSize !== undefined ? { minTextSize } : {}),
        ...(brief ? { brief } : {}),
      });
      // A finding about the brief itself (screen_state_missing) comes back from every root: keep one.
      for (const i of r.issues) {
        const key = `${i.kind}\u0000${i.nodeId}\u0000${i.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push(i);
      }
      checked += r.checked;
      truncated ||= r.truncated;
      animated ||= r.animated === true;
      if (r.restPose) {
        rest.moved += r.restPose.moved;
        for (const [k, n] of Object.entries(r.restPose.notJudged)) rest.notJudged[k] = (rest.notJudged[k] ?? 0) + n;
      }
      for (const [c, n] of r.rawColors) rawColors.set(c, (rawColors.get(c) ?? 0) + n);
      for (const [fam, n] of Object.entries(r.fonts ?? {})) fonts.set(fam, (fonts.get(fam) ?? 0) + (n as number));
      signals.bound ||= r.signals.bound;
      for (const s of r.signals.styleIds) signals.styleIds.add(s);
      tokenFindings.push(...(r.tokenFindings ?? []));
      if (r.handoff) mergeTally(handoff, r.handoff);
      if (r.structure) structures.push({ node: root, structure: r.structure });
    }
    // Three or more roots built on one structure: one skeleton, filled in again (tells).
    if (audit.has("tells")) issues.push(...skeletonAcross(structures));
    // One verdict for the whole selection, from every root's signals: judged
    // per root, a root with nothing bound lost its findings in a file whose
    // other root proved the system exists — exactly the root to flag.
    const system = audit.has("tokens") || audit.has("handoff") ? await designSystem(signals) : undefined;
    if (system && audit.has("tokens")) issues.push(...(await judgeTokens(tokenFindings, system)));
    const handed = system && audit.has("handoff") ? await handoffReport(handoff, signals.styleIds, system) : undefined;
    if (handed) issues.push(...handed.issues);
    // Each root's own were bound already; this binds any judged across them (it leaves a bound one alone).
    bindAvoid(issues, brief);
    const avoided = boundKinds(brief);

    const shown = issues.filter((i) => ORDER[i.severity] <= (ORDER[minSeverity] ?? 2)).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
    const counts = { error: 0, warning: 0, info: 0 };
    for (const i of issues) counts[i.severity]++;

    // Raw colours matter only when the file has a system to bind them to —
    // local tokens, or a subtree bound to library ones.
    const raw = [...rawColors.entries()].sort((a, b) => b[1] - a[1]);
    const hasSystem = raw.length ? (system ?? (await designSystem(signals))) : undefined;
    const one = roots.length === 1;

    return {
      ...(one ? { root: { id: roots[0]!.id, name: roots[0]!.name, type: roots[0]!.type } } : {}),
      ...(!one ? { roots: roots.map((r) => ({ id: r.id, name: r.name, type: r.type })), scope: ids ? "nodeIds" : "selection" } : {}),
      checked,
      ...(truncated ? { truncated: true, note: `Stopped after maxNodes=${maxNodes}; check a smaller subtree.` } : note ? { note } : {}),
      ok: counts.error === 0 && counts.warning === 0,
      counts,
      issues: shown.slice(0, limit),
      ...(shown.length > limit ? { more: shown.length - limit } : {}),
      ...(audit.size
        ? {
            audit: {
              ran: [...audit],
              ...(system
                ? { designSystem: system.found ? `found: ${system.why}` : `none (${system.why})${audit.has("tokens") ? " — token findings skipped" : ""}` }
                : {}),
              ...(chosen
                ? {
                    brief: {
                      id: chosen.brief.id, title: chosen.brief.title, role: chosen.brief.role, gear: chosen.brief.gear, platform: roleContext({ brief: chosen.brief }).platform,
                      from: chosen.from,
                      // The kinds the brief avoids at its gear: a finding of one is a warning here.
                      ...(avoided.length ? { avoid: avoided } : {}),
                      ...(chosen.note ? { note: chosen.note } : {}),
                    },
                  }
                : ROLE_AUDITS.some((k) => audit.has(k))
                  ? { brief: noBrief(audit) }
                  : {}),
              // Bounds read a keyed layer's base (resting) values, not the state at the playhead [C-192].
              ...(animated
                ? {
                    note:
                      "Layers here have keyframes: craft and tells measure one state — the values the document holds — not the motion. Render it to judge the motion." +
                      (brief?.role === "motion" ? "" : " A motion brief (briefId) leaves to the frames what rests on a keyed layer's rest pose, as figma_sign_off does."),
                  }
                : {}),
            },
          }
        : {}),
      ...(rest.moved > 0 ? { restPose: { ...rest, note: restPoseNote(rest.moved, rest.notJudged) } } : {}),
      ...(audit.has("fonts") ? { fonts: Object.fromEntries([...fonts].sort((x, y) => y[1] - x[1])) } : {}),
      ...(handed ? { handoff: handed.summary } : {}),
      ...(raw.length && hasSystem?.found
        ? {
            rawColors: {
              distinct: raw.length,
              top: raw.slice(0, 8).map(([color, uses]) => ({ color, uses })),
              hint: `Raw hex where a design system exists (${hasSystem.why}). Use it instead: figma_apply_style_to_node or ` +
                "figma_bind_variable_to_node; audit: [\"tokens\"] lists every node.",
            },
          }
        : {}),
    };
  },
};

export const CHECK_OPS: Record<string, PluginOp> = {
  check_layout: checkLayoutOp,
};
