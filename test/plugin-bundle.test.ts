// Runs the BUILT plugin — dist/plugin/code.js and the script inlined in
// dist/plugin/ui.html — against a real bridge. The sandbox realm gets no
// setTimeout at all (the worst case of contradiction C-012), so this proves
// the plugin does not depend on it. Only Figma's own APIs are faked.

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { OPS } from "../src/shared/ops.js";
import { CLOSE } from "../src/shared/protocol.js";
import { tokenFingerprint } from "../src/shared/token.js";
import { VERSION as BRIDGE_VERSION } from "../src/shared/version.js";
import type { Bridge } from "../src/server/bridge.js";
import { newToken, sleep, startBridge } from "./helpers.js";

// The build injects package.json's version into the bundles (src/shared/version.ts).
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const CODE = readFileSync(new URL("../dist/plugin/code.js", import.meta.url), "utf8");
const UI_HTML = readFileSync(new URL("../dist/plugin/ui.html", import.meta.url), "utf8");
const UI_SCRIPT = /<script>\n([\s\S]*)<\/script>/.exec(UI_HTML)![1]!;

interface FakeEl {
  className: string;
  textContent: string;
  hidden: boolean;
  value: string;
  children: unknown[];
  onclick: (() => void) | null;
  onsubmit: ((ev: { preventDefault(): void }) => void) | null;
  focus(): void;
  prepend(c: unknown): void;
  readonly lastElementChild: { remove(): void } | null;
}

function fakeEl(): FakeEl {
  const el: FakeEl = {
    className: "",
    textContent: "",
    hidden: true,
    value: "",
    children: [],
    onclick: null,
    onsubmit: null,
    focus() {},
    prepend(c) {
      el.children.unshift(c);
    },
    get lastElementChild() {
      return el.children.length ? { remove: () => void el.children.pop() } : null;
    },
  };
  return el;
}

function loadPlugin(opts: { port: number; storedToken: string | null; fileName?: string }) {
  let disposed = false;
  const timers = new Set<NodeJS.Timeout>();
  const sockets = new Set<WebSocket>();
  const storage = new Map<string, unknown>(opts.storedToken ? [["figma-mcp.token", opts.storedToken]] : []);
  const handlers = new Map<string, ((e?: unknown) => void)[]>();
  const pageHandlers = new Map<string, ((e?: unknown) => void)[]>();
  let sandboxOnMessage: ((m: unknown) => void) | null = null;
  let uiOnMessage: ((ev: { data: unknown }) => void) | null = null;
  const deliver = (fn: () => void) => setImmediate(() => !disposed && fn());

  const page = {
    id: "0:1",
    name: "Page 1",
    selection: [] as { id: string }[],
    on: (ev: string, fn: () => void) => pageHandlers.set(ev, [...(pageHandlers.get(ev) ?? []), fn]),
    off: () => {},
  };
  const figma = {
    apiVersion: "1.0.0",
    editorType: "figma",
    fileKey: undefined,
    root: { name: opts.fileName ?? "Bundle Test" },
    currentPage: page,
    currentUser: { id: "42", name: "Tester" },
    showUI: () => {},
    commitUndo: () => {},
    on: (ev: string, fn: () => void) => handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
    clientStorage: {
      getAsync: async (k: string) => storage.get(k),
      setAsync: async (k: string, v: unknown) => void storage.set(k, v),
    },
    ui: {
      postMessage: (msg: unknown) => deliver(() => uiOnMessage?.({ data: { pluginMessage: msg } })),
      set onmessage(fn: (m: unknown) => void) {
        sandboxOnMessage = fn;
      },
    },
  };

  // The sandbox realm: plain JavaScript plus `figma` — deliberately no timers.
  const sandbox = createContext({ figma, __html__: "<html></html>" });
  runInContext(CODE, sandbox);
  expect(runInContext("typeof setTimeout", sandbox)).toBe("undefined");

  // The iframe realm: DOM stubs, window timers, and a real WebSocket pointed at the test bridge.
  const els = new Map<string, FakeEl>();
  const document = {
    getElementById: (id: string) => els.get(id) ?? (els.set(id, fakeEl()), els.get(id)!),
    createElement: () => ({ textContent: "" }),
  };
  class TestWebSocket extends WebSocket {
    constructor(url: string) {
      super(disposed ? "ws://127.0.0.1:1" : url.replace(":38452", `:${opts.port}`));
      sockets.add(this);
    }
  }
  const win: Record<string, unknown> = {
    document,
    WebSocket: TestWebSocket,
    parent: { postMessage: (m: { pluginMessage: unknown }) => deliver(() => sandboxOnMessage?.(m.pluginMessage)) },
    setTimeout: (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        if (!disposed) fn();
      }, ms);
      timers.add(t);
      return t;
    },
    clearTimeout: (t: NodeJS.Timeout) => {
      clearTimeout(t);
      timers.delete(t);
    },
  };
  win.window = win;
  const ui = createContext(win);
  Object.defineProperty(win, "onmessage", { set: (fn) => (uiOnMessage = fn), get: () => uiOnMessage });
  runInContext(UI_SCRIPT, ui);

  return {
    figma,
    storage,
    el: (id: string) => document.getElementById(id),
    fire: (ev: string) => handlers.get(ev)?.forEach((f) => f()),
    firePage: (ev: string, arg: unknown) => pageHandlers.get(ev)?.forEach((f) => f(arg)),
    dispose() {
      disposed = true;
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.close();
    },
  };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(20);
  }
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function bridgeAndPlugin(storedToken: "right" | "wrong" | "none") {
  const token = newToken();
  const bridge = await startBridge({ token });
  cleanup.push(() => bridge.close());
  const plugin = loadPlugin({
    port: bridge.port,
    storedToken: storedToken === "right" ? token : storedToken === "wrong" ? newToken() : null,
  });
  cleanup.push(() => plugin.dispose());
  return { token, bridge, plugin };
}

