# Tells: what reads as generated

Generated design converges on a few interchangeable looks, and it stays unfinished; this section covers the first, section `finish` the second. "Measured by" names a kind of figma_check_layout { nodeId, audit: ["tells"] }, a value from figma_get_design_context, or "eye": only the render and a judgement see it.

Every `tells` kind reports `info` until it is calibrated: a question to answer, not a verdict. No "Instead" cell is a style to adopt: each is a choice the brief makes, and the opposite is right for another brief.

## The clusters, in numbers

`cluster_1` … `cluster_6` count each look's features and report "matches cluster N on k of m features" from two; figma_get_design_context and figma_get_styles show the values behind a count; colours compare as HSL hue and lightness.

| # | Look | Features to compare |
|---|---|---|
| 1 | Warm off-white with a serif and clay | ground: lightness above about 90 %, hue 20–60° (anchor about #F4F1EA); display: a high-contrast serif; accent: hue about 10–30°, mid lightness (anchor about #D97757) |
| 2 | Near-black with one acid accent | ground: lightness under about 10 %; one saturated accent, acid green or vermilion, and no other saturated colour |
| 3 | The broadsheet | strokes and rules of 1 px or less; radius 0 on every container; text in dense, narrow columns |
| 4 | The software kit | three or more cards of one size and radius; one radius on every container; one soft grey shadow on each card (black at about 10 % opacity); gradient washes |
| 5 | Template chrome | tracked capital labels over headings; middle-dot meta strings; "WORD — fragment" labels; near-black text at about #0B0B0B or #111 or tinted; small monospaced labels; an arrow on links and buttons |
| 6 | The dashboard kit | a navy, slate or saturated sidebar; an icon tile on every card or KPI; big KPI figures in the brand colour; a "+%" pill or a sparkline on every KPI; a greeting title; a gradient area chart; the accent on chrome |

Two or more features of one cluster is a finding for the originality lens; each look is legitimate when the brief chooses it. In the 2026-10-09 run an ad matched cluster 1 on all three features and cluster 5 on four, and no lens said so; its palette was the brand's, a given, and should still have been named. Styles saved in a file are not givens because they are there: section `brief` decides whose they are, and a match with no owner is a default.

## Type

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| One default face at one or two weights | The face nobody chose | `default_typeface` (every text one interface face) | A face that meets the subject's criteria (section `system`), its reason in one line; a common face when the brand gives it |
| A display face from the reflex list (Fraunces, Playfair, Space Grotesk, Inter as display …, dated 2026-10-20) | Last year's distinctive face is this year's default | `reflex_display_face` | A display face from the subject's world, with its reason |
| Flat hierarchy | Nothing leads, so everything competes | `flat_hierarchy`, `too_many_sizes` | Levels far apart for a poster read at a distance, gently for a dense tool; a step you can see |
| Everything centred | The alignment that needs no decision | `mostly_centred`, `centred_block` | Centre one statement or a symmetric pair; start the rest where its reading begins; never centre a block |
| A tracked capital label over every heading | Added whatever the heading says | `eyebrow_everywhere` | A label only where it says what the heading does not |
| One coloured or italic word in every headline | A stock trick standing in for emphasis | eye | Emphasis on the one word that carries the message, or none |
| Text that simply fills its box | Measure and leading were never set | `measure`, `leading` | Width from the measure, leading from the face |

## Layout and composition

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| A centred stack of centred sections | Every section the same shape | eye; `unbalanced_space` helps | Arrange each section by its content: an uneven split for uneven content |
| A small block centred in an empty app screen | The chat start screen, whatever the product | `centred_stage` | Content from where reading starts, the region given to the main job; centred for a sign-in or an empty state |
| The identical trio: icon, title, two lines, three times | Content cut to fit a kit, whatever its importance | `card_trio` | Rank the items: equal ones share a form (a list, a table); unequal ones get room by importance |
| KPI tiles: a big figure, a label, an icon tile or a sparkline, each | The dashboard kit's stat strip | `kpi_tile` | Figures as type in one divided row; the one that answers the screen's question largest |
| Boxes inside boxes; most text in a box | Containers instead of grouping | `nested_cards`, `boxiness` | Group with space and type; a container only where a group is acted on as one |
| Even spacing everywhere | No groups form | `flat_rhythm` | Tight inside a group, wider between groups, widest between sections |
| Nothing touches an edge | A bordered box, not a composition | eye | Decide what the edges do: a framed page for a calm brief, a bleed or a crop for scale |
| One skeleton on every view | A template filled in again | `skeleton_repeat` (sections, or the roots of one nodeIds check) | The same tokens, a composition per view's content |
| A web section moved into another format | Not composed for this one | eye | Compose for the format: its proportions, viewing distance, safe zones |

## Surface and decoration

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| A violet-to-blue wash | A hue nobody picked | `default_gradient` | Colour from the subject or the brand; a gradient only when light or a material gives it a reason |
| A glow behind the hero | Atmosphere standing in for an idea | `glow` | Depth from scale, contrast and real layering, or a flat field |
| One radius on every container; a nested radius equal to its parent's | A kit setting, not a system | `one_radius`, `nested_radius` | Radius by role and size; inner radius = outer minus the inset |
| The same soft shadow under every card | Elevation as decoration | `same_shadow` | Shadow only where something sits above something else |
| Faint blobs, low-opacity motifs | Decoration nobody would miss | eye | The motif at full strength carrying the idea, or nothing |
| Competing accents, coloured side bars, dots that mean nothing | Colour with no rule | eye | A written colour rule: what each colour marks; colour plus a second cue |
| The accent on navigation, icons and shapes | Accent as furniture, so nothing stands out | `accent_share` (the top saturated colour: chrome against data and buttons) | The accent on the data that answers the question and on the one primary action |
| Primary and accent a few degrees of hue apart | One hue pretending to be two | `hue_pair` | An accent of its own hue, or one colour and its tints |
| Tinted near-black body text; grey text as hierarchy | Mood over reading | a body fill whose R, G and B differ (#1f1c18, not #1c1c1c); `low_contrast` | Neutral text unless the brand tints it; hierarchy from size and weight |

## Icons and images

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| Emoji as icons or bullets | The cheapest glyph available | `emoji_icon` | A drawn set at one weight, plain bullets, or no icon |
| An icon on every card, in a tinted chip | Stock richness, meaning nothing | `icon_tile`, `card_trio` | Icons only where they speed recognition, labelled, at text size without the chip |
| Feel-good stock photos | People skip them | eye | The product, the real people and place, or no photo |
| Images in mixed temperatures; a light image dissolving into a light ground | Collected, not directed | eye | One temperature for the set; an edge for a light image |

## Copy and chrome

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| Vague benefit copy | Interchangeable, so readers discount it | eye | Specific claims: numbers, names, materials |
| A greeting as the title ("Welcome back", "How can I help") | A line that fits any product | `greeting_title` | A noun title the navigation uses, or the answer to the screen's question |
| Placeholder people and brands ("John Doe", "Acme", example.com) | Nobody wrote the content | `placeholder_text` | Plausible specifics, listed for replacement |
| Middle-dot meta strings, an arrow on every button, "WORD — fragment", 01/02/03 on things that are not a sequence | Added whatever the content is | `chrome_string` | Labels written as content; numbers only for real sequences |
| A rule under every heading | Separation by habit | `divider_everywhere` | Space, a change of colour or layout, or a rule where it separates something |

## Motion

| Tell | Why it reads as generated | Measured by | Instead |
|---|---|---|---|
| One fade-and-rise on every element | A prototype's build-in | figma_check_motion (`template_move`, `no_stagger`) | Moves chosen from the idea (the motion skill) |

## A tell can be right

Any tell may be the right choice for a brief: a centred block for a short invitation, a serif on cream for a brand that already owns it, numbered steps for a real sequence. Then it is a decision. Write it in the report with its reason and its evidence: "brand given" cites the style or variable id of a given (section `brief`), or quotes the user; "a real sequence" names the steps. The opposite holds too: a direction made only by negating these rows is a default of its own. Each choice names the brief line it answers.

Evidence (claim ids, for maintainers): [C-217] [C-207] [C-248] [C-220] [C-219] [C-208] [C-210] [C-218] [C-073] [C-209] [C-221] [C-214] [C-213] [C-215] [C-400]
