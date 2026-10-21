// figma_create_storyboard end to end against the write fakes: the plugin op
// (one create_from_spec build, snapshots through a fake exportAsync and
// createImage, the record in shared plugin data [C-188]), every refusal
// before the first node exists, the reader that takes the visible duration
// caption as the plan, and the server tool in front of it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { editorsSuffix } from "../src/shared/editors.js";
import { BridgeError } from "../src/shared/errors.js";
import { STORYBOARD_KEY, STORYBOARD_NAMESPACE } from "../src/shared/storyboard.js";
import { readStoryboard, STORYBOARD_OPS } from "../src/plugin/ops/storyboard.js";
import type { Bridge } from "../src/server/bridge.js";
import type { Extra } from "../src/server/tools/forward.js";
import { panelEntry, registerStoryboard, STORYBOARD_SHAPE } from "../src/server/tools/storyboard.js";
import { FakeContainer, installFigma, opContext, type FakeNode } from "./editor-fakes.js";
import { WFrame, WText, WriteFigma } from "./write-fakes.js";

type Any = Record<string, unknown>;

/** The Design file a storyboard is built in: images by bytes and by hash, and local text styles. */
class BoardFigma extends WriteFigma {
  readonly images = new Set<string>(["hash-known"]);
  textStyles: Any[] = [];
  private made = 0;
  createImage(bytes: Uint8Array): { hash: string; getSizeAsync(): Promise<{ width: number; height: number }> } {
    const hash = `img-${++this.made}-${bytes.length}`;
    this.images.add(hash);
    return { hash, getSizeAsync: async () => ({ width: 1, height: 1 }) };
  }
  getImageByHash(hash: string): unknown {
    return this.images.has(hash) ? { hash } : null;
  }
  async getLocalTextStylesAsync(): Promise<Any[]> {
    return this.textStyles;
  }
  async getStyleByIdAsync(id: string): Promise<Any | null> {
    const s = this.textStyles.find((t) => t.id === id);
    return s ? { id: s.id, name: s.name, type: "TEXT" } : null;
  }
}

// What every Figma node has and the shared fakes leave out: shared plugin data
// on frames, and a text style setter on text.
const shared = new WeakMap<object, Map<string, string>>();
const proto = WFrame.prototype as unknown as Any;
const textProto = WText.prototype as unknown as Any;
beforeAll(() => {
  proto.setSharedPluginData = function (this: object, ns: string, key: string, value: string) {
    if (!shared.has(this)) shared.set(this, new Map());
    shared.get(this)!.set(`${ns}/${key}`, value);
  };
  proto.getSharedPluginData = function (this: object, ns: string, key: string) {
    return shared.get(this)?.get(`${ns}/${key}`) ?? "";
  };
  textProto.setTextStyleIdAsync = async function (this: Any, id: string) {
    this.textStyleId = id;
  };
});
afterAll(() => {
  delete proto.setSharedPluginData;
  delete proto.getSharedPluginData;
  delete textProto.setTextStyleIdAsync;
});

let fake: BoardFigma;
let restore: (() => void) | undefined;
function file(): BoardFigma {
  fake = new BoardFigma();
  restore = installFigma(fake);
  return fake;
}
afterEach(() => {
  restore?.();
  restore = undefined;
});

const run = (params: Any, extra: Parameters<typeof opContext>[1] = {}) => STORYBOARD_OPS.create_storyboard!.run(opContext(params, extra)) as Promise<Any>;
async function refusal(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a refusal");
}
const node = (id: string) => fake.nodes.get(id) as (FakeNode & Any) | undefined;
const chars = (id: string) => (node(id) as unknown as { characters: string }).characters;
type PanelOut = { id: string; thumbId: string; hintId?: string; captionIds: Record<string, string>; styleframeId?: string; image?: string } & Any;
const panelsOf = (r: Any) => r.panels as PanelOut[];

/** A frame on the page standing for someone's styleframe, rendering through a recorded exportAsync. */
function styleframe(width: number, height: number, renders: Any[] = []): WFrame {
  const f = fake.frame();
  f.resize(width, height);
  (f as unknown as Any).exportAsync = async (settings: Any) => {
    renders.push(settings);
    return new Uint8Array(64);
  };
  return f;
}

