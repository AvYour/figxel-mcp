// OAuth for a team's web endpoint (cloud bridge plan, Phase C): the hub is its
// own authorization server, so a client that speaks only OAuth (ChatGPT
// [C-407], or claude.ai without a header [C-406]) can sign a person in.
//
// What the MCP authorization spec asks of it [C-414]: Protected Resource
// Metadata and authorization server metadata at their well-known paths; a
// public client identified by a Client ID Metadata Document (an https URL) or
// registered dynamically; PKCE with S256 only; exact redirect URIs, https or
// localhost; tokens bound to this server's /mcp; refresh tokens rotated.
//
// The person proves who they are on the sign-in page with their token or
// invite. A grant stands for that person's entry in the table (its hash), so
// removing the person, or giving them a new token, ends it at once. Access
// tokens live in memory for an hour; refresh tokens and registered clients are
// kept in <home>/hub-oauth.json as hashes.

import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { join } from "node:path";
import { clientAddress, type Bridge } from "./bridge.js";
import type { Logger } from "./config.js";
import { pkcePair, type Identity, type Provider, type ProviderId } from "./login.js";
import { parseInvite } from "../shared/invite.js";
import { PRODUCT_NAME } from "../shared/version.js";

export const OAUTH_FILE = "hub-oauth.json";
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const MAX_CLIENTS = 500;
const CIMD_TTL_MS = 60 * 60_000;
const CIMD_MAX_BYTES = 64 * 1024;
const MAX_DOCUMENTS = 200;

export interface OAuthOptions {
  /** The hub's public https address, without a trailing slash: the issuer. */
  issuer: string;
  home: string;
  logger: Logger;
  hub: () => Bridge;
  /** Fetches a Client ID Metadata Document; tests pass their own (the real one refuses private addresses). */
  fetchClientDocument?: (url: string) => Promise<unknown>;
  /**
   * BRIDGE_HUB_REDIRECT_HOSTS: when set, the only hosts an app may return to
   * (e.g. chatgpt.com, claude.ai, localhost). Unset, any https host or localhost.
   */
  redirectHosts?: readonly string[];
  /**
   * Sign-in with an account (login.ts): the providers offered, and the person
   * an account is, or null when it is not admitted (hub.ts personForLogin).
   * Without it, the sign-in page takes an invite alone.
   */
  accounts?: {
    providers: readonly Provider[];
    personFor: (identity: Identity) => { person: string; source: string } | null;
  };
}

/** At most `max` uses per key within `windowMs`: a cheap guard for endpoints anyone may call. */
class Budget {
  private readonly uses = new Map<string, { n: number; since: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  take(key: string): boolean {
    const now = Date.now();
    if (this.uses.size > 10_000) for (const [k, u] of this.uses) if (now - u.since > this.windowMs) this.uses.delete(k);
    let u = this.uses.get(key);
    if (!u || now - u.since > this.windowMs) this.uses.set(key, (u = { n: 0, since: now }));
    return ++u.n <= this.max;
  }
}

interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
}

interface Grant {
  person: string;
  /** The table entry (hash, hex) the grant stands for. */
  source: string;
  clientId: string;
  expiresAt: number;
}

interface Code extends Grant {
  redirectUri: string;
  challenge: string;
}

interface Stored {
  v: 1;
  clients: Record<string, Client & { createdAt: number }>;
  refresh: Record<string, Grant>;
  /** Credentials a plugin received by signing in through the browser (the device flow), by hash: what each stands for. */
  devices?: Record<string, { person: string; source: string; createdAt: number }>;
  /** Browsers that signed in on this hub, by the hash of their cookie: the next sign-in there is one click. */
  browsers?: Record<string, { person: string; source: string; via: string; expiresAt: number }>;
}

/** A sign-in in progress, between the page and the account's provider: an app's authorization, or a plugin's device code. */
type Pending =
  | { kind: "authorize"; client: Client; redirectUri: string; challenge: string; state: string | null; expiresAt: number }
  | { kind: "device"; deviceKey: string; userCode: string; expiresAt: number };

interface Device {
  userCode: string;
  expiresAt: number;
  lastPoll: number;
  approved?: { person: string; source: string };
  /** The account that signed in for it is not admitted: the plugin is told at once (access_denied). */
  denied?: boolean;
}

export interface OAuth {
  /** The well-known paths, /register, /authorize, /token, /login/* and /device*; false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
  /** The person behind an access token this server issued, while it lasts and its table entry is there. */
  verify(accessToken: string): { person: string; source: string } | null;
  /** The table entry (hash) a plugin credential from the device flow stands for, by the credential's hash; else null. */
  credentialSource(hashHex: string): string | null;
  /** The Protected Resource Metadata URL, for a 401's WWW-Authenticate. */
  readonly resourceMetadata: string;
}

