// The storyboard planner (src/shared/storyboard.ts), with no canvas: timing
// derived from the panels' durations — frame k at k / fps [C-193], bar.beat
// from the tempo [C-244] — the read-time list [C-241], the layout per aspect,
// every refusal, the record reader, and the compiled board passing the real
// create_from_spec parser on both sides of the bridge.

import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import {
  barBeat,
  compileStoryboardSpec,
  countWords,
  frameAt,
  matchTextStyles,
  parseDurationCaption,
  parseStoryboardRecord,
  planStoryboard,
  readStoryboardTiming,
  readTimeS,
  storyboardRecord,
  timecode,
  type StoryboardPlan,
  type TextStyleInfo,
} from "../src/shared/storyboard.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import { parseSpecParam } from "../src/server/tools/create.js";
import { installFigma, opContext, type FakeNode } from "./editor-fakes.js";
import { WriteFigma } from "./write-fakes.js";

type Any = Record<string, unknown>;

function refusal(params: Any): BridgeError {
  try {
    planStoryboard(params);
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    expect((e as BridgeError).code).toBe("INVALID_PARAM");
    return e as BridgeError;
  }
  throw new Error("expected planStoryboard to refuse");
}

const panels = (n: number, durationS: number, extra: Any = {}) => Array.from({ length: n }, () => ({ durationS, ...extra }));

describe("timing", () => {
  it("12 two-beat panels at 100 BPM and 30 fps land on the run's grid: 18 frames a beat, 6 bars, 14.4 s", () => {
    const plan = planStoryboard({ title: "End card", aspect: "9:16", bpm: 100, panels: panels(12, 1.2) });
    expect(plan.panels.map((p) => p.startFrame)).toEqual([0, 36, 72, 108, 144, 180, 216, 252, 288, 324, 360, 396]);
    expect(plan.panels.map((p) => p.endFrame)).toEqual([36, 72, 108, 144, 180, 216, 252, 288, 324, 360, 396, 432]);
    expect(plan.panels.map((p) => p.bar)).toEqual(["1.1", "1.3", "2.1", "2.3", "3.1", "3.3", "4.1", "4.3", "5.1", "5.3", "6.1", "6.3"]);
    expect(plan.panels[3]).toMatchObject({ startS: 3.6, endS: 4.8, durationS: 1.2 });
    expect(plan).toMatchObject({ durationS: 14.4, durationFrames: 432, offBeat: [], snapped: [] });
    expect(plan.tempoNote).toBeUndefined();
    expect(plan.panels[3]!.text.timecode).toBe("0:03.6 → 0:04.8 · f108 → f144 · bar 2.3");
    expect(plan.panels[3]!.text.duration).toBe("1.2 s · 36 f");
  });

  it("a panel that starts between beats is listed with its nearest beat and the offset in frames", () => {
    const plan = planStoryboard({ title: "x", aspect: "9:16", bpm: 100, panels: [{ durationS: 1.25 }, { durationS: 1.2 }, { durationS: 1 }] });
    // 1.25 s is 37.5 frames: snapped to 38, so panel 2 starts 2 frames after beat 1.3 (frame 36).
    expect(plan.snapped).toEqual([{ index: 1, from: 1.25, to: 1.2667 }]);
    expect(plan.offBeat).toEqual([
      { index: 2, startS: 1.2667, nearestBeat: "1.3", offsetFrames: 2 },
      { index: 3, startS: 2.4667, nearestBeat: "2.1", offsetFrames: 2 },
    ]);
  });

  it("snap frame rounds each duration to whole frames and reports the change", () => {
    const plan = planStoryboard({ title: "x", aspect: "1:1", panels: [{ durationS: 0.95 }, { durationS: 2 }] });
    expect(plan.snapped).toEqual([{ index: 1, from: 0.95, to: 0.9667 }]);
    expect(plan.panels.map((p) => [p.startFrame, p.endFrame])).toEqual([[0, 29], [29, 89]]);
    expect(plan.durationFrames).toBe(89);
  });

  it("snap beat rounds to whole beats; snap none keeps the durations and quantises only the frames", () => {
    const beat = planStoryboard({ title: "x", aspect: "1:1", bpm: 100, snap: "beat", panels: [{ durationS: 1 }, { durationS: 0.5 }] });
    expect(beat.panels.map((p) => [p.startS, p.endS])).toEqual([[0, 1.2], [1.2, 1.8]]);
    expect(beat.snapped).toEqual([{ index: 1, from: 1, to: 1.2 }, { index: 2, from: 0.5, to: 0.6 }]);
    const none = planStoryboard({ title: "x", aspect: "1:1", snap: "none", panels: [{ durationS: 0.95 }, { durationS: 1 }] });
    expect(none.snapped).toEqual([]);
    expect(none.panels.map((p) => [p.startS, p.endS, p.startFrame, p.endFrame])).toEqual([[0, 0.95, 0, 29], [0.95, 1.95, 29, 59]]);
    expect(none.panels[0]!.text.duration).toBe("0.95 s · 29 f");
  });

  it("a tempo whose beat is not a whole number of frames comes with a note", () => {
    expect(planStoryboard({ title: "x", aspect: "1:1", bpm: 128, panels: panels(1, 1) }).tempoNote).toMatch(/128 BPM one beat is 14.06 frames at 30 fps/);
    expect(planStoryboard({ title: "x", aspect: "1:1", bpm: 120, panels: panels(1, 1) }).tempoNote).toBeUndefined();
  });

  it("frame, bar.beat and timecode helpers", () => {
    expect(frameAt(1.5, 30)).toBe(45);
    expect(frameAt(1.2667, 30)).toBe(39); // 38.001: the first frame at or after the cut
    expect(frameAt(38 / 30, 30)).toBe(38);
    expect(barBeat(0, 4)).toBe("1.1");
    expect(barBeat(6, 4)).toBe("2.3");
    expect(barBeat(7, 3)).toBe("3.2");
    expect(timecode(3.6)).toBe("0:03.6");
    expect(timecode(75.25)).toBe("1:15.3");
    expect(timecode(59.97)).toBe("1:00.0");
  });
});

