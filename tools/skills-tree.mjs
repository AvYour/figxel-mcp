// The skills tree: every file under src/skills with its text, sha256 and size,
// and one hash over all of them [C-237].
//
// One walker for both paths, so they cannot disagree: tools/build.mjs bakes its
// result into dist/server.js, and src/server/skills.ts calls it on src/skills
// when the bundle's copy is absent (vitest, tsc). Pure and dependency-free, like
// plugin-sources.mjs. Sizes and digests are those an MCP skills manifest
// carries (SEP-2640) [C-172], so serving that extension later is additive.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isStrayFile } from "./stray-files.mjs";

/**
 * Split a SKILL.md into its frontmatter and body. The frontmatter holds plain
 * `key: value` lines only — the portable keys every client accepts [C-175] —
 * so a value that would need YAML quoting is refused rather than half-parsed.
 * The body drops the blank line after the frontmatter and the file's final
 * newline, so a guide answer is the text a person wrote between them.
 */
export function splitSkillFile(text) {
  if (!text.startsWith("---\n")) return { frontmatter: null, body: stripFinalNewline(text) };
  const end = text.indexOf("\n---\n", 3);
  if (end < 0) throw new Error("frontmatter opened with --- but never closed");
  const frontmatter = {};
  for (const line of text.slice(4, end).split("\n")) {
    const m = /^([a-z][a-z0-9-]*): (\S.*)$/.exec(line);
    if (!m) throw new Error(`frontmatter line is not a plain "key: value": ${JSON.stringify(line)}`);
    frontmatter[m[1]] = m[2];
  }
  return { frontmatter, body: stripFinalNewline(text.slice(end + 5).replace(/^\n/, "")) };
}

const stripFinalNewline = (s) => (s.endsWith("\n") ? s.slice(0, -1) : s);

/**
 * Walk `dir`. Paths are relative to it with forward slashes and sorted, and
 * text is LF-normalised, so the hash is the same on every OS and checkout.
 * Dotfiles and OS files (.DS_Store, Thumbs.db, desktop.ini) are skipped, so a
 * folder a file manager has touched still builds and hashes as before.
 */
export function readSkillsTree(dir) {
  const paths = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (isStrayFile(e.name)) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path);
      else paths.push(path);
    }
  };
  walk("");
  paths.sort();
  const files = paths.map((path) => {
    const text = readFileSync(join(dir, path), "utf8").replace(/\r\n/g, "\n");
    const bytes = Buffer.from(text, "utf8");
    return {
      path,
      text,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      frontmatter: path.endsWith("/SKILL.md") ? splitSkillFile(text).frontmatter : null,
    };
  });
  const tree = createHash("sha256");
  for (const f of files) tree.update(`${f.path}\0${f.sha256}\n`);
  return { files, treeHash: tree.digest("hex") };
}
