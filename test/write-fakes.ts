// Design-side nodes on top of test/editor-fakes.ts, for the write tests of the
// editor work (parent rules, the spec builder, text sublayers, Slides rules):
// frames, text with per-character styles, rectangles, and a `figma` whose
// factories log what they do, so a test can pin the ORDER of writes.
//
// Two behaviours are modelled because the code under test must survive them:
//   - in a Slides file, x/y written to a node that is not yet inside a SLIDE
//     lands 240 px off once it is attached (figma-use-slides slide-gotchas.md
//     "Position after appendChild") [C-146] — on with `slideDrift`;
//   - writing `characters` gives the whole text the first character's style,
//     while insertCharacters / deleteCharacters keep the other runs
//     (plugin-api.d.ts:9796-9818).

import { FakeContainer, FakeFigma, FakeNode, FakeSlide, solid, type FakeFigmaOptions, type FontName } from "./editor-fakes.js";

const hasSlideAbove = (node: FakeNode): boolean => {
  for (let p = node.parent; p; p = p.parent) if (p.type === "SLIDE") return true;
  return false;
};

/** x/y as Figma stores them: logged, and shifted by -240 where the Slides trap applies. */
function trackPosition(node: FakeNode, world: WriteFigma): void {
  const at = { x: 0, y: 0 };
  for (const axis of ["x", "y"] as const) {
    Object.defineProperty(node, axis, {
      configurable: true,
      get: () => at[axis],
      set: (v: number) => {
        world.log.push(`${axis} ${node.id}=${v}`);
        at[axis] = world.slideDrift && world.editorType === "slides" && !hasSlideAbove(node) ? v - 240 : v;
      },
    });
  }
}

export class WFrame extends FakeContainer {
  fills: unknown[] = [solid("#FFFFFF")];
  strokes: unknown[] = [];
  strokeWeight = 0;
  cornerRadius = 0;
  rotation = 0;
  clipsContent = true;
  layoutMode = "NONE";
  itemSpacing = 0;
  paddingTop = 0;
  paddingRight = 0;
  paddingBottom = 0;
  paddingLeft = 0;
  primaryAxisSizingMode = "FIXED";
  counterAxisSizingMode = "FIXED";
  layoutAlign = "INHERIT";
  layoutGrow = 0;
  constructor(
    type: string,
    readonly w0: WriteFigma,
  ) {
    super(type, undefined, w0);
    trackPosition(this, w0);
  }
  override insertChild(index: number, child: FakeNode): void {
    if (!this.w0.quiet) this.w0.log.push(`append ${child.id} > ${this.id}`);
    super.insertChild(index, child);
  }
  resize(w: number, h: number): void {
    this.w0.log.push(`resize ${this.id} ${w}x${h}`);
    this.w = w;
    this.h = h;
  }
  resizeWithoutConstraints(w: number, h: number): void {
    this.w0.log.push(`resizeWithoutConstraints ${this.id} ${w}x${h}`);
    this.w = w;
    this.h = h;
  }
}

export class WRect extends FakeNode {
  fills: unknown[] = [solid("#D9D9D9")];
  strokes: unknown[] = [];
  strokeWeight = 0;
  cornerRadius = 0;
  rotation = 0;
  layoutAlign = "INHERIT";
  layoutGrow = 0;
  constructor(
    type: string,
    readonly w0: WriteFigma,
  ) {
    super(type, undefined, w0);
    trackPosition(this, w0);
  }
  resize(w: number, h: number): void {
    this.w0.log.push(`resize ${this.id} ${w}x${h}`);
    this.w = w;
    this.h = h;
  }
}

type Style = { font: FontName; fill: string };

/**
 * A TextNode with one style per character, so a test can tell whether a write
 * kept the runs. `writes` logs "characters" for a wholesale write and
 * "insert" / "delete" for the range edits.
 */
