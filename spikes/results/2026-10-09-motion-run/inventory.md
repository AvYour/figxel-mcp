# Moku IG Story ad: inventory for the After Effects-grade rebuild

Read-only pass, 2026-10-09. Nothing was created, moved or modified on the Figma canvas.
Files written only to disk:

- `scratchpad/motion/inv/NN-<hash8>.png`: small renders of each unique image, cropped as the mock shows it (11–13 were cut from the video, see the note below the table)
- `scratchpad/motion/inv/orig/NN-<hash8>.jpg` and `inv/originals-sheet.png`: the full, uncropped originals at 360 px
- `scratchpad/motion/sheets/`: video contact sheets (`full-fps6.png`, `a-0-6s.png`, `b-6-12s.png`), 30 fps close-ups (`close-<t0>.png`, 0.8 s each), `holds-2.0-4.8-8.0.png`, `frame-0.png`, `frame-11.95.png`, `ystats.txt`
- Original image bytes (from `figma_download_assets`, read-only): `~/.figma-mcp/exports/moku-inv/raw/<fullhash>.jpg`

---

## 1. Product imagery: 13 unique images

All are `IMAGE` fills with `scaleMode: FILL`. To reuse one, call `figma_set_fills` on your own rectangle with `{ type: "IMAGE", imageHash: <full hash>, scaleMode: "FILL" }`, or use `figma_clone_node` on a source rect and then `figma_reparent_nodes`. Every original is **1400 px wide**. That sets how much each image can fill a 1080 × 1920 frame without going soft (the "full-bleed scale" column, where 1.00 means native).

