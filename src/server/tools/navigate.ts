// The meta group's plugin-backed tools (tools.md § meta): select, navigate to
// a page, zoom to nodes. They move what the user sees — not the document — so
// they are read-only for MCP purposes and carry no idempotencyKey.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import { readAnnotations } from "./annotations.js";
import { forwardTool, type Extra } from "./forward.js";
import { fitDescription } from "./params.js";

const SESSION = {
  session: z
    .string()
    .optional()
    .describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
};

const TARGETS = {
  nodeId: z.string().optional().describe("One node."),
  nodeIds: z.array(z.string()).max(500).optional().describe("Or several nodes (all on one page)."),
};

export function registerNavigate(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean): void {
  const tool = (op: string, title: string, description: string, shape: z.ZodRawShape) => {
    if (!wanted(op)) return;
    server.registerTool(
      `figma_${op}`,
      { title, description: fitDescription(description), inputSchema: { ...shape, ...SESSION }, annotations: readAnnotations(op) },
      async (args: Record<string, unknown>, extra: Extra) =>
        forwardTool(bridge, op, args, extra, { session: args.session as string | undefined }),
    );
  };

  tool(
    "select",
    "Select nodes",
    "Select nodes on the canvas so the user sees exactly what you mean or are about to change. `mode`: replace " +
      "(default), add, toggle. Nodes on another page switch the editor to that page first. Changes no design data.",
    { ...TARGETS, mode: z.enum(["replace", "add", "toggle"]).optional() },
  );

  tool(
    "navigate_page",
    "Go to page",
    "Switch the editor to another page, by id or exact name. figma_get_pages lists them. Changes no design data.",
    {
      pageId: z.string().optional(),
      pageName: z.string().optional(),
    },
  );

  tool(
    "zoom_to",
    "Zoom to nodes",
    'Scroll and zoom the viewport to show nodes — after building something, so the user sees it. `zoom`: "fit" ' +
      '(default) or a number as a string ("1" = 100%). Switches page if needed. In Figma Slides the nodes\' slide (a ' +
      'slide given, else the one holding the first node) becomes the focused slide, and `view` switches between ' +
      '"grid" (every slide) and "single-slide" (the focused one); `view` alone needs no nodes. The result says which ' +
      "slide is focused and the view, or why the view did not change. Changes no design data.",
    {
      ...TARGETS,
      zoom: z.string().optional().describe('"fit" or a zoom level like "1.5".'),
      view: z.enum(["grid", "single-slide"]).optional().describe("Figma Slides only: the grid of all slides, or one slide."),
    },
  );
}
