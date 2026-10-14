// The skills: every word of agent guidance, from one source [C-237].
//
// src/skills/figxel-<short>/SKILL.md is a skill's index and
// references/<section>.md its sections, in the Agent Skills format [C-174].
// The same bytes reach a model five ways — figma_get_guide (the floor every
// client has), the instructions' pointer, the prompts, the skill:// resources
// and the folders installed as skills — so no surface can drift from another.
//
// The tree is baked into dist/server.js by tools/build.mjs; without the bundle
// (vitest, tsc) the same walker reads src/skills, so the two paths share one
// parser and one hash.

import { fileURLToPath } from "node:url";
import { readSkillsTree, splitSkillFile, type SkillsTree, type SkillsTreeFile } from "../../tools/skills-tree.mjs";
import { BridgeError, ErrorCode } from "../shared/errors.js";
import { PRODUCT_NAME, SERVER_NAME } from "../shared/version.js";

declare const __SKILLS_TREE__: SkillsTree | undefined;

/**
 * The tree esbuild inlined, or undefined. Referenced once, inside a try:
 * esbuild pastes the whole tree at every reference, and without the bundle the
 * global is undeclared, so reading it throws instead of giving undefined.
 */
function bundledTree(): SkillsTree | undefined {
  try {
    return __SKILLS_TREE__;
  } catch {
    return undefined;
  }
}

const BUNDLED = bundledTree();

export const SKILLS_TREE: SkillsTree = BUNDLED ?? readSkillsTree(fileURLToPath(new URL("../skills", import.meta.url)));
/** True in dist/server.js: only a bundle can be older than the tree on disk. */
export const SKILLS_BUNDLED = BUNDLED !== undefined;
/** 12 hex of the tree hash — `skillsBuildId` in dist/build-id.json, `skills.version` in figma_status. */
export const SKILLS_VERSION = SKILLS_TREE.treeHash.slice(0, 12);

/** Every skill folder and frontmatter name starts with it: `figxel-workflow`, `figxel-design`, … */
export const SKILL_PREFIX = `${SERVER_NAME}-`;
/** The figma_get_guide topic that answers with the catalog instead of a skill. */
export const CATALOG_TOPIC = "skills";

export interface SkillSection {
  slug: string;
  file: SkillsTreeFile;
  body: string;
}

export interface Skill {
  /** The folder name without the prefix — the figma_get_guide topic. */
  short: string;
  /** The folder name, equal to the frontmatter `name`. */
  name: string;
  description: string;
  file: SkillsTreeFile;
  /** SKILL.md without its frontmatter. */
  body: string;
  /** In the order the index names them. */
  sections: SkillSection[];
  /** Every file of the skill folder, SKILL.md first. */
  files: SkillsTreeFile[];
}

// The order a person reads the catalog in: the loop first, then the process
// skills, then the specialised ones. A skill not listed sorts after, by name.
const RANK = [
  "workflow", "design", "storyboard", "motion", "critique",
  "design-system", "design-to-code", "code-to-design", "prototype", "figjam", "slides",
];
const rank = (short: string) => {
  const i = RANK.indexOf(short);
  return i < 0 ? RANK.length : i;
};

/** Group the tree into skills. A folder without a valid SKILL.md is a build defect, refused loudly. */
export function skillsOf(tree: SkillsTree): Skill[] {
  const byFolder = new Map<string, SkillsTreeFile[]>();
  for (const f of tree.files) {
    const folder = f.path.split("/")[0]!;
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), f]);
  }
  const skills: Skill[] = [];
  for (const [folder, files] of byFolder) {
    const index = files.find((f) => f.path === `${folder}/SKILL.md`);
    if (!index) throw new Error(`src/skills/${folder} has no SKILL.md`);
    if (!folder.startsWith(SKILL_PREFIX)) throw new Error(`src/skills/${folder}: a skill folder is named ${SKILL_PREFIX}<short>`);
    const { frontmatter, body } = splitSkillFile(index.text);
    if (frontmatter?.name !== folder || !frontmatter.description) {
      throw new Error(`src/skills/${folder}/SKILL.md: the frontmatter needs name: ${folder} and a description`);
    }
    const sections = files
      .map((f) => ({ f, m: new RegExp(`^${folder}/references/([a-z0-9-]+)\\.md$`).exec(f.path) }))
      .filter((x): x is { f: SkillsTreeFile; m: RegExpExecArray } => x.m !== null)
      .map(({ f, m }) => ({ slug: m[1]!, file: f, body: splitSkillFile(f.text).body }));
    // The index decides the order; a section it never names (test/skills.test.ts T3 refuses that) goes last.
    const at = (s: SkillSection) => {
      const i = body.indexOf(`references/${s.slug}.md`);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    sections.sort((a, b) => at(a) - at(b) || a.slug.localeCompare(b.slug));
    skills.push({
      short: folder.slice(SKILL_PREFIX.length),
      name: folder,
      description: frontmatter.description,
      file: index,
      body,
      sections,
      files: [index, ...files.filter((f) => f !== index)],
    });
  }
  return skills.sort((a, b) => rank(a.short) - rank(b.short) || a.short.localeCompare(b.short));
}

export const SKILLS: readonly Skill[] = skillsOf(SKILLS_TREE);

const BY_SHORT = new Map(SKILLS.map((s) => [s.short, s]));
const BY_SLUG = new Map(SKILLS.flatMap((skill) => skill.sections.map((section) => [section.slug, { skill, section }] as const)));

