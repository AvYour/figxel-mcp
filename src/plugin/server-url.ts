// Where the plugin connects: this computer's Figxel server (the default) or a
// team's hub at a wss:// address (docs/superpowers/plans/2026-10-22-cloud-bridge.md).
// Pure, so it is tested without a browser.

import { DEFAULT_PORT, HOST } from "../shared/protocol.js";

export const LOCAL_URL = `ws://${HOST}:${DEFAULT_PORT}`;

/**
 * Figxel Cloud: the hub the plugin signs in to when nobody gave it another
 * address, so a new user presses Sign in and types nothing. A team running its
 * own hub sets its address with Change; this computer's server stays one click away.
 */
export const CLOUD_URL = "wss://mcp.figxel.moirelabs.dev";
export const CLOUD_NAME = "Figxel Cloud";

/** A hub on the internet is retried more slowly than this computer's server, which costs nothing to refuse. */
export const REMOTE_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000, 30_000];

export type ServerInput = { ok: true; server: string | null } | { ok: false; error: string };

/**
 * What the person typed, as the server to connect to: empty is this computer
 * (null). A hub must be wss://: over ws:// its token would cross the network
 * in the clear, so ws:// stays for this computer only.
 */
export function parseServer(input: string): ServerInput {
  const s = input.trim();
  if (!s) return { ok: true, server: null };
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { ok: false, error: "Not an address. A hub's looks like wss://mcp.example.com." };
  }
  const local = url.hostname === HOST || url.hostname === "localhost";
  if (url.protocol === "ws:" && !local) return { ok: false, error: "A hub on another machine needs wss://, so the token travels encrypted." };
  if (url.protocol !== "wss:" && url.protocol !== "ws:") return { ok: false, error: "The address starts with wss://." };
  if (url.username || url.password || url.search || url.hash) return { ok: false, error: "No user name, query or fragment in the address." };
  const server = url.toString().replace(/\/$/, "");
  return { ok: true, server: server === LOCAL_URL ? null : server };
}

/** The address the socket opens. */
export const urlOf = (server: string | null): string => server ?? LOCAL_URL;

/** How the plugin window names it. */
export const placeOf = (server: string | null): string => (server === CLOUD_URL ? CLOUD_NAME : server ? new URL(server).host : "this computer");

