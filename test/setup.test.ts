// `figxel-mcp setup`, the command line around it, and the plugin copy the
// server keeps current (src/server/setup.ts). The unit tests call the
// functions; the end-to-end ones run the built bin with a temporary
// BRIDGE_HOME, the way an npx install runs it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, createLogger } from "../src/server/config.js";
import {
  bundledPluginDir,
  claudeDesktopConfigPath,
  copyPlugin,
  formatSetupReport,
  helpText,
  launchJson,
  parseCommand,
  PLUGIN_FILES,
  refreshInstalledPlugin,
  runSetup,
  serverLaunch,
  type SetupReport,
} from "../src/server/setup.js";
import { PACKAGE_NAME, PLUGIN_MENU_PATH, SERVER_NAME, SETUP_COMMAND } from "../src/shared/version.js";

const SERVER = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const DIST_PLUGIN = fileURLToPath(new URL("../dist/plugin/", import.meta.url));
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const TOKEN = "ab".repeat(32);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const temp = () => mkdtempSync(join(tmpdir(), "figxel-setup-"));
const capture = () => {
  const lines: string[] = [];
  return { lines, logger: createLogger("debug", (l) => lines.push(l)) };
};
const same = (a: string, b: string) => readFileSync(a).equals(readFileSync(b));

function env(home: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", BRIDGE_HOME: home, ...extra };
}
const run = (args: string[], home: string) => spawnSync(process.execPath, [SERVER, ...args], { env: env(home), encoding: "utf8" });

describe("the command line", () => {
  it("no argument serves; setup, --print-token, --version and --help are commands", () => {
    expect(parseCommand([])).toEqual({ kind: "serve" });
    expect(parseCommand(["setup"])).toEqual({ kind: "setup", json: false });
    expect(parseCommand(["setup", "--json"])).toEqual({ kind: "setup", json: true });
    expect(parseCommand(["--print-token"])).toEqual({ kind: "print-token" });
    expect(parseCommand(["--version"])).toEqual({ kind: "version" });
    for (const argv of [["--help"], ["-h"], ["setup", "--help"]]) expect(parseCommand(argv)).toEqual({ kind: "help" });
  });

  it("anything else is an error, not a server waiting on stdin", () => {
    expect(parseCommand(["setpu"])).toEqual({ kind: "error", message: 'unknown argument "setpu"' });
    expect(parseCommand(["setup", "--force"])).toEqual({ kind: "error", message: 'setup takes only --json, not "--force"' });
    expect(parseCommand(["--print-token", "x"])).toEqual({ kind: "error", message: 'unknown argument "x"' });
  });

  it("the help names the bin and every command", () => {
    const help = helpText();
    expect(help.startsWith(`${PACKAGE_NAME} `)).toBe(true);
    for (const c of ["setup", "setup --json", "--print-token", "--version", "--help"]) expect(help).toContain(`${PACKAGE_NAME} ${c}`);
    expect(help).toContain("BRIDGE_HOME");
    expect(help).not.toMatch(/dist\/|node dist/);
  });
});

describe("what an MCP client runs", () => {
  it("npx on macOS and Linux; through cmd /c on Windows, where npx is a .cmd script", () => {
    expect(serverLaunch("darwin")).toEqual({ command: "npx", args: ["-y", "figxel-mcp@latest"] });
    expect(serverLaunch("linux")).toEqual({ command: "npx", args: ["-y", "figxel-mcp@latest"] });
    expect(serverLaunch("win32")).toEqual({ command: "cmd", args: ["/c", "npx", "-y", "figxel-mcp@latest"] });
    expect(launchJson(serverLaunch("win32"))).toBe('{ "command": "cmd", "args": ["/c", "npx", "-y", "figxel-mcp@latest"] }');
  });

  it("Claude Desktop's config file per OS, and none on Linux", () => {
    expect(claudeDesktopConfigPath("win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a")).toBe(
      "C:\\Users\\a\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
    );
    expect(claudeDesktopConfigPath("win32", {}, "C:\\Users\\a")).toBe("C:\\Users\\a\\AppData\\Roaming\\Claude\\claude_desktop_config.json");
    expect(claudeDesktopConfigPath("darwin", {}, "/Users/a")).toBe("/Users/a/Library/Application Support/Claude/claude_desktop_config.json");
    expect(claudeDesktopConfigPath("linux", {}, "/home/a")).toBeNull();
  });
});

