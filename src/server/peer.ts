// Bridge ⇄ bridge messages: how several MCP clients share one Figma connection.
//
// The process that binds 127.0.0.1:38452 is the hub — it owns the plugin
// sessions. A process that finds the port taken connects to it as a peer and
// forwards its tool calls (spec §4.2 anticipated this split; the plugin
// protocol is unchanged — plugins never send `peer-hello`). Peers prove they
// belong to the same installation with the same token the plugin uses.

import { z } from "zod";

export const PEER_PROTOCOL_VERSION = 1;

/**
 * What a process can do beyond peer protocol 1, said in `peer-hello` and
 * `peer-welcome`. Additions go here, not into the version: a hub refuses a
 * version it does not know, so a new version would cut a new proxy off from
 * an older hub. An older process drops the field and so offers nothing.
 *
 * - "result-chunks": the hub may send a call-result whose binary payload is
 *   larger than one frame as a head plus `call-chunk` frames, as the plugin
 *   does (protocol.md §2). A proxy's socket takes frames up to maxFrameBytes
 *   (32 MiB): a 30 MiB video in one frame closed it with 1009 and lost the
 *   result as "the hub exited" (2026-10-14 audit).
 */
export const PEER_FEATURES = ["result-chunks"] as const;
export type PeerFeature = (typeof PEER_FEATURES)[number];

export interface PeerCallOptions {
  session?: string;
  idempotencyKey?: string;
  idleTimeoutMs?: number;
  /**
   * The proxy's own BRIDGE_ALLOW_UNVERIFIED. The flag belongs to the process
   * the MCP client talks to, as BRIDGE_ALLOW_EVAL does, so the hub applies its
   * own flag OR this one, for this call only. Optional, so an older hub simply
   * strips it and stays strict.
   */
  allowUnverified?: boolean;
  /**
   * The figma_export_video job a render belongs to in the proxy, so the BUSY
   * the hub answers other calls with names it. Optional: an older hub strips it.
   */
  jobId?: string;
  /**
   * A write's stale-write guard (trust spec §2.3): the proxy's own
   * BRIDGE_CONFLICTS and the call's `force`, sent on to the plugin as they
   * are. Like allowUnverified the mode belongs to the process the MCP client
   * talks to. Optional: an older hub strips it and sends no guard, and the
   * plugin then refuses nothing.
   */
  guard?: { conflicts: "refuse" | "warn" | "off"; force?: boolean; agent?: string };
}

export type PeerToHub =
  | { t: "peer-hello"; protocolVersion: number; token: string; pid: number; serverVersion: string; features?: string[] }
  | { t: "call"; id: string; op: string; params: Record<string, unknown>; opts: PeerCallOptions }
  | { t: "call-cancel"; id: string }
  | { t: "status-request"; id: string };

export interface PeerError {
  code: string;
  message: string;
  hint?: string;
  idempotencyKey?: string;
  partial?: unknown;
}

/** Where a chunked payload goes back: a Buffer the hub held, or a base64 string. */
export type ChunkField = "binary" | "base64";

export type HubToPeer =
  | { t: "peer-welcome"; hubPid: number; serverVersion: string; features?: string[] }
  /**
   * Sent before the hub closes a proxy whose token differs (4001), so the
   * proxy can say which process holds the port and which token file it uses.
   * An older hub closes without it.
   */
  | { t: "peer-refused"; hubPid: number; tokenPath: string | null; fingerprint: string }
  | { t: "call-progress"; id: string; done: number; total?: number; phase?: string }
  /** With `chunks`: `data` is the head, and `field` arrives in that many `call-chunk` frames ("result-chunks"). */
  | { t: "call-result"; id: string; ok: true; data: unknown; chunks?: number; field?: ChunkField }
  | { t: "call-result"; id: string; ok: false; error: PeerError }
  | { t: "call-chunk"; id: string; seq: number; base64: string }
  | { t: "status-result"; id: string; status: unknown };

const str = z.string();
const id = z.string().min(1);

const peerToHub = z.union([
  z.object({
    t: z.literal("peer-hello"),
    protocolVersion: z.number(),
    token: str,
    pid: z.number(),
    serverVersion: str,
    features: z.array(str).optional(),
  }),
  z.object({
    t: z.literal("call"),
    id,
    op: z.string().min(1),
    params: z.record(z.string(), z.unknown()),
    opts: z.object({
      session: str.optional(),
      idempotencyKey: str.optional(),
      idleTimeoutMs: z.number().optional(),
      allowUnverified: z.boolean().optional(),
      jobId: str.optional(),
      guard: z.object({ conflicts: z.enum(["refuse", "warn", "off"]), force: z.boolean().optional(), agent: z.string().max(64).optional() }).optional(),
    }),
  }),
  z.object({ t: z.literal("call-cancel"), id }),
  z.object({ t: z.literal("status-request"), id }),
]);

const peerError = z.object({
  code: str,
  message: str,
  hint: str.optional(),
  idempotencyKey: str.optional(),
  partial: z.unknown().optional(),
});

const hubToPeer = z.union([
  z.object({ t: z.literal("peer-welcome"), hubPid: z.number(), serverVersion: str, features: z.array(str).optional() }),
  z.object({ t: z.literal("peer-refused"), hubPid: z.number(), tokenPath: str.nullable(), fingerprint: str }),
  z.object({ t: z.literal("call-progress"), id, done: z.number(), total: z.number().optional(), phase: str.optional() }),
  z.object({
    t: z.literal("call-result"),
    id,
    ok: z.literal(true),
    data: z.unknown(),
    chunks: z.number().int().min(1).optional(),
    field: z.enum(["binary", "base64"]).optional(),
  }),
  z.object({ t: z.literal("call-result"), id, ok: z.literal(false), error: peerError }),
  z.object({ t: z.literal("call-chunk"), id, seq: z.number().int().min(0), base64: str }),
  z.object({ t: z.literal("status-result"), id, status: z.unknown() }),
]);

function parse<T>(schema: z.ZodType, text: string): T | null {
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? (r.data as T) : null;
  } catch {
    return null;
  }
}

export const parsePeerToHub = (text: string) => parse<PeerToHub>(peerToHub, text);
export const parseHubToPeer = (text: string) => parse<HubToPeer>(hubToPeer, text);
