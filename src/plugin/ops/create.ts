// The create group: one call = one screen (tools.md § create).
//
// `create_from_spec` is the flagship: 40 separate calls (40 round-trips, 40
// validations, 40 canvas refreshes) become one. Everything else here exists so
// an agent can also build incrementally when that is the better shape.
//
// Two contracts, both from tools.md:
//   - a mid-way failure reports `{ partial: true, created[], failedAt, error }`
//     rather than rolling back, because one op = one Ctrl+Z step and a fake
//     rollback is how an agent ends up lying about what is on the canvas;
//   - the whole call is ONE commitUndo, applied by the caller (code.ts), so a
//     single Ctrl+Z undoes the entire screen.

import { BridgeError, ErrorCode } from "../../shared/errors.js";
import { EDITOR_LABEL, editorRefusal, isEditor } from "../../shared/editors.js";
import { REF_TOKEN } from "../../shared/figjam.js";
import { arrangeColumns, placeGrid } from "../../shared/grid-layout.js";
import type { OpContext, PluginOp } from "./index.js";
import { apiHas, editorType, has, tryGet } from "../safe.js";
import { specType, specTypeNames, specTypeRunsIn, UNIVERSAL_SPEC_FIELDS, type SpecBuild, type SpecCheck, type SpecFields, type SpecTypeHandler } from "../spec-types.js";
import {
  applyStyle,
  bindField,
  bindTarget,
  findStyle,
  findVariable,
  isStyleTarget,
  targetFor,
  TEXT_FIELDS,
  type BindTarget,
  type StyleTarget,
  type VariableLike,
} from "../bind.js";
import { CancelledError, createPacer, type Pacer } from "../chunk.js";
import { str } from "../read.js";
import { checkModeName, parseLength, parseLineHeight } from "../tokens.js";
import { createStyleOp, finishVariable, prepareVariable } from "./tokens.js";
import { recolour } from "./assets.js";
import { PATH_DATA, vectorFromPath } from "./shapes.js";
import { resolvePropertyKey } from "./component.js";
import { beforeMutating } from "../guard.js";
import { resolveCollection, resolveMode, setMode, type CollectionLike } from "../modes.js";
import {
  alignmentFor,
  append,
  applySizing,
  applyWrapFields,
  loadFont,
  nearest,
  normalizePadding,
  num,
  parentFor,
  parseColor,
  parseSizing,
  resizeNode,
  resolveStyleByName,
  resolveVariableByName,
  slideOf,
  textDefaults,
  weightParam,
  weightToStyle,
  wrapFields,
  type FigmaWrite,
  type FrameLike,
  type NodeLikeW,
  type Sizing,
  type TextLike,
  type WrapFields,
} from "../write.js";

const api = () => (globalThis as unknown as { figma: FigmaWrite }).figma;

/** What the builder produced, so a partial failure can name it precisely. */
export interface Created {
  id: string;
  name: string;
  path: string;
  /** Text only, and only when the asked-for font was unavailable: what was used instead. */
  font?: { family: string; style: string; fellBack: true };
  /** Instance only: properties Figma accepted without changing them (`Label#1:2`, or `Icon.Label#3:4` for a nested one). */
  ignored?: string[];
}

interface BuildResult {
  node: NodeLikeW;
  created: Created[];
}

// ── one spec node ───────────────────────────────────────────────────────────

interface SizingSpec {
  width?: string;
  height?: string;
}

interface SpecNode {
  type?: string;
  name?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  layout?: string;
  /**
   * "hug" | "fixed", or an object to set each axis independently:
   * `{ "width": "fixed", "height": "hug" }`. The object exists because the
   * common intent — a fixed height with a width that fits the content — cannot
   * be said with one word.
   */
  sizing?: string | SizingSpec;
  /** Default false: clipping cuts shadows and overhangs. Opt in to trim. */
  clipsContent?: boolean;

  gap?: number;
  padding?: unknown;
  alignX?: string;
  alignY?: string;
  background?: string;
  fill?: string;
  cornerRadius?: number;
  stroke?: string;
  strokeWeight?: number;
  opacity?: number;
  visible?: boolean;
  locked?: boolean;
  rotation?: number;
  content?: string;          // text
  fontFamily?: string;
  fontSize?: number;
  weight?: number | string;
  color?: string;
  align?: string;
  lineHeight?: number | string;    // text: px, or "auto" | "24px" | "150%" as figma_set_text_properties takes it
  letterSpacing?: number | string; // text: px, or "0.5px" | "-2%"
  componentId?: string;      // instance
  componentKey?: string;     // instance: a published component, imported by key
  componentSetKey?: string;  // instance: a published component set, imported by key
  variant?: string;          // instance of a set: "Size=Large, State=Hover"
  properties?: Record<string, string | boolean>; // instance: component properties by name
  nested?: Record<string, Record<string, string | boolean>>; // instance: a nested instance's properties, by layer name
  pointCount?: number;       // polygon, star
  innerRadius?: number;      // star
  path?: string;             // vector: SVG path data
  svg?: string;              // svg: SVG markup (an icon)
  colorVariable?: string;    // svg: a COLOR variable (name or id) for every painted vector
  url?: string;              // image
  scaleMode?: string;        // image: fill | fit | crop | tile
  cap?: string;              // line
  /** "absolute": out of the parent auto-layout's flow, placed by x/y [C-095]. */
  positioning?: string;
  wrap?: boolean;
  rowGap?: number;
  alignContent?: string;
  /** `{ "<collection name or id>": "<mode name or id>" }` pinned on this node [C-105]. */
  variableModes?: Record<string, string>;
  variables?: Record<string, string>;
  style?: Record<string, string>;
  /** A name for this node within the spec, so another node (a connector) can point at it; the result maps it to the id. */
  ref?: string;
  list?: string;             // text: unordered | ordered | none
  arrange?: string;          // section: row | column | grid:N
  hug?: boolean;             // section: fit to its children
  contentsHidden?: boolean;  // section
  children?: SpecNode[];
}

function isSpecNode(v: unknown): v is SpecNode {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const NODE_TYPES = new Set([
  "frame", "text", "button", "rectangle", "ellipse", "component", "instance", "section",
  "polygon", "star", "line", "vector", "svg", "image",
]);
/** Types that hold children. Everything else is a leaf: Figma refuses children on a shape. */
const CONTAINER_TYPES = new Set(["frame", "button", "component", "section"]);

// What each type reads — and nothing else. A key outside its type's list used
// to be dropped without a word, so a misspelt `wrapp` or an unsupported
// `effects` came back as success and only a render showed otherwise; a Plugin
// API write to a property that does not exist fails loudly instead. The lists
// follow buildNode: a key here is a key something below acts on.
const COMMON = ["type", "name", "ref", "width", "height", "x", "y", "sizing", "opacity", "visible", "locked", "rotation", "variables", "style", "positioning"];
const PAINT = ["background", "fill", "stroke", "strokeWeight", "cornerRadius"];
const CONTAINER = ["layout", "gap", "padding", "alignX", "alignY", "wrap", "rowGap", "alignContent", "clipsContent", ...PAINT, "variableModes", "children"];
const without = (list: readonly string[], drop: readonly string[]) => list.filter((k) => !drop.includes(k));
const FIELDS: Record<string, ReadonlySet<string>> = {
  frame: new Set([...COMMON, ...CONTAINER]),
  button: new Set([...COMMON, ...CONTAINER]),
  component: new Set([...COMMON, ...CONTAINER]),
  // A SectionNode has no auto-layout, clipping, opacity or rotation (typings
  // 1.141.0), and can never be an auto-layout child: those keys would be dropped.
  // Its gap and padding space what `arrange` and `hug` lay out instead.
  section: new Set([
    ...without(COMMON, ["sizing", "opacity", "rotation", "positioning"]),
    ...without(CONTAINER, ["layout", "alignX", "alignY", "wrap", "rowGap", "alignContent", "clipsContent"]),
    "arrange", "hug", "contentsHidden",
  ]),
  // A text's height follows its lines (buildText sizes the width only).
  text: new Set([...without(COMMON, ["height"]), "content", "fontFamily", "fontSize", "weight", "color", "align", "lineHeight", "letterSpacing", "list"]),
  rectangle: new Set([...COMMON, ...PAINT]),
  ellipse: new Set([...COMMON, ...PAINT]),
  polygon: new Set([...COMMON, ...PAINT, "pointCount"]),
  star: new Set([...COMMON, ...PAINT, "pointCount", "innerRadius"]),
  vector: new Set([...COMMON, ...PAINT, "path"]),
  // A line's height is always 0: its length is `width`.
  line: new Set([...without(COMMON, ["height"]), "stroke", "color", "strokeWeight", "cap"]),
  svg: new Set([...COMMON, "svg", "color", "colorVariable"]),
  image: new Set([...COMMON, "url", "scaleMode", "cornerRadius", "stroke", "strokeWeight"]),
  instance: new Set([...COMMON, "componentId", "componentKey", "componentSetKey", "variant", "properties", "nested", "background", "fill"]),
};

/** A refusal before anything exists, naming the spec path it is about. */
function refuse(path: string, message: string, hint?: string): never {
  throw new BridgeError(ErrorCode.INVALID_PARAM, message, { ...(hint ? { hint } : {}), partial: { created: [], failedAt: path } });
}

/**
 * The op whose editor cell decides whether a spec type, or a field, builds in
 * this file's editor [C-129]: a component is convert_to_component, a key
 * import is import_library_assets. The plugin sees no BRIDGE_ALLOW_UNVERIFIED,
 * so only a "no" cell refuses here; the bridge's cell for create_from_spec
 * already governs whether an unmeasured editor runs the call at all.
 */
const SPEC_BACKING: Record<string, string> = {
  frame: "create_frame", button: "create_frame", text: "create_text", rectangle: "create_rectangle", ellipse: "create_ellipse",
  component: "convert_to_component", instance: "create_instance", section: "create_section", polygon: "create_polygon",
  star: "create_star", line: "create_line", vector: "create_vector", svg: "import_svg", image: "import_image",
};
const FIELD_BACKING: ReadonlyArray<[keyof SpecNode, string]> = [
  ["variables", "bind_variable_to_node"], ["style", "apply_style_to_node"], ["variableModes", "set_variable_mode"],
  ["componentKey", "import_library_assets"], ["componentSetKey", "import_library_assets"],
];

const editorName = (editor: string) => (isEditor(editor) ? EDITOR_LABEL[editor] : `"${editor}"`);

/**
 * The figma members each built-in type is made with. An editor may lack one —
 * Slides has no createSection (Working in Slides) [C-134], contradicted by the
 * typings [C-137] — and touching a missing member may throw [C-145], so each is
 * probed with apiHas while nothing exists: a spec that cannot be built is
 * refused whole instead of failing half-way with nodes on the canvas.
 */
const FACTORIES: Record<string, readonly string[]> = {
  frame: ["createFrame"], button: ["createFrame"], component: ["createFrame", "createComponentFromNode"],
  text: ["createText"], rectangle: ["createRectangle"], ellipse: ["createEllipse"], section: ["createSection"],
  polygon: ["createPolygon"], star: ["createStar"], line: ["createLine"], vector: ["createNodeFromSvg"],
  svg: ["createNodeFromSvg"], image: ["createRectangle"], // createImageAsync is checked where the images load
};

/** Refuse a spec node the editor cannot build, before the first node exists. */
function refuseInEditor(spec: SpecNode, type: string, path: string, editor: string): void {
  const backing: Array<[string, string]> = [[type, SPEC_BACKING[type]!]];
  for (const [field, op] of FIELD_BACKING) if (spec[field] !== undefined) backing.push([`${type}.${field}`, op]);
  for (const [what, op] of backing) {
    const r = editorRefusal(op, editor, { allowUnverified: false, layer: "plugin" });
    if (r) {
      throw new BridgeError(ErrorCode.UNSUPPORTED, `\`${path}\` (${what}): ${r.message}`, {
        hint: r.hint,
        partial: { created: [], failedAt: path },
      });
    }
  }
}

/** Refuse a type whose factory this editor lacks — once the whole spec's shape is valid, so a malformed spec hears about its shape first. */
function refuseMissingFactory(type: string, path: string, editor: string): void {
  const missing = (FACTORIES[type] ?? []).filter((name) => !apiHas(name));
  if (missing.length) {
    throw new BridgeError(ErrorCode.UNSUPPORTED, `\`${path}\` (${type}): this ${editorName(editor)} file has no figma.${missing.join(" or figma.")}, so a ${type} cannot be built here.`, {
      hint: "Nothing was created. figma_get_guide { topic: \"spec\" } lists the types; build this part another way.",
      partial: { created: [], failedAt: path },
    });
  }
}

/**
 * Section layout defaults, from the official FigJam notes: 64 px between items
 * laid out in a grid (create-sticky.md:136-148) and at least 32 px of padding
 * around a section's content (create-section.md:65; position-figjam-nodes.md:84)
 * [C-166].
 */
const ARRANGE_GAP = 64;
const SECTION_PADDING = 32;

/** A string → string | boolean map, as `properties` and each `nested` entry are. */
function isPropertyMap(v: unknown): v is Record<string, string | boolean> {
  return isSpecNode(v) && Object.values(v).every((x) => typeof x === "string" || typeof x === "boolean");
}

const POSITIONINGS = new Set(["auto", "absolute"]);
const SIZING_WORDS = new Set(["fixed", "hug", "fill"]);
/** What a text's `align` says, as textAlignHorizontal takes it (typings 1.141.0). */
const TEXT_ALIGN: Record<string, string> = { left: "LEFT", center: "CENTER", right: "RIGHT", justified: "JUSTIFIED" };

/**
 * The number fields and the least value each takes (undefined: any number).
 * A string here was skipped by a typeof test, and a value Figma refuses threw
 * after the node existed: resize() takes no size under 0.01 and a font size
 * under 1 (typings 1.141.0). The other minimums are the single-node tools'.
 * A text's lineHeight and letterSpacing are not here: they take
 * figma_set_text_properties' strings too, checked by parseLineHeight / parseLength.
 */
const NUMBER_FIELDS: Record<string, number | undefined> = {
  width: 0.01, height: 0.01, fontSize: 1, strokeWeight: 0, cornerRadius: 0,
  x: undefined, y: undefined, gap: undefined, opacity: undefined, rotation: undefined,
};

/** VariableBindableNodeField (typings 1.141.0): what setBoundVariable takes besides the text fields. */
const NODE_BINDABLE: ReadonlySet<string> = new Set([
  "height", "width", "characters", "itemSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "visible",
  "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "minWidth", "maxWidth",
  "minHeight", "maxHeight", "counterAxisSpacing", "strokeWeight", "strokeTopWeight", "strokeRightWeight",
  "strokeBottomWeight", "strokeLeftWeight", "opacity", "gridRowGap", "gridColumnGap",
]);
/** The friendly names bind.ts maps (tools.md § create_from_spec rules), offered first for a misspelt key. */
const VARIABLE_ALIASES = ["fill", "stroke", "radius", "gap", "padding", "size", "background", "fills", "strokes"];

/**
 * Which variables a `variables` field takes, decided while nothing exists —
 * bindField only finds out half-way through the build. Paints and effect
 * colours take a COLOR and the other effect and grid fields a FLOAT, as
 * bindField demands; a node's number fields take a FLOAT. `characters`,
 * `visible` and the text fields are Figma's to judge [C-109], except a COLOR,
 * which binds no node field. An unknown field is refused here, not as "a
 * FRAME has no …" after the frame exists.
 */
function variableRule(field: string, path: string): { takes: (type: string) => boolean; what: string } {
  let target: BindTarget;
  try {
    target = bindTarget(field);
  } catch (err) {
    refuse(path, `\`${path}.variables.${field}\`: ${err instanceof Error ? err.message : String(err)}`);
  }
  const only = (want: string) => ({ takes: (t: string) => t === want, what: `a ${want} variable` });
  if (target.kind === "paint") return only("COLOR");
  if (target.kind === "effect") return only(target.field === "color" ? "COLOR" : "FLOAT");
  if (target.kind === "grid") return only("FLOAT");
  if (target.fields.some((f) => !NODE_BINDABLE.has(f) && !TEXT_FIELDS.has(f))) {
    refuse(path, `\`${path}.variables.${field}\` is not a field a variable binds.`,
      `Did you mean: ${nearest(field, [...VARIABLE_ALIASES, ...NODE_BINDABLE, ...TEXT_FIELDS], 3).join(", ")}?`);
  }
  if (target.fields.every((f) => NODE_BINDABLE.has(f) && f !== "characters" && f !== "visible")) return only("FLOAT");
  return { takes: (t) => t !== "COLOR", what: "no COLOR variable (a colour binds fill, stroke or effect.color)" };
}

/** A spec `sizing` per axis, lower-cased: a string names both axes. */
function sizingAxes(sizing: unknown): { width?: string | undefined; height?: string | undefined } {
  const word = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : undefined);
  if (typeof sizing === "string") return { width: word(sizing), height: word(sizing) };
  if (!isSpecNode(sizing)) return {};
  const s = sizing as SizingSpec;
  return { width: word(s.width), height: word(s.height) };
}