export class WText extends FakeNode {
  private styles: Style[] = [];
  private chars = "";
  private baseFont: FontName = { family: "Inter", style: "Regular" };
  fontSize = 12;
  fills: unknown[] = [solid("#000000")];
  textAlignHorizontal = "LEFT";
  textAutoResize = "WIDTH_AND_HEIGHT";
  lineHeight: unknown = { unit: "AUTO" };
  letterSpacing: unknown = { unit: "PERCENT", value: 0 };
  layoutAlign = "INHERIT";
  layoutGrow = 0;
  rotation = 0;
  readonly writes: string[] = [];
  readonly lists: Array<[number, number, string]> = [];
  readonly indents: Array<[number, number, number]> = [];
  constructor(readonly w0: WriteFigma) {
    super("TEXT", "Text", w0);
    trackPosition(this, w0);
  }
  get fontName(): FontName | symbol {
    const fonts = new Set(this.styles.map((s) => `${s.font.family}|${s.font.style}`));
    if (fonts.size > 1) return this.w0.mixed;
    return this.styles[0]?.font ?? this.baseFont;
  }
  set fontName(f: FontName | symbol) {
    if (typeof f === "symbol") return;
    this.baseFont = f;
    this.styles = this.styles.map((s) => ({ ...s, font: f }));
    this.writes.push("fontName");
  }
  get characters(): string {
    return this.chars;
  }
  set characters(v: string) {
    if (this.w0.strictFonts) this.w0.assertLoaded(this.styles[0]?.font ?? this.baseFont);
    const first: Style = this.styles[0] ?? { font: this.baseFont, fill: "#000000" };
    this.chars = v;
    this.styles = Array.from(v, () => ({ ...first }));
    this.writes.push("characters");
  }
  resize(w: number, h: number): void {
    this.w0.log.push(`resize ${this.id} ${w}x${h}`);
    this.w = w;
    this.h = h;
  }
  /** Give the characters in [start, end) another font: a bold word. */
  styleRange(start: number, end: number, font: FontName): void {
    for (let i = start; i < end; i++) this.styles[i] = { ...this.styles[i]!, font };
  }
  getRangeAllFontNames(start: number, end: number): FontName[] {
    const seen = new Map<string, FontName>();
    for (const s of this.styles.slice(start, end)) seen.set(`${s.font.family}|${s.font.style}`, s.font);
    return seen.size ? [...seen.values()] : [this.baseFont];
  }
  getStyledTextSegments(_fields: string[], start = 0, end = this.chars.length): Array<{ start: number; end: number; characters: string; fontName: FontName }> {
    const out: Array<{ start: number; end: number; characters: string; fontName: FontName }> = [];
    for (let i = start; i < end; i++) {
      const f = this.styles[i]!.font;
      const last = out[out.length - 1];
      if (last && last.fontName.family === f.family && last.fontName.style === f.style) {
        last.end = i + 1;
        last.characters = this.chars.slice(last.start, last.end);
      } else out.push({ start: i, end: i + 1, characters: this.chars[i]!, fontName: f });
    }
    return out;
  }
  insertCharacters(start: number, characters: string, useStyle: "BEFORE" | "AFTER" = "BEFORE"): void {
    if (this.w0.strictFonts) for (const f of this.getRangeAllFontNames(0, this.chars.length)) this.w0.assertLoaded(f);
    const from = useStyle === "AFTER" ? this.styles[start] ?? this.styles[start - 1] : this.styles[start - 1] ?? this.styles[start];
    const style: Style = from ? { ...from } : { font: this.baseFont, fill: "#000000" };
    this.chars = this.chars.slice(0, start) + characters + this.chars.slice(start);
    this.styles.splice(start, 0, ...Array.from(characters, () => ({ ...style })));
    this.writes.push("insert");
  }
  deleteCharacters(start: number, end: number): void {
    this.chars = this.chars.slice(0, start) + this.chars.slice(end);
    this.styles.splice(start, end - start);
    this.writes.push("delete");
  }
  setRangeListOptions(start: number, end: number, value: { type: string }): void {
    this.lists.push([start, end, value.type]);
  }
  setRangeIndentation(start: number, end: number, value: number): void {
    this.indents.push([start, end, value]);
  }
  setRangeFontSize(_s: number, _e: number, v: number): void {
    this.fontSize = v;
  }
  setRangeFills(_s: number, _e: number, v: unknown[]): void {
    this.fills = v;
  }
}

/**
 * A `figma` with the Design factories on top of FakeFigma's FigJam and Slides
 * ones. Each factory places its node on the current page without logging the
 * placement, as Figma does, and logs `create TYPE id`; every later append into
 * a frame-like node, resize and x/y write is logged in order.
 */
