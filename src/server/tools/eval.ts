// The eval group on the server side (tools.md § eval, ADR #9).
//
// Two keys gate this, and both are enforced before the tool exists:
//   * BRIDGE_ALLOW_EVAL=1  (the config flag this module checks), AND
//   * a toolset that includes the eval group — which `selectOps` handles, so a
//     `BRIDGE_TOOLSET=core` bridge never even selects the op.
//
// That is deliberate: a tool a client cannot see is a tool an agent cannot be
// talked into calling. Documenting "please do not use this casually" would not
// achieve the same thing.
//
// Every call is logged with a SHA-256 of the code and its length, never the code
// itself (tools.md): enough to tell two calls apart and to prove afterwards
// exactly what ran, without dumping arbitrary JavaScript into stderr.

import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import type { Logger } from "../config.js";
import { forwardTool, type Extra } from "./forward.js";
import { fitDescription } from "./params.js";

export function registerEval(
  server: McpServer,
  bridge: Bridge,
  logger: Logger,
  wanted: (op: string) => boolean,
  allowEval: boolean,
): void {
  // Belt and braces: `wanted` already reflects the toolset, and `allowEval` the
  // flag. Requiring both here means a future change to either one cannot open
  // this hole by itself.
  if (!allowEval || !wanted("eval")) return;

  server.registerTool(
    "figma_eval",
    {
      title: "Run Plugin API code (opt-in)",
      description: fitDescription(
        "Run JavaScript in the plugin sandbox with full `figma.*` access and return its JSON-serializable value. This is the " +
          "escape hatch for gaps that have no dedicated tool — not the normal path: a dedicated tool is validated, typed and " +
          "reported on, and this is none of those. The code runs as the body of an async function, so `return` a value. " +
          "`await` works. Document changes are wrapped in one Ctrl+Z like any other write tool. `figma` and a `ctx` object " +
          "(`ctx.yieldToHost()`, `ctx.isCancelled()`) are in scope. Every call is logged by hash.",
      ),
      inputSchema: {
        code: z.string().max(200_000).describe("JavaScript to run as an async function body. Return JSON-serializable data."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(600_000)
          .optional()
          .describe("Idle timeout, default 30000. Cannot pre-empt a synchronous loop — only code that awaits."),
        idempotencyKey: z
          .string()
          .max(128)
          .optional()
          .describe("Retry key, ≤128 chars. Re-calling with the same key never runs the code twice."),
        session: z.string().optional().describe("Optional sessionId or file name, when more than one file is connected."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args: Record<string, unknown>, extra: Extra) => {
      const code = typeof args.code === "string" ? args.code : "";
      // The hash, not the code. Enough to correlate two logs of the same call and
      // to prove later exactly what ran, without printing arbitrary JavaScript.
      const digest = createHash("sha256").update(code, "utf8").digest("hex").slice(0, 16);
      logger.warn(`op=eval codeLen=${code.length} sha256=${digest}${args.idempotencyKey ? ` key=${String(args.idempotencyKey)}` : ""}`);
      return forwardTool(bridge, "eval", args, extra, {
        session: args.session as string | undefined,
        idempotencyKey: args.idempotencyKey as string | undefined,
      });
    },
  );
}
