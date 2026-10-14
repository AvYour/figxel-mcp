// Live probe of the motion facts figma_check_motion leans on (plan §5.3,
// row 4). The 2026-10-13 runs measured most of them; a re-run measures them
// again:
//
//   [C-189] HOLD: the value stays until the key and steps on the frame at it,
//           and HOLD on a segment's first key has no effect (measured at 24
//           and 30 fps).
//   [C-190] the curves of Figma's named easings and spring presets, sampled
//           per frame so src/shared/motion-curves.ts can replace its stand-ins.
//   [C-191] what a track shows before its first key (measured: the first
//           key's value, never the base).
//   [C-192] a box read inside an animated frame gives the base values, not
//           the playhead's; TRANSLATION on an auto-layout child moves only it;
//           STACK_SPACING on a hugging row reflows the children and the row
//           grows (all measured). ROTATION
//           on an auto-layout child and the SCALE pivot box stay unmeasured,
//           and this probe does not test them.
//   [C-193] frame k shows t = k / fps (measured on MP4 at 24, 30 and 60 fps
//           and on a 12 fps GIF), and a segment follows the easing of the key
//           it runs into.
//   [C-194] how many frames each format holds, against figma_export_video's
//           `expectedFrames`: ceil(d · fps) + 1 in every format, d kept to
//           the microsecond. The 2026-10-13 run gave MP4 at 24/30/60 fps,
//           where round and ceil agree, and a 12 fps GIF 16 frames for
//           1.2 s, ceil; live-animatic's dissolve gave an MP4 ceil where
//           round differs. MP4@12 and WEBM@12 (14.4 frames: round 15, ceil
//           16) test MP4 and WEBM at a fraction below one half; GIF@15
//           (18, whole) tells ceil(d · fps) + 1 from floor(d · fps) + 2. A
//           GIF's per-frame delays are recorded too: 8 cs at 12 fps.
//
// One 400 × 436 frame named "figma-mcp motion semantics probe (delete me)" at
// x 52000, y 24000 holds a 20 × 20 black square per row on white. Every row
// is rendered and decoded with ffmpeg (it must be on PATH [C-205]), and each
// square's position is read from the pixels. Raw numbers and verdicts go to
// spikes/results/live-motion-semantics.json; the frame is deleted unless KEEP=1.
//
// Run:  npm run build, re-run the plugin in Figma, then
//       node spikes/live-motion-semantics.mjs        (KEEP=1 to leave the frame)
// Keep the Figma window restored while it renders [C-198].

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./mcp-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "results", "live-motion-semantics.json");
const KEEP = process.env.KEEP === "1";
const X = 52000;
const Y = 24000;
const W = 400;
const BAND = 24;
const DURATION = 1.2;
const TRAVEL = 200;
const BASE_X = 100;
const VIDEO_TIMEOUT = 600_000;

const NAMED = ["EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK", "GENTLE", "QUICK", "BOUNCY", "SLOW"];
const OUT_EXPO = "cubic:0.16,1,0.3,1";
// Rows top to bottom; each is one band of BAND px. The last three are built differently (see build()).
const ROWS = ["cubic-into-key", "cubic-on-first-key", "hold-on-end-key", "hold-on-start-key", "before-first-key", ...NAMED.map((n) => `named-${n}`), "width-keyed", "al-translate", "al-spacing"];
const H = 4 + ROWS.length * BAND;

