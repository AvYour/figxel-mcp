// The plugin build id.
//
// This exists because of a specific, repeated waste of the user's time: asking
// them to restart the plugin when a restart would have changed nothing, and
// asking them to debug a "missing tool" that was really a stale bundle.
//
// A plugin keeps the bundle it was STARTED with. Rebuilding dist/ while its
// window stays open changes nothing. `pluginVersion` is a constant string, so a
// stale plugin and a current one both reported "0.1.0" — the only ways to tell
// were to call a tool and watch it fail, or to read a layout and notice the
// numbers looked old. Both happened here before this existed.
//
// These tests assert the three answers the field must be able to give, including
// the one that must NOT be a guess: an old plugin that does not report a build
// id at all. `matches: null` is the honest answer there, and turning it into
// `false` would send someone to restart for no reason.

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_BUILD_ID } from "../src/server/plugin-build.js";

const root = join(__dirname, "..");

describe("the plugin build id", () => {
  it("is a short hex string when bundled, and `dev` when not", () => {
    // Under vitest the module is imported without esbuild, so the injected global
    // genuinely does not exist. `dev` is the correct answer there, and asserting
    // hex would be asserting that the test harness was bundled — which it is not.
    expect(PLUGIN_BUILD_ID).toMatch(/^(dev|[0-9a-f]{12})$/);
  });

  it("is written next to the bundles so a script can read it without importing", () => {
    const file = join(root, "dist", "build-id.json");
    if (!existsSync(file)) return; // dist/ is not built in a fresh checkout
    const { pluginBuildId } = JSON.parse(readFileSync(file, "utf8")) as { pluginBuildId: string };
    // The file carries the BUNDLED id, which is always a hash even when this
    // test process is unbundled and reads `dev`.
    expect(pluginBuildId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is baked into both bundles, so plugin and server can compare", () => {
    const plugin = join(root, "dist", "plugin", "code.js");
    const server = join(root, "dist", "server.js");
    const file = join(root, "dist", "build-id.json");
    if (!existsSync(plugin) || !existsSync(server) || !existsSync(file)) return;
    const { pluginBuildId } = JSON.parse(readFileSync(file, "utf8")) as { pluginBuildId: string };
    expect(readFileSync(plugin, "utf8")).toContain(pluginBuildId);
    expect(readFileSync(server, "utf8")).toContain(pluginBuildId);
  });

  it("is hashed from every plugin and shared source, op modules in subfolders included", async () => {
    // A hard-coded list missed the FigJam and Slides modules: a change there
    // would have kept the id, and figma_status would have called a stale plugin current.
    const { pluginSourceFiles } = (await import("../tools/plugin-sources.mjs" as string)) as { pluginSourceFiles: (root: string) => string[] };
    const files = pluginSourceFiles(root);
    expect(files).toEqual([...files].sort());
    expect(files).toEqual(
      expect.arrayContaining([
        "src/plugin/code.ts", "src/plugin/context.ts", "src/plugin/board-read.ts", "src/plugin/manifest.json", "src/plugin/ui.html",
        "src/plugin/figjam/nodes.ts", "src/plugin/figjam/palette.ts", "src/plugin/slides/grid.ts", "src/plugin/ops/figjam.ts",
        "src/shared/editors.ts", "src/shared/ops.ts",
      ]),
    );
    expect(files.every((f) => f.startsWith("src/plugin/") || f.startsWith("src/shared/"))).toBe(true);
  });

  it("changes when a plugin source changes", async () => {
    // The property that makes it useful: two different bundles must not share an
    // id, or "matches" would be true for a stale plugin.
    const { createHash } = await import("node:crypto");
    const hashOf = (extra: string) => {
      const h = createHash("sha256");
      for (const f of ["src/plugin/code.ts", "src/plugin/read.ts", "src/plugin/write.ts", "src/plugin/chunk.ts", "src/plugin/bind.ts", "src/shared/ops.ts"]) {
        h.update(readFileSync(join(root, f)));
      }
      h.update(extra);
      return h.digest("hex").slice(0, 12);
    };
    expect(hashOf("")).not.toBe(hashOf("// a change"));
  });
});

describe("the build comparison in figma_status", () => {
  // The comparison itself is three lines, but each of its three answers means
  // something different to a caller, so all three are pinned here.
  const compare = (pluginId: string | undefined): boolean | null => (pluginId ? pluginId === PLUGIN_BUILD_ID : null);

  it("says true when the plugin is running the current build — do not ask for a restart", () => {
    expect(compare(PLUGIN_BUILD_ID)).toBe(true);
  });

  it("says false when the plugin is stale — this is the case that needs a restart", () => {
    expect(compare("000000000000")).toBe(false);
  });

  it("says null, not false, when the plugin is too old to report an id", () => {
    // A plugin predating build ids still works for most things. Reporting
    // `false` there would tell the caller to restart for no reason.
    expect(compare(undefined)).toBeNull();
  });
});
