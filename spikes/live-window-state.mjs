// Does Figma desktop's video export slow down or stall depending on the state
// of the Figma window? Today one fact is measured: a render stalled for about
// 40 minutes while the window was minimized and finished once it was restored
// [C-198]. Which window states stall a render, and which only slow it, is not
// measured. This run measures it, so Figxel can tell users the truth.
//
// A person drives it. For each window state the script prints what to do with
// the Figma window, waits for Enter, then renders one small test animation:
//
//   figma_export_video { nodeId, format: "MP4", fps: 30, jobId: <unique>, wait: 0 }
//
// and polls that job by jobId every 2 s for up to 300 s (job mode [C-249]).
// Per render it records when the render started, when the plugin's first
// progress phase arrived ("rendering MP4", then "encoding" once Figma's
// exportAsync returned), the render time the server measured, and the outcome:
// done, TIMEOUT (Figma gave up, about 240 s in [C-198]), stalled (still
// rendering at the limit), busy, or the error text.
//
// The states, in order (each repeated --runs times, default 2):
//   baseline   Figma visible and focused (5 s after Enter to click Figma)
//   behind     Figma restored but fully covered by another window
//   corner     a small Figma window in a screen corner, not covered
//   monitor    Figma on another monitor, visible (skippable)
//   vdesktop   Figma on another Windows virtual desktop (skippable)
//   minimized  Figma minimized
//   min-flags  minimized, Figma restarted with Chromium background flags (skippable)
// After a minimized run the person restores the window; a render still going
// is then followed until it ends (or --settle runs out), and how long it took
// after the restore is recorded. A render that stalls in any state is handled
// the same way, so the next render never meets a busy plugin.
//
// The test frame: one 540 x 960 frame, 3 s at 30 fps (91 frames [C-194]),
// four layers with translation and opacity keyframes, built by
// figma_create_from_spec + figma_set_keyframes at an empty spot right of
// everything on the current page. It is the only node the script creates and
// it is deleted at the end unless --keep; --frame <id> reuses an animated
// top-level frame instead (and deletes nothing).
//
// Needs: npm run build; a Figma Design file open in Figma desktop with the
// Figxel plugin running (Plugins > Development > Figxel); Motion on the
// account. It runs as a proxy of the hub the MCP client started, or as the hub
// itself when none runs (mcp-client.mjs spawns node dist/server.js), with
// BRIDGE_ALLOW_EVAL for the one figma_eval that finds the empty spot.
//
// The record, spikes/results/live-window-state.json, keeps the environment
// (OS, Figma desktop version as found on disk or in the process list, plugin
// and server versions), every run's numbers and a per-state summary (median
// render time against the baseline, stalls). It keeps no file name, user,
// session id or local path: error text has the home directory replaced by ~,
// and a video is named by its file name only. It is written only once a
// render was attempted, so a run that cannot start keeps the last record.
//
//   node spikes/live-window-state.mjs --help
//   node spikes/live-window-state.mjs --dry-run
//   node spikes/live-window-state.mjs [--runs 2] [--states baseline,minimized] [--keep]
//
// Exit 0: the sequence ran (stalls are data, not failures). 1: a crash (the
// error is printed). 2: the run could not start. 130: interrupted (Ctrl+C).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const OUT = path.join(HERE, "results", "live-window-state.json");

const FRAME = { width: 540, height: 960, durationS: 3, fps: 30 };
const EXPECTED_FRAMES = Math.ceil(FRAME.durationS * FRAME.fps) + 1; // the end frame renders too [C-194]
const FRAME_NAME = "Figxel window-state probe (delete me)";
const POLL_MS = 2_000;
const CALL_TIMEOUT_MS = 60_000;
const SESSION_WAIT_MS = 10 * 60_000;
const FOCUS_DELAY_S = 5;
/** A state's median render time within this ratio of the baseline's reads as "like the baseline". */
const LIKE_BASELINE = { below: 0.8, above: 1.25 };
const FLAGS = ["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling"];

const USAGE = `Usage: node spikes/live-window-state.mjs [options]

Measures whether Figma desktop's video export slows down or stalls with the
Figma window's state (visible, covered, small, another monitor, another
virtual desktop, minimized, minimized with Chromium flags). A person follows
the printed steps and presses Enter before each render. Figma must be open on a
Design file with the Figxel plugin running; run npm run build first.

Options:
  --runs <n>            renders per state (default 2, 1-10)
  --states <a,b,...>    only these states, in the usual order; ids: baseline,
                        behind, corner, monitor, vdesktop, minimized, min-flags
  --frame <id>          reuse this animated top-level frame instead of building
                        one (nothing is created or deleted)
  --keep                leave the test frame in the file at the end
  --file <name>         the connected Figma file to use when several are open
  --timeout <s>         how long one render is followed (default 300, 30-1800)
  --settle <s>          how long a stalled render is followed after the window
                        is restored (default 600, 30-3600)
  --no-warmup           skip the uncounted warm-up render before the states
  --figma-version <v>   record this Figma desktop version instead of the one
                        found on disk or in the process list
  --dry-run             print the plan and exit; nothing is sent to Figma
  -h, --help            this text

At every prompt: Enter renders, s skips (where allowed), q stops the run
(what was measured is saved and the test frame is deleted).

Result: spikes/results/live-window-state.json
Exit: 0 the sequence ran, 1 crash, 2 could not start, 130 interrupted.`;

// ── the window states ─────────────────────────────────────────────────────────

const IS_MAC = process.platform === "darwin";
const LOCALAPPDATA = process.env.LOCALAPPDATA ?? "%LOCALAPPDATA%";
const FIGMA_EXE = IS_MAC ? "/Applications/Figma.app" : path.win32.join(LOCALAPPDATA, "Figma", "Figma.exe");

