// The role process in the plugin: figma_set_brief, figma_get_brief and
// figma_sign_off (roles spec §3.4–§3.6; the parts' contract in
// docs/superpowers/plans/2026-10-16-roles-contract.md). The server checks
// every parameter, the role's lines and the lenses; this file owns what needs
// the file: the records, the brief block, the measured checks and the
// fingerprint.
//
// Records live in shared plugin data under the namespace the storyboard record
// and the motion plan use [C-188] (src/shared/roles.ts): the brief on its block
// (or on the node or page it was stored on), a sign-off on each deliverable, and
// an index of briefs on the document root. A record's `id` is the id of the
// node it is stored on; a record whose id is another node's was copied along
// with its layer (duplicated) and is not read as a brief. Reading them is
// brief-read.ts's, shared with figma_check_layout's default brief.
//
// Every check runs before the first write (guard.ts), so a refusal changed
// nothing; the runner commits one undo step per call.

import { AVOID_MAX, avoidOf, avoidRefusal, boundKinds } from "../../shared/avoid.js";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { TELL_KINDS } from "../../shared/tells-kinds.js";
import {
  BRIEF_INDEX_KEY,
  BRIEF_KEY,
  BRIEF_LIMITS,
  BRIEF_NAMESPACE,
  ROLES,
  SIGN_OFF_KEY,
  gearFits,
  isGear,
  isReviewer,
  isRole,
  parseBriefIndex,
  parseSignOff,
  reviewerOf,
  reviewOf,
  upsertIndex,
  type Answer,
  type AuditName,
  type BriefIndexEntry,
  type BriefRecord,
  type CheckSummary,
  type Gear,
  type LensScore,
  type RestPose,
  type SignOffRecord,
} from "../../shared/roles.js";
import { childrenOf, field } from "../board-read.js";
import { briefFor, briefOn, fileIndex, pageOf, readShared } from "../brief-read.js";
import { CRAFT_SEVERITY } from "../craft.js";
import { fingerprint } from "../fingerprint.js";
import { beforeMutating, unchanged } from "../guard.js";
import { byId, lookUp, sameLayer, str, type FigmaLike, type NodeLike } from "../read.js";
import { editorType, tryGet } from "../safe.js";
import {
  append,
  applySizing,
  loadFont,
  parseColor,
  place,
  resizeNode,
  textDefaults,
  type FigmaWrite,
  type FrameLike,
  type LoadedFont,
  type NodeLikeW,
  type SolidPaint,
  type TextLike,
} from "../write.js";
import { AUDITS, checkLayout, restPoseNote, type AuditKind, type CheckOptions, type Issue } from "./check.js";
import type { OpContext, PluginOp } from "./index.js";
import { META_OPS } from "./meta.js";
import { emptySpot } from "./storyboard.js";

const api = () => (globalThis as unknown as { figma: FigmaWrite }).figma;
const asRead = (f: FigmaWrite) => f as unknown as FigmaLike;
type Any = Record<string, unknown>;

const isObject = (v: unknown): v is Any => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const invalid = (msg: string, hint?: string) => new BridgeError(ErrorCode.INVALID_PARAM, msg, hint ? { hint } : {});
const unique = <T>(list: readonly T[]): T[] => list.filter((x, i) => list.indexOf(x) === i);

/** UTF-8 length: BRIEF_LIMITS counts bytes, and the sandbox has no TextEncoder (sandbox-globals.d.ts). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function fits(json: string, what: string): void {
  const bytes = utf8Bytes(json);
  if (bytes > BRIEF_LIMITS.bytes) {
    throw invalid(`The ${what} is ${bytes} bytes; one record holds at most ${BRIEF_LIMITS.bytes} (shared plugin data caps an entry at 100 kB).`,
      "Shorten the longest lines, lists and notes.");
  }
}

// ── records on nodes ────────────────────────────────────────────────────────

const canStore = (node: unknown) => typeof field(node, "setSharedPluginData") === "function";

function writeShared(node: NodeLike, key: string, value: string): void {
  const set = field<(ns: string, key: string, value: string) => void>(node, "setSharedPluginData");
  if (typeof set !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, `A ${node.type} takes no shared plugin data in this editor.`);
  set.call(node, BRIEF_NAMESPACE, key, value);
}

/** The sign-off stored on `node`, or why it cannot be read; neither when it holds none. */
export function signOffOn(node: NodeLike): { signOff?: SignOffRecord; invalid?: string } {
  const raw = readShared(node, SIGN_OFF_KEY);
  if (!raw) return {};
  const parsed = parseSignOff(raw);
  return "invalid" in parsed ? { invalid: `"${node.name}" (${node.id}): ${parsed.invalid}` } : { signOff: parsed.signOff };
}

/**
 * The block is marked in this plugin's private data, not by its name: a
 * redraw replaces the block's texts, and a user's frame that happens to be
 * named "Brief · …" (a brief stored on it with `nodeId`) must never be taken
 * for one. Private data is unreadable after a plugin id change [C-188]; the
 * block then reads as a node, and is no longer redrawn — the safe side.
 */
const BLOCK_MARK = "briefBlock";

function isBlock(node: unknown): boolean {
  const get = field<(key: string) => string>(node, "getPluginData");
  try {
    return typeof get === "function" && get.call(node, BLOCK_MARK) === "1";
  } catch {
    return false;
  }
}

function markBlock(node: unknown): void {
  const set = field<(key: string, value: string) => void>(node, "setPluginData");
  if (typeof set === "function") set.call(node, BLOCK_MARK, "1");
}

const storedAs = (holder: NodeLike): "block" | "node" | "page" => (isBlock(holder) ? "block" : holder.type === "PAGE" ? "page" : "node");

// ── the index ───────────────────────────────────────────────────────────────

const entryOf = (b: BriefRecord, pageId: string): BriefIndexEntry => ({
  id: b.id, title: b.title, role: b.role, gear: b.gear, pageId, status: b.status, deliverables: b.deliverables, updatedAt: b.updatedAt,
});

/** The index with `entry` upserted, oldest rows dropped until it fits one record. */
function nextIndex(owner: unknown, entry: BriefIndexEntry): string {
  const rows = upsertIndex(parseBriefIndex(readShared(owner, BRIEF_INDEX_KEY)), entry);
  let json = JSON.stringify(rows);
  while (rows.length > 1 && utf8Bytes(json) > BRIEF_LIMITS.bytes) {
    rows.pop();
    json = JSON.stringify(rows);
  }
  return json;
}