/**
 * The browser that signed in: __Host- keeps it to this host over https, HttpOnly
 * from scripts, SameSite=Lax from other sites' POSTs. Thirty days, and no
 * longer than the person's table entry.
 */
const BROWSER_COOKIE = "__Host-figxel";
const BROWSER_TTL_MS = 30 * 24 * 60 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const DEVICE_TTL_MS = 10 * 60_000;
const DEVICE_INTERVAL_S = 3;
/** User codes leave out vowels and look-alikes, as device-flow codes do: nothing to misread, no words. */
const CODE_LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const userCode = () => {
  const b = randomBytes(8);
  const c = [...b].map((x) => CODE_LETTERS[x % CODE_LETTERS.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};

/** Drops expired entries once a map grows, and the oldest past a hard cap: anyone can add to these maps. */
function prune<V extends { expiresAt: number }>(map: Map<string, V>, cap = 5000): void {
  if (map.size < 1000) return;
  const now = Date.now();
  for (const [k, v] of map) if (v.expiresAt < now) map.delete(k);
  while (map.size > cap) map.delete(map.keys().next().value!);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function createOAuth(opts: OAuthOptions): OAuth {
  const { issuer, logger } = opts;
  const resource = `${issuer}/mcp`;
  const resourceMetadata = `${issuer}/.well-known/oauth-protected-resource`;
  const path = join(opts.home, OAUTH_FILE);
  const stored: Stored = load(path);
  const access = new Map<string, Grant>();
  const codes = new Map<string, Code>();
  const documents = new Map<string, { client: Client; until: number }>();
  const fetchDocument = opts.fetchClientDocument ?? fetchClientDocument;
  const registrations = new Budget(20, 60 * 60_000);
  const fetches = new Budget(30, 10 * 60_000);
  /** A redirect this hub takes: https or localhost [C-414], and on an allowed host when the operator set some. */
  const allowedRedirect = (uri: string) =>
    validRedirect(uri) && (!opts.redirectHosts?.length || opts.redirectHosts.includes(new URL(uri).hostname.replace(/^\[|\]$/g, "")));

  const save = () => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  };

  /** A grant is good while it lasts and the person's table entry is still the one it was made from. */
  const live = (g: Grant | undefined): g is Grant => !!g && g.expiresAt > Date.now() && opts.hub().personOfSource(g.source) === g.person;

  function issue(g: Omit<Grant, "expiresAt">): Record<string, unknown> {
    const accessToken = `fxa_${randomBytes(32).toString("hex")}`;
    const refreshToken = `fxr_${randomBytes(32).toString("hex")}`;
    access.set(sha(accessToken), { ...g, expiresAt: Date.now() + ACCESS_TTL_MS });
    stored.refresh[sha(refreshToken)] = { ...g, expiresAt: Date.now() + REFRESH_TTL_MS };
    for (const [h, r] of Object.entries(stored.refresh)) if (r.expiresAt < Date.now()) delete stored.refresh[h];
    save();
    return { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refreshToken };
  }

  /** A client by id: one registered here, or one whose https id is its own metadata document. */
  async function clientOf(id: string, address: string): Promise<Client | null> {
    if (stored.clients[id]) return stored.clients[id]!;
    if (!/^https:\/\/[^/]+\/./.test(id)) return null;
    const cached = documents.get(id);
    if (cached && cached.until > Date.now()) return cached.client;
    // A fetch anyone can cause: limited per address, and the cache is capped.
    if (!fetches.take(address)) return null;
    if (documents.size >= MAX_DOCUMENTS) documents.delete(documents.keys().next().value!);
    try {
      const doc = (await fetchDocument(id)) as Partial<Client> | null;
      if (!doc || doc.client_id !== id || !Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every(allowedRedirect)) return null;
      const client: Client = { client_id: id, client_name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 80) : new URL(id).host, redirect_uris: doc.redirect_uris };
      documents.set(id, { client, until: Date.now() + CIMD_TTL_MS });
      return client;
    } catch (e) {
      logger.warn(`oauth: could not read the client document ${id} (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
  }

  async function register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = clientAddress(req);
    if (opts.hub().turnedAway(address) || !registrations.take(address)) return json(res, 429, { error: "slow_down" });
    const body = (await readJson(req, res)) as { redirect_uris?: unknown; client_name?: unknown } | null;
    if (res.headersSent) return;
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && allowedRedirect(u))) {
      return json(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris: https addresses, or http on localhost, on a host this hub allows" });
    }
    if (Object.keys(stored.clients).length >= MAX_CLIENTS) {
      // Room is made only from apps nobody is signed in with: a flood of registrations cannot push out a working one.
      const inUse = new Set(Object.values(stored.refresh).filter((r) => r.expiresAt > Date.now()).map((r) => r.clientId));
      const idle = Object.keys(stored.clients)
        .filter((id) => !inUse.has(id))
        .sort((a, b) => stored.clients[a]!.createdAt - stored.clients[b]!.createdAt)[0];
      if (!idle) return json(res, 503, { error: "temporarily_unavailable" });
      delete stored.clients[idle];
    }
    const client = {
      client_id: `fxc_${randomBytes(16).toString("hex")}`,
      client_name: typeof body?.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "An MCP client",
      redirect_uris: uris as string[],
      createdAt: Date.now(),
    };
    stored.clients[client.client_id] = client;
    save();
    logger.info(`oauth: registered "${client.client_name}"`);
    json(res, 201, {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  /** The authorization request's own checks; an answer already sent when they fail. */
  async function authRequest(params: URLSearchParams, res: ServerResponse, address: string): Promise<{ client: Client; redirectUri: string } | null> {
    const client = await clientOf(params.get("client_id") ?? "", address);
    const redirectUri = params.get("redirect_uri") ?? "";
    // Never redirect to an address the client did not register: the page says so instead.
    if (!client) return page(res, 400, errorPage("This app is not known to the hub, or its description could not be read.")), null;
    if (!client.redirect_uris.includes(redirectUri)) return page(res, 400, errorPage("This app asked to return to an address it did not register.")), null;
    const fail = (error: string, description: string) => {
      const to = new URL(redirectUri);
      to.searchParams.set("error", error);
      to.searchParams.set("error_description", description);
      if (params.get("state")) to.searchParams.set("state", params.get("state")!);
      res.writeHead(302, { location: to.toString() }).end();
      return null;
    };
    if (params.get("response_type") !== "code") return fail("unsupported_response_type", "response_type must be code");
    if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "")) {
      return fail("invalid_request", "PKCE with S256 is required");
    }
    const asked = params.get("resource");
    if (asked !== null && !sameResource(asked, resource, issuer)) return fail("invalid_target", `this server's resource is ${resource}`);
    return { client, redirectUri };
  }

  const providers = opts.accounts?.providers ?? [];
  /** Sign-ins between the page and the provider, by id; the provider round trips, by state. */
  const pendings = new Map<string, Pending>();
  const logins = new Map<string, { pending: string; provider: ProviderId; verifier: string; expiresAt: number }>();
  const devices = new Map<string, Device>();
  const deviceCodes = new Budget(20, 10 * 60_000);
  const security = {
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
  };
  type Browser = { person: string; source: string; via: string };
  const pageFor = (pendingId: string, p: Pending, error = "", browser: Browser | null = null) =>
    signInPage({
      pendingId,
      providers,
      error,
      ...(browser ? { signedInAs: browser } : {}),
      ...(p.kind === "authorize" ? { app: { client: p.client, redirectUri: p.redirectUri } } : { deviceCode: p.userCode }),
    });

  /** The person this browser signed in as, while the cookie lasts and their table entry is the same. */
  function browserOf(req: IncomingMessage): Browser | null {
    const cookie = new RegExp(`(?:^|;\\s*)${BROWSER_COOKIE}=([0-9a-f]{64})(?:;|$)`).exec(req.headers.cookie ?? "")?.[1];
    const b = cookie ? stored.browsers?.[sha(cookie)] : undefined;
    return b && b.expiresAt > Date.now() && opts.hub().personOfSource(b.source) === b.person ? { person: b.person, source: b.source, via: b.via } : null;
  }

  /** Remembers this browser as `who`: the Set-Cookie value for the answer. */
  function rememberBrowser(who: { person: string; source: string }, via: string): string {
    const cookie = randomBytes(32).toString("hex");
    const now = Date.now();
    const kept = Object.fromEntries(Object.entries(stored.browsers ?? {}).filter(([, b]) => b.expiresAt > now));
    stored.browsers = { ...kept, [sha(cookie)]: { ...who, via, expiresAt: now + BROWSER_TTL_MS } };
    save();
    return `${BROWSER_COOKIE}=${cookie}; Path=/; Max-Age=${BROWSER_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`;
  }
  const FORGET_BROWSER = `${BROWSER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  const callbackOf = (provider: ProviderId) => `${issuer}/login/${provider}/callback`;
  const livePending = (id: string | null): Pending | null => {
    const p = id ? pendings.get(id) : undefined;
    return p && p.expiresAt > Date.now() ? p : null;
  };
  const expired = (res: ServerResponse) => page(res, 400, errorPage("This sign-in expired. Start again from the app, or from Figma."), security);

  /** The person is known: an app gets its code back at its return address; a plugin's code is approved. */
  function complete(pendingId: string, p: Pending, who: { person: string; source: string }, res: ServerResponse, how: string, cookie?: string): void {
    pendings.delete(pendingId);
    const remember: Record<string, string> = cookie ? { "set-cookie": cookie } : {};
    if (p.kind === "device") {
      const device = devices.get(p.deviceKey);
      if (!device || device.expiresAt < Date.now()) return expired(res);
      device.approved = who;
      logger.info(`oauth: a plugin signed in as ${who.person} (${how})`);
      return page(res, 200, donePage(`${PRODUCT_NAME} in Figma is connected as ${who.person}. You can close this tab.`), { ...security, ...remember });
    }
    const code = randomBytes(32).toString("hex");
    codes.set(sha(code), { ...who, clientId: p.client.client_id, redirectUri: p.redirectUri, challenge: p.challenge, expiresAt: Date.now() + CODE_TTL_MS });
    const to = new URL(p.redirectUri);
    to.searchParams.set("code", code);
    if (p.state) to.searchParams.set("state", p.state);
    to.searchParams.set("iss", issuer);
    logger.info(`oauth: "${p.client.client_name}" signed in as ${who.person} (${how})`);
    res.writeHead(302, { location: to.toString(), ...remember }).end();
  }

  async function authorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = clientAddress(req);
    if (req.method === "GET") {
      const params = new URL(req.url ?? "/", issuer).searchParams;
      const ok = await authRequest(params, res, address);
      if (!ok) return;
      const id = randomBytes(16).toString("hex");
      prune(pendings);
      const p: Pending = { kind: "authorize", ...ok, challenge: params.get("code_challenge")!, state: params.get("state"), expiresAt: Date.now() + PENDING_TTL_MS };
      pendings.set(id, p);
      return page(res, 200, pageFor(id, p, "", browserOf(req)), security);
    }
    if (req.method !== "POST") return void res.writeHead(405).end();
    // The page's own forms only: a browser names the origin of a POST, and another site's is refused.
    const origin = req.headers.origin;
    if (origin && origin !== "null" && origin !== new URL(issuer).origin) return page(res, 403, errorPage("This form must be sent from the hub's own page."), security);
    const form = await readForm(req, res);
    if (!form) return;
    const id = form.get("p");
    const p = livePending(id);
    if (!p) return expired(res);
    // A browser that signed in here before: one click, as the person it remembers.
    if (form.get("continue") === "1") {
      const browser = browserOf(req);
      if (!browser) return page(res, 200, pageFor(id!, p), security);
      return complete(id!, p, { person: browser.person, source: browser.source }, res, `this browser, ${browser.via}`);
    }
    // The invite, the way in for someone with no account the hub takes.
    const hub = opts.hub();
    if (hub.turnedAway(address)) return page(res, 429, errorPage("Too many refused tokens from this address. Try again later."), security);
    const entered = (form.get("credential") ?? "").trim();
    const token = parseInvite(entered)?.token ?? (/^[0-9a-f]{64}$/i.test(entered) ? entered.toLowerCase() : "");
    const source = token ? hub.sourceOf(token) : null;
    const person = source ? hub.personOfSource(source) : null;
    if (!source || !person) {
      hub.noteRefusalFrom(address);
      return page(res, 401, pageFor(id!, p, "That invite is not one this hub knows."), security);
    }
    complete(id!, p, { person, source }, res, "invite", rememberBrowser({ person, source }, "an invite"));
  }

  /** GET /login/<provider>?p=<pending>: off to Figma or Google, with our own state and PKCE. */
  function loginStart(res: ServerResponse, provider: Provider, pendingId: string | null): void {
    if (!livePending(pendingId)) return expired(res);
    const state = randomBytes(16).toString("hex");
    const { verifier, challenge } = pkcePair();
    prune(logins);
    logins.set(state, { pending: pendingId!, provider: provider.id, verifier, expiresAt: Date.now() + PENDING_TTL_MS });
    res.writeHead(302, { location: provider.authorizeUrl(callbackOf(provider.id), state, challenge) }).end();
  }

  /** GET /login/<provider>/callback: who signed in, whether they come in, then the app or the plugin. */
  async function loginBack(res: ServerResponse, provider: Provider, params: URLSearchParams): Promise<void> {
    const state = params.get("state") ?? "";
    const login = logins.get(state);
    logins.delete(state);
    if (!login || login.provider !== provider.id || login.expiresAt < Date.now()) return expired(res);
    const p = livePending(login.pending);
    if (!p) return expired(res);
    if (params.get("error") || !params.get("code")) return page(res, 400, errorPage(`The sign-in with ${provider.label} was cancelled.`), security);
    let identity: Identity;
    try {
      identity = await provider.identify(params.get("code")!, callbackOf(provider.id), login.verifier);
    } catch (e) {
      logger.warn(`oauth: ${provider.label} sign-in failed (${e instanceof Error ? e.message : String(e)})`);
      return page(res, 502, errorPage(`${provider.label} did not confirm who signed in. Try again.`), security);
    }
    const who = opts.accounts!.personFor(identity);
    if (!who) {
      logger.info(`oauth: a ${provider.label} account was not admitted`);
      // A plugin waiting on this code hears it at once, instead of when the code expires.
      if (p.kind === "device") {
        const device = devices.get(p.deviceKey);
        if (device) device.denied = true;
      }
      return page(
        res,
        403,
        errorPage(
          `This ${provider.label} account${identity.email ? ` (${identity.email})` : ""} is not on this hub's list: it is by invitation. ` +
            `Ask whoever runs it to add you, or use ${PRODUCT_NAME} on your own computer, free: in the plugin, press "Use ${PRODUCT_NAME} on this computer instead".`,
        ),
        security,
      );
    }
    complete(login.pending, p, who, res, provider.label, rememberBrowser(who, provider.label));
  }

  /** POST /device/code: a plugin starts signing in; it shows the user code and opens /device. */
  function deviceCode(req: IncomingMessage, res: ServerResponse): void {
    const address = clientAddress(req);
    if (opts.hub().turnedAway(address) || !deviceCodes.take(address)) return json(res, 429, { error: "slow_down" });
    const deviceCodeValue = randomBytes(32).toString("hex");
    const code = userCode();
    prune(devices);
    devices.set(sha(deviceCodeValue), { userCode: code, expiresAt: Date.now() + DEVICE_TTL_MS, lastPoll: 0 });
    json(res, 200, {
      device_code: deviceCodeValue,
      user_code: code,
      verification_uri: `${issuer}/device`,
      verification_uri_complete: `${issuer}/device?code=${code}`,
      expires_in: DEVICE_TTL_MS / 1000,
      interval: DEVICE_INTERVAL_S,
    });
  }

  /** GET /device?code=<user code>: the page where the person confirms the code Figma shows and signs in. */
  /** GET /login/switch?p=<pending>: forget this browser, and show the sign-in buttons for the same request. */
  function switchAccount(req: IncomingMessage, res: ServerResponse, pendingId: string | null): void {
    const p = livePending(pendingId);
    if (!p) return expired(res);
    const cookie = new RegExp(`(?:^|;\\s*)${BROWSER_COOKIE}=([0-9a-f]{64})(?:;|$)`).exec(req.headers.cookie ?? "")?.[1];
    if (cookie && stored.browsers?.[sha(cookie)]) {
      delete stored.browsers[sha(cookie)];
      save();
    }
    page(res, 200, pageFor(pendingId!, p), { ...security, "set-cookie": FORGET_BROWSER });
  }

  function devicePage(req: IncomingMessage, res: ServerResponse, params: URLSearchParams): void {
    const code = (params.get("code") ?? "").trim().toUpperCase();
    const key = [...devices].find(([, d]) => d.userCode === code && d.expiresAt > Date.now() && !d.approved)?.[0];
    if (!key) return page(res, 400, errorPage("That code is not one waiting here, or it expired. In Figma, press Sign in again."), security);
    const id = randomBytes(16).toString("hex");
    prune(pendings);
    const p: Pending = { kind: "device", deviceKey: key, userCode: code, expiresAt: devices.get(key)!.expiresAt };
    pendings.set(id, p);
    page(res, 200, pageFor(id, p, "", browserOf(req)), security);
  }

  /** POST /device/token: the plugin asks, every few seconds, whether the person signed in; then gets its credential, once. */
  async function deviceToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req, res);
    if (!form) return;
    const key = sha(form.get("device_code") ?? "");
    const device = devices.get(key);
    if (!device) return json(res, 400, { error: "invalid_grant" });
    if (device.expiresAt < Date.now()) {
      devices.delete(key);
      return json(res, 400, { error: "expired_token" });
    }
    if (Date.now() - device.lastPoll < DEVICE_INTERVAL_S * 1000 - 500) return json(res, 400, { error: "slow_down" });
    device.lastPoll = Date.now();
    if (device.denied) {
      devices.delete(key);
      return json(res, 400, { error: "access_denied" });
    }
    if (!device.approved) return json(res, 400, { error: "authorization_pending" });
    devices.delete(key);
    const credential = randomBytes(32).toString("hex");
    stored.devices = { ...(stored.devices ?? {}), [sha(credential)]: { ...device.approved, createdAt: Date.now() } };
    save();
    json(res, 200, { token: credential, person: device.approved.person });
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req, res);
    if (!form) return;
    const clientId = form.get("client_id") ?? "";
    const grantType = form.get("grant_type");
    const asked = form.get("resource");
    if (asked !== null && !sameResource(asked, resource, issuer)) return json(res, 400, { error: "invalid_target" });
    if (grantType === "authorization_code") {
      const key = sha(form.get("code") ?? "");
      const code = codes.get(key);
      codes.delete(key); // one use, whatever happens next
      const verifier = form.get("code_verifier") ?? "";
      if (
        !code ||
        !live(code) ||
        code.clientId !== clientId ||
        code.redirectUri !== form.get("redirect_uri") ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        b64url(createHash("sha256").update(verifier).digest()) !== code.challenge
      ) {
        return json(res, 400, { error: "invalid_grant" });
      }
      return json(res, 200, issue({ person: code.person, source: code.source, clientId }));
    }
    if (grantType === "refresh_token") {
      const key = sha(form.get("refresh_token") ?? "");
      const grant = stored.refresh[key];
      if (!live(grant) || grant.clientId !== clientId) return json(res, 400, { error: "invalid_grant" });
      delete stored.refresh[key]; // rotated: the old one is spent
      return json(res, 200, issue({ person: grant.person, source: grant.source, clientId }));
    }
    json(res, 400, { error: "unsupported_grant_type" });
  }

  return {
    resourceMetadata,
    verify(accessToken) {
      const g = access.get(sha(accessToken));
      if (!live(g)) return null;
      return { person: g.person, source: g.source };
    },
    credentialSource(hashHex) {
      const d = stored.devices?.[hashHex];
      return d && opts.hub().personOfSource(d.source) === d.person ? d.source : null;
    },
    async handle(req, res, p) {
      const url = new URL(req.url ?? "/", issuer);
      const login = /^\/login\/(figma|google)(\/callback)?$/.exec(p);
      if (login && req.method === "GET") {
        const provider = providers.find((x) => x.id === login[1]);
        if (!provider) return false;
        if (login[2]) await loginBack(res, provider, url.searchParams);
        else loginStart(res, provider, url.searchParams.get("p"));
        return true;
      }
      if (p === "/device" && req.method === "GET") return devicePage(req, res, url.searchParams), true;
      if (p === "/login/switch" && req.method === "GET") return switchAccount(req, res, url.searchParams.get("p")), true;
      // The plugin's window calls these from its own origin ("null"), as the token endpoint is called by apps.
      const cors = p.startsWith("/.well-known/") || p === "/register" || p === "/token" || p === "/device/code" || p === "/device/token";
      if (cors) {
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-allow-headers", "content-type, authorization, mcp-protocol-version");
        if (req.method === "OPTIONS") return res.writeHead(204).end(), true;
      }
      if (req.method === "GET" && (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp")) {
        json(res, 200, { resource, authorization_servers: [issuer], bearer_methods_supported: ["header"], resource_name: PRODUCT_NAME });
        return true;
      }
      if (req.method === "GET" && p === "/.well-known/oauth-authorization-server") {
        json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        });
        return true;
      }
      if (p === "/register" && req.method === "POST") return await register(req, res), true;
      if (p === "/authorize") return await authorize(req, res), true;
      if (p === "/token" && req.method === "POST") return await token(req, res), true;
      if (p === "/device/code" && req.method === "POST") return deviceCode(req, res), true;
      if (p === "/device/token" && req.method === "POST") return await deviceToken(req, res), true;
      return false;
    },
  };
}

