// Every tool must be usable whatever model sits behind the MCP client —
// Claude, GPT, Gemini, GLM, a local model. Clients translate MCP tool schemas
// into their provider's function-calling format, and providers accept
// different slices of JSON Schema. This guard keeps every tool inside a
// deliberately conservative subset, so a tool added in a later phase fails
// here (and in CI) instead of failing for one model in the field.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, readOrCreateToken } from "../src/server/config.js";
import { connect, createApp, type App } from "../src/server/mcp.js";
import { quietLogger } from "./helpers.js";

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_DESCRIPTION = 1024;
const TYPES = new Set(["object", "string", "number", "integer", "boolean", "array"]);
// Keywords some function-calling providers reject or ignore. Express the same
// intent with plain `type`/`enum`/`properties`/`items` instead.
const FORBIDDEN = new Set([
  "$schema", "$ref", "$defs", "definitions", "$id", "anyOf", "oneOf", "allOf", "not", "if", "then", "else",
  "const", "format", "patternProperties", "propertyNames", "dependentSchemas", "dependentRequired",
  "unevaluatedProperties", "contains", "prefixItems",
]);

function problems(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${path}: not an object schema`];
  const s = schema as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(s)) if (FORBIDDEN.has(k)) out.push(`${path}: uses "${k}"`);
  if (typeof s.type !== "string" || !TYPES.has(s.type)) out.push(`${path}: "type" must be one of ${[...TYPES].join("/")}`);
  if (s.type === "object") {
    const props = s.properties;
    if (!props || typeof props !== "object") out.push(`${path}: object without "properties"`);
    else for (const [name, sub] of Object.entries(props)) out.push(...problems(sub, `${path}.${name}`));
  }
  if (s.type === "array") {
    if (!s.items) out.push(`${path}: array without "items"`);
    else out.push(...problems(s.items, `${path}[]`));
  }
  return out;
}

let app: App;
let client: Client;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "fmcp-schema-"));
  // Every group selected and eval allowed: the widest surface the server can register.
  const config = loadConfig({ BRIDGE_HOME: home, BRIDGE_PORT: "0", BRIDGE_ALLOW_EVAL: "1" });
  app = await createApp(config, readOrCreateToken(config.tokenPath), quietLogger);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "schema-check", version: "0" });
  await Promise.all([connect(app, a), client.connect(b)]);
});

afterAll(async () => {
  await client.close();
  await app.close();
});

describe("tool schemas stay portable across model providers", () => {
  it("every registered tool passes the conservative subset", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const found: string[] = [];
    for (const t of tools) {
      if (!NAME.test(t.name)) found.push(`${t.name}: name must match ${NAME}`);
      if (!t.description) found.push(`${t.name}: missing description`);
      else if (t.description.length > MAX_DESCRIPTION) found.push(`${t.name}: description over ${MAX_DESCRIPTION} chars`);
      found.push(...problems(t.inputSchema, `${t.name}.input`));
    }
    expect(found).toEqual([]);
  });

  it("the guard itself catches what it should", () => {
    expect(problems({ type: "object", properties: { a: { anyOf: [{ type: "string" }] } } }, "x")).toContain('x.a: uses "anyOf"');
    expect(problems({ type: "object" }, "x")).toContain('x: object without "properties"');
    expect(problems({ type: ["string", "null"] }, "x")[0]).toMatch(/"type" must be one of/);
    expect(problems({ type: "array" }, "x")).toContain('x: array without "items"');
    expect(problems({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {} }, "x")).toContain('x: uses "$schema"');
  });
});
