// Test findSilentNodeLoss against a mock that has the same shape as a real
// Figma node: `id` as the only own enumerable property, everything else as
// prototype getters. If the detector works here, a stale running plugin is the
// only explanation left for the live probe's result.
//
// Run: node spikes/test-node-loss.mjs

// Same implementation as src/plugin/ops/eval.ts (kept in sync by the test that
// follows this one — see test/phase4.test.ts).
function findSilentNodeLoss(value, depth = 0, seen = new Set()) {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const proto = Object.getPrototypeOf(value);
  if (proto && proto !== Object.prototype) {
    const names = Object.getOwnPropertyNames(proto);
    if (names.includes("getSharedPluginData") && names.includes("removed")) {
      let kind = "node";
      try {
        const ctor = value.constructor;
        if (ctor && typeof ctor.name === "string" && ctor.name) kind = ctor.name;
      } catch {}
      return kind;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSilentNodeLoss(item, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }

  for (const key of Object.keys(value)) {
    let child;
    try {
      child = value[key];
    } catch {
      continue;
    }
    const found = findSilentNodeLoss(child, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

// A mock node shaped like the real thing: only `id` is an own enumerable prop.
class PageNode {
  constructor(id) {
    this.id = id;
  }
  get name() {
    return "Page 1";
  }
  get removed() {
    return false;
  }
  getSharedPluginData() {
    return "";
  }
  toString() {
    return "PageNode";
  }
}

const cases = [
  ["a bare node", new PageNode("0:1"), "PageNode"],
  ["a node in an object", { frame: new PageNode("1:2") }, "PageNode"],
  ["a node in an array", [new PageNode("3:4")], "PageNode"],
  ["nested two deep", { a: { b: [new PageNode("5:6")] } }, "PageNode"],
  ["plain data", { id: "1:2", name: "x" }, null],
  ["an array of plain data", [{ id: "1:2" }, { n: 1 }], null],
  ["null", null, null],
  ["a number", 42, null],
  ["a string", "hello", null],
];

// A cyclic plain object must not loop forever — that is the guard's own guard.
const cyclic = { name: "cycle" };
cyclic.self = cyclic;
cases.push(["a cyclic object", cyclic, null]);

// Something that LOOKS like a node but is a plain object must not be flagged.
cases.push(["a plain object with node-like keys", { getSharedPluginData: 1, removed: 2 }, null]);

let failed = 0;
for (const [label, input, expected] of cases) {
  const got = findSilentNodeLoss(input);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`  ${ok ? "ok " : "BAD"} ${label.padEnd(34)} expected=${String(expected).padEnd(9)} got=${got}`);
}

// The silent-truncation claim that motivated the detector, verified rather than
// assumed: a mock node really does collapse to just its id under JSON.stringify.
const json = JSON.stringify(new PageNode("0:1"));
const jsonOk = json === '{"id":"0:1"}';
if (!jsonOk) failed++;
console.log(`  ${jsonOk ? "ok " : "BAD"} stringify collapses to the id alone      ${json}`);

process.exit(failed ? 1 : 0);
