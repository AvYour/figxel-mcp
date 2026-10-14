#!/usr/bin/env node
// Check documentation consistency. No dependencies.
//   node scripts/check-docs.mjs
// Exits 1 on any problem. What is checked:
//   1. Relative links and anchors in every .md (README + docs/) point at an existing file or heading.
//   2. tools.md: a group heading's count matches its tool rows; totals match (the opt-in
//      groups, eval and audio, are left out of the default); the core tier is valid.
//   3. Every `figma_*` name in a document exists in the catalog (or in the candidates table).
//   4. Every op in a protocol example ("op": ..., "ops": [...]) is a catalog tool without its prefix.
//   5. Any "N tool(s)" (N >= 20) in README/spec equals the catalog total or the default count.
//   6. The group summary tables in tools.md and spec §7 match the catalog.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const fail = (file, msg) => errors.push(`${relative(root, file).replaceAll("\\", "/")}: ${msg}`);

function listMarkdown(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listMarkdown(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

const files = [join(root, "README.md"), ...listMarkdown(join(root, "docs"))];
const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

// Lines outside fenced code blocks.
function proseLines(src) {
  const lines = [];
  let fenced = false;
  for (const line of src.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced) lines.push(line);
  }
  return lines;
}

// GitHub-style heading slug, including -1, -2 suffixes for duplicates.
function anchorsOf(src) {
  const seen = new Map();
  const anchors = new Set();
  for (const line of proseLines(src)) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = m[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
      .replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

// 1. Link & anchor
const anchorCache = new Map();
const anchorsFor = (f) => {
  if (!anchorCache.has(f)) anchorCache.set(f, anchorsOf(readFileSync(f, "utf8")));
  return anchorCache.get(f);
};
let linkCount = 0;
for (const [file, src] of text) {
  for (const line of proseLines(src)) {
    const noCode = line.replace(/`[^`]*`/g, "");
    for (const m of noCode.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:
      linkCount++;
      const [pathPart, anchor] = target.split("#");
      const dest = pathPart ? resolve(dirname(file), decodeURI(pathPart)) : file;
      if (!existsSync(dest)) { fail(file, `broken link → ${target}`); continue; }
      if (anchor && dest.endsWith(".md") && !anchorsFor(dest).has(anchor)) {
        fail(file, `anchor not found → ${target}`);
      }
    }
  }
}

// 2. Tool catalog
const toolsFile = join(root, "docs/reference/tools.md");
const toolsSrc = text.get(toolsFile);
const GROUPS = ["meta", "read", "create", "modify", "style", "export", "audio", "eval"];
// Groups registered only on opt-in: `eval` (BRIDGE_ALLOW_EVAL=1) and the
// held-back `audio` group (BRIDGE_ENABLE_AUDIO=1). The default count leaves them out.
const OPT_IN_GROUPS = ["eval", "audio"];
const catalog = new Map(); // name → group
const groupCounts = new Map();
{
  let group = null;
  for (const line of proseLines(toolsSrc)) {
    const h = /^##\s+(\w+)\s+\((\d+)\)\s*$/.exec(line);
    if (h && GROUPS.includes(h[1])) {
      group = h[1];
      groupCounts.set(group, { declared: Number(h[2]), rows: 0 });
      continue;
    }
    if (/^##\s/.test(line)) { group = null; continue; }
    const row = group && /^\|\s*`(figma_[a-z_]+)`\s*\|/.exec(line);
    if (row) {
      if (catalog.has(row[1])) fail(toolsFile, `duplicate tool: ${row[1]}`);
      catalog.set(row[1], group);
      groupCounts.get(group).rows++;
    }
  }
}
for (const g of GROUPS) {
  const c = groupCounts.get(g);
  if (!c) { fail(toolsFile, `group heading "## ${g} (N)" not found`); continue; }
  if (c.declared !== c.rows) fail(toolsFile, `group ${g}: heading says ${c.declared}, table has ${c.rows}`);
}
const total = catalog.size;
const optInCount = OPT_IN_GROUPS.reduce((n, g) => n + (groupCounts.get(g)?.rows ?? 0), 0);
const defaultCount = total - optInCount;
{
  const m = /(?:Count):\s*(\d+) tools? (?:in the catalog) → (\d+) (?:registered) by default/.exec(toolsSrc);
  if (!m) fail(toolsFile, `sentence "Count: N tools in the catalog → M registered by default" not found`);
  else if (Number(m[1]) !== total || Number(m[2]) !== defaultCount) {
    fail(toolsFile, `written count ${m[1]}/${m[2]}, actual ${total}/${defaultCount}`);
  }
}

// Tier core
{
  const m = /(?:Tier `core`|The `core` tier) \((\d+)\)\s*=\s*(.+)$/m.exec(toolsSrc);
  if (!m) fail(toolsFile, "the core tier definition was not found");
  else {
    const names = [...m[2].matchAll(/`(figma_[a-z_]+)`/g)].map((x) => x[1]);
    if (names.length !== Number(m[1])) fail(toolsFile, `core tier: says ${m[1]}, lists ${names.length}`);
    for (const n of names) if (!catalog.has(n)) fail(toolsFile, `core tier contains an unknown tool: ${n}`);
    if (!names.includes("figma_status")) fail(toolsFile, "the core tier must include figma_status");
  }
}

// 6. Group summary tables: "| meta | 4 |" (tools.md) and "| **meta** | 4 |" (spec §7)
const specFile = join(root, "docs/superpowers/specs/2026-10-06-figma-mcp-design.md");
for (const f of [toolsFile, specFile]) {
  for (const line of proseLines(text.get(f))) {
    const m = /^\|\s*\**(meta|read|create|modify|style|export|audio|eval)\**\s*\|\s*(\d+)\s*\|/.exec(line);
    if (m && groupCounts.get(m[1]) && Number(m[2]) !== groupCounts.get(m[1]).rows) {
      fail(f, `summary table: ${m[1]} = ${m[2]}, catalog = ${groupCounts.get(m[1]).rows}`);
    }
  }
}

// 3. figma_* names across all documents
const candidates = new Set();
{
  const sec = toolsSrc.split(/^### (?:Candidates)/m)[1]?.split(/^##\s/m)[0] ?? "";
  for (const m of sec.matchAll(/`(figma_[a-z_]+)`/g)) candidates.add(m[1]);
}
for (const [file, src] of text) {
  for (const m of new Set([...src.matchAll(/\bfigma_[a-z][a-z_]*[a-z]\b/g)].map((x) => x[0]))) {
    if (!catalog.has(m) && !candidates.has(m)) fail(file, `references a tool that is not in the catalog: ${m}`);
  }
}

// 4. Op names in protocol examples
const ops = new Set([...catalog.keys()].map((n) => n.slice("figma_".length)));
for (const f of [join(root, "docs/reference/protocol.md"), specFile]) {
  const src = text.get(f);
  const found = [
    ...[...src.matchAll(/"op"\s*:\s*"([a-z_]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/"ops"\s*:\s*\[([^\]]*)\]/g)].flatMap((m) =>
      [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1])),
  ];
  for (const op of found) if (!ops.has(op)) fail(f, `unknown op in example: "${op}"`);
}

// 5. "N tool" in README & spec
for (const f of [join(root, "README.md"), specFile]) {
  for (const m of text.get(f).matchAll(/\b(\d+)\s+tool\b/gi)) {
    const n = Number(m[1]);
    if (n >= 20 && n !== total && n !== defaultCount) {
      fail(f, `says "${m[0]}" — catalog: ${total} total, ${defaultCount} default`);
    }
  }
}

if (errors.length) {
  console.error(`check-docs: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(
  `check-docs: OK — ${files.length} documents, ${linkCount} relative links, ` +
  `${total} tool (${defaultCount} default + ${optInCount} opt-in), ${candidates.size} candidates`,
);
