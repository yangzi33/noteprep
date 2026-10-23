import { describe, expect, it } from "vitest";
import { renderDocument, type PageFormat } from "@/lib/latex/render";
import type { DocumentKind, LessonPackage } from "@/lib/package/schema";
import { suggestedTestContext, testPackage } from "../fixtures/package";
import { compiler } from "./helpers";
import { provePdf, type ProofResult } from "./pdf-proof";

// Proof that compiled PDFs carry the package they were made from (ordered fragments and exact counts, see pdf-proof.ts).
// Real compiler and real pdftotext, both inside the sandbox image.

const FIXTURES: { name: string; pkg: () => LessonPackage }[] = [
  { name: "mixed, 60 minutes, sample data", pkg: () => testPackage({}, "seed-1") },
  { name: "challenge, 90 minutes (fractional answers)", pkg: () => testPackage({ difficulty: "challenge", durationMinutes: 90 }, "f0") },
  { name: "basic, 45 minutes, real dataset (alignment stated)", pkg: () => testPackage({ difficulty: "basic", durationMinutes: 45 }, "seed-3", "real") },
  { name: "mixed, suggested topics", pkg: () => testPackage({}, "seed-4", "suggested", suggestedTestContext()) },
];

async function compileAll(pkg: LessonPackage, format: PageFormat): Promise<Map<DocumentKind, Uint8Array>> {
  const out = await compiler().compile({ documents: pkg.documents.map((d) => ({ id: d.id, tex: renderDocument(pkg, d.id, format).tex })) });
  return new Map(out.map((r) => [r.id, r.pdf]));
}
const show = (r: ProofResult) => r.failures.join("\n");

describe("PDF text proves the package", () => {
  for (const fixture of FIXTURES) {
    for (const format of ["letter", "a4"] as const) {
      it(`${fixture.name}: all three documents, ${format}`, async () => {
        const pkg = fixture.pkg();
        const pdfs = await compileAll(pkg, format);
        expect([...pdfs.keys()].sort()).toEqual(["notes", "solutions", "worksheet"]);
        for (const [doc, pdf] of pdfs) {
          const result = await provePdf(pdf, pkg, doc);
          expect(result.failures, `${doc} ${format}\n${show(result)}`).toEqual([]);
          expect(result.pages).toBeGreaterThanOrEqual(1);
        }
      });
    }
  }
});

describe("the proof is sensitive", () => {
  // The same shape of package with one exercise replaced by another seed's question and its answer-key entry.
  function withReplacedQuestion(pkg: LessonPackage, other: LessonPackage, index: number): LessonPackage {
    const clone = structuredClone(pkg);
    const questions = (p: LessonPackage) => p.sections.find((s) => s.kind === "exercises")!.blocks.filter((b) => b.type === "question");
    const solutions = (p: LessonPackage) => p.sections.find((s) => s.kind === "solutions")!.blocks.filter((b) => b.type === "solution");
    const q = questions(clone)[index]!;
    const oq = questions(other)[index]!;
    const s = solutions(clone)[index]!;
    const os = solutions(other)[index]!;
    if (q.type !== "question" || oq.type !== "question" || s.type !== "solution" || os.type !== "solution") throw new Error("fixture shape");
    expect(JSON.stringify(q.problem.equation)).not.toBe(JSON.stringify(oq.problem.equation));
    q.problem = oq.problem;
    s.solution = os.solution;
    s.steps = os.steps;
    return clone;
  }

  it("a PDF does not prove a package in which one question was regenerated", async () => {
    const pkg = testPackage({}, "seed-1");
    const changed = withReplacedQuestion(pkg, testPackage({}, "seed-2"), 2);
    const pdfs = await compileAll(pkg, "letter");
    for (const doc of ["worksheet", "solutions"] as const) {
      expect((await provePdf(pdfs.get(doc)!, pkg, doc)).failures).toEqual([]);
      const result = await provePdf(pdfs.get(doc)!, changed, doc);
      expect(result.ok, `${doc} must fail`).toBe(false);
      expect(result.failures.some((f) => /question 3|solution 3/.test(f)), show(result)).toBe(true);
    }
    // the notes do not contain the exercises, so they still prove (the check is specific, not just noisy)
    expect((await provePdf(pdfs.get("notes")!, changed, "notes")).failures).toEqual([]);
  });

  it("a PDF does not prove a package with another document's content or with a different seed", async () => {
    const pkg = testPackage({}, "seed-1");
    const pdfs = await compileAll(pkg, "letter");
    expect((await provePdf(pdfs.get("solutions")!, pkg, "worksheet")).ok).toBe(false);
    expect((await provePdf(pdfs.get("worksheet")!, pkg, "solutions")).ok).toBe(false);
    expect((await provePdf(pdfs.get("worksheet")!, testPackage({}, "seed-2"), "worksheet")).ok).toBe(false);
  });

  it("a worksheet that shows an answer or a step is refused (leak check)", async () => {
    const pkg = testPackage({}, "seed-1");
    const pdfs = await compileAll(pkg, "letter");
    // the SOLUTIONS pdf is "a worksheet with the answers in it": proving it as a worksheet must name the leaks
    const result = await provePdf(pdfs.get("solutions")!, pkg, "worksheet");
    expect(result.failures.some((f) => f.startsWith("worksheet leaks")), show(result)).toBe(true);
    expect(result.failures.some((f) => f.includes("count of \"Answer:\"")), show(result)).toBe(true);
  });
});