/** The axes a spec `sizing` fills, as applySizing takes them; undefined when it fills none. */
function fillAxes(sizing: unknown): Sizing | undefined {
  const axes = sizingAxes(sizing);
  const out: Sizing = {};
  if (axes.width === "fill") out.horizontal = "FILL";
  if (axes.height === "fill") out.vertical = "FILL";
  return out.horizontal || out.vertical ? out : undefined;
}
const fillsAnAxis = (sizing: unknown): boolean => fillAxes(sizing) !== undefined;
const SCALE_MODES: Record<string, string> = { fill: "FILL", fit: "FIT", crop: "CROP", tile: "TILE" };
const LINE_CAPS: Record<string, string> = {
  none: "NONE", round: "ROUND", square: "SQUARE", arrow: "ARROW_LINES", "arrow-filled": "ARROW_EQUILATERAL",
  triangle: "TRIANGLE_FILLED", circle: "CIRCLE_FILLED", diamond: "DIAMOND_FILLED",
};

/** Every image URL in a spec, so they can be fetched before anything is built. */
function imageUrls(spec: SpecNode, out = new Set<string>()): Set<string> {
  if ((spec.type ?? "").toLowerCase() === "image" && spec.url) out.add(spec.url);
  for (const c of spec.children ?? []) if (isSpecNode(c)) imageUrls(c, out);
  return out;
}

/** Where the builder is, so a failure can name the spec path even when Figma threw it. */
interface Cursor {
  path: string;
}

/** What validation collects across every root, for the checks that need the whole spec. */
interface Validation {
  /** figma.editorType, "figma" when the host reports none. */
  editor: string;
  /** Every declared ref → the path that declared it. */
  refs: Map<string, string>;
  /** Nodes of a registered type, validated by their handler once the tree is known. */
  handled: Array<{ handler: SpecTypeHandler; spec: SpecNode; path: string }>;
  /** Each built-in type the spec uses → its first path, for the factory check once the shape is valid. */
  types: Map<string, string>;
}

/** The registered handler for a spec node of a type the builder does not own. */
function handlerOf(spec: SpecNode): SpecTypeHandler | undefined {
  const type = (spec.type ?? "frame").toLowerCase();
  return NODE_TYPES.has(type) ? undefined : specType(type);
}

const isAutoLayout = (layout: string | undefined) => layout === "horizontal" || layout === "vertical";

/** `ref`: a token another node can name, declared once in the whole call. */
function checkRef(spec: SpecNode, path: string, v: Validation): void {
  if (spec.ref === undefined) return;
  if (typeof spec.ref !== "string" || !REF_TOKEN.test(spec.ref)) {
    refuse(path, `\`${path}.ref\` must be a name such as "card_a": a letter or _ first, then letters, digits, _ or -.`);
  }
  const earlier = v.refs.get(spec.ref);
  if (earlier) refuse(path, `\`${path}.ref\` "${spec.ref}" is already the ref of ${earlier}: each ref names one node.`);
  v.refs.set(spec.ref, path);
}

/**
 * A node of a registered type (spec-types.ts): its editors, its fields — a
 * stray key refused with the nearest name, as for the built-in types — and
 * where it may sit. Its own validate() runs once every ref is known.
 */
function validateHandled(spec: SpecNode, path: string, v: Validation, handler: SpecTypeHandler, type: string, parentLayout?: string): number {
  if (!specTypeRunsIn(handler, v.editor)) {
    throw new BridgeError(ErrorCode.UNSUPPORTED, `A "${type}" at ${path} builds in ${handler.editors.map(editorName).join(" and ")} files; this is a ${editorName(v.editor)} file.`, {
      partial: { created: [], failedAt: path },
    });
  }
  const allowed = new Set<string>([...UNIVERSAL_SPEC_FIELDS, ...handler.fields, ...(handler.container ? ["children"] : [])]);
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) refuse(path, `\`${path}.${key}\` is not a field of a ${type}.`, `Did you mean: ${nearest(key, [...allowed], 3).join(", ")}? The grammar: figma_get_guide { topic: "spec" }.`);
  }
  if (spec.name !== undefined && typeof spec.name !== "string") refuse(path, `\`${path}.name\` must be text.`);
  checkRef(spec, path, v);
  for (const key of ["x", "y"] as const) {
    if (spec[key] === undefined) continue;
    if (isAutoLayout(parentLayout)) refuse(path, `\`${path}.${key}\` is ignored in an auto-layout: the layout places this node.`);
    if (parentLayout === "arranged") refuse(path, `\`${path}.${key}\`: the section's \`arrange\` places this node.`, "Drop x/y here, or drop arrange from the section.");
  }
  // Built after the tree, in the container that declares it: an auto-layout would move it as an item.
  if (handler.deferred && isAutoLayout(parentLayout)) {
    refuse(path, `A "${type}" at ${path} cannot sit in an auto-layout, which would place it as one of its items.`, "Declare it in a section, a frame without layout, or at the top level.");
  }
  const kids = spec.children;
  if (kids !== undefined && !Array.isArray(kids)) refuse(path, `\`${path}.children\` must be an array.`);
  v.handled.push({ handler, spec, path });
  let count = 1;
  (kids ?? []).forEach((child, i) => {
    if (!isSpecNode(child)) refuse(path, `\`children[${i}]\` at ${path} is not an object.`);
    count += validateTree(child, `${path}.children[${i}]`, v, false, "none");
  });
  return count;
}

/**
 * Reject a structurally invalid spec before anything is created. A spec that
 * fails here leaves the canvas untouched, and says so (`partial.created: []`),
 * which is also what lets a corrected retry reuse the same idempotencyKey.
 * `parentLayout` is the parent's layout ("horizontal", "vertical", "none", or
 * "arranged" inside a section that arranges its children); undefined for a root,
 * whose parent createFromSpec checks once it is resolved.
 */
function validateTree(spec: SpecNode, path: string, v: Validation, insideComponent = false, parentLayout?: string): number {
  const type = (spec.type ?? "frame").toLowerCase();
  const handler = handlerOf(spec);
  if (handler) return validateHandled(spec, path, v, handler, type, parentLayout);
  if (!NODE_TYPES.has(type)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `Unknown spec type "${spec.type}" at ${path}.`, {
      hint: `Use one of: ${[...NODE_TYPES, ...specTypeNames()].join(", ")}.`,
    });
  }
  refuseInEditor(spec, type, path, v.editor);
  checkRef(spec, path, v);
  if (type === "component" && insideComponent) {
    // createComponentFromNode refuses a node inside a component (typings, 1.141.0).
    throw new BridgeError(ErrorCode.INVALID_PARAM, `A "component" at ${path} sits inside another component.`, {
      hint: "Make the inner one a frame, or build it separately and place an instance of it.",
    });
  }
  if (type === "instance") {
    const sources = (["componentId", "componentKey", "componentSetKey"] as const).filter((k) => spec[k] !== undefined);
    if (sources.length !== 1 || sources.some((k) => typeof spec[k] !== "string" || !(spec[k] as string).trim())) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `An "instance" at ${path} needs exactly one of \`componentId\`, \`componentKey\` or \`componentSetKey\`.`, {
        hint: "componentId is a local COMPONENT or COMPONENT_SET; a key imports a published library component or set.",
      });
    }
  }
  if (type === "instance" && Array.isArray(spec.children) && spec.children.length) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `An "instance" at ${path} cannot take \`children\`: its content comes from the component.`);
  }
  if (!CONTAINER_TYPES.has(type) && type !== "instance" && Array.isArray(spec.children) && spec.children.length) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `A "${type}" at ${path} cannot take \`children\`.`, {
      hint: "Wrap it in a frame with the other elements, or put the children next to it.",
    });
  }
  const allowed = FIELDS[type]!;
  for (const key of Object.keys(spec)) {
    if (allowed.has(key)) continue;
    refuse(path, `\`${path}.${key}\` is not a field of a${/^[aeiou]/.test(type) ? "n" : ""} ${type}.`, `Did you mean: ${nearest(key, [...allowed], 3).join(", ")}? The grammar: figma_get_guide { topic: "spec" }.`);
  }
  if (spec.positioning !== undefined) {
    const pos = typeof spec.positioning === "string" ? spec.positioning.toLowerCase() : "";
    if (!POSITIONINGS.has(pos)) refuse(path, `\`${path}.positioning\` must be auto or absolute.`);
    // The root's parent is only known once it is resolved: createFromSpec checks it there.
    if (pos === "absolute" && parentLayout !== undefined && parentLayout !== "horizontal" && parentLayout !== "vertical") {
      refuse(path, `\`${path}.positioning: absolute\` needs a parent with auto-layout; in this parent x/y already place it.`);
    }
    // FILL and ABSOLUTE exclude each other in Figma [C-095].
    if (pos === "absolute" && fillsAnAxis(spec.sizing)) {
      refuse(path, `\`${path}\` cannot both fill its parent and sit outside its flow (positioning absolute).`, "Give it a width/height instead of sizing fill.");
    }
  }
  if (type === "svg") {
    if (spec.color !== undefined && spec.colorVariable !== undefined) refuse(path, `\`${path}\`: give \`color\` or \`colorVariable\`, not both.`);
    // On an svg node these would land on the wrapper frame and paint a box
    // behind the icon — never the vectors the caller means.
    for (const [mapName, map] of [["variables", spec.variables], ["style", spec.style]] as const) {
      for (const key of ["fill", "fills", "background", "stroke", "strokes"]) {
        if (map && typeof map === "object" && key in map) {
          refuse(path, `\`${path}.${mapName}.${key}\` on an svg would paint the wrapper frame, not the icon.`, "Use `colorVariable` (a COLOR variable) or `color` to recolour the icon's vectors.");
        }
      }
    }
  }
  if (spec.variableModes !== undefined) {
    const m = spec.variableModes;
    if (!isSpecNode(m) || Object.entries(m).some(([k, v]) => !k.trim() || typeof v !== "string" || !v.trim())) {
      refuse(path, `\`${path}.variableModes\` maps a collection to a mode, e.g. { "Theme": "Dark" }.`);
    }
  }
  if (type === "instance") {
    if (spec.variant !== undefined && (typeof spec.variant !== "string" || !parseVariant(spec.variant))) {
      refuse(path, `\`${path}.variant\` names a variant as "Property=Value, Other=Value", e.g. "Size=Large, State=Hover".`);
    }
    if (spec.properties !== undefined && !isPropertyMap(spec.properties)) {
      refuse(path, `\`${path}.properties\` maps a property name to text or true/false, e.g. { "Label": "Buy now", "Show icon": false }.`);
    }
    if (spec.nested !== undefined && (!isSpecNode(spec.nested) || Object.values(spec.nested).some((v) => !isPropertyMap(v)))) {
      refuse(path, `\`${path}.nested\` maps a nested instance's layer name to its properties, e.g. { "Icon": { "Glyph": "Star" } }.`);
    }
  }
  if ((type === "polygon" || type === "star") && spec.pointCount !== undefined && (!Number.isInteger(spec.pointCount) || spec.pointCount < 3)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.pointCount\` must be an integer >= 3.`);
  }
  if (type === "star" && spec.innerRadius !== undefined && (typeof spec.innerRadius !== "number" || spec.innerRadius < 0 || spec.innerRadius > 1)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.innerRadius\` must be between 0 and 1.`);
  }
  if (type === "vector" && (typeof spec.path !== "string" || !spec.path.trim() || !PATH_DATA.test(spec.path))) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `A "vector" at ${path} needs \`path\`: SVG path data, e.g. "M0 0 L24 12 L0 24 Z".`);
  }
  if (type === "svg" && (typeof spec.svg !== "string" || !/<svg[\s>]/i.test(spec.svg))) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `An "svg" at ${path} needs \`svg\`: SVG markup with an <svg> element.`);
  }
  if (type === "image") {
    if (typeof spec.url !== "string" || !/^https?:\/\//i.test(spec.url)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `An "image" at ${path} needs \`url\` (http or https; PNG, JPEG or GIF).`);
    }
    if (spec.scaleMode !== undefined && !SCALE_MODES[String(spec.scaleMode).toLowerCase()]) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.scaleMode\` must be fill, fit, crop or tile.`);
    }
  }
  if (type === "line") {
    if (typeof spec.width !== "number" || spec.width <= 0) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `A "line" at ${path} needs \`width\`: its length in px (turn it with \`rotation\`).`);
    }
    if (spec.cap !== undefined && !LINE_CAPS[String(spec.cap).toLowerCase()]) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.cap\` must be one of: ${Object.keys(LINE_CAPS).join(", ")}.`);
    }
  }
  for (const [mapName, map] of [["variables", spec.variables], ["style", spec.style]] as const) {
    if (map === undefined) continue;
    if (!map || typeof map !== "object" || Array.isArray(map) || Object.values(map).some((v) => typeof v !== "string")) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.${mapName}\` must map a field to a name, e.g. { "fill": "color/bg" }.`);
    }
  }
  for (const key of Object.keys(spec.style ?? {})) {
    if (!isStyleTarget(key)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.style.${key}\`: the key must be fill, stroke, text, effect or grid.`);
    }
  }
  for (const field of Object.keys(spec.variables ?? {})) variableRule(field, path);
  for (const [key, min] of Object.entries(NUMBER_FIELDS)) {
    const v = (spec as Record<string, unknown>)[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || (min !== undefined && v < min))) {
      refuse(path, `\`${path}.${key}\` must be a number${min === undefined ? "" : ` >= ${min}`}.`, min === 0.01 ? "Figma refuses a size below 0.01." : undefined);
    }
  }
  // One grammar with figma_set_text_properties, so what figma_get_design_context
  // reads ("32px", "-1%") writes back as is; a bare number stays px.
  try {
    parseLineHeight(spec.lineHeight, `${path}.lineHeight`, false);
    parseLength(spec.letterSpacing, `${path}.letterSpacing`, false);
  } catch (err) {
    refuse(path, err instanceof Error ? err.message : String(err));
  }
  if (spec.align !== undefined && !TEXT_ALIGN[String(spec.align).toLowerCase()]) {
    refuse(path, `\`${path}.align\` must be left, center, right or justified.`, "start and end are alignX/alignY words; a text aligns left or right.");
  }
  // Everything a build would trip over half-way is checked here instead, while
  // nothing exists yet: layout, alignment, padding, colours.
  const layout = (spec.layout ?? "none").toLowerCase();
  if (!["horizontal", "vertical", "none"].includes(layout)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.layout\` must be "horizontal", "vertical" or "none".`);
  }
  const effective = layout === "none" && type === "button" ? "horizontal" : layout;
  // Each of these used to be dropped without a word when nothing could act on
  // it: spacing without a layout, x/y that the parent's layout overrides, a
  // sizing word that is misspelt, or that the node or its parent cannot take.
  if (type === "section") validateSectionLayout(spec, path);
  else {
    for (const key of ["gap", "padding"] as const) {
      if (spec[key] !== undefined && effective === "none") refuse(path, `\`${path}.${key}\` spaces an auto-layout's items: it needs layout "horizontal" or "vertical".`);
    }
  }
  if (spec.list !== undefined && !TEXT_LISTS[String(spec.list).toLowerCase()]) {
    refuse(path, `\`${path}.list\` must be unordered, ordered or none.`, "A list is one text: each line a bullet or a number (figma_get_guide topic spec).");
  }
  const parentIsAuto = isAutoLayout(parentLayout);
  const inFlow = parentIsAuto && String(spec.positioning).toLowerCase() !== "absolute";
  for (const key of ["x", "y"] as const) {
    if (spec[key] !== undefined && inFlow) {
      refuse(path, `\`${path}.${key}\` is ignored in an auto-layout: the layout places this node.`, 'Add positioning: "absolute" to place it by x/y inside an auto-layout.');
    }
    if (spec[key] !== undefined && parentLayout === "arranged") {
      refuse(path, `\`${path}.${key}\`: the section's \`arrange\` places this node.`, "Drop x/y here, or drop arrange from the section.");
    }
  }
  if (spec.sizing !== undefined) {
    const s: unknown = spec.sizing;
    const word = (v: unknown) => typeof v === "string" && SIZING_WORDS.has(v.toLowerCase());
    const shaped = typeof s === "string" ? word(s)
      : isSpecNode(s) && Object.keys(s).length > 0 && Object.entries(s).every(([k, v]) => (k === "width" || k === "height") && word(v));
    if (!shaped) {
      refuse(path, `\`${path}.sizing\` must be "fixed", "hug" or "fill", or { "width": …, "height": … } with those words.`, "The spec names the axes width and height.");
    }
    const axes = sizingAxes(s);
    if ((axes.width === "hug" || axes.height === "hug") && type !== "text" && !(["frame", "button", "component"].includes(type) && effective !== "none")) {
      refuse(path, `\`${path}.sizing: hug\` works on auto-layout frames and text — this ${type} ${CONTAINER_TYPES.has(type) ? "has no layout" : "keeps the size it is given"}.`);
    }
    // The root's parent is only known once it is resolved: createFromSpec checks it there.
    if ((axes.width === "fill" || axes.height === "fill") && parentLayout !== undefined && !parentIsAuto) {
      refuse(path, `\`${path}.sizing: fill\` takes the space of an auto-layout parent — its parent has none.`, "Give the parent a layout, or this node a width/height.");
    }
  }
  alignmentFor(effective.toUpperCase(), spec.alignX, spec.alignY, `${path}.`);
  normalizePadding(spec.padding, `${path}.padding`);
  if (spec.wrap !== undefined && typeof spec.wrap !== "boolean") refuse(path, `\`${path}.wrap\` must be true or false.`);
  if (spec.wrap === true && effective !== "horizontal") refuse(path, `\`${path}.wrap\` wraps a row: it needs layout "horizontal".`);
  wrapFields(spec as unknown as Record<string, unknown>, spec.wrap === true, `${path}.`);
  for (const key of ["background", "fill", "stroke", "color"] as const) {
    if (spec[key] !== undefined) parseColor(spec[key], `${path}.${key}`);
  }
  if (spec.children !== undefined && !Array.isArray(spec.children)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.children\` must be an array.`);
  }
  if (!v.types.has(type)) v.types.set(type, path);
  let count = 1;
  const childLayout = type !== "section" ? effective : spec.arrange !== undefined ? "arranged" : "none";
  (spec.children ?? []).forEach((child, i) => {
    if (!isSpecNode(child)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`children[${i}]\` at ${path} is not an object.`);
    }
    count += validateTree(child, `${path}.children[${i}]`, v, insideComponent || type === "component", childLayout);
  });
  return count;
}

