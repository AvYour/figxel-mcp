// The MCP resource group (spec §12 Phase 4, protocol.md §9).
//
// The selection, `figxel://session/<id>/selection`; and the skills, as
// `skill://figxel-<short>/SKILL.md` and their references (registerSkillResources).
// The selection's scheme is the server's own name, not `figma://`: that is
// Figma's deep-link scheme [C-016], and a URI here must not look like one.
//
// WHY A RESOURCE AND NOT ANOTHER TOOL
//
// A resource is state a client can read on its own schedule; a tool is an action
// the model must decide to take. The plugin already pushes `selection_changed`
// events, and the bridge already stores them — so the selection is known here
// without asking Figma anything. Exposing that as a tool would mean the agent has
// to spend a call to discover what the user is pointing at, and a client that
// supports resource refresh (Claude Desktop does) can subscribe to the change
// instead of polling for it.
//
// The resource is deliberately read-only and cheap: it returns the last event the
// plugin sent, and when none has arrived since the plugin connected it says so
// rather than inventing an empty selection. "I have not heard anything" and
// "nothing is selected" are different answers, and only one of them is a fact.

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode as McpErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { PLUGIN_MENU_PATH, PRODUCT_NAME, SERVER_NAME } from "../shared/version.js";
import type { Bridge, BridgeStatus } from "./bridge.js";
import { SKILL_PREFIX, SKILLS } from "./skills.js";

/** The selection resource's URI scheme. */
export const SELECTION_SCHEME = SERVER_NAME;
/** The resource URI, which is also how a client asks for a specific session. */
const URI_TEMPLATE = `${SELECTION_SCHEME}://session/{sessionId}/selection`;
/** The URI of one session's selection. */
export const selectionUri = (sessionId: string) => `${SELECTION_SCHEME}://session/${encodeURIComponent(sessionId)}/selection`;

interface SelectionPayload {
  sessionId: string;
  file: string | null;
  page: { id: string; name: string } | null;
  /** null means "no selection event has been received", [] means "nothing selected". */
  selection: unknown;
  user: { id: string | null; name: string } | null;
}