const BRIEF = {
  title: "Kiln end card",
  aspect: "9:16",
  bpm: 100,
  panels: [
    { durationS: 1.2, title: "Hook", onScreen: "Fired today", styleframe: true },
    { durationS: 1.8, title: "Vase", action: "Push in" },
    { durationS: 2.4, title: "End card", onScreen: "kiln.shop", styleframe: true },
  ],
};

describe("the op builds one board", () => {
  it("at an empty spot right of the page's work, with a card per panel and styleframes beside it", async () => {
    file();
    const work = fake.frame();
    work.resize(500, 300);
    work.x = 100;
    work.y = 50;
    const r = await run(BRIEF);
    const board = node(r.storyboardId as string)!;
    expect(board.name).toBe("Storyboard / Kiln end card");
    expect([board.x, board.y]).toEqual([100 + 500 + 400, 50]);
    expect(board.parent).toBe(fake.currentPage);
    const ps = panelsOf(r);
    expect(ps.map((p) => node(p.id)!.name)).toEqual(["Panel 01 · 0:00.0", "Panel 02 · 0:01.2", "Panel 03 · 0:03.0"]);
    // 0.6 s a beat: 3.0 s is beat 5, the second beat of bar 2.
    expect(ps.map((p) => [p.startFrame, p.endFrame, p.bar])).toEqual([[0, 36, "1.1"], [36, 90, "1.3"], [90, 162, "2.2"]]);
    expect(chars(ps[1]!.captionIds.duration!)).toBe("1.8 s · 54 f");
    expect(chars(ps[1]!.captionIds.action!)).toBe("Push in");
    expect(chars(ps[0]!.captionIds.action!)).toBe("—");
    // The board's spec gives its lengths as numbers: still px, now that a spec also takes strings.
    expect((node(ps[1]!.captionIds.duration!) as unknown as Any).lineHeight).toEqual({ unit: "PIXELS", value: 18 });
    expect(ps.map((p) => p.styleframeId !== undefined)).toEqual([true, false, true]);
    expect(node(ps[0]!.styleframeId!)!.name).toBe("SF 01 · Hook");
    // The top-level nodes it placed: deleting them removes the whole call.
    expect(r.created).toEqual([r.storyboardId, ps[0]!.styleframeId, ps[2]!.styleframeId]);
    expect(r).toMatchObject({ durationS: 5.4, durationFrames: 162, fps: 30, bpm: 100, beatsPerBar: 4, offBeat: [], readTime: [] });
    expect(r.nodeCount).toBeGreaterThan(40);
    // The runner commits the one undo step; the op itself never does.
    expect(fake.undoCommits).toBe(0);
  });

  it("x and y place it; pageId builds on another page", async () => {
    file();
    const other = new FakeContainer("PAGE", "Storyboard", fake);
    fake.root.appendChild(other);
    const r = await run({ ...BRIEF, pageId: other.id, x: -5000, y: 7000 });
    const board = node(r.storyboardId as string)!;
    expect(board.parent).toBe(other);
    expect([board.x, board.y]).toEqual([-5000, 7000]);
    expect(node(panelsOf(r)[0]!.styleframeId!)!.parent).toBe(other);
  });

  it("writes the record: ids only, the planned durations as a fallback", async () => {
    file();
    const r = await run(BRIEF);
    const raw = (node(r.storyboardId as string) as unknown as { getSharedPluginData(ns: string, k: string): string }).getSharedPluginData(STORYBOARD_NAMESPACE, STORYBOARD_KEY);
    const record = JSON.parse(raw);
    const ps = panelsOf(r);
    expect(record).toMatchObject({ v: 1, title: "Kiln end card", aspect: "9:16", fps: 30, bpm: 100, beatsPerBar: 4 });
    expect(record.panels).toEqual(ps.map((p, i) => ({
      index: i + 1, id: p.id, thumbId: p.thumbId, captionIds: p.captionIds, plannedS: [1.2, 1.8, 2.4][i],
      ...(p.styleframeId ? { styleframeId: p.styleframeId } : {}),
    })));
  });

  it("lists copy too short to read and starts off the beat", async () => {
    file();
    const r = await run({ title: "x", aspect: "4:5", bpm: 100, panels: [{ durationS: 1.25, onScreen: "Hand thrown stoneware fired in a wood kiln" }, { durationS: 1 }] });
    expect(r.readTime).toEqual([{ index: 1, words: 8, needS: 2.4, haveS: 1.2667 }]);
    expect(r.offBeat).toEqual([{ index: 2, startS: 1.2667, nearestBeat: "1.3", offsetFrames: 2 }]);
    expect(r.snapped).toEqual([{ index: 1, from: 1.25, to: 1.2667 }]);
  });
});

