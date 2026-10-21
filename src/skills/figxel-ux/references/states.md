# States — every control, every screen

A screen drawn only in its default state is a picture of the product on its best day. People meet the other days: a slot that is full, a field typed wrong, a list still loading, a keyboard instead of a mouse. Each of those is a state someone has to design, and here that someone is you.

## The state matrix

Every interactive component carries these states as variants of one property named `State`:

| Control | States |
|---|---|
| Button, link, tab, chip, menu item | Default, Hover, Focus, Pressed, Disabled; Loading on a button that submits |
| Text field, select, text area | Default, Focus, Filled, Error, Disabled |
| Checkbox, radio, switch, toggle | as a button, each also Selected (checked, on) |

Hover exists only on pointer platforms (web, desktop); on iOS and Android leave it out. The audit also reads a property named `status` or `interaction`, and these values as the same state: enabled or rest as Default; hovered; focused or focus-visible; active or down as Pressed; inactive as Disabled; invalid as Error; busy as Loading; checked or on as Selected.

## What each state changes

- **Default.** The control at rest, with real content: a real label, a real value.
- **Hover.** A small shift that says "this responds": a state layer over the container. Material Web's token set v0_192 puts the layer at 0.08 opacity of the content colour for hover, 0.12 for focus and pressed, 0.16 for dragged; newer token sets differ, so treat these as a starting point.
- **Focus.** A visible indicator around the control that a keyboard user can find at a glance: at least 2 px thick, with 3:1 contrast between the focused and unfocused pixels, and never hidden by a sticky header or a footer. It is the one state no pointer user notices, which is why it gets forgotten.
- **Pressed.** Stronger than hover, for the moment of the click or the tap.
- **Disabled.** Visibly unavailable but still readable as the same control. Inactive components are exempt from the contrast minimums; the label must still be legible. In v0_192 the filled button's disabled container is at 0.12 opacity and its label at 0.38. Prefer a control that explains why it cannot act over one that is merely grey.
- **Error.** Text that says what is wrong and how to fix it, by the field, plus a colour and an icon; never the colour alone (section `accessibility`).
- **Filled.** An input holding a real value, so the type and the spacing can be judged with content.
- **Loading.** The label keeps the button's width (a spinner beside or instead of it), so nothing jumps; the button cannot be pressed twice.
- **Selected.** On, checked or current, shown by more than colour: a check mark, a fill, a weight.

## Building the variants in one call

Build every state of a component in one figma_create_from_spec, each a component named `State=<value>` (add more properties the same way: `Size=Large, State=Hover`), then combine them: figma_combine_as_variants { componentIds, columns: "State" }. A button at 48 px tall, with five of its states:

figma_create_from_spec { pageId: <the components page>, spec: {"type":"frame","name":"Button / states","layout":"horizontal","gap":24,"padding":24,"children":[{"type":"component","name":"State=Default","layout":"horizontal","height":48,"padding":[0,20,0,20],"alignY":"center","cornerRadius":8,"background":"#1f5130","children":[{"type":"text","name":"Label","content":"Book slot","fontSize":16,"color":"#ffffff"}]},{"type":"component","name":"State=Hover","layout":"horizontal","height":48,"padding":[0,20,0,20],"alignY":"center","cornerRadius":8,"background":"#2a6a40","children":[{"type":"text","name":"Label","content":"Book slot","fontSize":16,"color":"#ffffff"}]},{"type":"component","name":"State=Focus","layout":"horizontal","height":48,"padding":[0,20,0,20],"alignY":"center","cornerRadius":8,"background":"#1f5130","stroke":"#ffbf47","strokeWeight":3,"children":[{"type":"text","name":"Label","content":"Book slot","fontSize":16,"color":"#ffffff"}]},{"type":"component","name":"State=Pressed","layout":"horizontal","height":48,"padding":[0,20,0,20],"alignY":"center","cornerRadius":8,"background":"#143a22","children":[{"type":"text","name":"Label","content":"Book slot","fontSize":16,"color":"#ffffff"}]},{"type":"component","name":"State=Disabled","layout":"horizontal","height":48,"padding":[0,20,0,20],"alignY":"center","cornerRadius":8,"background":"#e3e6e3","children":[{"type":"text","name":"Label","content":"Book slot","fontSize":16,"color":"#5b625c"}]}]} }

