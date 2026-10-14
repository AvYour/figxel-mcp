// The helpers several tool groups share, pinned before any of them uses them:
// the "nothing changed" refusal, cross-page loading under dynamic-page
// [C-090], variable modes by object [C-105], motion fields as strings [C-115],
// the paint dialect moved out of design context, and errorResult's options
// [C-096].
//
// Fakes behave like the Plugin API where it matters: a page that is not the
// current one throws on `children` until loadAsync ran, and a node records
// exactly what setExplicitVariableModeForCollection received — the deprecated
// id overload throws under dynamic-page, so receiving a string is a failure.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import { beforeMutating, unchanged } from "../src/plugin/guard.js";
import { changedNothing } from "../src/plugin/idempotency.js";
import { ensureLoaded, loadAllPages } from "../src/plugin/pages.js";
import { resolveCollection, resolveMode, setMode, type CollectionLike } from "../src/plugin/modes.js";
import { fieldToString, tracksToFieldNames } from "../src/plugin/motion-fields.js";
import { paintText } from "../src/plugin/dialect.js";
import { buildContext, type ContextOptions } from "../src/plugin/context.js";
import { errorResult } from "../src/server/results.js";

const g = globalThis as { figma?: unknown };
afterEach(() => {
  delete g.figma;
});

async function rejection(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (err) {
    return err as BridgeError;
  }
  throw new Error("expected a rejection");
}

describe("guard: refusing before the document changes", () => {
  it("passes the prepared value through, sync or async", async () => {
    expect(await beforeMutating(() => 7)).toBe(7);
    expect(await beforeMutating(async () => "ok")).toBe("ok");
  });

  it("keeps a BridgeError's code, message and hint, and states that nothing was created", async () => {
    const err = await rejection(beforeMutating(() => {
      throw new BridgeError("INVALID_PARAM", "`color` is not a colour.", { hint: "Use #rrggbb." });
    }));
    expect(err).toBeInstanceOf(BridgeError);
    expect(err).toMatchObject({ code: "INVALID_PARAM", message: "`color` is not a colour.", hint: "Use #rrggbb.", partial: { created: [] } });
  });

  it("turns any other throw into INTERNAL, still marked unchanged", async () => {
    const err = await rejection(beforeMutating(async () => {
      throw new TypeError("x is undefined");
    }));
    expect(err).toMatchObject({ code: "INTERNAL", message: "x is undefined", partial: { created: [] } });
  });

  it("produces the marker that frees the idempotencyKey for a corrected retry", () => {
    let err: BridgeError | undefined;
    try {
      unchanged(new BridgeError("NODE_NOT_FOUND", "No node 1:2."));
    } catch (e) {
      err = e as BridgeError;
    }
    expect(changedNothing({ ok: false, error: { code: err!.code, message: err!.message }, partial: err!.partial })).toBe(true);
  });
});

describe("pages: loading a page before reading or writing it [C-090]", () => {
  function page(name: string) {
    let loaded = false;
    const p = {
      type: "PAGE",
      name,
      loads: 0,
      async loadAsync() {
        p.loads++;
        loaded = true;
      },
      get children() {
        if (!loaded) throw new Error("in get_children: Cannot access children on a page that has not been explicitly loaded");
        return [];
      },
    };
    return p;
  }

  it("loads a page that is not the current one, after which its children are readable", async () => {
    const other = page("Other");
    g.figma = { currentPage: page("Current") };
    expect(() => other.children).toThrow(/not been explicitly loaded/);
    await ensureLoaded(other);
    expect(other.loads).toBe(1);
    expect(other.children).toEqual([]);
  });

  it("leaves the current page, scene nodes and a page without loadAsync alone", async () => {
    const current = page("Current");
    g.figma = { currentPage: current };
    await ensureLoaded(current);
    expect(current.loads).toBe(0);
    await expect(ensureLoaded({ type: "FRAME", loadAsync: async () => { throw new Error("must not be called"); } })).resolves.toBeUndefined();
    await expect(ensureLoaded({ type: "PAGE" })).resolves.toBeUndefined();
  });

  it("loads every page when asked, and is a no-op where the API is missing", async () => {
    let calls = 0;
    g.figma = { currentPage: null, loadAllPagesAsync: async () => void calls++ };
    await loadAllPages();
    expect(calls).toBe(1);
    g.figma = { currentPage: null };
    await expect(loadAllPages()).resolves.toBeUndefined();
  });
});

