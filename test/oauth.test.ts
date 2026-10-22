// OAuth for the hub's web endpoint (cloud bridge plan, Phase C): the hub is its
// own authorization server [C-414]. A client registers (or is known by its
// metadata document), the person signs in with their invite, and the access
// token reaches only that person's Figma, for as long as they are in the table.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, loadConfig } from "../src/server/config.js";
import { addPerson, peoplePath, readPeople, removePerson, runHub } from "../src/server/hub.js";
import { createAgentState, createApp } from "../src/server/mcp.js";
import { isPublicAddress, publicOnlyLookup, validRedirect } from "../src/server/oauth.js";
import { inviteOf } from "../src/shared/invite.js";
import { startMock } from "./helpers.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const ISSUER = "http://localhost:1"; // the public address links and metadata name; the test talks to the real port
const RESOURCE = `${ISSUER}/mcp`;
const FORM = { "content-type": "application/x-www-form-urlencoded" };

const pendingOf = (html: string) => /name="p" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? null;

async function oauthHub(fetchClientDocument?: (url: string) => Promise<unknown>, env: Record<string, string> = {}, fetchProvider?: typeof fetch) {
  const home = mkdtempSync(join(tmpdir(), "fmcp-oauth-"));
  const alice = addPerson(peoplePath(home), "alice");
  const config = loadConfig({ BRIDGE_HOME: home, BRIDGE_PORT: "0", BRIDGE_HUB_WEB: "1", BRIDGE_HUB_PUBLIC_URL: "ws://localhost:1", BRIDGE_SESSION_WAIT_MS: "2000", ...env });
  const { bridge, stop } = await runHub(config, createLogger("error"), { createApp, createAgentState, web: fetchClientDocument ? { fetchClientDocument } : {}, ...(fetchProvider ? { fetchProvider } : {}) });
  cleanup.push(stop);
  const figma = startMock({ port: bridge.port, token: alice, fileName: "Alice's file" });
  cleanup.push(() => figma.close());
  await figma.welcomed();
  return { home, alice, bridge, base: `http://127.0.0.1:${bridge.port}` };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(base: string, redirect = "https://client.example/callback") {
  const r = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test client", redirect_uris: [redirect] }) });
  expect(r.status).toBe(201);
  return ((await r.json()) as { client_id: string }).client_id;
}

/** Through the sign-in page: the code, or the answer when there is none. */
async function signIn(base: string, clientId: string, credential: string, opts: { redirect?: string; challenge: string }) {
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: opts.redirect ?? "https://client.example/callback",
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    state: "st-1",
    resource: RESOURCE,
  };
  const page = await fetch(`${base}/authorize?${new URLSearchParams(params)}`);
  const pageText = await page.text();
  // The page holds the sign-in in progress by its id; the invite form sends that id.
  const pending = pendingOf(pageText) ?? "none";
  const post = await fetch(`${base}/authorize`, { method: "POST", headers: FORM, body: new URLSearchParams({ p: pending, credential }), redirect: "manual" });
  const location = post.headers.get("location");
  return { page, pageText, pending, post, location: location ? new URL(location) : null };
}

