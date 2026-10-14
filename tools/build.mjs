#!/usr/bin/env node
// Build — spec §4.5. Six outputs:
//   dist/server.js               single bundle, src/skills included; `node dist/server.js` needs no node_modules.
//                                It is the package's bin, so its first line is a shebang.
//   dist/plugin/code.js          the sandbox, es2017
//   dist/plugin/ui.html          ui.html with the ui.ts bundle inlined (Figma loads `ui` as one file)
//   dist/plugin/manifest.json    copied as-is
//   dist/build-id.json           the plugin and skills build ids (src/server/plugin-build.ts)
//   dist/THIRD_PARTY_NOTICES.md  every package the server bundle inlines, with its licence text
//
// Lives in tools/ rather than scripts/: scripts/** is the locked doc surface.

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginSourceFiles } from "./plugin-sources.mjs";
import { readSkillsTree } from "./skills-tree.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const pluginDist = join(dist, "plugin");
mkdirSync(pluginDist, { recursive: true });

const started = performance.now();

// The one version: package.json's, injected into every bundle as
// __PACKAGE_VERSION__ (src/shared/version.ts), so `--version`, serverInfo and
// the plugin's pluginVersion always say what the package says.
const PACKAGE_VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (typeof PACKAGE_VERSION !== "string" || !PACKAGE_VERSION) throw new Error("package.json has no version");
const VERSION_DEFINE = { __PACKAGE_VERSION__: JSON.stringify(PACKAGE_VERSION) };

// A content hash of the plugin sources, injected into the bundle that the
// sandbox runs and into the server that talks to it.
//
// WHY: a running plugin holds the code it was STARTED with. Rebuilding dist/
// while the plugin window stays open changes nothing, and there was no way to
// tell from the outside — `pluginVersion` is a constant string, so a stale
// plugin reported "0.1.0" forever and the only way to find out was to call a
// tool and notice it missing. That cost real debugging time more than once.
//
// With the hash on both sides, `figma_status` can say "the connected plugin is
// running build A and dist/ is build B" BEFORE anyone calls anything. It also
// makes the restart prompt answerable: when the hashes match, no restart is
// needed, and asking for one would be wrong.
// Every plugin and shared source is hashed (tools/plugin-sources.mjs): the
// editor table refuses inside the plugin too, so a flipped cell is a new build,
// and so is a manifest change (a new editorType needs the plugin re-run).
const pluginHash = createHash("sha256");
for (const f of pluginSourceFiles(root)) {
  pluginHash.update(f);
  pluginHash.update(readFileSync(join(root, f)));
}
const BUILD_ID = pluginHash.digest("hex").slice(0, 12);

// The skills (src/skills), baked into the server bundle so `node dist/server.js`
// reads no file at run time, and with their own id: a skill edit rebuilds the
// server, not the plugin, so it must not ask anyone to re-run the plugin. The
// walker is the one src/server/skills.ts uses unbundled [C-237].
const SKILLS = readSkillsTree(join(root, "src/skills"));
const SKILLS_BUILD_ID = SKILLS.treeHash.slice(0, 12);