const results = { ranAt: new Date().toISOString(), frame: null, renders: {}, measured: {}, verdicts: {}, steps: [] };
const record = (label, ok, why) => {
  results.steps.push({ label, ok, why });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(56)} ${why}`);
};
const short = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 160 ? `${s.slice(0, 160)}…` : (s ?? "");
};

const mcp = await connect({ allowEval: true, env: { BRIDGE_ALLOW_UNVERIFIED: "1" } });
const tools = await mcp.list();
const registered = new Set(tools.map((t) => t.name));
const exportSchema = tools.find((t) => t.name === "figma_export_video")?.inputSchema?.properties ?? {};

const st = await mcp.call("figma_status", {});
const sess = st.data?.sessions?.find((s) => s.active) ?? st.data?.sessions?.[0];
console.log(`role ${st.data?.bridge?.role}, file "${sess?.file?.name}", build ${JSON.stringify(sess?.build)}`);
if (!sess || !registered.has("figma_eval")) {
  console.error("Needs a Figma session and figma_eval (BRIDGE_ALLOW_EVAL): run the plugin in Figma first.");
  await mcp.close();
  process.exit(2);
}
const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (ffmpeg.error) {
  console.error("ffmpeg is not on PATH; the probe reads positions from decoded frames [C-205].");
  await mcp.close();
  process.exit(2);
}

async function evalJs(code) {
  const r = await mcp.call("figma_eval", { code });
  if (!r.ok) throw new Error(`figma_eval failed: ${short(r.text)}`);
  return r.data && "value" in r.data ? r.data.value : r.data;
}

/** The CSS cubic-bezier the audit evaluates with, restated: a spike cannot import the TypeScript source. */
function bezier(x1, y1, x2, y2) {
  const b = (p1, p2, s) => 3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s ** 2 * p2 + s ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 80; i++) {
      const m = (lo + hi) / 2;
      if (b(x1, x2, m) < x) lo = m;
      else hi = m;
    }
    return b(y1, y2, (lo + hi) / 2);
  };
}
const outExpo = bezier(0.16, 1, 0.3, 1);

/** Render the probe; on a build with job mode, poll the job until the file is there [C-249]. */
async function render(frameId, format, fps) {
  const ext = format.toLowerCase();
  const args = { nodeId: frameId, format, fps, width: W, saveTo: `wp4-semantics-${fps}.${ext}` };
  const jobs = "jobId" in exportSchema && "wait" in exportSchema;
  const jobId = `wp4-sem-${format}-${fps}-${Date.now()}`;
  let r = await mcp.call("figma_export_video", jobs ? { ...args, jobId, wait: 40 } : args, { timeoutMs: VIDEO_TIMEOUT });
  for (let i = 0; jobs && r.ok && r.data?.status === "rendering" && i < 30; i++) r = await mcp.call("figma_export_video", { jobId, wait: 40 }, { timeoutMs: VIDEO_TIMEOUT });
  if (!r.ok || !r.data?.path) throw new Error(`export ${format} ${fps} fps failed: ${short(r.text)}`);
  return r.data;
}

/** Every frame of a video as rows of grey bytes. */
function decode(file) {
  // Scaled to the frame's size, so a render rounded a pixel off still lines up with the bands.
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 30, windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg could not decode ${file}: ${String(r.stderr)}`);
  const size = W * H;
  const frames = [];
  for (let o = 0; o + size <= r.stdout.length; o += size) frames.push(r.stdout.subarray(o, o + size));
  return frames;
}

