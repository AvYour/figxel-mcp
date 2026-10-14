#!/usr/bin/env node
// Enforce AGENTS.md § Language: everything in this repository is written in
// English. No dependencies.
//
//   node scripts/check-language.mjs
//
// Exits 1 when a file contains a non-Latin script (CJK, kana, hangul,
// fullwidth forms) or a word from the Indonesian marker list.
//
// Why this is mechanical rather than a convention: the rule was written down
// and still leaked. The two doc checkers printed their summaries in Indonesian
// for a whole phase — nobody noticed, because nothing checked. A written rule
// you do not verify is a wish.
//
// Deliberately checked by raw bytes as well as by string: a string-based scan
// silently skips a file that is not valid UTF-8, which is exactly the kind of
// file that would carry stray bytes.
//
// Escape hatch for a legitimate exception (a heading quoting another language,
// a fixture): put `language-check: allow` on the line. Use it rarely and
// visibly — it is a comment, not a config file, so it shows up in review.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = relative(root, fileURLToPath(import.meta.url)).replaceAll("\\", "/");

// Ranges written as escapes so this file contains no literal CJK of its own.
const SCRIPT =
  /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef\uac00-\ud7af\u30a0-\u30fa\u31f0-\u31ff]/;

// Indonesian function words with no English homograph. Kept short on purpose:
// a long list produces false positives and gets ignored.
const WORDS =
  /\b(tidak|bukan|harus|bila|dengan|yang|adalah|untuk|sudah|belum|wajib|atau|dan|pada|dari|kita|bisa|juga|akan|dipakai|dijalankan|masalah|dokumen|berkas|kesalahan|jumlah|daftar|perlu|hanya|tanpa|tentang|sebelum|sesudah|karena|namun|tetapi|klaim|rujukan|diuji|grup|terdaftar|sebenarnya|bilang|berisi|memuat|menyebut|ditemukan|tertulis|ganda|berstatus|berikut|cukup|masih|lagi|saja|kalau|mana|apa|siapa|bagaimana|mengapa)\b/i;

const TEXT = new Set([
  ".md", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".jsonl",
  ".html", ".yaml", ".yml", ".txt", ".ps1", ".py", ".css", ".toml", ".sh",
]);
const SKIP_DIR = /^(node_modules|dist|\.git|coverage|__pycache__|\.vitest)$/;
const ALLOW = /language-check:\s*allow/;

const scriptHits = [];
const wordHits = [];
let scanned = 0, undecodable = 0;

function walk(p, depth = 0) {
  if (depth > 9) return;
  let st;
  try { st = statSync(p); } catch { return; }

  if (st.isDirectory()) {
    let names;
    try { names = readdirSync(p); } catch { return; }
    for (const name of names) if (!SKIP_DIR.test(name)) walk(join(p, name), depth + 1);
    return;
  }

  const rel = relative(root, p).replaceAll("\\", "/");
  if (rel === SELF) return; // this file lists the marker words by design
  if (!TEXT.has(extname(p).toLowerCase())) return;
  if (st.size > 4_000_000) return;

  let buf;
  try { buf = readFileSync(p); } catch { return; }
  scanned++;
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { undecodable++; scriptHits.push(`${rel}: not valid UTF-8`); return; }

  const src = buf.toString("utf8");
  for (const [i, line] of src.split(/\r?\n/).entries()) {
    if (ALLOW.test(line)) continue;
    const m = SCRIPT.exec(line);
    if (m) {
      const chars = [...line].filter((c) => SCRIPT.test(c)).join("");
      scriptHits.push(`${rel}:${i + 1}  [${chars.slice(0, 12)}]  ${line.trim().slice(0, 90)}`);
      continue;
    }
    const w = WORDS.exec(line);
    // Ignore lines whose only match sits inside an external URL or quote.
    if (w && !/https?:\/\//.test(line)) {
      wordHits.push(`${rel}:${i + 1}  "${w[1]}"  ${line.trim().slice(0, 90)}`);
    }
  }
}

walk(join(root, "README.md"));
walk(join(root, "AGENTS.md"));
for (const d of ["docs", "scripts", "spikes", "src", "tools", "test", ".githooks", ".github"]) {
  const p = join(root, d);
  if (existsSync(p)) walk(p);
}

const problems = scriptHits.length + wordHits.length;
if (problems) {
  console.error(`check-language: ${problems} non-English line(s) — AGENTS.md § Language requires English\n`);
  if (scriptHits.length) {
    console.error("  Non-Latin script:");
    for (const h of scriptHits.slice(0, 30)) console.error(`    ${h}`);
  }
  if (wordHits.length) {
    console.error("\n  Indonesian wording:");
    for (const h of wordHits.slice(0, 30)) console.error(`    ${h}`);
  }
  console.error(`\n  ${scanned} text file(s) scanned, ${undecodable} not valid UTF-8.`);
  console.error("  Translate the line, or mark it `language-check: allow` if it is a deliberate exception.");
  process.exit(1);
}

console.log(`check-language: OK — ${scanned} text file(s), all English`);