const sessions = (b: Bridge) => b.status().sessions;

describe("built plugin bundles against a real bridge", () => {
  it("connects with a stored token and reports file, page, user, version", async () => {
    const { bridge, plugin } = await bridgeAndPlugin("right");
    await until(() => sessions(bridge).length === 1);
    const s = sessions(bridge)[0]!;
    expect(s.file).toEqual({ name: "Bundle Test", key: null });
    expect(s.page).toEqual({ id: "0:1", name: "Page 1" });
    expect(s.user).toEqual({ id: "42", name: "Tester" });
    expect(s.pluginVersion).toBe(PACKAGE_VERSION);
    expect(s.editorType).toBe("figma");
    // Phase 1: the read group is advertised, so a bridge that does not know
    // these ops can be detected instead of failing one call at a time.
    expect(s.ops).toContain("get_design_context");
    expect(s.ops).toContain("search_nodes");
    expect(s.ops.length).toBeGreaterThan(0);
    // Every advertised op must exist in the catalog: an op the plugin claims but
    // tools.md does not list would be forwardable but unregistered, and vice
    // versa is a silent UNSUPPORTED at call time.
    const unknown = s.ops.filter((op) => !OPS.has(op));
    expect(unknown).toEqual([]);
    await until(() => plugin.el("status").textContent === "Connected");
    // The bridge here runs from source, so it reports the unbundled version. The token's
    // fingerprint is the one setup and figma_status print, so a person can compare them.
    expect(plugin.el("detail").textContent).toMatch(new RegExp(`^Session s-\\d+ · bridge ${BRIDGE_VERSION.replaceAll(".", "\\.")} · token [0-9a-f]{4}\\.\\.\\.[0-9a-f]{4}$`));
    const stored = plugin.storage.get("figma-mcp.token") as string;
    expect(plugin.el("detail").textContent!.endsWith(` · token ${tokenFingerprint(stored)}`)).toBe(true);
    expect(tokenFingerprint(stored)).toBe(bridge.status().tokenFingerprint);
    expect(plugin.el("detail").textContent).not.toContain(stored); // never the token itself
  });

  it("forwards a selection change through the iframe-hosted debounce (no sandbox timers)", async () => {
    const { bridge, plugin } = await bridgeAndPlugin("right");
    await until(() => sessions(bridge).length === 1);
    plugin.figma.currentPage.selection = [{ id: "1:2" }, { id: "1:3" }];
    plugin.fire("selectionchange");
    plugin.fire("selectionchange"); // debounced into one event
    await until(() => sessions(bridge)[0]!.selection?.count === 2);
    expect(sessions(bridge)[0]!.selection!.nodeIds).toEqual(["1:2", "1:3"]);
  });

  it("asks for a token when none is stored, then connects after it is pasted", async () => {
    const { token, bridge, plugin } = await bridgeAndPlugin("none");
    await until(() => plugin.el("token-form").hidden === false);
    expect(plugin.el("status").textContent).toBe("Token needed");
    expect(sessions(bridge)).toHaveLength(0);
    plugin.el("token-input").value = token;
    plugin.el("token-form").onsubmit!({ preventDefault() {} });
    await until(() => sessions(bridge).length === 1);
    await until(() => plugin.storage.get("figma-mcp.token") === token); // saved to clientStorage
  });

  it("stops and shows the token form when the bridge rejects the token (4001), naming the refused token's fingerprint", async () => {
    const { bridge, plugin } = await bridgeAndPlugin("wrong");
    await until(() => plugin.el("token-form").hidden === false);
    expect(plugin.el("detail").textContent).toMatch(/rejected the token/);
    const refused = tokenFingerprint(plugin.storage.get("figma-mcp.token") as string);
    expect(plugin.el("detail").textContent).toContain(`(token ${refused})`);
    expect(plugin.el("detail").textContent).toMatch(/setup prints it with its fingerprint/);
    expect(refused).not.toBe(bridge.status().tokenFingerprint);
    expect(bridge.status().lastAuthFailureAt).not.toBeNull();
    const failedAt = bridge.status().lastAuthFailureAt;
    await sleep(1500); // longer than the first backoff steps — no retry loop on 4001
    expect(bridge.status().lastAuthFailureAt).toBe(failedAt);
  });

  it("survives the bridge stopping and reconnects to the next one within the 3 s backoff cap", async () => {
    const { token, bridge, plugin } = await bridgeAndPlugin("right");
    await until(() => sessions(bridge).length === 1);
    const port = bridge.port;
    await bridge.close(); // the plugin sees 4010
    await until(() => plugin.el("status").textContent === "Waiting for bridge…");
    const next = await startBridge({ token, port });
    cleanup.push(() => next.close());
    const restartedAt = Date.now();
    await until(() => sessions(next).length === 1, 6000);
    expect(Date.now() - restartedAt).toBeLessThan(3500);
  });

  it("shows 'Replaced' and stops when another window with the same instanceId takes over (4004)", async () => {
    const { token, bridge, plugin } = await bridgeAndPlugin("right");
    await until(() => sessions(bridge).length === 1);
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    const instanceId = sessions(bridge)[0]!.instanceId;
    await new Promise((r) => ws.addEventListener("open", r));
    ws.send(JSON.stringify({
      t: "hello", protocolVersion: 1, token, instanceId, pluginVersion: "x", apiVersion: "1.0.0", editorType: "figma",
      ops: [], file: { name: "Twin", key: null }, page: null, user: null,
    }));
    await until(() => plugin.el("status").textContent === "Replaced");
    expect(CLOSE.SESSION_REPLACED).toBe(4004);
    ws.close();
  });

  // Regression, seen live on 2026-10-07: the window showed "Replaced — another
  // window of this plugin took over" while the bridge had a healthy session for
  // that very window. Saving a token while connected closes the old socket and
  // opens a new one; the OLD socket's close handler then ran in full — it
  // scheduled a reconnect, the reconnect replaced the live socket (4004), and
  // that socket's handler stopped the loop and painted "Replaced".
  it("re-saving the token while connected keeps one healthy connection — a superseded socket is ignored", async () => {
    const { token, bridge, plugin } = await bridgeAndPlugin("right");
    await until(() => plugin.el("status").textContent === "Connected");
    const first = sessions(bridge)[0]!.sessionId;

    plugin.el("token-input").value = token;
    plugin.el("token-form").onsubmit!({ preventDefault() {} });
    await until(() => sessions(bridge).length === 1 && sessions(bridge)[0]!.sessionId !== first);
    const second = sessions(bridge)[0]!.sessionId;

    await sleep(2500); // past several backoff steps: any stray reconnect would have fired by now
    expect(plugin.el("status").textContent).toBe("Connected");
    expect(sessions(bridge)).toHaveLength(1);
    expect(sessions(bridge)[0]!.sessionId).toBe(second);
  });
});
