import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { notBatchable } from "../src/plugin/ops/batch.js";
import { CORE_OPS, GROUPS, OPS, parseToolset, selectOps, toolName } from "../src/shared/ops.js";
import { DEV_VERSION, VERSION } from "../src/shared/version.js";

// tools.md is the source of truth for the tool list (AGENTS.md § Document
// roles). These tests make the code fail loudly if it drifts from the catalog.
const catalog = readFileSync(new URL("../docs/reference/tools.md", import.meta.url), "utf8");

function catalogByGroup(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let group: string | null = null;
  let fenced = false;
  for (const line of catalog.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const h = /^##\s+(\w+)\s+\((\d+)\)\s*$/.exec(line);
    if (h) {
      group = (GROUPS as readonly string[]).includes(h[1]!) ? h[1]! : null;
      if (group) out.set(group, []);
      continue;
    }
    if (/^##\s/.test(line)) group = null;
    const row = group ? /^\|\s*`(figma_[a-z_]+)`\s*\|/.exec(line) : null;
    if (row) out.get(group!)!.push(row[1]!);
  }
  return out;
}

describe("op table vs docs/reference/tools.md", () => {
  it("has exactly the catalog's tools, group by group", () => {
    const fromDoc = catalogByGroup();
    for (const g of GROUPS) {
      const inCode = [...OPS].filter(([, i]) => i.group === g).map(([op]) => toolName(op));
      expect(inCode, `group ${g}`).toEqual(fromDoc.get(g));
    }
  });

  it("matches the declared totals (the Count line in tools.md)", () => {
    const m = /Count:\s*(\d+) tools in the catalog → (\d+) registered by default/.exec(catalog);
    expect(m).not.toBeNull();
    expect(OPS.size).toBe(Number(m![1]));
    expect(selectOps({ kind: "full" }, false).length).toBe(Number(m![2]));
    // The catalog total is every tool with both opt-in keys turned.
    expect(selectOps({ kind: "full" }, true, true).length).toBe(Number(m![1]));
  });

  it("matches the core tier list", () => {
    const m = /The `core` tier \((\d+)\) = (.+)$/m.exec(catalog);
    expect(m).not.toBeNull();
    const names = [...m![2]!.matchAll(/`(figma_[a-z_]+)`/g)].map((x) => x[1]);
    expect(CORE_OPS.map(toolName)).toEqual(names);
    expect(CORE_OPS.length).toBe(Number(m![1]));
  });

  it("marks the destructive tools named in the conventions", () => {
    const line = catalog.split(/\r?\n/).find((l) => l.includes("destructiveHint: true"))!;
    const named = [...line.matchAll(/`(figma_[a-z_]+)`/g)].map((x) => x[1]);
    const inCode = [...OPS].filter(([, i]) => i.destructive).map(([op]) => toolName(op));
    expect(inCode.sort()).toEqual(named.sort());
  });

  it("flags removing a mode and resetting a slot as destructive: both lose work, so neither runs in a batch", () => {
    for (const op of ["update_variable_collection", "reset_slot"]) {
      expect(OPS.get(op)!.destructive, op).toBe(true);
      expect(notBatchable(op), op).toMatch(/is destructive and runs on its own call/);
    }
  });

  it("keeps undo_step in modify so BRIDGE_TOOLSET=read truly reads only", () => {
    expect(OPS.get("undo_step")!.group).toBe("modify");
    const readOnly = selectOps({ kind: "groups", groups: ["read"] }, false);
    expect(readOnly.every((op) => op === "status" || OPS.get(op)!.readOnly)).toBe(true);
  });
});

describe("toolset parsing (tools.md § Trimming the toolset)", () => {
  it("accepts full/core/none/group lists", () => {
    expect(parseToolset(undefined)).toEqual({ kind: "full" });
    expect(parseToolset("full")).toEqual({ kind: "full" });
    expect(parseToolset("core")).toEqual({ kind: "core" });
    expect(parseToolset("none")).toEqual({ kind: "none" });
    expect(parseToolset("read, export")).toEqual({ kind: "groups", groups: ["read", "export"] });
    expect(parseToolset("export,audio")).toEqual({ kind: "groups", groups: ["export", "audio"] });
  });

  it("refuses an unrecognised value instead of falling back to full", () => {
    expect(() => parseToolset("everything")).toThrow(/not recognised/);
    expect(() => parseToolset("read,bogus")).toThrow(/bogus/);
  });

  it("always keeps figma_status", () => {
    expect(selectOps({ kind: "none" }, false)).toEqual(["status"]);
    expect(selectOps({ kind: "groups", groups: ["export"] }, false)).toContain("status");
  });

  it("needs two keys for eval", () => {
    expect(selectOps({ kind: "full" }, false)).not.toContain("eval");
    expect(selectOps({ kind: "full" }, true)).toContain("eval");
    expect(selectOps({ kind: "core" }, true)).not.toContain("eval");
    expect(selectOps({ kind: "groups", groups: ["eval"] }, false)).not.toContain("eval");
    expect(selectOps({ kind: "groups", groups: ["eval"] }, true)).toContain("eval");
  });

  // Held back from the release on 2026-10-14: kept, tested, and registered
  // only with BRIDGE_ENABLE_AUDIO=1 and a toolset that includes the group.
  it("needs two keys for the held-back audio group", () => {
    const AUDIO = ["analyze_audio", "add_audio", "generate_audio"];
    const audioIn = (ops: string[]) => AUDIO.filter((op) => ops.includes(op));
    for (const op of AUDIO) expect(OPS.get(op), op).toMatchObject({ group: "audio", readOnly: true, write: false, bridgeOnly: true });
    expect(audioIn(selectOps({ kind: "full" }, false))).toEqual([]);
    expect(audioIn(selectOps({ kind: "full" }, true))).toEqual([]);
    expect(audioIn(selectOps({ kind: "full" }, false, true))).toEqual(AUDIO);
    expect(audioIn(selectOps({ kind: "core" }, true, true))).toEqual([]);
    expect(audioIn(selectOps({ kind: "groups", groups: ["export"] }, false, true))).toEqual([]);
    expect(audioIn(selectOps({ kind: "groups", groups: ["audio"] }, false))).toEqual([]);
    expect(audioIn(selectOps({ kind: "groups", groups: ["audio"] }, false, true))).toEqual(AUDIO);
    // The flag adds the audio group and nothing else.
    expect(selectOps({ kind: "full" }, false, true).length - selectOps({ kind: "full" }, false).length).toBe(AUDIO.length);
  });
});

// package.json is the only place the version is written: the build injects it
// into every bundle (test/package.test.ts checks the built ones). Unbundled
// there is nothing to inject, and the source says so instead of guessing.
it("VERSION is the dev marker when the source runs unbundled", () => {
  expect(VERSION).toBe(DEV_VERSION);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(DEV_VERSION).not.toBe(pkg.version);
});
