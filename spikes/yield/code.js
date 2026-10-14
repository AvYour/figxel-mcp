// Phase 0 spike 1 — the yield primitive (spec §14.1, claims C-012 / C-013).
//
// Plain ES2017, no build step: import spikes/yield/manifest.json into Figma
// desktop and run it on a scratch file. It touches only one frame it creates
// itself, named "yield-spike (safe to delete)".
//
// What it measures, per option:
//   A  setTimeout(0)                 — only if the sandbox has setTimeout
//   B  ping-pong through the iframe  — the plan's default; that it yields is undocumented
//   C  await Promise.resolve()       — the microtask hypothesis expected to fail
//   none                             — no yield at all (the overhead baseline)
// Objective responsiveness metric: the iframe sends a "probe" every 20 ms;
// the sandbox records how late each probe is handled. The sandbox runs on
// Figma's main thread, so the worst probe latency is how long that thread
// stayed blocked. A real yield keeps it near the 12 ms budget; no yield makes
// it ≈ the whole run.

var N = 5000;
var BUDGET_MS = 12;
var FRAME_NAME = "yield-spike (safe to delete)";

figma.showUI(__html__, { width: 440, height: 640, title: "figma-mcp yield spike" });

var env = {
  apiVersion: figma.apiVersion,
  editorType: figma.editorType,
  typeofSetTimeout: typeof setTimeout,
  typeofSetInterval: typeof setInterval,
  typeofQueueMicrotask: typeof queueMicrotask,
  typeofFetch: typeof fetch,
  setTimeoutFires: null,
  setTimeoutDelayMs: null,
  setTimeoutError: null,
};

function post(msg) {
  figma.ui.postMessage(msg);
}

if (typeof setTimeout === "function") {
  var t0 = Date.now();
  try {
    setTimeout(function () {
      env.setTimeoutFires = true;
      env.setTimeoutDelayMs = Date.now() - t0;
      post({ kind: "env", env: env });
    }, 10);
  } catch (e) {
    env.setTimeoutFires = false;
    env.setTimeoutError = String(e && e.message ? e.message : e);
  }
}

// ── option B: yield through the iframe ────────────────────────────────────
var nextTick = 1;
var pendingTicks = {};
function uiYield() {
  return new Promise(function (resolve) {
    var id = nextTick++;
    pendingTicks[id] = resolve;
    post({ kind: "tick-request", id: id });
  });
}

function yieldFor(option) {
  if (option === "A") {
    if (typeof setTimeout !== "function") return null;
    return function () {
      return new Promise(function (r) {
        setTimeout(r, 0);
      });
    };
  }
  if (option === "B") return uiYield;
  if (option === "C") return function () {
    return Promise.resolve();
  };
  return "none";
}

// ── run state ─────────────────────────────────────────────────────────────
var current = null;

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function findFrame() {
  for (var i = 0; i < figma.currentPage.children.length; i++) {
    var n = figma.currentPage.children[i];
    if (n.type === "FRAME" && n.name === FRAME_NAME) return n;
  }
  return null;
}

async function setup() {
  var frame = await findFrame();
  if (frame && frame.children.length === N) return post({ kind: "setup-done", nodes: N, reused: true });
  if (frame) frame.remove();
  frame = figma.createFrame();
  frame.name = FRAME_NAME;
  frame.resize(100 * 10, Math.ceil(N / 100) * 10);
  frame.x = figma.viewport.center.x;
  frame.y = figma.viewport.center.y;
  var slice = Date.now();
  for (var i = 0; i < N; i++) {
    var r = figma.createRectangle();
    r.resize(8, 8);
    r.x = (i % 100) * 10;
    r.y = Math.floor(i / 100) * 10;
    frame.appendChild(r);
    if (Date.now() - slice >= BUDGET_MS) {
      post({ kind: "setup-progress", done: i + 1, total: N });
      await uiYield();
      slice = Date.now();
    }
  }
  figma.commitUndo();
  figma.viewport.scrollAndZoomIntoView([frame]);
  post({ kind: "setup-done", nodes: N, reused: false });
}

async function run(option, passes) {
  var frame = await findFrame();
  if (!frame) return post({ kind: "error", message: "Run Setup first." });
  var fn = yieldFor(option);
  if (fn === null) {
    return post({ kind: "result", result: { option: option, available: false, note: "setTimeout is not a function in this sandbox" } });
  }
  var nodes = frame.children.slice();
  current = { option: option, probes: [], cancelRequestedAt: null };
  post({ kind: "running", option: option });

  var t0 = Date.now();
  var slice = t0;
  var yields = 0;
  var maxSliceMs = 0;
  var done = 0;
  var cancelled = false;
  outer: for (var pass = 0; pass < passes; pass++) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      node.rotation = (pass + 1) % 2 === 0 ? 0 : 45;
      done++;
      if (fn !== "none" && Date.now() - slice >= BUDGET_MS) {
        var s = Date.now() - slice;
        if (s > maxSliceMs) maxSliceMs = s;
        await fn();
        yields++;
        if (current.cancelRequestedAt !== null) {
          cancelled = true;
          break outer;
        }
        slice = Date.now();
      }
    }
  }
  var total = Date.now() - t0;
  figma.commitUndo();
  var probes = current.probes.slice().sort(function (a, b) {
    return a - b;
  });
  var result = {
    option: option,
    available: true,
    nodes: nodes.length,
    passes: passes,
    modifications: done,
    totalMs: total,
    perModificationUs: Math.round((total / Math.max(1, done)) * 1000 * 10) / 10,
    yields: yields,
    maxSliceMs: fn === "none" ? total : maxSliceMs,
    probesHandledDuringRun: probes.length,
    // No probe got through during a run long enough to have sent several: the
    // main thread never handed control back. The expected outcome for C and none.
    blockedEntireRun: probes.length === 0 && total > 100,
    probeLatencyMaxMs: probes.length ? probes[probes.length - 1] : null,
    probeLatencyP95Ms: percentile(probes, 95),
    cancelled: cancelled,
    cancelLatencyMs: cancelled ? Date.now() - current.cancelRequestedAt : null,
  };
  current = null;
  post({ kind: "result", result: result });
}

figma.ui.onmessage = function (m) {
  if (m.kind === "tick") {
    var resolve = pendingTicks[m.id];
    if (resolve) {
      delete pendingTicks[m.id];
      resolve();
    }
  } else if (m.kind === "probe") {
    if (current) current.probes.push(Date.now() - m.sentAt);
  } else if (m.kind === "cancel") {
    if (current && current.cancelRequestedAt === null) current.cancelRequestedAt = Date.now();
  } else if (m.kind === "setup") {
    setup().catch(function (e) {
      post({ kind: "error", message: String(e && e.message ? e.message : e) });
    });
  } else if (m.kind === "run") {
    run(m.option, m.passes).catch(function (e) {
      post({ kind: "error", message: String(e && e.message ? e.message : e) });
    });
  } else if (m.kind === "cleanup") {
    findFrame().then(function (f) {
      if (f) f.remove();
      figma.commitUndo();
      post({ kind: "cleaned" });
    });
  }
};

post({ kind: "env", env: env });
