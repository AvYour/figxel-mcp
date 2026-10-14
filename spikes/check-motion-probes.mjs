// The probe frame of spikes/live-check-motion.mjs, as data: one layer per
// figma_check_motion rule, keyed to break exactly that rule, and the snapshot
// the plugin op `check_motion` reads back from the frame the spike builds.
//
// test/check-motion-probes.test.ts audits that snapshot offline with the
// server's own judge, so a probe that cannot fire its rule fails in CI instead
// of in a live run. The snapshot mirrors the figma_eval code in the spike:
// change the two together.

export const FPS = 30;

export const IN = "cubic:0.7,0,0.84,0";
export const OUT_EXPO = "cubic:0.16,1,0.3,1";
export const SOFT = "cubic:0.45,0,0.55,1";
export const DRAW = "cubic:0.65,0,0.35,1";
export const SWELL = "cubic:0.33,0,0.67,1";
export const t = (frame) => Math.round((frame / FPS) * 10000) / 10000;
/** A jump on exactly frame k: two LINEAR keys inside the frame before it [C-240]. */
export const cut = (k, from, to) => [
  { t: t(k - 0.75), value: String(from), easing: "LINEAR" },
  { t: t(k - 0.15), value: String(to), easing: "LINEAR" },
];
export const opacity = (...switches) => ({ field: "OPACITY", keyframes: [{ t: 0, value: String(switches[0][1]) }, ...switches.flatMap(([k, from, to]) => cut(k, from, to))] });
export const tr = (field, ...keyframes) => ({ field, keyframes: keyframes.map(([time, value, easing]) => ({ t: time, value: String(value), ...(easing ? { easing } : {}) })) });

/** The probe frame: 540 × 960, clipping, on a 4 s timeline. */
export const FRAME = { width: 540, height: 960, durationS: 4 };