/**
 * Upsert the brief's row on the document root; when writing the root fails
 * (PageNode and DocumentNode both carry setSharedPluginData in the typings,
 * but the root's write is unmeasured live — spec §3.2), on the brief's page.
 */
function writeIndex(figma: FigmaWrite, b: BriefRecord, page: NodeLike): "root" | "page" {
  const entry = entryOf(b, page.id);
  try {
    writeShared(figma.root as unknown as NodeLike, BRIEF_INDEX_KEY, nextIndex(figma.root, entry));
    return "root";
  } catch {
    writeShared(page, BRIEF_INDEX_KEY, nextIndex(page, entry));
    return "page";
  }
}

// ── the block ───────────────────────────────────────────────────────────────

const BLOCK_WIDTH = 720;
const BLOCK_PADDING = 32;
const BLOCK_GAP = 12;
/** The names the block's texts carry: a redraw replaces these and leaves anything else a person put in the block. */
const LINE_NAMES = new Set(["Role · gear", "Message", "Goal", "Audience", "Success", "Tone", "Default to avoid", "Avoid", "Status", "Brief"]);

export interface BlockLine {
  name: string;
  text: string;
  size: number;
}

/** The status line sign-off rewrites. */
export function statusLine(b: BriefRecord): string {
  if (b.status !== "signed") return "Status: open — not signed off";
  return b.lastSignOff?.ok ? `Status: signed off ${b.lastSignOff.at.slice(0, 10)}` : "Status: signed off";
}

/** What the block says (spec §3.4): Role · gear, Message, Goal, Audience, Success, Tone, Default to avoid, Avoid (its tells kinds), and the status. */
export function blockLines(b: BriefRecord): BlockLine[] {
  const l = b.lines;
  const out: BlockLine[] = [{ name: "Role · gear", text: `${b.role} · ${b.gear} — ${ROLES[b.role].professional}`, size: 14 }];
  const add = (name: string, text: string | undefined) => {
    if (typeof text === "string" && text.trim()) out.push({ name, text: `${name}: ${text}`, size: 16 });
  };
  add("Message", l.message);
  add("Goal", l.goal);
  add("Audience", l.audience);
  if (Array.isArray(l.success) && l.success.length) out.push({ name: "Success", text: `Success:\n${l.success.map((s) => `• ${s}`).join("\n")}`, size: 16 });
  if (l.tone && Array.isArray(l.tone.words) && l.tone.words.length) add("Tone", `${l.tone.words.join(", ")}${l.tone.not ? ` — not ${l.tone.not}` : ""}`);
  add("Default to avoid", l.defaultToAvoid);
  const avoid = avoidOf(b);
  if (avoid.length) add("Avoid", avoid.join(", "));
  out.push({ name: "Status", text: statusLine(b), size: 14 });
  return out;
}

interface BlockFont {
  font: LoadedFont;
  fill: SolidPaint;
}

/** The tool's default font and colour for this editor, loaded before anything is written. */
async function blockFont(figma: FigmaWrite): Promise<BlockFont> {
  const defaults = textDefaults(editorType());
  return { font: await loadFont(figma, undefined, defaults.style), fill: parseColor(defaults.color) };
}

function newText(figma: FigmaWrite, f: BlockFont, name: string, text: string, size: number): TextLike {
  const t = figma.createText() as TextLike;
  t.fontName = { family: f.font.family, style: f.font.style };
  t.fontSize = size;
  t.characters = text;
  t.fills = [f.fill];
  t.name = name;
  return t;
}

const isOurText = (n: NodeLike) => n.type === "TEXT" && LINE_NAMES.has(n.name);
const heightOf = (n: unknown) => {
  const h = field<number>(n, "height");
  return typeof h === "number" && Number.isFinite(h) ? h : 0;
};

/**
 * Write the block's lines. The new texts are made first and the old ones
 * removed after, so a failure half-way leaves the block as it was (the new
 * texts are taken out again). In FigJam the block is a section, which has no
 * auto-layout: one text holds every line and the section is sized to it.
 */
function drawLines(figma: FigmaWrite, block: NodeLikeW, b: BriefRecord, f: BlockFont): void {
  const old = (childrenOf(block as unknown as NodeLike) ?? []).filter(isOurText);
  const made: TextLike[] = [];
  try {
    if (block.type === "SECTION") {
      const t = newText(figma, f, "Brief", blockLines(b).map((l) => l.text).join("\n\n"), 16);
      made.push(t);
      append(block, t);
      place(t as unknown as FrameLike, BLOCK_PADDING, BLOCK_PADDING);
      t.resize(BLOCK_WIDTH - 2 * BLOCK_PADDING, Math.max(1, heightOf(t)));
      t.textAutoResize = "HEIGHT";
    } else {
      for (const line of blockLines(b)) {
        const t = newText(figma, f, line.name, line.text, line.size);
        made.push(t);
        append(block, t);
        // Fill the column and wrap in it, as figma_create_text does in a vertical stack [C-072].
        applySizing(t, { horizontal: "FILL" });
        t.textAutoResize = "HEIGHT";
      }
    }
  } catch (err) {
    for (const t of made) t.remove?.();
    throw err;
  }
  for (const t of old) (t as unknown as NodeLikeW).remove?.();
  if (block.type === "SECTION") resizeNode(block, BLOCK_WIDTH, Math.max(1, heightOf(made[0]) + 2 * BLOCK_PADDING));
}

/**
 * A new block at `at` on `page`: a frame with vertical auto-layout, or in
 * FigJam a section (set_brief has checked createSection exists). Removed again
 * if a write to it fails.
 */
function createBlock(figma: FigmaWrite, page: NodeLikeW, title: string, at: { x: number; y: number }): NodeLikeW {
  const figjam = editorType() === "figjam";
  const block = (figjam ? figma.createSection!() : figma.createFrame()) as FrameLike;
  try {
    block.name = `Brief · ${title}`;
    if (page.id !== figma.currentPage.id) append(page, block);
    if (!figjam) {
      block.layoutMode = "VERTICAL";
      block.resize(BLOCK_WIDTH, 100);
      block.primaryAxisSizingMode = "AUTO";
      block.counterAxisSizingMode = "FIXED";
      block.itemSpacing = BLOCK_GAP;
      block.paddingTop = block.paddingRight = block.paddingBottom = block.paddingLeft = BLOCK_PADDING;
      block.fills = [parseColor("#FFFFFF")];
      block.strokes = [parseColor("#D9D9D9")];
      block.strokeWeight = 1;
      block.cornerRadius = 12;
    }
    place(block, at.x, at.y);
    markBlock(block);
  } catch (err) {
    block.remove?.();
    throw err;
  }
  return block;
}

