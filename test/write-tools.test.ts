// Server-side contract of the write tools, through a real MCP client and the
// mock plugin. Found live on 2026-10-07: figma_create_from_spec declares `spec`
// as a JSON string (a recursive object schema is not portable across
// providers), but forwarded the string untouched, and the plugin op — which
// builds from an object — rejected every call: "`spec` must be an object".

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, readOrCreateToken } from "../src/server/config.js";
import { connect, createApp, type App } from "../src/server/mcp.js";
import { parseSpecParam } from "../src/server/tools/create.js";
import { quietLogger, startMock, type MockPlugin } from "./helpers.js";

let app: App;
let client: Client;
let mock: MockPlugin;

beforeAll(async () => {
  const home = mkdtempSync(join(tmpdir(), "fmcp-write-"));
  // A frame spec at page level is new work: the role gate is the role-process tests' to judge.
  const config = loadConfig({ BRIDGE_HOME: home, BRIDGE_PORT: "0", BRIDGE_SESSION_WAIT_MS: "2000", BRIDGE_PROCESS: "off" });
  const token = readOrCreateToken(config.tokenPath);
  app = await createApp(config, token, quietLogger);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "write-tools", version: "0" });
  await Promise.all([connect(app, a), client.connect(b)]);
  mock = startMock({ token, port: app.bridge.port });
  await mock.welcomed();
});

afterAll(async () => {
  mock.close();
  await client.close();
  await app.close();
});

const requests = () => mock.received.filter((m) => m.t === "request" && m.op === "create_from_spec");

describe("figma_create_from_spec — spec travels as a string, arrives as an object", () => {
  it("parses the JSON string before it reaches the plugin", async () => {
    const spec = { type: "frame", name: "Hero", children: [{ type: "text", content: "Hi" }] };
    const r = await client.callTool({
      name: "figma_create_from_spec",
      arguments: { spec: JSON.stringify(spec), idempotencyKey: "spec-parse-1" },
    });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ specType: "object", specKeys: ["type", "name", "children"], idempotencyKey: "spec-parse-1" });
    const sent = requests().at(-1)!;
    expect(sent.params).toMatchObject({ spec });
  });

  it("answers malformed JSON with INVALID_PARAM and never bothers the plugin", async () => {
    const before = requests().length;
    const r = await client.callTool({ name: "figma_create_from_spec", arguments: { spec: "{not json", idempotencyKey: "spec-bad-1" } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM", idempotencyKey: "spec-bad-1" });
    expect(String((r.structuredContent as { message: string }).message)).toMatch(/not valid JSON/);
    expect(requests().length).toBe(before);
  });

  it("rejects JSON that is not an object (an array, a number)", () => {
    expect(() => parseSpecParam("[1,2]")).toThrow(/must be a JSON object/);
    expect(() => parseSpecParam("42")).toThrow(/must be a JSON object/);
    expect(parseSpecParam({ type: "frame" })).toEqual({ type: "frame" });
  });
});