describe("setup", () => {
  const setupIn = (home: string, platform: NodeJS.Platform) =>
    runSetup({ home, tokenPath: join(home, "token") }, TOKEN, { platform, env: { APPDATA: "C:\\AppData" }, userHome: "/u" });

  it("copies the bundled plugin into <home>/plugin, byte for byte, and only what changed on a second run", () => {
    expect(bundledPluginDir()).not.toBeNull();
    const home = temp();
    const r = setupIn(home, "win32");
    expect(r.pluginDir).toBe(join(home, "plugin"));
    expect(r.manifestPath).toBe(join(home, "plugin", "manifest.json"));
    expect(r.pluginFilesWritten).toEqual([...PLUGIN_FILES]);
    for (const f of PLUGIN_FILES) expect(same(join(home, "plugin", f), join(DIST_PLUGIN, f)), f).toBe(true);
    expect(readdirSync(join(home, "plugin")).sort()).toEqual([...PLUGIN_FILES].sort());
    expect(setupIn(home, "win32").pluginFilesWritten).toEqual([]);
  });

  it("reports the token, the manifest, the steps in Figma and a client entry for the OS", () => {
    const r = setupIn(temp(), "win32");
    expect(r.token).toBe(TOKEN);
    expect(r.figmaSteps).toHaveLength(3);
    expect(r.figmaSteps[0]).toContain("Plugins → Development → Import plugin from manifest…");
    expect(r.figmaSteps[0]).toContain(r.manifestPath);
    expect(r.figmaSteps[1]).toContain(PLUGIN_MENU_PATH);
    expect(r.clients.claudeDesktop).toEqual({
      configPath: "C:\\AppData\\Claude\\claude_desktop_config.json",
      config: { mcpServers: { [SERVER_NAME]: { command: "cmd", args: ["/c", "npx", "-y", "figxel-mcp@latest"] } } },
    });
    expect(r.clients.claudeCode).toBe("claude mcp add -s user figxel -- cmd /c npx -y figxel-mcp@latest");
    expect(r.clients.stdio).toEqual(serverLaunch("win32"));

    const text = formatSetupReport(r);
    for (const s of [TOKEN, r.manifestPath, PLUGIN_MENU_PATH, r.clients.claudeCode, "C:\\AppData\\Claude\\claude_desktop_config.json", "figma_status"]) {
      expect(text).toContain(s);
    }
    expect(text).toContain('"figxel": { "command": "cmd", "args": ["/c", "npx", "-y", "figxel-mcp@latest"] }');
    expect(text).toContain("entries for Windows");
  });

  it("on Linux there is no Claude Desktop entry, and the others use npx directly", () => {
    const r: SetupReport = setupIn(temp(), "linux");
    expect(r.clients.claudeDesktop).toBeNull();
    expect(r.clients.claudeCode).toBe("claude mcp add -s user figxel -- npx -y figxel-mcp@latest");
    const text = formatSetupReport(r);
    expect(text).not.toContain("Claude Desktop");
    expect(text).toContain("entries for Linux");
  });

  it("without the plugin files next to the server it refuses with a ConfigError", () => {
    const home = temp();
    expect(() => runSetup({ home, tokenPath: join(home, "token") }, TOKEN, { pluginFrom: null })).toThrow(ConfigError);
  });
});