/** https anywhere, or http on this computer only: what a redirect may point to [C-414]. */
export function validRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

/** The resource a client named is this server's /mcp, or the server itself, whatever the case of scheme and host. */
function sameResource(asked: string, resource: string, issuer: string): boolean {
  const norm = (s: string) => {
    try {
      const u = new URL(s);
      return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
    } catch {
      return "";
    }
  };
  const n = norm(asked);
  return n !== "" && (n === norm(resource) || n === norm(issuer));
}

function load(path: string): Stored {
  if (!existsSync(path)) return { v: 1, clients: {}, refresh: {} };
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<Stored>;
    return { v: 1, clients: s.clients ?? {}, refresh: s.refresh ?? {} };
  } catch {
    return { v: 1, clients: {}, refresh: {} };
  }
}

/** An address on the public internet: never this machine, a private network, link-local or the cloud metadata service. */
export function isPublicAddress(address: string): boolean {
  const a = address.replace(/^::ffff:/i, "").toLowerCase();
  if (isIP(a) === 4) {
    const [x, y, z] = a.split(".").map(Number) as [number, number, number];
    return !(
      x === 0 ||
      x === 10 ||
      x === 127 ||
      (x === 100 && y >= 64 && y <= 127) || // shared address space (carrier NAT)
      (x === 169 && y === 254) || // link-local, and the cloud metadata service
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 192 && y === 0 && (z === 0 || z === 2)) || // IETF protocol assignments, documentation
      (x === 198 && (y === 18 || y === 19)) || // benchmarking
      (x === 198 && y === 51 && z === 100) ||
      (x === 203 && y === 0 && z === 113) ||
      x >= 224
    );
  }
  if (isIP(a) === 6) {
    // Loopback, unspecified, unique-local, link-local, multicast; and the ranges that carry an IPv4
    // address inside (IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16), which could reach
    // a private IPv4 address through a translator; documentation and discard prefixes.
    return !(
      a === "::" ||
      a === "::1" ||
      a.includes(".") ||
      /^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a) ||
      /^64:ff9b:/.test(a) ||
      /^2002:/.test(a) ||
      /^2001:db8:/.test(a) ||
      /^100::/.test(a) ||
      /^f[cd]/.test(a) ||
      /^fe[89ab]/.test(a) ||
      /^ff/.test(a)
    );
  }
  return false;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;

