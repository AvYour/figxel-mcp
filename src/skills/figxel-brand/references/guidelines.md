# Guidelines — the brand sheet, styles and applications

An identity is only finished when someone else can apply it without asking. The brand sheet is that handover: the mark's versions and rules, the colours and type as numbers, and two real applications that show it working.

## The brand sheet

One frame at the brief's `format` (or one per page when it grows), where the mark appears only as instances of its components, so a change to the mark reaches it:

- **Versions** — full colour, one colour and reversed, each on the ground it is for.
- **Clear space** — a lockup with its clear-space margin drawn and the rule written ("1x = the cap height of the name").
- **Minimum size** — the mark at its minimum width, the number in px (and mm for print), and the simplified version below it when there is one.
- **Colour** — each colour as a swatch with its hex, its role (lead, support, the accent and what earns it, text, ground) and roughly how much of a layout it covers; the print values when the brand has them.
- **Type** — the families and their roles, the scale as numbers, each level set in its own type.
- **Do and don't** — four misuses or more, drawn with real instances, each crossed out and captioned: stretched, recoloured outside the palette, on a busy photo, under the minimum size, rotated, the clear space broken. They are deliberate: answer any finding they raise at the sign-off with that reason.
- **Applications** — two from the brief's list, at their real size: a card, an avatar, a sign.

## Colours and type as styles

- **On the brief first:** figma_set_brief { briefId, system: { bodySize, ratio, sizes, palette } } with every colour as { hex, role }. The sign-off needs the palette, and the system audit's `off_palette` checks every solid colour against it.
- **Then saved for whoever applies the identity next:** a paint style per role (figma_create_paint_style { name, color, description }) and a text style per level (figma_create_text_style { name, fontFamily, weight, fontSize, lineHeight }), or variables when the identity will feed a product. The design-system skill has the order and the naming (figma_get_guide { topic: "design-system" }). Name them for the brand ("Spoke & Bench/Green"), beside any other brand's styles in the file, never over them.
- **Describe the components:** figma_set_description { targetId: <the mark's set>, description: "Full colour on light grounds, reversed on the green or darker; never under 24 px wide." }, so the rule travels with the mark into every file that uses it.

## Applications

- A card, a letterhead, a sign or a favicon in an existing identity is this role's page gear: the identity is a given (the design skill's `brief` section), and only what it leaves open is decided.
- Each application is its own frame at its real size and unit. For print, the graphic skill's `placements` section has trim, bleed and delivery (figma_get_guide { topic: "graphic", section: "placements" }).
- The mark goes in as an instance, at or above its minimum size, with its clear space kept.
- A favicon is the symbol alone or a lettermark, redrawn for its pixel size rather than scaled down, and checked at the smallest size the brief gives it.

## The app icon

When the applications include an app icon:

- A 1024 × 1024 px frame named "App icon": Apple's icon layout for iOS, iPadOS and macOS.
- The symbol on a ground from the palette. Text only when it is essential to the brand; an illustration rather than a photo; nothing that copies an interface control or a screenshot.
- The mark audit reports text in it (`app_icon_text`, info): keep it only with its reason.
- Render it at the small sizes it shows at, such as figma_export_node { nodeId, maxSize: 64 }: the symbol must still read there.

## Signing it off

figma_sign_off { nodeIds, lenses, rounds, answers, placeholders } with the deliverables: the mark's component set, the lockup set and the brand sheet frame (and the app icon when there is one), never the construction frame or the routes. It runs craft, tells, mark and system on each; the lenses are those of section `identity`. On a pass it selects and zooms to them; the report quotes it, with the minimum size and the colours as the user will apply them.

Evidence (claim ids, for maintainers): [C-361] [C-385] [C-386]
