// A curated typography catalogue for figma_suggest_fonts.
//
// This is design judgement written down, not an external fact (claims.md C-077):
// for well-known families, what kind of face it is, what it is good for, and the
// moods it carries. It never decides availability — suggestions are always
// filtered against figma.listAvailableFontsAsync() on the user's machine — and a
// family that is not listed is still classified by its name ("… Mono", "… Serif").
//
// roles: body = comfortable for paragraphs and UI text at 12–18 px;
//        heading = good at 20–48 px; display = only at large sizes.

export type FontCategory = "sans" | "serif" | "slab" | "mono" | "display" | "script";
export type FontRole = "body" | "heading" | "display";

export interface FontInfo {
  category: FontCategory;
  roles: FontRole[];
  tags: string[];
}

const B: FontRole[] = ["body", "heading"];
const H: FontRole[] = ["heading"];
const D: FontRole[] = ["display", "heading"];

// [family, category, roles, tags]
const ROWS: Array<[string, FontCategory, FontRole[], string]> = [
  // Neutral and UI sans
  ["Inter", "sans", B, "modern neutral minimal ui technical startup corporate"],
  ["Roboto", "sans", B, "neutral ui technical corporate"],
  ["Open Sans", "sans", B, "neutral friendly humanist corporate trustworthy"],
  ["Lato", "sans", B, "warm friendly humanist corporate"],
  ["Source Sans 3", "sans", B, "neutral humanist editorial trustworthy"],
  ["Noto Sans", "sans", B, "neutral international trustworthy"],
  ["IBM Plex Sans", "sans", B, "technical corporate modern trustworthy"],
  ["Public Sans", "sans", B, "neutral trustworthy corporate minimal"],
  ["Work Sans", "sans", B, "modern friendly minimal"],
  ["Karla", "sans", B, "quirky friendly modern"],
  ["Mulish", "sans", B, "minimal clean modern"],
  ["Nunito Sans", "sans", B, "friendly soft modern"],
  ["Figtree", "sans", B, "friendly modern clean startup"],
  ["Hanken Grotesk", "sans", B, "modern neutral minimal"],
  ["Albert Sans", "sans", B, "modern geometric clean"],
  ["Be Vietnam Pro", "sans", B, "modern friendly startup"],
  ["Lexend", "sans", B, "readable friendly modern accessible"],
  ["Red Hat Text", "sans", ["body"], "technical corporate modern"],
  ["Red Hat Display", "sans", H, "technical corporate modern bold"],
  ["Helvetica Neue", "sans", B, "neutral classic minimal corporate"],
  ["Arial", "sans", B, "neutral plain"],
  ["SF Pro Text", "sans", ["body"], "neutral ui modern"],
  ["SF Pro Display", "sans", H, "neutral ui modern"],
  ["Segoe UI", "sans", B, "neutral ui"],
  // Geometric and expressive sans
  ["Montserrat", "sans", B, "geometric bold modern startup"],
  ["Poppins", "sans", B, "geometric friendly modern startup playful"],
  ["DM Sans", "sans", B, "geometric minimal modern clean"],
  ["Manrope", "sans", B, "geometric modern technical minimal"],
  ["Plus Jakarta Sans", "sans", B, "geometric modern startup friendly"],
  ["Outfit", "sans", B, "geometric modern minimal startup"],
  ["Urbanist", "sans", B, "geometric modern minimal"],
  ["Sora", "sans", B, "geometric futuristic technical"],
  ["Space Grotesk", "sans", B, "technical futuristic quirky modern"],
  ["Raleway", "sans", H, "elegant geometric luxury"],
  ["Josefin Sans", "sans", H, "elegant geometric retro"],
  ["Rubik", "sans", B, "rounded friendly playful"],
  ["Archivo", "sans", B, "bold technical modern"],
  ["Barlow", "sans", B, "technical industrial modern"],
  ["Fira Sans", "sans", B, "humanist technical neutral"],
  ["Syne", "display", D, "expressive futuristic artsy bold"],
  ["Unbounded", "display", D, "expressive futuristic bold playful"],
  // Rounded and playful
  ["Nunito", "sans", B, "rounded friendly playful soft"],
  ["Quicksand", "sans", H, "rounded friendly playful light"],
  ["Comfortaa", "display", D, "rounded playful friendly"],
  ["Fredoka", "display", D, "rounded playful kids bold"],
  ["Baloo 2", "display", D, "rounded playful friendly bold"],
  ["Varela Round", "sans", B, "rounded friendly soft"],
  // Condensed and impact
  ["Bebas Neue", "display", ["display"], "condensed bold impact poster"],
  ["Oswald", "sans", H, "condensed bold impact editorial"],
  ["Anton", "display", ["display"], "condensed bold impact poster"],
  ["Archivo Black", "display", D, "bold impact poster"],
  ["Righteous", "display", ["display"], "retro playful bold"],
  // Serif
  ["Playfair Display", "serif", D, "elegant editorial luxury classic"],
  ["Merriweather", "serif", B, "editorial readable classic trustworthy"],
  ["Lora", "serif", B, "editorial warm literary elegant"],
  ["Libre Baskerville", "serif", B, "classic editorial literary"],
  ["Cormorant Garamond", "serif", D, "elegant luxury classic literary"],
  ["EB Garamond", "serif", B, "classic literary elegant"],
  ["Crimson Pro", "serif", B, "literary editorial classic"],
  ["Source Serif 4", "serif", B, "editorial readable trustworthy"],
  ["PT Serif", "serif", B, "classic editorial readable"],
  ["Noto Serif", "serif", B, "classic readable international"],
  ["IBM Plex Serif", "serif", B, "technical editorial corporate"],
  ["DM Serif Display", "serif", D, "elegant editorial luxury bold"],
  ["Fraunces", "serif", D, "expressive warm retro editorial"],
  ["Instrument Serif", "serif", D, "elegant editorial modern luxury"],
  ["Abril Fatface", "display", ["display"], "bold editorial poster luxury"],
  ["Georgia", "serif", B, "classic editorial readable"],
  ["Times New Roman", "serif", B, "classic plain"],
  // Slab
  ["Roboto Slab", "slab", B, "sturdy technical editorial"],
  ["Zilla Slab", "slab", B, "sturdy editorial quirky"],
  ["Bitter", "slab", B, "sturdy readable editorial"],
  ["Arvo", "slab", B, "sturdy retro"],
  // Mono
  ["JetBrains Mono", "mono", B, "code technical developer"],
  ["Fira Code", "mono", B, "code technical developer"],
  ["IBM Plex Mono", "mono", B, "code technical corporate"],
  ["Source Code Pro", "mono", B, "code technical"],
  ["Roboto Mono", "mono", B, "code technical neutral"],
  ["Space Mono", "mono", H, "code retro quirky futuristic"],
  ["DM Mono", "mono", B, "code minimal modern"],
  ["Inconsolata", "mono", B, "code technical"],
  // Script
  ["Caveat", "script", ["display"], "handwritten casual friendly"],
  ["Pacifico", "script", ["display"], "handwritten playful retro"],
  ["Dancing Script", "script", ["display"], "handwritten elegant"],
  ["Satisfy", "script", ["display"], "handwritten elegant"],
];

