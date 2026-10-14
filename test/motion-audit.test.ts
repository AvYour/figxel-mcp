// figma_check_motion's rules (src/server/motion-audit.ts), one block per rule
// on small synthetic snapshots: the positive case, the negative case, the
// boundary of its threshold, and the exemption it documents. The thresholds
// themselves are pinned against the run's recordings in
// test/motion-audit-fixtures.test.ts.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Bridge } from "../src/server/bridge.js";
import { cutPairKeys, type KeyText, type MotionSnapshot, type SnapshotNode, type SnapshotTrack } from "../src/shared/motion-curves.js";
import { auditMotion, DEFAULT_THRESHOLDS, FIX_EASINGS, RULE_IDS, VARIANTS, type AuditOptions, type MotionIssue } from "../src/server/motion-audit.js";
import { auditOptions, CHECK_MOTION_SHAPE, registerCheckMotion } from "../src/server/tools/check-motion.js";

const IN = "cubic:0.7,0,0.84,0";
const OUT = "cubic:0.16,1,0.3,1";
const L = "LINEAR";
const F = (k: number) => k / 30;
const K = (t: number, value: string | number, easing?: string): KeyText => ({ t, value: String(value), ...(easing ? { easing } : {}) });
const track = (field: string, ...keyframes: KeyText[]): SnapshotTrack => ({ field, keyframes });
/** OPACITY switched by a cut pair on frame k [C-240]. */
const switchAt = (k: number, from: number, to: number) => track("OPACITY", K(0, from), ...cutPairKeys(k, 30, String(from), String(to)));

type N = Partial<SnapshotNode> & { name: string };
const ROOT = "1:1";

/** A 1080 × 1920 frame; layers default to 200 × 200 rectangles directly in it. */
function snap(nodes: N[], durationS = 2): MotionSnapshot {
  const root: SnapshotNode = { id: ROOT, name: "Frame", type: "FRAME", parentId: null, width: 1080, height: 1920, clipsContent: true };
  const list = nodes.map((n, i): SnapshotNode => ({ id: `2:${i + 1}`, type: "RECTANGLE", width: 200, height: 200, parentId: ROOT, ...n }));
  return { root: { id: ROOT, name: "Frame", width: 1080, height: 1920, durationS }, nodes: [root, ...list], truncated: false, maxNodes: 2000 };
}

const run = (s: MotionSnapshot, opts: AuditOptions = {}) => auditMotion(s, { limit: 500, ...opts });
const of = (issues: MotionIssue[], rule: string, name?: string) => issues.filter((i) => i.rule === rule && (name === undefined || i.name === name));
const rules = (s: MotionSnapshot, opts: AuditOptions = {}) => run(s, opts).issues.map((i) => `${i.rule}:${i.name}:f${i.frame}`);

describe("the catalogue", () => {
  it("has the plan's 22 rules (brand_late and cta_short counted apart) and four narrower names", () => {
    expect(RULE_IDS).toHaveLength(23);
    expect(Object.entries(VARIANTS)).toEqual([
      ["cut_at_rest", "vanish_mid_move"],
      ["stagger_off_grid", "no_stagger"],
      ["off_grid", "unrendered_extreme"],
      ["dimmed_text", "read_time"],
    ]);
    expect(DEFAULT_THRESHOLDS).toMatchObject({ stepShare: 0.4, stepPx: 24, strobeWarnPx: 150, aliveSpeedPx: 1, readSecondsPerWord: 0.3 });
  });
});

// ── vanish_mid_move / cut_at_rest ───────────────────────────────────────────

describe("vanish_mid_move: still 0.4 or more of its size when cut", () => {
  const band = (easing: string, extra: Partial<N> = {}) =>
    snap([
      {
        name: "Band",
        type: "ELLIPSE",
        width: 800,
        height: 800,
        tracks: [track("SCALE_XY", K(0, "1,1"), K(F(20), "1,1", L), K(F(35), "0.0025,0.0025", easing)), switchAt(33, 1, 0)],
        ...extra,
      },
    ]);

  it("fires when an accelerating close is cut while still three-quarters big, and names the easing that fixes it", () => {
    const [v] = of(run(band(IN)).issues, "vanish_mid_move");
    expect(v).toMatchObject({ severity: "warning", frame: 33, frames: [32, 33], field: "SCALE_XY" });
    expect(v!.detail).toMatch(/0\.75 on f32/);
    expect(v!.fix).toMatch(/^Change the easing of the SCALE_XY key at 1\.1667 s from cubic:0\.7,0,0\.84,0 to cubic:0\.45,0,0\.55,1: the last visible frame then shows 0\.0\d\.$/);
  });

  it("is quiet when the close has finished by the cut", () => {
    expect(of(run(band(FIX_EASINGS.draw)).issues, "vanish_mid_move")).toEqual([]);
  });

  it("counts from 0.4 of the size: 0.4 fires, 0.39 does not", () => {
    const at = (opacity: number) =>
      snap([{ name: "Chip", tracks: [track("OPACITY", K(0, opacity), ...cutPairKeys(10, 30, String(opacity), "0")), track("TRANSLATION_X", K(0, 0), K(F(20), 200, L))] }]);
    expect(of(run(at(0.4)).issues, "vanish_mid_move")).toHaveLength(1);
    expect(of(run(at(0.39)).issues, "vanish_mid_move")).toEqual([]);
  });

  it("a blur of 6 or more on the last frame covers the cut", () => {
    const blurred = band(IN);
    blurred.nodes[1]!.tracks!.push(track("effect:0:RADIUS", K(0, 10)));
    expect(of(run(blurred).issues, "vanish_mid_move")).toEqual([]);
  });

  it("a whole layer cut at rest is cut_at_rest (info), and so is a hand-off to a layer appearing on the same frame", () => {
    const r = run(
      snap([
        { name: "Still", tracks: [switchAt(10, 1, 0)] },
        { name: "Mover", tracks: [switchAt(20, 1, 0), track("TRANSLATION_X", K(0, 0), K(F(30), 300, L))] },
        { name: "Heir", tracks: [switchAt(20, 0, 1)] },
      ]),
    );
    expect(of(r.issues, "vanish_mid_move")).toEqual([]);
    expect(of(r.issues, "cut_at_rest").map((i) => [i.name, i.frame, i.severity])).toEqual([
      ["Still", 10, "info"],
      ["Mover", 20, "info"],
    ]);
    expect(of(r.issues, "cut_at_rest", "Mover")[0]!.detail).toMatch(/"Heir" appears on the same frame/);
  });

  it("a scene container's cut is not each child's vanish", () => {
    const s = snap([
      { name: "Scene", type: "FRAME", width: 1080, height: 1920, tracks: [switchAt(33, 1, 0)] },
      { name: "Child", type: "ELLIPSE", parentId: "2:1", width: 800, height: 800, tracks: [track("SCALE_XY", K(0, "1,1"), K(F(20), "1,1", L), K(F(35), "0,0", IN))] },
    ]);
    expect(of(run(s).issues, "vanish_mid_move")).toEqual([]);
  });
});

