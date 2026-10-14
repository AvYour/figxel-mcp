# Figma Slides decks — sections, arranging, speaker notes, design decisions

## Sections
Every row is a section, named in the editor and in Presenter View. Asked to organise a deck, read it and propose a grouping from its own cues (the title, numbered parts, transition slides, a closing) in one message; ask only when it has none. Two to five sections, each named in one to three concrete words; rename a section with figma_rename_node on its row id (figma_get_slide_grid lists them).

## Arranging and delivering
- Reorder with figma_move_slides (a few slides) or figma_set_slide_grid (the whole deck's grouping); copy a slide with figma_clone_node (it lands right after its source); skip one with figma_set_slide_properties.
- Show the user: figma_zoom_to { nodeId: <slide id> } focuses that slide; `view` "grid" or "single-slide".

## Speaker notes
Only when asked, or for a deck meant to be presented: figma_set_slide_properties { slides: [{ "slideId": "…", "speakerNotes": "- …" }] }. Short markdown bullets that add what the slide does not say — why, the transition to the next slide, a source, the question to expect — never the slide's text again and never a script unless asked. Lists, bold, italic and strikethrough show; headings, code and links stay literal. If this Figma build does not expose notes, the call is refused and nothing changes.

## Design decisions
Figma's own guidance names what a deck made without intent looks like, and asks for real contrast, imbalance and scale [C-218]. None of that is a style to apply: each is a decision the brief makes, slide by slide.
- **Where it is seen.** A deck projected in a room needs a hierarchy readable from the back: the title many times the body, few words per slide. A deck sent as a PDF and read on a screen can carry more, at reading sizes.
- **The tonal arc.** Decide how light and dark move through the deck from its structure and the room: quiet slides around the moments that must land, or one ground throughout when the content is even. Body text stays readable on whichever ground it sits on.
- **Colour by role.** One colour leads; the others each mark something the plan names. The roles come from the brief and the brand, not from a fixed list.
- **Balance by content.** A slide with one thing that matters gives it most of the space; a true comparison can split evenly. Where content anchors changes from slide to slide when the slides do different jobs.
- **Type.** One family or two by role, chosen as the design skill's `system` section decides it; centre only titles and one-line statements.
- **One idea per slide.** Cut before you shrink: more slides, not denser ones.
- **Pictures and motifs.** A chart, a photo or a diagram where the content has something to show; a recurring element only when the direction gives one, and then at full strength.
- **The opposite of intent** [C-218]: one structure repeated on every slide, the same layout recoloured, everything centred inside identical margins, a line under every heading, every block in the same box, decoration so faint nobody would miss it.