export const FONT_CATALOG: ReadonlyMap<string, FontInfo> = new Map(
  ROWS.map(([family, category, roles, tags]) => [family.toLowerCase(), { category, roles, tags: tags.split(" ") }]),
);

/** A family not in the catalogue, classified only by what its name says. */
export function classifyByName(family: string): FontInfo {
  const f = family.toLowerCase();
  if (/\bmono\b|code|console/.test(f)) return { category: "mono", roles: ["body", "heading"], tags: ["code", "technical"] };
  if (/slab/.test(f)) return { category: "slab", roles: ["body", "heading"], tags: ["sturdy"] };
  if (/serif/.test(f) && !/sans/.test(f)) return { category: "serif", roles: ["body", "heading"], tags: ["classic"] };
  if (/script|hand|brush/.test(f)) return { category: "script", roles: ["display"], tags: ["handwritten"] };
  if (/display|poster|black/.test(f)) return { category: "display", roles: ["display", "heading"], tags: ["bold"] };
  return { category: "sans", roles: ["body", "heading"], tags: [] };
}

export function fontInfo(family: string): { info: FontInfo; known: boolean } {
  const hit = FONT_CATALOG.get(family.toLowerCase());
  return hit ? { info: hit, known: true } : { info: classifyByName(family), known: false };
}