// ── pop_in ──────────────────────────────────────────────────────────────────

describe("pop_in: appears at most of its size in one frame", () => {
  const arrow = (width: number, easing = OUT) =>
    snap([
      {
        name: "Arrow",
        type: "VECTOR",
        width,
        height: 0,
        strokeCap: "ROUND",
        tracks: [switchAt(11, 0, 1), track("PATH_TRIM_END", K(0, 0), K(F(10), 0, L), K(F(15), 1, easing))],
      },
    ]);

  it("fires when a trim draw turns on already three-quarters drawn, and names the easing that fixes it", () => {
    const [p] = of(run(arrow(100)).issues, "pop_in");
    expect(p).toMatchObject({ severity: "warning", frame: 11, field: "PATH_TRIM_END" });
    expect(p!.detail).toMatch(/7\d % of its size \(\d+ px/);
    expect(p!.fix).toContain(FIX_EASINGS.draw);
  });

  it("is quiet when it draws on from nothing", () => {
    expect(of(run(arrow(100, FIX_EASINGS.draw)).issues, "pop_in")).toEqual([]);
  });

  it("a jump under stepPx (24 px) is too small to see: a 20 px tick is quiet", () => {
    expect(of(run(arrow(20)).issues, "pop_in")).toEqual([]);
  });

  it("a full-size layer cut in by opacity is a cut, not a pop", () => {
    expect(of(run(snap([{ name: "Card", tracks: [switchAt(10, 0, 1)] }])).issues, "pop_in")).toEqual([]);
  });
});

// ── concentrated_step ───────────────────────────────────────────────────────

describe("concentrated_step: one frame carrying 40 % or more of a move", () => {
  const word = (travel: number, easing = IN, extra: Partial<N> = {}) =>
    snap([{ name: "Word", type: "TEXT", width: 300, height: 100, tracks: [track("TRANSLATION_Y", K(0, 0), K(F(10), 0, L), K(F(16), travel, easing))], ...extra }]);

  it("fires on an accelerating exit, and names the easing that spreads it", () => {
    const [c] = of(run(word(200)).issues, "concentrated_step");
    expect(c).toMatchObject({ severity: "warning", frame: 16, field: "TRANSLATION_Y" });
    expect(c!.detail).toMatch(/^69 % of a 6-frame move/);
    expect(c!.fix).toContain(FIX_EASINGS.soft);
  });

  it("is quiet on an even move", () => {
    expect(of(run(word(200, FIX_EASINGS.soft)).issues, "concentrated_step")).toEqual([]);
  });

  it("a step under stepPx is not reported (30 px of travel), nor one under a 6 px blur or on a hidden frame", () => {
    expect(of(run(word(30)).issues, "concentrated_step")).toEqual([]);
    const blurred = word(200);
    blurred.nodes[1]!.tracks!.push(track("effect:0:RADIUS", K(0, 8)));
    expect(of(run(blurred).issues, "concentrated_step")).toEqual([]);
    const hidden = word(200);
    hidden.nodes[1]!.tracks!.push(switchAt(16, 1, 0));
    expect(of(run(hidden).issues, "concentrated_step")).toEqual([]);
  });

  it("a rise into a clipping mask hides its big first step: exempt; the same rise unmasked fires", () => {
    const rise = (clips: boolean) =>
      snap([
        { name: "Mask", type: "FRAME", width: 300, height: 100, clipsContent: clips },
        { name: "Text", type: "TEXT", parentId: "2:1", width: 300, height: 100, tracks: [track("TRANSLATION_Y", K(0, 100), K(F(10), 100, L), K(F(22), 0, OUT))] },
      ]);
    expect(of(run(rise(true)).issues, "concentrated_step")).toEqual([]);
    expect(of(run(rise(false)).issues, "concentrated_step")).toHaveLength(1);
  });

  it("thresholds override the defaults: stepShare 0.8 lets a 69 % step pass", () => {
    expect(of(run(word(200), { thresholds: { stepShare: 0.8 } }).issues, "concentrated_step")).toEqual([]);
  });
});

// ── strobe ──────────────────────────────────────────────────────────────────

describe("strobe: big steps without the blur to carry them [C-243]", () => {
  const mover = (perFrame: number, blur = 0) =>
    snap([{ name: "Logo", tracks: [track("TRANSLATION_X", K(0, 0), K(F(10), 0, L), K(F(15), perFrame * 5, L)), track("effect:0:RADIUS", K(0, blur))] }]);

  it("150 px or more per frame with no blur is a warning, one issue per run of frames", () => {
    const s = of(run(mover(200)).issues, "strobe");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ severity: "warning", frames: [11, 15] });
    expect(s[0]!.fix).toMatch(/peaking at about 13/);
  });

  it("60 px with no blur is info; 400 px is a warning whatever the blur; 300 px with blur 10 passes", () => {
    expect(of(run(mover(70)).issues, "strobe")[0]?.severity).toBe("info");
    expect(of(run(mover(50)).issues, "strobe")).toEqual([]);
    expect(of(run(mover(450, 10)).issues, "strobe")[0]).toMatchObject({ severity: "warning" });
    expect(of(run(mover(450, 10)).issues, "strobe")[0]!.fix).toMatch(/No blur covers/);
    expect(of(run(mover(300, 10)).issues, "strobe")).toEqual([]);
  });

  it("judges what moves on screen: a photo counter-translated inside a moving mask is still", () => {
    const s = snap([
      { name: "Mask", type: "FRAME", clipsContent: true, tracks: [track("TRANSLATION_X", K(0, 0), K(F(5), 1000, L))] },
      { name: "Photo", parentId: "2:1", tracks: [track("TRANSLATION_X", K(0, 0), K(F(5), -1000, L))] },
    ]);
    expect(of(run(s).issues, "strobe").map((i) => i.name)).toEqual(["Mask"]);
  });

  it("a cut pair is a cut, not a fast move", () => {
    const s = snap([{ name: "Jump", tracks: [track("TRANSLATION_X", K(0, 0), ...cutPairKeys(10, 30, "0", "500"))] }]);
    expect(of(run(s).issues, "strobe")).toEqual([]);
  });
});