/** text `list`, as setRangeListOptions takes it (TextListOptions, plugin-api.d.ts:5475). */
const TEXT_LISTS: Record<string, string> = { unordered: "UNORDERED", ordered: "ORDERED", none: "NONE" };

/**
 * A section's own layout: `arrange` places its children in a row, a column or
 * a grid from their real sizes; `hug` fits the section to them. `gap` spaces
 * what arrange places and `padding` insets both — on their own they would act
 * on nothing, so they are refused without them.
 */
function validateSectionLayout(spec: SpecNode, path: string): void {
  if (spec.arrange !== undefined) {
    if (typeof spec.arrange !== "string") refuse(path, `\`${path}.arrange\` must be "row", "column" or "grid:N".`);
    try {
      arrangeColumns(spec.arrange, 1);
    } catch (err) {
      refuse(path, `\`${path}.arrange\`: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }
  for (const key of ["hug", "contentsHidden"] as const) {
    if (spec[key] !== undefined && typeof spec[key] !== "boolean") refuse(path, `\`${path}.${key}\` must be true or false.`);
  }
  if (spec.gap !== undefined && spec.arrange === undefined) {
    refuse(path, `\`${path}.gap\` spaces the children \`arrange\` places: add arrange ("row", "column" or "grid:N").`);
  }
  if (typeof spec.gap === "number" && spec.gap < 0) refuse(path, `\`${path}.gap\` must be a number >= 0.`);
  if (spec.padding !== undefined && spec.arrange === undefined && spec.hug !== true) {
    refuse(path, `\`${path}.padding\` insets what \`arrange\` or \`hug\` lays out: add one of them.`);
  }
  if (spec.hug === true && (spec.width !== undefined || spec.height !== undefined)) {
    refuse(path, `\`${path}\`: \`hug\` sizes the section from its children — drop width/height, or hug.`);
  }
}

/** "Size=Large, State=Hover" as pairs, or null when it is not that shape. */
function parseVariant(v: string): Array<[string, string]> | null {
  const pairs = v.split(",").map((p) => p.split("=").map((s) => s.trim()));
  return pairs.length && pairs.every((p) => p.length === 2 && p[0] && p[1]) ? (pairs as Array<[string, string]>) : null;
}

/** Every node of a spec with its path, root first — the order buildNode visits them in. */
function eachSpec(spec: SpecNode, path: string, visit: (s: SpecNode, path: string) => void): void {
  visit(spec, path);
  (spec.children ?? []).forEach((c, i) => {
    if (isSpecNode(c)) eachSpec(c, `${path}.children[${i}]`, visit);
  });
}

/**
 * Whether a frame placed in `parent` sits directly on the canvas. createFrame()
 * starts white: on the canvas that is an artboard, as in Figma's own editor,
 * but inside another frame it is a white box painted behind its siblings — so a
 * nested frame with no `background` is made transparent.
 */
const onCanvas = (parent: NodeLikeW) => parent.type === "PAGE" || parent.type === "PAGE_NODE" || parent.type === "SECTION";

/**
 * Run every check that can fail before the node exists. Figma places a node on
 * the page the moment it is created, so a check failing after that would leave
 * an unreported node behind. Failing here provably changed nothing and says so
 * (`created: []`), which also frees the idempotencyKey for a corrected retry.
 */
async function beforeCreating<T>(prepare: () => T | Promise<T>): Promise<T> {
  // The shared wrapper (guard.ts): one convention for every write op [C-096].
  return beforeMutating(prepare);
}

/**
 * The writes that follow a single-node create, as one unit. A write Figma
 * refuses there — an append into a parent that takes no children, a sizing
 * rule — used to leave the new node at the page origin, unreported and never
 * in its parent. It is removed instead, so the refusal provably changed
 * nothing and says so (`created: []`).
 */
function afterCreating<T>(node: NodeLikeW, write: () => T): T {
  try {
    return write();
  } catch (err) {
    node.remove?.();
    const e = err instanceof BridgeError ? err : undefined;
    throw new BridgeError(e?.code ?? ErrorCode.INVALID_PARAM, err instanceof Error ? err.message : String(err), {
      ...(e?.hint ? { hint: e.hint } : {}),
      partial: { created: [] },
    });
  }
}

/** A width or height a single-node create takes: Figma's resize() refuses anything under 0.01 (typings 1.141.0). */
function sizeParam(params: Record<string, unknown>, key: string, required: boolean): number | undefined {
  const v = params[key];
  if (v === undefined && !required) return undefined;
  const n = num(params, key);
  if (n === undefined || n < 0.01) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${key}\` must be a number >= 0.01.`, { hint: "Figma refuses a size below 0.01." });
  return n;
}

/** One spec `instance`, resolved before the build: what to instance and what to set on it. */
interface ResolvedInstance {
  /** The COMPONENT instantiate() is given: the one named, a picked variant, or the set's default. */
  component: NodeLikeW;
  properties: Record<string, string | boolean>;
  nested: Array<{ name: string; properties: Record<string, string | boolean> }>;
}

/** Everything a spec names by id, key or name, resolved while nothing exists yet. */
interface Resolved {
  /** Image URL to image hash. */
  images: Map<string, string>;
  /** By spec path. */
  instances: Map<string, ResolvedInstance>;
  /** By spec path: the collection OBJECTS and mode ids to pin [C-105]. */
  modes: Map<string, Array<{ collection: CollectionLike; modeId: string }>>;
  /** By spec path: the bound paint an svg's vectors take. */
  iconPaints: Map<string, unknown>;
  /** By the map's value: a variable name or id. */
  variables: Map<string, VariableLike>;
  /** By `<slot>|<value>`: a style name or id. */
  styles: Map<string, { id: string; name: string; kind: string }>;
}

/** Everything one build shares: where nodes go, what was made, where it is, its pace. */
interface Build extends Resolved {
  figma: FigmaWrite;
  out: Created[];
  at: Cursor;
  pacer: Pacer;
  ctx: OpContext;
  /** figma.editorType, "figma" when the host reports none. */
  editor: string;
  /**
   * Attach each node to its real parent the moment it exists, then size, paint
   * and place it. On for a build into a slide: there a node positioned before
   * its final append can land 240 px off, at any depth, intermittently
   * (figma-use-slides slide-gotchas.md "Position after appendChild") [C-146].
   * Off elsewhere, which keeps the Design build order exactly as it was.
   */
  topDown: boolean;
  /** Every ref the spec declares, and the node built for it once it exists. */
  declared: ReadonlySet<string>;
  refs: Map<string, NodeLikeW>;
  /** Registered types built after the tree, in the container that declares them (connectors). */
  deferred: Array<{ spec: SpecNode; path: string; parent: NodeLikeW; handler: SpecTypeHandler; root?: number }>;
  /** Top-down only: every x/y the spec placed, read back afterwards as drift. */
  placed: Array<{ node: NodeLikeW; path: string; x?: number; y?: number }>;
}

/** Set x/y after the append; an omitted axis keeps Figma's placement. Top-down builds remember what they asked for. */
function placeAt(b: Build, node: NodeLikeW, path: string, x?: number, y?: number): void {
  const at = node as unknown as { x: number; y: number };
  if (typeof x === "number") at.x = x;
  if (typeof y === "number") at.y = y;
  if (b.topDown && (typeof x === "number" || typeof y === "number")) {
    b.placed.push({ node, path, ...(typeof x === "number" ? { x } : {}), ...(typeof y === "number" ? { y } : {}) });
  }
}

/**
 * Where each placed node ended up against where the spec put it. Read back,
 * never compensated: adding 240 back hides the order bug and re-triggers it
 * under other state (slide-gotchas.md "Diagnosing offset bugs") [C-146].
 */
function driftOf(b: Build): Array<{ id: string; path: string; dx: number; dy: number }> {
  const out: Array<{ id: string; path: string; dx: number; dy: number }> = [];
  for (const p of b.placed) {
    // A read that throws is not drift: the build itself succeeded, and this is only its proof.
    const x = tryGet<number>(p.node, "x");
    const y = tryGet<number>(p.node, "y");
    if (!x.ok || !y.ok || typeof x.value !== "number" || typeof y.value !== "number") continue;
    const dx = p.x === undefined ? 0 : Math.round((x.value - p.x) * 100) / 100;
    const dy = p.y === undefined ? 0 : Math.round((y.value - p.y) * 100) / 100;
    if (dx !== 0 || dy !== 0) out.push({ id: p.node.id, path: p.path, dx, dy });
  }
  return out;
}

