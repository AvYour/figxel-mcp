// walk() gives the host a turn by TIME, not by node count, and reports progress
// when it does [C-124]. Measured live: a scan that yielded every 200 nodes spent
// ~27 s on a 5,000-node page while Figma was in the background (each throttled
// yield about a second), never reported progress, and was declared STALLED —
// with every call queued behind it stalling too.

import { describe, expect, it } from "vitest";
import { collect, walk, type NodeLike } from "../src/plugin/read.js";

function flatPage(n: number): NodeLike {
  const children = Array.from({ length: n }, (_, i) => ({ id: `1:${i + 2}`, name: `R${i}`, type: "RECTANGLE" }) as unknown as NodeLike);
  return { id: "0:1", name: "Page", type: "PAGE", children } as unknown as NodeLike;
}

function host() {
  const calls = { yields: 0, progress: [] as number[] };
  let cancelled = false;
  return {
    calls,
    cancel: () => void (cancelled = true),
    ctx: {
      yieldToHost: async () => void calls.yields++,
      isCancelled: () => cancelled,
      progress: (done: number) => void calls.progress.push(done),
    },
  };
}

describe("walk slices by time [C-124]", () => {
  it("a walk that fits in one slice never yields — 5,000 nodes, no 25 throttled yields", async () => {
    const h = host();
    let seen = 0;
    await walk(flatPage(5000), () => void seen++, h.ctx, { now: () => 0 });
    expect(seen).toBe(5001);
    expect(h.calls.yields).toBe(0);
  });

  it("once the budget is spent it reports progress, then yields", async () => {
    const h = host();
    let t = 0;
    await walk(flatPage(1000), () => void (t += 0.1), h.ctx, { now: () => t, budgetMs: 12, yieldEvery: 50 });
    // 100 ms of work in 12 ms slices, checked every 50 nodes (5 ms) → a yield every 15 ms.
    expect(h.calls.yields).toBeGreaterThanOrEqual(5);
    expect(h.calls.progress).toHaveLength(h.calls.yields);
    expect(h.calls.progress.every((d, i, a) => i === 0 || d > a[i - 1]!)).toBe(true);
  });

  it("a cancel is seen at the next slice boundary", async () => {
    const h = host();
    let t = 0;
    const p = walk(flatPage(1000), (n) => {
      t += 1;
      if (n.name === "R100") h.cancel();
    }, h.ctx, { now: () => t, budgetMs: 12, yieldEvery: 10 });
    await expect(p).rejects.toThrow(/Cancelled/);
  });

  it("collect stops at the first match past the page, whatever the clock", async () => {
    const h = host();
    const { items, more } = await collect(flatPage(5000), (n) => n.type === "RECTANGLE", 1, 0, h.ctx, { now: () => 0 });
    expect(items.map((n) => n.name)).toEqual(["R0"]);
    expect(more).toBe(true);
    expect(h.calls.yields).toBe(0);
  });
});
