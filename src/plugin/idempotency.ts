// The plugin-side idempotency map — protocol.md §3 "Idempotency".
// Lives in sandbox memory: it survives WebSocket reconnects and bridge
// restarts, and is lost when the plugin closes.

export type StoredResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; hint?: string }; partial?: unknown };

/**
 * True only for a failure that says, explicitly, that nothing was created:
 * `partial.created` is an empty array. Everything else — successes, failures
 * without that statement, failures after partial work — counts as possibly
 * applied and is recorded, because executing twice is worse than replaying a
 * stale error.
 */
export function changedNothing(result: StoredResult): boolean {
  if (result.ok) return false;
  const partial = result.partial as { created?: unknown } | undefined;
  return !!partial && Array.isArray(partial.created) && partial.created.length === 0;
}

interface Entry {
  op: string;
  status: "running" | "done";
  /** Request ids to answer when the op finishes (the original first). */
  waiters: string[];
  result: StoredResult | null;
  doneAt: number;
}

export type BeginOutcome =
  | { kind: "execute" }
  | { kind: "attach" }
  | { kind: "replay"; result: StoredResult }
  | { kind: "conflict"; op: string };

export interface StoreOptions {
  max?: number;
  ttlMs?: number;
  now?: () => number;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: StoreOptions = {}) {
    this.max = opts.max ?? 1000;
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  status(key: string): Entry["status"] | null {
    this.expire();
    return this.entries.get(key)?.status ?? null;
  }

  begin(key: string, op: string, requestId: string): BeginOutcome {
    this.expire();
    const e = this.entries.get(key);
    if (!e) {
      this.entries.set(key, { op, status: "running", waiters: [requestId], result: null, doneAt: 0 });
      return { kind: "execute" };
    }
    if (e.op !== op) return { kind: "conflict", op: e.op };
    if (e.status === "running") {
      e.waiters.push(requestId);
      return { kind: "attach" };
    }
    // LRU touch
    this.entries.delete(key);
    this.entries.set(key, e);
    return { kind: "replay", result: e.result! };
  }

  /** Record the outcome; returns every request id that must receive it. */
  complete(key: string, result: StoredResult): string[] {
    const e = this.entries.get(key);
    if (!e) return [];
    const waiters = e.waiters;
    e.status = "done";
    e.result = result;
    e.waiters = [];
    e.doneAt = this.now();
    this.evict();
    return waiters;
  }

  /**
   * Forget a key whose op provably changed nothing (it was rejected before
   * acting). Returns every request id that must still be answered. Without
   * this, a corrected retry under the same key would replay the stale error
   * for 15 minutes; with it, the key binds only work that actually happened.
   */
  abandon(key: string): string[] {
    const e = this.entries.get(key);
    if (!e) return [];
    this.entries.delete(key);
    return e.waiters;
  }

  /** Detach a cancelled request; true when nobody is waiting on the op any more. */
  detach(key: string, requestId: string): boolean {
    const e = this.entries.get(key);
    if (!e || e.status !== "running") return true;
    e.waiters = e.waiters.filter((w) => w !== requestId);
    return e.waiters.length === 0;
  }

  waiters(key: string): readonly string[] {
    return this.entries.get(key)?.waiters ?? [];
  }

  get size(): number {
    return this.entries.size;
  }

  private expire(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [k, e] of this.entries) if (e.status === "done" && e.doneAt <= cutoff) this.entries.delete(k);
  }

  private evict(): void {
    if (this.entries.size <= this.max) return;
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.max) break;
      if (e.status === "done") this.entries.delete(k); // oldest first; running entries are never evicted
    }
  }
}