const STATES = [
  {
    id: "baseline",
    label: "Figma visible and focused",
    focusDelayS: FOCUS_DELAY_S,
    setup: [
      "Make the Figma window large and fully visible: not minimized, nothing over it.",
      `After you press Enter you have ${FOCUS_DELAY_S} s to click Figma's title bar or tab bar (not the canvas), so Figma has focus while it renders.`,
      "Keep Figma in front until the terminal bell rings (or about a minute has passed), then come back here.",
    ],
    again: `Same state: Figma visible; after Enter click its title bar within ${FOCUS_DELAY_S} s and keep it in front until the bell.`,
    restore: "Make sure the Figma window is visible and not minimized.",
  },
  {
    id: "behind",
    label: "Behind another window, fully covered",
    setup: [
      "Put the Figma window BEHIND another window that covers it fully: for example, maximize this terminal over it.",
      "Figma stays restored (not minimized). Do not bring it to the front until the result line appears here.",
    ],
    again: "Same state: Figma still fully covered by another window, not minimized.",
    restore: "Bring the Figma window to the front again.",
  },
  {
    id: "corner",
    label: "Small window in a corner, not covered",
    setup: [
      "Un-maximize Figma and make it a small window, about a quarter of the screen, in a corner.",
      "Nothing may cover it: put this terminal beside it, not over it. Focus stays on this terminal.",
    ],
    again: "Same state: Figma small in a corner, nothing covering it.",
    restore: "Give the Figma window its usual size again.",
  },
  {
    id: "monitor",
    label: "On another monitor, visible",
    skippable: true,
    setup: [
      "Move the Figma window entirely onto your OTHER monitor, visible there: not covered, not minimized.",
      "Keep this terminal on this monitor. With one monitor, type s to skip this state.",
    ],
    again: "Same state: Figma visible on the other monitor.",
    restore: "Move the Figma window back to your main monitor.",
  },
  {
    id: "vdesktop",
    label: "On another virtual desktop",
    skippable: true,
    setup: IS_MAC
      ? [
          "Move the Figma window to another Space (Mission Control: drag it onto a new Space at the top).",
          "Stay on THIS Space with the terminal. Type s to skip this state.",
        ]
      : [
          "Press Win+Tab and choose New desktop. In Task View, right-click the Figma window's preview and choose Move to > Desktop 2 (or drag it onto the new desktop).",
          "Stay on THIS desktop with the terminal. Type s to skip this state.",
        ],
    again: "Same state: Figma still on the other virtual desktop, the terminal on this one.",
    restore: IS_MAC ? "Move the Figma window back to this Space." : "Move the Figma window back to this desktop (Win+Tab, then drag it onto this desktop).",
  },
  {
    id: "minimized",
    label: "Minimized",
    minimized: true,
    setup: [`Minimize the Figma window (its minimize button, or ${IS_MAC ? "Cmd+M" : "Win+Down"}). Leave it minimized until the script asks you to restore it.`],
    again: "Minimize the Figma window again.",
    restore: `Restore the Figma window (click its ${IS_MAC ? "Dock icon" : "taskbar button"}).`,
  },
  {
    id: "min-flags",
    label: "Minimized, Figma started with Chromium background flags",
    minimized: true,
    skippable: true,
    restart: true,
    intro: [
      "This state restarts Figma with three Chromium switches that keep a hidden window from being slowed down:",
      `  ${FLAGS.join(" ")}`,
      "Whether Figma desktop honours them is not known; the script checks that they reach a running Figma process.",
      "",
      "1. Quit Figma FULLY. The flags only take effect when Figma starts fresh.",
      IS_MAC
        ? "   Press Cmd+Q in Figma, then check Activity Monitor that no Figma process is left."
        : "   Close every Figma window, quit it from its system tray icon if it has one, and check Task Manager that no Figma.exe is left.",
      "2. Start Figma with the flags:",
      ...(IS_MAC
        ? [`   in Terminal:  open -a Figma --args ${FLAGS.join(" ")}`]
        : [
            `   from PowerShell:  & "${FIGMA_EXE}" ${FLAGS.join(" ")}`,
            "   or with a shortcut: right-click the desktop > New > Shortcut, and paste this as the location:",
            `     "${FIGMA_EXE}" ${FLAGS.join(" ")}`,
            "   (to change an existing Figma shortcut instead: right-click it > Properties > Target, and add the three",
            "   flags after the closing quote; a copy of the shortcut keeps the original intact)",
          ]),
      "3. Open the same file again and run the Figxel plugin in it (Plugins > Development > Figxel).",
    ],
    setup: [`Minimize the Figma window (its minimize button, or ${IS_MAC ? "Cmd+M" : "Win+Down"}). Leave it minimized until the script asks you to restore it.`],
    again: "Minimize the Figma window again.",
    restore: `Restore the Figma window (click its ${IS_MAC ? "Dock icon" : "taskbar button"}).`,
    after: "You can quit Figma and start it the usual way again, without the flags.",
  },
];

// ── the test frame ───────────────────────────────────────────────────────────

function frameSpec(x, y) {
  return {
    type: "frame",
    name: FRAME_NAME,
    x,
    y,
    width: FRAME.width,
    height: FRAME.height,
    background: "#111827",
    clipsContent: true,
    children: [
      { type: "text", ref: "title", name: "Title", content: "Window state probe", x: 48, y: 64, fontSize: 36, weight: "Bold", color: "#f9fafb" },
      { type: "rectangle", ref: "block", name: "Block", x: 48, y: 200, width: 160, height: 160, cornerRadius: 24, fill: "#3b82f6" },
      { type: "ellipse", ref: "dot", name: "Dot", x: 330, y: 520, width: 140, height: 140, fill: "#f59e0b" },
      { type: "rectangle", ref: "bar", name: "Bar", x: 48, y: 840, width: 444, height: 24, cornerRadius: 12, fill: "#10b981" },
    ],
  };
}

/** Keyframes per spec ref: every layer moves or fades, the last key at FRAME.durationS. */
const KEYS = {
  title: [
    { field: "OPACITY", keyframes: [{ t: 0, value: "0" }, { t: 0.6, value: "1", easing: "EASE_OUT" }] },
    { field: "TRANSLATION_Y", keyframes: [{ t: 0, value: "24" }, { t: 0.6, value: "0", easing: "EASE_OUT" }] },
  ],
  block: [
    { field: "TRANSLATION_X", keyframes: [{ t: 0, value: "0" }, { t: 3, value: "284", easing: "EASE_IN_AND_OUT" }] },
    { field: "OPACITY", keyframes: [{ t: 0, value: "0.4" }, { t: 1, value: "1", easing: "LINEAR" }] },
  ],
  dot: [{ field: "TRANSLATION_Y", keyframes: [{ t: 0, value: "0" }, { t: 1.5, value: "-280", easing: "EASE_OUT" }, { t: 3, value: "0", easing: "EASE_IN" }] }],
  bar: [
    { field: "OPACITY", keyframes: [{ t: 0, value: "0" }, { t: 1, value: "1", easing: "EASE_OUT" }] },
    { field: "TRANSLATION_X", keyframes: [{ t: 0, value: "-48" }, { t: 1, value: "0", easing: "EASE_OUT" }] },
  ],
};

