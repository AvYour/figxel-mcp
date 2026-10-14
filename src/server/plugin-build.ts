// The plugin build id this server was built with, and the skills id beside it.
//
// Injected by tools/build.mjs as `__PLUGIN_BUILD_ID__`, and written next to the
// bundle as `dist/build-id.json` (with `skillsBuildId`, src/server/skills.ts)
// for anything that needs to read it without importing this module.
//
// It exists so `figma_status` can answer a question that previously had no
// answer from outside the plugin: is the connected plugin running the code in
// dist/ right now? A plugin holds the bundle it was started with, and its
// version string is a constant, so a stale plugin used to look exactly like a
// current one until a tool call failed or a measurement came back wrong.
//
// The `typeof` guard is not decoration: unit tests import this module without
// esbuild, where the global genuinely does not exist.

import { readFileSync } from "node:fs";

declare const __PLUGIN_BUILD_ID__: string | undefined;

export const PLUGIN_BUILD_ID: string = typeof __PLUGIN_BUILD_ID__ === "string" ? __PLUGIN_BUILD_ID__ : "dev";

/**
 * The plugin build id in dist/ RIGHT NOW, read from dist/build-id.json.
 *
 * PLUGIN_BUILD_ID is fixed when this server process starts, so after a rebuild
 * a long-running server compares a fresh plugin against its own stale id and
 * reports `matches: false` — and the advice "re-run the plugin" can never make
 * it true [C-084]. Reading the file at call time tells the two cases apart: a
 * plugin older than dist/ needs a re-run; a server older than dist/ needs the
 * MCP client restarted.
 *
 * `null` when the file cannot be read (a fresh checkout before a build).
 */
export function buildIdOnDisk(candidates: readonly URL[] = DEFAULT_LOCATIONS): string | null {
  return idOnDisk("pluginBuildId", candidates);
}

/**
 * The skills tree id in dist/ right now (`skillsBuildId`). The skills are baked
 * into the server bundle, so a server started before a rebuild serves the old
 * text — the same staleness as an old hub, with the same remedy.
 */
export function skillsBuildIdOnDisk(candidates: readonly URL[] = DEFAULT_LOCATIONS): string | null {
  return idOnDisk("skillsBuildId", candidates);
}

function idOnDisk(key: "pluginBuildId" | "skillsBuildId", candidates: readonly URL[]): string | null {
  for (const url of candidates) {
    try {
      const id = (JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>)[key];
      if (typeof id === "string" && id) return id;
    } catch {
      // not here — try the next location
    }
  }
  return null;
}

// Next to the bundle (dist/server.js), or from the source tree (src/server/).
const DEFAULT_LOCATIONS: readonly URL[] = [
  new URL("./build-id.json", import.meta.url),
  new URL("../../dist/build-id.json", import.meta.url),
];

export interface BuildCheck {
  plugin: string | null;
  dist: string | null;
  server: string;
  matches: boolean | null;
  /** Which side to restart, when one is out of date. */
  restart?: "plugin" | "client";
}

/** Compare a session's plugin build with dist/ and with this server. */
export function checkBuild(pluginId: string | undefined, server: string = PLUGIN_BUILD_ID, onDisk: string | null = buildIdOnDisk()): BuildCheck {
  const dist = onDisk ?? (server === "dev" ? null : server);
  const plugin = pluginId ?? null;
  const matches = plugin && dist ? plugin === dist : null;
  const restart =
    plugin && dist && plugin !== dist ? "plugin" : dist && server !== "dev" && server !== dist ? "client" : undefined;
  return { plugin, dist, server, matches, ...(restart ? { restart } : {}) };
}

export interface SkillsCheck {
  /** The skills this process serves. */
  version: string;
  /** The skills in dist/ now; null when unknown (no build yet, or a build that predates the field). */
  dist: string | null;
  /** Set when this process serves older skills than dist/ holds. */
  restart?: "client";
}

/**
 * Compare the skills this process serves with dist/. Only a bundle can lag:
 * unbundled (vitest, a dev run) the server read src/skills itself.
 */
export function checkSkillsBuild(version: string, bundled: boolean, onDisk: string | null = skillsBuildIdOnDisk()): SkillsCheck {
  return { version, dist: onDisk, ...(bundled && onDisk && onDisk !== version ? { restart: "client" as const } : {}) };
}
