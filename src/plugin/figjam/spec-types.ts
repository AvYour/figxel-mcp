// The FigJam node types of figma_create_from_spec: sticky, shape, table, code
// and connector, registered through the spec-types seam (plugin/spec-types.ts)
// so one spec builds a whole board zone — a section of stickies, a table and
// the connectors between them — in ONE call and ONE undo step, the official
// rhythm of one zone per call [C-155].
//
// Each handler reuses the builders in figjam/nodes.ts, so a sticky from a spec
// is the same as one from figma_create_stickies. Connectors are deferred: the
// builder makes them after the rest of the tree, in the container that
// declares them, so their ends exist and they are never reparented [C-149].
// FigJam only: the create APIs are FigJam's [C-132].
//
// Wired by the integrator: registerFigjamSpecTypes() at plugin load.

import type { Editor } from "../../shared/editors.js";
import { BridgeError, ErrorCode } from "../../shared/errors.js";
import type { ParsedEndpoint } from "../../shared/figjam.js";
import { registerSpecType, specType, type SpecBuild, type SpecCheck, type SpecFields, type SpecTypeHandler } from "../spec-types.js";
import { weightToStyle, type NodeLikeW } from "../write.js";
import {
  buildCodeBlock,
  buildConnector,
  buildShape,
  buildSticky,
  buildTable,
  endpointNode,
  FIGJAM_FONT,
  failedAtOf,
  Measurer,
  optNumber,
  parseCode,
  parseConnector,
  parseShape,
  parseSticky,
  parseTable,
  type ConnectorSpec,
  type Make,
} from "./nodes.js";

const FIGJAM: readonly Editor[] = ["figjam"];
const POSITION = ["x", "y"] as const;

/** A nodes.ts refusal, handed to the builder's own refuse so it names the field and says nothing exists yet. */
function checked<T>(check: SpecCheck, path: string, parse: () => T): T {
  try {
    return parse();
  } catch (err) {
    if (err instanceof BridgeError) return check.refuse(failedAtOf(err) ?? path, err.message, err.hint);
    throw err;
  }
}

async function checkedAsync(check: SpecCheck, path: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (err instanceof BridgeError) check.refuse(failedAtOf(err) ?? path, err.message, err.hint);
    throw err;
  }
}