// ── arguments ────────────────────────────────────────────────────────────────

class StartError extends Error {}

function parse() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        "dry-run": { type: "boolean" },
        runs: { type: "string" },
        states: { type: "string" },
        frame: { type: "string" },
        keep: { type: "boolean" },
        file: { type: "string" },
        timeout: { type: "string" },
        settle: { type: "string" },
        "no-warmup": { type: "boolean" },
        "figma-version": { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const int = (name, def, min, max) => {
    if (values[name] === undefined) return def;
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n < min || n > max) {
      console.error(`--${name} takes a whole number from ${min} to ${max} (got "${values[name]}").\n\n${USAGE}`);
      process.exit(2);
    }
    return n;
  };
  let states = STATES;
  if (values.states !== undefined) {
    const asked = values.states.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = asked.filter((id) => !STATES.some((s) => s.id === id));
    if (!asked.length || unknown.length) {
      console.error(`--states: unknown ${unknown.length ? unknown.join(", ") : "(empty list)"}; the ids are ${STATES.map((s) => s.id).join(", ")}.`);
      process.exit(2);
    }
    states = STATES.filter((s) => asked.includes(s.id));
  }
  return {
    dryRun: values["dry-run"] === true,
    runs: int("runs", 2, 1, 10),
    timeoutS: int("timeout", 300, 30, 1800),
    settleS: int("settle", 600, 30, 3600),
    warmup: values["no-warmup"] !== true,
    keep: values.keep === true,
    frame: values.frame ?? null,
    file: values.file ?? null,
    figmaVersion: values["figma-version"] ?? null,
    states,
  };
}

const opts = parse();

// ── the dry run ──────────────────────────────────────────────────────────────

function printPlan() {
  const renders = (opts.warmup ? 1 : 0) + opts.states.length * opts.runs;
  const out = [];
  out.push("Plan (dry run: nothing is sent to Figma)", "");
  out.push(
    opts.frame
      ? `Test frame: reuse ${opts.frame} (must be an animated top-level frame); nothing is created or deleted.`
      : `Test frame: build "${FRAME_NAME}", ${FRAME.width} x ${FRAME.height}, at an empty spot right of the page's content: ` +
          `${Object.keys(KEYS).length} layers (${Object.keys(KEYS).join(", ")}) with translation and opacity keys, ` +
          `${FRAME.durationS} s at ${FRAME.fps} fps (${EXPECTED_FRAMES} frames).`,
  );
  out.push(
    `Each render: figma_export_video { nodeId, format: "MP4", fps: ${FRAME.fps}, jobId: <unique>, wait: 0 }, ` +
      `polled by jobId every ${POLL_MS / 1000} s for up to ${opts.timeoutS} s. A render still going after a restore ` +
      `is followed for up to ${opts.settleS} s more.`,
  );
  out.push(opts.warmup ? "Warm-up: one render with Figma visible, not counted." : "Warm-up: skipped (--no-warmup).");
  out.push("", `States, ${opts.runs} run(s) each:`);
  opts.states.forEach((s, i) => {
    out.push(`  ${i + 1}. ${s.id}: ${s.label}${s.skippable ? " (skippable)" : ""}`);
    for (const line of s.intro ?? []) out.push(`       ${line}`);
    for (const line of s.setup) out.push(`       - ${line}`);
    if (s.minimized) out.push(`       After each render: ${s.restore}`);
    else out.push(`       If a render stalls, or when the state ends: ${s.restore}`);
    if (s.after) out.push(`       When the state ends: ${s.after}`);
  });
  out.push("");
  out.push(
    opts.frame
      ? "Cleanup: none (the frame was not made by this run)."
      : opts.keep
        ? "Cleanup: none, --keep leaves the test frame in the file."
        : "Cleanup: delete the test frame, the only node this run creates.",
  );
  out.push(`Record: ${path.relative(process.cwd(), OUT) || OUT}`);
  out.push(`Renders: ${renders}; each takes at most ${opts.timeoutS} s here, plus your setup time between them.`);
  console.log(out.join("\n"));
}

if (opts.dryRun) {
  printPlan();
  process.exit(0);
}

// ── helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const firstLine = (text) => String(text ?? "").split("\n")[0].slice(0, 200);
const HOME = os.homedir();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HOME_RE = HOME ? new RegExp(escapeRe(HOME), "gi") : null;
const HOME_RE_FWD = HOME ? new RegExp(escapeRe(HOME.replaceAll("\\", "/")), "gi") : null;
const REPO_RE = new RegExp(escapeRe(REPO), "gi");

/** Local paths out of anything written to the record. */
function scrub(text) {
  let s = String(text ?? "");
  s = s.replace(REPO_RE, "<repo>");
  if (HOME_RE) s = s.replace(HOME_RE, "~");
  if (HOME_RE_FWD) s = s.replace(HOME_RE_FWD, "~");
  return s;
}

function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return r1(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

const compareVersions = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/**
 * The running Figma processes: executable path and command line, from the
 * process list. null when the list cannot be read. Read here, never recorded:
 * only a count, a version and which flags appear go into the record.
 */
function figmaProcesses() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Figma.exe' } | Select-Object ExecutablePath, CommandLine | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", windowsHide: true, timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (!out) return [];
      const parsed = JSON.parse(out);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ exe: p.ExecutablePath ?? "", cmd: p.CommandLine ?? "" }));
    }
    const out = execFileSync("ps", ["-axo", "command"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
    return out
      .split("\n")
      .filter((l) => l.includes("Figma.app/"))
      .map((l) => ({ exe: l.split(" --")[0], cmd: l }));
  } catch {
    return null;
  }
}

