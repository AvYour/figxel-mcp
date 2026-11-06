// package.json "version", injected by tools/build.mjs into every bundle (the
// server and both plugin bundles), so the shipped --version, serverInfo and the
// plugin's pluginVersion cannot drift from the package that carries them.
// Unbundled (vitest, a dev run from src/) nothing is injected: DEV_VERSION.
// The `typeof` guard is what makes that work: the global exists only in a bundle.
declare const __PACKAGE_VERSION__: string | undefined;

/** What VERSION is when the source runs without the build: never a released version. */
export const DEV_VERSION = "0.0.0-dev";
export const VERSION: string = typeof __PACKAGE_VERSION__ === "string" ? __PACKAGE_VERSION__ : DEV_VERSION;

// The product's names, in one place: the server and the plugin both import
// this file, so a rename is one edit here (plus the static files a test pins to
// these values: src/plugin/manifest.json, the skill folders, tools/mock-plugin.mjs).
//
// What is NOT derived from them, on purpose, because users or files already
// hold it: the figma_* tool names, the BRIDGE_* environment variables, the
// plugin manifest id "figma-mcp-bridge" (clientStorage is bound to it), the
// clientStorage token key, and the storyboard namespace written into files.

/** The product, in prose and hints. */
export const PRODUCT_NAME = "Figxel";
/** The npm package, which is also its bin. */
export const PACKAGE_NAME = "figxel-mcp";
/** MCP serverInfo.name, the key a client config uses, the log prefix and the selection resource's URI scheme. */
export const SERVER_NAME = "figxel";
/** The Figma plugin's display name: the Plugins → Development menu entry and the window title. */
export const PLUGIN_NAME = "Figxel";
/** The folder in the user's home directory that holds the token, the exports and the plugin copy (BRIDGE_HOME overrides it). */
export const HOME_DIRNAME = ".figxel";
/** The home folder before the rename: a token found there is copied into the new home once. */
export const LEGACY_HOME_DIRNAME = ".figma-mcp";

/** What a user runs to install or update: it copies the current plugin and prints the token. */
export const SETUP_COMMAND = `npx -y ${PACKAGE_NAME}@latest setup`;
/** What a Figxel Cloud user runs to install or update the plugin: no server, no token on their computer. */
export const INSTALL_COMMAND = `npx -y ${PACKAGE_NAME}@latest install`;

/**
 * True when `a` is a later release than `b`, comparing major.minor.patch. A
 * pre-release or a dev build such as DEV_VERSION is never newer or older than
 * anything: a window run from a checkout is not told to update.
 */
export function isNewerVersion(a: string, b: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number) ?? null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}
/** Where the imported plugin is in Figma's menus. */
export const PLUGIN_MENU_PATH = `Plugins → Development → ${PLUGIN_NAME}`;