function position(node: SpecFields, path: string): { x?: number; y?: number } {
  const x = optNumber(node, "x", path);
  const y = optNumber(node, "y", path);
  return { ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
}

const make = (b: SpecBuild): Make => ({
  record: (n) => b.record(n),
  append: (p, c) => b.append(p, c),
  loadFont: (f) => b.loadFont(f),
  yieldToHost: () => b.yieldToHost(),
});

const sticky: SpecTypeHandler = {
  // width/height are listed only so the refusal can point at `wide`.
  fields: ["content", "color", "wide", "authorVisible", ...POSITION, "width", "height"],
  container: false,
  editors: FIGJAM,
  validate(node, path, check) {
    checked(check, path, () => {
      parseSticky(node, path, { textKey: "content", allowed: null });
      position(node, path);
    });
  },
  async build(node, parent, b) {
    const spec = parseSticky(node, "", { textKey: "content", allowed: null });
    const made = await buildSticky(spec, parent, make(b));
    const at = position(node, "");
    b.place(made, at.x, at.y);
    return made;
  },
};

const shape: SpecTypeHandler = {
  fields: ["shape", "content", "color", "fill", "stroke", "textColor", "width", "height", "fontSize", ...POSITION],
  container: false,
  editors: FIGJAM,
  validate(node, path, check) {
    checked(check, path, () => {
      parseShape(node, path, { textKey: "content", allowed: null });
      position(node, path);
    });
  },
  async build(node, parent, b) {
    const spec = parseShape(node, "", { textKey: "content", allowed: null });
    // One measurer per shape here: a spec has no end-of-call hook to remove a shared one, and it must never outlive the build [C-163].
    const measurer = new Measurer(make(b));
    try {
      const { node: made } = await buildShape(spec, parent, make(b), measurer);
      const at = position(node, "");
      b.place(made, at.x, at.y);
      return made;
    } finally {
      measurer.remove();
    }
  },
};

const table: SpecTypeHandler = {
  fields: ["rows", "numRows", "numColumns", "header", "headerColor", "fill", "columnWidths", "rowHeights", "fontFamily", "weight", "fontSize", ...POSITION],
  container: false,
  editors: FIGJAM,
  validate(node, path, check) {
    checked(check, path, () => {
      parseTable(node, path, null);
      position(node, path);
    });
  },
  async build(node, parent, b) {
    const spec = parseTable(node, "", null);
    // A spec's font is loaded exactly or refused (b.loadFont), like the spec's text.
    const font =
      spec.fontFamily !== undefined || spec.weight !== undefined
        ? { family: spec.fontFamily ?? FIGJAM_FONT.family, style: spec.weight !== undefined ? weightToStyle(spec.weight) : spec.fontFamily ? "Regular" : FIGJAM_FONT.style }
        : undefined;
    const made = await buildTable(spec, parent, make(b), font);
    const at = position(node, "");
    b.place(made, at.x, at.y);
    return made;
  },
};

const code: SpecTypeHandler = {
  fields: ["content", "language", ...POSITION],
  container: false,
  editors: FIGJAM,
  validate(node, path, check) {
    checked(check, path, () => {
      parseCode(node, path, { textKey: "content", allowed: null });
      position(node, path);
    });
  },
  async build(node, parent, b) {
    const spec = parseCode(node, "", { textKey: "content", allowed: null });
    const made = await buildCodeBlock(spec, parent, make(b));
    const at = position(node, "");
    b.place(made, at.x, at.y);
    return made;
  },
};

const CONNECTOR_PLACEMENT = ["x", "y", "width", "height"] as const;

const connector: SpecTypeHandler = {
  // x/y/width/height are listed only so the refusal can say why.
  fields: ["from", "to", "label", "lineType", "startCap", "endCap", "color", "strokeWeight", "dash", "labelBackground", ...CONNECTOR_PLACEMENT],
  container: false,
  editors: FIGJAM,
  deferred: true,
  async validate(node, path, check) {
    for (const k of CONNECTOR_PLACEMENT) {
      if (node[k] !== undefined) {
        check.refuse(`${path}.${k}`, `\`${path}.${k}\`: a connector is drawn between its ends; it takes no ${k}.`, "Move or size the nodes it connects; setting a connector's box breaks its route.");
      }
    }
    const spec = checked(check, path, () => parseConnector(node, path, { refs: true, weightKey: "strokeWeight", allowed: null, create: true }));
    for (const end of ["from", "to"] as const) {
      const e = spec[end]!;
      if (!("endpointNodeId" in e)) continue;
      const at = `${path}.${end}`;
      if (e.ref) {
        if (!check.refs.has(e.endpointNodeId)) {
          check.refuse(at, `\`${at}\` names the ref "${e.endpointNodeId}", which no node in this spec declares.`, check.refs.size ? `Refs here: ${[...check.refs].join(", ")}.` : "Give the node it should attach to a `ref`.");
        }
        continue;
      }
      await checkedAsync(check, at, async () => {
        await endpointNode(e.endpointNodeId, at);
      });
    }
  },
  async build(node, parent, b) {
    const spec: ConnectorSpec = parseConnector(node, "", { refs: true, weightKey: "strokeWeight", allowed: null, create: true });
    for (const end of ["from", "to"] as const) {
      const e = spec[end]!;
      if ("endpointNodeId" in e && e.ref) spec[end] = await resolved(e, end, b);
    }
    return buildConnector(spec, parent, make(b));
  },
};

/** A ref endpoint with the id of the node built for it. A connector stays refused as an end until measured [C-148]. */
async function resolved(e: ParsedEndpoint & { endpointNodeId: string }, end: string, b: SpecBuild): Promise<ParsedEndpoint> {
  const target: NodeLikeW = await b.resolveRef(e.endpointNodeId);
  if (target.type === "CONNECTOR") {
    // Nodes exist by now: no `created: []` here, the builder reports what it made.
    throw new BridgeError(ErrorCode.INVALID_PARAM, `\`${end}\`: the ref "${e.endpointNodeId}" is a connector; attaching a connector to another one is not supported yet.`);
  }
  const { ref: _ref, ...rest } = e;
  return { ...rest, endpointNodeId: target.id } as ParsedEndpoint;
}

/** The board types, by spec type name. */
export const FIGJAM_SPEC_TYPES: Readonly<Record<string, SpecTypeHandler>> = { sticky, shape, table, code, connector };

/**
 * Register the board types with create_from_spec. Safe to call twice (a test
 * and the plugin's load may both do it); a different handler already under one
 * of these names is a real clash and throws, as registerSpecType does.
 */
export function registerFigjamSpecTypes(): void {
  for (const [name, handler] of Object.entries(FIGJAM_SPEC_TYPES)) {
    if (specType(name) === handler) continue;
    registerSpecType(name, handler);
  }
}