/** Which of FLAGS appear on any running Figma process; null when the list cannot be read. */
function flagsOn(procs) {
  if (!procs) return null;
  return Object.fromEntries(FLAGS.map((f) => [f, procs.some((p) => p.cmd.includes(f))]));
}

/** Figma desktop's version: --figma-version, else the running app's folder, else the newest install, else Info.plist. */
function figmaDesktop() {
  const procs = figmaProcesses();
  let version = null;
  let from = null;
  for (const p of procs ?? []) {
    const m = /[\\/]app-(\d+(?:\.\d+)+)[\\/]/i.exec(p.exe);
    if (m) {
      version = m[1];
      from = "running process path";
      break;
    }
  }
  if (!version && process.platform === "win32" && process.env.LOCALAPPDATA) {
    try {
      const found = fs
        .readdirSync(path.join(process.env.LOCALAPPDATA, "Figma"))
        .map((d) => /^app-(\d+(?:\.\d+)+)$/.exec(d)?.[1])
        .filter(Boolean)
        .sort(compareVersions);
      if (found.length) {
        version = found.at(-1);
        from = "newest install folder";
      }
    } catch {
      // not installed per user, or elsewhere
    }
  }
  if (!version && IS_MAC) {
    try {
      const plist = fs.readFileSync("/Applications/Figma.app/Contents/Info.plist", "utf8");
      const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
      if (m) {
        version = m[1];
        from = "Info.plist";
      }
    } catch {
      // not in /Applications
    }
  }
  if (opts.figmaVersion) {
    version = opts.figmaVersion;
    from = "--figma-version";
  }
  return { version, versionFrom: from, processes: procs ? procs.length : null, flags: flagsOn(procs), procs };
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

// ── state of the run ─────────────────────────────────────────────────────────

const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[^0-9]/g, "").slice(0, 14);
const result = {
  spike: "live-window-state",
  question: "Does Figma desktop's video export slow down or stall with the Figma window's state? [C-198]",
  startedAt,
  finishedAt: null,
  complete: false,
  stoppedEarly: false,
  interrupted: false,
  settings: {
    runs: opts.runs,
    states: opts.states.map((s) => s.id),
    render: { format: "MP4", fps: FRAME.fps, wait: 0 },
    pollS: POLL_MS / 1000,
    timeoutS: opts.timeoutS,
    settleS: opts.settleS,
    warmup: opts.warmup,
    focusDelayS: FOCUS_DELAY_S,
    likeBaseline: LIKE_BASELINE,
  },
  environment: null,
  frame: null,
  warmup: null,
  runs: [],
  skipped: [],
  stateChecks: {},
  summary: null,
  cleanup: null,
  crash: null,
};

let mcp = null;
let rl = null;
let stdinClosed = false;
let stdinGone = null; // resolves "q" once stdin closes
let session = null;
let fileName = null;
let nodeId = opts.frame;
const createdIds = []; // top-level ids our own calls returned: deleted at the end unless --keep
let attempted = false; // a render was started: only then is the record written
let videoDir = null; // console only, never recorded

function save() {
  if (!attempted) return;
  result.finishedAt = new Date().toISOString();
  result.summary = summarize();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + "\n");
}

// ── prompts ──────────────────────────────────────────────────────────────────

/** One line from the person, lower-cased; "q" when stdin is gone. */
async function ask(prompt) {
  if (stdinClosed) return "q";
  try {
    return await Promise.race([rl.question(prompt).then((a) => a.trim().toLowerCase()), stdinGone]);
  } catch {
    return "q";
  }
}

/** Ask until the answer is Enter, q, or (when allowed) s. */
async function choose(prompt, allowSkip) {
  for (;;) {
    const a = await ask(prompt);
    if (a === "" || a === "q") return a;
    if (a === "s" && allowSkip) return a;
    console.log(allowSkip ? "  Press Enter, or type s or q." : "  Press Enter, or type q to stop (this one cannot be skipped).");
  }
}

async function countdown(seconds) {
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\r  Click Figma's title bar now: the render starts in ${i} s `);
    await sleep(1000);
  }
  process.stdout.write("\r" + " ".repeat(64) + "\r");
}

function heading(text) {
  console.log(`\n== ${text} ${"=".repeat(Math.max(0, 74 - text.length))}`);
}

// ── Figma ────────────────────────────────────────────────────────────────────

async function tool(name, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
  return mcp.call(name, { ...args, session: session.sessionId }, { timeoutMs });
}

async function evalJs(code) {
  const r = await tool("figma_eval", { code });
  if (!r.ok) throw new Error(`figma_eval failed: ${firstLine(r.text)}`);
  return r.data && typeof r.data === "object" && "value" in r.data ? r.data.value : r.data;
}

/** The connected session of the file this run uses; waits for it (after a restart, say). */
async function ensureSession() {
  const until = Date.now() + SESSION_WAIT_MS;
  let told = false;
  for (;;) {
    const st = await mcp.call("figma_status", {});
    const found = (st.data?.sessions ?? []).find((s) => s.editorType === "figma" && (s.file?.name ?? null) === fileName);
    if (found) {
      if (told) console.log(`  The Figxel plugin is connected in "${fileName ?? "untitled"}" again.`);
      session = found;
      return st;
    }
    if (!told) {
      console.log(`  Waiting for the Figxel plugin in "${fileName ?? "untitled"}": open the file and run Plugins > Development > Figxel ...`);
      told = true;
    }
    if (Date.now() > until) throw new Error(`The Figxel plugin did not connect in "${fileName ?? "untitled"}" within ${SESSION_WAIT_MS / 60_000} min.`);
    await sleep(2000);
  }
}

