import path from "node:path";
import { readDatasetDir } from "@/lib/curriculum/files";
import { describe, expect, it } from "vitest";
import { learningObjectiveItems } from "@/lib/curriculum/context";
import { escapeText } from "@/lib/latex/escape";
import { renderPackage } from "@/lib/latex/render";
import { buildPackage } from "@/lib/package/build";
import { htmlDocument } from "@/lib/package/html-view";
import { checkProse, validatePackage } from "@/lib/package/validate";
import { suggestedTestContext, testContext, testRequest } from "../fixtures/package";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
describe("the in-memory suggested test context", () => {
  it("matches the fixture dataset", () => {
    const d = readDatasetDir(path.join(__dirname, "../fixtures/curricula/suggested-fixture/v1"));
    const c = suggestedTestContext();
    expect(c.curriculum.id).toBe(d.meta.curriculum.id);
    expect(c.curriculum.name).toBe(d.meta.curriculum.name);
    expect(c.curriculum.educationSystem).toEqual(d.meta.educationSystem);
    expect(c.curriculum.version).toMatchObject({ id: d.meta.version.id, label: d.meta.version.label, kind: d.meta.version.kind });
    expect(c.curriculum.version.source.title).toBe(d.meta.version.source.title);
    expect(c.topic).toEqual({ id: d.structure.topics[0]!.id, title: d.structure.topics[0]!.title });
  });
});

describe("a lesson built from a suggested topic", () => {
  const context = suggestedTestContext();
  const pkg = buildPackage({ request: testRequest(), context, seed: "s" });

  it("has exactly one objective, derived from NotePrep's topic title, with no code", () => {
    expect(learningObjectiveItems(context)).toEqual(["Practise: Solving linear equations"]);
    const section = pkg.sections.find((s) => s.kind === "objectives")!;
    const lists = section.blocks.flatMap((b) => (b.type === "list" ? [b.items] : []));
    expect(lists).toEqual([["Practise: Solving linear equations"]]);
    expect(pkg.outline.sections.every((s) => s.objectiveIds.length === 0)).toBe(true);
  });
  it("validates as verified, with the claim kept at none", () => {
    expect(validatePackage(clone(pkg))).toMatchObject({ overall: "verified", structure: { overall: "pass" }, prose: { overall: "pass" } });
    const alignment = pkg.sections.find((s) => s.kind === "alignment")!.blocks[0]!;
    expect(alignment).toMatchObject({ type: "alignment", claim: "none", datasetKind: "suggested", objectives: [] });
  });
  it("a changed objective line is still caught as altered dataset text", () => {
    const bad = clone(pkg);
    const list = bad.sections.find((s) => s.kind === "objectives")!.blocks.find((b) => b.type === "list");
    if (list?.type === "list") list.items = ["Master everything"];
    expect(checkProse(bad, context).issues.map((i) => i.code)).toContain("DATASET_TEXT_ALTERED");
  });
  it("renders to LaTeX without an empty list and says the topic list is unofficial", () => {
    for (const doc of renderPackage(pkg)) {
      expect(doc.tex, doc.id).not.toMatch(/\\begin\{itemize\}\s*\\end\{itemize\}/);
    }
    const notes = renderPackage(pkg).find((d) => d.id === "notes")!.tex;
    expect(notes).toContain(escapeText("Practise: Solving linear equations"));
    expect(notes).toContain("not endorsed by any curriculum authority");
    expect(notes).not.toMatch(/This lesson addresses objectives/);
  });
  it("renders the HTML draft with one objective and the unofficial wording", () => {
    const html = JSON.stringify(htmlDocument(pkg, "notes"));
    expect(html).toContain("Practise: Solving linear equations");
  });
  it("the other kinds still list their own objectives", () => {
    const sample = testContext("sample");
    expect(learningObjectiveItems(sample)).toEqual(sample.objectives.map((o) => o.label));
  });
});

describe("defence in depth: the claim must match the dataset kind", () => {
  it("a package whose context allows alignment while the dataset is not real fails validation", () => {
    for (const kind of ["sample", "synthetic", "suggested"] as const) {
      const context = testContext(kind, { alignmentClaimsAllowed: true });
      const pkg = buildPackage({ request: testRequest(), context, seed: "s" });
      expect(checkProse(clone(pkg), context).issues.map((i) => i.code), kind).toContain("ALIGNMENT_CLAIM_NOT_ALLOWED");
      expect(validatePackage(clone(pkg)).overall, kind).toBe("failed");
    }
  });
  it("a real dataset that allows alignment is fine", () => {
    const context = testContext("real");
    expect(validatePackage(clone(buildPackage({ request: testRequest(), context, seed: "s" }))).overall).toBe("verified");
  });
});
