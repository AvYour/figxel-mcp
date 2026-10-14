// Every error result says whether a retry is safe without reading the canvas
// first [C-096] — the signal the official workflow builds its recovery on.
// True only on evidence: a read, a refusal before the bridge, the plugin's
// `created: []`, or a code that means the request never arrived. A timeout or
// a failure half-way through a write is false: look, then retry.

import { describe, expect, it } from "vitest";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import { changedNothing } from "../src/plugin/idempotency.js";
import { beforeMutating, unchanged } from "../src/plugin/guard.js";
import { errorResult } from "../src/server/results.js";

const safe = (err: unknown, opts?: { readOnly?: boolean; unchanged?: boolean }) =>
  (errorResult(err, opts).structuredContent as { safeToRetry: boolean }).safeToRetry;

describe("safeToRetry, the truth table", () => {
  const nothing = { created: [] };
  const something = { created: [{ id: "1:2", path: "spec" }], failedAt: "spec.children[1]" };

  it.each([
    ["a read that failed", new BridgeError(ErrorCode.TIMEOUT, "slow"), { readOnly: true }, true],
    ["refused before the bridge", new BridgeError(ErrorCode.INVALID_PARAM, "bad"), { unchanged: true }, true],
    ["the plugin says created: []", new BridgeError(ErrorCode.INVALID_PARAM, "bad", { partial: nothing }), {}, true],
    ["created: [] with a failedAt", new BridgeError(ErrorCode.INVALID_PARAM, "bad", { partial: { ...nothing, failedAt: "spec" } }), {}, true],
    ["no plugin connected", new BridgeError(ErrorCode.NO_SESSION, "none"), {}, true],
    ["the queue refused it", new BridgeError(ErrorCode.BUSY, "busy"), {}, true],
    ["the port never opened", new BridgeError(ErrorCode.PORT_IN_USE, "taken"), {}, true],
    ["half a spec was built", new BridgeError(ErrorCode.INVALID_PARAM, "bad", { partial: something }), {}, false],
    ["a batch stopped after a step", new BridgeError(ErrorCode.INVALID_PARAM, "bad", { partial: { steps: [{ index: 0 }], failedAt: 1 } }), {}, false],
    ["a timeout on a write", new BridgeError(ErrorCode.TIMEOUT, "slow"), {}, false],
    ["a stall", new BridgeError(ErrorCode.STALLED, "stuck"), {}, false],
    ["a cancel", new BridgeError(ErrorCode.CANCELLED, "stop"), {}, false],
    ["Figma threw mid-write, no partial", new BridgeError(ErrorCode.INVALID_PARAM, "bad"), {}, false],
    ["an unexpected exception", new Error("boom"), {}, false],
  ])("%s → %s", (_label, err, opts, expected) => {
    expect(safe(err, opts as { readOnly?: boolean; unchanged?: boolean })).toBe(expected);
  });

  it("is always present and always a boolean", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(typeof (errorResult(new BridgeError(code, "x")).structuredContent as { safeToRetry: unknown }).safeToRetry).toBe("boolean");
    }
  });
});

describe("the server and the plugin read `created: []` the same way", () => {
  it.each([
    [{ created: [] }],
    [{ created: [], failedAt: "spec" }],
    [{ created: [{ id: "1:2" }] }],
    [{ steps: [], failedAt: 0 }],
    [undefined],
    [null],
    [{ created: "none" }],
  ])("%j", (partial) => {
    const plugin = changedNothing({ ok: false, error: { code: "INVALID_PARAM", message: "x" }, partial });
    expect(safe(new BridgeError(ErrorCode.INVALID_PARAM, "x", { partial }))).toBe(plugin);
  });
});

describe("guard.ts: a refusal before the first write is marked, end to end", () => {
  it("beforeMutating turns any check failure into created: [], which the result calls safe", async () => {
    let err: unknown;
    try {
      await beforeMutating(() => {
        throw new BridgeError(ErrorCode.NODE_NOT_FOUND, "No node with id `9:9`.", { hint: "Check the id." });
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "NODE_NOT_FOUND", hint: "Check the id.", partial: { created: [] } });
    expect(safe(err)).toBe(true);
  });

  it("unchanged wraps a plain Error as INTERNAL, still marked", () => {
    expect(() => unchanged(new Error("boom"))).toThrow(expect.objectContaining({ code: "INTERNAL", partial: { created: [] } }));
  });
});