async function buildFrame() {
  const spot = await evalJs(`let right = 0, top = Infinity;
for (const n of figma.currentPage.children) { const b = n.absoluteBoundingBox; if (!b) continue; right = Math.max(right, b.x + b.width); top = Math.min(top, b.y); }
return { x: Math.round(right + 3000), y: Number.isFinite(top) ? Math.round(top) : 0 };`);
  const built = await tool("figma_create_from_spec", { spec: JSON.stringify(frameSpec(spot.x, spot.y)) }, 120_000);
  if (!built.ok || typeof built.data?.rootId !== "string") {
    throw new Error(`figma_create_from_spec failed: ${firstLine(built.text)}. If it stopped midway, press Ctrl+Z once in Figma to remove what it made.`);
  }
  createdIds.push(built.data.rootId);
  nodeId = built.data.rootId;
  const refs = built.data.refs ?? {};
  for (const [ref, tracks] of Object.entries(KEYS)) {
    if (typeof refs[ref] !== "string") throw new Error(`figma_create_from_spec returned no id for "${ref}".`);
    const k = await tool("figma_set_keyframes", { nodeId: refs[ref], tracks, timelineDuration: FRAME.durationS });
    if (!k.ok && /UNSUPPORTED/.test(k.text)) throw new StartError(`Motion is not available here, so nothing can be rendered: ${firstLine(k.text)}`);
    if (!k.ok) throw new Error(`figma_set_keyframes on "${ref}" failed: ${firstLine(k.text)}`);
  }
  result.frame = { nodeId, created: true, width: FRAME.width, height: FRAME.height, durationS: FRAME.durationS, fps: FRAME.fps, expectedFrames: EXPECTED_FRAMES, layers: Object.keys(KEYS) };
  console.log(`  Built the test frame ${nodeId} at x ${spot.x}, y ${spot.y}: ${FRAME.width} x ${FRAME.height}, ${FRAME.durationS} s at ${FRAME.fps} fps.`);
}

/** The test frame is still in the file (after a restart); rebuilt when this run made it. */
async function ensureFrame() {
  const type = await evalJs(`const n = await figma.getNodeByIdAsync(${JSON.stringify(nodeId)}); return n ? n.type : null;`);
  if (type) return;
  if (!createdIds.length) throw new Error(`Node ${nodeId} (--frame) is not in the file any more.`);
  console.log(`  The test frame ${nodeId} is not in the file any more: building it again.`);
  createdIds.length = 0;
  await buildFrame();
}

// ── one render ───────────────────────────────────────────────────────────────

function classify(text) {
  if (/^TIMEOUT\b/m.test(text) || /video export timed out/i.test(text)) return "TIMEOUT";
  if (/^STALLED\b/m.test(text)) return "stalled";
  if (/^BUSY\b/m.test(text)) return "busy";
  if (/^CANCELLED\b/m.test(text)) return "cancelled";
  return "error";
}

/** The fields of an answer that is no longer "rendering". */
function ending(r) {
  const d = r.data;
  if (r.ok && d?.status === "done") {
    if (d.path) videoDir = path.dirname(d.path);
    return {
      outcome: "done",
      renderS: typeof d.renderS === "number" ? d.renderS : null,
      frameCount: d.frameCount ?? null,
      expectedFrames: d.expectedFrames ?? null,
      durationS: d.durationS ?? null,
      video: d.path ? path.basename(d.path) : null,
      ...(d.note ? { note: scrub(d.note) } : {}),
    };
  }
  if (r.ok && d?.status === "cancelled") return { outcome: "cancelled" };
  const text = scrub(r.ok ? JSON.stringify(d ?? r.text) : r.text);
  const out = { outcome: r.ok ? "error" : classify(text), error: text.slice(0, 600) };
  const m = /\(([\d.]+) s after the render started\)/.exec(text);
  if (m) out.figmaGaveUpAfterS = Number(m[1]);
  return out;
}

/** Start one render and follow it by jobId until it ends or the limit passes. */
async function measure(stateId, run, attempt) {
  const jobId = `ws-${stamp}-${stateId}-${run}${attempt > 1 ? `-r${attempt}` : ""}`;
  const rec = { state: stateId, run, ...(attempt > 1 ? { attempt } : {}), jobId, startedAt: new Date().toISOString() };
  const phases = [];
  const t0 = Date.now();
  const since = () => r1((Date.now() - t0) / 1000);
  const seen = (d) => {
    if (d?.phase && phases.at(-1)?.phase !== d.phase) {
      phases.push({ phase: d.phase, atS: since(), ...(typeof d.elapsedS === "number" ? { serverElapsedS: d.elapsedS } : {}) });
    }
  };
  attempted = true;
  console.log(`  Rendering (job ${jobId}) ...`);
  let r = await tool("figma_export_video", { nodeId, format: "MP4", fps: FRAME.fps, jobId, wait: 0, saveTo: `${jobId}.mp4` });
  rec.startAnswerS = since();
  let polls = 0;
  let shownAt = Date.now();
  for (;;) {
    const d = r.data;
    if (r.ok && d?.status === "rendering") {
      seen(d);
      if (Date.now() - t0 >= opts.timeoutS * 1000) {
        rec.outcome = "stalled";
        break;
      }
      if (Date.now() - shownAt >= 30_000) {
        console.log(`    ... ${since()} s, ${phases.at(-1)?.phase ?? "no progress from the plugin yet"}`);
        shownAt = Date.now();
      }
      await sleep(POLL_MS);
      r = await mcp.call("figma_export_video", { jobId, wait: 0 }, { timeoutMs: CALL_TIMEOUT_MS });
      polls++;
      continue;
    }
    Object.assign(rec, ending(r));
    break;
  }
  rec.totalS = since();
  rec.polls = polls;
  rec.firstPhase = phases[0]?.phase ?? null;
  rec.firstPhaseS = phases[0]?.atS ?? null;
  rec.encodingAtS = phases.find((p) => p.phase === "encoding")?.atS ?? null;
  rec.phases = phases;
  process.stdout.write("\x07"); // the bell: the person may be looking at Figma
  console.log(`  ${describe(rec)}`);
  return { rec, t0 };
}

function describe(rec) {
  const bits = [];
  switch (rec.outcome) {
    case "done":
      bits.push(`done in ${rec.renderS ?? rec.totalS} s${rec.frameCount != null ? `, ${rec.frameCount} frames` : ""}`);
      break;
    case "TIMEOUT":
      bits.push(`TIMEOUT: Figma gave up${rec.figmaGaveUpAfterS ? ` ${rec.figmaGaveUpAfterS} s after the start` : ""}`);
      break;
    case "stalled":
      bits.push(rec.error ? `stalled: ${firstLine(rec.error)}` : `still rendering after ${rec.totalS} s`);
      break;
    default:
      bits.push(`${rec.outcome}: ${firstLine(rec.error)}`);
  }
  bits.push(rec.firstPhaseS != null ? `first progress at ${rec.firstPhaseS} s ("${rec.firstPhase}")` : "no progress update seen");
  if (rec.encodingAtS != null) bits.push(`encoding at ${rec.encodingAtS} s`);
  return bits.join("; ");
}