/** Every value figma_get_guide's `topic` takes: skill short names, section slugs, and the catalog. */
const topicNames: string[] = [...SKILLS.map((s) => s.short), ...BY_SLUG.keys(), CATALOG_TOPIC];
export const GUIDE_TOPIC_NAMES = topicNames as [string, ...string[]];

export function skillByShort(short: string): Skill | undefined {
  return BY_SHORT.get(short);
}

export function sectionBySlug(slug: string): { skill: Skill; section: SkillSection } | undefined {
  return BY_SLUG.get(slug);
}

export type Resolved =
  | { kind: "catalog" }
  | { kind: "skill"; skill: Skill }
  | { kind: "section"; skill: Skill; section: SkillSection };

const quoteList = (names: readonly string[]) => names.map((n) => `"${n}"`).join(", ");

/**
 * What `figma_get_guide { topic, section }` names. A topic is a skill, a section
 * (every slug is unique across the tree), or the catalog; `section` picks one
 * of that skill's sections. Refused with the valid names, never guessed.
 */
export function resolveTopic(topic = "workflow", section?: string): Resolved {
  if (topic === CATALOG_TOPIC) {
    if (section !== undefined) {
      const ex = example();
      throw new BridgeError(ErrorCode.INVALID_PARAM, `topic "${CATALOG_TOPIC}" is the catalog and has no sections.`, {
        hint: `Name a skill as topic, then one of its sections${ex ? `, e.g. ${sectionCall(ex.skill, ex.section)}` : ""}.`,
      });
    }
    return { kind: "catalog" };
  }
  const skill = BY_SHORT.get(topic);
  if (skill) {
    if (section === undefined) return { kind: "skill", skill };
    const found = skill.sections.find((s) => s.slug === section);
    if (found) return { kind: "section", skill, section: found };
    throw new BridgeError(ErrorCode.INVALID_PARAM, `"${section}" is not a section of the ${skill.short} skill.`, {
      hint: skill.sections.length
        ? `Its sections: ${quoteList(skill.sections.map((s) => s.slug))}.`
        : `The ${skill.short} skill has no sections; omit \`section\`.`,
    });
  }
  const bySlug = BY_SLUG.get(topic);
  if (bySlug) {
    if (section === undefined || section === topic) return { kind: "section", ...bySlug };
    throw new BridgeError(ErrorCode.INVALID_PARAM, `topic "${topic}" is already a section, of the ${bySlug.skill.short} skill.`, {
      hint: `Pass the skill as topic: figma_get_guide { topic: "${bySlug.skill.short}", section: "${section}" }.`,
    });
  }
  throw new BridgeError(ErrorCode.INVALID_PARAM, `"${topic}" is not a skill or a section.`, {
    hint: `Skills: ${quoteList(SKILLS.map((s) => s.short))}; "${CATALOG_TOPIC}" lists them with their sections.`,
  });
}

const indexCall = (skill: Skill) => `figma_get_guide { topic: "${skill.short}" }`;
const sectionCall = (skill: Skill, section: SkillSection) => `figma_get_guide { topic: "${skill.short}", section: "${section.slug}" }`;

/**
 * What every guide answer ends with: the rest of this skill, then every other
 * skill, each as the exact call that fetches it. One answer is enough to reach
 * every byte, which is what a client with nothing but tools relies on.
 */
export function guideFooter(skill: Skill, current?: SkillSection): string {
  const here = [
    ...(current ? [`- ${indexCall(skill)} — the index`] : []),
    ...skill.sections.filter((s) => s !== current).map((s) => `- ${sectionCall(skill, s)}`),
  ];
  const others = SKILLS.filter((s) => s !== skill).map((s) => `- ${indexCall(s)}`);
  return [
    "---",
    ...(here.length ? [`More of the ${skill.short} skill:`, ...here] : []),
    `Other skills (figma_get_guide { topic: "${CATALOG_TOPIC}" } says what each is for):`,
    ...others,
  ].join("\n");
}

/** A real skill and section for an example call: a placeholder in a call gets copied literally. */
function example(): { skill: Skill; section: SkillSection } | undefined {
  const skill = SKILLS.find((s) => s.sections.length > 0);
  return skill ? { skill, section: skill.sections[0]! } : undefined;
}

/** The catalog: each skill's name, description and sections. */
export function catalogText(): string {
  const ex = example();
  return [
    `# ${PRODUCT_NAME} skills`,
    "",
    "Each skill is the playbook for one kind of work. Read a skill by its name as the topic" +
      (ex ? `, e.g. ${indexCall(ex.skill)}, and a section with ${sectionCall(ex.skill, ex.section)}.` : "."),
    "",
    ...SKILLS.map((s) => `- ${s.short} — ${s.description}${s.sections.length ? ` Sections: ${s.sections.map((x) => x.slug).join(", ")}.` : ""}`),
  ].join("\n");
}

/** The text figma_get_guide answers with: the file body, then the footer. */
export function guideText(r: Resolved): string {
  if (r.kind === "catalog") return catalogText();
  const body = r.kind === "section" ? r.section.body : r.skill.body;
  return `${body}\n\n${guideFooter(r.skill, r.kind === "section" ? r.section : undefined)}`;
}

/** The body figma_get_guide returns for a topic, without the footer. */
export function topicBody(topic: string): string {
  const r = resolveTopic(topic);
  if (r.kind === "catalog") return catalogText();
  return r.kind === "section" ? r.section.body : r.skill.body;
}
