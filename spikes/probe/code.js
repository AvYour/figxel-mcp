// Phase 0 API probe — answers, on the installed Figma desktop, three
// questions documents could not settle (claim verification, 2026-10-07):
//
//   C-021  Is figma.fileKey available to a DEV plugin whose manifest sets
//          enablePrivatePluginApi? (The manifest page says local plugins get
//          private APIs during development; the API page says private
//          plugins only.) Only presence and length are recorded, not the key.
//   C-012  Which globals does the sandbox actually have? how-plugins-run says
//          to inspect `this` on the main thread; typeof checks for the
//          contested ones (setTimeout, setInterval, fetch) are included.
//   C-025  What does a nodechange look like — does it carry `id`/`origin`
//          (the typings say yes, the web page does not), and does a Ctrl+Z
//          arrive as an ordinary change, indistinguishable from an edit?
//
// Plain ES2017, no build step. If Figma refuses to import this manifest
// because of enablePrivatePluginApi, that refusal is itself the C-021 answer:
// record it in the Phase 0 log.

var g = typeof globalThis !== "undefined" ? globalThis : this;

figma.showUI(__html__, { width: 440, height: 560, title: "figma-mcp API probe" });

function safe(fn) {
  try {
    return fn();
  } catch (e) {
    return "threw: " + (e && e.message ? e.message : String(e));
  }
}

var report = {
  at: new Date().toISOString(),
  apiVersion: figma.apiVersion,
  editorType: figma.editorType,
  manifestSetsEnablePrivatePluginApi: true,
  fileKey: safe(function () {
    var k = figma.fileKey;
    return { typeof: typeof k, present: typeof k === "string" && k.length > 0, length: typeof k === "string" ? k.length : null };
  }),
  typeofs: {
    setTimeout: typeof setTimeout,
    setInterval: typeof setInterval,
    fetch: typeof fetch,
    queueMicrotask: typeof queueMicrotask,
    structuredClone: typeof structuredClone,
    WebSocket: typeof WebSocket,
    XMLHttpRequest: typeof XMLHttpRequest,
    document: typeof document,
  },
  globals: safe(function () {
    return Object.getOwnPropertyNames(g).sort();
  }),
  nodeChanges: [],
};

function post() {
  figma.ui.postMessage({ kind: "report", report: report });
}

function describeChange(c) {
  return {
    keys: Object.keys(c),
    hasId: "id" in c,
    id: c.id,
    hasOrigin: "origin" in c,
    origin: c.origin,
    type: c.type,
    properties: c.properties || null,
    nodeRemoved: safe(function () {
      return c.node ? c.node.removed : null;
    }),
  };
}

var changesSeen = 0;
figma.currentPage.on("nodechange", function (ev) {
  for (var i = 0; i < ev.nodeChanges.length && changesSeen < 12; i++) {
    var d = describeChange(ev.nodeChanges[i]);
    d.step = changesSeen === 0 ? "first change seen" : "later change";
    changesSeen++;
    report.nodeChanges.push(d);
  }
  post();
});

figma.ui.onmessage = function (m) {
  if (m.kind === "mark") {
    report.nodeChanges.push({ marker: m.label, at: Date.now() });
    post();
  }
};

post();
