// figma_check_layout's `mark` audit: the tests a brand designer puts a mark
// through before calling it finished (role spec §4.6) — does it survive the
// smallest size it is used at, is every version the brief declares drawn (and
// is the one-colour version truly one colour), does each lockup keep its clear
// space, does the mark hold on its ground, and does an app icon carry text it
// does not need.
//
// The numbers come from the brief: details.applications ({ name, sizePx }, the
// size the mark is rendered at there), details.versions (by default full
// colour, one colour and reversed, src/shared/roles.ts) and details.clearSpace
// ("1x = cap height", "24 px"). A logotype is exempt from text contrast (WCAG
// 2.2 SC 1.4.3, logotypes), so mark_contrast judges the mark as a graphic
// against 3:1, as guidance, at info. Apple's HIG asks an app icon (1024 ×
// 1024 px) to carry text only when it is essential.
//
// Warnings only where the brief declared the number: a detail under 1 px at a
// declared application size, a declared version missing, a declared clear
// space not kept. The rest is info until calibrated (§4.9). Plain functions
// over the census, after the walk; versions drawn outside the checked subtree
// are found among the page's top-level frames and the brief's deliverables,
// which check.ts lists beforehand (RoleContext.frames).

import { type RoleContext, variantPropsOf, words } from "./a11y.js";
import { childrenOf, field } from "./board-read.js";
import { contrastRatio } from "./context.js";
import { type Census, type Finding, type Index, type Layer, type Rect, type Rgb, bottom, hex, mix, overlapX, overlapY, r1, right } from "./craft.js";
import type { NodeLike } from "./read.js";

type Any = Record<string, unknown>;

/** Every threshold of the mark audit, to calibrate here. */
export const MARK = {
  /** mark_detail_lost: a feature this many px or thinner at an application's size is lost (warning); under softPx it is fragile (info). */
  lostPx: 1,
  softPx: 2,
  /** mark_contrast: the 3:1 a graphic needs (WCAG 2.2 SC 1.4.11), as guidance: SC 1.4.3 exempts logotypes. */
  contrast: 3,
  /** clear_space: cap height and x-height as shares of the size when the ink cannot say; padding may fall short by clearTol px. */
  capHeightEm: 0.7,
  xHeightEm: 0.5,
  clearTol: 0.5,
  /** A leaf covering this share of a mark or lockup is its ground (a plate), not the mark. */
  groundShare: 0.9,
  /** version_missing: the versions a brand brief declares by default (src/shared/roles.ts), and the words that name each. */
  versions: ["full colour", "one colour", "reversed"],
  synonyms: {
    "full colour": ["full colour", "primary", "positive", "multicolour", "multi colour"],
    "one colour": ["one colour", "single colour", "1 colour", "mono", "monochrome", "monotone", "one tone"],
    reversed: ["reversed", "reverse", "inverse", "inverted", "knockout", "knock out", "negative"],
  } as Readonly<Record<string, readonly string[]>>,
  /** app_icon_text: an app icon's canvas (Apple HIG: 1024 × 1024 px). */
  appIcon: 1024,
  /** Layers read per version off the page, and shape pairs compared per parent, so a large brand sheet stays fast. */
  cap: 2000,
  pairCap: 200,
} as const;

/** A layer named for a mark: logo, wordmark, symbol, lockup and their kin. */
const MARK_NAME = /(^| )(logo|logos|logomark|logotype|wordmark|lettermark|monogram|symbol|emblem|brandmark|mark|lockup)( |$)/;
/** A brand sheet's panels name the mark too, and are not it. */
const SHEET_NAME = /(^| )(usage|guide|guides|guidelines|sheet|do|dos|don t|dont|misuse|rules|examples|overview|clear space|colours|colors|palette|typography|board)( |$)/;
const LOCKUP = /(^| )lockup( |$)/;
const APP_ICON = /(^| )app ?icon( |$)/;
const CANDIDATE = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "GROUP", "VECTOR", "BOOLEAN_OPERATION"]);
/** Layers whose geometry is drawn: their stroke weight and box are features of the mark. */
const SHAPES = new Set(["VECTOR", "LINE", "ELLIPSE", "RECTANGLE", "POLYGON", "STAR", "BOOLEAN_OPERATION", "REGULAR_POLYGON"]);
/** A unit in a clear-space line. */
const UNIT = /(\d+(?:\.\d+)?)\s*(px|x)\b/i;

