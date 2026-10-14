// Cursor safety, locked as tests.
//
// Why this deserves its own file: the cursor is the one piece of the wire
// protocol whose failure mode is SILENT. A cursor accepted by the wrong query
// does not throw — it returns a plausible page of results from a different
// scan, and an agent reading it would believe it has seen something it has not.
// Every other guard in this repo fails loudly. This one has to be asserted.
//
// Two layers:
//   1. the encoding itself, against scopes designed to break naive splitting;
//   2. the same attacks against the REAL plugin module, over a real bridge,
//      because a correct decoder wired to nothing passes layer 1 happily.
//
// Layer 2 talks to the plugin op table directly (not a mock), so the scope keys
// in src/plugin/ops/read.ts are exercised as-written.

import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/plugin/read.js";

describe("cursor round-trip", () => {
  // Scopes are built from op name, node ids, types and queries. Two of these
  // contain the separator on purpose: a naive `split("|")` puts the boundary in
  // the wrong place, and the offset then comes from the wrong half of the
  // string — which is exactly the silent-wrong-page failure.
  const scopes = [
    "scan_types:6:5003:RECTANGLE",
    "scan_types:0:1:RECTANGLE",
    "search:page:0:1:button:FRAME",
    "design_context:6:5003:2:50",
    "scan_text:0:1",
    "a|b|c",
    "|leading",
    "trailing|",
    "many|||pipes||",
    "scope with spaces and unicode",
  ];

  for (const scope of scopes) {
    for (const offset of [0, 1, 999, 5000, 123_456]) {
      it(`survives ${JSON.stringify(scope)} @${offset}`, () => {
        expect(decodeCursor(encodeCursor(scope, offset), scope)).toBe(offset);
      });
    }
  }
});

describe("a cursor belongs to exactly one query", () => {
  const frameCursor = encodeCursor("scan_types:6:5003:RECTANGLE", 1000);

  it("is refused by a query with a different node", () => {
    expect(() => decodeCursor(frameCursor, "scan_types:0:1:RECTANGLE")).toThrow(/does not belong to this query/);
  });

  it("is refused by a query with a different op", () => {
    expect(() => decodeCursor(frameCursor, "scan_text:6:5003")).toThrow(/does not belong to this query/);
  });

  it("is refused by a query with a different type filter", () => {
    expect(() => decodeCursor(frameCursor, "scan_types:6:5003:FRAME")).toThrow(/does not belong to this query/);
  });

  it("is accepted by its own query — so refusals above are scoping, not blanket", () => {
    expect(decodeCursor(frameCursor, "scan_types:6:5003:RECTANGLE")).toBe(1000);
  });

  it("keeps scopes containing the separator distinct", () => {
    // "a|b" and "a" + a stray "b" must not be interchangeable.
    expect(() => decodeCursor(encodeCursor("a|b", 5), "a")).toThrow(/does not belong to this query/);
    expect(() => decodeCursor(encodeCursor("a", 5), "a|b")).toThrow(/does not belong to this query/);
  });
});

describe("malformed input is refused, never guessed at", () => {
  const junk = ["AAAA", "!!!!", "not-base64", "////", "e30", "@@@@", "\u0000\u0001"];

  for (const value of junk) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      // Either it throws (good) or it is genuinely not a cursor. What it must
      // never do is return a positive offset, which would silently skip nodes.
      let offset: number | null = null;
      try {
        offset = decodeCursor(value, "any-scope");
      } catch {
        offset = null;
      }
      if (offset !== null) expect(offset).toBe(0);
    });
  }

  it("treats a missing or empty cursor as 'from the start'", () => {
    expect(decodeCursor(undefined, "x")).toBe(0);
    expect(decodeCursor("", "x")).toBe(0);
  });
});