/** A ref this spec declared (once its node is built), else a node id in this file. */
async function resolveRef(b: Build, refOrId: string): Promise<NodeLikeW> {
  const built = b.refs.get(refOrId);
  if (built) return built;
  if (b.declared.has(refOrId)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `ref "${refOrId}" names a node this spec has not built yet.`, {
      hint: "Declare it earlier in the spec; a connector is built last, so it can name any node of the call.",
    });
  }
  const id = refOrId.replace(/^(I?\d+)-(\d+)$/, "$1:$2");
  const node = await b.figma.getNodeByIdAsync(id);
  if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node \`${id}\`: neither a ref of this spec nor an id in this file.`);
  return node;
}

/**
 * Build a node of a registered type: its handler creates, records, appends and
 * places it (spec-types.ts), and the builder never appends it again.
 */
async function buildHandled(spec: SpecNode, path: string, b: Build, parent: NodeLikeW, handler: SpecTypeHandler): Promise<NodeLikeW> {
  b.at.path = path;
  const entry: Created = { id: "", name: "", path };
  let recorded = false;
  const sb: SpecBuild = {
    editor: b.editor,
    record: (n) => {
      if (!recorded) {
        recorded = true;
        entry.id = n.id;
        entry.name = n.name;
        b.out.push(entry);
      }
      return n;
    },
    append: (p, c) => append(p, c),
    place: (n, x, y) => placeAt(b, n, path, x, y),
    resolveRef: (r) => resolveRef(b, r),
    loadFont: async (font) => {
      try {
        await b.figma.loadFontAsync(font);
      } catch (err) {
        throw new BridgeError(ErrorCode.FONT_LOAD_FAILED, `\`${path}\`: "${font.family} ${font.style}" did not load: ${err instanceof Error ? err.message : String(err)}`, {
          hint: "figma_get_fonts lists the fonts this Figma can load.",
        });
      }
    },
    yieldToHost: async () => {
      await b.ctx.yieldToHost();
      if (b.ctx.isCancelled()) throw new CancelledError(b.out.length);
    },
  };
  const node = sb.record(await handler.build(spec as SpecFields, parent, sb));
  b.at.path = path;
  if (typeof spec.name === "string") node.name = spec.name;
  entry.name = node.name;
  if (spec.ref) b.refs.set(spec.ref, node);
  await b.pacer.tick();
  if (handler.container) await buildChildren(spec, path, b, node, "none");
  return node;
}

type ComponentApi = FigmaWrite & {
  importComponentByKeyAsync?(key: string): Promise<NodeLikeW>;
  importComponentSetByKeyAsync?(key: string): Promise<NodeLikeW>;
  variables?: FigmaWrite["variables"] & { setBoundVariableForPaint?(paint: unknown, field: string, v: VariableLike): unknown };
};

type PropertyDefs = Record<string, { type: string; variantOptions?: readonly string[] }>;

/** A component's property definitions — read on the set for a variant, where reading them on the variant throws. */
function definitionsOf(component: NodeLikeW): PropertyDefs {
  const owner = component.parent?.type === "COMPONENT_SET" ? component.parent : component;
  try {
    return ((owner as unknown as { componentPropertyDefinitions?: PropertyDefs }).componentPropertyDefinitions ?? {}) as PropertyDefs;
  } catch {
    return {};
  }
}

/**
 * A properties map checked against the definitions, keyed the way setProperties
 * wants it (TEXT / BOOLEAN / INSTANCE_SWAP with their `#id`). Every value is
 * checked here, so a typo fails before the first node rather than after the
 * instance exists.
 */
async function resolveProperties(defs: PropertyDefs, props: Record<string, string | boolean>, field: string, path: string): Promise<Record<string, string | boolean>> {
  const out: Record<string, string | boolean> = {};
  const listed = () => Object.keys(defs).map((k) => `${k} (${defs[k]!.type})`).join(", ") || "none";
  for (const [name, value] of Object.entries(props)) {
    const key = resolvePropertyKey(defs, name);
    if (!key) refuse(path, `\`${field}\`: the component has no property "${name}".`, `Its properties: ${listed()}.`);
    const def = defs[key]!;
    if (def.type === "VARIANT") {
      const options = def.variantOptions ?? [];
      if (typeof value !== "string" || (options.length && !options.includes(value))) {
        refuse(path, `\`${field}.${name}\` must be one of: ${options.join(", ")}.`);
      }
      out[key] = value;
    } else if (def.type === "BOOLEAN") {
      if (value !== true && value !== false && value !== "true" && value !== "false") refuse(path, `\`${field}.${name}\` is a BOOLEAN: true or false.`);
      out[key] = value === true || value === "true";
    } else if (def.type === "INSTANCE_SWAP") {
      const target = typeof value === "string" ? await api().getNodeByIdAsync(value) : null;
      if (!target || target.type !== "COMPONENT") refuse(path, `\`${field}.${name}\` swaps in a component: give a COMPONENT id (got ${JSON.stringify(value)}).`);
      out[key] = value as string;
    } else if (def.type === "SLOT") {
      // setProperties throws cannotSetSlotProperty for a slot [C-112].
      refuse(path, `\`${field}.${name}\` is a SLOT: a slot is filled with children, not set as a property.`, "Build the instance, then create content with parentId = the slot.");
    } else {
      if (typeof value !== "string") refuse(path, `\`${field}.${name}\` is ${def.type}: give text.`);
      out[key] = value;
    }
  }
  return out;
}

/** The variant of `set` whose name holds every pair asked for; the rest follow the default variant. */
function pickVariant(set: NodeLikeW, variant: string, path: string): NodeLikeW {
  const want = parseVariant(variant)!;
  const pairsOf = (name: string) => new Map(parseVariant(name) ?? []);
  const variants = (set.children ?? []).filter((c) => c.type === "COMPONENT");
  const matches = variants.filter((v) => {
    const have = pairsOf(v.name);
    return want.every(([k, val]) => have.get(k) === val);
  });
  if (!matches.length) {
    refuse(path, `\`${path}.variant\` "${variant}" matches no variant of "${set.name}".`, `Its variants: ${variants.slice(0, 12).map((v) => v.name).join("; ")}${variants.length > 12 ? "; …" : ""}`);
  }
  const fallback = pairsOf((set as unknown as { defaultVariant?: NodeLikeW }).defaultVariant?.name ?? "");
  const score = (v: NodeLikeW) => [...pairsOf(v.name)].filter(([k, val]) => fallback.get(k) === val).length;
  return [...matches].sort((a, b) => score(b) - score(a))[0]!;
}

/** The INSTANCE layers named `name` anywhere under `root`. */
function instancesNamed(root: NodeLikeW, name: string): NodeLikeW[] {
  const r = root as unknown as { findAll?: (p: (n: NodeLikeW) => boolean) => NodeLikeW[] };
  return typeof r.findAll === "function" ? r.findAll((n) => n.type === "INSTANCE" && n.name === name) : [];
}

async function resolveInstance(spec: SpecNode, path: string): Promise<ResolvedInstance> {
  const figma = api() as ComponentApi;
  let source: NodeLikeW;
  if (spec.componentId) {
    const found = await figma.getNodeByIdAsync(spec.componentId);
    if (!found) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node \`${spec.componentId}\` to instance at ${path}.`);
    if (found.type !== "COMPONENT" && found.type !== "COMPONENT_SET") {
      refuse(path, `\`${spec.componentId}\` at ${path} is a ${found.type}, not a component or component set.`);
    }
    source = found;
  } else {
    // Import by key [C-110]: present in the typings, unmeasured in this
    // plugin's manifest — so an absent API says which one, and Figma's own
    // refusal (an unpublished key) is passed on with the rule.
    const isSet = spec.componentSetKey !== undefined;
    const key = (isSet ? spec.componentSetKey : spec.componentKey)!;
    const name = isSet ? "importComponentSetByKeyAsync" : "importComponentByKeyAsync";
    const load = figma[name];
    if (typeof load !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, `This editor type has no ${name}: a library ${isSet ? "component set" : "component"} cannot be imported here.`);
    try {
      source = await load.call(figma, key);
    } catch (err) {
      refuse(path, `Figma could not import the ${isSet ? "component set" : "component"} with key "${key}" at ${path}: ${err instanceof Error ? err.message : String(err)}`,
        "Only a PUBLISHED library component imports by key; the key comes from the library's components (figma_get_design_context on an instance of it).");
    }
  }
  let component = source;
  if (source.type === "COMPONENT_SET") {
    const fallback = (source as unknown as { defaultVariant?: NodeLikeW }).defaultVariant;
    component = spec.variant ? pickVariant(source, spec.variant, path) : fallback ?? source;
  } else if (spec.variant) {
    refuse(path, `\`${path}.variant\` picks a variant of a component set, and this is a single COMPONENT.`, "Give the set's id (or componentSetKey), or drop `variant`.");
  }
  const properties = await resolveProperties(definitionsOf(component), spec.properties ?? {}, `${path}.properties`, path);
  const nested: ResolvedInstance["nested"] = [];
  for (const [name, props] of Object.entries(spec.nested ?? {})) {
    const hits = instancesNamed(component, name);
    if (hits.length !== 1) {
      refuse(path, hits.length
        ? `\`${path}.nested.${name}\`: ${hits.length} nested instances are named "${name}"; rename one so the name picks a single layer.`
        : `\`${path}.nested.${name}\`: the component has no nested instance named "${name}".`,
        hits.length ? `They are ${hits.map((h) => h.id).join(", ")}.` : "figma_get_design_context on the component lists its layers.");
    }
    const inner = hits[0] as unknown as { getMainComponentAsync?: () => Promise<NodeLikeW | null>; mainComponent?: NodeLikeW | null };
    const main = typeof inner.getMainComponentAsync === "function" ? await inner.getMainComponentAsync() : inner.mainComponent ?? null;
    if (!main) refuse(path, `\`${path}.nested.${name}\`: its main component could not be read.`);
    nested.push({ name, properties: await resolveProperties(definitionsOf(main), props, `${path}.nested.${name}`, path) });
  }
  return { component, properties, nested };
}

/**
 * Resolve everything the spec names before the first node exists — instances
 * (by id or key) with their properties, variable modes, an svg's colour
 * variable, the variables and style maps, each against the field or slot it
 * fills — so a typo or a mismatch in any of them fails with
 * `created: []` instead of half-way through the build. `at.path` follows along,
 * so the failure names the node it is about.
 */
async function resolveSpec(roots: ReadonlyArray<[SpecNode, string]>, at: Cursor, images: Map<string, string>): Promise<Resolved> {
  const figma = api() as ComponentApi;
  const r: Resolved = { images, instances: new Map(), modes: new Map(), iconPaints: new Map(), variables: new Map(), styles: new Map() };
  const nodes: Array<[SpecNode, string]> = [];
  for (const [root, rootPath] of roots) eachSpec(root, rootPath, (s, p) => nodes.push([s, p]));
  for (const [s, path] of nodes) {
    at.path = path;
    const type = (s.type ?? "frame").toLowerCase();
    if (!NODE_TYPES.has(type)) continue; // a registered type resolves what it names itself

    if (type === "instance") r.instances.set(path, await resolveInstance(s, path));
    if (s.variableModes) {
      const pins: Array<{ collection: CollectionLike; modeId: string }> = [];
      for (const [ref, mode] of Object.entries(s.variableModes)) {
        const collection = await resolveCollection(ref.startsWith("VariableCollectionId:") ? { id: ref } : { name: ref }, `${path}.variableModes`);
        pins.push({ collection, modeId: resolveMode(collection, mode).modeId });
      }
      r.modes.set(path, pins);
    }
    if (type === "svg" && s.colorVariable !== undefined) {
      const ref = String(s.colorVariable);
      const v = await findVariable(ref.startsWith("VariableID:") ? { id: ref } : { name: ref }, `${path}.colorVariable`);
      if (v.resolvedType !== "COLOR") refuse(path, `\`${path}.colorVariable\` "${v.name}" is a ${v.resolvedType} variable; an icon colour needs a COLOR one.`);
      const bind = figma.variables?.setBoundVariableForPaint;
      if (typeof bind !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type has no setBoundVariableForPaint: an icon cannot be bound to a variable here.");
      // A new paint object, not a document change: setBoundVariableForPaint returns a copy.
      r.iconPaints.set(path, bind.call(figma.variables, { type: "SOLID", color: { r: 0, g: 0, b: 0 } }, "color", v));
    }
    for (const [field, ref] of Object.entries(s.variables ?? {})) {
      if (!r.variables.has(ref)) r.variables.set(ref, await findVariable(ref.startsWith("VariableID:") ? { id: ref } : { name: ref }, `${path}.variables.${field}`));
      const v = r.variables.get(ref)!;
      const rule = variableRule(field, path);
      if (!rule.takes(v.resolvedType)) refuse(path, `\`${path}.variables.${field}\` takes ${rule.what}; "${v.name}" is ${v.resolvedType}.`);
    }
    for (const [slot, ref] of Object.entries(s.style ?? {})) {
      const key = `${slot}|${ref}`;
      if (!r.styles.has(key)) r.styles.set(key, await findStyle(ref.startsWith("S:") ? { id: ref } : { name: ref }, slot as StyleTarget));
      // A name is looked up among the slot's kind only; an id is not, so its
      // kind is checked here rather than by applyStyle mid-build.
      const style = r.styles.get(key)!;
      try {
        targetFor(style.kind, slot as StyleTarget);
      } catch {
        refuse(path, `\`${path}.style.${slot}\`: "${style.name}" is a ${style.kind} style; it cannot be applied as ${slot}.`);
      }
    }
  }
  at.path = roots[0]?.[1] ?? "spec";
  return r;
}

/**
 * An instance of a COMPONENT, or of a COMPONENT_SET's default variant. In
 * Figma Design this is a method on the component (`createInstance()`), not on
 * `figma` — `figma.createInstance` exists only on the FigJam/Buzz API
 * (@figma/plugin-typings 1.141.0), which is why instances never worked before.
 */
export function instantiate(comp: NodeLikeW): NodeLikeW {
  const target =
    comp.type === "COMPONENT_SET" ? (comp as unknown as { defaultVariant?: NodeLikeW }).defaultVariant : comp;
  const make = (target as unknown as { createInstance?: () => NodeLikeW } | undefined)?.createInstance;
  if (!target || target.type !== "COMPONENT" || typeof make !== "function") {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${comp.id}\` is a ${comp.type}, not a component or component set.`);
  }
  return make.call(target);
}