/** A page by id, loaded; or the current page. */
async function pageFor(figma: FigmaWrite, pageId: string | undefined): Promise<NodeLike> {
  if (!pageId) return figma.currentPage as unknown as NodeLike;
  const page = await byId(asRead(figma), pageId);
  if (page.type !== "PAGE") throw invalid(`\`pageId\` \`${pageId}\` is a ${page.type}, not a page.`);
  return page;
}

// ── set_brief ───────────────────────────────────────────────────────────────

const LINE_STRINGS = ["goal", "message", "audience", "givens", "format", "safeArea", "defaultToAvoid"];
const LINE_LISTS = ["success", "proof", "constraints", "assumptions", "references"];
/** Lines a brief always has: an update may change them, never remove them. */
const LINE_KEPT = ["goal", "message", "success"];
/** Fields an update replaces whole, or removes with null. */
const OPTIONAL_FIELDS = ["avoid", "direction0", "directions", "chosen", "styleframes", "system"] as const;
const BRIEF_FIELDS = new Set(["role", "gear", "title", "lines", "details", "deliverables", ...OPTIONAL_FIELDS]);

/** `brief.lines` as sent: each line its type; `null` removes an optional line. */
function checkLines(raw: unknown): Any {
  if (!isObject(raw)) throw invalid("`brief.lines` must be an object of the brief's lines.");
  for (const [k, v] of Object.entries(raw)) {
    const at = `\`brief.lines.${k}\``;
    if (v === null) {
      if (LINE_KEPT.indexOf(k) >= 0) throw invalid(`${at} cannot be removed: a brief always has a goal, a message and its success lines.`);
      continue;
    }
    if (LINE_STRINGS.indexOf(k) >= 0) {
      if (typeof v !== "string") throw invalid(`${at} must be a string.`);
    } else if (LINE_LISTS.indexOf(k) >= 0) {
      if (!isStrings(v)) throw invalid(`${at} must be a list of strings.`);
    } else if (k === "minTextSize") {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw invalid(`${at} must be a number above 0.`);
    } else if (k === "tone") {
      if (!isObject(v) || !isStrings(v.words) || (v.not !== undefined && typeof v.not !== "string")) throw invalid(`${at} must be { words: string[], not?: string }.`);
    } else throw invalid(`${at} is not a line of a brief.`);
  }
  return raw;
}

/** The fields of `brief` as sent, each its type. `creating`: role, gear, title and the goal and message are required. */
function checkBriefParam(raw: unknown, creating: boolean): Any {
  if (!isObject(raw)) throw invalid("`brief` must be an object: { role, gear, title, lines, details, … }.");
  for (const k of Object.keys(raw)) if (!BRIEF_FIELDS.has(k)) throw invalid(`\`brief.${k}\` is not a field a brief takes.`);
  if (raw.role !== undefined && !isRole(raw.role)) throw invalid(`\`brief.role\` ${JSON.stringify(raw.role)} is not a role.`);
  if (raw.gear !== undefined && !isGear(raw.gear)) throw invalid(`\`brief.gear\` ${JSON.stringify(raw.gear)} is not a gear.`);
  if (raw.title !== undefined && (typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > BRIEF_LIMITS.title)) {
    throw invalid(`\`brief.title\` must be 1–${BRIEF_LIMITS.title} characters.`);
  }
  if (raw.lines !== undefined) checkLines(raw.lines);
  if (raw.details !== undefined && !isObject(raw.details)) throw invalid("`brief.details` must be an object.");
  if (raw.deliverables !== undefined && !isStrings(raw.deliverables)) throw invalid("`brief.deliverables` must be a list of node ids.");
  if (raw.styleframes !== undefined && raw.styleframes !== null && !isStrings(raw.styleframes)) throw invalid("`brief.styleframes` must be a list of node ids.");
  if (raw.avoid !== undefined && raw.avoid !== null) {
    if (!Array.isArray(raw.avoid) || raw.avoid.length > AVOID_MAX) throw invalid(`\`brief.avoid\` must be a list of at most ${AVOID_MAX} tells kinds.`);
    const bad = avoidRefusal(raw.avoid);
    if (bad) throw invalid(bad.message.replace("`avoid`", "`brief.avoid`"), bad.hint);
  }
  for (const k of ["direction0", "chosen"]) {
    if (raw[k] !== undefined && raw[k] !== null && typeof raw[k] !== "string") throw invalid(`\`brief.${k}\` must be a string.`);
  }
  if (raw.directions !== undefined && raw.directions !== null) {
    const ok = Array.isArray(raw.directions) && raw.directions.every((d) => isObject(d) && typeof d.name === "string" && typeof d.idea === "string" && (d.total === undefined || typeof d.total === "number"));
    if (!ok) throw invalid("`brief.directions` must be a list of { name, idea, total? }.");
  }
  if (raw.system !== undefined && raw.system !== null && (!isObject(raw.system) || typeof raw.system.bodySize !== "number")) {
    throw invalid("`brief.system` must be an object with a bodySize.");
  }
  if (creating) {
    if (raw.role === undefined || raw.gear === undefined || raw.title === undefined) throw invalid("A new brief needs `brief.role`, `brief.gear` and `brief.title`.");
    const lines = (raw.lines ?? {}) as Any;
    if (typeof lines.goal !== "string" || typeof lines.message !== "string") throw invalid("A new brief needs `brief.lines.goal` and `brief.lines.message`.");
  }
  return raw;
}

