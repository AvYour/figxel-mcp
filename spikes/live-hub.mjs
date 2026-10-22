// The cloud bridge against a real hub (docs/superpowers/plans/2026-10-22-cloud-bridge.md,
// Phase A live runs), without Figma: a mock plugin and an agent's process
// (BRIDGE_HUB_URL) reach the hub under one person's token, and the process
// sees that person's file and nothing else. A token not in the table is
// refused, by a plugin and by a process, and is told no one's name.
//
//   node spikes/live-hub.mjs --hub wss://mcp.figxel.example --token-file <path> [--other-token-file <path>] [--idle <s>]
//
// --hub        the hub's address; ws:// only through a tunnel to loopback
// --token-file a file holding the person's token (64 hex), never printed
// --other-token-file  a second person's token: each person must see only their own file
// --idle       hold both connections this many seconds, then call again (proxy idle timeouts)
//
// Writes spikes/results/live-hub.json (-two with a second person, -idle with --idle).

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockPlugin } from "../tools/mock-plugin.mjs";
import { connect } from "./mcp-client.mjs";

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const hub = arg("hub");
const tokenFile = arg("token-file");
const idleS = Number(arg("idle") ?? 0);
const otherFile = arg("other-token-file");
if (!hub || !tokenFile) {
  console.error("usage: node spikes/live-hub.mjs --hub <wss://...> --token-file <path> [--idle <s>]");
  process.exit(2);
}
const readToken = (file) => {
  const t = readFileSync(file, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Error(`${file} does not hold a 64-hex token`);
  return t;
};
const token = readToken(tokenFile);

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.error(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`${what}: no answer in ${ms} ms`)))]);

const fileName = `live-hub ${randomBytes(3).toString("hex")}`;
const started = Date.now();

// 1. A plugin with the person's token is welcomed, and told whose token it is.
const plugin = startMockPlugin({ url: hub, token, fileName });
const welcome = await within(plugin.welcomed(), 15_000, "plugin welcome");
const welcomeFrame = plugin.received.find((f) => f.t === "welcome");
check("plugin welcomed", Boolean(welcome.sessionId), `session ${welcome.sessionId}`);
check("welcome names the person", typeof welcomeFrame?.person === "string", `as ${welcomeFrame?.person}`);

// 2. An agent's process joins the hub and never takes the port.
const agent = await connect({ env: { BRIDGE_HUB_URL: hub, BRIDGE_TOKEN: token } });
const status = await agent.call("figma_status", {});
const files = (status.data?.sessions ?? []).map((s) => s.file?.name);
check("figma_status shows the person's own file", files.includes(fileName), JSON.stringify(files));

// 3. A call reaches the plugin and comes back.
const t0 = Date.now();
const meta = await agent.call("figma_get_metadata", { session: fileName });
check("a call goes through the hub and back", meta.ok, `${Date.now() - t0} ms`);

// 3b. Two people: each sees only their own file, and the other's file by name is as if it did not exist.
if (otherFile) {
  const other = readToken(otherFile);
  const otherName = `live-hub other ${randomBytes(3).toString("hex")}`;
  const otherPlugin = startMockPlugin({ url: hub, token: other, fileName: otherName });
  await within(otherPlugin.welcomed(), 15_000, "other plugin welcome");
  const otherAgent = await connect({ env: { BRIDGE_HUB_URL: hub, BRIDGE_TOKEN: other } });
  const names = async (a) => ((await a.call("figma_status", {})).data?.sessions ?? []).map((x) => x.file?.name);
  const mine = await names(agent);
  const theirs = await names(otherAgent);
  check(
    "each person's status lists only their own file",
    mine.includes(fileName) && !mine.includes(otherName) && theirs.includes(otherName) && !theirs.includes(fileName),
    `first ${JSON.stringify(mine)}, second ${JSON.stringify(theirs)}`,
  );
  const byName = await agent.call("figma_get_metadata", { session: otherName });
  const never = await agent.call("figma_get_metadata", { session: "no such file" });
  check(
    "the other person's file, by name, reads as one that does not exist",
    !byName.ok && byName.text.replace(otherName, "X") === never.text.replace("no such file", "X"),
    byName.text.split("\n")[0],
  );
  const reverse = await otherAgent.call("figma_get_metadata", { session: fileName });
  check("and the other way round", !reverse.ok, reverse.text.split("\n")[0]);
  const asked = (m) => m.received.filter((f) => f.t === "request").length;
  check("neither plugin received the other person's calls", asked(otherPlugin) === 0, `other plugin got ${asked(otherPlugin)} request(s)`);
  await otherAgent.close();
  otherPlugin.close();
}

// 4. Idle: both connections held, then a call again.
if (idleS > 0) {
  console.error(`holding both connections ${idleS} s ...`);
  await sleep(idleS * 1000);
  const again = await agent.call("figma_get_metadata", { session: fileName });
  check(`a call after ${idleS} s idle`, again.ok, again.ok ? "" : again.text.slice(0, 200));
}

// 5. A token not in the table: the plugin is closed with 4001; the process is told nothing about anyone.
const stranger = randomBytes(32).toString("hex");
const strangerPlugin = startMockPlugin({ url: hub, token: stranger, fileName: "stranger" });
const closed = await within(strangerPlugin.closed(), 15_000, "stranger close");
check("a stranger's plugin is refused", closed.code === 4001, `close ${closed.code}`);
strangerPlugin.close();
const strangerAgent = await connect({ env: { BRIDGE_HUB_URL: hub, BRIDGE_TOKEN: stranger } });
const refused = await strangerAgent.call("figma_status", {});
const said = `${refused.text}`;
check(
  "a stranger's process learns no file or person",
  !said.includes(fileName) && !(welcomeFrame?.person && said.includes(welcomeFrame.person)),
  said.slice(0, 160).replace(/\s+/g, " "),
);
await strangerAgent.close();

await agent.close();
plugin.close();

const result = {
  ranAt: new Date(started).toISOString(),
  hub: new URL(hub).host,
  idleS,
  twoPeople: Boolean(otherFile),
  checks,
  ok: checks.every((c) => c.ok),
};
mkdirSync(path.join(REPO, "spikes/results"), { recursive: true });
const out = `live-hub${otherFile ? "-two" : ""}${idleS > 0 ? "-idle" : ""}.json`;
writeFileSync(path.join(REPO, "spikes/results", out), `${JSON.stringify(result, null, 2)}\n`);
console.error(result.ok ? "all checks passed" : "some checks FAILED");
process.exit(result.ok ? 0 : 1);
