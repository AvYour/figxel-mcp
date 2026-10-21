// A Figma file as the role process's tests see it through a fake bridge: the
// briefs, sign-offs and fingerprints the plugin's brief ops would answer
// (src/plugin/ops/brief.ts, contract § Plugin ops), the facts get_brief
// { target } gives, and every op the server sends, in order. The tools run
// as the server registers them (registerTools), behind a real MCP client.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MotionSnapshot } from "../src/shared/motion-curves.js";
import { BridgeError, ErrorCode } from "../src/shared/errors.js";
import type { BriefIndexEntry, BriefRecord, SignOffRecord } from "../src/shared/roles.js";
import type { Bridge } from "../src/server/bridge.js";
import { loadConfig, type ProcessMode } from "../src/server/config.js";
import { MotionProcess, SkillLedger } from "../src/server/motion-process.js";
import { registerSkillResources } from "../src/server/resources.js";
import { RoleProcess, type TargetFacts } from "../src/server/role-process.js";
import { registerTools } from "../src/server/tools/index.js";
import { quietLogger } from "./helpers.js";

/** Every role skill, as the build serves them once wave B lands: messages are then the spec's exactly. */
export const ALL_SKILLS: ReadonlySet<string> = new Set([
  "workflow", "design", "storyboard", "motion", "critique", "design-system", "design-to-code", "code-to-design",
  "prototype", "figjam", "slides", "ux", "graphic", "brand",
]);

export type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };

export interface SessionRow {
  sessionId: string;
  active: boolean;
  editorType: string;
  file: { name: string; key: string | null };
  page: { id: string; name: string } | null;
  selection: { nodeIds: string[]; count: number; at: number } | null;
  lastNodesChanged?: { count: number; at: number } | null;
}

/** A brief record with the always lines; `over` replaces any field. */
export function brief(over: Partial<BriefRecord> & { id: string }): BriefRecord {
  return {
    v: 1,
    role: "ux",
    gear: "page",
    title: "Bench booking page",
    status: "open",
    createdAt: "2026-10-14T12:00:00.000Z",
    updatedAt: "2026-10-14T12:00:00.000Z",
    lines: { goal: "members book a bench slot online", message: "You fix your own bike here, with a mechanic beside you.", success: ["a visitor books within one scroll at 390 x 844"] },
    details: {},
    deliverables: [],
    ...over,
  };
}

/** A sign-off record of `nodeId` against `briefId`. */
export function signOffOf(briefId: string, over: Partial<SignOffRecord> = {}): SignOffRecord {
  return {
    v: 1,
    briefId,
    role: "ux",
    gear: "page",
    at: "2026-10-14T13:05:42.123Z",
    ok: true,
    fingerprint: "8f3a01c2",
    checks: [],
    lenses: [],
    rounds: 1,
    answers: [],
    exceptions: [],
    placeholders: [],
    build: {},
    ...over,
  };
}

export class RoleWorld {
  sent: Array<{ op: string; params: Record<string, unknown>; session?: string }> = [];
  sessions: SessionRow[] = [
    { sessionId: "s-1", active: true, editorType: "figma", file: { name: "Co-op", key: null }, page: { id: "0:1", name: "Page 1" }, selection: null, lastNodesChanged: null },
  ];
  /** Briefs by the id of the node they are stored on. */
  briefs = new Map<string, BriefRecord>();
  /** Which brief a node belongs to, beyond its own record and the deliverables lists (a frame inside the work, a page). */
  covers = new Map<string, string>();
  /** Briefs stored on a page: a node only `covers` gives one of these is found `from: "page"`. */
  pageBriefs = new Set<string>();
  /** Sign-offs by deliverable. */
  signOffs = new Map<string, SignOffRecord>();
  /** Each node's fingerprint now. */
  prints = new Map<string, string>();
  /** get_brief { target } by parentId (or pageId); "" for no parent. */
  targets = new Map<string, TargetFacts>();
  names = new Map<string, string>([["12:345", "Bench booking / 01 Slots"]]);
  /** A plugin built before briefs: the bridge says it does not implement get_brief. */
  oldPlugin = false;
  /** Any other failure of a get_brief read. */
  briefReadError: BridgeError | null = null;
  /** What sign_off answers; default: ok when no server blocker, every audit clean. */
  signOffAnswer: ((params: Record<string, unknown>) => Record<string, unknown>) | null = null;
  snapshot: MotionSnapshot | null = null;
  plans = new Map<string, unknown>();
  private nextId = 40;

