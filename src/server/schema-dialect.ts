// Strip `$schema` from tool schemas on the wire.
//
// WHY THIS EXISTS — a measured, reproduced failure, not a precaution.
//
// The MCP TypeScript SDK hardcodes JSON Schema draft-07 when it converts a zod
// shape into the `inputSchema` a client sees, and it does the conversion lazily
// inside its own `tools/list` handler. There is no public option to change the
// dialect or omit the key (upstream: modelcontextprotocol/typescript-sdk#2084;
// "There is no public API on registerTool to override the dialect, so server
// authors cannot fix this downstream" — anthropics/claude-code#88882).
//
// The consequence is not cosmetic. The Anthropic API rejects a tool schema that
// declares draft-07:
//
//   tools.N.custom.input_schema: JSON schema is invalid.
//   It must match JSON Schema draft 2020-12
//
// Claude Desktop goes through that API, so every tool *with parameters* fails
// there — the whole server becomes unusable for exactly the client this project
// targets, and it fails at the provider, where no local error tells you why.
// Tools without parameters are unaffected, because the SDK returns a plain
// empty object for them: that is why figma_status worked and why this bug would
// only have appeared once Phase 1 added real tools.
//
// WHAT THIS DOES — and deliberately does not
//
// It removes only `$schema`, leaving the rest of the document byte-identical.
// The remaining keywords are checked against the conservative subset by
// test/schema-portability.test.ts, which is the guard that caught this in the
// first place. Nothing is normalised, rewritten or "cleaned up" beyond that one
// key: a shim that rewrites more than it must is a second source of bugs.
//
// It is the recommendation from issue Dokploy/mcp#36, and it is what the
// upstream fix boils down to. If the SDK later stops emitting `$schema`, this
// becomes a no-op and can be deleted.

// The two shapes the SDK produces, as they appear on the wire.
type JsonSchema = Record<string, unknown>;

export interface ListToolsResult {
  tools: Array<{ name: string; inputSchema?: JsonSchema; [k: string]: unknown }>;
  [k: string]: unknown;
}

/**
 * Remove `$schema` at the top level of every tool's inputSchema.
 *
 * Returns the number of schemas changed, so a caller can log it and a test can
 * assert it did something rather than silently passing on an already-clean SDK.
 */
export function stripSchemaDialect(result: ListToolsResult): number {
  let changed = 0;
  for (const tool of result?.tools ?? []) {
    const schema = tool.inputSchema;
    if (schema && typeof schema === "object" && "$schema" in schema) {
      delete schema.$schema;
      changed++;
    }
  }
  return changed;
}
