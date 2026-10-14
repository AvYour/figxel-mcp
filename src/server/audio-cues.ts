// Sound effects derived from an animated frame, for figma_generate_audio
// { nodeId } — pure. The frame's moves, cuts and text entrances come from the
// same per-frame model figma_check_motion judges (motion-audit.ts
// soundEvents); this file only decides which of them deserve a sound:
//
//   - a whoosh for each fast move, starting with the move and as long as it,
//     louder the faster it goes; a move that starts while another still
//     moves, within 0.3 s of it (a stagger), shares its whoosh;
//   - a hit on each cut: a scene switched on, or a large layer cut in; cuts
//     within 3 frames of each other are one hit;
//   - a tick on each text entrance that no hit already covers.
//
// Each cue carries a `note` saying why, and the list is returned in the shape
// figma_generate_audio's `cues` takes, so an agent can edit it and run again.

import type { CueSpec } from "./audio-synth.js";
import type { SoundEvents } from "./motion-audit.js";

/** A move this fast or faster, in frame diagonals per second, gets a whoosh... */
export const WHOOSH_SPEED = 0.5;
/** ...when it also travels at least this share of the frame's diagonal. */
export const WHOOSH_TRAVEL = 0.06;
/** A move that starts while a group still moves, within this long of the group's start, joins its whoosh. */
const GROUP_S = 0.3;
/** Cuts this close (frames) are one hit. */
const HIT_FRAMES = 3;
/** A hit this close (frames) covers a text entrance; a tick this close to the last one is skipped. */
const NEAR_FRAMES = 2;
export const MAX_DERIVED = 48;

type Derived = CueSpec & { note: string };
type Placed = Derived & { frame: number };

export interface DerivedCues {
  cues: Derived[];
  counts: { whoosh: number; hit: number; tick: number };
  /** Cues left out past the cap: ticks first, then the quietest whooshes. */
  dropped: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const panOf = (x: number) => r2(clamp((x * 2 - 1) * 0.7, -0.7, 0.7));
const quote = (s: string) => `"${s.length > 30 ? `${s.slice(0, 29)}…` : s}"`;

export function cuesFromMotion(ev: SoundEvents, max = MAX_DERIVED): DerivedCues {
  const { fps } = ev;
  const diag = Math.hypot(ev.width, ev.height) || 1;

  const hits: Placed[] = [];
  for (const c of ev.cuts) {
    const hit: Placed = { t: r3(c.frame / fps), type: "hit", intensity: c.scene ? 0.9 : 0.7, pan: 0, note: `${c.scene ? "scene cut" : "cut"}: ${quote(c.name)} on f${c.frame}`, frame: c.frame };
    const last = hits[hits.length - 1];
    if (last && c.frame - last.frame <= HIT_FRAMES) {
      // Cuts that land together are one hit, named by the scene when there is one.
      if (c.scene && last.intensity! < 0.9) hits[hits.length - 1] = { ...hit, t: last.t, frame: last.frame };
      continue;
    }
    hits.push(hit);
  }

  const fast = ev.moves.filter((mv) => (mv.peakPx * fps) / diag >= WHOOSH_SPEED && mv.travelPx >= WHOOSH_TRAVEL * diag);
  const groupFrames = Math.round(GROUP_S * fps);
  const whooshes: Placed[] = [];
  for (let i = 0; i < fast.length; ) {
    const first = fast[i]!;
    const group = [first];
    let end = first.f1;
    for (i++; i < fast.length && fast[i]!.f0 <= end && fast[i]!.f0 - first.f0 <= groupFrames; i++) {
      group.push(fast[i]!);
      end = Math.max(end, fast[i]!.f1);
    }
    const lead = group.reduce((a, b) => (b.peakPx > a.peakPx ? b : a));
    const speed = (lead.peakPx * fps) / diag;
    whooshes.push({
      t: r3(first.f0 / fps),
      type: "whoosh",
      durationS: r3(clamp((end - first.f0) / fps, 0.12, 3)),
      intensity: r2(clamp(0.3 + 0.7 * Math.min(1, speed / 3), 0.3, 1)),
      pan: panOf(group.reduce((s, g) => s + g.x, 0) / group.length),
      note: `${quote(lead.name)} moves ${Math.round(lead.travelPx)} px (${lead.field}) over f${lead.f0}–f${lead.f1}${group.length > 1 ? `, with ${group.length - 1} more in a stagger` : ""}`,
      frame: first.f0,
    });
  }

  const ticks: Placed[] = [];
  let lastTick = Number.NEGATIVE_INFINITY;
  for (const a of ev.appears) {
    if (hits.some((h) => Math.abs(h.frame - a.frame) <= NEAR_FRAMES)) continue;
    if (a.frame - lastTick <= NEAR_FRAMES) continue;
    lastTick = a.frame;
    ticks.push({ t: r3(a.frame / fps), type: "tick", intensity: 0.45, pan: panOf(a.x), note: `text ${quote(a.text)} appears on f${a.frame}`, frame: a.frame });
  }

  // Past the cap, keep the hits, then the loudest whooshes, then the ticks.
  const ranked = [...hits, ...[...whooshes].sort((a, b) => b.intensity! - a.intensity! || a.t - b.t), ...ticks];
  const kept = ranked.slice(0, max);
  const cues = kept.sort((a, b) => a.t - b.t || a.type.localeCompare(b.type)).map(({ frame: _f, ...c }) => c);
  const count = (type: string) => cues.filter((c) => c.type === type).length;
  return { cues, counts: { whoosh: count("whoosh"), hit: count("hit"), tick: count("tick") }, dropped: ranked.length - kept.length };
}