export class WriteFigma extends FakeFigma {
  readonly log: string[] = [];
  /** Model the Slides x/y trap [C-146]. */
  slideDrift = false;
  /** Set while a factory places its node, so the placement is not logged as an append. */
  quiet = false;
  readonly fonts: FontName[] = [
    { family: "Inter", style: "Regular" },
    { family: "Inter", style: "Medium" },
    { family: "Inter", style: "Bold" },
  ];

  constructor(opts: FakeFigmaOptions = {}) {
    super(opts);
  }

  /**
   * Every node also gets absoluteTransform, its place on the page: its own x/y
   * plus every parent's up to the page (d.ts:7328), translation only.
   */
  override register(node: FakeNode): void {
    super.register(node);
    Object.defineProperty(node, "absoluteTransform", {
      configurable: true,
      get: () => {
        let x = 0;
        let y = 0;
        for (let n: FakeNode | null = node; n && n.type !== "PAGE" && n.type !== "DOCUMENT"; n = n.parent) {
          x += n.x;
          y += n.y;
        }
        return [[1, 0, x], [0, 1, y]];
      },
    });
  }

  private born<T extends FakeNode>(node: T): T {
    this.log.push(`create ${node.type} ${node.id}`);
    this.quiet = true;
    try {
      this.currentPage.appendChild(node);
    } finally {
      this.quiet = false;
    }
    return node;
  }
  createFrame(): WFrame {
    return this.born(new WFrame("FRAME", this));
  }
  createText(): WText {
    return this.born(new WText(this));
  }
  createRectangle(): WRect {
    return this.born(new WRect("RECTANGLE", this));
  }
  createEllipse(): WRect {
    return this.born(new WRect("ELLIPSE", this));
  }
  createLine(): WRect {
    return this.born(new WRect("LINE", this));
  }
  createPolygon(): WRect {
    return this.born(new WRect("POLYGON", this));
  }
  createStar(): WRect {
    return this.born(new WRect("STAR", this));
  }
  /** One VECTOR inside a FRAME wrapper, as Figma returns a single <path>. */
  createNodeFromSvg(_svg: string): WFrame {
    const frame = this.born(new WFrame("FRAME", this));
    const vector = new WRect("VECTOR", this);
    this.quiet = true;
    frame.appendChild(vector);
    this.quiet = false;
    return frame;
  }
  async listAvailableFontsAsync(): Promise<Array<{ fontName: FontName }>> {
    return this.fonts.map((f) => ({ fontName: f }));
  }
  override async loadFontAsync(font: FontName): Promise<void> {
    if (font.family && !this.fonts.some((f) => f.family === font.family && f.style === font.style) && font.family !== "Inter") {
      this.unloadable.add(`${font.family}|${font.style}`);
    }
    return super.loadFontAsync(font);
  }

  /** A frame placed by the test (not logged), optionally inside `parent`. */
  frame(parent: FakeContainer = this.currentPage): WFrame {
    const f = new WFrame("FRAME", this);
    this.quiet = true;
    parent.appendChild(f);
    this.quiet = false;
    return f;
  }
  /** A slide in a new deck row, focused or not. */
  slide(focus = false): FakeSlide {
    this.createSlideRow();
    const s = this.createSlide();
    if (focus) this.currentPage.focusedSlide = s;
    return s;
  }

  /** A slide that clones as SlideNode.clone does: the copy lands on the current page (d.ts:12306-12308) [C-136]. */
  clonable(slide: FakeSlide): FakeSlide & { clone(): FakeSlide } {
    return Object.assign(slide, {
      clone: () => {
        const copy = new FakeSlide(this);
        copy.name = slide.name;
        copy.isSkippedSlide = slide.isSkippedSlide;
        this.currentPage.appendChild(copy);
        return copy;
      },
    });
  }
}

/** The range setters a sublayer has (NonResizableTextMixin, d.ts:10116-10370), each call logged as [name, start, end, value]. */
export function withRanges<T extends object>(text: T): T & { calls: Array<[string, number, number, unknown]> } {
  const calls: Array<[string, number, number, unknown]> = [];
  const names = [
    "setRangeFontSize", "setRangeFills", "setRangeFontName", "setRangeListOptions", "setRangeIndentation",
    "setRangeTextCase", "setRangeTextDecoration", "setRangeLetterSpacing", "setRangeLineHeight",
  ];
  for (const name of names) {
    (text as Record<string, unknown>)[name] = (s: number, e: number, v: unknown) => void calls.push([name, s, e, v]);
  }
  return Object.assign(text, { calls });
}