describe("snapshots", () => {
  it("a source renders in the sandbox, wide enough to cover its thumbnail at 2x, into the thumbnail's fill", async () => {
    file();
    const renders: Any[] = [];
    const tall = styleframe(1080, 1920, renders);
    const wide = styleframe(1920, 1080, renders);
    const r = await run({ title: "x", aspect: "9:16", panels: [{ durationS: 1, source: tall.id }, { durationS: 1, source: wide.id }, { durationS: 1 }] });
    // 216 × 384 at 2x: the tall frame by its width, the wide one by its height (432 / 768 → 1365 wide).
    expect(renders).toEqual([
      { format: "PNG", constraint: { type: "WIDTH", value: 432 } },
      { format: "PNG", constraint: { type: "WIDTH", value: 1365 } },
    ]);
    const ps = panelsOf(r);
    expect((node(ps[0]!.thumbId) as unknown as Any).fills).toEqual([{ type: "IMAGE", imageHash: "img-1-64", scaleMode: "FILL" }]);
    expect((node(ps[1]!.thumbId) as unknown as Any).fills).toEqual([{ type: "IMAGE", imageHash: "img-2-64", scaleMode: "FILL" }]);
    expect(ps.map((p) => [p.image, p.hintId !== undefined])).toEqual([["source", false], ["source", false], [undefined, true]]);
  });

  it("an image already in the file fills its thumbnail by hash", async () => {
    file();
    const r = await run({ title: "x", aspect: "1:1", panels: [{ durationS: 1, image: "hash-known" }] });
    const p = panelsOf(r)[0]!;
    expect((node(p.thumbId) as unknown as Any).fills).toEqual([{ type: "IMAGE", imageHash: "hash-known", scaleMode: "FILL" }]);
    expect(p.image).toBe("image");
  });

  it("a source too large for one image is rendered within 4096 px a side", async () => {
    file();
    const renders: Any[] = [];
    const strip = styleframe(200, 4000, renders);
    await run({ title: "x", aspect: "16:9", thumbWidth: 1080, panels: [{ durationS: 1, source: strip.id }] });
    // Covering 2160 × 1216 needs it 2160 wide and 43200 tall; the cap holds the height to 4096 (204 wide).
    expect(renders).toEqual([{ format: "PNG", constraint: { type: "WIDTH", value: 204 } }]);
  });
});