describe("the server keeps <home>/plugin current", () => {
  it("leaves a home without a setup copy alone", () => {
    const home = temp();
    const { lines, logger } = capture();
    expect(refreshInstalledPlugin(home, logger)).toBe("absent");
    expect(existsSync(join(home, "plugin"))).toBe(false);
    expect(lines).toEqual([]);
  });

  it("replaces an older copy, says to re-run the plugin, and is quiet when the copy is current", () => {
    const home = temp();
    copyPlugin(DIST_PLUGIN, join(home, "plugin"));
    writeFileSync(join(home, "plugin", "code.js"), "// an older build\n");
    const { lines, logger } = capture();
    expect(refreshInstalledPlugin(home, logger)).toBe("refreshed");
    expect(same(join(home, "plugin", "code.js"), join(DIST_PLUGIN, "code.js"))).toBe(true);
    expect(lines.join("")).toMatch(/\[figxel\] info: updated the Figma plugin in .* \(code\.js\); close the Figxel plugin window in Figma and run it again/);
    expect(refreshInstalledPlugin(home, logger)).toBe("current");
    expect(lines).toHaveLength(1);
    // Written through a temporary name, which never stays behind.
    expect(readdirSync(join(home, "plugin")).sort()).toEqual([...PLUGIN_FILES].sort());
  });

  it("never throws: a missing source is a warning that names setup", () => {
    const home = temp();
    copyPlugin(DIST_PLUGIN, join(home, "plugin"));
    const { lines, logger } = capture();
    expect(refreshInstalledPlugin(home, logger, null)).toBe("failed");
    expect(lines.join("")).toContain(`warn: could not update the Figma plugin in ${join(home, "plugin")}`);
    expect(lines.join("")).toContain(SETUP_COMMAND);
  });
});

describe("the built bin", () => {
  it("--help prints the commands on stdout and exits 0", () => {
    const r = run(["--help"], temp());
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith(`${PACKAGE_NAME} ${PKG.version} — `)).toBe(true);
    expect(r.stdout).toContain(`${PACKAGE_NAME} setup`);
    expect(r.stderr).toBe("");
  });

  it("--version prints package.json's version on stdout", () => {
    const r = run(["--version"], temp());
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${PKG.version}\n`);
  });

  it("an unknown argument exits 2 with the reason and the help on stderr", () => {
    const home = temp();
    const r = run(["setpu"], home);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^\[figxel\] error: unknown argument "setpu"/);
    expect(r.stderr).toContain(`${PACKAGE_NAME} setup`);
    expect(existsSync(join(home, "token"))).toBe(false);
  });

  it("setup creates the token and the plugin copy, and prints both", () => {
    const home = temp();
    const r = run(["setup"], home);
    expect(r.status).toBe(0);
    const token = readFileSync(join(home, "token"), "utf8").trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(r.stdout).toContain(`  ${token}\n`);
    expect(r.stdout).toContain(join(home, "plugin", "manifest.json"));
    expect(r.stdout).toContain(PLUGIN_MENU_PATH);
    for (const f of PLUGIN_FILES) expect(same(join(home, "plugin", f), join(DIST_PLUGIN, f)), f).toBe(true);
    // The same token on the next run: setup never replaces it.
    expect(run(["setup"], home).stdout).toContain(`  ${token}\n`);
  });

  it("setup --json prints the same report as JSON", () => {
    const home = temp();
    const r = run(["setup", "--json"], home);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout) as SetupReport;
    expect(report.version).toBe(PKG.version);
    expect(report.token).toBe(readFileSync(join(home, "token"), "utf8").trim());
    expect(report.manifestPath).toBe(join(home, "plugin", "manifest.json"));
    expect(existsSync(report.manifestPath)).toBe(true);
    expect(report.clients.stdio).toEqual(serverLaunch(process.platform));
    expect(report.platform).toBe(process.platform);
  });

  it("started as an MCP server, it refreshes an older copy in <home>/plugin before it answers", async () => {
    const home = temp();
    mkdirSync(join(home, "plugin"));
    copyPlugin(DIST_PLUGIN, join(home, "plugin"));
    writeFileSync(join(home, "plugin", "ui.html"), "<!-- an older build -->\n");
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: env(home, { BRIDGE_PORT: String(port), BRIDGE_SESSION_WAIT_MS: "300" }),
      stderr: "pipe",
    });
    const client = new Client({ name: "setup-e2e", version: "0" });
    await client.connect(transport);
    cleanup.push(() => client.close());
    expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: PKG.version });
    expect(same(join(home, "plugin", "ui.html"), join(DIST_PLUGIN, "ui.html"))).toBe(true);
  });
});
