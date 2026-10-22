// The plugin's server setting (cloud bridge plan, step 1): this computer by
// default, a team's hub only over wss://, one token per server.

import { describe, expect, it } from "vitest";
import { tokenKey } from "../src/plugin/server-key.js";
import { LOCAL_URL, parseServer, placeOf, urlOf } from "../src/plugin/server-url.js";

describe("the plugin's server setting", () => {
  it("empty, or this computer's own address, is this computer", () => {
    expect(parseServer("")).toEqual({ ok: true, server: null });
    expect(parseServer("   ")).toEqual({ ok: true, server: null });
    expect(parseServer(LOCAL_URL)).toEqual({ ok: true, server: null });
    expect(urlOf(null)).toBe(LOCAL_URL);
    expect(placeOf(null)).toBe("this computer");
  });

  it("a hub is a wss:// address, kept without a trailing slash", () => {
    expect(parseServer(" wss://mcp.figxel.example.dev/ ")).toEqual({ ok: true, server: "wss://mcp.figxel.example.dev" });
    expect(parseServer("wss://hub.example.dev:8443/figxel")).toEqual({ ok: true, server: "wss://hub.example.dev:8443/figxel" });
    expect(placeOf("wss://mcp.figxel.example.dev")).toBe("mcp.figxel.example.dev");
  });

  it("refuses ws:// to another machine, other schemes, credentials and junk", () => {
    expect(parseServer("ws://mcp.figxel.example.dev")).toMatchObject({ ok: false, error: expect.stringMatching(/needs wss/) });
    expect(parseServer("https://mcp.figxel.example.dev")).toMatchObject({ ok: false, error: expect.stringMatching(/starts with wss/) });
    expect(parseServer("wss://me:secret@hub.example.dev")).toMatchObject({ ok: false });
    expect(parseServer("wss://hub.example.dev/?token=x")).toMatchObject({ ok: false });
    expect(parseServer("mcp.figxel.example.dev")).toMatchObject({ ok: false, error: expect.stringMatching(/Not an address/) });
  });

  it("ws:// stays allowed for this computer, on another port too", () => {
    expect(parseServer("ws://localhost:38999")).toEqual({ ok: true, server: "ws://localhost:38999" });
  });

  it("each server keeps its own token; this computer's stays under the old key", () => {
    expect(tokenKey(null, "figma-mcp.token")).toBe("figma-mcp.token");
    expect(tokenKey("wss://mcp.figxel.example.dev", "figma-mcp.token")).toBe("figxel.token wss://mcp.figxel.example.dev");
  });
});
