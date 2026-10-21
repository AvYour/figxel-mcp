// The skills: one source in src/skills, five surfaces [C-237].
//
// What this pins is the promise that makes the tree worth having — every
// surface serves the same bytes, and a client with nothing but tools can still
// reach every one of them — plus the format and budget rules that keep the
// folders installable as skills in any client [C-174] [C-175]. T1–T10 are the
// drift checks of the plan (§1.6); the rest pin the move from guides.ts and
// each surface's own behaviour.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSkillsTree, splitSkillFile } from "../tools/skills-tree.mjs";
import { loadConfig, readOrCreateToken } from "../src/server/config.js";
import { GUIDE_TOPICS, GUIDES, SERVER_INSTRUCTIONS } from "../src/server/guides.js";
import { connect, createApp, type App } from "../src/server/mcp.js";
import { checkSkillsBuild } from "../src/server/plugin-build.js";
import { PROMPTS, promptText, readCheckpoint, registerPrompts, type PromptRow } from "../src/server/prompts.js";
import { CATALOG_TOPIC, catalogText, GUIDE_TOPIC_NAMES, guideFooter, resolveTopic, SKILLS, SKILLS_BUNDLED, SKILLS_TREE, SKILLS_VERSION, skillsOf } from "../src/server/skills.js";
import { buildStatus } from "../src/server/tools/meta.js";
import type { Bridge, BridgeStatus } from "../src/server/bridge.js";
import { OPS, selectOps, toolName } from "../src/shared/ops.js";
import { BridgeError } from "../src/shared/errors.js";
import { CREATE_OPS } from "../src/plugin/ops/create.js";
import { toReaction } from "../src/plugin/ops/style.js";
import { registerFigjamSpecTypes } from "../src/plugin/figjam/spec-types.js";
import { installFigma, opContext } from "./editor-fakes.js";
import { board } from "./figjam-fakes.js";
import { quietLogger } from "./helpers.js";
import { WriteFigma } from "./write-fakes.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILLS_DIR = join(ROOT, "src/skills");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const lf = (s: string) => s.replace(/\r\n/g, "\n");

/** Every topic's text at a6ebb06, taken before anything moved. */
const SNAPSHOT = JSON.parse(readFileSync(new URL("./fixtures/guide-topics-a6ebb06.json", import.meta.url), "utf8")) as Record<string, string>;

/** The tree read fresh from disk, not the module's copy. */
const DISK = readSkillsTree(SKILLS_DIR);
const DISK_SKILLS = skillsOf(DISK);
const allBodies = () => DISK_SKILLS.flatMap((s) => [s.body, ...s.sections.map((x) => x.body)]);

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

async function inMemory(env: Record<string, string> = {}): Promise<{ app: App; client: Client }> {
  const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-skills-")), BRIDGE_PORT: "0", BRIDGE_SESSION_WAIT_MS: "200", ...env });
  const app = await createApp(config, readOrCreateToken(config.tokenPath), quietLogger);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "skills-test", version: "0" });
  await Promise.all([connect(app, a), client.connect(b)]);
  return { app, client };
}

/**
 * Every `figma_<tool> { key, key: value, … }` a text shows, with its top-level
 * keys. Nested braces, brackets and quoted strings are skipped, so a spec's
 * JSON or a `sizing: { horizontal }` value does not count as a key.
 */
function toolCalls(text: string): Array<{ tool: string; keys: string[] }> {
  const out: Array<{ tool: string; keys: string[] }> = [];
  for (const m of text.matchAll(/\b(figma_[a-z_]+) \{/g)) {
    const parts: string[] = [];
    let cur = "";
    let depth = 1;
    let quoted = false;
    for (let i = m.index! + m[0].length; i < text.length && depth > 0; i++) {
      const ch = text[i]!;
      if (quoted || ch === '"') quoted = ch === '"' ? !quoted : quoted;
      else if ("{[(".includes(ch)) depth++;
      else if ("}])".includes(ch)) depth--;
      if (depth === 1 && ch === "," && !quoted) {
        parts.push(cur);
        cur = "";
      } else if (depth > 0) cur += ch;
    }
    parts.push(cur);
    const keys = parts.map((p) => /^\s*([A-Za-z_]\w*)\??\s*(?::|$)/.exec(p)?.[1]).filter((k): k is string => k !== undefined);
    out.push({ tool: m[1]!, keys });
  }
  return out;
}

/** Every literal `figma_get_guide { topic: "…"[, section: "…"] }` in a text. */
const guideCallsIn = (text: string) =>
  [...text.matchAll(/figma_get_guide \{ topic: "([^"]+)"(?:, section: "([^"]+)")? \}/g)].map((m) => ({ topic: m[1]!, section: m[2] }));

// ── the surfaces, through a real MCP client ─────────────────────────────────

