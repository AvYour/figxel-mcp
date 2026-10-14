// Bridge ⇄ bridge messages: how several MCP clients share one Figma connection.
//
// The process that binds 127.0.0.1:38452 is the hub — it owns the plugin
// sessions. A process that finds the port taken connects to it as a peer and
// forwards its tool calls (spec §4.2 anticipated this split; the plugin
// protocol is unchanged — plugins never send `peer-hello`). Peers prove they
// belong to the same installation with the same token the plugin uses.

import { z } from "zod";

export const PEER_PROTOCOL_VERSION = 1;

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
}

export type PeerToHub =
  | { t: "peer-hello"; protocolVersion: number; token: string; pid: number; serverVersion: string }
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

export type HubToPeer =
  | { t: "peer-welcome"; hubPid: number; serverVersion: string }
  | { t: "call-progress"; id: string; done: number; total?: number; phase?: string }
  | { t: "call-result"; id: string; ok: true; data: unknown }
  | { t: "call-result"; id: string; ok: false; error: PeerError }
  | { t: "status-result"; id: string; status: unknown };

const str = z.string();
const id = z.string().min(1);

const peerToHub = z.union([
  z.object({ t: z.literal("peer-hello"), protocolVersion: z.number(), token: str, pid: z.number(), serverVersion: str }),
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
  z.object({ t: z.literal("peer-welcome"), hubPid: z.number(), serverVersion: str }),
  z.object({ t: z.literal("call-progress"), id, done: z.number(), total: z.number().optional(), phase: str.optional() }),
  z.object({ t: z.literal("call-result"), id, ok: z.literal(true), data: z.unknown() }),
  z.object({ t: z.literal("call-result"), id, ok: z.literal(false), error: peerError }),
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
