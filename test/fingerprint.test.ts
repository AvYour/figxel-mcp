// The content fingerprint a sign-off records (roles spec §3.2): the same for
// an unchanged subtree, different after an edit of any member the spec lists,
// blind to what is not content (the root's place on the canvas, sub-pixel
// noise, a brief block inside the work), and safe on nodes whose members throw.

import { describe, expect, it } from "vitest";
import { BRIEF_KEY, BRIEF_NAMESPACE } from "../src/shared/roles.js";
import { carriesBrief, fingerprint } from "../src/plugin/fingerprint.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `3:${++seq}`, type, name: type, visible: true, x: 0, y: 0, width: 100, height: 100, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const solid = (hex: string, opacity?: number) => ({
  type: "SOLID",
  color: { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 },
  ...(opacity !== undefined ? { opacity } : {}),
});
const withBrief = (n: N): N =>
  Object.assign(n, { getSharedPluginData: (ns: string, key: string) => (ns === BRIEF_NAMESPACE && key === BRIEF_KEY ? '{"v":1}' : "") });

/** A small card: a frame with auto-layout, a title, a price and an image. */
function card(): { root: N; title: N; price: N; image: N } {
  const title = mk("TEXT", {
    x: 24, y: 24, width: 300, height: 40, characters: "Wood-fired vase", fontName: { family: "Inter", style: "Bold" }, fontSize: 32, fills: [solid("#111111")],
  });
  const price = mk("TEXT", {
    x: 24, y: 80, width: 300, height: 24, characters: "€48", fontName: { family: "Inter", style: "Regular" }, fontSize: 18, fills: [solid("#333333")],
  });
  const image = mk("RECTANGLE", { x: 24, y: 120, width: 300, height: 200, fills: [{ type: "IMAGE", imageHash: "abc123", scaleMode: "FILL" }], cornerRadius: 8 });
  const root = mk("FRAME", {
    x: 1000, y: 500, width: 348, height: 344, fills: [solid("#FFFFFF")], strokes: [solid("#DDDDDD")], strokeWeight: 1, cornerRadius: 16,
    effects: [{ type: "DROP_SHADOW" }], layoutMode: "VERTICAL", itemSpacing: 16, paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24,
  }, [title, price, image]);
  return { root, title, price, image };
}

