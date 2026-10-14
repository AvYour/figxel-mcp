// The calibration of figma_check_motion against the 2026-10-09 run [C-246]:
// the same ad at three points of its review, r0 (what the round-1 critics
// saw), r1 (after their fixes, reviewed in round 2) and r2 (after the round-2
// fixes, reviewed in round 3). The critics measured every finding by hand
// from rendered frames (journal lines 38–40, 46–48, 54–56) [C-206]; the audit
// sees the same defects from the keyframes alone, before any render, and goes
// quiet where the critics' fix removed them.
//
// This is the regression net for the thresholds: a change that loses one of
// these findings, or keeps one after its fix, fails here.

import { describe, expect, it } from "vitest";
import { auditMotion, type AuditResult } from "../src/server/motion-audit.js";
import { SNAPSHOTS, loadSnapshot, type SnapshotName } from "./fixtures/motion-2026-10-09/snapshot.js";

const results = Object.fromEntries(SNAPSHOTS.map((s) => [s, auditMotion(loadSnapshot(s), { limit: 500, bpm: 100 })])) as Record<SnapshotName, AuditResult>;

/** "name fN" for every finding of a rule, at a severity when given. */
const found = (s: SnapshotName, rule: string, severity?: string) =>
  results[s].issues.filter((i) => i.rule === rule && (severity === undefined || i.severity === severity)).map((i) => `${i.name} f${i.frame}`);
const names = (s: SnapshotName, rule: string) => new Set(results[s].issues.filter((i) => i.rule === rule).map((i) => i.name));

