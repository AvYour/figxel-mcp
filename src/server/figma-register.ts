// `figxel-mcp setup --register` and `--unregister`: list the plugin under
// Plugins → Development by writing Figma desktop's own settings file, so the
// one manual import [C-274] can be skipped. Running the plugin stays manual:
// nothing outside Figma can start a plugin [C-016].
//
// What Figma writes when a manifest is imported, measured on Windows with Figma
// desktop 126.9.13 [C-275]: settings.json holds `localFileExtensions`, a list
// with one entry per file. The manifest's entry carries `manifestPath`,
// `lastKnownName`, `lastKnownPluginId` and `fileMetadata: { type: "manifest",
// codeFileId, uiFileIds }`; the code.js and ui.html entries carry their own
// absolute path in `manifestPath` and `fileMetadata: { type: "code" | "ui",
// manifestFileId }`. Every entry has a numeric `id` the others refer to.
//
// The rules this module keeps, because the file is Figma's and not ours:
//   - never guess: a file whose structure is not the one measured is refused;
//   - never while Figma runs, and never without a backup next to the file;
//   - change only the list, and inside it only Figxel's entries: every other
//     byte of the file is copied through, including the other entries' text;
//   - a new id is one more than any id in the list or referenced by it, so it
//     can collide with nothing, not even an entry Figma left behind.
//
// The pure half (parse, plan, render) works on text and is what the tests
// drive; runFigmaRegistration is the thin layer that finds, checks and writes
// the file.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { PACKAGE_NAME, SETUP_COMMAND } from "../shared/version.js";
import { ConfigError } from "./config.js";
import type { SetupReport } from "./setup.js";

// ---------------------------------------------------------------------------
// The command line

export interface RegistrationRequest {
  action: "register" | "unregister";
  /** --register only: move a registration of the same plugin from another folder. */
  force: boolean;
  /** Print the change and write nothing. */
  dryRun: boolean;
}

/** setup's flags that belong to this module. */
export const REGISTRATION_FLAGS: readonly string[] = ["--register", "--unregister", "--force", "--dry-run"];

/** The registration setup's flags ask for: null when they ask for none, or why they do not go together. */
export function parseRegistrationFlags(flags: readonly string[]): { request: RegistrationRequest | null } | { error: string } {
  const has = (f: string) => flags.includes(f);
  if (has("--register") && has("--unregister")) return { error: "setup takes --register or --unregister, not both" };
  const action = has("--register") ? "register" : has("--unregister") ? "unregister" : null;
  if (has("--force") && action !== "register") return { error: "--force goes with setup --register" };
  if (has("--dry-run") && action === null) return { error: "--dry-run goes with setup --register or setup --unregister" };
  return { request: action === null ? null : { action, force: has("--force"), dryRun: has("--dry-run") } };
}

// ---------------------------------------------------------------------------
// The entries

export const SETTINGS_KEY = "localFileExtensions";

export interface FileMetadata {
  type: "manifest" | "code" | "ui";
  /** A manifest's code file. */
  codeFileId?: number;
  /** A manifest's UI files. */
  uiFileIds?: number[];
  /** A code or UI file's manifest. */
  manifestFileId?: number;
  [key: string]: unknown;
}

/** One entry of `localFileExtensions`. Keys this module does not know (such as cachedContainsWidget) are kept. */
export interface FileEntry {
  id: number;
  /** The absolute path of this entry's own file: the manifest, code.js or ui.html. */
  manifestPath: string;
  lastKnownName?: string;
  lastKnownPluginId?: string;
  fileMetadata: FileMetadata;
  [key: string]: unknown;
}

/** The plugin to register: its manifest's id and name, and the absolute paths Figma loads. */
export interface PluginFiles {
  id: string;
  name: string;
  manifestPath: string;
  codePath: string;
  uiPaths: string[];
}

/** Refused: nothing was written, and `message` says why. */
export class RegistrationRefused extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isManifest = (e: FileEntry) => e.fileMetadata.type === "manifest";

