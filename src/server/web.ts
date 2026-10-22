// The web endpoint of a team's hub (cloud bridge plan, Phase B): MCP over
// Streamable HTTP at /mcp, for clients with no process on the person's
// computer (claude.ai, and Cursor, VS Code or Claude Code by URL) [C-406].
//
// Sign-in is the person's own token as `Authorization: Bearer`, on every
// request. Each MCP session is a person's server process in miniature: the
// same tools (createApp), with a Bridge that joins this hub over loopback with
// that token, so the hub's isolation between persons applies unchanged.
//
// A web client has no disk here, so the files its tools write go to the
// person's folder on the server (<home>/web/<person>), the only folder its
// tools may read or write, and come back as short-lived download links under
// /files. A file can be uploaded there first, to import it.

import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { clientAddress, type Bridge } from "./bridge.js";
import type { Config, Logger } from "./config.js";
import type { AgentState, App } from "./mcp.js";
import { ICON_PNG, ICON_SVG } from "./icons.js";
import { createOAuth, type OAuthOptions } from "./oauth.js";

/** How long a download link, and the file behind it, lasts. */
export const FILE_TTL_MS = 60 * 60_000;
/** A web session nobody used for this long is closed: its Bridge and tools go with it. */
export const SESSION_IDLE_MS = 30 * 60_000;
/** At most this many open web sessions per person; a new one closes the oldest. */
const SESSIONS_PER_PERSON = 8;
/** The largest MCP message and the largest upload a web client may send. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const ICONS: Record<string, [string, Buffer]> = {
  "/favicon.ico": ["image/png", ICON_PNG],
  "/icon.png": ["image/png", ICON_PNG],
  "/apple-touch-icon.png": ["image/png", ICON_PNG],
  "/favicon.svg": ["image/svg+xml", Buffer.from(ICON_SVG)],
};

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".wav": "audio/wav",
  ".json": "application/json",
};

export interface WebOptions {
  /** The hub's configuration: its home, port and public address. */
  config: Config;
  logger: Logger;
  /** The hub, once it listens: who a token names, its port, and its limit on refused tokens. */
  hub: () => Bridge;
  /** Builds one session's tools (mcp.ts createApp), passed in so web.ts does not import mcp.ts at run time. */
  createApp: (config: Config, token: string, logger: Logger, bridgeOverrides?: object, shared?: AgentState) => Promise<App>;
  /** Builds a person's agent state (mcp.ts createAgentState), shared by their sessions. Without it, each session has its own. */
  createAgentState?: (config: Config, token: string, logger: Logger) => Promise<AgentState>;
  /** Tests shorten these. */
  fileTtlMs?: number;
  sessionIdleMs?: number;
  /** Tests pass their own; the real one fetches only from public addresses (oauth.ts). */
  fetchClientDocument?: OAuthOptions["fetchClientDocument"];
  /** Sign-in with Figma or Google (login.ts, hub.ts): passed on to OAuth. */
  accounts?: OAuthOptions["accounts"];
}

interface WebSession {
  id: string;
  person: string;
  /** The table entry (hash, hex) of the person who opened it: every request on it must be theirs. */
  source: string;
  app: App;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
}

/** A person's agent on the hub, shared by their web sessions (agentFor). */
interface PersonAgent {
  person: string;
  source: string;
  /** Its own credential to the hub (Bridge.sessionToken), released when the agent closes. */
  internal: string;
  exportDir: string;
  config: Config;
  /** The shared bridge, ledger, processes and renders; null when no createAgentState was given (each session has its own). */
  state: AgentState | null;
  sessions: number;
  lastUsed: number;
}

interface Link {
  /** The real path, resolved when the link was made. */
  file: string;
  /** The person's folder it must still be in when it is served. */
  folder: string;
  expiresAt: number;
}

/** The real path of `candidate` when it is a file inside `folder`, after `..` and symbolic links are resolved; else null. */
async function insideFolder(candidate: string, folder: string): Promise<string | null> {
  const [real, root] = await Promise.all([realpath(resolve(candidate)).catch(() => null), realpath(folder).catch(() => null)]);
  if (!real || !root) return null;
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return (await stat(real).catch(() => null))?.isFile() ? real : null;
}

export interface WebEndpoint {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
  /** Open web sessions, for tests and the hub's log. */
  readonly sessions: number;
  /** A plugin credential from the browser sign-in: the table entry it stands for (oauth.ts). */
  credentialSource(hashHex: string): string | null;
}

