// A team's hub ready to open to everyone (docs/hub.md § Opening a hub to
// everyone): limits per person, each refused with when to try again; a cap on
// the number of people; the privacy page the sign-in page links to; and what
// the hub keeps surviving a restart.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeError } from "../src/shared/errors.js";
import { ConfigError, createLogger, loadConfig } from "../src/server/config.js";
import { addPerson, peoplePath, personForLogin, readPeople, runHub } from "../src/server/hub.js";
import { Budget, ensureRoom, overLimit } from "../src/server/limits.js";
import { admitsNew, type Identity } from "../src/server/login.js";
import { createAgentState, createApp } from "../src/server/mcp.js";
import { renderMarkdown } from "../src/server/privacy.js";
import { connectedMock, newToken, sleep, startBridge, startMock } from "./helpers.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const REDIRECT = "https://client.example/callback";
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

async function rejection(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    return e as BridgeError;
  }
  throw new Error("expected a rejection");
}

/** A hub with the web endpoint and Alice and Bob, each with a Figma file; `env` sets the limits. */
async function webHub(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "fmcp-limits-"));
  const alice = addPerson(peoplePath(home), "alice");
  const bob = addPerson(peoplePath(home), "bob");
  const config = loadConfig({ BRIDGE_HOME: home, BRIDGE_PORT: "0", BRIDGE_HUB_WEB: "1", BRIDGE_HUB_PUBLIC_URL: "ws://localhost:1", BRIDGE_SESSION_WAIT_MS: "2000", ...env });
  const { bridge, web: endpoint, stop } = await runHub(config, createLogger("error"), { createApp, createAgentState });
  cleanup.push(stop);
  const base = `http://127.0.0.1:${bridge.port}`;
  for (const [token, fileName] of [[alice, "Alice's file"], [bob, "Bob's file"]] as const) {
    const figma = startMock({ port: bridge.port, token, fileName });
    cleanup.push(() => figma.close());
    await figma.welcomed();
  }
  return { home, alice, bob, base, endpoint: endpoint! };
}

async function client(base: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const c = new Client({ name: "limits-test", version: "0" });
  await c.connect(transport);
  cleanup.push(() => c.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as ToolResult;
  return { call, transport };
}

describe("the settings for opening a hub", () => {
  it("are on by default with their documented values, and refuse a value out of range", () => {
    const c = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-limits-")) });
    expect(c).toMatchObject({ hubWebCallsPerMin: 120, hubRequestsPerMin: 600, hubWebSessions: 8, hubWebFolderMb: 500, hubWebUploadMb: 25, hubMaxPeople: 0, hubPrivacyFile: null, folderQuota: null });
    expect(loadConfig({ BRIDGE_HUB_WEB_CALLS_PER_MIN: "0", BRIDGE_HUB_REQUESTS_PER_MIN: "0", BRIDGE_HUB_WEB_FOLDER_MB: "0" })).toMatchObject({ hubWebCallsPerMin: 0, hubRequestsPerMin: 0, hubWebFolderMb: 0 });
    expect(() => loadConfig({ BRIDGE_HUB_WEB_SESSIONS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ BRIDGE_HUB_WEB_UPLOAD_MB: "1000" })).toThrow(/BRIDGE_HUB_WEB_UPLOAD_MB="1000" must be an integer between 1 and 256/);
    expect(() => loadConfig({ BRIDGE_HUB_MAX_PEOPLE: "-1" })).toThrow(ConfigError);
  });

  it("logs the limits and who may sign up when the hub starts", async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-limits-"));
    addPerson(peoplePath(home), "alice");
    const lines: string[] = [];
    const config = loadConfig({
      BRIDGE_HOME: home,
      BRIDGE_PORT: "0",
      BRIDGE_HUB_WEB: "1",
      BRIDGE_HUB_PUBLIC_URL: "ws://localhost:1",
      BRIDGE_HUB_GOOGLE_CLIENT_ID: "g",
      BRIDGE_HUB_GOOGLE_CLIENT_SECRET: "s",
      BRIDGE_HUB_SIGNUP: "open",
      BRIDGE_HUB_MAX_PEOPLE: "50",
    });
    const { stop } = await runHub(config, createLogger("info", (l) => lines.push(l)), { createApp, createAgentState });
    cleanup.push(stop);
    expect(lines.join("")).toContain("new people: any Google account, up to 50 people in all");
    expect(lines.join("")).toContain("hub: limits per person: calls to Figma through the hub 600 a minute; on the web endpoint, tool calls and new sessions 120 a minute, 8 open sessions, a folder of 500 MB, uploads up to 25 MB");
  });
});

