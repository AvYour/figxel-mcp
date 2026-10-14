// Fakes for FigJam and Slides nodes, and a `figma` global whose editorType can
// be set — the base every editor test builds on. Shaped after
// @figma/plugin-typings 1.141.0 where it matters, because code must survive
// what the real API does:
//
//   - STICKY, SHAPE_WITH_TEXT and CONNECTOR keep their text in a `text`
//     sublayer (TextSublayerNode, d.ts:10403) that has no textAlignHorizontal
//     or textAutoResize; a sticky has no resize and a fixed width (d.ts:11305);
//   - TABLE has cellAt and no children (d.ts:11353); a TABLE_CELL has no id (11442);
//   - CODE_BLOCK keeps `code`, with no font (11581);
//   - SECTION resizes with resizeWithoutConstraints (12285); `resize` is
//     contradicted [C-141], so a test can make it throw;
//   - SLIDE is frame-like; SLIDE_ROW and SLIDE_GRID are opaque, and reading
//     fills / layoutMode / effects on them throws "no such property 'fills' on
//     SLIDE_GRID node" (slide-gotchas.md:192) [C-145];
//   - a new connector's label font does not load and its fills are empty
//     (create-connector.md:109; generate-project-plan SKILL.md:196) [C-148];
//   - on the global, a member can be removed (absent) or made to throw on any
//     touch, `in` included — the "no such property" form [C-145].
//
// Every node a factory creates is parented under currentPage, as in Figma, and
// found by getNodeByIdAsync until it is removed.

import type { OpContext } from "../src/plugin/ops/index.js";

export type FontName = { family: string; style: string };
export const fontKey = (f: FontName) => `${f.family}|${f.style}`;
export const solid = (hex: string) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return { type: "SOLID", color: { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 } };
};

let seq = 1;
const newId = () => `90:${seq++}`;

/** What Figma reports for a member a node does not have. */
export const noSuchProperty = (prop: string, owner: string) => new TypeError(`no such property '${prop}' on ${owner}`);

// ── nodes ───────────────────────────────────────────────────────────────────

export class FakeNode {
  readonly id: string;
  name: string;
  parent: FakeContainer | null = null;
  removed = false;
  x = 0;
  y = 0;
  opacity = 1;
  visible = true;
  locked = false;
  protected w = 100;
  protected h = 100;
  constructor(
    readonly type: string,
    name?: string,
    readonly world?: FakeFigma,
  ) {
    this.id = newId();
    this.name = name ?? type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, " ");
    world?.register(this);
  }
  get width(): number {
    return this.w;
  }
  get height(): number {
    return this.h;
  }
  remove(): void {
    this.parent?.detach(this);
    this.parent = null;
    this.removed = true;
    this.world?.nodes.delete(this.id);
  }
}

export class FakeContainer extends FakeNode {
  children: FakeNode[] = [];
  appendChild(child: FakeNode): void {
    this.insertChild(this.children.length, child);
  }
  insertChild(index: number, child: FakeNode): void {
    child.parent?.detach(child);
    child.parent = this;
    this.children.splice(Math.max(0, Math.min(index, this.children.length)), 0, child);
  }
  detach(child: FakeNode): void {
    this.children = this.children.filter((c) => c !== child);
  }
}

/**
 * The text a sticky, shape or connector holds. `writes` logs the order of
 * writes ("fontName", "characters", "fills") for tests that pin it. With
 * `fontState` "throw" reading fontName throws; with "invalid" it reads but
 * will not load.
 */