/**
 * Build one spec node and its subtree.
 *
 * Order matters and is deliberate: geometry first (so a text node resized
 * afterwards keeps its size), then content (which can change intrinsic size),
 * then layout (which re-flows children), then children (which the layout then
 * arranges), then variable bindings and styles (last, because applying a style
 * can overwrite fill and radius), then — for a `component` — the conversion,
 * which needs the finished subtree.
 *
 * `parent` is where the node ends up. A bottom-up build (Design, FigJam) leaves
 * the append to the caller once the subtree is built; a top-down one (into a
 * slide) appends here, before the first property write [C-146]. A registered
 * type always appends itself (spec-types.ts).
 */
async function buildNode(spec: SpecNode, path: string, b: Build, parent: NodeLikeW, nested: boolean): Promise<NodeLikeW> {
  const { figma, out, at } = b;
  at.path = path;
  const type = (spec.type ?? "frame").toLowerCase();
  const handler = handlerOf(spec);
  if (handler) return buildHandled(spec, path, b, parent, handler);

  // Recorded the moment it exists, before its first property write: Figma has
  // already placed it on the page, so a write it refuses — a size, an
  // alignment, the type's own setup — must still report it. The entry used to
  // be pushed after that setup, and a refusal there reported `created: []`
  // with a node on the canvas. Pre-order: `created[0]` is always the root.
  const entry: Created = { id: "", name: "", path };
  const record = <T extends NodeLikeW>(n: T, attached = false): T => {
    entry.id = n.id;
    entry.name = n.name;
    out.push(entry);
    if (b.topDown && !attached) append(parent, n);
    return n;
  };

  let node: NodeLikeW;
  if (type === "text") {
    const text = await buildText(spec, figma, record, textDefaults(b.editor));
    node = text.node;
    if (text.font.fellBack) entry.font = { family: text.font.family, style: text.font.style, fellBack: true };
  } else if (type === "instance") {
    // Resolved before the build (resolveSpec): the component, picked variant or import.
    node = record(instantiate(b.instances.get(path)!.component));
    // A width or height on an instance was read by nothing; it resizes the
    // instance as the editor does, keeping the axis it was not given.
    const inst = node as unknown as { width: number; height: number; resize(w: number, h: number): void };
    if (typeof spec.width === "number" || typeof spec.height === "number") inst.resize(spec.width ?? inst.width, spec.height ?? inst.height);
  } else if (type === "rectangle") {
    node = record(figma.createRectangle());
    applySize(node as unknown as FrameLike, spec, path, false);
  } else if (type === "ellipse") {
    node = record(figma.createEllipse());
    applySize(node as unknown as FrameLike, spec, path, false);
  } else if (type === "polygon" || type === "star") {
    const f = figma as unknown as Record<string, () => NodeLikeW>;
    const make = type === "star" ? f.createStar : f.createPolygon;
    if (typeof make !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, `This editor type cannot create a ${type}.`);
    node = record(make.call(figma));
    applySize(node as unknown as FrameLike, spec, path, false);
    const shape = node as unknown as { pointCount: number; innerRadius: number };
    if (typeof spec.pointCount === "number") shape.pointCount = spec.pointCount;
    if (type === "star" && typeof spec.innerRadius === "number") shape.innerRadius = spec.innerRadius;
  } else if (type === "line") {
    const make = (figma as unknown as { createLine?: () => NodeLikeW }).createLine;
    if (typeof make !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot create lines.");
    node = record(make.call(figma));
    const line = node as unknown as Record<string, unknown> & { resize(w: number, h: number): void };
    line.resize(spec.width!, 0); // a line takes a height of exactly 0
    line.strokes = [parseColor(spec.stroke ?? spec.color ?? "#000000", `${path}.stroke`)];
    line.strokeWeight = typeof spec.strokeWeight === "number" ? spec.strokeWeight : 1;
    if (spec.cap) line.strokeCap = LINE_CAPS[String(spec.cap).toLowerCase()];
  } else if (type === "vector") {
    // Sized here, once recorded: vectorFromPath would resize it before then.
    // Top-down, it goes straight into its parent rather than parking on the page.
    node = record(vectorFromPath(figma as never, spec.path!, undefined, undefined, b.topDown ? parent : undefined), b.topDown);
    const v = node as unknown as { width: number; height: number; rescale?(s: number): void; resize(w: number, h: number): void };
    if (typeof spec.width === "number" && typeof spec.height === "number") v.resize(spec.width, spec.height);
    else if (typeof spec.width === "number" && v.width > 0) v.rescale?.(spec.width / v.width);
    else if (typeof spec.height === "number" && v.height > 0) v.rescale?.(spec.height / v.height);
  } else if (type === "svg") {
    const make = (figma as unknown as { createNodeFromSvg?: (s: string) => NodeLikeW }).createNodeFromSvg;
    if (typeof make !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot import SVG.");
    try {
      node = record(make.call(figma, spec.svg!));
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma could not parse the SVG at ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const icon = node as unknown as Record<string, unknown> & { width: number; height: number; rescale?(s: number): void };
    const factor = typeof spec.width === "number" && icon.width > 0 ? spec.width / icon.width
      : typeof spec.height === "number" && icon.height > 0 ? spec.height / icon.height : undefined;
    if (factor && factor > 0) icon.rescale?.(factor);
    if (spec.color) recolour(icon, parseColor(spec.color, `${path}.color`));
    // One bound paint on every painted vector, so a stroke-only icon stays
    // stroke-only and the icon follows the theme with its variable.
    const bound = b.iconPaints.get(path);
    if (bound) recolour(icon, bound);
    // An <svg> with no size or viewBox comes back as a GROUP [C-086], which
    // has neither fills nor clipping to clear: writing them would throw.
    if (node.type === "FRAME") {
      icon.fills = [];
      icon.clipsContent = false;
    }
    if (!spec.name) node.name = "Icon";
  } else if (type === "image") {
    node = record(figma.createRectangle());
    applySize(node as unknown as FrameLike, { ...spec, width: spec.width ?? 400, height: spec.height ?? 300 }, path, false);
    const hash = b.images.get(spec.url!)!;
    (node as unknown as { fills: unknown[] }).fills = [
      { type: "IMAGE", imageHash: hash, scaleMode: SCALE_MODES[String(spec.scaleMode ?? "fill").toLowerCase()] },
    ];
    if (!spec.name) node.name = "Image";
  } else if (type === "section") {
    // apiHas, not a plain read: in an editor without it the read itself may throw [C-145].
    if (!apiHas("createSection")) throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot create sections.");
    node = record(figma.createSection!());
    applySize(node as unknown as FrameLike, spec, path, true);
  } else {
    // frame, button and component all start life as a frame.
    node = record(figma.createFrame());
    applySize(node as unknown as FrameLike, spec, path, true);
  }

  // A section's name may be cleared: on a board the visible title is a text
  // inside it (plan-board-content.md:81) [C-156].
  if (spec.name || (type === "section" && spec.name === "")) node.name = spec.name!;
  entry.name = node.name;

  pinModes(node, b.modes.get(path), path);
  const instance = b.instances.get(path);
  if (type === "instance" && instance) {
    const ignored = setInstanceProperties(node, instance, path);
    if (ignored.length) entry.ignored = ignored;
  }

  const asFrame = node as unknown as FrameLike;
  const hasExplicitSize = typeof spec.width === "number" || typeof spec.height === "number";

  // Auto-layout before children, so the children are laid out as they arrive.
  // A "button" is a horizontal auto-layout that hugs its label unless told otherwise.
  const declared = (spec.layout ?? "none").toLowerCase();
  const layout = declared === "none" && type === "button" ? "horizontal" : declared;
  if ((layout === "horizontal" || layout === "vertical") && has(asFrame, "layoutMode")) {
    asFrame.layoutMode = layout === "horizontal" ? "HORIZONTAL" : "VERTICAL";
    const isButton = type === "button" && declared === "none";
    asFrame.itemSpacing = typeof spec.gap === "number" ? spec.gap : isButton ? 8 : asFrame.itemSpacing ?? 0;
    const pad = normalizePadding(spec.padding, `${path}.padding`) ?? (isButton ? [12, 20, 12, 20] : null);
    if (pad) {
      asFrame.paddingTop = pad[0];
      asFrame.paddingRight = pad[1];
      asFrame.paddingBottom = pad[2];
      asFrame.paddingLeft = pad[3];
    }
    Object.assign(asFrame, alignmentFor(asFrame.layoutMode, spec.alignX, spec.alignY, `${path}.`));
    if (spec.wrap === true) {
      asFrame.layoutWrap = "WRAP";
      // After WRAP: the row gap and content alignment apply only to a wrapping frame [C-095].
      applyWrapFields(asFrame, wrapFields(spec as unknown as Record<string, unknown>, true, `${path}.`) as WrapFields, true);
    }
    // Sizing is decided PER AXIS, from what the spec actually pinned.
    //
    // The old rule was all-or-nothing: `sizing ?? (hasExplicitSize ? "fixed" :
    // "hug")` decided both axes at once, so giving only a height turned the
    // width into a hard 100 as well. Measured live, that is how a chip row with
    // `height: 28` came out 100 wide with its second chip clipped — and the
    // generated screenshot showed it, which no assertion had.
    //
    // What a caller means by "height: 28" is a fixed height and a width that
    // fits the content. That is exactly `counterAxisSizingMode`/`primaryAxis`
    // per axis, so:
    //   * a per-axis `sizing` object wins over everything
    //   * otherwise an explicit number on an axis is fixed
    //   * otherwise an explicit `sizing` string applies
    //   * otherwise hug — the natural default for an auto-layout
    // The last case is what gave the correct 158x28 before, and it stays.
    const declaredSizing = typeof spec.sizing === "string" ? spec.sizing.toLowerCase() : undefined;
    const perAxis = typeof spec.sizing === "object" && spec.sizing !== null ? (spec.sizing as SizingSpec) : undefined;
    const primaryIsHorizontal = layout === "horizontal";
    const widthPinned = typeof spec.width === "number";
    const heightPinned = typeof spec.height === "number";
    const hugOnly = declaredSizing === "hug" && !perAxis;

    // Primary axis = the layout direction; counter axis = the other one.
    const primaryPinned = primaryIsHorizontal ? widthPinned : heightPinned;
    const counterPinned = primaryIsHorizontal ? heightPinned : widthPinned;
    const explicitPrimary = primaryIsHorizontal ? perAxis?.width : perAxis?.height;
    const explicitCounter = primaryIsHorizontal ? perAxis?.height : perAxis?.width;

    // Explicit "hug" is the only word that asks for AUTO. "fixed" pins the axis,
    // and "fill" hands it to the parent — neither is self-sizing.
    const hugs = (explicit: string | undefined, pinned: boolean): boolean =>
      explicit === undefined ? hugOnly || !pinned : explicit.toLowerCase() === "hug";

    asFrame.primaryAxisSizingMode = hugs(explicitPrimary, primaryPinned) ? "AUTO" : "FIXED";
    asFrame.counterAxisSizingMode = hugs(explicitCounter, counterPinned) ? "AUTO" : "FIXED";
  }

  // Colour before children so the frame is not transparent while building.
  const bg = type === "svg" || type === "line" || type === "image" ? undefined : spec.background ?? spec.fill;
  if (bg) {
    asFrame.fills = [parseColor(bg, `${path}.background`)];
  } else if (type === "button") {
    asFrame.fills = [parseColor("#1a1a1a", `${path}.background`)];
  } else if (nested && (type === "frame" || type === "component")) {
    asFrame.fills = [];
  }

  const radius = num(spec as unknown as Record<string, unknown>, "cornerRadius");
  if (typeof radius === "number" && has(asFrame, "cornerRadius")) asFrame.cornerRadius = radius;

  if (spec.stroke && type !== "line") {
    asFrame.strokes = [parseColor(spec.stroke, `${path}.stroke`)];
    asFrame.strokeWeight = typeof spec.strokeWeight === "number" ? spec.strokeWeight : 1;
  }

  if (typeof spec.opacity === "number") asFrame.opacity = Math.max(0, Math.min(1, spec.opacity));
  if (typeof spec.visible === "boolean") asFrame.visible = spec.visible;
  if (typeof spec.locked === "boolean") asFrame.locked = spec.locked;
  if (typeof spec.rotation === "number" && has(asFrame, "rotation")) asFrame.rotation = spec.rotation;

  // `clipsContent` off unless the spec says otherwise.
  //
  // Measured: `figma.createFrame()` starts with `clipsContent === true`. That is
  // what Figma's own editor does for an artboard — but it also means every drop
  // shadow, every badge overhanging a corner and every absolutely-placed
  // decoration gets silently cut at the frame edge. A shadow that is half drawn
  // reads as a rendering bug, and the caller has no way to suspect clipping is
  // the cause. Clipping is the deliberate act here, not the default: opt in with
  // `clipsContent: true` when trimming is genuinely wanted.
  if (has(asFrame, "clipsContent")) {
    asFrame.clipsContent = typeof spec.clipsContent === "boolean" ? spec.clipsContent : false;
  }

  await b.pacer.tick();

  // Children: the parent's layout arranges them as they land.
  const kids = await buildChildren(spec, path, b, node, hasAutoLayout(asFrame) ? layout : "none");
  at.path = path;
  if (type === "section") layOutSection(spec, path, b, node, kids);

  // tools.md: `variables` binds a variable, `style` applies a style — each by
  // name or by id ("VariableID:…", "S:…"), resolved before the build began.
  for (const [field, ref] of Object.entries(spec.variables ?? {})) {
    const variable: VariableLike = b.variables.get(ref)!;
    try {
      bindField(node as never, field, variable);
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.variables.${field}\`: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }
  for (const [slot, ref] of Object.entries(spec.style ?? {})) {
    const target = slot as Parameters<typeof targetFor>[1] & string;
    const style = b.styles.get(`${slot}|${ref}`)!;
    try {
      await applyStyle(node as never, style.id, targetFor(style.kind, target));
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.style.${slot}\`: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }

  if (type === "component") {
    const convert = (figma as unknown as { createComponentFromNode?: (n: NodeLikeW) => NodeLikeW }).createComponentFromNode;
    if (!convert) throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot create components.");
    const comp = convert.call(figma, node);
    entry.id = comp.id; // the component is what now stands where the frame was
    entry.name = comp.name;
    node = comp;
    // The conversion makes a new node: the pinned modes go on it as well.
    pinModes(node, b.modes.get(path), path);
  }
  if (spec.ref) b.refs.set(spec.ref, node);
  return node;
}

/**
 * Build `spec.children` into `node`, whose auto-layout direction is `layout`
 * ("none" without one). A registered type appends and places itself; a
 * deferred one (a connector) waits for the whole tree and is built in this
 * container afterwards. Returns the children built now, for a section's
 * `arrange` and `hug`.
 */
async function buildChildren(spec: SpecNode, path: string, b: Build, node: NodeLikeW, layout: string): Promise<Array<{ node: NodeLikeW; path: string }>> {
  const built: Array<{ node: NodeLikeW; path: string }> = [];
  const auto = layout === "horizontal" || layout === "vertical";
  const kids = Array.isArray(spec.children) ? spec.children : [];
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i]!;
    const childPath = `${path}.children[${i}]`;
    const handler = handlerOf(child);
    if (handler?.deferred) {
      b.deferred.push({ spec: child, path: childPath, parent: node, handler });
      continue;
    }
    const made = await buildNode(child, childPath, b, node, true);
    b.at.path = path; // back at this node: a failure from here on is this node's
    built.push({ node: made, path: childPath });
    if (handler) continue; // appended and placed by its handler
    if (!b.topDown) append(node, made);
    // Out of the flow before x/y: switching to ABSOLUTE moves the node itself
    // (typings 1.141.0), and only an absolute child of a layout takes x/y [C-095].
    const absolute = typeof child.positioning === "string" && child.positioning.toLowerCase() === "absolute";
    if (absolute) (made as unknown as { layoutPositioning: string }).layoutPositioning = "ABSOLUTE";
    const placed = !auto || absolute;
    // `layoutMode` is the STRING "NONE" when there is no auto-layout, and "NONE"
    // is truthy — so `!asFrame.layoutMode` was never true and an explicit x/y on
    // a child of a plain frame was silently dropped. Measured in a unit test
    // written for the text-wrapping fix, which is how this was found: the same
    // mistake was in four places. hasAutoLayout makes it impossible to repeat.
    if (placed) placeAt(b, made, childPath, child.x, child.y);
    if (absolute) continue; // outside the flow: no stretch, no fill (validateTree refused fill)

    // A TEXT child inside an auto-layout PARENT has to be told to fill the
    // parent's cross axis, or it never wraps.
    //
    // Measured live: a subheadline came out 1427 px wide inside a 1040 px
    // content area — `WIDTH_AND_HEIGHT` means "grow forever on one line" — so
    // the text ran off the frame and was clipped instead of wrapping. This is
    // the difference between "width: hug" and "width: fill" in the Figma UI,
    // and a text node in a stack almost always wants fill.
    //
    // Only for TEXT, and only when the child declared no width of its own: an
    // explicit width is a deliberate choice (that path sets textAutoResize
    // HEIGHT itself), and stretching a fixed-width element would be a
    // different kind of wrong. An explicit hug across the parent is a
    // deliberate choice too, and stretching overrode it. `layoutAlign` on a
    // non-auto-layout parent throws in the real API, which is why the
    // parent's auto-layout is checked rather than `layoutMode`.
    // Only in a column: across a ROW the cross axis is the height, and
    // stretching a text there wraps nothing — it fills a hugging row's height,
    // the two wait on each other, and a "/month" next to a price sat at the top
    // of the row instead of on its baseline (measured live, check_layout
    // fill_in_hug, 2026-10-09).
    const childAxes = sizingAxes(child.sizing);
    const primaryIsWidth = layout === "horizontal";
    const hugsAcross = (primaryIsWidth ? childAxes.height : childAxes.width) === "hug";
    if (auto && !primaryIsWidth && (made as { type?: string }).type === "TEXT" && typeof child.width !== "number" && !hugsAcross) {
      (made as unknown as { layoutAlign: string }).layoutAlign = "STRETCH";
    }
    // `sizing: "fill"` means "fill the container" — the third option in Figma's
    // own resizing menu, next to Fixed and Hug. On a child it maps to two
    // different API properties depending on the axis it names:
    //   * the parent's PRIMARY axis (the layout direction) → layoutGrow = 1
    //   * the parent's COUNTER axis (across it)             → layoutAlign = STRETCH
    // Getting this wrong is what made every section of a landing page hug its
    // content: the header came out 690 px wide inside a 1440 px frame, so it sat
    // cramped against the left edge and looked clipped.
    const fillWidth = childAxes.width === "fill";
    const fillHeight = childAxes.height === "fill";

    if (auto && (fillWidth || fillHeight)) {
      // validateTree refused fill under a parent without auto-layout, so a
      // request to fill always lands here rather than being dropped.
      if (primaryIsWidth ? fillWidth : fillHeight) {
        (made as unknown as { layoutGrow: number }).layoutGrow = 1;
      }
      if (primaryIsWidth ? fillHeight : fillWidth) {
        (made as unknown as { layoutAlign: string }).layoutAlign = "STRETCH";
      }
    }
  }
  return built;
}

/**
 * A section's `arrange`, then `hug`, once its children exist. Arrange reads
 * each child's real size — a sticky grows with its text — and places them in
 * rows from the top-left padding, each row as tall as its tallest item
 * (grid-layout.ts; create-sticky.md "Two-pass layout") [C-147]. Hug then fits
 * the section to its children's far edges plus padding, from its own (0,0), as
 * the official recipe does (create-section.md:63-93). Inner sections were built
 * first, so a nested hug is always inner-first. resizeWithoutConstraints, never
 * resize() [C-141].
 */
function layOutSection(spec: SpecNode, path: string, b: Build, section: NodeLikeW, kids: ReadonlyArray<{ node: NodeLikeW; path: string }>): void {
  const pad = normalizePadding(spec.padding, `${path}.padding`) ?? [SECTION_PADDING, SECTION_PADDING, SECTION_PADDING, SECTION_PADDING];
  const box = (n: NodeLikeW) => n as unknown as { x: number; y: number; width: number; height: number };
  if (typeof spec.arrange === "string" && kids.length) {
    const grid = placeGrid(kids.map((k) => ({ w: box(k.node).width, h: box(k.node).height })), {
      columns: arrangeColumns(spec.arrange, kids.length),
      gap: typeof spec.gap === "number" ? spec.gap : ARRANGE_GAP,
      origin: { x: pad[3], y: pad[0] },
    });
    kids.forEach((k, i) => placeAt(b, k.node, k.path, grid.positions[i]!.x, grid.positions[i]!.y));
  }
  if (spec.hug === true && kids.length) {
    let right = 0;
    let bottom = 0;
    for (const k of kids) {
      right = Math.max(right, box(k.node).x + box(k.node).width);
      bottom = Math.max(bottom, box(k.node).y + box(k.node).height);
    }
    resizeNode(section, Math.max(0.01, right + pad[1]), Math.max(0.01, bottom + pad[2]));
  }
  if (typeof spec.contentsHidden === "boolean") (section as unknown as { sectionContentsHidden: boolean }).sectionContentsHidden = spec.contentsHidden;
}

/** Pin each resolved collection's mode on `node`, through the collection-object overload only [C-105]. */
function pinModes(node: NodeLikeW, pins: Array<{ collection: CollectionLike; modeId: string }> | undefined, path: string): void {
  for (const pin of pins ?? []) {
    try {
      setMode(node as never, pin.collection, pin.modeId);
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.variableModes\` "${pin.collection.name}": ${err instanceof Error ? err.message : String(err)}.`);
    }
  }
}

/**
 * Set an instance's resolved properties, and each nested instance's, right
 * after it exists — one call, one undo step, no follow-up per instance.
 * Returns the keys Figma took without changing (a value it ignored), so the
 * created[] entry can say so rather than report success it cannot show.
 */
function setInstanceProperties(node: NodeLikeW, r: ResolvedInstance, path: string): string[] {
  type Inst = NodeLikeW & { setProperties?: (p: Record<string, string | boolean>) => void; componentProperties?: Record<string, { value: unknown }> };
  const ignored: string[] = [];
  const apply = (inst: Inst, props: Record<string, string | boolean>, field: string, prefix: string) => {
    if (!Object.keys(props).length) return;
    if (typeof inst.setProperties !== "function") throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: a ${inst.type} has no component properties.`);
    try {
      inst.setProperties(props);
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${field}\`: Figma refused the properties: ${err instanceof Error ? err.message : String(err)}`);
    }
    const now = inst.componentProperties ?? {};
    for (const [key, want] of Object.entries(props)) {
      if (key in now && String(now[key]!.value) !== String(want)) ignored.push(`${prefix}${key}`);
    }
  };
  apply(node as Inst, r.properties, `${path}.properties`, "");
  for (const { name, properties } of r.nested) {
    const hits = instancesNamed(node, name);
    if (hits.length !== 1) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.nested.${name}\`: the new instance has ${hits.length} layers named "${name}".`);
    apply(hits[0] as Inst, properties, `${path}.nested.${name}`, `${name}.`);
  }
  return ignored;
}

