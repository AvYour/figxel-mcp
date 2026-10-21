// A multi-scene motion piece shaped like the one signed off live on
// 2026-10-20 (frame 4:262): its scenes stack in one top-level frame and keys
// move them, so at rest scene B covers scene A, a credit strip covers both, a
// roll counter's digit strip runs out of its clip window, and a tag is parked
// outside the frame until it slides in. Every layer stays visible at rest, as
// the motion skill asks (figma_check_motion's `rest_state_hidden`).
//
// Built with the caller's own tree maker, so the check tests and the sign-off
// tests share one piece. No layer is a defect where the viewer sees it; at rest
// figma_check_layout finds `covered`, `overlap`, `clipped`, `safe_area`,
// `stroke_crosses_text`, `no_shared_edge` and `sibling_overlap` in it.

type Box = [number, number, number, number];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mk = (type: string, name: string, box: Box, props?: Record<string, unknown>, children?: any[]) => any;

const solid = (hex: string) => [{ type: "SOLID", color: { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 } }];

/** One keyframe track as `manualKeyframeTracks` holds it: keyed by the property's name. */
export const track = (field: string, ...values: number[]) => ({
  [field]: { keyframes: values.map((v, i) => ({ time: i, value: { type: "FLOAT", value: v } })) },
});

/** The piece's safe area, as its motion brief records it. */
export const SAFE_AREA = "40,40,1000,1000";

export function gearPiece(mk: Mk, opts: { noKeys?: boolean } = {}) {
  const keyed = (t: Record<string, unknown>) => (opts.noKeys ? {} : { manualKeyframeTracks: t });
  const text = (name: string, box: Box, chars: string, size: number, color = "#111111", props: Record<string, unknown> = {}) =>
    mk("TEXT", name, box, { characters: chars, fontName: { family: "Inter", style: "Regular" }, fontSize: size, fills: solid(color), textAutoResize: "HEIGHT", ...props });

  const aTitle = text("A title", [80, 200, 560, 120], "Every gear turns", 96);
  const aFoot = text("A foot", [80, 980, 600, 40], "Made in Lisbon", 32);
  // Scene A fades out as scene B slides in over it.
  const sceneA = mk("FRAME", "Scene A", [0, 0, 1080, 1080], { fills: solid("#F4EFE6"), ...keyed(track("OPACITY", 1, 0)) }, [aTitle, aFoot]);
  const bTitle = text("B title", [80, 300, 560, 120], "Torque you can feel", 96, "#FFFFFF");
  const ring = mk("ELLIPSE", "Ring", [600, 40, 200, 200], { fills: [], strokes: solid("#E8C547"), strokeWeight: 4 });
  const sceneB = mk("FRAME", "Scene B", [0, 0, 1080, 1080], { fills: solid("#1B1B1B"), ...keyed(track("TRANSLATION_X", 1080, 0)) }, [bTitle, ring]);
  // A roll counter: the digit strip rolls up behind a clip window that shows one digit.
  const digits = Array.from({ length: 10 }, (_, k) => text(`Digit ${k}`, [860, 60 + 80 * k, 120, 80], String(k), 64, "#FFFFFF"));
  const strip = mk("FRAME", "Digits", [860, 60, 120, 800], { fills: [], ...keyed(track("TRANSLATION_Y", 0, -720)) }, digits);
  const counter = mk("FRAME", "Counter window", [860, 60, 120, 80], { fills: solid("#222222"), clipsContent: true }, [strip]);
  const credit = text("Credit", [40, 990, 600, 40], "Figxel Showcase 2026", 32, "#FFFFFF");
  const credits = mk("FRAME", "Credits", [0, 960, 1080, 120], { fills: solid("#000000"), ...keyed(track("OPACITY", 0, 1)) }, [credit]);
  // Parked outside the frame; it slides in at the end.
  const tag = text("Tag", [1100, 500, 200, 40], "New", 32, "#111111", keyed(track("TRANSLATION_X", 0, -400)));
  const root = mk("FRAME", "Gear piece", [0, 0, 1080, 1080], { fills: solid("#FFFFFF"), clipsContent: true, layoutMode: "NONE" }, [sceneA, sceneB, counter, credits, tag]);
  return { root, sceneA, sceneB, aTitle, aFoot, bTitle, ring, strip, digits, counter, credits, credit, tag };
}

/** The visible layers of gearPiece that keys move against the frame: both scenes, the digit strip, the credits and the tag, with what they carry. */
export const GEAR_PIECE_MOVED = 3 + 3 + 11 + 2 + 1;
