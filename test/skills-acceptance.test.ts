// What acceptance run 1 (2026-10-13: "a landing hero for a wood-fired pottery
// studio", one agent, the design skill) found missing or ambiguous in the
// design, critique, workflow and design-system skills. Each block pins one fix,
// in numbers where the skill gives one, so the gap cannot come back silently.
// The blocks at the end pin what the product redesign (2026-10-19) had no
// guidance for: app screens, light or dark, the mode and colour strategy, icons,
// and a critique that judges before it reads the numbers.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { readSkillsTree } from "../tools/skills-tree.mjs";
import { loadConfig, readOrCreateToken } from "../src/server/config.js";
import { connect, createApp } from "../src/server/mcp.js";
import { PROMPTS } from "../src/server/prompts.js";
import { resolveTopic, skillsOf } from "../src/server/skills.js";
import { CRAFT } from "../src/plugin/craft.js";
import { quietLogger } from "./helpers.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DISK = readSkillsTree(join(ROOT, "src/skills"));
const SKILLS = skillsOf(DISK);

/** The skills this pass owns, and the role skills that joined them (the role process, 2026-10-16). */
const IN_SCOPE = ["design", "critique", "workflow", "design-system", "ux", "graphic", "brand"];
const scopeFiles = () => DISK.files.filter((f) => IN_SCOPE.some((s) => f.path.startsWith(`figxel-${s}/`)));
const skill = (short: string) => SKILLS.find((s) => s.short === short)!;
const section = (short: string, slug: string) => skill(short).sections.find((s) => s.slug === slug)!.body;

/** The rows of the first Markdown table after `heading`, header first, separator dropped. */
function table(body: string, heading: string): string[][] {
  const lines = body.slice(body.indexOf(heading)).split("\n").slice(1);
  const rows: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("|")) rows.push(line.split("|").slice(1, -1).map((c) => c.trim()));
    else if (rows.length) break;
  }
  return rows.filter((r) => !r.every((c) => /^-+$/.test(c)));
}

/** The sections a Read cell names: "`brief`" in this skill, "critique `lenses`" in another. */
function reads(cell: string, own: string): Array<{ topic: string; slug: string }> {
  return [...cell.matchAll(/(?:([a-z][a-z-]*) )?`([a-z0-9-]+)`/g)].map((m) => ({
    topic: m[1] && SKILLS.some((s) => s.short === m[1]) ? m[1] : own,
    slug: m[2]!,
  }));
}

describe("the first two calls are enough to start (14 guide calls before the first node)", () => {
  const index = skill("design").body;
  const rows = table(index, "## Gear");
  const col = (name: string) => rows[0]!.indexOf(name);

  it("the design index's gear table names, per gear, the two or three sections it reads, each resolving", () => {
    expect(col("Read")).toBeGreaterThan(0);
    const gears = rows.slice(1);
    expect(gears.map((r) => r[0])).toEqual(["Edit", "Section", "Page", "Top", "Storyboard styleframes"]);
    for (const row of gears) {
      const named = reads(row[col("Read")]!, "design");
      if (row[0] === "Edit") expect(named, "Edit").toEqual([]);
      else expect(named.length, row[0]).toBeGreaterThanOrEqual(2);
      expect(named.length, row[0]).toBeLessThanOrEqual(3);
      for (const r of named) expect(resolveTopic(r.topic, r.slug).kind, `${row[0]}: ${r.topic} ${r.slug}`).toBe("section");
    }
    expect(index).toMatch(/Two calls start any gear but Edit: this index, then the first section in its Read column, such as figma_get_guide \{ topic: "design", section: "brief" \}/);
  });

  it("the design prompt carries exactly the page gear's first read", () => {
    const page = rows.find((r) => r[0] === "Page")!;
    const first = reads(page[col("Read")]!, "design")[0]!;
    const prompt = PROMPTS.find((p) => p.name === "design_in_figma")!;
    expect([prompt.skill, prompt.section]).toEqual([first.topic, first.slug]);
  });

  it("the critique index names the sections each kind of work reads", () => {
    const crit = table(skill("critique").body, "## Lenses by gear");
    const at = crit[0]!.indexOf("Read");
    expect(at).toBeGreaterThan(0);
    for (const row of crit.slice(1)) {
      const named = reads(row[at]!, "critique");
      expect(named.length, row[0]).toBeGreaterThanOrEqual(1);
      expect(named.length, row[0]).toBeLessThanOrEqual(3);
      for (const r of named) expect(resolveTopic(r.topic, r.slug).kind).toBe("section");
    }
  });

  it("the workflow index sends new work to the design index instead of a reading list of its own", () => {
    expect(skill("workflow").body).toMatch(/gear table names the two or three sections each gear reads: read nothing else first/);
  });
});

