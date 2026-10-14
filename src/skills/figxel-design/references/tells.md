# Tells: what reads as generated

Generated design fails in two ways. It converges: broad requests land on the same flat, interchangeable look. And it stays unfinished: grouping, contrast and spacing that nobody measured. This section covers the first; section `finish` covers the second. Each row says why the tell reads as generated, what measures it, and the decision a professional makes instead. "Measured by" names a kind of figma_check_layout { nodeId, audit: ["tells"] }, a value read with figma_get_design_context, or "eye" when only the render and a judgement can see it.

The `tells` kinds report `info` only, because they are not calibrated yet: an info is a question to answer, not a verdict. Practitioners' lists name the same patterns; they corroborate, they do not decide. None of the "Instead" cells is a style to adopt: each is a choice the brief makes, and the opposite choice is right for another brief.

## The clusters, in numbers

Generated design falls into a few recognisable looks. Read the piece's values (figma_get_design_context for fills, fonts, radii, effects and text; figma_get_styles for the palette) and count the features each cluster matches. Colours are compared as HSL hue and lightness; the anchors are the source's own examples.

| # | Look | Features to compare |
|---|---|---|
| 1 | Warm off-white with a serif and clay | ground: lightness above about 90 %, hue 20–60° (anchor about #F4F1EA); display: a high-contrast serif; accent: hue about 10–30°, mid lightness (anchor about #D97757) |
| 2 | Near-black with one acid accent | ground: lightness under about 10 %; one saturated accent, acid green or vermilion, and no other saturated colour |
| 3 | The broadsheet | strokes and rules of 1 px or less; radius 0 on every container; text in dense, narrow columns |
| 4 | The software kit | three or more cards of one size and radius; one radius on every container; one soft grey shadow on each card (black at about 10 % opacity); gradient washes |
| 5 | Template chrome | tracked capital labels over headings; middle-dot meta strings; "WORD — fragment" labels; near-black text at about #0B0B0B or #111 or tinted; small monospaced labels; an arrow on links and buttons |

Report a match as "matches cluster N on k of m features". Two or more features of one cluster, or a whole cluster 5 set of chrome, is a finding for the originality lens. Each look is legitimate when the brief chooses it. In the 2026-10-09 test run, an ad for a fictional brand, the look matched cluster 1 on all three features (ground #fbf9f6, Cormorant Garamond, accent #a4532f) and cluster 5 on four (a tracked kicker, middle-dot meta, an arrow on the CTA, ink #1f1c18), and no lens said so; its palette was that brand's, so it was a given, and it still should have been named. Styles saved in a file are not givens because they are there: section `brief` decides whose they are, and a match with no owner is a default.

The `default_typeface` tell fires only when every text is one family from a short list of interface faces at two styles or fewer, so a serif display with an interface body, as in cluster 1, raises nothing there: the cluster table is the check for it.

## Type

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| One default face at one or two weights | The face nobody chose | `default_typeface`, and the cluster table | Criteria from the subject first (section `system`), then the face that meets them, its reason in one line; a common face is right when the brand gives it |
| Flat hierarchy | Nothing leads, so everything competes | `flat_hierarchy`, `too_many_sizes` | Decide how far apart the levels must be: far for a poster read at a distance, gentle for a dense tool; either way a step you can see |
| Everything centred | The alignment that needs no decision | `mostly_centred`, `centred_block` | Centre one statement or a symmetric pair; start other content from the edge its reading order begins at; never centre a block |
| A tracked capital label over every heading | Added whatever the heading says | `eyebrow_everywhere` | A label only where it tells the reader something the heading does not |
| One coloured or italic word in every headline | A stock trick standing in for emphasis | eye | Emphasis on the one word that carries the message, by weight, colour or scale, or none |
| Text that simply fills its box | Measure and leading were never set | `measure`, `leading` | Width from the measure, leading from the face |

## Layout and composition

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| A centred stack of centred sections | Every section the same shape | eye; `unbalanced_space` helps | Arrange each section by its content: a single statement may centre, uneven content takes an uneven split |
| The identical trio: icon, title, two lines, three times | Content cut to fit a kit, whatever its importance | `card_trio` | Rank the items: equal ones can share a form (a list, a table, cards when each is acted on alone); unequal ones get room by importance |
| Boxes inside boxes | Containers instead of grouping | `nested_cards` | Group with space and type; a container only where a group is acted on as one |
| Even spacing everywhere | No groups form | eye | Tight inside a group, wider between groups, widest between sections |
| Nothing touches an edge | A bordered box, not a composition | eye | Decide what the edges do: a framed, quiet page for a calm or formal brief; a bleed or a crop when it wants scale or energy |
| One skeleton on every view | A template filled in twice | eye, comparing renders | The same tokens, a composition per view's content |
| A web section moved into another format | Not composed for this one | eye | Compose for the format: its proportions, its viewing distance, its safe zones |

## Surface and decoration

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| A violet-to-blue wash | A hue nobody picked | `default_gradient` | Colour from the subject or the brand; a gradient only when light, depth or a material gives it a reason |
| A glow behind the hero | Atmosphere standing in for an idea | `glow` | Depth from scale, contrast and real layering, or a flat field when the direction is flat |
| One radius on every container; a nested radius equal to its parent's | A kit setting, not a system | `one_radius`, `nested_radius` | Radius by role and size, square to round as the direction decides; inner radius = outer minus the inset |
| The same soft shadow under every card | Elevation as decoration | `same_shadow` | Shadow only where something sits above something else, in as few levels as the layering has |
| Faint blobs, low-opacity motifs | Decoration nobody would miss | eye | Make the motif carry the idea at full strength, or remove it |
| Competing accents, coloured side bars, dots that mean nothing | Colour with no rule | eye | A written colour rule: what each colour marks; colour plus a second cue |
| Tinted near-black body text; grey text as hierarchy | Mood over reading | figma_get_design_context: a body text fill whose R, G and B differ (#1f1c18 is tinted, #1c1c1c is not); `low_contrast` | Neutral text unless the brand tints it; hierarchy from size and weight |

## Icons and images

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| Emoji as icons or bullets | The cheapest glyph available | `emoji_icon` | A drawn set at one weight, plain bullets, or no icon |
| A line icon on every card | Stock richness, meaning nothing | eye; `card_trio` helps | Icons only where they speed recognition, always labelled |
| Feel-good stock photos | People skip them | eye | The product, the real people, the real place, or no photo |
| Images in mixed temperatures; a light image dissolving into a light ground | Collected, not directed | eye | Grade the set to one temperature; give a light image an edge |

## Copy and chrome

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| Vague benefit copy | Interchangeable, so readers discount it | eye | Specific claims: numbers, names, materials |
| Placeholder people and brands ("John Doe", "Acme", example.com) | Nobody wrote the content | `placeholder_text` | Plausible specifics, listed for replacement |
| Middle-dot meta strings, an arrow on every button, "WORD — fragment", 01/02/03 on things that are not a sequence | Added whatever the content is | `chrome_string` | Labels written as content; numbers only for real sequences; an arrow only where something moves on |
| A rule under every heading | Separation by habit | `divider_everywhere` | Space, a change of colour or layout, or a rule where it separates something real |

## Motion

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| One fade-and-rise on every element | A prototype's build-in; the earlier ad used it on 15 of 23 animated layers | figma_check_motion (`template_move`, `no_stagger`) | Moves chosen from the idea (the motion and storyboard skills) |

## A tell can be right

Any tell may be the right choice for a brief: a centred block for a short invitation, a serif on cream for a brand that already owns it, numbered steps for a real sequence. Then it is a decision. Write it in the report with its reason and its evidence: "brand given" cites the style or variable id of a given (section `brief`), or quotes the user; "a real sequence" names the steps. The opposite holds too: a direction made only by negating these rows is a default of its own. Each choice names the brief line it answers.

Evidence (claim ids, for maintainers): [C-217] [C-207] [C-248] [C-220] [C-219] [C-208] [C-210] [C-218] [C-073] [C-209] [C-221] [C-214] [C-213] [C-215]