// ── blur_off_speed ──────────────────────────────────────────────────────────

describe("blur_off_speed: the blur peaks away from the fastest frame", () => {
  const exit = (blur: KeyText[], travel = 400, effects?: SnapshotNode["effects"]) =>
    snap([
      {
        name: "Ash",
        type: "TEXT",
        width: 300,
        height: 276,
        ...(effects ? { effects } : {}),
        tracks: [track("TRANSLATION_Y", K(0, 0), K(F(10), 0, L), K(F(20), travel, IN)), track("effect:0:RADIUS", ...blur)],
      },
    ]);
  const early = [K(0, 0), K(F(16), 0, L), K(F(18), 8, FIX_EASINGS.soft), K(F(20), 0, L)];

  it("fires when the blur peaks two frames before the fastest, and keys the peak onto it", () => {
    const [b] = of(run(exit(early)).issues, "blur_off_speed");
    expect(b).toMatchObject({ severity: "warning", frame: 20, frames: [18, 20] });
    expect(b!.fix).toMatch(/peak on f20: @0\.6 0 · @0\.6667 \d+ · @0\.7333 0/);
  });

  it("is quiet when the blur peaks on the fastest frame", () => {
    expect(of(run(exit([K(0, 0), K(F(18), 0, L), K(F(20), 8, FIX_EASINGS.soft)])).issues, "blur_off_speed")).toEqual([]);
  });

  it("is quiet for a peak under 2 px, a move under 30 px a frame, or an effect that is not a layer blur", () => {
    expect(of(run(exit([K(0, 0), K(F(16), 0, L), K(F(18), 1.5, L), K(F(20), 0, L)])).issues, "blur_off_speed")).toEqual([]);
    expect(of(run(exit(early, 60)).issues, "blur_off_speed")).toEqual([]);
    expect(of(run(exit(early, 400, [{ type: "DROP_SHADOW", radius: 4 }])).issues, "blur_off_speed")).toEqual([]);
  });
});

// ── one_frame_extreme ───────────────────────────────────────────────────────

describe("one_frame_extreme: a peak on screen for one frame", () => {
  const punch = (holdFrames: number) =>
    snap([
      {
        name: "Down",
        type: "FRAME",
        width: 952,
        height: 432,
        tracks: [
          track(
            "SCALE_XY",
            K(0, "1,1"),
            K(F(36), "1,1", L),
            K(F(38), "1.06,1.06", "cubic:0.33,0,0.67,1"),
            ...(holdFrames ? [K(F(38 + holdFrames), "1.06,1.06", L)] : []),
            K(F(48 + holdFrames), "1,1", OUT),
          ),
        ],
      },
    ]);

  it("fires on a swell that leaves at full speed the frame after it arrives", () => {
    expect(of(run(punch(0)).issues, "one_frame_extreme")[0]).toMatchObject({ severity: "warning", frame: 38, frames: [37, 39], field: "SCALE_XY" });
  });

  it("is quiet when the peak is held two frames", () => {
    expect(of(run(punch(2)).issues, "one_frame_extreme")).toEqual([]);
  });
});

// ── arrival_not_held ────────────────────────────────────────────────────────

describe("arrival_not_held: a fast arrival that does not stay", () => {
  const dot = (offAt: number) =>
    snap([
      { name: "Scene", type: "FRAME", width: 1080, height: 1920, tracks: [switchAt(offAt, 1, 0)] },
      { name: "Wheel", parentId: "2:1", width: 960, height: 960, tracks: [track("SCALE_XY", K(0, "1,1"), K(F(10), "1,1", L), K(F(20), "0.1,0.1", IN))] },
    ]);

  it("fires when the arrived state is on screen one frame", () => {
    const [a] = of(run(dot(21)).issues, "arrival_not_held");
    expect(a).toMatchObject({ severity: "warning", name: "Wheel", frame: 20 });
    expect(a!.detail).toMatch(/49 % of its travel in the last frame.*1 frame\./);
    expect(a!.fix).toMatch(/Land 3 frames early/);
  });

  it("is quiet when it holds minHoldFrames (3) frames", () => {
    expect(of(run(dot(23)).issues, "arrival_not_held")).toEqual([]);
    expect(of(run(dot(22)).issues, "arrival_not_held")).toHaveLength(1);
  });
});

// ── dead_span / cold_open ───────────────────────────────────────────────────

describe("dead_span: nothing moves for half a second or more", () => {
  const still = (frames: number, extra: N[] = []) =>
    snap(
      [{ name: "Mover", tracks: [track("TRANSLATION_X", K(0, 0), K(F(10), 300, L), K(F(10 + frames), 300, L), K(F(20 + frames), 600, L))] }, ...extra],
      F(20 + frames),
    );

  it("fires on a second of stillness and names the fastest layer in it", () => {
    const [d] = of(run(still(30)).issues, "dead_span");
    expect(d).toMatchObject({ severity: "warning", nodeId: ROOT, frames: [11, 40] });
  });

  it("counts from deadSpanS: 15 frames fire, 14 do not", () => {
    expect(of(run(still(15)).issues, "dead_span")).toHaveLength(1);
    expect(of(run(still(14)).issues, "dead_span")).toEqual([]);
  });

  it("an intended hold passed in `holds` is exempt, and a drift of 2 px per frame keeps it alive", () => {
    expect(of(run(still(30), { holds: [{ from: 0.3, to: 1.4 }] }).issues, "dead_span")).toEqual([]);
    // The same stretch in frames, as figma_review_video takes it; half of it leaves a dead span.
    expect(of(run(still(30), auditOptions({ fps: 30, holds: [{ fromFrame: 9, toFrame: 42 }] })).issues, "dead_span")).toEqual([]);
    expect(of(run(still(30), auditOptions({ fps: 30, holds: [{ fromFrame: 9, toFrame: 20 }] })).issues, "dead_span")).toHaveLength(1);
    const drift = still(30, [{ name: "Drift", tracks: [track("TRANSLATION_Y", K(0, 0), K(2, 120, L))] }]);
    expect(of(run(drift).issues, "dead_span")).toEqual([]);
  });
});

