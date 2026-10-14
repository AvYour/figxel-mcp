// Spike 1 found setTimeout, setInterval and fetch in the sandbox of Figma
// desktop 126.9.11 — but official pages contradict each other about them
// (C-012), so a future version could drop them. Sandbox code therefore never
// calls them directly: the one sanctioned use is chunk.ts's feature-detected
// timer option (A), reached through `globalThis`, which falls back to option B
// when it is missing. @figma/plugin-typings declares all three as globals, so
// the compiler cannot enforce this — this test does.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const pluginDir = fileURLToPath(new URL("../src/plugin/", import.meta.url));

function sandboxSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sandboxSources(p));
    // ui.ts runs in the iframe, where browser timers certainly exist.
    else if (name.endsWith(".ts") && name !== "ui.ts") out.push(p);
  }
  return out;
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

it("sandbox code never calls setTimeout, setInterval or fetch directly", () => {
  const offenders: string[] = [];
  for (const file of sandboxSources(pluginDir)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const m of code.matchAll(/(^|[^.\w])(setTimeout|setInterval|fetch)\s*\(/g)) {
      offenders.push(`${file.slice(pluginDir.length)}: ${m[2]}(`);
    }
  }
  expect(offenders).toEqual([]);
});

it("the only timer access is chunk.ts's feature-detected option A", () => {
  const hits = sandboxSources(pluginDir).filter((f) => /\bsetTimeout\b/.test(stripComments(readFileSync(f, "utf8"))));
  expect(hits.map((f) => f.slice(pluginDir.length).replaceAll("\\", "/"))).toEqual(["chunk.ts"]);
  const chunk = stripComments(readFileSync(join(pluginDir, "chunk.ts"), "utf8"));
  expect(chunk).toMatch(/globalThis as \{ setTimeout\?/);
  expect(chunk).toMatch(/typeof st !== "function"/);
});

it("the plugin defaults to option A, the spike's choice, with B as the automatic fallback", () => {
  expect(readFileSync(join(pluginDir, "code.ts"), "utf8")).toMatch(/const YIELD_MODE: YieldMode = "timer";/);
  // chooseYield("timer") must degrade to the UI scheduler when setTimeout is absent.
  expect(readFileSync(join(pluginDir, "chunk.ts"), "utf8")).toMatch(/if \(mode === "timer"\) return timerYield\(\) \?\? ui\.yieldToHost;/);
});
