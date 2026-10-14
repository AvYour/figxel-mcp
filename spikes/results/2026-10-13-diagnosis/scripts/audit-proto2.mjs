// Prototype of track-only motion-audit rules, run against the 2026-10-09 run's
// figma_get_motion_context snapshots. Throwaway: it exists to ground thresholds.
// Usage: node audit-proto.mjs <mc.json> [fps]
import { readFileSync } from "node:fs";

const file = process.argv[2];
const FPS = Number(process.argv[3] ?? 30);
const j = JSON.parse(readFileSync(file, "utf8"));
const d = j.data ?? j;
const DUR = d.nodes[0]?.timeline?.durationS ?? 14.4;
const N = Math.round(DUR * FPS); // last frame index rendered is N (measured: 433 frames for 14.4 s)

function bez(x1, y1, x2, y2) {
  const bx = (t) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3;
  const by = (t) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (bx(m) < x) lo = m; else hi = m; }
    return by((lo + hi) / 2);
  };
}
const curve = (e) => {
  if (!e || e === "LINEAR") return (x) => x;
  if (e.startsWith("cubic:")) return bez(...e.slice(6).split(",").map(Number));
  if (e === "HOLD") return (x) => (x >= 1 ? 1 : 0);
  return null; // named preset: unknown curve
};
const num = (v) => (v.startsWith("#") ? null : v.split(",").map(Number));
function sample(track) {
  const k = track.keyframes;
  const out = [];
  let unknown = false;
  for (let f = 0; f <= N; f++) {
    const t = f / FPS;
    let v;
    if (t <= k[0].t) v = num(k[0].value);
    else if (t >= k[k.length - 1].t) v = num(k[k.length - 1].value);
    else {
      for (let i = 1; i < k.length; i++) if (t <= k[i].t) {
        const a = k[i - 1], b = k[i];
        const c = curve(b.easing);
        if (!c) unknown = true;
        const y = (c ?? ((x) => x))((t - a.t) / (b.t - a.t));
        const va = num(a.value), vb = num(b.value);
        v = va && vb ? va.map((x, m) => x + (vb[m] - x) * y) : null;
        break;
      }
    }
    out.push(v);
  }
  return { values: out, unknown };
}

const nodes = d.nodes;
const byName = new Map(nodes.map((n) => [n.name, n]));
// Container opacity by scene prefix (the prototype has no parent ids).
const containerOf = (name) => {
  const m = /^(S\d)/.exec(name);
  if (!m) return null;
  return nodes.find((n) => n.name.startsWith(m[1] + " ·"));
};
const S = new Map(); // node -> field -> values
for (const n of nodes) {
  const m = new Map();
  for (const t of n.tracks) if (!t.field.startsWith("fill") && !t.field.startsWith("stroke")) m.set(t.field, sample(t).values);
  S.set(n.name, m);
}
const opacityAt = (name, f) => {
  const own = S.get(name)?.get("OPACITY")?.[f]?.[0] ?? 1;
  const c = containerOf(name);
  const cont = c && c.name !== name ? S.get(c.name)?.get("OPACITY")?.[f]?.[0] ?? 1 : 1;
  return own * cont;
};
const blurAt = (name, f) => S.get(name)?.get("effect:0:RADIUS")?.[f]?.[0] ?? 0;

const findings = [];
const add = (rule, name, f, detail) => findings.push({ rule, name, f, t: (f / FPS).toFixed(3), detail });

// ── R1 vanish / snap: visible extent drops from >= 40 % to ~0 in one frame ──
const SIZE = ["SCALE_XY", "SCALE_X", "SCALE_Y", "WIDTH", "HEIGHT"];
function extent(name, f) {
  const m = S.get(name);
  let e = 1;
  for (const fld of SIZE) {
    const v = m.get(fld);
    if (!v) continue;
    const max = Math.max(...v.map((x) => Math.abs(x[0])));
    if (max > 0) e = Math.min(e, Math.abs(v[f][0]) / max);
  }
  const ts = m.get("PATH_TRIM_START"), te = m.get("PATH_TRIM_END");
  if (ts || te) e = Math.min(e, Math.max(0, (te ? te[f][0] : 1) - (ts ? ts[f][0] : 0)));
  return e;
}
for (const n of nodes) {
  if (n.name.includes(" · ")) continue; // scene containers: their cuts are scene cuts
  for (let f = 1; f <= N; f++) {
    const c = containerOf(n.name); const cA = c && c.name !== n.name ? (S.get(c.name)?.get("OPACITY")?.[f-1]?.[0] ?? 1) : 1; const cB = c && c.name !== n.name ? (S.get(c.name)?.get("OPACITY")?.[f]?.[0] ?? 1) : 1;
    if (Math.abs(cA - cB) > 0.02) continue; // the scene container cut: a scene cut, not this layer
    const a = opacityAt(n.name, f - 1) * extent(n.name, f - 1);
    const b = opacityAt(n.name, f) * extent(n.name, f);
    if (a >= 0.4 && b <= 0.02 && blurAt(n.name, f - 1) < 6) add("vanish", n.name, f, `visible extent ${a.toFixed(2)} on f${f - 1}, gone on f${f}`);
    if (a <= 0.02 && b >= 0.6 && blurAt(n.name, f) < 6) {
      // only when the jump comes from a size-like track, not a pure opacity cut of a full-size layer
      const fromSize = extent(n.name, f) < 0.98 || extent(n.name, f - 1) < 0.02;
      if (fromSize) add("pop_in", n.name, f, `visible extent 0 on f${f - 1}, ${b.toFixed(2)} on f${f}`);
    }
  }
}