export class FakeTextSublayer {
  private chars = "";
  private font: FontName | symbol = { family: "Inter", style: "Medium" };
  private paint: unknown[] = [solid("#1E1E1E")];
  fontSize = 16;
  fontState: "ok" | "throw" | "invalid" = "ok";
  readonly writes: string[] = [];
  constructor(
    private readonly world?: FakeFigma,
    private readonly owner = "TEXT_SUBLAYER",
  ) {}
  get fontName(): FontName | symbol {
    if (this.fontState === "throw") throw noSuchProperty("fontName", `${this.owner} text`);
    return this.fontState === "invalid" ? { family: "", style: "" } : this.font;
  }
  set fontName(f: FontName | symbol) {
    this.font = f;
    this.fontState = "ok";
    this.writes.push("fontName");
  }
  get characters(): string {
    return this.chars;
  }
  set characters(v: string) {
    if (this.world?.strictFonts) this.world.assertLoaded(this.fontName as FontName);
    this.chars = v;
    this.writes.push("characters");
  }
  get fills(): unknown[] {
    return this.paint;
  }
  set fills(v: unknown[]) {
    this.paint = v;
    this.writes.push("fills");
  }
  getRangeAllFontNames(start: number, end: number): FontName[] {
    const f = this.fontName;
    return end > start && typeof f === "object" ? [f] : [];
  }
  insertCharacters(start: number, characters: string): void {
    this.characters = this.chars.slice(0, start) + characters + this.chars.slice(start);
  }
  deleteCharacters(start: number, end: number): void {
    this.characters = this.chars.slice(0, start) + this.chars.slice(end);
  }
}

export class FakeSticky extends FakeNode {
  readonly text: FakeTextSublayer;
  isWideWidth = false;
  authorVisible = true;
  authorName = "Ada Lovelace";
  fills: unknown[] = [solid("#FFE299")];
  constructor(world?: FakeFigma) {
    super("STICKY", "Sticky", world);
    this.text = new FakeTextSublayer(world, "STICKY");
  }
  // Constant 240, 416 when wide (d.ts:1226) [C-147]; read-only, no resize.
  override get width(): number {
    return this.isWideWidth ? 416 : 240;
  }
  override get height(): number {
    return 240;
  }
}

export class FakeShapeWithText extends FakeNode {
  readonly text: FakeTextSublayer;
  shapeType = "SQUARE";
  fills: unknown[] = [solid("#FFFFFF")];
  strokes: unknown[] = [solid("#1E1E1E")];
  strokeWeight = 2;
  readonly cornerRadius = 0;
  readonly resizes: Array<[number, number]> = [];
  constructor(world?: FakeFigma) {
    super("SHAPE_WITH_TEXT", "Shape", world);
    this.text = new FakeTextSublayer(world, "SHAPE_WITH_TEXT");
    this.w = 208;
    this.h = 208;
  }
  resize(w: number, h: number): void {
    this.resizes.push([w, h]);
    this.w = w;
    this.h = h;
  }
}

export type Endpoint = { position: { x: number; y: number } } | { endpointNodeId: string; magnet: string } | { endpointNodeId: string; position: { x: number; y: number } };

export class FakeConnector extends FakeNode {
  readonly text: FakeTextSublayer;
  readonly textBackground: { fills: unknown[] } = { fills: [] };
  connectorStart: Endpoint = { position: { x: 0, y: 0 } };
  connectorEnd: Endpoint = { position: { x: 100, y: 0 } };
  connectorLineType = "ELBOWED";
  connectorStartStrokeCap = "NONE";
  connectorEndStrokeCap = "ARROW_LINES";
  strokes: unknown[] = [solid("#757575")];
  strokeWeight = 2;
  dashPattern: number[] = [];
  rotation = 0;
  constructor(world?: FakeFigma) {
    super("CONNECTOR", "Connector line", world);
    this.text = new FakeTextSublayer(world, "CONNECTOR");
    this.text.fontState = "invalid";
    this.text.fills = [];
    this.text.writes.length = 0;
  }
}

export class FakeTableCell {
  readonly type = "TABLE_CELL";
  readonly text: FakeTextSublayer;
  fills: unknown[] = [];
  constructor(
    readonly parent: FakeTable,
    world?: FakeFigma,
  ) {
    this.text = new FakeTextSublayer(world, "TABLE_CELL");
  }
  get rowIndex(): number {
    return this.parent.rows.findIndex((r) => r.includes(this));
  }
  get columnIndex(): number {
    return this.parent.rows[this.rowIndex]!.indexOf(this);
  }
}

