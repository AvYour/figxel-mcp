// The hub's web endpoint (cloud bridge plan, Phase B): MCP over Streamable
// HTTP at /mcp, signed in with a person's token as a bearer header. A web
// session reaches only its person's Figma, writes only its person's folder,
// and hands the files back as links.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, loadConfig } from "../src/server/config.js";
import { addPerson, peoplePath, runHub } from "../src/server/hub.js";
import { createAgentState, createApp } from "../src/server/mcp.js";
import { startMock } from "./helpers.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown> };

/** A hub with the web endpoint, and Alice and Bob, each with a Figma file connected. */
async function webHub(web: { fileTtlMs?: number; sessionIdleMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "fmcp-web-"));
  const alice = addPerson(peoplePath(home), "alice");
  const bob = addPerson(peoplePath(home), "bob");
  // Links are made from the public address; the test reads them from the port it really got.
  const config = loadConfig({ BRIDGE_HOME: home, BRIDGE_PORT: "0", BRIDGE_HUB_WEB: "1", BRIDGE_HUB_PUBLIC_URL: "ws://localhost:1", BRIDGE_SESSION_WAIT_MS: "2000" });
  const logger = createLogger("error");
  const { bridge, web: endpoint, stop } = await runHub(config, logger, { createApp, createAgentState, web });
  cleanup.push(stop);
  const base = `http://127.0.0.1:${bridge.port}`;
  for (const [token, fileName] of [[alice, "Alice's file"], [bob, "Bob's file"]] as const) {
    const figma = startMock({ port: bridge.port, token, fileName });
    cleanup.push(() => figma.close());
    await figma.welcomed();
  }
  return { home, alice, bob, base, port: bridge.port, endpoint: endpoint!, local: (url: string) => url.replace("http://localhost:1", base) };
}

async function client(base: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const c = new Client({ name: "web-test", version: "0" });
  await c.connect(transport);
  cleanup.push(() => c.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })) as ToolResult;
  return { call, transport, info: () => c.getServerVersion() };
}

const dataOf = (r: ToolResult) => JSON.parse(r.content[0]!.text!) as Record<string, unknown>;

