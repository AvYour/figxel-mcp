// A Figma Slides deck on top of test/editor-fakes.ts: the SLIDE_GRID →
// SLIDE_ROW → SLIDE tree, and the members whose behaviour the sources disagree
// on, each switchable so a test can pin the code against both sides:
//
//   - speakerNotes: absent by default, as in plugin-typings 1.141.0; present
//     (a markdown string, "" when empty) as the official skill reads it [C-138];
//   - transitions: working, or throwing "not implemented" as the official
//     notes say [C-139];
//   - the view: canvasView / slidesView / slidesMode, each present, absent,
//     throwing, or ignoring writes [C-140];
//   - setSlideGrid / setCanvasGrid: every current slide must come back
//     (d.ts:2048-2049), and an emptied row is kept or pruned [C-164].
//
// Every write to the grid is logged, so a test proves a refusal never reached it.

import { FakeContainer, FakeFigma, FakeNode, FakeSlide, FakeSlideRow, makeOpaque, noSuchProperty, solid } from "./editor-fakes.js";

export type ViewMode = "ok" | "absent" | "throws" | "ignores";

export interface DeckOptions {
  /** Slides per row to start with; [] (the default) is a new, empty deck. */
  rows?: number[];
  /** speakerNotes on every slide (default false: the typings have none) [C-138]. */
  notes?: boolean;
  /** "not-implemented" makes getSlideTransition / setSlideTransition throw (default "works") [C-139]. */
  transitions?: "works" | "not-implemented";
  /** Which grid calls exist: both (default), only the deprecated getSlideGrid/setSlideGrid, or none. */
  gridApi?: "both" | "slide" | "none";
  /** Remove a row that a grid write leaves empty (default false: Figma keeps it, slide-lifecycle.md:58) [C-164]. */
  pruneEmptyRows?: boolean;
  /** The view properties (default: canvasView only, as the newest typings) [C-140]. */
  view?: Partial<Record<"canvasView" | "slidesView" | "slidesMode", ViewMode>>;
}

/** The viewport: zoom, scrollAndZoomIntoView, and whichever view properties the options give. */
export class FakeViewport {
  zoom = 1;
  readonly scrolled: string[][] = [];
  readonly viewWrites: Array<[string, unknown]> = [];
  scrollAndZoomIntoView(nodes: ReadonlyArray<{ id: string }>): void {
    this.scrolled.push(nodes.map((n) => n.id));
  }
}

const VIEW_VALUES = { canvasView: ["grid", "single-asset"], slidesView: ["grid", "single-slide"], slidesMode: ["grid", "single-slide"] } as const;

function defineView(viewport: FakeViewport, prop: keyof typeof VIEW_VALUES, mode: ViewMode): void {
  if (mode === "absent") return;
  let value: string = "grid";
  Object.defineProperty(viewport, prop, {
    configurable: true,
    enumerable: true,
    get() {
      if (mode === "throws") throw noSuchProperty(prop, "the viewport");
      return value;
    },
    set(v: string) {
      viewport.viewWrites.push([prop, v]);
      if (mode === "throws") throw noSuchProperty(prop, "the viewport");
      if (mode === "ignores") return;
      if (!(VIEW_VALUES[prop] as readonly string[]).includes(v)) throw new Error(`in set_${prop}: invalid value "${v}"`);
      value = v;
    },
  });
}

/** A text layer as titleOf reads it. */
export function addText(parent: FakeContainer, characters: string, fontSize: number | symbol): FakeNode {
  const t = Object.assign(new FakeNode("TEXT", characters.slice(0, 20), parent.world), { characters, fontSize });
  parent.appendChild(t);
  return t;
}

/** A poll on a slide: opaque, with its kind (d.ts:12359). */
export function addPoll(parent: FakeContainer): FakeNode {
  const n = makeOpaque(Object.assign(new FakeNode("INTERACTIVE_SLIDE_ELEMENT", "Poll", parent.world), { interactiveSlideElementType: "POLL" }));
  parent.appendChild(n);
  return n;
}

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export class FakeDeck extends FakeFigma {
  readonly viewport = new FakeViewport();
  /** Every grid write, as ids per row, with the call that made it. */
  readonly gridWrites: Array<{ via: string; rows: string[][] }> = [];
  readonly exports: string[] = [];
  notes: boolean;
  transitions: "works" | "not-implemented";
  pruneEmptyRows: boolean;

  constructor(opts: DeckOptions = {}) {
    super({ editorType: "slides", fileName: "Deck" });
    this.notes = opts.notes ?? false;
    this.transitions = opts.transitions ?? "works";
    this.pruneEmptyRows = opts.pruneEmptyRows ?? false;
    this.currentPage.focusedSlide = null;
    const view = opts.view ?? { canvasView: "ok" };
    for (const prop of ["canvasView", "slidesView", "slidesMode"] as const) defineView(this.viewport, prop, view[prop] ?? "absent");
    if (opts.gridApi === "slide" || opts.gridApi === "none") this.removed.add("getCanvasGrid").add("setCanvasGrid");
    if (opts.gridApi === "none") this.removed.add("getSlideGrid").add("setSlideGrid");
    (opts.rows ?? []).forEach((n, r) => {
      this.createSlideRow();
      for (let c = 0; c < n; c++) this.createSlide(r, c).name = `Slide ${r}.${c}`;
    });
  }

  get rowsNow(): FakeSlideRow[] {
    return this.grid!.rows;
  }
  /** The grid as ids, read from the tree. */
  ids(): string[][] {
    return this.rowsNow.map((r) => r.slides.map((s) => s.id));
  }
  slide(row: number, col: number): FakeSlide {
    return this.rowsNow[row]!.slides[col]!;
  }

  override createSlide(row?: number, col?: number): FakeSlide {
    const slide = super.createSlide(row, col);
    if (this.notes) {
      let notes = "";
      Object.defineProperty(slide, "speakerNotes", {
        configurable: true,
        enumerable: true,
        get: () => notes,
        set: (v: string) => {
          notes = String(v);
        },
      });
    }
    if (this.transitions === "not-implemented") slide.transitionError = "not implemented";
    const exports = this.exports;
    Object.assign(slide, {
      async exportAsync(settings: { format: string }) {
        exports.push(slide.id);
        return enc(`%${settings.format}:${slide.id}`);
      },
    });
    return slide;
  }

  private write(via: string, rows: FakeSlide[][]): void {
    this.gridWrites.push({ via, rows: rows.map((r) => r.map((s) => s.id)) });
    FakeFigma.prototype.setSlideGrid.call(this, rows);
    if (this.pruneEmptyRows) for (const r of [...this.rowsNow]) if (!r.slides.length) r.remove();
  }
  override setSlideGrid(rows: FakeSlide[][]): void {
    this.write("setSlideGrid", rows);
  }
  override setCanvasGrid(rows: FakeSlide[][]): void {
    this.write("setCanvasGrid", rows);
  }
}

export { solid };
