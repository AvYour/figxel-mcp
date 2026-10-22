// A team's hub (docs/superpowers/plans/2026-10-22-cloud-bridge.md): the
// people table, and `figxel-mcp hub`, which runs the bridge on a server as a
// pure relay. The table keeps each token's SHA-256 only: a token is printed
// once, when a person is added, and is never written to the server's disk.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { Bridge, tokenHashHex } from "./bridge.js";
import type { Config, Logger } from "./config.js";
import { figmaProvider, googleAdmits, googleProvider, type Identity, type ProviderId } from "./login.js";
import { createWebEndpoint, type WebEndpoint, type WebOptions } from "./web.js";

export const PEOPLE_FILE = "hub-people.json";

/** A name: lowercase letters, digits, dot, dash and underscore, starting with a letter or digit. */
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export interface PersonRecord {
  person: string;
  /** SHA-256 of the person's token, hex. A person who signs in with an account still has one, never shown. */
  hash: string;
  addedAt: string;
  /** Their email, so a sign-in with an account of that verified email is this person (login.ts). */
  email?: string;
  /** The accounts they signed in with: provider and that provider's stable id for them. */
  logins?: Array<{ provider: ProviderId; subject: string }>;
}

interface PeopleFile {
  v: 1;
  people: PersonRecord[];
}

export const peoplePath = (home: string): string => join(home, PEOPLE_FILE);

/** The table, or an empty one when the file does not exist yet. */
export function readPeople(path: string): PersonRecord[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PeopleFile>;
  if (parsed.v !== 1 || !Array.isArray(parsed.people)) throw new Error(`${path} is not a ${PEOPLE_FILE} this version reads.`);
  return parsed.people.filter((p) => typeof p.person === "string" && /^[0-9a-f]{64}$/.test(String(p.hash)));
}

