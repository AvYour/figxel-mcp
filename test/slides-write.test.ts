// The existing write tools in a Figma Slides deck. The deck is a SLIDE_GRID of
// SLIDE_ROWs of SLIDEs; the grid places slides, so x/y, layer order, parent and
// size mean nothing for them [C-134], a slide's copy must end up in a row
// (SlideNode.clone parents it under the page, d.ts:12306-12308) [C-136], and a
// layer positioned before its final append can land 240 px off [C-146].

import { afterEach, describe, expect, it } from "vitest";
import { BridgeError } from "../src/shared/errors.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import { MODIFY_OPS } from "../src/plugin/ops/modify.js";
import { SHAPE_OPS, vectorFromPath } from "../src/plugin/ops/shapes.js";
import { installFigma, opContext, type FakeNode, type FakeSlide, type FakeSlideRow } from "./editor-fakes.js";
import { WriteFigma } from "./write-fakes.js";

let fake: WriteFigma;
let restore: (() => void) | undefined;

function deck(): WriteFigma {
  fake = new WriteFigma({ editorType: "slides" });
  restore = installFigma(fake);
  return fake;
}
afterEach(() => {
  restore?.();
  restore = undefined;
});

type Any = Record<string, unknown>;
const run = (group: Record<string, { run(ctx: ReturnType<typeof opContext>): Promise<unknown> }>, op: string, params: Any) =>
  group[op]!.run(opContext(params)) as Promise<Any>;
async function refusal(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    return e as BridgeError;
  }
  throw new Error("expected a refusal");
}
const items = (r: Any) => r.items as Array<Any & { id: string; ok: boolean; error?: string }>;
const rowOf = (s: FakeSlide) => s.parent as FakeSlideRow;
/** Slides sitting loose on the page, outside every row: what a failed clone must never leave. */
const orphans = () => fake.currentPage.children.filter((c) => c.type === "SLIDE");

// ── clone ───────────────────────────────────────────────────────────────────

