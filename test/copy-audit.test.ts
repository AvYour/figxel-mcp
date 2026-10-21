// figma_check_layout { audit: ["copy"] } (role spec §4.3): the words of an
// interface — a button that says what it does (Apple HIG Writing), one
// capitalisation style per kind of element, no interjection in an error and
// no bare error code (NN/g error messages), one thing written one way (the
// design skill's `finish`). Every kind is info; each fires on one fixture and
// stays quiet on its look-alike.

import { describe, expect, it } from "vitest";
import { checkLayout } from "../src/plugin/ops/check.js";
import { caseStyle, copyKey } from "../src/plugin/copy.js";

type N = Record<string, unknown> & { id: string; name: string; type: string; children?: N[]; parent?: N | null };
let seq = 0;
function mk(type: string, name: string, box: [number, number, number, number], props: Record<string, unknown> = {}, children: N[] = []): N {
  const n: N = { id: `23:${++seq}`, type, name, absoluteBoundingBox: { x: box[0], y: box[1], width: box[2], height: box[3] }, ...props, children };
  for (const c of children) c.parent = n;
  return n;
}
const white = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
const ink = [{ type: "SOLID", color: { r: 0.07, g: 0.07, b: 0.07 } }];
const txt = (name: string, chars: string, y = 0, props: Record<string, unknown> = {}) =>
  mk("TEXT", name, [10, y, 300, 20], { characters: chars, fontSize: 16, fills: ink, ...props });
/** A button: an instance named for one, holding its label. */
const button = (label: string, y = 0, props: Record<string, unknown> = {}) =>
  mk("INSTANCE", "Button", [0, y, 200, 48], { fills: white }, [txt("Label", label, y + 14, props)]);
const screen = (...kids: N[]) => mk("FRAME", "Screen", [0, 0, 600, 1200], { fills: white }, kids);
const noYield = { yieldToHost: async () => {}, isCancelled: () => false };
const check = (root: N) => checkLayout(root as never, 3000, noYield, { audit: new Set(["copy"]) });
type Issue = { kind: string; name: string; severity: string; detail: string; nodeId: string };
const of = (issues: Issue[], kind: string) => issues.filter((i) => i.kind === kind);

describe("generic_label", () => {
  it("a button that says Submit, OK or Learn more → is info; a label naming the action is not, nor the same word outside a button", async () => {
    const r = await check(screen(button("Submit", 0), button("Learn more →", 60), button("Book the bench", 120), txt("Body", "Submit your bike for a check-up.", 200), txt("Lone", "OK", 240)));
    const found = of(r.issues, "generic_label");
    expect(found.map((i) => i.detail.match(/says "([^"]+)"/)![1])).toEqual(["Submit", "Learn more →"]);
    expect(found.every((i) => i.severity === "info")).toBe(true);
    expect(found[0]!.detail).toMatch(/Apple HIG Writing/);
  });

  it("a layer named for a call to action counts as a button too", async () => {
    const cta = mk("FRAME", "CTA", [0, 0, 200, 48], { fills: white }, [txt("Label", "Read more", 14)]);
    expect(of((await check(screen(cta))).issues, "generic_label")).toHaveLength(1);
  });
});

describe("label_case_mixed", () => {
  it("buttons in title case beside buttons in sentence case: one info on the deliverable", async () => {
    const r = await check(screen(button("Book a Bench", 0), button("Find a mechanic", 60), button("Pay now", 120)));
    const found = of(r.issues, "label_case_mixed");
    expect(found.map((i) => [i.name, i.severity])).toEqual([["Screen", "info"]]);
    expect(found[0]!.detail).toMatch(/title case \("Book a Bench"\) and sentence case \("Find a mechanic", "Pay now"\)/);
  });

  it("one style throughout, one-word labels, or a case set by the text style are not mixed", async () => {
    expect(of((await check(screen(button("Book a bench"), button("Find a mechanic", 60)))).issues, "label_case_mixed")).toEqual([]);
    expect(of((await check(screen(button("Book"), button("Find a Mechanic", 60)))).issues, "label_case_mixed")).toEqual([]);
    expect(of((await check(screen(button("Book a Bench"), button("find a mechanic", 60, { textCase: "UPPER" })))).issues, "label_case_mixed")).toEqual([]);
  });

  it("caseStyle: small words stay lower in title case; a proper noun inside sentence case is neither", () => {
    expect(caseStyle("Sign Up for the Newsletter")).toBe("title");
    expect(caseStyle("Sign up")).toBe("sentence");
    expect(caseStyle("Open in Figma desktop")).toBeNull();
    expect(caseStyle("BOOK NOW")).toBeNull();
  });
});

describe("error_interjection", () => {
  it("Oops, Uh-oh, Whoops are info; a word that contains one is not", async () => {
    const r = await check(screen(txt("Error", "Oops! Something went wrong.", 0), txt("Alt", "Uh-oh, the slot is gone", 40), txt("Fine", "Hoopskirt repairs", 80)));
    expect(of(r.issues, "error_interjection").map((i) => i.name)).toEqual(["Error", "Alt"]);
  });
});

describe("error_code_only", () => {
  it("a code with no words around it is info; with a message beside it, or a bare number, it is not", async () => {
    const alone = mk("FRAME", "Error card", [0, 0, 400, 200], {}, [txt("Code", "Error 500", 10)]);
    const constant = mk("FRAME", "Toast", [0, 300, 400, 100], {}, [txt("Code", "ERR_CONNECTION_REFUSED", 310)]);
    const told = mk("FRAME", "Error card", [0, 500, 400, 200], {}, [txt("Code", "Error 500", 510), txt("Message", "We could not save your booking. Try again in a minute.", 540)]);
    const stat = mk("FRAME", "Stat", [0, 800, 400, 200], {}, [txt("Number", "404", 810)]);
    const r = await check(screen(alone, constant, told, stat));
    const found = of(r.issues, "error_code_only");
    expect(found.map((i) => i.detail.match(/reads "([^"]+)"/)![1])).toEqual(["Error 500", "ERR_CONNECTION_REFUSED"]);
    expect(found[0]!.detail).toMatch(/NN\/g/);
  });
});

describe("copy_variants", () => {
  it("one thing written two ways — a dash, a quote mark, a case — is info on the rarer spelling", async () => {
    const r = await check(screen(txt("A", "Sign up", 0), txt("B", "Sign up", 40), txt("C", "Sign-up", 80), txt("D", "Don't miss a slot", 120), txt("E", "Don’t miss a slot", 160)));
    const found = of(r.issues, "copy_variants");
    expect(found.map((i) => i.name).sort()).toEqual(["C", "E"]);
    const signup = found.find((i) => i.name === "C")!;
    expect(signup.detail).toMatch(/reads "Sign-up", and "A" .* writes the same thing "Sign up"/);
  });

  it("different words, or the same spelling twice, are not variants", async () => {
    expect(of((await check(screen(txt("A", "Book a bench", 0), txt("B", "Book a bench", 40), txt("C", "Book a mechanic", 80)))).issues, "copy_variants")).toEqual([]);
    expect(copyKey("“Fix it” — yourself…")).toBe("fix it yourself");
  });
});
