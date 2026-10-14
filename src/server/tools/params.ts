// Schema shapes that stay inside every provider's accepted subset.
//
// The portability guard (test/schema-portability.test.ts) rejects `anyOf`,
// `oneOf`, `propertyNames`, `$ref` and friends, because providers differ on
// them and the failure mode is the worst kind: accepted by one provider,
// rejected by a second, and ACCEPTED BUT IGNORED by a third. A tool whose schema
// is ignored is a tool that takes no arguments, and the model simply never calls
// it correctly — with nothing in any log to say why.
//
// The problem is that zod's natural spellings produce exactly those keywords:
//
//   z.union([A, B])            -> anyOf            (rejected at the root)
//   z.record(z.string(), X)    -> propertyNames    (rejected)
//   z.union([z.literal(a), z.number()]) -> anyOf   (rejected)
//
// So every union in this project's tool schemas is expressed one of two other
// ways, whichever fits the data honestly:
//
//   * as a plain string with an `enum` where the alternatives are a fixed set
//     (no schema trickery needed at all);
//   * as a single `string` or `number` with the accepted forms stated in the
//     description, where the alternatives are "a scalar or a list" — the tool
//     already validates and reports the offending value.
//
// The second case gives up a little schema-level strictness and gains the
// property that matters more here: the tool is callable from every client. The
// plugin still rejects a bad value with INVALID_PARAM naming the field, so
// nothing is accepted silently.
//
// Every nested object is `.strict()`. The SDK parses arguments with zod and
// hands the tool the PARSED copy, and zod's default strips unknown keys: a
// misspelt `angel: 180` would vanish before the plugin's own key check could
// see it, and the call would succeed with the default. Strict refuses it with
// its path; on the wire it is `additionalProperties: false`, the keyword the
// SDK's zod 3 converter emitted on every object anyway.

import { z } from "zod";

/** A hex colour, as a plain string. Validated properly in the plugin. */
export const hexColor = z
  .string()
  .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "Use #rgb, #rrggbb or #rrggbbaa");

/**
 * Padding: a number (all sides) or four numbers.
 *
 * Written as a string-or-number-free shape: `padding: 24` or `padding: "24,24,24,24"`.
 * A JSON array would be the natural type, but `z.array()` of length 4 next to a
 * `z.number()` needs a union, and a union is `anyOf`. Accepting the comma form
 * instead keeps the schema a plain `string`, and the plugin parses both.
 */
export const paddingParam = z
  .string()
  .describe("Padding: one number for all sides (\"24\"), or four comma-separated (\"48,48,32,32\") for top,right,bottom,left.");

/**
 * A number that may also be given as a Figma style name.
 *
 * `z.union([z.number(), z.string()])` is `anyOf`; `z.coerce.number()` would
 * silently turn "Semi Bold" into NaN. A single string keeps the schema legal,
 * and the plugin understands both "600" and "Semi Bold" — which is what the
 * parameter means either way.
 */
export const weightParam = z
  .string()
  .describe('Font weight as a number ("600") or a Figma style name ("Semi Bold" — Inter uses spaces, not "SemiBold").');

/**
 * A text length — line height or letter spacing — in figma_set_text_properties'
 * grammar ("auto", "24", "24px", "150%", "-2%"), which is also what
 * figma_get_design_context reads back. A bare JSON number is still px, as the
 * create tools always took it: the preprocess turns a finite number into its
 * string so the string check passes, and textLengthsForPlugin turns it back.
 *
 * Not a union, which is `"type": ["string", "number"]` and outside the portable
 * subset; not z.coerce.string(), which would turn true, null or {} into text.
 * On the wire a preprocess is its output schema, one `"type": "string"`
 * (test/agent-guidance.test.ts pins that through the SDK).
 */
export const textLengthParam = z.preprocess((v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : v), z.string());

/**
 * textLengthParam's preprocess undone before forwarding: a value that is
 * exactly a finite number's string ("24", "-0.5") goes to the plugin as that
 * number. The current plugin parses either form, but a plugin started before
 * the string grammar applied only a number and dropped a string without an
 * error. A stale plugin is something figma_status reports, not something the
 * bridge refuses, so forwarding the number keeps a call that worked before
 * working under that skew. "24px", "150%" and "auto" go on as strings.
 */