describe("read time", () => {
  it("copy with too many words for its panel is listed: max(5/6 s, 0.3 s a word)", () => {
    const plan = planStoryboard({
      title: "x",
      aspect: "9:16",
      panels: [
        { durationS: 1.2, onScreen: "Fresh from the kiln every Friday" },
        { durationS: 1.2, onScreen: "Kiln" },
        { durationS: 0.5, onScreen: "Go" },
        { durationS: 1 },
      ],
    });
    expect(plan.readTime).toEqual([
      { index: 1, words: 6, needS: 1.8, haveS: 1.2 },
      { index: 3, words: 1, needS: 0.83, haveS: 0.5 },
    ]);
    expect(plan.panels.map((p) => [p.words, p.readOk])).toEqual([[6, false], [1, true], [1, false], [0, true]]);
  });

  it("numbers count as words; dashes and dots do not", () => {
    expect(countWords("20% off 3 vases")).toBe(4);
    expect(countWords("Kiln — open · daily")).toBe(3);
    expect(countWords("   ")).toBe(0);
    expect(readTimeS(0)).toBe(0);
    expect(readTimeS(2)).toBeCloseTo(5 / 6);
    expect(readTimeS(10)).toBeCloseTo(3);
  });
});

describe("layout per aspect", () => {
  it.each([
    ["9:16", 216, 384, 6, 1080, 1920],
    ["4:5", 288, 360, 5, 1080, 1350],
    ["1:1", 300, 300, 5, 1080, 1080],
    ["16:9", 384, 216, 4, 1920, 1080],
  ])("%s: thumb %i × %i, %i columns, styleframes %i × %i", (aspect, tw, th, cols, sw, sh) => {
    const plan = planStoryboard({ title: "x", aspect, panels: panels(12, 1) });
    expect([plan.thumbWidth, plan.thumbHeight, plan.columns, plan.styleframeWidth, plan.styleframeHeight]).toEqual([tw, th, cols, sw, sh]);
    expect(plan.gridWidth).toBe(cols * tw + (cols - 1) * 48);
    expect(plan.boardWidth).toBe(plan.gridWidth + 128);
  });

  it("fewer panels than columns: the grid is only as wide as they are", () => {
    const plan = planStoryboard({ title: "x", aspect: "9:16", panels: panels(3, 1) });
    expect(plan.columns).toBe(3);
    expect(plan.gridWidth).toBe(3 * 216 + 2 * 48);
  });

  it("captions: timecode and duration, plus every row a panel fills, in the fixed order", () => {
    const plan = planStoryboard({ title: "x", aspect: "9:16", panels: [{ durationS: 1, notes: "n" }, { durationS: 1, onScreen: "Hi", beat: "hook" }] });
    expect(plan.captions).toEqual(["timecode", "duration", "beat", "onScreen", "notes"]);
    expect(plan.panels[0]!.text.onScreen).toBe("—");
    const asked = planStoryboard({ title: "x", aspect: "9:16", captions: ["camera", "duration"], panels: panels(1, 1) });
    expect(asked.captions).toEqual(["duration", "camera"]);
  });
});