type Push = (n: NodeLike, kind: string, severity: Finding["severity"], detail: string) => void;
type Application = { name: string; sizePx: number };

const area = (b: Rect) => Math.max(0, b.width) * Math.max(0, b.height);
const visible = (n: unknown) => field(n, "visible") !== false;
function boxOf(n: unknown): Rect | null {
  const b = field<Rect | null>(n, "absoluteBoundingBox");
  return b && Number.isFinite(b.width) && Number.isFinite(b.height) ? b : null;
}
/** A version name compared: words, "color" as "colour", padded so a key is matched as whole words. */
const key = (s: string) => ` ${words(s).replace(/\bcolor\b/g, "colour")} `;

export function judgeMark(c: Census, ix: Index, rc: RoleContext): Finding[] {
  const out: Finding[] = [];
  const push: Push = (n, kind, severity, detail) => out.push({ kind, severity, nodeId: n.id, name: n.name, detail });
  const details = (rc.brief?.details ?? {}) as Any;
  const unmeasured: string[] = [];
  const marks = marksOf(c, ix, details);
  if (!marks.length) {
    unmeasured.push("mark_detail_lost and mark_contrast (no layer here is named for a mark — logo, wordmark, symbol, lockup — or for the brand)");
  } else {
    const apps = applicationsOf(details);
    if (apps.length) for (const m of marks) detailLost(m, c, ix, apps, push);
    else unmeasured.push(`mark_detail_lost (${rc.brief ? "the brief lists no applications with their sizePx" : "no brief was given: figma_check_layout { briefId }"})`);
    for (const m of marks) markContrast(m, c, ix, push);
  }
  if (rc.brief) versions(c, rc, details, push);
  else unmeasured.push("version_missing (no brief was given)");
  const clear = clearSpace(c, ix, details, push, !!rc.brief);
  if (clear) unmeasured.push(`clear_space (${clear})`);
  appIconText(c, ix, details, push);
  if (unmeasured.length) push(c.rootNode, "mark_unmeasured", "info", `not measured: ${unmeasured.join("; ")}. The rest of the mark audit ran.`);
  return out;
}

// ── which layers are the mark ────────────────────────────────────────────────

/**
 * The marks in the census: layers named for a mark or for the brand
 * (details.name), not a brand sheet's panel. A component set named for the
 * mark is its versions, one per variant; a lockup or a component is one mark
 * with its parts inside it; a frame holding several marks is a sheet of them,
 * so its marks are judged instead. Components come before their instances,
 * which copy them. Nothing named: a component checked by itself is the mark.
 */