export function textLengthsForPlugin(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out = { ...args };
  for (const key of keys) {
    const v = out[key];
    if (typeof v !== "string") continue;
    const n = Number(v);
    if (Number.isFinite(n) && String(n) === v) out[key] = n;
  }
  return out;
}

/**
 * A variable value: hex for COLOR, a number for FLOAT, text for STRING, "true"
 * for BOOLEAN. One string type; the plugin converts by the declared `type`.
 */
export const variableValueParam = z
  .string()
  .describe('The value for the declared type: "#1a2b3c" for COLOR, "16" for FLOAT, "Inter" for STRING, "true" for BOOLEAN.');

/**
 * Figma's "Horizontal / Vertical sizing" dropdowns, per screen axis: fixed (a
 * set size), hug (fits its content — auto-layout frames and text), fill (takes
 * the space of an auto-layout parent). An object with two enum fields, which is
 * inside the portable subset.
 */
const axis = z.enum(["fixed", "hug", "fill"]);
export const sizingParam = z
  .object({ horizontal: axis.optional(), vertical: axis.optional() })
  .strict()
  .describe('How it sizes, as in Figma\'s panel: { "horizontal": "fill" } to take the parent column\'s width; "hug" fits content; "fixed" keeps the number.');

/**
 * One effect: a shadow (colour, offset, blur radius, spread), a blur (radius,
 * optionally ramped), a noise, a texture or a glass. One object with optional
 * fields rather than a union per effect type; the plugin rejects a field that
 * does not belong to the type (plugin/ops/style.ts toEffect).
 */
const xy = z.object({ x: z.number(), y: z.number() }).strict();
export const effectEntry = z.object({
  type: z
    .enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR", "NOISE", "TEXTURE", "GLASS"])
    .optional()
    .describe("Default DROP_SHADOW. NOISE, TEXTURE and GLASS are recent: an older Figma build may refuse them."),
  color: hexColor.optional().describe("Shadow or NOISE colour (NOISE default #000000); #rrggbbaa alpha becomes the opacity."),
  x: z.number().optional().describe("Shadow offset x (default 0). Shadows only."),
  y: z.number().optional().describe("Shadow offset y (default 4). Shadows only."),
  radius: z.number().nonnegative().optional().describe("Blur radius (default 8) — also a TEXTURE's radius (8) and a GLASS frost (0)."),
  spread: z.number().optional().describe("Shadow spread (default 0). Shadows only."),
  opacity: z.number().min(0).max(1).optional().describe("Shadow or NOISE opacity 0–1 (default 0.25)."),
  visible: z.boolean().optional(),
  showBehindNode: z.boolean().optional().describe("Drop shadow shows through transparent areas. Default false."),
  progressive: z
    .object({
      startRadius: z.number().nonnegative().optional().describe("Blur where the ramp starts, default 0."),
      startOffset: xy.optional().describe("Where it starts, 0–1 of the node; default top centre { x: 0.5, y: 0 }."),
      endOffset: xy.optional().describe("Where it reaches `radius`; default bottom centre { x: 0.5, y: 1 }."),
    })
    .strict()
    .optional()
    .describe("Blurs only: ramp the blur instead of a uniform one."),
  noiseType: z.enum(["monotone", "duotone", "multitone"]).optional().describe("NOISE only, default monotone."),
  secondaryColor: hexColor.optional().describe("NOISE duotone only, and required there: the second colour."),
  noiseSize: z.number().positive().optional().describe("NOISE and TEXTURE (required there): grain size."),
  density: z.number().min(0).max(1).optional().describe("NOISE (required there): grain density 0–1."),
  clipToShape: z.boolean().optional().describe("TEXTURE: keep it inside the shape, default true."),
  lightIntensity: z.number().min(0).max(1).optional().describe("GLASS: highlight strength 0–1, default 0.5."),
  lightAngle: z.number().optional().describe("GLASS: light direction in degrees, default -45."),
  refraction: z.number().min(0).max(1).optional().describe("GLASS: distortion 0–1, default 0.5."),
  depth: z.number().min(1).optional().describe("GLASS: ≥ 1, default 20."),
  dispersion: z.number().min(0).max(1).optional().describe("GLASS: colour split at the edges 0–1, default 0."),
}).strict();

const unit = z.number().min(0).max(1);

