// What the server tells an agent before a create or a rotation reaches Figma:
// a size Figma refuses is refused here, `pageId` says what it does now that
// the plugin reads it, and a rotation's direction is Figma's own —
// `rotation` is atan2(-m10, m00) [C-098], so a positive angle turns the node
// counter-clockwise on screen, as create_line's "90 = up" and the motion
// guide already said.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { Bridge } from "../src/server/bridge.js";
import { registerCreate } from "../src/server/tools/create.js";
import { registerModify } from "../src/server/tools/modify.js";

const shapes = new Map<string, Record<string, z.ZodTypeAny>>();
const server = {
  registerTool(name: string, config: { inputSchema: Record<string, z.ZodTypeAny> }) {
    shapes.set(name, config.inputSchema);
  },
} as unknown as McpServer;
registerCreate(server, {} as Bridge, () => true);
registerModify(server, {} as Bridge, () => true);
const param = (tool: string, name: string) => shapes.get(tool)![name]!;

describe("create tools refuse a size Figma refuses", () => {
  it.each([
    ["figma_create_frame", "width"],
    ["figma_create_frame", "height"],
    ["figma_create_rectangle", "width"],
    ["figma_create_rectangle", "height"],
    ["figma_create_ellipse", "width"],
    ["figma_create_ellipse", "height"],
    ["figma_create_section", "width"],
    ["figma_create_section", "height"],
  ])("%s.%s: 0 is refused, a hairline is not", (tool, name) => {
    expect(param(tool, name).safeParse(0).success).toBe(false);
    expect(param(tool, name).safeParse(0.5).success).toBe(true);
  });
});

describe("parameter descriptions say what the plugin does", () => {
  it("figma_rotate_nodes: a positive angle turns counter-clockwise", () => {
    const angle = param("figma_rotate_nodes", "angle").description ?? "";
    expect(angle).toMatch(/counter-clockwise/);
    expect(angle).toMatch(/negative turns clockwise/);
  });

  it("figma_create_from_spec: pageId picks the page to build on", () => {
    const pageId = param("figma_create_from_spec", "pageId").description ?? "";
    expect(pageId).toMatch(/page to build on/);
    expect(pageId).not.toMatch(/symmetry/);
  });
});
