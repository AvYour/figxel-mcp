// figma_check_layout under a motion brief judges layout where the viewer sees
// it (defect found live on 2026-10-20; roles spec §3.6, "Motion: where the
// viewer sees it"). A keyed layer's rest pose is one state of the motion, and
// not a frame anyone need see: before a track's first key the first key's
// value holds and the base value never shows [C-191], while a still shows only
// the rest pose [C-116]. So a finding that rests on where a keyed layer sits
// against a layer its keys do not move with it is not made — it is counted in
// `restPose` — and everything else is judged as before: static layers, and
// layers that one key moves together.

import { afterEach, describe, expect, it } from "vitest";
import { BRIEF_KEY, BRIEF_NAMESPACE, type BriefRecord } from "../src/shared/roles.js";
import { CHECK_OPS, checkLayout, restPoseNote, type AuditKind } from "../src/plugin/ops/check.js";
import type { OpContext } from "../src/plugin/ops/index.js";
import { GEAR_PIECE_MOVED, SAFE_AREA, gearPiece, track } from "./motion-piece.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `8:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const solid = (hex: string) => [{ type: "SOLID", color: { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 } }];
const text = (name: string, box: [number, number, number, number], chars: string, size: number, props: Record<string, unknown> = {}) =>
  mk("TEXT", name, box, { characters: chars, fontName: { family: "Inter", style: "Regular" }, fontSize: size, fills: solid("#111111"), ...props });
/** A top-level frame: its parent is a page, so the brief's safe area applies to it. */
const onPage = (root: N) => {
  const page = mk("PAGE", "Showcase", [0, 0, 0, 0], {}, [root]);
  return page;
};

function brief(role: BriefRecord["role"], gear: BriefRecord["gear"]): BriefRecord {
  return {
    v: 1, id: "9:1", role, gear, title: "Gear piece", status: "open", createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-20T08:00:00.000Z",
    lines: { goal: "people remember the gear", message: "Every gear turns for you.", success: ["the tag reads for 2 s"], safeArea: SAFE_AREA },
    details: role === "motion" ? { placement: "feed", durationS: 6, fps: 30 } : {}, deliverables: [],
  };
}
const MOTION = brief("motion", "piece");

const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const check = (root: N, b: BriefRecord | undefined, audit: AuditKind[] = ["craft"]) =>
  checkLayout(root as never, 3000, noYield, { audit: new Set(audit), ...(b ? { brief: b } : {}) });
type Issue = { kind: string; severity: string; name: string; nodeId: string; detail: string };
const kinds = (issues: Issue[]) => [...new Set(issues.map((i) => i.kind))].sort();
const failing = (issues: Issue[]) => issues.filter((i) => i.severity !== "info");

afterEach(() => {
  delete (globalThis as { figma?: unknown }).figma;
});

describe("a multi-scene piece at rest (the live case, frame 4:262)", () => {
  it("judged at rest, as a still is, it reports the stacked scenes, the counter and the parked tag", async () => {
    const p = gearPiece(mk);
    onPage(p.root);
    const r = await check(p.root, brief("graphic", "section"));
    expect(kinds(failing(r.issues))).toEqual(["clipped", "covered", "overlap", "safe_area", "stroke_crosses_text"]);
    expect(r.restPose).toBeUndefined();
  });

  it("under its motion brief, nothing that rests on where keys park a layer is reported, and restPose counts it", async () => {
    const p = gearPiece(mk);
    onPage(p.root);
    const r = await check(p.root, MOTION);
    expect(r.issues).toEqual([]);
    expect(r.restPose).toEqual({
      moved: GEAR_PIECE_MOVED,
      // Scene A under scene B and the ring, its foot under the credits; two titles, a foot and a credit over each other;
      // the strip behind its window and the parked tag; the tag outside the safe area; the ring through scene A's title;
      // the stacked scenes and strips as siblings.
      notJudged: { clipped: 2, covered: 4, overlap: 2, safe_area: 1, sibling_overlap: 5, stroke_crosses_text: 1 },
    });
  });

  it("the same frame without keys is a still: the motion brief judges it as before", async () => {
    const p = gearPiece(mk, { noKeys: true });
    onPage(p.root);
    const r = await check(p.root, MOTION);
    expect(kinds(failing(r.issues))).toEqual(["clipped", "covered", "overlap", "safe_area", "stroke_crosses_text"]);
    expect(r.restPose).toBeUndefined();
  });

  it("without craft the walk still judges the base look where the viewer sees it", async () => {
    const p = gearPiece(mk);
    onPage(p.root);
    const r = await check(p.root, MOTION, []);
    expect(failing(r.issues)).toEqual([]);
    expect(r.restPose?.moved).toBe(GEAR_PIECE_MOVED);
  });
});

