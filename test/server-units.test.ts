import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import { ConfigError, createLogger, loadConfig, migrateLegacyToken, readOrCreateToken } from "../src/server/config.js";
import { extractFileKey, extractNodeIdFromUrl, normalizeNodeId } from "../src/server/figma-url.js";
import { parseFrame } from "../src/server/frames.js";
import { ProgressForwarder } from "../src/server/mcp-progress.js";
import { errorResult, okResult } from "../src/server/results.js";

describe("config (spec §4.4)", () => {
  it("has the documented defaults", () => {
    const c = loadConfig({});
    expect(c.toolset).toEqual({ kind: "full" });
    expect(c.allowEval).toBe(false);
    expect(c.enableAudio).toBe(false);
    expect(c.autolaunch).toBe(false);
    expect(c.sessionWaitMs).toBe(5000);
    expect(c.port).toBe(38452);
    expect(c.logLevel).toBe("info");
    expect(c.home).toMatch(/\.figxel$/);
    expect(c.exportDir).toBe(join(c.home, "exports"));
    expect(c.tokenPath).toBe(join(c.home, "token"));
  });

  it("puts the home in the OS home folder unless BRIDGE_HOME names it, and knows the old home only then", () => {
    const user = mkdtempSync(join(tmpdir(), "fmcp-user-"));
    const c = loadConfig({}, user);
    expect(c.home).toBe(join(user, ".figxel"));
    expect(c.exportDir).toBe(join(user, ".figxel", "exports"));
    expect(c.legacyTokenPath).toBe(join(user, ".figma-mcp", "token"));
    const custom = join(user, "elsewhere");
    const d = loadConfig({ BRIDGE_HOME: custom }, user);
    expect(d.home).toBe(custom);
    expect(d.legacyTokenPath).toBeNull();
  });

  it("BRIDGE_ENABLE_AUDIO, the held-back audio tools' flag, is 0 or 1 like BRIDGE_ALLOW_EVAL", () => {
    expect(loadConfig({ BRIDGE_ENABLE_AUDIO: "1" }).enableAudio).toBe(true);
    expect(loadConfig({ BRIDGE_ENABLE_AUDIO: "0" }).enableAudio).toBe(false);
    expect(loadConfig({ BRIDGE_ENABLE_AUDIO: " " }).enableAudio).toBe(false);
  });

  it("refuses invalid values instead of guessing", () => {
    expect(() => loadConfig({ BRIDGE_TOOLSET: "all" })).toThrow(ConfigError);
    expect(() => loadConfig({ BRIDGE_ALLOW_EVAL: "yes" })).toThrow(/0 or 1/);
    expect(() => loadConfig({ BRIDGE_ENABLE_AUDIO: "true" })).toThrow(ConfigError);
    expect(() => loadConfig({ BRIDGE_ENABLE_AUDIO: "2" })).toThrow(/BRIDGE_ENABLE_AUDIO="2" must be 0 or 1/);
    expect(() => loadConfig({ BRIDGE_PORT: "70000" })).toThrow(/BRIDGE_PORT/);
    expect(() => loadConfig({ BRIDGE_SESSION_WAIT_MS: "-1" })).toThrow(/BRIDGE_SESSION_WAIT_MS/);
    expect(() => loadConfig({ BRIDGE_LOG_LEVEL: "loud" })).toThrow(/BRIDGE_LOG_LEVEL/);
  });

  it("splits BRIDGE_EXPORT_ROOTS on the platform delimiter", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    const c = loadConfig({ BRIDGE_EXPORT_ROOTS: `/a${sep}/b` });
    expect(c.exportRoots).toHaveLength(2);
  });
});

describe("token (spec §4.3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fmcp-token-"));
  });

  it("creates 32 random bytes as 64 hex characters, then reuses them", () => {
    const path = join(dir, "sub", "token");
    const a = readOrCreateToken(path);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(readOrCreateToken(path)).toBe(a);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a malformed token file rather than overwriting it", () => {
    const path = join(dir, "token");
    writeFileSync(path, "not-a-token");
    expect(() => readOrCreateToken(path)).toThrow(/64 hex/);
    expect(readFileSync(path, "utf8")).toBe("not-a-token");
  });
});

