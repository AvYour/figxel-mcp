// Configuration — spec §4.4 (env vars), §4.3 (home, token), and the stderr
// logger. An invalid value makes the bridge refuse to start (ConfigError).

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { DEFAULT_PORT } from "../shared/protocol.js";
import { parseToolset, type Toolset } from "../shared/ops.js";
import { HOME_DIRNAME, LEGACY_HOME_DIRNAME, SERVER_NAME } from "../shared/version.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/**
 * BRIDGE_PROCESS — how the tools hold an agent to the motion process
 * (src/server/motion-process.ts): "strict" refuses a keyframe write or a final
 * render whose earlier steps are missing, "guided" runs it and lists them as
 * `processWarnings`, "off" tracks nothing.
 */
export const PROCESS_MODES = ["strict", "guided", "off"] as const;
export type ProcessMode = (typeof PROCESS_MODES)[number];

/**
 * BRIDGE_CONFLICTS — the stale-write guard (trust spec §2.3), sent with every
 * write request (RequestMsg.guard): "refuse" lets the plugin refuse a write
 * whose target a person or a collaborator changed after the agent last read
 * or wrote it (STALE, nothing changed), "warn" runs it and lists the
 * conflicts in its result, "off" checks nothing. A call's `force: true`
 * overrides a refusal for that call only.
 */
export const CONFLICT_MODES = ["refuse", "warn", "off"] as const;
export type ConflictsMode = (typeof CONFLICT_MODES)[number];

export interface Config {
  toolset: Toolset;
  allowEval: boolean;
  /**
   * BRIDGE_ENABLE_AUDIO: registers the held-back `audio` group (figma_analyze_audio,
   * figma_add_audio, figma_generate_audio). Off by default: the tools were held back
   * from the release on 2026-10-14 (docs/superpowers/plans/2026-10-14-audio-held.md).
   */
  enableAudio: boolean;
  /** BRIDGE_ALLOW_UNVERIFIED: writes not yet verified in a file's editor run anyway (src/shared/editors.ts). */
  allowUnverified: boolean;
  /** BRIDGE_PROCESS: the motion process gate, "strict" by default. */
  processMode: ProcessMode;
  /** BRIDGE_CONFLICTS: the stale-write guard every write carries, "refuse" by default. */
  conflicts: ConflictsMode;
  autolaunch: boolean;
  sessionWaitMs: number;
  home: string;
  tokenPath: string;
  /**
   * The token in the home folder used before the rename (~/.figma-mcp/token),
   * copied once by migrateLegacyToken; null when BRIDGE_HOME names the home.
   */
  legacyTokenPath: string | null;
  exportDir: string;
  exportRoots: string[];
  port: number;
  logLevel: LogLevel;
  /** BRIDGE_FFMPEG / BRIDGE_FFPROBE: the programs the video (and, when enabled, audio) tools run (ffmpeg.ts). Names on PATH by default. */
  ffmpeg: string;
  ffprobe: string;
  /**
   * BRIDGE_VIDEO_MAX_WAIT_S: the longest one figma_export_video call waits,
   * whatever its `wait` asks. Default 45, a margin under clients that cut a
   * call at 60 s [C-030]; raise it only for a client with a longer timeout.
   */
  videoMaxWaitS: number;
}

type Env = Record<string, string | undefined>;