/** Why `v` is not an entry of the measured shape, or null when it is. */
function entryProblem(v: unknown): string | null {
  if (!isObject(v)) return "is not an object";
  if (!isId(v.id)) return "has no numeric id";
  if (typeof v.manifestPath !== "string" || v.manifestPath === "") return "has no manifestPath";
  const meta = v.fileMetadata;
  if (!isObject(meta)) return "has no fileMetadata";
  if (meta.type === "manifest") {
    if (!isId(meta.codeFileId)) return "is a manifest without a numeric codeFileId";
    if (meta.uiFileIds !== undefined && !(Array.isArray(meta.uiFileIds) && meta.uiFileIds.every(isId))) return "is a manifest whose uiFileIds is not a list of ids";
    for (const k of ["lastKnownName", "lastKnownPluginId"] as const) if (v[k] !== undefined && typeof v[k] !== "string") return `has a ${k} that is not text`;
    return null;
  }
  if (meta.type === "code" || meta.type === "ui") return isId(meta.manifestFileId) ? null : `is a ${meta.type} file without a numeric manifestFileId`;
  return `has a fileMetadata.type ${JSON.stringify(meta.type)} that setup does not know`;
}

/** The ids of the files a manifest entry names. */
function namedIds(m: FileEntry): number[] {
  return [m.fileMetadata.codeFileId, ...(m.fileMetadata.uiFileIds ?? [])].filter(isId);
}

/** One more than every id in the list and every id an entry refers to, so a new id collides with nothing. */
export function nextFreeId(entries: readonly FileEntry[]): number {
  let max = 0;
  for (const e of entries) {
    max = Math.max(max, e.id, ...namedIds(e));
    if (isId(e.fileMetadata.manifestFileId)) max = Math.max(max, e.fileMetadata.manifestFileId);
  }
  return max + 1;
}

const pathApi = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

/** The same file? Windows paths compare without case and with either slash. */
export function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const p = pathApi(platform);
  const n = (s: string) => (platform === "win32" ? p.normalize(s).toLowerCase() : p.normalize(s));
  return n(a) === n(b);
}

/**
 * The plugin a manifest describes, at the folder `dir` (where Figma will read
 * it). `main` and `ui` are relative to the manifest, as Figma reads them.
 */
export function pluginFilesFrom(manifestText: string, dir: string, platform: NodeJS.Platform = process.platform): PluginFiles {
  let m: unknown;
  try {
    m = JSON.parse(manifestText);
  } catch {
    m = null;
  }
  if (!isObject(m) || typeof m.id !== "string" || typeof m.name !== "string" || typeof m.main !== "string") {
    throw new ConfigError(`The plugin's manifest.json has no id, name or main. Reinstall ${PACKAGE_NAME}.`);
  }
  const ui = typeof m.ui === "string" ? [m.ui] : isObject(m.ui) ? Object.values(m.ui).filter((u): u is string => typeof u === "string") : [];
  const p = pathApi(platform);
  return { id: m.id, name: m.name, manifestPath: p.join(dir, "manifest.json"), codePath: p.join(dir, m.main), uiPaths: ui.map((u) => p.join(dir, u)) };
}

// ---------------------------------------------------------------------------
// Parse and render, keeping every byte that is not Figxel's

interface Span {
  start: number;
  end: number;
}

interface Member extends Span {
  key: string;
  /** Where the key's string starts and its value starts. */
  keyStart: number;
  valueStart: number;
}

export interface FigmaSettings {
  /** The file's text without a byte-order mark. */
  text: string;
  bom: boolean;
  entries: FileEntry[];
  /** `lastKnownVersion`: the Figma version that last wrote the file. */
  figmaVersion: string | null;
  /** Each entry's own text, so an entry that does not change is written back as it was read. */
  raw: Map<FileEntry, string>;
  /** The list's value in `text`; null when the file has no list yet. */
  list: (Span & { elements: Span[] }) | null;
  /** Where a missing list goes: the end of the last top-level value, or just inside an empty object. */
  insertAt: number;
  hasMembers: boolean;
  eol: string;
  /** Indented files: the indent unit and the text between a key and its value. Null for a file on one line, as Figma writes it. */
  pretty: { unit: string; colon: string } | null;
}

const WS = " \t\r\n";

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.includes(s[i]!)) i++;
  return i;
}

function stringEnd(s: string, i: number): number {
  for (i++; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i + 1;
  }
  return s.length;
}