// Every probe: what it is, where it sits in the 540 × 960 frame, and its keys.
// `rule` is what must fire on it (a rule or one of its narrower names).
export const PROBES = [
  { name: "vanish_mid_move", kind: "ellipse", w: 100, h: 100, tracks: [tr("SCALE_XY", [0, "1,1"], [0.5, "1,1", "LINEAR"], [1, "0.0025,0.0025", IN]), opacity([28, 1, 0])] },
  { name: "pop_in", kind: "line", w: 100, cap: "NONE", tracks: [tr("PATH_TRIM_END", [0, 0], [1, 0, "LINEAR"], [t(35), 1, OUT_EXPO]), opacity([31, 0, 1])] },
  { name: "concentrated_step", w: 60, h: 60, tracks: [tr("TRANSLATION_Y", [0, 0], [t(40), 0, "LINEAR"], [t(46), 200, IN])] },
  { name: "strobe", w: 40, h: 40, tracks: [tr("TRANSLATION_X", [0, 0], [2, 0, "LINEAR"], [t(65), 1000, "LINEAR"])] },
  { name: "blur_off_speed", w: 60, h: 60, blur: true, tracks: [tr("TRANSLATION_Y", [0, 0], [t(70), 0, "LINEAR"], [t(80), 300, IN]), tr("effect:0:RADIUS", [0, 0], [t(76), 0, "LINEAR"], [t(78), 8, SOFT], [t(80), 0, "LINEAR"])] },
  { name: "one_frame_extreme", w: 110, h: 60, tracks: [tr("SCALE_XY", [0, "1,1"], [t(37), "1,1", "LINEAR"], [t(39), "1.1,1.1", SWELL], [t(49), "1,1", OUT_EXPO])] },
  { name: "arrival_not_held", parent: "arrival scene", w: 100, h: 100, tracks: [tr("SCALE_XY", [0, "1,1"], [t(10), "1,1", "LINEAR"], [t(20), "0.1,0.1", IN])] },
  // Three scenes, each entering with the same rise: one move signature under three parents.
  { name: "template_move 1", parent: "template a", w: 80, h: 40, rule: "template_move", tracks: [tr("TRANSLATION_Y", [0, 40], [1, 40, "LINEAR"], [t(40), 0, OUT_EXPO])] },
  { name: "template_move 2", parent: "template b", w: 80, h: 40, tracks: [tr("TRANSLATION_Y", [0, 40], [1.5, 40, "LINEAR"], [t(55), 0, OUT_EXPO])] },
  { name: "template_move 3", parent: "template c", w: 80, h: 40, tracks: [tr("TRANSLATION_Y", [0, 40], [2, 40, "LINEAR"], [t(70), 0, OUT_EXPO])] },
  ...[1, 2, 3].map((i) => ({ name: `no_stagger ${i}`, parent: "stagger line", w: 30, h: 30, rule: i === 1 ? "no_stagger" : undefined, tracks: [tr("TRANSLATION_Y", [0, 30], [1, 30, "LINEAR"], [t(40), 0, OUT_EXPO])] })),
  { name: "unrendered_extreme", w: 60, h: 60, tracks: [tr("SCALE_XY", [0, "1,1"], [1, "1,1", "LINEAR"], [t(30.5), "1.3,1.3", OUT_EXPO], [1.5, "1,1", OUT_EXPO])] },
  { name: "easing_census 1", w: 60, h: 60, rule: "easing_census", tracks: [tr("SCALE_XY", [0, "0.5,0.5"], [1, "1,1", "EASE_OUT_BACK"])] },
  { name: "easing_census 2", w: 60, h: 60, tracks: [tr("SCALE_XY", [0, "0.5,0.5"], [1.2, "1,1", "EASE_OUT_BACK"])] },
  { name: "hold_easing", w: 60, h: 60, tracks: [tr("OPACITY", [0, 1], [1, 0, "HOLD"])] },
  // 100 BPM: beats every 0.6 s; this punch starts on the 2.4 s beat, so its peak lands late.
  { name: "beat_offset", w: 100, h: 100, tracks: [tr("SCALE_XY", [0, "1,1"], [2.4, "1,1", "LINEAR"], [t(74), "1.08,1.08", SWELL], [t(84), "1,1", OUT_EXPO])] },
  { name: "read_time", kind: "text", characters: "three little words here", tracks: [opacity([30, 0, 1], [45, 1, 0])] },
  { name: "rest_state_hidden", w: 60, h: 60, restOpacity: 0, tracks: [tr("OPACITY", [0, 0], [0.5, 1, "LINEAR"])] },
  { name: "timeline_end", w: 60, h: 60, pastEnd: true, tracks: [tr("TRANSLATION_X", [0, 0], [4.5, 50, "LINEAR"])] },
  { name: "roundcap_zero_trim", kind: "line", w: 100, cap: "ROUND", tracks: [tr("PATH_TRIM_END", [0, 0], [2, 0, "LINEAR"], [2.5, 1, DRAW])] },
  { name: "brand_late", w: 100, h: 40, tracks: [opacity([105, 0, 1])] },
  { name: "cta_short", kind: "text", characters: "Shop now", tracks: [opacity([60, 0, 1], [90, 1, 0])] },
  { name: "first_key_late", w: 60, h: 60, tracks: [tr("OPACITY", [1, 0], [1.5, 1, "LINEAR"])] },
  { name: "clamped_morph", w: 110, h: 100, radius: 10, tracks: [tr("WIDTH", [0, 20], [t(10), 110, OUT_EXPO]), tr("HEIGHT", [0, 20], [t(15), 100, OUT_EXPO]), tr("CORNER_RADIUS", [0, 10], [t(15), 50, OUT_EXPO])] },
  // Calibration probes, judged by eye and metric in the render: strobe at the info and warning
  // limits, a big step under a capped blur, and the r1 wheel's collapse with its blur a frame early.
  { name: "strobe 60px", w: 40, h: 40, calibration: true, tracks: [tr("TRANSLATION_X", [0, 0], [3, 0, "LINEAR"], [t(95), 300, "LINEAR"])] },
  { name: "strobe 150px", w: 40, h: 40, calibration: true, tracks: [tr("TRANSLATION_X", [0, 0], [3, 0, "LINEAR"], [t(94), 600, "LINEAR"])] },
  { name: "strobe 400px blur 12", w: 40, h: 40, blur: true, calibration: true, tracks: [tr("TRANSLATION_X", [0, 0], [3, 0, "LINEAR"], [t(92), 800, "LINEAR"]), tr("effect:0:RADIUS", [0, 12])] },
  { name: "wheel collapse", kind: "ellipse", w: 110, h: 110, blur: true, calibration: true, tracks: [tr("SCALE_XY", [0, "1,1"], [t(95), "1,1", "LINEAR"], [t(105), "0.1,0.1", IN]), tr("effect:0:RADIUS", [0, 0], [t(99), 0, "LINEAR"], [t(104), 8, SOFT], [t(105), 0, "LINEAR"])] },
];

/** The frames that hold probes, in the order the spike creates them. */
export const PARENTS = ["arrival scene", "template a", "template b", "template c", "stagger line"];

