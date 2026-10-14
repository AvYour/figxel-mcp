// The command line beyond the MCP server: `setup`, the help text, and the
// plugin copy the server keeps current.
//
// `figxel-mcp setup` is what someone who installed nothing but the package runs
// once, and may run again after an update. It needs no clone and no build:
//   - the token is created in the home folder (BRIDGE_HOME, default ~/.figxel);
//   - the plugin bundled next to dist/server.js is copied to <home>/plugin. The
//     package itself runs from an npx cache folder whose path changes with every
//     version, so importing the manifest from there would break on the first
//     update; <home>/plugin keeps one path, so Figma imports it once;
//   - everything a person types next is printed: the token, the manifest path,
//     the steps in Figma, and a client entry for this operating system.
//
// stdout belongs to the person here, not to JSON-RPC: these commands never
// start the server.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_DIRNAME, PACKAGE_NAME, PLUGIN_MENU_PATH, PLUGIN_NAME, PRODUCT_NAME, SERVER_NAME, SETUP_COMMAND, VERSION } from "../shared/version.js";
import { ConfigError, type Config, type Logger } from "./config.js";

// ---------------------------------------------------------------------------
// The command line

export type Command =
  | { kind: "serve" }
  | { kind: "setup"; json: boolean }
  | { kind: "print-token" }
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "error"; message: string };

/**
 * What the arguments ask for. No arguments is the MCP server, which is what a
 * client starts. Anything unrecognised is an error rather than a server start:
 * a mistyped `setpu` would otherwise sit waiting for JSON-RPC on stdin.
 */
export function parseCommand(argv: readonly string[]): Command {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  if (argv.includes("--version")) return { kind: "version" };
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "serve" };
  if (first === "setup") {
    const unknown = rest.filter((a) => a !== "--json");
    if (unknown.length > 0) return { kind: "error", message: `setup takes only --json, not "${unknown[0]}"` };
    return { kind: "setup", json: rest.includes("--json") };
  }
  if (first === "--print-token" && rest.length === 0) return { kind: "print-token" };
  return { kind: "error", message: `unknown argument "${first === "--print-token" ? rest[0] : first}"` };
}

export function helpText(): string {
  const bin = PACKAGE_NAME;
  return [
    `${bin} ${VERSION} — ${PRODUCT_NAME}, an MCP server for Figma desktop`,
    "",
    "Usage:",
    `  ${bin}                  run as an MCP server over stdio (what an MCP client starts)`,
    `  ${bin} setup            create the token, copy the Figma plugin into the home folder,`,
    "                              and print the token, the manifest to import and client entries",
    `  ${bin} setup --json     the same, as JSON`,
    `  ${bin} --print-token    print the plugin token (created if absent)`,
    `  ${bin} --version        print the version`,
    `  ${bin} --help           print this help`,
    "",
    `Home folder: ~/${HOME_DIRNAME} (BRIDGE_HOME overrides it). Other settings are BRIDGE_* environment variables.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The plugin copy

/** What Figma loads from a development plugin's folder: the manifest names the other two. */
export const PLUGIN_FILES = ["code.js", "ui.html", "manifest.json"] as const;

// Next to the bundle (dist/server.js → dist/plugin/), or from the source tree (src/server/ → dist/plugin/).
const BUNDLED_PLUGIN_LOCATIONS: readonly URL[] = [new URL("./plugin/", import.meta.url), new URL("../../dist/plugin/", import.meta.url)];

/** The folder holding the plugin this server was built with, or null when none of the candidates has all three files. */
export function bundledPluginDir(candidates: readonly URL[] = BUNDLED_PLUGIN_LOCATIONS): string | null {
  for (const url of candidates) {
    const dir = fileURLToPath(url);
    if (PLUGIN_FILES.every((f) => existsSync(join(dir, f)))) return dir;
  }
  return null;
}

/** Where setup puts the plugin: one path for every version, so Figma imports its manifest once. */
export function installedPluginDir(home: string): string {
  return join(home, "plugin");
}

/**
 * Copy the bundled plugin into `dir`, replacing only the files whose bytes
 * differ. Returns the files it wrote; an empty list means the copy was current.
 * Each file goes to a temporary name first and is renamed over the old one, so
 * Figma never reads a half-written bundle and two servers starting at the same
 * moment do not interleave their writes.
 */
export function copyPlugin(from: string, dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  // The manifest last: it is what Figma reads first.
  for (const name of PLUGIN_FILES) {
    const bytes = readFileSync(join(from, name));
    const target = join(dir, name);
    if (existsSync(target) && readFileSync(target).equals(bytes)) continue;
    const temp = `${target}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, bytes);
      renameSync(temp, target);
    } finally {
      rmSync(temp, { force: true });
    }
    written.push(name);
  }
  return written;
}

