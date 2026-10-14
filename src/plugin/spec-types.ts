// The create_from_spec extension contract: node types beyond the built-in ones
// (frame, text, rectangle, … in ops/create.ts).
//
// The builder in ops/create.ts looks a type up here when it is not one of its
// own; the FigJam node types (sticky, shape, table, code, connector) register
// here from their own module. That is the seam that lets the builder and the
// board types change without editing the same file, and it keeps ONE spec
// validator and ONE undo step per call for every editor — one zone or one slide
// per call, the same rhythm as one section per call [C-082] [C-155].
//
// A handler owns its node from creation to placement:
//   1. validate(node, path, check) runs for every node of its type BEFORE the
//      first node exists; a refusal goes through check.refuse, so the call
//      reports `partial: { created: [] }` and frees its idempotencyKey.
//   2. build(node, parent, b) creates the node, hands it to b.record at once,
//      appends it into `parent` with b.append, then writes its properties and
//      places it with b.place. Append first: a Slides node positioned before
//      its final append can land 240 px off [C-146], and a connector must sit
//      in its final parent before its endpoints are set — a reparented
//      connector keeps stale elbows (generate-project-plan SKILL.md:195)
//      [C-149]. The builder does not append the returned node again.
//
// Structural types only (no plugin typings), so the tests import it as it is.

import type { Editor } from "../shared/editors.js";
import type { NodeLikeW, SolidPaint } from "./write.js";

/** A node as the builder handles it. */
export type SceneLike = NodeLikeW;

/** One spec node as parsed JSON: `type`, `name`, `ref`, and the handler's own fields. */
export type SpecFields = Record<string, unknown>;

/** Keys every spec node may carry, whatever its type; a handler's `fields` lists the rest. */
export const UNIVERSAL_SPEC_FIELDS = ["type", "name", "ref"] as const;

export interface SpecCheck {
  /** figma.editorType of the file being built in. */
  editor: string;
  /** Every `ref` the spec declares, so a field may name a node built later in the same call. */
  refs: ReadonlySet<string>;
  /** Refuse before anything exists: INVALID_PARAM with `partial: { created: [], failedAt: path }`. */
  refuse(path: string, message: string, hint?: string): never;
  /** write.ts parseColor: "#rgb" / "#rrggbb" / "#rrggbbaa" → a SOLID paint, refusing anything else by `field`. */
  parseColor(input: unknown, field: string): SolidPaint;
}

export interface SpecBuild {
  /** figma.editorType of the file being built in. */
  editor: string;
  /** Report a node the moment it exists, before its first write, so a later failure still lists it in partial.created. */
  record<T extends SceneLike>(node: T): T;
  /** Append `child` into its final parent. */
  append(parent: SceneLike, child: SceneLike): void;
  /** Set x/y, after the append; an omitted axis keeps Figma's placement. */
  place(node: SceneLike, x?: number, y?: number): void;
  /** A `ref` declared in this spec (the node built for it), else a node id in this file. */
  resolveRef(refOrId: string): Promise<SceneLike>;
  /** Load a font; FONT_LOAD_FAILED when it will not load. */
  loadFont(font: { family: string; style: string }): Promise<void>;
  /** Give Figma a turn during a long build (a large table). */
  yieldToHost(): Promise<void>;
}

export interface SpecTypeHandler {
  /** The keys this type takes beyond UNIVERSAL_SPEC_FIELDS; any other key is refused with the nearest name. */
  fields: readonly string[];
  /** Whether it takes `children`. */
  container: boolean;
  /** The editors it builds in; any other editor is refused before the first node. */
  editors: readonly Editor[];
  /** Built after the rest of the tree, in the container that declares it (connectors: their ends must exist). Never a container. */
  deferred?: boolean;
  validate(node: SpecFields, path: string, check: SpecCheck): void | Promise<void>;
  build(node: SpecFields, parent: SceneLike, b: SpecBuild): Promise<SceneLike>;
}

const handlers = new Map<string, SpecTypeHandler>();

/** Register a spec type; its name is matched case-insensitively, like the built-in ones. */
export function registerSpecType(type: string, handler: SpecTypeHandler): void {
  const key = type.trim().toLowerCase();
  if (!key) throw new Error("a spec type needs a name");
  if (handlers.has(key)) throw new Error(`spec type "${key}" is already registered`);
  if (handler.deferred && handler.container) throw new Error(`spec type "${key}" cannot be both deferred and a container`);
  const clash = handler.fields.find((f) => (UNIVERSAL_SPEC_FIELDS as readonly string[]).includes(f));
  if (clash) throw new Error(`spec type "${key}" lists "${clash}", which every type already takes`);
  handlers.set(key, handler);
}

/** The handler for `type`, or undefined when no module registered it. */
export function specType(type: string): SpecTypeHandler | undefined {
  return handlers.get(type.trim().toLowerCase());
}

/** Every registered type name, for the "use one of" hint. */
export function specTypeNames(): string[] {
  return [...handlers.keys()];
}

/** Drop a registration — for tests that register a fake type. */
export function unregisterSpecType(type: string): boolean {
  return handlers.delete(type.trim().toLowerCase());
}

/** Whether `handler` builds in `editor` (figma.editorType, which may be outside the three). */
export function specTypeRunsIn(handler: SpecTypeHandler, editor: string): boolean {
  return (handler.editors as readonly string[]).includes(editor);
}
