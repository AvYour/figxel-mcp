// Types for skills-tree.mjs, which stays plain JavaScript so tools/build.mjs can run it without a compiler.

export interface SkillsTreeFile {
  /** Relative to src/skills, forward slashes, e.g. "figxel-workflow/references/build.md". */
  path: string;
  /** The file's text, LF line endings. */
  text: string;
  sha256: string;
  /** UTF-8 bytes. */
  size: number;
  /** A SKILL.md's frontmatter; null for every other file. */
  frontmatter: Record<string, string> | null;
}

export interface SkillsTree {
  files: SkillsTreeFile[];
  treeHash: string;
}

export function splitSkillFile(text: string): { frontmatter: Record<string, string> | null; body: string };
export function readSkillsTree(dir: string): SkillsTree;