/**
 * Every parent is a 120 × 120 frame with no fill that does not clip. It must
 * not clip: figma.createFrame() starts with clipsContent true [C-067], and the
 * audit reads a clipping frame that wraps one layer as that layer's mask,
 * grouping the layer with the mask's own parent (motion-audit.ts groupOf). Left
 * clipping (the 2026-10-13 live run), the three template scenes read as three
 * masks in the probe frame: the six layers sharing the rise, the stagger line's
 * three included, had 2 parents where template_move needs 3, and it was silent.
 */
export const PARENT_FRAME = { w: 120, h: 120, clipsContent: false };

/** Keys on the parents themselves: the arrival scene leaves one frame after its child lands. */
export const PARENT_TRACKS = { "arrival scene": [opacity([21, 1, 0])] };

/** Rules that report on the frame rather than a layer; the spike probes them on its stillness frame. */
export const FRAME_RULES = ["dead_span", "cold_open"];
export const VARIANT_OF = { cut_at_rest: "vanish_mid_move", stagger_off_grid: "no_stagger", off_grid: "unrendered_extreme", dimmed_text: "read_time" };

/** The audit's arguments besides nodeId, brandId and ctaId: brand_late and cta_short probe the layers named here. */
export const AUDIT = { bpm: 100, limit: 500 };
export const BRAND = "brand_late";
export const CTA = "cta_short";

/** The probes that must fire a rule on the probe frame, and the rule each must fire. */
export function ruleProbes() {
  return PROBES.filter((p) => !p.calibration && (p.rule !== undefined || !/ \d$/.test(p.name))).map((p) => ({ probe: p, rule: p.rule ?? p.name }));
}

/** The finding that answers a probe: its rule (or a narrower name) on the probe, a sibling probe of the rule, or the frame. */
export function hitFor(issues, rule, probeName, frameId) {
  const ruleOf = (r) => VARIANT_OF[r] ?? r;
  return issues.find((i) => ruleOf(i.rule) === rule && (i.name === probeName || i.name.startsWith(rule) || i.nodeId === frameId));
}

/**
 * The snapshot figma_check_motion's plugin op reads from the probe frame the
 * spike builds (src/plugin/ops/motion-snapshot.ts `describe`): ids are made up,
 * the rest is what the frame holds. The walk is depth first in document order:
 * the parents first, each followed by its probes, then the probes placed in the
 * frame itself. Text boxes are left out (they size to their characters), so the
 * audit sizes text by its font size.
 */
export function probeSnapshot() {
  const FRAME_ID = "probe:frame";
  const id = (name) => `probe:${name}`;
  const inFrame = PROBES.filter((p) => !p.parent);
  const node = (p, parentId) => {
    const n = { id: id(p.name), name: p.name, parentId };
    if (p.kind === "text") Object.assign(n, { type: "TEXT", characters: p.characters, fontSize: 28 });
    else if (p.kind === "line") Object.assign(n, { type: "VECTOR", width: p.w, height: 0, strokeCap: p.cap, strokeWeight: 8 });
    else Object.assign(n, { type: p.kind === "ellipse" ? "ELLIPSE" : "RECTANGLE", width: p.w, height: p.h });
    if (p.restOpacity !== undefined && p.restOpacity !== 1) n.opacity = p.restOpacity;
    if (p.radius) n.cornerRadius = p.radius;
    if (p.blur) n.effects = [{ type: "LAYER_BLUR", radius: 0 }];
    n.tracks = p.tracks;
    return n;
  };
  const nodes = [
    { id: FRAME_ID, name: "figma-mcp check_motion probes (delete me)", type: "FRAME", parentId: null, width: FRAME.width, height: FRAME.height, clipsContent: true, childCount: PARENTS.length + inFrame.length },
  ];
  for (const name of PARENTS) {
    const kids = PROBES.filter((p) => p.parent === name);
    nodes.push({
      id: id(name),
      name,
      type: "FRAME",
      parentId: FRAME_ID,
      width: PARENT_FRAME.w,
      height: PARENT_FRAME.h,
      ...(PARENT_FRAME.clipsContent ? { clipsContent: true } : {}),
      ...(kids.length ? { childCount: kids.length } : {}),
      ...(PARENT_TRACKS[name] ? { tracks: PARENT_TRACKS[name] } : {}),
    });
    for (const p of kids) nodes.push(node(p, id(name)));
  }
  for (const p of inFrame) nodes.push(node(p, FRAME_ID));
  return {
    snapshot: { root: { id: FRAME_ID, name: nodes[0].name, width: FRAME.width, height: FRAME.height, durationS: FRAME.durationS }, nodes, truncated: false, maxNodes: 2000 },
    frameId: FRAME_ID,
    idOf: id,
  };
}