/** The end of the value starting at `i`, in text JSON.parse has accepted. */
function valueEnd(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return stringEnd(s, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '"') {
        i = stringEnd(s, i);
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return s.length;
  }
  while (i < s.length && !",}] \t\r\n".includes(s[i]!)) i++;
  return i;
}

/** The members of the object or the elements of the array that starts at `open`. */
function children(s: string, open: number): { members: Member[]; elements: Span[] } {
  const isObj = s[open] === "{";
  const members: Member[] = [];
  const elements: Span[] = [];
  let i = skipWs(s, open + 1);
  while (i < s.length && s[i] !== "}" && s[i] !== "]") {
    if (isObj) {
      const keyStart = i;
      const keyEnd = stringEnd(s, i);
      const key = JSON.parse(s.slice(keyStart, keyEnd)) as string;
      const valueStart = skipWs(s, skipWs(s, keyEnd) + 1);
      const end = valueEnd(s, valueStart);
      members.push({ key, keyStart, valueStart, start: valueStart, end });
      i = end;
    } else {
      const end = valueEnd(s, i);
      elements.push({ start: i, end });
      i = end;
    }
    i = skipWs(s, i);
    if (s[i] === ",") i = skipWs(s, i + 1);
  }
  return { members, elements };
}

const refuse = (why: string) => new RegistrationRefused(`Figma's settings file is not in the form setup knows: ${why}`);