/** Merge `changes` into `into` key by key; `null` removes a key. */
function mergeKeys(into: Any, changes: unknown): Any {
  const out: Any = { ...into };
  if (!isObject(changes)) return out;
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** The record a call makes: a new one, or `old` with the fields given merged in. */
function mergeBrief(old: BriefRecord | undefined, p: Any, now: string, reopen: boolean): BriefRecord {
  const base: BriefRecord = old ?? {
    v: 1, id: "", role: p.role as BriefRecord["role"], gear: p.gear as Gear, title: String(p.title), status: "open",
    createdAt: now, updatedAt: now, lines: { goal: "", message: "", success: [] }, details: {}, deliverables: [],
  };
  const next: BriefRecord = {
    ...base,
    ...(p.role !== undefined ? { role: p.role as BriefRecord["role"] } : {}),
    ...(p.gear !== undefined ? { gear: p.gear as Gear } : {}),
    ...(p.title !== undefined ? { title: String(p.title) } : {}),
    lines: mergeKeys(base.lines as unknown as Any, p.lines) as unknown as BriefRecord["lines"],
    details: mergeKeys(base.details, p.details),
    deliverables: unique([...base.deliverables, ...((p.deliverables as string[] | undefined) ?? [])]),
    updatedAt: now,
    status: reopen ? "open" : base.status,
  };
  if (!Array.isArray(next.lines.success)) next.lines.success = [];
  const rec = next as unknown as Any;
  for (const k of OPTIONAL_FIELDS) {
    if (p[k] === null) delete rec[k];
    else if (p[k] !== undefined) rec[k] = p[k];
  }
  return next;
}

/** Ids a call adds must name nodes that exist now; a later sign-off reads each of them. */
async function mustExist(figma: FigmaWrite, ids: readonly string[], fieldName: string, block?: string): Promise<void> {
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `\`${fieldName}\` names ${id}, and no node has that id.`);
    if (node.type === "DOCUMENT") throw invalid(`\`${fieldName}\` names the document; name a frame, a section, a component set or a page.`);
    if (id === block) throw invalid(`\`${fieldName}\` names the brief block itself, a working note: name the work.`);
  }
}

interface SetPlan {
  record: BriefRecord;
  stored: "block" | "node" | "page";
  /** The node the record goes on; absent for a block not drawn yet. */
  holder?: NodeLike;
  page: NodeLike;
  at?: { x: number; y: number };
  font?: BlockFont;
  note?: string;
}

const setBrief: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const plan = await beforeMutating(async (): Promise<SetPlan> => {
      const briefId = str(ctx.params, "briefId");
      const nodeId = str(ctx.params, "nodeId");
      const reopen = ctx.params.reopen === true;
      const block = ctx.params.block;
      if (block !== undefined && typeof block !== "boolean") throw invalid("`block` must be true or false.");
      // An update may change nothing but the status (reopen).
      const p = checkBriefParam(ctx.params.brief === undefined && briefId ? {} : ctx.params.brief, !briefId);
      const now = new Date().toISOString();
      let note: string | undefined;

      let old: BriefRecord | undefined;
      let holder: NodeLike | undefined;
      let stored: SetPlan["stored"];
      let page: NodeLike;
      let at: SetPlan["at"];
      if (briefId) {
        if (nodeId) throw invalid("Pass `briefId` to update a brief or `nodeId` to store a new one, not both.", "A brief stays on the node it was first stored on.");
        holder = await byId(asRead(figma), briefId);
        const found = briefOn(holder);
        if (!found.brief) {
          throw invalid(found.invalid ? `No readable brief on ${briefId}: ${found.invalid}.` : `No brief is stored on "${holder.name}" (${briefId}).`,
            "figma_get_brief with no arguments lists the file's open briefs.");
        }
        old = found.brief;
        stored = storedAs(holder);
        page = pageOf(holder) ?? (figma.currentPage as unknown as NodeLike);
      } else {
        if (reopen) throw invalid("`reopen` takes `briefId`: it opens a brief that was signed off.");
        const slides = editorType() === "slides";
        if (nodeId) {
          if (block === true) throw invalid("Pass `nodeId` to store the brief on a node, or `block: true` to draw a block, not both.");
          holder = await byId(asRead(figma), nodeId);
          if (holder.type === "DOCUMENT") throw invalid("`nodeId` is the document; store a brief on a frame, a section, a slide or a page.");
          stored = holder.type === "PAGE" ? "page" : "node";
          page = pageOf(holder) ?? holder;
        } else {
          // A block by default where the work is a page or more (spec §3.4); a deck keeps its brief on the page.
          let draw = block ?? ["page", "top", "piece"].indexOf(String(p.gear)) >= 0;
          if (draw && slides) {
            draw = false;
            if (block === true) note = "A Slides file has no brief block: the brief is stored on the page.";
          }
          page = await pageFor(figma, str(ctx.params, "pageId"));
          if (draw && editorType() === "figjam" && typeof figma.createSection !== "function") {
            throw new BridgeError(ErrorCode.UNSUPPORTED, "This FigJam has no createSection: the brief block cannot be drawn.", {
              hint: "Pass block: false to store the brief on the page, or nodeId to store it on a section.",
            });
          }
          if (draw) {
            stored = "block";
            const spot = emptySpot(page as unknown as NodeLikeW);
            const x = ctx.params.x;
            const y = ctx.params.y;
            at = { x: typeof x === "number" && Number.isFinite(x) ? x : spot.x, y: typeof y === "number" && Number.isFinite(y) ? y : spot.y };
          } else {
            stored = "page";
            holder = page;
          }
        }
        if (holder) {
          const taken = briefOn(holder);
          if (taken.brief) {
            throw invalid(`"${holder.name}" (${holder.id}) already holds the brief "${taken.brief.title}".`,
              `To change it, pass briefId: "${holder.id}"; for a second brief, store it elsewhere (nodeId) or draw a block (block: true).`);
          }
        }
      }
      if (holder && !canStore(holder)) throw new BridgeError(ErrorCode.UNSUPPORTED, `A ${holder.type} takes no shared plugin data in this editor.`);

      const record = mergeBrief(old, p, now, reopen);
      if (!gearFits(record.role, record.gear)) {
        throw invalid(`The ${record.role} role does not take the ${record.gear} gear; it takes ${ROLES[record.role].gears.join(", ")}.`);
      }
      if (record.deliverables.length > BRIEF_LIMITS.deliverables) throw invalid(`A brief lists at most ${BRIEF_LIMITS.deliverables} deliverables.`);
      const added = record.deliverables.filter((id) => !old || old.deliverables.indexOf(id) < 0);
      await mustExist(figma, added, "brief.deliverables", stored === "block" ? holder?.id : undefined);
      if (Array.isArray(p.styleframes)) await mustExist(figma, p.styleframes as string[], "brief.styleframes", stored === "block" ? holder?.id : undefined);
      // The id is known once the block exists: measure with room for a long one.
      fits(JSON.stringify({ ...record, id: holder?.id ?? "000000000:000000000" }), "brief");
      return {
        record: holder ? { ...record, id: holder.id } : record,
        stored,
        ...(holder ? { holder } : {}),
        page,
        ...(at ? { at } : {}),
        ...(stored === "block" ? { font: await blockFont(figma) } : {}),
        ...(note ? { note } : {}),
      };
    });

    let record = plan.record;
    let holder = plan.holder;
    if (plan.stored === "block" && !holder) {
      // A new block: drawn, then the record on it. A failure removes the block,
      // so the refusal still changed nothing.
      let block: NodeLikeW | undefined;
      try {
        block = createBlock(figma, plan.page as unknown as NodeLikeW, record.title, plan.at!);
        record = { ...record, id: block.id };
        drawLines(figma, block, record, plan.font!);
        writeShared(block as unknown as NodeLike, BRIEF_KEY, JSON.stringify(record));
      } catch (err) {
        block?.remove?.();
        const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INTERNAL, err instanceof Error ? err.message : String(err));
        throw new BridgeError(e.code, `The brief block could not be drawn: ${e.message}`, { ...(e.hint ? { hint: e.hint } : {}), partial: { created: [] } });
      }
      holder = block as unknown as NodeLike;
    } else {
      if (plan.stored === "block") {
        const block = holder as unknown as NodeLikeW;
        // drawLines takes its new texts out again when it fails: still unchanged.
        try {
          drawLines(figma, block, record, plan.font!);
        } catch (err) {
          unchanged(err);
        }
        block.name = `Brief · ${record.title}`;
      }
      writeShared(holder!, BRIEF_KEY, JSON.stringify(record));
    }

    let indexOn: "root" | "page";
    try {
      indexOn = writeIndex(figma, record, plan.page);
    } catch (err) {
      // The record is written, so the partial must not read as "nothing changed" (created: []).
      throw new BridgeError(ErrorCode.INTERNAL, `The brief was stored on ${record.id}, but the file's index of briefs could not be written: ${err instanceof Error ? err.message : String(err)}`, {
        hint: `figma_get_brief { briefId: "${record.id}" } still reads it.`,
        partial: { ...(plan.stored === "block" && !plan.holder ? { created: [record.id] } : {}), briefId: record.id },
      });
    }
    return {
      briefId: record.id,
      ...(plan.stored === "block" ? { blockId: record.id } : {}),
      stored: plan.stored,
      status: record.status,
      indexOn,
      record,
      ...(plan.note ? { note: plan.note } : {}),
    };
  },
};

