// A FigJam board for the board-tool tests, on top of editor-fakes.ts. What it
// adds is what the board tools must survive in the real editor:
//
//   - a sticky grows taller with its text and keeps its width [C-147], so a grid
//     laid out from one measured sticky would overlap;
//   - fonts are strict: writing characters with an unloaded font throws, and a
//     new connector's label font does not load at all [C-148]; so is writing a
//     sticky's, shape's or cell's text fills — the official recipe loads the
//     font before text.fills too (create-table.md:244) [C-163];
//   - a table column cannot shrink below a minimum, and a cell reports its
//     column's width (d.ts:11425-11437, 11464-11466) [C-161];
//   - createText makes the wrap measurer: its height follows its characters,
//     font size and width;
//   - createLinkPreviewAsync resolves to an EMBED or a LINK_UNFURL, or rejects,
//     optionally leaving a node behind [C-162];
//   - a section's resize() can be made to throw, to prove fits never call it [C-141].

import {
  FakeContainer,
  FakeFigma,
  FakeNode,
  FakeSection,
  FakeShapeWithText,
  FakeSticky,
  FakeTable,
  FakeTableCell,
  FakeTextSublayer,
  installFigma,
  type FakeFigmaOptions,
  type FontName,
} from "./editor-fakes.js";

export * from "./editor-fakes.js";

const SUBLAYER_FILLS = Object.getOwnPropertyDescriptor(FakeTextSublayer.prototype, "fills")!;

/** Make writing `t.fills` need its font loaded, as writing its characters does. */
export function strictFills(t: FakeTextSublayer, world?: FakeFigma): FakeTextSublayer {
  Object.defineProperty(t, "fills", {
    configurable: true,
    get: () => SUBLAYER_FILLS.get!.call(t),
    set: (v: unknown[]) => {
      if (world?.strictFonts) world.assertLoaded(t.fontName as FontName);
      SUBLAYER_FILLS.set!.call(t, v);
    },
  });
  return t;
}

/** A sticky whose height follows its text: 22 characters a line square, 40 wide, 24 px a line. */
export class GrowingSticky extends FakeSticky {
  constructor(world?: FakeFigma) {
    super(world);
    strictFills(this.text, world);
  }
  override get height(): number {
    const perLine = this.isWideWidth ? 40 : 22;
    const lines = Math.ceil(this.text.characters.length / perLine);
    return Math.max(240, 48 + lines * 24);
  }
}

/** A table cell that reports its row's height and its column's width. */
export class BoardCell extends FakeTableCell {
  constructor(parent: FakeTable, world?: FakeFigma) {
    super(parent, world);
    strictFills(this.text, world);
  }
  get width(): number {
    return this.parent.columnWidths[this.columnIndex]!;
  }
  get height(): number {
    return this.parent.rowHeights[this.rowIndex]!;
  }
}

/** A table whose columns and rows cannot shrink below a minimum. */
export class BoardTable extends FakeTable {
  static readonly MIN_COLUMN = 80;
  static readonly MIN_ROW = 32;
  constructor(numRows = 2, numColumns = 2, world?: FakeFigma) {
    super(numRows, numColumns, world);
    this.rows = this.rows.map((r) => r.map(() => new BoardCell(this, world)));
  }
  override insertRow(index: number): void {
    this.rows.splice(index, 0, Array.from({ length: this.numColumns }, () => new BoardCell(this, this.world)));
    this.rowHeights.splice(index, 0, 40);
  }
  override insertColumn(index: number): void {
    for (const r of this.rows) r.splice(index, 0, new BoardCell(this, this.world));
    this.columnWidths.splice(index, 0, 160);
  }
  override resizeColumn(index: number, width: number): void {
    this.columnWidths[index] = Math.max(BoardTable.MIN_COLUMN, width);
  }
  override resizeRow(index: number, height: number): void {
    this.rowHeights[index] = Math.max(BoardTable.MIN_ROW, height);
  }
}

/**
 * A TEXT node that wraps: with textAutoResize HEIGHT its height is its line
 * count (0.6 em a character at its width) times 1.2 em.
 */