/** Read Figma's settings.json text. Throws RegistrationRefused when its structure is not the measured one. */
export function parseFigmaSettings(fileText: string): FigmaSettings {
  const bom = fileText.startsWith("﻿");
  const text = bom ? fileText.slice(1) : fileText;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw refuse(`it is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!isObject(data)) throw refuse("its top level is not an object");
  const open = skipWs(text, 0);
  const { members } = children(text, open);
  const listMembers = members.filter((m) => m.key === SETTINGS_KEY);
  if (listMembers.length > 1) throw refuse(`it has "${SETTINGS_KEY}" more than once`);
  const value = data[SETTINGS_KEY];
  if (value !== undefined && !Array.isArray(value)) throw refuse(`"${SETTINGS_KEY}" is not a list`);
  const list = (value ?? []) as unknown[];
  list.forEach((e, i) => {
    const why = entryProblem(e);
    if (why) throw refuse(`entry ${i + 1} of "${SETTINGS_KEY}" ${why}`);
  });
  const entries = list as FileEntry[];
  const ids = new Set(entries.map((e) => e.id));
  if (ids.size !== entries.length) throw refuse(`two entries of "${SETTINGS_KEY}" share an id`);

  const member = listMembers[0];
  const elements = member ? children(text, member.valueStart).elements : [];
  if (elements.length !== entries.length) throw refuse(`"${SETTINGS_KEY}" could not be read entry by entry`);
  const raw = new Map(entries.map((e, i) => [e, text.slice(elements[i]!.start, elements[i]!.end)] as const));

  const first = members[0];
  const lead = first ? text.slice(open + 1, first.keyStart) : "";
  const pretty = lead.includes("\n")
    ? { unit: lead.slice(lead.lastIndexOf("\n") + 1), colon: text.slice(stringEnd(text, first!.keyStart), first!.valueStart) }
    : null;
  const last = members[members.length - 1];
  return {
    text,
    bom,
    entries,
    figmaVersion: typeof data.lastKnownVersion === "string" ? data.lastKnownVersion : null,
    raw,
    list: member ? { start: member.start, end: member.end, elements } : null,
    insertAt: last ? last.end : open + 1,
    hasMembers: members.length > 0,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    pretty,
  };
}

/** The file's text with `entries` as its list. Entries read from the file and not changed keep their exact text. */
export function renderFigmaSettings(s: FigmaSettings, entries: readonly FileEntry[]): string {
  const listText = s.list ? s.text.slice(s.list.start, s.list.end) : "";
  // An indented list stays indented; Figma's own file is one line.
  const indented = s.list && s.list.elements.length > 0 ? listText.includes("\n") : s.pretty !== null;
  let array: string;
  if (entries.length === 0) {
    array = "[]";
  } else if (!indented) {
    array = `[${entries.map((e) => s.raw.get(e) ?? JSON.stringify(e)).join(",")}]`;
  } else {
    const unit = s.pretty?.unit ?? "  ";
    const els = s.list?.elements ?? [];
    const lead = els.length > 0 ? listText.slice(1, els[0]!.start - s.list!.start) : `${s.eol}${unit}${unit}`;
    const tail = els.length > 0 ? listText.slice(els[els.length - 1]!.end - s.list!.start, -1) : `${s.eol}${unit}`;
    const indent = lead.slice(lead.lastIndexOf("\n") + 1);
    const fresh = (e: FileEntry) => JSON.stringify(e, null, unit).split("\n").join(`${s.eol}${indent}`);
    array = `[${lead}${entries.map((e) => s.raw.get(e) ?? fresh(e)).join(`,${lead}`)}${tail}]`;
  }
  let out: string;
  if (s.list) {
    out = s.text.slice(0, s.list.start) + array + s.text.slice(s.list.end);
  } else {
    const before = s.hasMembers ? (s.pretty ? `,${s.eol}${s.pretty.unit}` : ",") : "";
    const member = `${before}${JSON.stringify(SETTINGS_KEY)}${s.pretty?.colon ?? ":"}${array}`;
    out = s.text.slice(0, s.insertAt) + member + s.text.slice(s.insertAt);
  }
  return (s.bom ? "﻿" : "") + out;
}

// ---------------------------------------------------------------------------
// Plan the change

export type RegistrationOutcome =
  /** New entries for the manifest, its code and its UI. */
  | "added"
  /** The registration at <home>/plugin had other paths or another name, now fixed. */
  | "updated"
  /** Already registered as it should be: nothing written. */
  | "unchanged"
  /** --force: a registration of the same plugin in another folder now points at <home>/plugin. */
  | "moved"
  /** The same plugin is registered from another folder, and was kept (no --force). */
  | "kept-other"
  /** --unregister removed the registration of <home>/plugin. */
  | "removed"
  /** --unregister found nothing to remove. */
  | "absent"
  /** Nothing written; `reason` says why. */
  | "refused";

export interface Plan {
  outcome: Exclude<RegistrationOutcome, "refused">;
  /** The whole new list. Entries that do not change are the same objects as before. */
  entries: FileEntry[];
  /** The affected entries as they were, and as they will be. */
  before: FileEntry[];
  after: FileEntry[];
  /** Manifest paths of other registrations of the same plugin id, left alone. */
  others: string[];
}

/** Point the manifest entry `m` and the files it names at `plugin`, reusing their ids. */
function updateRegistration(entries: readonly FileEntry[], m: FileEntry, plugin: PluginFiles, platform: NodeJS.Platform, outcome: "updated" | "moved", others: string[]): Plan {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const namedElsewhere = new Set(entries.filter((e) => isManifest(e) && e !== m).flatMap(namedIds));
  let next = nextFreeId(entries);
  const changed = new Map<FileEntry, FileEntry>();
  const removed = new Set<FileEntry>();
  const added: FileEntry[] = [];

  const updated = structuredClone(m);
  if (!samePath(updated.manifestPath, plugin.manifestPath, platform)) updated.manifestPath = plugin.manifestPath;
  updated.lastKnownName = plugin.name;
  updated.lastKnownPluginId = plugin.id;
  const file = (id: number | undefined, type: "code" | "ui", path: string): number => {
    const old = id === undefined ? undefined : byId.get(id);
    if (old && old.fileMetadata.type === type && !namedElsewhere.has(old.id)) {
      const e = structuredClone(old);
      if (!samePath(e.manifestPath, path, platform)) e.manifestPath = path;
      e.fileMetadata.manifestFileId = m.id;
      changed.set(old, e);
      return old.id;
    }
    const e: FileEntry = { id: next++, manifestPath: path, fileMetadata: { type, manifestFileId: m.id } };
    added.push(e);
    return e.id;
  };
  updated.fileMetadata.codeFileId = file(m.fileMetadata.codeFileId, "code", plugin.codePath);
  const oldUi = m.fileMetadata.uiFileIds ?? [];
  updated.fileMetadata.uiFileIds = plugin.uiPaths.map((p, i) => file(oldUi[i], "ui", p));
  // UI files the manifest no longer names, which only it named.
  for (const id of oldUi.slice(plugin.uiPaths.length)) {
    const old = byId.get(id);
    if (old && old.fileMetadata.type === "ui" && old.fileMetadata.manifestFileId === m.id && !namedElsewhere.has(id)) removed.add(old);
  }
  changed.set(m, updated);
  // An entry whose text would not change stays the object that was read, so its bytes stay too.
  for (const [old, e] of changed) if (JSON.stringify(old) === JSON.stringify(e)) changed.delete(old);

  if (changed.size === 0 && added.length === 0 && removed.size === 0) return { outcome: "unchanged", entries: [...entries], before: [], after: [], others };
  return {
    outcome,
    entries: [...entries.filter((e) => !removed.has(e)).map((e) => changed.get(e) ?? e), ...added],
    before: entries.filter((e) => changed.has(e) || removed.has(e)),
    after: [...entries.filter((e) => changed.has(e)).map((e) => changed.get(e)!), ...added],
    others,
  };
}

/**
 * Register `plugin`. An entry for its manifest path is updated in place; an
 * entry for the same plugin id in another folder is kept, or moved with
 * `force`; otherwise three entries are added (manifest, code, UI), with ids no
 * entry uses or refers to.
 */
export function planRegister(entries: readonly FileEntry[], plugin: PluginFiles, opts: { force: boolean; platform: NodeJS.Platform }): Plan {
  const manifests = entries.filter(isManifest);
  const here = manifests.filter((e) => samePath(e.manifestPath, plugin.manifestPath, opts.platform));
  if (here.length > 1) throw refuse(`${plugin.manifestPath} is listed ${here.length} times`);
  const elsewhere = manifests.filter((e) => e.lastKnownPluginId === plugin.id && !here.includes(e));
  const others = elsewhere.map((e) => e.manifestPath);
  if (here[0]) return updateRegistration(entries, here[0], plugin, opts.platform, "updated", others);
  if (elsewhere[0]) {
    if (!opts.force) return { outcome: "kept-other", entries: [...entries], before: [], after: [], others };
    return updateRegistration(entries, elsewhere[0], plugin, opts.platform, "moved", others.slice(1));
  }
  let next = nextFreeId(entries);
  const manifestId = next++;
  const codeId = next++;
  const uiIds = plugin.uiPaths.map(() => next++);
  // Key order as Figma writes them [C-275].
  const added: FileEntry[] = [
    {
      id: manifestId,
      manifestPath: plugin.manifestPath,
      lastKnownName: plugin.name,
      lastKnownPluginId: plugin.id,
      fileMetadata: { type: "manifest", codeFileId: codeId, uiFileIds: uiIds },
    },
    { id: codeId, manifestPath: plugin.codePath, fileMetadata: { type: "code", manifestFileId: manifestId } },
    ...plugin.uiPaths.map((p, i): FileEntry => ({ id: uiIds[i]!, manifestPath: p, fileMetadata: { type: "ui", manifestFileId: manifestId } })),
  ];
  return { outcome: "added", entries: [...entries, ...added], before: [], after: added, others: [] };
}

/**
 * Remove the registration of `plugin.manifestPath`: its manifest entry, the
 * files it names, and file entries Figma left behind for it (they point at its
 * id and sit in its folder). Nothing another manifest names is removed, and a
 * registration of the same plugin from another folder is kept and reported.
 */
export function planUnregister(entries: readonly FileEntry[], plugin: Pick<PluginFiles, "id" | "manifestPath">, opts: { platform: NodeJS.Platform }): Plan {
  const p = pathApi(opts.platform);
  const manifests = entries.filter(isManifest);
  const here = manifests.filter((e) => samePath(e.manifestPath, plugin.manifestPath, opts.platform));
  const others = manifests.filter((e) => e.lastKnownPluginId === plugin.id && !here.includes(e)).map((e) => e.manifestPath);
  if (here.length === 0) return { outcome: "absent", entries: [...entries], before: [], after: [], others };
  const ids = new Set(here.map((e) => e.id));
  const namedElsewhere = new Set(manifests.filter((e) => !here.includes(e)).flatMap(namedIds));
  const named = new Set(here.flatMap(namedIds));
  const folder = p.dirname(plugin.manifestPath);
  const remove = (e: FileEntry) => {
    if (here.includes(e)) return true;
    if (isManifest(e) || namedElsewhere.has(e.id)) return false;
    if (named.has(e.id)) return true;
    return ids.has(e.fileMetadata.manifestFileId ?? -1) && samePath(p.dirname(e.manifestPath), folder, opts.platform);
  };
  return { outcome: "removed", entries: entries.filter((e) => !remove(e)), before: entries.filter(remove), after: [], others };
}

// ---------------------------------------------------------------------------
// The file on disk

/**
 * Figma desktop's settings file. Windows: %APPDATA%\Figma\settings.json, as
 * measured [C-275]. macOS: the same name under Application Support, which is
 * not measured, so a run there says it is experimental. Linux: none, because
 * Figma desktop has no Linux build [C-273].
 */
export function figmaSettingsPath(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  userHome: string = homedir(),
): string | null {
  if (platform === "win32") return win32.join(env.APPDATA?.trim() || win32.join(userHome, "AppData", "Roaming"), "Figma", "settings.json");
  if (platform === "darwin") return posix.join(userHome, "Library", "Application Support", "Figma", "settings.json");
  return null;
}

/**
 * Whether Figma desktop is running: Figma.exe in the task list on Windows, a
 * process named exactly "Figma" on macOS. Null when it cannot tell. Figma's
 * font helper (figma_agent) is a different process and does not count.
 */
export function figmaIsRunning(platform: NodeJS.Platform = process.platform): boolean | null {
  try {
    if (platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Figma.exe", "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return /"figma\.exe"/i.test(out);
    }
    if (platform === "darwin") {
      try {
        execFileSync("pgrep", ["-x", "Figma"], { stdio: "ignore" });
        return true;
      } catch (e) {
        // pgrep exits 1 when no process matches.
        return (e as { status?: unknown }).status === 1 ? false : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface RegistrationReport {
  action: "register" | "unregister";
  dryRun: boolean;
  force: boolean;
  platform: NodeJS.Platform;
  /** macOS: the settings path there is not measured. */
  experimental: boolean;
  settingsPath: string | null;
  /** `lastKnownVersion` in the file: the Figma version that last wrote it. */
  figmaVersion: string | null;
  manifestPath: string;
  outcome: RegistrationOutcome;
  /** Why nothing was written, when the outcome is "refused". */
  reason: string | null;
  before: FileEntry[];
  after: FileEntry[];
  others: string[];
  /** The copy of the file made before writing it. */
  backupPath: string | null;
  /** Whether Figma was running when checked: before a write, and on a dry run. Null when not checked or not known. */
  figmaRunning: boolean | null;
  next: string[];
}

export interface RegistrationOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  userHome?: string;
  /** A test passes its own file instead of Figma's. */
  settingsPath?: string;
  /** A test passes its own process check. */
  isFigmaRunning?: (platform: NodeJS.Platform) => boolean | null;
  now?: () => Date;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Find Figma's settings file, plan the change, and (unless a dry run) back it up and write it. Never throws for a refusal. */
export function runFigmaRegistration(plugin: PluginFiles, request: RegistrationRequest, opts: RegistrationOptions = {}): RegistrationReport {
  const platform = opts.platform ?? process.platform;
  const settingsPath = opts.settingsPath ?? figmaSettingsPath(platform, opts.env ?? process.env, opts.userHome ?? homedir());
  const report: RegistrationReport = {
    action: request.action,
    dryRun: request.dryRun,
    force: request.force,
    platform,
    experimental: platform === "darwin",
    settingsPath,
    figmaVersion: null,
    manifestPath: plugin.manifestPath,
    outcome: "refused",
    reason: null,
    before: [],
    after: [],
    others: [],
    backupPath: null,
    figmaRunning: null,
    next: [],
  };
  const importByHand = `Import the plugin by hand instead: in Figma desktop, Plugins → Development → Import plugin from manifest…, and choose ${plugin.manifestPath}.`;
  const refused = (reason: string, next: string[] = [importByHand]): RegistrationReport => Object.assign(report, { outcome: "refused", reason, next });

  if (settingsPath === null) return refused("Figma desktop has no Linux build, so there is no Figma settings file to register in.", []);
  if (!existsSync(settingsPath)) return refused(`Figma's settings file is not at ${settingsPath}, so there is nothing to register in.`);
  const isRunning = opts.isFigmaRunning ?? figmaIsRunning;

  let bytes: Buffer;
  let plan: Plan;
  let settings: FigmaSettings;
  try {
    bytes = readFileSync(settingsPath);
    settings = parseFigmaSettings(bytes.toString("utf8"));
    report.figmaVersion = settings.figmaVersion;
    plan =
      request.action === "register"
        ? planRegister(settings.entries, plugin, { force: request.force, platform })
        : planUnregister(settings.entries, plugin, { platform });
  } catch (e) {
    return refused(`${errorText(e)}. Nothing was written.`);
  }
  Object.assign(report, { outcome: plan.outcome, before: plan.before, after: plan.after, others: plan.others });
  const writes = plan.before.length > 0 || plan.after.length > 0;

  if (request.dryRun) {
    report.figmaRunning = isRunning(platform);
    return withNext(report, plugin);
  }
  if (!writes) return withNext(report, plugin);

  report.figmaRunning = isRunning(platform);
  if (report.figmaRunning !== false) {
    const why =
      report.figmaRunning === true
        ? "Figma desktop is running. Setup edits Figma's settings file only while Figma is closed."
        : "setup could not tell whether Figma desktop is running, and edits Figma's settings file only while Figma is closed.";
    return Object.assign(refused(why, ["Quit Figma desktop completely (every window), then run the command again.", importByHand]), {
      before: plan.before,
      after: plan.after,
    });
  }

  const text = renderFigmaSettings(settings, plan.entries);
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const temp = `${settingsPath}.figxel-${process.pid}.tmp`;
  try {
    if (!readFileSync(settingsPath).equals(bytes)) return refused("Figma's settings file changed while setup was reading it. Nothing was written; run the command again.");
    // The backup holds exactly the bytes the change was planned on, and never replaces an earlier backup.
    for (let n = 1; report.backupPath === null; n++) {
      const backupPath = `${settingsPath}.figxel-backup-${stamp}${n > 1 ? `-${n}` : ""}`;
      try {
        writeFileSync(backupPath, bytes, { flag: "wx" });
        report.backupPath = backupPath;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || n >= 100) throw e;
      }
    }
    writeFileSync(temp, text, "utf8");
    renameSync(temp, settingsPath);
  } catch (e) {
    rmSync(temp, { force: true });
    return refused(`could not write ${settingsPath}: ${errorText(e)}.${report.backupPath ? ` The backup ${report.backupPath} holds the file as it was.` : ""}`);
  }
  return withNext(report, plugin);
}

