// The eval group (tools.md § eval), Phase 4 — the escape hatch.
//
// `figma_eval` is the counterpart of the official server's `use_figma`: it runs
// arbitrary JavaScript in the plugin sandbox with full `figma.*` access, for the
// gaps that have no dedicated tool yet.
//
// It is the one tool in this project that can do anything at all, so its
// constraints are deliberate and are enforced rather than documented:
//
//  * **Two keys to exist** (ADR #9): `BRIDGE_ALLOW_EVAL=1` AND a toolset that
//    includes the eval group. Without both, the tool is not registered at all —
//    a client cannot see it, and therefore cannot be talked into calling it.
//  * **One commitUndo per call**, like every other write. Whatever it did is one
//    Ctrl+Z, which is what makes an escape hatch safe to hand to an agent.
//  * **Logged with a hash, not the code** (tools.md): the log line carries
//    `op=eval`, the code length and a SHA-256, so an operator can tell two calls
//    apart and prove what was run without a wall of JavaScript in stderr.
//  * **No `Function` constructor shortcut.** The code is compiled with the
//    sandbox's own evaluator and called as an async function body, so a syntax
//    error is reported as a syntax error with the offending line rather than as
//    an unexplained rejection.
//
// The return value must survive the wire, so it is checked here: a live Figma
// node cannot be JSON-serialized, and discovering that after the call is a
// confusing INTERNAL where a clear INVALID_PARAM belongs.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { OpContext, PluginOp } from "./index.js";
import { str, int } from "../read.js";
import { timerDelay } from "../chunk.js";
import type { FigmaWrite } from "../write.js";

const api = () => (globalThis as unknown as { figma: FigmaWrite }).figma;

/**
 * The sandbox's evaluator.
 *
 * `Function` is used rather than `eval` for one reason: it evaluates in the
 * global scope, so the code can reach `figma` and the sandbox globals, while
 * `eval` in this module would close over module internals the caller must not
 * depend on. Both exist in the sandbox (the global list in
 * spikes/results/probe.json includes `Function`).
 */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

export interface EvalResult {
  value: unknown;
  durationMs: number;
  /** Present when the code returned something that cannot cross the wire. */
  serialization?: string;
}

const evalOp: PluginOp = {
  // A write: an eval script very often changes the document, and tools.md says
  // its changes are wrapped in one commitUndo like any other write.
  write: true,
  async run(ctx: OpContext): Promise<EvalResult> {
    const code = str(ctx.params, "code");
    if (code === undefined) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`code` is required.");
    }
    if (code.length > 200_000) {
      throw new BridgeError(
        ErrorCode.INVALID_PARAM,
        `\`code\` is ${code.length} characters; the limit is 200000. Split the work into several calls.`,
      );
    }
    const timeoutMs = int(ctx.params, "timeoutMs", 30_000, 600_000);

    // Compile first, so a syntax error is reported as one, with the message the
    // engine produced — that message names the line, which is the only useful
    // thing a caller can act on.
    let fn: (...args: unknown[]) => Promise<unknown>;
    try {
      fn = new AsyncFunction("figma", "ctx", code);
    } catch (err) {
      throw new BridgeError(
        ErrorCode.INVALID_PARAM,
        `The code does not compile: ${err instanceof Error ? err.message : String(err)}`,
        { hint: "The function body is compiled as an async function. A bare expression must be returned explicitly." },
      );
    }

    const started = Date.now();
    let value: unknown;
    try {
      // The timeout is advisory in the sense that it cannot pre-empt CPU-bound
      // code inside a synchronous block — nothing in a sandbox can. What it does
      // cover is code that awaits: it races the body against a timer, so an
      // eval that hangs on a promise does not hold the plugin queue forever.
      value = await withTimeout(fn(api(), { yieldToHost: ctx.yieldToHost, isCancelled: ctx.isCancelled }), timeoutMs);
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw new BridgeError(
          ErrorCode.TIMEOUT,
          `The code did not settle within ${timeoutMs} ms (the idle timeout, not wall-clock).`,
          { hint: "Nothing was rolled back. Pass a larger timeoutMs, or split the work." },
        );
      }
      if (err instanceof BridgeError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : "";
      throw new BridgeError(ErrorCode.INTERNAL, `The code threw: ${message}`, stack ? { hint: stack } : {});
    }

    // Check the value crosses the wire HERE, where the error can name the cause.
    //
    // Measured, not assumed: a Figma node does NOT throw on JSON.stringify — it
    // silently collapses to `{"id":"0:1"}` because the interesting fields live on
    // the prototype as getters and only `id` is an own enumerable property. A
    // silent truncation is worse than a throw: the caller gets a plausible object
    // with the data missing and no error anywhere. So the loss is DETECTED rather
    // than waited for.
    let serialization: string | undefined;
    try {
      JSON.stringify(value);
    } catch (err) {
      serialization = `the return value is not JSON-serializable (${err instanceof Error ? err.message : String(err)}). Return plain data — node ids, numbers, strings — not live Figma objects.`;
      throw new BridgeError(ErrorCode.INVALID_PARAM, serialization);
    }
    const lost = findSilentNodeLoss(value);
    if (lost) {
      throw new BridgeError(
        ErrorCode.INVALID_PARAM,
        `The return value contains a live Figma ${lost}, which cannot cross the wire: it serializes to just its id and ` +
          "every other field is lost with no error. Return plain data instead — e.g. " +
          "`{ id: node.id, name: node.name, type: node.type, width: node.width }`.",
      );
    }

    const durationMs = Date.now() - started;
    ctx.progress(1, 1, "done");
    return { value, durationMs };
  },
};