/**
 * A DNS lookup for a connection that may reach public addresses only: every
 * address a name resolves to must be public, or the connection fails. It
 * answers in the form it is asked for: one address, or with `all` (as Node's
 * connection racing asks) the list. Answering one address to a request for all
 * failed every fetch with "Invalid IP address: undefined" (claude.ai, 2026-10-22).
 */
export function publicOnlyLookup(
  resolveAll: (host: string) => Promise<Array<{ address: string; family: number }>> = (host) => lookup(host, { all: true }),
): (host: string, options: { all?: boolean } | number | undefined, cb: LookupCallback) => void {
  return (host, options, cb) => {
    const all = typeof options === "object" && options?.all === true;
    resolveAll(host)
      .then((found) => {
        if (found.length === 0 || !found.every((a) => isPublicAddress(a.address))) return cb(new Error(`${host} is not a public address`), all ? [] : "", 4);
        if (all) return cb(null, found);
        cb(null, found[0]!.address, found[0]!.family);
      })
      .catch((e: NodeJS.ErrnoException) => cb(e, all ? [] : "", 4));
  };
}

/**
 * Fetches a Client ID Metadata Document [C-414]: https only, no redirects, at
 * most 64 KB in 5 s, and only from a public address, checked when the
 * connection is made, so a name that resolves to this server's network is
 * refused (server-side request forgery).
 */