describe("the fingerprint", () => {
  it("is 8 hex digits, and the same for an unchanged subtree", async () => {
    const { root } = card();
    const a = await fingerprint(root as never);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(await fingerprint(root as never)).toBe(a);
  });

  it("changes for each member the spec lists", async () => {
    const edits: Array<[string, (c: ReturnType<typeof card>) => void]> = [
      ["the type", (c) => void (c.image.type = "ELLIPSE")],
      ["visible", (c) => void (c.price.visible = false)],
      ["a child's x", (c) => void (c.price.x = 30)],
      ["a child's y", (c) => void (c.price.y = 90)],
      ["the width", (c) => void (c.root.width = 400)],
      ["the height", (c) => void (c.title.height = 80)],
      ["the characters", (c) => void (c.title.characters = "Ash-glazed vase")],
      ["the font family", (c) => void (c.title.fontName = { family: "Georgia", style: "Bold" })],
      ["the font style", (c) => void (c.title.fontName = { family: "Inter", style: "Regular" })],
      ["the font size", (c) => void (c.price.fontSize = 20)],
      ["a fill colour", (c) => void (c.root.fills = [solid("#FAFAFA")])],
      ["a fill opacity", (c) => void (c.root.fills = [solid("#FFFFFF", 0.9)])],
      ["a stroke colour", (c) => void (c.root.strokes = [solid("#CCCCCC")])],
      ["the stroke weight", (c) => void (c.root.strokeWeight = 2)],
      ["the corner radius", (c) => void (c.image.cornerRadius = 12)],
      ["the effects count", (c) => void (c.root.effects = [])],
      ["the layout mode", (c) => void (c.root.layoutMode = "HORIZONTAL")],
      ["the gap", (c) => void (c.root.itemSpacing = 20)],
      ["the padding", (c) => void (c.root.paddingLeft = 32)],
      ["an image hash", (c) => void (c.image.fills = [{ type: "IMAGE", imageHash: "def456", scaleMode: "FILL" }])],
      ["a node's id (a replaced layer)", (c) => void (c.image.id = "3:999")],
      ["the order of the children", (c) => void (c.root.children = [c.price, c.title, c.image])],
      ["a child deleted", (c) => void (c.root.children = [c.title, c.price])],
    ];
    seq = 0;
    const base = await fingerprint(card().root as never);
    for (const [what, edit] of edits) {
      seq = 0;
      const c = card();
      expect(await fingerprint(c.root as never), "the fixture rebuilds identically").toBe(base);
      edit(c);
      expect(await fingerprint(c.root as never), what).not.toBe(base);
    }
  });

  it("changes when a layer moves from inside a frame to beside it, at the same walk order", async () => {
    const inner = () => mk("RECTANGLE", { x: 0, y: 0 });
    seq = 100;
    const nested = mk("FRAME", {}, [mk("FRAME", { x: 0, y: 0 }, [inner()])]);
    seq = 100;
    const flat = mk("FRAME", {}, [mk("FRAME", { x: 0, y: 0 }), inner()]);
    expect(await fingerprint(nested as never)).not.toBe(await fingerprint(flat as never));
  });

  it("each run's font counts, read from the styled segments", async () => {
    const segs = (size: number) => () => [
      { start: 0, end: 4, fontName: { family: "Inter", style: "Bold" }, fontSize: 24 },
      { start: 4, end: 9, fontName: { family: "Inter", style: "Regular" }, fontSize: size },
    ];
    seq = 0;
    const a = mk("TEXT", { characters: "Kiln time", fontName: Symbol("mixed"), fontSize: Symbol("mixed"), getStyledTextSegments: segs(16) });
    seq = 0;
    const b = mk("TEXT", { characters: "Kiln time", fontName: Symbol("mixed"), fontSize: Symbol("mixed"), getStyledTextSegments: segs(18) });
    expect(await fingerprint(a as never)).not.toBe(await fingerprint(b as never));
  });

  it("rounds geometry to 0.5 px: sub-pixel noise is not an edit, a visible nudge is", async () => {
    const at = async (width: number) => {
      seq = 0;
      const c = card();
      c.image.width = width;
      return fingerprint(c.root as never);
    };
    expect(await at(300.2)).toBe(await at(300));
    expect(await at(300.3)).not.toBe(await at(300));
  });

  it("leaves out the root's own place on the canvas: moving the deliverable is not an edit of it", async () => {
    seq = 0;
    const c = card();
    const before = await fingerprint(c.root as never);
    c.root.x = -4000;
    c.root.y = 9000;
    expect(await fingerprint(c.root as never)).toBe(before);
  });

  it("skips a brief block inside the work, with its subtree, but never the root", async () => {
    seq = 0;
    const c = card();
    const before = await fingerprint(c.root as never);
    const status = mk("TEXT", { characters: "Status: open — not signed off" });
    const block = withBrief(mk("FRAME", { x: 0, y: 400 }, [status]));
    block.parent = c.root;
    c.root.children = [...c.root.children!, block];
    expect(carriesBrief(block as never)).toBe(true);
    expect(await fingerprint(c.root as never), "adding the block").toBe(before);
    status.characters = "Status: signed off 2026-10-16";
    expect(await fingerprint(c.root as never), "its status line rewritten").toBe(before);

    // A brief stored on the deliverable itself (nodeId, or a deck's page) still fingerprints the work.
    withBrief(c.root);
    const own = await fingerprint(c.root as never);
    c.title.characters = "Changed";
    expect(await fingerprint(c.root as never)).not.toBe(own);
  });

  it("survives members that throw and a slide grid it must not read", async () => {
    const throwing = (n: N, keys: string[]) => {
      for (const k of keys) {
        Object.defineProperty(n, k, {
          get() {
            throw new TypeError(`no such property '${k}' on ${n.type} node`);
          },
        });
      }
      return n;
    };
    const slide = mk("SLIDE", { fills: [solid("#FFFFFF")] }, [mk("TEXT", { characters: "Hook" })]);
    const row = throwing(mk("SLIDE_ROW", {}, [slide]), ["fills", "strokes", "effects", "layoutMode", "cornerRadius"]);
    const grid = throwing(mk("SLIDE_GRID", {}, [row]), ["fills", "strokes", "effects", "layoutMode", "cornerRadius"]);
    const page = mk("PAGE", {}, [grid]);
    const a = await fingerprint(page as never);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    (slide.children![0] as N).characters = "Hook, rewritten";
    expect(await fingerprint(page as never)).not.toBe(a);
  });

  it("gives the editor a turn on a long walk", async () => {
    const root = mk("FRAME", {}, Array.from({ length: 1200 }, () => mk("RECTANGLE")));
    let turns = 0;
    await fingerprint(root as never, { yieldToHost: async () => void turns++ });
    expect(turns).toBe(2);
  });
});
