// The MCP resource (spec §12 Phase 4).
//
// What is worth locking here is not "it returns JSON". It is the three ways this
// resource could quietly lie:
//
//   1. Registering the URI as a STRING instead of a ResourceTemplate. The SDK
//      overloads on the type, so a string becomes one static resource whose URI
//      contains literal braces — it looks registered in `resources/list` and can
//      never be read. That is a failure with no error at registration time.
//   2. Reporting `[]` when no selection event has arrived yet, which claims the
//      user has nothing selected when the truth is "I have not heard".
//   3. Answering for a session that does not exist.

import { describe, expect, it } from "vitest";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResources, registerSkillResources, SELECTION_SCHEME, selectionUri } from "../src/server/resources.js";
import { SKILLS } from "../src/server/skills.js";
import type { Bridge, BridgeStatus } from "../src/server/bridge.js";

/** A bridge whose status we control, so each case is a fact and not a fixture. */
function fakeBridge(status: Partial<BridgeStatus>): Bridge {
  const full: BridgeStatus = {
    role: "hub",
    listening: true,
    reason: null,
    port: 38452,
    host: "127.0.0.1",
    hubPid: 1,
    peers: 0,
    lastAuthFailureAt: null,
    sessions: [],
    ...status,
  } as BridgeStatus;
  return { statusAsync: async () => full } as unknown as Bridge;
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s-1",
    file: { name: "Untitled", key: null },
    page: { id: "0:1", name: "Page 1" },
    user: { id: "u-1", name: "Alex" },
    selection: null as unknown,
    ops: [],
    active: true,
    ...overrides,
  } as unknown as BridgeStatus["sessions"][number];
}

/** Call the registered reader directly, the way the SDK would. */
async function read(bridge: Bridge, uri: string) {
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { resources: {} } });
  registerResources(server, bridge);
  const internal = server.server as unknown as {
    _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
  };
  // tools/list is wrapped elsewhere; resources/read is the SDK's own handler.
  const handler = internal._requestHandlers.get("resources/read");
  const result = (await handler!({ method: "resources/read", params: { uri } }, {})) as {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  };
  return JSON.parse(result.contents[0]!.text);
}

describe("the selection resource", () => {
  it("registers a template, not a static URI with literal braces", () => {
    // The bug this catches: `registerResource(name, "figxel://…/{id}/…", …)`
    // registers ONE static resource. It lists fine and is unreadable forever.
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { resources: {} } });
    registerResources(server, fakeBridge({}));
    const internal = server.server as unknown as { _registeredResources?: Map<string, unknown> };
    // The static map must stay empty — the template map is where it belongs.
    expect(internal._registeredResources?.size ?? 0).toBe(0);
    // And a read through a real-looking URI must reach our callback, which is
    // the observable difference: a static registration would 404 here.
    return expect(read(fakeBridge({ sessions: [session()] }), "figxel://session/s-1/selection")).resolves.toMatchObject({
      sessionId: "s-1",
    });
  });

  it("uses the server's own scheme, never figma://, which is Figma's deep-link scheme [C-016]", async () => {
    expect(SELECTION_SCHEME).toBe("figxel");
    expect(selectionUri("s 1")).toBe("figxel://session/s%201/selection");
    await expect(read(fakeBridge({ sessions: [session()] }), "figma://session/s-1/selection")).rejects.toThrow(/not found/);
  });

  it("is readable through a real URI, which a static registration would not be", async () => {
    const payload = await read(fakeBridge({ sessions: [session()] }), "figxel://session/s-1/selection");
    expect(payload.sessionId).toBe("s-1");
    expect(payload.file).toBe("Untitled");
  });

  it("distinguishes `no event yet` (null) from `nothing selected` ([])", async () => {
    const noEvent = await read(fakeBridge({ sessions: [session({ selection: null })] }), "figxel://session/s-1/selection");
    expect(noEvent.selection).toBeNull();

    const emptyButKnown = await read(
      fakeBridge({ sessions: [session({ selection: { count: 0, nodeIds: [] } })] }),
      "figxel://session/s-1/selection",
    );
    expect(emptyButKnown.selection).toEqual({ count: 0, nodeIds: [] });
  });

  it("refuses to invent a selection for a session that does not exist", async () => {
    const payload = await read(fakeBridge({ sessions: [session()] }), "figxel://session/ghost/selection");
    expect(payload.error).toBe("NO_SUCH_SESSION");
    expect(payload.sessions).toContain("s-1");
  });

  it("says which of the two no-session cases applies", async () => {
    // No plugin connected at all.
    const none = await read(fakeBridge({ sessions: [] }), "figxel://session/x/selection");
    expect(none.message).toMatch(/no figma plugin is connected/i);

    // Several files connected and the name does not match any: the message must
    // name the mismatch, not claim a sessionId is missing.
    const many = await read(
      fakeBridge({ sessions: [session({ sessionId: "a" }), session({ sessionId: "b" })] }),
      "figxel://session/x/selection",
    );
    expect(many.message).toMatch(/no connected session with id or file name/i);
    expect(many.sessions).toContain("a");
    expect(many.sessions).toContain("b");
  });

  it("accepts a file name as well as an id, like every tool's `session` parameter", async () => {
    const payload = await read(fakeBridge({ sessions: [session()] }), "figxel://session/untitled/selection");
    expect(payload.sessionId).toBe("s-1");
  });

  it("never redirects to a different session when the asked-for one does not exist", async () => {
    // The dangerous shape: one file connected, a typo in the name, and the
    // resource cheerfully answers with the one session it knows. That is a wrong
    // answer that looks right, which is worse than the error.
    const payload = await read(fakeBridge({ sessions: [session()] }), "figxel://session/typo-here/selection");
    expect(payload.error).toBe("NO_SUCH_SESSION");
    expect(payload.selection).toBeUndefined();
  });

  it("lists one concrete URI per connected session, so a client can find them", async () => {
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { resources: {} } });
    registerResources(server, fakeBridge({ sessions: [session()] }));
    const internal = server.server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    };
    const handler = internal._requestHandlers.get("resources/list");
    const result = (await handler!({ method: "resources/list", params: {} }, {})) as {
      resources: Array<{ uri: string; name: string }>;
    };
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.uri).toBe("figxel://session/s-1/selection");
    expect(result.resources[0]!.name).toContain("Untitled");
  });

  it("lists nothing when no plugin is connected, rather than a broken URI", async () => {
    // registerResources alone: the skills are registered beside it (registerSkillResources).
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { resources: {} } });
    registerResources(server, fakeBridge({ sessions: [] }));
    const internal = server.server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    };
    const result = (await internal._requestHandlers.get("resources/list")!(
      { method: "resources/list", params: {} },
      {},
    )) as { resources: unknown[] };
    expect(result.resources).toHaveLength(0);
  });
});