describe("cold_open: the first frame is blank or still", () => {
  it("fires when frame 0 shows only the background, and when nothing moves in the first 3 frames", () => {
    const blank = run(snap([{ name: "Late", tracks: [switchAt(10, 0, 1), track("TRANSLATION_X", K(0, 0), K(F(30), 100, L))] }]));
    expect(of(blank.issues, "cold_open")[0]!.detail).toMatch(/only the background/);
    const still = run(snap([{ name: "Slow start", tracks: [track("TRANSLATION_X", K(0, 0), K(F(10), 0, L), K(F(30), 100, L))] }]));
    expect(of(still.issues, "cold_open")[0]!.detail).toMatch(/first 3 frames/);
  });

  it("is quiet when the piece opens moving, and not judged when the window starts later", () => {
    expect(of(run(snap([{ name: "Open", tracks: [track("TRANSLATION_X", K(0, 0), K(F(30), 300, L))] }])).issues, "cold_open")).toEqual([]);
    expect(of(run(snap([{ name: "Late", tracks: [switchAt(10, 0, 1)] }]), { from: 1 }).issues, "cold_open")).toEqual([]);
  });
});

// ── template_move / no_stagger / stagger_off_grid ───────────────────────────

describe("template_move: one entry on layers across the piece", () => {
  const rise = (at: number) => [track("TRANSLATION_Y", K(0, 40), K(F(at), 40, L), K(F(at + 10), 0, OUT))];

  it("fires when layers under 3 parents enter with the same move; a mask around each layer does not count as a parent", () => {
    const s = snap([
      { name: "Scene 1", type: "FRAME" },
      { name: "Scene 2", type: "FRAME" },
      { name: "Scene 3", type: "FRAME" },
      { name: "Mask", type: "FRAME", parentId: "2:3", clipsContent: true },
      { name: "A", type: "TEXT", parentId: "2:1", tracks: rise(0) },
      { name: "B", type: "TEXT", parentId: "2:2", tracks: rise(20) },
      { name: "C", type: "TEXT", parentId: "2:4", tracks: rise(40) },
    ]);
    const [t] = of(run(s).issues, "template_move");
    expect(t).toMatchObject({ severity: "info" });
    expect(t!.detail).toMatch(/3 layers under 3 different parents/);
  });

  it("siblings sharing one move are a stagger, not a template", () => {
    const s = snap([{ name: "Line", type: "FRAME" }, ...["a", "b", "c"].map((name, i) => ({ name, type: "TEXT", parentId: "2:1", tracks: rise(i * 2) }))]);
    expect(of(run(s).issues, "template_move")).toEqual([]);
  });
});

describe("no_stagger and stagger_off_grid [C-242]", () => {
  const line = (starts: number[]) =>
    snap([{ name: "Line", type: "FRAME" }, ...starts.map((at, i) => ({ name: `w${i}`, type: "TEXT", parentId: "2:1", tracks: [track("TRANSLATION_Y", K(0, 40), K(F(at), 40, L), K(F(at + 10), 0, OUT))] }))]);

  it("fires when three siblings start the same move on the same frame", () => {
    expect(of(run(line([10, 10, 10])).issues, "no_stagger")[0]).toMatchObject({ severity: "info", frame: 10, field: "TRANSLATION_Y" });
  });

  it("a 2-frame stagger is quiet; 1-frame and half-frame offsets are stagger_off_grid", () => {
    expect(run(line([10, 12, 14])).issues.filter((i) => i.rule === "no_stagger" || i.rule === "stagger_off_grid")).toEqual([]);
    expect(of(run(line([10, 11, 12])).issues, "stagger_off_grid")[0]!.detail).toMatch(/steps by 1, 1 frames/);
    expect(of(run(line([10, 12.5, 15])).issues, "stagger_off_grid")).toHaveLength(1);
  });
});

// ── unrendered_extreme / off_grid ───────────────────────────────────────────

describe("unrendered_extreme: an extreme no frame shows", () => {
  const punch = (peakT: number, extra: SnapshotTrack[] = []) =>
    snap([{ name: "Ten", width: 952, height: 480, tracks: [track("SCALE_XY", K(0, "1,1"), K(F(30), "1,1", L), K(peakT, "1.2,1.2", OUT), K(F(50), "1,1", OUT)), ...extra] }]);

  it("fires on an extreme half a frame off the grid", () => {
    expect(of(run(punch(F(37.5))).issues, "unrendered_extreme")[0]).toMatchObject({ severity: "warning", field: "SCALE_XY" });
    expect(of(run(punch(F(38))).issues, "unrendered_extreme")).toEqual([]);
  });

  it("fires on an extreme that lands on a frame where the layer is hidden", () => {
    const hidden = run(punch(F(38), [track("OPACITY", K(0, 1), ...cutPairKeys(36, 30, "1", "0"), ...cutPairKeys(40, 30, "0", "1"))]));
    expect(of(hidden.issues, "unrendered_extreme")[0]!.detail).toMatch(/hidden/);
  });

  it("other keys between frames are one off_grid info per layer; cut pairs are exempt [C-240]", () => {
    const s = snap([{ name: "Drift", tracks: [track("TRANSLATION_X", K(0, 0), K(0.51, 50, L), K(1.05, 100, L)), switchAt(20, 1, 0)] }]);
    const r = run(s);
    expect(of(r.issues, "off_grid")).toHaveLength(1);
    expect(of(r.issues, "off_grid")[0]!.detail).toMatch(/^2 keys between frames/);
    expect(r.census.offGrid).toBe(2);
    expect(r.census.cutPairs).toBe(1);
  });
});

// ── easing_census / hold_easing ─────────────────────────────────────────────