| # | Full imageHash | Source node(s) | Native px / orientation | Subject | Dominant colours (dark → light) | Full-bleed 1080×1920 scale | Best use in the ad |
|---|---|---|---|---|---|---|---|
| 1 | `4f0c889acfa136ce743258ce6a8d1f07697fcf8c` | 30:14025 (Hero photo), also ad 30:14997 | 1400×933, landscape 3:2 | A row of about 10 mixed vases on a pale wood shelf against an off-white wall: crackled terracotta and cream globe, ribbed ochre, white honeycomb gourd, white trumpet, speckled blush vase with handles | #775d48 #9d826a #b09882 #c9bdb0 #d8d4ce #e7e6e2 (avg #c9bdb3) | 2.06×, too soft | **Range/collection beat as a horizontal band** (1080 × ~720 at about 0.77×) with a slow lateral truck along the shelf. It is busy and not one product, so it is a weak hero. The current ad opens on it. |
| 2 | `b1e64fd760af16e36d356c2d758139152a48ad21` | 30:14027 (Thumb), 30:14420 | 1400×1120, landscape 5:4 | One matte white bud vase, round belly, short neck, left of centre on a light-grey seamless, soft shadow, empty right half | #675b55 #8a7f79 #a29c98 #afadab #bbbcba #c6c7c6 (cool grey) | 1.71×, soft | **Minimal single-object beat**: the empty right half holds type. Its round silhouette works as a **match-cut source** (vase becomes a terracotta circle or mask). Series with #9 and #10. Cool cast, so place it on cream or under a warm overlay. |
| 3 | `90925717d81d67ef050ae9f0aa1e478d8fdb50da` | 30:14076 | 1400×2100, portrait 2:3 | Three lumpy, hand-built, unglazed sand-coloured vessels on a concrete plinth, warm grey wall, quiet light | #4d4131 #776d56 #86826e #928f7b #a5a18f #bdbdb3 (avg #9d9888) | **0.91×, native** | **Best full-bleed opener or "made by hand" hero.** It is the most on-brand image (hand-made, slow). The vertical composition with a clean upper third leaves room for type. Use it for a slow camera push. |
| 4 | `346ee9f0268857764d35721ef7386bf48798c2bc` | 30:14082 | 1400×1750, portrait 4:5 | Folded linen cloths (white, peach, blush, flax, grey) piled on a wooden stool, pale wall | #272016 #634935 #9a836e #b6af9f #c6c2b3 #d7d4c6 | 1.10× | Texture or lifestyle cutaway ("slow living" beyond ceramics). The peach linen echoes terracotta. **Not a product shot**, so use it at most once, briefly. |
| 5 | `bff7b99e2e0e870d51f5b1f37793ba8c19986313` | 30:14088 | 1400×1856, portrait | Warm evening interior: glowing cream arc-lamp shade, sheer beige curtains, two glossy black bottle vases and a white squat vase with dried stems on a dining table | #2e1b06 #543314 #6f4721 #926f4b #bdaf9b #ecd5a6 (avg #8c6c49) | 1.03× | **Mood beat and bridge to the dark end card**: its dark amber-brown palette dissolves naturally into #1f1c18, and the lamp glow can push to black. Good for "evening, slow". |
| 6 | `a20ae21ad3dd4b6d070a5856fce3ea2d9468b1e9` | 30:14094 | 1400×933, landscape 3:2 | White brick wall, two reclaimed-wood shelves on leather straps, two-tone pots, small planters with succulents and cactus, trailing plants | #482c19 #6e543d #887764 #a19888 #bfbfb9 #d6d8d7 | 2.06×, too soft | Low priority: busy, plant-led, off-brand. If used, make it a narrow band or a background plate behind a parallax foreground. |
| 7 | `e6467ef2ad5881493d047570d9e0f6c627961b18` | 30:14225 | 1400×933, landscape 3:2 | Close-up of clay-covered hands throwing a grey cylinder on a potter's wheel, near-black background, white wheel head | #020201 #1c1813 #47372c #746356 #b2a8a1 #dbdad2 (avg #5d534d) | 2.06×, too soft | **The process shot and the strongest story image** ("made by hand, fired for 48 hours"). Its high contrast suits white type. Frame it in a square or circular mask (about 1.29× in a 1080×1200 window). The wheel's circle suits a circle-mask match cut, or a ROTATION-driven type ring. |
| 8 | `6abdd71a966b0784e95e1bceae1e0884e20ea960` | 30:14418, 30:14426, also ad 30:15000 | 1400×1750, portrait 4:5 | White peony in a small white matte bud vase, very shallow depth of field with blurred twins behind, high-key | #aaa493 #bfbbb5 #c8c5c1 #d1cdca #dcd8d4 #e6e1dd (avg #d6d1cf, near-monochrome) | 1.10× | Soft, airy product portrait. The current ad uses it as the "Ash Vase", but the flower hides most of the vase and nothing reads as "ash". Low contrast, so dark type only. Fine for a slow push, weak as the price hero. |
| 9 | `558f930a54e5deb899ab2e260ff2c8f95258dea6` | 30:14422 | 1400×1120, landscape 5:4 | Three identical white bud vases stacked as a pyramid on light-grey seamless | #5f544e #817773 #908784 #a39c9a #b3b1af #c6c7c5 | 1.71×, soft | **Rhythm series with #2 and #10**: the same vase on the same backdrop, so hard cuts on the beat (1 vase, then 3 in a row, then the stack) read like stop-motion. Use as cards or bands. |
| 10 | `f5a98f81c56c83ee9828181d89093f4600991910` | 30:14424 | 1400×933, landscape 3:2 | Three identical white bud vases in an evenly spaced row, light-grey seamless | #635853 #7d726e #8d8480 #9f9897 #adaaa9 #c1c1c1 | 2.06×, too soft | Repetition beat in the series above. Horizontal band (1080×720). |
| 11 | `acbb852e49aa6f3b180839fb60dd57da0906ada4` | ad 30:15013 (Tile / Mug) | 1400×2100, portrait 2:3 | Four hand-pinched, unglazed blush-cream mugs stacked vertically with handles alternating sides, cream plaster surface | #8b6f5b #aa9586 #b9a79a #cdc2b9 #e3e0db #f1efec (avg #e0dad5, warm) | **0.91×, native** | **Kiln Mug hero, full bleed.** The vertical stack is made for 9:16 and invites a slow vertical pan (TRANSLATION_Y drift). It is the warmest match to the #fbf9f6 page. |
| 12 | `5992035e9601a007ca539c5fc8f2d4959a847124` | ad 30:15018 (Tile / Bowl) | 1400×787, landscape 16:9 | Serving bowl, side view: raw terracotta exterior, white glazed interior painted with green grass strokes, on white | #764126 #8f5c3d #ab9277 #bbb49f #d6d4c8 #e6e8e1 | 2.44×, unusable full-bleed | **The only object in the brand accent colour** (its exterior is about #8f5c3d, next to terracotta #a4532f). That makes it the ideal **match cut into a terracotta wipe or panel**: the bowl's band becomes the brand-colour wipe. Use as a wide band (1080×607). |
| 13 | `b6f9ac8e82fed12a9a25b9f6e1b154011293e70a` | ad 30:15023 (Tile / Plates) | 1400×1810, portrait | A stack of white tableware (small bowls, embossed-rim plates, bowl, plate) on white terrazzo with terracotta and amber flecks | #8a8c8b #b3b6b8 #c2c6c8 #d5d8da #e4e8ed #eaeff4 (avg #e1e2e9, cool) | 1.06× | Dinner Plates hero, near-native full bleed. It has a cool cast, so pair it with cream or warm overlays. The terracotta flecks can seed a particle or confetti accent. |

