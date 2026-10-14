// `setup --register` / `--unregister` (src/server/figma-register.ts): Figxel's
// entries in Figma desktop's settings.json, `localFileExtensions` [C-275].
//
// The fixtures under test/fixtures/figma-settings/ copy the structure measured
// on Windows with Figma desktop 126.9.13 — one line of JSON, no final newline,
// the list last, code and UI entries before their manifest, and file entries
// Figma left behind for a manifest it no longer lists — with invented paths,
// names and values. Nothing here reads or writes the real settings file: every
// run passes its own file and its own process check.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  figmaSettingsPath,
  formatRegistrationReport,
  nextFreeId,
  parseFigmaSettings,
  parseRegistrationFlags,
  planRegister,
  planUnregister,
  pluginFilesFrom,
  pluginToRegister,
  RegistrationRefused,
  renderFigmaSettings,
  runFigmaRegistration,
  samePath,
  withRegistration,
  type FileEntry,
  type Plan,
  type RegistrationReport,
  type RegistrationRequest,
} from "../src/server/figma-register.js";
import { helpText, parseCommand, runSetup } from "../src/server/setup.js";
import { PACKAGE_NAME } from "../src/shared/version.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/figma-settings/${name}.json`, import.meta.url), "utf8");
const WITHOUT = fixture("without-figxel");
const FROM_CLONE = fixture("figxel-from-clone");
const MANIFEST = readFileSync(new URL("../src/plugin/manifest.json", import.meta.url), "utf8");
const SERVER = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const DIST_PLUGIN = fileURLToPath(new URL("../dist/plugin/", import.meta.url));

const HOME_PLUGIN = "C:\\Users\\alex\\.figxel\\plugin";
const CLONE_PLUGIN = "C:\\Users\\alex\\code\\figxel-mcp\\dist\\plugin";
const PLUGIN = pluginFilesFrom(MANIFEST, HOME_PLUGIN, "win32");
const W = { platform: "win32" as const };

const register = (force = false) => (entries: readonly FileEntry[]) => planRegister(entries, PLUGIN, { force, ...W });
const unregister = (manifestPath = PLUGIN.manifestPath) => (entries: readonly FileEntry[]) => planUnregister(entries, { id: PLUGIN.id, manifestPath }, W);

/** Parse `text`, plan, render: the plan and the file it would write. */
function apply(text: string, plan: (entries: readonly FileEntry[]) => Plan): { plan: Plan; text: string } {
  const s = parseFigmaSettings(text);
  const p = plan(s.entries);
  return { plan: p, text: renderFigmaSettings(s, p.entries) };
}

/** The exact text of the entry with `id` in a one-line file. */
function rawEntry(text: string, id: number): string {
  const s = parseFigmaSettings(text);
  return s.raw.get(s.entries.find((e) => e.id === id)!)!;
}

const ids = (entries: readonly FileEntry[]) => entries.map((e) => e.id);

describe("the plugin to register", () => {
  it("comes from the manifest setup copies: its id, its name, and the files it names, at <home>/plugin", () => {
    expect(PLUGIN).toEqual({
      id: "figma-mcp-bridge",
      name: "Figxel",
      manifestPath: `${HOME_PLUGIN}\\manifest.json`,
      codePath: `${HOME_PLUGIN}\\code.js`,
      uiPaths: [`${HOME_PLUGIN}\\ui.html`],
    });
    const fromDist = pluginToRegister(join(tmpdir(), "nowhere", "plugin"), DIST_PLUGIN);
    expect(fromDist.manifestPath).toBe(join(tmpdir(), "nowhere", "plugin", "manifest.json"));
    expect(fromDist.id).toBe("figma-mcp-bridge");
  });

  it("Windows paths are the same file whatever the case or slash; macOS paths compare exactly", () => {
    expect(samePath("C:\\Users\\Alex\\.figxel\\plugin\\manifest.json", "c:/users/alex/.figxel/plugin/manifest.json", "win32")).toBe(true);
    expect(samePath("C:\\a\\manifest.json", "C:\\b\\manifest.json", "win32")).toBe(false);
    expect(samePath("/Users/a/x.json", "/Users/A/x.json", "darwin")).toBe(false);
    expect(samePath("/Users/a/./x.json", "/Users/a/x.json", "darwin")).toBe(true);
  });

  it("Figma's settings file: %APPDATA%\\Figma on Windows [C-275], Application Support on macOS, none on Linux [C-273]", () => {
    expect(figmaSettingsPath("win32", { APPDATA: "C:\\Users\\alex\\AppData\\Roaming" }, "C:\\Users\\alex")).toBe("C:\\Users\\alex\\AppData\\Roaming\\Figma\\settings.json");
    expect(figmaSettingsPath("win32", {}, "C:\\Users\\alex")).toBe("C:\\Users\\alex\\AppData\\Roaming\\Figma\\settings.json");
    expect(figmaSettingsPath("darwin", {}, "/Users/alex")).toBe("/Users/alex/Library/Application Support/Figma/settings.json");
    expect(figmaSettingsPath("linux", {}, "/home/alex")).toBeNull();
  });
});

