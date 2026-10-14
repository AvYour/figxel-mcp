// figma_check_layout on a slide and on a board.
//
// A slide: the official batch validator's bounds check (slide-gotchas.md:241-301)
// [C-155] — content wholly off the slide, a bleed (deliberate, so info), and
// text the slide's edge cuts — with the opaque grid and rows never read [C-136].
// A board, with audit "board": the official board rules [C-156] [C-159] [C-160].

import { afterEach, describe, expect, it } from "vitest";
import { CHECK_OPS } from "../src/plugin/ops/check.js";
import { FakeContainer, FakeFigma, FakeNode, FakeSlide, installFigma, opContext, solid } from "./editor-fakes.js";

type Any = Record<string, unknown>;
type Issue = { kind: string; severity: string; name: string; nodeId: string; detail: string };
const check = async (params: Any) => (await CHECK_OPS.check_layout!.run(opContext(params))) as Any & { issues: Issue[]; counts: Record<string, number> };
const kinds = (issues: Issue[], only?: RegExp) => issues.filter((i) => !only || only.test(i.kind)).map((i) => `${i.kind}:${i.name}`).sort();
const reads = (n: unknown) => (n as { opaqueReads: string[] }).opaqueReads;

/** Give a fake its page box: absoluteBoundingBox. */
function at<T extends FakeNode>(node: T, x: number, y: number, w?: number, h?: number): T {
  Object.defineProperty(node, "absoluteBoundingBox", { configurable: true, get: () => ({ x, y, width: w ?? node.width, height: h ?? node.height }) });
  return node;
}

function text(world: FakeFigma, name: string, chars: string, fill = "#1E1E1E"): FakeNode {
  return Object.assign(new FakeNode("TEXT", name, world), { characters: chars, fontSize: 24, fills: [solid(fill)], textAutoResize: "NONE" });
}