// The skills as resources, in the SEP-2640 layout [C-172]. The same two traps
// apply — a template registered as a string, and an answer for something that
// does not exist — plus one of their own: the bytes must be the file's,
// frontmatter included, or a future manifest digest would not match.
describe("the skill resources", () => {
  function served() {
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { resources: {} } });
    registerSkillResources(server);
    const internal = server.server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    };
    const call = (method: string, params: Record<string, unknown> = {}) => internal._requestHandlers.get(method)!({ method, params }, {});
    return { server, call };
  }

  it("one static resource per SKILL.md, with no braces; the references behind one template", () => {
    const { server } = served();
    const internal = server as unknown as { _registeredResources: Record<string, unknown>; _registeredResourceTemplates: Record<string, unknown> };
    const statics = Object.keys(internal._registeredResources);
    expect(statics.sort()).toEqual(SKILLS.map((s) => `skill://${s.name}/SKILL.md`).sort());
    expect(statics.filter((u) => u.includes("{"))).toEqual([]);
    expect(Object.keys(internal._registeredResourceTemplates)).toEqual(["figxel-skill-references"]);
  });

  it("lists every reference with its size, and reads each as the file's own bytes", async () => {
    const { call } = served();
    const { resources } = (await call("resources/list")) as { resources: Array<{ uri: string; size: number }> };
    const references = SKILLS.flatMap((s) => s.sections);
    expect(resources).toHaveLength(SKILLS.length + references.length);
    for (const s of references) {
      const uri = `skill://${s.file.path}`;
      expect(resources.find((r) => r.uri === uri)?.size).toBe(s.file.size);
      const read = (await call("resources/read", { uri })) as { contents: Array<{ text: string; mimeType: string }> };
      expect(read.contents[0]).toMatchObject({ text: s.file.text, mimeType: "text/markdown" });
    }
    const index = (await call("resources/read", { uri: "skill://figxel-workflow/SKILL.md" })) as { contents: Array<{ text: string }> };
    expect(index.contents[0]!.text.startsWith("---\nname: figxel-workflow\n")).toBe(true);
  });

  it("refuses a reference that does not exist instead of answering with another", async () => {
    const { call } = served();
    await expect(call("resources/read", { uri: "skill://figxel-workflow/references/missing.md" })).rejects.toThrow(/not found/);
    await expect(call("resources/read", { uri: "skill://figxel-nope/references/build.md" })).rejects.toThrow(/not found/);
  });
});
