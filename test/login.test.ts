// Sign-in with Figma or Google on a team's hub (login.ts, oauth.ts), with the
// providers' endpoints stood in for: an app gets in as the person the account
// is, the plugin signs in through the browser (the device flow), and Google
// admits only the addresses the operator lists. Removing the person ends it all.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, loadConfig } from "../src/server/config.js";
import { addPerson, peoplePath, readPeople, removePerson, runHub, setEmail } from "../src/server/hub.js";
import { googleAdmits } from "../src/server/login.js";
import { createAgentState, createApp } from "../src/server/mcp.js";
import { startMock } from "./helpers.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const REDIRECT = "https://client.example/callback";

/** Figma's and Google's endpoints, answering for whoever `who` says signed in. */
function providerStub(who: { figma?: { id: string; email: string; handle: string }; google?: { sub: string; email: string; verified: boolean } }): typeof fetch {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.figma.com/v1/oauth/token") {
      expect(String((init?.headers as Record<string, string>).authorization)).toMatch(/^Basic /); // the app's id and secret [C-415]
      return ok({ access_token: "figma-access", user_id_string: who.figma?.id, token_type: "bearer" });
    }
    if (url === "https://api.figma.com/v1/me") return ok({ id: who.figma?.id, email: who.figma?.email, handle: who.figma?.handle });
    if (url === "https://oauth2.googleapis.com/token") return ok({ access_token: "google-access", token_type: "Bearer" });
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") return ok({ sub: who.google?.sub, email: who.google?.email, email_verified: who.google?.verified, name: "G" });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

async function loginHub(stub: typeof fetch, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "fmcp-login-"));
  const alice = addPerson(peoplePath(home), "alice");
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
  const { bridge, stop } = await runHub(config, createLogger("error"), { createApp, createAgentState, fetchProvider: stub });
  cleanup.push(stop);
  return { home, alice, bridge, base: `http://127.0.0.1:${bridge.port}` };
}

const pendingOf = (html: string) => /name="p" value="([0-9a-f]{32})"/.exec(html)?.[1] ?? null;

/** An app's sign-in up to the page: the pending id the page holds. */
async function startApp(base: string) {
  const reg = await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test app", redirect_uris: [REDIRECT] }) });
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const params = { response_type: "code", client_id, redirect_uri: REDIRECT, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "s" };
  const html = await (await fetch(`${base}/authorize?${new URLSearchParams(params)}`)).text();
  return { client_id, verifier, html, pending: pendingOf(html)! };
}

/** Through a provider: the button, the provider's redirect (not followed), and its callback with a code. */
async function viaProvider(base: string, provider: "figma" | "google", pending: string) {
  const go = await fetch(`${base}/login/${provider}?p=${pending}`, { redirect: "manual" });
  const to = new URL(go.headers.get("location")!);
  const back = await fetch(`${base}/login/${provider}/callback?code=provider-code&state=${to.searchParams.get("state")}`, { redirect: "manual" });
  return { to, back, location: back.headers.get("location") ? new URL(back.headers.get("location")!) : null, text: await back.text() };
}