export class FakeTable extends FakeNode {
  rows: FakeTableCell[][] = [];
  columnWidths: number[] = [];
  rowHeights: number[] = [];
  fills: unknown[] = [solid("#FFFFFF")];
  constructor(numRows = 2, numColumns = 2, world?: FakeFigma) {
    super("TABLE", "Table", world);
    for (let r = 0; r < numRows; r++) this.rows.push(Array.from({ length: numColumns }, () => new FakeTableCell(this, world)));
    this.columnWidths = Array.from({ length: numColumns }, () => 160);
    this.rowHeights = Array.from({ length: numRows }, () => 40);
  }
  get numRows(): number {
    return this.rows.length;
  }
  get numColumns(): number {
    return this.rows[0]?.length ?? 0;
  }
  override get width(): number {
    return this.columnWidths.reduce((a, b) => a + b, 0);
  }
  override get height(): number {
    return this.rowHeights.reduce((a, b) => a + b, 0);
  }
  cellAt(row: number, column: number): FakeTableCell {
    const cell = this.rows[row]?.[column];
    if (!cell) throw new Error(`in cellAt: cell (${row}, ${column}) is out of bounds`);
    return cell;
  }
  insertRow(index: number): void {
    this.rows.splice(index, 0, Array.from({ length: this.numColumns }, () => new FakeTableCell(this, this.world)));
    this.rowHeights.splice(index, 0, 40);
  }
  insertColumn(index: number): void {
    for (const r of this.rows) r.splice(index, 0, new FakeTableCell(this, this.world));
    this.columnWidths.splice(index, 0, 160);
  }
  removeRow(index: number): void {
    this.rows.splice(index, 1);
    this.rowHeights.splice(index, 1);
  }
  removeColumn(index: number): void {
    for (const r of this.rows) r.splice(index, 1);
    this.columnWidths.splice(index, 1);
  }
  moveRow(from: number, to: number): void {
    const [row] = this.rows.splice(from, 1);
    this.rows.splice(to, 0, row!);
  }
  moveColumn(from: number, to: number): void {
    for (const r of this.rows) {
      const [cell] = r.splice(from, 1);
      r.splice(to, 0, cell!);
    }
  }
  resizeRow(index: number, height: number): void {
    this.rowHeights[index] = height;
  }
  resizeColumn(index: number, width: number): void {
    this.columnWidths[index] = width;
  }
}

export class FakeCodeBlock extends FakeNode {
  code = "";
  codeLanguage = "PLAINTEXT";
  constructor(world?: FakeFigma) {
    super("CODE_BLOCK", "Code block", world);
    this.w = 400;
    this.h = 120;
  }
}

export class FakeSection extends FakeContainer {
  fills: unknown[] = [solid("#FFFFFF")];
  sectionContentsHidden = false;
  /** resize() is contradicted for sections [C-141]: set to make it throw, so a test proves it is never called. */
  resizeThrows = false;
  readonly resizes: Array<{ via: "resize" | "resizeWithoutConstraints"; w: number; h: number }> = [];
  constructor(world?: FakeFigma) {
    super("SECTION", "Section", world);
  }
  resizeWithoutConstraints(w: number, h: number): void {
    this.resizes.push({ via: "resizeWithoutConstraints", w, h });
    this.w = w;
    this.h = h;
  }
  resize(w: number, h: number): void {
    if (this.resizeThrows) throw new Error("in resize: sections are resized with resizeWithoutConstraints");
    this.resizes.push({ via: "resize", w, h });
    this.w = w;
    this.h = h;
  }
}

/** The members an opaque node does not have; reading one throws. */
export const OPAQUE_MEMBERS = ["fills", "strokes", "effects", "layoutMode", "cornerRadius", "clipsContent", "opacity", "blendMode"] as const;

/** Make reading each member throw as Figma does on SLIDE_ROW / SLIDE_GRID; the read is logged first. */
export function makeOpaque<T extends FakeNode>(node: T, members: readonly string[] = OPAQUE_MEMBERS): T & { opaqueReads: string[] } {
  const reads: string[] = [];
  for (const m of members) {
    Object.defineProperty(node, m, {
      configurable: true,
      get() {
        reads.push(m);
        throw noSuchProperty(m, `${node.type} node`);
      },
      set() {
        throw noSuchProperty(m, `${node.type} node`);
      },
    });
  }
  return Object.assign(node, { opaqueReads: reads });
}

export type Transition = Record<string, unknown>;