// ── R2 segment concentration: >= 40 % of a >= 4-frame move in one frame, no blur ──
for (const n of nodes) {
  for (const t of n.tracks) {
    if (!/^(TRANSLATION|SCALE|WIDTH|HEIGHT|PATH_TRIM)/.test(t.field)) continue;
    const k = t.keyframes;
    for (let i = 1; i < k.length; i++) {
      const a = k[i - 1], b = k[i];
      const fa = Math.ceil(a.t * FPS - 1e-6), fb = Math.floor(b.t * FPS + 1e-6);
      if (fb - fa < 4) continue;
      const va = num(a.value), vb = num(b.value);
      if (!va || !vb) continue;
      const total = Math.hypot(...va.map((x, m) => vb[m] - x));
      if (total === 0) continue;
      const vals = S.get(n.name).get(t.field);
      let best = 0, bf = 0;
      for (let f = fa + 1; f <= fb; f++) {
        const step = Math.hypot(...vals[f].map((x, m) => x - vals[f - 1][m]));
        if (step > best) { best = step; bf = f; }
      }
      const share = best / total;
      const px = /^TRANSLATION|WIDTH|HEIGHT/.test(t.field) ? best : null;
      const vis = opacityAt(n.name, bf) > 0.5 && opacityAt(n.name, bf - 1) > 0.5;
      if (share >= 0.4 && vis && blurAt(n.name, bf) < 6 && (px === null || px >= 24)) {
        add("concentrated_step", n.name, bf, `${t.field} ${b.easing}: ${(share * 100).toFixed(0)} % of ${fb - fa}-frame move in one frame${px !== null ? ` (${px.toFixed(0)} px)` : ""}`);
      }
    }
  }
}

// ── R3 dead span: no track changes for > 0.5 s ──
let still = 0, start = 0;
const spans = [];
for (let f = 1; f <= N; f++) {
  let moving = false;
  for (const n of nodes) {
    if (opacityAt(n.name, f) < 0.05) continue;
    for (const [fld, v] of S.get(n.name)) {
      if (!v[f] || !v[f - 1]) continue;
      const delta = Math.max(...v[f].map((x, m) => Math.abs(x - v[f - 1][m])));
      const thr = /^TRANSLATION|WIDTH|HEIGHT|STACK/.test(fld) ? 0.3 : /^SCALE/.test(fld) ? 0.0004 : fld === "ROTATION" ? 0.05 : 0.005;
      if (delta > thr) { moving = true; break; }
    }
    if (moving) break;
  }
  if (!moving) { if (still === 0) start = f; still++; }
  else { if (still / FPS > 0.5) spans.push([start, f - 1]); still = 0; }
}
if (still / FPS > 0.5) spans.push([start, N]);
for (const [a, b] of spans) add("dead_span", "(frame)", a, `nothing changes f${a}-f${b} (${((b - a + 1) / FPS).toFixed(2)} s)`);

// ── R4 template move: same entry signature on many layers ──
const sig = new Map();
for (const n of nodes) {
  const parts = [];
  for (const t of n.tracks) {
    const k = t.keyframes;
    for (let i = 1; i < k.length; i++) {
      if (k[i].value === k[i - 1].value) continue;
      const dur = Math.round((k[i].t - k[i - 1].t) * FPS);
      if (dur < 3) continue; // cuts
      const va = num(k[i - 1].value), vb = num(k[i].value);
      const delta = va && vb ? vb.map((x, m) => Math.round((x - va[m]) / 10) * 10).join(",") : "c";
      parts.push(`${t.field}:${delta}:${dur}f:${k[i].easing}`);
      break; // first move of each track = the entry
    }
  }
  if (parts.length) { const s = parts.sort().join(" + "); sig.set(s, [...(sig.get(s) ?? []), n.name]); }
}
for (const [s, list] of sig) if (list.length >= 4) add("template_move", list.slice(0, 6).join(", "), 0, `${list.length} layers enter with "${s}"`);

// ── R5 off-grid keys that are not cut pairs ──
let off = 0, offPeak = 0;
for (const n of nodes) for (const t of n.tracks) {
  const k = t.keyframes;
  for (let i = 0; i < k.length; i++) {
    const fr = k[i].t * FPS;
    if (Math.abs(fr - Math.round(fr)) < 0.02) continue;
    const pair = (i > 0 && (k[i].t - k[i - 1].t) * FPS < 1) || (i + 1 < k.length && (k[i + 1].t - k[i].t) * FPS < 1);
    if (pair) continue;
    off++;
    const v = num(k[i].value), p = i > 0 ? num(k[i - 1].value) : null, q = i + 1 < k.length ? num(k[i + 1].value) : null;
    if (v && p && q && ((v[0] - p[0]) * (q[0] - v[0]) < 0)) { offPeak++; add("unrendered_peak", n.name, Math.round(fr), `${t.field} extreme ${k[i].value} at ${k[i].t} s = frame ${fr.toFixed(2)}: never rendered`); }
  }
}
add("off_grid_total", "(all)", 0, `${off} keys off the 1/${FPS} s grid outside cut pairs, ${offPeak} of them extremes`);