export function createWebEndpoint(opts: WebOptions): WebEndpoint {
  const { config, logger } = opts;
  if (!config.hubPublicUrl) throw new Error("BRIDGE_HUB_WEB needs BRIDGE_HUB_PUBLIC_URL: download links are made from it.");
  const base = config.hubPublicUrl.replace(/^ws/, "http"); // wss:// → https://, ws:// (tests) → http://
  const fileTtl = opts.fileTtlMs ?? FILE_TTL_MS;
  const idle = opts.sessionIdleMs ?? SESSION_IDLE_MS;
  const webRoot = resolve(config.home, "web");
  const sessions = new Map<string, WebSession>();
  const agents = new Map<string, PersonAgent>();
  const startingAgents = new Map<string, Promise<PersonAgent | null>>();
  const links = new Map<string, Link>();
  // Each session's own logger: its Bridge and tools say little; the hub's log names the person.
  const sessionLogger: Logger = { ...logger, debug: () => {}, info: () => {} };

  const folderOf = (person: string) => join(webRoot, person);
  // OAuth for clients that accept nothing else (oauth.ts): this hub is its own authorization server.
  const oauth = createOAuth({
    issuer: base,
    home: config.home,
    logger,
    hub: opts.hub,
    redirectHosts: config.hubRedirectHosts,
    ...(opts.accounts ? { accounts: opts.accounts } : {}),
    ...(opts.fetchClientDocument ? { fetchClientDocument: opts.fetchClientDocument } : {}),
  });

  /** The person behind a bearer token, or an answer already sent (401, or turned away). */
  /**
   * The person behind a bearer credential, or an answer already sent (401, or
   * turned away). The credential is the person's own token, or an access token
   * this hub's OAuth issued (oauth.ts); either stands for their table entry.
   */
  function signIn(req: IncomingMessage, res: ServerResponse): { person: string; source: string } | null {
    const hub = opts.hub();
    const address = clientAddress(req);
    if (hub.turnedAway(address)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "900" }).end(JSON.stringify({ error: "Too many refused tokens from this address; try again later." }));
      return null;
    }
    const credential = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];
    let who: { person: string; source: string } | null = null;
    if (credential && /^[0-9a-f]{64}$/i.test(credential)) {
      const source = hub.sourceOf(credential.toLowerCase());
      const person = source ? hub.personOfSource(source) : null;
      if (source && person) who = { person, source };
    } else if (credential?.startsWith("fxa_")) {
      who = oauth.verify(credential);
    }
    if (!who) {
      if (credential) hub.noteRefusalFrom(address);
      // Where to sign in with OAuth [C-414]; a client with a fixed header never needs it.
      const challenge = `Bearer realm="figxel", resource_metadata="${oauth.resourceMetadata}"${credential ? ', error="invalid_token"' : ""}`;
      res
        .writeHead(401, { "content-type": "application/json", "www-authenticate": challenge })
        .end(JSON.stringify({ error: "Sign in: Authorization: Bearer <your token for this hub>, or with OAuth." }));
      return null;
    }
    return who;
  }

  /** A web session's configuration: the person's folder only, and this hub over loopback as the person. */
  const configFor = (exportDir: string, internal: string): Config => ({
    ...config,
    // Its tools read and write this folder only: never the hub's table, never another person's files.
    exportDir,
    exportRoots: [],
    hubUrl: `ws://127.0.0.1:${opts.hub().port}`,
    hubFrom: "env",
    hubToken: internal,
    hubTokenFrom: null,
    allowEval: false,
    hubWeb: false,
    webMode: true,
  });

  /**
   * The person's agent: one bridge, one ledger of the guides read, one motion
   * and role process, one store of renders, for all their web sessions. A
   * client such as ChatGPT opens a new MCP session for nearly every call; a
   * guide read in one must still count in the next.
   */
  async function agentFor(person: string, source: string): Promise<PersonAgent | null> {
    const known = agents.get(source);
    if (known) return known;
    const starting = startingAgents.get(source);
    if (starting) return starting;
    const start = (async (): Promise<PersonAgent | null> => {
      const exportDir = folderOf(person);
      await mkdir(exportDir, { recursive: true });
      // Its own credential to the hub, standing for the person's table entry: never the person's token.
      const internal = opts.hub().sessionToken(source);
      if (internal === null) return null;
      const cfg = configFor(exportDir, internal);
      const state = opts.createAgentState ? await opts.createAgentState(cfg, internal, sessionLogger) : null;
      const agent: PersonAgent = { person, source, internal, exportDir, config: cfg, state, sessions: 0, lastUsed: Date.now() };
      agents.set(source, agent);
      return agent;
    })().finally(() => startingAgents.delete(source));
    startingAgents.set(source, start);
    return start;
  }

  async function closeAgent(agent: PersonAgent, why: string): Promise<void> {
    agents.delete(agent.source);
    await agent.state?.bridge.close().catch(() => {});
    opts.hub().releaseSessionToken(agent.internal);
    logger.info(`web: ${agent.person}'s agent closed (${why})`);
  }

  async function openSession(person: string, source: string): Promise<WebSession | null> {
    const agent = await agentFor(person, source);
    if (!agent) return null;
    const app = await opts.createApp(agent.config, agent.internal, sessionLogger, {}, agent.state ?? undefined);
    const session = {} as WebSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        Object.assign(session, { id, person, source, app, transport, lastUsed: Date.now() });
        sessions.set(id, session);
        agent.sessions++;
        trimSessions(person);
        logger.info(`web: ${person} opened a session (${sessions.size} open)`);
      },
      onsessionclosed: (id) => void closeSession(id, "closed by the client"),
    });
    // Files a tool wrote leave as links: every result is read on its way out.
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => send(await withDownloads(message, agent.exportDir), options);
    await app.server.connect(transport);
    return Object.assign(session, { person, source, app, transport, lastUsed: Date.now() });
  }

  async function closeSession(id: string, why: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.transport.close().catch(() => {});
    await s.app.close().catch(() => {});
    const agent = agents.get(s.source);
    if (agent) {
      agent.sessions = Math.max(0, agent.sessions - 1);
      agent.lastUsed = Date.now();
      // Without a shared state the session's own bridge closed with it, and so does its credential.
      if (!agent.state && agent.sessions === 0) await closeAgent(agent, "its last session ended");
    }
    logger.info(`web: ${s.person}'s session ended (${why}), ${sessions.size} open`);
  }

  function trimSessions(person: string): void {
    const mine = [...sessions.values()].filter((s) => s.person === person).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const s of mine.slice(0, Math.max(0, mine.length - SESSIONS_PER_PERSON))) void closeSession(s.id, "too many open sessions");
  }

  /** Adds `downloads` (a link per file in the person's folder) to a tool's result. */
  async function withDownloads(message: JSONRPCMessage, folder: string): Promise<JSONRPCMessage> {
    const result = (message as { result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> } }).result;
    if (!result?.content) return message;
    const candidates = new Set<string>();
    const collect = (v: unknown): void => {
      if (typeof v === "string") {
        if (v.startsWith(folder + sep)) candidates.add(v);
      } else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
    };
    collect(result.structuredContent);
    for (const c of result.content) {
      if (c.type !== "text" || c.text === undefined) continue;
      try {
        collect(JSON.parse(c.text));
      } catch {
        for (const m of c.text.matchAll(/(\S+)/g)) collect(m[1]!.replace(/[",.;:)\]]+$/, ""));
      }
    }
    // A string in a result is text the person may have written (a layer's name): only a file that
    // really is in their folder, once `..` and links are resolved, gets a link.
    const files = new Map<string, string>();
    for (const candidate of candidates) {
      const real = await insideFolder(candidate, folder);
      if (real) files.set(candidate, real);
    }
    if (files.size === 0) return message;
    const expiresAt = Date.now() + fileTtl;
    const downloads = [...files].map(([shown, file]) => {
      const id = randomBytes(16).toString("hex");
      links.set(id, { file, folder, expiresAt });
      return { path: shown, url: `${base}/files/${id}/${encodeURIComponent(basename(file))}`, expiresAt: new Date(expiresAt).toISOString() };
    });
    const content = result.content.map((c) => {
      if (c.type !== "text" || c.text === undefined) return c;
      try {
        const parsed = JSON.parse(c.text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ...c, text: JSON.stringify({ ...parsed, downloads }, null, 2) };
      } catch {
        // Not JSON: the links go below the text.
      }
      return { ...c, text: `${c.text}\n\nDownloads (until ${downloads[0]!.expiresAt}):\n${downloads.map((d) => d.url).join("\n")}` };
    });
    const structuredContent = result.structuredContent ? { ...result.structuredContent, downloads } : undefined;
    return { ...message, result: { ...result, content, ...(structuredContent ? { structuredContent } : {}) } } as JSONRPCMessage;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const who = signIn(req, res);
    if (!who) return;
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const s = sessions.get(sessionId);
      // Another person's session id, with this token, is a session that does not exist.
      if (!s || s.source !== who.source) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }
      s.lastUsed = Date.now();
      const body = req.method === "POST" ? await readJson(req, res) : undefined;
      if (body === null) return;
      await s.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no session; start with initialize" }, id: null }));
      return;
    }
    const body = await readJson(req, res);
    if (body === null) return;
    if (!isInitializeRequest(body)) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no session; start with initialize" }, id: null }));
      return;
    }
    const s = await openSession(who.person, who.source);
    if (!s) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "This person is no longer in the hub's table." }));
      return;
    }
    await s.transport.handleRequest(req, res, body);
    // An initialize the transport refused leaves no session behind, and no Bridge.
    if (!s.id || !sessions.has(s.id)) await s.app.close().catch(() => {});
  }

  async function handleFiles(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method === "POST" && path === "/files") return upload(req, res);
    const m = /^\/files\/([0-9a-f]{32})\/[^/]+$/.exec(path);
    const link = m ? links.get(m[1]!) : undefined;
    if (req.method !== "GET" || !link || link.expiresAt < Date.now()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("This link has expired, or never existed.\n");
      return;
    }
    // Checked again when served: a link names a file in the person's folder, or nothing.
    const file = await insideFolder(link.file, link.folder);
    const info = file ? await stat(file).catch(() => null) : null;
    if (!file || !info?.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("This file is gone.\n");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(info.size),
      "content-disposition": `inline; filename="${basename(file).replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
    });
    createReadStream(file).pipe(res);
  }

  /** POST /files?name=<file name>, signed in: the body is saved in the person's folder, for an import by `path`. */
  async function upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const who = signIn(req, res);
    if (!who) return;
    const raw = new URL(req.url ?? "/", "http://hub").searchParams.get("name") ?? "upload";
    const name = basename(raw).replace(/[^\w.-]+/g, "_").slice(-80) || "upload";
    const bytes = await readBody(req, res, MAX_UPLOAD_BYTES);
    if (bytes === null) return;
    const relative = `uploads/${randomBytes(4).toString("hex")}-${name}`;
    const file = join(folderOf(who.person), relative);
    await mkdir(join(folderOf(who.person), "uploads"), { recursive: true });
    await writeFile(file, bytes);
    res
      .writeHead(201, { "content-type": "application/json" })
      .end(JSON.stringify({ path: relative, bytes: bytes.length, expiresAt: new Date(Date.now() + fileTtl).toISOString() }));
  }

  // Housekeeping: idle sessions close, links expire, and files older than a link's life are deleted.
  const sweep = setInterval(() => void housekeeping(), Math.min(60_000, Math.max(50, idle / 4)));
  sweep.unref();
  async function housekeeping(): Promise<void> {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (now - s.lastUsed > idle) await closeSession(s.id, "idle");
      else if (opts.hub().personOfSource(s.source) === null) await closeSession(s.id, "the person left the table");
    }
    // An agent outlives its sessions by the idle time, so the next session finds what the last one read.
    for (const a of [...agents.values()]) {
      if (opts.hub().personOfSource(a.source) === null) await closeAgent(a, "the person left the table");
      else if (a.sessions === 0 && now - a.lastUsed > idle) await closeAgent(a, "idle");
    }
    for (const [id, l] of links) if (l.expiresAt < now) links.delete(id);
    await removeOlderThan(webRoot, now - fileTtl).catch(() => {});
  }

  return {
    credentialSource: (hashHex) => oauth.credentialSource(hashHex),
    get sessions() {
      return sessions.size;
    },
    async handle(req, res) {
      const path = new URL(req.url ?? "/", "http://hub").pathname;
      // The mark, for apps that show a connector's icon from its domain or its server info.
      if (req.method === "GET" && ICONS[path]) {
        const [type, body] = ICONS[path];
        res.writeHead(200, { "content-type": type, "content-length": String(body.length), "cache-control": "public, max-age=86400" }).end(body);
        return true;
      }
      if (await oauth.handle(req, res, path)) return true;
      if (path === "/mcp") {
        await handleMcp(req, res);
        return true;
      }
      if (path === "/files" || path.startsWith("/files/")) {
        await handleFiles(req, res, path);
        return true;
      }
      return false;
    },
    async close() {
      clearInterval(sweep);
      for (const id of [...sessions.keys()]) await closeSession(id, "the hub stopped");
      for (const a of [...agents.values()]) await closeAgent(a, "the hub stopped");
    },
  };
}

/** A JSON body, at most MAX_MESSAGE_BYTES; null when an answer was already sent. */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const bytes = await readBody(req, res, MAX_MESSAGE_BYTES);
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
    return null;
  }
}

function readBody(req: IncomingMessage, res: ServerResponse, limit: number): Promise<Buffer | null> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        res.writeHead(413, { "content-type": "text/plain" }).end(`Too large: at most ${Math.round(limit / 1024 / 1024)} MB.\n`);
        req.destroy();
        done(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => done(Buffer.concat(chunks)));
    req.on("error", () => done(null));
  });
}

/** Deletes files under `dir` last changed before `cutoff`; folders stay. */
async function removeOlderThan(dir: string, cutoff: number): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await removeOlderThan(p, cutoff);
      continue;
    }
    const info = await stat(p).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(p, { force: true });
  }
}