export class FakeSlide extends FakeContainer {
  fills: unknown[] = [solid("#FFFFFF")];
  isSkippedSlide = false;
  layoutMode = "NONE";
  clipsContent = true;
  /** Set to make getSlideTransition / setSlideTransition throw, as the official notes say they may [C-139]. */
  transitionError: string | null = null;
  transition: Transition = { style: "NONE", duration: 0, curve: "EASE_OUT", timing: { type: "ON_CLICK" } };
  constructor(world?: FakeFigma) {
    super("SLIDE", "Slide", world);
    this.w = 1920;
    this.h = 1080;
  }
  getSlideTransition(): Transition {
    if (this.transitionError) throw new Error(this.transitionError);
    return this.transition;
  }
  setSlideTransition(t: Transition): void {
    if (this.transitionError) throw new Error(this.transitionError);
    this.transition = t;
  }
}

export class FakeSlideRow extends FakeContainer {
  constructor(world?: FakeFigma) {
    super("SLIDE_ROW", "Row", world);
    makeOpaque(this);
  }
  get slides(): FakeSlide[] {
    return this.children as FakeSlide[];
  }
}

export class FakeSlideGrid extends FakeContainer {
  constructor(world?: FakeFigma) {
    super("SLIDE_GRID", "Grid", world);
    makeOpaque(this);
  }
  get rows(): FakeSlideRow[] {
    return this.children as FakeSlideRow[];
  }
}

// ── the global ──────────────────────────────────────────────────────────────

export interface FakeFigmaOptions {
  editorType?: string;
  fileName?: string;
}

/**
 * The `figma` global. `global()` is what code sees: a proxy that hides the
 * members in `removed` and throws on any touch of those in `throwing`. A
 * Slides fake starts with the page's one SLIDE_GRID and no rows (an empty deck).
 */
export class FakeFigma {
  editorType: string;
  readonly apiVersion = "1.0.0";
  readonly mixed = Symbol("mixed");
  readonly nodes = new Map<string, FakeNode>();
  readonly root: FakeContainer;
  currentPage: FakeContainer & { focusedSlide?: FakeSlide | null; selection: FakeNode[] };
  readonly grid: FakeSlideGrid | null;
  readonly removed = new Set<string>();
  readonly throwing = new Set<string>();
  /** Setting characters with an unloaded font throws, as in Figma. */
  strictFonts = false;
  readonly loaded = new Set<string>();
  readonly unloadable = new Set<string>();
  readonly fontLoads: FontName[] = [];
  undoCommits = 0;
  readonly posted: unknown[] = [];
  readonly ui: { postMessage(msg: unknown): void; onmessage: ((msg: unknown) => void) | undefined };
  readonly clientStorage = { getAsync: async (_key: string): Promise<unknown> => null, setAsync: async (_key: string, _value: unknown) => {} };
  readonly currentUser = { id: "u-1", name: "Fake User" };

  constructor(opts: FakeFigmaOptions = {}) {
    this.editorType = opts.editorType ?? "figma";
    this.root = new FakeContainer("DOCUMENT", opts.fileName ?? "Fake file", this);
    const page = new FakeContainer("PAGE", "Page 1", this) as FakeFigma["currentPage"];
    page.selection = [];
    Object.assign(page, { on() {}, off() {} });
    this.root.appendChild(page);
    this.currentPage = page;
    this.grid = this.editorType === "slides" ? new FakeSlideGrid(this) : null;
    if (this.grid) page.appendChild(this.grid);
    const posted = this.posted;
    this.ui = { postMessage: (msg) => void posted.push(msg), onmessage: undefined };
  }

  register(node: FakeNode): void {
    this.nodes.set(node.id, node);
  }

  /** What code sees as `figma`. */
  global(): Record<string, unknown> {
    const deny = (prop: string | symbol) => {
      if (typeof prop === "string" && this.throwing.has(prop)) throw noSuchProperty(prop, "the figma global object");
    };
    return new Proxy(this as unknown as Record<string, unknown>, {
      get: (target, prop, receiver) => {
        deny(prop);
        if (typeof prop === "string" && this.removed.has(prop)) return undefined;
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(this) : v;
      },
      has: (target, prop) => {
        deny(prop);
        return typeof prop === "string" && this.removed.has(prop) ? false : Reflect.has(target, prop);
      },
    });
  }

