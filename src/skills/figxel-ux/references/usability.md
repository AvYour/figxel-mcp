# Usability — walk the task against the ten heuristics

The audits measure what a tool can see. Whether a person gets through the task is judged by walking it: step by step, as the person in the brief, against Nielsen's ten usability heuristics. It is the usability lens of stage 8, run in every critique round of the page and top gears.

## Set up

1. Re-read the brief: figma_get_brief { nodeId: <a screen> } returns the task, the audience, the screens and their states.
2. Take the screens in step order, each with its state frames, as renders (figma_export_node { nodeId: <the screen> }) and as structure (figma_get_design_context { nodeId: <the screen> } for what each control is and says).
3. Be the person: where they are, what they hold, what they know already (the brief's audience line). A booking made with one hand next to a broken bike is a different walk from one made at a desk.

## The walk

For each step of the flow, ask each heuristic its question about that screen and its states. Write a finding only where the answer is no.

| # | Heuristic | Its question for a screen |
|---|---|---|
| 1 | Visibility of system status | Does the person know where they are, what just happened and what is happening now: the step and how many remain, a loading state, a saved confirmation? |
| 2 | Match between the system and the real world | Are the words, the order and the units the person's, not the system's or the organisation's? |
| 3 | User control and freedom | Can they go back, cancel or undo at this step, without losing what they entered? |
| 4 | Consistency and standards | Does the same action have the same name, place and look on every screen, and does the screen follow its platform's conventions? |
| 5 | Error prevention | Does the design stop the likely mistake before it happens: sensible defaults, impossible choices removed, a confirmation before anything that cannot be undone? |
| 6 | Recognition rather than recall | Is everything needed to decide visible here, rather than remembered from an earlier screen? |
| 7 | Flexibility and efficiency of use | Can a returning person go faster: remembered details, a shortcut, a default that is usually right? |
| 8 | Aesthetic and minimalist design | Does anything on the screen compete with the primary action or the information the step needs? |
| 9 | Help users recognize, diagnose and recover from errors | Does each error state say in plain words what went wrong and how to fix it (section `content`)? |
| 10 | Help and documentation | Where a step needs knowledge the person may lack, is the help on that screen, short and specific? |

Walk the error, empty and loading states as their own steps: a walk of the happy path alone never reaches them.

## Severity, 0 to 4

Rate each finding by how often people will meet it, how badly it stops them, and whether it keeps stopping them once they know it:

| Rating | Meaning | In the critique schema |
|---|---|---|
| 4 | a usability catastrophe: fixed before release | blocker |
| 3 | a major problem | major |
| 2 | a minor problem | minor |
| 1 | a cosmetic problem only | minor |
| 0 | not a usability problem | drop it |

A finding in the critique's schema, with the heuristic named:

```
usability · score 7 · verdict fix
- major (3) · where: "Booking / 02 Slots / Error" 12:410 · heuristic: 3 user control and freedom · problem: a full slot sends the person back to the day list, losing the chosen time · fix: keep them on the slot list with the next free slots above the message: figma_set_text { nodeId: "12:415", content: "That slot was just taken. These are free at the same time:" } and a three-slot list in the error frame
```

Scores follow the critique skill: a blocker caps the lens at 5, a major at 7. Sign-off needs no finding rated 3 or 4 left, and the lens at 8, or at the round budget an exception that lists what remains. Its code in a round's finding ids is US (accessibility is AX).

## More than one evaluator

NN/g's ideal is three to five people evaluating the same interface independently, each without seeing the others' findings until their own are done. Here:

- **One agent:** run the walk as its own pass, after the cold read and before re-reading your build notes, with only the brief and the renders in front of you.
- **A client with subagents:** give the walk to one or more subagents that receive only the brief (figma_get_brief), the screen ids and this section, never your intentions. Merge their findings as the critique's `rounds` section merges lenses: duplicates become one finding with the highest rating.

## After the walk

Fix in the round's one batch, with the other lenses' fixes, then re-walk the steps the fixes touched. At the gear's last round, every finding left goes into the report with its rating, and into figma_sign_off as the usability lens's `remaining`.

Evidence (claim ids, for maintainers): [C-367] [C-369] [C-368] [C-386] [C-239]