/**
 * Whether a frame is an auto-layout.
 *
 * `layoutMode` is the STRING "NONE" when it is not — and "NONE" is truthy, so
 * `if (node.layoutMode)` is true for every frame in the document. That mistake
 * shipped four times in this file before a unit test caught it, which is why
 * this exists as a named function instead of a comparison written inline.
 */
function hasAutoLayout(node: FrameLike): boolean {
  const mode = (node as unknown as { layoutMode?: unknown }).layoutMode;
  return mode === "HORIZONTAL" || mode === "VERTICAL";
}

function applySize(node: FrameLike, spec: SpecNode, path: string, allowHug: boolean) {
  const w = typeof spec.width === "number" ? spec.width : null;
  const h = typeof spec.height === "number" ? spec.height : null;
  if (w === null && h === null) return;
  if (w !== null && (!Number.isFinite(w) || w < 0)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.width\` must be a non-negative number.`);
  }
  if (h !== null && (!Number.isFinite(h) || h < 0)) {
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${path}.height\` must be a non-negative number.`);
  }
  const sizing = typeof spec.sizing === "string" ? spec.sizing.toLowerCase() : "";
  const hug = allowHug && sizing === "hug";
  if (hug) {
    resizeNode(node, w ?? 10, h ?? 10);
    return;
  }

  // The placeholder along an UNPINNED axis is 10, not 100.
  //
  // This number is a stand-in that auto-layout replaces: setting `layoutMode`
  // afterwards switches the axis to AUTO and the frame re-measures from its
  // children, which is why the no-size case already produced the right 158x28.
  // But when only ONE axis is pinned, the other one keeps whatever we pass here
  // for a moment — measured live, a 100-wide placeholder is what clipped the
  // second chip in a row whose spec said only `height: 28`. A smaller stand-in
  // cannot hide content that the hug will reveal a frame later.
  //
  // 10 rather than 1: a frame briefly sized at 1x1 in a live document is the
  // kind of thing that flashes on the user's canvas, and this is a canvas other
  // people are looking at.
  resizeNode(node, w ?? 10, h ?? 10);
}