  ops(): string[] {
    return this.sent.map((s) => s.op);
  }

  /** The open briefs of the file's index, newest first. */
  open(): BriefIndexEntry[] {
    return [...this.briefs.values()]
      .filter((b) => b.status === "open")
      .reverse()
      .map((b) => ({ id: b.id, title: b.title, role: b.role, gear: b.gear, pageId: "0:1", status: b.status, deliverables: b.deliverables, updatedAt: b.updatedAt }));
  }

  briefOf(nodeId: string): BriefRecord | undefined {
    return this.briefs.get(nodeId) ?? [...this.briefs.values()].find((b) => b.deliverables.includes(nodeId)) ?? this.briefs.get(this.covers.get(nodeId) ?? "");
  }

  bridge(): Bridge {
    return {
      request: async (op: string, params: Record<string, unknown>, opts: { session?: string } = {}) => {
        this.sent.push({ op, params, ...(opts.session !== undefined ? { session: opts.session } : {}) });
        switch (op) {
          case "get_brief":
            return this.getBrief(params);
          case "set_brief":
            return this.setBrief(params);
          case "sign_off":
            return this.signOff(params);
          case "get_nodes_info":
            return {
              items: (params.nodeIds as string[]).map((id) => (this.names.has(id) ? { id, ok: true, node: { id, name: this.names.get(id) } } : { id, ok: false, error: "not found on the reachable pages" })),
            };
          case "check_motion":
            if (!this.snapshot) throw new BridgeError(ErrorCode.INVALID_PARAM, "Not an animated frame.");
            return { ...this.snapshot, plan: this.plans.get(this.snapshot.root.id) ?? null };
          case "get_motion_context":
            return { scope: { from: "node", ids: [params.nodeId], recursive: false, topLevelFrameIds: [params.nodeId] }, count: 0, nodes: [], motionPlans: [{ frameId: params.nodeId, name: "Hero", plan: this.plans.get(String(params.nodeId)) ?? null }] };
          case "export_node":
            return { nodeId: params.nodeId ?? "12:345", name: "Slots", format: "PNG", mime: "image/png", bytes: 4, base64: "iVBORw==" };
          case "export_frames_to_pdf":
            return { pages: [], failed: [{ nodeId: "12:345", error: "fake" }] };
          case "batch":
            return { steps: [], completed: (params.steps as unknown[]).length };
          default:
            // Every create and edit: one new node.
            return { id: `5:${this.nextId++}`, name: String(params.name ?? op) };
        }
      },
      statusAsync: async () => ({ sessions: this.sessions, allowUnverified: false }),
      status: () => ({ sessions: this.sessions }),
    } as unknown as Bridge;
  }

  private getBrief(params: Record<string, unknown>): Record<string, unknown> {
    if (this.oldPlugin) {
      throw new BridgeError(ErrorCode.UNSUPPORTED, 'The connected plugin does not implement op "get_brief".', { hint: "The connected plugin is older than this server." });
    }
    if (this.briefReadError) throw this.briefReadError;
    const out: Record<string, unknown> = { open: this.open() };
    if (typeof params.briefId === "string") {
      const b = this.briefs.get(params.briefId);
      if (b) out.brief = b;
      else out.invalid = `no brief is stored on ${params.briefId}`;
    }
    if (typeof params.nodeId === "string") {
      const b = this.briefOf(params.nodeId);
      if (b && params.briefId === undefined) {
        out.brief = b;
        const own = this.briefs.get(params.nodeId) === b || b.deliverables.includes(params.nodeId);
        out.from = !own && this.pageBriefs.has(b.id) ? "page" : "node";
      }
      const s = this.signOffs.get(params.nodeId);
      if (s) out.signOff = s;
      if (params.fingerprint === true) {
        const print = this.prints.get(params.nodeId) ?? "00000000";
        out.fingerprint = print;
        if (s) out.fresh = s.fingerprint === print;
      }
    }
    if (params.target !== undefined) {
      const t = params.target as { parentId?: string; pageId?: string };
      out.target = this.targets.get(t.parentId ?? t.pageId ?? "") ?? { type: "PAGE", topLevel: true, childCount: 0 };
    }
    return out;
  }

