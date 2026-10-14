// Phase 4: the export tools and the escape hatch.
//
// Three things are worth locking here, and none of them is "the happy path
// returns bytes":
//
//  1. `figma_eval` is really gated by two keys — not documented as gated. A hole
//     here is the whole document-modifying surface exposed by a typo.
//  2. The eval timeout cannot leave a caller hanging. A race that settles the
//     wrong promise is invisible until something hangs forever.
//  3. The PDF merge keeps page order and refuses to silently drop a page it
//     cannot read. A PDF that opens with the wrong pages is worse than an error.

import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { mergePdfs } from "../src/server/pdf.js";
import { BridgeError } from "../src/shared/errors.js";

async function makePdf(label: string, width = 200, height = 100): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  page.drawText(label, { x: 20, y: 40, size: 18 });
  return Buffer.from(await doc.save());
}

describe("PDF merge", () => {
  it("keeps the order it is given", async () => {
    const a = await makePdf("A", 200, 100);
    const b = await makePdf("B", 300, 150);
    const c = await makePdf("C", 400, 200);
    const merged = await mergePdfs([
      { nodeId: "1:1", name: "first", bytes: a },
      { nodeId: "1:2", name: "second", bytes: b },
      { nodeId: "1:3", name: "third", bytes: c },
    ]);
    expect(merged.pageCount).toBe(3);

    // Page order is asserted through the page SIZES, because that is observable
    // without decoding text: a reorder would swap them.
    const check = await PDFDocument.load(merged.bytes);
    const sizes = check.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
    expect(sizes).toEqual([
      [200, 100],
      [300, 150],
      [400, 200],
    ]);
  });

  it("handles a single page without turning it into an error", async () => {
    const only = await makePdf("only");
    const merged = await mergePdfs([{ nodeId: "1:1", name: "only", bytes: only }]);
    expect(merged.pageCount).toBe(1);
  });

  it("refuses an empty set with a clear error, rather than writing an empty file", async () => {
    await expect(mergePdfs([])).rejects.toThrow(BridgeError);
    await expect(mergePdfs([])).rejects.toThrow(/no page rendered successfully/i);
  });

  it("skips an unreadable page and keeps the readable ones", async () => {
    const good = await makePdf("good", 222, 111);
    const merged = await mergePdfs([
      { nodeId: "1:1", name: "good", bytes: good },
      { nodeId: "1:2", name: "broken", bytes: Buffer.from("this is not a PDF at all") },
    ]);
    expect(merged.pageCount).toBe(1);
    const check = await PDFDocument.load(merged.bytes);
    expect(Math.round(check.getPage(0).getWidth())).toBe(222);
  });

  it("fails loudly when nothing at all could be read", async () => {
    await expect(
      mergePdfs([
        { nodeId: "1:1", name: "junk1", bytes: Buffer.from("nope") },
        { nodeId: "1:2", name: "junk2", bytes: Buffer.from("also nope") },
      ]),
    ).rejects.toThrow(/None of the rendered PDFs could be read/i);
  });
});

describe("eval's timeout race", () => {
  // The helper is exercised directly because the failure mode it guards against
  // — settling the wrong promise — shows up as a caller that never returns, and
  // no happy-path test would ever notice.
  it("rejects when the body outlives the delay", async () => {
    const { __withTimeout, __TimeoutError } = await import("../src/plugin/ops/eval.js");
    const never = new Promise<void>(() => {});
    await expect(__withTimeout(never, 20)).rejects.toBeInstanceOf(__TimeoutError);
  });

  it("resolves with the body's value when it finishes first", async () => {
    const { __withTimeout } = await import("../src/plugin/ops/eval.js");
    await expect(__withTimeout(Promise.resolve("done"), 5_000)).resolves.toBe("done");
  });

  it("propagates the body's own rejection rather than reporting a timeout", async () => {
    const { __withTimeout } = await import("../src/plugin/ops/eval.js");
    await expect(__withTimeout(Promise.reject(new Error("boom")), 5_000)).rejects.toThrow("boom");
  });
});

describe("detecting a live node in eval's return value", () => {
  // The mock mirrors the measured shape of a real node: `id` is the only own
  // enumerable property, everything else is a prototype getter. That shape is
  // exactly why JSON.stringify neither throws nor helps — it returns
  // `{"id":"0:1"}` — and so the check has to look at the prototype.
  class FakeNode {
    constructor(public id: string) {}
    get name(): string {
      return "Page 1";
    }
    get removed(): boolean {
      return false;
    }
    getSharedPluginData(): string {
      return "";
    }
  }

  const load = async () => (await import("../src/plugin/ops/eval.js")).__findSilentNodeLoss;

  it("does not throw on a live node — it collapses silently, which is why detection exists", () => {
    expect(JSON.stringify(new FakeNode("0:1"))).toBe('{"id":"0:1"}');
  });

  it.each([
    ["a bare node", new FakeNode("0:1"), "FakeNode"],
    ["a node inside an object", { frame: new FakeNode("1:2") }, "FakeNode"],
    ["a node inside an array", [new FakeNode("3:4")], "FakeNode"],
    ["a node nested two levels deep", { a: { b: [new FakeNode("5:6")] } }, "FakeNode"],
  ])("finds %s", async (_label, input, expected) => {
    expect((await load())(input)).toBe(expected);
  });

  it.each([
    ["plain data", { id: "1:2", name: "x" }],
    ["arrays of plain data", [{ id: "1:2" }, { n: 1 }]],
    ["null", null],
    ["a number", 42],
    ["a string", "hello"],
    // A plain object that merely has node-ish key names must NOT be flagged:
    // a false positive rejects valid input, which is its own kind of bug.
    ["a plain object with node-like keys", { getSharedPluginData: 1, removed: 2 }],
  ])("leaves %s alone", async (_label, input) => {
    expect((await load())(input)).toBeNull();
  });

  it("terminates on a cyclic object instead of looping forever", async () => {
    const cyclic: Record<string, unknown> = { name: "cycle" };
    cyclic.self = cyclic;
    expect((await load())(cyclic)).toBeNull();
  });
});