function marksOf(c: Census, ix: Index, details: Any): Layer[] {
  const all = c.root ? [c.root, ...c.layers] : c.layers;
  const brand = typeof details.name === "string" ? words(details.name) : "";
  const named = (n: NodeLike) => {
    const w = words(n.name);
    if (SHEET_NAME.test(w)) return false;
    return MARK_NAME.test(w) || (!!brand && words(n.name.split("/")[0]!) === brand);
  };
  let found: Layer[] = [];
  for (const l of all) {
    if (!CANDIDATE.has(l.node.type) || !named(l.node)) continue;
    if (l.node.type === "COMPONENT_SET") found.push(...ix.kids(l.node).filter((k) => k.node.type === "COMPONENT"));
    else found.push(l);
  }
  if (!found.length && c.root && (c.rootNode.type === "COMPONENT" || c.rootNode.type === "COMPONENT_SET")) {
    found = c.rootNode.type === "COMPONENT" ? [c.root] : ix.kids(c.rootNode).filter((k) => k.node.type === "COMPONENT");
  }
  const whole = (l: Layer) => l.node.type === "COMPONENT" || LOCKUP.test(words(l.node.name));
  const set = new Set(found.map((l) => l.node));
  found = found.filter((l) => {
    const inside = found.filter((o) => o !== l && ix.isAncestor(l.node, o.node));
    if (inside.length >= 2 && !whole(l)) return false; // a sheet of marks, not one
    for (let p = l.node.parent; p; p = p.parent) {
      if (!set.has(p)) continue;
      const outer = ix.byNode.get(p);
      if (outer && (whole(outer) || found.filter((o) => o !== outer && ix.isAncestor(outer.node, o.node)).length < 2)) return false;
    }
    return true;
  });
  if (found.some((l) => l.node.type === "COMPONENT")) found = found.filter((l) => l.node.type !== "INSTANCE");
  return found;
}

/** `details.applications` as { name, sizePx }, the bad entries left out. */
function applicationsOf(details: Any): Application[] {
  const raw = Array.isArray(details.applications) ? (details.applications as unknown[]) : [];
  const out: Application[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const size = Number((a as Any).sizePx);
    if (!Number.isFinite(size) || size <= 0) continue;
    out.push({ name: typeof (a as Any).name === "string" ? ((a as Any).name as string) : `${size} px`, sizePx: size });
  }
  return out.sort((a, b) => a.sizePx - b.sizePx);
}

// ── mark_detail_lost ─────────────────────────────────────────────────────────

/** The layers of the mark that draw it: its shapes, a boolean's operands left out (they are not seen, the result is). */
function shapesOf(m: Layer, c: Census, ix: Index): Layer[] {
  const all = [m, ...c.layers.filter((l) => ix.isAncestor(m.node, l.node))];
  return all.filter((l) => {
    if (!SHAPES.has(l.node.type) || !(l.filled || l.stroked)) return false;
    for (let p = l.node.parent; p && p !== m.node.parent; p = p.parent) if (p.type === "BOOLEAN_OPERATION") return false;
    return true;
  });
}

/**
 * The mark's smallest feature: the least of its shapes' stroke weights, of
 * its filled shapes' smaller box sides, and of the gaps between sibling
 * shapes that face each other.
 */
function smallestFeature(m: Layer, c: Census, ix: Index): { px: number; what: string; at: Layer; count: (limit: number) => number } | null {
  const shapes = shapesOf(m, c, ix);
  const features: Array<{ px: number; what: string; at: Layer }> = [];
  for (const s of shapes) {
    const w = s.a.strokeWeight;
    if (s.stroked && typeof w === "number" && w > 0) features.push({ px: w, what: "stroke", at: s });
    const side = Math.min(s.box.width, s.box.height);
    if (s.filled && s.node.type !== "LINE" && side >= 0.01) features.push({ px: side, what: s.box.width < s.box.height ? "width" : "height", at: s });
  }
  const byParent = new Map<NodeLike | null, Layer[]>();
  for (const s of shapes) byParent.set(s.node.parent ?? null, [...(byParent.get(s.node.parent ?? null) ?? []), s]);
  for (const sibs of byParent.values()) {
    const list = sibs.slice(0, MARK.pairCap);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!.box;
        const b = list[j]!.box;
        const gx = -overlapX(a, b);
        const gy = -overlapY(a, b);
        // Only gaps two shapes face each other across: side by side, or one above the other.
        const gap = gx > 0 && overlapY(a, b) > 0 ? gx : gy > 0 && overlapX(a, b) > 0 ? gy : 0;
        if (gap > 0) features.push({ px: gap, what: `gap to "${list[j]!.node.name}"`, at: list[i]! });
      }
    }
  }
  if (!features.length) return null;
  const least = features.reduce((x, y) => (y.px < x.px ? y : x), features[0]!);
  return { ...least, count: (limit) => features.filter((f) => f.px < limit).length };
}