// ── get_brief ───────────────────────────────────────────────────────────────

/** The deliverable a node's sign-off is on: the node itself or the nearest node above it, up to its page, that holds one. */
function signOffFor(node: NodeLike): { holder?: NodeLike; signOff?: SignOffRecord; invalid?: string } {
  let firstInvalid: string | undefined;
  for (let n: NodeLike | null | undefined = node; n && n.type !== "DOCUMENT"; n = field<NodeLike | null>(n, "parent")) {
    const r = signOffOn(n);
    if (r.signOff) return { holder: n, signOff: r.signOff };
    firstInvalid ??= r.invalid;
  }
  return firstInvalid ? { invalid: firstInvalid } : {};
}

/** Every slide of the deck, row by row (write.ts slideIds, as nodes). */
function deckSlides(figma: FigmaWrite): NodeLike[] {
  const g = figma as unknown as Any;
  for (const name of ["getCanvasGrid", "getSlideGrid"]) {
    const read = tryGet<(() => ReadonlyArray<ReadonlyArray<NodeLike>>) | undefined>(g, name);
    if (!read.ok || typeof read.value !== "function") continue;
    try {
      const out: NodeLike[] = [];
      for (const row of read.value.call(g)) for (const s of row) if (s.type === "SLIDE") out.push(s);
      return out;
    } catch {
      /* the next reader, or the tree below */
    }
  }
  const out: NodeLike[] = [];
  for (const grid of childrenOf(figma.currentPage as unknown as NodeLike) ?? []) {
    if (grid.type !== "SLIDE_GRID") continue;
    for (const row of childrenOf(grid) ?? []) for (const s of childrenOf(row) ?? []) if (s.type === "SLIDE") out.push(s);
  }
  return out;
}

/**
 * The facts the process gate reads (spec §3.3): where new work would go — the
 * parent, else the page, else (Slides) the focused slide or the page — its
 * type, whether it sits at page level (a page itself, or a node whose parent
 * is a page or a section, as read.ts's top-level frame), its child count, and
 * in Slides whether any slide of the deck has content.
 */
async function targetFacts(figma: FigmaWrite, raw: unknown): Promise<{ type: string; topLevel: boolean; childCount: number; deckHasContent?: boolean }> {
  if (!isObject(raw)) throw invalid("`target` must be an object: { parentId?, pageId? }.");
  const slides = editorType() === "slides";
  const parentId = str(raw, "parentId");
  const pageId = str(raw, "pageId");
  let node: NodeLike;
  if (parentId) node = await byId(asRead(figma), parentId);
  else if (pageId) node = await pageFor(figma, pageId);
  else {
    const focused = slides ? tryGet<NodeLike | null>(figma.currentPage, "focusedSlide") : undefined;
    node = focused?.ok && focused.value?.type === "SLIDE" ? focused.value : (figma.currentPage as unknown as NodeLike);
  }
  const parent = field<NodeLike | null>(node, "parent");
  return {
    type: node.type,
    topLevel: node.type === "PAGE" || (!!parent && (parent.type === "PAGE" || parent.type === "SECTION")),
    childCount: (childrenOf(node) ?? []).length,
    ...(slides ? { deckHasContent: deckSlides(figma).some((s) => (childrenOf(s) ?? []).length > 0) } : {}),
  };
}

const getBrief: PluginOp = {
  write: false,
  async run(ctx: OpContext) {
    const figma = api();
    const nodeId = str(ctx.params, "nodeId");
    const briefId = str(ctx.params, "briefId");
    const wantPrint = ctx.params.fingerprint === true;
    if (wantPrint && !nodeId) throw invalid("`fingerprint` needs `nodeId`: the node whose content is compared with its sign-off.");
    const index = fileIndex(figma);
    let found: { brief?: BriefRecord; from?: "node" | "page"; invalid?: string } = {};
    let signed: ReturnType<typeof signOffFor> = {};
    let print: string | undefined;
    if (briefId) {
      found = briefOn(await byId(asRead(figma), briefId));
      if (!found.brief && !found.invalid) found = { invalid: `no brief is stored on ${briefId}` };
    }
    if (nodeId) {
      const node = await byId(asRead(figma), nodeId);
      if (!briefId) found = await briefFor(figma, node, index);
      signed = signOffFor(node);
      // Over the deliverable the sign-off is on: a layer inside it changes it.
      if (wantPrint) print = await fingerprint(signed.holder ?? node, { yieldToHost: ctx.yieldToHost });
    }
    // An index row whose node was deleted is not offered as open work.
    const open: BriefIndexEntry[] = [];
    for (const e of index) if (e.status === "open" && (await figma.getNodeByIdAsync(e.id))) open.push(e);
    const target = ctx.params.target === undefined ? undefined : await targetFacts(figma, ctx.params.target);
    const why = found.invalid ?? signed.invalid;
    return {
      ...(found.brief ? { brief: found.brief } : {}),
      // How nodeId found it: the node's own work, or only its page (sign-off ranks that below the brief in force).
      ...(found.brief && found.from ? { from: found.from } : {}),
      ...(signed.signOff ? { signOff: signed.signOff } : {}),
      ...(print !== undefined ? { fingerprint: print } : {}),
      ...(print !== undefined && signed.signOff ? { fresh: signed.signOff.fingerprint === print } : {}),
      open,
      ...(target ? { target } : {}),
      ...(why ? { invalid: why } : {}),
    };
  },
};

