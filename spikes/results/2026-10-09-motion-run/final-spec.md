# Moku IG Story Ad v2 (motion): the build bible

Locked 2026-10-09 by the creative director. Builders follow this document literally, in parallel, one package each, without talking to each other.

Every keyframe in section D also exists as data in **`final-spec.keyframes.json`** (same folder), keyed by package and exact layer name. Both come from one source (`final/gen-final.mjs`), which also validated the set:

- every key sits on the 1/30 s grid, except the frame-exact cut pairs;
- the first key of every track is at t = 0 and the last key of the timeline is 14.4;
- at most 10 keys per track (the cap is 100) and at most 6 tracks per layer (the cap is 50);
- every `effect:0:RADIUS` track has its LAYER_BLUR prerequisite listed.

Totals: 175 nodes, 93 animated layers, 182 tracks, 681 keys.

---

## 0. How to use this document

- **Sections A to C** describe the frame, the container tree and the packages. **Section D** holds one block per package: layers, build rules, keyframes, mechanism checks and fallbacks. **Section E** lists the frames to check after the single verification render.
- **Times are absolute timeline seconds everywhere.** Frame k is at k/30 s. "f72" means frame 72 = 2.4 s.
- **Coordinates are relative to the parent** given in each row. Containers and every 1080 × 1920 plane sit at (0, 0), so their children's x, y are screen coordinates. Rows marked "screen" restate the position on the 1080 × 1920 canvas.
- **When a value depends on a measured text width** (w), the row gives the rule. Measure with `figma_get_node` after creating the text with auto width.

---

## 1. The piece

**Concept: "Slow down."** The ad tells the scrolling thumb to slow down, and the type does exactly that. Then one terracotta circle of clay carries the whole edit:

1. It is born as a dot in the counter of the "o" of "Slow".
2. It swells into a disc that holds hands throwing clay on the wheel.
3. It collapses into a dot on the belly of the Ash Vase, which bursts open into the product band.
4. The camera pushes through the vase into the Kiln collection.
5. The bowl's terracotta wall blooms into the full-frame offer.
6. The offer field contracts into the "Shop the collection" button.

The brand wordmark "Moku" is on screen from frame 0 to the end. It locks its tracking on beat 1.8, then flies and scales into the end-card logo.

**Spine: the type spec ("Slow down.")**, which had the highest combined score: craft 8.5, ad 8, build 8. From it come:

- the frame-0 hook: "S l o w" collapsing its tracking at 400 px, and "down." dropping in letter by letter;
- the dot popping into the "o";
- the 230 px "Ash Vase" and the 220 px "$48";
- the full-frame terracotta "10%" field that contracts into the CTA;
- the build method: single-source JSON and frame-exact cut pairs.

**Grafts from the graphic spec:**

- the single terracotta circle as the thread through every scene;
- the concentric stacked iris (clay, cream, photo, 2 frames apart);
- the disc collapsing to a Ø 96 dot on the vase belly, with anticipation, and bursting into the band;
- the stacked plate wipe inside the band;
- exactly three hand-keyed overshoots;
- the brand that never leaves the screen and becomes the logo;
- trim-path accents (ring, dimension line, loop, bowl arc, arrow drawn shaft-first);
- the CTA numbers: a 640 × 120 pill, a 40 px label, an 8 % punch with settle, a 50 px ripple and two arrow nudges;
- name + price for every collection item.

**Grafts from the camera spec:**

- the velocity-matched push-through, as the ad's only camera move;
- lag-and-settle follow-through on secondaries (ring, pointer dot, "32 cm");
- 8 px blur on big type rises;
- the soft "slow" curve on the "Slow" tracking;
- a centred brand that is visible on frame 0 and locks its tracking at 1.8;
- the breath directly before the end card;
- the offer restated on the end card next to the CTA;
- plain clip frames for masks.

**Restraint for an ad that sells "slow":**

- no whip;
- no panel burst;
- no grain;
- one camera move;
- between 6 and 9 s, exactly two devices: the push-through arrival and the stop-motion cut with its list.

---

## 2. Tempo and beat grid

**100 BPM in 4/4.** One beat is 0.6 s = 18 frames, an 8th is 0.3 s = 9 frames, and a bar is 2.4 s. The timeline is **14.4 s = 6 bars = 432 frames** (frames 0 to 431 render). Every major hit lands on a downbeat (2.4, 4.8, 7.2, 9.6, 12.0), and the secondary hits land on beats or 8ths.

| Bar.beat | t (s) | Frame | Hit |
|---|---|---|---|
| 1.1 | 0.0 | 0 | Frame 0 already moving: "S l o w" tracking collapsing, the image slit opening, "M o k u" tracked wide |
| 1.2 | 0.6 | 18 | "down." starts dropping, one letter every 2 frames |
| 1.3 | 1.2 | 36 | Scale punch on "down." |
| 1.3& | 1.5 | 45 | **Terracotta dot pops into the "o"** (overshoot accent 1 of 3) |
| 1.4 | 1.8 | 54 | **"Moku" tracking locks** (centre brand moment); the dot settles |
| 2.1 | 2.4 | 72 | **Downbeat: the disc lands (Ø 880) and the stacked burst starts** (clay, then cream, then the hands photo) |
| 2.1–2.3 | 2.6–3.3 | 78–99 | Wheel beat: the ring draws and spins; "By hand." |
| 2.3 | 3.6 | 108 | **The circle collapses to a Ø 96 dot on the vase belly, and the band bursts open** |
| 2.4 | 4.2 | 126 | The band snaps square; the specs and the dimension line draw |
| 3.1 | 4.8 | 144 | **Downbeat: "$48"** (overshoot accent 2 of 3) |
| 3.3 | 6.0 | 180 | **Push-through cut** into the collection (anticipation dive 5.6–6.0) |
| 4.1 | 7.2 | 216 | **Downbeat: stop-motion cut, mug to plates** |
| 4.2& | 8.1 | 243 | Stop-motion cut, plates to bowl |
| 4.4 (approach) | 9.2–9.6 | 276–288 | The bloom seeds on the bowl's terracotta wall (cream first, terracotta 2 frames behind) |
| 5.1 | 9.6 | 288 | **Downbeat: full terracotta field; "1" rises** |
| 5.2 | 10.2 | 306 | Scale punch on "10%" |
| 5.3 | 10.4–10.9 | 312–327 | **Breath**: nothing new arrives, only drifts move (the music drops out) |
| 5.3& | 10.9–11.4 | 327–342 | The offer type falls toward the button; **the field collapses into the CTA pill** |
| 5.4 | 11.4 | 342 | The pill lands; the brand finishes its flight into the logo at 11.533 |
| 6.1 | 12.0 | 360 | Downbeat: end card building (bowl arc closed, offer row rising) |
| 6.3 | 13.2 | 396 | **Final CTA pulse** 1.08 → 0.985 → 1 (overshoot accent 3 of 3), plus a ripple and an arrow nudge |
| 6.4 | 13.8 | 414 | Echo arrow nudge |
| end | 14.4 | 432 | Clean, settled last frame (rendered frame 431 = 14.367) |

---

## 3. Conventions for every package

### 3.1 Easing tokens

The keyframe tables use these tokens. The JSON carries the full strings.

| Token | String passed to `figma_set_keyframes` | Use |
|---|---|---|
| L | `LINEAR` | holds, drifts, cut pairs |
| OUT | `cubic:0.16,1,0.3,1` | arrivals (expo-out) |
| IN | `cubic:0.7,0,0.84,0` | exits and collapses (accelerating) |
| WHIP | `cubic:0.83,0,0.17,1` | the disc's grow, the field collapse, the logo flight |
| SOFT | `cubic:0.45,0,0.55,1` | settles, blur ramps, dims |
| DRAW | `cubic:0.65,0,0.35,1` | trim-path draws |
| QOUT | `cubic:0.3,0,0.2,1` | anticipations, the radius snap |
| IRIS | `cubic:0.6,0,0.2,1` | the bloom: slow seed, fast spread, soft land |
| SLOW | `cubic:0.25,0.6,0.15,1` | the deliberately soft "Slow" tracking collapse |
| LOCK | `cubic:0.7,0,0.2,1` | the "Moku" tracking lock |
| SWELL | `cubic:0.33,0,0.67,1` | 2-frame scale punches |
| FADE | `cubic:0.2,0,0.6,1` | the ripple fade |

### 3.2 Notation

`@t value EASE · @t value EASE …`. The EASE on a key shapes the move **into** that key; the first key has none. XY values are written `x,y`. `TRANSLATION_*` is added to the resting position, and `SCALE_*` multiplies around the node's own centre. Two equal keys in a row hold the value until the second key's time.

### 3.3 Cut pairs: frame-exact jumps, never HOLD

A jump at frame k is two LINEAR keys: the old value at k/30 − 0.025 and the new value at k/30 − 0.005. Frame k−1 shows the old value and frame k shows the new one. For example, `@3.575 0 L · @3.595 1 L` switches on at frame 108 (3.6 s).

This was measured on this account: Figma samples frame k at exactly t = k/30, and its `cubic:` equals CSS cubic-bezier. The measurement came from the current ad's MP4, frames 89–96. It is not yet a claims-registry entry; only the main agent may add it.

No track uses `HOLD`.

### 3.4 Resting state