export function registerResources(server: McpServer, bridge: Bridge): void {
  server.registerResource(
    "figma-selection",
    // A ResourceTemplate, NOT the string. The SDK overloads on the type: a
    // string is registered as a single static resource with that literal URI,
    // so `figxel://session/{sessionId}/selection` would only ever match a read
    // that used the braces literally. Passing the template is what makes the
    // variable match a real id.
    //
    // `list` is what makes the resource FINDABLE. With `list: undefined` the
    // template is still readable by anyone who guesses the URI, but a client
    // that enumerates resources (Claude Desktop does) sees nothing at all — so
    // one concrete URI per connected session is listed, which is also how a
    // client learns the session ids without calling a tool first.
    new ResourceTemplate(URI_TEMPLATE, {
      list: async () => {
        const status = await bridge.statusAsync();
        return {
          resources: status.sessions.map((s) => ({
            uri: selectionUri(s.sessionId),
            name: `Selection in ${s.file?.name ?? "untitled"} (${s.sessionId})`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      title: "Selection of a connected Figma session",
      description:
        "What the user currently has selected in Figma, as last reported by the plugin. Reading this costs no Figma " +
        "work: the plugin pushes selection changes and the bridge keeps the latest one. `selection: null` means no " +
        "event has arrived yet (the plugin may have just connected), while an empty list in `nodes` means the user " +
        "really has nothing selected. Pair with `figma_get_selection` when you need the selection read fresh.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const wanted = typeof variables.sessionId === "string" ? variables.sessionId : undefined;
      // statusAsync() rather than a private registry: when this process is a
      // proxy, the sessions belong to the hub, and statusAsync() already knows
      // how to ask it. Using the local registry here would make the resource
      // report "no plugin connected" in exactly the setup the project documents.
      const status = await bridge.statusAsync();
      const sessions = status.sessions;
      // A session may be addressed by id or by file name, matching every tool's
      // `session` parameter — an agent that learned the name from figma_status
      // should not have to discover the id as well.
      //
      // There is deliberately NO fallback to "the only session" when the name
      // does not match: returning one session's selection because another was
      // asked for is a wrong answer that looks like a right one. The template
      // always supplies a sessionId, so the fallback would only ever fire on a
      // typo — exactly when a silent redirect is least acceptable.
      const session =
        sessions.find((s) => s.sessionId === wanted) ??
        sessions.find((s) => (s.file?.name ?? "untitled").toLowerCase() === (wanted ?? "").toLowerCase());

      if (!session) {
        // A resource that returns a made-up answer for an unknown session is
        // worse than one that says it does not know which session is meant.
        //
        // The empty case is checked FIRST and reports the real cause. When no
        // plugin is connected, replying "no session with that id" is technically
        // true and useless: it points at the id, and the fix is to open the
        // plugin. Measured against the probe, which hit exactly this and made it
        // say "no figma plugin is connected" instead.
        const known = sessions.map((s) => s.sessionId).join(", ") || "none";
        const message =
          sessions.length === 0
            ? `No Figma plugin is connected. Open it in Figma: ${PLUGIN_MENU_PATH}.`
            : wanted
              ? `No connected session with id or file name \`${wanted}\`.`
              : "More than one file is connected, so a sessionId is required.";
        const payload = { error: "NO_SUCH_SESSION", message, sessions: known };
        return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
      }

      const payload: SelectionPayload = {
        sessionId: session.sessionId,
        file: session.file?.name ?? null,
        page: session.page ? { id: session.page.id, name: session.page.name } : null,
        // null and [] mean different things and both are reported as they are:
        // "no event has arrived yet" is not the same fact as "nothing selected".
        selection: session.selection ?? null,
        user: session.user ? { id: session.user.id, name: session.user.name } : null,
      };
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );
}

// ── the skills ───────────────────────────────────────────────────────────────
//
// The SEP-2640 layout [C-172]: skill://<skill name>/<file>, whose last skill
// path segment is the skill's `name`. A client without the skills extension
// sees ordinary resources [C-172]; when the SDK speaks it, skills/list can
// serve these same URIs and bytes. Resources are application-driven [C-169]:
// the host offers them, so they are marked for the assistant, and the content
// is the raw file, frontmatter included, so a future manifest digest matches.

const SKILL_MIME = "text/markdown";
const FOR_ASSISTANT = { audience: ["assistant" as const] };

/** One static resource per SKILL.md; one template whose list names every reference. */
export function registerSkillResources(server: McpServer): void {
  for (const skill of SKILLS) {
    server.registerResource(
      skill.name,
      `skill://${skill.name}/SKILL.md`,
      { title: `${skill.short} (${PRODUCT_NAME} skill)`, description: skill.description, mimeType: SKILL_MIME, size: skill.file.size, annotations: FOR_ASSISTANT },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: SKILL_MIME, text: skill.file.text }] }),
    );
  }
  const references = SKILLS.flatMap((skill) => skill.sections.map((section) => ({ skill, section })));
  server.registerResource(
    `${SKILL_PREFIX}skill-references`,
    // A template, for the same reason as the selection: a string would be one
    // static URI with literal braces.
    new ResourceTemplate("skill://{skill}/references/{section}.md", {
      list: async () => ({
        resources: references.map(({ skill, section }) => ({
          uri: `skill://${skill.name}/references/${section.slug}.md`,
          name: `${skill.name}/references/${section.slug}.md`,
          mimeType: SKILL_MIME,
          size: section.file.size,
          annotations: FOR_ASSISTANT,
        })),
      }),
    }),
    {
      title: `A section of a ${PRODUCT_NAME} skill`,
      description: "One section of a skill, as Markdown. The skill's SKILL.md names its sections; figma_get_guide serves the same text.",
      mimeType: SKILL_MIME,
    },
    async (uri, variables) => {
      const found = references.find(({ skill, section }) => skill.name === String(variables.skill) && section.slug === String(variables.section));
      // The SDK's own answer for an unknown URI, so a miss reads the same either way.
      if (!found) throw new McpError(McpErrorCode.InvalidParams, `Resource ${uri.href} not found`);
      return { contents: [{ uri: uri.href, mimeType: SKILL_MIME, text: found.section.file.text }] };
    },
  );
}
