# Content — the words of the interface

In a product the words are controls: a button's label is the decision the person makes, an error is the only help they get at the moment they need it. Write them as the designer of the flow, at the build, never as placeholders to fix later. Copy-only work on an existing screen is an edit and needs no brief.

## The rules

- **A button or a link says what happens, with a verb:** "Book slot", "Save changes", "Send invoice". Never "Submit", "OK", "Click here", "Learn more" or "Continue" alone; a reader who sees only the button should know what it does.
- **The same thing has the same name everywhere.** If the flow says "slot" on one screen, it never says "booking", "session" or "appointment" for the same thing on another.
- **One capitalisation style per kind of element,** used throughout: all buttons in sentence case ("Book slot"), or all in title case ("Book Slot"), never both. The same for headings, labels and menu items.
- **Every input has a visible label,** above or before it, that stays when the person types. The placeholder may show an example ("e.g. 07700 900123"), never the label itself, and never an instruction the person needs while typing.
- **Errors sit next to the field they are about,** in plain words: what went wrong and how to fix it. "Enter a date after today" rather than "Invalid date"; "This slot was just taken. Pick another time." rather than "Error 409". Never blame the person, never "Oops" or "Uh-oh", never a code alone. The person's input stays in the field.
- **Empty states say what will appear and how to start:** "No bookings yet. Book a bench slot and it shows here." with the action as a button.
- **Confirmations say what happened and what comes next:** "Booked: Saturday 10:00, bench 4. The details are in your email."
- **Cut every word that is not needed.** Each label, line and message is read at the moment of a decision; a sentence the person can skip should not be there.
- **Numbers, dates, times and prices in the reader's format,** with units: "£8 for 45 minutes", not "8.00 GBP / 0.75 h".
- **Specific beats promotional:** a fact the reader can use ("six repair stands, tools included") reads as more useful than a claim ("an amazing repair experience").

## Before and after

| Before | After | Why |
|---|---|---|
| Submit | Book slot | says what happens |
| Oops! Something went wrong. | We could not save your booking. Check your connection and try again. | what happened, what to do, no interjection |
| ERR_CARD_DECLINED | Your card was declined. Try another card or pay at the desk. | words, a way forward |
| Nothing here | No saved bikes yet. Add a bike to book faster next time. | what appears, how to start |
| Learn more | See opening hours | names the destination |

## The copy audit

figma_check_layout { nodeId, audit: ["copy"] } reads every text under the node. Each kind is info: fix it, or keep it with a reason at sign-off.

| Kind | Finds | Fix |
|---|---|---|
| `generic_label` | a button-like node whose text is Submit, OK, Click here, Learn more, Read more, Go, Yes, No or Continue | a verb and its object (figma_set_text { nodeId, content }) |
| `label_case_mixed` | button labels of one deliverable mixing title case and sentence case | choose one style and apply it to every label |
| `error_interjection` | Oops, Uh-oh, Whoops | state the problem and the fix instead |
| `error_code_only` | an error code with no words around it | a sentence a person can act on; the code may follow it |
| `copy_variants` | two strings that differ only in case, punctuation, dashes or quote marks | one wording everywhere: figma_find_replace_text { find, replace, scope: "subtree", nodeId } |

## The content pass

Stage 7's last pass, after the states exist:

1. figma_scan_text_nodes { nodeId: <each screen> } lists every string, state frames included.
2. Read them in flow order, as the person in the brief: does each label name what it does, each error say how to recover, each empty state say how to start?
3. Check the words against each other: one name per thing, one capitalisation per element type, one kind of dash and quote mark.
4. Fix with figma_set_text or figma_find_replace_text, then run the copy audit again.
5. List every invented fact (names, prices, times, addresses) for the report's placeholders and for figma_sign_off's `placeholders`.
6. Before sign-off, put the words under real pressure: figma_stress_test { nodeId: <each screen> }, one run per screen for this pass and the states pass. Its copy cases are `expand` (every text grown as translation grows it, short strings most: up to three times their length), `long` (twice the words, single words as 24-character compounds) and `numbers` (every figure large: $9.99 becomes $12,345.99); `many` and `empty` fill and empty the lists. Fix what it breaks in the layout, never by cutting the real copy to fit, and run it again (section `states` has the fixes).

The copy lens of the critique judges the result; for a ux deliverable it reads errors, empty states and confirmations as well as headlines.

Evidence (claim ids, for maintainers): [C-360] [C-370] [C-349] [C-350] [C-372] [C-215] [C-391] [C-396]