async function buildText(
  spec: SpecNode,
  figma: FigmaWrite,
  record: (n: NodeLikeW) => NodeLikeW,
  defaults: { style: string; color: string },
): Promise<{ node: NodeLikeW; font: { family: string; style: string; fellBack: boolean } }> {
  // Everything that can fail runs before the node exists: createText() places
  // it on the page at once, so a font or colour failure after it would leave
  // an unreported text node behind. The node is recorded before its first
  // write, so a write Figma refuses still reports it.
  const font = await loadFont(figma, spec.fontFamily, spec.weight === undefined ? defaults.style : weightToStyle(spec.weight));
  const fill = parseColor(spec.color ?? defaults.color, "color");
  const lineHeight = parseLineHeight(spec.lineHeight, "lineHeight", false);
  const letterSpacing = parseLength(spec.letterSpacing, "letterSpacing", false);
  const node = record(figma.createText()) as TextLike;
  node.fontName = { family: font.family, style: font.style };
  if (typeof spec.fontSize === "number") node.fontSize = spec.fontSize;
  node.characters = typeof spec.content === "string" ? spec.content : "";
  node.fills = [fill];
  // A list is one text, each line a bullet or a number — never dots laid out
  // beside it (figma-use-slides slide-content.md:28-53).
  const list = spec.list === undefined ? undefined : TEXT_LISTS[spec.list.toLowerCase()];
  if (list && list !== "NONE" && node.characters.length) {
    const t = node as unknown as { setRangeListOptions?(s: number, e: number, v: { type: string }): void };
    if (typeof t.setRangeListOptions !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This Figma's text has no setRangeListOptions: `list` cannot be set.");
    t.setRangeListOptions(0, node.characters.length, { type: list });
  }
  if (spec.align) node.textAlignHorizontal = TEXT_ALIGN[spec.align.toLowerCase()]!;
  if (lineHeight) node.lineHeight = lineHeight;
  if (letterSpacing) node.letterSpacing = letterSpacing;
  if (typeof spec.width === "number") {
    // A fixed width that wraps: resize first (the width was never applied before,
    // so text wrapped at Figma's default width), then let the height follow.
    node.resize(spec.width, Math.max(1, (node as unknown as { height?: number }).height ?? 1));
    node.textAutoResize = "HEIGHT";
  }
  return { node, font };
}

// ── the ops ─────────────────────────────────────────────────────────────────

/** At most this many roots in one array spec: one slide or one zone per call, not a document [C-082] [C-155]. */
const MAX_ROOTS = 50;

const createFromSpec: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const editor = editorType() ?? "figma";
    // The server parses the JSON string; accept one here too, so the op does not
    // depend on which caller sits in front of it (mock plugin, an older bridge).
    // An array is several roots into one parent — the contents of one slide, the
    // cards of one zone — still one validation and one undo step.
    const { roots, many } = await beforeCreating((): { roots: SpecNode[]; many: boolean } => {
      let raw: unknown = ctx.params.spec;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          throw new BridgeError(ErrorCode.INVALID_PARAM, "`spec` is a string but not valid JSON.");
        }
      }
      if (Array.isArray(raw)) {
        if (raw.length < 1 || raw.length > MAX_ROOTS) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`spec\` as an array takes 1–${MAX_ROOTS} roots (got ${raw.length}).`);
        raw.forEach((r, i) => {
          if (!isSpecNode(r)) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`spec[${i}]\` must be an object.`);
        });
        if (!str(ctx.params, "parentId") && !str(ctx.params, "pageId")) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, "An array of roots needs `parentId` or `pageId`: say where they all go.");
        }
        return { roots: raw as SpecNode[], many: true };
      }
      if (!isSpecNode(raw)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, "`spec` must be an object (see the tool description for its shape).");
      }
      return { roots: [raw], many: false };
    });
    const pathOf = (i: number) => (many ? `spec[${i}]` : "spec");
    const created: Created[] = [];
    const at: Cursor = { path: pathOf(0) };
    const images = new Map<string, string>();
    const v: Validation = { editor, refs: new Map(), handled: [], types: new Map() };
    // Nothing exists yet, so a failure here reports `created: []` — provably no
    // change, which also frees the idempotencyKey for a corrected retry.
    let parent: NodeLikeW;
    let total = 0;
    let resolved: Resolved;
    try {
      roots.forEach((root, i) => {
        total += validateTree(root, pathOf(i), v);
      });
      for (const [type, path] of v.types) refuseMissingFactory(type, path, editor);
      // `pageId` was accepted and never read: a spec aimed at another page was
      // built on the current one, and the call reported success.
      const parentId = str(ctx.params, "parentId");
      const pageId = str(ctx.params, "pageId");
      if (parentId && pageId) refuse(pathOf(0), "Give `parentId` or `pageId`, not both: a parent already sits on its page.");
      parent = await parentFor(figma, parentId ?? pageId);
      if (pageId && parent.type !== "PAGE" && parent.type !== "PAGE_NODE") {
        refuse(pathOf(0), `\`pageId\` \`${pageId}\` is a ${parent.type}, not a page.`, "To build inside a frame or section, give it as parentId.");
      }
      roots.forEach((root, i) => checkRoot(root, pathOf(i), parent));
      // A registered type checks its own fields once every ref of the call is known.
      const check: SpecCheck = { editor, refs: new Set(v.refs.keys()), refuse, parseColor };
      for (const h of v.handled) {
        at.path = h.path;
        await h.handler.validate(h.spec as SpecFields, h.path, check);
      }
      // Images are fetched before the first node exists: an unreachable URL then
      // fails the call cleanly instead of half-way through the build.
      const createImageAsync = (figma as unknown as { createImageAsync?: (u: string) => Promise<{ hash: string }> }).createImageAsync;
      const urls = new Set<string>();
      for (const root of roots) imageUrls(root, urls);
      for (const url of urls) {
        if (typeof createImageAsync !== "function") throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot load images.");
        try {
          images.set(url, (await createImageAsync.call(figma, url)).hash);
        } catch (err) {
          throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma could not load the image ${url}: ${err instanceof Error ? err.message : String(err)}`, {
            hint: "PNG, JPEG or GIF, at most 4096 px a side, reachable from Figma.",
          });
        }
      }
      resolved = await resolveSpec(roots.map((r, i) => [r, pathOf(i)] as [SpecNode, string]), at, images);
    } catch (err) {
      const e = err instanceof BridgeError ? err : new BridgeError(ErrorCode.INTERNAL, err instanceof Error ? err.message : String(err));
      // A refusal that already names its node keeps that path.
      const named = (e.partial as { failedAt?: unknown } | undefined)?.failedAt;
      throw new BridgeError(e.code, e.message, {
        hint: `${e.hint ? `${e.hint} ` : ""}Nothing was created.`,
        partial: { created: [], failedAt: typeof named === "string" ? named : at.path },
      });
    }

    ctx.progress(0, total, "building");
    // Paced like forEachChunked: Figma gets a turn every ~12 ms of building, so a
    // large spec keeps the editor responsive and can be cancelled (tools.md).
    const pacer = createPacer(total, {
      yieldToHost: ctx.yieldToHost,
      onProgress: (done, all) => ctx.progress(done, all, "building"),
      isCancelled: ctx.isCancelled,
    });
    const b: Build = {
      ...resolved, figma, out: created, at, pacer, ctx, editor,
      topDown: slideOf(parent) !== null,
      declared: new Set(v.refs.keys()), refs: new Map(), deferred: [], placed: [],
    };
    const rootIds: string[] = [];
    try {
      for (let i = 0; i < roots.length; i++) {
        const spec = roots[i]!;
        const path = pathOf(i);
        const handler = handlerOf(spec);
        if (handler?.deferred) {
          b.deferred.push({ spec, path, parent, handler, root: i });
          continue;
        }
        const node = await buildNode(spec, path, b, parent, !onCanvas(parent));
        rootIds[i] = node.id;
        at.path = path;
        if (handler) continue; // appended and placed by its handler
        if (!b.topDown) append(parent, node);
        const rootAbsolute = typeof spec.positioning === "string" && spec.positioning.toLowerCase() === "absolute";
        if (rootAbsolute) (node as unknown as { layoutPositioning: string }).layoutPositioning = "ABSOLUTE";
        // The root follows the same rule as a child. The old test was
        // `"layoutMode" in parent && parent.layoutMode` — but layoutMode is the
        // truthy STRING "NONE" without auto-layout, so x/y were dropped under every
        // plain frame: the documented overlap recipe failed silently.
        if (!hasAutoLayout(parent as FrameLike) || rootAbsolute) placeAt(b, node, path, spec.x, spec.y);
        // `sizing: fill` on the root was read by nothing — a section meant to span
        // its wrapper came out at its placeholder width.
        const rootFill = fillAxes(spec.sizing);
        if (rootFill) applySizing(node, rootFill, `${path}.sizing`);
      }
      // Connectors and other deferred types last, each in the container that
      // declared it, so every end exists and nothing is reparented afterwards —
      // a moved connector keeps stale elbows [C-149].
      for (const d of b.deferred) {
        const node = await buildHandled(d.spec, d.path, b, d.parent, d.handler);
        if (d.root !== undefined) rootIds[d.root] = node.id;
      }
      ctx.progress(created.length, created.length, "done");
      const refs = Object.fromEntries([...b.refs].map(([r, n]) => [r, n.id]));
      return {
        rootId: rootIds[0],
        ...(many ? { rootIds } : {}),
        created,
        nodeCount: created.length,
        ...(b.refs.size ? { refs } : {}),
        // Top-down builds read every placed node back; an empty list is the proof [C-146].
        ...(b.topDown ? { drift: driftOf(b) } : {}),
      };
    } catch (err) {
      // No rollback, by design: one op = one Ctrl+Z, and the ids are returned so
      // the agent can continue from `failedAt` instead of starting over.
      const message = err instanceof Error ? err.message : String(err);
      ctx.progress(created.length, created.length, "failed");
      const cause = err instanceof BridgeError && err.hint ? `${err.hint} ` : "";
      const code = err instanceof CancelledError ? ErrorCode.CANCELLED : err instanceof BridgeError ? err.code : ErrorCode.INTERNAL;
      throw new BridgeError(
        code,
        message,
        {
          hint: created.length
            ? `${cause}${created.length} node(s) were created before the failure (ids in partial.created). Tell the user to press Ctrl+Z to undo the whole call, delete them with figma_delete_nodes, or continue from partial.failedAt.`
            : `${cause}Nothing was created.`,
          // tools.md § create_from_spec: a mid-way failure reports what exists and where it stopped.
          partial: { created, failedAt: at.path },
        },
      );
    }
  },
};

/**
 * A root's relation to its parent, once the parent is known: "fill" and
 * "absolute" exist only inside an auto-layout, which also owns x/y; a slide is
 * never an auto-layout parent (slide-content.md:101); a deferred type cannot be
 * an auto-layout item.
 */
function checkRoot(spec: SpecNode, path: string, parent: NodeLikeW): void {
  const rootAbsolute = typeof spec.positioning === "string" && spec.positioning.toLowerCase() === "absolute";
  const rootFill = fillAxes(spec.sizing);
  const auto = hasAutoLayout(parent as FrameLike);
  if (rootFill && parent.type === "SLIDE") {
    refuse(path, `\`${path}.sizing: fill\`: a slide is not an auto-layout parent, so a node placed directly on it cannot fill it.`, "Give it a width and height; fill works one level down, inside an auto-layout frame.");
  }
  if ((rootFill || rootAbsolute) && !auto) {
    refuse(path, `\`${path}.${rootAbsolute ? "positioning: absolute" : "sizing: fill"}\` needs a parent with auto-layout — ${parent.type === "PAGE" ? "the page" : `"${parent.name}"`} has none.`,
      rootAbsolute ? "Without auto-layout, x/y already place the root." : "Give the parent auto-layout (figma_set_auto_layout), or a fixed width.");
  }
  // ...and x/y, which an auto-layout parent overrides (validateTree checks every child).
  if ((spec.x !== undefined || spec.y !== undefined) && auto && !rootAbsolute) {
    refuse(path, `\`${path}.${spec.x !== undefined ? "x" : "y"}\` is ignored in an auto-layout: "${parent.name}" places the root.`,
      'Add positioning: "absolute" to place it by x/y inside an auto-layout.');
  }
  if (handlerOf(spec)?.deferred && auto) {
    refuse(path, `A "${spec.type}" at ${path} cannot be an item of the auto-layout "${parent.name}".`, "Give a section, a frame without layout, or a page as parentId.");
  }
}

/**
 * figma_create_frame — the step-by-step builder's container, with the same
 * defaults create_from_spec learned the hard way, because an agent building one
 * element per call [C-071] should not get a worse result than one batch:
 *
 *   - an auto-layout frame HUGS any axis it was not given a size for (the old
 *     100 x 100 default pinned both axes and clipped content);
 *   - `clipsContent` is off unless asked for — Figma's default cuts shadows and
 *     overhanging badges at the frame edge [C-067];
 *   - `sizing` sets Figma's own "fixed / hug / fill" dropdowns, so a section can
 *     fill the page column the way a designer would make it.
 */
const createFrame: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const layout = str(ctx.params, "layout")?.toLowerCase();
    if (layout !== undefined && !["horizontal", "vertical", "none"].includes(layout)) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, "`layout` must be horizontal, vertical or none.", { partial: { created: [] } });
    }
    const auto = layout === "horizontal" || layout === "vertical";
    const mode = layout === "horizontal" ? "HORIZONTAL" : "VERTICAL";
    const p = await beforeCreating(async () => {
      const background = str(ctx.params, "background");
      const wraps = auto && mode === "HORIZONTAL" && ctx.params.wrap === true;
      // A wrap on a column used to be dropped without a word.
      if (ctx.params.wrap === true && !wraps) throw new BridgeError(ErrorCode.INVALID_PARAM, "`wrap` wraps a row: it needs `layout: \"horizontal\"`.");
      return {
        width: sizeParam(ctx.params, "width", false),
        height: sizeParam(ctx.params, "height", false),
        parent: await parentFor(figma, str(ctx.params, "parentId")),
        pad: auto ? normalizePadding(ctx.params.padding) : undefined,
        fill: background ? parseColor(background, "background") : undefined,
        align: auto ? alignmentFor(mode, ctx.params.alignX, ctx.params.alignY) : alignmentFor("NONE", ctx.params.alignX, ctx.params.alignY),
        sizing: parseSizing(ctx.params.sizing),
        // Refused unless the frame will wrap: Figma throws on these otherwise [C-095].
        wrapping: wrapFields(ctx.params, wraps),
      };
    });
    const node = figma.createFrame();
    const asFrame = node as unknown as FrameLike;
    const rowGapNote = afterCreating(node, () => {
      let note: string | undefined;
      if (str(ctx.params, "name")) node.name = str(ctx.params, "name")!;
      // An unpinned axis gets a small stand-in that the hug replaces at once.
      asFrame.resize(p.width ?? (auto ? 10 : 100), p.height ?? (auto ? 10 : 100));
      if (auto) {
        asFrame.layoutMode = mode;
        if (typeof ctx.params.gap === "number") asFrame.itemSpacing = ctx.params.gap;
        if (p.pad) {
          asFrame.paddingTop = p.pad[0];
          asFrame.paddingRight = p.pad[1];
          asFrame.paddingBottom = p.pad[2];
          asFrame.paddingLeft = p.pad[3];
        }
        Object.assign(asFrame, p.align);
        if (ctx.params.wrap === true && mode === "HORIZONTAL") {
          asFrame.layoutWrap = "WRAP";
          note = applyWrapFields(asFrame, p.wrapping, true);
        }
      }
      if (p.fill) asFrame.fills = [p.fill];
      else if (!onCanvas(p.parent)) asFrame.fills = [];
      if (typeof ctx.params.cornerRadius === "number") asFrame.cornerRadius = ctx.params.cornerRadius;
      asFrame.clipsContent = ctx.params.clipsContent === true;
      append(p.parent, node);
      if (typeof ctx.params.x === "number") (node as unknown as { x: number }).x = ctx.params.x;
      if (typeof ctx.params.y === "number") (node as unknown as { y: number }).y = ctx.params.y;
      // Own sizing: a number pins its axis, an auto-layout hugs the rest; an
      // explicit `sizing` wins. Applied once the frame is in its parent, since
      // "fill" is a relation to that parent. The pin must be written, not
      // assumed: turning auto-layout on leaves the primary axis hugging, so a
      // `width: 300` wrapping row grew to 793 px on one line instead of wrapping
      // (measured live) [C-125].
      const pin = (given: number | undefined) => (auto ? (given === undefined ? "HUG" : "FIXED") : undefined);
      applySizing(node, {
        horizontal: p.sizing?.horizontal ?? pin(p.width),
        vertical: p.sizing?.vertical ?? pin(p.height),
      });
      return note;
    });
    const box = node as unknown as { width: number; height: number };
    return { id: node.id, name: node.name, type: node.type, width: box.width, height: box.height, ...(rowGapNote ? { rowGap: rowGapNote } : {}) };
  },
};

/**
 * figma_create_text. Three things the bare createText() gets wrong for a
 * designer, all measured: text with no width never wraps and runs past its
 * column [C-072]; inside a vertical stack it should fill the column the way
 * Figma's "Fill container" does; and a column whose items are centred expects
 * its text centred too — a filled, left-aligned title in a centred card looks
 * off-centre.
 */
