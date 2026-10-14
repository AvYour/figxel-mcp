// Observational events — protocol.md §2 `event`. Debounced 150 ms through the
// UI-hosted delay (the sandbox may have no setTimeout, claim C-012).
// nodes_changed uses currentPage.on("nodechange"), not figma.on("documentchange"),
// which under dynamic-page would require loadAllPagesAsync (ADR #25).

import type { EventMsg } from "../shared/protocol.js";

const DEBOUNCE_MS = 150;
const MAX_SELECTION_IDS = 500;
const MAX_CHANGED_IDS = 50;

export interface EventSink {
  emit(msg: EventMsg): void;
  delay(ms: number): Promise<void>;
}

function debounced(delay: (ms: number) => Promise<void>, fn: () => void): () => void {
  let generation = 0;
  return () => {
    const mine = ++generation;
    void delay(DEBOUNCE_MS).then(() => {
      if (mine === generation) fn();
    });
  };
}

export function selectionEvent(): EventMsg {
  const sel = figma.currentPage.selection;
  return {
    t: "event",
    name: "selection_changed",
    data: { nodeIds: sel.slice(0, MAX_SELECTION_IDS).map((n) => n.id), count: sel.length, at: Date.now() },
  };
}

export function pageEvent(): EventMsg {
  return { t: "event", name: "page_changed", data: { pageId: figma.currentPage.id, pageName: figma.currentPage.name } };
}

export function startEvents(sink: EventSink): void {
  const changed = new Set<string>();
  let changeCount = 0;

  const flushSelection = debounced(sink.delay, () => sink.emit(selectionEvent()));
  const flushChanges = debounced(sink.delay, () => {
    const ids = [...changed].slice(0, MAX_CHANGED_IDS);
    sink.emit({ t: "event", name: "nodes_changed", data: { count: changeCount, nodeIds: ids, at: Date.now() } });
    changed.clear();
    changeCount = 0;
  });

  const onNodeChange = (e: NodeChangeEvent) => {
    for (const c of e.nodeChanges) {
      changed.add(c.id);
      changeCount++;
    }
    flushChanges();
  };

  let watchedPage: PageNode = figma.currentPage;
  watchedPage.on("nodechange", onNodeChange);

  figma.on("selectionchange", flushSelection);
  figma.on("currentpagechange", () => {
    watchedPage.off("nodechange", onNodeChange);
    watchedPage = figma.currentPage;
    watchedPage.on("nodechange", onNodeChange);
    sink.emit(pageEvent());
    flushSelection();
  });
}