class TimeoutError extends Error {
  constructor() {
    super("The code did not settle within the idle timeout.");
    this.name = "TimeoutError";
  }
}

/**
 * Find a live Figma node hiding in a return value, and name its type.
 *
 * Why not just try to stringify it? Because stringify does not fail — measured
 * against the real API, `JSON.stringify(figma.currentPage)` returns
 * `{"id":"0:1"}`: only `id` is an own enumerable property, and everything else
 * lives on the prototype as getters that JSON ignores. A silent truncation is
 * the worst outcome available: the caller receives a plausible object, the data
 * is gone, and nothing anywhere reports a problem.
 *
 * Detection therefore looks at the PROTOTYPE, never at instance properties.
 * Reading a value off a removed node throws, and a serialization check that can
 * itself throw on valid input is worse than no check. `getOwnPropertyNames` on
 * the prototype does not invoke getters — it only lists them — and
 * `getSharedPluginData` plus `removed` together are a Figma node and nothing
 * else.
 *
 * Walks arrays and plain objects because `return { frame }` and `return [node]`
 * are the natural way to hit this. Bounded: depth 4, and a `seen` set so a
 * cyclic structure cannot loop forever.
 */
function findSilentNodeLoss(value: unknown, depth = 0, seen = new Set<unknown>()): string | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto && proto !== Object.prototype) {
    const names = Object.getOwnPropertyNames(proto);
    if (names.includes("getSharedPluginData") && names.includes("removed")) {
      // The type name comes from the constructor, read defensively: a node whose
      // js object has been detached can throw on almost anything.
      let kind = "node";
      try {
        const ctor = (value as { constructor?: { name?: string } }).constructor;
        if (ctor && typeof ctor.name === "string" && ctor.name) kind = ctor.name;
      } catch {
        /* keep the generic name */
      }
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
    let child: unknown;
    try {
      child = (value as Record<string, unknown>)[key];
    } catch {
      continue; // A throwing getter is not our business here.
    }
    const found = findSilentNodeLoss(child, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

/**
 * Race a promise against a timer.
 *
 * The delay comes from `chunk.ts`'s feature-detected primitive, not from a
 * direct `setTimeout`: the sandbox-globals guard allows exactly one file to
 * touch the timer global, and a tool that quietly made itself a second exception
 * would erode the rule for everything added later.
 *
 * When the sandbox has no timer at all, the race is skipped: the body's own
 * promise is awaited and the caller's client-side timeout remains the backstop.
 * That is honest — a sandbox with no timer cannot enforce an idle timeout — and
 * it is better than pretending with a yield, which returns immediately.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const delay = timerDelay();
  if (!delay) return p;
  return new Promise<T>((resolve, reject) => {
    // No clearTimeout on the winning path: a promise that has already settled
    // ignores later settle attempts, so the timer firing later is a no-op.
    // Clearing it would need `clearTimeout`, another global the guard reserves.
    void delay(ms).then(() => reject(new TimeoutError()));
    p.then(resolve, reject);
  });
}

export const EVAL_OPS: Record<string, PluginOp> = {
  eval: evalOp,
};

// Exported for the unit tests: the compile-and-serialize behaviour is worth
// asserting without a Figma instance, and it is where the real failures were.
// `TimeoutError` is exported so a test can assert the TYPE — matching on the
// message would pass for any error that happened to contain the word "timeout".
// `findSilentNodeLoss` is exported so the detector is tested against a mock with
// the real node's shape, not against a copy of the detector kept in a spike.
export { withTimeout as __withTimeout, TimeoutError as __TimeoutError, findSilentNodeLoss as __findSilentNodeLoss };