const createText: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const p = await beforeCreating(async () => {
      const content = str(ctx.params, "content");
      if (content === undefined) throw new BridgeError(ErrorCode.INVALID_PARAM, "`content` is required.");
      const width = sizeParam(ctx.params, "width", false);
      const align = str(ctx.params, "align");
      if (align !== undefined && !TEXT_ALIGN[align.toLowerCase()]) throw new BridgeError(ErrorCode.INVALID_PARAM, "`align` must be left, center, right or justified.");
      // FigJam's own defaults when the call names none: Inter Medium, Charcoal [C-156].
      const defaults = textDefaults(editorType());
      const weight = weightParam(ctx.params);
      return {
        content,
        width,
        align: align === undefined ? undefined : TEXT_ALIGN[align.toLowerCase()],
        // figma_set_text_properties' strings, or px; the line height stays above 0 as it always was here.
        lineHeight: parseLineHeight(ctx.params.lineHeight, "lineHeight", true),
        letterSpacing: parseLength(ctx.params.letterSpacing, "letterSpacing", false),
        sizing: parseSizing(ctx.params.sizing),
        parent: await parentFor(figma, str(ctx.params, "parentId")),
        fill: parseColor(str(ctx.params, "color") ?? defaults.color, "color"),
        font: await loadFont(figma, str(ctx.params, "fontFamily"), weight === undefined ? defaults.style : weightToStyle(weight)),
      };
    });
    const node = figma.createText() as TextLike;
    const { sizing, autoAligned } = afterCreating(node, () => {
      node.fontName = { family: p.font.family, style: p.font.style };
      if (typeof ctx.params.fontSize === "number") node.fontSize = ctx.params.fontSize;
      node.characters = p.content;
      node.fills = [p.fill];
      if (str(ctx.params, "name")) node.name = str(ctx.params, "name")!;
      if (p.lineHeight) node.lineHeight = p.lineHeight;
      if (p.letterSpacing) node.letterSpacing = p.letterSpacing;
      if (p.width !== undefined) {
        node.resize(p.width, Math.max(1, (node as unknown as { height?: number }).height ?? 1));
        node.textAutoResize = "HEIGHT";
      }
      append(p.parent, node);
      if (typeof ctx.params.x === "number") (node as unknown as { x: number }).x = ctx.params.x;
      if (typeof ctx.params.y === "number") (node as unknown as { y: number }).y = ctx.params.y;

      const parent = p.parent as unknown as { layoutMode?: string; counterAxisAlignItems?: string };
      const inColumn = parent.layoutMode === "VERTICAL";
      let sizing = p.sizing;
      if (!sizing && p.width === undefined && inColumn) sizing = { horizontal: "FILL" };
      let autoAligned: string | undefined;
      if (!p.align && sizing?.horizontal === "FILL" && inColumn) {
        autoAligned = { CENTER: "CENTER", MAX: "RIGHT" }[parent.counterAxisAlignItems ?? ""];
      }
      const textAlign = p.align ?? autoAligned;
      if (textAlign) node.textAlignHorizontal = textAlign;
      applySizing(node, sizing);
      return { sizing, autoAligned };
    });
    const box = node as unknown as { width: number; height: number };
    return {
      id: node.id, name: node.name, type: node.type, width: box.width, height: box.height,
      ...(sizing?.horizontal === "FILL" && !p.sizing ? { wraps: "fills the column (auto)" } : {}),
      ...(autoAligned ? { align: `${autoAligned.toLowerCase()} (follows the column)` } : {}),
      font: { family: p.font.family, style: p.font.style, fellBack: p.font.fellBack },
    };
  },
};

function simpleShape(kind: "rectangle" | "ellipse"): PluginOp {
  return {
    write: true,
    async run(ctx: OpContext) {
      const figma = api();
      const p = await beforeCreating(async () => {
        const fill = str(ctx.params, "fill");
        const stroke = kind === "rectangle" ? str(ctx.params, "stroke") : undefined;
        return {
          parent: await parentFor(figma, str(ctx.params, "parentId")),
          // Not requireInt: it took 0, which resize() refuses, and refused a 0.5 px hairline.
          width: sizeParam(ctx.params, "width", true)!,
          height: sizeParam(ctx.params, "height", true)!,
          fill: fill ? parseColor(fill, "fill") : undefined,
          stroke: stroke ? parseColor(stroke, "stroke") : undefined,
          sizing: parseSizing(ctx.params.sizing),
        };
      });
      const node = kind === "rectangle" ? figma.createRectangle() : figma.createEllipse();
      const asShape = node as unknown as FrameLike;
      afterCreating(node, () => {
        asShape.resize(p.width, p.height);
        if (p.fill) asShape.fills = [p.fill];
        if (kind === "rectangle") {
          if (typeof ctx.params.cornerRadius === "number") asShape.cornerRadius = ctx.params.cornerRadius;
          if (p.stroke) {
            asShape.strokes = [p.stroke];
            asShape.strokeWeight = typeof ctx.params.strokeWeight === "number" ? ctx.params.strokeWeight : 1;
          }
        }
        if (str(ctx.params, "name")) node.name = str(ctx.params, "name")!;
        append(p.parent, node);
        if (typeof ctx.params.x === "number") (node as unknown as { x: number }).x = ctx.params.x;
        if (typeof ctx.params.y === "number") (node as unknown as { y: number }).y = ctx.params.y;
        applySizing(node, p.sizing);
      });
      return { id: node.id, name: node.name, type: node.type };
    },
  };
}

/**
 * figma_create_section. On a board sections are the structure — a white
 * wrapper, zones inside it, cards inside those (plan-board-content.md:67-75,
 * 149-162) — so a section takes a parent: a page or another section, the only
 * places Figma holds one. Its name may be "" (a title text inside carries the
 * label, :81). The fill is a hex until the palette names are measured [C-144].
 */
const createSection: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const p = await beforeCreating(async () => {
      // apiHas, not a plain read: in an editor without it the read itself may throw [C-145].
      if (!apiHas("createSection")) throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot create sections.");
      const name = ctx.params.name;
      if (name !== undefined && typeof name !== "string") throw new BridgeError(ErrorCode.INVALID_PARAM, "`name` must be text (\"\" clears it).");
      const hidden = ctx.params.contentsHidden;
      if (hidden !== undefined && typeof hidden !== "boolean") throw new BridgeError(ErrorCode.INVALID_PARAM, "`contentsHidden` must be true or false.");
      const fill = str(ctx.params, "fill");
      const parent = await parentFor(figma, str(ctx.params, "parentId"));
      if (!["PAGE", "PAGE_NODE", "SECTION"].includes(parent.type)) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, `A section sits on a page or inside another section, not in a ${parent.type}.`, {
          hint: "Give a section id as parentId to nest it, or omit parentId for the page.",
        });
      }
      // Read before the section exists: a size resize() refuses used to leave it behind.
      return {
        create: figma.createSection!,
        w: sizeParam(ctx.params, "width", false) ?? 800,
        h: sizeParam(ctx.params, "height", false) ?? 600,
        name: name as string | undefined,
        hidden: hidden as boolean | undefined,
        fill: fill === undefined ? undefined : parseColor(fill, "fill"),
        parent,
      };
    });
    const node = p.create.call(figma) as unknown as FrameLike;
    afterCreating(node as unknown as NodeLikeW, () => {
      resizeNode(node, p.w, p.h);
      if (p.name !== undefined) node.name = p.name;
      if (p.fill) node.fills = [p.fill];
      if (p.hidden !== undefined) (node as unknown as { sectionContentsHidden: boolean }).sectionContentsHidden = p.hidden;
      // A new section already sits on the current page; elsewhere it moves in
      // first, then takes section-local x/y (position-figjam-nodes.md:56-62).
      if (node.parent?.id !== p.parent.id) append(p.parent, node);
      if (typeof ctx.params.x === "number") node.x = ctx.params.x;
      if (typeof ctx.params.y === "number") node.y = ctx.params.y;
    });
    const box = node as unknown as { width: number; height: number };
    return { id: node.id, name: node.name, type: node.type, width: box.width, height: box.height, ...(p.parent.type === "SECTION" ? { parentId: p.parent.id } : {}) };
  },
};

const createPage: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    const { create, name } = await beforeCreating(() => {
      // apiHas: in FigJam touching createPage may throw rather than read
      // undefined (figma-use-figjam SKILL.md:13) [C-145] [C-142] — UNSUPPORTED, not INTERNAL.
      if (!apiHas("createPage")) throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type has no pages.");
      const name = str(ctx.params, "name");
      if (!name) throw new BridgeError(ErrorCode.INVALID_PARAM, "`name` is required.");
      return { create: figma.createPage!, name };
    });
    let page: NodeLikeW;
    try {
      page = create.call(figma);
    } catch (err) {
      // Figma's own text for the Starter 3-page cap (claim C-048). Surfaced
      // as-written rather than paraphrased: the user may need to act on it.
      // Refused, so no page exists: nothing changed [C-096].
      const message = err instanceof Error ? err.message : String(err);
      throw new BridgeError(ErrorCode.INVALID_PARAM, message, {
        hint: /starter|3 pages/i.test(message)
          ? "The free Starter plan allows 3 pages per file. Delete a page or upgrade — the plugin API enforces the same cap the product does."
          : "Figma refused to create the page.",
        partial: { created: [] },
      });
    }
    page.name = name;
    if (ctx.params.activate === true) {
      const f = api() as unknown as { setCurrentPageAsync?: (p: NodeLikeW) => Promise<void> };
      await f.setCurrentPageAsync?.(page);
    }
    return { id: page.id, name: page.name };
  },
};

const convertToComponent: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    // figma.createComponentFromNode — the toolbar's "Create component". Nodes
    // have no createComponent() method of their own (typings 1.141.0); the old
    // call to one meant this tool could never succeed.
    const convert = (figma as unknown as { createComponentFromNode?: (n: NodeLikeW) => NodeLikeW }).createComponentFromNode;
    const { id, node, description } = await beforeCreating(async () => {
      const id = str(ctx.params, "nodeId");
      if (!id) throw new BridgeError(ErrorCode.INVALID_PARAM, "`nodeId` is required.");
      const description = ctx.params.description;
      if (description !== undefined && typeof description !== "string") throw new BridgeError(ErrorCode.INVALID_PARAM, "`description` must be text.");
      const node = await figma.getNodeByIdAsync(id);
      if (!node) throw new BridgeError(ErrorCode.NODE_NOT_FOUND, `No node with id \`${id}\`.`);
      if (!convert) throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type cannot create components.");
      return { id, node, description: description as string | undefined };
    });
    let comp: NodeLikeW;
    try {
      comp = convert!.call(figma, node);
    } catch (err) {
      throw new BridgeError(ErrorCode.INVALID_PARAM, `Figma would not make this ${node.type} a component: ${err instanceof Error ? err.message : String(err)}`, {
        hint: "A node that is already a component, or sits inside a component or instance, cannot be converted.",
        partial: { created: [] },
      });
    }
    const name = str(ctx.params, "name");
    if (name) comp.name = name;
    // What it is for, where the assets panel and Dev Mode show it [C-111].
    if (description !== undefined) (comp as unknown as { description: string }).description = description;
    return {
      id: comp.id, name: comp.name, type: comp.type, sourceId: id,
      ...(description !== undefined ? { description: (comp as unknown as { description?: string }).description } : {}),
    };
  },
};

// ── variables & styles ──────────────────────────────────────────────────────

const createVariableCollection: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const figma = api();
    type NewCollection = { id: string; name: string; modes: Array<{ modeId: string; name: string }>; renameMode?(id: string, name: string): void; addMode?(name: string): string };
    const f = figma as unknown as { variables?: { createVariableCollection?(name: string): NewCollection } };
    const p = await beforeCreating(() => {
      if (!f.variables?.createVariableCollection) throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type has no variables API.");
      const name = str(ctx.params, "name");
      if (!name) throw new BridgeError(ErrorCode.INVALID_PARAM, "`name` is required.");
      const raw = ctx.params.modes;
      if (raw !== undefined && (!Array.isArray(raw) || raw.some((m) => typeof m !== "string" || m.trim() === ""))) {
        throw new BridgeError(ErrorCode.INVALID_PARAM, '`modes` must be an array of mode names, e.g. ["Light", "Dark"].');
      }
      const modes = ((raw as string[] | undefined) ?? []).map((m) => m.trim());
      // Figma's 40-character limit [C-127]: refused before the collection exists,
      // not as a warning once it does.
      modes.forEach((m, i) => checkModeName(m, `modes[${i}]`));
      const dup = modes.find((m, i) => modes.indexOf(m) !== i);
      if (dup) throw new BridgeError(ErrorCode.INVALID_PARAM, `\`modes\` names "${dup}" twice.`);
      // Figma names the first mode "Mode 1"; tools.md promises "Default", and the
      // official notes say never to leave "Mode 1" — so a list or not, it is renamed.
      return { name, modes: modes.length ? modes : ["Default"] };
    });
    const collection = f.variables!.createVariableCollection!(p.name);
    const modes = p.modes;
    const warnings: string[] = [];
    if (modes.length > 1) {
      // Modes beyond the first are paid-plan only (claim C-047). Attempt them,
      // and report honestly if Figma refuses, rather than silently dropping.
      for (let i = 1; i < modes.length; i++) {
        try {
          if (collection.addMode) collection.addMode(modes[i]!);
        } catch (err) {
          warnings.push(`mode "${modes[i]}" was refused: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (collection.modes[0] && collection.renameMode && collection.modes[0].name !== modes[0]) {
      try {
        collection.renameMode(collection.modes[0].modeId, modes[0]!);
      } catch {
        warnings.push(`could not rename the default mode to "${modes[0]}"`);
      }
    }
    return {
      id: collection.id,
      name: collection.name,
      modes: collection.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
      ...(warnings.length ? { warnings } : {}),
    };
  },
};

const createVariable: PluginOp = {
  write: true,
  async run(ctx: OpContext) {
    const vars = (api() as unknown as {
      variables?: {
        // The collection OBJECT: the id form is deprecated and throws under
        // documentAccess "dynamic-page" (typings 1.141.0) — which this plugin uses.
        createVariable?(name: string, collection: unknown, type: string): Parameters<typeof finishVariable>[0];
      };
    }).variables;

    // Every check before the variable exists: a bad value, an alias to nothing,
    // a scope the type cannot take or a name already used must not leave an
    // empty ALL_SCOPES variable — or a silent duplicate — behind [C-106].
    const p = await beforeCreating(async () => {
      if (!vars?.createVariable) throw new BridgeError(ErrorCode.UNSUPPORTED, "This editor type has no variables API.");
      return prepareVariable(ctx.params);
    });

    const variable = vars!.createVariable!(p.name, p.collection, p.type);
    variable.setValueForMode(p.mode.modeId, p.value);
    const changed = finishVariable(variable, p.props);
    return {
      id: variable.id,
      name: variable.name,
      resolvedType: variable.resolvedType,
      collectionId: p.collection.id,
      modeId: p.mode.modeId,
      ...(changed.length ? { properties: changed } : {}),
    };
  },
};

/** The four create_*_style ops share one implementation in tokens.ts, so they cannot drift apart. */
function styleOp(kind: "PAINT" | "TEXT" | "EFFECT"): PluginOp {
  return createStyleOp(kind);
}

export const CREATE_OPS: Record<string, PluginOp> = {
  create_from_spec: createFromSpec,
  create_frame: createFrame,
  create_text: createText,
  create_rectangle: simpleShape("rectangle"),
  create_ellipse: simpleShape("ellipse"),
  create_section: createSection,
  create_page: createPage,
  convert_to_component: convertToComponent,
  create_variable_collection: createVariableCollection,
  create_variable: createVariable,
  create_paint_style: styleOp("PAINT"),
  create_text_style: styleOp("TEXT"),
  create_effect_style: styleOp("EFFECT"),
};

// Re-exported for the tests: these are the pure parts worth asserting without
// a Figma instance (colour parsing, padding, font weight names, fuzzy match).
export { resolveStyleByName, resolveVariableByName };
