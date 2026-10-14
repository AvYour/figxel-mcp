// The `$schema` guard itself, and the proof that removing it is safe.
//
// This is a regression test for a bug that would have taken the whole server
// down for Claude Desktop (and any client going through the Anthropic API):
// the MCP SDK hardcodes JSON Schema draft-07 into every tool schema that has
// parameters, and the Anthropic API answers
//
//   tools.N.custom.input_schema: JSON schema is invalid.
//   It must match JSON Schema draft 2020-12
//
// The failure lands at the provider, with no local error, and only for tools
// with parameters — so it stayed invisible while figma_status was the only tool.
//
// The assertions below are deliberately about the WIRE (what a client sees via
// tools/list), not about the helper in isolation: the helper could be correct
// and still be wired up to nothing.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, readOrCreateToken } from "../src/server/config.js";
import { connect, createApp, type App } from "../src/server/mcp.js";
import { stripSchemaDialect } from "../src/server/schema-dialect.js";
import { quietLogger } from "./helpers.js";

describe("the $schema stripper", () => {
  it("removes the dialect only, leaving the rest byte-identical", () => {
    const result = {
      tools: [
        {
          name: "t",
          inputSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
        },
      ],
    };
    const changed = stripSchemaDialect(result);
    expect(changed).toBe(1);
    expect(result.tools[0]!.inputSchema).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
  });

  it("is a no-op on a schema that never had the key, and on an empty result", () => {
    const clean = { tools: [{ name: "t", inputSchema: { type: "object", properties: {} } }] };
    expect(stripSchemaDialect(clean)).toBe(0);
    expect(stripSchemaDialect({ tools: [] })).toBe(0);
    // A tool with no schema at all must not throw.
    expect(stripSchemaDialect({ tools: [{ name: "no-schema" }] })).toBe(0);
  });
});

describe("on the wire, over a real MCP connection", () => {
  let app: App;
  let client: Client;

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fmcp-dialect-"));
    const config = loadConfig({ BRIDGE_HOME: home, BRIDGE_PORT: "0", BRIDGE_ALLOW_EVAL: "1" });
    app = await createApp(config, readOrCreateToken(config.tokenPath), quietLogger);
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "dialect-check", version: "0" });
    await Promise.all([connect(app, a), client.connect(b)]);
  });

  afterAll(async () => {
    await client.close();
    await app.close();
  });

  it("advertises no `$schema` on any tool, at any depth", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(10); // the read group is registered
    const found: string[] = [];
    const scan = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "$schema") found.push(path);
        else scan(v, `${path}.${k}`);
      }
    };
    for (const t of tools) scan(t.inputSchema, `${t.name}.inputSchema`);
    expect(found).toEqual([]);
  });

  it("keeps the parameters it stripped the dialect from", async () => {
    const { tools } = await client.listTools();
    const node = tools.find((t) => t.name === "figma_get_node");
    expect(node).toBeDefined();
    const schema = node!.inputSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {})).toContain("nodeId");
    expect(schema.required).toContain("nodeId");
  });
});