describe("a person's minute (limits.ts)", () => {
  it("counts per key in a window that starts at the first use, refused uses too, and says how long until it ends", () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const minute = new Budget(2, 60_000);
      expect([minute.take("alice"), minute.take("alice"), minute.take("alice")]).toEqual([true, true, false]);
      expect(minute.take("bob")).toBe(true);
      now += 45_000;
      expect(minute.waitMs("alice")).toBe(15_000);
      expect(minute.take("alice")).toBe(false);
      now += 15_001;
      expect(minute.take("alice")).toBe(true); // a new minute
      expect(new Budget(0, 60_000).take("anyone", 1_000_000)).toBe(true); // 0 is no limit
    } finally {
      clock.mockRestore();
    }
    const busy = overLimit("calls", 5, 1500, "BRIDGE_X");
    expect([busy.code, busy.message, busy.hint]).toEqual(["BUSY", "Too many calls: at most 5 a minute per person.", "Nothing ran. Try again in 2 s. Whoever runs the hub sets the limit (BRIDGE_X)."]);
    expect(busy.partial).toEqual({ created: [], retryAfterS: 2 });
  });

  it("makes room in a full folder from its expired files first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fmcp-limits-"));
    mkdirSync(join(dir, "uploads"));
    writeFileSync(join(dir, "uploads", "old.bin"), Buffer.alloc(1024 * 1024, 1));
    const quota = { bytes: 1024 * 1024, ttlMs: 60_000 };
    const full = await rejection(ensureRoom(dir, quota));
    expect(full.code).toBe("BUSY");
    expect(existsSync(join(dir, "uploads", "old.bin"))).toBe(true);
    await ensureRoom(dir, quota, Date.now() + 60_001); // a minute later the file has expired
    expect(existsSync(join(dir, "uploads", "old.bin"))).toBe(false);
  });
});

describe("tool calls a minute on the web endpoint", () => {
  it("answers past the limit with BUSY and when to try again, per person; a new session counts too", async () => {
    const { alice, bob, base } = await webHub({ BRIDGE_HUB_WEB_CALLS_PER_MIN: "3" });
    const web = await client(base, alice); // the new session is one
    expect((await web.call("figma_status")).isError).toBeFalsy();
    expect((await web.call("figma_status")).isError).toBeFalsy();
    const refused = await web.call("figma_status");
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/^BUSY: Too many tool calls and new sessions on this hub's web endpoint: at most 3 a minute per person\.\nNothing ran\. Try again in \d+ s\./);
    expect(refused.structuredContent).toMatchObject({ code: "BUSY", safeToRetry: true, partial: { created: [] } });
    expect((refused.structuredContent!.partial as { retryAfterS: number }).retryAfterS).toBeGreaterThan(0);

    // A new session counts too, and is refused with 429 and Retry-After.
    const init = await fetch(`${base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${alice}` }, body: JSON.stringify(INIT) });
    expect(init.status).toBe(429);
    expect(Number(init.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await init.json()) as { error: { message: string } }).error.message).toMatch(/Too many tool calls/);

    // Bob has a minute of his own.
    expect((await (await client(base, bob)).call("figma_status")).isError).toBeFalsy();
  });
});