describe("every refusal comes before the first node", () => {
  const cases: Array<[string, (f: BoardFigma) => Any, string, RegExp]> = [
    ["an unknown source id", () => ({ panels: [{ durationS: 1, source: "77:77" }] }), "NODE_NOT_FOUND", /panels\[0\]\.source`: no node with id `77:77`/],
    ["an unknown image hash", () => ({ panels: [{ durationS: 1 }, { durationS: 1, image: "nope" }] }), "INVALID_PARAM", /panels\[1\]\.image`: no image with hash `nope`/],
    ["source and image together", () => ({ panels: [{ durationS: 1, source: "1:1", image: "hash-known" }] }), "INVALID_PARAM", /both `source` and `image`/],
    ["a pageId that is a frame", (f) => ({ pageId: f.frame().id, panels: [{ durationS: 1 }] }), "INVALID_PARAM", /is a FRAME, not a page/],
    ["a source with no area", (f) => {
      const flat = f.frame();
      flat.resize(0, 10);
      (flat as unknown as Any).exportAsync = async () => new Uint8Array(1);
      return { panels: [{ durationS: 1, source: flat.id }] };
    }, "INVALID_PARAM", /has no area to render/],
    ["a source Figma cannot render", (f) => {
      const broken = f.frame();
      (broken as unknown as Any).exportAsync = async () => {
        throw new Error("render failed");
      };
      return { panels: [{ durationS: 1, source: broken.id }] };
    }, "INVALID_PARAM", /could not render .*render failed/],
    ["a source that cannot be exported", (f) => ({ panels: [{ durationS: 1, source: f.frame().id }] }), "INVALID_PARAM", /cannot be rendered to a picture/],
    ["over 600 s", () => ({ panels: Array.from({ length: 11 }, () => ({ durationS: 60 })) }), "INVALID_PARAM", /at most 600 s/],
    ["an unknown caption", () => ({ captions: ["lens"], panels: [{ durationS: 1 }] }), "INVALID_PARAM", /"lens" is not a caption row/],
  ];
  it.each(cases)("%s", async (_label, params, code, message) => {
    file();
    const extra = params(fake);
    const before = fake.log.length;
    const pageKids = fake.currentPage.children.length;
    const e = await refusal(run({ title: "x", aspect: "9:16", ...extra }));
    expect(e.code).toBe(code);
    expect(e.message).toMatch(message);
    expect(e.partial).toEqual({ created: [] });
    expect(fake.log.slice(before).filter((l) => l.startsWith("create"))).toEqual([]);
    expect(fake.currentPage.children.length).toBe(pageKids);
  });

  it("a cancel while rendering the snapshots stops before the build", async () => {
    file();
    const a = styleframe(100, 100);
    const b = styleframe(100, 100);
    let asked = 0;
    const e = await refusal(run({ title: "x", aspect: "1:1", panels: [{ durationS: 1, source: a.id }, { durationS: 1, source: b.id }] }, { isCancelled: () => ++asked > 1 }));
    expect(e.code).toBe("CANCELLED");
    expect(e.partial).toEqual({ created: [] });
    expect(fake.log.filter((l) => l.startsWith("create"))).toEqual([]);
  });

  it("a failure after the build names what exists", async () => {
    file();
    const original = proto.setSharedPluginData;
    proto.setSharedPluginData = () => {
      throw new Error("no plugin data today");
    };
    try {
      const e = await refusal(run(BRIEF));
      expect(e.message).toMatch(/The board was built, but writing the storyboard record failed: no plugin data today/);
      const partial = e.partial as { created: Array<{ id: string }>; failedAt: string };
      expect(partial.failedAt).toBe("writing the storyboard record");
      expect(partial.created.length).toBeGreaterThan(40);
      expect(node(partial.created[0]!.id)!.name).toBe("Storyboard / Kiln end card");
    } finally {
      proto.setSharedPluginData = original;
    }
  });
});

describe("the file's text styles", () => {
  it("a role takes a local style that fits and whose font loads; one whose font will not load is left out", async () => {
    file();
    fake.textStyles = [
      { id: "S:body,", name: "Body/Small", fontSize: 13, fontName: { family: "Inter", style: "Regular" } },
      { id: "S:ghost,", name: "Ghost/Label", fontSize: 11, fontName: { family: "Ghost Sans", style: "Bold" } },
    ];
    const r = await run(BRIEF);
    expect(r.textStyles).toEqual({ meta: "Body/Small", value: "Body/Small", hint: "Body/Small" });
    const p = panelsOf(r)[0]!;
    expect((node(p.captionIds.duration!) as unknown as Any).textStyleId).toBe("S:body,");
    expect((node(p.hintId!) as unknown as Any).textStyleId).toBe("S:body,");
  });

  it("a file without styles keeps the board's own sizes", async () => {
    file();
    const r = await run(BRIEF);
    expect(r.textStyles).toBeUndefined();
    expect((node(panelsOf(r)[0]!.captionIds.duration!) as unknown as Any).fontSize).toBe(13);
  });
});

