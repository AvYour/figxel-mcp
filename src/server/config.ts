// Configuration — spec §4.4 (env vars), §4.3 (home, token), and the stderr
// logger. An invalid value makes the bridge refuse to start (ConfigError).

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { DEFAULT_PORT } from "../shared/protocol.js";
import { parseToolset, type Toolset } from "../shared/ops.js";
import { HOME_DIRNAME, LEGACY_HOME_DIRNAME, SERVER_NAME } from "../shared/version.js";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface Config {
  toolset: Toolset;
  allowEval: boolean;
  /** BRIDGE_ALLOW_UNVERIFIED: writes not yet verified in a file's editor run anyway (src/shared/editors.ts). */
  allowUnverified: boolean;
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

  return {
    toolset,
    allowEval: flag(env, "BRIDGE_ALLOW_EVAL"),
    // Off by default: an unmeasured editor cell refuses writes until a spike has
    // recorded them. Like eval, it belongs to the process the MCP client talks
    // to — a measuring run turns it on for its own calls only [C-129].
    allowUnverified: flag(env, "BRIDGE_ALLOW_UNVERIFIED"),
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
  };
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
