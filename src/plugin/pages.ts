// Pages under documentAccess "dynamic-page" (manifest.json): only the user's
// current page is guaranteed to be loaded. Another page's `children`,
// `appendChild`, `insertChild` and finds need PageNode.loadAsync() first, and a
// document-wide find needs figma.loadAllPagesAsync() [C-090]. Without it a
// cross-page read or write fails on whichever page the user is not looking at.

import { BridgeError, ErrorCode } from "../shared/errors.js";

interface PageLike {
  type: string;
  id?: string;
  name?: string;
  loadAsync?(): Promise<void>;
}

interface FigmaPages {
  currentPage: unknown;
  loadAllPagesAsync?(): Promise<void>;
}

const api = () => (globalThis as unknown as { figma: FigmaPages }).figma;

/**
 * Figma's own words when it gives up fetching what the plugin asked for —
 * "Unable to establish connection to Figma after 10 seconds. Please check your
 * internet connection." It reached agents as INTERNAL — from
 * figma_get_nodes_info on 2026-10-09, and from figma_get_design_context on
 * another page's id on 2026-10-13 — with nothing saying what Figma was asked
 * for or what to try.
 */
const GAVE_UP = /unable to establish connection|after \d+ seconds/i;

const textOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The error for something Figma could not fetch for the plugin: what it was,
 * Figma's own text quoted, and what to try. A timeout in Figma's words is
 * TIMEOUT; anything else stays INTERNAL, with the same context.
 */
export function notReachable(err: unknown, what: string, pageId: string | undefined): BridgeError {
  if (err instanceof BridgeError) return err;
  const said = textOf(err);
  const open = pageId
    ? `Open the page in Figma (figma_navigate_page { pageId: "${pageId}" }) and call again — the open page is the one Figma keeps loaded`
    : "If it is on a page other than the open one, open that page (figma_get_pages lists them, figma_navigate_page opens one) and call again";
  return new BridgeError(GAVE_UP.test(said) ? ErrorCode.TIMEOUT : ErrorCode.INTERNAL, `Figma could not load ${what} for the plugin. Figma said: "${said}"`, {
    hint: `${open}; or retry in a moment. A failed load changes nothing in the file, so a read can simply be called again. If it fails again, ask the user whether Figma itself shows a connection problem.`,
  });
}

/** How a page is named in an error: its name and id where it has them. */
function pageLabel(node: PageLike): string {
  const id = typeof node.id === "string" ? node.id : undefined;
  if (typeof node.name !== "string") return id ? `the page ${id}` : "a page";
  return id ? `the page "${node.name}" (${id})` : `the page "${node.name}"`;
}

/**
 * Load `node` when it is a page other than the current one. Any other node
 * passes through: the loadAsync requirement is on pages only, and the current
 * page is the one Figma guarantees loaded [C-090]. A page Figma could not load
 * is said as that, with what to try, never as Figma's bare text.
 */
export async function ensureLoaded(node: PageLike): Promise<void> {
  if (node.type === "PAGE" && node !== api().currentPage && typeof node.loadAsync === "function") {
    try {
      await node.loadAsync();
    } catch (err) {
      throw notReachable(err, pageLabel(node), typeof node.id === "string" ? node.id : undefined);
    }
  }
}

/** Load every page — only for a walk that must see the whole document; slow on a large file [C-090]. */
export async function loadAllPages(): Promise<void> {
  try {
    await api().loadAllPagesAsync?.();
  } catch (err) {
    throw notReachable(err, "every page of the file", undefined);
  }
}
