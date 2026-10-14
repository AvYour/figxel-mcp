# Principles — the classic craft in Figma fields

The twelve principles of animation come from hand-drawn character work [C-226], and most of them map straight onto keyframe fields. Timing and spacing come first.

## Timing and spacing
- **Timing** is how many frames an action takes, and where it starts on the beat grid.
- **Spacing** is how far it travels in each of those frames, which the easing decides.

The same 12 frames read as a heavy object or a light one depending on the spacing alone. Plan timing on the beat sheet; shape spacing with the easing roles (section `easing`, figma_get_guide { topic: "motion", section: "easing" }); read the result as numbers with figma_check_motion { includeActivity: true }, which lists the fastest on-screen move per frame.

## The principles as fields
| Principle | In Figma Motion |
|---|---|
| Squash and stretch | SCALE_X and SCALE_Y in opposite directions on a shape, keeping its area about the same. Not on type: it distorts the letterforms |
| Anticipation | a small reverse key before the move: a few per cent of pull-back before a dive, a slight swell before a collapse. Without it, a big move starts from nothing; with a stall instead, the move dies before it starts |
| Staging | one focal action per beat; everything else holds still or dims. Dimmed text that must still be read keeps its contrast (4.5:1, or 3:1 when large [C-075]): the run's dimmed list items measured 2.16:1 and 1.83:1 [C-207] |
| Pose to pose | keyframes are pose to pose by nature: block the poses on the beats first, then shape the curves (section `passes`) |
| Follow-through and overlap | secondaries lag the lead by 2 to 4 frames and settle after it stops; nothing in a group stops on the same frame |
| Slow in and slow out | the easing roles; never the same curve on every move |
| Arcs | separate TRANSLATION_X and TRANSLATION_Y tracks on different easings bend the path; one TRANSLATION_XY track always travels in a straight line. Or rotate a parent about an offset point |
| Secondary action | a small move that supports the main one (a ring that spins, an echo that spreads) and is never born underneath the thing that triggers it |
| Timing | frames per action, placed on the beat grid; hits peak on their beat frame |
| Exaggeration | accents pushed past rest and back, each hand-keyed, as many as the bible's restraint rules allow for this brief |
| Solid drawing and appeal | the composition and the type: the styleframes carry these, not the motion |

## Restraint
Every device needs a reason in the brief. Write restraint rules into the bible for every piece, from its own brief: how many devices may share a stretch, how many accents the piece gets, which moves never happen. Then count against them in review.

## Tells of generated motion
These were measured on an earlier ad that read as generated [C-209] [C-260], or are named as habits of generated work [C-219]:
- the same move (a fade plus a small rise) on most layers;
- one arrival curve and one exit curve on every layer, whatever its size;
- a slideshow rhythm: build, freeze, exit, gap, with nothing carried across a cut;
- a blank frame 0 that the brief did not ask for;
- staggers that fall between frames;
- spring pops as the accent;
- camera pushes that ease to a stop, then frozen holds;
- the brand arriving late, or a logo fading in on black at the end;
- a cross-fade or a slide-over where a designed transition belongs;
- copy held too briefly to read.

figma_check_motion counts several of them: `template_move` (one entry signature on many layers), `easing_census` (one curve on most moves, stock springs), `no_stagger`, `cold_open`, `dead_span`, `read_time` and `brand_late`. Any of them can be right for a brief; then it is a choice written in the report, never a habit.
