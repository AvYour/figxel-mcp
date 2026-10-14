// Cues derived from an animated frame (figma_generate_audio { nodeId }): small
// synthetic snapshots for each kind, then the 2026-10-09 ad as recorded, where
// the cuts the critics named become hits and the staggered type one whoosh.

import { describe, expect, it } from "vitest";
import { cuesFromMotion, WHOOSH_SPEED } from "../src/server/audio-cues.js";
import { soundEvents } from "../src/server/motion-audit.js";
import { cutPairKeys, type KeyText, type MotionSnapshot, type SnapshotNode, type SnapshotTrack } from "../src/shared/motion-curves.js";
import { loadSnapshot } from "./fixtures/motion-2026-10-09/snapshot.js";

const F = (k: number) => k / 30;
const K = (t: number, value: string | number, easing?: string): KeyText => ({ t, value: String(value), ...(easing ? { easing } : {}) });
const track = (field: string, ...keyframes: KeyText[]): SnapshotTrack => ({ field, keyframes });
const OUT = "cubic:0.16,1,0.3,1";
type N = Partial<SnapshotNode> & { name: string };

/** A 1080 × 1920 frame; layers default to 200 × 200 rectangles directly in it. */
function snap(nodes: N[], durationS = 3): MotionSnapshot {
  const root: SnapshotNode = { id: "1:1", name: "Frame", type: "FRAME", parentId: null, width: 1080, height: 1920 };
  const list = nodes.map((n, i): SnapshotNode => ({ id: `2:${i + 1}`, type: "RECTANGLE", width: 200, height: 200, x: 440, y: 860, parentId: "1:1", ...n }));
  return { root: { id: "1:1", name: "Frame", width: 1080, height: 1920, durationS }, nodes: [root, ...list], truncated: false, maxNodes: 2000 };
}

describe("cues from small frames", () => {
  it("a fast move gets a whoosh as long as the move, starting with it; a slow drift gets none", () => {
    const fast = snap([{ name: "Card", x: 700, tracks: [track("TRANSLATION_X", K(0, 0), K(F(12), 0), K(F(24), -900, OUT))] }]);
    const d = cuesFromMotion(soundEvents(fast, 30));
    expect(d.cues).toHaveLength(1);
    expect(d.cues[0]).toMatchObject({ t: 0.4, type: "whoosh", durationS: 0.4 });
    expect(d.cues[0]!.intensity).toBeGreaterThan(0.6);
    // The card sits right of centre: the whoosh is panned right.
    expect(d.cues[0]!.pan).toBeGreaterThan(0);
    expect(d.cues[0]!.note).toMatch(/"Card" moves 900 px \(TRANSLATION_X\) over f12–f24/);
    const drift = snap([{ name: "Drift", tracks: [track("TRANSLATION_X", K(0, 0), K(F(90), 40))] }]);
    expect(cuesFromMotion(soundEvents(drift, 30)).cues).toEqual([]);
    expect(WHOOSH_SPEED).toBe(0.5);
  });

  it("a stagger shares one whoosh, from its first start to its last end", () => {
    const letters = ["a", "b", "c", "d"].map((name, i): N => ({ name, tracks: [track("TRANSLATION_Y", K(0, 400), K(F(10 + 2 * i), 400), K(F(22 + 2 * i), 0, OUT))] }));
    const d = cuesFromMotion(soundEvents(snap(letters), 30));
    expect(d.cues).toHaveLength(1);
    expect(d.cues[0]).toMatchObject({ type: "whoosh", t: 0.333, durationS: 0.6 });
    expect(d.cues[0]!.note).toMatch(/with 3 more in a stagger/);
  });

  it("a scene switched on is a hit; text that appears is a tick, unless a hit covers it", () => {
    const s = snap([
      { name: "Scene 2", type: "FRAME", width: 1080, height: 1920, x: 0, y: 0, tracks: [track("OPACITY", K(0, 0), ...cutPairKeys(30, 30, "0", "1"))] },
      { name: "Title", type: "TEXT", characters: "Fired by hand", width: 600, height: 120, tracks: [track("OPACITY", K(0, 0), ...cutPairKeys(60, 30, "0", "1"))] },
      { name: "Caption", type: "TEXT", characters: "Same frame as the cut", width: 600, height: 80, tracks: [track("OPACITY", K(0, 0), ...cutPairKeys(31, 30, "0", "1"))] },
    ]);
    const d = cuesFromMotion(soundEvents(s, 30));
    expect(d.cues.map((c) => [c.type, c.t])).toEqual([
      ["hit", 1],
      ["tick", 2],
    ]);
    expect(d.cues[0]).toMatchObject({ intensity: 0.9, note: 'scene cut: "Scene 2" on f30' });
    expect(d.cues[1]!.note).toBe('text "Fired by hand" appears on f60');
    expect(d.counts).toEqual({ whoosh: 0, hit: 1, tick: 1 });
  });

  it("past the cap, hits stay and ticks go first", () => {
    const many = Array.from({ length: 8 }, (_, i): N => ({ name: `T${i}`, type: "TEXT", characters: `Line ${i}`, tracks: [track("OPACITY", K(0, 0), ...cutPairKeys(10 + 6 * i, 30, "0", "1"))] }));
    const s = snap([{ name: "Scene", type: "FRAME", width: 1080, height: 1920, x: 0, y: 0, tracks: [track("OPACITY", K(0, 0), ...cutPairKeys(80, 30, "0", "1"))] }, ...many]);
    const d = cuesFromMotion(soundEvents(s, 30), 3);
    expect(d.cues.map((c) => c.type)).toEqual(["tick", "tick", "hit"]);
    expect(d.dropped).toBe(6);
  });
});

describe("cues from the 2026-10-09 ad (r2)", () => {
  const d = cuesFromMotion(soundEvents(loadSnapshot("r2"), 30));

  it("the scene cuts are hits on their frames, near cuts merged", () => {
    const hits = d.cues.filter((c) => c.type === "hit");
    expect(hits.map((h) => h.t)).toEqual(expect.arrayContaining([3.633, 6, 9.533]));
    expect(hits.find((h) => h.t === 9.533)!.note).toBe('scene cut: "S5 · Offer + CTA" on f286');
    // f276 and f278, two frames apart, are one hit.
    expect(hits.filter((h) => h.t >= 9.19 && h.t <= 9.27)).toHaveLength(1);
  });

  it("the opening word stagger is one whoosh, and every cue lies inside the 14.4 s timeline", () => {
    const first = d.cues.find((c) => c.type === "whoosh" && /S1\/Down/.test(c.note));
    expect(first).toMatchObject({ t: 0.6 });
    expect(first!.note).toMatch(/more in a stagger/);
    for (const c of d.cues) expect(c.t).toBeLessThan(14.4);
    expect(d.cues.length).toBeGreaterThan(15);
    expect(d.cues.length).toBeLessThanOrEqual(48);
    expect(d.dropped).toBe(0);
  });

  it("is deterministic", () => {
    expect(cuesFromMotion(soundEvents(loadSnapshot("r2"), 30))).toEqual(d);
  });
});