/** What the person does next, for an outcome that was not refused. */
function withNext(report: RegistrationReport, plugin: PluginFiles): RegistrationReport {
  const keptOther = `Figma runs the plugin from ${report.others[0] ?? "that folder"}, not from ${plugin.manifestPath}, which the server keeps current. To point the registration at ${plugin.manifestPath}, quit Figma desktop and run ${SETUP_COMMAND} --register --force.`;
  if (report.dryRun) {
    const writes = report.before.length > 0 || report.after.length > 0;
    report.next = [
      ...(report.outcome === "kept-other" ? [keptOther] : []),
      ...(writes ? ["To make the change, quit Figma desktop completely and run the same command without --dry-run."] : []),
    ];
    return report;
  }
  switch (report.outcome) {
    case "added":
    case "updated":
    case "moved":
    case "unchanged":
      report.next = [
        `Open Figma desktop and a file, run Plugins → Development → ${plugin.name}, paste the token and press Save.`,
        `If ${plugin.name} is not in that menu, import it by hand: Plugins → Development → Import plugin from manifest…, and choose ${plugin.manifestPath}.`,
        `To undo, with Figma closed: ${SETUP_COMMAND} --unregister.`,
      ];
      break;
    case "kept-other":
      report.next = [keptOther];
      break;
    case "removed":
      report.next = [`To add it again: ${SETUP_COMMAND} --register, or import the manifest by hand.`];
      break;
    default:
      break;
  }
  return report;
}

