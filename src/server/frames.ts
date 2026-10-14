// Validation of plugin → bridge frames (protocol.md §2). Unknown fields are
// dropped, as protocol.md §10 requires receivers to ignore them.

import { z } from "zod";
import type { PluginToServer } from "../shared/protocol.js";

const str = z.string();
const nonEmpty = z.string().min(1);

const hello = z.object({
  t: z.literal("hello"),
  protocolVersion: z.number(),
  token: str,
  instanceId: nonEmpty,
  pluginVersion: str,
  apiVersion: str,
  editorType: str,
  ops: z.array(str),
  file: z.object({ name: str.nullable(), key: str.nullable() }),
  page: z.object({ id: str, name: str }).nullable(),
  user: z.object({ id: str.nullable(), name: str }).nullable(),
  // Without this the schema stripped the field, and figma_status reported
  // build.plugin: null for every plugin — measured live on 2026-10-08.
  buildId: str.optional(),
});

const wireError = z.object({ code: str, message: str, hint: str.optional() });

const result = z.union([
  z.object({ t: z.literal("result"), id: nonEmpty, ok: z.literal(true), data: z.unknown() }),
  z.object({
    t: z.literal("result"),
    id: nonEmpty,
    ok: z.literal(false),
    error: wireError,
    partial: z.unknown().optional(),
  }),
]);

const chunk = z.object({ t: z.literal("chunk"), id: nonEmpty, seq: z.number().int().min(0), base64: str });

const progress = z.object({
  t: z.literal("progress"),
  id: nonEmpty,
  done: z.number(),
  total: z.number().optional(),
  phase: str.optional(),
});

const nodeIds = z.array(str);
const event = z.union([
  z.object({
    t: z.literal("event"),
    name: z.literal("selection_changed"),
    data: z.object({ nodeIds, count: z.number(), at: z.number() }),
  }),
  z.object({
    t: z.literal("event"),
    name: z.literal("page_changed"),
    data: z.object({ pageId: str, pageName: str }),
  }),
  z.object({
    t: z.literal("event"),
    name: z.literal("nodes_changed"),
    data: z.object({ count: z.number(), nodeIds, at: z.number() }),
  }),
]);

const log = z.object({
  t: z.literal("log"),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: str,
});

const pong = z.object({ t: z.literal("pong"), at: z.number() });

const frame = z.union([hello, result, chunk, progress, event, log, pong]);

export type ParsedFrame = { ok: true; msg: PluginToServer } | { ok: false; reason: string };

/** Parse one text frame from the plugin. Never throws. */
export function parseFrame(text: string): ParsedFrame {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  const r = frame.safeParse(json);
  if (!r.success) {
    const t = typeof json === "object" && json && "t" in json ? String((json as { t: unknown }).t) : "?";
    return { ok: false, reason: `invalid "${t}" frame: ${r.error.issues[0]?.message ?? "schema mismatch"}` };
  }
  return { ok: true, msg: r.data as PluginToServer };
}