/** Moods a person might say, mapped to catalogue tags. */
export const MOOD_WORDS: Record<string, string[]> = {
  modern: ["modern", "geometric", "minimal"],
  minimal: ["minimal", "neutral", "clean"],
  clean: ["clean", "minimal", "neutral"],
  corporate: ["corporate", "trustworthy", "neutral"],
  professional: ["corporate", "trustworthy", "neutral"],
  trustworthy: ["trustworthy", "readable", "neutral"],
  friendly: ["friendly", "rounded", "warm", "soft"],
  playful: ["playful", "rounded", "friendly", "quirky"],
  fun: ["playful", "rounded", "quirky"],
  kids: ["kids", "playful", "rounded"],
  elegant: ["elegant", "luxury", "classic"],
  luxury: ["luxury", "elegant"],
  premium: ["luxury", "elegant", "minimal"],
  editorial: ["editorial", "literary", "classic"],
  magazine: ["editorial", "elegant", "bold"],
  classic: ["classic", "literary"],
  technical: ["technical", "code", "neutral"],
  tech: ["technical", "futuristic", "modern"],
  developer: ["code", "technical", "developer"],
  futuristic: ["futuristic", "technical", "expressive"],
  startup: ["startup", "modern", "geometric", "friendly"],
  saas: ["startup", "modern", "neutral", "ui"],
  bold: ["bold", "impact", "condensed"],
  poster: ["poster", "impact", "bold"],
  retro: ["retro", "quirky"],
  warm: ["warm", "humanist", "friendly"],
  calm: ["soft", "minimal", "humanist"],
  artsy: ["artsy", "expressive", "quirky"],
  handwritten: ["handwritten", "casual"],
  readable: ["readable", "humanist", "accessible"],
  accessible: ["accessible", "readable"],
};

/** Type scales by use: [size, line height] pairs, smallest to largest. */
export const TYPE_SCALES: Record<string, Array<{ role: string; size: number; lineHeight: number; weight: string }>> = {
  ui: [
    { role: "caption", size: 12, lineHeight: 16, weight: "Regular" },
    { role: "body", size: 14, lineHeight: 20, weight: "Regular" },
    { role: "body-large", size: 16, lineHeight: 24, weight: "Regular" },
    { role: "title", size: 20, lineHeight: 28, weight: "Semi Bold" },
    { role: "heading", size: 24, lineHeight: 32, weight: "Semi Bold" },
    { role: "display", size: 32, lineHeight: 40, weight: "Bold" },
  ],
  marketing: [
    { role: "caption", size: 14, lineHeight: 20, weight: "Regular" },
    { role: "body", size: 18, lineHeight: 28, weight: "Regular" },
    { role: "subheading", size: 24, lineHeight: 32, weight: "Medium" },
    { role: "heading", size: 40, lineHeight: 48, weight: "Bold" },
    { role: "display", size: 56, lineHeight: 64, weight: "Bold" },
    { role: "hero", size: 72, lineHeight: 80, weight: "Bold" },
  ],
  editorial: [
    { role: "caption", size: 14, lineHeight: 20, weight: "Regular" },
    { role: "body", size: 18, lineHeight: 30, weight: "Regular" },
    { role: "pull-quote", size: 24, lineHeight: 36, weight: "Regular" },
    { role: "heading", size: 32, lineHeight: 40, weight: "Bold" },
    { role: "headline", size: 48, lineHeight: 56, weight: "Bold" },
  ],
  mobile: [
    { role: "caption", size: 12, lineHeight: 16, weight: "Regular" },
    { role: "body", size: 15, lineHeight: 22, weight: "Regular" },
    { role: "title", size: 17, lineHeight: 24, weight: "Semi Bold" },
    { role: "heading", size: 22, lineHeight: 28, weight: "Bold" },
    { role: "large-title", size: 28, lineHeight: 34, weight: "Bold" },
  ],
};