// ---------------------------------------------------------------------------
// What setup prints

/** The plugin setup registers: the bundled manifest (what setup copies), at the folder setup copies it to. */
export function pluginToRegister(installedDir: string, bundledDir: string | null, platform: NodeJS.Platform = process.platform): PluginFiles {
  const candidates = [bundledDir && join(bundledDir, "manifest.json"), join(installedDir, "manifest.json")].filter((p): p is string => !!p);
  const source = candidates.find((p) => existsSync(p));
  if (!source) throw new ConfigError(`The plugin's manifest.json is neither next to this server nor in ${installedDir}. Reinstall ${PACKAGE_NAME}.`);
  return pluginFilesFrom(readFileSync(source, "utf8"), installedDir, platform);
}

function headline(r: RegistrationReport): string {
  const would = r.dryRun;
  const where = r.manifestPath;
  switch (r.outcome) {
    case "added":
      return `${would ? "Would add" : "Added"} ${where} to Figma's development plugins.`;
    case "updated":
      return `${would ? "Would update" : "Updated"} the registration of ${where}.`;
    case "unchanged":
      return `Already registered: ${where}. Nothing to change.`;
    case "moved":
      return `${would ? "Would move" : "Moved"} the registration from ${r.before.find(isManifest)?.manifestPath ?? "another folder"} to ${where}.`;
    case "kept-other":
      return `The plugin is already registered from ${r.others[0] ?? "another folder"}. Kept it.`;
    case "removed":
      return `${would ? "Would remove" : "Removed"} the registration of ${where}.`;
    case "absent":
      return `${where} is not registered in Figma's settings. Nothing to remove.`;
    case "refused":
      return `Not ${r.action === "register" ? "registered" : "unregistered"}: ${r.reason ?? ""}`;
  }
}

