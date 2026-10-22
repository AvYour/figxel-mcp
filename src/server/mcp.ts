// Entry point — spec §4.4 (CLI), §4.6 (lifecycle), §5.1.
//
//   figxel-mcp                 MCP stdio mode (dist/server.js is the bin)
//   figxel-mcp setup [--json]  token, plugin copy in <home>/plugin, what to do next (setup.ts)
//     --register | --unregister [--force] [--dry-run]   Figma's own list of development plugins (figma-register.ts)
//   figxel-mcp --print-token   create the token if absent, print it, exit
//   figxel-mcp --version | --help

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { inviteOf } from "../shared/invite.js";
import { tokenFingerprint } from "../shared/token.js";
import { PACKAGE_NAME, PLUGIN_MENU_PATH, PLUGIN_NAME, PRODUCT_NAME, SERVER_NAME, VERSION } from "../shared/version.js";
import { Bridge, type BridgeOptions } from "./bridge.js";
import { ConfigError, createLogger, joinedPathOf, loadConfig, migrateLegacyToken, readOrCreateToken, type Config, type Logger } from "./config.js";
import { joinHub, leaveHub } from "./join.js";
import { MotionProcess, SkillLedger } from "./motion-process.js";
import { RoleProcess } from "./role-process.js";
import { VideoJobs } from "./video-jobs.js";
import { stripSchemaDialect } from "./schema-dialect.js";
import { registerResources, registerSkillResources } from "./resources.js";
import { registerTools, type Registration } from "./tools/index.js";
import { SERVER_INSTRUCTIONS } from "./guides.js";
import { bundledPluginDir, copyPlugin, formatSetupReport, helpText, installedPluginDir, parseCommand, refreshInstalledPlugin, runSetup } from "./setup.js";
import { addPerson, peoplePath, readPeople, removePerson, runHub, setEmail } from "./hub.js";
import { formatRegistrationReport, pluginToRegister, runFigmaRegistration, withRegistration } from "./figma-register.js";

// What every client receives at initialize: the working contract and the
// pointer to figma_get_guide, not a feature list. A guide in the repository
// never reaches the model; this does.
const INSTRUCTIONS = SERVER_INSTRUCTIONS;

export interface App {
  server: McpServer;
  bridge: Bridge;
  registration: Registration;
  close(): Promise<void>;
}

// Logged once per process: the notice is useful, repeated on every tools/list it is noise.
let dialectNoticeLogged = false;

/**
 * What one agent's work keeps between its calls: the bridge it reaches Figma
 * through, the skills it read, its motion and role processes (the briefs), and
 * the renders it started. A process on a laptop holds one; the hub's web
 * endpoint keeps one per person (web.ts), because a client such as ChatGPT
 * opens a new MCP session for nearly every call, and a guide read in one
 * session must count in the next.
 */
export interface AgentState {
  bridge: Bridge;
  ledger: SkillLedger;
  motion: MotionProcess;
  roles: RoleProcess;
  videoJobs: VideoJobs<unknown>;
}

/** A started bridge and fresh processes, for a caller that shares them across MCP sessions. */
export async function createAgentState(config: Config, token: string, logger: Logger, bridgeOverrides: Partial<BridgeOptions> = {}): Promise<AgentState> {
  const bridge = new Bridge({
    token,
    logger,
    port: config.port,
    sessionWaitMs: config.sessionWaitMs,
    allowUnverified: config.allowUnverified,
    tokenPath: config.tokenPath,
    conflicts: config.conflicts,
    ...(config.hubUrl ? { hubUrl: config.hubUrl } : {}),
    ...bridgeOverrides,
  });
  const ledger = new SkillLedger();
  const state: AgentState = { bridge, ledger, motion: new MotionProcess(config.processMode, ledger), roles: new RoleProcess(config.processMode, ledger), videoJobs: new VideoJobs() };
  await bridge.start();
  return state;
}

/**
 * Build the MCP server + bridge. `connect` attaches a transport (stdio in
 * production, in-memory in tests). With `shared`, the server serves that agent
 * state instead of its own, and closing the app leaves the state's bridge open.
 */