describe("readStoryboard", () => {
  it("reads the durations from the captions as the canvas shows them now", async () => {
    file();
    const r = await run(BRIEF);
    const id = r.storyboardId as string;
    const first = await readStoryboard(id);
    expect(first.panels.map((p) => [p.durationS, p.startS, p.from])).toEqual([[1.2, 0, "caption"], [1.8, 1.2, "caption"], [2.4, 3, "caption"]]);
    const ps = panelsOf(r);
    (node(ps[0]!.captionIds.duration!) as unknown as { characters: string }).characters = "2 s";
    const later = await readStoryboard(id);
    expect(later.panels.map((p) => [p.durationS, p.startS, p.endS, p.startFrame])).toEqual([[2, 0, 2, 0], [1.8, 2, 3.8, 60], [2.4, 3.8, 6.2, 114]]);
    expect(later).toMatchObject({ durationS: 6.2, durationFrames: 186, captionConflicts: [] });
  });

  it("a caption that does not parse is a conflict; a deleted one is tolerated", async () => {
    file();
    const r = await run(BRIEF);
    const ps = panelsOf(r);
    (node(ps[1]!.captionIds.duration!) as unknown as { characters: string }).characters = "a beat longer";
    node(ps[2]!.captionIds.duration!)!.remove();
    const read = await readStoryboard(r.storyboardId as string);
    expect(read.panels[1]).toMatchObject({ durationS: 1.8, from: "planned", captionConflict: "a beat longer" });
    expect(read.panels[2]).toMatchObject({ durationS: 2.4, from: "planned", captionMissing: true });
    expect(read.captionConflicts).toEqual([{ index: 2, text: "a beat longer", usedS: 1.8 }]);
  });

  it("a frame that is not a storyboard is refused, naming it", async () => {
    file();
    const f = fake.frame();
    await expect(readStoryboard(f.id)).rejects.toThrow(/is not a storyboard figma_create_storyboard made/);
    await expect(readStoryboard("404:1")).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
  });
});

// ── the server tool ──────────────────────────────────────────────────────────

describe("figma_create_storyboard on the server", () => {
  type Tool = { config: { description: string; inputSchema: Record<string, z.ZodTypeAny> }; handler: (a: Any, e: Extra) => Promise<CallToolResult> };
  const tools: Record<string, Tool> = {};
  const server = { registerTool: (name: string, config: never, handler: never) => void (tools[name] = { config, handler }) } as unknown as McpServer;
  const requests: Array<{ op: string; p: Any }> = [];
  const bridge = {
    request: async (op: string, p: Any) => {
      requests.push({ op, p });
      return { storyboardId: "9:9" };
    },
    statusAsync: async () => ({ sessions: [] }),
  } as unknown as Bridge;
  registerStoryboard(server, bridge, () => true);
  const tool = tools.figma_create_storyboard!;
  const extra = { signal: new AbortController().signal, sendNotification: async () => {}, _meta: {} } as unknown as Extra;

  it("registers its schema and a description that fits the cap with its Editors sentence", () => {
    expect(Object.keys(tool.config.inputSchema)).toEqual([
      "title", "aspect", "fps", "bpm", "beatsPerBar", "panels", "captions", "columns", "thumbWidth", "styleframeWidth", "snap",
      "pageId", "x", "y", "session", "idempotencyKey", "force",
    ]);
    expect(tool.config.description).toMatch(/One undo step\.$/);
    expect(tool.config.description.length + editorsSuffix("create_storyboard").length).toBeLessThanOrEqual(1024);
  });

  it("stays inside the portable schema subset, panels strict", () => {
    const json = JSON.stringify(z.toJSONSchema(z.object(STORYBOARD_SHAPE).strict(), { io: "input" }));
    for (const banned of ['"anyOf"', '"oneOf"', '"allOf"', '"const"', '"format"', '"$ref"', '"propertyNames"']) expect(json).not.toContain(banned);
    expect(panelEntry.safeParse({ durationS: 1, dialogue: "hi" }).success).toBe(false);
    expect(STORYBOARD_SHAPE.aspect.safeParse("21:9").success).toBe(false);
  });

  it("refuses a plan it cannot build before the bridge is asked", async () => {
    const res = await tool.handler({ title: "x", aspect: "9:16", panels: [{ durationS: 1, source: "1:2", image: "h" }] }, extra);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
    expect(requests).toEqual([]);
  });

  it("forwards the call with each panel's source as an id the plugin resolves", async () => {
    await tool.handler({ title: "x", aspect: "9:16", panels: [{ durationS: 1, source: "12-34" }, { durationS: 1 }], pageId: "0-1" }, extra);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.op).toBe("create_storyboard");
    expect(requests[0]!.p).toMatchObject({ pageId: "0:1", panels: [{ durationS: 1, source: "12:34" }, { durationS: 1 }] });
  });

  it("is not registered unless the toolset wants it", () => {
    const names: string[] = [];
    registerStoryboard({ registerTool: (n: string) => void names.push(n) } as unknown as McpServer, {} as Bridge, () => false);
    expect(names).toEqual([]);
  });
});
