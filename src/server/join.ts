// `figxel-mcp join <invite>` and `leave`: a team's hub for every AI app on this
// computer. The invite (src/shared/invite.ts) is checked against the hub, then
// saved in <home>/hub.json, which every Figxel process reads when it starts
// (config.ts), so no app's entry needs BRIDGE_HUB_URL or BRIDGE_TOKEN.

import { existsSync, rmSync } from "node:fs";
import { Bridge } from "./bridge.js";
import { ConfigError, hubAddressOf, readJoined, writeJoined, type Config, type Logger } from "./config.js";
import { parseInvite } from "../shared/invite.js";
import { PLUGIN_NAME, PRODUCT_NAME } from "../shared/version.js";

export interface JoinOutcome {
  /** Saved: the hub welcomed the token, or could not be reached and will be tried by every app. */
  saved: boolean;
  message: string;
}

const RESTART = `Restart your AI apps so that they pick it up.`;

/** Checks the invite against the hub, and saves it unless the hub refused its token. */
export async function joinHub(config: Config, invite: string, logger: Logger): Promise<JoinOutcome> {
  const parsed = parseInvite(invite);
  if (!parsed) throw new ConfigError("That is not an invite: it looks like wss://mcp.example.com#<64 hexadecimal characters>, as `hub add` prints it.");
  const url = hubAddressOf(parsed.url, "The invite's address")!;
  const host = new URL(url).host;
  const bridge = new Bridge({ token: parsed.token, logger: quiet(logger), port: config.port, sessionWaitMs: 0, hubUrl: url });
  await bridge.start(); // one attempt to join, at most the remote handshake
  const role = bridge.role;
  const refused = bridge.status().reason === "HUB_REFUSED";
  const person = bridge.joinedAs;
  await bridge.close();
  if (refused) {
    return { saved: false, message: `The team's hub at ${host} refused this invite's token: it may have been revoked. Ask whoever runs the hub for a new invite. Nothing was saved.` };
  }
  writeJoined(config.joinedPath, url, parsed.token);
  const plugin = `In Figma, paste the same invite in the ${PLUGIN_NAME} plugin window under Team hub.`;
  if (role !== "proxy") {
    return {
      saved: true,
      message: `Saved the team's hub at ${host}, but it could not be reached just now (offline, or the hub is down); your apps keep trying. ${RESTART} ${plugin}`,
    };
  }
  return { saved: true, message: `Joined the team's hub at ${host}${person ? ` as ${person}` : ""}. Every AI app on this computer that runs ${PRODUCT_NAME} now works through it. ${RESTART} ${plugin}` };
}

/** Forgets the hub `join` saved (`joinedPath`); the apps use this computer's own server after a restart. */
export function leaveHub(joinedPath: string): string {
  if (!existsSync(joinedPath)) return "This computer has not joined a team's hub.";
  let host = "the team's hub";
  try {
    const joined = readJoined(joinedPath);
    if (joined) host = `the team's hub at ${new URL(joined.url).host}`;
  } catch {
    // A broken file is removed all the same.
  }
  rmSync(joinedPath);
  return `Left ${host}. Your AI apps use this computer's own ${PRODUCT_NAME} again once you restart them. In Figma, press This computer in the ${PLUGIN_NAME} plugin window.`;
}

/** The check's own connection logs nothing below a warning: the command prints its outcome. */
function quiet(logger: Logger): Logger {
  return { ...logger, debug: () => {}, info: () => {} };
}