describe("calls to Figma through the hub", () => {
  it("are limited per person, from all their processes together, with BUSY and when to try again", async () => {
    const alice = newToken();
    const bob = newToken();
    const hub = await startBridge({ token: newToken(), people: [{ person: "alice", token: alice }, { person: "bob", token: bob }], requestLimit: { max: 2, windowMs: 60_000 } });
    cleanup.push(() => hub.close());
    for (const [token, fileName] of [[alice, "Alice's file"], [bob, "Bob's file"]] as const) {
      const figma = await connectedMock(hub, token, { fileName });
      cleanup.push(() => figma.close());
    }
    const laptop = await startBridge({ token: alice, port: hub.port });
    cleanup.push(() => laptop.close());
    const other = await startBridge({ token: alice, port: hub.port }); // a second app of hers: the same minute
    cleanup.push(() => other.close());
    const asBob = await startBridge({ token: bob, port: hub.port });
    cleanup.push(() => asBob.close());

    await laptop.request("get_metadata", {});
    await other.request("get_metadata", {});
    const err = await rejection(laptop.request("get_metadata", {}));
    expect(err.code).toBe("BUSY");
    expect(err.message).toBe("Too many calls to Figma through this hub: at most 2 a minute per person.");
    expect(err.hint).toMatch(/^Nothing ran\. Try again in \d+ s\. Whoever runs the hub sets the limit \(BRIDGE_HUB_REQUESTS_PER_MIN\)\.$/);
    expect(err.partial).toMatchObject({ created: [] });
    expect(((await asBob.request("get_metadata", {})) as { name: string }).name).toBe("Bob's file");
  });

  it("does not apply on one computer, where the processes sharing the port are the person's own apps", async () => {
    const token = newToken();
    const local = await startBridge({ token, requestLimit: { max: 1, windowMs: 60_000 } });
    cleanup.push(() => local.close());
    const figma = await connectedMock(local, token);
    cleanup.push(() => figma.close());
    const proxy = await startBridge({ token, port: local.port });
    cleanup.push(() => proxy.close());
    for (let i = 0; i < 3; i++) await proxy.request("get_metadata", {});
  });
});

describe("open web sessions per person", () => {
  it("closes the least recently used past the limit, and its client hears why", async () => {
    const { alice, bob, base, endpoint } = await webHub({ BRIDGE_HUB_WEB_SESSIONS: "2" });
    const first = await client(base, alice);
    await client(base, alice);
    await client(base, alice);
    const end = Date.now() + 5000;
    while (endpoint.sessions > 2 && Date.now() < end) await sleep(25);
    expect(endpoint.sessions).toBe(2);
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    const ask = (token: string) => fetch(`${base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${token}`, "mcp-session-id": first.transport.sessionId! }, body: JSON.stringify(list) });
    const gone = await ask(alice);
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { error: { message: string } }).error.message).toBe(
      "Session not found: it was closed because alice had more than 2 sessions open on this hub, and it was the least recently used. Start a new session.",
    );
    // Another person asking with that id learns nothing about it.
    const asBob = await ask(bob);
    expect(((await asBob.json()) as { error: { message: string } }).error.message).toBe("Session not found");
  });
});