describe("refusals, before anything exists", () => {
  it.each<[string, Any, RegExp]>([
    ["49 panels", { panels: panels(49, 1) }, /at most 48/],
    ["over 600 s", { panels: panels(11, 60) }, /660 s; a board plans at most 600 s/],
    ["source and image", { panels: [{ durationS: 1, source: "1:2", image: "abc" }] }, /panels\[0\]` gives both `source` and `image`/],
    ["an unknown caption", { captions: ["timecode", "lens"], panels: panels(1, 1) }, /captions\[1\]` "lens" is not a caption row/],
    ["a filled row the captions leave out", { captions: ["timecode"], panels: [{ durationS: 1 }, { durationS: 1, action: "pan" }] }, /panels\[1\]\.action` is filled, but `captions` leaves out "action"/],
    ["an unknown panel field", { panels: [{ durationS: 1, dialog: "hi" }] }, /panels\[0\]\.dialog` is not a panel field/],
    ["a duration over 60 s", { panels: [{ durationS: 61 }] }, /durationS` must be a number of seconds above 0 and at most 60/],
    ["a zero duration", { panels: [{ durationS: 0 }] }, /durationS`/],
    ["snap beat without bpm", { snap: "beat", panels: panels(1, 1) }, /needs `bpm`/],
    ["beatsPerBar without bpm", { beatsPerBar: 3, panels: panels(1, 1) }, /beatsPerBar` needs `bpm`/],
    // 0.51–0.52 s at 24 fps lies between frames 12 (0.5 s) and 13 (0.5417 s).
    ["a panel between two frames with snap none", { snap: "none", fps: 24, panels: [{ durationS: 0.51 }, { durationS: 0.01 }] }, /panels\[1\]` \(0.01 s\) falls between two frames at 24 fps/],
    ["a bad aspect", { aspect: "21:9", panels: panels(1, 1) }, /aspect` must be one of 9:16, 4:5, 1:1, 16:9/],
    ["a fractional fps", { fps: 29.97, panels: panels(1, 1) }, /fps` must be a whole number from 1 to 60/],
    ["a thumbnail too narrow", { thumbWidth: 40, panels: panels(1, 1) }, /thumbWidth` must be a number from 96 to 1080/],
    ["no panels", { panels: [] }, /at least one panel/],
  ])("%s", (_label, params, message) => {
    const e = refusal({ title: "Board", aspect: "9:16", ...params });
    expect(e.message).toMatch(message);
  });

  it("an empty title is refused", () => {
    expect(refusal({ title: "  ", aspect: "9:16", panels: panels(1, 1) }).message).toMatch(/title` must be 1–120 characters/);
  });

  it("session, idempotencyKey, pageId, x and y ride along untouched", () => {
    expect(() => planStoryboard({ title: "x", aspect: "1:1", panels: panels(1, 1), session: "s", idempotencyKey: "k", pageId: "0:1", x: 0, y: 0 })).not.toThrow();
  });
});

