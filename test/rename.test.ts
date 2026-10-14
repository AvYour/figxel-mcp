// The product's names (figma-mcp → Figxel, for the public release).
//
// The names live in src/shared/version.ts so a rename is one edit. What this
// pins: the values themselves, the static files that cannot import them
// (the plugin manifest, the skill folders, tools/mock-plugin.mjs), the
// identifiers that must NOT follow a rename, and that no text a user or an
// agent reads still carries the old name or a developer-only step.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSkillsTree } from "../tools/skills-tree.mjs";
import {
  HOME_DIRNAME,
  LEGACY_HOME_DIRNAME,
  PACKAGE_NAME,
  PLUGIN_MENU_PATH,
  PLUGIN_NAME,
  PRODUCT_NAME,
  SERVER_NAME,
  SETUP_COMMAND,
} from "../src/shared/version.js";
import { STORYBOARD_NAMESPACE } from "../src/shared/storyboard.js";
import { HUB_LOST_HINT, NO_SESSION_HINT, TOKEN_HINT } from "../src/server/bridge.js";
import { SERVER_INSTRUCTIONS } from "../src/server/guides.js";
import { catalogText, SKILL_PREFIX, SKILLS, skillsOf } from "../src/server/skills.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("the names", () => {
  it("are the release's: Figxel, figxel-mcp, figxel, ~/.figxel", () => {
    expect([PRODUCT_NAME, PACKAGE_NAME, SERVER_NAME, PLUGIN_NAME, HOME_DIRNAME, LEGACY_HOME_DIRNAME]).toEqual([
      "Figxel", "figxel-mcp", "figxel", "Figxel", ".figxel", ".figma-mcp",
    ]);
    expect(SETUP_COMMAND).toBe("npx -y figxel-mcp@latest setup");
    expect(PLUGIN_MENU_PATH).toBe("Plugins → Development → Figxel");
    expect(SKILL_PREFIX).toBe("figxel-");
  });

  it("the plugin manifest carries the plugin name and keeps its id, which clientStorage is bound to", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "src/plugin/manifest.json"), "utf8")) as {
      name: string; id: string; networkAccess: { reasoning: string };
    };
    expect(manifest.name).toBe(PLUGIN_NAME);
    expect(manifest.id).toBe("figma-mcp-bridge");
    expect(manifest.networkAccess.reasoning).toContain(`local ${PRODUCT_NAME} server`);
  });

  it("identifiers already stored in users' files and plugins stay as they were", () => {
    expect(STORYBOARD_NAMESPACE).toBe("figmamcp");
    expect(readFileSync(join(ROOT, "src/plugin/code.ts"), "utf8")).toContain('const TOKEN_KEY = "figma-mcp.token";');
  });

  it("tools/mock-plugin.mjs reads the token from the server's default home", async () => {
    const mock = (await import("../tools/mock-plugin.mjs" as string)) as { DEFAULT_HOME_DIRNAME: string };
    expect(mock.DEFAULT_HOME_DIRNAME).toBe(HOME_DIRNAME);
  });

  it("every skill folder and name carries the prefix", () => {
    expect(SKILLS.length).toBeGreaterThanOrEqual(11);
    for (const s of SKILLS) expect(s.name).toBe(`${SKILL_PREFIX}${s.short}`);
    for (const dir of readdirSync(join(ROOT, "src/skills"))) expect(dir.startsWith(SKILL_PREFIX), dir).toBe(true);
  });
});

