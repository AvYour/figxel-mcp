// meta group. Phase 0 implements figma_status only — answered by the bridge
// itself, so it works while no plugin is connected (ADR #24).

import { checkBuild, checkSkillsBuild, PLUGIN_BUILD_ID, type BuildCheck, type SkillsCheck } from "../plugin-build.js";
import { SKILLS, SKILLS_BUNDLED, SKILLS_VERSION } from "../skills.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EDITOR_LABEL, isEditor, refusedTools, unverifiedTools } from "../../shared/editors.js";
import { ErrorCode } from "../../shared/errors.js";
import { OPS, opName, toolsetLabel } from "../../shared/ops.js";
import { tokenFingerprint } from "../../shared/token.js";
import { PLUGIN_MENU_PATH, PLUGIN_NAME, PRODUCT_NAME, VERSION } from "../../shared/version.js";
import { RENDER_STUCK_HINT } from "../../shared/video.js";
import { authFailureIsCurrent, NO_SESSION_HINT, peerRefusedMessage, tokenHint, type Bridge } from "../bridge.js";
import type { Config } from "../config.js";
import type { checkMediaTools } from "../ffmpeg.js";
import type { MotionProcess } from "../motion-process.js";
import { okResult } from "../results.js";

export interface StatusContext {
  bridge: Bridge;
  config: Config;
  startedAt: number;
  /** Tools the toolset selects, and those actually registered (implemented). */
  selectedTools: string[];
  registeredTools: string[];
  /** The skills this process serves. Default: src/server/skills.ts; a test passes its own, with `onDisk` for dist/. */
  skills?: { version: string; count: number; bundled: boolean; onDisk?: string | null };
  /** Whether ffmpeg and ffprobe run (ffmpeg.ts); omitted, the status leaves `video` out. */
  media?: () => ReturnType<typeof checkMediaTools>;
  /** The motion process this process's tools share (motion-process.ts). */
  process?: MotionProcess;
}

/** A session's build check, with a client restart added when this process's skills lag dist/ and nothing else is asked. */
function withSkills(build: BuildCheck, skills: SkillsCheck): BuildCheck {
  return build.restart || !skills.restart ? build : { ...build, restart: skills.restart };
}