describe("figma_clone_node of a slide", () => {
  it("lands in its own row, right after its source, and reports row and column", async () => {
    deck();
    const [a, b] = [fake.slide(), fake.createSlide(0)];
    fake.clonable(a);
    const r = await run(MODIFY_OPS, "clone_node", { nodeId: a.id, name: "Copy" });
    expect(rowOf(a).children.map((c) => c.id)).toEqual([a.id, r.id, b.id]);
    expect(r).toMatchObject({ type: "SLIDE", sourceId: a.id, rowId: rowOf(a).id, row: 0, col: 1, name: "Copy" });
    expect(orphans()).toEqual([]);
  });

  it("with parentId = another row, goes to the end of that row", async () => {
    deck();
    const a = fake.clonable(fake.slide());
    const other = fake.slide();
    const r = await run(MODIFY_OPS, "clone_node", { nodeId: a.id, parentId: rowOf(other).id });
    expect(rowOf(other).children.map((c) => c.id)).toEqual([other.id, r.id]);
    expect(r).toMatchObject({ row: 1, col: 1 });
  });

  it("x/y, or a parent that is not a row, are refused before the copy exists", async () => {
    deck();
    const a = fake.clonable(fake.slide());
    const before = fake.nodes.size;
    const xy = await refusal(run(MODIFY_OPS, "clone_node", { nodeId: a.id, x: 10 }));
    expect(xy.message).toMatch(/A slide has no x\/y of its own/);
    expect(xy.partial).toEqual({ created: [] });
    const frame = fake.frame(a as unknown as Parameters<WriteFigma["frame"]>[0]);
    const into = await refusal(run(MODIFY_OPS, "clone_node", { nodeId: a.id, parentId: frame.id }));
    expect(into.message).toMatch(/A slide's copy goes into a SLIDE_ROW, not a FRAME/);
    expect(fake.nodes.size).toBe(before + 1); // the test's frame only
  });

  it("when Figma will not place the copy in the row, the copy is removed and nothing is reported as made", async () => {
    deck();
    const a = fake.clonable(fake.slide());
    rowOf(a).insertChild = () => {
      throw new Error("in insertChild: slides cannot be moved this way");
    };
    fake.setCanvasGrid = () => {
      throw new Error("in setCanvasGrid: every slide in the current grid must be passed back exactly once");
    };
    const e = await refusal(run(MODIFY_OPS, "clone_node", { nodeId: a.id }));
    expect(e.code).toBe("INVALID_PARAM");
    expect(e.message).toMatch(/insertChild: slides cannot be moved.*grid: in setCanvasGrid/);
    expect(e.partial).toEqual({ created: [] });
    expect(orphans()).toEqual([]);
    expect([...fake.nodes.values()].filter((n) => n.type === "SLIDE")).toHaveLength(1);
  });

  it("falls back to writing the grid back with the copy beside its source (slide-lifecycle.md:40-49)", async () => {
    deck();
    const a = fake.clonable(fake.slide());
    const b = fake.createSlide(0);
    rowOf(a).insertChild = () => {
      throw new Error("in insertChild: refused");
    };
    let written: string[][] = [];
    fake.setCanvasGrid = (rows: FakeSlide[][]) => {
      written = rows.map((r) => r.map((s) => s.id));
      const row = fake.grid!.rows[0]!;
      // The row's own insertChild is the refused one: place through the container's.
      for (const s of rows[0]!) Object.getPrototypeOf(row).insertChild.call(row, row.children.length, s);
    };
    const r = await run(MODIFY_OPS, "clone_node", { nodeId: a.id });
    expect(written).toEqual([[a.id, r.id as string, b.id]]);
    expect(rowOf(a).children.map((c) => c.id)).toContain(r.id);
    expect(orphans()).toEqual([]);
  });

  it("the grid and a row cannot be cloned (SlideGridNode.clone throws, d.ts:12344)", async () => {
    deck();
    const s = fake.slide();
    for (const node of [fake.grid!, rowOf(s)]) {
      const e = await refusal(run(MODIFY_OPS, "clone_node", { nodeId: node.id }));
      expect(e.code).toBe("INVALID_PARAM");
      expect(e.message).toMatch(new RegExp(`A ${node.type} cannot be cloned`));
      expect(e.partial).toEqual({ created: [] });
    }
  });
});

// ── delete ──────────────────────────────────────────────────────────────────

describe("figma_delete_nodes in a deck", () => {
  it("refuses the grid and a row that still holds slides, per item, and deletes the rest", async () => {
    deck();
    const s = fake.slide();
    const loose = fake.frame(s as unknown as Parameters<WriteFigma["frame"]>[0]);
    const r = await run(MODIFY_OPS, "delete_nodes", { nodeIds: [fake.grid!.id, rowOf(s).id, loose.id] });
    const [grid, row, frame] = items(r);
    expect(grid!.error).toMatch(/the SLIDE_GRID is the deck itself/);
    expect(row!.error).toMatch(/still holds 1 slide\(s\): delete them first, or regroup them with figma_set_slide_grid/);
    expect(frame).toEqual({ id: loose.id, ok: true });
    expect(s.removed).toBe(false);
  });

  it("deleting a row's last slide reports the emptied row, which can then be deleted (slide-lifecycle.md:51-58)", async () => {
    deck();
    const s = fake.slide();
    const row = rowOf(s);
    const first = await run(MODIFY_OPS, "delete_nodes", { nodeIds: [s.id] });
    expect(first.emptiedRows).toEqual([row.id]);
    expect(row.removed).toBe(false);
    const second = await run(MODIFY_OPS, "delete_nodes", { nodeIds: [row.id] });
    expect(items(second)[0]).toEqual({ id: row.id, ok: true });
    expect(second.emptiedRows).toBeUndefined();
  });

  it("a slide and then its row in one call: the row is gone, not reported as emptied", async () => {
    deck();
    const s = fake.slide();
    const row = rowOf(s);
    const r = await run(MODIFY_OPS, "delete_nodes", { nodeIds: [s.id, row.id] });
    expect(r.deleted).toBe(2);
    expect(r.emptiedRows).toBeUndefined();
  });
});

// ── what the grid places ────────────────────────────────────────────────────

describe("slides, rows and the grid are placed by the deck", () => {
  it("move, reorder, resize and reparent refuse them per item with the tool that moves slides", async () => {
    deck();
    const s = fake.slide();
    const target = fake.slide();
    const ids = [s.id, rowOf(s).id];
    const moved = await run(MODIFY_OPS, "move_nodes", { nodeIds: ids, x: 10 });
    const reordered = await run(MODIFY_OPS, "reorder_nodes", { nodeIds: ids, position: "front" });
    const reparented = await run(MODIFY_OPS, "reparent_nodes", { nodeIds: [s.id], parentId: target.id });
    for (const r of [moved, reordered, reparented]) {
      for (const item of items(r)) expect(item.error).toMatch(/placed by the deck's grid.*figma_move_slides/);
    }
    const resized = await run(MODIFY_OPS, "resize_nodes", { nodeIds: [s.id], sizing: { horizontal: "FIXED" } });
    expect(items(resized)[0]!.error).toMatch(/a SLIDE is fixed at 1920×1080/);
    expect(s.parent?.type).toBe("SLIDE_ROW");
  });

  it("a row or the grid as a reparent target is refused before anything moves", async () => {
    deck();
    const s = fake.slide();
    const rect = fake.createRectangle();
    for (const target of [rowOf(s), fake.grid!]) {
      const e = await refusal(run(MODIFY_OPS, "reparent_nodes", { nodeIds: [rect.id], parentId: target.id }));
      expect(e.code).toBe("INVALID_PARAM");
      expect(e.partial).toEqual({ created: [] });
    }
    expect(rect.parent?.id).toBe(fake.currentPage.id);
  });
});

// ── creating onto a slide ───────────────────────────────────────────────────

describe("single creates onto a slide [C-146]", () => {
  it("append before x/y: a frame, a text and a rectangle read back exactly where they were asked", async () => {
    deck();
    fake.slideDrift = true;
    const slide = fake.slide();
    const made = [
      await run(CREATE_OPS, "create_frame", { parentId: slide.id, x: 120, y: 80, width: 400, height: 300 }),
      await run(CREATE_OPS, "create_text", { parentId: slide.id, content: "Title", x: 96, y: 64 }),
      await run(CREATE_OPS, "create_rectangle", { parentId: slide.id, x: 10, y: 20, width: 5, height: 5 }),
    ];
    const at = made.map((r) => fake.nodes.get(r.id as string)!).map((n) => [n.parent?.id, n.x, n.y]);
    expect(at).toEqual([[slide.id, 120, 80], [slide.id, 96, 64], [slide.id, 10, 20]]);
  });

  it("with no parentId the rectangle goes onto the focused slide", async () => {
    deck();
    const slide = fake.slide(true);
    const r = await run(CREATE_OPS, "create_rectangle", { width: 5, height: 5 });
    expect(fake.nodes.get(r.id as string)!.parent?.id).toBe(slide.id);
  });
});

describe("a vector built for a slide never parks on the page", () => {
  /** Log every VECTOR the page is handed. */
  function watchPage(): string[] {
    const seen: string[] = [];
    const page = fake.currentPage;
    const insert = page.insertChild.bind(page);
    page.insertChild = (i: number, child: FakeNode) => {
      if (child.type === "VECTOR") seen.push(child.id);
      insert(i, child);
    };
    return seen;
  }

  it("vectorFromPath with a parent appends it straight there, and drops the SVG wrapper", () => {
    deck();
    const slide = fake.slide();
    const seen = watchPage();
    const v = vectorFromPath(fake.global() as never, "M0 0 L10 10", 20, 20, slide as never);
    expect(v.parent?.id).toBe(slide.id);
    expect(seen).toEqual([]);
    expect(fake.currentPage.children.filter((c) => c.type === "FRAME")).toEqual([]);
  });

  it("a spec vector into a slide lands in its parent frame without touching the page, with no drift", async () => {
    deck();
    fake.slideDrift = true;
    const slide = fake.slide();
    const seen = watchPage();
    const r = await run(CREATE_OPS, "create_from_spec", {
      parentId: slide.id,
      spec: { type: "frame", width: 200, height: 200, children: [{ type: "vector", path: "M0 0 L10 10", x: 50, y: 60 }] },
    });
    const vector = fake.nodes.get((r.created as Array<{ id: string }>)[1]!.id)!;
    expect(vector.parent?.id).toBe(r.rootId);
    expect([vector.x, vector.y]).toEqual([50, 60]);
    expect(seen).toEqual([]);
    expect(r.drift).toEqual([]);
  });

  it("figma_create_vector into a slide reads back where it was asked", async () => {
    deck();
    fake.slideDrift = true;
    const slide = fake.slide();
    const r = await run(SHAPE_OPS, "create_vector", { parentId: slide.id, path: "M0 0 L10 10", x: 30, y: 40 });
    const v = fake.nodes.get(r.id as string)!;
    expect([v.parent?.id, v.x, v.y]).toEqual([slide.id, 30, 40]);
  });
});

describe("create_from_spec in a deck", () => {
  it("a section, which Slides cannot create (Working in Slides) [C-134], is refused before the first node", async () => {
    deck();
    fake.removed.add("createSection");
    const slide = fake.slide();
    const before = fake.nodes.size;
    const r = refusal(run(CREATE_OPS, "create_from_spec", {
      parentId: slide.id,
      spec: { type: "frame", width: 100, height: 100, children: [{ type: "section", name: "Zone" }] },
    }));
    const e = await r;
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toMatch(/`spec.children\[0\]` \(section\): this Figma Slides file has no figma.createSection/);
    expect(e.partial).toEqual({ created: [], failedAt: "spec.children[0]" });
    expect(fake.nodes.size).toBe(before);
  });

  it("bullets are one text with `list`, built on the slide without drift (slide-content.md:28-53)", async () => {
    deck();
    fake.slideDrift = true;
    const slide = fake.slide();
    const r = await run(CREATE_OPS, "create_from_spec", {
      parentId: slide.id,
      spec: JSON.stringify([{ type: "text", content: "One\nTwo", list: "unordered", x: 96, y: 300 }]),
    });
    const t = fake.nodes.get((r.rootIds as string[])[0]!) as unknown as { lists: unknown[]; x: number; y: number };
    expect(t.lists).toEqual([[0, 7, "UNORDERED"]]);
    expect([t.x, t.y]).toEqual([96, 300]);
    expect(r.drift).toEqual([]);
  });
});