describe("uploads and a person's folder", () => {
  it("refuses an upload past its size before reading it, and writes nothing", async () => {
    const { alice, base, home } = await webHub({ BRIDGE_HUB_WEB_UPLOAD_MB: "1" });
    const up = await fetch(`${base}/files?name=big.png`, { method: "POST", headers: { authorization: `Bearer ${alice}` }, body: Buffer.alloc(2 * 1024 * 1024, 1) });
    expect(up.status).toBe(413);
    const body = (await up.json()) as { error: string; hint: string };
    expect(body.error).toBe("Too large: an upload to this hub is at most 1 MB.");
    expect(body.hint).toMatch(/give the import a URL/);
    expect(existsSync(join(home, "web", "alice", "uploads"))).toBe(false);
    // A body that does not say its size is cut off where it passes the limit, with the same answer.
    const chunked = await fetch(`${base}/files?name=big.png`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice}` },
      body: new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(1536 * 1024)), c.close()) }),
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(413);
    expect(((await chunked.json()) as { error: string }).error).toBe("Too large: an upload to this hub is at most 1 MB.");
    expect(existsSync(join(home, "web", "alice", "uploads"))).toBe(false);
  });

  it("takes no new upload once the folder holds its size, and says when room comes back", async () => {
    const { alice, bob, base } = await webHub({ BRIDGE_HUB_WEB_FOLDER_MB: "1" });
    const upload = (token: string) => fetch(`${base}/files?name=part.bin`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: Buffer.alloc(600 * 1024, 1) });
    expect((await upload(alice)).status).toBe(201);
    expect((await upload(alice)).status).toBe(201); // the file that crosses the size is kept
    const full = await upload(alice);
    expect(full.status).toBe(507);
    expect(Number(full.headers.get("retry-after"))).toBeGreaterThan(3500);
    const body = (await full.json()) as { error: string; hint: string; retryAfterS: number };
    expect(body.error).toBe("Your folder on this hub is full: 1.2 MB of the 1 MB it may hold.");
    expect(body.hint).toMatch(/^Nothing was written\. Each file is deleted 60 min after it was written, so room comes back by \S+ \(in 60 min\), when the oldest goes: try again then\./);
    expect((await upload(bob)).status).toBe(201); // a folder each
  });

  it("refuses a tool's file once the folder is full, as BUSY that changed nothing", async () => {
    const { alice, base, home } = await webHub({ BRIDGE_HUB_WEB_FOLDER_MB: "1" });
    mkdirSync(join(home, "web", "alice"), { recursive: true });
    writeFileSync(join(home, "web", "alice", "earlier.mp4"), Buffer.alloc(1024 * 1024 + 1, 1));
    const web = await client(base, alice);
    const r = await web.call("figma_export_node", { nodeId: "1:1", saveTo: "frame.png" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^BUSY: Your folder on this hub is full/);
    expect(r.structuredContent).toMatchObject({ code: "BUSY", safeToRetry: true });
    expect(readdirSync(join(home, "web", "alice"))).toEqual(["earlier.mp4"]);
    expect(String((JSON.parse((await web.call("figma_status")).content[0]!.text!) as { hint: string }).hint)).toContain("for an hour, up to 1 MB at a time");
  });
});

/** Figma's and Google's endpoints, answering for whoever `who` says signed in. */
function providerStub(who: { figma?: { id: string; email: string }; google?: { sub: string; email: string } }): typeof fetch {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://api.figma.com/v1/oauth/token") return ok({ access_token: "figma-access" });
    if (url === "https://api.figma.com/v1/me") return ok({ id: who.figma?.id, email: who.figma?.email, handle: "F" });
    if (url === "https://oauth2.googleapis.com/token") return ok({ access_token: "google-access" });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") return ok({ sub: who.google?.sub, email: who.google?.email, email_verified: true, name: "G" });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

async function loginHub(stub: typeof fetch, env: Record<string, string> = {}, home = mkdtempSync(join(tmpdir(), "fmcp-limits-"))) {
  if (readPeople(peoplePath(home)).length === 0) addPerson(peoplePath(home), "alice", new Date(), "alice@example.com");
  const config = loadConfig({
    BRIDGE_HOME: home,
    BRIDGE_PORT: "0",
    BRIDGE_HUB_WEB: "1",
    BRIDGE_HUB_PUBLIC_URL: "ws://localhost:1",
    BRIDGE_SESSION_WAIT_MS: "2000",
    BRIDGE_HUB_FIGMA_CLIENT_ID: "figma-client",
    BRIDGE_HUB_FIGMA_CLIENT_SECRET: "figma-secret",
    BRIDGE_HUB_GOOGLE_CLIENT_ID: "google-client",
    BRIDGE_HUB_GOOGLE_CLIENT_SECRET: "google-secret",
    ...env,
  });
  const hub = await runHub(config, createLogger("error"), { createApp, createAgentState, fetchProvider: stub });
  let stopped: Promise<void> | null = null;
  const stop = () => (stopped ??= hub.stop());
  cleanup.push(stop);
  return { home, bridge: hub.bridge, stop, base: `http://127.0.0.1:${hub.bridge.port}` };
}

const pendingOf = (html: string) => /name="p" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? null;

async function startApp(base: string) {
  const reg = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test app", redirect_uris: [REDIRECT] }) });
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const params = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "s" };
  const html = await (await fetch(`${base}/authorize?${new URLSearchParams(params)}`)).text();
  return { html, pending: pendingOf(html)! };
}

async function viaProvider(base: string, provider: "figma" | "google", pending: string, cookie?: string) {
  const go = await fetch(`${base}/login/${provider}?p=${pending}`, { redirect: "manual" });
  const to = new URL(go.headers.get("location")!);
  const back = await fetch(`${base}/login/${provider}/callback?code=provider-code&state=${to.searchParams.get("state")}`, { redirect: "manual", ...(cookie ? { headers: { cookie } } : {}) });
  return { back, text: await back.text() };
}

describe("a cap on the number of people", () => {
  it("tells a new account the hub is full and adds nobody, while the people already in come in", async () => {
    const { base, home } = await loginHub(providerStub({ figma: { id: "999", email: "carol@moire.example" }, google: { sub: "g-alice", email: "alice@example.com" } }), { BRIDGE_HUB_MAX_PEOPLE: "1" });
    const refused = await viaProvider(base, "figma", (await startApp(base)).pending);
    expect(refused.back.status).toBe(403);
    expect(refused.text).toContain("<h1>This hub is full</h1>");
    expect(refused.text).toContain("nobody was added");
    expect(refused.text).not.toContain("carol@moire.example");
    expect(readPeople(peoplePath(home)).map((p) => p.person)).toEqual(["alice"]);
    // Alice is already in the table: the cap stops only someone new.
    expect((await viaProvider(base, "google", (await startApp(base)).pending)).back.headers.get("location")).toMatch(/^https:\/\/client\.example\/callback\?code=/);
  });

  it("fills an open hub up to the cap, and a plugin waiting on a full hub hears it at once", async () => {
    let next = 0;
    const stub = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "a" }), { status: 200 });
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        next++;
        return new Response(JSON.stringify({ sub: `g-${next}`, email: `someone${next}@anywhere.example`, email_verified: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const { base, home } = await loginHub(stub, { BRIDGE_HUB_SIGNUP: "open", BRIDGE_HUB_MAX_PEOPLE: "2" });
    expect((await viaProvider(base, "google", (await startApp(base)).pending)).back.status).toBe(302);
    expect(readPeople(peoplePath(home)).map((p) => p.person)).toEqual(["alice", "someone1"]);

    const start = (await (await fetch(`${base}/device/code`, { method: "POST" })).json()) as { device_code: string; user_code: string };
    const page = await (await fetch(`${base}/device?code=${start.user_code}`)).text();
    expect((await viaProvider(base, "google", pendingOf(page)!)).text).toContain("This hub is full");
    const poll = await fetch(`${base}/device/token`, { method: "POST", headers: FORM, body: new URLSearchParams({ device_code: start.device_code }) });
    expect(((await poll.json()) as { error: string }).error).toBe("access_denied");
    expect(readPeople(peoplePath(home))).toHaveLength(2);
  });

  it("is one rule for both providers: personForLogin and admitsNew", () => {
    const path = peoplePath(mkdtempSync(join(tmpdir(), "fmcp-limits-")));
    addPerson(path, "alice", new Date(), "alice@example.com");
    const figma: Identity = { provider: "figma", subject: "7", email: "new@else.example", emailVerified: true, name: null };
    const google: Identity = { provider: "google", subject: "g7", email: "new@else.example", emailVerified: true, name: null };
    expect(personForLogin(path, figma, { admitNew: true, maxPeople: 1 })).toBe("full");
    expect(personForLogin(path, figma, { admitNew: false, maxPeople: 1 })).toBeNull();
    expect(personForLogin(path, { ...google, email: "alice@example.com" }, { admitNew: false, maxPeople: 1 })).toMatchObject({ person: "alice" });
    expect(personForLogin(path, figma, { admitNew: true, maxPeople: 0 })).toMatchObject({ person: "new", changed: true });
    // Figma: whoever the Figma app lets sign in, under either setting; Google: the list under "team", anyone verified under "open".
    expect(admitsNew(figma, "team", [])).toBe(true);
    expect(admitsNew(figma, "open", [])).toBe(true);
    expect(admitsNew(google, "team", [])).toBe(false);
    expect(admitsNew(google, "team", ["@else.example"])).toBe(true);
    expect(admitsNew(google, "open", [])).toBe(true);
    expect(admitsNew({ ...google, emailVerified: false }, "open", [])).toBe(false);
  });
});

describe("the privacy page", () => {
  it("is linked from the sign-in page, and without a file is the built-in notice of what the hub keeps", async () => {
    const { base } = await loginHub(providerStub({}));
    const { html } = await startApp(base);
    expect(html).toContain('<a href="/privacy">Privacy</a>');
    const page = await fetch(`${base}/privacy`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/^default-src 'none'/);
    const text = await page.text();
    expect(text).toContain("<h1>Privacy on this hub</h1>");
    expect(text).toContain("SHA-256 hash of your token");
    expect(text).toContain("deleted an hour after it was written");
    expect(text).not.toContain('href="/privacy"'); // it does not link to itself
  });

  it("renders the operator's Markdown with everything escaped, and reads the file again on each request", async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-limits-"));
    const file = join(home, "privacy.md");
    writeFileSync(file, "# Our **privacy**\n\nWe keep <script>alert(1)</script> nothing.\n\n- [mail us](mailto:privacy@moire.example)\n- [bad](javascript:void)\n- [site](https://moire.example/p?a=1&b=2)\n");
    const { base } = await loginHub(providerStub({}), { BRIDGE_HUB_PRIVACY_FILE: file }, home);
    const text = await (await fetch(`${base}/privacy`)).text();
    expect(text).toContain("<title>Our privacy</title>");
    expect(text).toContain("<h1>Our <strong>privacy</strong></h1>");
    expect(text).toContain("We keep &#60;script&#62;alert(1)&#60;/script&#62; nothing.");
    expect(text).not.toContain("<script");
    expect(text).toContain('<li><a href="mailto:privacy@moire.example">mail us</a></li>');
    expect(text).toContain("<li>bad</li>");
    expect(text).toContain('<a href="https://moire.example/p?a=1&#38;b=2">site</a>');
    writeFileSync(file, "# Changed\n");
    expect(await (await fetch(`${base}/privacy`)).text()).toContain("<h1>Changed</h1>");
    rmSync(file);
    expect((await fetch(`${base}/privacy`)).status).toBe(503);
  });

  it("serves an operator's HTML whole, under a policy that runs no script", async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-limits-"));
    const file = join(home, "privacy.html");
    writeFileSync(file, "<!doctype html><title>P</title><h1>Ours</h1>");
    const { base } = await loginHub(providerStub({}), { BRIDGE_HUB_PRIVACY_FILE: file }, home);
    const page = await fetch(`${base}/privacy`);
    expect(await page.text()).toBe("<!doctype html><title>P</title><h1>Ours</h1>");
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toMatch(/^default-src 'none';/);
    expect(csp).not.toMatch(/script-src/);
  });

  it("stops the hub from starting when the file is not there", async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-limits-"));
    await expect(loginHub(providerStub({}), { BRIDGE_HUB_PRIVACY_FILE: join(home, "missing.md") }, home)).rejects.toThrow(/BRIDGE_HUB_PRIVACY_FILE names .*missing\.md/);
    await expect(loginHub(providerStub({}), { BRIDGE_HUB_TERMS_FILE: join(home, "missing-terms.md") }, home)).rejects.toThrow(/BRIDGE_HUB_TERMS_FILE names .*missing-terms\.md/);
  });

  it("serves the operator's terms at /terms, linked from the sign-in and privacy pages, and a plain notice without a file", async () => {
    const plain = await loginHub(providerStub({}));
    const { html } = await startApp(plain.base);
    expect(html).toContain('<a href="/terms">Terms</a>');
    const privacy = await (await fetch(`${plain.base}/privacy`)).text();
    expect(privacy).toContain('<a href="/terms">Terms</a>');
    const notice = await fetch(`${plain.base}/terms`);
    expect(notice.status).toBe(200);
    const noticeText = await notice.text();
    expect(noticeText).toContain("<h1>Terms on this hub</h1>");
    expect(noticeText).toContain('<a href="/privacy">Privacy</a>');
    expect(noticeText).not.toContain('href="/terms"'); // it does not link to itself

    const home = mkdtempSync(join(tmpdir(), "fmcp-limits-"));
    const file = join(home, "terms.md");
    writeFileSync(file, "# Our terms\n\nUse it **fairly**. <script>alert(1)</script>\n");
    const { base } = await loginHub(providerStub({}), { BRIDGE_HUB_TERMS_FILE: file }, home);
    const page = await fetch(`${base}/terms`);
    expect(page.headers.get("content-security-policy")).toMatch(/^default-src 'none'/);
    const text = await page.text();
    expect(text).toContain("<title>Our terms</title>");
    expect(text).toContain("Use it <strong>fairly</strong>.");
    expect(text).not.toContain("<script");
    rmSync(file);
    expect((await fetch(`${base}/terms`)).status).toBe(503);
  });

  it("renders the template the docs give operators, whose relative link stays text on the hub", () => {
    const html = renderMarkdown(readFileSync(new URL("../docs/hub-privacy-template.md", import.meta.url), "utf8"));
    expect(html.startsWith("<h1>Privacy notice for [HUB NAME]</h1>\n<blockquote><p><strong>This is a template, not legal advice.</strong>")).toBe(true);
    expect(html).toContain("(docs/hub.md § A privacy page)");
    expect(html).not.toContain('href="hub.md');
    expect(html).toContain("<h3>Your browser</h3>");
    expect(html).toContain("<code>__Host-figxel</code>");
  });

  it("renders the Markdown a notice needs: headings, lists, quotes, rules and code", () => {
    expect(renderMarkdown("## What we keep\n1. Your name\n2. Your `email`\n   still item two\n\n> Template: replace this.\n\n---\nDone *now*.")).toBe(
      "<h2>What we keep</h2>\n<ol><li>Your name</li><li>Your <code>email</code> still item two</li></ol>\n<blockquote><p>Template: replace this.</p></blockquote>\n<hr>\n<p>Done <em>now</em>.</p>",
    );
  });
});