/**
 * The person restores the window; meanwhile the render is followed, so a
 * render that ends on the restore is timed from it. Followed for at most
 * --settle seconds after Enter, then cancelled (Figma still finishes it).
 */
async function settle(rec, t0, instruction) {
  let end = null;
  let restoredAt = null;
  const poller = (async () => {
    for (;;) {
      const r = await mcp.call("figma_export_video", { jobId: rec.jobId, wait: 0 }, { timeoutMs: CALL_TIMEOUT_MS });
      if (!(r.ok && r.data?.status === "rendering")) {
        end = { at: Date.now(), r };
        if (restoredAt === null) console.log(`\n  The render ended (${ending(r).outcome}) before you pressed Enter.`);
        return;
      }
      if (restoredAt !== null && Date.now() - restoredAt >= opts.settleS * 1000) return;
      await sleep(POLL_MS);
    }
  })();
  const answer = await ask(`  ${instruction} Then press Enter here: `);
  restoredAt = Date.now();
  if (!end) console.log(`  Following the render for up to ${opts.settleS} s more ...`);
  await poller;
  const after = { restoredAtS: r1((restoredAt - t0) / 1000) };
  if (end) {
    const e = ending(end.r);
    Object.assign(after, {
      outcome: e.outcome,
      endedAtS: r1((end.at - t0) / 1000),
      endedSinceRestoreS: r1((end.at - restoredAt) / 1000),
      ...(e.renderS != null ? { renderS: e.renderS } : {}),
      ...(e.frameCount != null ? { frameCount: e.frameCount } : {}),
      ...(e.error ? { error: e.error } : {}),
    });
    console.log(`  After the restore: ${e.outcome} at ${after.endedAtS} s (${after.endedSinceRestoreS} s after Enter).`);
  } else {
    after.outcome = "still rendering";
    const c = await mcp.call("figma_export_video", { jobId: rec.jobId, cancel: true }, { timeoutMs: CALL_TIMEOUT_MS });
    after.cancelled = c.ok;
    console.log(
      `  Still rendering ${opts.settleS} s after the restore; the job is dropped. Figma finishes a render it has begun, ` +
        "so the plugin may stay busy: the next render waits for it (you will be asked).",
    );
  }
  rec.afterRestore = after;
  return answer;
}

// ── a state ──────────────────────────────────────────────────────────────────

/**
 * One run of a state. `action` is "ok", "skip" (the rest of the state) or
 * "quit"; `restored` says the person undid the state after this run, so the
 * next run prints the whole setup again rather than "same state".
 */
async function runOnce(state, run, fullSetup) {
  console.log("");
  for (const line of fullSetup ? state.setup : [state.again]) console.log(`  ${line}`);
  const a = await choose(`  [${state.id} ${run}/${opts.runs}] Press Enter to render${state.skippable ? ", s to skip this state" : ""}, q to stop: `, !!state.skippable);
  if (a === "q") return { action: "quit" };
  if (a === "s") return { action: "skip" };
  for (let attempt = 1; ; attempt++) {
    await ensureSession();
    if (state.focusDelayS) await countdown(state.focusDelayS);
    const { rec, t0 } = await measure(state.id, run, attempt);
    result.runs.push(rec);
    save();
    if (rec.outcome === "busy") {
      const b = await choose(
        "  Figma is still busy with an earlier render, so nothing started. Wait for it to end (or close and re-run the Figxel plugin), then press Enter to retry, s to skip this run, q to stop: ",
        true,
      );
      if (b === "q") return { action: "quit" };
      if (b === "s") return { action: "ok", restored: false };
      continue;
    }
    let answer = "";
    let restored = false;
    if (rec.outcome === "stalled" && !rec.error) {
      console.log(`  Still rendering after ${opts.timeoutS} s.`);
      answer = await settle(rec, t0, state.restore);
      restored = true;
      save();
    } else if (state.minimized) {
      answer = await ask(`  ${state.restore} Then press Enter here: `);
      restored = true;
    }
    return { action: answer === "q" ? "quit" : "ok", restored };
  }
}

/** A state's restart step (min-flags): "ok", "skip" or "quit". */
async function restartStep(state) {
  console.log("");
  for (const line of state.intro) console.log(`  ${line}`);
  console.log(`  (the file: "${fileName ?? "untitled"}")`);
  const a = await choose("  Press Enter once Figma runs with the flags and the Figxel plugin runs in the file, s to skip this state, q to stop: ", true);
  if (a !== "") return a === "q" ? "quit" : "skip";
  await ensureSession();
  await ensureFrame();
  const procs = figmaProcesses();
  const flags = flagsOn(procs);
  result.stateChecks[state.id] = { figmaProcesses: procs ? procs.length : null, flagsOnRunningFigma: flags };
  save();
  if (flags && !FLAGS.every((f) => flags[f])) {
    const missing = FLAGS.filter((f) => !flags[f]);
    console.log(`  These flags do not appear on any running Figma process: ${missing.join(" ")}`);
    if (!IS_MAC) {
      const v = figmaDesktop().version;
      if (v) console.log(`  The launcher may not pass them on. Quit Figma fully and try the app itself:\n    & "${path.win32.join(LOCALAPPDATA, "Figma", `app-${v}`, "Figma.exe")}" ${FLAGS.join(" ")}`);
    }
    // Measured anyway, the record's stateChecks say which flags were seen.
    const b = await choose("  Press Enter to measure anyway (the record keeps which flags were seen), s to skip this state, q to stop: ", true);
    if (b !== "") return b === "q" ? "quit" : "skip";
  } else if (!flags) {
    console.log("  The process list could not be read, so the flags are not checked.");
  } else {
    console.log("  All three flags are on a running Figma process.");
  }
  return "ok";
}

// ── the summary ──────────────────────────────────────────────────────────────