describe("what a motion brief still judges", () => {
  it("layers one key moves together: text over text and a card over text inside one scene", async () => {
    const title = text("B title", [80, 300, 560, 120], "Torque you can feel", 96);
    const sub = text("B sub", [80, 380, 560, 60], "In every turn", 48);
    const card = mk("RECTANGLE", "Card", [60, 500, 600, 200], { fills: solid("#DDDDDD") });
    const caption = text("Caption", [80, 520, 400, 40], "Hidden under the card", 32);
    const scene = mk("FRAME", "Scene B", [0, 0, 1080, 1080], { fills: solid("#FFFFFF"), manualKeyframeTracks: track("TRANSLATION_X", 1080, 0) }, [title, sub, caption, card]);
    const root = mk("FRAME", "Piece", [0, 0, 1080, 1080], { fills: solid("#FFFFFF") }, [scene]);
    onPage(root);
    const r = await check(root, MOTION);
    expect(r.issues.filter((i) => i.kind === "overlap").map((i) => i.name)).toEqual(["B title"]);
    expect(r.issues.filter((i) => i.kind === "covered").map((i) => i.name)).toEqual(["Caption"]);
  });

  it("static layers: covered by a static plate, and outside the safe area", async () => {
    const note = text("Static note", [100, 600, 300, 40], "Always here", 32);
    const plate = mk("RECTANGLE", "Static plate", [90, 590, 320, 60], { fills: solid("#333333") });
    const edge = text("Edge line", [10, 700, 300, 40], "Too near the edge", 32);
    const mover = text("Mover", [100, 100, 300, 40], "Slides in", 32, { manualKeyframeTracks: track("TRANSLATION_X", -400, 0) });
    const root = mk("FRAME", "Piece", [0, 0, 1080, 1080], { fills: solid("#FFFFFF") }, [note, plate, edge, mover]);
    onPage(root);
    const r = await check(root, MOTION);
    expect(r.issues.filter((i) => i.kind === "covered").map((i) => i.name)).toEqual(["Static note"]);
    expect(r.issues.filter((i) => i.kind === "safe_area").map((i) => i.name)).toEqual(["Edge line"]);
  });

  it("a layer cut by its own keyed parent is cut in every frame; one whose clip is resized by keys is not judged", async () => {
    const pill = text("Pill", [500, 500, 300, 40], "Cut by its badge", 32);
    const badge = mk("FRAME", "Badge", [500, 500, 200, 40], { clipsContent: true, fills: solid("#EEEEEE"), manualKeyframeTracks: track("TRANSLATION_X", 600, 0) }, [pill]);
    const reveal = text("Reveal", [100, 800, 400, 40], "Revealed by the slit", 32);
    const slit = mk("FRAME", "Slit", [100, 800, 400, 10], { clipsContent: true, fills: [], manualKeyframeTracks: track("HEIGHT", 10, 40) }, [reveal]);
    const root = mk("FRAME", "Piece", [0, 0, 1080, 1080], { fills: solid("#FFFFFF") }, [badge, slit]);
    onPage(root);
    const r = await check(root, MOTION);
    expect(r.issues.filter((i) => i.kind === "clipped").map((i) => i.name)).toEqual(["Pill"]);
    expect(r.restPose?.notJudged.clipped).toBe(1);
  });

  it("a contrast ground is taken only from layers that move with the text", async () => {
    // At rest a dark scene sits under the light scene's grey text; the text is only ever seen on its own scene.
    const grey = text("Grey line", [100, 100, 400, 40], "On the light scene", 32, { fills: solid("#666666") });
    const light = mk("FRAME", "Light scene", [0, 0, 1080, 1080], { fills: [], manualKeyframeTracks: track("OPACITY", 1, 0) }, [grey]);
    const dark = mk("RECTANGLE", "Dark scene", [0, 0, 1080, 1080], { fills: solid("#222222"), manualKeyframeTracks: track("OPACITY", 0, 1) });
    const root = mk("FRAME", "Piece", [0, 0, 1080, 1080], { fills: solid("#FFFFFF") }, [dark, light]);
    onPage(root);
    expect((await check(root, brief("graphic", "section"))).issues.map((i) => i.kind)).toContain("low_contrast_over_shape");
    expect((await check(root, MOTION)).issues.map((i) => i.kind)).not.toContain("low_contrast_over_shape");
  });

  it("without the Motion flag nothing is known to move: every finding stands, and the walk stops asking after the first read", async () => {
    let reads = 0;
    const p = gearPiece(mk, { noKeys: true });
    onPage(p.root);
    const throwing = (n: N) => {
      Object.defineProperty(n, "manualKeyframeTracks", {
        get() {
          reads++;
          throw new Error("in get_manualKeyframeTracks: manualKeyframeTracks is not a supported API");
        },
      });
      for (const k of n.children ?? []) throwing(k);
    };
    throwing(p.root);
    const r = await check(p.root, MOTION);
    expect(kinds(failing(r.issues))).toEqual(["clipped", "covered", "overlap", "safe_area", "stroke_crosses_text"]);
    expect(r.restPose).toBeUndefined();
    expect(reads).toBe(1);
  });
});