async function exchange(base: string, body: Record<string, string>) {
  const r = await fetch(`${base}/token`, { method: "POST", headers: FORM, body: new URLSearchParams(body) });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

/** The whole flow, as a client that speaks only OAuth runs it. */
async function tokensFor(base: string, credential: string) {
  const clientId = await register(base);
  const { verifier, challenge } = pkce();
  const { location } = await signIn(base, clientId, credential, { challenge });
  const t = await exchange(base, { grant_type: "authorization_code", code: location!.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: "https://client.example/callback", resource: RESOURCE });
  expect(t.status).toBe(200);
  return { clientId, access_token: t.body.access_token!, refresh_token: t.body.refresh_token! };
}

describe("OAuth for the web endpoint", () => {
  it("publishes its metadata, and a 401 points to it", async () => {
    const { base } = await oauthHub();
    const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER] });
    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: ISSUER, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true, registration_endpoint: `${ISSUER}/register` });
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`);
  });

  it("signs a person in with their invite, and the access token reaches their Figma", async () => {
    const { base, alice } = await oauthHub();
    const clientId = await register(base);
    const { challenge } = pkce();
    const { pageText, location } = await signIn(base, clientId, inviteOf("wss://mcp.figxel.example", alice), { challenge });
    expect(pageText).toContain("Test client");
    expect(pageText).toContain("client.example"); // where it returns, shown before anyone allows it
    expect(location?.origin).toBe("https://client.example");
    expect(location?.searchParams.get("state")).toBe("st-1");
    expect(location?.searchParams.get("iss")).toBe(ISSUER);

    const tokens = await tokensFor(base, alice);
    expect(tokens.access_token).toMatch(/^fxa_[0-9a-f]{64}$/);
    expect(tokens.refresh_token).toMatch(/^fxr_[0-9a-f]{64}$/);
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } });
    const client = new Client({ name: "oauth-test", version: "0" });
    await client.connect(transport);
    cleanup.push(() => client.close());
    const status = (await client.callTool({ name: "figma_status", arguments: {} })) as { content: Array<{ text: string }> };
    const data = JSON.parse(status.content[0]!.text) as { sessions: Array<{ file: { name: string } }> };
    expect(data.sessions.map((s) => s.file.name)).toEqual(["Alice's file"]);
  });

  it("refuses a wrong verifier, a code used twice, and a wrong token on the page", async () => {
    const { base, alice } = await oauthHub();
    const clientId = await register(base);
    const { verifier, challenge } = pkce();
    const { location } = await signIn(base, clientId, alice, { challenge });
    const code = location!.searchParams.get("code")!;
    const body = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: "https://client.example/callback" };
    expect((await exchange(base, { ...body, code_verifier: pkce().verifier })).body.error).toBe("invalid_grant");
    expect((await exchange(base, { ...body, code_verifier: verifier })).body.error).toBe("invalid_grant"); // the first try spent it

    const wrong = await signIn(base, clientId, randomBytes(32).toString("hex"), { challenge });
    expect(wrong.post.status).toBe(401);
    expect(wrong.location).toBeNull();
  });

  it("never redirects to an address the client did not register, nor to plain http on the internet", async () => {
    const { base, alice } = await oauthHub();
    const clientId = await register(base);
    const { challenge } = pkce();
    const r = await signIn(base, clientId, alice, { challenge, redirect: "https://evil.example/steal" });
    expect(r.page.status).toBe(400);
    expect(r.location).toBeNull();
    const bad = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
    expect(bad.status).toBe(400);
  });

  it("rotates refresh tokens: a spent one is refused", async () => {
    const { base, alice } = await oauthHub();
    const first = await tokensFor(base, alice);
    const next = await exchange(base, { grant_type: "refresh_token", refresh_token: first.refresh_token!, client_id: first.clientId });
    expect(next.status).toBe(200);
    expect(next.body.access_token).not.toBe(first.access_token);
    expect((await exchange(base, { grant_type: "refresh_token", refresh_token: first.refresh_token!, client_id: first.clientId })).body.error).toBe("invalid_grant");
  });

  it("ends a person's grants when they leave the table", async () => {
    const { base, alice, home, bridge } = await oauthHub();
    const tokens = await tokensFor(base, alice);
    removePerson(peoplePath(home), "alice");
    bridge.setPeople(readPeople(peoplePath(home))); // what the running hub does when the file changes
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
    });
    expect(r.status).toBe(401);
    expect((await exchange(base, { grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id: tokens.clientId })).body.error).toBe("invalid_grant");
  });

  it("knows a client by its metadata document, which must name itself", async () => {
    const docs: Record<string, unknown> = {
      "https://app.example/client.json": { client_id: "https://app.example/client.json", client_name: "Doc client", redirect_uris: ["http://localhost:5555/cb"] },
      "https://liar.example/client.json": { client_id: "https://other.example/client.json", redirect_uris: ["https://liar.example/cb"] },
    };
    const { base } = await oauthHub(async (url) => docs[url] ?? null);
    const { challenge } = pkce();
    const ok = await signIn(base, "https://app.example/client.json", "x", { challenge, redirect: "http://localhost:5555/cb" });
    expect(ok.page.status).toBe(200);
    expect(ok.pageText).toContain("Doc client");
    expect(ok.pageText).toContain("a program on your own computer");
    const liar = await signIn(base, "https://liar.example/client.json", "x", { challenge, redirect: "https://liar.example/cb" });
    expect(liar.page.status).toBe(400);
  });

  it("fetches a metadata document only from a public address, and allows https or localhost redirects", () => {
    for (const a of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.18.0.2", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect(isPublicAddress(a), a).toBe(true);
    expect(validRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(validRedirect("http://localhost:33418/callback")).toBe(true);
    expect(validRedirect("http://127.0.0.1:8080/cb")).toBe(true);
    expect(validRedirect("http://evil.example/cb")).toBe(false);
    expect(validRedirect("https://client.example/cb#frag")).toBe(false);
  });

  it("answers Node's lookup in the form asked, one address or all of them, and refuses a name with any private address", async () => {
    const ask = (found: Array<{ address: string; family: number }>, options: { all?: boolean } | undefined) =>
      new Promise<{ err: unknown; address: unknown }>((done) => publicOnlyLookup(async () => found)("app.example", options, (err, address) => done({ err, address })));
    const pub = [{ address: "160.79.104.10", family: 4 }, { address: "2607:6bc0::10", family: 6 }];
    expect(await ask(pub, { all: true })).toEqual({ err: null, address: pub });
    expect(await ask(pub, {})).toEqual({ err: null, address: "160.79.104.10" });
    const mixed = [...pub, { address: "10.0.0.5", family: 4 }];
    expect((await ask(mixed, { all: true })).err).toBeInstanceOf(Error);
    for (const a of ["64:ff9b::a00:1", "2002:a00:1::1", "::7f00:1", "192.0.0.1", "198.18.0.1", "2001:db8::1"]) expect(isPublicAddress(a), a).toBe(false);
  });

  it("limits registrations per address, and takes only allowed return hosts when the operator set them", async () => {
    const { base } = await oauthHub(undefined, { BRIDGE_HUB_REDIRECT_HOSTS: "claude.ai, chatgpt.com" });
    const reg = (uri: string) => fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [uri] }) });
    expect((await reg("https://claude.ai/api/mcp/auth_callback")).status).toBe(201);
    expect((await reg("https://client.example/callback")).status).toBe(400);
    for (let i = 0; i < 18; i++) await reg("https://chatgpt.com/connector_platform_oauth_redirect");
    expect((await reg("https://chatgpt.com/connector_platform_oauth_redirect")).status).toBe(429);
  });
});