export async function buildStatus(ctx: StatusContext): Promise<Record<string, unknown>> {
  const [st, media] = await Promise.all([ctx.bridge.statusAsync(), ctx.media ? ctx.media().catch(() => undefined) : Promise.resolve(undefined)]);
  const active = st.sessions.find((s) => s.active) ?? null;
  // This process's token file and fingerprint: the one the agent's server reads.
  const own = { tokenPath: st.tokenPath ?? ctx.config.tokenPath, fingerprint: st.tokenFingerprint ?? tokenFingerprint(null) };
  // A plugin refused for its token is the problem only until a session connects after it.
  const pluginAuthCurrent = authFailureIsCurrent(st.lastAuthFailureAt, st.sessions.map((s) => s.connectedAt));
  const peerRefusal = st.peerRefusal ?? null;

  let hint: string;
  if (st.role === "none" && st.reason === ErrorCode.PORT_IN_USE && peerRefusal) {
    // Not the plugin's token: the port is held by another server, with another token file.
    const { message, hint: fix } = peerRefusedMessage(peerRefusal, own, ctx.config.port);
    hint = `${message} ${fix}`;
  } else if (st.role === "none" && st.reason === ErrorCode.PORT_IN_USE) {
    hint = `Port ${ctx.config.port} is held by a process that is not a compatible ${PRODUCT_NAME} server (another program, or an older ${PRODUCT_NAME} version). Close it; this bridge takes over automatically within ≤ 5 s.`;
  } else if (st.role === "none") {
    hint = `The bridge is between roles (${st.reason ?? "starting"}); it retries within seconds.`;
  } else if (!active) {
    hint = pluginAuthCurrent ? tokenHint(own) : NO_SESSION_HINT;
  } else {
    hint = `Connected to "${active.file.name ?? "untitled"}"${active.page ? ` (page "${active.page.name}")` : ""}.`;
  }
  if (st.role === "proxy") {
    hint += ` This process shares the Figma connection held by ${PRODUCT_NAME} process ${st.hubPid}, so several AI apps can use Figma at once.`;
  }
  // Figma's exporter looks stuck in a window: say so before the agent renders again [C-318].
  const stuck = st.sessions.filter((s) => (s.videoExport?.timeoutsInARow ?? 0) >= 2);
  if (stuck.length) {
    hint += ` Video export: ${stuck.map((s) => `${s.videoExport!.timeoutsInARow} renders in a row timed out in "${s.file.name ?? "untitled"}"`).join("; ")}, so Figma's video exporter is likely stuck. ${RENDER_STUCK_HINT}`;
  }
  // The build to compare is the one holding the Figma connection — the hub —
  // because that process gates and forwards every call. A proxy that is itself
  // current says nothing about the hub it joined. A hub that sends no build
  // predates the field, so it is older than the installed build by construction.
  //
  // The hints speak to someone who installed the package, not to a developer
  // with a checkout: the server refreshes the plugin copy in its home folder
  // when it starts, so a stale plugin needs only a re-run, and a stale server
  // a restart of the MCP client that started it.
  const serverBuild = st.serverBuild === undefined ? PLUGIN_BUILD_ID : (st.serverBuild ?? "unknown");
  const build = active ? checkBuild(active.buildId, serverBuild) : null;
  if (build?.restart === "plugin") {
    hint += ` The plugin is running a different build than this server: ask the user to close the ${PLUGIN_NAME} plugin window and run it again (${PLUGIN_MENU_PATH}).`;
  } else if (build?.restart === "client" && st.role === "proxy") {
    hint += ` The ${PRODUCT_NAME} process holding the Figma connection (pid ${st.hubPid}) is older than the installed version: ask the user to restart the MCP client that started it. Re-running the plugin would change nothing.`;
  } else if (build?.restart === "client") {
    hint += " This MCP server is older than the installed version (updated since it started): ask the user to restart the MCP client. Re-running the plugin would change nothing.";
  }
  // The skills are served by THIS process, whichever holds the Figma
  // connection: figma_get_guide is answered here, so its text lags when this
  // bundle does, and a proxy's lag is not the hub's.
  const served = ctx.skills ?? { version: SKILLS_VERSION, count: SKILLS.length, bundled: SKILLS_BUNDLED };
  const skills = checkSkillsBuild(served.version, served.bundled, served.onDisk);
  const askedThisClient = build?.restart === "client" && st.role !== "proxy";
  if (skills.restart && !askedThisClient) {
    hint += " This MCP server's skills are older than the installed version (updated since it started): ask the user to restart the MCP client to load them. Re-running the plugin would change nothing.";
  }

  // The hub gates with its own flag OR this process's (bridge.ts dispatch), so that is what decides here too.
  const allowUnverified = ctx.config.allowUnverified || st.allowUnverified === true;
  const registered = new Set(ctx.registeredTools);
  const gated = ctx.registeredTools.filter((t) => !OPS.get(opName(t))?.bridgeOnly);
  const editorOf = (editorType: string) => (isEditor(editorType) ? EDITOR_LABEL[editorType] : `unsupported (editorType "${editorType}")`);
  if (new Set(st.sessions.map((s) => s.editorType)).size > 1) {
    hint +=
      ` Connected files: ${st.sessions.map((s) => `"${s.file.name ?? "untitled"}" (${editorOf(s.editorType)}, ${s.sessionId})`).join(", ")}.` +
      " Each editor runs different tools (sessions[].unavailableTools); pass `session` to pick the file.";
  }

  return {
    bridge: {
      version: VERSION,
      role: st.role,
      listening: st.listening,
      reason: st.reason,
      host: st.host,
      port: st.port,
      hubPid: st.hubPid,
      sharedWith: st.role === "hub" ? st.peers : undefined,
      uptimeSec: Math.round((Date.now() - ctx.startedAt) / 1000),
      toolset: toolsetLabel(ctx.config.toolset),
      toolsSelected: ctx.selectedTools.length,
      toolsRegistered: ctx.registeredTools,
      evalEnabled: ctx.config.allowEval,
      // BRIDGE_ALLOW_UNVERIFIED as this process's calls see it: writes not yet
      // verified in a file's editor run instead of being refused.
      allowUnverified,
      sessionWaitMs: ctx.config.sessionWaitMs,
    },
    // What figma_get_guide, the prompts and the skill:// resources serve here.
    skills: { version: skills.version, count: served.count, dist: skills.dist, ...(skills.restart ? { restart: skills.restart } : {}) },
    // The fingerprint is the token's first and last four characters: the plugin window shows its own,
    // so a person can tell whether the plugin and this server use the same token. Never the token.
    token: { tokenPresent: true, tokenPath: own.tokenPath, fingerprint: own.fingerprint },
    // Refused tokens, kept apart: a plugin's (its token differs from this server's), and a server's
    // (two servers with different token files: the one holding the port refused this one, or refused another).
    auth: {
      plugin: st.lastAuthFailureAt ? { lastFailureAt: new Date(st.lastAuthFailureAt).toISOString(), current: pluginAuthCurrent } : null,
      server: peerRefusal
        ? {
            refusedAt: new Date(peerRefusal.at).toISOString(),
            hubPid: peerRefusal.hubPid,
            hubTokenPath: peerRefusal.hubTokenPath,
            hubFingerprint: peerRefusal.hubFingerprint,
          }
        : null,
      ...(st.lastPeerAuthFailure ? { refusedServer: { at: new Date(st.lastPeerAuthFailure.at).toISOString(), pid: st.lastPeerAuthFailure.pid } } : {}),
    },
    ...(media
      ? {
          video: {
            ffmpeg: media.ffmpeg,
            ffprobe: media.ffprobe,
            maxWaitS: ctx.config.videoMaxWaitS,
            ...(media.note ? { note: media.note } : {}),
          },
        }
      : {}),
    // BRIDGE_PROCESS, and whether this client has read the motion skill the keyframe tools wait for.
    ...(ctx.process ? { process: { mode: ctx.process.mode, motionSkillRead: ctx.process.skillRead !== null } } : {}),
    activeSession: active?.sessionId ?? null,
    sessions: st.sessions.map((s) => ({
      sessionId: s.sessionId,
      active: s.active,
      file: s.file,
      page: s.page,
      user: s.user,
      pluginVersion: s.pluginVersion,
      apiVersion: s.apiVersion,
      editorType: s.editorType,
      // What this file's editor runs [C-129]: the registered tools the bridge
      // refuses here (a "no" cell, or a write not verified in this editor yet),
      // and how many registered tools are still unverified here (reads among
      // them run). An editor the plugin does not support refuses everything.
      editor: editorOf(s.editorType),
      unavailableTools: isEditor(s.editorType) ? refusedTools(s.editorType, allowUnverified).filter((t) => registered.has(t)) : gated,
      unverifiedTools: isEditor(s.editorType) ? unverifiedTools(s.editorType).filter((t) => registered.has(t)).length : 0,
      opsAdvertised: s.ops.length,
      // Is the connected plugin running the code in dist/ right now?
      //
      // A plugin keeps the bundle it was STARTED with, so rebuilding dist/ while
      // its window stays open changes nothing, and `pluginVersion` is a constant
      // — it reported "0.1.0" for both, which made a stale plugin indistinguishable
      // from a current one. The answer arrived only by calling a tool and finding
      // it missing, or by reading a layout and noticing the numbers were old.
      //
      // Now it is answerable before anything is called — against dist/ as it
      // is on disk NOW, not the id this server was started with [C-084]:
      // `restart: "plugin"` = close the plugin window and run it again;
      // `restart: "client"` = the server holding the connection is older than
      // dist/, restart the MCP client that started it (re-running the plugin
      // would change nothing). `matches: null` means the plugin predates build
      // ids — "unknown", not a guess.
      build: withSkills(checkBuild(s.buildId, serverBuild), skills),
      selection: s.selection ? { count: s.selection.count, nodeIds: s.selection.nodeIds.slice(0, 20) } : null,
      // Figma's render timeouts in a row here (2 or more: the exporter is likely stuck [C-318]) and the render holding the plugin.
      ...(s.videoExport ? { videoExport: s.videoExport } : {}),
      connectedAt: new Date(s.connectedAt).toISOString(),
      lastSeenAt: new Date(s.lastSeenAt).toISOString(),
    })),
    lastAuthFailureAt: st.lastAuthFailureAt ? new Date(st.lastAuthFailureAt).toISOString() : null,
    hint,
  };
}

export function registerStatus(server: McpServer, ctx: StatusContext): void {
  server.registerTool(
    "figma_status",
    {
      title: "Figma bridge status",
      description:
        "Bridge and plugin connection status: whether this process holds the Figma connection or shares it, every " +
        "connected Figma file (session id, file, page, user, plugin version), each file's editor (Figma Design, FigJam " +
        "or Figma Slides) with the tools that do not run there (`unavailableTools`), the active session, the version " +
        "of the skills figma_get_guide serves (`skills`), the motion process mode and whether the motion skill was read " +
        "(`process`), this server's token file and fingerprint (the plugin window shows its own) with refused tokens " +
        "(`auth`), video export state (`videoExport`, `video`: ffmpeg), and a hint for what to do next. Answered by the " +
        "bridge itself — works even when no plugin is connected. Call this first, " +
        "and whenever another figma_ tool returns NO_SESSION, PORT_IN_USE, or UNSUPPORTED naming an editor.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => okResult(await buildStatus(ctx)),
  );
}