describe("gear: a single view on its own has a row", () => {
  const rows = table(skill("design").body, "## Gear");
  const row = (gear: string) => rows.find((r) => r[0] === gear)![1]!;

  it("the page gear covers one view such as a landing hero; the section gear needs a design on the canvas", () => {
    expect(row("Page")).toMatch(/one view on its own, such as a landing hero/);
    expect(row("Section")).toMatch(/already on the canvas/);
    expect(row("Top")).toMatch(/stop a stranger who did not come for it/);
    expect(skill("design").body).toMatch(/a hero asked for with no design around it is a one-view page/);
  });
});

describe("whose system the file holds", () => {
  /** The numbered cases under the brief's givens line, in order. */
  const cases = () => {
    const brief = section("design", "brief");
    const block = brief.slice(brief.indexOf("**Givens: whose system is this?**"));
    expect(block.length).toBeLessThan(brief.length);
    expect(block).toMatch(/^[^\n]*The first case that fits decides:/);
    const out: string[] = [];
    for (const line of block.split("\n").slice(1)) {
      const m = /^ {5}(\d)\. (.+)$/.exec(line);
      if (m) out.push(m[2]!);
      else if (out.length) break;
    }
    return out;
  };

  it("the brief decides it, first case first: pointed at or extended is given; another brand's is reference; the brief's own brand in a look is asked once; a look with no owner is reference", () => {
    const c = cases();
    expect(c).toHaveLength(5);
    expect(c[0]).toMatch(/^The user pointed at them, or the work extends a design that uses them: givens/);
    expect(c[1]).toMatch(/^They belong to another brand or product: reference, read but never applied to this work and never edited/);
    expect(c[2]).toMatch(/^They are this brief's brand and match one of the six looks below on two or more features: ask the user once/);
    expect(c[3]).toMatch(/^They are this brief's brand, or nobody's, and match no look: givens/);
    expect(c[4]).toMatch(/^Nobody's, and they match a look: reference/);
    // The six looks the cases count against are listed in the same section, before the directions need them.
    expect(section("design", "brief")).toMatch(/\*\*The generated default\.\*\* Generated design falls into six looks:/);
  });

  it("every place that says to reuse the file's styles points at that rule", () => {
    expect(skill("design").body).toMatch(/Styles merely saved in the file are not: section `brief` decides whose they are/);
    expect(section("design", "system")).toMatch(/another brand's, or a generated look saved as styles, are reference/);
    expect(skill("workflow").body).toMatch(/when the work extends a design that uses them or they are this brief's brand; another brand's system, or a generated look saved as styles, is reference only/);
    expect(skill("design-system").body).toMatch(/Apply it when the user pointed at it, when the work extends a design that uses it, or when it is this brief's brand\. Another brand's styles, or a generated look saved as styles, are reference/);
    expect(section("design-system", "typography")).toMatch(/keep it when it is a given \(the design skill's `brief` section\)/);
    expect(section("critique", "lenses")).toMatch(/the style must be a given by the design skill's `brief` section, not merely saved in the file/);
    expect(section("design", "tells")).toMatch(/"brand given" cites the style or variable id of a given \(section `brief`\)/);
  });
});

describe("cards and styleframes combine by a stated rule", () => {
  const directions = section("design", "directions");

  it("no skill says 'within a point' any more", () => {
    expect(DISK.files.filter((f) => /within a point/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it("a card's total is the sum of three whole-point scores; a near tie is a gap of 3 or less, and ties break by effectiveness, then originality", () => {
    expect(directions).toMatch(/scoring 1–10 in whole points/);
    expect(directions).toMatch(/A card's total is effectiveness \+ craft \+ originality, 3 to 30, counted only once buildability passes/);
    const m = /whose total is (\d+) points or less below the leader's, one point per score: a gap of (\d+) is a near tie, a gap of (\d+) is not/.exec(directions)!;
    expect(m).not.toBeNull();
    const [limit, tie, notTie] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // "Within a point" per score, over three scores, is a gap of three.
    expect(limit).toBe(3);
    expect(tie).toBeLessThanOrEqual(limit);
    expect(notTie).toBe(limit + 1);
    expect(directions).toMatch(/on equal totals, the higher effectiveness, then the higher originality/);
    expect(directions).toMatch(/A styleframe's total is the sum of those lens scores/);
    expect(directions).toMatch(/the styleframe with the highest total, the higher message score breaking a tie/);
    expect(skill("design").body).toMatch(/two on a near tie/);
  });
});

describe("one view: the chosen styleframe is the deliverable", () => {
  it("is cloned to the target and refined, which is what 'never rebuild' asks", () => {
    const directions = section("design", "directions");
    expect(directions).toMatch(/figma_clone_node \{ nodeId: <styleframe>, parentId: <target page or wrapper id>, x, y, name \}/);
    expect(directions).toMatch(/When the deliverable is one view \(a landing hero, a poster, a single screen\), the clone is the deliverable/);
    expect(skill("design").body).toMatch(/never rebuild a section that is mostly right\. A one-view deliverable's chosen styleframe is that section: clone it and refine it\./);
    expect(skill("design").body).toMatch(/\| 6 \| Build \| the workflow loop; one view: the chosen styleframe, cloned \|/);
  });
});

describe("safe zones only where something covers the frame; the fold is measured", () => {
  it("the brief passes no safeArea for a web view and measures the fold from absolute boxes", () => {
    const brief = section("design", "brief");
    expect(brief).toMatch(/\*\*Safe zones\*\* exist only where something covers part of the frame/);
    expect(brief).toMatch(/\*\*A web or app view has no safe zone:\*\* pass no `safeArea`/);
    expect(brief).toMatch(/figma_get_design_context \{ nodeId: <the view>, absolute: true \}/);
    expect(brief).toMatch(/Never pass the fold as `safeArea`/);
  });

  it("the check, sampling and lens texts agree", () => {
    expect(section("workflow", "check")).toMatch(/A web or app view has none: its fold is a success line/);
    expect(section("critique", "sampling")).toMatch(/a web view passes none/);
    expect(section("critique", "lenses")).toMatch(/A web view passes none/);
    expect(section("critique", "lenses")).toMatch(/the fold is never passed as `safeArea`/);
  });
});

describe("the text floor and near_size", () => {
  it("every threshold the skills state is the one figma_check_layout uses", () => {
    const stated = scopeFiles().flatMap((f) => [...f.text.matchAll(/(\d+\.\d+)× apart/g)].map((m) => ({ path: f.path, v: Number(m[1]) })));
    expect(stated.length).toBeGreaterThanOrEqual(3);
    for (const s of stated) expect(s.v, s.path).toBe(CRAFT.nearSize);
    // "within about 12 %" left open which size the 12 % was of.
    expect(scopeFiles().filter((f) => /within about 12/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it("the floor wins: its worked example steps a full ratio up from the floor, and names the size that does not", () => {
    const system = section("design", "system");
    expect(system).toMatch(/\*\*The floor wins\.\*\* No size goes under the floor/);
    const m = /A (\d+) px floor and a ([\d.]+) ratio give (\d+) and (\d+); an (\d+) px body over (\d+) px labels is off that scale/.exec(system)!;
    expect(m).not.toBeNull();
    const [floor, ratio, small, body, offBody, offLabel] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
    expect(small).toBe(floor);
    expect(body).toBe(Math.round(floor * ratio));
    expect(body / small).toBeGreaterThanOrEqual(CRAFT.nearSize);
    expect(offLabel).toBe(floor);
    expect(offBody / offLabel).toBeLessThan(ratio);
  });
});

describe("fonts: named families, filtered; figma_suggest_fonts optional", () => {
  // The names the tools pass adds to figma_get_fonts (docs/reference/tools.md).
  const FONT_PARAMS = ["scope", "families", "query", "limit"];

  it("no skill asks for the unfiltered list", () => {
    expect(DISK.files.filter((f) => /figma_get_fonts \{ scope: "available" \}/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it("the type steps check families with the filter and fall back to a figma_create_text try", () => {
    for (const text of [section("design", "directions"), section("design-system", "typography"), skill("code-to-design").body]) {
      expect(text).toMatch(/figma_get_fonts,?\s+(with\s+)?`scope: "available"`/);
      expect(text).toMatch(/`families`/);
      expect(text).toMatch(/[Nn]ever\s+(ask\s+for\s+)?the\s+unfiltered\s+list/);
      expect(text).toMatch(/figma_create_text/);
      expect(text).toMatch(/`?fellBack`?/);
    }
  });

  it("figma_get_fonts is only ever given its own filter names", () => {
    // From each mention to the end of its clause or the next tool named: the backticked names there are its parameters.
    const passed = DISK.files.flatMap((f) =>
      [...f.text.matchAll(/figma_get_fonts(?:(?!figma_)[^.;|])*/g)].flatMap((m) => [...m[0].matchAll(/`([a-z][A-Za-z]*)(?::[^`]*)?`/g)].map((p) => p[1]!)),
    );
    expect(new Set(passed)).toEqual(new Set(FONT_PARAMS));
  });

  it("once figma_get_fonts takes a filter, it takes exactly the names the skills use", async (ctx) => {
    const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-acc1-")), BRIDGE_PORT: "0", BRIDGE_SESSION_WAIT_MS: "200" });
    const app = await createApp(config, readOrCreateToken(config.tokenPath), quietLogger);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "acc1", version: "0" });
    await Promise.all([connect(app, a), client.connect(b)]);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === "figma_get_fonts")!;
      const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
      // Until the tools pass lands, the filter is absent and the skills' fallback (a figma_create_text try) is what runs.
      if (!props.includes("families")) ctx.skip();
      for (const p of FONT_PARAMS) expect(props, p).toContain(p);
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("every line that names figma_suggest_fonts calls it optional, and the type steps never wait on it or retry it", () => {
    for (const f of scopeFiles()) {
      for (const line of f.text.split("\n").filter((l) => l.includes("figma_suggest_fonts"))) expect(line, f.path).toMatch(/optional/);
    }
    // It stalled twice in the run, and its stall hint asked for a retry it cannot honour.
    expect(section("design", "directions")).toMatch(/figma_suggest_fonts is optional: nothing waits on it, a call that does not answer is not retried/);
    expect(section("design-system", "typography")).toMatch(/nothing below depends on it: when it does not answer,\s+go on without it and never retry it/);
  });
});

describe("no plugin session: report and stop", () => {
  it("the design and workflow indexes say to tell the user, check once more, and never poll", () => {
    for (const short of ["design", "workflow"]) {
      const body = skill(short).body;
      expect(body, short).toMatch(/NO_SESSION/);
      expect(body, short).toMatch(/cannot open the plugin/);
      expect(body, short).toMatch(/call figma_status once more, then stop/);
      expect(body, short).toMatch(/[Nn]ever poll/);
    }
  });
});

describe("less to read", () => {
  it("the frame-px formula is written once, in the brief where the floor is set", () => {
    const at = scopeFiles().filter((f) => /frame width ÷ device width/.test(f.text)).map((f) => f.path);
    expect(at).toEqual(["figxel-design/references/brief.md"]);
  });

  it("claim ids sit on one closing line per file, out of the prose an agent reads", () => {
    for (const f of scopeFiles()) {
      const lines = f.text.replace(/\n$/, "").split("\n");
      const last = lines[lines.length - 1]!;
      const inProse = lines.slice(0, -1).filter((l) => /\[C-\d{3}\]/.test(l));
      expect(inProse, f.path).toEqual([]);
      if (/\[C-\d{3}\]/.test(last)) expect(last, f.path).toMatch(/^Evidence \(claim ids, for maintainers\):( \[C-\d{3}\])+$/);
    }
  });
});

// ── The product redesign (2026-10-19): the guidance it lacked ────────────────

describe("app screens: the ux skill's screens section", () => {
  it("figma_get_guide serves it by topic and by section, and the ux index reads it at the build stage", async () => {
    const config = loadConfig({ BRIDGE_HOME: mkdtempSync(join(tmpdir(), "fmcp-screens-")), BRIDGE_PORT: "0", BRIDGE_SESSION_WAIT_MS: "200" });
    const app = await createApp(config, readOrCreateToken(config.tokenPath), quietLogger);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "screens", version: "0" });
    await Promise.all([connect(app, a), client.connect(b)]);
    try {
      for (const args of [{ topic: "ux", section: "screens" }, { topic: "screens" }]) {
        const r = (await client.callTool({ name: "figma_get_guide", arguments: args })) as { content: { text: string }[]; isError?: boolean };
        expect(r.isError, JSON.stringify(args)).toBeFalsy();
        expect(r.content[0]!.text.startsWith(`${section("ux", "screens")}\n\n---\n`), JSON.stringify(args)).toBe(true);
      }
    } finally {
      await client.close();
      await app.close();
    }
    expect(resolveTopic("screens")).toMatchObject({ kind: "section", skill: { short: "ux" } });
    const build = table(skill("ux").body, "## The stages").find((r) => r[1] === "Build")!;
    expect(build[2]).toMatch(/`screens`/);
  });

  it("asks for the one question and its finding, figures as type, the accent on data, and honest zeros", () => {
    const s = section("ux", "screens");
    for (const rule of [
      /\*\*The question\*\* the person opens it with/,
      /\*\*The finding\*\* the screen leads with/,
      /\*\*The largest block answers the question\.\*\*/,
      /\*\*The main job is one click away\.\*\*/,
      /\*\*A title that names, no greeting\.\*\*/,
      /\*\*One element only this product has\.\*\*/,
      /\*\*The sidebar on the page ground\.\*\*/,
      /\*\*The accent on data, not chrome\.\*\*/,
      /\*\*KPIs as type, in one container\.\*\*/,
      /\*\*Tabular figures, right-aligned\.\*\*/,
      /\*\*An honest zero\.\*\*/,
      /\*\*Empty leads to the first action\.\*\*/,
    ]) expect(s).toMatch(rule);
    // Light or dark is the brief's decision, and an app screen is an operate view.
    expect(s).toMatch(/operate view/);
    expect(s).toMatch(/never from "dashboards are dark"/);
  });

  it("each pattern recipe says when, what and how it is measured, and none is a house style", () => {
    const s = section("ux", "screens");
    expect(s).toMatch(/not a house style/);
    const recipes = s.slice(s.indexOf("## Pattern recipes")).split("\n### ").slice(1);
    expect(recipes.map((r) => r.split("\n")[0])).toEqual(["A settings area", "A dense data table", "An empty state", "A command bar"]);
    for (const r of recipes) {
      for (const part of ["When", "What", "Measured"]) expect(r, `${r.split("\n")[0]}: ${part}`).toMatch(new RegExp(`^- \\*\\*${part}:\\*\\* `, "m"));
    }
    expect(recipes[0]).toMatch(/grouped rows with inline controls/);
    expect(recipes[0]).toMatch(/not each in a card/);
  });

  it("every number the section picks is framed as Figxel's starting point, to test against the brief", () => {
    const s = section("ux", "screens");
    const picked = s.split("\n").filter((l) => /\b\d+ px\b|\bfigures or fewer\b/.test(l));
    expect(picked.length).toBeGreaterThanOrEqual(2);
    for (const line of picked) expect(line).toMatch(/Figxel's starting point[^.:]*to test against the brief/);
  });
});

describe("light or dark, the mode and the colour strategy are decisions on record", () => {
  it("the brief's audience line carries a one-sentence physical scene, and the scene decides light or dark", () => {
    const brief = section("design", "brief");
    const audience = brief.split("\n").find((l) => l.startsWith("2. **Audience.**"))!;
    expect(audience).toMatch(/the scene, one sentence in `audience` too: who, where, under what light/);
    expect(audience).toMatch(/The scene decides light or dark/);
    expect(audience).toMatch(/never "the category is dark"/);
    expect(brief).toMatch(/^- Audience: [^\n]*Scene: [^\n]*light ground\.$/m);
  });

  it("the system names a mode and a colour strategy before any face or hex", () => {
    const system = section("design", "system");
    expect(system.indexOf("## Mode, then colour strategy")).toBeGreaterThan(0);
    expect(system.indexOf("## Mode, then colour strategy")).toBeLessThan(system.indexOf("## Type"));
    for (const word of ["persuade", "operate", "read", "experience", "restrained", "committed", "full palette", "drenched"]) {
      expect(system, word).toMatch(new RegExp(`\\*\\*${word}\\*\\*`));
    }
    expect(system).toMatch(/An operate view borrows only type, palette, density and one signature move from its world/);
    expect(system).toMatch(/on the ground the brief's scene chose \(light or dark, never the category's\)/);
  });

  it("the direction card carries a Mode line and a Colour strategy line", () => {
    const d = section("design", "directions");
    const card = d.slice(d.indexOf("## The direction card"), d.indexOf("## The default check"));
    expect(card).toMatch(/^- \*\*Mode\*\* — persuade, operate, read or experience/m);
    expect(card).toMatch(/^- \*\*Colour strategy\*\* — restrained, committed, full palette or drenched/m);
  });

  it("radius is a decision to test; icons are one set, outline at rest, matched to their label, bare; small Heroicons are solid", () => {
    const system = section("design", "system");
    expect(system).toMatch(/\*\*Radius by role and size, as a decision to test\.\*\*[^\n]*Figxel's starting point, to test/);
    const icons = system.slice(system.indexOf("## Icons"), system.indexOf("## Copy"));
    for (const rule of [/One set per piece, at its native sizes/, /Outline at rest, filled when active or selected/, /Stroke matched to the text beside it/, /Bare by default/]) {
      expect(icons).toMatch(rule);
    }
    // [C-399]: Heroicons has no 20 or 16 px outline set.
    expect(icons).toMatch(/\*\*Heroicons:\*\* outline exists only at 24 px; at 20 and 16 px take the 20 or 16 px solid set/);
    expect(system.trimEnd().split("\n").pop()).toContain("[C-399]");
  });
});

describe("critique: the verdict before the numbers, and what a clean page can hide", () => {
  const index = () => skill("critique").body;

  it("the set-up writes each verdict from the renders and the brief, then reads figma_check_layout and merges", () => {
    const body = index();
    const at = (s: string) => body.indexOf(s);
    expect(at("**Cold read first.**")).toBeGreaterThan(0);
    expect(at("Re-read the brief")).toBeGreaterThan(at("**Cold read first.**"));
    expect(at("**Verdict before numbers.**")).toBeGreaterThan(at("Re-read the brief"));
    expect(body).toMatch(/\*\*Verdict before numbers\.\*\* From the renders and the brief alone, write each lens's verdict/);
    expect(body).toMatch(/Only then read the measurements \(figma_check_layout/);
    expect(body).toMatch(/what the eye missed and one on what the numbers missed/);
  });

  it('a review that could not run in a fresh context opens its report with "self-reviewed"', () => {
    expect(index()).toMatch(/A review that could not run in a fresh context opens its report with "self-reviewed"/);
  });

  it("the substance guard is a major trigger: mostly empty, small or grey running text, an idea that stops after the first view", () => {
    const major = index().split("\n").find((l) => l.startsWith("- **Major:**"))!;
    expect(major).toMatch(/mostly empty/);
    expect(major).toMatch(/running text set small or grey/);
    expect(major).toMatch(/an idea that stops after the first view/);
  });

  it("rounds: each finding is falsified before it is kept, at most three per lens per round, and the checks are not rationed", () => {
    const rounds = section("critique", "rounds");
    expect(rounds).toMatch(/\*\*Try to falsify each finding before you keep it\.\*\*/);
    expect(rounds).toMatch(/\*\*At most three findings per lens per round:\*\*/);
    expect(rounds).toMatch(/every figma_check_layout and figma_check_motion error and warning is fixed, whatever the count/);
  });

  it("lenses: message and originality judge before they measure", () => {
    const lenses = section("critique", "lenses");
    const message = lenses.slice(lenses.indexOf("## Message"), lenses.indexOf("## Type and composition"));
    expect(message.indexOf("**Then the numbers.**")).toBeGreaterThan(message.indexOf("**Format.**"));
    expect(message).toMatch(/\*\*Substance\.\*\*/);
    const originality = lenses.slice(lenses.indexOf("## Originality"), lenses.indexOf("## Finish QA"));
    const steps = [...originality.matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(steps).toEqual(["1 Swap test.", "2 Direction 0.", "3 Trace.", "4 Negation.", "5 Self-repetition.", "6 Clusters, in numbers.", "7 The tells census."]);
    expect(originality).toMatch(/Steps 1 to 5 judge from the renders and the brief and end in a written verdict; steps 6 and 7 bring the numbers/);
  });
});