export class FakeText extends FakeNode {
  private chars = "";
  fontName: FontName = { family: "Inter", style: "Regular" };
  private size = 12;
  textAutoResize = "WIDTH_AND_HEIGHT";
  fills: unknown[] = [];
  constructor(world?: FakeFigma) {
    super("TEXT", "Text", world);
  }
  get characters(): string {
    return this.chars;
  }
  set characters(v: string) {
    if (this.world?.strictFonts) this.world.assertLoaded(this.fontName);
    this.chars = v;
  }
  get fontSize(): number {
    return this.size;
  }
  set fontSize(v: number) {
    if (this.world?.strictFonts) this.world.assertLoaded(this.fontName);
    this.size = v;
  }
  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
  }
  override get height(): number {
    if (this.textAutoResize !== "HEIGHT") return this.h;
    const perLine = Math.max(1, Math.floor(this.w / (this.size * 0.6)));
    return Math.max(1, Math.ceil(this.chars.length / perLine)) * this.size * 1.2;
  }
}

/** An opaque board node a preview inserts. */
export class FakePreview extends FakeNode {
  constructor(
    type: "EMBED" | "LINK_UNFURL",
    readonly url: string,
    world?: FakeFigma,
  ) {
    super(type, type === "EMBED" ? "Embed" : "Link", world);
    this.w = 320;
    this.h = 180;
  }
  get embedData() {
    return this.type === "EMBED" ? { srcUrl: this.url, canonicalUrl: this.url, title: "A video", description: null, provider: "YouTube" } : undefined;
  }
  get linkUnfurlData() {
    return this.type === "LINK_UNFURL" ? { url: this.url, title: "Figma", description: "The collaborative interface design tool", provider: "Figma" } : undefined;
  }
}

/** A plain box of a given size — a stand-in for any child of a section. */
export class FakeBox extends FakeNode {
  constructor(world: FakeFigma | undefined, w: number, h: number, type = "RECTANGLE") {
    super(type, "Box", world);
    this.w = w;
    this.h = h;
  }
}

export type PreviewBehaviour = { kind: "EMBED" | "LINK_UNFURL" } | { error: string; leaveNode?: boolean };

/** The figma global of a FigJam board, strict about fonts. */
export class BoardFigma extends FakeFigma {
  preview: PreviewBehaviour = { kind: "LINK_UNFURL" };
  readonly texts: FakeText[] = [];
  readonly previewCalls: string[] = [];

  constructor(opts: FakeFigmaOptions = {}) {
    super({ editorType: "figjam", fileName: "Retro board", ...opts });
    this.strictFonts = true;
  }

  private land<T extends FakeNode>(node: T): T {
    this.currentPage.appendChild(node);
    return node;
  }
  override createSticky(): GrowingSticky {
    return this.land(new GrowingSticky(this));
  }
  override createShapeWithText(): FakeShapeWithText {
    const shape = super.createShapeWithText();
    strictFills(shape.text, this);
    return shape;
  }
  override createTable(numRows = 2, numColumns = 2): BoardTable {
    return this.land(new BoardTable(numRows, numColumns, this));
  }
  createText(): FakeText {
    const t = this.land(new FakeText(this));
    this.texts.push(t);
    return t;
  }
  async createLinkPreviewAsync(url: string): Promise<FakePreview> {
    this.previewCalls.push(url);
    const b = this.preview;
    if ("error" in b) {
      if (b.leaveNode) this.land(new FakePreview("LINK_UNFURL", url, this));
      throw new Error(b.error);
    }
    return this.land(new FakePreview(b.kind, url, this));
  }

  /** A section on the page (or in `parent`) at a size. */
  section(w = 800, h = 600, parent: FakeContainer = this.currentPage): FakeSection {
    const s = new FakeSection(this);
    parent.appendChild(s);
    s.resizeWithoutConstraints(w, h);
    s.resizes.length = 0;
    return s;
  }
  /** A frame on the page, optionally with auto-layout. */
  frame(layoutMode = "NONE", w = 600, h = 400): FakeContainer & { layoutMode: string } {
    const f = new FakeBoxContainer("FRAME", this, w, h) as FakeContainer & { layoutMode: string };
    f.layoutMode = layoutMode;
    this.currentPage.appendChild(f);
    return f;
  }
}

/** A container with a set size. */
export class FakeBoxContainer extends FakeContainer {
  layoutMode = "NONE";
  constructor(type: string, world: FakeFigma, w: number, h: number) {
    super(type, type.charAt(0) + type.slice(1).toLowerCase(), world);
    this.w = w;
    this.h = h;
  }
}

/** A fresh board installed as `figma`; returns it and the undo. */
export function board(opts: FakeFigmaOptions = {}): { fake: BoardFigma; restore: () => void } {
  const fake = new BoardFigma(opts);
  return { fake, restore: installFigma(fake) };
}