describe("modes: collection and mode by id or name, set by object [C-105]", () => {
  const theme: CollectionLike = { id: "VariableCollectionId:1:1", name: "Theme", modes: [{ modeId: "1:0", name: "Light" }, { modeId: "1:1", name: "Dark" }] };
  const spacing: CollectionLike = { id: "VariableCollectionId:1:2", name: "Spacing", modes: [{ modeId: "2:0", name: "Default" }] };
  let local: CollectionLike[];

  beforeEach(() => {
    local = [theme, spacing];
    g.figma = {
      variables: {
        async getVariableCollectionByIdAsync(id: string) {
          return [...local, { id: "VariableCollectionId:lib:9", name: "Library theme", modes: [] }].find((c) => c.id === id) ?? null;
        },
        async getLocalVariableCollectionsAsync() {
          return local;
        },
      },
    };
  });

  it("finds a collection by id — a library one too — or by exact local name, returning the object", async () => {
    expect(await resolveCollection({ id: theme.id })).toBe(theme);
    expect((await resolveCollection({ id: "VariableCollectionId:lib:9" })).name).toBe("Library theme");
    expect(await resolveCollection({ name: "Spacing" })).toBe(spacing);
  });

  it("names what is missing: an unknown id, an unknown name with the nearest, or no reference at all", async () => {
    expect(await rejection(resolveCollection({ id: "VariableCollectionId:404" }))).toMatchObject({ code: "NODE_NOT_FOUND" });
    const byName = await rejection(resolveCollection({ name: "Themes" }));
    expect(byName).toMatchObject({ code: "INVALID_PARAM" });
    expect(byName.hint).toMatch(/Nearest: Theme/);
    expect(await rejection(resolveCollection({}))).toMatchObject({ code: "INVALID_PARAM", message: "Give `collectionId` or `collectionName`." });
    expect((await rejection(resolveCollection({}, "variableModes.collection"))).message).toMatch(/variableModes\.collectionId/);
  });

  it("refuses a name two local collections share instead of picking one", async () => {
    local = [theme, { ...spacing, id: "VariableCollectionId:1:3", name: "Theme" }];
    const err = await rejection(resolveCollection({ name: "Theme" }));
    expect(err).toMatchObject({ code: "INVALID_PARAM" });
    expect(err.hint).toContain("VariableCollectionId:1:3");
  });

  it("is UNSUPPORTED where the editor has no variables API", async () => {
    g.figma = {};
    expect(await rejection(resolveCollection({ name: "Theme" }))).toMatchObject({ code: "UNSUPPORTED" });
  });

  it("finds a mode by id or by name, and lists the modes when it cannot", () => {
    expect(resolveMode(theme, "1:1")).toEqual({ modeId: "1:1", name: "Dark" });
    expect(resolveMode(theme, "Dark")).toEqual({ modeId: "1:1", name: "Dark" });
    let err: BridgeError | undefined;
    try {
      resolveMode(spacing, "Dark");
    } catch (e) {
      err = e as BridgeError;
    }
    expect(err).toMatchObject({ code: "INVALID_PARAM" });
    expect(err!.hint).toContain("Default (2:0)");
    expect(err!.hint).toMatch(/one mode per collection/);
  });

  it("passes the collection object, never its id, and reports a node that takes no mode", () => {
    const received: unknown[][] = [];
    const frame = { type: "FRAME", setExplicitVariableModeForCollection: (...args: unknown[]) => void received.push(args) };
    setMode(frame, theme, "1:1");
    expect(received).toEqual([[theme, "1:1"]]);
    expect(received[0]![0]).toBe(theme);
    expect(() => setMode({ type: "VECTOR" }, theme, "1:1")).toThrow("a VECTOR cannot take a variable mode");
  });
});