**Not an image:** 30:13947 "Photo" (302×378) is a solid `#f4efe7` placeholder with no image fill. Its instance copies `I30:14107;30:13947`, `I30:14136;…`, `I30:14165;…`, `I30:14194;…`, `I30:14497;…`, `I30:14526;…`, `I30:14555;…` and `I30:14584;…` are skipped.

**Rendering trap found:** `figma_export_node` on 30:15013, 30:15018 and 30:15023 returned **1×1 px**. Their ancestor tiles rest at `opacity 0`, and the REST data shows `absoluteRenderBounds: null`. Any layer whose resting state (or an ancestor's) is opacity 0 cannot be previewed with `figma_export_node`. Check it through `figma_export_video` frames instead. Images 11–13 were therefore cropped from the video at t = 8.0 s.

**Shortlist for a 9:16 rebuild** (native-resolution full bleed): #3 hand-built vessels, #11 mugs, #13 plates, #5 lamp mood, #8 peony vase. Use #7 (hands) and #12 (terracotta bowl) inside masks or bands; they carry the story and the match cut. The #2/#9/#10 series supplies rhythmic beat cuts.

---

## 2. Free canvas spot for the new 1080 × 1920 top-level frame

Every top-level node on Page 1 (`0:1`), with its bounds:

| id | name | x – x2 | y – y2 |
|---|---|---|---|
| 1:2 | Rectangle 1 | −379 – −227 | −123 – 21 |
| 7:10004 | "HALO INI TEST MCP" (text) | −371 – −255 | −115 – −100 |
| 6:5003 | yield-spike (safe to delete) | −198 – 802 | −123 – 377 |
| 11:10550 | figma-mcp — Landing demo | 2000 – 3440 | 0 – 1237 |
| 14:11224 | Pricing | 2000 – 3440 | 1400 – 2320 |
| 11:10755 | v2 / 01 Cover | 3725 – 5645 | 0 – 1080 |
| 30:13736 | v2 / 01 Cover — B | 5765 – 7685 | 0 – 1080 |
| 30:13878 | Moku — E-commerce (dummy), SECTION | 0 – 4840 | 3200 – 7900 |
| 30:14651 = 30:14989 | Moku — IG Story Ad (9:16), the current ad (see the note in §3) | 5000 – 6080 | 3200 – 5120 |

**Use x = 6280, y = 3200 (frame spans x 6280–7360, y 3200–5120).** Clearances:

- left: **200 px** to the current ad (its right edge is at x 6080)
- above: **2120 px** to "v2 / 01 Cover — B" (bottom at y 1080)
- right and below: no node on the page at all

This is the preferred spot and it meets the ≥ 200 px rule exactly. For more air, x = 6480 (400 px gap) is equally clear. A second variant would fit at x = 7560, y = 3200, also clear.

---

## 3. The current ad (30:14651)

### Identity note: two ids, one frame
The page lists two top-level children, `30:14651` and `30:14989`. Both are named "Moku — IG Story Ad (9:16)" and both sit at 5000, 3200, 1080×1920. They are **the same node**: reading either id returns the identical subtree (same child ids 30:14990…30:15038), and the REST export of 30:14651 reports `document.id = 30:14989`. `figma_get_motion_context` names 30:14989 as the top-level frame and timeline id (12 s). So a page scan shows a "duplicate", but there is only one ad. **Never delete or move either id.** Expect the new ad to gain a similar twin id once it is keyframed. Do not treat that twin as an obstacle or a stray copy.

### Structure (frame 1080×1920, fill color/bg/page #fbf9f6, clipsContent)
Four full-size scene frames are stacked at 0,0 with no fill; each scene's layers handle its own in and out. Timeline: **12.0 s, 30 fps, 361 frames**, rendered to `~/.figma-mcp/exports/moku-ig-story-ad.mp4` (15.8 MB). 23 animated layers.

| Scene (id) | Layer (id) | Geometry | Copy / content | Motion (s) |
|---|---|---|---|---|
| **1 Intro** (30:14990), 0.15–3.15 | Eyebrow (30:14991) | 92,270 | "AUTUMN COLLECTION 2026" Inter SemiBold 26, +3 tracking, terracotta | opacity + Y 30→0, 0.15–0.6; out 2.55–2.85 |
| | Line mask 1 (30:14992) › Line 1 (30:14993) | mask 80,318 940×168 | "Objects for" Cormorant Garamond Medium 156/164, −3 | Y 180→0, 0.25–1.0 expo-out; out to −180, 2.6–3.0 |
| | Line mask 2 (30:14994) › Line 2 (30:14995) | mask 80,480 | "slow living." same style | Y 180→0, 0.4–1.15; out 2.7–3.1 |
| | Photo card (30:14996) › Photo (30:14997) | card 90,724 900×1080 r32; photo 1290×1380 | image #1 (vase shelf) | card opacity 0→1 0.55–1.2, Y 140→0 0.55–1.35; out: fade + Y −100, 2.75–3.15. Photo scale 1.18→1, 0.55–3.1 (decelerating) |
| **2 Product** (30:14998), 2.95–5.85 | Product photo (30:14999) › Photo (30:15000) | 0,0 1080×1160 clip; photo 1080×1380 | image #8 (peony vase) | X 1080→0, 2.95–3.65 expo-out; X 0→−1080, 5.35–5.85 in-out. Photo scale 1.15→1, 2.95–5.4 |
| | Name mask (30:15001) › Name (30:15002) | mask 80,1190 | "Ash Vase" Cormorant Medium 156 | Y 180→0, 3.35–4.0; out 5.35–5.75 |
| | Details (30:15003) | 92,1378 | "Hand-thrown · Wood-fired · 32 cm" Inter Regular 36, #4a443c | opacity + Y 24→0, 3.65–4.15; out 5.3–5.6 |
| | Price pill (30:15004) | 90,1470 252×96, terracotta pill | "$48" Inter SemiBold 46 + "NEW" 24 white | opacity on 4.0–4.15 linear; scale 0.2→1 spring:0.4, 4.0–4.65; out 5.3–5.6 to 0.8 |
| **3 Collection** (30:15007), 5.8–8.8 | Eyebrow (30:15008) | 92,270 | "THE KILN COLLECTION" | opacity + Y, 5.8–6.2; out 8.45–8.75 |
| | Title mask (30:15009) › Title (30:15010) | mask 80,318 940×260 | "Made by hand,\nfired for 48 hours." Cormorant Medium 112/120 (one node, two lines) | Y 270→0, 5.85–6.6; out 8.4–8.8 |
| | Tile / Mug (30:15011), Tile / Bowl (30:15016), Tile / Plates (30:15021) | 288×490 each at x 90 / 396 / 702, y 644; media 288×384 r22 | images #11, #12, #13; "Kiln Mug $32", "Serving Bowl $58", "Dinner Plates $110 / set of 4" (Inter Medium 30 / Regular 28) | opacity + Y 160→0, 6.2–6.9 / 6.35–7.05 / 6.5–7.2; out 8.45–8.75 |
| | Offer badge (30:15026) | 650,1214 340×340 terracotta circle | "10% off" Cormorant SemiBold 92 + "your first order" Inter Medium 26 | opacity on 6.9–7.05; rotation −40→0, 6.9–7.5; scale 0.2→1 spring:0.45, 6.9–7.55; out 8.45–8.75 |
| | Note (30:15029) | 92,1294 520×112 | "Free shipping over $80.\nPlastic-free, always." Inter Regular 38/56 | opacity + Y 24→0, 7.1–7.5; out 8.45–8.75 |
| **4 End card** (30:15030), 8.6–12.0 | Panel (30:15031) | 1080×1920 #1f1c18 | none | Y 1920→0, 8.6–9.25 in-out |
| | Logo (30:15032) | 0,640 1080×260 | "Moku" Cormorant SemiBold 260, −4, white, centred | opacity 9.1–9.7, scale 0.9→1, 9.1–9.85 |
| | Underline (30:15033) | LINE 390,940 300 w, stroke 4 terracotta | none | PATH_TRIM_END 0→1, 9.5–10.1 in-out |
| | Tagline (30:15034) | 0,990 | "Objects for slow living." Cormorant Medium Italic 66, #d6cab8 | opacity + Y 20→0, 9.7–10.2 |
| | CTA (30:15035) | 280,1240 520×106 terracotta pill | "Shop the collection" + "→" Inter SemiBold 38 white | opacity + Y 60→0, 10.0–10.55; pulse scale 1→1.06→1, 10.95–11.45 |
| | URL (30:15038) | 0,1430 | "moku.store · 10% off your first order" Inter Medium 32, #d6cab8 | opacity, 10.3–10.7 |

Type: Cormorant Garamond (Medium, SemiBold, Medium Italic) and Inter (Regular, Medium, SemiBold), so two families. Colours are all Moku variables (bg/page, bg/subtle, accent, text primary/secondary/muted, bg/inverse, text inverse/inverse-muted). Safe zones hold: text is never above y 270 or below y 1566, and side margins are 80–92 px. Only the Scene 1 photo card's lower edge (y 1804) enters the bottom 340 px, and it is image only.

---

## 4. Critique against "After Effects, by a senior motion designer"

**Verdict:** a well-mannered **Figma prototype that fades things in**. The vocabulary is right: masked line reveals, expo-out arrivals, ease-in exits, one trim path. But it is applied as **one move repeated on every layer** ("opacity + 20–160 px slide on expo-out"), cut together as a **slideshow**: build in, freeze, push off to nothing, build in again. The layouts are e-commerce web sections (eyebrow + H1 + card, a 3-up product grid), not story frames. Measured evidence follows.

### Frame by frame

**0.00–0.30 s, the opening (fails the hook and the clean first frame).**
Frames 0–4 (0.00–0.133 s) are a **completely empty cream frame**: luma min = max = 230 across the whole picture (`ystats.txt`). `freezedetect` reports nothing moving until 0.30 s. On Instagram the first frame is the poster and the thumb-stop. This ad opens on a blank page, then fades in a 26 px eyebrow, the least important line in the ad. A pro opens on frame 0 *already in motion*: a full-bleed image mid-push, or a bold shape mid-wipe.

**0.25–1.35 s, the headline and photo build.**
- "Objects for" and "slow living." rise through masks: the best idea in the ad. But they rise as **whole lines** with a 0.15 s offset (**4.5 frames**, off the frame grid). There is no per-word stagger, no scale punch on "slow", no tracking animation. It is the standard SaaS-hero reveal.
- The photo card **cross-fades** (opacity 0→1 over 0.65 s) while sliding up 140 px: the most generic build in Keynote or Figma. There is no mask reveal, no wipe, and no edge-in.
- The composition is a rounded card in a page, a website hero. About 40 % of the frame is flat cream. Image #1 is a busy shelf of *other people's* mixed vases, so no single product reads.
- The hook (headline readable, photo opaque) lands at **about 1.0–1.2 s**, a marginal pass.

**1.35–2.55 s, the hold.** The only motion is the photo scaling 1.18→1 on a **decelerating** curve, so it is almost still by 2.0 s. It is also a zoom *out* that settles, not a push that keeps living. Text and photo are locked together, so there is no parallax.

**Brand.** The word "Moku" first appears at **9.1 s**, 76 % of the way in. The brand-by-2 s rule **fails**: the eyebrow says "AUTUMN COLLECTION 2026" with no brand.

**2.55–3.65 s, transition 1 (two scenes collide).**
- Scene 1 exits piecemeal: eyebrow fade 2.55, line 1 down 2.6, line 2 2.7, card fade + 100 px up 2.75–3.15.
- *Meanwhile* the Scene 2 photo slides in from the right (2.95–3.65, expo-out). In frames 2.97–3.13 its hard vertical edge cuts across "slow living" while the old card is still half-visible. Under the new 1160-px-tall photo the faded old card shows until about 3.2 s (`close-2.6.png`). This is not a designed transition but two layouts overlapping.
- The incoming edge moves about 280 px in its first frame (expo-out over 21 frames: the curve's 6.25× initial slope times the 51 px per frame average), with **no motion blur**, so it strobes.
- There is no match cut: the shelf photo and the peony photo share no shape, position or colour.

**3.35–4.65 s, the Scene 2 build.**
- "Ash Vase" rises through a mask, the same move as Scene 1, so the repetition reads as a template.
- The details fade and slide 24 px.
- The price pill hard-switches to opaque in 0.15 s while it is still at **0.2 scale**, so a tiny terracotta blob is visible for about 4 frames before the spring (`close-3.3.png`, last frames).
- That makes three different reveal types in one scene, all bottom-left. The payoff ($48) is a 252×96 pill under a 36 px caption.
- Image #8 is high-key white on white. The flower hides the product, and nothing in it says "ash" or "wood-fired".

**4.65–5.35 s, a dead hold.** `freezedetect` reports the frame **frozen 4.90–5.37 s**: the photo push has eased to zero. Read times are tight: the details line (5 words) is fully visible 4.15–5.30, which is 1.15 s against the 1.5 s needed at 0.3 s per word.

**5.30–6.20 s, transition 2 (a push-off to nothing).**
- The photo whips left 5.35–5.85 (in-out over 15 frames, peak about 300 px per frame from the curve's 4.2× mid slope, no blur).
- The name drops out and the details and pill fade.
- In frames **5.80–5.93 the screen is empty cream** apart from a sliver of departing photo (`close-5.3.png`, row 2). Nothing new rides in on the move. Scene 3 then builds from nothing (an eyebrow fade).
- This is the slideshow rhythm in its purest form: exit, gap, enter.

**5.80–7.55 s, the Scene 3 build (the most "Figma prototype" moment).**
- The two-line title rises as **one block** (a single text node in one mask), with no line stagger.
- Three equal product tiles fade up 160 px with 0.15 s offsets, exactly a web page's scroll-reveal of a 3-up product grid. The tiles are small (288×384, 27 % of the width each) and labelled at 28–30 px.
- The offer badge is the **second spring pop** of the ad and adds a −40° rotation. On a circle with centred text, that reads as the type wobbling, a sticker cliché. It also arrives (6.9–7.55) while tile 3 is still landing (6.5–7.2), so two accents compete in the same beat.
- The Note fades and slides 24 px.

**7.43–8.50 s, the longest dead hold.** The frame is **fully frozen for 1.07 s**: no drift, no push, nothing. It is also overloaded. About 33 words (eyebrow, title, 3 names, 3 prices, badge, two facts) are fully visible together for only about **0.95–1.8 s**:
- title: 7 words in 1.8 s, needs 2.1 s
- tiles: about 11 words in 1.25 s
- badge: 5 words in 0.9 s
- note: 7 words in 0.95 s

Most of this cannot be read. The scene also leaves the lower 366 px empty.

**8.40–9.30 s, transition 3 (a wipe over an emptied frame).**
- All of Scene 3 fades out 8.45–8.75 *before* the dark panel arrives (rising 8.6–9.25). So the panel wipes across an **already-blank cream frame** (8.8–8.95, `close-8.4.png`). It is ornamental, not motivated, because it carries nothing off.
- It is a single flat panel: no stacked brand-colour layers, no frame offsets, no blur. Its hard horizontal edge steps about 410 px per frame at peak (1920 px over 19.5 frames, 4.2× mid slope).

**9.10–10.70 s, the end-card build.**
- "Moku" **fades in on black**, so for about 6 frames it is a muddy grey word (`close-9.0.png`, row 1) with only a 0.9→1 scale: the default logo fade.
- The underline trim-path is the *only* drawn-on accent in 12 s, and it is 300 × 4 px.
- The tagline repeats the opening headline.
- CTA and URL fade and slide in one after another, so there is no single landing beat and no designed breath before the end card. Scene 3's frozen second is dead air, not a breath.

**10.37–12.03 s, the CTA.**
- The CTA is fully opaque from 10.40 to 12.03, which is **1.63 s, so "readable ≥ 2 s" fails**. The URL line gets 1.33 s.
- The final pulse (scale 1.06, ease-in-out, 0.5 s) is **barely perceptible** and has no arrow nudge.
- `freezedetect` shows the end card frozen 10.37–11.07 and again **11.40–12.03**.
- The last frame is clean (`frame-11.95.png`). That passes.

### Against each line of the bar

| Bar | Current ad | Pass? |
|---|---|---|
| Speed graphs, not default eases | Good curves exist (expo-out 0.16,1,0.3,1; ease-in 0.7,0,0.84,0; in-out 0.76,0,0.24,1; two springs). But every layer gets the same arrival/exit pair, so there is no hierarchy of speed. Big moves use the same curve as captions. | partial |
| Overlap and offsets | Staggers exist but are **0.15 s = 4.5 frames**. Many keys sit on half frames (0.15, 0.55, 1.15, 1.35, 2.55, 2.75, 2.85, 2.95, 3.15, 3.35, 3.65, 4.15, 4.65, 5.35, 5.85…), against a 0.05 s grid, not 1/30 s. No anticipation anywhere. No follow-through on secondaries. | weak |
| Nothing is ever dead | Frozen 0–0.30, 4.90–5.37, 7.43–8.50, 10.37–11.07, 11.40–12.03 (strict threshold), about 3.2 s of 12. The camera pushes decelerate to zero, and there is no parallax. | **fail** |
| Designed transitions | Three transitions: an overlapping slide-over, a push-off to an empty frame, and a flat panel over an emptied frame. No match cut, no stacked colour wipes, no mask reveal between scenes, no morph, no faked motion blur. | **fail** |
| Kinetic typography | Whole lines rise from masks, which is good, but there is no per-word or per-letter stagger, no scale punch, no animated tracking. The two-line Scene 3 title moves as one block. | weak |
| Trim-path accents | One 300 px underline at 9.5 s. Nothing punctuates beats. | weak |
| Rhythm on a beat grid | Hits at 1.0, 1.15, 2.95, 3.65, 4.0, 5.35, 5.85, 6.6, 7.05, 9.25, 10.1, 10.55, 11.2 follow no common interval, so there is no stated BPM. Scene lengths are a flat ~2.9 s each. No designed breath; the CTA pulse is weak. | **fail** |
| Restraint and finish | Palette coherent, two typefaces. But the first frame is blank, read times fail in Scenes 2–4, and Scene 3 is overloaded (about 33 words). | partial |
| Format | Safe zones and margins pass. Hook about 1.0–1.2 s (marginal). **Brand at 9.1 s (fails ~2 s). CTA 1.63 s (fails ≥ 2 s).** 12.0 s length is OK. | partial |

### What reads as amateur or template-like, in one line each
1. A blank first frame and 0.3 s of nothing.
2. Fade + small slide on 15 of 23 animated layers, the "prototype build-in" signature.
3. Layouts lifted from the e-commerce page: a hero card, a 3-up product grid, a pill price. They are not composed for 9:16 or full bleed.
4. A slideshow structure: build, freeze, exit, gap, build. Nothing carries across a cut.
5. Fast moves with hard edges and no blur (three of them), so they strobe.
6. Spring pops used twice, the second with a rotation wobble on centred text.
7. Camera pushes that ease to a stop, plus 1-second frozen holds.
8. Brand hidden until the last quarter, and the CTA visible for under 2 s.
9. Information overload in Scene 3, with read times it cannot meet.
10. A logo fade-in on black (it goes grey before white) and a timid 6 % CTA pulse.

### Worth keeping
Line-mask type reveals (extend them to per-word); the curve set (expo-out, ease-in); the terracotta-on-cream palette with a dark #1f1c18 end card; the trim-path underline (make more of it); the copy facts and their hierarchy.