describe("the record reader", () => {
  it("parses the durations a person may leave in the caption", () => {
    expect(parseDurationCaption("1.5 s · 45 f", 30)).toBe(1.5);
    expect(parseDurationCaption("2s", 30)).toBe(2);
    expect(parseDurationCaption("1,5 sec", 30)).toBe(1.5);
    expect(parseDurationCaption("45 f", 30)).toBe(1.5);
    expect(parseDurationCaption("36 frames", 24)).toBe(1.5);
    expect(parseDurationCaption(" .5", 30)).toBe(0.5);
    expect(parseDurationCaption("two seconds", 30)).toBeUndefined();
    expect(parseDurationCaption("0 s", 30)).toBeUndefined();
    expect(parseDurationCaption("—", 30)).toBeUndefined();
  });

  const plan = planStoryboard({ title: "Reel", aspect: "9:16", fps: 24, bpm: 120, panels: [{ durationS: 1 }, { durationS: 2 }, { durationS: 1.5 }] });
  const ids = { panels: plan.panels.map((p) => ({ id: `c${p.index}`, thumbId: `t${p.index}`, captionIds: { duration: `d${p.index}` } })) };

  it("round-trips through the stored JSON, values in the captions first", () => {
    const record = parseStoryboardRecord(JSON.stringify(storyboardRecord(plan, ids)), "1:1");
    expect(record).toMatchObject({ v: 1, title: "Reel", aspect: "9:16", fps: 24, bpm: 120, beatsPerBar: 4 });
    expect(record.panels.map((p) => p.plannedS)).toEqual([1, 2, 1.5]);
    const read = readStoryboardTiming(record, ["1 s · 24 f", "3 s", "1.5 s · 36 f"]);
    expect(read.panels.map((p) => [p.durationS, p.startS, p.endS, p.startFrame, p.endFrame, p.from])).toEqual([
      [1, 0, 1, 0, 24, "caption"],
      [3, 1, 4, 24, 96, "caption"],
      [1.5, 4, 5.5, 96, 132, "caption"],
    ]);
    expect(read).toMatchObject({ durationS: 5.5, durationFrames: 132, captionConflicts: [] });
  });

  it("a caption that no longer parses is a conflict; a missing one is tolerated; the plan stands in for both", () => {
    const record = storyboardRecord(plan, ids);
    const read = readStoryboardTiming(record, ["about a second", undefined, "1.5 s"]);
    expect(read.panels[0]).toMatchObject({ durationS: 1, from: "planned", captionConflict: "about a second" });
    expect(read.panels[1]).toMatchObject({ durationS: 2, from: "planned", captionMissing: true });
    expect(read.panels[1]!.captionConflict).toBeUndefined();
    expect(read.captionConflicts).toEqual([{ index: 1, text: "about a second", usedS: 1 }]);
  });

  it("a node without a record, or with a foreign one, is refused naming it", () => {
    expect(() => parseStoryboardRecord("", "5:5")).toThrow(/`5:5` is not a storyboard figma_create_storyboard made: it carries no storyboard record/);
    expect(() => parseStoryboardRecord("{", "5:5")).toThrow(/not JSON/);
    expect(() => parseStoryboardRecord(JSON.stringify({ v: 2 }), "5:5")).toThrow(/version 2, not 1/);
    expect(() => parseStoryboardRecord(JSON.stringify({ v: 1, fps: 30, panels: [{ id: 1 }] }), "5:5")).toThrow(/panel 1 of its record is malformed/);
  });
});

describe("the file's text styles", () => {
  const style = (name: string, fontSize: number, weight = "Regular"): TextStyleInfo => ({ id: `S:${name},`, name, fontSize, fontName: { family: "Söhne", style: weight } });

  it("a role takes the nearest size of its weight class; a far size or the wrong weight is left alone", () => {
    const m = matchTextStyles([style("Body/Small", 13), style("Body/Base", 16), style("Label/Caps", 11, "Semi Bold"), style("Display", 64, "Bold"), style("Heading/H2", 40, "Medium")]);
    expect(m.value?.name).toBe("Body/Small");
    expect(m.meta?.name).toBe("Body/Base"); // 16 is within 15 % of 15
    expect(m.label?.name).toBe("Label/Caps");
    expect(m.title).toBeUndefined(); // 64 is too far; the 40 is Medium, not strong
    expect(m.hint?.name).toBe("Body/Small"); // 13 is within 1.8 of 12
  });

  it("between two equally near sizes, the name that says what it is for wins", () => {
    const m = matchTextStyles([style("Footer/13", 13), style("Paragraph/13", 13)]);
    expect(m.value?.name).toBe("Paragraph/13");
  });
});