export type RefreshResult = "absent" | "current" | "refreshed" | "failed";

/**
 * Keep <home>/plugin equal to the plugin this server carries; called when the
 * server starts. After an update the new version runs from a new npx folder
 * while Figma still loads <home>/plugin, so without this the plugin a person
 * re-runs would stay the old one, and figma_status's "re-run the plugin" could
 * never come true. A re-run loads the replaced files without a new import:
 * measured on 2026-10-07, when a plugin closed and run again after a build ran
 * the new bundle (docs/superpowers/plans/2026-10-07-phases-1-2-log.md).
 *
 * Only a folder that setup created is touched ("absent" otherwise: the plugin
 * was imported from somewhere else, such as a clone's dist/plugin). It never
 * throws: a server that cannot refresh the copy still serves.
 */
export function refreshInstalledPlugin(home: string, logger: Logger, from: string | null = bundledPluginDir()): RefreshResult {
  const dir = installedPluginDir(home);
  if (!existsSync(join(dir, "manifest.json"))) return "absent";
  try {
    if (!from) throw new Error("the plugin files are not next to this server");
    const written = copyPlugin(from, dir);
    if (written.length === 0) return "current";
    logger.info(
      `updated the Figma plugin in ${dir} to ${PACKAGE_NAME} ${VERSION} (${written.join(", ")}); ` +
        `close the ${PLUGIN_NAME} plugin window in Figma and run it again to load it`,
    );
    return "refreshed";
  } catch (e) {
    logger.warn(`could not update the Figma plugin in ${dir}: ${e instanceof Error ? e.message : String(e)}. Run \`${SETUP_COMMAND}\` to copy it.`);
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// What a client runs

export interface Launch {
  command: string;
  args: string[];
}

/**
 * How an MCP client starts this server on `platform`. On Windows npx is a .cmd
 * script, which a client that starts processes without a shell cannot run, so
 * `cmd /c` runs it. Kept in this one function so the rule is one edit.
 */
export function serverLaunch(platform: NodeJS.Platform = process.platform): Launch {
  const npx = ["-y", `${PACKAGE_NAME}@latest`];
  return platform === "win32" ? { command: "cmd", args: ["/c", "npx", ...npx] } : { command: "npx", args: npx };
}

/** Claude Desktop's config file on `platform`; null where there is no Claude Desktop (Linux). */
export function claudeDesktopConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  userHome: string = homedir(),
): string | null {
  if (platform === "win32") return win32.join(env.APPDATA?.trim() || win32.join(userHome, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (platform === "darwin") return posix.join(userHome, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return null;
}

// ---------------------------------------------------------------------------
// setup

export interface SetupReport {
  product: string;
  version: string;
  /** The operating system the client entries are for (process.platform). */
  platform: NodeJS.Platform;
  home: string;
  token: string;
  tokenPath: string;
  pluginDir: string;
  manifestPath: string;
  /** The plugin files this run wrote; empty when the copy was already current. */
  pluginFilesWritten: string[];
  figmaSteps: string[];
  clients: {
    claudeDesktop: { configPath: string; config: { mcpServers: Record<string, Launch> } } | null;
    claudeCode: string;
    stdio: Launch;
  };
  next: string[];
}

export interface SetupOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  userHome?: string;
  /** The bundled plugin folder; a test passes its own. */
  pluginFrom?: string | null;
}

/** Copy the plugin and gather what setup prints. The token must already exist (main() creates it). */
export function runSetup(config: Pick<Config, "home" | "tokenPath">, token: string, opts: SetupOptions = {}): SetupReport {
  const platform = opts.platform ?? process.platform;
  const from = opts.pluginFrom === undefined ? bundledPluginDir() : opts.pluginFrom;
  if (!from) {
    throw new ConfigError(`The Figma plugin files are not next to this server, so there is nothing to copy. Reinstall ${PACKAGE_NAME}.`);
  }
  const pluginDir = installedPluginDir(config.home);
  let written: string[];
  try {
    written = copyPlugin(from, pluginDir);
  } catch (e) {
    throw new ConfigError(`Could not copy the Figma plugin into ${pluginDir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const manifestPath = join(pluginDir, "manifest.json");
  const launch = serverLaunch(platform);
  const desktopPath = claudeDesktopConfigPath(platform, opts.env ?? process.env, opts.userHome ?? homedir());
  return {
    product: PRODUCT_NAME,
    version: VERSION,
    platform,
    home: config.home,
    token,
    tokenPath: config.tokenPath,
    pluginDir,
    manifestPath,
    pluginFilesWritten: written,
    figmaSteps: [
      `Plugins → Development → Import plugin from manifest…, and choose ${manifestPath}. Only once: the path stays the same across updates.`,
      `Run the plugin: ${PLUGIN_MENU_PATH}.`,
      "Paste the token into the plugin window and press Save.",
    ],
    clients: {
      claudeDesktop: desktopPath ? { configPath: desktopPath, config: { mcpServers: { [SERVER_NAME]: launch } } } : null,
      claudeCode: `claude mcp add -s user ${SERVER_NAME} -- ${[launch.command, ...launch.args].join(" ")}`,
      stdio: launch,
    },
    next: [
      "Restart the MCP client, then ask it to call figma_status.",
      `After an update, the server copies the new plugin into ${pluginDir} when it starts: close the ${PLUGIN_NAME} plugin window in Figma and run it again.`,
    ],
  };
}

/** A launch as one line of JSON, the way a person would type it into a config file. */
export function launchJson(l: Launch): string {
  return `{ "command": ${JSON.stringify(l.command)}, "args": [${l.args.map((a) => JSON.stringify(a)).join(", ")}] }`;
}

/** The report as a person reads it. */
export function formatSetupReport(r: SetupReport): string {
  const osName = r.platform === "win32" ? "Windows" : r.platform === "darwin" ? "macOS" : "Linux";
  const out = [
    `${r.product} ${r.version} is set up in ${r.home}`,
    "",
    "Token (the plugin asks for it once):",
    `  ${r.token}`,
    "",
    "Plugin manifest:",
    `  ${r.manifestPath}`,
    "",
    "In Figma desktop:",
    ...r.figmaSteps.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    `Add the server to your MCP client (entries for ${osName}):`,
  ];
  if (r.clients.claudeDesktop) {
    const [name, launch] = Object.entries(r.clients.claudeDesktop.config.mcpServers)[0]!;
    out.push(
      "",
      `  Claude Desktop: add this to ${r.clients.claudeDesktop.configPath}`,
      '  (if the file already has "mcpServers", add the entry inside it):',
      "    {",
      '      "mcpServers": {',
      `        ${JSON.stringify(name)}: ${launchJson(launch)}`,
      "      }",
      "    }",
    );
  }
  out.push(
    "",
    "  Claude Code:",
    `    ${r.clients.claudeCode}`,
    "",
    "  Any other MCP client (stdio):",
    `    ${launchJson(r.clients.stdio)}`,
    "",
    ...r.next,
  );
  return `${out.join("\n")}\n`;
}
