// Time-sliced work for the plugin sandbox — spec §5.5 Limit 1.
//
// The yield spike settled the three questions documents could not (spec §14.1,
// spikes/results/yield.json, Figma desktop 126.9.11):
//   A  setTimeout exists, fires, and yields — the default (code.ts YIELD_MODE);
//   B  the iframe ping-pong also yields — the automatic fallback when
//      setTimeout is missing (timerYield() returns null);
//   C  a microtask never yields: 7 of 7 runs blocked the editor completely.
// Each yield costs about one rendered frame (~18–20 ms), because the editor
// repaints in its turn. setTimeout is still only reached through a
// feature-detect, never called directly (test/sandbox-globals.test.ts).

export type YieldToHost = () => Promise<void>;
export type YieldMode = "timer" | "ui" | "microtask";

export class CancelledError extends Error {
  readonly done: number;
  constructor(done: number) {
    super(`Cancelled after ${done} item(s).`);
    this.name = "CancelledError";
    this.done = done;
  }
}

export interface ChunkOptions {
  yieldToHost: YieldToHost;
  /** Time budget per slice; default 12 ms. */
  budgetMs?: number;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
  now?: () => number;
}

export async function forEachChunked<T>(
  items: readonly T[],
  work: (item: T, i: number) => void | Promise<void>,
  opts: ChunkOptions,
): Promise<void> {
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? 12;
  let sliceStart = now();
  for (let i = 0; i < items.length; i++) {
    await work(items[i] as T, i);
    if (now() - sliceStart >= budget) {
      opts.onProgress?.(i + 1, items.length);
      await opts.yieldToHost(); // the host gets a turn: repaint, input, a cancel message
      if (opts.isCancelled?.()) throw new CancelledError(i + 1);
      sliceStart = now();
    }
  }
  opts.onProgress?.(items.length, items.length);
}

/**
 * forEachChunked for work that is not a flat list — a recursive tree build.
 * Call `tick()` after each unit: it yields when the slice has spent its budget,
 * reports progress, and throws CancelledError once a cancel has arrived.
 */
export interface Pacer {
  readonly done: number;
  tick(): Promise<void>;
}

export function createPacer(total: number, opts: ChunkOptions): Pacer {
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? 12;
  let sliceStart = now();
  let done = 0;
  return {
    get done() {
      return done;
    },
    async tick() {
      done++;
      if (now() - sliceStart < budget) return;
      opts.onProgress?.(done, total);
      await opts.yieldToHost();
      if (opts.isCancelled?.()) throw new CancelledError(done);
      sliceStart = now();
    },
  };
}

export async function mapChunked<T, R>(
  items: readonly T[],
  work: (item: T, i: number) => R | Promise<R>,
  opts: ChunkOptions,
): Promise<R[]> {
  const out: R[] = [];
  await forEachChunked(items, async (item, i) => {
    out.push(await work(item, i));
  }, opts);
  return out;
}

/** Option A — only when the spike shows setTimeout exists in the sandbox. */
export function timerYield(): YieldToHost | null {
  const st = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout;
  if (typeof st !== "function") return null;
  return () => new Promise<void>((resolve) => void st(resolve, 0));
}

/**
 * A delay primitive, feature-detected like everything else here.
 *
 * This exists so that code needing a TIMER (rather than a yield) does not reach
 * for `setTimeout` directly — the sandbox-globals guard allows exactly one file
 * to touch it, and that rule is worth more than the convenience of a direct call.
 * Returns null when the sandbox has no timer, so a caller can fall back to the
 * scheduler's `delay` (served by the iframe) instead of assuming.
 *
 * Distinct from `yieldToHost`: a yield gives the host a turn as soon as possible,
 * a delay gives up at least `ms`. A timeout needs the second.
 */
export function timerDelay(): ((ms: number) => Promise<void>) | null {
  const st = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout;
  if (typeof st !== "function") return null;
  return (ms: number) => new Promise<void>((resolve) => void st(resolve, ms));
}

/** Option C — expected NOT to hand control to the host (C-013); kept for the spike's evidence. */
export const microtaskYield: YieldToHost = () => Promise.resolve();

/**
 * Option B, plus a delay primitive, both served by the UI iframe. The reply
 * should arrive as a new host task, giving the editor a turn while the sandbox
 * awaits it — expected, not documented; spike 1 measures it (probe latency).
 */
export interface UiScheduler {
  yieldToHost: YieldToHost;
  delay(ms: number): Promise<void>;
  /** Feed every `{ kind: "tick", id }` the UI sends back. */
  onTick(id: number): void;
}

export function createUiScheduler(post: (msg: { kind: "tick-request"; id: number; ms: number }) => void): UiScheduler {
  let next = 1;
  const pending = new Map<number, () => void>();
  const request = (ms: number) =>
    new Promise<void>((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      post({ kind: "tick-request", id, ms });
    });
  return {
    yieldToHost: () => request(0),
    delay: (ms) => request(ms),
    onTick(id) {
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve();
      }
    },
  };
}

export function chooseYield(mode: YieldMode, ui: UiScheduler): YieldToHost {
  if (mode === "timer") return timerYield() ?? ui.yieldToHost;
  if (mode === "microtask") return microtaskYield;
  return ui.yieldToHost;
}

/**
 * protocol.md §2: progress at least once per second and at most once per
 * 250 ms — a 12 ms yield must not become 83 messages a second. The final
 * value (done === total) always goes through.
 */
export function throttleProgress(
  send: (done: number, total?: number, phase?: string) => void,
  minIntervalMs = 250,
  now: () => number = Date.now,
): (done: number, total?: number, phase?: string) => void {
  let last = -Infinity;
  return (done, total, phase) => {
    const t = now();
    if (t - last < minIntervalMs && done !== total) return;
    last = t;
    send(done, total, phase);
  };
}