// ── the compiled board against the real builder ──────────────────────────────

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

function compiled(plan: StoryboardPlan) {
  return compileStoryboardSpec(plan, { x: 1000, y: -200 }, {});
}

describe("the compiled spec", () => {
  const plan = planStoryboard({
    title: "Kiln end card",
    aspect: "9:16",
    bpm: 100,
    panels: [
      { durationS: 1.2, title: "Hook", onScreen: "Fired today", styleframe: true },
      { durationS: 1.8, title: "Vase", action: "Push in", source: "1:2" },
      { durationS: 2.4, title: "End card", onScreen: "kiln.shop", styleframe: true },
    ],
  });

  it("is JSON the server's spec parser accepts as an array of roots", () => {
    const roots = parseSpecParam(JSON.stringify(compiled(plan).roots));
    expect(Array.isArray(roots) && roots.length).toBe(3); // the board and two styleframes
  });

  it("builds with the real create_from_spec: a board, a card per panel, styleframes in a row to its right", async () => {
    const fake = new WriteFigma();
    restore = installFigma(fake);
    const c = compiled(plan);
    const r = (await CREATE_OPS.create_from_spec!.run(opContext({ spec: c.roots, pageId: fake.currentPage.id }))) as { refs: Record<string, string>; nodeCount: number; rootIds: string[] };
    const node = (ref: string) => fake.nodes.get(r.refs[ref]!) as FakeNode & Any;
    const board = node("board");
    expect(board.name).toBe("Storyboard / Kiln end card");
    expect([board.x, board.y]).toEqual([1000, -200]);
    expect(board.layoutMode).toBe("VERTICAL");
    const grid = (board as unknown as { children: Array<Any> }).children[1]!;
    expect(grid).toMatchObject({ name: "Panels", layoutMode: "HORIZONTAL", layoutWrap: "WRAP", counterAxisSpacing: 64, itemSpacing: 48, width: plan.gridWidth });
    expect(c.panels.map((p) => node(p.card).name)).toEqual(["Panel 01 · 0:00.0", "Panel 02 · 0:01.2", "Panel 03 · 0:03.0"]);
    const thumb = node(c.panels[0]!.thumb);
    expect([thumb.width, thumb.height, thumb.clipsContent, thumb.layoutMode]).toEqual([216, 384, true, "NONE"]);
    // The snapshot panel gets no "draw here" prompt; the others do, inside their thumbnail.
    expect(c.panels.map((p) => p.hint !== undefined)).toEqual([true, false, true]);
    expect(node(c.panels[0]!.hint!).parent).toBe(thumb);
    expect((node(c.panels[0]!.captions.duration!) as unknown as { characters: string }).characters).toBe("1.2 s · 36 f");
    expect((node(c.panels[1]!.captions.action!) as unknown as { characters: string }).characters).toBe("Push in");
    const [sf1, sf3] = [node(c.panels[0]!.styleframe!), node(c.panels[2]!.styleframe!)];
    expect(c.panels[1]!.styleframe).toBeUndefined();
    expect([sf1.name, sf1.width, sf1.height, sf1.x, sf1.y]).toEqual(["SF 01 · Hook", 1080, 1920, 1000 + plan.boardWidth + 400, -200]);
    expect([sf3.name, sf3.x]).toEqual(["SF 03 · End card", 1000 + plan.boardWidth + 400 + 1080 + 200]);
    expect(r.rootIds).toEqual([board.id, sf1.id, sf3.id]);
  });

  it("a file's text style rides on its role's texts as a style id", () => {
    const c = compileStoryboardSpec(plan, { x: 0, y: 0 }, { value: "S:body," });
    const json = JSON.stringify(c.roots);
    expect(json).toContain('"content":"1.2 s · 36 f","fontSize":13,"weight":"Regular"');
    expect((json.match(/"style":\{"text":"S:body,"\}/g) ?? []).length).toBe(1 + 3 * plan.captions.length); // the legend and every value
  });
});