/**
 * A gradient — fills and strokes share it. Direction is one CSS angle, so a
 * value read off a design pastes in unchanged; `transform` is Figma's raw
 * matrix, flattened to six numbers because a nested array is one more shape a
 * provider can mangle. The plugin refuses the raw matrix next to the friendly
 * fields rather than picking one.
 */
export const gradientEntry = z.object({
  type: z.enum(["linear", "radial", "angular", "diamond"]),
  stops: z
    .array(z.object({ position: unit.describe("0 = start, 1 = end."), color: hexColor }).strict())
    .min(2)
    .max(16),
  // A paint style has no size, so its angle is fitted to a square (plugin
  // style.ts toPaint): a diagonal drifts on any other shape. Said where the
  // agent writes the angle, since the same entry serves set_fills and styles.
  angle: z
    .number()
    .optional()
    .describe(
      "Linear only, CSS degrees: 90 = left → right (default), 180 = top → bottom. Fitted to each node's size — but a " +
        "paint style has no size, so there a diagonal is exact only on a square (135 shows about 163 on 1280×400).",
    ),
  center: z
    .object({ x: unit, y: unit })
    .strict()
    .optional()
    .describe("Radial, angular, diamond: the centre, 0–1 of the node. Default { x: 0.5, y: 0.5 }."),
  radius: z.number().positive().max(1).optional().describe("Radial, diamond: reach from the centre as a fraction of each side; 0.5 (default) touches the edges."),
  transform: z
    .array(z.number())
    .min(6)
    .max(6)
    .optional()
    .describe("Raw gradientTransform [a, b, c, d, e, f] = [[a, b, c], [d, e, f]]. Alone — not with angle, center or radius."),
}).strict();

/** An image already in the file, by the hash figma_import_image returns. */
export const imageEntry = z.object({
  hash: z.string().describe("The imageHash of an image already in this file."),
  scaleMode: z.enum(["fill", "fit", "crop", "tile"]).optional().describe('Default "fill".'),
  rotation: z.number().optional().describe("0, 90, 180 or 270 (not with crop)."),
  filters: z
    .object({
      exposure: z.number().min(-1).max(1).optional(),
      contrast: z.number().min(-1).max(1).optional(),
      saturation: z.number().min(-1).max(1).optional(),
      temperature: z.number().min(-1).max(1).optional(),
      tint: z.number().min(-1).max(1).optional(),
      highlights: z.number().min(-1).max(1).optional(),
      shadows: z.number().min(-1).max(1).optional(),
    })
    .strict()
    .optional()
    .describe("The paint picker's sliders, each -1 to 1 (0 = unchanged)."),
}).strict();

/**
 * One fill: a single object with separate optional fields rather than a union
 * of "hex | rgba | gradient | image", because `anyOf` is not portable across
 * model providers. The plugin enforces "exactly one form per entry".
 */
export const fillEntry = z
  .object({
    color: hexColor.optional().describe("Solid colour, #rgb / #rrggbb / #rrggbbaa."),
    r: unit.optional().describe("Solid colour as channels 0–1 (with g and b)."),
    g: unit.optional(),
    b: unit.optional(),
    a: unit.optional().describe("Alpha 0–1 for the r/g/b form."),
    gradient: gradientEntry.optional(),
    image: imageEntry.optional(),
    opacity: unit.optional().describe("Opacity of this fill, 0–1."),
  })
  .strict()
  .describe("Exactly one of `color`, `r/g/b`, `gradient`, or `image`.");

/**
 * Z-order target: a keyword or an index.
 *
 * As a single string, so there is no union: the four keywords, or a decimal
 * index like "3". The plugin rejects anything else with the accepted list.
 */
export const positionParam = z
  .string()
  .describe('"front", "back", "forward", "backward", or an index as a string ("3").');

/** Descriptions are capped: providers truncate silently past their limit. */
export const MAX_DESCRIPTION = 1024;

/**
 * Trim a description to the portable cap, on a sentence boundary rather than
 * mid-word. Silently truncated text is worse than absent text: a tool whose
 * last sentence is cut off may say the opposite of what was meant.
 */
export function fitDescription(text: string, limit = MAX_DESCRIPTION): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "), cut.lastIndexOf(" — "));
  return stop > limit * 0.5 ? cut.slice(0, stop + 1) : `${cut.slice(0, limit - 1)}…`;
}