function frame(world: FakeFigma, name: string): FakeContainer {
  return Object.assign(new FakeContainer("FRAME", name, world), { fills: [], layoutMode: "NONE" });
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("on a slide", () => {
  function deck() {
    const fake = new FakeFigma({ editorType: "slides" });
    restore = installFigma(fake);
    const slide = at(fake.createSlide(), 0, 0);
    slide.name = "Market";
    return { fake, slide };
  }

  it("out_of_slide, bleed and text_cut_by_slide — and no generic clipped finding", async () => {
    const { fake, slide } = deck();
    const add = <T extends FakeNode>(parent: FakeContainer, n: T) => (parent.appendChild(n), n);
    add(slide, at(text(fake, "Cut title", "Total addressable market"), 1800, 100, 300, 60));
    add(slide, at(Object.assign(new FakeNode("RECTANGLE", "Bleed shape", fake), { fills: [solid("#2563EB")] }), -100, 900, 400, 300));
    const off = add(slide, at(frame(fake, "Off slide"), 2000, 0, 200, 200));
    add(off, at(text(fake, "Lost note", "never shows"), 2010, 10, 50, 20));
    const bleeding = add(slide, at(frame(fake, "Bleeding card"), 1700, 500, 400, 200));
    add(bleeding, at(text(fake, "Cut caption", "Revenue by region"), 1850, 520, 200, 40));
    add(slide, at(text(fake, "Fine", "Inside the slide"), 100, 100, 400, 60));

    const r = await check({ nodeId: slide.id });
    expect(kinds(r.issues, /slide|bleed|clipped|outside_parent/)).toEqual([
      "bleed:Bleed shape",
      "bleed:Bleeding card",
      "out_of_slide:Off slide",
      "text_cut_by_slide:Cut caption",
      "text_cut_by_slide:Cut title",
    ]);
    const sev = Object.fromEntries(r.issues.map((i) => [i.kind, i.severity]));
    expect(sev).toMatchObject({ out_of_slide: "warning", bleed: "info", text_cut_by_slide: "error" });
    expect(r.issues.find((i) => i.name === "Cut title")!.detail).toMatch(/180 px right past the edge of the slide "Market"/);
    expect(r.issues.find((i) => i.kind === "out_of_slide")!.detail).toMatch(/at 2000, 0 on a 1920 × 1080 slide/);
  });

  it("slides side by side in a row are a deck, not a stack — and the rows are never read", async () => {
    const { fake } = deck();
    at(fake.createSlide(), 1000, 0); // overlapping the first: still not a finding
    const r = await check({ nodeId: fake.currentPage.id });
    expect(r.checked).toBe(5); // page, grid, row, two slides
    expect(kinds(r.issues, /sibling_overlap/)).toEqual([]);
    expect([...reads(fake.grid), ...reads(fake.grid!.rows[0])]).toEqual([]);
  });

  it("the contrast backdrop is the slide's fill, and the search stops at the slide", async () => {
    const { fake, slide } = deck();
    slide.appendChild(at(text(fake, "Faint", "Barely there", "#EEEEEE"), 100, 100, 400, 60));
    const r = await check({ nodeId: slide.id });
    expect(r.issues.find((i) => i.kind === "low_contrast")!.detail).toMatch(/#eeeeee on #ffffff/);
    // A slide with no fill: the search does not climb into the opaque row.
    slide.fills = [];
    const r2 = await check({ nodeId: slide.id });
    expect(kinds(r2.issues, /low_contrast/)).toEqual([]);
    expect([...reads(fake.grid), ...reads(fake.grid!.rows[0])]).toEqual([]);
  });

  it("nodeIds checks a batch of slides in one call; nodeId and nodeIds together are refused", async () => {
    const { fake, slide } = deck();
    const second: FakeSlide = at(fake.createSlide(), 2000, 0);
    const r = await check({ nodeIds: [slide.id, second.id] });
    expect(r).toMatchObject({ scope: "nodeIds", roots: [{ id: slide.id }, { id: second.id }] });
    await expect(check({ nodeId: slide.id, nodeIds: [second.id] })).rejects.toMatchObject({ code: "INVALID_PARAM" });
    await expect(check({ nodeIds: Array.from({ length: 101 }, () => slide.id) })).rejects.toMatchObject({ code: "INVALID_PARAM" });
  });
});

describe("on a board, audit board", () => {
  function board() {
    const fake = new FakeFigma({ editorType: "figjam" });
    restore = installFigma(fake);
    return fake;
  }

  it("section_overflow, sticky_overlap, dangling_connector, label_too_long, text_not_charcoal, section_name_duplicate", async () => {
    const fake = board();
    const zone = at(fake.createSection(), 0, 0, 1000, 600);
    zone.name = "Ideas";
    zone.resizeWithoutConstraints(1000, 600);
    const twin = at(fake.createSection(), 1200, 0, 400, 400);
    twin.name = "Ideas";
    const wrapper = at(fake.createSection(), -100, -100, 3000, 1000);
    wrapper.name = "Board";
    wrapper.appendChild(zone);
    wrapper.appendChild(twin);
    const a = at(fake.createSticky(), 40, 40);
    const b = at(fake.createSticky(), 200, 100);
    const c = at(fake.createSticky(), 900, 500);
    for (const s of [a, b, c]) zone.appendChild(s);
    const gone = at(fake.createConnector(), 300, 400, 200, 0);
    gone.connectorStart = { endpointNodeId: a.id, magnet: "AUTO" };
    gone.connectorEnd = { endpointNodeId: "90:99999", magnet: "AUTO" };
    gone.text.characters = "this label goes on far longer than a few words do";
    zone.appendChild(gone);
    const grey = at(text(fake, "Grey note", "Context", "#757575"), 40, 320, 200, 30);
    const charcoal = at(text(fake, "Heading", "Ideas", "#1E1E1E"), 40, 360, 200, 30);
    zone.appendChild(grey);
    zone.appendChild(charcoal);

    const r = await check({ nodeId: wrapper.id, audit: ["board"] });
    expect(kinds(r.issues, /section_|sticky_|dangling|label_too|charcoal|outside_parent|zero_size/)).toEqual([
      "dangling_connector:Connector line",
      "label_too_long:Connector line",
      "section_name_duplicate:Ideas",
      "section_overflow:Sticky",
      "sticky_overlap:Sticky",
      "text_not_charcoal:Grey note",
    ]);
    const by = (k: string) => r.issues.find((i) => i.kind === k)!;
    expect(by("sticky_overlap").nodeId).toBe(b.id);
    expect(by("section_overflow")).toMatchObject({ nodeId: c.id, severity: "warning" });
    expect(by("dangling_connector")).toMatchObject({ severity: "error" });
    expect(by("dangling_connector").detail).toMatch(/its end is attached to 90:99999, which no longer exists/);

    // Without the audit the same board reports the generic finding, and none of the board rules.
    const plain = await check({ nodeId: wrapper.id });
    expect(kinds(plain.issues, /section_|sticky_|dangling|label_too|charcoal|outside_parent/)).toEqual(["outside_parent:Sticky"]);
  });

  it("off_palette: a sticky, shape or connector paint that is not one of FigJam's swatches for its type [C-156]", async () => {
    const fake = board();
    const zone = at(fake.createSection(), 0, 0, 2000, 1000);
    zone.name = "Zone";
    zone.fills = [solid("#ABCDEF")]; // sections wait for their swatches to be measured [C-144]
    const yellow = at(fake.createSticky(), 40, 40);
    const custom = at(fake.createSticky(), 400, 40);
    custom.name = "Custom sticky";
    custom.fills = [solid("#FFE29A")]; // one channel off yellow is a custom colour
    // A connector blue is not a sticky blue: each type has its own palette.
    const wrongKind = at(fake.createSticky(), 800, 40);
    wrongKind.name = "Connector-blue sticky";
    wrongKind.fills = [solid("#3DADFF")];
    const shape = at(fake.createShapeWithText(), 40, 400);
    shape.name = "Preset shape";
    shape.fills = [solid("#C2E5FF")]; // light-blue preset
    const line = at(fake.createConnector(), 300, 400, 200, 0);
    line.name = "Custom line";
    line.strokes = [solid("#123456")];
    for (const n of [yellow, custom, wrongKind, shape, line]) zone.appendChild(n);

    const r = await check({ nodeId: zone.id, audit: ["board"] });
    expect(kinds(r.issues, /off_palette/)).toEqual(["off_palette:Connector-blue sticky", "off_palette:Custom line", "off_palette:Custom sticky"]);
    const custom1 = r.issues.find((i) => i.name === "Custom sticky")!;
    expect(custom1.severity).toBe("info");
    expect(custom1.detail).toMatch(/is #FFE29A, not one of FigJam's sticky colours/);
    expect(custom1.detail).toMatch(/figma_set_board_properties/);
    // Not part of the plain layout check.
    expect(kinds((await check({ nodeId: zone.id })).issues, /off_palette/)).toEqual([]);
  });

  it("a board of 12 stickies under a title has no covered, collapsed or overlap finding", async () => {
    const fake = board();
    const zone = at(fake.createSection(), 0, 0, 1240, 1000);
    zone.name = "Retro";
    zone.appendChild(at(text(fake, "Title", "What went well"), 40, 40, 600, 60));
    for (let i = 0; i < 12; i++) {
      const s = at(fake.createSticky(), 40 + (i % 4) * 304, 140 + Math.floor(i / 4) * 304);
      s.text.characters = `Note ${i + 1}`;
      zone.appendChild(s);
    }
    const r = await check({ nodeId: zone.id, audit: ["board"] });
    expect(kinds(r.issues, /covered|text_collapsed|overlap|sticky_/)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("a connector never covers text: its ink is the routed line, not its box", async () => {
    const fake = board();
    const zone = at(fake.createSection(), 0, 0, 1000, 600);
    // The label sits across the right edge of the connector's box, painted below it.
    zone.appendChild(at(text(fake, "Note", "Approved by finance"), 380, 90, 160, 30));
    const elbow = at(fake.createConnector(), 0, 0, 400, 200);
    elbow.connectorStart = { position: { x: 0, y: 0 } };
    elbow.connectorEnd = { position: { x: 400, y: 200 } };
    zone.appendChild(elbow);
    const r = await check({ nodeId: zone.id });
    expect(kinds(r.issues, /covered/)).toEqual([]);
  });

  it("a straight connector is not zero-size", async () => {
    const fake = board();
    const line = at(fake.createConnector(), 0, 0, 300, 0);
    line.connectorStart = { position: { x: 0, y: 0 } };
    const r = await check({ nodeId: line.id });
    expect(kinds(r.issues, /zero_size/)).toEqual([]);
  });
});