describe("reading Figma's settings", () => {
  it("reads the measured form and writes it back byte for byte when nothing changes", () => {
    for (const text of [WITHOUT, FROM_CLONE]) {
      const s = parseFigmaSettings(text);
      expect(s.figmaVersion).toBe("126.9.13");
      expect(s.pretty).toBeNull();
      expect(renderFigmaSettings(s, s.entries)).toBe(text);
    }
    expect(ids(parseFigmaSettings(FROM_CLONE).entries)).toEqual([2, 3, 1, 5, 6, 4, 7, 8, 9, 10]);
  });

  it("refuses any other structure instead of guessing", () => {
    const entry = '{"id":1,"manifestPath":"C:\\\\p\\\\manifest.json","fileMetadata":{"type":"manifest","codeFileId":2,"uiFileIds":[3]}}';
    const bad: [string, RegExp][] = [
      ["", /not valid JSON/],
      ["{\"a\":", /not valid JSON/],
      ["[]", /top level is not an object/],
      ['{"localFileExtensions":{}}', /is not a list/],
      ['{"localFileExtensions":[1]}', /entry 1 .* is not an object/],
      ['{"localFileExtensions":[{"manifestPath":"x","fileMetadata":{"type":"code","manifestFileId":1}}]}', /no numeric id/],
      ['{"localFileExtensions":[{"id":1,"fileMetadata":{"type":"code","manifestFileId":1}}]}', /no manifestPath/],
      ['{"localFileExtensions":[{"id":1,"manifestPath":"x"}]}', /no fileMetadata/],
      ['{"localFileExtensions":[{"id":1,"manifestPath":"x","fileMetadata":{"type":"widget"}}]}', /type "widget" that setup does not know/],
      ['{"localFileExtensions":[{"id":1,"manifestPath":"x","fileMetadata":{"type":"manifest"}}]}', /without a numeric codeFileId/],
      ['{"localFileExtensions":[{"id":1,"manifestPath":"x","fileMetadata":{"type":"manifest","codeFileId":2,"uiFileIds":"3"}}]}', /uiFileIds is not a list/],
      ['{"localFileExtensions":[{"id":1,"manifestPath":"x","fileMetadata":{"type":"ui"}}]}', /without a numeric manifestFileId/],
      [`{"localFileExtensions":[${entry},${entry}]}`, /share an id/],
      [`{"localFileExtensions":[],"localFileExtensions":[${entry}]}`, /more than once/],
    ];
    for (const [text, why] of bad) {
      expect(() => parseFigmaSettings(text), text).toThrow(RegistrationRefused);
      expect(() => parseFigmaSettings(text), text).toThrow(why);
    }
  });

  it("a new id is one more than every id used or referred to, even by an entry Figma left behind", () => {
    expect(nextFreeId(parseFigmaSettings(WITHOUT).entries)).toBe(9);
    expect(nextFreeId(parseFigmaSettings(FROM_CLONE).entries)).toBe(11);
    expect(nextFreeId([])).toBe(1);
    const dangling = parseFigmaSettings('{"localFileExtensions":[{"id":1,"manifestPath":"x","fileMetadata":{"type":"code","manifestFileId":40}}]}');
    expect(nextFreeId(dangling.entries)).toBe(41);
  });
});