function fetchClientDocument(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        headers: { accept: "application/json" },
        timeout: 5000,
        lookup: publicOnlyLookup(),
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > CIMD_MAX_BYTES) {
            req.destroy();
            reject(new Error("too large"));
          } else chunks.push(c);
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("not JSON"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function page(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers }).end(html);
}

/** A body of at most 64 KB; null, with `413` already sent, when it is larger. */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  const limit = 64 * 1024;
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        if (!res.headersSent) res.writeHead(413, { "content-type": "text/plain" }).end("Too large.\n");
        req.destroy();
        done(null);
      } else chunks.push(c);
    });
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", () => done(null));
  });
}

/** A form body, or null with the answer already sent. */
async function readForm(req: IncomingMessage, res: ServerResponse): Promise<URLSearchParams | null> {
  const body = await readBody(req, res);
  return body === null ? null : new URLSearchParams(body.toString("utf8"));
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const body = await readBody(req, res);
  try {
    return body ? (JSON.parse(body.toString("utf8")) as unknown) : null;
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
  :root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --text: #1d1d1b; --muted: #666; --line: #ddd; --brand: #0d63d6; --bad: #c62828; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #1f1f1d; --text: #ecece8; --muted: #a3a39e; --line: #3a3a37; --brand: #5aa0ff; --bad: #ff7a70; } }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 16px; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; } p { margin: 0 0 12px; } .muted { color: var(--muted); font-size: 13px; }
  .host { font-weight: 600; } .bad { color: var(--bad); }
  .back { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; }
  .where { font-size: 18px; font-weight: 700; word-break: break-all; }
  label { display: block; font-weight: 600; margin: 16px 0 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px; font: inherit; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
  button { margin-top: 16px; width: 100%; padding: 10px; font: inherit; font-weight: 600; border: 0; border-radius: 8px; background: var(--brand); color: #fff; cursor: pointer; }
  a.button { display: block; margin-top: 10px; padding: 11px; text-align: center; font-weight: 600; border-radius: 8px; text-decoration: none; border: 1px solid var(--line); color: var(--text); background: var(--card); }
  a.button.figma { background: var(--text); color: var(--card); border-color: var(--text); }
  details { margin-top: 16px; } summary { cursor: pointer; color: var(--muted); font-size: 14px; }`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function errorPage(message: string): string {
  return shell(`${PRODUCT_NAME}: sign-in`, `<h1>Cannot sign in</h1><p class="bad">${esc(message)}</p><p class="muted">Close this page and connect the app again.</p>`);
}

function donePage(message: string): string {
  return shell(`${PRODUCT_NAME}: signed in`, `<h1>Done</h1><p>${esc(message)}</p>`);
}

/**
 * The sign-in page: for an app, which app and where it returns; for a plugin,
 * the code Figma shows. Then the accounts this hub takes, and the invite.
 */
function signInPage(o: {
  pendingId: string;
  providers: readonly Provider[];
  error: string;
  app?: { client: Client; redirectUri: string };
  deviceCode?: string;
  /** This browser signed in here before: one click instead of a second sign-in. */
  signedInAs?: { person: string; via: string };
}): string {
  let intro: string;
  if (o.app) {
    const back = new URL(o.app.redirectUri);
    const local = back.protocol === "http:";
    // A self-registered app names itself: the name is a claim, the return address is what the hub checks.
    const named = o.app.client.client_id.startsWith("https://") ? `known by ${new URL(o.app.client.client_id).host}` : "its own name, unchecked";
    intro = `<h1>Sign in to ${PRODUCT_NAME}</h1>
<p><span class="host">${esc(o.app.client.client_name)}</span> <span class="muted">(${esc(named)})</span> wants to use your Figma through this team's hub, as you.</p>
<div class="back"><span class="muted">After you sign in, you go to</span><br><span class="where">${esc(back.host)}</span>${local ? `<br><span class="muted">a program on your own computer</span>` : ""}</div>
<p class="muted">Continue only if you started this from that app, at that address.</p>`;
  } else {
    intro = `<h1>Connect ${PRODUCT_NAME} in Figma</h1>
<p>Check that the ${PRODUCT_NAME} plugin in Figma shows this code:</p>
<div class="back"><span class="where">${esc(o.deviceCode ?? "")}</span></div>
<p class="muted">Continue only if it does, and you pressed Sign in there yourself.</p>`;
  }
  const buttons = o.providers.map((p) => `<a class="button ${p.id}" href="/login/${p.id}?p=${o.pendingId}">Continue with ${esc(p.label)}</a>`).join("\n");
  const invite = `<form method="post" action="/authorize" autocomplete="off"><input type="hidden" name="p" value="${o.pendingId}">
<label for="credential">Your invite</label>
<input id="credential" name="credential" type="password" required spellcheck="false" placeholder="wss://…#…">
<button type="submit">Continue with the invite</button>
</form>
<p class="muted">Whoever runs the hub may have given you an invite. It is never shown to the app.</p>`;
  if (o.signedInAs) {
    return shell(
      `${PRODUCT_NAME}: sign in`,
      `${intro}
<form method="post" action="/authorize"><input type="hidden" name="p" value="${o.pendingId}"><input type="hidden" name="continue" value="1">
<button type="submit">Continue as ${esc(o.signedInAs.person)}</button>
</form>
<p class="muted">Signed in on this browser with ${esc(o.signedInAs.via)}. <a href="/login/switch?p=${o.pendingId}">Use another account</a></p>`,
    );
  }
  return shell(
    `${PRODUCT_NAME}: sign in`,
    `${intro}
${o.error ? `<p class="bad">${esc(o.error)}</p>` : ""}
${buttons}
${o.providers.length ? `<details${o.error ? " open" : ""}><summary>Use an invite instead</summary>${invite}</details>` : invite}`,
  );
}