describe("sign-in with an account", () => {
  it("offers Figma and Google on the page, with the invite kept as the other way in", async () => {
    const { base } = await loginHub(providerStub({}));
    const { html } = await startApp(base);
    expect(html).toContain("Continue with Figma");
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Use an invite instead");
  });

  it("signs an app in with Figma as the person whose email it is, through Figma's own sign-in", async () => {
    const { base, home } = await loginHub(providerStub({ figma: { id: "1234", email: "Alice@Example.com", handle: "Alice" } }));
    setEmail(peoplePath(home), "alice", "alice@example.com");
    const app = await startApp(base);
    const { to, location } = await viaProvider(base, "figma", app.pending);
    expect(to.origin + to.pathname).toBe("https://www.figma.com/oauth");
    expect(to.searchParams.get("scope")).toBe("current_user:read");
    expect(to.searchParams.get("redirect_uri")).toBe("http://localhost:1/login/figma/callback");
    expect(location?.origin).toBe("https://client.example");
    const t = await fetch(`${base}/token`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ grant_type: "authorization_code", code: location!.searchParams.get("code")!, code_verifier: app.verifier, client_id: app.client_id, redirect_uri: REDIRECT }),
    });
    expect(t.status).toBe(200);
    // The account is linked to alice: the next sign-in finds her by Figma's id, whatever the email.
    expect(readPeople(peoplePath(home)).find((p) => p.person === "alice")?.logins).toEqual([{ provider: "figma", subject: "1234" }]);
  });

  it("lets in a new member of the Figma team as a new person, named after their email", async () => {
    const { base, home } = await loginHub(providerStub({ figma: { id: "999", email: "carol@moire.example", handle: "Carol" } }));
    const { location } = await viaProvider(base, "figma", (await startApp(base)).pending);
    expect(location?.searchParams.get("code")).toMatch(/^[0-9a-f]{64}$/);
    expect(readPeople(peoplePath(home)).map((p) => p.person)).toEqual(["alice", "carol"]);
  });

  it("lets in a Google account only when the operator listed it, and only with a verified email", async () => {
    const stranger = await loginHub(providerStub({ google: { sub: "g1", email: "someone@else.example", verified: true } }), { BRIDGE_HUB_GOOGLE_ALLOW: "@moire.example" });
    const refused = await viaProvider(stranger.base, "google", (await startApp(stranger.base)).pending);
    expect(refused.back.status).toBe(403);
    expect(refused.text).toContain("is not on this hub&#39;s list"); // the page escapes the apostrophe
    expect(readPeople(peoplePath(stranger.home)).map((p) => p.person)).toEqual(["alice"]);

    const member = await loginHub(providerStub({ google: { sub: "g2", email: "dina@moire.example", verified: true } }), { BRIDGE_HUB_GOOGLE_ALLOW: "@moire.example" });
    expect((await viaProvider(member.base, "google", (await startApp(member.base)).pending)).location?.searchParams.get("code")).toBeTruthy();

    expect(googleAdmits({ provider: "google", subject: "x", email: "dina@moire.example", emailVerified: false, name: null }, ["@moire.example"], false)).toBe(false);
    expect(googleAdmits({ provider: "google", subject: "x", email: "a@b.example", emailVerified: true, name: null }, [], true)).toBe(true);
  });

  it("signs the plugin in through the browser: a code, the person confirms it, the plugin gets its credential once", async () => {
    const { base, home, bridge } = await loginHub(providerStub({ figma: { id: "1234", email: "alice@example.com", handle: "Alice" } }));
    setEmail(peoplePath(home), "alice", "alice@example.com");
    const start = (await (await fetch(`${base}/device/code`, { method: "POST" })).json()) as { device_code: string; user_code: string; verification_uri_complete: string; interval: number };
    expect(start.user_code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    const poll = () => fetch(`${base}/device/token`, { method: "POST", headers: FORM, body: new URLSearchParams({ device_code: start.device_code }) });
    expect(((await (await poll()).json()) as { error: string }).error).toBe("authorization_pending");

    const page = await (await fetch(`${base}/device?code=${start.user_code}`)).text();
    expect(page).toContain(start.user_code); // the person checks the code Figma shows
    const { text } = await viaProvider(base, "figma", pendingOf(page)!);
    expect(text).toContain("connected as alice");

    await new Promise((r) => setTimeout(r, start.interval * 1000));
    const got = (await (await poll()).json()) as { token: string; person: string };
    expect(got.person).toBe("alice");
    expect(((await (await poll()).json()) as { error: string }).error).toBe("invalid_grant"); // once

    const figma = startMock({ port: bridge.port, token: got.token, fileName: "Alice's file" });
    cleanup.push(() => figma.close());
    await figma.welcomed();
    expect(bridge.status("alice").sessions.map((s) => s.file.name)).toEqual(["Alice's file"]);

    removePerson(peoplePath(home), "alice");
    bridge.setPeople(readPeople(peoplePath(home)));
    expect((await figma.closed()).code).toBe(4001); // the browser sign-in ends with the person
  });
});

