---
name: figxel-prototype
description: Wire prototype behaviour in Figma with Figxel. Interactions and their JSON shape, scrolling and fixed layers, and the page's flows, with what Figma refuses. Use for clicks, overlays, delays and variable changes; not for timeline animation.
---

# Prototypes — interactions, scrolling and flows

Three places: interactions on layers (figma_set_reactions), scrolling and fixed layers on frames (figma_set_scroll_behavior), and the page's flows (figma_set_prototype_flows). Read the current state first with figma_get_reactions.

## Interactions — figma_set_reactions { nodeId, reactions }
`reactions` is a JSON array that replaces the node's list ([] removes them). Figma's full Reaction shape is accepted as is — copy one from figma_get_reactions — plus a shorthand for navigation. Use ids, never names: destinations from figma_get_node or design context, variables and modes from figma_get_variable_defs. Units differ: a transition's `duration` is seconds [C-056], a trigger's `timeout` (AFTER_TIMEOUT) and `delay` (MOUSE_ENTER, MOUSE_LEAVE, MOUSE_UP, MOUSE_DOWN) are milliseconds [C-122] — 0.3 and 2000, never 300 and 2.

Navigate on click with smart animate (shorthand):
  [{"trigger":"ON_CLICK","action":{"type":"NODE","destinationId":"12:3","transition":"SMART_ANIMATE","duration":0.3,"easing":"EASE_OUT"}}]
Open an overlay:
  [{"trigger":"ON_CLICK","action":{"type":"NODE","destinationId":"12:40","navigation":"OVERLAY","transition":"DISSOLVE","duration":0.2}}]
After a delay of 2 s:
  [{"trigger":{"type":"AFTER_TIMEOUT","timeout":2000},"actions":[{"type":"NODE","destinationId":"12:3","navigation":"NAVIGATE","transition":null}]}]
On a key (Enter is 13):
  [{"trigger":{"type":"ON_KEY_DOWN","device":"KEYBOARD","keyCodes":[13]},"actions":[{"type":"BACK"}]}]
Set a variable — variableValue is Figma's VariableData:
  [{"trigger":"ON_CLICK","actions":[{"type":"SET_VARIABLE","variableId":"VariableID:1:2","variableValue":{"type":"BOOLEAN","resolvedType":"BOOLEAN","value":true}}]}]
Switch a mode (light to dark):
  [{"trigger":"ON_CLICK","actions":[{"type":"SET_VARIABLE_MODE","variableCollectionId":"VariableCollectionId:1:1","variableModeId":"1:2"}]}]
Branch on a boolean variable — the block without a condition is the else; actions inside a block use the full shape:
  [{"trigger":"ON_CLICK","actions":[{"type":"CONDITIONAL","conditionalBlocks":[
    {"condition":{"type":"VARIABLE_ALIAS","resolvedType":"BOOLEAN","value":{"type":"VARIABLE_ALIAS","id":"VariableID:1:2"}},
     "actions":[{"type":"NODE","destinationId":"12:3","navigation":"NAVIGATE","transition":null}]},
    {"actions":[{"type":"BACK"}]}]}]}]

What Figma enforces:
- A NAVIGATE to the frame that contains the clicked layer is refused [C-058]: navigate between top-level frames, or use SCROLL_TO or an overlay inside one.
- Smart animate pairs layers across the two frames by name and by place in the hierarchy [C-119]: give every moving layer the same name and nesting in both. A layer only in the destination dissolves in.
- Overlay position, background and click-outside behaviour are read-only to plugins [C-117]: figma_get_reactions reports them; ask the user to set them in Figma's prototype panel.

## Scrolling and fixed layers — figma_set_scroll_behavior
{ nodeId, overflow: "vertical", fixedNodeIds: [<nav id>] }: the frame scrolls in presentation and the nav stays put. Fixed layers are a section at the top of the layer list, not a per-layer flag [C-117], so they are moved there; inside auto-layout make each absolute first (figma_move_nodes { nodeIds, positioning: "absolute" }). A top-level frame larger than the device scrolls on its own; overflow matters for nested frames such as carousels and panels.

## Flows — figma_set_prototype_flows
{ flows: [{ nodeId: <first screen>, name: "Onboarding" }], background: "#111111" } replaces the page's starting points in order; the first is the one the play button opens. Each must be a top-level frame on that page. The call replaces the list, so read the existing flows first (figma_get_reactions { scope: "page" }) and keep the user's own.

Check what you wired with figma_get_reactions; a refusal comes back with Figma's message naming the id or field.