const server = build({
  entryPoints: [join(root, "src/server/mcp.ts")],
  outfile: join(dist, "server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // ws requires these optional native helpers inside try/catch; leave them out.
  external: ["bufferutil", "utf-8-validate"],
  define: { __FIGMA_MCP_ENTRY__: "true", __PLUGIN_BUILD_ID__: JSON.stringify(BUILD_ID), __SKILLS_TREE__: JSON.stringify(SKILLS), ...VERSION_DEFINE },
  // The shebang first: npm links dist/server.js as the package's bin, and on
  // macOS and Linux that line is how the file finds node. Then: CommonJS
  // dependencies (ws) call require(); give the ESM bundle a real one.
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  // The licences of what is inlined go to dist/THIRD_PARTY_NOTICES.md instead (below).
  legalComments: "none",
  metafile: true,
  absWorkingDir: root,
  logLevel: "warning",
});


const sandbox = build({
  entryPoints: [join(root, "src/plugin/code.ts")],
  outfile: join(pluginDist, "code.js"),
  bundle: true,
  platform: "neutral",
  format: "iife",
  // Conservative until the spike shows the sandbox handles newer syntax (spec §14.10).
  target: "es2017",
  define: { __PLUGIN_BUILD_ID__: JSON.stringify(BUILD_ID), ...VERSION_DEFINE },
  legalComments: "none",
  metafile: true,
  absWorkingDir: root,
  logLevel: "warning",
});

const ui = build({
  entryPoints: [join(root, "src/plugin/ui.ts")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  target: "es2017",
  define: VERSION_DEFINE,
  legalComments: "none",
  metafile: true,
  absWorkingDir: root,
  logLevel: "warning",
}).then((r) => {
  const js = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const html = readFileSync(join(root, "src/plugin/ui.html"), "utf8");
  if (!html.includes("<!-- SCRIPT -->")) throw new Error("src/plugin/ui.html has no <!-- SCRIPT --> placeholder");
  writeFileSync(join(pluginDist, "ui.html"), html.replace("<!-- SCRIPT -->", () => `<script>\n${js}</script>`));
  return r;
});

const [serverResult, sandboxResult, uiResult] = await Promise.all([server, sandbox, ui]);
copyFileSync(join(root, "src/plugin/manifest.json"), join(pluginDist, "manifest.json"));

// Third-party notices. The server bundle inlines its dependencies and
// legalComments "none" drops their licence comments, while MIT, BSD, ISC and
// Zlib all ask that the notice travel with every copy. So every package the
// metafile shows was inlined is listed, with the licence file from its folder.
// The plugin bundles inline none today; if one ever does, notices are written
// into dist/plugin too, because that folder is shipped on its own (a release zip).
const serverPackages = inlinedPackages([serverResult.metafile]);
const pluginPackages = inlinedPackages([sandboxResult.metafile, uiResult.metafile]);
writeFileSync(join(dist, "THIRD_PARTY_NOTICES.md"), notices("dist/server.js", serverPackages));
if (pluginPackages.length > 0) {
  writeFileSync(join(pluginDist, "THIRD_PARTY_NOTICES.md"), notices("The plugin (code.js, ui.html)", pluginPackages));
}

const ms = Math.round(performance.now() - started);

// Kept next to the bundles so a person (or a script that cannot import this
// module) can read which plugin build dist/ currently holds.
writeFileSync(join(dist, "build-id.json"), JSON.stringify({ pluginBuildId: BUILD_ID, skillsBuildId: SKILLS_BUILD_ID }, null, 2) + "\n");
process.stderr.write(
  `build: dist/server.js ${PACKAGE_VERSION} (${SKILLS.files.length} skill files, ${serverPackages.length} third-party packages), ` +
    `dist/plugin/{code.js,ui.html,manifest.json} in ${ms} ms\n`,
);

/** Each node_modules package with files among the metafiles' inputs: name, version, licence and licence text. */
function inlinedPackages(metafiles) {
  const dirs = new Set();
  for (const meta of metafiles) {
    for (const input of Object.keys(meta.inputs)) {
      const path = input.replaceAll("\\", "/");
      const at = path.lastIndexOf("node_modules/");
      if (at < 0) continue;
      const parts = path.slice(at + "node_modules/".length).split("/");
      const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
      dirs.add(join(root, path.slice(0, at), "node_modules", name));
    }
  }
  const byId = new Map();
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const license =
      typeof pkg.license === "string"
        ? pkg.license
        : (pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(" OR ") : "UNKNOWN"));
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i.test(f));
    // A package without its licence text cannot be redistributed correctly: stop the build, not the lawyer.
    if (!file) throw new Error(`${relative(root, dir)} has no licence file to reproduce in THIRD_PARTY_NOTICES.md`);
    const text = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trim();
    byId.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license, text });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The notices file: a table, then each licence text verbatim. */
function notices(what, packages) {
  const lines = [
    "# Third-party notices",
    "",
    `${what} bundles the packages below. Each licence text is reproduced after the table, as those licences require.`,
    "Generated by tools/build.mjs from the esbuild metafile.",
    "",
    "| Package | Version | Licence |",
    "|---|---|---|",
    ...packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  ];
  for (const p of packages) {
    const fence = p.text.includes("```") ? "~~~~" : "```";
    lines.push("", `## ${p.name} ${p.version}`, "", `Licence: ${p.license}`, "", `${fence}text`, p.text, fence);
  }
  return `${lines.join("\n")}\n`;
}