function summarize() {
  const counted = (r) => r.outcome !== "busy";
  const baseline = median(result.runs.filter((r) => r.state === "baseline" && r.outcome === "done").map((r) => r.renderS ?? r.totalS));
  const states = {};
  for (const st of opts.states) {
    const rs = result.runs.filter((r) => r.state === st.id && counted(r));
    const skipped = result.skipped.find((s) => s.state === st.id);
    const done = rs.filter((r) => r.outcome === "done");
    const times = done.map((r) => r.renderS ?? r.totalS);
    const med = median(times);
    const ratio = med != null && baseline ? r2(med / baseline) : null;
    const n = (o) => rs.filter((r) => r.outcome === o).length;
    const s = {
      label: st.label,
      runs: rs.length,
      done: done.length,
      timeouts: n("TIMEOUT"),
      stalls: n("stalled"),
      errors: rs.length - done.length - n("TIMEOUT") - n("stalled"),
      busy: result.runs.filter((r) => r.state === st.id && r.outcome === "busy").length,
      medianRenderS: med,
      minRenderS: times.length ? r1(Math.min(...times)) : null,
      maxRenderS: times.length ? r1(Math.max(...times)) : null,
      medianFirstProgressS: median(rs.map((r) => r.firstPhaseS)),
      medianEncodingAtS: median(rs.map((r) => r.encodingAtS)),
      vsBaseline: st.id === "baseline" ? (med != null ? 1 : null) : ratio,
      afterRestore: rs
        .filter((r) => r.afterRestore && r.outcome === "stalled")
        .map((r) => ({ run: r.run, outcome: r.afterRestore.outcome, endedSinceRestoreS: r.afterRestore.endedSinceRestoreS ?? null })),
      ...(skipped ? { skipped: skipped.reason } : {}),
    };
    s.verdict = verdict(st, s, rs.length);
    states[st.id] = s;
  }
  return { baselineMedianRenderS: baseline, states };
}

function verdict(st, s, n) {
  if (!n) return s.skipped ?? "not measured";
  const parts = [];
  if (s.stalls) parts.push(`${s.stalls} of ${n} still rendering after ${opts.timeoutS} s`);
  if (s.timeouts) parts.push(`${s.timeouts} of ${n} ended by Figma's own time limit (TIMEOUT)`);
  if (s.errors) parts.push(`${s.errors} of ${n} failed with another error`);
  if (s.done) {
    const med = `median ${s.medianRenderS} s`;
    if (st.id === "baseline") parts.push(`${s.done} of ${n} finished, ${med}`);
    else if (s.vsBaseline == null) parts.push(`${s.done} of ${n} finished, ${med} (no baseline to compare)`);
    else if (s.vsBaseline > LIKE_BASELINE.above) parts.push(`${s.done} of ${n} finished, slower than the baseline (${med}, x${s.vsBaseline})`);
    else if (s.vsBaseline < LIKE_BASELINE.below) parts.push(`${s.done} of ${n} finished, faster than the baseline (${med}, x${s.vsBaseline})`);
    else parts.push(`${s.done} of ${n} finished like the baseline (${med}, x${s.vsBaseline})`);
  }
  for (const a of s.afterRestore) {
    parts.push(`run ${a.run} after the restore: ${a.outcome}${a.endedSinceRestoreS != null ? ` ${a.endedSinceRestoreS} s after it` : ""}`);
  }
  return parts.join("; ");
}

// ── the run ──────────────────────────────────────────────────────────────────