/** Written whole, readable by its owner only, through a temporary file, so a running hub never reads half of it. */
function writePeople(path: string, people: PersonRecord[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, people } satisfies PeopleFile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Adds a person and returns their new token, which is shown once and kept nowhere. With an email, a sign-in with that verified email is them too. */
export function addPerson(path: string, person: string, now = new Date(), email?: string): string {
  if (!NAME_RE.test(person)) throw new Error(`"${person}" is not a name the table takes: lowercase letters, digits, ".", "-" and "_", up to 40.`);
  if (email !== undefined && !EMAIL_RE.test(email)) throw new Error(`"${email}" is not an email address.`);
  const people = readPeople(path);
  if (people.some((p) => p.person === person)) throw new Error(`"${person}" is already in the table. Remove them first to issue a new token.`);
  if (email && people.some((p) => p.email === email.toLowerCase())) throw new Error(`${email} already belongs to someone in the table.`);
  const token = randomBytes(32).toString("hex");
  writePeople(path, [...people, { person, hash: tokenHashHex(token), addedAt: now.toISOString(), ...(email ? { email: email.toLowerCase() } : {}) }]);
  return token;
}

/** Sets a person's email: a sign-in with that verified email is them from now on. */
export function setEmail(path: string, person: string, email: string): void {
  if (!EMAIL_RE.test(email)) throw new Error(`"${email}" is not an email address.`);
  const people = readPeople(path);
  if (!people.some((p) => p.person === person)) throw new Error(`"${person}" is not in the table.`);
  if (people.some((p) => p.person !== person && p.email === email.toLowerCase())) throw new Error(`${email} already belongs to someone else in the table.`);
  writePeople(path, people.map((p) => (p.person === person ? { ...p, email: email.toLowerCase() } : p)));
}

/**
 * The person an account signs in as: the one it signed in as before; else the
 * one whose email it verifiably has (and the account is linked to them); else,
 * when `admitNew`, a new person named after the account, with a token nobody
 * sees. Null when the account is not admitted. The source is their table
 * entry's hash, what every grant stands for (oauth.ts); `changed` when the
 * table was written (a person added, or an account linked).
 */
export function personForLogin(path: string, identity: Identity, admitNew: boolean, now = new Date()): { person: string; source: string; changed: boolean } | null {
  const people = readPeople(path);
  const login = { provider: identity.provider, subject: identity.subject };
  const linked = people.find((p) => p.logins?.some((l) => l.provider === login.provider && l.subject === login.subject));
  if (linked) return { person: linked.person, source: linked.hash, changed: false };
  const email = identity.emailVerified && identity.email ? identity.email.toLowerCase() : null;
  const byEmail = email ? people.find((p) => p.email === email) : undefined;
  if (byEmail) {
    writePeople(path, people.map((p) => (p === byEmail ? { ...p, logins: [...(p.logins ?? []), login] } : p)));
    return { person: byEmail.person, source: byEmail.hash, changed: true };
  }
  if (!admitNew) return null;
  const base = nameFor(identity);
  let person = base;
  for (let i = 2; people.some((p) => p.person === person); i++) person = `${base.slice(0, 36)}-${i}`;
  const record: PersonRecord = {
    person,
    hash: tokenHashHex(randomBytes(32).toString("hex")), // the account is how they sign in; this token is never shown
    addedAt: now.toISOString(),
    ...(email ? { email } : {}),
    logins: [login],
  };
  writePeople(path, [...people, record]);
  return { person, source: record.hash, changed: true };
}

/** A table name from the account: the email's local part, else the name, made to fit NAME_RE. */
function nameFor(identity: Identity): string {
  const raw = (identity.email?.split("@")[0] ?? identity.name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);
  return NAME_RE.test(raw) ? raw : `${identity.provider}-${identity.subject.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase() || "user"}`;
}

/** Removes a person; a running hub closes their connections when it reads the file again. */
export function removePerson(path: string, person: string): void {
  const people = readPeople(path);
  if (!people.some((p) => p.person === person)) throw new Error(`"${person}" is not in the table.`);
  writePeople(path, people.filter((p) => p.person !== person));
}

/**
 * `figxel-mcp hub`: the bridge alone, on loopback behind the server's proxy
 * (Caddy). It registers no tools and has no stdio transport, so it never writes
 * a file: tools and files stay with each person's own process. Its own token is
 * random and in no table, so the hub itself reaches no one's Figma. The table
 * is read again when it changes; a removed person's connections close at once.
 */
export async function runHub(
  config: Config,
  logger: Logger,
  deps: {
    createApp?: WebOptions["createApp"];
    createAgentState?: WebOptions["createAgentState"];
    web?: Partial<Pick<WebOptions, "fileTtlMs" | "sessionIdleMs" | "fetchClientDocument">>;
    /** Tests stand in for Figma's and Google's endpoints. */
    fetchProvider?: typeof fetch;
  } = {},
): Promise<{ bridge: Bridge; web: WebEndpoint | null; stop: () => Promise<void> }> {
  const path = peoplePath(config.home);
  const people = readPeople(path);
  if (people.length === 0) logger.warn(`the table ${path} is empty: add a person with \`hub add <name>\`; the hub reads it again when it changes`);
  // BRIDGE_HUB_WEB: MCP over HTTP for web clients, on the same port (web.ts). Its sessions run tools, the hub itself none.
  let bridge: Bridge | null = null;
  // Sign-in with an account (login.ts): a Figma app admits its own team, Google the listed emails, or anyone when open.
  const providers = [
    ...(config.hubFigma ? [figmaProvider(config.hubFigma.clientId, config.hubFigma.clientSecret, deps.fetchProvider)] : []),
    ...(config.hubGoogle ? [googleProvider(config.hubGoogle.clientId, config.hubGoogle.clientSecret, deps.fetchProvider)] : []),
  ];
  const accounts = providers.length
    ? {
        providers,
        personFor: (identity: Identity) => {
          const admitNew = identity.provider === "figma" || config.hubSignup === "open" || googleAdmits(identity, config.hubGoogleAllow, false);
          const found = personForLogin(path, identity, admitNew);
          if (found?.changed) bridge!.setPeople(readPeople(path)); // at once, not when the file watcher next looks
          return found;
        },
      }
    : undefined;
  const web =
    config.hubWeb && deps.createApp
      ? createWebEndpoint({
          config,
          logger,
          hub: () => bridge!,
          createApp: deps.createApp,
          ...(deps.createAgentState ? { createAgentState: deps.createAgentState } : {}),
          ...deps.web,
          ...(accounts ? { accounts } : {}),
        })
      : null;
  bridge = new Bridge({
    token: randomBytes(32).toString("hex"),
    logger,
    port: config.port,
    sessionWaitMs: config.sessionWaitMs,
    conflicts: config.conflicts,
    people,
    bindHost: config.hubBind,
    ...(web ? { httpHandler: (req, res) => web.handle(req, res), credentialSource: (hashHex: string) => web.credentialSource(hashHex) } : {}),
  });
  const hub = bridge;
  await hub.start();
  if (hub.role !== "hub") {
    await web?.close();
    await hub.close();
    throw new Error(`port ${config.port} is taken: stop what holds it, or set BRIDGE_PORT.`);
  }
  logger.info(`hub: ${people.length} person(s) in ${path}, listening on ${config.hubBind}:${hub.port}${web ? `; web clients at ${config.hubPublicUrl?.replace(/^ws/, "http")}/mcp` : ""}`);
  if (web) logger.info(`hub: sign-in with ${[...providers.map((p) => p.label), "an invite"].join(", ")}${config.hubSignup === "open" ? "; sign-up open to any Google account" : ""}`);
  const reload = (now: Stats, before: Stats) => {
    if (now.mtimeMs === 0 && before.mtimeMs === 0) return; // still no file: nothing changed
    try {
      const next = readPeople(path);
      hub.setPeople(next);
      logger.info(`hub: the table changed, ${next.length} person(s) now`);
    } catch (e) {
      logger.warn(`hub: could not read ${path} (${e instanceof Error ? e.message : String(e)}); the table in use stays`);
    }
  };
  watchFile(path, { interval: 2000 }, reload);
  return {
    bridge: hub,
    web,
    stop: async () => {
      unwatchFile(path, reload);
      await web?.close();
      await hub.close();
    },
  };
}