// ── sign_off ────────────────────────────────────────────────────────────────

/**
 * The kinds each audit reports, so a finding is filed under the audit that
 * found it (CheckSummary) and an `answerKinds` info is told from the rest.
 * craft from its own severity table; tokens, names, fonts and board as
 * check.ts emits them, tells and handoff as tells.ts and handoff.ts do; the
 * audits being added (a11y, states, copy, system; deck, mark, icons, library
 * in wave B) as roles spec §4 names their kinds. A kind no audit run claims is
 * figma_check_layout's own look (overlap, clipped, low_contrast, …).
 */
export const AUDIT_KINDS: Readonly<Record<AuditName, readonly string[]>> = {
  tokens: ["unbound_color", "unbound_spacing", "unbound_radius"],
  names: ["duplicate_name"],
  fonts: ["wrong_font", "ds_font_gap"],
  board: ["sticky_overlap", "dangling_connector", "label_too_long", "section_name_duplicate", "off_palette", "text_not_charcoal", "section_overflow"],
  craft: Object.keys(CRAFT_SEVERITY),
  // tells from the shared list, planned kinds included (src/shared/tells-kinds.ts).
  tells: TELL_KINDS,
  handoff: ["duplicate_style", "detached_instance"],
  a11y: ["target_size", "target_spacing", "focus_state_missing", "focus_indicator_weak", "weak_boundary", "error_colour_only", "input_unlabelled", "text_fixed_box", "safe_area_platform"],
  states: ["state_missing", "state_property_missing", "variant_default_name", "screen_state_missing"],
  copy: ["generic_label", "label_case_mixed", "error_interjection", "error_code_only", "copy_variants"],
  system: ["format_mismatch", "off_scale", "off_spacing", "off_grid", "off_palette", "optical_margin", "hanging_punctuation", "system_unmeasured"],
  // deck reports the deck's floor as min_text too (craft's kind, which claims it first when both run).
  deck: ["slide_words", "topic_title", "two_focal", "repeated_skeleton", "bullets_dense", "notes_missing", "min_text", "deck_unmeasured"],
  mark: ["mark_detail_lost", "version_missing", "clear_space", "mark_contrast", "app_icon_text", "mark_unmeasured"],
  icons: ["icon_size_mixed", "stroke_mixed", "live_area", "off_pixel", "corner_mixed", "icons_unmeasured"],
  library: ["mode_value_missing", "alias_broken", "scope_all", "code_syntax_missing", "description_missing", "library_unmeasured"],
};

/** The audit among those run that reports `kind`, in run order (off_palette is board's on a board, system's elsewhere). */
function auditOf(kind: string, ran: readonly AuditName[]): AuditName | undefined {
  for (const a of ran) if ((AUDIT_KINDS[a] ?? []).indexOf(kind) >= 0) return a;
  return undefined;
}

/** A deliverable this large is not signed on a partial look. */
const MAX_NODES = 20_000;
/** Findings a result lists; the counts in `checks` cover all of them. */
const LIST_CAP = 100;

interface SignOffParams {
  briefId: string;
  nodeIds?: string[];
  audits: AuditName[];
  tokensWhenSystem: boolean;
  answerKinds: AuditName[];
  answers: Answer[];
  lenses: LensScore[];
  rounds: number;
  exceptions: LensScore[];
  placeholders: string[];
  serverBlockers: string[];
  build: { server?: string; skills?: string };
}

function signOffParams(p: Any): SignOffParams {
  const briefId = str(p, "briefId");
  if (!briefId) throw invalid("`briefId` is required: the brief the work is signed off against.");
  const list = <T>(key: string, ok: (v: unknown) => boolean, what: string, max = Infinity): T[] => {
    const v = p[key];
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every(ok)) throw invalid(`\`${key}\` must be a list of ${what}.`);
    if (v.length > max) throw invalid(`\`${key}\` takes at most ${max} entries.`);
    return v as T[];
  };
  const isStr = (v: unknown) => typeof v === "string";
  const isLens = (v: unknown) =>
    isObject(v) && typeof v.lens === "string" && typeof v.score === "number" && (v.verdict === "pass" || v.verdict === "fix") && (v.reviewer === undefined || isReviewer(v.reviewer));
  const nodeIds = p.nodeIds === undefined ? undefined : unique(list<string>("nodeIds", isStr, "node ids", BRIEF_LIMITS.deliverables));
  if (!Array.isArray(p.audits)) throw invalid("`audits` must list the audits the role's sign-off runs.");
  const rounds = p.rounds === undefined ? 0 : p.rounds;
  if (typeof rounds !== "number" || !Number.isInteger(rounds) || rounds < 0) throw invalid("`rounds` must be a whole number.");
  const build = p.build === undefined ? {} : p.build;
  if (!isObject(build) || (build.server !== undefined && typeof build.server !== "string") || (build.skills !== undefined && typeof build.skills !== "string")) {
    throw invalid("`build` must be { server?, skills? }.");
  }
  return {
    briefId,
    ...(nodeIds && nodeIds.length ? { nodeIds } : {}),
    audits: unique(list<AuditName>("audits", isStr, "audit names")),
    tokensWhenSystem: p.tokensWhenSystem === true,
    answerKinds: list<AuditName>("answerKinds", isStr, "audit names"),
    answers: list<Answer>("answers", (v) => isObject(v) && isStr(v.kind) && isStr(v.nodeId) && isStr(v.reason), "{ kind, nodeId, reason }", BRIEF_LIMITS.answers),
    // Each lens says who scored it in the record: "self" where the call left it out.
    lenses: list<LensScore>("lenses", isLens, '{ lens, score, verdict, reviewer? } (reviewer "self", "owner" or "agent:<name>")').map((l) => ({ ...l, reviewer: reviewerOf(l) })),
    rounds,
    exceptions: list<LensScore>("exceptions", isLens, "{ lens, score, verdict, remaining?, reviewer? }").map((l) => ({ ...l, reviewer: reviewerOf(l) })),
    placeholders: list<string>("placeholders", isStr, "strings"),
    serverBlockers: list<string>("serverBlockers", isStr, "strings"),
    build: { ...(typeof build.server === "string" ? { server: build.server } : {}), ...(typeof build.skills === "string" ? { skills: build.skills } : {}) },
  };
}

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

