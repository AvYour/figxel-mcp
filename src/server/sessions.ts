// Session registry — protocol.md §1 (one connection = one session; replace per
// instanceId) and the tools.md `session?` convention (pick by sessionId or
// file name, else the most recently active).

import type { FileInfo, PageInfo, UserInfo } from "../shared/protocol.js";

export interface Selection {
  nodeIds: string[];
  count: number;
  at: number;
}

export interface SessionState {
  sessionId: string;
  instanceId: string;
  pluginVersion: string;
  /** What the plugin said it is running. Compared against ours in figma_status. */
  buildId?: string;
  apiVersion: string;
  editorType: string;
  ops: ReadonlySet<string>;
  file: FileInfo;
  page: PageInfo | null;
  user: UserInfo | null;
  connectedAt: number;
  /** Any frame from the plugin (heartbeat liveness). */
  lastSeenAt: number;
  /** Connect or a user-driven event — decides the default session. */
  lastActiveAt: number;
  selection: Selection | null;
  lastNodesChanged: { count: number; at: number } | null;
}

export class SessionRegistry<S extends { state: SessionState }> {
  private readonly sessions = new Map<string, S>();
  private readonly waiters = new Set<(s: S) => void>();

  /** Adds a session; returns the live session it replaces (same instanceId), if any. */
  add(session: S): S | undefined {
    let replaced: S | undefined;
    for (const s of this.sessions.values()) {
      if (s.state.instanceId === session.state.instanceId) replaced = s;
    }
    if (replaced) this.sessions.delete(replaced.state.sessionId);
    this.sessions.set(session.state.sessionId, session);
    for (const w of [...this.waiters]) w(session);
    return replaced;
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  list(): S[] {
    return [...this.sessions.values()];
  }

  get size(): number {
    return this.sessions.size;
  }

  /**
   * By sessionId, then by file name (case-insensitive), else the most recently
   * active. A Design file and its FigJam board often share a name, so among
   * name matches the ones `prefer` accepts (the bridge passes "this op runs in
   * its editor") win. Never with no `arg`: the active file is the one the user
   * is looking at, and the call is not silently rerouted to another file.
   */
  select(arg?: string, prefer?: (s: S) => boolean): S | undefined {
    if (arg) {
      const byId = this.sessions.get(arg);
      if (byId) return byId;
      const wanted = arg.toLowerCase();
      const byName = this.list().filter((s) => s.state.file.name?.toLowerCase() === wanted);
      const preferred = prefer ? byName.filter(prefer) : [];
      return mostRecent(preferred.length ? preferred : byName);
    }
    return mostRecent(this.list());
  }

  /** Resolves with the first session `select(arg, prefer)` returns within `ms`, else undefined. */
  waitFor(arg: string | undefined, ms: number, prefer?: (s: S) => boolean): Promise<S | undefined> {
    const now = this.select(arg, prefer);
    if (now || ms <= 0) return Promise.resolve(now);
    return new Promise((resolve) => {
      const done = (s: S | undefined) => {
        clearTimeout(timer);
        this.waiters.delete(onAdd);
        resolve(s);
      };
      const onAdd = () => {
        const s = this.select(arg, prefer);
        if (s) done(s);
      };
      const timer = setTimeout(() => done(undefined), ms);
      this.waiters.add(onAdd);
    });
  }
}

function mostRecent<S extends { state: SessionState }>(list: S[]): S | undefined {
  let best: S | undefined;
  for (const s of list) if (!best || s.state.lastActiveAt >= best.state.lastActiveAt) best = s;
  return best;
}