describe("what a user or an agent reads", () => {
  it("the instructions and the catalog name the product, and no skill names the old one", () => {
    expect(SERVER_INSTRUCTIONS.startsWith(`${PRODUCT_NAME} drives the Figma file open in Figma desktop (plugin "${PLUGIN_NAME}").`)).toBe(true);
    expect(catalogText().startsWith(`# ${PRODUCT_NAME} skills`)).toBe(true);
    const texts = [SERVER_INSTRUCTIONS, catalogText(), ...readSkillsTree(join(ROOT, "src/skills")).files.map((f) => f.text)];
    expect(texts.filter((t) => /figma-mcp/i.test(t))).toEqual([]);
  });

  it("the connection hints give steps someone who installed the package can take", () => {
    expect(NO_SESSION_HINT).toContain(`Open the plugin in Figma: ${PLUGIN_MENU_PATH}.`);
    expect(NO_SESSION_HINT).toContain(`run \`${SETUP_COMMAND}\` and import the plugin from the manifest it prints`);
    expect(TOKEN_HINT).toBe(
      `A plugin tried to connect to this server and was refused: its token does not match this server's token file. Run \`${SETUP_COMMAND}\`, ` +
        `which prints the token and its fingerprint, and paste the token into the ${PLUGIN_NAME} plugin.`,
    );
    expect(HUB_LOST_HINT).toMatch(/^The Figxel process that held the Figma connection exited/);
    for (const hint of [NO_SESSION_HINT, TOKEN_HINT, HUB_LOST_HINT]) expect(hint).not.toMatch(/figma-mcp|dist\/|rebuild|node dist/i);
  });

  it("the old name is left only where it is an identifier or history", () => {
    // Each allowed line, by what it is; anything else naming figma-mcp is a missed rename.
    const ALLOWED = [
      /LEGACY_HOME_DIRNAME = "\.figma-mcp"/, // the old home, read once for the token
      /plugin manifest id "figma-mcp-bridge"/, // version.ts says what is not renamed
      /"id": "figma-mcp-bridge"/, // the manifest id: clientStorage is bound to it
      /TOKEN_KEY = "figma-mcp\.token"/, // the clientStorage key plugins already wrote
      /~\/\.figma-mcp\/token/, // config.ts documents the move
      /~\/figma-mcp\/server\.py/, // figma-url.ts: where the helpers came from
    ];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|json|html|md)$/.test(e.name)) {
          readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (/figma-mcp/i.test(line) && !ALLOWED.some((re) => re.test(line))) hits.push(`${relative(ROOT, p)}:${i + 1}: ${line.trim()}`);
          });
        }
      }
    };
    walk(join(ROOT, "src"));
    expect(hits).toEqual([]);
  });
});

describe("files an OS drops into a folder are not sources", () => {
  const write = (root: string, files: Record<string, string>) => {
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), t);
    }
  };
  const SKILL = "---\nname: figxel-x\ndescription: An example.\n---\n\n# X\n\nreferences/a.md\n";

  it("the skills walker skips .DS_Store, other dotfiles, Thumbs.db and desktop.ini, and hashes the same", () => {
    const clean = mkdtempSync(join(tmpdir(), "fmcp-stray-"));
    write(clean, { "figxel-x/SKILL.md": SKILL, "figxel-x/references/a.md": "# A\n" });
    const messy = mkdtempSync(join(tmpdir(), "fmcp-stray-"));
    write(messy, {
      "figxel-x/SKILL.md": SKILL,
      "figxel-x/references/a.md": "# A\n",
      ".DS_Store": "\0\0\0\u0001Bud1",
      "figxel-x/.DS_Store": "\0\0\0\u0001Bud1",
      "figxel-x/references/Thumbs.db": "x",
      "figxel-x/desktop.ini": "[.ShellClassInfo]\n",
      "Desktop.ini": "[.ShellClassInfo]\n",
      ".git/HEAD": "ref: refs/heads/main\n",
    });
    const tree = readSkillsTree(messy);
    expect(tree.files.map((f) => f.path)).toEqual(["figxel-x/SKILL.md", "figxel-x/references/a.md"]);
    expect(tree.treeHash).toBe(readSkillsTree(clean).treeHash);
    // Before: the root .DS_Store was a "skill folder" without SKILL.md, and the server refused to start.
    expect(skillsOf(tree).map((s) => s.name)).toEqual(["figxel-x"]);
  });

  it("the plugin source hash skips them too, so a .DS_Store does not change the build id", async () => {
    const { pluginSourceFiles } = (await import("../tools/plugin-sources.mjs" as string)) as { pluginSourceFiles: (root: string) => string[] };
    const root = mkdtempSync(join(tmpdir(), "fmcp-stray-src-"));
    write(root, {
      "src/plugin/code.ts": "",
      "src/plugin/.DS_Store": "x",
      "src/plugin/Thumbs.db": "x",
      "src/plugin/ops/x.ts": "",
      "src/plugin/ops/desktop.ini": "x",
      "src/plugin/.cache/y.ts": "",
      "src/shared/v.ts": "",
      "src/shared/.DS_Store": "x",
    });
    expect(pluginSourceFiles(root)).toEqual(["src/plugin/code.ts", "src/plugin/ops/x.ts", "src/shared/v.ts"]);
  });
});
