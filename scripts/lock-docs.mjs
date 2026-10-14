#!/usr/bin/env node
// Lock the documentation surface so nothing changes silently.
//
//   node scripts/lock-docs.mjs            verify against the lock (exit 1 on any change)
//   node scripts/lock-docs.mjs --update   re-lock, after an intentional change
//
// Why this exists: a parallel agent rewrote these documents once and
// introduced four factual errors that took a full review pass to find. A
// read-only file attribute is not a real lock (any process running as the
// same user can undo it) and it breaks legitimate editing. What actually
// works is a recorded baseline plus a gate that refuses the commit.
//
// Scope — the normative surface:
//   README.md, AGENTS.md, docs/** (except the plans below), scripts/**
// Deliberately NOT locked: docs/superpowers/plans/** (working plans, they
// change by design), and src/, test/, dist/, spikes/ (code and spike kits).
//
// The docs/ tree is walked as a whole rather than by naming subfolders: a new
// document at the docs root (docs/clients.md was one) would otherwise sit
// outside the lock without anyone noticing.
const SKIP = new Set(["docs/superpowers/plans"]);
//
// Line endings are normalised before hashing: git's `eol=lf` attribute means
// the working tree and a fresh clone can differ by CRLF/LF for the same
// content. Hashing raw bytes would produce false alarms. A leading BOM is
// stripped for the same reason.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(root, "docs.lock.json");

const FILES = ["README.md", "AGENTS.md"];
const DIRS = ["docs", "scripts"];

function listFiles(rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [rel];
  if (SKIP.has(rel)) return [];
  const out = [];
  for (const name of readdirSync(abs)) {
    if (name.startsWith(".")) continue;
    const child = `${rel}/${name}`;
    const st = statSync(join(root, child));
    if (st.isDirectory()) out.push(...listFiles(child));
    else if (SKIP.has(child)) continue;
    else if (/\.(md|mjs|ps1)$/.test(name)) out.push(child);
  }
  return out;
}

// Stable, line-ending-independent content hash.
function hash(abs) {
  const buf = readFileSync(abs);
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  text = text.replace(/\r\n/g, "\n");
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function snapshot() {
  const files = [...FILES, ...DIRS.flatMap(listFiles)].sort();
  const out = {};
  for (const f of files) out[f] = hash(join(root, f));
  return out;
}

const current = snapshot();
const update = process.argv.includes("--update");

if (!existsSync(LOCK)) {
  if (update) {
    writeFileSync(LOCK, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    console.log(`lock-docs: locked ${Object.keys(current).length} files → docs.lock.json`);
    process.exit(0);
  }
  console.error("lock-docs: docs.lock.json is missing. Run: node scripts/lock-docs.mjs --update");
  process.exit(1);
}

const locked = JSON.parse(readFileSync(LOCK, "utf8"));

// Writing the lock must never be blocked by the lock. `docs.lock.json` is
// itself read-only (layer 2), and on Windows that turns an --update into an
// EPERM crash — the recovery procedure would be broken by the very lock it
// maintains. Clear the attribute on the way in, restore it on the way out.
const isWindows = process.platform === "win32";
const readOnly = { on: [], off: [] };
function unlockWrite(paths) {
  if (!isWindows) return;
  for (const p of paths) {
    if (existsSync(p) && (statSync(p).mode & 0o200) === 0) {
      execFileSync("attrib", ["-R", p], { stdio: "ignore" });
      readOnly.on.push(p);
    }
  }
}
function restoreLock() {
  if (!isWindows) return;
  // Everything the lock covers must end up read-only — including files that
  // an --update just touched, and files that happen to be missing the
  // attribute for any other reason. This is what makes the read-only layer
  // self-healing rather than something a stray `git checkout` can undo.
  const all = new Set([
    ...readOnly.on,
    ...Object.keys(current).map((f) => join(root, f)),
    LOCK, // the lock file guards itself too
  ]);
  for (const p of all) {
    if (existsSync(p)) {
      try { execFileSync("attrib", ["+R", p], { stdio: "ignore" }); } catch { /* best effort */ }
    }
  }
}

if (update) {
  const changed = [];
  for (const [f, h] of Object.entries(current)) if (locked[f] !== h) changed.push(f);
  for (const f of Object.keys(locked)) if (!(f in current)) changed.push(`${f} (removed)`);
  unlockWrite([LOCK]);
  try {
    writeFileSync(LOCK, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  } finally {
    restoreLock();
  }
  console.log(`lock-docs: re-locked ${Object.keys(current).length} files (${changed.length} changed)`);
  for (const f of changed) console.log(`  ~ ${f}`);
  process.exit(0);
}

const modified = [];
const added = [];
const removed = [];
for (const [f, h] of Object.entries(current)) {
  if (!(f in locked)) added.push(f);
  else if (locked[f] !== h) modified.push(f);
}
for (const f of Object.keys(locked)) if (!(f in current)) removed.push(f);

const problems = modified.length + added.length + removed.length;
if (problems) {
  console.error(`lock-docs: the documentation surface changed (${problems})\n`);
  for (const f of modified) console.error(`  ~ modified: ${f}`);
  for (const f of added) console.error(`  + added:    ${f}`);
  for (const f of removed) console.error(`  - removed:  ${f}`);
  console.error(
    "\nThese documents are locked so they cannot change silently.\n" +
    "If the change is intentional:  node scripts/lock-docs.mjs --update\n" +
    "If it is not:                  git checkout -- <file>",
  );
  process.exit(1);
}

console.log(`lock-docs: OK — ${Object.keys(current).length} files match the lock`);