describe("every surface serves the source bytes (T2)", () => {
  let app: App;
  let client: Client;
  beforeAll(async () => ({ app, client } = await inMemory({ BRIDGE_ALLOW_EVAL: "1" })));
  afterAll(async () => {
    await client.close();
    await app.close();
  });
  const guide = async (args: Record<string, string>) => (await client.callTool({ name: "figma_get_guide", arguments: args })) as ToolResult;

  it("the module serves the tree on disk", () => {
    expect(SKILLS_BUNDLED).toBe(false);
    expect(SKILLS_TREE.treeHash).toBe(DISK.treeHash);
    expect(SKILLS_VERSION).toBe(DISK.treeHash.slice(0, 12));
  });

  it("figma_get_guide returns every skill's index and every section's file body, then the footer", async () => {
    for (const skill of DISK_SKILLS) {
      const r = await guide({ topic: skill.short });
      expect(r.isError, skill.short).toBeFalsy();
      expect(r.content).toHaveLength(1);
      expect(r.content[0]!.text).toBe(`${skill.body}\n\n${guideFooter(SKILLS.find((s) => s.short === skill.short)!)}`);
      // Text only: a client that prefers structuredContent would drop the guide.
      expect(r.structuredContent).toBeUndefined();
      for (const section of skill.sections) {
        const viaSkill = await guide({ topic: skill.short, section: section.slug });
        const viaSlug = await guide({ topic: section.slug });
        expect(viaSkill.content[0]!.text.startsWith(`${section.body}\n\n---\n`), section.slug).toBe(true);
        expect(viaSlug.content[0]!.text).toBe(viaSkill.content[0]!.text);
      }
    }
  });

  it("no arguments is the workflow index", async () => {
    expect((await guide({})).content[0]!.text).toBe((await guide({ topic: "workflow" })).content[0]!.text);
  });

  it("every old topic name still resolves", async () => {
    for (const topic of GUIDE_TOPICS) {
      const r = await guide({ topic });
      expect(r.isError, topic).toBeFalsy();
      expect(r.content[0]!.text.length).toBeGreaterThan(300);
    }
  });

  it("from one call with no arguments, following the footers reaches every byte of every skill", async () => {
    // What a client with nothing but tools relies on: no prompts, no
    // resources, no instructions — the default answer leads everywhere.
    const seen = new Set<string>();
    const queue: Array<Record<string, string>> = [{}];
    const asked = new Set<string>();
    while (queue.length) {
      const args = queue.shift()!;
      const key = JSON.stringify(args);
      if (asked.has(key)) continue;
      asked.add(key);
      const text = (await guide(args)).content[0]!.text;
      seen.add(text.split("\n\n---\n")[0]!);
      for (const c of guideCallsIn(text)) queue.push(c.section ? { topic: c.topic, section: c.section } : { topic: c.topic });
    }
    expect(allBodies().filter((b) => !seen.has(b))).toEqual([]);
  });

  it("resources: one per SKILL.md, every reference through the template, each read returning the file's bytes", async () => {
    const { resources } = await client.listResources();
    const byUri = new Map(resources.map((r) => [r.uri, r]));
    for (const f of DISK.files) {
      const uri = `skill://${f.path}`;
      const listed = byUri.get(uri);
      expect(listed, uri).toBeDefined();
      expect(listed!.mimeType).toBe("text/markdown");
      expect(listed!.size).toBe(f.size);
      expect(listed!.annotations).toEqual({ audience: ["assistant"] });
      const read = await client.readResource({ uri });
      expect((read.contents[0] as { text: string }).text).toBe(lf(readFileSync(join(SKILLS_DIR, f.path), "utf8")));
    }
    for (const skill of DISK_SKILLS) {
      const r = byUri.get(`skill://${skill.name}/SKILL.md`)!;
      expect([r.name, r.description]).toEqual([skill.name, skill.description]);
    }
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("skill://{skill}/references/{section}.md");
    await expect(client.readResource({ uri: "skill://figxel-workflow/references/nope.md" })).rejects.toThrow(/not found/);
  });

  it("every prompt contains its SKILL.md body, its section, and the calls for the rest — within 16,000 bytes", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(PROMPTS.map((p) => p.name).sort());
    for (const row of PROMPTS) {
      const args = Object.fromEntries(row.args.map((a) => [a.name, SAMPLE[a.name] ?? "x"]));
      const text = ((await client.getPrompt({ name: row.name, arguments: args })).messages[0]!.content as { text: string }).text;
      const skill = DISK_SKILLS.find((s) => s.short === row.skill)!;
      expect(text, row.name).toContain(skill.body);
      const slug = typeof row.section === "function" ? row.section(args) : row.section;
      if (slug) expect(text, row.name).toContain(allBodies().find((b) => b === GUIDES[slug])!);
      expect(text, row.name).toContain(`figma_get_guide { topic: "${CATALOG_TOPIC}" }`);
      expect(bytes(text), row.name).toBeLessThanOrEqual(16_000);
    }
  });
});

/** Realistic argument values for the budget check. */
const SAMPLE: Record<string, string> = {
  brief: "a pricing section with three plans", slideCount: "8", nodeId: "12:34", target: "react + tailwind",
  clientLanguages: "typescript,css", clientFrameworks: "react,tailwind", rulesPath: "AGENTS.md", source: "src/components/Hero.tsx",
  duration: "6", placement: "Instagram Story", lens: "all", checkpoint: "none",
};

// ── the move from guides.ts ─────────────────────────────────────────────────

