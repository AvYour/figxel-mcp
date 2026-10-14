// The npm package: what package.json declares and what the build puts in dist/.
// A stranger runs `npx -y figxel-mcp@latest`, which installs only the files
// listed in package.json and none of the dependencies, so the bundle must carry
// every one of them, start with a shebang, and ship their licence notices.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/shared/version.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown> & {
  version: string;
  bin: Record<string, string>;
  files: string[];
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const BUNDLE = readFileSync(join(ROOT, "dist/server.js"), "utf8");

describe("package.json", () => {
  it("is a public package whose bin is the bundle", () => {
    expect(PKG.name).toBe(PACKAGE_NAME);
    expect(PKG.private).toBeUndefined();
    expect(PKG.license).toBe("MIT");
    expect(PKG.type).toBe("module");
    expect(PKG.bin).toEqual({ [PACKAGE_NAME]: "dist/server.js" });
    expect(PKG.engines).toEqual({ node: ">=22" });
    expect(PKG.repository).toEqual({ type: "git", url: "git+https://github.com/AvYour/figxel-mcp.git" });
  });

  it("ships only the built files; README.md and LICENSE come along on their own", () => {
    expect(PKG.files).toEqual(["dist/server.js", "dist/build-id.json", "dist/plugin/", "dist/THIRD_PARTY_NOTICES.md"]);
    // dist/ is gitignored, so a pack from a clean checkout must build first.
    expect(PKG.scripts.prepack).toBe("npm run build");
  });

  it("has no runtime dependencies: the bundle inlines them", () => {
    expect(PKG.dependencies).toBeUndefined();
    for (const d of ["@modelcontextprotocol/sdk", "pdf-lib", "ws", "zod"]) expect(PKG.devDependencies[d], d).toBeDefined();
  });
});

describe("dist/server.js", () => {
  it("starts with a shebang, so the bin runs on macOS and Linux", () => {
    expect(BUNDLE.split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  it("imports nothing but Node built-ins and ws's optional native helpers", () => {
    const specifiers = [
      ...[...BUNDLE.matchAll(/^import\s[^;]*?\sfrom\s"([^"]+)"/gm)].map((m) => m[1]!),
      ...[...BUNDLE.matchAll(/__require\("([^"]+)"\)/g)].map((m) => m[1]!),
    ];
    expect(specifiers.length).toBeGreaterThan(10);
    const outside = specifiers.filter((s) => !isBuiltin(s) && s !== "bufferutil" && s !== "utf-8-validate");
    expect([...new Set(outside)]).toEqual([]);
  });

  it("carries package.json's version", () => {
    const r = spawnSync(process.execPath, [join(ROOT, "dist/server.js"), "--version"], { encoding: "utf8" });
    expect(r.stdout).toBe(`${PKG.version}\n`);
  });

  it("runs from a folder that holds only the packaged files", () => {
    const pkg = mkdtempSync(join(tmpdir(), "figxel-pkg-"));
    for (const f of ["server.js", "build-id.json", "plugin"]) cpSync(join(ROOT, "dist", f), join(pkg, "dist", f), { recursive: true });
    const home = mkdtempSync(join(tmpdir(), "figxel-pkg-home-"));
    const r = spawnSync(process.execPath, [join(pkg, "dist/server.js"), "setup", "--json"], {
      env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", BRIDGE_HOME: home },
      encoding: "utf8",
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { manifestPath: string }).manifestPath).toBe(join(home, "plugin", "manifest.json"));
  });
});

describe("dist/THIRD_PARTY_NOTICES.md", () => {
  const notices = readFileSync(join(ROOT, "dist/THIRD_PARTY_NOTICES.md"), "utf8");
  const rows = [...notices.matchAll(/^\| (\S+) \| (\S+) \| (.+) \|$/gm)].filter((m) => m[1] !== "Package" && m[1] !== "---");

  it("lists every former runtime dependency and their own dependencies", () => {
    const names = rows.map((m) => m[1]);
    for (const d of ["@modelcontextprotocol/sdk", "pdf-lib", "ws", "zod", "ajv", "pako", "zod-to-json-schema"]) expect(names, d).toContain(d);
  });

  it("reproduces a licence text for each package in the table", () => {
    expect(rows.length).toBeGreaterThan(5);
    for (const [, name, version, license] of rows) {
      const section = notices.split(`\n## ${name} ${version}\n`)[1];
      expect(section, `${name} ${version}`).toBeDefined();
      expect(section!.startsWith(`\nLicence: ${license}\n`)).toBe(true);
      expect(section!.split("\n## ")[0]!.length, name).toBeGreaterThan(100);
    }
  });
});