/** mark_detail_lost: the smallest feature, scaled to each application's size (sizePx = the mark's longer side there). */
function detailLost(m: Layer, c: Census, ix: Index, apps: Application[], push: Push): void {
  const f = smallestFeature(m, c, ix);
  const side = Math.max(m.box.width, m.box.height);
  if (!f || side <= 0) return;
  const at = (a: Application) => (f.px * a.sizePx) / side;
  const lost = apps.filter((a) => at(a) < MARK.lostPx - 1e-9);
  const soft = apps.filter((a) => at(a) >= MARK.lostPx - 1e-9 && at(a) < MARK.softPx - 1e-9);
  if (!lost.length && !soft.length) return;
  const list = (l: Application[]) => l.map((a) => `${a.name} (${a.sizePx} px: ${Math.round(at(a) * 100) / 100} px)`).join(", ");
  const smallest = (lost[0] ?? soft[0])!;
  const thinner = f.count((MARK.lostPx * side) / smallest.sizePx);
  const what = `its smallest feature, the ${f.what} of "${f.at.node.name}" (${f.at.node.id}), is ${r1(f.px)} px on a ${r1(side)} px mark`;
  if (lost.length) {
    push(m.node, "mark_detail_lost", "warning",
      `${what}: at ${list(lost)} it renders under ${MARK.lostPx} px, so it fills in or disappears` +
        `${thinner > 1 ? ` (${thinner} features are that thin at ${smallest.name})` : ""}${soft.length ? `; at ${list(soft)} under ${MARK.softPx} px` : ""}. ` +
        "Thicken the strokes, open the gaps, or draw a simplified version for the small sizes (sizePx is read as the mark's longer side).");
  } else {
    push(m.node, "mark_detail_lost", "info",
      `${what}: at ${list(soft)} it renders under ${MARK.softPx} px — it survives, barely, and blurs on a low-density screen. ` +
        "Check the render at that size (figma_export_node), and simplify the mark there if the detail matters.");
  }
}

// ── mark_contrast ────────────────────────────────────────────────────────────

/** mark_contrast: the mark's colours against its ground under 3:1, as graphics guidance (logotypes are exempt from SC 1.4.3). */
function markContrast(m: Layer, c: Census, ix: Index, push: Push): void {
  const own = m.solid && m.solid.opacity >= 0.99 && (typeof m.a.opacity !== "number" || (m.a.opacity as number) >= 0.99) ? m.solid.color : null;
  const ground = own ?? c.backdrop(m.node);
  if (!ground) return;
  const plate = MARK.groundShare * area(m.box);
  let worst: { ratio: number; seen: Rgb; at: Layer } | null = null;
  for (const l of c.layers) {
    if (!ix.isAncestor(m.node, l.node)) continue;
    if (!l.text && !(childrenOf(l.node) ?? []).length && area(l.box) >= plate) continue; // a plate under the mark is its ground
    const alpha = typeof l.a.opacity === "number" ? (l.a.opacity as number) : 1;
    for (const p of [l.solid, l.strokeSolid]) {
      if (!p || p.opacity * alpha < 0.05) continue;
      const seen = mix(p.color, ground, p.opacity * alpha);
      const ratio = contrastRatio(seen, ground);
      if (!worst || ratio < worst.ratio) worst = { ratio, seen, at: l };
    }
  }
  if (!worst || worst.ratio >= MARK.contrast) return;
  push(m.node, "mark_contrast", "info",
    `its colour ${hex(worst.seen)} ("${worst.at.node.name}") is ${worst.ratio.toFixed(2)}:1 against its ground ${hex(ground)}, under the ${MARK.contrast}:1 ` +
      "a graphic needs to hold its shape (WCAG 2.2 SC 1.4.11, as guidance: SC 1.4.3 exempts logotypes from text contrast). Darken or lighten it " +
      "for this ground, or keep this version off grounds like it.");
}