describe("the move from guides.ts kept every word (snapshot of a6ebb06)", () => {
  // Every change to an old topic is declared here, change by change: anything
  // else is drift. A later edit of an old topic's content is declared in
  // REWRITTEN with its reason, which takes that topic out of the checks below.
  const REWRITTEN: Record<string, string> = {
    workflow:
      "points new work at the design and storyboard skills by gear; every element earns its place instead of decoration by default; " +
      "the role process (2026-10-16): state the role and the gear, read the role's skill, figma_set_brief first, the finish ends with figma_sign_off; " +
      "trust (2026-10-19): figma_savepoint at the start of each instruction, what STALE asks for, the report from figma_get_changes, figma_rollback to undo an instruction; prose trimmed to stay in budget",
    build:
      "the worked example taught generated tells (a caps eyebrow, a centred block, identical icon cards, vague copy, a blob, one radius); a second example reaches the opposite answer from its brief; " +
      "trust (2026-10-19): the example opens with figma_savepoint, and its report lists what changed from figma_get_changes",
    check:
      "the craft and tells audits, safeArea and minTextSize, the squint test, and a pointer to figma_check_motion; " +
      "the role process (2026-10-16): the a11y, states, copy and system audits with their kinds, severities and fixes, and briefId; " +
      "role quality (2026-10-20): tells by default under a page or top brief, a kind on its avoid list a warning, and the create result's tells",
    tools:
      "rows for the storyboard, animatic, motion-check and video-review tools, and the changed ones; figma_set_motion_plan and the final render (2026-10-14); " +
      "a sound row that names no tool: the audio tools were held back (2026-10-14, docs/superpowers/plans/2026-10-14-audio-held.md); " +
      "the role process (2026-10-16): rows for figma_set_brief, figma_get_brief and figma_sign_off, the new audits and final exports; " +
      "trust (2026-10-19): rows for figma_savepoint, figma_get_changes, figma_rollback and figma_stress_test",
    typography: "body sizes and leading from C-210, the accented-word habit, figures checked at display size, and criteria before figma_suggest_fonts' ranking; families checked by filter, figma_suggest_fonts optional (acceptance run 1); new text's lineHeight and letterSpacing as strings, a bare number px (found later)",
    slides:
      "a new deck runs the design skill's page gear; the deck principles became decisions the brief makes (C-218); " +
      "the role process (2026-10-16): the presentation brief and sign-off, and a story section (the arc, a sentence per slide, assertion headlines, density by room, the deck audit)",
    figjam:
      "the role process (2026-10-16): a new board starts with a board-role brief (figma_set_brief) and ends with figma_sign_off once the board audit passes",
    motion:
      "the mechanics section gained the frame-grid facts, cut pairs, job-mode rendering, readback and a UI micro-motion recipe (plan §1.2); " +
      "the index opens with the senior motion designer's role and the stages the tools enforce: a plan before keyframes, a passing check before the final render (BRIDGE_PROCESS, 2026-10-14); " +
      "the index sends delivery to the formats section, whose sound part is one neutral line since the audio tools were held back (2026-10-14); " +
      "the role process (2026-10-16): a role-motion brief first, the plan takes what it leaves out from it, figma_sign_off before the final render",
    safety:
      "job mode on figma_export_video, the restored-window rule, and created ids inside an animated frame (plan §1.2); what PROCESS_REQUIRED asks for (2026-10-14); " +
      "the role process (2026-10-16): PROCESS_REQUIRED for new work and final exports too; " +
      "trust (2026-10-19): figma_savepoint and figma_rollback replace the figma_undo_step advice, what ROLLBACK_BLOCKED and STALE ask for, force only on the person's word, the report from figma_get_changes",
    "design-system":
      "decides whose system the file holds before applying it: another brand's styles are reference (acceptance run 1); " +
      "the role process (2026-10-16): the design-system role's brief, its components' states (the ux skill's states section), figma_sign_off",
    "code-to-design":
      "fonts checked with figma_get_fonts' family filter or a figma_create_text try, never the unfiltered list (acceptance run 1); " +
      "the role process (2026-10-16): the replica brief, figma_set_brief with role ux and gear replica, and figma_sign_off",
    spec: "lineHeight and letterSpacing take figma_set_text_properties' strings (\"auto\", \"24\", \"150%\", \"-2%\"); a bare number is px (acceptance run 1, found later)",
  };
  const checked = (topics: string[]) => topics.filter((t) => !(t in REWRITTEN));
  const UNCHANGED = checked(["build", "spec", "check", "safety", "tools", "library", "typography", "rules", "code-to-design", "prototype"]);
  const SECTION_LIST = "## Sections of this skill\n";
  const blocks = (t: string) => t.split(/\n\n(?=## )/);
  // Each pair is one declared rewording of an old topic: [text at a6ebb06, text now].
  const REWORDED: Record<string, Array<[string, string]>> = {
    figjam: [
      // Shared a 12-word run with the official FigJam skill (T9), so it was put in our own words.
      [
        "- Sticky colours can carry meaning: blue discussion, yellow question, green positive, pink concern, red blocker, teal decision, violet idea.",
        "- Sticky colours can carry meaning; one scheme gives yellow to questions, blue to discussion, green to what went well, pink to concerns, red to blockers, teal to decisions and violet to ideas.",
      ],
      // The product was renamed for the public release (figma-mcp → Figxel).
      ["figma-mcp has no such layout engine yet", "Figxel has no such layout engine yet"],
    ],
  };

  it("the snapshot holds the 16 topics, and a rewrite names one of them with its reason", () => {
    expect(Object.keys(SNAPSHOT).sort()).toEqual([...GUIDE_TOPICS].sort());
    for (const [t, why] of Object.entries(REWRITTEN)) {
      expect(SNAPSHOT[t], t).toBeDefined();
      expect(why.length, t).toBeGreaterThan(10);
    }
  });

  it("the topics nobody rewrote are served exactly as before", () => {
    for (const t of UNCHANGED) expect(GUIDES[t as keyof typeof GUIDES], t).toBe(SNAPSHOT[t]);
  });

  it.skipIf("motion" in REWRITTEN)("the motion topic's text is the motion skill's mechanics section, unchanged; topic motion is its new index", () => {
    expect(GUIDES.mechanics).toBe(SNAPSHOT.motion);
    expect(GUIDES.motion).toContain("references/mechanics.md");
  });

  it("workflow, design-system and design-to-code gained only their section list, at the end", () => {
    for (const t of checked(["workflow", "design-system", "design-to-code"]) as Array<"workflow" | "design-system" | "design-to-code">) {
      const body = GUIDES[t];
      expect(body.startsWith(`${SNAPSHOT[t]}\n\n${SECTION_LIST}`), t).toBe(true);
      const list = body.slice(SNAPSHOT[t]!.length + 2 + SECTION_LIST.length).split("\n");
      for (const line of list) expect(line, t).toMatch(/^- section `([a-z0-9-]+)` \(references\/\1\.md, or figma_get_guide \{ topic: "[a-z-]+", section: "\1" \}\) — .+$/);
    }
  });

  it("figjam and slides were split by whole sections into an index and recipes, in order", () => {
    for (const [short, slug] of ([["figjam", "board-recipes"], ["slides", "deck-recipes"]] as const).filter(([s]) => !(s in REWRITTEN))) {
      const old = blocks((REWORDED[short] ?? []).reduce((text, [from, to]) => {
        expect(text, `${short}: "${from.slice(0, 40)}"`).toContain(from);
        return text.replace(from, to);
      }, SNAPSHOT[short]!));
      const own = blocks(GUIDES[short]).filter((b) => !b.startsWith(SECTION_LIST));
      const recipes = blocks(GUIDES[slug]!);
      expect(recipes[0], slug).toMatch(/^# [^\n]+$/); // the reference's own title
      const moved = recipes.slice(1);
      let i = 0;
      let j = 0;
      for (const b of old) {
        if (own[i] === b) i++;
        else if (moved[j] === b) j++;
        else expect.fail(`${short}: block ${JSON.stringify(b.slice(0, 40))} is missing or out of order`);
      }
      expect([i, j]).toEqual([own.length, moved.length]);
      expect(moved.length).toBeGreaterThan(0);
    }
  });
});

// ── T1: the format every client accepts ─────────────────────────────────────

describe("format and budgets (T1)", () => {
  it("frontmatter: only name and description; name = folder, Agent Skills rules; description 1–300 bytes, a plain YAML scalar", () => {
    expect(DISK_SKILLS.length).toBeGreaterThanOrEqual(8);
    for (const skill of DISK_SKILLS) {
      const fm = splitSkillFile(skill.file.text).frontmatter!;
      expect(Object.keys(fm), skill.name).toEqual(["name", "description"]);
      expect(fm.name).toBe(skill.name);
      expect(skill.name).toMatch(/^figxel-[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skill.name.length).toBeLessThanOrEqual(64);
      const d = fm.description!;
      expect(bytes(d), skill.name).toBeGreaterThanOrEqual(1);
      expect(bytes(d), skill.name).toBeLessThanOrEqual(300);
      // Plain scalars only: a client's YAML parser must read exactly this text.
      expect(d, skill.name).not.toMatch(/: | #|^[-?:,[\]{}#&*!|>'"%@`]|\s$/);
    }
  });

  it("an index is ≤ 5,000 bytes and ≤ 120 lines; a reference ≤ 10,000 bytes; a skill ≤ 60,000 bytes", () => {
    for (const skill of DISK_SKILLS) {
      expect(bytes(skill.body), skill.name).toBeLessThanOrEqual(5_000);
      expect(skill.body.split("\n").length, skill.name).toBeLessThanOrEqual(120);
      for (const s of skill.sections) expect(s.file.size, s.file.path).toBeLessThanOrEqual(10_000);
      expect(skill.files.reduce((n, f) => n + f.size, 0), skill.name).toBeLessThanOrEqual(60_000);
    }
  });

  it("a skill folder holds SKILL.md and references/<section>.md, one level deep, LF, ending in a newline", () => {
    for (const f of DISK.files) {
      expect(f.path).toMatch(/^figxel-[a-z0-9-]+\/(SKILL\.md|references\/[a-z0-9]+(-[a-z0-9]+)*\.md)$/);
      const raw = readFileSync(join(SKILLS_DIR, f.path), "utf8");
      expect(raw.includes("\r"), f.path).toBe(false);
      expect(raw.endsWith("\n") && !raw.endsWith("\n\n"), f.path).toBe(true);
    }
  });
});

// ── T3: sections ────────────────────────────────────────────────────────────

describe("sections (T3)", () => {
  it("every section an index names exists, and every reference is named by its index", () => {
    for (const skill of DISK_SKILLS) {
      const named = new Set([...skill.body.matchAll(/references\/([a-z0-9-]+)\.md/g)].map((m) => m[1]!));
      expect([...named].sort(), skill.name).toEqual(skill.sections.map((s) => s.slug).sort());
    }
  });

  it("no reference links another", () => {
    for (const s of DISK_SKILLS.flatMap((k) => k.sections)) {
      expect(s.body, s.file.path).not.toMatch(/references\/|\]\([^)]*\.md\)/);
    }
  });

  it("slugs are unique across the tree and never a skill's name or the catalog's", () => {
    const slugs = DISK_SKILLS.flatMap((s) => s.sections.map((x) => x.slug));
    const shorts = DISK_SKILLS.map((s) => s.short);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.filter((s) => shorts.includes(s) || s === CATALOG_TOPIC)).toEqual([]);
    expect(shorts).not.toContain(CATALOG_TOPIC);
    expect([...GUIDE_TOPIC_NAMES].sort()).toEqual([...shorts, ...slugs, CATALOG_TOPIC].sort());
  });

  it("every figma_get_guide call any surface shows resolves", () => {
    const texts = [
      SERVER_INSTRUCTIONS,
      catalogText(),
      ...allBodies(),
      ...SKILLS.map((s) => guideFooter(s)),
      ...SKILLS.flatMap((s) => s.sections.map((x) => guideFooter(s, x))),
      ...PROMPTS.map((row) => promptText(row, {})),
    ];
    const calls = texts.flatMap(guideCallsIn);
    expect(calls.length).toBeGreaterThan(20);
    for (const c of calls) expect(() => resolveTopic(c.topic, c.section), JSON.stringify(c)).not.toThrow();
  });
});

// ── T4, T10: the tools a skill names ────────────────────────────────────────

describe("tools and parameters (T4, T10)", () => {
  let app: App;
  let client: Client;
  let params: Map<string, Set<string>>;
  let descriptions: Map<string, string>;
  beforeAll(async () => {
    ({ app, client } = await inMemory({ BRIDGE_ALLOW_EVAL: "1" }));
    const { tools } = await client.listTools();
    params = new Map(tools.map((t) => [t.name, new Set(Object.keys((t.inputSchema as { properties?: object }).properties ?? {}))]));
    descriptions = new Map(tools.map((t) => [t.name, t.description ?? ""]));
  });
  afterAll(async () => {
    await client.close();
    await app.close();
  });
  const texts = () => [SERVER_INSTRUCTIONS, catalogText(), ...allBodies(), ...SKILLS.map((s) => guideFooter(s))];

  it("every figma_* name in the skills and the instructions is a registered tool", () => {
    const named = new Set(texts().flatMap((t) => [...t.matchAll(/\bfigma_[a-z_]+/g)].map((m) => m[0])));
    // "figma_create_…_style" stands for several tools; the trailing underscore marks it.
    expect([...named].filter((n) => !params.has(n) && !n.endsWith("_"))).toEqual([]);
  });

  it("no surface names a tool of the held-back audio group, which the default server does not register", () => {
    // Held back on 2026-10-14 (docs/superpowers/plans/2026-10-14-audio-held.md): this server runs without BRIDGE_ENABLE_AUDIO.
    const audio = [...OPS].filter(([, i]) => i.group === "audio").map(([op]) => toolName(op));
    expect(audio).toHaveLength(3);
    for (const t of audio) expect(params.has(t), t).toBe(false);
    const surfaces = [...texts(), ...PROMPTS.map((row) => promptText(row, {}))];
    expect(surfaces.filter((s) => audio.some((t) => s.includes(t)))).toEqual([]);
  });

  it("every figma_x { key … } names only that tool's parameters", () => {
    // The SDK strips an unknown key without an error, so a wrong name in a
    // skill (copied into a project's rules file) fails silently forever.
    const calls = texts().flatMap(toolCalls);
    expect(calls.length).toBeGreaterThan(40);
    const wrong = calls.flatMap((c) => (params.has(c.tool) ? c.keys.filter((k) => !params.get(c.tool)!.has(k)).map((k) => `${c.tool}.${k}`) : []));
    expect(wrong).toEqual([]);
  });

  it("every tool description is 1,024 characters or less (T10)", () => {
    expect(descriptions.size).toBe(selectOps({ kind: "full" }, true).length);
    for (const [name, d] of descriptions) expect(d.length, name).toBeLessThanOrEqual(1024);
  });
});

// ── T5: claims ──────────────────────────────────────────────────────────────

describe("claims (T5)", () => {
  it("every [C-xxx] in src/skills is registered as verified, measured or decision", () => {
    // In vitest because scripts/check-claims.mjs (locked) scans only README.md and docs/.
    const status = new Map<string, string>();
    for (const line of readFileSync(join(ROOT, "docs/reference/claims.md"), "utf8").split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (/^C-\d{3}$/.test(cells[1] ?? "")) status.set(cells[1]!, (cells[3] ?? "").replace(/[*`]/g, "").trim());
    }
    const cited = new Set(DISK.files.flatMap((f) => [...f.text.matchAll(/\[(C-\d{3})\]/g)].map((m) => m[1]!)));
    expect(cited.size).toBeGreaterThan(0);
    const bad = [...cited].filter((id) => !/^(verified|measured|decision)\b/.test(status.get(id) ?? "")).map((id) => `${id}: ${status.get(id) ?? "not registered"}`);
    expect(bad).toEqual([]);
  });
});

// ── T6: the bundle ──────────────────────────────────────────────────────────

const DIST_SERVER = join(ROOT, "dist/server.js");
const DIST_IDS = join(ROOT, "dist/build-id.json");

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

describe.skipIf(!existsSync(DIST_SERVER) || !existsSync(DIST_IDS))("the bundle (T6)", () => {
  it("dist/build-id.json carries the tree's id, and dist/server.js serves the tree on disk", async () => {
    expect((JSON.parse(readFileSync(DIST_IDS, "utf8")) as { skillsBuildId: string }).skillsBuildId).toBe(DISK.treeHash.slice(0, 12));
    const home = mkdtempSync(join(tmpdir(), "fmcp-skills-dist-"));
    const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", BRIDGE_HOME: home, BRIDGE_PORT: String(await freePort()), BRIDGE_SESSION_WAIT_MS: "300" };
    const client = new Client({ name: "skills-dist", version: "0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST_SERVER], env, stderr: "pipe" }));
    try {
      const st = (await client.callTool({ name: "figma_status", arguments: {} })) as ToolResult;
      expect(st.structuredContent!.skills).toEqual({ version: DISK.treeHash.slice(0, 12), count: DISK_SKILLS.length, dist: DISK.treeHash.slice(0, 12) });
      for (const f of DISK.files) {
        const read = await client.readResource({ uri: `skill://${f.path}` });
        expect((read.contents[0] as { text: string }).text, f.path).toBe(f.text);
      }
      const g = (await client.callTool({ name: "figma_get_guide", arguments: { topic: "spec" } })) as ToolResult;
      expect(g.content[0]!.text.startsWith(`${GUIDES.spec}\n\n---\n`)).toBe(true);
    } finally {
      await client.close();
    }
  });
});

// ── T7: the instructions ────────────────────────────────────────────────────

describe("the instructions (T7)", () => {
  it("are 2,000 bytes or less, and their first 512 bytes stand alone and name figma_status and figma_get_guide [C-176] [C-177]", () => {
    expect(bytes(SERVER_INSTRUCTIONS)).toBeLessThanOrEqual(2_000);
    const head = Buffer.from(SERVER_INSTRUCTIONS, "utf8").subarray(0, 512).toString("utf8");
    expect(head).toContain("figma_status");
    expect(head).toContain("figma_get_guide");
    // The process skills are named there too, so a client that reads only the head still finds them.
    for (const short of ["design", "storyboard", "motion", "critique"]) {
      expect(SKILLS.some((s) => s.short === short), short).toBe(true);
      expect(head, short).toMatch(new RegExp(`\\b${short}\\b`));
    }
    // The topic list moved to the footer of every guide answer.
    expect(SERVER_INSTRUCTIONS).not.toMatch(/Playbooks:/);
  });
});

// ── T8: examples an agent copies ────────────────────────────────────────────

/**
 * Every JSON example in a text: a line that opens with `{"type":`,
 * `[{"type":` or `[{"trigger":` and closes, possibly lines later, at the end
 * of a line. One closed before its line ends is a fragment of a larger call
 * (the build section's spec pieces) and is skipped.
 */
function jsonExamples(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\[?\{"(type|trigger)":/.test(lines[i]!)) continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let done: { line: number; col: number } | null = null;
    for (let l = i; l < lines.length && !done; l++) {
      const s = lines[l]!;
      for (let c = 0; c < s.length; c++) {
        const ch = s[c]!;
        if (escaped) escaped = false;
        else if (quoted && ch === "\\") escaped = true;
        else if (ch === '"') quoted = !quoted;
        else if (!quoted && "{[".includes(ch)) depth++;
        else if (!quoted && "}]".includes(ch) && --depth === 0) {
          done = { line: l, col: c };
          break;
        }
      }
    }
    if (done && lines[done.line]!.slice(done.col + 1).trim() === "") {
      out.push(lines.slice(i, done.line + 1).join("\n").trim());
      i = done.line;
    }
  }
  return out;
}

describe("examples parse and pass their op's own parser (T8)", () => {
  const examples = allBodies().flatMap(jsonExamples);

  it("finds the examples, and each is JSON", () => {
    expect(examples.length).toBeGreaterThanOrEqual(9);
    for (const e of examples) expect(() => JSON.parse(e), e.slice(0, 60)).not.toThrow();
  });

  it("every reaction example passes figma_set_reactions' parser", () => {
    const reactions = examples.filter((e) => e.startsWith('[{"trigger"'));
    expect(reactions.length).toBeGreaterThanOrEqual(7);
    for (const e of reactions) (JSON.parse(e) as unknown[]).forEach((r, i) => expect(() => toReaction(r, i)).not.toThrow());
  });

  it("every spec example builds with figma_create_from_spec in the editor its types belong to", async () => {
    const specs = examples.filter((e) => !e.startsWith('[{"trigger"'));
    expect(specs.length).toBeGreaterThanOrEqual(2);
    const BOARD_TYPES = /"type":"(sticky|shape|connector|table|code)"/;
    for (const spec of specs) {
      if (BOARD_TYPES.test(spec)) {
        const { restore } = board();
        try {
          registerFigjamSpecTypes();
          await expect(CREATE_OPS.create_from_spec!.run(opContext({ spec })), spec.slice(0, 60)).resolves.toBeDefined();
        } finally {
          restore();
        }
      } else if (spec.startsWith("[")) {
        // An array of roots is a slide's content in this tree; it needs a parent.
        const fake = new WriteFigma({ editorType: "slides" });
        const restore = installFigma(fake);
        try {
          await expect(CREATE_OPS.create_from_spec!.run(opContext({ parentId: fake.slide().id, spec })), spec.slice(0, 60)).resolves.toBeDefined();
        } finally {
          restore();
        }
      } else {
        const restore = installFigma(new WriteFigma());
        try {
          await expect(CREATE_OPS.create_from_spec!.run(opContext({ spec })), spec.slice(0, 60)).resolves.toBeDefined();
        } finally {
          restore();
        }
      }
    }
  });
});

// ── T9: our own words ───────────────────────────────────────────────────────

const OFFICIAL = join(homedir(), ".claude/plugins/cache/claude-plugins-official/figma");

function officialSkillFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(p);
    }
  };
  if (existsSync(OFFICIAL)) for (const v of readdirSync(OFFICIAL)) if (existsSync(join(OFFICIAL, v, "skills"))) walk(join(OFFICIAL, v, "skills"));
  return out;
}

describe.skipIf(officialSkillFiles().length === 0)("our own words (T9, local only)", () => {
  it("no run of 12 consecutive words is shared with the official Figma plugin's skills", () => {
    const words = (t: string) => t.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const runs = new Set<string>();
    for (const f of officialSkillFiles()) {
      const w = words(readFileSync(f, "utf8"));
      for (let i = 0; i + 12 <= w.length; i++) runs.add(w.slice(i, i + 12).join(" "));
    }
    const shared: string[] = [];
    for (const f of DISK.files) {
      const w = words(f.text);
      for (let i = 0; i + 12 <= w.length; i++) if (runs.has(w.slice(i, i + 12).join(" "))) shared.push(`${f.path}: ${w.slice(i, i + 12).join(" ")}`);
    }
    expect(shared).toEqual([]);
  });
});

// ── figma_get_guide's own behaviour ─────────────────────────────────────────

describe("figma_get_guide", () => {
  let app: App;
  let client: Client;
  beforeAll(async () => ({ app, client } = await inMemory()));
  afterAll(async () => {
    await client.close();
    await app.close();
  });
  const guide = async (args: Record<string, string>) => (await client.callTool({ name: "figma_get_guide", arguments: args })) as ToolResult;

  it("every footer is 1,200 bytes or less, and every answer 11,200", () => {
    for (const skill of SKILLS) {
      expect(bytes(guideFooter(skill)), skill.short).toBeLessThanOrEqual(1_200);
      for (const s of skill.sections) {
        expect(bytes(guideFooter(skill, s)), s.slug).toBeLessThanOrEqual(1_200);
        expect(bytes(`${s.body}\n\n${guideFooter(skill, s)}`), s.slug).toBeLessThanOrEqual(11_200);
      }
    }
  });

  it("the footer lists the skill's other sections and every other skill, as exact calls", async () => {
    const text = (await guide({ topic: "workflow", section: "spec" })).content[0]!.text;
    const footer = text.slice(text.indexOf("\n\n---\n") + 2);
    expect(footer).toContain('figma_get_guide { topic: "workflow" } — the index');
    expect(footer).toContain('figma_get_guide { topic: "workflow", section: "build" }');
    expect(footer).not.toContain('section: "spec"');
    for (const s of SKILLS.filter((x) => x.short !== "workflow")) expect(footer).toContain(`figma_get_guide { topic: "${s.short}" }`);
  });

  it('topic "skills" is the catalog: every skill with what it is for and its sections', async () => {
    const text = (await guide({ topic: CATALOG_TOPIC })).content[0]!.text;
    for (const s of SKILLS) {
      expect(text).toContain(`- ${s.short} — ${s.description}`);
      for (const x of s.sections) expect(text).toContain(x.slug);
    }
  });

  it("refuses a section the skill does not have, naming the ones it has", async () => {
    const r = await guide({ topic: "design-system", section: "spec" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/INVALID_PARAM: "spec" is not a section of the design-system skill\.\nIts sections: "library", "typography"\./);
    expect(r.structuredContent).toMatchObject({ code: "INVALID_PARAM", safeToRetry: true });
  });

  it("refuses a section on a skill without sections, on a section topic, and on the catalog", async () => {
    expect((await guide({ topic: "prototype", section: "x" })).content[0]!.text).toMatch(/has no sections; omit `section`/);
    expect((await guide({ topic: "build", section: "spec" })).content[0]!.text).toMatch(/topic "build" is already a section, of the workflow skill[\s\S]*topic: "workflow", section: "spec"/);
    expect((await guide({ topic: "skills", section: "build" })).content[0]!.text).toMatch(/is the catalog and has no sections/);
    // A topic that names its own section is the same answer, not a refusal.
    expect((await guide({ topic: "build", section: "build" })).isError).toBeFalsy();
  });

  it("an unknown topic is refused by the schema, before the tool runs", async () => {
    const r = (await client.callTool({ name: "figma_get_guide", arguments: { topic: "nope" } })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(() => resolveTopic("nope")).toThrow(BridgeError);
  });

  it("the description names every skill and stays within the cap", async () => {
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === "figma_get_guide")!.description!;
    for (const s of SKILLS) expect(d).toContain(s.short);
    expect(d).toMatch(/^Read this before a design, motion or review task\./);
  });
});

// ── the always-registered rule ──────────────────────────────────────────────

describe("figma_get_guide is registered in every toolset except none (plan §1.4)", () => {
  const listed = async (toolset: string) => {
    const { app, client } = await inMemory({ BRIDGE_TOOLSET: toolset });
    try {
      return { tools: (await client.listTools()).tools.map((t) => t.name), resources: (await client.listResources()).resources.map((r) => r.uri) };
    } finally {
      await client.close();
      await app.close();
    }
  };

  // Wired by the integrator: one line in selectOps (src/shared/ops.ts), the
  // registry this package does not own. Fails until then — on purpose.
  it("BRIDGE_TOOLSET=read,export keeps it: the floor every client reads", async () => {
    expect(selectOps({ kind: "groups", groups: ["read", "export"] }, false)).toContain("get_guide");
    expect((await listed("read,export")).tools).toContain("figma_get_guide");
  });

  it("BRIDGE_TOOLSET=none drops it with every tool but figma_status; the skill resources stay", async () => {
    const { tools, resources } = await listed("none");
    expect(tools).toEqual(["figma_status"]);
    expect(resources).toContain("skill://figxel-workflow/SKILL.md");
  });
});

// ── prompts ─────────────────────────────────────────────────────────────────

describe("the prompt table", () => {
  const row = (extra: Partial<PromptRow> = {}): PromptRow => ({
    name: "design_probe",
    title: "Probe",
    description: "A row as the integrator writes one.",
    args: [{ name: "brief", description: "What to design." }],
    checkpoint: true,
    skill: "workflow",
    preamble: ({ brief }) => `Design this: ${brief ?? "the user's request in this conversation"}.`,
    ...extra,
  });
  const serve = async (rows: PromptRow[]) => {
    const server = new McpServer({ name: "p", version: "0" }, { capabilities: { prompts: {} } });
    registerPrompts(server, rows);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "p", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  };

  it("the six existing prompts keep their names and arguments", () => {
    const OLD: Array<[string, string]> = [
      ["build_in_figma", "brief"],
      ["build_board", "brief"],
      ["build_deck", "brief,slideCount?"],
      ["design_to_code", "nodeId?,target?"],
      ["create_design_system_rules", "clientLanguages?,clientFrameworks?,rulesPath?"],
      ["code_to_design", "source,target?"],
    ];
    for (const [name, args] of OLD) {
      const row = PROMPTS.find((p) => p.name === name);
      expect(row, name).toBeDefined();
      expect([...row!.args.map((a) => `${a.name}${a.required ? "" : "?"}`), ...(row!.checkpoint ? ["checkpoint?"] : [])].join(","), name).toBe(args);
    }
  });

  it("the four new prompts take optional arguments, and checkpoint only where something is built (plan §1.5, §9)", () => {
    const NEW: Array<[string, string, string]> = [
      ["design_in_figma", "brief?,checkpoint?", "design"],
      ["storyboard_motion", "brief?,duration?,placement?,checkpoint?", "storyboard"],
      ["animate_in_figma", "nodeId?,brief?,checkpoint?", "motion"],
      ["critique_design", "nodeId?,lens?", "critique"],
    ];
    for (const [name, args, skill] of NEW) {
      const row = PROMPTS.find((p) => p.name === name);
      expect(row, name).toBeDefined();
      expect([...row!.args.map((a) => `${a.name}${a.required ? "" : "?"}`), ...(row!.checkpoint ? ["checkpoint?"] : [])].join(","), name).toBe(args);
      expect(row!.skill, name).toBe(skill);
    }
    const build = PROMPTS.find((p) => p.name === "build_in_figma")!;
    expect(promptText(build, { brief: "a page" })).toContain('follow the design skill instead: figma_get_guide { topic: "design" }');
  });

  it("critique_design carries the motion checks for a motion lens and the still lenses otherwise", () => {
    const critique = PROMPTS.find((p) => p.name === "critique_design")!;
    const carried = (lens?: string) => {
      const text = promptText(critique, lens === undefined ? {} : { lens });
      return text.includes(GUIDES["motion-checks"]!) ? "motion-checks" : text.includes(GUIDES.lenses!) ? "lenses" : "none";
    };
    for (const lens of ["motion craft", "motion", "technical QA", "technical", "design and type", "animation"]) expect(carried(lens), lens).toBe("motion-checks");
    for (const lens of [undefined, "all", "finish QA", "type and composition", "message", "originality", "design"]) expect(carried(lens), String(lens)).toBe("lenses");
    // With no lens named, a motion piece is pointed at its own checklist.
    expect(promptText(critique, {})).toContain('figma_get_guide { topic: "critique", section: "motion-checks" }');
  });

  it("a row with checkpoint takes it as its last, optional argument", async () => {
    const client = await serve([row()]);
    const { prompts } = await client.listPrompts();
    expect(prompts[0]!.arguments!.map((a) => [a.name, a.required ?? false])).toEqual([["brief", false], ["checkpoint", false]]);
    await client.close();
  });

  it('"storyboard" asks for a stop before building; "none" and no value run to the end', async () => {
    const client = await serve([row()]);
    const text = async (args: Record<string, string>) => ((await client.getPrompt({ name: "design_probe", arguments: args })).messages[0]!.content as { text: string }).text;
    expect(await text({ brief: "a poster", checkpoint: "storyboard" })).toMatch(/^Design this: a poster\.\n\nCheckpoint: [^\n]*wait for my approval before building\./);
    expect(await text({ brief: "a poster", checkpoint: " Storyboard " })).toMatch(/Checkpoint:/);
    expect(await text({ brief: "a poster", checkpoint: "none" })).not.toMatch(/Checkpoint|checkpoint/);
    expect(await text({})).toMatch(/^Design this: the user's request in this conversation\.\n\n# Working in Figma/);
    await client.close();
  });

  it("a stray word in checkpoint is handed to the agent, not dropped and not refused [C-176]", async () => {
    // Claude Code splits a typed line on whitespace, so a word of the brief can land here.
    expect(readCheckpoint("pricing")).toEqual({ checkpoint: "none", stray: "pricing" });
    expect(promptText(row(), { brief: "a", checkpoint: "pricing" })).toMatch(/The checkpoint argument read "pricing", which is neither "storyboard" nor "none"/);
  });

  it("composes preamble, SKILL.md body, one section and the calls for the rest", () => {
    const text = promptText(row({ checkpoint: false, section: "check" }), { brief: "a card" });
    const workflow = SKILLS.find((s) => s.short === "workflow")!;
    expect(text.startsWith(`Design this: a card.\n\n${workflow.body}\n\n${GUIDES.check}\n\n---\n`)).toBe(true);
    const closing = text.slice(text.lastIndexOf("\n---\n"));
    expect(closing).toContain('figma_get_guide { topic: "workflow", section: "spec" }');
    // The section it carries is not offered again.
    expect(closing).not.toContain('section: "check" }');
  });

  it("a row naming a skill or section that does not exist fails at registration, not in a user's prompt", () => {
    const server = new McpServer({ name: "p", version: "0" });
    expect(() => registerPrompts(server, [row({ skill: "nope" })])).toThrow(/no skill "nope"/);
    expect(() => registerPrompts(server, [row({ section: "nope" })])).toThrow(/no section "nope"/);
    expect(() => registerPrompts(server, [row({ section: () => "nope" })])).toThrow(/no section "nope"/);
  });

  it("a row may pick its section from the arguments (a critique's lens)", () => {
    const pick = row({ checkpoint: false, args: [{ name: "lens", description: "A lens." }], section: ({ lens }) => (lens === "safety" ? "safety" : "check") });
    expect(promptText(pick, { lens: "safety" })).toContain(GUIDES.safety);
    expect(promptText(pick, { lens: "all" })).toContain(GUIDES.check);
    expect(promptText(pick, {})).toContain(GUIDES.check);
  });
});

// ── figma_status ────────────────────────────────────────────────────────────

describe("figma_status reports the skills it serves", () => {
  const distPlugin = existsSync(DIST_IDS) ? (JSON.parse(readFileSync(DIST_IDS, "utf8")) as { pluginBuildId: string }).pluginBuildId : undefined;
  const session = {
    sessionId: "s-1", instanceId: "s-1", pluginVersion: "0", apiVersion: "1.0.0", editorType: "figma", ops: [], file: { name: "Landing", key: null },
    page: null, user: null, connectedAt: 0, lastSeenAt: 0, lastActiveAt: 0, selection: null, lastNodesChanged: null, active: true, buildId: distPlugin,
  };
  const run = async (skills: { version: string; count: number; bundled: boolean; onDisk: string | null }, extra: Partial<BridgeStatus> = {}, sessions: unknown[] = [session]) => {
    const st = { role: "hub", listening: true, reason: null, port: 0, host: "127.0.0.1", hubPid: 7, peers: 0, lastAuthFailureAt: null, serverBuild: "dev", allowUnverified: false, sessions, ...extra } as BridgeStatus;
    const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-st-skills-")), BRIDGE_PORT: "0" });
    return (await buildStatus({ bridge: { statusAsync: async () => st } as unknown as Bridge, config, startedAt: Date.now(), selectedTools: [], registeredTools: [], skills })) as {
      skills: Record<string, unknown>;
      sessions: Array<{ build: { restart?: string } }>;
      hint: string;
    };
  };

  it("checkSkillsBuild: only a bundle that differs from dist/ asks for a restart", () => {
    expect(checkSkillsBuild("aaaaaaaaaaaa", true, "bbbbbbbbbbbb")).toEqual({ version: "aaaaaaaaaaaa", dist: "bbbbbbbbbbbb", restart: "client" });
    expect(checkSkillsBuild("aaaaaaaaaaaa", true, "aaaaaaaaaaaa")).toEqual({ version: "aaaaaaaaaaaa", dist: "aaaaaaaaaaaa" });
    // Unbundled, the server read src/skills itself: dist/ says nothing about it.
    expect(checkSkillsBuild("aaaaaaaaaaaa", false, "bbbbbbbbbbbb")).toEqual({ version: "aaaaaaaaaaaa", dist: "bbbbbbbbbbbb" });
    // No build on disk is "unknown", not stale.
    expect(checkSkillsBuild("aaaaaaaaaaaa", true, null)).toEqual({ version: "aaaaaaaaaaaa", dist: null });
  });

  it("current skills: version and count, no restart", async () => {
    const out = await run({ version: "aaaaaaaaaaaa", count: 8, bundled: true, onDisk: "aaaaaaaaaaaa" });
    expect(out.skills).toEqual({ version: "aaaaaaaaaaaa", count: 8, dist: "aaaaaaaaaaaa" });
    expect(out.sessions[0]!.build.restart).toBeUndefined();
    expect(out.hint).not.toMatch(/skills/);
  });

  it("a newer skills build on disk sets build.restart client and says why, as a stale hub does", async () => {
    const out = await run({ version: "aaaaaaaaaaaa", count: 8, bundled: true, onDisk: "bbbbbbbbbbbb" });
    expect(out.skills).toMatchObject({ restart: "client", dist: "bbbbbbbbbbbb" });
    expect(out.sessions[0]!.build.restart).toBe("client");
    expect(out.hint).toMatch(/skills are older than the installed version .*restart the MCP client/);
    // With no plugin connected there is no session to carry it: the top-level field and the hint still do.
    const alone = await run({ version: "aaaaaaaaaaaa", count: 8, bundled: true, onDisk: "bbbbbbbbbbbb" }, {}, []);
    expect(alone.skills.restart).toBe("client");
    expect(alone.hint).toMatch(/skills are older than the installed version/);
  });

  it("a stale plugin keeps restart plugin; the skills sentence is added, not swapped in", async () => {
    const out = await run({ version: "aaaaaaaaaaaa", count: 8, bundled: true, onDisk: "bbbbbbbbbbbb" }, {}, [{ ...session, buildId: "000000000000" }]);
    expect(out.sessions[0]!.build.restart).toBe("plugin");
    expect(out.hint).toMatch(/re-run|run it again/);
    expect(out.hint).toMatch(/skills are older/);
  });

  it("when this server is already asked to restart, the skills sentence is not repeated", async () => {
    const out = await run({ version: "aaaaaaaaaaaa", count: 8, bundled: true, onDisk: "bbbbbbbbbbbb" }, { serverBuild: "111111111111" });
    expect(out.hint).toMatch(/This MCP server is older than the installed version/);
    expect(out.hint).not.toMatch(/skills are older/);
  });
});

// ── the walker ──────────────────────────────────────────────────────────────

describe("the walker", () => {
  const tree = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "fmcp-tree-"));
    for (const [p, t] of Object.entries(files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), t);
    }
    return readSkillsTree(dir);
  };
  const SKILL = "---\nname: figxel-x\ndescription: An example.\n---\n\n# X\n\nBody.\n";

  it("hashes the same tree the same on every OS: paths sorted, CRLF read as LF", () => {
    const a = tree({ "figxel-x/SKILL.md": SKILL, "figxel-x/references/a.md": "# A\n" });
    const b = tree({ "figxel-x/references/a.md": "# A\r\n", "figxel-x/SKILL.md": SKILL.replace(/\n/g, "\r\n") });
    expect(b.treeHash).toBe(a.treeHash);
    expect(a.files.map((f) => f.path)).toEqual(["figxel-x/SKILL.md", "figxel-x/references/a.md"]);
    expect(a.files[0]!.frontmatter).toEqual({ name: "figxel-x", description: "An example." });
    expect(a.files[1]!.frontmatter).toBeNull();
    expect(a.files[0]!.size).toBe(bytes(SKILL));
    expect(tree({ "figxel-x/SKILL.md": SKILL.replace("Body.", "Body!") }).treeHash).not.toBe(a.treeHash);
  });

  it("a body is the text between the frontmatter's blank line and the final newline", () => {
    expect(splitSkillFile(SKILL).body).toBe("# X\n\nBody.");
    expect(splitSkillFile("# A\n").body).toBe("# A");
  });

  it("refuses frontmatter it cannot read exactly", () => {
    expect(() => splitSkillFile("---\nname: x\n  folded: y\n---\n\nb\n")).toThrow(/not a plain "key: value"/);
    expect(() => splitSkillFile("---\nname: x\n")).toThrow(/never closed/);
  });

  it("a folder without SKILL.md, or a name that is not its folder, is refused loudly", () => {
    expect(() => skillsOf(tree({ "figxel-x/references/a.md": "# A\n" }))).toThrow(/has no SKILL.md/);
    expect(() => skillsOf(tree({ "figxel-x/SKILL.md": SKILL.replace("name: figxel-x", "name: figxel-y") }))).toThrow(/needs name: figxel-x/);
  });

  it("orders sections as the index names them", () => {
    const skill = skillsOf(tree({
      "figxel-x/SKILL.md": SKILL.replace("Body.", "references/b.md then references/a.md"),
      "figxel-x/references/a.md": "# A\n",
      "figxel-x/references/b.md": "# B\n",
    }))[0]!;
    expect(skill.sections.map((s) => s.slug)).toEqual(["b", "a"]);
  });
});

// The catalog ops this file reads must exist (a renamed op would make T4 vacuous).
it("the ops this file relies on are in the catalog", () => {
  expect(["get_guide", "status", "create_from_spec", "set_reactions"].every((op) => OPS.has(op))).toBe(true);
  expect(toolName("get_guide")).toBe("figma_get_guide");
});