describe("the hub's web endpoint", () => {
  it("signs a web client in with its bearer token and reaches only its person's Figma", async () => {
    const { alice, base } = await webHub();
    const web = await client(base, alice);
    const status = dataOf(await web.call("figma_status"));
    expect((status.sessions as Array<{ file: { name: string } }>).map((s) => s.file.name)).toEqual(["Alice's file"]);
    expect(String(status.hint)).toMatch(/This is the team's web endpoint as alice/);
    expect(dataOf(await web.call("figma_get_metadata")).name).toBe("Alice's file");
    const other = await web.call("figma_get_metadata", { session: "Bob's file" });
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toMatch(/NO_SESSION/);
  });

  it("answers 401 without a token or with a wrong one, and 404 for another person's session id", async () => {
    const { alice, bob, base } = await webHub();
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: `Bearer ${"0".repeat(64)}` })).status).toBe(401);
    const web = await client(base, alice);
    const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    const asBob = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bob}`, "mcp-session-id": web.transport.sessionId! },
      body: JSON.stringify(list),
    });
    expect(asBob.status).toBe(404);
  });

  it("hands a written file back as a link that serves it, until it expires", async () => {
    const { alice, base, local } = await webHub({ fileTtlMs: 1500 });
    const web = await client(base, alice);
    const r = await web.call("figma_export_node", { nodeId: "1:1", saveTo: "frame.png" });
    expect(r.isError).toBeFalsy();
    const downloads = dataOf(r).downloads as Array<{ path: string; url: string }>;
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.path).toMatch(/[\\/]web[\\/]alice[\\/]frame\.png$/);
    expect(r.structuredContent?.downloads).toEqual(downloads);
    const got = await fetch(local(downloads[0]!.url));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect((await got.arrayBuffer()).byteLength).toBe(1024);
    await new Promise((r) => setTimeout(r, 1700));
    expect((await fetch(local(downloads[0]!.url))).status).toBe(404);
  });

  it("makes no link for a path that only looks inside the person's folder: .. never reaches another person's files", async () => {
    const { alice, base, home, local, port } = await webHub();
    mkdirSync(join(home, "web", "bob"), { recursive: true });
    writeFileSync(join(home, "web", "bob", "secret.png"), "bob's");
    // A layer or file name is the person's own text, and tools echo it back.
    const sneaky = [join(home, "web", "alice"), "..", "bob", "secret.png"].join(sep); // not join(): it would fold the ..
    const figma = startMock({ port, token: alice, fileName: sneaky });
    cleanup.push(() => figma.close());
    await figma.welcomed();
    const web = await client(base, alice);
    const r = await web.call("figma_get_metadata", { session: sneaky });
    expect(r.isError).toBeFalsy();
    const downloads = (dataOf(r).downloads ?? []) as Array<{ url: string }>;
    expect(downloads).toEqual([]);
    for (const d of downloads) expect((await fetch(local(d.url))).status).toBe(404);
  });

  it("keeps a web session to its person's folder: nothing outside it is read", async () => {
    const { alice, base } = await webHub();
    const web = await client(base, alice);
    for (const path of ["../../hub-people.json", "../bob/x.png"]) {
      const r = await web.call("figma_import_image", { path });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/INVALID_PARAM/);
    }
  });

  it("takes an upload into the person's folder, for an import by path", async () => {
    const { alice, bob, base, home } = await webHub();
    const up = await fetch(`${base}/files?name=../logo.png`, { method: "POST", headers: { authorization: `Bearer ${alice}` }, body: Buffer.alloc(64, 1) });
    expect(up.status).toBe(201);
    const body = (await up.json()) as { path: string };
    expect(body.path).toMatch(/^uploads\/[0-9a-f]{8}-logo\.png$/);
    expect(readdirSync(join(home, "web", "alice", "uploads"))).toHaveLength(1);
    expect(readdirSync(join(home, "web")).sort()).toEqual(["alice"]); // the name cannot climb out
    expect((await fetch(`${base}/files?name=a.png`, { method: "POST", body: "x" })).status).toBe(401);
    void bob;
  });

  it("closes a web session nobody uses", async () => {
    const { alice, base, endpoint } = await webHub({ sessionIdleMs: 300 });
    await client(base, alice);
    expect(endpoint.sessions).toBe(1);
    await new Promise((r) => setTimeout(r, 800));
    expect(endpoint.sessions).toBe(0);
  });

  it("serves the Figxel mark and names it in the server info, so an app can show the connector's icon", async () => {
    const { alice, base } = await webHub();
    const png = await fetch(`${base}/favicon.ico`);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await png.arrayBuffer()).equals(readFileSync(new URL("../assets/logo/icon-512.png", import.meta.url)))).toBe(true);
    const svg = await (await fetch(`${base}/favicon.svg`)).text();
    expect(svg).toBe(readFileSync(new URL("../assets/logo/icon-128.svg", import.meta.url), "utf8").trim());
    const web = await client(base, alice);
    expect(web.info()).toMatchObject({ name: "figxel", title: "Figxel", icons: [{ src: "http://localhost:1/icon.png", mimeType: "image/png" }, { src: "http://localhost:1/favicon.svg" }] });
  });
});

describe("a person's agent across web sessions", () => {
  it("keeps what one session read for the next, as a client that opens a session per call needs", async () => {
    const { alice, base } = await webHub();
    // The first session reads the ux skill's guide, then goes away, as ChatGPT's sessions do.
    const first = await client(base, alice);
    expect((await first.call("figma_get_guide", { topic: "ux" })).isError).toBeFalsy();
    await first.transport.terminateSession().catch(() => {});
    // A new session of the same person: the guide still counts.
    const next = await client(base, alice);
    const status = dataOf(await next.call("figma_status")) as { process?: { skillsRead?: string[] } };
    expect(status.process?.skillsRead).toContain("ux");
  });

  it("keeps one person's reading from another's", async () => {
    const { alice, bob, base } = await webHub();
    await (await client(base, alice)).call("figma_get_guide", { topic: "ux" });
    const status = dataOf(await (await client(base, bob)).call("figma_status")) as { process?: { skillsRead?: string[] } };
    expect(status.process?.skillsRead ?? []).not.toContain("ux");
  });
});
