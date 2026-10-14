#!/usr/bin/env node
// Check claim-registry consistency. No dependencies.
//   node scripts/check-claims.mjs
// Exits 1 on any problem. What is checked:
//   1. Every [C-0xx] a document references exists in the registry (no ghost references).
//   2. Every registry entry has a known status.
//   3. Every entry has a Source/Reference and a readable date.
//   4. No duplicate IDs.
//   5. A claim with status `contradiction` is not used as a load-bearer in a document
//      without a "must be tested"/"spike" marker.
//   6. Sections A–H (external facts) do not use the `decision` status.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(root, "docs/reference/claims.md");
const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

if (!existsSync(REGISTRY)) {
  console.error(`check-claims: registry not found → ${relative(root, REGISTRY)}`);
  process.exit(1);
}

const registrySrc = readFileSync(REGISTRY, "utf8");
const STATUSES = new Set(["verified", "corrected", "contradiction", "measured", "to-verify", "decision"]);
const FACT_SECTIONS = /^## ([A-H])\./;

// ── Parse registry ────────────────────────────────────────────────────────────
const entries = new Map(); // id → { status, hasSource, hasDate, section, line }
let section = null;
let inTable = false;

registrySrc.split(/\r?\n/).forEach((line, i) => {
  const h = /^##\s+([A-I])\./.exec(line);
  if (h) { section = h[1]; inTable = false; return; }
  if (/^\|\s*ID\s*\|/.test(line)) { inTable = true; return; }
  if (!inTable) return;
  if (/^\|\s*-{2,}/.test(line)) return;

  const m = /^\|\s*(C-\d{3})\s*\|(.*)$/.exec(line);
  if (!m) return;
  const id = m[1];
  const rest = m[2].split("|").map((c) => c.trim());
  // Columns: Claim | Status | Source | Checked
  const [claim, status, source, checked] = rest;

  if (entries.has(id)) fail(`claims.md:${i + 1}`, `duplicate ID: ${id}`);
  const st = (status || "").replace(/[*`]/g, "").trim();
  if (!STATUSES.has(st)) {
    fail(`claims.md:${i + 1}`, `${id}: unknown status "${status}"`);
  }
  entries.set(id, {
    status: st,
    section,
    hasSource: Boolean(source && source.length > 3 && source !== "—"),
    hasDate: /\d{4}-\d{2}-\d{2}/.test(checked || ""),
    line: i + 1,
    claim: claim || "",
  });
});

if (entries.size === 0) fail("claims.md", "no claim entries could be parsed");

// ── 2/3/6. Rules per entry ────────────────────────────────────────────────────
for (const [id, e] of entries) {
  if (e.status === "contradiction") continue; // the sources genuinely conflict; no single date applies
  if (!e.hasSource) fail(`claims.md:${e.line}`, `${id}: missing Source/Reference column`);
  if (e.status !== "decision" && !e.hasDate) {
    fail(`claims.md:${e.line}`, `${id}: missing "Checked" date (YYYY-MM-DD)`);
  }
  if (FACT_SECTIONS.test(`## ${e.section}.`) && e.status === "decision") {
    fail(`claims.md:${e.line}`, `${id}: section ${e.section} is an external fact, but the status is "decision" — decisions belong in section I`);
  }
}

// ── Collect documents ─────────────────────────────────────────────────────────
function listMarkdown(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listMarkdown(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}
const files = [join(root, "README.md"), ...listMarkdown(join(root, "docs"))].filter(
  (f) => f !== REGISTRY && !f.endsWith("claim-verification.md"),
);

// ── 1/5. References inside documents ───────────────────────────────────────────────────
let refCount = 0;
for (const f of files) {
  const where = relative(root, f).replaceAll("\\", "/");
  const lines = readFileSync(f, "utf8").split(/\r?\n/);
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    for (const m of line.matchAll(/\[(C-\d{3})\]/g)) {
      refCount++;
      const id = m[1];
      const e = entries.get(id);
      if (!e) { fail(`${where}:${i + 1}`, `references a claim that does not exist: ${id}`); continue; }
      if (e.status === "contradiction" && !/must be tested|needs testing|must be tested|needs testing|spike|bertentangan|conflicting|contradicts/i.test(line)) {
        fail(`${where}:${i + 1}`, `${id} is "contradiction" but is used without a "must be tested"/"spike" marker`);
      }
      if (e.status === "to-verify" && /^.{0,40}(must|confirmed|proven|must|confirmed|proven|definitely)\b/i.test(line) && !/not yet|will be tested|to-verify/i.test(line)) {
        fail(`${where}:${i + 1}`, `${id} is "to-verify" but is asserted as fact`);
      }
    }
  });
}

// ── Report ───────────────────────────────────────────────────────────────────
if (errors.length) {
  console.error(`check-claims: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
const byStatus = {};
for (const e of entries.values()) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
const summary = Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(", ");
console.log(`check-claims: OK — ${entries.size} claims (${summary}), ${refCount} references across ${files.length} documents`);