describe("restPoseNote", () => {
  it("says how many layers move and what was left to the frames, in the right number", () => {
    expect(restPoseNote(1, { covered: 1 })).toMatch(/: 1 layer here moves with keys, and 1 finding that rested .* was not made\. Judge it on frames: figma_review_video/);
    expect(restPoseNote(3, {})).toBe(
      "Under a motion brief layout is judged where the viewer sees it: 3 layers here move with keys, and no finding rested on where they sit at rest. " +
        "Static layers, and layers one key moves together, were judged as usual.",
    );
  });
});

describe("the check_layout op with a motion brief", () => {
  const ctx = (params: Record<string, unknown>): OpContext => ({ requestId: "r", params, yieldToHost: async () => {}, isCancelled: () => false, progress() {} });
  type Result = { ok: boolean; issues: Issue[]; restPose?: { moved: number; notJudged: Record<string, number>; note: string }; audit?: { note?: string } };
  const install = (nodes: N[]) => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    (globalThis as { figma?: unknown }).figma = { currentPage: mk("PAGE", "P", [0, 0, 0, 0], { selection: [] }), getNodeByIdAsync: async (id: string) => byId.get(id) ?? null };
  };
  const holder = (b: BriefRecord) => mk("FRAME", "Brief · Gear piece", [2000, 0, 720, 400], { getSharedPluginData: (ns: string, key: string) => (ns === BRIEF_NAMESPACE && key === BRIEF_KEY ? JSON.stringify({ ...b, id: block.id }) : "") });
  let block: N;

  it("briefId of a motion brief: ok where the viewer sees it, with restPose and its note", async () => {
    const p = gearPiece(mk);
    onPage(p.root);
    block = holder(MOTION);
    install([p.root, block]);
    const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: p.root.id, briefId: block.id, audit: ["craft"] }))) as Result;
    expect(r.ok).toBe(true);
    expect(r.restPose).toMatchObject({ moved: GEAR_PIECE_MOVED, notJudged: expect.objectContaining({ covered: 4 }) });
    expect(r.restPose!.note).toMatch(/^Under a motion brief layout is judged where the viewer sees it: 20 layers here move with keys, and 15 findings/);
    expect(r.restPose!.note).toMatch(/figma_review_video/);
  });

  it("no brief: judged at rest, and the note says what a motion brief changes", async () => {
    const p = gearPiece(mk);
    onPage(p.root);
    install([p.root]);
    const r = (await CHECK_OPS.check_layout!.run(ctx({ nodeId: p.root.id, audit: ["craft"] }))) as Result;
    expect(r.ok).toBe(false);
    expect(r.restPose).toBeUndefined();
    expect(r.audit!.note).toMatch(/keyframes: craft and tells measure one state/);
    expect(r.audit!.note).toMatch(/A motion brief \(briefId\) leaves to the frames what rests on a keyed layer's rest pose, as figma_sign_off does\./);
  });
});