describe("easing_census", () => {
  it("counts moves per easing and flags named presets as approximate [C-190]", () => {
    const r = run(snap([{ name: "Card", tracks: [track("TRANSLATION_X", K(0, 0), K(F(10), 100, "EASE_OUT"), K(F(20), 0, OUT))] }]));
    expect(r.census.easings).toEqual({ EASE_OUT: 1, [OUT]: 1 });
    expect(r.census.approximated).toEqual(["EASE_OUT"]);
    expect(of(r.issues, "easing_census")[0]!.detail).toMatch(/approximate \[C-190\]/);
    expect(r.limits.join(" ")).toMatch(/EASE_OUT \[C-190\]/);
  });

  it("flags one curve on 70 % or more of the eased moves, a fast LINEAR move seen to start or stop, and stock overshoot on 2 layers", () => {
    const same = run(snap(["a", "b", "c", "d", "e"].map((name, i) => ({ name, tracks: [track("TRANSLATION_X", K(0, 0), K(F(10 + i), 100, OUT))] }))));
    expect(of(same.issues, "easing_census").some((i) => /shapes 5 of 5 eased moves/.test(i.detail))).toBe(true);
    const linear = run(snap([{ name: "Slide", tracks: [track("TRANSLATION_X", K(0, 0), K(F(10), 0, L), K(F(20), 200, L))] }]));
    expect(of(linear.issues, "easing_census", "Slide")[0]!.detail).toMatch(/LINEAR TRANSLATION_X move of 200 px/);
    const drift = run(snap([{ name: "Drift", tracks: [track("TRANSLATION_X", K(0, 0), K(F(30), 30, L))] }]));
    expect(of(drift.issues, "easing_census")).toEqual([]);
    const back = run(snap(["a", "b"].map((name) => ({ name, tracks: [track("SCALE_XY", K(0, "0,0"), K(F(10), "1,1", "EASE_OUT_BACK"))] }))));
    expect(of(back.issues, "easing_census").some((i) => /2 layers overshoot/.test(i.detail))).toBe(true);
  });
});

describe("hold_easing", () => {
  it("reports a HOLD with the cut pair that replaces it [C-189] [C-240]", () => {
    const r = run(snap([{ name: "Swap", tracks: [track("OPACITY", K(0, 0), K(F(30), 1, "HOLD"))] }]));
    const [h] = of(r.issues, "hold_easing");
    expect(h).toMatchObject({ severity: "info", frame: 30, field: "OPACITY" });
    expect(h!.detail).toMatch(/keeps 0 until the key and steps on f30 \[C-189\], a step measured on one probe only/);
    expect(h!.fix).toContain("@0.975 0 LINEAR · @0.995 1 LINEAR");
    expect(r.limits.join(" ")).toMatch(/HOLD .*measured on one probe .*\[C-189\]/);
    expect(r.limits.join(" ")).not.toMatch(/disagree|contradict/);
  });
});

// ── beat_offset ─────────────────────────────────────────────────────────────

describe("beat_offset (with bpm)", () => {
  const punchFrom = (start: number) =>
    snap(
      [
        {
          name: "Down",
          type: "FRAME",
          width: 952,
          height: 432,
          tracks: [track("SCALE_XY", K(0, "1,1"), K(F(start), "1,1", L), K(F(start + 2), "1.06,1.06", "cubic:0.33,0,0.67,1"), K(F(start + 12), "1,1", OUT))],
        },
      ],
      3,
    );

  it("warns when a punch starts on the beat, so the beat frame shows nothing and the peak lands late", () => {
    // 100 BPM at 30 fps: a beat every 18 frames; 1.2 s is frame 36.
    const r = run(punchFrom(36), { bpm: 100 });
    expect(of(r.issues, "beat_offset").find((i) => i.severity === "warning")).toMatchObject({ frame: 36, frames: [36, 38] });
    expect(r.beats).toMatchObject({ bpm: 100, framesPerBeat: 18, beatsPerBar: 4 });
    expect(r.beats!.hits).toContainEqual({ frame: 38, nearestBeat: 36, offsetFrames: 2, nodeId: "2:1", kind: "punch peak" });
  });

  it("is quiet when the peak lands on the beat", () => {
    const r = run(punchFrom(34), { bpm: 100 });
    expect(of(r.issues, "beat_offset")).toEqual([]);
    expect(r.beats!.hits).toContainEqual({ frame: 36, nearestBeat: 36, offsetFrames: 0, nodeId: "2:1", kind: "punch peak" });
  });

  it("is off without bpm, and notes a tempo whose beats fall between frames [C-244]", () => {
    expect(run(punchFrom(36)).beats).toBeUndefined();
    expect(run(punchFrom(36), { bpm: 110 }).beats!.note).toMatch(/\[C-244\]/);
    expect(run(punchFrom(36), { bpm: 120 }).beats!.note).toBeUndefined();
  });

  it("lists the scenes the frame's children switch, in beats", () => {
    const s = snap(
      [
        { name: "S1", type: "FRAME", tracks: [switchAt(36, 1, 0)] },
        { name: "S2", type: "FRAME", tracks: [track("OPACITY", K(0, 0), ...cutPairKeys(36, 30, "0", "1"))] },
      ],
      2.4,
    );
    expect(run(s, { bpm: 100 }).beats!.scenes).toEqual([
      { nodeId: "2:1", name: "S1", from: 0, to: 35, beats: 2 },
      { nodeId: "2:2", name: "S2", from: 36, to: 72, beats: 2.06 },
    ]);
  });
});

// ── read_time / dimmed_text ─────────────────────────────────────────────────