Every node rests in its built, visible layout with **resting opacity 1**. Hiding is done only with keyframes. A resting opacity of 0 makes `figma_export_node` return 1 × 1 (the inventory's rendering trap).

Two containers export misleadingly at rest:

- **S1** shows the wheel (disc and photo) over "Slow".
- **S3** shows the full terracotta bloom.

For S1, export `S1/Window`, `S1/Slow`, `S1/Down` and `S1/By hand` separately. For S3, export `S3/Content`.

### 3.5 Masks and rows

- **A mask** is a FRAME with clipsContent true, no fill and **no auto-layout**. It holds exactly one TEXT node, placed at the stated local x, y.
- **Auto-layout is used only for the five rows whose `STACK_SPACING` animates:** `Brand bug`, `S1/Slow`, `S3/Kicker`, `S5/Ten` and `S4/Logo`. Each gets an explicit FIXED width and FIXED height, because turning auto-layout on leaves the primary axis hugging unless a size is given [C-125].
- **The children of those rows never receive TRANSLATION keys.** In `S5/Ten`, the children are masks; their texts translate inside the masks, which are plain frames.

### 3.6 Fonts and colours

There are two families only:

- **Cormorant Garamond:** SemiBold, Medium and Medium Italic.
- **Inter:** Regular, Medium and Semi Bold. Use the style name `figma_get_fonts` returns ("Semi Bold" or "SemiBold").

Line heights are in px as given. Letter spacing is 0 unless stated.

| Token | Hex | Variable (bind static fills; keep keyframed fills as raw hex) |
|---|---|---|
| cream | `#fbf9f6` | color/bg/page |
| linen | `#f4efe7` | color/bg/subtle |
| clay | `#d6cab8` | color/text/inverse-muted |
| terracotta | `#a4532f` | color/accent/default |
| stone | `#4a443c` | color/text/secondary |
| ink | `#1f1c18` | color/bg/inverse |
| white | `#ffffff` | color/text/inverse |

The underlay greys `#bdbdb3`, `#c6c7c6` and `#e8e2da` sit only beneath photos.

### 3.7 Images

The photos are IMAGE fills on rectangles: `figma_set_fills` with `{ type: "IMAGE", imageHash, scaleMode: "FILL" }`. **Never download images.**

| # | imageHash | Used in |
|---|---|---|
| 3 | `90925717d81d67ef050ae9f0aa1e478d8fdb50da` | S1/Photo (hand-built vessels) |
| 7 | `e6467ef2ad5881493d047570d9e0f6c627961b18` | S1/Hands (hands on the wheel) |
| 2 | `b1e64fd760af16e36d356c2d758139152a48ad21` | S2/Vase photo (Ash Vase) |
| 11 | `acbb852e49aa6f3b180839fb60dd57da0906ada4` | S3/Mug |
| 13 | `b6f9ac8e82fed12a9a25b9f6e1b154011293e70a` | S3/Plates |
| 12 | `5992035e9601a007ca539c5fc8f2d4959a847124` | S3/Bowl |

### 3.8 Effects

Every node that has an `effect:0:RADIUS` track first gets exactly one effect: a `LAYER_BLUR` with radius 0, set with `figma_set_effects`. If 0 is refused, use 0.1 for the effect and for every key written as 0 on that track. Each package lists its nodes. No other effects are used anywhere.

### 3.9 Constraints

Every child of a frame whose WIDTH or HEIGHT animates gets constraints horizontal LEFT and vertical TOP (`figma_set_constraints`). This applies to: `S1/Photo`, `S1/Hands`, `S2/Push`, `S2/Plate clay` and `S2/Plate terracotta`.

### 3.10 SVG strokes

Each SVG is imported with `figma_import_svg`, with `width`, `height` and `viewBox` always given [C-086]. The result is a wrapper FRAME holding one VECTOR per path.

- Rename the wrapper and its vectors exactly as the tables say.
- Remove any fill on the wrapper and set its clipsContent to false.
- Keyframe the **VECTOR** children for trims, opacity and rotation, and the wrapper only where a table says so.

Caps:

- **Round caps** are used only on the ring, the loop, the bowl arc and the arrow. Each carries an OPACITY guard that keeps it hidden while its length is zero.
- **The dimension line and ticks use butt caps**, so they need no guard.

### 3.11 Keyframing

- Make one `figma_set_keyframes` call per layer, carrying all of that layer's tracks.
- **The first call of every package passes `timelineDuration: 14.4`.** Every package passes the same value, so the result is the same whoever runs first.
- Never keyframe the top-level frame.
- Copy the values from the JSON. The tables in section D are the same data.

### 3.12 Rendering

A video render blocks the plugin for minutes. **Packages never call `figma_export_video` while building.** They check layout with `figma_export_node` stills of their own nodes only. One verification render runs after every package is done (section E).

### 3.13 Safe zones

- All text, the logo and the CTA lie between screen y 304 (the top of the "Moku" glyphs) and y 1500 (the "down." baseline).
- Every text box lies between x 64 and x 1016.
- Only shapes, photos and colour fields enter the top 250 px or the bottom 340 px.
- No Inter text is smaller than 28 px.

---

## A. Frame

| Property | Value |
|---|---|
| Name | **`Moku — IG Story Ad v2 (motion)`** (the separator is an em dash) |
| Type / parent | FRAME, a top-level child of Page 1 (`0:1`) |
| Position, size | x **6280**, y **3200**, **1080 × 1920**. The spot is clear: the current ad ends at x 6080, and nothing lies right of it or below it. |
| Background | fill `#fbf9f6`, bound to `color/bg/page` |
| clipsContent | **true** |
| Auto-layout | none |
| Timeline | **14.4 s**, set by `timelineDuration: 14.4` on each package's first `figma_set_keyframes` call |
| fps | **30** for export (`figma_export_video` `fps: 30`) |
| BPM | **100**. Beat times in s: 0, 0.6, 1.2, 1.8, 2.4, 3.0, 3.6, 4.2, 4.8, 5.4, 6.0, 6.6, 7.2, 7.8, 8.4, 9.0, 9.6, 10.2, 10.8, 11.4, 12.0, 12.6, 13.2, 13.8, 14.4. Downbeats: 0, 2.4, 4.8, 7.2, 9.6, 12.0. |
| Never touch | `30:14651` / `30:14989` (the current ad, one node with two ids). After keyframing, this frame may also show a twin id; that is the same node. |

---

## B. Container tree (z-order, bottom to top)

There are no global background layers: the frame's own cream fill is the background. Five containers follow, then one global overlay. Each container is a FRAME, **1080 × 1920 at (0, 0), no fill, clipsContent false**.

```
Moku — IG Story Ad v2 (motion)                    fill #fbf9f6, clip, never keyframed
├─ S1 · Hook              visible 0 – 3.6      "Slow down.", the dot, the wheel disc, "By hand."
├─ S2 · Ash Vase          visible 3.6 – 6.0    band burst from the dot, headline, $48, specs, push-through
├─ S3 · Collection        visible 6.0 – 9.6    arch window with 3 products, list, bloom circles (top of S3)
├─ S4 · End card          visible 9.633 – 14.4 ink ground, logo, bowl arc, tagline, offer row, URL, footer
│                                              (switched on under S5's full field; revealed 11.0 – 11.4)
├─ S5 · Offer + CTA       visible 9.6 – 14.4   terracotta field (offer ground, then the CTA pill), offer type, CTA label
└─ Brand bug              global overlay, 0 – 11.533: "Moku" wordmark; flies into S4/Logo
```

**Why S4 sits under S5.** The terracotta field in S5 is the offer's ground and then collapses into the CTA pill. Whatever it reveals must lie beneath it, so the end card (S4) sits under S5, and the CTA label sits in S5 above the pill.

Each container is switched on and off by frame-exact OPACITY cut pairs on the container itself. Every switch happens under full cover or onto a pixel-identical picture (section C).

---

## C. Packages

| Key | Package | Owns (container) | Active (s) | Nodes it creates |
|---|---|---|---|---|
| RIG | Frame, containers, brand overlay | the top-level frame, creates the 5 empty containers, `Brand bug` + 4 letters | 0 – 14.4 | 11 |
| S1 | Hook and wheel | `S1 · Hook` and everything inside | 0 – 3.633 | 31 |
| S2 | Ash Vase | `S2 · Ash Vase` and everything inside | 3.6 – 6.033 | 39 |
| S3 | Collection | `S3 · Collection` and everything inside | 6.0 – 9.633 | 42 |
| S4 | End card | `S4 · End card` and everything inside | 9.633 – 14.4 | 26 |
| S5 | Offer and CTA | `S5 · Offer + CTA` and everything inside | 9.6 – 14.4 | 26 |

**Order of work.**

1. **RIG phase 0 runs first and alone:**
   - Create the frame.
   - Create the five empty containers in the z-order of section B. **Each container gets no keyframes from RIG.**
   - Create the `Brand bug` row (and its four letters) as the topmost child.
2. **Then all six packages run in parallel, including RIG phase 1** (the bug's keyframes). Each scene package:
   - finds its container by exact name (`figma_search_nodes` inside the frame);
   - builds its layers;
   - keyframes the container node itself (its OPACITY switch) as well as everything inside it.

No layer is owned by two packages. A package never edits a node outside its container, and RIG never edits inside a container.

**Cross-package timing** (stated again in each package's block):

| Frame (t) | Event | Packages | Must hold |
|---|---|---|---|
| 108 (3.6) | **Dot handoff.** `S1/Wheel` lands at Ø 96, centred on (384, 1180), blur 0. `S2 · Ash Vase` switches on at this frame. | S1, S2 | S2's `S2/BG` is cream and its `S2/Band window` is a Ø 96 circle at (384, 1180), filled by the terracotta plate. The picture is identical to S1's last state. |
| 109 (3.633) | `S1 · Hook` switches off (already covered by S2) | S1 | none |
| 180 (6.0) | **Push-through cut.** `S2/Content` ends its dive at 2.6×, blur 18. `S3 · Collection` switches on with `S3/Content` at 0.82×, blur 18. | S2, S3 | velocity-matched: the blur is continuous across the cut |
| 181 (6.033) | `S2 · Ash Vase` switches off (under S3's opaque linen) | S2 | none |
| 283 (9.433) | **Bug colour flip.** S3's terracotta bloom edge has passed the whole wordmark (bloom radius 1058 vs. 978 px to the farthest glyph point), so the `Bug/*` fills turn ink → white. | S3, RIG | frame 282: the bug lies on cream; frame 283: the bug lies on terracotta |
| 288 (9.6) | **Field handoff.** `S3/Terracotta circle` is at full size (r 1500, centre (324, 1238); the farthest corner is 1451 px). `S5 · Offer + CTA` switches on with `S5/Field` full-frame terracotta. | S3, S5 | identical full terracotta |
| 289 (9.633) | `S3 · Collection` switches off; `S4 · End card` switches on (both under S5's field) | S3, S4 | none |
| 330–342 (11.0–11.4) | `S5/Field` collapses into the pill (640 × 120 at (220, 1100)), revealing S4's ink end card | S5, S4 | S4's logo position (y 486–714) is clear of the pill |
| 333–346 (11.1–11.533) | `Brand bug` flies from centre (540, 328) to (540, 600) and scales 1 → 3 | RIG, S4 | — |
| 346 (11.533) | **Logo swap.** `Brand bug` switches off and `S4/Logo` switches on, on the same frame and at the same place, size and colour (white) | RIG, S4 | the logo is exactly the bug × 3: 192 px letters, spacing 12, centre (540, 600) |

---

## D. Packages in detail

### D.1 RIG: frame, containers, brand overlay

**Layers**

| Layer | Type | Parent | x, y | w × h | Paint / stroke / effects | Text and type |
|---|---|---|---|---|---|---|
| Moku — IG Story Ad v2 (motion) | FRAME | Page 1 (`0:1`) | 6280, 3200 (page) | 1080 × 1920 | fill `#fbf9f6` (bound to `color/bg/page`); clipsContent true; no auto-layout | — |
| S1 · Hook | FRAME | top-level frame | 0, 0 | 1080 × 1920 | no fill; clipsContent false | container 1 (bottom) |
| S2 · Ash Vase | FRAME | top-level frame | 0, 0 | 1080 × 1920 | no fill; clipsContent false | container 2 |
| S3 · Collection | FRAME | top-level frame | 0, 0 | 1080 × 1920 | no fill; clipsContent false | container 3 |
| S4 · End card | FRAME | top-level frame | 0, 0 | 1080 × 1920 | no fill; clipsContent false | container 4 |
| S5 · Offer + CTA | FRAME | top-level frame | 0, 0 | 1080 × 1920 | no fill; clipsContent false | container 5 |
| Brand bug | FRAME, auto-layout HORIZONTAL | top-level frame (topmost child) | 64, 290 | 952 × 76, FIXED width and height | no fill; clipsContent false; primary align CENTER; counter align CENTER; itemSpacing **4** (rest); padding 0 | centre (540, 328) |
| Bug/M, Bug/o, Bug/k, Bug/u | TEXT × 4 | Brand bug (in this order) | auto-layout | auto × 76 | fill `#1f1c18`, raw hex (keyframed; do not bind) | "M", "o", "k", "u"; Cormorant Garamond **SemiBold 64**; LH 76 px; LS 0; left |

The glyphs sit at about screen y 304–348 and x 465–615 at rest spacing.

**Build notes**

1. Create the containers in the order S1, S2, S3, S4, S5, then `Brand bug` last, so the bug is topmost.
2. The bug's row width is FIXED at 952, so the bug always pivots on (540, 328), whatever its spacing. Its SCALE happens only after its spacing has stopped animating (spacing is still from 1.8 s on).

**Keyframes** (timeline 14.4; the first call passes `timelineDuration: 14.4`)

| Layer | Field | Keys (`@t value EASE`, absolute seconds; EASE shapes the move into that key) |
|---|---|---|
| **Brand bug**<br><sub>tracking locks on beat 1.8 (centre brand moment); flies + scales 3x into the logo 11.1-11.533; hidden on frame 346 when S4/Logo appears</sub> | `STACK_SPACING` | @0 48 · @1.4 40 L · @1.8 4 LOCK |
|  | `SCALE_XY` | @0 1,1 · @11.1 1,1 L · @11.5333 3,3 WHIP |
|  | `TRANSLATION_Y` | @0 0 · @11.1 0 L · @11.5333 272 WHIP |
|  | `OPACITY` | @0 1 · @11.5083 1 L · @11.5283 0 L |
| **Bug/M**<br><sub>ink to white on frame 283: the frame the S3 terracotta bloom's edge has passed the whole bug</sub> | `fill:0` | @0 #1f1c18 · @9.4083 #1f1c18 L · @9.4283 #ffffff L |
| **Bug/o** | `fill:0` | @0 #1f1c18 · @9.4083 #1f1c18 L · @9.4283 #ffffff L |
| **Bug/k** | `fill:0` | @0 #1f1c18 · @9.4083 #1f1c18 L · @9.4283 #ffffff L |
| **Bug/u** | `fill:0` | @0 #1f1c18 · @9.4083 #1f1c18 L · @9.4283 #ffffff L |

LAYER_BLUR (radius 0) required before keyframing, on: none.


**Cross-package timing:**

- f283: the colour flip relies on S3's bloom (S3 owns the bloom).
- f346: the bug switches off on the same frame `S4/Logo` switches on (S4 owns the logo).

**Mechanism check and fallback.** In the verification render, frame 0 must show "M o k u" widely spaced, and 1.8 s must show it tight.

If the spacing does not change (STACK_SPACING not reflowing):

1. Turn auto-layout off on `Brand bug`. The letters keep their positions.
2. Delete its STACK_SPACING track.
3. Key TRANSLATION_X on each letter: (i − 1.5) × (spacing − 4) for i = 0..3.

| Letter | @0 | @1.4 | @1.8 (LOCK) |
|---|---|---|---|
| M | −66 | −54 | 0 |
| o | −22 | −18 | 0 |
| k | 22 | 18 | 0 |
| u | 66 | 54 | 0 |

---

### D.2 S1: Hook and wheel (`S1 · Hook`, 0 – 3.633)

The hook circle centre is **C1 = (540, 1070)**: the centre of the counter of the "o" of "Slow". Everything round in S1 is centred on C1.

**Layers** (z-order bottom to top: `S1/Window`, `S1/Slow`, `S1/Down`, `S1/Wheel`, `S1/By hand`)

| Layer | Type | Parent | x, y | w × h | Paint / stroke / effects | Text and type / notes |
|---|---|---|---|---|---|---|
| S1/Window | FRAME | S1 · Hook | 300, 400 | 480 × 560 | fill `#bdbdb3`; clipsContent true; radius 0; LAYER_BLUR 0 | image window, screen x 300–780, y 400–960 |
| S1/Photo | RECT | S1/Window | −110, −250 | 700 × 1050 | IMAGE #3 `90925717d81d67ef050ae9f0aa1e478d8fdb50da`, FILL; constraints LEFT/TOP | #3 at 0.5×: the three vessels sit at screen y ≈ 575–760, with the plinth below |
| S1/Slow | FRAME, auto-layout HORIZONTAL | S1 · Hook | 64 + dx, 783 | 952 × 480, FIXED both axes | no fill; clipsContent false; primary CENTER; counter MIN (top); itemSpacing **−8** (rest); padding 0 | dx from build note 1 (expected about −2) |
| S1/Slow/S, S1/Slow/l, S1/Slow/o, S1/Slow/w | TEXT × 4 | S1/Slow | auto-layout | auto × 480 | `#1f1c18` | "S", "l", "o", "w"; Cormorant Garamond **SemiBold 400**; LH 480; LS 0. Baseline at screen y 1150. |
| S1/Down | FRAME | S1 · Hook | 64, 1170 | 952 × 432 | no fill; clipsContent false | plain frame (it carries the punch); baseline at screen y 1500 |
| S1/Down/d-mask, S1/Down/o-mask, S1/Down/w-mask, S1/Down/n-mask, S1/Down/.-mask | FRAME × 5 | S1/Down | x_i, 0 | (w_i + 72) × 432 | clipsContent true; no fill | x_d = (952 − Σw)/2 − 36; x_{i+1} = x_i + w_i (letters d, o, w, n, .) |
| S1/Down/d, S1/Down/o, S1/Down/w, S1/Down/n, S1/Down/. | TEXT × 5 | its mask | 36, 0 | auto × 432 | `#a4532f`; LAYER_BLUR 0 | "d", "o", "w", "n", "."; Cormorant Garamond **Medium Italic 360**; LH 432; LS 0 |
| S1/Wheel | FRAME | S1 · Hook | 60, 590 | 960 × 960 | no fill; clipsContent false; LAYER_BLUR 0 | its centre is C1; it is the dot, the disc and the collapse in one transform |
| S1/Ring | FRAME (SVG R1) | S1/Wheel | 0, 0 | 960 × 960 | no fill; clipsContent false | wrapper; its SCALE is keyed |
| S1/Ring path | VECTOR | S1/Ring | from SVG | from SVG | stroke `#a4532f` 3, round caps, no fill | circle r 478 starting at 12 o'clock, clockwise |
| S1/Disc | ELLIPSE | S1/Wheel | 40, 40 | 880 × 880 | `#a4532f` | the circle of clay (no keys of its own) |
| S1/Clay band | ELLIPSE | S1/Wheel | 80, 80 | 800 × 800 | `#d6cab8` | — |
| S1/Cream band | ELLIPSE | S1/Wheel | 80, 80 | 800 × 800 | `#fbf9f6` | — |
| S1/Iris | FRAME | S1/Wheel | 80, 80 | 800 × 800 | no fill; clipsContent true; corner radius 400; LAYER_BLUR 0 | photo iris |
| S1/Hands | RECT | S1/Iris | −320, −100 | 1400 × 933 | IMAGE #7 `e6467ef2ad5881493d047570d9e0f6c627961b18`, FILL (native 1.0×); constraints LEFT/TOP | the clay cylinder (photo px 720, 500) lands on the iris centre |
| S1/By hand | FRAME | S1 · Hook | 64, 404 | 952 × 158 | no fill; clipsContent false | glyphs at screen y ≈ 434–575 |
| S1/By-mask | FRAME | S1/By hand | xBy, 0 | (wBy + 48) × 158 | clipsContent true | xBy = (952 − (wBy + 33 + whand))/2 − 24 |
| S1/By | TEXT | S1/By-mask | 24, 0 | auto × 158 | `#1f1c18`; LAYER_BLUR 0 | "By"; Cormorant Garamond **Medium Italic 132**; LH 158 |
| S1/hand.-mask | FRAME | S1/By hand | xBy + wBy + 33, 0 | (whand + 48) × 158 | clipsContent true | — |
| S1/hand. | TEXT | S1/hand.-mask | 24, 0 | auto × 158 | `#a4532f`; LAYER_BLUR 0 | "hand."; Cormorant Garamond **Medium Italic 132**; LH 158 |

**SVG R1 (S1/Ring):**

```
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="960" viewBox="0 0 960 960"><path d="M480 2 C744 2 958 216 958 480 C958 744 744 958 480 958 C216 958 2 744 2 480 C2 216 216 2 480 2" fill="none" stroke="#a4532f" stroke-width="3" stroke-linecap="round"/></svg>
```

**Build notes**

1. **Register the "o" on C1.**
   - Build `S1/Slow` at (64, 783) with itemSpacing −8.
   - Read `S1/Slow/o` with `figma_get_node`: cx = absoluteX + width/2 − 6280.
   - Set the row's x to 64 + (540 − cx). Its y stays 783: the counter centre lies 287 px below the row top, which puts it at 1070.
   - Re-read until |cx − 540| ≤ 1. Do **not** toggle visibility to check this; check it numerically.
2. **Frame-0 spacing.** Σw = the sum of the four letter widths. The first STACK_SPACING key is s0 = min(56, floor((952 − Σw)/3)). The JSON uses **54**, which assumes Σw ≈ 790; if your s0 differs, change only that first value.
3. **"down." masks.** Measure the five letter widths w_i and place the masks by the rule in the table. Glyph gaps are 0; overlapping masks are fine.
4. **"By hand.".** Measure wBy and whand. The word space is 33 px.
5. **Import SVG R1** into `S1/Wheel` at (0, 0), then rename the wrapper `S1/Ring` and the vector `S1/Ring path`. Keep the child order inside `S1/Wheel`, bottom to top: Ring, Disc, Clay band, Cream band, Iris.
6. **Constraints:** LEFT/TOP on `S1/Photo` and `S1/Hands`.
7. **LAYER_BLUR 0** on the nodes listed under the keyframes.
8. **Layout check.** Use `figma_export_node` on `S1/Window`, `S1/Slow`, `S1/Down` and `S1/By hand`. The container itself shows the wheel over the word at rest (3.4).

**Keyframes**

| Layer | Field | Keys (`@t value EASE`, absolute seconds; EASE shapes the move into that key) |
|---|---|---|
| **S1 · Hook**<br><sub>container: off on frame 109, one frame after S2 has covered it</sub> | `OPACITY` | @0 1 · @3.6083 1 L · @3.6283 0 L |
| **S1/Window**<br><sub>slit opens from its centre (240 -> 480); then the bottom edge rises shut (blind) on the disc's grow</sub> | `WIDTH` | @0 240 · @0.5 480 OUT |
|  | `TRANSLATION_X` | @0 120 · @0.5 0 OUT |
|  | `HEIGHT` | @0 560 · @1.9 560 L · @2.2 0 IN |
|  | `effect:0:RADIUS` | @0 0 · @2.1 0 L · @2.1667 10 SOFT |
|  | `OPACITY` | @0 1 · @2.175 1 L · @2.195 0 L |
| **S1/Photo**<br><sub>counter-translation keeps the image screen-locked while the slit opens; continuous pull-back</sub> | `TRANSLATION_X` | @0 -120 · @0.5 0 OUT |
|  | `SCALE_XY` | @0 1.12,1.12 · @0.5 1.05,1.05 OUT · @1.9 1,1 L |
| **S1/Slow**<br><sub>tracking collapse on the soft 'slow' curve; then the letters are sucked toward the growing disc; cut under full cover</sub> | `STACK_SPACING` | @0 54 · @0.6 -8 SLOW · @1.9 -6 L · @2.3 -40 IN |
|  | `OPACITY` | @0 1 · @2.375 1 L · @2.395 0 L |
| **S1/Down**<br><sub>plain frame: 2-frame scale punch on beat 1.2, then drift</sub> | `SCALE_XY` | @0 1,1 · @1.2 1,1 L · @1.2667 1.06,1.06 SWELL · @1.6 1,1 OUT |
|  | `TRANSLATION_Y` | @0 0 · @1.2667 0 L · @1.8 -10 L |
| **S1/Down/d**<br><sub>per-letter drop from above, 2-frame stagger, blur on the fastest frames; falls out downward 1.8-2.267</sub> | `TRANSLATION_Y` | @0 -432 · @0.6 -432 L · @1 0 OUT · @1.8 0 L · @2 432 IN |
|  | `effect:0:RADIUS` | @0 0 · @0.6 0 L · @0.6333 10 L · @0.7333 0 SOFT · @1.9 0 L · @1.9667 10 SOFT |
| **S1/Down/o** | `TRANSLATION_Y` | @0 -432 · @0.6667 -432 L · @1.0667 0 OUT · @1.8667 0 L · @2.0667 432 IN |
|  | `effect:0:RADIUS` | @0 0 · @0.6667 0 L · @0.7 10 L · @0.8 0 SOFT · @1.9667 0 L · @2.0333 10 SOFT |
| **S1/Down/w** | `TRANSLATION_Y` | @0 -432 · @0.7333 -432 L · @1.1333 0 OUT · @1.9333 0 L · @2.1333 432 IN |
|  | `effect:0:RADIUS` | @0 0 · @0.7333 0 L · @0.7667 10 L · @0.8667 0 SOFT · @2.0333 0 L · @2.1 10 SOFT |
| **S1/Down/n** | `TRANSLATION_Y` | @0 -432 · @0.8 -432 L · @1.2 0 OUT · @2 0 L · @2.2 432 IN |
|  | `effect:0:RADIUS` | @0 0 · @0.8 0 L · @0.8333 10 L · @0.9333 0 SOFT · @2.1 0 L · @2.1667 10 SOFT |
| **S1/Down/.** | `TRANSLATION_Y` | @0 -432 · @0.8667 -432 L · @1.2667 0 OUT · @2.0667 0 L · @2.2667 432 IN |
|  | `effect:0:RADIUS` | @0 0 · @0.8667 0 L · @0.9 10 L · @1 0 SOFT · @2.1667 0 L · @2.2333 10 SOFT |
| **S1/Wheel**<br><sub>the circle of clay: dot pops in the 'o' (overshoot accent 1 of 3), anticipates, grows to the 880 disc on the 2.4 downbeat, anticipates +5 %, collapses to a 96 dot on the vase belly (384, 1180) on 3.6</sub> | `OPACITY` | @0 0 · @1.475 0 L · @1.495 1 L |
|  | `SCALE_XY` | @0 0.001,0.001 · @1.5 0.001,0.001 L · @1.6 0.1023,0.1023 OUT · @1.7 0.0777,0.0777 SOFT · @1.8 0.0818,0.0818 SOFT · @1.9 0.0655,0.0655 QOUT · @2.4 1,1 WHIP · @3.1667 1.02,1.02 L · @3.2667 1.05,1.05 QOUT · @3.6 0.1091,0.1091 IN |
|  | `TRANSLATION_XY` | @0 0,0 · @3.2667 0,0 L · @3.6 -156,110 IN |
|  | `effect:0:RADIUS` | @0 0 · @3.4 0 L · @3.5667 8 SOFT · @3.6 0 L |
| **S1/Ring**<br><sub>follow-through: the ring lags the disc's landing, overshoots, settles</sub> | `SCALE_XY` | @0 0.94,0.94 · @2.5667 0.94,0.94 L · @2.8 1.02,1.02 OUT · @3.0333 1,1 SOFT |
| **S1/Ring path**<br><sub>trim-path ring drawn round the wheel, spinning clockwise; guarded while zero length</sub> | `OPACITY` | @0 0 · @2.575 0 L · @2.595 1 L · @3.3417 1 L · @3.3617 0 L |
|  | `PATH_TRIM_END` | @0 0 · @2.5667 0 L · @3.1 1 DRAW |
|  | `PATH_TRIM_START` | @0 0 · @3.1333 0 L · @3.3667 1 IN |
|  | `ROTATION` | @0 0 · @2.5667 0 L · @3.3667 -60 L |
| **S1/Clay band**<br><sub>stacked concentric burst 1 of 3 (on the downbeat); closes last</sub> | `OPACITY` | @0 0 · @2.4083 0 L · @2.4283 1 L · @3.5083 1 L · @3.5283 0 L |
|  | `SCALE_XY` | @0 0.0025,0.0025 · @2.4 0.0025,0.0025 L · @2.9 1,1 OUT · @3.3667 1,1 L · @3.5333 0.0025,0.0025 IN |
| **S1/Cream band**<br><sub>burst 2 of 3, 2 frames later</sub> | `OPACITY` | @0 0 · @2.475 0 L · @2.495 1 L · @3.475 1 L · @3.495 0 L |
|  | `SCALE_XY` | @0 0.0025,0.0025 · @2.4667 0.0025,0.0025 L · @2.9667 1,1 OUT · @3.3333 1,1 L · @3.5 0.0025,0.0025 IN |
| **S1/Iris**<br><sub>burst 3 of 3: photo iris, 4 frames after the clay; radius keyed = width/2 (no clamping relied on); closes first</sub> | `OPACITY` | @0 0 · @2.5083 0 L · @2.5283 1 L · @3.4417 1 L · @3.4617 0 L |
|  | `WIDTH` | @0 2 · @2.5333 2 L · @3.0333 800 OUT · @3.3 800 L · @3.4667 2 IN |
|  | `HEIGHT` | @0 2 · @2.5333 2 L · @3.0333 800 OUT · @3.3 800 L · @3.4667 2 IN |
|  | `CORNER_RADIUS` | @0 1 · @2.5333 1 L · @3.0333 400 OUT · @3.3 400 L · @3.4667 1 IN |
|  | `TRANSLATION_XY` | @0 399,399 · @2.5333 399,399 L · @3.0333 0,0 OUT · @3.3 0,0 L · @3.4667 399,399 IN |
|  | `effect:0:RADIUS` | @0 0 · @3.3667 0 L · @3.4333 8 SOFT |
| **S1/Hands**<br><sub>exact counter of the iris translation (screen-locked) + 6 % camera push</sub> | `TRANSLATION_XY` | @0 -399,-399 · @2.5333 -399,-399 L · @3.0333 0,0 OUT · @3.3 0,0 L · @3.4667 -399,-399 IN |
|  | `SCALE_XY` | @0 1,1 · @2.5333 1,1 L · @3.4667 1.06,1.06 L |
| **S1/By**<br><sub>per-word rise, exits upward</sub> | `TRANSLATION_Y` | @0 158 · @2.4333 158 L · @2.8333 0 OUT · @3.2 0 L · @3.4 -158 IN |
|  | `effect:0:RADIUS` | @0 0 · @2.4333 0 L · @2.4667 8 L · @2.5667 0 SOFT |
| **S1/hand.** | `TRANSLATION_Y` | @0 158 · @2.5 158 L · @2.9 0 OUT · @3.2333 0 L · @3.4333 -158 IN |
|  | `effect:0:RADIUS` | @0 0 · @2.5 0 L · @2.5333 8 L · @2.6333 0 SOFT |

LAYER_BLUR (radius 0) required before keyframing, on: `S1/Window`, `S1/Down/d`, `S1/Down/o`, `S1/Down/w`, `S1/Down/n`, `S1/Down/.`, `S1/Wheel`, `S1/Iris`, `S1/By`, `S1/hand.`.


**Cross-package timing:**

- At f108 (3.6), `S1/Wheel` must be Ø 96 (scale 0.1091 of the 880 disc) centred on **(384, 1180)** = C1 + (−156, +110), with blur 0. `S2 · Ash Vase` switches on at that frame with an identical dot.
- `S1 · Hook` switches off at f109.

**What each beat shows** (for self-checking stills):

- 0.0: slit 240 wide, "S l o w" tracked.
- 1.5–1.8: the dot pops (Ø 0 → 90 → 68 → 72) and anticipates to Ø 58 by 1.9.
- 1.9–2.4: the disc swells to Ø 880 on WHIP. The main growth is 2.1–2.25; "Slow" is sucked in (spacing → −40) and cut at f72 under full cover.
- 2.4 / 2.467 / 2.533: clay, cream and the photo burst concentrically.
- 2.567–3.1: the ring draws on. It spins −60° in total by 3.367 and is erased 3.133–3.367.
- 2.4–3.167: the wheel drifts 1 → 1.02. From 3.167 to 3.267 it anticipates to 1.05.
- 3.3–3.533: the iris, cream and clay close inside it, 1 frame apart, at nearly full size.
- 3.267–3.6: the wheel collapses on IN and travels to the belly; most of the move falls in the last 3 frames (scale 0.82 at 3.533, 0.57 at 3.567, 0.109 at 3.6).

**Mechanism checks and fallbacks** (applied after the verification render):

- **The "Slow" tracking does not change** (letters frozen at 0 to 0.6 s): turn auto-layout off on `S1/Slow`, delete STACK_SPACING, and key TRANSLATION_X per letter = (i − 1.5) × (spacing + 8):

  | Letter | @0 | @0.6 (SLOW) | @1.9 (L) | @2.3 (IN) |
  |---|---|---|---|---|
  | S | −93 | 0 | −3 | +48 |
  | l | −31 | 0 | −1 | +16 |
  | o | +31 | 0 | +1 | −16 |
  | w | +93 | 0 | +3 | −48 |

- **The photo slides inside the iris** while it opens or closes (the counter-translation fails):
  1. Replace `S1/Iris` with an ELLIPSE "S1/Iris" 800 × 800 at (80, 80).
  2. Set it as a mask (`figma_set_mask`), with `S1/Hands` directly above it in the same parent.
  3. Delete the Hands TRANSLATION_XY track.
  4. Give the ellipse `SCALE_XY @0 0.0025,0.0025 · @2.5333 0.0025,0.0025 L · @3.0333 1,1 OUT · @3.3 1,1 L · @3.4667 0.0025,0.0025 IN` and the same OPACITY track.
- **The vessels slide while the slit opens:** delete the TRANSLATION_X tracks of `S1/Window` and `S1/Photo`. The slit then opens left to right from x 300, which is acceptable.

---

### D.3 S2: Ash Vase (`S2 · Ash Vase`, 3.6 – 6.033)

The vase belly **B = (384, 1180)** is where the dot lands and the anchor of the push-through.

**Layers** (z-order bottom to top: `S2/BG`, `S2/Content` › [`S2/Band window` › [`S2/Push` › [Vase photo, Warm, Dim line, Tick top, Tick bottom, 32 cm-mask], Plate clay, Plate terracotta], `S2/Type` › [Headline, Price, Spec 1-mask, Spec 2-mask]])

| Layer | Type | Parent | x, y | w × h | Paint / stroke / effects | Text and type / notes |
|---|---|---|---|---|---|---|
| S2/BG | RECT | S2 · Ash Vase | 0, 0 | 1080 × 1920 | `#fbf9f6` | covers S1 from f108 |
| S2/Content | FRAME | S2 · Ash Vase | 0, 0 | 1080 × 1920 | no fill; clipsContent false; LAYER_BLUR 0 | carries the push-through (pivot = its centre, 540, 960) |
| S2/Band window | FRAME | S2/Content | 0, 540 | 1080 × 1040 | fill `#c6c7c6`; clipsContent true; radius 0; LAYER_BLUR 0 | image band, screen y 540–1580 |
| S2/Push | FRAME | S2/Band window | 0, 0 | 768 × 1280 | no fill; clipsContent false; constraints LEFT/TOP | its centre (384, 640) is screen B, the pivot of its 4 % push |
| S2/Vase photo | RECT | S2/Push | −90, −20 | 1400 × 1120 | IMAGE #2 `b1e64fd760af16e36d356c2d758139152a48ad21`, FILL (native 1.0×) | the vase sits at screen x 170–600, rim y 800, base y 1410, belly centre B |
| S2/Warm | RECT | S2/Push | −90, −20 | 1400 × 1120 | fill `#f4efe7`; layer blend **MULTIPLY** (`figma_set_blend_mode`) | warms the cool grey seamless |
| S2/Dim line | FRAME (SVG D1) | S2/Push | 618, 258 | 4 × 614 | no fill | screen x 620, y 800 → 1410 |
| S2/Dim line path | VECTOR | S2/Dim line | from SVG | from SVG | stroke `#a4532f` 3, butt caps | the path runs bottom → top |
| S2/Tick top | FRAME (SVG D2) | S2/Push | 604, 258 | 32 × 4 | no fill | screen y 800 |
| S2/Tick top path | VECTOR | S2/Tick top | from SVG | from SVG | stroke `#a4532f` 3, butt caps | — |
| S2/Tick bottom | FRAME (SVG D2) | S2/Push | 604, 868 | 32 × 4 | no fill | screen y 1410 |
| S2/Tick bottom path | VECTOR | S2/Tick bottom | from SVG | from SVG | stroke `#a4532f` 3, butt caps | — |
| S2/32 cm-mask | FRAME | S2/Push | 640, 543 | w × 34 | clipsContent true; no fill | screen (640, 1083) |
| S2/32 cm | TEXT | S2/32 cm-mask | 0, 0 | auto × 34 | `#4a443c` | "32 cm"; Inter **Medium 28**; LH 34 |
| S2/Plate clay | RECT | S2/Band window | **0, −1040** | 1080 × 1040 | `#d6cab8`; LAYER_BLUR 0; constraints LEFT/TOP | rests above the window; TRANSLATION_Y +1040 = covering |
| S2/Plate terracotta | RECT | S2/Band window | **0, −1040** | 1080 × 1040 | `#a4532f`; LAYER_BLUR 0; constraints LEFT/TOP | above Plate clay |
| S2/Type | FRAME | S2/Content | 0, 0 | 1080 × 1920 | no fill; clipsContent false | type plane (drift) |
| S2/Headline | FRAME | S2/Type | 64, 400 | 952 × 276 | no fill; clipsContent false | baseline at screen y 611, dipping 71 px into the band over the empty seamless |
| S2/Ash-mask | FRAME | S2/Headline | −6, 0 | (wAsh + 12) × 276 | clipsContent true | — |
| S2/Ash | TEXT | S2/Ash-mask | 6, 0 | auto × 276 | `#1f1c18`; LAYER_BLUR 0 | "Ash"; Cormorant Garamond **SemiBold 230**; LH 276; LS −1 % |
| S2/Vase/V-mask, S2/Vase/a-mask, S2/Vase/s-mask, S2/Vase/e-mask | FRAME × 4 | S2/Headline | x_i, 0 | (w_i + 56) × 276 | clipsContent true | x_V = wAsh + 30 (a word space of 58 minus the 28 pad); x_{i+1} = x_i + w_i |
| S2/Vase/V, S2/Vase/a, S2/Vase/s, S2/Vase/e | TEXT × 4 | its mask | 28, 0 | auto × 276 | `#a4532f`; LAYER_BLUR 0 | Cormorant Garamond **Medium Italic 230**; LH 276 |
| S2/Price | FRAME | S2/Type | 1003 − Σw, 790 | (Σw + 26) × 294 | no fill; clipsContent false | Σw = w($) + w(4) + w(8); the last glyph's right edge lands on x 1016 |
| S2/Price/$-mask, S2/Price/4-mask, S2/Price/8-mask | FRAME × 3 | S2/Price | x_i, 0 | (w_i + 26) × 294 | clipsContent true | x_$ = 0; x_{i+1} = x_i + w_i; 30 px headroom on top for the overshoot |
| S2/Price/$, S2/Price/4, S2/Price/8 | TEXT × 3 | its mask | 13, 30 | auto × 264 | `#1f1c18`; LAYER_BLUR 0 | "$", "4", "8"; Cormorant Garamond **SemiBold 220**; LH 264; baseline at screen y 1022 |
| S2/Spec 1-mask | FRAME | S2/Type | 1016 − w, 1170 | w × 41 | clipsContent true | — |
| S2/Spec 1 | TEXT | S2/Spec 1-mask | 0, 0 | auto × 41 | `#4a443c` | "Hand-thrown"; Inter **Medium 34**; LH 41 |
| S2/Spec 2-mask | FRAME | S2/Type | 1016 − w, 1220 | w × 41 | clipsContent true | — |
| S2/Spec 2 | TEXT | S2/Spec 2-mask | 0, 0 | auto × 41 | `#4a443c` | "Wood-fired"; Inter **Medium 34**; LH 41 |

**SVG D1 (S2/Dim line)** and **SVG D2 (each tick; import it twice):**

```
<svg xmlns="http://www.w3.org/2000/svg" width="4" height="614" viewBox="0 0 4 614"><path d="M2 612 L2 2" fill="none" stroke="#a4532f" stroke-width="3"/></svg>
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="4" viewBox="0 0 32 4"><path d="M2 2 L30 2" fill="none" stroke="#a4532f" stroke-width="3"/></svg>
```

**Build notes**

1. **Fit rule.** "Ash Vase" measures about 840 px. If wAsh + 58 + Σw(Vase) > 952, reduce both fonts by 4 % steps, and scale LH, the mask heights and the 276 TRANSLATION values by the same factor.
2. **Inside the pushed plane.** The dimension line, its ticks and "32 cm" live inside `S2/Push`, so they scale with the vase and stay registered to it. This fixes the type spec's 8–13 px misregistration.
3. **Plates rest off-window** (y −1040), so `figma_export_node` of `S2/Content` shows the vase layout. The keys bring them down to cover the band during the burst.
4. **Constraints:** LEFT/TOP on `S2/Push`, `S2/Plate clay` and `S2/Plate terracotta`.
5. **The band never relies on radius clamping.** CORNER_RADIUS is keyed equal to height/2 throughout the burst (48 → 520 on the same OUT curve as the height), then snapped to 0 on QOUT.

**Keyframes**

| Layer | Field | Keys (`@t value EASE`, absolute seconds; EASE shapes the move into that key) |
|---|---|---|
| **S2 · Ash Vase**<br><sub>on at frame 108 (its 96 dot sits exactly on S1's), off at 181 under S3</sub> | `OPACITY` | @0 0 · @3.575 0 L · @3.595 1 L · @6.0083 1 L · @6.0283 0 L |
| **S2/Content**<br><sub>the ad's one camera move: push-through into the vase belly, anchored on (384, 1180): T = (1 - s)(anchor - centre)</sub> | `SCALE_XY` | @0 1,1 · @5.6 1,1 L · @6 2.6,2.6 IN |
|  | `TRANSLATION_XY` | @0 0,0 · @5.6 0,0 L · @6 249.6,-352 IN |
|  | `effect:0:RADIUS` | @0 0 · @5.6667 0 L · @5.8667 10 SOFT · @5.9667 18 SOFT · @6 18 L |
| **S2/Band window**<br><sub>match cut: the 96 dot bursts into the image band as a circle (radius = height/2 the whole way), then snaps square on beat 4.2</sub> | `WIDTH` | @0 96 · @3.6 96 L · @4.1 1080 OUT |
|  | `HEIGHT` | @0 96 · @3.6 96 L · @4.1 1040 OUT |
|  | `TRANSLATION_XY` | @0 336,592 · @3.6 336,592 L · @4.1 0,0 OUT |
|  | `CORNER_RADIUS` | @0 48 · @3.6 48 L · @4.1 520 OUT · @4.3 0 QOUT |
|  | `effect:0:RADIUS` | @0 0 · @3.6 0 L · @3.6333 10 L · @3.7667 0 SOFT |
| **S2/Push**<br><sub>counter-translation (photo screen-locked during the burst) + 4 % push pivoting on the belly</sub> | `TRANSLATION_XY` | @0 -336,-592 · @3.6 -336,-592 L · @4.1 0,0 OUT |
|  | `SCALE_XY` | @0 1,1 · @4.1 1,1 L · @5.6 1.04,1.04 L |
| **S2/Plate terracotta**<br><sub>stacked colour wipe inside the band, 1 of 2: rests above the window (y -1040), so +1040 = covering; wipes up and off</sub> | `TRANSLATION_Y` | @0 1040 · @3.7333 1040 L · @4.0333 0 WHIP |
|  | `effect:0:RADIUS` | @0 0 · @3.7333 0 L · @3.9 14 SOFT · @4.0333 0 SOFT |
| **S2/Plate clay**<br><sub>2 frames behind</sub> | `TRANSLATION_Y` | @0 1040 · @3.8 1040 L · @4.1 0 WHIP |
|  | `effect:0:RADIUS` | @0 0 · @3.8 0 L · @3.9667 14 SOFT · @4.1 0 SOFT |
| **S2/Ash**<br><sub>mask rise</sub> | `TRANSLATION_Y` | @0 276 · @3.7667 276 L · @4.1667 0 OUT |
|  | `effect:0:RADIUS` | @0 0 · @3.7667 0 L · @3.8 8 L · @3.9 0 SOFT |
| **S2/Vase/V**<br><sub>per-letter rise, 2-frame stagger</sub> | `TRANSLATION_Y` | @0 276 · @3.8333 276 L · @4.2333 0 OUT |
|  | `effect:0:RADIUS` | @0 0 · @3.8333 0 L · @3.8667 8 L · @3.9667 0 SOFT |
| **S2/Vase/a** | `TRANSLATION_Y` | @0 276 · @3.9 276 L · @4.3 0 OUT |
|  | `effect:0:RADIUS` | @0 0 · @3.9 0 L · @3.9333 8 L · @4.0333 0 SOFT |
| **S2/Vase/s** | `TRANSLATION_Y` | @0 276 · @3.9667 276 L · @4.3667 0 OUT |
|  | `effect:0:RADIUS` | @0 0 · @3.9667 0 L · @4 8 L · @4.1 0 SOFT |
| **S2/Vase/e** | `TRANSLATION_Y` | @0 276 · @4.0333 276 L · @4.4333 0 OUT |
|  | `effect:0:RADIUS` | @0 0 · @4.0333 0 L · @4.0667 8 L · @4.1667 0 SOFT |
| **S2/Tick bottom path**<br><sub>centre-out draw (butt caps: no dot at zero length)</sub> | `PATH_TRIM_START` | @0 0.5 · @4.1333 0.5 L · @4.3333 0 OUT |
|  | `PATH_TRIM_END` | @0 0.5 · @4.1333 0.5 L · @4.3333 1 OUT |
| **S2/Dim line path**<br><sub>path runs bottom to top: measures the vase upward</sub> | `PATH_TRIM_END` | @0 0 · @4.2333 0 L · @4.7 1 DRAW |
| **S2/Tick top path** | `PATH_TRIM_START` | @0 0.5 · @4.5667 0.5 L · @4.7667 0 OUT |
|  | `PATH_TRIM_END` | @0 0.5 · @4.5667 0.5 L · @4.7667 1 OUT |
| **S2/32 cm**<br><sub>follow-through: lands as the line passes its midpoint</sub> | `TRANSLATION_Y` | @0 34 · @4.4 34 L · @4.7333 0 OUT |
| **S2/Spec 1** | `TRANSLATION_Y` | @0 41 · @4.2 41 L · @4.5333 0 OUT |
| **S2/Spec 2** | `TRANSLATION_Y` | @0 41 · @4.2667 41 L · @4.6 0 OUT |
| **S2/Price/$**<br><sub>overshoot accent 2 of 3: hand-keyed, lands on the bar-3 downbeat (4.8); mask has 30 px headroom</sub> | `TRANSLATION_Y` | @0 264 · @4.8 264 L · @5.1 -18 OUT · @5.2333 5 SOFT · @5.3667 0 SOFT |
|  | `effect:0:RADIUS` | @0 0 · @4.8 0 L · @4.8333 8 L · @4.9333 0 SOFT |
| **S2/Price/4** | `TRANSLATION_Y` | @0 264 · @4.8667 264 L · @5.1667 -18 OUT · @5.3 5 SOFT · @5.4333 0 SOFT |
|  | `effect:0:RADIUS` | @0 0 · @4.8667 0 L · @4.9 8 L · @5 0 SOFT |
| **S2/Price/8** | `TRANSLATION_Y` | @0 264 · @4.9333 264 L · @5.2333 -18 OUT · @5.3667 5 SOFT · @5.5 0 SOFT |
|  | `effect:0:RADIUS` | @0 0 · @4.9333 0 L · @4.9667 8 L · @5.0667 0 SOFT |
| **S2/Type**<br><sub>type plane drifts against the photo push (parallax)</sub> | `TRANSLATION_Y` | @0 0 · @4.1 0 L · @5.6 -12 L |

LAYER_BLUR (radius 0) required before keyframing, on: `S2/Content`, `S2/Band window`, `S2/Plate terracotta`, `S2/Plate clay`, `S2/Ash`, `S2/Vase/V`, `S2/Vase/a`, `S2/Vase/s`, `S2/Vase/e`, `S2/Price/$`, `S2/Price/4`, `S2/Price/8`.


**Cross-package timing:**

- **f108 (3.6):** `S2 · Ash Vase` switches on. At that frame `S2/Band window` is 96 × 96, radius 48, top-left (336, 1132), centred on B, with the terracotta plate covering it and blur 0. This is identical to S1's dot.
- **f180 (6.0):** the dive ends at 2.6×, blur 18. S3 switches on at this frame.
- **f181:** `S2 · Ash Vase` switches off.

**Mechanism checks and fallbacks:**

- **The vase slides while the band bursts:** delete `S2/Push` TRANSLATION_XY. The plates cover the photo until f121–f123, by which point the band is more than 97 % open, so any slide is under 15 px and hidden under the plate blur.
- **The plates shift or stretch while the band resizes:** their constraints are wrong (CENTER or SCALE). The band's own TRANSLATION already carries its children, so the plates cover its visible area by construction. Set LEFT/TOP again on both plates and on `S2/Push`; nothing else changes.

---

### D.4 S3: Collection (`S3 · Collection`, 6.0 – 9.633)

**Layers** (z-order bottom to top: `S3/BG`, `S3/Content` › [`S3/Window` › [Mug, Plates, Bowl], `S3/Type` › [Kicker-mask, The-mask, Kiln-mask, collection-mask], `S3/List` › [entries, Pointer]], `S3/Cream circle`, `S3/Terracotta circle`)

| Layer | Type | Parent | x, y | w × h | Paint / stroke / effects | Text and type / notes |
|---|---|---|---|---|---|---|
| S3/BG | RECT | S3 · Collection | 0, 0 | 1080 × 1920 | `#f4efe7` (bound to `color/bg/subtle`) | not scaled |
| S3/Content | FRAME | S3 · Collection | 0, 0 | 1080 × 1920 | no fill; clipsContent false; LAYER_BLUR 0 | arrival scale, pivot (540, 960) |
| S3/Window | FRAME | S3/Content | 64, 760 | 520 × 720 | fill `#e8e2da`; clipsContent true; corner radii TL 260, TR 260, BR 0, BL 0 (static, per corner) | kiln-arch window, screen y 760–1480 |
| S3/Mug | RECT | S3/Window | −70, −177 | 700 × 1050 | IMAGE #11 `acbb852e49aa6f3b180839fb60dd57da0906ada4`, FILL | #11 at 0.5×: the mug stack is centred in the arch |
| S3/Plates | RECT | S3/Window | −100, −185 | 700 × 905 | IMAGE #13 `b6f9ac8e82fed12a9a25b9f6e1b154011293e70a`, FILL | #13 at 0.5×: the stack sits on the flat bottom |
| S3/Bowl | RECT | S3/Window | −379, −4 | 1288 × 724 | IMAGE #12 `5992035e9601a007ca539c5fc8f2d4959a847124`, FILL | #12 at 0.92×: close crop; terracotta wall centre at screen **(324, 1238)** |
| S3/Type | FRAME | S3/Content | 0, 0 | 1080 × 1920 | no fill | title plane |
| S3/Kicker-mask | FRAME | S3/Type | 64, 410 | 600 × 34 | clipsContent true | — |
| S3/Kicker | FRAME, auto-layout HORIZONTAL | S3/Kicker-mask | 0, 0 | 600 × 34, FIXED both axes | no fill; primary MIN; counter MIN; itemSpacing **6** (rest); padding 0 | letters grow rightward from x 64 |
| S3/Kicker/A, S3/Kicker/U1, S3/Kicker/T, S3/Kicker/U2, S3/Kicker/M, S3/Kicker/N, S3/Kicker/2a, S3/Kicker/0, S3/Kicker/2b, S3/Kicker/6 | TEXT × 10 | S3/Kicker | auto-layout | auto × 34 | `#a4532f` | "A","U","T","U","M","N","2","0","2","6"; Inter **Semi Bold 28**; LH 34 |
| S3/Kicker/Space | FRAME | S3/Kicker (7th child, after N) | auto-layout | 10 × 34 | no fill | word space |
| S3/The-mask | FRAME | S3/Type | 58, 452 | (wThe + 12) × 144 | clipsContent true | — |
| S3/The | TEXT | S3/The-mask | 6, 0 | auto × 144 | `#1f1c18` | "The"; Cormorant Garamond **Medium 120**; LH 144; LS −1 % |
| S3/Kiln-mask | FRAME | S3/Type | 64 + wThe + 6, 452 | (wKiln + 48) × 144 | clipsContent true | a word space of 30 minus the 24 pad |
| S3/Kiln | TEXT | S3/Kiln-mask | 24, 0 | auto × 144 | `#a4532f` | "Kiln"; Cormorant Garamond **Medium Italic 120**; LH 144 |
| S3/collection-mask | FRAME | S3/Type | 58, 572 | (wColl + 12) × 144 | clipsContent true | — |
| S3/collection | TEXT | S3/collection-mask | 6, 0 | auto × 144 | `#1f1c18` | "collection"; Cormorant Garamond **Medium 120**; LH 144; LS −1 % |
| S3/List | FRAME | S3/Content | 0, 0 | 1080 × 1920 | no fill | — |
| S3/Name 1-mask | FRAME | S3/List | 640, 900 | 376 × 76 | clipsContent true | entry 1 |
| S3/Name 1 | TEXT | S3/Name 1-mask | 0, 0 | auto × 76 | `#1f1c18` | "Kiln Mug"; Cormorant Garamond **Medium 60**; LH 76 |
| S3/Price 1-mask | FRAME | S3/List | 640, 982 | 376 × 41 | clipsContent true | — |
| S3/Price 1 | TEXT | S3/Price 1-mask | 0, 0 | auto × 41 | `#4a443c` | "$32"; Inter **Medium 34**; LH 41 |
| S3/Name 2-mask | FRAME | S3/List | 640, 1080 | 376 × 76 | clipsContent true | entry 2 |
| S3/Name 2 | TEXT | S3/Name 2-mask | 0, 0 | auto × 76 | `#1f1c18` | "Dinner Plates"; as Name 1 |
| S3/Price 2-mask | FRAME | S3/List | 640, 1162 | 376 × 41 | clipsContent true | — |
| S3/Price 2 | TEXT | S3/Price 2-mask | 0, 0 | auto × 41 | `#4a443c` | "$110 · set of 4"; as Price 1 |
| S3/Name 3-mask | FRAME | S3/List | 640, 1260 | 376 × 76 | clipsContent true | entry 3 |
| S3/Name 3 | TEXT | S3/Name 3-mask | 0, 0 | auto × 76 | `#1f1c18` | "Serving Bowl"; as Name 1 |
| S3/Price 3-mask | FRAME | S3/List | 640, 1342 | 376 × 41 | clipsContent true | — |
| S3/Price 3 | TEXT | S3/Price 3-mask | 0, 0 | auto × 41 | `#4a443c` | "$58"; as Price 1 |
| S3/Pointer | ELLIPSE | S3/List | 608, 938 | 16 × 16 | `#a4532f` | centre (616, 946), level with entry 1's x-height; moves +180 per product |
| S3/Cream circle | ELLIPSE | S3 · Collection | −1176, −262 | 3000 × 3000 | `#fbf9f6`; LAYER_BLUR 0 | centre (324, 1238) = the bowl wall; the farthest corner is 1451 px away |
| S3/Terracotta circle | ELLIPSE | S3 · Collection | −1176, −262 | 3000 × 3000 | `#a4532f`; LAYER_BLUR 0 | above the cream circle |

**Build notes**

1. **Widths.** "Dinner Plates" at 60 px measures about 350 px and must be ≤ 376; if it is wider, set all three names to 56 px.
2. **Export.** Export `S3/Content`, not the container, to check layout: the bloom circles cover everything at rest.
3. **Photo order.** Keep the photos bottom to top as Mug, Plates, Bowl; the OPACITY cuts select one at a time.

**Keyframes**

| Layer | Field | Keys (`@t value EASE`, absolute seconds; EASE shapes the move into that key) |
|---|---|---|
| **S3 · Collection**<br><sub>on at frame 180 (velocity-matched cut), off at 289 under S5's field</sub> | `OPACITY` | @0 0 · @5.975 0 L · @5.995 1 L · @9.6083 1 L · @9.6283 0 L |
| **S3/Content**<br><sub>continues the push-through: arrives at 0.82 with the dive's blur and decelerates to rest</sub> | `SCALE_XY` | @0 0.82,0.82 · @6 0.82,0.82 L · @6.5 1,1 OUT |
|  | `effect:0:RADIUS` | @0 18 · @6 18 L · @6.2333 0 OUT |
| **S3/Mug**<br><sub>stop-motion cut on 7.2; pans up the stack</sub> | `OPACITY` | @0 1 · @7.175 1 L · @7.195 0 L |
|  | `TRANSLATION_Y` | @0 0 · @6 0 L · @7.2 -24 L |
| **S3/Plates** | `OPACITY` | @0 0 · @7.175 0 L · @7.195 1 L · @8.075 1 L · @8.095 0 L |
|  | `SCALE_XY` | @0 1,1 · @7.2 1,1 L · @8.1 1.03,1.03 L |
| **S3/Bowl**<br><sub>cut in on the 8th at 8.1 so its list entry gets >= 0.9 s before the bloom covers it</sub> | `OPACITY` | @0 0 · @8.075 0 L · @8.095 1 L |
|  | `SCALE_XY` | @0 1,1 · @8.1 1,1 L · @9.6 1.05,1.05 L |
| **S3/Type**<br><sub>title plane drift</sub> | `TRANSLATION_Y` | @0 0 · @6.5 0 L · @9.6 -12 L |
| **S3/Kicker**<br><sub>animated tracking: opens on arrival, then keeps opening slowly</sub> | `TRANSLATION_Y` | @0 34 · @6.2 34 L · @6.5333 0 OUT |
|  | `STACK_SPACING` | @0 0 · @6.2 0 L · @6.7333 6 OUT · @9.6 8 L |
| **S3/The**<br><sub>per-word rise</sub> | `TRANSLATION_Y` | @0 144 · @6.2667 144 L · @6.6667 0 OUT |
| **S3/Kiln** | `TRANSLATION_Y` | @0 144 · @6.3333 144 L · @6.7333 0 OUT |
| **S3/collection** | `TRANSLATION_Y` | @0 144 · @6.4 144 L · @6.8 0 OUT |
| **S3/Name 1**<br><sub>list entry rises with its product; dims when the next product cuts in</sub> | `TRANSLATION_Y` | @0 76 · @6.4667 76 L · @6.8 0 OUT |
|  | `OPACITY` | @0 1 · @7.2 1 L · @7.4 0.35 SOFT |
| **S3/Price 1** | `TRANSLATION_Y` | @0 41 · @6.5333 41 L · @6.8667 0 OUT |
|  | `OPACITY` | @0 1 · @7.2333 1 L · @7.4333 0.35 SOFT |
| **S3/Name 2** | `TRANSLATION_Y` | @0 76 · @7.2667 76 L · @7.6 0 OUT |
|  | `OPACITY` | @0 1 · @8.1 1 L · @8.3 0.35 SOFT |
| **S3/Price 2** | `TRANSLATION_Y` | @0 41 · @7.3333 41 L · @7.6667 0 OUT |
|  | `OPACITY` | @0 1 · @8.1333 1 L · @8.3333 0.35 SOFT |
| **S3/Name 3** | `TRANSLATION_Y` | @0 76 · @8.1667 76 L · @8.5 0 OUT |
| **S3/Price 3** | `TRANSLATION_Y` | @0 41 · @8.2333 41 L · @8.5667 0 OUT |
| **S3/Pointer**<br><sub>the clay dot again: follows each cut 3 frames late, overshoots, settles (follow-through)</sub> | `OPACITY` | @0 0 · @6.575 0 L · @6.595 1 L |
|  | `SCALE_XY` | @0 0.01,0.01 · @6.6 0.01,0.01 L · @6.8 1,1 OUT |
|  | `TRANSLATION_Y` | @0 0 · @7.3 0 L · @7.5 192 OUT · @7.6333 176 SOFT · @7.7667 180 SOFT · @8.2 180 L · @8.4 372 OUT · @8.5333 356 SOFT · @8.6667 360 SOFT |
| **S3/Cream circle**<br><sub>bloom 1 of 2: seeds on the bowl's terracotta wall (324, 1238)</sub> | `OPACITY` | @0 0 · @9.175 0 L · @9.195 1 L |
|  | `SCALE_XY` | @0 0.002,0.002 · @9.2 0.002,0.002 L · @9.5333 1,1 IRIS |
|  | `effect:0:RADIUS` | @0 0 · @9.2 0 L · @9.3667 12 SOFT · @9.5333 0 SOFT |
| **S3/Terracotta circle**<br><sub>bloom 2 of 2, 2 frames behind; fills the frame on the 9.6 downbeat</sub> | `OPACITY` | @0 0 · @9.2417 0 L · @9.2617 1 L |
|  | `SCALE_XY` | @0 0.002,0.002 · @9.2667 0.002,0.002 L · @9.6 1,1 IRIS |
|  | `effect:0:RADIUS` | @0 0 · @9.2667 0 L · @9.4333 12 SOFT · @9.6 0 SOFT |

LAYER_BLUR (radius 0) required before keyframing, on: `S3/Content`, `S3/Cream circle`, `S3/Terracotta circle`.


**Cross-package timing:**

- **f180:** `S3 · Collection` switches on, arriving at 0.82× with blur 18 to match S2's dive.
- **f283:** the terracotta bloom has passed the "Moku" bug (RIG flips its colour on this frame).
- **f288:** the terracotta circle is full (r 1500); S5 switches on.
- **f289:** `S3 · Collection` switches off.

**Mechanism check and fallback.** If the kicker spacing does not move:

1. Turn auto-layout off on `S3/Kicker`.
2. Delete STACK_SPACING.
3. Key TRANSLATION_X on each child i (0..10, counting Space) = i × (spacing − 6), with keys `@0 −6i · @6.2 −6i L · @6.7333 0 OUT · @9.6 2i L`.

---

### D.5 S4: End card (`S4 · End card`, 9.633 – 14.4; seen from 11.0)

**Layers** (z-order bottom to top: `S4/BG`, `S4/Logo`, `S4/Bowl arc`, `S4/Tagline`, `S4/Offer`, `S4/URL-mask`, `S4/Footer-mask`)

| Layer | Type | Parent | x, y | w × h | Paint / stroke / effects | Text and type / notes |
|---|---|---|---|---|---|---|
| S4/BG | RECT | S4 · End card | 0, 0 | 1080 × 1920 | `#1f1c18` (bound to `color/bg/inverse`) | — |
| S4/Logo | FRAME, auto-layout HORIZONTAL | S4 · End card | 64, 486 | 952 × 228, FIXED both axes | no fill; clipsContent false; primary CENTER; counter CENTER; itemSpacing **12** (rest); padding 0 | exactly `Brand bug` × 3, centred (540, 600) |
| S4/Logo/M, S4/Logo/o, S4/Logo/k, S4/Logo/u | TEXT × 4 | S4/Logo | auto-layout | auto × 228 | `#ffffff` | "M","o","k","u"; Cormorant Garamond **SemiBold 192**; LH 228; LS 0. Baseline at screen y ≈ 661. |
| S4/Bowl arc | FRAME (SVG E1) | S4 · End card | 358, 690 | 364 × 48 | no fill | a bowl-shaped arc under the logo |
| S4/Bowl arc path | VECTOR | S4/Bowl arc | from SVG | from SVG | stroke `#a4532f` 4, round caps | — |
| S4/Tagline | FRAME | S4 · End card | 64, 756 | 952 × 68 | no fill | — |
| S4/Objects-mask, S4/for-mask, S4/slow-mask, S4/living.-mask | FRAME × 4 | S4/Tagline | x_i, 0 | (w_i + 32) × 68 | clipsContent true | x_0 = (952 − (Σw + 42))/2 − 16; x_{i+1} = x_i + w_i + 14 |
| S4/Objects, S4/for, S4/slow, S4/living. | TEXT × 4 | its mask | 16, 0 | auto × 68 | `#d6cab8` | "Objects", "for", "slow", "living."; Cormorant Garamond **Medium Italic 56**; LH 68 |
| S4/Offer | FRAME | S4 · End card | 64, 930 | 952 × 76 | no fill | the offer restated |
| S4/10% off-mask | FRAME | S4/Offer | x1, 0 | (w1 + 16) × 76 | clipsContent true | x1 = (952 − (w1 + 16 + w2))/2 − 8 |
| S4/10% off | TEXT | S4/10% off-mask | 8, 0 | auto × 76 | `#ffffff` | "10% off"; Cormorant Garamond **SemiBold 60**; LH 76 |
| S4/your first order-mask | FRAME | S4/Offer | x1 + w1 + 4, 0 | (w2 + 40) × 76 | clipsContent true | — |
| S4/your first order | TEXT | S4/your first order-mask | 20, 0 | auto × 76 | `#d6cab8` | "your first order"; Cormorant Garamond **Medium Italic 60**; LH 76 |
| S4/URL-mask | FRAME | S4 · End card | 64, 1262 | 952 × 44 | clipsContent true | below the CTA pill (1100–1220) |
| S4/URL | TEXT | S4/URL-mask | 0, 0 | 952 × 44, fixed width | `#ffffff` | "moku.store"; Inter **Semi Bold 36**; LH 44; centre |
| S4/Footer-mask | FRAME | S4 · End card | 64, 1322 | 952 × 34 | clipsContent true | — |
| S4/Footer | TEXT | S4/Footer-mask | 0, 0 | 952 × 34, fixed width | `#d6cab8` | "Free shipping over $80 · Plastic-free"; Inter **Regular 28**; LH 34; centre |

**SVG E1 (S4/Bowl arc):**

```
<svg xmlns="http://www.w3.org/2000/svg" width="364" height="48" viewBox="0 0 364 48"><path d="M2 3 C72 59 292 59 362 3" fill="none" stroke="#a4532f" stroke-width="4" stroke-linecap="round"/></svg>
```

**Build notes**

1. **The logo must equal the bug × 3:** same font and style, 64 → 192, LH 76 → 228, spacing 4 → 12, the same FIXED-952 CENTER row, and centre y 328 + 272 = 600. Do not change any of these numbers. The swap at f346 is invisible only if they match.
2. The vertical stack on the end card is: logo glyphs 529–661, arc 690–738, tagline 756–824, offer 930–1006, (S5's pill 1100–1220), URL 1262–1306, footer 1322–1356.

**Keyframes**

| Layer | Field | Keys (`@t value EASE`, absolute seconds; EASE shapes the move into that key) |
|---|---|---|
| **S4 · End card**<br><sub>on at frame 289, while S5's full terracotta field covers it</sub> | `OPACITY` | @0 0 · @9.6083 0 L · @9.6283 1 L |
| **S4/Logo**<br><sub>appears on frame 346 exactly where the flying bug lands (bug hidden on the same frame); then slow luxury tracking-out + 3 % push</sub> | `OPACITY` | @0 0 · @11.5083 0 L · @11.5283 1 L |
|  | `SCALE_XY` | @0 1,1 · @11.5333 1,1 L · @14.4 1.03,1.03 L |
|  | `STACK_SPACING` | @0 12 · @11.5333 12 L · @14.4 20 L |
| **S4/Bowl arc path**<br><sub>a bowl-shaped arc drawn centre-out under the logo, round caps guarded</sub> | `OPACITY` | @0 0 · @11.6083 0 L · @11.6283 1 L |
|  | `PATH_TRIM_START` | @0 0.5 · @11.6 0.5 L · @12 0 DRAW |
|  | `PATH_TRIM_END` | @0 0.5 · @11.6 0.5 L · @12 1 DRAW |
| **S4/Objects**<br><sub>tagline per word</sub> | `TRANSLATION_Y` | @0 68 · @11.7 68 L · @12.1 0 OUT |
| **S4/for** | `TRANSLATION_Y` | @0 68 · @11.7667 68 L · @12.1667 0 OUT |
| **S4/slow** | `TRANSLATION_Y` | @0 68 · @11.8333 68 L · @12.2333 0 OUT |
| **S4/living.** | `TRANSLATION_Y` | @0 68 · @11.9 68 L · @12.3 0 OUT |
| **S4/10% off**<br><sub>the offer restated on the end card</sub> | `TRANSLATION_Y` | @0 76 · @11.9667 76 L · @12.3667 0 OUT |
| **S4/your first order** | `TRANSLATION_Y` | @0 76 · @12.0333 76 L · @12.4333 0 OUT |
| **S4/URL** | `TRANSLATION_Y` | @0 44 · @12.1333 44 L · @12.4667 0 OUT |
| **S4/Footer** | `TRANSLATION_Y` | @0 34 · @12.2 34 L · @12.5333 0 OUT |

LAYER_BLUR (radius 0) required before keyframing, on: none.


**Cross-package timing:**

- **f289:** `S4 · End card` switches on under S5's full field.
- **11.0–11.4:** S5's field collapse reveals it.
- **f346:** `S4/Logo` switches on on the same frame RIG switches `Brand bug` off; the bug has landed at (540, 600), 3×, white.

**Mechanism check and fallback.** If `S4/Logo` spacing does not move, leave it at 12 and delete the track. The drift is polish, and the logo still scales 1 → 1.03.

---

### D.6 S5: Offer and CTA (`S5 · Offer + CTA`, 9.6 – 14.4)

**Layers** (z-order bottom to top: `S5/Ripple`, `S5/Field`, `S5/Offer type` › [Ten, off-mask, Line, Loop], `S5/CTA mask` › [CTA label, Arrow])

| Layer | Type | Parent | x, y | w × h | Paint / stroke / effects | Text and type / notes |
|---|---|---|---|---|---|---|
| S5/Ripple | RECT | S5 · Offer + CTA | 220, 1100 | 640 × 120 | no fill; stroke `#a4532f` 3, CENTER; corner radius 60 | the pulse ring |
| S5/Field | RECT | S5 · Offer + CTA | 220, 1100 | 640 × 120 | `#a4532f`; corner radius 60; LAYER_BLUR 0 | rests as the CTA pill, centre (540, 1160); starts as the full frame |
| S5/Offer type | FRAME | S5 · Offer + CTA | 0, 0 | 1080 × 1920 | no fill | drift plane |
| S5/Ten | FRAME, auto-layout HORIZONTAL | S5/Offer type | 64, 380 | 952 × 480, FIXED both axes | no fill; clipsContent false; primary CENTER; counter MIN; itemSpacing **−52** (rest); padding 0 | figure tops at screen y ≈ 495, baseline 747 |
| S5/Ten/1-mask, S5/Ten/0-mask, S5/Ten/%-mask | FRAME × 3 | S5/Ten | auto-layout | (w_i + 52) × 480, FIXED | clipsContent true; no fill; not auto-layout | — |
| S5/Ten/1, S5/Ten/0, S5/Ten/% | TEXT × 3 | its mask | 26, 0 | auto × 480 | `#fbf9f6`; LAYER_BLUR 0 | "1", "0", "%"; Cormorant Garamond **SemiBold 400**; LH 480 |
| S5/off-mask | FRAME | S5/Offer type | 540 − (w + 48)/2, 800 | (w + 48) × 240 | clipsContent true | — |
| S5/off | TEXT | S5/off-mask | 24, 0 | auto × 240 | `#fbf9f6`; LAYER_BLUR 0 | "off"; Cormorant Garamond **Medium Italic 200**; LH 240 |
| S5/Line | FRAME | S5/Offer type | 64, 1040 | 952 × 116 | no fill | — |
| S5/your-mask, S5/first-mask, S5/order.-mask | FRAME × 3 | S5/Line | x_i, 0 | (w_i + 48) × 116 | clipsContent true | x_0 = (952 − (Σw + 48))/2 − 24; x_{i+1} = x_i + w_i + 24 |
| S5/your, S5/first, S5/order. | TEXT × 3 | its mask | 24, 0 | auto × 116 | `#fbf9f6` | "your", "first", "order."; Cormorant Garamond **Medium Italic 96**; LH 116 |
| S5/Loop | FRAME (SVG L1) | S5/Offer type | 110, 391 | 860 × 460 | no fill; resting rotation 0 (the tilt is baked into the path) | loop centre (540, 621); it spans screen y 426–813 |
| S5/Loop path | VECTOR | S5/Loop | from SVG | from SVG | stroke `#fbf9f6` 6, round caps | a hand-drawn ellipse round "10%" that overshoots its start |
| S5/CTA mask | FRAME | S5 · Offer + CTA | 220, 1100 | 640 × 120 | clipsContent true; no fill; not auto-layout | centre (540, 1160) = the pill centre |
| S5/CTA label | TEXT | S5/CTA mask | xL, 36 | auto × 48 | `#ffffff` | "Shop the collection"; Inter **Semi Bold 40**; LH 48. xL = (640 − (wL + 60))/2 |
| S5/Arrow | FRAME (SVG A1) | S5/CTA mask | xL + wL + 20, 46 | 40 × 28 | no fill; clipsContent false | nudge carrier |
| S5/Arrow shaft | VECTOR (1st path) | S5/Arrow | from SVG | from SVG | stroke `#ffffff` 4, round caps | — |
| S5/Arrow head | VECTOR (2nd path) | S5/Arrow | from SVG | from SVG | stroke `#ffffff` 4, round caps and joins | — |

**SVG L1 (S5/Loop)** and **SVG A1 (S5/Arrow):**

```
<svg xmlns="http://www.w3.org/2000/svg" width="860" height="460" viewBox="0 0 860 460"><path d="M416.7 40.5 C642.6 24.7 831.7 96.7 839 201.4 C846.3 306.1 669.1 403.7 443.3 419.5 C217.4 435.3 28.3 363.3 21 258.6 C13.7 153.9 190.9 56.3 416.7 40.5 C506.7 34.2 597 31.7 688.3 44.3" fill="none" stroke="#fbf9f6" stroke-width="6" stroke-linecap="round"/></svg>
<svg xmlns="http://www.w3.org/2000/svg" width="40" height="28" viewBox="0 0 40 28"><path d="M2 14 L36 14" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/><path d="M24 3 L36 14 L24 25" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>
```

**Build notes**

1. **The pulse.** `S5/Field` scales on the pulse only at 13.2, when its WIDTH is at rest, so its pivot is unambiguous (540, 1160). `S5/CTA mask` has the identical pulse, so the label scales with the button.
2. **The ripple** grows by WIDTH, HEIGHT, TRANSLATION_XY and CORNER_RADIUS, not by scale, so its stroke thins only through its STROKE_WEIGHT track.
3. **"10%" figures.** If Cormorant renders old-style figures (the 1 and the 0 at x-height), keep them: they are on-brand, and the loop still encloses them.

**Keyframes**

| Layer | Field | Keys (`@t value EASE`, absolute seconds; EASE shapes the move into that key) |
|---|---|---|
| **S5 · Offer + CTA**<br><sub>on at frame 288: its full-frame field is pixel-identical to S3's landed bloom</sub> | `OPACITY` | @0 0 · @9.575 0 L · @9.595 1 L |
| **S5/Field**<br><sub>the offer field collapses into the CTA pill (match cut 'offer -> button'); final pulse on 13.2 = overshoot accent 3 of 3 (width at rest)</sub> | `WIDTH` | @0 1080 · @11 1080 L · @11.4 640 WHIP |
|  | `HEIGHT` | @0 1920 · @11 1920 L · @11.4 120 WHIP |
|  | `TRANSLATION_XY` | @0 -220,-1100 · @11 -220,-1100 L · @11.4 0,0 WHIP |
|  | `CORNER_RADIUS` | @0 0 · @11 0 L · @11.4 60 WHIP |
|  | `effect:0:RADIUS` | @0 0 · @11.1 0 L · @11.2 12 SOFT · @11.3333 0 SOFT |
|  | `SCALE_XY` | @0 1,1 · @13.2 1,1 L · @13.3 1.08,1.08 OUT · @13.4667 0.985,0.985 SOFT · @13.6333 1,1 SOFT |
| **S5/Ripple**<br><sub>ring born 1 frame after the pulse: grows 50 px on every side (size, not scale), thins, fades</sub> | `OPACITY` | @0 0 · @13.2083 0 L · @13.2283 1 L · @13.8333 0 FADE |
|  | `WIDTH` | @0 640 · @13.2333 640 L · @13.8333 740 OUT |
|  | `HEIGHT` | @0 120 · @13.2333 120 L · @13.8333 220 OUT |
|  | `TRANSLATION_XY` | @0 0,0 · @13.2333 0,0 L · @13.8333 -50,-50 OUT |
|  | `CORNER_RADIUS` | @0 60 · @13.2333 60 L · @13.8333 110 OUT |
|  | `STROKE_WEIGHT` | @0 3 · @13.2333 3 L · @13.8333 1 OUT |
| **S5/Offer type**<br><sub>type plane drift through the breath</sub> | `TRANSLATION_Y` | @0 0 · @9.6 0 L · @11 -14 L |
| **S5/Ten**<br><sub>tracking opens slowly; scale punch on beat 10.2</sub> | `STACK_SPACING` | @0 -52 · @9.6 -52 L · @11 -36 L |
|  | `SCALE_XY` | @0 1,1 · @10.2 1,1 L · @10.2667 1.06,1.06 SWELL · @10.6 1,1 OUT |
| **S5/Ten/1**<br><sub>per-character rise on the 9.6 downbeat; falls out toward the button</sub> | `TRANSLATION_Y` | @0 480 · @9.6 480 L · @10 0 OUT · @10.9 0 L · @11.1 480 IN |
|  | `effect:0:RADIUS` | @0 0 · @9.6 0 L · @9.6333 10 L · @9.7333 0 SOFT · @11 0 L · @11.0667 10 SOFT |
| **S5/Ten/0** | `TRANSLATION_Y` | @0 480 · @9.6667 480 L · @10.0667 0 OUT · @10.9667 0 L · @11.1667 480 IN |
|  | `effect:0:RADIUS` | @0 0 · @9.6667 0 L · @9.7 10 L · @9.8 0 SOFT · @11.0667 0 L · @11.1333 10 SOFT |
| **S5/Ten/%** | `TRANSLATION_Y` | @0 480 · @9.7333 480 L · @10.1333 0 OUT · @11.0333 0 L · @11.2333 480 IN |
|  | `effect:0:RADIUS` | @0 0 · @9.7333 0 L · @9.7667 10 L · @9.8667 0 SOFT · @11.1333 0 L · @11.2 10 SOFT |
| **S5/off** | `TRANSLATION_Y` | @0 240 · @9.7667 240 L · @10.1667 0 OUT · @10.9333 0 L · @11.1333 240 IN |
|  | `effect:0:RADIUS` | @0 0 · @9.7667 0 L · @9.8 8 L · @9.9 0 SOFT · @11.0333 0 L · @11.1 8 SOFT |
| **S5/your**<br><sub>per word, 2-frame stagger</sub> | `TRANSLATION_Y` | @0 116 · @9.8333 116 L · @10.2333 0 OUT · @11 0 L · @11.2 116 IN |
| **S5/first** | `TRANSLATION_Y` | @0 116 · @9.9 116 L · @10.3 0 OUT · @11.0667 0 L · @11.2667 116 IN |
| **S5/order.** | `TRANSLATION_Y` | @0 116 · @9.9667 116 L · @10.3667 0 OUT · @11.1333 0 L · @11.3333 116 IN |
| **S5/Loop path**<br><sub>hand-drawn loop round '10%' that overshoots its own start; erased on the exit</sub> | `OPACITY` | @0 0 · @9.8083 0 L · @9.8283 1 L · @11.1417 1 L · @11.1617 0 L |
|  | `PATH_TRIM_END` | @0 0 · @9.8 0 L · @10.2333 1 DRAW |
|  | `PATH_TRIM_START` | @0 0 · @10.9333 0 L · @11.1667 1 IN |
|  | `ROTATION` | @0 0 · @9.8 0 L · @11.1667 2 L |
| **S5/CTA mask**<br><sub>same pulse as the field so the label scales with the button</sub> | `SCALE_XY` | @0 1,1 · @13.2 1,1 L · @13.3 1.08,1.08 OUT · @13.4667 0.985,0.985 SOFT · @13.6333 1,1 SOFT |
| **S5/CTA label**<br><sub>rises inside the pill one frame after it lands</sub> | `TRANSLATION_Y` | @0 120 · @11.4333 120 L · @11.7667 0 OUT |
| **S5/Arrow**<br><sub>two nudges (13.267 follow-through of the pulse, 13.8 echo); settled by 14.1</sub> | `TRANSLATION_X` | @0 0 · @13.2667 0 L · @13.3667 14 OUT · @13.5667 0 SOFT · @13.8 0 L · @13.9 10 OUT · @14.1 0 SOFT |
| **S5/Arrow shaft**<br><sub>shaft draws before the head</sub> | `OPACITY` | @0 0 · @11.6417 0 L · @11.6617 1 L |
|  | `PATH_TRIM_END` | @0 0 · @11.6333 0 L · @11.8 1 OUT |
| **S5/Arrow head** | `OPACITY` | @0 0 · @11.7417 0 L · @11.7617 1 L |
|  | `PATH_TRIM_END` | @0 0 · @11.7333 0 L · @11.8667 1 OUT |

LAYER_BLUR (radius 0) required before keyframing, on: `S5/Field`, `S5/Ten/1`, `S5/Ten/0`, `S5/Ten/%`, `S5/off`.


**Cross-package timing:**

- **f288 (9.6):** `S5 · Offer + CTA` switches on with `S5/Field` full-frame terracotta, identical to S3's landed bloom.
- **11.0–11.4:** the collapse reveals S4.
- During **11.1–11.533**, RIG's bug flies above S5.

**Mechanism check and fallback.** If `S5/Ten` spacing does not move:

1. Turn auto-layout off on `S5/Ten`.
2. Delete STACK_SPACING.
3. Key TRANSLATION_X on the three masks as (i − 1) × (spacing + 52): `S5/Ten/1-mask @0 0 · @9.6 0 L · @11.0 −16 L`, `S5/Ten/0-mask` none, `S5/Ten/%-mask @0 0 · @9.6 0 L · @11.0 16 L`.

These keys are on the masks, which are no longer auto-layout children once auto-layout is off.

---

## E. Frames to check

### E.1 The verification render

Run this once, after every package reports done (RIG runs it, or the orchestrator):

1. Render: `figma_export_video { nodeId: <frame id>, format: "MP4", fps: 30, saveTo: "~/.figma-mcp/exports/moku-ig-story-v2.mp4" }`, with no `frames`, so it renders once.
2. Cut the stills below: `ffmpeg -v error -y -ss <s> -i <mp4> -frames:v 1 <png>`, with s = (k + 0.5)/30 for frame k, so the seek lands squarely on that frame.
3. Make the contact sheet: `ffmpeg -v error -y -i <mp4> -vf "fps=6,scale=180:-1,tile=9x10" <png>`.
4. Make the close-ups (`-ss <t0> -t 0.8 … fps=30,scale=216:-1,tile=8x3`) at t0 = 1.8, 3.3, 3.567, 5.6, 7.15, 9.2, 10.9, 11.3 and 13.15. In a close-up, the spacing between successive frames is the speed graph.
5. Run freeze detection. Nothing may be frozen for longer than 0.5 s; the breath at 10.4–10.9 keeps its drifts.
6. Apply any package fallback whose check fails, then re-render once.

### E.2 Stills

| # | t (frame) | What must be visible |
|---|---|---|
| 1 | 0.000 (0) | **Clean first frame**, cream. Nothing in it is blurred, and there is no "down." and no dot yet. It shows: <br>- "M o k u" in ink, centred at the top (glyphs y ≈ 304–348), widely spaced;<br>- a 240-wide image slit (x 420–660, y 400–960) showing the vessels;<br>- "S l o w" in 400 px ink, widely spaced (glyphs y ≈ 874–1150). |
| 2 | 0.500 (15) | The slit fully open (x 300–780). The "Slow" tracking nearly collapsed. |
| 3 | 0.733 (22) | Terracotta "d" about 90 % down (42 px above rest) and sharp; "o" about two-thirds down and blurred (about 8 px); "w" not yet visible. No glyph shows above the mask tops (y 1170). |
| 4 | 1.267 (38) | Scale punch peak: "down." about 6 % larger, "." landing. The hook "Slow down." is readable. |
| 5 | 1.600 (48) | A terracotta dot at its overshoot (Ø 90) inside the counter of the "o", centred (540, 1070). The "Moku" spacing visibly closing. |
| 6 | 1.800 (54) | "Moku" tight (spacing 4), still centred. The dot settled at Ø 72. |
| 7 | 2.167 (65) | The disc mid-swell (r ≈ 300) eating the middle of "Slow". "d", "o" and "w" of "down." gone; "n" falling (blurred, about 10 px); "." just starting to fall. The slit closed to about 300 px tall (bottom edge near y 700), blurred. |
| 8 | 2.400 (72) | **Downbeat:** a terracotta disc Ø 880 centred (540, 1070). No trace of "Slow", "down." or the slit. A clay seed at the disc centre. "By hand." not yet visible: "By" rises from the next frame. |
| 9 | 2.633 (79) | Stacked burst inside the terracotta disc: a clay ring (≈ 770), a cream ring (≈ 720) and the hands photo opening (≈ 600 wide). "By hand." almost landed. A tiny ring arc just started at 12 o'clock. |
| 10 | 3.033 (91) | Hands-on-wheel photo Ø 800 inside a 40 px terracotta rim. The ring almost fully drawn, rotated about −35°. "By hand." (ink "By", terracotta "hand.") readable above. |
| 11 | 3.433 (103) | The wheel still at full size (anticipation 1.02). The photo iris shutting (≈ 600 wide, blurred), with a cream ring and then a clay ring showing round it. The ring and "By hand." gone. |
| 12 | 3.600 (108) | **One crisp terracotta dot, Ø 96, at (384, 1180)** on plain cream, and "Moku" at the top. Nothing else. |
| 13 | 3.900 (117) | The band about 99 % open: a near-circle ≈ 1068 × 1029 with radius ≈ 514. Inside it, the terracotta plate covers only its top part and is blurred (14 px) as it wipes up; the clay plate covers most of the rest; a strip of photo shows at the very bottom. "Ash" almost landed. |
| 14 | 4.333 (130) | The band squared to the full 1080 × 1040 rectangle (y 540–1580). "Ash Vase" landed ("Ash" ink, "Vase" terracotta italic) across the band top. The bottom tick drawn; "Hand-thrown" landed; the dimension line just starting up from the base. |
| 15 | 5.500 (165) | **Full product frame, everything settled:** headline; "$48" (220 px, right edge at x 1016); "Hand-thrown" and "Wood-fired"; the terracotta dimension line with ticks along the vase (x ≈ 620, y 800–1410) and "32 cm" at its middle. |
| 16 | 5.900 (177) | Dive: S2 at ≈ 1.3× around the vase belly, blur ≈ 12. "Moku" still legible in ink at the top. (Frame 179 reaches ≈ 1.9× with blur 18.) |
| 17 | 6.033 (181) | S3 at ≈ 0.88× with blur ≈ 7, on linen. The arch window (mug) and the title area are soft. No cream border anywhere. |
| 18 | 6.900 (207) | Collection settled: the "AUTUMN 2026" kicker (terracotta), "The *Kiln* / collection", mugs in the arch, "Kiln Mug / $32" with the terracotta pointer dot at its left. |
| 19 | 7.267 (218) | **Hard cut done:** plates in the arch, the mug gone. "Kiln Mug / $32" starting to dim. "Dinner Plates" about to rise; the pointer still at entry 1. |
| 20 | 8.667 (260) | Bowl in the arch, its terracotta wall across the lower half. "Serving Bowl / $58" landed. The pointer settled at entry 3; entries 1–2 dimmed to 35 %. |
| 21 | 9.367 (281) | Bloom: the cream circle (r ≈ 1065) racing out from the bowl wall, blurred; the terracotta circle (r ≈ 240) inside it. The bug still ink, on cream. |
| 22 | 9.433 (283) | The terracotta circle (r ≈ 1058, its top edge near y 180) has swept past the wordmark; **"Moku" is now white** on terracotta. The cream circle almost fills the frame. |
| 23 | 9.700 (291) | Full terracotta. Cream "1" about 80 % risen; "0" about halfway and blurred (10 px); "%" not yet visible. |
| 24 | 10.267 (308) | "10%" at its punch peak (1.06). The cream loop fully drawn round it. "off" and "your first order." readable. |
| 25 | 10.600 (318) | **Breath:** the whole offer settled; only slow drifts. |
| 26 | 11.200 (336) | The field mid-collapse (860 × 1020, centred (540, 1060), blurred 12), ink showing round it. Only "%" (half gone, blurred), "first" and "order." still falling; the rest of the offer type is gone. The bug just starting its flight (≈ 1.07×). (Frame 340: bug ≈ 2.4×, 187 px lower.) |
| 27 | 11.533 (346) | **Swap frame:** a sharp white "Moku" logo (192 px, glyphs y ≈ 529–661, centred). The pill landed (640 × 120 at y 1100–1220). "Shop the collection" about 15 px below its rest inside the pill. |
| 28 | 12.600 (378) | **Complete end card:** logo; terracotta bowl arc; "Objects for slow living."; "10% off your first order"; the pill with label and arrow; "moku.store"; footer. |
| 29 | 13.300 (399) | Pulse peak: the pill and label at 1.08. A terracotta ripple ring (≈ 693 wide, nearly opaque) just outside the pill. The arrow nudged ≈ 13 px right. |
| 30 | 14.367 (431) | **Clean last frame:** the end card settled, the ripple gone, the arrow at rest. The logo about 3 % larger and slightly more widely spaced than at 11.533. |

---

## Appendix A: Read times

The rule is at least 0.3 s per word, counted from fully legible to covered.

| Block | Words | Fully readable (s) | Needed |
|---|---|---|---|
| Moku (wordmark) | 1 | 0.0–11.1, then as the logo 11.53–14.4 | 0.3 |
| Slow | 1 | 0.0–1.95 | 0.3 |
| down. | 1 | 1.1–1.85 | 0.3 |
| By hand. | 2 | 2.62–3.25 | 0.6 |
| Ash Vase | 2 | 4.05–5.7 | 0.6 |
| Hand-thrown / Wood-fired | 1 + 1 | 4.35–5.7 / 4.42–5.7 | 0.3 each |
| 32 cm | 2 | 4.55–5.7 | 0.6 |
| $48 | 1 | 4.95–5.7 | 0.3 |
| AUTUMN 2026 / The Kiln collection | 2 / 3 | 6.4–9.33 / 6.6–9.33 | 0.6 / 0.9 |
| Kiln Mug / $32 | 2 + 1 | 6.65–9.33 (the active item until 7.2) | 0.9 |
| Dinner Plates / $110 · set of 4 | 2 + 4 | 7.42–9.33 | 1.8 |
| Serving Bowl / $58 | 2 + 1 | 8.27–9.33 | 0.9 |
| 10% off | 2 | 9.85–10.95 | 0.6 |
| your first order. | 3 | 10.1–11.05 | 0.9 |
| Shop the collection → | 3 | **11.6–14.4 (2.8 s)** | ≥ 2.5 |
| Objects for slow living. | 4 | 11.85–14.4 | 1.2 |
| 10% off your first order (end card) | 5 | 12.15–14.4 | 1.5 |
| moku.store / footer | 1 / 6 | 12.3–14.4 / 12.35–14.4 | 0.3 / 1.8 |

The bloom covers the list area from f281 (9.367), so 9.33 is the read cut-off for every list entry.

## Appendix B: The judges' findings and how this cut answers them

| Finding (judge) | This cut |
|---|---|
| Hook all type, a 96 px slit (ad) | The slit starts at 240 px and is fully open by 0.5 s; the vessels register on frame 0 |
| Graphic's hook type is 136 px and frame 0 has no message (motion, ad) | 400 px "S l o w" is readable on frame 0 |
| Corner bug at y 262 has low salience (ad) | A centred wordmark at y 290 on frame 0. It locks its tracking on 1.8, stays through every scene, flips colour exactly once (f283) and becomes the logo. |
| 22–24 px Inter labels (ad) | No Inter text below 28 px |
| Pace contradicts "Slow down."; at most one whip; at most two devices in 6–9 s (motion, ad) | No whip and no panel burst. One camera move (the push-through). 6–9 s holds only the push-through arrival and the stop-motion cut with its list. |
| Graphic's T2 three-panel rise is template-like (motion) | Removed |
| Type spec's 1-frame offsets (motion) | Inside every stagger group the offset is 2 frames: letters, words, and the stacked burst (clay 2.4, cream 2.467, photo 2.533). Separate gestures may start 1 frame apart. Only the closes inside the collapsing wheel run 1 frame apart. |
| Stock back-ease and spring overshoots (motion) | Three hand-keyed accents: the dot 1.25 → 0.95 → 1; "$48" −18 → +5 → 0 px; the CTA 1.08 → 0.985 → 1 |
| Collection flashes at 0.5 s with no prices (ad); camera's plates beat never lands (motion) | Each product gets 0.9–1.2 s on screen. Name + price entries persist as a list, each readable ≥ 1.06 s. |
| "Thrown by hand." is under its read time (ad) | Cut to "By hand." (2 words, 0.63 s) inside the wheel beat; "Hand-thrown" returns as a spec |
| The offer appears once and is missing from the end card (ad) | Hero field at 9.6, restated on the end card above the CTA (12.15–14.4) |
| CTA ≥ 600 × 116, label ≥ 40 px, ≥ 2.5 s, one punch with settle, ripple, two nudges (ad, motion) | 640 × 120, 40 px, readable 2.8 s; 8 % punch with settle; 50 px ripple; nudges at 13.267 and 13.8 |
| The breath must come directly before the end card (ad) | 10.4–10.9, then the collapse |
| Soft frame 0 and grain (ad) | No rack focus, no grain |
| Text must stay ≥ 280 and ≤ 1540 (ad) | Text spans y 304–1500 |
| Single-source JSON and cut pairs (build) | Done and validated |
| Auto-layout children translated; HUG reflow; unmeasured STACK_SPACING (build) | No TRANSLATION on any auto-layout child. Every animated row is FIXED. Each STACK_SPACING track has a TRANSLATION_X fallback. |
| Radius clamping relied on (build) | Never: the iris radius = W/2 and the band radius = H/2 are keyed |
| Round-cap trims at zero length (build) | OPACITY guards on the ring, loop, bowl arc and arrow; butt caps on the dimension line and ticks |
| SCALE while WIDTH is off rest (build) | The only scaled node with animated WIDTH is `S5/Field`, and it is scaled only at 13.2, at rest |
| Over 100 keys per track (build) | Max 10; no grain |
| Blur on edges over 150 px/frame; peak ≤ 20 (build, ad) | Computed per move: drops 186 → blur 10; plate wipe 497 → 14; band burst 177 → 10; bloom 434 → 12; field 331 → 12; dive up to 896 at the corners → 18. Moves under 150 (bug flight 101, title rises 62) carry none or 8 on display type. |
| Bloom circles must clear the corners (build) | Ø 3000 from (324, 1238): farthest corner 1451 < 1500 |
| Bug → logo may render soft (build) | A real logo swap on f346 by default |
| Type spec's dimension line misregistered (build) | Dimension line, ticks and label sit inside the pushed plane |