describe("motion fields as strings [C-115]", () => {
  it("writes each KeyframeField form as one string", () => {
    expect(fieldToString({ type: "PROPERTY", name: "OPACITY" })).toBe("OPACITY");
    expect(fieldToString({ type: "INDEXED_ITEM", collection: "fills", index: 0 })).toBe("fill:0");
    expect(fieldToString({ type: "INDEXED_ITEM", collection: "strokes", index: 1 })).toBe("stroke:1");
    expect(fieldToString({ type: "INDEXED_ITEM", collection: "effects", index: 0, field: "RADIUS" })).toBe("effect:0:RADIUS");
    expect(fieldToString({ type: "INDEXED_ITEM", collection: "fills", index: 2, propertyId: "p1" })).toBe("fill:2:prop:p1");
    expect(fieldToString({ type: "INDEXED_ITEM", collection: "effects", index: 1, propertyId: "p2" })).toBe("effect:1:prop:p2");
  });

  it("flattens manualKeyframeTracks: property keys, then the paint and effect index maps", () => {
    const track = { id: "t", baseValue: { type: "FLOAT", value: 0 }, keyframes: [] };
    const names = tracksToFieldNames({
      OPACITY: track,
      TRANSLATION_X: track,
      ROTATION: undefined,
      fills: { 0: track, 2: { properties: { p1: track } } },
      strokes: [undefined, track],
      effects: { 0: { RADIUS: track, COLOR: track, properties: { p2: track } } },
    });
    expect(names).toEqual(["OPACITY", "TRANSLATION_X", "fill:0", "fill:2:prop:p1", "stroke:1", "effect:0:RADIUS", "effect:0:COLOR", "effect:0:prop:p2"]);
  });

  it("reads `animations` the same way, and nothing from a node without motion", () => {
    const binding = { baseValue: { type: "FLOAT", value: 1 }, timelineDuration: 1, tracks: [] };
    expect(tracksToFieldNames({ SCALE_XY: binding, fills: { 1: binding } })).toEqual(["SCALE_XY", "fill:1"]);
    expect(tracksToFieldNames({})).toEqual([]);
    expect(tracksToFieldNames(undefined)).toEqual([]);
  });
});

describe("the paint dialect, moved out of design context unchanged", () => {
  const red = { type: "SOLID", color: { r: 1, g: 0, b: 0 } };

  it("writes solids, gradients and other paints the way design context always has", () => {
    expect(paintText(red)).toBe("#ff0000");
    expect(paintText({ ...red, opacity: 0.5 })).toBe("#ff0000 50%");
    expect(
      paintText({ type: "GRADIENT_RADIAL", gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 1, g: 1, b: 1, a: 0.5 } }] }),
    ).toBe("radial-gradient(#000000 0%, #ffffff 50% 100%)");
    expect(paintText({ type: "IMAGE" })).toBe("image");
  });

  it("puts the variable before the hidden flag, as design context did", async () => {
    expect(paintText({ ...red, visible: false }, 1, 1, "color/brand")).toBe("#ff0000 (var: color/brand) (hidden)");
    g.figma = {
      variables: {
        async getVariableByIdAsync(id: string) {
          return id === "V:9" ? { name: "color/brand", resolvedType: "COLOR", resolveForConsumer: () => ({ value: { r: 1, g: 0, b: 0, a: 1 } }) } : null;
        },
      },
    };
    const opts: ContextOptions = { depth: 1, maxNodes: 10, maxChildren: 10, includeGeometry: false, includeStyles: false, includeVariables: true };
    const rect = { id: "7:1", type: "RECTANGLE", name: "Swatch", fills: [{ ...red, visible: false, boundVariables: { color: { id: "V:9" } } }] };
    const r = await buildContext([rect as never], opts, { yieldToHost: async () => {}, isCancelled: () => false });
    expect(r.roots[0]!.fills).toEqual(["#ff0000 (var: color/brand) (hidden)"]);
    expect(r.variablesUsed).toEqual([{ id: "V:9", name: "color/brand", type: "COLOR", value: "#ff0000" }]);
  });
});

describe("errorResult options [C-096]", () => {
  it("accepts readOnly / unchanged without changing the result yet", () => {
    const err = new BridgeError("INVALID_PARAM", "Bad.", { hint: "Fix it.", partial: { created: [] } });
    expect(errorResult(err, { readOnly: true })).toEqual(errorResult(err));
    expect(errorResult(err, { unchanged: true })).toEqual(errorResult(err));
  });
});
