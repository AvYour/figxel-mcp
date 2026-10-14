// Where a node keeps its text, and the fonts it needs before that text changes.
//
// FigJam keeps text in three shapes [C-135]:
//   TEXT                                the node itself (TextNode);
//   STICKY, SHAPE_WITH_TEXT, CONNECTOR  a `text` sublayer: TextSublayerNode =
//                                       NonResizableTextMixin + MinimalFillsMixin
//                                       (plugin-api.d.ts:10403) — characters,
//                                       fonts, ranges and fills, but none of
//                                       TextNode's own members such as
//                                       textAlignHorizontal or textAutoResize
//                                       (d.ts:10963, 10977);
//   CODE_BLOCK                          `code`, a plain string with no font (d.ts:11581).
// A TABLE keeps text per cell (cellAt(row, column).text) and has no single
// target, so it is not one here.
//
// Structural types only (no plugin typings), like read.ts and write.ts.

import { BridgeError, ErrorCode } from "../shared/errors.js";
import { tryGet } from "./safe.js";

export interface FontNameLike {
  family: string;
  style: string;
}

/** What TextNode and TextSublayerNode share: enough to read, load and rewrite the text. */
export interface TextHolder {
  characters: string;
  fontName: FontNameLike | symbol;
  getRangeAllFontNames?(start: number, end: number): FontNameLike[];
}

export interface CodeHolder {
  code: string;
}

export interface OwnerLike {
  id?: string;
  type: string;
}

export type TextTarget =
  | { kind: "text"; owner: OwnerLike; target: TextHolder }
  | { kind: "sublayer"; owner: OwnerLike; target: TextHolder }
  | { kind: "code"; owner: OwnerLike; target: CodeHolder };

const SUBLAYER_TYPES: ReadonlySet<string> = new Set(["STICKY", "SHAPE_WITH_TEXT", "CONNECTOR"]);
/** Node types that hold one editable text, in the order a reader lists them. */
export const TEXT_HOLDER_TYPES = ["TEXT", "STICKY", "SHAPE_WITH_TEXT", "CONNECTOR", "CODE_BLOCK"] as const;

/** The text `node` holds, or null when it holds none (a TABLE, a frame, a sublayer that cannot be read). */
export function textTarget(node: OwnerLike): TextTarget | null {
  if (node.type === "TEXT") return { kind: "text", owner: node, target: node as unknown as TextHolder };
  if (node.type === "CODE_BLOCK") return { kind: "code", owner: node, target: node as unknown as CodeHolder };
  if (!SUBLAYER_TYPES.has(node.type)) return null;
  const text = tryGet<TextHolder | null>(node, "text");
  return text.ok && text.value ? { kind: "sublayer", owner: node, target: text.value } : null;
}

/** FigJam's default text font, which a connector label is given when its own cannot be used [C-148]. */
export const CONNECTOR_LABEL_FONT: FontNameLike = { family: "Inter", style: "Medium" };

export interface FontLoader {
  loadFontAsync(font: FontNameLike): Promise<void>;
}

const isFont = (v: unknown): v is FontNameLike =>
  typeof v === "object" && v !== null && typeof (v as FontNameLike).family === "string" && typeof (v as FontNameLike).style === "string";

/** Every font the text uses (all runs), else its one fontName; deduplicated. */
export function fontsOf(target: TextHolder): FontNameLike[] {
  const len = typeof target.characters === "string" ? target.characters.length : 0;
  let fonts: FontNameLike[] = [];
  if (len > 0 && typeof target.getRangeAllFontNames === "function") {
    try {
      fonts = target.getRangeAllFontNames(0, len);
    } catch {
      fonts = [];
    }
  }
  if (!fonts.length) {
    const own = tryGet(target, "fontName");
    if (own.ok && isFont(own.value)) fonts = [own.value];
  }
  const seen = new Set<string>();
  return fonts.filter((f) => {
    const k = `${f.family}\u0000${f.style}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function loads(figma: FontLoader, font: FontNameLike): Promise<boolean> {
  try {
    await figma.loadFontAsync(font);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load what `t` needs before its characters change. A code block needs nothing.
 *
 * A new connector's label font is invalid: loading `connector.text.fontName`
 * fails, so the official recipe sets a known font first
 * (create-connector.md:109) [C-148]. A connector whose font cannot be read or
 * loaded therefore gets Inter Medium — loaded, then set, before anything else
 * — and `reset` says so. That one assignment is a write: call this after the
 * op's own checks. Any other font that will not load is FONT_LOAD_FAILED.
 */
export async function loadTextFonts(t: TextTarget, figma: FontLoader): Promise<{ fonts: FontNameLike[]; reset?: FontNameLike }> {
  if (t.kind === "code") return { fonts: [] };
  const target = t.target;
  if (t.owner.type === "CONNECTOR") {
    const current = tryGet(target, "fontName");
    const usable = current.ok && isFont(current.value) && (await loads(figma, current.value));
    if (!usable) {
      await figma.loadFontAsync(CONNECTOR_LABEL_FONT);
      target.fontName = { ...CONNECTOR_LABEL_FONT };
      return { fonts: [{ ...CONNECTOR_LABEL_FONT }], reset: { ...CONNECTOR_LABEL_FONT } };
    }
  }
  const fonts = fontsOf(target);
  for (const font of fonts) {
    try {
      await figma.loadFontAsync(font);
    } catch (err) {
      throw new BridgeError(
        ErrorCode.FONT_LOAD_FAILED,
        `The ${t.owner.type}${t.owner.id ? ` \`${t.owner.id}\`` : ""} uses "${font.family} ${font.style}", which did not load: ${err instanceof Error ? err.message : String(err)}`,
        { hint: "figma_get_fonts lists the fonts this Figma can load." },
      );
    }
  }
  return { fonts };
}