interface Checked {
  node: NodeLike;
  checks: CheckSummary[];
  failures: Issue[];
  unanswered: Issue[];
  fingerprint: string;
  /** Under a motion brief: the layers keys move, and the findings left to the frames (check.ts). */
  restPose?: RestPose;
}

/** One deliverable: its checks, what fails it, the infos left unanswered, its fingerprint. */
async function checkDeliverable(
  node: NodeLike,
  brief: BriefRecord,
  run: ReadonlySet<AuditName>,
  p: SignOffParams,
  ctx: OpContext,
): Promise<Checked> {
  // `brief` is CheckOptions.brief once the audits part is merged (contract § checkLayout and the brief).
  const opts: CheckOptions & { brief?: BriefRecord } = { audit: run as unknown as ReadonlySet<AuditKind>, brief };
  const r = await checkLayout(node, MAX_NODES, ctx, opts);
  if (ctx.isCancelled()) throw new BridgeError(ErrorCode.CANCELLED, "Cancelled while checking the deliverables; nothing was recorded.");
  const issues: Issue[] = [...r.issues];
  if (r.truncated) {
    issues.push({ kind: "check_truncated", severity: "warning", nodeId: node.id, name: node.name,
      detail: `has more than ${MAX_NODES} visible layers; the check stopped there, so the rest is unchecked. Sign off its parts (nodeIds) instead.` });
  }
  // tokens only counts as run where the file has a system to bind to — check.ts decides that from its own signals.
  const ran = [...run].filter((a) => a !== "tokens" || p.audits.indexOf("tokens") >= 0 || r.system?.found === true);
  const covered = new Set(p.answers.map((a) => `${a.kind}\u0000${a.nodeId}`));
  // During a second-id stretch the listed ids change between calls [C-199]: an answer that names
  // the same layer by another of its ids covers the info too.
  const named = new Map<string, NodeLike[]>();
  for (const a of p.answers) {
    const n = await lookUp(api(), a.nodeId).catch(() => null);
    if (n) named.set(a.kind, [...(named.get(a.kind) ?? []), n]);
  }
  const isCovered = async (i: Issue): Promise<boolean> => {
    if (covered.has(`${i.kind}\u0000${i.nodeId}`)) return true;
    const answered = named.get(i.kind);
    if (!answered?.length) return false;
    const n = await lookUp(api(), i.nodeId).catch(() => null);
    return !!n && answered.some((a) => sameLayer(a, n));
  };
  const failures: Issue[] = [];
  const unanswered: Issue[] = [];
  const tally = new Map<AuditName, CheckSummary>();
  for (const a of ran) tally.set(a, { name: a, ok: true, errors: 0, warnings: 0, infos: 0, unanswered: 0 });
  // CheckSummary has no name for figma_check_layout's own look: it is counted with craft, the finish audit, else the first audit run.
  const bucket: AuditName | undefined = ran.indexOf("craft") >= 0 ? "craft" : ran[0];
  for (const i of issues) {
    const owner = auditOf(i.kind, ran);
    const sum = tally.get(owner ?? (bucket as AuditName));
    if (i.severity === "error" || i.severity === "warning") {
      failures.push(i);
      if (sum) {
        if (i.severity === "error") sum.errors++;
        else sum.warnings++;
      }
    } else {
      if (sum) sum.infos++;
      if (owner && p.answerKinds.indexOf(owner) >= 0 && !(await isCovered(i))) {
        unanswered.push(i);
        if (sum) sum.unanswered++;
      }
    }
  }
  const checks = [...tally.values()].map((s) => ({ ...s, ok: s.errors === 0 && s.warnings === 0 && s.unanswered === 0 }));
  return {
    node, checks, failures, unanswered, fingerprint: await fingerprint(node, { yieldToHost: ctx.yieldToHost }),
    ...(r.restPose ? { restPose: r.restPose } : {}),
  };
}

/** The deliverables' checks added up per audit, in run order. */
function sumChecks(all: readonly Checked[]): CheckSummary[] {
  const out = new Map<string, CheckSummary>();
  for (const c of all) {
    for (const s of c.checks) {
      const had = out.get(s.name);
      if (!had) out.set(s.name, { ...s });
      else {
        had.errors += s.errors;
        had.warnings += s.warnings;
        had.infos += s.infos;
        had.unanswered += s.unanswered;
        had.ok = had.ok && s.ok;
      }
    }
  }
  return [...out.values()];
}