function flag(env: Env, name: string): boolean {
  const v = (env[name] ?? "").trim();
  if (v === "" || v === "0") return false;
  if (v === "1") return true;
  throw new ConfigError(`${name}="${v}" must be 0 or 1`);
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const v = (env[name] ?? "").trim();
  if (v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name}="${v}" must be an integer between ${min} and ${max}`);
  }
  return n;
}

/** `userHome` is the OS home directory; a test passes its own. */
export function loadConfig(env: Env = process.env, userHome: string = homedir()): Config {
  let toolset: Toolset;
  try {
    toolset = parseToolset(env.BRIDGE_TOOLSET);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }

  const homeFromEnv = env.BRIDGE_HOME?.trim();
  const home = resolve(homeFromEnv || join(userHome, HOME_DIRNAME));
  const exportDir = resolve(env.BRIDGE_EXPORT_DIR?.trim() || join(home, "exports"));
  const exportRoots = (env.BRIDGE_EXPORT_ROOTS ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));

  const logLevel = (env.BRIDGE_LOG_LEVEL?.trim() || "info") as LogLevel;
  if (!LEVELS.includes(logLevel)) {
    throw new ConfigError(`BRIDGE_LOG_LEVEL="${env.BRIDGE_LOG_LEVEL}" must be one of ${LEVELS.join(", ")}`);
  }
  // Like the toolset: a misspelt mode stops the server rather than falling back to a weaker one.
  const processMode = (env.BRIDGE_PROCESS?.trim() || "strict") as ProcessMode;
  if (!PROCESS_MODES.includes(processMode)) {
    throw new ConfigError(`BRIDGE_PROCESS="${env.BRIDGE_PROCESS}" must be one of ${PROCESS_MODES.join(", ")}`);
  }
  // The same rule: a misspelt "refuse" must not leave writes unguarded.
  const conflicts = (env.BRIDGE_CONFLICTS?.trim() || "refuse") as ConflictsMode;
  if (!CONFLICT_MODES.includes(conflicts)) {
    throw new ConfigError(`BRIDGE_CONFLICTS="${env.BRIDGE_CONFLICTS}" must be one of ${CONFLICT_MODES.join(", ")}`);
  }

  // A program name is looked up on PATH; a path is used as given. BRIDGE_FFMPEG
  // alone, as a path, also looks for ffprobe in the same folder.
  const ffmpeg = env.BRIDGE_FFMPEG?.trim() || "ffmpeg";
  const ffprobe = env.BRIDGE_FFPROBE?.trim() || siblingProbe(ffmpeg) || "ffprobe";

  return {
    toolset,
    allowEval: flag(env, "BRIDGE_ALLOW_EVAL"),
    // Off by default, like eval: the audio tools are kept and tested, not released.
    enableAudio: flag(env, "BRIDGE_ENABLE_AUDIO"),
    // Off by default: an unmeasured editor cell refuses writes until a spike has
    // recorded them. Like eval, it belongs to the process the MCP client talks
    // to — a measuring run turns it on for its own calls only [C-129].
    allowUnverified: flag(env, "BRIDGE_ALLOW_UNVERIFIED"),
    // Per process too: the gate keeps the state of the client this process serves.
    processMode,
    // Per process as well: a proxy sends its own mode with each write it forwards (peer.ts).
    conflicts,
    // Inert since 2026-10-07: auto-launch was removed (ADR #32) because it had
    // to raise Figma over whatever the operator was doing. The flag is still
    // parsed so an existing .env does not fail validation; nothing reads it.
    autolaunch: flag(env, "BRIDGE_AUTOLAUNCH"),
    sessionWaitMs: int(env, "BRIDGE_SESSION_WAIT_MS", 5000, 0, 600_000),
    home,
    tokenPath: join(home, "token"),
    legacyTokenPath: homeFromEnv ? null : join(resolve(userHome, LEGACY_HOME_DIRNAME), "token"),
    exportDir,
    exportRoots,
    port: int(env, "BRIDGE_PORT", DEFAULT_PORT, 0, 65535),
    logLevel,
    ffmpeg,
    ffprobe,
    videoMaxWaitS: int(env, "BRIDGE_VIDEO_MAX_WAIT_S", 45, 0, 600),
  };
}

/** `…/ffmpeg(.exe)` → `…/ffprobe(.exe)`; undefined for a bare name, which PATH resolves. */
function siblingProbe(ffmpeg: string): string | undefined {
  if (!/[\\/]/.test(ffmpeg)) return undefined;
  const name = basename(ffmpeg);
  if (!/ffmpeg/i.test(name)) return undefined;
  return join(dirname(ffmpeg), name.replace(/ffmpeg/i, "ffprobe"));
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * Read the token, creating it on first start: 32 random bytes → 64 hex chars
 * (spec §4.3). POSIX gets mode 0600; on Windows the file inherits the
 * %USERPROFILE% ACL, which is already user-only.
 */
export function readOrCreateToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (TOKEN_RE.test(token)) return token;
    throw new ConfigError(
      `The token file ${tokenPath} is not 64 hex characters. Delete it to have a new one created.`,
    );
  }
  mkdirSync(join(tokenPath, ".."), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") chmodSync(tokenPath, 0o600);
  return token;
}

/**
 * The one-time move from the home folder used before the rename. When the
 * default home has no token yet and the old one (~/.figma-mcp/token) holds a
 * valid token, copy it, so a plugin that already stores that token keeps
 * connecting without pasting it again. Nothing is copied when BRIDGE_HOME
 * names the home, when the new token exists, or when the old file is not a
 * token. The old folder is left as it was (its exports stay there).
 * Call before readOrCreateToken. Returns the copied file's path, or null.
 */
export function migrateLegacyToken(config: Pick<Config, "tokenPath" | "legacyTokenPath">): string | null {
  const from = config.legacyTokenPath;
  if (!from || existsSync(config.tokenPath) || !existsSync(from)) return null;
  let token: string;
  try {
    token = readFileSync(from, "utf8").trim();
  } catch {
    return null;
  }
  if (!TOKEN_RE.test(token)) return null;
  mkdirSync(join(config.tokenPath, ".."), { recursive: true });
  try {
    // "wx": another server starting at the same moment may have written it first.
    writeFileSync(config.tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw e;
  }
  if (process.platform !== "win32") chmodSync(config.tokenPath, 0o600);
  return from;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Logs to stderr only. stdout is the MCP JSON-RPC channel — a single stray
 * write there corrupts the framing (spec §4.3).
 */
export function createLogger(level: LogLevel, write: (line: string) => void = (l) => process.stderr.write(l)): Logger {
  const min = LEVELS.indexOf(level);
  const at = (lvl: LogLevel) => (msg: string) => {
    if (LEVELS.indexOf(lvl) >= min) write(`[${SERVER_NAME}] ${lvl}: ${msg}\n`);
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}
