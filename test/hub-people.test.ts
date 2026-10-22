// `figxel-mcp hub` (cloud bridge plan, step 4): the team's people table keeps
// only each token's hash, a token is printed once, and a hub that is running
// closes a removed person's connections at once.

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tokenHashHex } from "../src/server/bridge.js";
import { loadConfig } from "../src/server/config.js";
import { addPerson, peoplePath, readPeople, removePerson, runHub } from "../src/server/hub.js";
import { parseCommand } from "../src/server/setup.js";
import { connectedMock, newToken, quietLogger, sleep, startBridge } from "./helpers.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

const home = () => mkdtempSync(join(tmpdir(), "figxel-hub-"));

async function until(ok: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(25);
  }
}

describe("the hub's command line", () => {
  it("parses hub, hub list, hub add <name> and hub remove <name>, and nothing else", () => {
    expect(parseCommand(["hub"])).toEqual({ kind: "hub" });
    expect(parseCommand(["hub", "list"])).toEqual({ kind: "hub-list" });
    expect(parseCommand(["hub", "add", "darrel"])).toEqual({ kind: "hub-add", person: "darrel" });
    expect(parseCommand(["hub", "remove", "darrel"])).toEqual({ kind: "hub-remove", person: "darrel" });
    expect(parseCommand(["hub", "add"])).toMatchObject({ kind: "error" });
    expect(parseCommand(["hub", "add", "a", "b"])).toMatchObject({ kind: "error" });
    expect(parseCommand(["hub", "start"])).toMatchObject({ kind: "error" });
  });
});

describe("the people table", () => {
  it("adding a person returns a token once and keeps only its hash, readable by the owner only", () => {
    const path = peoplePath(home());
    const token = addPerson(path, "darrel", new Date("2026-10-22T10:00:00Z"));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(token);
    expect(readPeople(path)).toEqual([{ person: "darrel", hash: tokenHashHex(token), addedAt: "2026-10-22T10:00:00.000Z" }]);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a name twice, a name it does not take, and removing someone who is not there", () => {
    const path = peoplePath(home());
    addPerson(path, "darrel");
    expect(() => addPerson(path, "darrel")).toThrow(/already in the table/);
    expect(() => addPerson(path, "Darrel Gusti")).toThrow(/not a name/);
    expect(() => removePerson(path, "carol")).toThrow(/not in the table/);
    removePerson(path, "darrel");
    expect(readPeople(path)).toEqual([]);
  });

  it("a missing file is an empty table", () => {
    expect(readPeople(peoplePath(home()))).toEqual([]);
  });
});

describe("revoking a person while the hub runs", () => {
  it("closes their plugin session and their agent's connection at once, and leaves the others", async () => {
    const alice = newToken();
    const bob = newToken();
    const hub = await startBridge({ token: newToken(), people: [{ person: "alice", hash: tokenHashHex(alice) }, { person: "bob", hash: tokenHashHex(bob) }] });
    cleanup.push(() => hub.close());
    const aliceFigma = await connectedMock(hub, alice);
    cleanup.push(() => aliceFigma.close());
    const bobFigma = await connectedMock(hub, bob);
    cleanup.push(() => bobFigma.close());
    const asBob = await startBridge({ token: bob, hubUrl: `ws://127.0.0.1:${hub.port}` });
    cleanup.push(() => asBob.close());
    expect(asBob.role).toBe("proxy");

    hub.setPeople([{ person: "alice", hash: tokenHashHex(alice) }]);
    expect((await bobFigma.closed()).code).toBe(4001);
    await until(() => asBob.role === "none");
    expect(aliceFigma.state.closeCode).toBeNull();
  });

  it("a name removed and added again with a new token: the old token opens nothing", async () => {
    const old = newToken();
    const hub = await startBridge({ token: newToken(), people: [{ person: "darrel", hash: tokenHashHex(old) }] });
    cleanup.push(() => hub.close());
    const figma = await connectedMock(hub, old);
    cleanup.push(() => figma.close());
    hub.setPeople([{ person: "darrel", hash: tokenHashHex(newToken()) }]);
    expect((await figma.closed()).code).toBe(4001);
  });
});

describe("figxel-mcp hub", () => {
  it("runs the bridge alone for the table's people, and reads the table again when it changes", async () => {
    const dir = home();
    const path = peoplePath(dir);
    const darrel = addPerson(path, "darrel");
    const config = loadConfig({ BRIDGE_HOME: dir, BRIDGE_PORT: "0" });
    const hub = await runHub(config, quietLogger);
    cleanup.push(() => hub.stop());
    expect(hub.bridge.role).toBe("hub");
    const figma = await connectedMock(hub.bridge, darrel, { fileName: "Darrel's file" });
    cleanup.push(() => figma.close());
    const laptop = await startBridge({ token: darrel, hubUrl: `ws://127.0.0.1:${hub.bridge.port}` });
    cleanup.push(() => laptop.close());
    expect(((await laptop.request("get_metadata", {})) as { name: string }).name).toBe("Darrel's file");

    removePerson(path, "darrel");
    expect((await figma.closed()).code).toBe(4001); // within the file watch's 2 s
  }, 15_000);
});