/** Show the deliverables, as the finish step's figma_select + figma_zoom_to did; a page (a deck) is shown by its slides already. */
async function showWork(ctx: OpContext, nodes: readonly NodeLike[]): Promise<string | undefined> {
  const ids = nodes.filter((n) => n.type !== "PAGE").map((n) => n.id);
  if (!ids.length) return undefined;
  try {
    await META_OPS.select!.run({ ...ctx, params: { nodeIds: ids } });
    await META_OPS.zoom_to!.run({ ...ctx, params: { nodeIds: ids } });
    return undefined;
  } catch (err) {
    return `Signed off, but the work could not be selected and shown: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const signOff: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const prep = await beforeMutating(async () => {
      const p = signOffParams(ctx.params);
      const holder = await byId(asRead(figma), p.briefId);
      const found = briefOn(holder);
      if (!found.brief) {
        throw invalid(found.invalid ? `No readable brief on ${p.briefId}: ${found.invalid}.` : `No brief is stored on "${holder.name}" (${p.briefId}).`,
          "figma_get_brief { nodeId } finds the brief a frame belongs to.");
      }
      const brief = found.brief;
      const ids = p.nodeIds ?? brief.deliverables;
      if (!ids.length) {
        throw invalid(`The brief "${brief.title}" lists no deliverables and \`nodeIds\` names none: name the work to sign off.`,
          `Pass nodeIds, or record them on the brief: figma_set_brief { briefId: "${brief.id}", deliverables: [...] }.`);
      }
      const nodes: NodeLike[] = [];
      for (const id of ids) {
        const node = await byId(asRead(figma), id);
        if (node.type === "DOCUMENT") throw invalid(`${id} is the document; sign off frames, sections, component sets, or the page of a deck.`);
        if (isBlock(node)) throw invalid(`"${node.name}" (${id}) is a brief block, a working note: name the work it describes.`);
        if (!canStore(node)) throw new BridgeError(ErrorCode.UNSUPPORTED, `"${node.name}" (${id}) is a ${node.type}, which takes no shared plugin data in this editor.`);
        nodes.push(node);
      }

      // The audits this plugin runs; one it does not know yet is reported, not faked as passed. A brief whose
      // avoid list binds (page, top) is judged on tells even where its role's sign-off would not run them.
      const asked = unique([
        ...p.audits,
        ...(p.tokensWhenSystem ? (["tokens"] as AuditName[]) : []),
        ...(boundKinds(brief).length ? (["tells"] as AuditName[]) : []),
      ]);
      const known = asked.filter((a) => (AUDITS as readonly string[]).indexOf(a) >= 0);
      const notRun = asked.filter((a) => known.indexOf(a) < 0);
      const checked: Checked[] = [];
      const namedPages = new Set<string>();
      for (const node of nodes) {
        // names is a page-wide check: once per page, as figma_check_layout runs it.
        const pageId = pageOf(node)?.id ?? "";
        const run = new Set(known.filter((a) => a !== "names" || !namedPages.has(pageId)));
        if (run.has("names")) namedPages.add(pageId);
        checked.push(await checkDeliverable(node, brief, run, p, ctx));
        ctx.progress(checked.length, nodes.length, "checks");
      }

      const failures = checked.reduce<Issue[]>((all, c) => all.concat(c.failures), []);
      const unanswered = checked.reduce<Issue[]>((all, c) => all.concat(c.unanswered), []);
      const ok = p.serverBlockers.length === 0 && failures.length === 0 && unanswered.length === 0;
      const at = new Date().toISOString();
      // Who scored the cold lenses, by the shared rule the server's gate reads (roles.ts reviewOf).
      const review = reviewOf(brief.role, brief.gear, p.lenses);
      const records = checked.map((c) => {
        const rec: SignOffRecord = {
          v: 1, briefId: brief.id, role: brief.role, gear: brief.gear, at, ok, fingerprint: c.fingerprint, checks: c.checks,
          lenses: p.lenses, independent: review.independent, ...(review.selfReviewed ? { selfReviewed: true as const } : {}),
          rounds: p.rounds, answers: p.answers, exceptions: p.exceptions, placeholders: p.placeholders, build: p.build,
          ...(c.restPose ? { restPose: c.restPose } : {}),
        };
        const json = JSON.stringify(rec);
        fits(json, `sign-off record of "${c.node.name}"`);
        return { node: c.node, json };
      });
      // A failing attempt is recorded as the last sign-off; only a pass closes the brief.
      const next: BriefRecord = ok
        ? { ...brief, status: "signed", lastSignOff: { at, ok }, deliverables: unique([...brief.deliverables, ...ids]), updatedAt: at }
        : { ...brief, lastSignOff: { at, ok } };
      if (next.deliverables.length > BRIEF_LIMITS.deliverables) throw invalid(`A brief lists at most ${BRIEF_LIMITS.deliverables} deliverables.`);
      const nextJson = JSON.stringify(next);
      fits(nextJson, "brief");
      const block = ok && isBlock(holder);
      return {
        p, holder, nodes, checked, failures, unanswered, ok, at, records, next, nextJson, notRun,
        page: pageOf(holder) ?? (figma.currentPage as unknown as NodeLike),
        ...(block ? { font: await blockFont(figma) } : {}),
      };
    });

    const { holder, ok, at, next } = prep;
    const written: string[] = [];
    let indexOn: "root" | "page" | undefined;
    try {
      for (const r of prep.records) {
        writeShared(r.node, SIGN_OFF_KEY, r.json);
        written.push(r.node.id);
      }
      writeShared(holder, BRIEF_KEY, prep.nextJson);
      if (ok) {
        if (prep.font) drawLines(figma, holder as unknown as NodeLikeW, next, prep.font);
        indexOn = writeIndex(figma, next, prep.page);
      }
    } catch (err) {
      throw new BridgeError(err instanceof BridgeError ? err.code : ErrorCode.INTERNAL,
        `The sign-off was measured, but recording it failed: ${err instanceof Error ? err.message : String(err)}`, {
          hint: "Run figma_sign_off again: it measures and records everything anew.",
          partial: { signOffWritten: written },
        });
    }
    const note = ok ? await showWork(ctx, prep.nodes) : undefined;

    const sorted = (list: Issue[]) => list.slice().sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2));
    const fingerprints: Record<string, string> = {};
    for (const c of prep.checked) fingerprints[c.node.id] = c.fingerprint;
    // Under a motion brief: what each deliverable left to the frames, and the one sentence that says so.
    const posed = prep.checked.filter((c) => c.restPose);
    const restPose = posed.length
      ? {
          deliverables: posed.map((c) => ({ nodeId: c.node.id, name: c.node.name, ...c.restPose! })),
          note: restPoseNote(
            posed.reduce((n, c) => n + c.restPose!.moved, 0),
            posed.reduce<Record<string, number>>((all, c) => {
              for (const [k, n] of Object.entries(c.restPose!.notJudged)) all[k] = (all[k] ?? 0) + n;
              return all;
            }, {}),
          ),
        }
      : undefined;
    return {
      ok,
      checks: sumChecks(prep.checked),
      issues: sorted(prep.failures).slice(0, LIST_CAP),
      ...(prep.failures.length > LIST_CAP ? { moreIssues: prep.failures.length - LIST_CAP } : {}),
      unanswered: prep.unanswered.slice(0, LIST_CAP),
      ...(prep.unanswered.length > LIST_CAP ? { moreUnanswered: prep.unanswered.length - LIST_CAP } : {}),
      fingerprints,
      signedAt: at,
      briefStatus: next.status,
      ...(indexOn ? { indexOn } : {}),
      ...(prep.notRun.length ? { notRun: prep.notRun } : {}),
      ...(restPose ? { restPose } : {}),
      ...(note ? { note } : {}),
    };
  },
};

export const BRIEF_OPS: Record<string, PluginOp> = {
  set_brief: setBrief,
  get_brief: getBrief,
  sign_off: signOff,
};