/** A GIF's per-frame delays in hundredths of a second, read from its Graphic Control Extensions. */
function gifDelays(file) {
  const b = fs.readFileSync(file);
  if (b.toString("latin1", 0, 3) !== "GIF") return undefined;
  const table = (flags) => (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  const skipBlocks = (p) => {
    while (p < b.length && b[p] !== 0) p += b[p] + 1;
    return p + 1;
  };
  const delays = [];
  let pending = null;
  let p = 13 + table(b[10]);
  while (p < b.length) {
    const tag = b[p++];
    if (tag === 0x21) {
      const label = b[p++];
      if (label === 0xf9) pending = b.readUInt16LE(p + 2);
      p = skipBlocks(p);
    } else if (tag === 0x2c) {
      p += 9 + table(b[p + 8]) + 1; // descriptor, local colour table, LZW code size
      p = skipBlocks(p);
      delays.push(pending);
      pending = null;
    } else break; // 0x3b, the trailer
  }
  return delays;
}

/** Dark runs along the middle rows of a band: each square's left edge and width, darkness-weighted to sub-pixel. */
function blobs(frame, band) {
  const top = 4 + band * BAND + 4;
  const ink = new Float64Array(W);
  for (let y = top; y < top + 12; y++) for (let x = 0; x < W; x++) ink[x] += (255 - frame[y * W + x]) / 255 / 12;
  const out = [];
  let x = 0;
  while (x < W) {
    if (ink[x] < 0.1) {
      x++;
      continue;
    }
    let mass = 0;
    let moment = 0;
    const start = x;
    while (x < W && ink[x] >= 0.02) {
      mass += ink[x];
      moment += ink[x] * (x + 0.5);
      x++;
    }
    out.push({ centre: moment / mass, width: mass, from: start });
  }
  return out;
}

/** The square's offset from its resting x on every frame (NaN where it cannot be seen). */
const offsets = (frames, band) => frames.map((f) => {
  const b = blobs(f, band)[0];
  return b ? Math.round((b.centre - BASE_X - 10) * 100) / 100 : NaN;
});

let frameId;
try {
  // ── build ────────────────────────────────────────────────────────────────
  const built = await evalJs(`
    const f = figma.createFrame();
    f.name = "figma-mcp motion semantics probe (delete me)";
    f.x = ${X}; f.y = ${Y}; f.resize(${W}, ${H});
    f.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    f.clipsContent = true;
    const black = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
    const ids = { frame: f.id };
    const square = (name) => { const r = figma.createRectangle(); r.name = name; r.resize(20, 20); r.fills = black; return r; };
    const rows = ${JSON.stringify(ROWS)};
    rows.forEach((name, i) => {
      const y = 4 + i * ${BAND};
      if (name === "al-translate" || name === "al-spacing") {
        const row = figma.createFrame();
        row.name = name; row.fills = []; row.layoutMode = "HORIZONTAL";
        row.primaryAxisSizingMode = "AUTO"; row.counterAxisSizingMode = "AUTO"; row.itemSpacing = 20;
        f.appendChild(row); row.x = ${BASE_X}; row.y = y;
        ids[name] = row.id;
        ids[name + "/kids"] = [0, 1, 2].map((k) => { const c = square(name + "/" + k); row.appendChild(c); return c.id; });
      } else {
        // Placed after it is in the frame: x and y are relative to the parent.
        const r = square(name);
        f.appendChild(r);
        r.x = ${BASE_X}; r.y = y;
        ids[name] = r.id;
      }
    });
    return ids;
  `);
  frameId = built.frame;
  results.frame = { id: frameId, x: X, y: Y, width: W, height: H, rows: ROWS };
  record("probe frame built", true, `${frameId}, ${ROWS.length} rows`);

  // ── keys ─────────────────────────────────────────────────────────────────
  const keyed = [
    ["cubic-into-key", "TRANSLATION_X", [{ t: 0, value: "0" }, { t: 1, value: String(TRAVEL), easing: OUT_EXPO }]],
    ["cubic-on-first-key", "TRANSLATION_X", [{ t: 0, value: "0", easing: OUT_EXPO }, { t: 1, value: String(TRAVEL), easing: "LINEAR" }]],
    ["hold-on-end-key", "TRANSLATION_X", [{ t: 0, value: "0" }, { t: 0.5, value: String(TRAVEL), easing: "HOLD" }]],
    ["hold-on-start-key", "TRANSLATION_X", [{ t: 0, value: "0", easing: "HOLD" }, { t: 0.5, value: String(TRAVEL), easing: "LINEAR" }]],
    ["before-first-key", "TRANSLATION_X", [{ t: 0.5, value: "100", easing: "LINEAR" }, { t: 1, value: String(TRAVEL), easing: "LINEAR" }]],
    ...NAMED.map((n) => [`named-${n}`, "TRANSLATION_X", [{ t: 0, value: "0" }, { t: 1, value: String(TRAVEL), easing: n }]]),
    ["width-keyed", "WIDTH", [{ t: 0, value: "60" }, { t: 1, value: "120", easing: "LINEAR" }]],
  ];
  let first = true;
  for (const [name, field, keyframes] of keyed) {
    const r = await mcp.call("figma_set_keyframes", { nodeId: built[name], tracks: [{ field, keyframes }], ...(first ? { timelineDuration: DURATION } : {}) });
    record(`keys: ${name}`, r.ok, r.ok ? short(r.data?.tracks?.[0]?.keyframes) : short(r.text));
    if (!r.ok && /UNSUPPORTED/.test(r.text)) throw new Error("Motion is not available on this account [C-115]; nothing to measure.");
    first = false;
  }
  const alKid = built["al-translate/kids"][1];
  const kidKeys = await mcp.call("figma_set_keyframes", { nodeId: alKid, tracks: [{ field: "TRANSLATION_X", keyframes: [{ t: 0, value: "0" }, { t: 1, value: "40", easing: "LINEAR" }] }] });
  record("keys: auto-layout child TRANSLATION_X", kidKeys.ok, short(kidKeys.ok ? kidKeys.data : kidKeys.text));
  const spacing = await mcp.call("figma_set_keyframes", { nodeId: built["al-spacing"], tracks: [{ field: "STACK_SPACING", keyframes: [{ t: 0, value: "20" }, { t: 1, value: "60", easing: "LINEAR" }] }] });
  record("keys: hugging row STACK_SPACING", spacing.ok, short(spacing.ok ? spacing.data : spacing.text));

  // ── [C-192] what a read returns on an animated layer ─────────────────────
  const read = await evalJs(`
    const n = await figma.getNodeByIdAsync(${JSON.stringify(built["width-keyed"])});
    const kid = await figma.getNodeByIdAsync(${JSON.stringify(alKid)});
    const row = await figma.getNodeByIdAsync(${JSON.stringify(built["al-spacing"])});
    return { width: n.width, absoluteWidth: n.absoluteBoundingBox && n.absoluteBoundingBox.width, kidX: kid.x, rowWidth: row.width, rowSpacing: row.itemSpacing };
  `);
  results.measured.reads = read;
  results.verdicts["C-192 read"] =
    read.width === 20 ? "a read gives the BASE width (20), not the keyed value at the playhead" : read.width === 60 ? "a read gives the PLAYHEAD value (60 at t = 0)" : `a read gives ${read.width} (base 20, keyed 60 → 120)`;
  record("[C-192] width read on a keyed layer", true, results.verdicts["C-192 read"]);

  // ── renders ──────────────────────────────────────────────────────────────
  const plan = [
    ["MP4", 30],
    ["MP4", 24],
    ["MP4", 60],
    ["GIF", 12],
    // 1.2 s at 12 fps is 14.4 frames: round and ceil differ, so these settle MP4 and WEBM.
    ["MP4", 12],
    ["WEBM", 12],
    // 18 frames, whole: ceil(d · fps) + 1 = 19, floor(d · fps) + 2 = 20.
    ["GIF", 15],
  ];
  const decoded = {};
  for (const [format, fps] of plan) {
    const key = `${format}@${fps}`;
    try {
      const v = await render(frameId, format, fps);
      const frames = decode(v.path);
      // What figma-mcp predicts (src/shared/motion-curves.ts expectedFrames), restated for a build without it.
      const ceil = Math.ceil((Math.round(DURATION * 1e6) / 1e6) * fps - 1e-9) + 1;
      const expected = typeof v.expectedFrames === "number" ? v.expectedFrames : ceil;
      const delaysCs = format === "GIF" ? gifDelays(v.path) : undefined;
      decoded[key] = frames;
      results.renders[key] = {
        path: v.path,
        bytes: v.bytes,
        frames: frames.length,
        expectedFrames: expected,
        round: Math.round(DURATION * fps) + 1,
        ceil,
        ...(delaysCs ? { delaysCs, playsAtFps: delaysCs.length && delaysCs.every((d) => d === delaysCs[0]) ? 100 / delaysCs[0] : null } : {}),
      };
      const timing = delaysCs ? `; delays ${[...new Set(delaysCs)].join("/")} cs` : "";
      record(`[C-194] ${key}: frames`, frames.length === expected, `${frames.length} decoded, expectedFrames ${expected} (round ${results.renders[key].round}, ceil ${results.renders[key].ceil})${timing}`);
    } catch (err) {
      record(`render ${key}`, false, String(err?.message ?? err));
    }
  }

  // ── [C-193] frame k at k / fps; and which key's easing shapes a segment ─
  for (const [key, frames] of Object.entries(decoded)) {
    const fps = Number(key.split("@")[1]);
    const into = offsets(frames, ROWS.indexOf("cubic-into-key"));
    const onFirst = offsets(frames, ROWS.indexOf("cubic-on-first-key"));
    const at = (k, shift) => TRAVEL * outExpo((k + shift) / fps);
    const err = (series, shift) => Math.max(...series.map((v, k) => (Number.isNaN(v) ? 0 : Math.abs(v - at(k, shift)))));
    const linearErr = Math.max(...onFirst.map((v, k) => (Number.isNaN(v) ? 0 : Math.abs(v - TRAVEL * Math.min(1, k / fps)))));
    results.measured[key] = { "cubic-into-key": into, "cubic-on-first-key": onFirst };
    results.verdicts[`C-193 ${key}`] = { maxErrorAtKOverFps: err(into, 0), maxErrorAtCentreSampling: err(into, 0.5), easingOnFirstKey: { maxErrorAsCurve: err(onFirst, 0), maxErrorAsLinear: linearErr } };
    record(`[C-193] ${key}: frame k at k/fps`, err(into, 0) <= 1.5, `max error ${err(into, 0).toFixed(2)} px at k/fps, ${err(into, 0.5).toFixed(2)} px at (k + 0.5)/fps`);
  }

  // ── [C-189] HOLD, [C-191] before the first key, [C-190] named easings ────
  // MP4@30 when it rendered; else the first render that did, read at its own fps
  // (the 2026-10-13 rerun fell back to 24 fps and judged frames 13-14, past t = 0.5, as "neither").
  const mainKey = decoded["MP4@30"] ? "MP4@30" : Object.keys(decoded)[0];
  const main = mainKey ? decoded[mainKey] : undefined;
  if (main) {
    const mainFps = Number(mainKey.split("@")[1]);
    const half = Math.round(0.5 * mainFps); // the frame at t = 0.5, where the HOLD rows' end key and the late first key sit
    results.measured.from = mainKey;
    const firstJump = (band) => offsets(main, ROWS.indexOf(band)).findIndex((v) => v >= TRAVEL / 2);
    results.measured.hold = { endKey: offsets(main, ROWS.indexOf("hold-on-end-key")), startKey: offsets(main, ROWS.indexOf("hold-on-start-key")) };
    results.verdicts["C-189"] = {
      from: mainKey,
      "HOLD on the end key: first frame at the new value": firstJump("hold-on-end-key"),
      "HOLD on the start key: first frame at the new value": firstJump("hold-on-start-key"),
      reading: `frame ${half} (t = 0.5) means the value is kept until the key; frame 1 means it jumps at once`,
    };
    record("[C-189] HOLD", true, short(results.verdicts["C-189"]));
    // Frames before t = 0.5, the first key's time.
    const before = offsets(main, ROWS.indexOf("before-first-key")).slice(0, Math.ceil(0.5 * mainFps));
    results.measured.beforeFirstKey = before;
    results.verdicts["C-191"] = before.every((v) => Math.abs(v - 100) <= 1) ? "the first key's value is held before it" : before.every((v) => Math.abs(v) <= 1) ? "the base value shows before the first key" : `neither: ${short(before)}`;
    record("[C-191] before the first key", true, results.verdicts["C-191"]);
    const widths = main.map((f) => blobs(f, ROWS.indexOf("width-keyed"))[0]?.width ?? NaN);
    results.measured.widthKeyed = widths.map((w) => Math.round(w * 100) / 100);
    results.verdicts["C-192 render"] = `rendered width ${widths[0]?.toFixed(1)} px on frame 0 and ${widths.at(-1)?.toFixed(1)} px on the last (keys 60 → 120, base 20)`;
    const kids = (band) => main.map((f) => blobs(f, ROWS.indexOf(band)).map((b) => Math.round(b.centre * 10) / 10));
    results.measured.autoLayout = { translate: [kids("al-translate")[0], kids("al-translate").at(-1)], spacing: [kids("al-spacing")[0], kids("al-spacing").at(-1)] };
    results.verdicts["C-192 auto-layout"] = results.measured.autoLayout;
    record("[C-192] auto-layout child and hugging row", true, short(results.measured.autoLayout));
  }
  const fine = decoded["MP4@60"];
  if (fine) {
    results.measured.named = Object.fromEntries(NAMED.map((n) => [n, offsets(fine, ROWS.indexOf(`named-${n}`)).map((v) => Math.round((v / TRAVEL) * 10000) / 10000)]));
    results.verdicts["C-190"] = "progress per frame at 60 fps for each named easing, in measured.named: fit control points from these before replacing the stand-ins";
    record("[C-190] named easings sampled at 60 fps", true, `${NAMED.length} curves × ${fine.length} frames`);
  }
} catch (err) {
  record("probe", false, String(err?.message ?? err));
} finally {
  if (frameId && !KEEP) {
    const d = await mcp.call("figma_delete_nodes", { nodeIds: [frameId] });
    record("delete the probe frame", d.ok, d.ok ? frameId : short(d.text));
  } else if (frameId) {
    console.log(`  KEEP=1: left ${frameId} in the file`);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(`\n  results: ${path.relative(process.cwd(), OUT)}`);
  await mcp.close();
}
process.exit(results.steps.some((s) => !s.ok) ? 1 : 0);