// ── version_missing ──────────────────────────────────────────────────────────

/** The words a node is known by: its name's segments, a variant's values, and the whole name. */
function labelsOf(n: NodeLike): string[] {
  const out: string[] = [n.name];
  for (const seg of n.name.split(/[/,]/)) {
    const i = seg.indexOf("=");
    out.push(i >= 0 ? seg.slice(i + 1) : seg);
  }
  if (n.type === "COMPONENT" || n.type === "INSTANCE") {
    const props = variantPropsOf(n);
    for (const k of Object.keys(props)) out.push(props[k]!);
  }
  return out.map(key).filter((s) => s.trim());
}

/** Every solid colour drawn inside `n` (a plate covering it left out); `mixed` when a gradient or an image paints part of it. */
function inksOf(n: NodeLike): { colours: Set<string>; mixed: boolean } {
  const colours = new Set<string>();
  let mixed = false;
  const box = boxOf(n);
  const plate = box ? MARK.groundShare * area(box) : Infinity;
  const stack = [...(childrenOf(n) ?? [])];
  for (let seen = 0; stack.length && seen < MARK.cap; seen++) {
    const k = stack.pop()!;
    if (!visible(k)) continue;
    const kids = childrenOf(k) ?? [];
    const kb = boxOf(k);
    const isPlate = !kids.length && k.type !== "TEXT" && kb && area(kb) >= plate;
    if (!isPlate) {
      for (const list of [field(k, "fills"), field(k, "strokes")]) {
        if (!Array.isArray(list)) continue;
        for (const p of list as Any[]) {
          if (!p || p.visible === false) continue;
          const o = typeof p.opacity === "number" ? p.opacity : 1;
          if (o < 0.01) continue;
          if (p.type === "SOLID") colours.add(`${hex(p.color as Rgb)}${o < 0.99 ? `@${Math.round(o * 100)}%` : ""}`);
          else mixed = true; // a gradient, an image, a video: more than one colour
        }
      }
    }
    for (const kk of kids) stack.push(kk);
  }
  return { colours, mixed };
}

/**
 * version_missing: each version the brief declares (details.versions, else
 * full colour, one colour and reversed) has a component, variant or frame
 * named for it — here, among the page's top-level frames, or among the
 * brief's deliverables — and a one-colour version paints one colour.
 * Reported on the brief, once, as screen_state_missing is.
 */