/** The registration as a person reads it. */
export function formatRegistrationReport(r: RegistrationReport): string {
  const out = [`Figma desktop registration (setup --${r.action}${r.force ? " --force" : ""}${r.dryRun ? " --dry-run" : ""}):`];
  if (r.dryRun) out.push("  Dry run: nothing was written.");
  if (r.experimental) out.push("  macOS is experimental: the location of Figma's settings file there has not been measured.");
  out.push(`  ${headline(r)}`);
  if (r.settingsPath) out.push(`  Figma's settings file: ${r.settingsPath}${r.figmaVersion ? ` (last written by Figma ${r.figmaVersion})` : ""}`);
  if (r.before.length > 0 || r.after.length > 0) {
    out.push(`  Entries in "${SETTINGS_KEY}"${r.outcome === "refused" ? " the change would touch" : ""}:`);
    for (const e of r.before) out.push(`    - ${JSON.stringify(e)}`);
    for (const e of r.after) out.push(`    + ${JSON.stringify(e)}`);
  }
  const otherList = r.outcome === "kept-other" ? r.others.slice(1) : r.others;
  for (const o of otherList) out.push(`  Also registered from ${o}: left as it is.`);
  if (r.dryRun && r.figmaRunning) out.push("  Figma desktop is running now: quit it before the real run.");
  if (r.backupPath) out.push(`  Backup of the file as it was: ${r.backupPath}`);
  if (r.next.length > 0) out.push("", ...r.next.map((n) => `  ${n}`));
  return `${out.join("\n")}\n`;
}

/** Setup's report after a registration: the import step is replaced when the registration is in place. */
export function withRegistration(report: SetupReport, r: RegistrationReport): SetupReport & { figmaRegistration: RegistrationReport } {
  const registered = !r.dryRun && (r.outcome === "added" || r.outcome === "updated" || r.outcome === "moved" || r.outcome === "unchanged");
  const figmaSteps = registered
    ? [
        `Nothing to import: setup --register listed the plugin in Figma's settings. Open Figma desktop and a file; if the plugin is not under Plugins → Development, import ${report.manifestPath} by hand (Plugins → Development → Import plugin from manifest…).`,
        ...report.figmaSteps.slice(1),
      ]
    : report.figmaSteps;
  return { ...report, figmaSteps, figmaRegistration: r };
}
