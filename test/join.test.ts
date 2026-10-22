// `figxel-mcp join <invite>` and `leave` (cloud bridge): an invite is checked
// against the hub before it is saved for every AI app on this computer, a
// refused one saves nothing, and leaving forgets it.

import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, loadConfig, readJoined } from "../src/server/config.js";
import { joinHub, leaveHub } from "../src/server/join.js";
import { parseCommand } from "../src/server/setup.js";
import { inviteOf } from "../src/shared/invite.js";
import { newToken, startBridge } from "./helpers.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const logger = createLogger("error");
const laptop = () => loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-join-")) });

async function aliceHub(alice: string) {
  const hub = await startBridge({ token: newToken(), people: [{ person: "alice", token: alice }] });
  cleanup.push(() => hub.close());
  return `ws://127.0.0.1:${hub.port}`;
}

describe("join and leave", () => {
  it("parses install, for Figxel Cloud: the plugin alone, with --force, --dry-run and --json", () => {
    expect(parseCommand(["install"])).toEqual({ kind: "install", json: false, force: false, dryRun: false });
    expect(parseCommand(["install", "--dry-run", "--json"])).toEqual({ kind: "install", json: true, force: false, dryRun: true });
    expect(parseCommand(["install", "--register"]).kind).toBe("error");
  });

  it("parses join with one invite and leave with nothing", () => {
    expect(parseCommand(["join", "wss://h.example#x"])).toEqual({ kind: "join", invite: "wss://h.example#x" });
    expect(parseCommand(["join"]).kind).toBe("error");
    expect(parseCommand(["leave"])).toEqual({ kind: "leave" });
    expect(parseCommand(["leave", "now"]).kind).toBe("error");
  });

  it("joins a hub that welcomes the token, names the person, and saves it for every app", async () => {
    const alice = newToken();
    const url = await aliceHub(alice);
    const config = laptop();
    const outcome = await joinHub(config, inviteOf(url, alice), logger);
    expect(outcome.saved).toBe(true);
    expect(outcome.message).toMatch(/^Joined the team's hub at 127\.0\.0\.1:\d+ as alice\./);
    expect(readJoined(config.joinedPath)).toEqual({ url, token: alice });
    // The next process on this computer takes it with no setting at all.
    expect(loadConfig({ BRIDGE_HOME: config.home })).toMatchObject({ hubUrl: url, hubFrom: "joined", hubToken: alice });
  });

  it("saves nothing when the hub refuses the invite's token", async () => {
    const url = await aliceHub(newToken());
    const config = laptop();
    const outcome = await joinHub(config, inviteOf(url, newToken()), logger);
    expect(outcome.saved).toBe(false);
    expect(outcome.message).toMatch(/refused this invite's token/);
    expect(existsSync(config.joinedPath)).toBe(false);
  });

  it("saves an invite whose hub cannot be reached just now, and says so", async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const { port } = s.address() as AddressInfo;
    await new Promise<void>((r) => s.close(() => r()));
    const config = laptop();
    const outcome = await joinHub(config, inviteOf(`ws://127.0.0.1:${port}`, newToken()), logger);
    expect(outcome.saved).toBe(true);
    expect(outcome.message).toMatch(/could not be reached just now/);
  });

  it("refuses text that is not an invite, and an invite over ws:// to another machine", async () => {
    await expect(joinHub(laptop(), "wss://mcp.figxel.example.dev", logger)).rejects.toThrow(/not an invite/);
    await expect(joinHub(laptop(), inviteOf("ws://mcp.figxel.example.dev", newToken()), logger)).rejects.toThrow(/must be a wss:\/\/ address/);
  });

  it("leave forgets the hub, and says so when there is none", async () => {
    const alice = newToken();
    const url = await aliceHub(alice);
    const config = laptop();
    await joinHub(config, inviteOf(url, alice), logger);
    expect(leaveHub(config.joinedPath)).toMatch(/^Left the team's hub at 127\.0\.0\.1:\d+\./);
    expect(existsSync(config.joinedPath)).toBe(false);
    expect(leaveHub(config.joinedPath)).toBe("This computer has not joined a team's hub.");
  });
});