function versions(c: Census, rc: RoleContext, details: Any, push: Push): void {
  const brief = rc.brief!;
  const declared = Array.isArray(details.versions)
    ? (details.versions as unknown[]).filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [...MARK.versions];
  if (!declared.length) return;
  // Where a version may be drawn: the checked subtree, the page's top-level frames and the deliverables, and their variants.
  const pool = new Map<NodeLike, string[]>();
  const add = (n: NodeLike) => {
    if (!pool.has(n) && (n.type === "COMPONENT" || n.type === "FRAME" || n.type === "INSTANCE" || n.type === "COMPONENT_SET")) pool.set(n, labelsOf(n));
  };
  for (const l of c.root ? [c.root, ...c.layers] : c.layers) add(l.node);
  for (const f of rc.frames) {
    if (!f.node) continue;
    add(f.node);
    if (f.node.type === "COMPONENT_SET") for (const v of childrenOf(f.node) ?? []) if (visible(v)) add(v);
  }
  const oneColour = new Set(MARK.synonyms["one colour"]!.map((s) => key(s)));
  const missing: string[] = [];
  for (const v of declared) {
    const k = key(v);
    const group = Object.keys(MARK.synonyms).find((g) => key(g) === k || MARK.synonyms[g]!.some((s) => key(s) === k));
    const keys = group ? MARK.synonyms[group]!.map(key) : [k];
    const hits = [...pool].filter(([, labels]) => labels.some((lab) => keys.some((x) => lab.indexOf(x) >= 0))).map(([n]) => n);
    if (!hits.length) {
      missing.push(`"${v}" (no component, variant or frame is named for it)`);
      continue;
    }
    if (!keys.some((x) => oneColour.has(x))) continue;
    const inks = hits.map((n) => ({ n, ...inksOf(n) }));
    if (inks.some((i) => !i.mixed && i.colours.size <= 1)) continue;
    const first = inks[0]!;
    const what = first.mixed ? "paints a gradient or an image" : `paints ${first.colours.size} colours (${[...first.colours].slice(0, 4).join(", ")})`;
    missing.push(`"${v}" ("${first.n.name}" (${first.n.id}) ${what}, so it is not one colour)`);
  }
  if (!missing.length) return;
  push({ id: brief.id, name: `brief "${brief.title}"`, type: "FRAME" }, "version_missing", "warning",
    `declares the version${declared.length > 1 ? "s" : ""} ${declared.map((v) => `"${v}"`).join(", ")}; missing: ${missing.join("; ")}. Draw each as a ` +
      "variant of the mark (a Version property: figma_combine_as_variants) or a frame named for it — a mark is finished when it survives one colour " +
      "and a reversed ground — or take it out of details.versions (figma_set_brief).");
}

// ── clear_space ──────────────────────────────────────────────────────────────

/** The union of a box list. */
function union(list: Rect[]): Rect | null {
  if (!list.length) return null;
  const x = Math.min(...list.map((b) => b.x));
  const y = Math.min(...list.map((b) => b.y));
  return { x, y, width: Math.max(...list.map(right)) - x, height: Math.max(...list.map(bottom)) - y };
}

/**
 * clear_space: each lockup frame (a frame or component named lockup) keeps
 * the padding `details.clearSpace` asks around what it holds: "24 px", or
 * "1x = cap height" (also x-height, mark height, mark width), resolved from
 * the lockup's own wordmark and mark. Returns why it was not measured, or null.
 */