Then:
- the label as a property: figma_add_component_property { componentId: <the set>, name: "Label", type: "TEXT", defaultValue: "Book slot", bindNodeIds: [<each Label id>] };
- a focus ring outside the edge instead of inside it: figma_set_strokes { nodeIds: [<the Focus variant>], color: "#ffbf47", weight: 2, align: "OUTSIDE" };
- bind the colours to the file's variables when it has them (the design-system skill).

Place instances in the screens (figma_create_instance, or `"type":"instance"` in a spec), never copies of the component's layers. A state that is missing from an existing set: figma_clone_node { nodeId: <the Default variant> } (the copy lands beside its source, in the set), figma_rename_node { nodeId: <the copy>, name: "State=Focus" }, then change only what the state changes.

## Screen states

Each screen state is a top-level frame named `<screen name> / <State>`, built from the screen by cloning it and changing what differs (section `flows` has the names and the brief's `details.screens`).

- **Empty.** Say what will appear here and how to make it appear, with the action that starts it: "No bookings yet. Book a bench slot to see it here." Never a blank area: an empty state is the screen's chance to teach its use.
- **Loading.** Pick the indicator by the wait. About 0.1 s feels instant and needs nothing; about 1 s keeps the person's train of thought; about 10 s is as long as attention holds. A whole screen loading in under 10 s: a skeleton of its layout. One part loading for 2 to 10 s: a spinner in that part. Longer, or a process such as an upload: a progress bar that shows how much is done.
- **Error.** What happened, in plain words, what the person can do, and a way to retry; anything they typed is kept (section `content`).
- **Success.** What just happened and what comes next: "Booked: Saturday 10:00, bench 4. We emailed the details."
- **Offline.** Only when the product works without a connection: what still works, and what waits.

## The states audit

figma_check_layout { nodeId, audit: ["states"], briefId } reads the component sets under the node and, with the brief, its declared screens.

| Kind | Severity | Fix |
|---|---|---|
| `state_missing` | warning for Focus on the web and desktop and for Error on an input; info for Hover (pointer platforms), Pressed, Disabled and Loading | add the variant as above |
| `state_property_missing` | info | a set with variants but no state property: rename its property to `State` with figma_edit_component_property { componentId, property, name: "State" } |
| `variant_default_name` | warning | a property still called "Property 1", or a value such as "Variant2": rename it the same way, or rename the variants (figma_rename_node) |
| `screen_state_missing` | warning | a state the brief declares has no frame named `<screen name> / <State>` among the deliverables: build it, or drop the state from `details.screens` with figma_set_brief { briefId, details } and say why in the report |

A state left out on purpose (a read-only chip needs no Pressed) is an info answered at sign-off: `answers: [{ kind: "state_missing", nodeId, reason }]`.

## The stress test: real content, before sign-off

A screen that holds up with tidy placeholder copy can break the day real content arrives. Before figma_sign_off, run figma_stress_test { nodeId: <the screen> } on every screen, state frames included, and fix what it breaks. It checks one copy per case against the original (figma_check_layout's `craft`, plus the `audits` you name) and reports only what a case broke, by the original's layer path ("Card / Title overflows by 46 px under expand"). It deletes the copies unless `keep: true`, which leaves them for you to see and delete.

| Case | What it does to the copy | It stands for |
|---|---|---|
| `expand` | every text grows as translation grows it, short strings most: to 300 % of its length up to 10 characters, 130 % past 70 | another language |
| `long` | twice the words per text; a single word becomes a 24-character compound | long names and labels |
| `numbers` | each run of digits becomes a large value of its form: 9 → 12,345, $9.99 → $12,345.99 | big counts and prices |
| `many` | each auto-layout list of three or more instances of one component gets three times the items | a full account |
| `empty` | those lists drop to none | a new account |

Fix the layout, not the words; real copy and its translations will be that long:
- A text that overflows, clips or collapses (`expand`, `long`): it fills its column and hugs its height (figma_resize_nodes { nodeIds, sizing: { horizontal: "fill", vertical: "hug" } }); its frame hugs instead of a fixed height; a button hugs its label up to a `maxWidth`, then the label wraps.
- A figure wider than its slot: the figure hugs, the text beside it fills.
- A list under `many`: the screen grows; a fixed-height region scrolls (figma_set_scroll_behavior { nodeId, overflow: "vertical" }).
- A layout that collapses under `empty`: the screen's Empty state above, built if missing.

Run it again after the fixes. A break kept on purpose, and any text skipped for a missing font, go in the report.

Evidence (claim ids, for maintainers): [C-388] [C-365] [C-346] [C-347] [C-348] [C-355] [C-356] [C-349] [C-372] [C-371] [C-373] [C-370] [C-391] [C-396]
