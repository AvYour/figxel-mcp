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
import type { SkillLedger } from "../motion-process.js";
import { PROMPTS, registerPrompts } from "../prompts.js";
import { errorResult } from "../results.js";
import { CATALOG_TOPIC, GUIDE_TOPIC_NAMES, guideText, resolveTopic, SKILLS } from "../skills.js";
import { readAnnotations } from "./annotations.js";

/**
 * `ledger` hears which skill each answer and each prompt carried, once for
 * both gates: the keyframe tools wait until the motion or storyboard skill was
 * read (motion-process.ts), figma_set_brief until the role's (role-process.ts).
 */
export function registerGuide(server: McpServer, wanted: (op: string) => boolean, ledger?: Pick<SkillLedger, "note">): void {
  if (wanted("get_guide")) {
    server.registerTool(
      "figma_get_guide",
      {
        title: "How to work in Figma (skills)",
        description:
          "Read this before a design, motion or review task. Returns a skill — the playbook for one kind of work — as " +
          "Markdown. No arguments gives `workflow` (the designer's loop). State the role and the gear first: screens " +
          "and flows read `ux`, posters, ads, print and icons `graphic`, logos `brand`; a page or more also runs " +
          "`design`. A motion piece starts with " +
          "`storyboard`, keyframes with `motion`, and a review with `critique`. " +
          `\`topic\` names a skill (${SKILLS.map((s) => s.short).join(", ")}) ` +
          `or one of its sections (\`spec\` is the figma_create_from_spec grammar); \`section\` picks a section of that skill; ` +
          `"${CATALOG_TOPIC}" lists every skill with what it is for and its sections. Every answer ends with the exact ` +
          "calls for the skill's other sections and for the other skills. Works without the plugin. Under " +
          "BRIDGE_PROCESS=strict new work waits for its role skill and figma_set_brief, keyframes for the motion skill.",
        inputSchema: {
          topic: z.enum(GUIDE_TOPIC_NAMES).optional().describe(`A skill, one of its sections, or "${CATALOG_TOPIC}". Default "workflow".`),
          section: z.string().optional().describe("A section of the skill named by topic; every answer's footer lists them."),
        },
        annotations: readAnnotations("get_guide"),
      },
      async (args: { topic?: string; section?: string }) => {
        try {
          const resolved = resolveTopic(args.topic, args.section);
          const text = guideText(resolved);
          if (resolved.kind !== "catalog") {
            const asked = `topic: "${args.topic ?? "workflow"}"${args.section !== undefined ? `, section: "${args.section}"` : ""}`;
            ledger?.note(resolved.skill.short, `figma_get_guide { ${asked} }`);
          }
          return { content: [{ type: "text", text }] };
        } catch (e) {
          if (e instanceof BridgeError) return errorResult(e, { readOnly: true });
          throw e;
        }
      },
    );
  }

  // Prompts: the same skills as a starting message a user can pick from the
  // client's menu (Claude Desktop's attachment menu, Claude Code's slash list).
  registerPrompts(server, PROMPTS, (row) => ledger?.note(row.skill, `the prompt ${row.name}`));
}