export async function createApp(
  config: Config,
  token: string,
  logger: Logger,
  bridgeOverrides: Partial<BridgeOptions> = {},
  shared?: AgentState,
): Promise<App> {
  const startedAt = Date.now();
  // A web session (web.ts) names its title and the hub's icon, which an app listing the connector can show.
  const site = config.webMode && config.hubPublicUrl ? config.hubPublicUrl.replace(/^ws/, "http") : null;
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: VERSION,
      ...(site
        ? {
            title: PRODUCT_NAME,
            icons: [
              { src: `${site}/icon.png`, mimeType: "image/png", sizes: ["512x512"] },
              { src: `${site}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
            ],
          }
        : {}),
    },
    // `resources: {}` advertises the capability. Without it a client that lists
    // resources gets nothing, even though the resource is registered — the
    // registration alone does not put the capability on the wire.
    { capabilities: { logging: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );
  const bridge =
    shared?.bridge ??
    new Bridge({
      token,
      logger,
      port: config.port,
      sessionWaitMs: config.sessionWaitMs,
      allowUnverified: config.allowUnverified,
      tokenPath: config.tokenPath,
      // BRIDGE_CONFLICTS: the stale-write guard every write carries (trust spec §2.3).
      conflicts: config.conflicts,
      // BRIDGE_HUB_URL: join a team's hub, never the port (cloud bridge).
      ...(config.hubUrl ? { hubUrl: config.hubUrl } : {}),
      onPluginLog: (level, message) => {
        if (!server.isConnected()) return;
        void server.server
          .sendLoggingMessage({ level: level === "warn" ? "warning" : level, logger: "figma-plugin", data: message })
          .catch(() => {});
      },
      ...bridgeOverrides,
    });
  // One per agent, as the client it serves: a skill read on any surface is noted once, in one
  // ledger, and counts for both gates — the motion process's keyframes and the role process's briefs.
  const ledger = shared?.ledger ?? new SkillLedger();
  const motionProcess = shared?.motion ?? new MotionProcess(config.processMode, ledger);
  const roleProcess = shared?.roles ?? new RoleProcess(config.processMode, ledger);
  const registration = registerTools(server, bridge, config, startedAt, logger, motionProcess, roleProcess, shared?.videoJobs);
  registerResources(server, bridge);
  // Whatever the toolset: a client that surfaces resources reaches the skills even with BRIDGE_TOOLSET=none.
  registerSkillResources(server, (skill, uri) => ledger.note(skill.short, `the resource ${uri}`));
  if (!shared) await bridge.start();

  // Remove the draft-07 `$schema` the SDK adds to every tool schema with
  // parameters. Without this, Claude Desktop — which goes through the Anthropic
  // API — rejects every such tool with "It must match JSON Schema draft 2020-12",
  // and fails at the provider where no local error explains it. Measured, and
  // reproduced upstream: see src/server/schema-dialect.ts.
  //
  // Done by wrapping the registered `tools/list` handler rather than reaching
  // into the SDK's internals from here: the previous handler is captured first,
  // so if the SDK changes its handler this keeps calling whatever it provides.
  const internalServer = server.server as unknown as {
    _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
  };
  const listTools = internalServer._requestHandlers.get("tools/list");
  if (listTools) {
    internalServer._requestHandlers.set("tools/list", async (req, extra) => {
      const result = (await listTools(req, extra)) as Parameters<typeof stripSchemaDialect>[0];
      const changed = stripSchemaDialect(result);
      if (changed > 0 && !dialectNoticeLogged) {
        dialectNoticeLogged = true;
        logger.info(
          `removed the draft-07 $schema from ${changed} tool schema(s); ` +
            "the Anthropic API rejects schemas that declare that dialect (schema-dialect.ts)",
        );
      }
      return result;
    });
  }

  return {
    server,
    bridge,
    registration,
    async close() {
      if (!shared) await bridge.close(); // a shared bridge belongs to its agent state
      await server.close().catch(() => {});
    },
  };
}

export async function connect(app: App, transport: Transport): Promise<void> {
  await app.server.connect(transport);
}

/** `hub add | remove | list`: the team's table, edited in place; a running hub reads it again. */
function runPeopleCommand(
  command: { kind: "hub-add"; person: string; email?: string } | { kind: "hub-remove"; person: string } | { kind: "hub-email"; person: string; email: string } | { kind: "hub-list" },
  path: string,
  publicUrl: string | null,
): void {
  try {
    if (command.kind === "hub-email") {
      setEmail(path, command.person, command.email);
      process.stdout.write(`"${command.person}" signs in with ${command.email.toLowerCase()}: Figma or Google, once that email is verified there.\n`);
      return;
    }
    if (command.kind === "hub-add") {
      const token = addPerson(path, command.person, new Date(), command.email);
      // stdout carries the secret alone, so it can go straight to a file; the guidance goes to stderr.
      if (publicUrl) {
        process.stdout.write(`${inviteOf(publicUrl, token)}\n`);
        process.stderr.write(
          `Added "${command.person}" to ${path}. The invite above holds their token: it is shown once and kept nowhere on this server, ` +
            `so send it to them privately. They paste it in the ${PLUGIN_NAME} plugin window (Team hub) and run: ` +
            `npx -y ${PACKAGE_NAME}@latest join '<the invite>'. A running hub takes it within seconds.\n`,
        );
      } else {
        process.stdout.write(`${token}\n`);
        process.stderr.write(
          `Added "${command.person}" to ${path}. The token above is shown once and kept nowhere on this server: ` +
            "give it to them for the plugin window and for BRIDGE_TOKEN in their AI apps. A running hub takes it within seconds. " +
            "Set BRIDGE_HUB_PUBLIC_URL to the hub's wss:// address to print an invite instead.\n",
        );
      }
    } else if (command.kind === "hub-remove") {
      removePerson(path, command.person);
      process.stdout.write(`Removed "${command.person}". A running hub closes their connections within seconds.\n`);
    } else {
      const people = readPeople(path);
      const line = (p: (typeof people)[number]) =>
        [p.person, `added ${p.addedAt}`, p.email ?? "", (p.logins ?? []).map((l) => l.provider).join(",")].filter(Boolean).join("\t");
      process.stdout.write(people.length ? people.map((p) => `${line(p)}\n`).join("") : `No one yet: ${path} is empty.\n`);
    }
  } catch (e) {
    process.stderr.write(`[${SERVER_NAME}] error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // stdout belongs to JSON-RPC. Anything that reaches for console.log by
  // accident goes to stderr instead of corrupting the framing (spec §4.3).
  // The commands that do not serve write their answer to stdout explicitly.
  console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

  const command = parseCommand(argv);
  if (command.kind === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (command.kind === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command.kind === "error") {
    process.stderr.write(`[${SERVER_NAME}] error: ${command.message}\n\n${helpText()}\n`);
    process.exit(2);
  }

  let config: Config;
  let token: string;
  let logger: Logger;
  try {
    // Before the configuration: leaving must work even when the saved hub no longer loads.
    if (command.kind === "leave") {
      process.stdout.write(`${leaveHub(joinedPathOf())}\n`);
      return;
    }
    config = loadConfig();
    logger = createLogger(config.logLevel);
    if (command.kind === "hub-add" || command.kind === "hub-remove" || command.kind === "hub-email" || command.kind === "hub-list") {
      runPeopleCommand(command, peoplePath(config.home), config.hubPublicUrl);
      return;
    }
    if (command.kind === "join") {
      const outcome = await joinHub(config, command.invite, logger);
      process.stdout.write(`${outcome.message}\n`);
      if (!outcome.saved) process.exitCode = 1;
      return;
    }
    if (command.kind === "hub") {
      const hub = await runHub(config, logger, { createApp, createAgentState });
      const stop = () => void hub.stop().then(() => process.exit(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return; // the listening hub keeps the process alive
    }
    // --unregister and any --dry-run leave the home folder alone: no token, no plugin copy.
    if (command.kind === "install") {
      // The plugin, and nothing that a server on this computer would need: Figxel Cloud signs in through the browser.
      const from = bundledPluginDir();
      if (!from) throw new ConfigError(`The Figma plugin files are not next to this command, so there is nothing to copy. Reinstall ${PACKAGE_NAME}.`);
      const pluginDir = installedPluginDir(config.home);
      if (!command.dryRun) copyPlugin(from, pluginDir);
      const r = runFigmaRegistration(pluginToRegister(pluginDir, from), { action: "register", force: command.force, dryRun: command.dryRun });
      const next =
        r.outcome === "refused"
          ? ""
          : [
              "",
              "Next:",
              `  1. Open Figma desktop and a file, then ${PLUGIN_MENU_PATH}, and press Sign in.`,
              "  2. In your AI app, add the connector https://mcp.figxel.moirelabs.dev/mcp and sign in the same way.",
              "",
            ].join("\n");
      process.stdout.write(command.json ? `${JSON.stringify({ pluginDir, registration: r }, null, 2)}\n` : `${formatRegistrationReport(r, "install")}${next}`);
      if (r.outcome === "refused") process.exitCode = 1;
      return;
    }
    const figma = command.kind === "setup" ? command.figma : undefined;
    if (command.kind === "setup" && figma && (figma.dryRun || figma.action === "unregister")) {
      const r = runFigmaRegistration(pluginToRegister(installedPluginDir(config.home), bundledPluginDir()), figma);
      process.stdout.write(command.json ? `${JSON.stringify(r, null, 2)}\n` : formatRegistrationReport(r));
      if (r.outcome === "refused") process.exitCode = 1;
      return;
    }
    const migrated = migrateLegacyToken(config);
    if (migrated) logger.info(`copied the token from ${migrated} to ${config.tokenPath}; the plugin keeps the token it has`);
    token = readOrCreateToken(config.tokenPath);
    if (command.kind === "setup") {
      const report = runSetup(config, token);
      if (figma) {
        // After the copy, so Figma is pointed at files that exist.
        const r = runFigmaRegistration(pluginToRegister(report.pluginDir, bundledPluginDir()), figma);
        const both = withRegistration(report, r);
        process.stdout.write(command.json ? `${JSON.stringify(both, null, 2)}\n` : `${formatSetupReport(both)}\n${formatRegistrationReport(r)}`);
        if (r.outcome === "refused") process.exitCode = 1;
        return;
      }
      process.stdout.write(command.json ? `${JSON.stringify(report, null, 2)}\n` : formatSetupReport(report));
      return;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`[${SERVER_NAME}] error: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  if (command.kind === "print-token") {
    process.stdout.write(`${token}\n`);
    process.stderr.write(
      `Token file: ${config.tokenPath} (fingerprint ${tokenFingerprint(token)})\n` +
        `Paste this token into the ${PLUGIN_NAME} plugin in Figma; its window then shows the same fingerprint.\n`,
    );
    return;
  }

  // After an update the plugin copy setup made is the old one; never fatal.
  refreshInstalledPlugin(config.home, logger);

  // The person's token for a team's hub (BRIDGE_TOKEN, or the one `join` saved), in place of this computer's file.
  if (config.hubToken) token = config.hubToken;
  if (config.hubUrl) {
    const from = config.hubFrom === "joined" ? `saved by \`${PACKAGE_NAME} join\`` : "BRIDGE_HUB_URL";
    logger.info(`joining the team's hub at ${new URL(config.hubUrl).host} (${from}); this process never takes the port`);
  }
  const app = await createApp(config, token, logger);
  logger.info(
    `${PACKAGE_NAME} ${VERSION}: toolset ${config.toolset.kind}, ${app.registration.registered.length} tool(s) registered, process ${config.processMode}`,
  );

  let shuttingDown = false;
  const shutdown = (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`shutting down (${why})`);
    // The port must be free for the next bridge within ≤ 1 s (spec §4.6).
    setTimeout(() => process.exit(0), 900);
    void app.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", () => shutdown("stdin closed"));
  process.stdin.on("close", () => shutdown("stdin closed"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  transport.onclose = () => shutdown("transport closed");
  await connect(app, transport);
}

// Set only in the esbuild bundle (tools/build.mjs), so importing this module
// from tests never starts a server.
declare const __FIGMA_MCP_ENTRY__: boolean | undefined;
if (typeof __FIGMA_MCP_ENTRY__ !== "undefined" && __FIGMA_MCP_ENTRY__) {
  main().catch((err: unknown) => {
    process.stderr.write(`[${SERVER_NAME}] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