  // fonts and lookup
  async loadFontAsync(font: FontName): Promise<void> {
    this.fontLoads.push(font);
    if (!font.family || this.unloadable.has(fontKey(font))) throw new Error(`The font "${font.family} ${font.style}" could not be loaded`);
    this.loaded.add(fontKey(font));
  }
  assertLoaded(font: FontName): void {
    if (!this.loaded.has(fontKey(font))) throw new Error(`Cannot write to node with unloaded font "${font.family} ${font.style}"`);
  }
  async getNodeByIdAsync(id: string): Promise<FakeNode | null> {
    return this.nodes.get(id) ?? null;
  }
  commitUndo(): void {
    this.undoCommits++;
  }
  showUI(): void {}
  on(): void {}

  // FigJam factories: each lands on the current page, as in Figma.
  private place<T extends FakeNode>(node: T): T {
    this.currentPage.appendChild(node);
    return node;
  }
  createSticky(): FakeSticky {
    return this.place(new FakeSticky(this));
  }
  createShapeWithText(): FakeShapeWithText {
    return this.place(new FakeShapeWithText(this));
  }
  createConnector(): FakeConnector {
    return this.place(new FakeConnector(this));
  }
  createTable(numRows = 2, numColumns = 2): FakeTable {
    return this.place(new FakeTable(numRows, numColumns, this));
  }
  createCodeBlock(): FakeCodeBlock {
    return this.place(new FakeCodeBlock(this));
  }
  createSection(): FakeSection {
    return this.place(new FakeSection(this));
  }

  // Slides: the grid is the page's SLIDE_GRID → SLIDE_ROW → SLIDE tree.
  private needGrid(): FakeSlideGrid {
    if (!this.grid) throw noSuchProperty("createSlide", "the figma global object");
    return this.grid;
  }
  createSlideRow(row?: number): FakeSlideRow {
    const grid = this.needGrid();
    const r = new FakeSlideRow(this);
    grid.insertChild(row ?? grid.children.length, r);
    return r;
  }
  createSlide(row?: number, col?: number): FakeSlide {
    const grid = this.needGrid();
    if (!grid.rows.length) this.createSlideRow();
    const target = grid.rows[row ?? grid.rows.length - 1];
    if (!target) throw new Error(`in createSlide: row ${row} does not exist`);
    const slide = new FakeSlide(this);
    target.insertChild(col ?? target.children.length, slide);
    return slide;
  }
  getSlideGrid(): FakeSlide[][] {
    return this.needGrid().rows.map((r) => [...r.slides]);
  }
  getCanvasGrid(): FakeSlide[][] {
    return this.getSlideGrid();
  }
  /**
   * Every current slide must come back, each once (d.ts:2048-2049); rows are
   * filled to match. Whether Figma prunes a row this empties is unmeasured, so
   * the fake keeps it: a test that needs pruning says so.
   */
  setSlideGrid(rows: FakeSlide[][]): void {
    const grid = this.needGrid();
    const before = new Set(grid.rows.flatMap((r) => r.slides));
    const after = rows.flat();
    if (after.length !== before.size || new Set(after).size !== after.length || !after.every((s) => before.has(s))) {
      throw new Error("in setSlideGrid: every slide in the current grid must be passed back exactly once");
    }
    rows.forEach((slides, i) => {
      const row = grid.rows[i] ?? this.createSlideRow();
      for (const s of slides) row.appendChild(s);
    });
  }
  setCanvasGrid(rows: FakeSlide[][]): void {
    this.setSlideGrid(rows);
  }
}

/** Put `fake.global()` on globalThis as `figma`; returns the undo. */
export function installFigma(fake: FakeFigma): () => void {
  const g = globalThis as unknown as { figma?: unknown };
  const before = g.figma;
  g.figma = fake.global();
  return () => {
    g.figma = before;
  };
}

/** An OpContext for running a plugin op directly. */
export function opContext(params: Record<string, unknown>, extra: Partial<OpContext> = {}): OpContext {
  return {
    requestId: "r-test",
    params,
    yieldToHost: async () => {},
    progress: () => {},
    isCancelled: () => false,
    ...extra,
  };
}