describe("the one-time move from ~/.figma-mcp (the home before the rename)", () => {
  const OLD = "a".repeat(64);
  let user: string;
  beforeEach(() => {
    user = mkdtempSync(join(tmpdir(), "fmcp-migrate-"));
  });
  const oldToken = (text = `${OLD}\n`) => {
    mkdirSync(join(user, ".figma-mcp"), { recursive: true });
    writeFileSync(join(user, ".figma-mcp", "token"), text);
  };

  it("copies a valid old token into the new home, once, and the server then reads it", () => {
    oldToken();
    const c = loadConfig({}, user);
    expect(migrateLegacyToken(c)).toBe(join(user, ".figma-mcp", "token"));
    expect(readOrCreateToken(c.tokenPath)).toBe(OLD);
    if (process.platform !== "win32") expect(statSync(c.tokenPath).mode & 0o777).toBe(0o600);
    // The new token now exists: nothing is copied again, even if the old one changes.
    oldToken(`${"b".repeat(64)}\n`);
    expect(migrateLegacyToken(c)).toBeNull();
    expect(readOrCreateToken(c.tokenPath)).toBe(OLD);
    // The old folder is left as it was.
    expect(existsSync(join(user, ".figma-mcp", "token"))).toBe(true);
  });

  it("copies nothing when BRIDGE_HOME names the home", () => {
    oldToken();
    const c = loadConfig({ BRIDGE_HOME: join(user, "custom") }, user);
    expect(migrateLegacyToken(c)).toBeNull();
    expect(existsSync(c.tokenPath)).toBe(false);
  });

  it("never overwrites a token the new home already has", () => {
    oldToken();
    const c = loadConfig({}, user);
    mkdirSync(c.home, { recursive: true });
    writeFileSync(c.tokenPath, `${"c".repeat(64)}\n`);
    expect(migrateLegacyToken(c)).toBeNull();
    expect(readOrCreateToken(c.tokenPath)).toBe("c".repeat(64));
  });

  it("ignores an old file that is not a token, so a fresh one is created", () => {
    oldToken("not-a-token");
    const c = loadConfig({}, user);
    expect(migrateLegacyToken(c)).toBeNull();
    expect(readOrCreateToken(c.tokenPath)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does nothing when there is no old home", () => {
    expect(migrateLegacyToken(loadConfig({}, user))).toBeNull();
  });
});

it("the logger writes only through its sink (stderr in production)", () => {
  const lines: string[] = [];
  const log = createLogger("warn", (l) => lines.push(l));
  log.info("hidden");
  log.warn("shown");
  expect(lines).toEqual(["[figxel] warn: shown\n"]);
});

describe("figma-url (ported from server.py)", () => {
  it("normalizes node ids", () => {
    expect(normalizeNodeId("1-2")).toBe("1:2");
    expect(normalizeNodeId(" 12:34 ")).toBe("12:34");
  });
  it("extracts file keys and node ids from URLs", () => {
    const url = "https://www.figma.com/design/AbC123xyz/Landing?node-id=12-34&t=x";
    expect(extractFileKey(url)).toBe("AbC123xyz");
    expect(extractFileKey("AbC123xyz")).toBe("AbC123xyz");
    expect(extractNodeIdFromUrl(url)).toBe("12:34");
    expect(extractNodeIdFromUrl("https://figma.com/file/K/x?node-id=1%3A2")).toBe("1:2");
    expect(extractNodeIdFromUrl("https://figma.com/file/K/x")).toBeNull();
  });
});

describe("frame validation (protocol.md §2)", () => {
  it("accepts the documented frames and ignores unknown fields", () => {
    const r = parseFrame(JSON.stringify({ t: "progress", id: "r-1", done: 3, total: 9, extra: true }));
    expect(r).toEqual({ ok: true, msg: { t: "progress", id: "r-1", done: 3, total: 9 } });
    expect(parseFrame(JSON.stringify({ t: "result", id: "r-1", ok: false, error: { code: "X", message: "m" } })).ok).toBe(true);
    expect(parseFrame(JSON.stringify({ t: "event", name: "nodes_changed", data: { count: 1, nodeIds: ["1:2"], at: 1 } })).ok).toBe(true);
  });
  it("rejects malformed frames without throwing", () => {
    expect(parseFrame("{").ok).toBe(false);
    expect(parseFrame(JSON.stringify({ t: "progress", id: "r-1" })).ok).toBe(false);
    expect(parseFrame(JSON.stringify({ t: "event", name: "unknown", data: {} })).ok).toBe(false);
  });
});

describe("results (protocol.md §9)", () => {
  it("formats errors as CODE: message + hint with structured content", () => {
    const r = errorResult(new BridgeError("STALLED", "Stopped.", { hint: "Retry.", idempotencyKey: "k" }));
    expect(r.isError).toBe(true);
    expect(r.content[0]).toEqual({ type: "text", text: "STALLED: Stopped.\nRetry." });
    // A stall says nothing about what reached the canvas, so a retry is not called safe [C-096].
    expect(r.structuredContent).toEqual({ code: "STALLED", message: "Stopped.", hint: "Retry.", idempotencyKey: "k", safeToRetry: false });
  });
  it("wraps unexpected errors as INTERNAL", () => {
    expect(errorResult(new Error("boom")).structuredContent).toMatchObject({ code: "INTERNAL", message: "boom" });
  });
  it("returns JSON text plus structured content for objects", () => {
    const r = okResult({ a: 1 });
    expect(r.structuredContent).toEqual({ a: 1 });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ a: 1 });
  });
});