describe("what a hub keeps across a restart", () => {
  it("keeps a plugin's browser credential and a remembered browser", async () => {
    const stub = providerStub({ figma: { id: "1234", email: "alice@example.com" } });
    const first = await loginHub(stub); // alice, with her email: the Figma account is her
    const start = (await (await fetch(`${first.base}/device/code`, { method: "POST" })).json()) as { device_code: string; user_code: string };
    const page = await (await fetch(`${first.base}/device?code=${start.user_code}`)).text();
    const signedIn = await viaProvider(first.base, "figma", pendingOf(page)!);
    const cookie = (signedIn.back.headers.get("set-cookie") ?? "").split(";")[0]!;
    const { token } = (await (await fetch(`${first.base}/device/token`, { method: "POST", headers: FORM, body: new URLSearchParams({ device_code: start.device_code }) })).json()) as { token: string };
    await first.stop();

    const again = await loginHub(stub, {}, first.home);
    const figma = startMock({ port: again.bridge.port, token, fileName: "Alice's file" });
    cleanup.push(() => figma.close());
    await figma.welcomed();
    expect(again.bridge.status("alice").sessions.map((s) => s.file.name)).toEqual(["Alice's file"]);
    const code = ((await (await fetch(`${again.base}/device/code`, { method: "POST" })).json()) as { user_code: string }).user_code;
    expect(await (await fetch(`${again.base}/device?code=${code}`, { headers: { cookie } })).text()).toContain("Continue as alice");
  });
});
