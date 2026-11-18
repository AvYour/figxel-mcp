// Limits per person on a team's hub (docs/hub.md § Limits per person): the
// calls a person may make in a minute, through the web endpoint and through
// the relay, and the size of their folder on the server. A hub open to anyone
// is a shared server; on one computer none of this applies.
//
// Each refusal is BUSY: nothing ran, the cause passes by itself, and the hint
// says when to try again (`partial.retryAfterS` carries the seconds). A proxy
// of an older release knows BUSY, so the relay's refusal reads right there too.

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { BridgeError, ErrorCode } from "../shared/errors.js";

/**
 * At most `max` uses per key within a window that starts at the key's first
 * use; `max` 0 is no limit. A cheap guard for endpoints anyone may call, and
 * for a person's calls a minute.
 */
export class Budget {
  private readonly uses = new Map<string, { n: number; since: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  /** Counts `n` uses; false once the key's window holds more than `max`. */
  take(key: string, n = 1): boolean {
    if (this.max <= 0) return true;
    const now = Date.now();
    if (this.uses.size > 10_000) for (const [k, u] of this.uses) if (now - u.since > this.windowMs) this.uses.delete(k);
    let u = this.uses.get(key);
    if (!u || now - u.since > this.windowMs) this.uses.set(key, (u = { n: 0, since: now }));
    u.n += n;
    return u.n <= this.max;
  }
  /** How long until the key's window ends and its count starts again from nothing. */
  waitMs(key: string): number {
    const u = this.uses.get(key);
    return u ? Math.max(0, u.since + this.windowMs - Date.now()) : 0;
  }
}

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
const megabytes = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const span = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${seconds(ms)} s`);

/**
 * The BUSY a call gets past a person's limit a minute. `what` names what is
 * counted, `setting` the variable the operator sets it with.
 */
export function overLimit(what: string, max: number, waitMs: number, setting: string): BridgeError {
  const s = seconds(waitMs);
  return new BridgeError(ErrorCode.BUSY, `Too many ${what}: at most ${max} a minute per person.`, {
    hint: `Nothing ran. Try again in ${s} s. Whoever runs the hub sets the limit (${setting}).`,
    partial: { created: [], retryAfterS: s },
  });
}

/** A person's folder on a hub's web endpoint (web.ts): its size limit, and how long a file in it lasts. */
export interface FolderQuota {
  bytes: number;
  ttlMs: number;
}

/**
 * Room for a new file in `dir`, a person's folder. Its expired files go first
 * (the hub's sweep deletes them within a minute anyway); then, while the rest
 * hold the quota or more, a new file is refused with BUSY until the oldest of
 * them expires. The check comes before a write, never after: the file that
 * crosses the quota is kept, so a render Figma spent minutes on is not lost.
 */
export async function ensureRoom(dir: string, quota: FolderQuota, now = Date.now()): Promise<void> {
  const use = await measure(dir, now - quota.ttlMs);
  if (use.bytes < quota.bytes) return;
  const freesAt = (use.oldest ?? now) + quota.ttlMs;
  const s = seconds(freesAt - now);
  throw new BridgeError(ErrorCode.BUSY, `Your folder on this hub is full: ${megabytes(use.bytes)} MB of the ${megabytes(quota.bytes)} MB it may hold.`, {
    hint:
      `Nothing was written. Each file is deleted ${span(quota.ttlMs)} after it was written, so room comes back by ` +
      `${new Date(freesAt).toISOString()} (in ${span(s * 1000)}), when the oldest goes: try again then. ` +
      "Whoever runs the hub sets the size (BRIDGE_HUB_WEB_FOLDER_MB).",
    partial: { created: [], retryAfterS: s },
  });
}

/** The size of the files under `dir`, and the oldest one's time; files last changed before `cutoff` are deleted on the way. */
async function measure(dir: string, cutoff: number): Promise<{ bytes: number; oldest: number | null }> {
  let bytes = 0;
  let oldest: number | null = null;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const inner = await measure(p, cutoff);
      bytes += inner.bytes;
      if (inner.oldest !== null && (oldest === null || inner.oldest < oldest)) oldest = inner.oldest;
      continue;
    }
    const info = await stat(p).catch(() => null);
    if (!info?.isFile()) continue;
    if (info.mtimeMs < cutoff) {
      await rm(p, { force: true });
      continue;
    }
    bytes += info.size;
    if (oldest === null || info.mtimeMs < oldest) oldest = info.mtimeMs;
  }
  return { bytes, oldest };
}
