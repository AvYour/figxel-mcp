// The offline twin of spikes/live-check-motion.mjs: the spike's probe frame,
// as the plugin op `check_motion` reads it, judged by the server's own audit.
// Every probe must fire its rule here before a live run can expect it to.
//
// Why it exists: the 2026-10-13 live run (hub, plugin and dist at one build)
// found template_move silent on its probe. The probe, not the rule, was wrong:
// its three "scenes" were frames from figma.createFrame(), which clip by
// default [C-067], each wrapping one layer, so the audit read them as three
// masks in one frame (motion-audit.ts groupOf) and found 2 parents where the
// rule needs 3. This snapshot of that frame reproduced the live audit exactly:
// 20 warnings and 23 infos over 35 layers, 38 tracks and 112 keys, every other
// rule on the frame the live run reported.

import { describe, expect, it } from "vitest";
import type { MotionSnapshot } from "../src/shared/motion-curves.js";
import { auditMotion, type MotionIssue } from "../src/server/motion-audit.js";

interface ProbeModule {
  AUDIT: { bpm: number; limit: number };
  BRAND: string;
  CTA: string;
  PARENTS: string[];
  PARENT_FRAME: { w: number; h: number; clipsContent: boolean };
  ruleProbes(): Array<{ probe: { name: string }; rule: string }>;
  hitFor(issues: MotionIssue[], rule: string, probeName: string, frameId: string): MotionIssue | undefined;
  probeSnapshot(): { snapshot: MotionSnapshot; frameId: string; idOf(name: string): string };
}

// A plain .mjs spike module: imported by path so the type checker does not ask for its declarations.
const MODULE = "../spikes/check-motion-probes.mjs";
const P = (await import(MODULE)) as ProbeModule;

function audit(snapshot: MotionSnapshot, idOf: (name: string) => string) {
  return auditMotion(snapshot, { ...P.AUDIT, brandId: idOf(P.BRAND), ctaId: idOf(P.CTA) });
}

const { snapshot, frameId, idOf } = P.probeSnapshot();
const result = audit(snapshot, idOf);

describe("spikes/live-check-motion.mjs: every probe fires its rule offline", () => {
  it("no rule is silent on its probe", () => {
    const silent = P.ruleProbes()
      .filter(({ probe, rule }) => !P.hitFor(result.issues, rule, probe.name, frameId))
      .map(({ rule }) => rule);
    expect(silent).toEqual([]);
  });

  it("template_move fires on the three template scenes, each its own parent", () => {
    const [hit] = result.issues.filter((i) => i.rule === "template_move");
    expect(hit).toMatchObject({ severity: "info", name: "template_move 1" });
    expect(hit!.detail).toMatch(/^6 layers under 4 different parents enter with the same move \(TRANSLATION_Y-:cubic:0\.16,1,0\.3,1, 10 frames\)/);
    expect(hit!.detail).toContain('"template_move 1", "template_move 2", "template_move 3"');
  });

  it("the probe's parents do not clip: clipping, each would read as the mask of its one layer", () => {
    expect(P.PARENT_FRAME.clipsContent).toBe(false);
    const parents = new Set(P.PARENTS.map(idOf));
    const clipped: MotionSnapshot = { ...snapshot, nodes: snapshot.nodes.map((n) => (parents.has(n.id) ? { ...n, clipsContent: true } : n)) };
    const before = audit(clipped, idOf);
    expect(before.issues.filter((i) => i.rule === "template_move")).toEqual([]);
    // The 6 layers then sit under the frame and the stagger line: 2 parents.
    const two = auditMotion(clipped, { ...P.AUDIT, rules: ["template_move"], thresholds: { templateParents: 2 } });
    expect(two.issues[0]!.detail).toMatch(/^6 layers under 2 different parents/);
  });

  it("matches the live read: the frames the 2026-10-13 live run reported for every other rule", () => {
    // spikes/results/live-check-motion.json, ranAt 2026-10-13T07:25:02Z, build 43fdb67e716f.
    const live: Record<string, number> = {
      vanish_mid_move: 28, pop_in: 31, concentrated_step: 46, strobe: 62, blur_off_speed: 80, one_frame_extreme: 39,
      arrival_not_held: 20, no_stagger: 30, unrendered_extreme: 31, easing_census: 0, hold_easing: 30, beat_offset: 72,
      read_time: 30, rest_state_hidden: 0, timeline_end: 120, roundcap_zero_trim: 0, brand_late: 105, cta_short: 60,
      first_key_late: 0, clamped_morph: 1,
    };
    const offline = Object.fromEntries(
      P.ruleProbes()
        .filter(({ rule }) => rule in live)
        .map(({ probe, rule }) => [rule, P.hitFor(result.issues, rule, probe.name, frameId)?.frame]),
    );
    expect(offline).toEqual(live);
    expect(result.checked).toEqual({ layers: 35, tracks: 38, keys: 112 });
    expect(result.counts).toEqual({ error: 0, warning: 20, info: 24 });
  });
});
