// Entry point — spec §4.4 (CLI), §4.6 (lifecycle), §5.1.
//
//   figxel-mcp                 MCP stdio mode (dist/server.js is the bin)
//   figxel-mcp setup [--json]  token, plugin copy in <home>/plugin, what to do next (setup.ts)
//   figxel-mcp --print-token   create the token if absent, print it, exit
//   figxel-mcp --version | --help

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PACKAGE_NAME, PLUGIN_NAME, SERVER_NAME, VERSION } from "../shared/version.js";
import { Bridge, type BridgeOptions } from "./bridge.js";
import { ConfigError, createLogger, loadConfig, migrateLegacyToken, readOrCreateToken, type Config, type Logger } from "./config.js";
import { stripSchemaDialect } from "./schema-dialect.js";
import { registerResources, registerSkillResources } from "./resources.js";
import { registerTools, type Registration } from "./tools/index.js";
import { SERVER_INSTRUCTIONS } from "./guides.js";
import { formatSetupReport, helpText, parseCommand, refreshInstalledPlugin, runSetup } from "./setup.js";

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

/** Build the MCP server + bridge. `connect` attaches a transport (stdio in production, in-memory in tests). */
export async function createApp(
  config: Config,
  token: string,
  logger: Logger,
  bridgeOverrides: Partial<BridgeOptions> = {},
): Promise<App> {
  const startedAt = Date.now();
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    // `resources: {}` advertises the capability. Without it a client that lists
    // resources gets nothing, even though the resource is registered — the
    // registration alone does not put the capability on the wire.
    { capabilities: { logging: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS },
  );
  const bridge = new Bridge({
    token,
    logger,
    port: config.port,
    sessionWaitMs: config.sessionWaitMs,
    allowUnverified: config.allowUnverified,
    onPluginLog: (level, message) => {
      if (!server.isConnected()) return;
      void server.server
        .sendLoggingMessage({ level: level === "warn" ? "warning" : level, logger: "figma-plugin", data: message })
        .catch(() => {});
    },
    ...bridgeOverrides,
  });
  const registration = registerTools(server, bridge, config, startedAt, logger);
  registerResources(server, bridge);
  // Whatever the toolset: a client that surfaces resources reaches the skills even with BRIDGE_TOOLSET=none.
  registerSkillResources(server);
  await bridge.start();

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
      await bridge.close();
      await server.close().catch(() => {});
    },
  };
}

export async function connect(app: App, transport: Transport): Promise<void> {
  await app.server.connect(transport);
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
    config = loadConfig();
    logger = createLogger(config.logLevel);
    const migrated = migrateLegacyToken(config);
    if (migrated) logger.info(`copied the token from ${migrated} to ${config.tokenPath}; the plugin keeps the token it has`);
    token = readOrCreateToken(config.tokenPath);
    if (command.kind === "setup") {
      const report = runSetup(config, token);
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
    process.stderr.write(`Token file: ${config.tokenPath}\nPaste this token into the ${PLUGIN_NAME} plugin in Figma.\n`);
    return;
  }

  // After an update the plugin copy setup made is the old one; never fatal.
  refreshInstalledPlugin(config.home, logger);

  const app = await createApp(config, token, logger);
  logger.info(
    `${PACKAGE_NAME} ${VERSION}: toolset ${config.toolset.kind}, ${app.registration.registered.length} tool(s) registered`,
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