describe("read_time: fully readable for max(5/6 s, 0.3 s per word) [C-241]", () => {
  const text = (characters: string, onFrames: number, opacity = 1, extra: SnapshotTrack[] = []) =>
    snap([{ name: "Copy", type: "TEXT", characters, width: 600, height: 80, tracks: [track("OPACITY", K(0, 0), ...cutPairKeys(10, 30, "0", String(opacity)), ...cutPairKeys(10 + onFrames, 30, String(opacity), "0")), ...extra] }]);

  it("fires when three words are readable for half a second", () => {
    const [r] = of(run(text("three little words", 15)).issues, "read_time");
    expect(r).toMatchObject({ severity: "warning", frame: 10 });
    expect(r!.detail).toMatch(/\(3 words\) is fully readable for 0\.5 s in all; it needs 0\.9 s/);
  });

  it("is quiet at the minimum: 25 frames for one word", () => {
    expect(of(run(text("Hello", 25)).issues, "read_time")).toEqual([]);
    expect(of(run(text("Hello", 24)).issues, "read_time")).toHaveLength(1);
  });

  it("a moving text is not readable, and text dimmed to 0.5 or less is dimmed_text", () => {
    const moving = text("Hello", 40, 1, [track("TRANSLATION_Y", K(0, 0), K(2, 300, L))]);
    expect(of(run(moving).issues, "read_time")).toHaveLength(1);
    const dim = run(text("Hello", 30, 0.35));
    expect(of(dim.issues, "read_time")).toHaveLength(1);
    expect(of(dim.issues, "dimmed_text")[0]).toMatchObject({ severity: "info" });
  });

  it("letters set one per layer read as one word on their line", () => {
    const s = snap([
      { name: "Down", type: "FRAME", width: 952, height: 432 },
      ...["d", "o", "w", "n"].map((c) => ({ name: `Down/${c}`, type: "TEXT", characters: c, parentId: "2:1", tracks: [switchAt(10, 0, 1)] })),
    ]);
    const r = run(s, { rules: ["read_time"] });
    expect(r.issues).toEqual([]);
    const short = snap([
      { name: "Down", type: "FRAME", width: 952, height: 432 },
      ...["d", "o", "w", "n"].map((c) => ({ name: `Down/${c}`, type: "TEXT", characters: c, parentId: "2:1", tracks: [track("OPACITY", K(0, 0), ...cutPairKeys(10, 30, "0", "1"), ...cutPairKeys(20, 30, "1", "0"))] })),
    ]);
    expect(of(run(short).issues, "read_time")).toEqual([expect.objectContaining({ name: "Down", nodeId: "2:1" })]);
    expect(of(run(short).issues, "read_time")[0]!.detail).toMatch(/"down" \(1 word\)/);
  });
});

// ── rest_state_hidden / timeline_end / roundcap_zero_trim ───────────────────

describe("rest_state_hidden: a base of opacity or scale 0 [C-204]", () => {
  it("fires on a resting opacity 0 or a scale track whose base is 0", () => {
    const r = run(
      snap([
        { name: "Ghost", opacity: 0, tracks: [switchAt(10, 0, 1)] },
        { name: "Seed", tracks: [{ field: "SCALE_XY", base: "0,0", keyframes: [K(0, "0,0"), K(F(10), "1,1", OUT)] }] },
        { name: "Fine", tracks: [switchAt(10, 0, 1)] },
      ]),
    );
    expect(of(r.issues, "rest_state_hidden").map((i) => i.name)).toEqual(["Ghost", "Seed"]);
    expect(of(r.issues, "rest_state_hidden")[0]!.detail).toMatch(/figma_export_node renders nothing/);
  });
});