describe("ProgressForwarder (protocol.md §9 progress rules)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function sink(token: string | undefined) {
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    return { sent, notifier: { progressToken: token, send: async (n: (typeof sent)[number]) => void sent.push(n) } };
  }

  it("coalesces to at most 10/s and always sends the final value before the result", async () => {
    const { sent, notifier } = sink("tok");
    const f = new ProgressForwarder(notifier, { label: "figma_create_from_spec" });
    for (let i = 1; i <= 100; i++) {
      f.update({ done: i, total: 100 });
      await vi.advanceTimersByTimeAsync(12);
    }
    await f.finish();
    // 1.2 s of updates at 12 ms → ≤ 13 notifications, and the last one is 100
    expect(sent.length).toBeLessThanOrEqual(14);
    expect(sent.at(-1)!.params).toMatchObject({ progressToken: "tok", progress: 100, total: 100 });
    expect(sent.every((n) => n.method === "notifications/progress")).toBe(true);
  });

  it("keeps progress strictly increasing when the plugin starts a new phase", async () => {
    const { sent, notifier } = sink("tok");
    const f = new ProgressForwarder(notifier, { label: "x" });
    f.update({ done: 50, total: 50, phase: "fonts" });
    await vi.advanceTimersByTimeAsync(150);
    f.update({ done: 3, total: 800, phase: "nodes" });
    await vi.advanceTimersByTimeAsync(150);
    await f.finish();
    const values = sent.map((n) => n.params.progress as number);
    expect(values).toEqual([50, 51]);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
  });

  it("sends nothing after finish", async () => {
    const { sent, notifier } = sink("tok");
    const f = new ProgressForwarder(notifier, { label: "x" });
    f.update({ done: 1 });
    await f.finish();
    const n = sent.length;
    f.update({ done: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.length).toBe(n);
  });

  it("falls back to an info log at most once per 5 s without a progressToken", async () => {
    const { sent, notifier } = sink(undefined);
    const f = new ProgressForwarder(notifier, { label: "figma_create_from_spec" });
    for (let i = 1; i <= 100; i++) {
      f.update({ done: i, total: 100 });
      await vi.advanceTimersByTimeAsync(100);
    }
    await f.finish();
    expect(sent.every((n) => n.method === "notifications/message")).toBe(true);
    expect(sent.length).toBeLessThanOrEqual(3); // 10 s of updates
    expect(sent[0]!.params).toMatchObject({ level: "info", logger: "figxel" });
  });
});