async function live() {
  if (!fs.existsSync(path.join(REPO, "dist", "server.js"))) throw new StartError("dist/server.js is missing: run npm run build first.");
  const { connect } = await import("./mcp-client.mjs");
  mcp = await connect({ allowEval: true });
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  stdinGone = new Promise((resolve) =>
    rl.once("close", () => {
      stdinClosed = true;
      resolve("q");
    }),
  );
  rl.on("SIGINT", () => void interrupt());

  const tools = new Map((await mcp.list()).map((t) => [t.name, t]));
  const needed = ["figma_status", "figma_export_video", "figma_eval", ...(opts.frame ? [] : ["figma_create_from_spec", "figma_set_keyframes", "figma_delete_nodes"])];
  const missing = needed.filter((t) => !tools.has(t));
  if (missing.length) throw new StartError(`The spawned server does not register ${missing.join(", ")}: run npm run build (figma_eval needs BRIDGE_ALLOW_EVAL, which this script sets).`);
  if (!tools.get("figma_export_video")?.inputSchema?.properties?.jobId) throw new StartError("figma_export_video has no `jobId`: dist/ predates job mode; run npm run build.");

  const st = await mcp.call("figma_status", {});
  if (!st.ok || !st.data) throw new StartError(`figma_status failed: ${firstLine(st.text)}`);
  const sessions = (st.data.sessions ?? []).filter((s) => s.editorType === "figma");
  session = opts.file ? sessions.find((s) => s.file?.name === opts.file) : sessions.find((s) => s.active) ?? sessions[0];
  if (!session) {
    throw new StartError(
      opts.file
        ? `No connected Figma Design file named "${opts.file}".`
        : "No Figma Design file is connected: open one in Figma desktop and run Plugins > Development > Figxel.",
    );
  }
  if (session.build?.restart === "client") throw new StartError("Restart the MCP client that holds the Figma connection: it runs an older build than dist/.");
  if (session.build?.restart === "plugin") throw new StartError(`Close the Figxel plugin window in "${session.file?.name}" and run it again: it runs an older build than dist/.`);
  fileName = session.file?.name ?? null;

  const fig = figmaDesktop();
  result.environment = {
    os: { platform: process.platform, release: os.release(), version: typeof os.version === "function" ? os.version() : null, arch: process.arch },
    node: process.version,
    figmaDesktop: { version: fig.version, versionFrom: fig.versionFrom, processes: fig.processes },
    figmaFlagsAtStart: fig.flags,
    plugin: { pluginVersion: session.pluginVersion ?? null, apiVersion: session.apiVersion ?? null, editorType: session.editorType },
    server: { version: st.data.bridge?.version ?? null, role: st.data.bridge?.role ?? null, package: packageVersion(), build: session.build ?? null },
  };
  console.log(
    `Figma desktop ${fig.version ?? "(version unknown)"}${fig.versionFrom ? ` (${fig.versionFrom})` : ""}, plugin API ${session.apiVersion ?? "?"}, ` +
      `server ${st.data.bridge?.version ?? "?"} as ${st.data.bridge?.role ?? "?"}, file "${fileName ?? "untitled"}".`,
  );
  if (fig.flags && FLAGS.some((f) => fig.flags[f])) {
    console.log("  Note: Figma already runs with some of the Chromium flags, so the baseline is not a usual start. Recorded as figmaFlagsAtStart.");
  }

  heading("Test frame");
  if (opts.frame) {
    const node = await evalJs(`const n = await figma.getNodeByIdAsync(${JSON.stringify(opts.frame)});
return n ? { type: n.type, top: !!n.parent && n.parent.type === "PAGE" } : null;`);
    if (!node) throw new StartError(`--frame ${opts.frame} is not in this file.`);
    result.frame = { nodeId: opts.frame, created: false, type: node.type, topLevel: node.top };
    console.log(`  Reusing ${opts.frame} (${node.type}${node.top ? ", top-level" : ", inside a top-level frame"}).`);
  } else {
    await buildFrame();
  }

  const renders = (opts.warmup ? 1 : 0) + opts.states.length * opts.runs;
  console.log(
    `\n  ${renders} renders follow, each at most ${opts.timeoutS} s. Keep this terminal where you can read it, except where a step says otherwise.` +
      "\n  At every prompt: Enter renders, s skips (where allowed), q stops (what was measured is saved).",
  );

  if (opts.warmup) {
    heading("Warm-up (not counted)");
    const a = await choose("  Keep Figma visible and restored (not minimized, not covered). Press Enter to render, q to stop: ", false);
    if (a === "q") {
      result.stoppedEarly = true;
      return;
    }
    await ensureSession();
    const { rec, t0 } = await measure("warmup", 1, 1);
    result.warmup = rec;
    save();
    if (rec.outcome === "error" && /UNSUPPORTED|NODE_NOT_FOUND|INVALID_PARAM/.test(rec.error ?? "")) {
      throw new StartError(`The warm-up render was refused, so nothing can be measured: ${firstLine(rec.error)}`);
    }
    if (rec.outcome === "stalled" && !rec.error) await settle(rec, t0, "Make sure the Figma window is visible and not minimized.");
  }

  for (const state of opts.states) {
    heading(`${state.id}: ${state.label}`);
    if (state.restart) {
      const r = await restartStep(state);
      if (r === "quit") {
        result.stoppedEarly = true;
        return;
      }
      if (r === "skip") {
        result.skipped.push({ state: state.id, reason: "skipped by the person", afterRuns: 0 });
        save();
        continue;
      }
    }
    let fullSetup = true;
    for (let run = 1; run <= opts.runs; run++) {
      const o = await runOnce(state, run, fullSetup);
      if (o.action === "quit") {
        result.stoppedEarly = true;
        return;
      }
      if (o.action === "skip") {
        result.skipped.push({ state: state.id, reason: "skipped by the person", afterRuns: run - 1 });
        save();
        break;
      }
      // A minimized state's `again` line already says to minimize again.
      fullSetup = o.restored && !state.minimized;
    }
    const leave = state.after ?? (state.minimized ? null : state.restore);
    if (leave) console.log(`\n  Before the next step: ${leave}`);
  }
  result.complete = true;
}

async function cleanup() {
  if (!mcp || !session || !createdIds.length) return;
  if (opts.keep) {
    result.cleanup = "kept (--keep)";
    console.log(`  --keep: the test frame ${nodeId} stays in the file (run again with --frame ${nodeId} to reuse it).`);
    return;
  }
  const d = await tool("figma_delete_nodes", { nodeIds: [...createdIds] });
  if (d.ok) {
    result.cleanup = "deleted";
    console.log(`  Deleted the test frame ${createdIds.join(", ")}.`);
  } else {
    result.cleanup = `not deleted: ${scrub(firstLine(d.text))}`;
    console.log(`  Could not delete the test frame (${firstLine(d.text)}). Delete ${createdIds.join(", ")} by hand.`);
  }
}

function printSummary() {
  const s = result.summary;
  if (!s) return;
  heading("Summary");
  console.log(`  baseline median: ${s.baselineMedianRenderS ?? "none"} s`);
  for (const [id, x] of Object.entries(s.states)) console.log(`  ${id.padEnd(10)} ${x.verdict}`);
}

let interrupting = false;
async function interrupt() {
  if (interrupting) process.exit(130);
  interrupting = true;
  console.log("\nInterrupted: saving what was measured ...");
  result.interrupted = true;
  try {
    save();
  } catch (err) {
    console.error(`  could not save: ${err?.message ?? err}`);
  }
  if (createdIds.length && !opts.keep) console.log(`  The test frame stays in the file: delete ${createdIds.join(", ")} by hand, or reuse it with --frame ${nodeId}.`);
  try {
    await mcp?.close();
  } catch {
    // already gone
  }
  process.exit(130);
}
process.on("SIGINT", () => void interrupt());

let exitCode = 0;
try {
  await live();
} catch (err) {
  if (err instanceof StartError) {
    console.error(`\n${err.message}`);
    result.crash = `could not start: ${scrub(err.message)}`;
    exitCode = 2;
  } else {
    console.error(`\nCrash: ${err?.stack ?? err}`);
    result.crash = scrub(String(err?.stack ?? err));
    exitCode = 1;
  }
}
try {
  heading("Cleanup");
  await cleanup();
} catch (err) {
  console.error(`  Cleanup failed: ${err?.message ?? err}. Delete ${createdIds.join(", ")} by hand.`);
  result.cleanup = `failed: ${scrub(String(err?.message ?? err))}`;
  if (!exitCode) exitCode = 1;
}
try {
  save();
} catch (err) {
  console.error(`Could not write ${OUT}: ${err?.message ?? err}`);
  if (!exitCode) exitCode = 1;
}
printSummary();
if (attempted) console.log(`\nRecord: ${path.relative(process.cwd(), OUT) || OUT}`);
else console.log("\nNo render was attempted, so the record was not written.");
if (videoDir) console.log(`Videos: ${videoDir}`);
rl?.close();
try {
  await mcp?.close();
} catch {
  // already gone
}
process.exit(exitCode);