// ── R6 blur cap ──
for (const n of nodes) {
  const v = S.get(n.name).get("effect:0:RADIUS");
  if (!v) continue;
  const mx = Math.max(...v.map((x) => x[0]));
  if (mx > 20) add("blur_over_cap", n.name, v.findIndex((x) => x[0] === mx), `blur peaks at ${mx}`);
}

// ── R7 blur/speed phase on translation ──
for (const n of nodes) {
  const b = S.get(n.name).get("effect:0:RADIUS");
  const tr = S.get(n.name).get("TRANSLATION_Y") ?? S.get(n.name).get("TRANSLATION_X") ?? S.get(n.name).get("TRANSLATION_XY");
  if (!b || !tr) continue;
  let vmax = 0, fv = 0;
  for (let f = 1; f <= N; f++) { const s = Math.hypot(...tr[f].map((x, m) => x - tr[f - 1][m])); if (s > vmax && opacityAt(n.name, f) > 0.5) { vmax = s; fv = f; } }
  if (vmax < 30) continue;
  let bmax = 0, fb = 0;
  for (let f = Math.max(0, fv - 6); f <= Math.min(N, fv + 6); f++) if (b[f][0] > bmax) { bmax = b[f][0]; fb = f; }
  if (bmax > 0 && (Math.abs(fb - fv) > 1 || b[fv][0] < 0.5 * bmax)) add("blur_off_speed", n.name, fv, `fastest frame f${fv} (${vmax.toFixed(0)} px/f) has blur ${b[fv][0].toFixed(1)}; blur peaks ${bmax} on f${fb}`);
}

// ── R8 one-frame peak with reversal (punch cusp / dot blink) on SCALE ──
for (const n of nodes) {
  const v = S.get(n.name).get("SCALE_XY");
  if (!v) continue;
  for (let f = 1; f < N; f++) {
    const d1 = v[f][0] - v[f - 1][0], d2 = v[f + 1][0] - v[f][0];
    if (d1 * d2 >= 0) continue;
    const small = Math.min(Math.abs(d1), Math.abs(d2)), big = Math.max(Math.abs(d1), Math.abs(d2));
    if (small >= 0.008 && small >= 0.5 * big && opacityAt(n.name, f) > 0.5) add("one_frame_extreme", n.name, f, `SCALE ${v[f - 1][0].toFixed(3)} -> ${v[f][0].toFixed(3)} -> ${v[f + 1][0].toFixed(3)}`);
  }
}

const by = new Map();
for (const x of findings) by.set(x.rule, [...(by.get(x.rule) ?? []), x]);
console.log(`# ${file.split(/[\\/]/).slice(-2).join("/")}  nodes ${nodes.length}  frames 0-${N}`);
for (const [r, list] of by) {
  console.log(`\n## ${r} (${list.length})`);
  for (const x of list.slice(0, 40)) console.log(`  f${x.f} ${x.t}s  ${x.name}: ${x.detail}`);
}

// ── R9 arrival not held: a fast arrival whose state is on screen < 3 frames ──
console.log("\n## arrival_not_held");
for (const n of nodes) {
  for (const t of n.tracks) {
    if (!/^(SCALE|WIDTH|HEIGHT|TRANSLATION)/.test(t.field)) continue;
    const k = t.keyframes;
    for (let i = 1; i < k.length; i++) {
      const a = k[i - 1], b = k[i];
      if (a.value === b.value) continue;
      const fb = Math.round(b.t * FPS);
      const fa = Math.ceil(a.t * FPS - 1e-6);
      if (fb - fa < 3) continue;
      const vals = S.get(n.name).get(t.field);
      const total = Math.hypot(...num(b.value).map((x, m) => x - num(a.value)[m]));
      const last = Math.hypot(...vals[fb].map((x, m) => x - vals[fb - 1][m]));
      if (total === 0 || last / total < 0.25) continue; // arrives slowly: fine
      if (opacityAt(n.name, fb) < 0.5) continue;
      // frames the arrived state stays on screen and unchanged
      let held = 0;
      for (let f = fb; f <= N; f++) {
        const same = Math.hypot(...vals[f].map((x, m) => x - vals[fb][m])) < 0.02 * total;
        if (!same || opacityAt(n.name, f) < 0.5) break;
        held++;
      }
      if (held < 3) console.log(`  f${fb} ${n.name} ${t.field} ${b.easing}: arrives with ${(100 * last / total).toFixed(0)} % of its travel in the last frame, state on screen ${held} frame(s)`);
    }
  }
}