describe("timeline_end: keys after the end never play [C-194]", () => {
  it("reports them, and every result says how many frames a render holds", () => {
    const r = run(snap([{ name: "Late", tracks: [track("TRANSLATION_X", K(0, 0), K(3, 100, L))] }], 2));
    expect(of(r.issues, "timeline_end")[0]!.detail).toMatch(/1 key after the timeline's end \(2 s\)/);
    expect(r.expectedFrames).toBe(61);
    expect(run(snap([{ name: "In", tracks: [track("TRANSLATION_X", K(0, 0), K(2, 100, L))] }], 2)).issues.filter((i) => i.rule === "timeline_end")).toEqual([]);
  });
});

describe("roundcap_zero_trim: a round cap paints a dot at zero length", () => {
  const ring = (cap: string, guarded: boolean) =>
    snap([
      {
        name: "Ring",
        type: "VECTOR",
        width: 900,
        height: 900,
        strokeCap: cap,
        strokeWeight: 3,
        // The guard turns on the frame after the draw starts, as the run's guards did.
        tracks: [track("PATH_TRIM_END", K(0, 0), K(F(10), 0, L), K(F(25), 1, FIX_EASINGS.draw)), ...(guarded ? [switchAt(11, 0, 1)] : [])],
      },
    ]);

  it("fires while a round-capped stroke sits at zero length and visible", () => {
    expect(of(run(ring("ROUND", false)).issues, "roundcap_zero_trim")[0]).toMatchObject({ severity: "warning", frame: 0, frames: [0, 10] });
  });

  it("is quiet when an opacity guard hides it, or the cap is flat", () => {
    expect(of(run(ring("ROUND", true)).issues, "roundcap_zero_trim")).toEqual([]);
    expect(of(run(ring("NONE", false)).issues, "roundcap_zero_trim")).toEqual([]);
  });
});

// ── brand_late / cta_short ──────────────────────────────────────────────────

describe("brand_late and cta_short [C-235] [C-241]", () => {
  const piece = (brandOn: number, ctaFrames: number) =>
    snap(
      [
        { id: "9:1", name: "Logo", tracks: [switchAt(brandOn, 0, 1)] },
        { id: "9:2", name: "CTA", type: "TEXT", characters: "Shop now", tracks: [track("OPACITY", K(0, 0), ...cutPairKeys(150, 30, "0", "1"), ...cutPairKeys(150 + ctaFrames, 30, "1", "0"))] },
      ],
      10,
    );

  it("fires when the brand is first fully visible after 3 s, and when the CTA reads for under 2.5 s", () => {
    const r = run(piece(120, 30), { brandId: "9:1", ctaId: "9:2" });
    expect(of(r.issues, "brand_late")[0]!.detail).toMatch(/first fully visible at 4 s \(f120\); the brief wants it by 3 s/);
    expect(of(r.issues, "cta_short")[0]!.detail).toMatch(/readable for 1 s .* needs 2\.5 s/);
  });

  it("is quiet by the defaults, honours brandBy and ctaMinS, and is off without the ids", () => {
    expect(run(piece(60, 90), { brandId: "9:1", ctaId: "9:2" }).issues.filter((i) => /brand_late|cta_short/.test(i.rule))).toEqual([]);
    expect(of(run(piece(60, 90), { brandId: "9:1", brandBy: 1 }).issues, "brand_late")).toHaveLength(1);
    expect(of(run(piece(60, 90), { ctaId: "9:2", ctaMinS: 4 }).issues, "cta_short")).toHaveLength(1);
    expect(run(piece(120, 30)).issues.filter((i) => /brand_late|cta_short/.test(i.rule))).toEqual([]);
  });

  it("refuses an id outside the frame", () => {
    expect(() => run(piece(60, 90), { brandId: "7:7" })).toThrow(/`brandId` 7:7 is not inside "Frame"/);
  });
});

// ── first_key_late / clamped_morph ──────────────────────────────────────────

describe("first_key_late: a track that starts after 0 away from the base [C-191]", () => {
  it("fires when the first key differs from the resting value, and is quiet when keyed at 0 or equal to it", () => {
    const r = run(
      snap([
        { name: "Late", tracks: [track("OPACITY", K(1, 0), K(1.5, 1, L))] },
        { name: "At zero", tracks: [track("OPACITY", K(0, 0), K(1.5, 1, L))] },
        { name: "Same", tracks: [track("OPACITY", K(1, 1), K(1.5, 0, L))] },
        { name: "Base", tracks: [{ field: "TRANSLATION_X", base: "0", keyframes: [K(0.5, 40), K(1, 0, OUT)] }] },
      ]),
    );
    expect(of(r.issues, "first_key_late").map((i) => i.name)).toEqual(["Base", "Late"]);
    expect(of(r.issues, "first_key_late", "Late")[0]!.fix).toMatch(/Add a key at t = 0/);
    expect(of(r.issues, "first_key_late", "Late")[0]!.detail).toMatch(/Figma holds the first key's value before it, so 0 shows from frame 0, not the resting value \[C-191\]/);
  });
});

describe("clamped_morph: WIDTH and HEIGHT on different curves at full radius [C-196]", () => {
  // The radius is keyed as half the height throughout, as the run's band was.
  const burst = (widthFrames: number) =>
    snap([
      {
        name: "Band",
        type: "FRAME",
        width: 1080,
        height: 1040,
        tracks: [
          track("WIDTH", K(0, 96), K(F(10), 96, L), K(F(10 + widthFrames), 1080, OUT)),
          track("HEIGHT", K(0, 96), K(F(10), 96, L), K(F(25), 1040, OUT)),
          track("CORNER_RADIUS", K(0, 48), K(F(10), 48, L), K(F(25), 520, OUT)),
        ],
      },
    ]);

  it("fires when the width outruns the height while the radius is half the short side", () => {
    expect(of(run(burst(13)).issues, "clamped_morph")[0]).toMatchObject({ severity: "info", name: "Band" });
  });

  it("is quiet when both sides share their keys and curve", () => {
    expect(of(run(burst(15)).issues, "clamped_morph")).toEqual([]);
  });
});

// ── the result ──────────────────────────────────────────────────────────────

describe("the result follows figma_check_layout's contract", () => {
  const busy = () =>
    snap([
      { name: "Word", type: "TEXT", width: 300, height: 100, tracks: [track("TRANSLATION_Y", K(0, 0), K(F(10), 0, L), K(F(16), 200, IN))] },
      { name: "Still", tracks: [switchAt(30, 1, 0)] },
    ]);

  it("ok is false with a warning; counts cover every finding; minSeverity hides, limit cuts and says how many more", () => {
    const r = run(busy());
    expect(r.ok).toBe(false);
    const warnings = run(busy(), { minSeverity: "warning" });
    expect(warnings.counts).toEqual(r.counts);
    expect(warnings.issues.every((i) => i.severity !== "info")).toBe(true);
    const one = run(busy(), { limit: 1 });
    expect(one.issues).toHaveLength(1);
    expect(one.more).toBe(r.issues.length - 1);
    expect(r.issues[0]!.severity).toBe("warning");
  });

  it("`rules` keeps only those rules, a rule bringing its narrower names along", () => {
    expect(rules(busy(), { rules: ["concentrated_step"] })).toEqual(["concentrated_step:Word:f16"]);
    expect(rules(busy(), { rules: ["vanish_mid_move"] })).toEqual(["cut_at_rest:Still:f30"]);
  });

  it("from and to judge a window only, and the result says so", () => {
    const r = run(busy(), { from: 0.8, rules: ["concentrated_step", "vanish_mid_move"] });
    expect(r.window).toEqual({ from: 24, to: 60 });
    expect(r.issues.map((i) => i.rule)).toEqual(["cut_at_rest"]);
  });

  it("judges at the asked frame rate", () => {
    const r = run(busy(), { fps: 24 });
    expect(r.fps).toBe(24);
    expect(r.expectedFrames).toBe(49);
  });

  it("says what was checked, and what it leaned on", () => {
    const r = run(busy());
    expect(r.root).toEqual({ id: ROOT, name: "Frame", durationS: 2 });
    expect(r.checked).toEqual({ layers: 2, tracks: 2, keys: 6 });
    expect(r.limits.join(" ")).toMatch(/\[C-191\].*\[C-192\]/);
    expect(r.limits.join(" ")).toMatch(/gives the base values, not the state at the playhead \[C-192\]/);
    expect(r.limits.join(" ")).not.toMatch(/undocumented|unmeasured/);
  });

  it("a frame with no keys is ok and says how to animate it; a truncated read says so", () => {
    const quiet = run(snap([{ name: "Card" }]));
    expect(quiet).toMatchObject({ ok: true, issues: [], checked: { layers: 1, tracks: 0, keys: 0 } });
    expect(quiet.note).toMatch(/figma_set_keyframes/);
    const cut = run({ ...busy(), truncated: true, maxNodes: 2 });
    expect(cut.truncated).toBe(true);
    expect(cut.note).toMatch(/Only the first 2 layers/);
  });

  it("includeActivity adds the fastest on-screen move per frame", () => {
    const r = run(busy(), { includeActivity: true });
    expect(r.activity).toHaveLength(r.expectedFrames);
    expect(Math.max(...r.activity!)).toBeGreaterThan(100);
  });
});

// ── figma_check_motion on the server ────────────────────────────────────────

describe("figma_check_motion on the server (src/server/tools/check-motion.ts)", () => {
  type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;
  const extra = { _meta: {}, sendNotification: async () => {}, signal: new AbortController().signal };
  const piece = snap([
    { id: "9:1", name: "Logo", tracks: [switchAt(100, 0, 1)] },
    { name: "Word", type: "TEXT", width: 300, height: 100, tracks: [track("TRANSLATION_Y", K(0, 0), K(F(10), 0, L), K(F(16), 200, IN))] },
  ], 4);

  function setup(answer: unknown = piece) {
    const tools = new Map<string, { config: { description: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }; cb: Handler }>();
    const server = { registerTool: (name: string, config: never, cb: Handler) => void tools.set(name, { config, cb }) } as unknown as McpServer;
    const forwarded: Array<{ op: string; params: Record<string, unknown> }> = [];
    const bridge = {
      request: async (op: string, params: Record<string, unknown>) => {
        forwarded.push({ op, params });
        return answer;
      },
      statusAsync: async () => ({ sessions: [] }),
    } as unknown as Bridge;
    registerCheckMotion(server, bridge, () => true);
    return { tools, forwarded, call: (args: Record<string, unknown>) => tools.get("figma_check_motion")!.cb(args, extra) };
  }

  it("registers one read tool, only when the toolset wants it", () => {
    const { tools } = setup();
    expect([...tools.keys()]).toEqual(["figma_check_motion"]);
    expect(tools.get("figma_check_motion")!.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const names: string[] = [];
    registerCheckMotion({ registerTool: (n: string) => void names.push(n) } as unknown as McpServer, {} as Bridge, () => false);
    expect(names).toEqual([]);
  });

  it("its description fits the cap with the Editors sentence the catalogue will add, and names its neighbours", () => {
    const d = setup().tools.get("figma_check_motion")!.config.description;
    // check_motion's editor row is unmeasured in Design and "no" elsewhere (plan §3.9).
    expect((d + " Editors: Design only, unverified.").length).toBeLessThanOrEqual(1024);
    expect(d).toMatch(/figma_check_layout/);
    expect(d).toMatch(/figma_export_video/);
    expect(d).toMatch(/figma_review_video/);
    expect(d).toMatch(/UNSUPPORTED/);
    expect(d.endsWith(".")).toBe(true);
  });

  it("its schema is portable: no unions or references, nested objects strict", async () => {
    const server = new McpServer({ name: "check-motion", version: "0" });
    registerCheckMotion(server, setup().forwarded as unknown as Bridge, () => true);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "check", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const forbidden = ["$ref", "$defs", "anyOf", "oneOf", "allOf", "not", "const", "format", "patternProperties", "propertyNames", "prefixItems"];
    const walk = (s: Record<string, unknown>, at: string): string[] => [
      ...Object.keys(s).filter((k) => forbidden.includes(k)).map((k) => `${at}: ${k}`),
      ...Object.entries((s.properties ?? {}) as Record<string, Record<string, unknown>>).flatMap(([k, v]) => walk(v, `${at}.${k}`)),
      ...(s.items ? walk(s.items as Record<string, unknown>, `${at}[]`) : []),
    ];
    expect(walk(tools[0]!.inputSchema as Record<string, unknown>, "figma_check_motion")).toEqual([]);
    const props = (tools[0]!.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.thresholds!.additionalProperties).toBe(false);
    expect((props.holds!.items as Record<string, unknown>).additionalProperties).toBe(false);
    expect((props.rules!.items as { enum: string[] }).enum).toEqual([...RULE_IDS]);
    await client.close();
    // A misspelt threshold is refused, not stripped and run with the default.
    expect(z.object(CHECK_MOTION_SHAPE).strict().safeParse({ thresholds: { stepshare: 0.5 } }).success).toBe(false);
  });

  it("forwards only what the plugin reads, ids normalised, and answers with the judged snapshot", async () => {
    const { call, forwarded } = setup();
    const r = await call({ nodeId: "12-34", maxNodes: 300, fps: 30, rules: ["concentrated_step"], session: "Ad file" });
    expect(forwarded).toEqual([{ op: "check_motion", params: { nodeId: "12:34", maxNodes: 300 } }]);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ ok: false, counts: { warning: 1 }, issues: [{ rule: "concentrated_step", name: "Word", frame: 16 }] });
  });

  it("refuses a window or a hold that ends before it starts, before Figma is asked", async () => {
    const { call, forwarded } = setup();
    const w = await call({ from: 2, to: 1 });
    expect(w.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    expect((w.content[0] as { text: string }).text).toMatch(/`to` must be after `from`/);
    const h = await call({ holds: [{ from: 1, to: 2 }, { from: 3, to: 3 }] });
    expect((h.content[0] as { text: string }).text).toMatch(/`holds\[1\]\.to`/);
    for (const [holds, pattern] of [
      [[{ fromFrame: 9, toFrame: 3 }], /`holds\[0\]` runs backwards: fromFrame 9 > toFrame 3/],
      [[{ from: 1, toFrame: 3 }], /`holds\[0\]` mixes seconds/],
      [[{ fromFrame: 3 }], /`holds\[0\]` needs both fromFrame and toFrame/],
      [[{ from: 1 }], /`holds\[0\]` needs from and to/],
    ] as const) {
      const r = await call({ holds });
      expect((r.content[0] as { text: string }).text, JSON.stringify(holds)).toMatch(pattern);
    }
    expect(forwarded).toEqual([]);
  });

  it("takes a hold in frames, as figma_review_video does, as the same stretch in seconds at `fps`", () => {
    expect(auditOptions({ fps: 30, holds: [{ fromFrame: 120, toFrame: 179 }] }).holds).toEqual([{ from: 4, to: 179 / 30 }]);
    expect(auditOptions({ holds: [{ fromFrame: 30, toFrame: 60 }] }).holds).toEqual([{ from: 1, to: 2 }]);
    expect(auditOptions({ fps: 24, holds: [{ from: 1, to: 2 }] }).holds).toEqual([{ from: 1, to: 2 }]);
  });

  it("reads brandId and ctaId as node ids, and refuses one outside the audited frame", async () => {
    const { call } = setup();
    const ok = await call({ brandId: "9-1" });
    expect((ok.structuredContent as { issues: MotionIssue[] }).issues.some((i) => i.rule === "brand_late" && i.nodeId === "9:1")).toBe(true);
    const outside = await call({ brandId: "7:7" });
    expect(outside.structuredContent).toMatchObject({ code: "INVALID_PARAM", message: expect.stringMatching(/`brandId` 7:7 is not inside/) });
  });

  it("a plugin that answers without a snapshot predates the tool: INTERNAL, with the way out", async () => {
    const r = await setup({ nodes: "?" }).call({});
    expect(r.structuredContent).toMatchObject({ code: "INTERNAL", hint: expect.stringMatching(/figma_status/) });
  });
});