describe("a browser that signed in", () => {
  it("is remembered: the next sign-in, the plugin's included, is one click as the same person, with no second login", async () => {
    const { base, home } = await loginHub(providerStub({ google: { sub: "g-alice", email: "alice@example.com", verified: true } }));
    setEmail(peoplePath(home), "alice", "alice@example.com");
    // First: an app signs in with Google, and the hub remembers the browser.
    const first = await viaProvider(base, "google", (await startApp(base)).pending);
    const setCookie = first.back.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-figxel=[0-9a-f]{64}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
    const cookie = setCookie.split(";")[0]!;

    // Then the plugin: its code's page knows the browser, and Continue approves it.
    const start = (await (await fetch(`${base}/device/code`, { method: "POST" })).json()) as { device_code: string; user_code: string };
    const page = await (await fetch(`${base}/device?code=${start.user_code}`, { headers: { cookie } })).text();
    expect(page).toContain("Continue as alice");
    expect(page).not.toContain("Continue with Google");
    const ok = await fetch(`${base}/authorize`, { method: "POST", headers: { ...FORM, cookie, origin: "http://localhost:1" }, body: new URLSearchParams({ p: pendingOf(page)!, continue: "1" }) });
    expect(await ok.text()).toContain("connected as alice");
  });

  it("is refused a form posted from another site, and forgotten by Use another account", async () => {
    const { base, home } = await loginHub(providerStub({ google: { sub: "g-alice", email: "alice@example.com", verified: true } }));
    setEmail(peoplePath(home), "alice", "alice@example.com");
    const cookie = ((await viaProvider(base, "google", (await startApp(base)).pending)).back.headers.get("set-cookie") ?? "").split(";")[0]!;
    const app = await startApp(base);
    const page = await (await fetch(`${base}/authorize?client_id=x`, { headers: { cookie } })).text(); // an unknown app: refused, nothing remembered shown
    expect(page).not.toContain("Continue as");
    const evil = await fetch(`${base}/authorize`, { method: "POST", headers: { ...FORM, cookie, origin: "https://evil.example" }, body: new URLSearchParams({ p: app.pending, continue: "1" }), redirect: "manual" });
    expect(evil.status).toBe(403);
    const sw = await fetch(`${base}/login/switch?p=${app.pending}`, { headers: { cookie } });
    expect(sw.headers.get("set-cookie")).toMatch(/^__Host-figxel=; Path=\/; Max-Age=0/);
    expect(await sw.text()).toContain("Continue with Google");
    // The cookie it forgot no longer signs anyone in.
    const again = await (await fetch(`${base}/device?code=${((await (await fetch(`${base}/device/code`, { method: "POST" })).json()) as { user_code: string }).user_code}`, { headers: { cookie } })).text();
    expect(again).not.toContain("Continue as");
  });
});

describe("an account the hub does not admit", () => {
  it("tells a waiting plugin at once (access_denied), and the page names the free way in", async () => {
    const { base } = await loginHub(providerStub({ google: { sub: "g-x", email: "stranger@else.example", verified: true } }));
    const start = (await (await fetch(`${base}/device/code`, { method: "POST" })).json()) as { device_code: string; user_code: string };
    const page = await (await fetch(`${base}/device?code=${start.user_code}`)).text();
    const refused = await viaProvider(base, "google", pendingOf(page)!);
    expect(refused.back.status).toBe(403);
    expect(refused.text).toContain("Use Figxel on this computer instead");
    const poll = await fetch(`${base}/device/token`, { method: "POST", headers: FORM, body: new URLSearchParams({ device_code: start.device_code }) });
    expect(((await poll.json()) as { error: string }).error).toBe("access_denied");
  });
});