describe("register", () => {
  it("adds the manifest, code and UI entries the way Figma writes them, after every other byte of the file", () => {
    const { plan, text } = apply(WITHOUT, register());
    expect(plan.outcome).toBe("added");
    expect(plan.before).toEqual([]);
    const added = [
      `{"id":9,"manifestPath":${JSON.stringify(PLUGIN.manifestPath)},"lastKnownName":"Figxel","lastKnownPluginId":"figma-mcp-bridge","fileMetadata":{"type":"manifest","codeFileId":10,"uiFileIds":[11]}}`,
      `{"id":10,"manifestPath":${JSON.stringify(PLUGIN.codePath)},"fileMetadata":{"type":"code","manifestFileId":9}}`,
      `{"id":11,"manifestPath":${JSON.stringify(PLUGIN.uiPaths[0])},"fileMetadata":{"type":"ui","manifestFileId":9}}`,
    ];
    expect(plan.after.map((e) => JSON.stringify(e))).toEqual(added);
    expect(text).toBe(`${WITHOUT.slice(0, -2)},${added.join(",")}]}`);
  });

  it("is idempotent: a second run plans nothing and the file stays the same bytes", () => {
    const once = apply(WITHOUT, register()).text;
    const twice = apply(once, register());
    expect(twice.plan.outcome).toBe("unchanged");
    expect(twice.plan.before).toEqual([]);
    expect(twice.plan.after).toEqual([]);
    expect(twice.text).toBe(once);
  });

  it("updates its own entry in place when the name or a path is stale, and touches nothing else", () => {
    const once = apply(WITHOUT, register()).text;
    const stale = once.replace('"lastKnownName":"Figxel"', '"lastKnownName":"figma-mcp bridge"').replace(`${HOME_PLUGIN.replaceAll("\\", "\\\\")}\\\\code.js`, "C:\\\\old\\\\code.js");
    expect(stale).not.toBe(once);
    const { plan, text } = apply(stale, register());
    expect(plan.outcome).toBe("updated");
    expect(ids(plan.before)).toEqual([9, 10]);
    expect(text).toBe(once);
  });

  it("a manifest entry whose code file is missing gets a new code entry", () => {
    const broken = '{"localFileExtensions":[' + JSON.stringify({ id: 1, manifestPath: PLUGIN.manifestPath, lastKnownName: "Figxel", lastKnownPluginId: PLUGIN.id, fileMetadata: { type: "manifest", codeFileId: 5, uiFileIds: [] } }) + "]}";
    const { plan } = apply(broken, register());
    expect(plan.outcome).toBe("updated");
    const manifest = plan.entries.find((e) => e.id === 1)!;
    expect(manifest.fileMetadata).toEqual({ type: "manifest", codeFileId: 6, uiFileIds: [7] });
    expect(plan.entries.filter((e) => e.id !== 1).map((e) => [e.id, e.manifestPath, e.fileMetadata.type])).toEqual([
      [6, PLUGIN.codePath, "code"],
      [7, PLUGIN.uiPaths[0], "ui"],
    ]);
  });

  it("refuses a file that lists the same manifest twice", () => {
    const m = (id: number) => JSON.stringify({ id, manifestPath: PLUGIN.manifestPath, fileMetadata: { type: "manifest", codeFileId: 9, uiFileIds: [] } });
    expect(() => apply(`{"localFileExtensions":[${m(1)},${m(2)}]}`, register())).toThrow(/listed 2 times/);
  });

  it("keeps a registration of the same plugin from another folder, and says so", () => {
    const { plan, text } = apply(FROM_CLONE, register());
    expect(plan.outcome).toBe("kept-other");
    expect(plan.others).toEqual([`${CLONE_PLUGIN}\\manifest.json`]);
    expect(text).toBe(FROM_CLONE);
  });

  it("with --force, moves that registration to <home>/plugin, keeping its ids and its other keys", () => {
    const { plan, text } = apply(FROM_CLONE, register(true));
    expect(plan.outcome).toBe("moved");
    expect(ids(plan.before)).toEqual([4, 9, 10]);
    const moved = [
      `{"id":4,"manifestPath":${JSON.stringify(PLUGIN.manifestPath)},"lastKnownName":"Figxel","lastKnownPluginId":"figma-mcp-bridge","fileMetadata":{"type":"manifest","codeFileId":9,"uiFileIds":[10]},"cachedContainsWidget":false}`,
      `{"id":9,"manifestPath":${JSON.stringify(PLUGIN.codePath)},"fileMetadata":{"type":"code","manifestFileId":4}}`,
      `{"id":10,"manifestPath":${JSON.stringify(PLUGIN.uiPaths[0])},"fileMetadata":{"type":"ui","manifestFileId":4}}`,
    ];
    expect(plan.after.map((e) => JSON.stringify(e))).toEqual(moved);
    // Exactly those three entries' text changes; Figma's leftovers 5 and 6 stay.
    let expected = FROM_CLONE;
    [4, 9, 10].forEach((id, i) => (expected = expected.replace(rawEntry(FROM_CLONE, id), moved[i]!)));
    expect(text).toBe(expected);
    expect(apply(text, register()).plan.outcome).toBe("unchanged");
  });

  it("a file with no list yet gets one, after the last key, in the file's own style", () => {
    const compact = apply('{"zoomStop":100,"locale":"en"}', register()).text;
    expect(compact.startsWith('{"zoomStop":100,"locale":"en","localFileExtensions":[{"id":1,')).toBe(true);
    expect(compact.endsWith("}]}")).toBe(true);
    expect(JSON.parse(apply("{}", register()).text)).toEqual({ localFileExtensions: JSON.parse(JSON.stringify(apply("{}", register()).plan.entries)) });

    const pretty = apply('{\n  "zoomStop": 100\n}\n', register()).text;
    expect(pretty.startsWith('{\n  "zoomStop": 100,\n  "localFileExtensions": [\n    {\n      "id": 1,\n')).toBe(true);
    expect(pretty.endsWith("\n    }\n  ]\n}\n")).toBe(true);
    expect(JSON.parse(pretty).localFileExtensions).toHaveLength(3);
  });

  it("keeps an indented file indented, with its CRLF line ends and its byte-order mark", () => {
    const data = { zoomStop: 100, localFileExtensions: JSON.parse(WITHOUT).localFileExtensions as unknown[], locale: "en" };
    const original = `\uFEFF${JSON.stringify(data, null, 2).replace(/\n/g, "\r\n")}\r\n`;
    const { text } = apply(original, register());
    expect(text.startsWith("\uFEFF{\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(text).toContain('\r\n    {\r\n      "id": 9,\r\n      "manifestPath": ');
    expect(text.endsWith('\r\n  ],\r\n  "locale": "en"\r\n}\r\n')).toBe(true);
    expect(JSON.parse(text.slice(1)).localFileExtensions).toHaveLength(8);
    // And --unregister gives back the very same bytes.
    expect(apply(text, unregister()).text).toBe(original);
  });

  it("strings that hold brackets, braces and quotes do not confuse where the list is", () => {
    const original = '{"title":"a ] } \\" [ { ,","localFileExtensions":[],"after":"[{\\"x\\"}]"}';
    const { text } = apply(original, register());
    expect(text.startsWith('{"title":"a ] } \\" [ { ,","localFileExtensions":[{"id":1,')).toBe(true);
    expect(text.endsWith('}],"after":"[{\\"x\\"}]"}')).toBe(true);
    expect(apply(text, unregister()).text).toBe(original);
  });
});

describe("unregister", () => {
  it("removes exactly what register added: the file is the same bytes again", () => {
    const registered = apply(WITHOUT, register()).text;
    const { plan, text } = apply(registered, unregister());
    expect(plan.outcome).toBe("removed");
    expect(ids(plan.before)).toEqual([9, 10, 11]);
    expect(text).toBe(WITHOUT);
  });

  it("removes Figxel's entries and Figma's leftovers in its folder, and never another plugin's", () => {
    const { plan, text } = apply(FROM_CLONE, unregister(`${CLONE_PLUGIN}\\manifest.json`));
    expect(plan.outcome).toBe("removed");
    expect(ids(plan.before)).toEqual([5, 6, 4, 9, 10]);
    // Entries 2 and 3 point at manifest 1 too, but sit in another folder: not Figxel's.
    expect(ids(plan.entries)).toEqual([2, 3, 1, 7, 8]);
    for (const id of [2, 3, 1, 7, 8]) expect(text).toContain(rawEntry(FROM_CLONE, id));
    expect(text.slice(0, text.indexOf("["))).toBe(FROM_CLONE.slice(0, FROM_CLONE.indexOf("[")));
  });

  it("with nothing at <home>/plugin there is nothing to remove, and another folder's registration is reported", () => {
    const { plan, text } = apply(FROM_CLONE, unregister());
    expect(plan.outcome).toBe("absent");
    expect(plan.others).toEqual([`${CLONE_PLUGIN}\\manifest.json`]);
    expect(text).toBe(FROM_CLONE);
  });
});

// ---------------------------------------------------------------------------
// The file on disk, with a temporary file and an injected process check

const REGISTER: RegistrationRequest = { action: "register", force: false, dryRun: false };
const UNREGISTER: RegistrationRequest = { action: "unregister", force: false, dryRun: false };

function settingsFile(text: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "figxel-figma-settings-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, text);
  return { dir, path };
}

function runOn(path: string, request: RegistrationRequest, running: boolean | null = false, calls: { n: number } = { n: 0 }): RegistrationReport {
  return runFigmaRegistration(PLUGIN, request, {
    platform: "win32",
    settingsPath: path,
    isFigmaRunning: () => {
      calls.n++;
      return running;
    },
    now: () => new Date("2026-10-14T12:34:56.789Z"),
  });
}

describe("writing the file", () => {
  it("backs the file up next to itself, then replaces it whole; no temporary file stays", () => {
    const { dir, path } = settingsFile(WITHOUT);
    const r = runOn(path, REGISTER);
    expect(r.outcome).toBe("added");
    expect(r.backupPath).toBe(`${path}.figxel-backup-2026-10-14T12-34-56-789Z`);
    expect(readFileSync(r.backupPath!, "utf8")).toBe(WITHOUT);
    expect(readFileSync(path, "utf8")).toBe(apply(WITHOUT, register()).text);
    expect(readdirSync(dir).sort()).toEqual(["settings.json", "settings.json.figxel-backup-2026-10-14T12-34-56-789Z"]);
    expect(r.figmaVersion).toBe("126.9.13");
    expect(r.figmaRunning).toBe(false);
    const text = formatRegistrationReport(r);
    for (const s of ["Added", PLUGIN.manifestPath, r.backupPath!, "Plugins → Development → Figxel", "paste the token", "Import plugin from manifest…", "--unregister"]) {
      expect(text).toContain(s);
    }
  });

  it("a second run writes nothing, makes no backup and does not even check for Figma", () => {
    const { dir, path } = settingsFile(WITHOUT);
    runOn(path, REGISTER);
    const calls = { n: 0 };
    const r = runOn(path, REGISTER, true, calls);
    expect(r.outcome).toBe("unchanged");
    expect(r.backupPath).toBeNull();
    expect(calls.n).toBe(0);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it("refuses while Figma runs, or when it cannot tell, and writes nothing", () => {
    for (const running of [true, null]) {
      const { dir, path } = settingsFile(WITHOUT);
      const r = runOn(path, REGISTER, running);
      expect(r.outcome).toBe("refused");
      expect(r.reason).toMatch(running ? /Figma desktop is running/ : /could not tell whether Figma desktop is running/);
      expect(r.next[0]).toMatch(/Quit Figma desktop completely/);
      expect(r.after).toHaveLength(3);
      expect(readFileSync(path, "utf8")).toBe(WITHOUT);
      expect(readdirSync(dir)).toEqual(["settings.json"]);
      expect(formatRegistrationReport(r)).toContain("Not registered: ");
    }
  });

  it("a dry run prints the change and writes nothing, even while Figma runs", () => {
    for (const [request, text] of [
      [{ ...REGISTER, dryRun: true }, WITHOUT],
      [{ ...REGISTER, force: true, dryRun: true }, FROM_CLONE],
      [{ ...UNREGISTER, dryRun: true }, apply(WITHOUT, register()).text],
    ] as const) {
      const { dir, path } = settingsFile(text);
      const r = runOn(path, request, true);
      expect(r.outcome).not.toBe("refused");
      expect(r.backupPath).toBeNull();
      expect(r.figmaRunning).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(text);
      expect(readdirSync(dir)).toEqual(["settings.json"]);
      const out = formatRegistrationReport(r);
      expect(out).toContain("Dry run: nothing was written.");
      expect(out).toMatch(/^ {4}[-+] \{"id":/m);
      expect(out).toContain("Figma desktop is running now: quit it before the real run.");
      expect(out).toContain("without --dry-run");
    }
  });

  it("without --force a registration from another folder is kept, and the output says how to move it", () => {
    const { path } = settingsFile(FROM_CLONE);
    const r = runOn(path, REGISTER);
    expect(r.outcome).toBe("kept-other");
    expect(readFileSync(path, "utf8")).toBe(FROM_CLONE);
    const out = formatRegistrationReport(r);
    expect(out).toContain(`already registered from ${CLONE_PLUGIN}\\manifest.json`);
    expect(out).toContain("--register --force");
  });

  it("unregister restores the file register changed, and a second backup never replaces the first", () => {
    const { dir, path } = settingsFile(WITHOUT);
    const first = runOn(path, REGISTER);
    const r = runOn(path, UNREGISTER);
    expect(r.outcome).toBe("removed");
    expect(readFileSync(path, "utf8")).toBe(WITHOUT);
    expect(runOn(path, UNREGISTER).outcome).toBe("absent");
    // Both runs had the same clock: the second backup takes the next free name.
    expect(r.backupPath).toBe(`${first.backupPath}-2`);
    expect(readFileSync(first.backupPath!, "utf8")).toBe(WITHOUT);
    expect(readFileSync(r.backupPath!, "utf8")).toBe(apply(WITHOUT, register()).text);
    expect(readdirSync(dir)).toHaveLength(3);
  });

  it("refuses a missing file, an unknown structure and Linux, writing nothing", () => {
    const missing = runOn(join(tmpdir(), "figxel-no-such-dir", "settings.json"), REGISTER);
    expect(missing.outcome).toBe("refused");
    expect(missing.reason).toMatch(/is not at .*settings\.json/);
    expect(missing.next[0]).toContain("Import plugin from manifest…");

    const { path } = settingsFile('{"localFileExtensions":{"not":"a list"}}');
    const unknown = runOn(path, REGISTER);
    expect(unknown.outcome).toBe("refused");
    expect(unknown.reason).toMatch(/not in the form setup knows: "localFileExtensions" is not a list\. Nothing was written\./);
    expect(readFileSync(path, "utf8")).toBe('{"localFileExtensions":{"not":"a list"}}');

    const linux = runFigmaRegistration(PLUGIN, REGISTER, { platform: "linux", isFigmaRunning: () => false });
    expect(linux.outcome).toBe("refused");
    expect(linux.reason).toMatch(/no Linux build/);
    expect(linux.settingsPath).toBeNull();
  });

  it("macOS is marked experimental", () => {
    const { path } = settingsFile(WITHOUT);
    const r = runFigmaRegistration(PLUGIN, { ...REGISTER, dryRun: true }, { platform: "darwin", settingsPath: path, isFigmaRunning: () => false });
    expect(r.experimental).toBe(true);
    expect(formatRegistrationReport(r)).toContain("macOS is experimental");
  });
});

describe("setup with --register", () => {
  it("the flags: --register or --unregister, --force only with --register, --dry-run with either", () => {
    expect(parseRegistrationFlags([])).toEqual({ request: null });
    expect(parseRegistrationFlags(["--register"])).toEqual({ request: { action: "register", force: false, dryRun: false } });
    expect(parseRegistrationFlags(["--register", "--force", "--dry-run"])).toEqual({ request: { action: "register", force: true, dryRun: true } });
    expect(parseRegistrationFlags(["--unregister", "--dry-run"])).toEqual({ request: { action: "unregister", force: false, dryRun: true } });
    expect(parseCommand(["setup", "--register", "--json"])).toEqual({ kind: "setup", json: true, figma: { action: "register", force: false, dryRun: false } });
    expect(parseCommand(["setup", "--register", "--unregister"])).toEqual({ kind: "error", message: "setup takes --register or --unregister, not both" });
    expect(parseCommand(["setup", "--force"])).toEqual({ kind: "error", message: "--force goes with setup --register" });
    expect(parseCommand(["setup", "--unregister", "--force"])).toEqual({ kind: "error", message: "--force goes with setup --register" });
    expect(parseCommand(["setup", "--dry-run"])).toEqual({ kind: "error", message: "--dry-run goes with setup --register or setup --unregister" });
    expect(parseCommand(["setup", "--registr"])).toEqual({ kind: "error", message: 'setup takes only --json, --register, --unregister, --force, --dry-run, not "--registr"' });
  });

  it("the help documents both commands", () => {
    const help = helpText();
    for (const c of ["setup --register [--force] [--dry-run]", "setup --unregister [--dry-run]"]) expect(help).toContain(`${PACKAGE_NAME} ${c}`);
    expect(help).toContain("Quit Figma first");
  });

  it("once registered, setup's first Figma step is no longer the import", () => {
    const home = mkdtempSync(join(tmpdir(), "figxel-setup-"));
    const report = runSetup({ home, tokenPath: join(home, "token") }, "ab".repeat(32), { platform: "win32" });
    const { path } = settingsFile(WITHOUT);
    const r = runFigmaRegistration(pluginToRegister(report.pluginDir, null), REGISTER, { platform: "win32", settingsPath: path, isFigmaRunning: () => false });
    expect(r.outcome).toBe("added");
    const both = withRegistration(report, r);
    expect(both.figmaSteps[0]).toMatch(/^Nothing to import: setup --register listed the plugin/);
    expect(both.figmaSteps.slice(1)).toEqual(report.figmaSteps.slice(1));
    expect(both.figmaRegistration).toBe(r);
    // A refusal leaves the import step in place.
    const refused = runFigmaRegistration(pluginToRegister(report.pluginDir, null), REGISTER, { platform: "linux" });
    expect(withRegistration(report, refused).figmaSteps).toEqual(report.figmaSteps);
  });
});

describe("the built bin", () => {
  // Figma's settings file is found from APPDATA on Windows and HOME on macOS: both point into a temporary folder.
  function figmaHome(text: string): { env: Record<string, string>; settings: string | null } {
    const root = mkdtempSync(join(tmpdir(), "figxel-figma-home-"));
    const dir = process.platform === "win32" ? join(root, "Figma") : join(root, "Library", "Application Support", "Figma");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), text);
    return { env: { APPDATA: root, HOME: root, USERPROFILE: root }, settings: process.platform === "linux" ? null : join(dir, "settings.json") };
  }
  const run = (args: string[], home: string, extra: Record<string, string>) =>
    spawnSync(process.execPath, [SERVER, ...args], {
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", BRIDGE_HOME: home, ...extra },
      encoding: "utf8",
    });

  it("setup --register --dry-run prints the change and writes nothing: not the settings, not the token, not the plugin copy", () => {
    const home = mkdtempSync(join(tmpdir(), "figxel-setup-"));
    const figma = figmaHome(WITHOUT);
    const r = run(["setup", "--register", "--dry-run"], home, figma.env);
    expect(existsSync(join(home, "token"))).toBe(false);
    expect(existsSync(join(home, "plugin"))).toBe(false);
    if (process.platform === "linux") {
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("no Linux build");
      return;
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Dry run: nothing was written.");
    expect(r.stdout).toContain(`+ {"id":9,"manifestPath":${JSON.stringify(join(home, "plugin", "manifest.json"))}`);
    expect(readFileSync(figma.settings!, "utf8")).toBe(WITHOUT);
  });

  it("setup --unregister --json reports as JSON, and a stray flag exits 2", () => {
    const home = mkdtempSync(join(tmpdir(), "figxel-setup-"));
    const figma = figmaHome(WITHOUT);
    const r = run(["setup", "--unregister", "--json"], home, figma.env);
    const report = JSON.parse(r.stdout) as RegistrationReport;
    expect(report.action).toBe("unregister");
    expect(report.outcome).toBe(process.platform === "linux" ? "refused" : "absent");
    expect(r.status).toBe(process.platform === "linux" ? 1 : 0);
    if (figma.settings) expect(readFileSync(figma.settings, "utf8")).toBe(WITHOUT);

    const bad = run(["setup", "--force"], home, figma.env);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("--force goes with setup --register");
  });
});
