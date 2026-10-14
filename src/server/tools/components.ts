// The component tools that reach what the official Figma MCP does through
// Plugin API JavaScript: one component's property definitions, library assets
// imported by key, property edits and deletes, descriptions, and slots
// [C-110] [C-111] [C-112].
//
// One register function, wired by tools/index.ts. The component tools that
// already existed (create_instance, swap_component, add_component_property, …)
// stay in their groups' modules; their new parameters are there.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Bridge } from "../bridge.js";
import { fitDescription, sizingParam } from "./params.js";
import { forwardTool, type Extra } from "./forward.js";
import { WRITE_PARAMS } from "./create.js";
import { readAnnotations, writeAnnotations } from "./annotations.js";

const SESSION = {
  session: z
    .string()
    .optional()
    .describe("Optional sessionId or file name, to pick a Figma file when more than one is connected."),
};

const PER_ITEM =
  "Returns per-item results: `items: [{ id, ok, error? }]` — one node failing does not fail the call.";

export function registerComponents(server: McpServer, bridge: Bridge, wanted: (op: string) => boolean): void {
  const write = (op: string, title: string, description: string, shape: z.ZodRawShape) => {
    if (!wanted(op)) return;
    server.registerTool(
      `figma_${op}`,
      { title, description: fitDescription(description), inputSchema: { ...shape, ...WRITE_PARAMS }, annotations: writeAnnotations(op) },
      async (args: Record<string, unknown>, extra: Extra) =>
        forwardTool(bridge, op, args, extra, {
          session: args.session as string | undefined,
          idempotencyKey: args.idempotencyKey as string | undefined,
        }),
    );
  };

  // `idempotencyKey` is meaningless for a read, as in read.ts.
  const read = (op: string, title: string, description: string, shape: z.ZodRawShape) => {
    if (!wanted(op)) return;
    server.registerTool(
      `figma_${op}`,
      { title, description: fitDescription(description), inputSchema: { ...shape, ...SESSION }, annotations: readAnnotations(op) },
      async (args: Record<string, unknown>, extra: Extra) => forwardTool(bridge, op, args, extra, { session: args.session as string | undefined }),
    );
  };

  read(
    "get_component",
    "Get one component",
    "One component's API, as code or an instance needs it: its property definitions (key, name, type, default, variant " +
      "options, preferred swap targets), its variants with their values, the default variant, and which layers each " +
      "property drives. Pass a component, a component set, a variant (answered from its set, where Figma keeps the " +
      "definitions) or an instance (answered from its main component — library ones too, read-only). `key` is what " +
      "figma_import_library_assets and figma_create_instance `componentKey` take. figma_get_local_components lists " +
      "components; figma_get_design_context shows an instance's current values. `references` is paginated with " +
      "`limit` + `cursor`.",
    {
      nodeId: z.string().describe("A COMPONENT, COMPONENT_SET, variant or INSTANCE id."),
      limit: z.number().int().min(1).max(2000).optional().describe("Max layer references returned. Default 200."),
      cursor: z.string().optional().describe("The nextCursor of a truncated call, unchanged."),
    },
  );

  write(
    "import_library_assets",
    "Import library assets",
    "Bring published library assets into this file by key — components, component sets, styles, variables — and get " +
      "the local ids every other tool takes: figma_create_instance / figma_swap_component `componentId`, " +
      "figma_apply_style_to_node `styleId`, figma_bind_variable_to_node `variableId`. Keys come off an existing screen " +
      "(figma_get_design_context, figma_get_component) or from the library file opened as another session. Only " +
      "published assets import; each one that does not carries Figma's reason: `items: [{ key, kind, ok, id?, name?, " +
      "type?, error? }]`. To place a single library component, figma_create_instance `componentKey` imports it itself.",
    {
      assets: z
        .array(
          z
            .object({
              kind: z.enum(["component", "component_set", "style", "variable"]),
              key: z.string().min(1).describe("The asset's published key."),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    },
  );

  write(
    "edit_component_property",
    "Edit component property",
    "Change a component property that already exists: rename it (`name` — the key changes and is returned), change " +
      "its default, set an instance swap's preferred components, or wire / unwire layers (`bindNodeIds` / " +
      "`unbindNodeIds`, matched by name path in every variant of a set). A variant id is redirected to its set. " +
      "Figma's rules are checked before anything changes: no default for VARIANT or SLOT, preferredValues only on " +
      "INSTANCE_SWAP and SLOT. To add a property use figma_add_component_property; to change one instance's value, " +
      "figma_set_instance_properties.",
    {
      componentId: z.string().describe("The COMPONENT or COMPONENT_SET (a variant id is redirected to its set)."),
      property: z.string().describe('Its name ("Label") or full key ("Label#2:0").'),
      name: z.string().optional().describe("A new name."),
      defaultValue: z.string().optional().describe('Text, "true"/"false" for BOOLEAN, a component id for INSTANCE_SWAP.'),
      preferredValues: z.array(z.string()).max(50).optional().describe("INSTANCE_SWAP / SLOT: component or component-set ids offered first. [] clears them."),
      bindNodeIds: z.array(z.string()).max(50).optional().describe("Layers inside the component to drive with this property."),
      unbindNodeIds: z.array(z.string()).max(50).optional().describe("Layers to stop driving."),
    },
  );

  write(
    "delete_component_property",
    "Delete component property",
    "Delete a TEXT, BOOLEAN, INSTANCE_SWAP or SLOT property from a component or component set: every instance loses " +
      "it, overrides included. A VARIANT property cannot be deleted — it comes from the variant names, so rename the " +
      "variants instead. To rename or rewire a property use figma_edit_component_property.",
    {
      componentId: z.string().describe("The COMPONENT or COMPONENT_SET (a variant id is redirected to its set)."),
      property: z.string().describe('Its name ("Label") or full key ("Label#2:0").'),
    },
  );

  write(
    "set_description",
    "Set description",
    "Write the description (plain or markdown) and documentation link that the assets panel and Dev Mode show, on a " +
      "component, component set, local style or local variable. A set's description is the one people see — put it " +
      "there rather than on a variant. One https link at most; \"\" clears it. Variables take plain text only, no " +
      "link. Library assets are read-only here. To rename: a component or set with figma_rename_node, a style with " +
      "figma_update_style `name`, a variable with figma_set_variable_properties `name`.",
    {
      targetId: z.string().describe('A COMPONENT / COMPONENT_SET id, a style id ("S:…,") or a variable id ("VariableID:…").'),
      description: z.string().optional().describe('The text. "" clears it.'),
      markdown: z.boolean().optional().describe("Treat `description` as markdown (bold, lists, links). Default false."),
      documentationLink: z.string().optional().describe('One https:// address. "" removes the link.'),
    },
  );

  write(
    "create_slot",
    "Create slot",
    "Add a slot to a component: a frame that each instance fills with its own layers, plus the SLOT property that " +
      "goes with it. Pass a component or one variant, not a set. `layout` horizontal or vertical (Figma refuses a grid " +
      "on a slot). Fill it in an instance by creating content with `parentId` = the slot inside that instance; " +
      "figma_reset_slot empties it again. figma_set_instance_properties cannot set a slot.",
    {
      componentId: z.string().describe("A COMPONENT, or one variant of a set."),
      name: z.string().optional().describe('e.g. "Content", "Actions".'),
      layout: z.enum(["horizontal", "vertical"]).optional().describe("Auto-layout direction of the slot."),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      sizing: sizingParam.optional(),
    },
  );

  write(
    "reset_slot",
    "Reset slot",
    "Put slots inside instances back to the component's own slot content, dropping what was added into them. Pass " +
      "the SLOT layers of the instances (figma_search_nodes with type SLOT finds them). To empty one layer at a time " +
      "use figma_delete_nodes instead. " +
      PER_ITEM,
    { nodeIds: z.array(z.string()).min(1).max(500).describe("SLOT layers inside instances.") },
  );
}
