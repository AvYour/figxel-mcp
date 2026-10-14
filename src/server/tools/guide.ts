// figma_get_guide and the MCP prompts — how an agent learns to work in Figma.
//
// The counterpart of the official Figma MCP's skill-fetching tool: guidance that
// reaches the model through MCP itself, so it works in every client, including
// ones that never load files from this repository. Answered by the bridge alone
// (no plugin needed), like figma_status.
//
// The tool is the floor of the skills' five surfaces [C-237]: every skill and
// section is one call away, and every answer ends with the calls for the rest.
// Text only — a client that prefers structuredContent would drop the guide.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../../shared/errors.js";
import { registerPrompts } from "../prompts.js";
import { errorResult } from "../results.js";
import { CATALOG_TOPIC, GUIDE_TOPIC_NAMES, guideText, resolveTopic, SKILLS } from "../skills.js";
import { readAnnotations } from "./annotations.js";

export function registerGuide(server: McpServer, wanted: (op: string) => boolean): void {
  if (wanted("get_guide")) {
    server.registerTool(
      "figma_get_guide",
      {
        title: "How to work in Figma (skills)",
        description:
          "Read this before a design, motion or review task. Returns a skill — the playbook for one kind of work — as " +
          "Markdown. No arguments gives `workflow` (the designer's loop). State the gear first; a section runs the " +
          "`design` skill's section gear; a page or more runs the whole `design` skill. A motion piece starts with " +
          "`storyboard`, keyframes with `motion`, and a review with `critique`. " +
          `\`topic\` names a skill (${SKILLS.map((s) => s.short).join(", ")}) ` +
          `or one of its sections (\`spec\` is the figma_create_from_spec grammar); \`section\` picks a section of that skill; ` +
          `"${CATALOG_TOPIC}" lists every skill with what it is for and its sections. Every answer ends with the exact ` +
          "calls for the skill's other sections and for the other skills. Works without the plugin.",
        inputSchema: {
          topic: z.enum(GUIDE_TOPIC_NAMES).optional().describe(`A skill, one of its sections, or "${CATALOG_TOPIC}". Default "workflow".`),
          section: z.string().optional().describe("A section of the skill named by topic; every answer's footer lists them."),
        },
        annotations: readAnnotations("get_guide"),
      },
      async (args: { topic?: string; section?: string }) => {
        try {
          return { content: [{ type: "text", text: guideText(resolveTopic(args.topic, args.section)) }] };
        } catch (e) {
          if (e instanceof BridgeError) return errorResult(e, { readOnly: true });
          throw e;
        }
      },
    );
  }

  // Prompts: the same skills as a starting message a user can pick from the
  // client's menu (Claude Desktop's attachment menu, Claude Code's slash list).
  registerPrompts(server);
}