  private setBrief(params: Record<string, unknown>): Record<string, unknown> {
    const p = (params.brief ?? {}) as Record<string, unknown>;
    const id = (params.briefId as string | undefined) ?? (params.nodeId as string | undefined) ?? "12:40";
    const old = this.briefs.get(id);
    const record: BriefRecord = {
      ...(old ?? brief({ id, role: p.role as BriefRecord["role"], gear: p.gear as BriefRecord["gear"], title: String(p.title) })),
      ...(Object.fromEntries(Object.entries(p).filter(([k]) => k !== "lines" && k !== "details" && k !== "deliverables")) as Partial<BriefRecord>),
      id,
      lines: { ...(old?.lines ?? { goal: "", message: "", success: [] }), ...((p.lines ?? {}) as object) } as BriefRecord["lines"],
      details: { ...(old?.details ?? {}), ...((p.details ?? {}) as object) },
      deliverables: [...new Set([...(old?.deliverables ?? []), ...((p.deliverables as string[] | undefined) ?? [])])],
      status: params.reopen === true ? "open" : (old?.status ?? "open"),
    };
    this.briefs.set(id, record);
    return { briefId: id, blockId: id, stored: "block", status: record.status, indexOn: "root", record };
  }

  private signOff(params: Record<string, unknown>): Record<string, unknown> {
    if (this.signOffAnswer) return this.signOffAnswer(params);
    const blockers = params.serverBlockers as string[];
    const ok = blockers.length === 0;
    const at = "2026-10-16T10:00:00.000Z";
    const b = this.briefs.get(String(params.briefId))!;
    for (const id of params.nodeIds as string[]) this.signOffs.set(id, signOffOf(b.id, { ok, at, fingerprint: this.prints.get(id) ?? "00000000" }));
    if (ok) this.briefs.set(b.id, { ...b, status: "signed", lastSignOff: { at, ok } });
    return {
      ok,
      checks: (params.audits as string[]).map((name) => ({ name, ok: true, errors: 0, warnings: 0, infos: 0, unanswered: 0 })),
      issues: [],
      unanswered: [],
      fingerprints: Object.fromEntries((params.nodeIds as string[]).map((id) => [id, this.prints.get(id) ?? "00000000"])),
      signedAt: at,
      briefStatus: ok ? "signed" : "open",
      indexOn: "root",
    };
  }
}

export interface Served {
  client: Client;
  motion: MotionProcess;
  roles: RoleProcess;
  ledger: SkillLedger;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** The JSON a result carries, from its first text block. */
  data(r: ToolResult): Record<string, unknown>;
  close(): Promise<void>;
}

/** The server's tools over `world`, in `mode`, with the skills `bundled` (default: every role's). */
export async function serve(mode: ProcessMode, world: RoleWorld, opts: { bundled?: ReadonlySet<string>; env?: Record<string, string> } = {}): Promise<Served> {
  const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-roles-")), BRIDGE_PORT: "0", BRIDGE_PROCESS: mode, ...opts.env });
  const ledger = new SkillLedger();
  const motion = new MotionProcess(config.processMode, ledger);
  const roles = new RoleProcess(config.processMode, ledger, opts.bundled ?? ALL_SKILLS);
  const server = new McpServer({ name: "roles", version: "0" }, { capabilities: { prompts: {}, resources: {} } });
  registerTools(server, world.bridge(), config, Date.now(), quietLogger, motion, roles);
  registerSkillResources(server, (skill, uri) => ledger.note(skill.short, uri));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "roles-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    motion,
    roles,
    ledger,
    call: async (name, args) => (await client.callTool({ name, arguments: args })) as ToolResult,
    data: (r) => JSON.parse(r.content[0]!.text!) as Record<string, unknown>,
    close: () => client.close(),
  };
}

/** A brief that passes every line of the ux page gear (spec §2.4), for figma_set_brief. */
export const UX_PAGE = {
  role: "ux",
  gear: "page",
  title: "Bench booking page",
  goal: "members book a bench slot online",
  audience: "neighbours on a phone, next to a broken bike",
  message: "You fix your own bike here, with a mechanic beside you.",
  proof: ["six repair stands", "45-minute slots for 8 GBP"],
  constraints: ["390 px first, 1440 px second"],
  givens: "the co-op's logo and green; no other styles",
  success: ["a visitor books within one scroll at 390 x 844", "every text 16 px or more on the phone"],
  tone: { words: ["hands-on", "plain", "welcoming"], not: "cute" },
  format: "390x844 px phone, 1440x900 px desktop",
  details: { platform: "responsive", viewport: ["390x844", "1440x900"], task: "book a 45-minute bench slot", screens: [{ name: "Slots", states: ["empty", "loading", "error"] }] },
};