function clearSpace(c: Census, ix: Index, details: Any, push: Push, briefed: boolean): string | null {
  const lockups = (c.root ? [c.root, ...c.layers] : c.layers).filter(
    (l) => (l.node.type === "FRAME" || l.node.type === "COMPONENT" || l.node.type === "INSTANCE") && LOCKUP.test(words(l.node.name)),
  );
  const raw = details.clearSpace;
  const rule = typeof raw === "number" ? `${raw} px` : typeof raw === "string" ? raw.trim() : "";
  if (!lockups.length) return rule ? "no frame here is named lockup" : null;
  if (!rule) return briefed ? "the brief gives no clearSpace" : "no brief was given";
  const unit = UNIT.exec(rule);
  const times = unit ? Number(unit[1]) : 1; // "the cap height" is one of it
  const px = unit && unit[2]!.toLowerCase() === "px";
  const of = rule.toLowerCase();
  const basis = px ? "px" : /x-?height/.test(of) ? "x-height" : /cap|capital|letter/.test(of) ? "cap height" : /width/.test(of) ? "mark width" : /height/.test(of) ? "mark height" : "";
  if (!Number.isFinite(times) || !basis) {
    return `"${rule}" names no size this audit can resolve: write "24 px", or "1x = cap height" (x-height, mark height, mark width)`;
  }
  for (const lock of lockups) {
    const kids = ix.kids(lock.node);
    const plate = MARK.groundShare * area(lock.box);
    const content = kids.filter((k) => (k.text ? k.text.chars.trim() !== "" : !(area(k.box) >= plate && !(childrenOf(k.node) ?? []).length)));
    const ink = union(content.map((k) => (k.text ? k.text.glyphs : k.box)));
    if (!ink) continue;
    let need: number;
    let from: string;
    if (px) {
      need = times;
      from = `${times} px`;
    } else if (basis === "cap height" || basis === "x-height") {
      const texts = ix.texts.filter((t) => ix.isAncestor(lock.node, t.node));
      if (!texts.length) continue;
      const word = texts.reduce((m, t) => (t.text!.size > m.text!.size ? t : m), texts[0]!);
      const f = word.text!;
      const capInk = basis === "cap height" && f.caps && f.inked;
      const h = capInk ? f.glyphs.height : f.size * (basis === "cap height" ? MARK.capHeightEm : MARK.xHeightEm);
      need = times * h;
      from = `${basis} of "${word.node.name}" ${capInk ? "(its ink)" : `(≈ ${basis === "cap height" ? MARK.capHeightEm : MARK.xHeightEm} × ${r1(f.size)} px)`}`;
    } else {
      const shapes = content.filter((k) => !k.text);
      const mark = union((shapes.length ? shapes : content).map((k) => k.box))!;
      need = times * (basis === "mark width" ? mark.width : mark.height);
      from = `${basis} (${r1(basis === "mark width" ? mark.width : mark.height)} px)`;
    }
    const pads = { left: ink.x - lock.box.x, right: right(lock.box) - right(ink), top: ink.y - lock.box.y, bottom: bottom(lock.box) - bottom(ink) };
    const short = Object.entries(pads).filter(([, v]) => v < need - MARK.clearTol);
    if (!short.length) continue;
    push(lock.node, "clear_space", "warning",
      `keeps ${short.map(([side, v]) => `${r1(v)} px ${side}`).join(", ")} around its content; the brief's clear space "${rule}" is ${r1(need)} px here ` +
        `(${times}× the ${from}). Pad the lockup to ${r1(need)} px on every side (figma_set_auto_layout padding, or figma_resize_nodes), so nothing ` +
        "crowds the mark where it is placed.");
  }
  return null;
}

// ── app_icon_text ────────────────────────────────────────────────────────────

/** app_icon_text: an app icon (named for one, or a 1024 × 1024 top-level frame when an application is one) holding text. Apple HIG: text only when essential. */
function appIconText(c: Census, ix: Index, details: Any, push: Push): void {
  const apps = Array.isArray(details.applications) ? (details.applications as Any[]) : [];
  const appIconAsked = apps.some((a) => a && typeof a.name === "string" && APP_ICON.test(words(a.name)));
  const top = (n: NodeLike) => n.parent?.type === "PAGE" || n.parent?.type === "SECTION";
  const canvas = (b: Rect) => Math.abs(b.width - MARK.appIcon) <= 0.5 && Math.abs(b.height - MARK.appIcon) <= 0.5;
  const icons = (c.root ? [c.root, ...c.layers] : c.layers).filter((l) =>
    (l.node.type === "FRAME" || l.node.type === "COMPONENT" || l.node.type === "INSTANCE") &&
    (APP_ICON.test(words(l.node.name)) || (appIconAsked && top(l.node) && canvas(l.box))));
  const set = new Set(icons.map((l) => l.node));
  for (const icon of icons) {
    let nested = false;
    for (let p = icon.node.parent; p && !nested; p = p.parent) nested = set.has(p);
    if (nested) continue;
    const text = ix.texts.find((t) => ix.isAncestor(icon.node, t.node));
    if (!text) continue;
    push(icon.node, "app_icon_text", "info",
      `holds the text "${text.text!.chars.trim().slice(0, 30)}" ("${text.node.name}"): Apple's HIG asks an app icon to carry text only when it is ` +
        "essential — at icon sizes it cannot be read, and the app's name sits under the icon already. Let the symbol carry it, or keep the text " +
        "only if the name is the mark.");
  }
}