describe("the run's ad, frame by frame [C-246]", () => {
  it("renders 433 frames for 14.4 s at 30 fps, and reads every layer the bible lists [C-194]", () => {
    for (const s of SNAPSHOTS) {
      expect(results[s].expectedFrames).toBe(433);
      expect(results[s].root.durationS).toBe(14.4);
      expect(results[s].checked.layers).toBeGreaterThan(170);
    }
  });

  it("vanish_mid_move: the closes that popped off (round 1) fire on r0 and are gone once eased (r1, r2)", () => {
    // Ring trim 63 %, two bands 75 %, loop 63 % on their last visible frames (journal line 40).
    expect(found("r0", "vanish_mid_move")).toEqual(expect.arrayContaining(["S1/Ring path f101", "S1/Cream band f105", "S1/Clay band f106", "S5/Loop path f335"]));
    for (const s of ["r1", "r2"] as const) {
      for (const layer of ["S1/Ring path", "S1/Cream band", "S1/Clay band", "S5/Loop path"]) expect(names(s, "vanish_mid_move").has(layer)).toBe(false);
    }
  });

  it("pop_in: the arrow that turned on three-quarters drawn (round 1) fires on r0 only; ticks and the pointer are too small to count", () => {
    expect(found("r0", "pop_in")).toEqual(["S5/Arrow shaft f350", "S5/Arrow head f353"]);
    expect(found("r1", "pop_in")).toEqual([]);
    expect(found("r2", "pop_in")).toEqual([]);
  });

  it("arrival_not_held: the match-cut dot on screen one frame (the round-1 blocker) is held after the fix; the dive's 2.6× key is never held", () => {
    expect(found("r0", "arrival_not_held")).toEqual(expect.arrayContaining(["S1/Wheel f108"]));
    expect(names("r1", "arrival_not_held").has("S1/Wheel")).toBe(false);
    // The round-3 motion critic found S2/Content's last key never shown; no snapshot follows that round.
    for (const s of SNAPSHOTS) expect(found(s, "arrival_not_held")).toContain("S2/Content f180");
  });

  it("one_frame_extreme: both type punches are cusps in every snapshot (named in rounds 2 and 3, fixed after r2)", () => {
    expect(found("r0", "one_frame_extreme")).toEqual(["S1/Down f38", "S5/Ten f308"]);
    expect(found("r1", "one_frame_extreme")).toEqual(["S1/Down f38", "S5/Ten f308"]);
    expect(found("r2", "one_frame_extreme")).toEqual(["S1/Down f36", "S5/Ten f306"]);
  });

  it("concentrated_step: the words leaving 108 of 158 px in one frame (round 2) fire on r0 and r1 and go quiet with the round-2 exit", () => {
    expect(found("r0", "concentrated_step")).toEqual(expect.arrayContaining(["S1/By f102", "S1/hand. f103", "S1/Wheel f108"]));
    expect(found("r1", "concentrated_step")).toEqual(expect.arrayContaining(["S1/By f103", "S1/hand. f104"]));
    expect(names("r2", "concentrated_step").has("S1/By")).toBe(false);
    expect(names("r2", "concentrated_step").has("S1/hand.")).toBe(false);
    // The photo inside the iris moves 424 px on f104, the frame the iris itself is cut:
    // nothing of it is on screen, so it is not a finding. The iris close is caught
    // through the bands it closes with (vanish_mid_move above).
    for (const s of SNAPSHOTS) expect(names(s, "concentrated_step").has("S1/Hands")).toBe(false);
  });

  it("blur_off_speed: the blur that dropped the frame after the push-through (round 1) and the exit blur against the speed graph (round 3)", () => {
    expect(found("r0", "blur_off_speed")).toContain("S3/Content f181");
    expect(names("r1", "blur_off_speed").has("S3/Content")).toBe(false);
    expect(found("r2", "blur_off_speed")).toEqual(expect.arrayContaining(["S2/Ash f172", "S2/Vase/V f173", "S2/Vase/a f174", "S2/Vase/s f175", "S2/Vase/e f176"]));
    for (const s of ["r0", "r1"] as const) for (const l of ["S2/Ash", "S2/Vase/V", "S2/Vase/e"]) expect(names(s, "blur_off_speed").has(l)).toBe(false);
  });

  it("strobe: the logo flight with no blur (rounds 1 and 2) until its round-2 fix; the plate wipes and the bloom (round 3) despite their blur", () => {
    expect(found("r0", "strobe", "warning")).toContain("Brand bug f340");
    expect(found("r1", "strobe", "warning")).toContain("Brand bug f340");
    expect(names("r2", "strobe").has("Brand bug")).toBe(false);
    expect(found("r2", "strobe", "warning")).toEqual(expect.arrayContaining(["S2/Plate terracotta f117", "S2/Plate clay f119", "S3/Cream circle f281", "S3/Terracotta circle f283"]));
  });

  it("beat_offset: the punch that starts on the beat, so the beat frame shows no change (round 2), until it is moved earlier", () => {
    expect(found("r0", "beat_offset", "warning")).toContain("S1/Down f36");
    expect(found("r1", "beat_offset", "warning")).toContain("S1/Down f36");
    expect(names("r2", "beat_offset").has("S1/Down")).toBe(false);
  });

  it("dead_span: the end card that read as a freeze (round 2) in every snapshot; the intended breath is exempt when passed as a hold", () => {
    for (const s of SNAPSHOTS) expect(found(s, "dead_span").some((f) => /f37[2-3]$/.test(f))).toBe(true);
    const r2 = auditMotion(loadSnapshot("r2"), { limit: 500, holds: [{ from: 10.4, to: 10.9 }] });
    expect(r2.issues.filter((i) => i.rule === "dead_span").map((i) => i.frame)).toEqual([372]);
  });

  it("clamped_morph: the band burst that rendered as a stadium (round 3) is a regression of the round-1 fix, seen without a render", () => {
    expect(found("r0", "clamped_morph")).toEqual([]);
    expect(found("r2", "clamped_morph")).toEqual(["S2/Band window f112"]);
  });

  it("read_time and dimmed_text: the list read too fast and dimmed to 0.35 (round 2)", () => {
    expect(found("r1", "read_time")).toEqual(expect.arrayContaining(["S3/Name 1 f200", "S3/Price 1 f195"]));
    expect(found("r1", "dimmed_text")).toEqual(expect.arrayContaining(["S3/Name 1 f220", "S3/Price 1 f221"]));
  });

  it("template_move: the same −40 px rise on the specs, the third price and the URL across three scenes", () => {
    for (const s of SNAPSHOTS) {
      const t = results[s].issues.filter((i) => i.rule === "template_move").map((i) => i.detail);
      expect(t.some((d) => ["S2/Spec 1", "S2/Spec 2", "S3/Price 3", "S4/URL"].every((n) => d.includes(`"${n}"`)))).toBe(true);
    }
  });

  it("the run used whole-frame keys and cut pairs only: no key off the grid, no HOLD, every curve exact", () => {
    for (const s of SNAPSHOTS) {
      expect(results[s].census.offGrid).toBe(0);
      expect(results[s].census.cutPairs).toBeGreaterThan(40);
      expect(results[s].census.approximated).toEqual([]);
      expect(results[s].issues.filter((i) => i.rule === "hold_easing" || i.rule === "unrendered_extreme")).toEqual([]);
    }
  });
});
