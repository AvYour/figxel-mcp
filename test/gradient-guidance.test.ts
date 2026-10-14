// What a gradient entry promises the agent, checked against what the plugin
// does with it: an angular gradient takes a centre but no radius, and a paint
// style — which has no size — fits a linear angle to a square, so a diagonal
// drifts on any other shape. Text that says otherwise sends the agent into a
// refusal, or into a style that renders at the wrong angle with nothing said.

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { transformAngle, type Transform } from "../src/plugin/gradient.js";
import { toPaint, toPaintFor } from "../src/plugin/ops/style.js";
import type { Bridge } from "../src/server/bridge.js";
import { gradientEntry } from "../src/server/tools/params.js";
import { registerCreate } from "../src/server/tools/create.js";
import { registerStyle } from "../src/server/tools/style.js";
import { registerTokens } from "../src/server/tools/tokens.js";

const stops = [
  { position: 0, color: "#000000" },
  { position: 1, color: "#ffffff" },
];
const tools = new Map<string, { inputSchema: z.ZodRawShape; description: string }>();
registerStyle({ registerTool: (name: string, config: { inputSchema: z.ZodRawShape; description: string }) => tools.set(name, config) } as unknown as McpServer, {} as Bridge, () => true);

describe("an angular gradient takes `center`, never `radius`", () => {
  it("figma_set_fills says so, as the plugin enforces it", () => {
    const d = tools.get("figma_set_fills")!.description;
    expect(d).toMatch(/radial and diamond take `center` \/ `radius`, angular takes `center` only/);
    expect(d).not.toMatch(/the others take `center` \/ `radius`/);
    expect(() => toPaint({ gradient: { type: "angular", radius: 0.3, stops } }, 0)).toThrow(/radius` is for radial and diamond/);
    expect(() => toPaint({ gradient: { type: "angular", center: { x: 0.3, y: 0.3 }, stops } }, 0)).not.toThrow();
  });

  it("a radius on a linear gradient names radial and diamond only; a centre names all three", () => {
    expect(() => toPaint({ gradient: { type: "linear", radius: 0.3, stops } }, 0)).toThrow(/`fills\[0\]\.gradient\.radius` is for radial and diamond gradients/);
    expect(() => toPaint({ gradient: { type: "linear", center: { x: 0, y: 0 }, stops } }, 0)).toThrow(/center` is for radial, angular and diamond gradients/);
  });
});

describe("a paint style's linear angle is fitted to a square", () => {
  const angleOn = (t: Transform, w: number, h: number) => Math.round(transformAngle(t, w, h)!);
  const linear135 = { gradient: { type: "linear", angle: 135, stops } };

  it("on a node the angle is the node's own; in a style it holds only on a square — the number the schema quotes", () => {
    const fitted = toPaintFor(linear135, 0)(1280, 400) as { gradientTransform: Transform };
    expect(angleOn(fitted.gradientTransform, 1280, 400)).toBe(135);
    const style = toPaint(linear135, 0) as { gradientTransform: Transform };
    expect(angleOn(style.gradientTransform, 400, 400)).toBe(135);
    expect(angleOn(style.gradientTransform, 1280, 400)).toBe(163);
  });

  it("the schema tells the agent where it writes the angle", () => {
    const angle = gradientEntry.shape.angle.description ?? "";
    expect(angle).toMatch(/paint style has no size/);
    expect(angle).toMatch(/135 shows about 163 on 1280×400/);
  });
});

describe("the paint style tools say so too (C-6)", () => {
  const styleTools = new Map<string, { description: string }>();
  const server = { registerTool: (name: string, config: { description: string }) => styleTools.set(name, config) } as unknown as McpServer;
  registerCreate(server, {} as Bridge, () => true);
  registerTokens(server, {} as Bridge, () => true);

  it.each(["figma_create_paint_style", "figma_update_style"])("%s warns that a style's angle is exact only on a square, within the cap", (name) => {
    const d = styleTools.get(name)!.description;
    expect(d).toMatch(/A gradient style's `angle` is exact only on a square node — a style has no size; for an exact CSS angle on a known node use figma_set_fills, or give `transform`\./);
    expect(d.length).toBeLessThanOrEqual(1024);
  });
});
