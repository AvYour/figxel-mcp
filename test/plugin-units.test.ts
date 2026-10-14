import { describe, expect, it } from "vitest";
import {
  CancelledError,
  chooseYield,
  createUiScheduler,
  forEachChunked,
  mapChunked,
  microtaskYield,
  throttleProgress,
} from "../src/plugin/chunk.js";
import { IdempotencyStore } from "../src/plugin/idempotency.js";

function fakeClock(step = 1) {
  let t = 0;
  return { now: () => (t += step), set: (v: number) => (t = v), get: () => t };
}

describe("forEachChunked (spec §5.5 Limit 1)", () => {
  it("yields once per time budget, not per item", async () => {
    const clock = fakeClock(1); // every now() call advances 1 ms
    let yields = 0;
    await forEachChunked(Array.from({ length: 100 }), () => {}, {
      yieldToHost: async () => void yields++,
      budgetMs: 12,
      now: clock.now,
    });
    // each item costs one now() call → ~12 items per slice
    expect(yields).toBeGreaterThan(5);
    expect(yields).toBeLessThan(15);
  });

  it("checks for cancellation only after a real yield and reports how far it got", async () => {
    const clock = fakeClock(5);
    let cancelled = false;
    const err = await forEachChunked(Array.from({ length: 50 }), (_x, i) => {
      if (i === 10) cancelled = true;
    }, { yieldToHost: async () => {}, budgetMs: 12, now: clock.now, isCancelled: () => cancelled }).catch((e) => e);
    expect(err).toBeInstanceOf(CancelledError);
    expect((err as CancelledError).done).toBeGreaterThanOrEqual(11);
    expect((err as CancelledError).done).toBeLessThan(50);
  });

  it("reports progress at slice boundaries and once at the end", async () => {
    const clock = fakeClock(4);
    const seen: [number, number][] = [];
    await forEachChunked([1, 2, 3, 4, 5, 6, 7, 8], () => {}, {
      yieldToHost: async () => {},
      budgetMs: 10,
      now: clock.now,
      onProgress: (d, t) => seen.push([d, t]),
    });
    expect(seen.at(-1)).toEqual([8, 8]);
    expect(seen.length).toBeGreaterThan(1);
  });

  it("mapChunked keeps order", async () => {
    const out = await mapChunked([3, 1, 2], async (x) => x * 2, { yieldToHost: microtaskYield });
    expect(out).toEqual([6, 2, 4]);
  });
});

describe("UI scheduler — option B (ADR #22)", () => {
  it("resolves a yield only when the iframe answers", async () => {
    const posted: { id: number; ms: number }[] = [];
    const ui = createUiScheduler((m) => posted.push(m));
    let resumed = false;
    const p = ui.yieldToHost().then(() => (resumed = true));
    await Promise.resolve();
    expect(resumed).toBe(false);
    expect(posted).toEqual([{ kind: "tick-request", id: 1, ms: 0 }]);
    ui.onTick(1);
    await p;
    expect(resumed).toBe(true);
  });

  it("is the default when the timer option is unavailable", () => {
    const ui = createUiScheduler(() => {});
    expect(chooseYield("ui", ui)).toBe(ui.yieldToHost);
    expect(chooseYield("microtask", ui)).toBe(microtaskYield);
  });
});

describe("progress throttle (protocol.md §2)", () => {
  it("sends at most one message per 250 ms but always the final value", () => {
    const clock = fakeClock(0);
    const sent: number[] = [];
    const progress = throttleProgress((d) => sent.push(d), 250, () => clock.get());
    for (let i = 1; i <= 100; i++) {
      clock.set(i * 12); // a 12 ms yield cadence
      progress(i, 100);
    }
    expect(sent.length).toBeLessThanOrEqual(6);
    expect(sent.at(-1)).toBe(100);
  });
});

describe("IdempotencyStore (protocol.md §3)", () => {
  it("executes once, attaches while running, replays when done", () => {
    const s = new IdempotencyStore();
    expect(s.begin("k", "create_frame", "r-1")).toEqual({ kind: "execute" });
    expect(s.begin("k", "create_frame", "r-2")).toEqual({ kind: "attach" });
    expect(s.complete("k", { ok: true, data: { id: "1:1" } })).toEqual(["r-1", "r-2"]);
    expect(s.begin("k", "create_frame", "r-3")).toEqual({ kind: "replay", result: { ok: true, data: { id: "1:1" } } });
  });

  it("refuses a key reused for another op", () => {
    const s = new IdempotencyStore();
    s.begin("k", "create_frame", "r-1");
    expect(s.begin("k", "set_text", "r-2")).toEqual({ kind: "conflict", op: "create_frame" });
  });

  it("detach reports when nobody waits any more", () => {
    const s = new IdempotencyStore();
    s.begin("k", "create_frame", "r-1");
    s.begin("k", "create_frame", "r-2");
    expect(s.detach("k", "r-1")).toBe(false);
    expect(s.detach("k", "r-2")).toBe(true);
  });

  it("expires finished keys after 15 minutes", () => {
    let now = 0;
    const s = new IdempotencyStore({ now: () => now });
    s.begin("k", "create_frame", "r-1");
    s.complete("k", { ok: true, data: 1 });
    now = 15 * 60_000 + 1;
    expect(s.begin("k", "create_frame", "r-2")).toEqual({ kind: "execute" });
  });

  it("evicts the oldest finished keys past 1000, never a running one", () => {
    const s = new IdempotencyStore({ max: 3 });
    s.begin("running", "create_frame", "r-0");
    for (let i = 1; i <= 5; i++) {
      s.begin(`k${i}`, "create_frame", `r-${i}`);
      s.complete(`k${i}`, { ok: true, data: i });
    }
    expect(s.size).toBe(3);
    expect(s.status("running")).toBe("running");
    expect(s.status("k1")).toBeNull();
    expect(s.status("k5")).toBe("done");
  });
});
