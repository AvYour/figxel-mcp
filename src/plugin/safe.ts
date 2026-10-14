// Reading a member that may not exist, without letting the read throw.
//
// In Design files a missing member reads as undefined. In Slides — and, per the
// official skills, in FigJam — touching a member the editor does not have can
// THROW instead: `figma.createPage` in a board or a deck raises "no such
// property 'createPage' on the figma global object", and reading `fills` on a
// SLIDE_GRID throws "no such property 'fills' on SLIDE_GRID node"
// (figma-use-figjam/SKILL.md:13; figma-use-slides/SKILL.md:35;
// slide-gotchas.md:192) [C-145]. Whether every missing read throws is
// unmeasured, so every probe here survives both behaviours: a throw is
// "absent", never a crash.
//
// Structural types only (no plugin typings), so the server-side tests import
// this module as it is.

/** `key in obj`, false when the check itself throws or obj is not an object. */
export function has(obj: unknown, key: string): boolean {
  if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) return false;
  try {
    return key in (obj as object);
  } catch {
    return false;
  }
}

export type Got<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Read `obj[key]`. A throwing read reports Figma's own message; a member that
 * is absent (`in` says no and the value is undefined) reports that it is.
 */
export function tryGet<T = unknown>(obj: unknown, key: string): Got<T> {
  if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) {
    return { ok: false, message: `cannot read '${key}' of ${obj === null ? "null" : typeof obj}` };
  }
  try {
    const value = (obj as Record<string, unknown>)[key];
    if (value === undefined && !has(obj, key)) return { ok: false, message: `no property '${key}'` };
    return { ok: true, value: value as T };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The sandbox's `figma`, untyped — reached through globalThis so tests can install a fake. */
export function figmaGlobal(): unknown {
  return (globalThis as unknown as { figma?: unknown }).figma;
}

/**
 * Whether the figma global offers `name` — a dotted path such as
 * "variables.getLocalVariableCollectionsAsync" walks member by member. True
 * only for a member that is present and not null; a throw anywhere is false.
 */
export function apiHas(name: string): boolean {
  let at: unknown = figmaGlobal();
  for (const part of name.split(".")) {
    const got = tryGet(at, part);
    if (!got.ok || got.value === undefined || got.value === null) return false;
    at = got.value;
  }
  return true;
}

/** figma.editorType ("figma", "figjam", "slides", …), or undefined when it cannot be read. */
export function editorType(): string | undefined {
  const got = tryGet(figmaGlobal(), "editorType");
  return got.ok && typeof got.value === "string" ? got.value : undefined;
}
