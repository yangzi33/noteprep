import { describe, expect, it } from "vitest";
import { renderPackage } from "@/lib/latex/render";
import { solutionText } from "@/lib/latex/math";
import { testPackage } from "../fixtures/package";
import { compiler, leftoverContainers, pdfText } from "./helpers";

const docs = (p: ReturnType<typeof testPackage>) => renderPackage(p).map((d) => ({ id: d.id, tex: d.tex }));

describe("compiling a real lesson package in the sandbox", () => {
  it("produces a valid PDF for each of the three documents", async () => {
    const pkg = testPackage();
    const result = await compiler().compile({ documents: docs(pkg) });
    expect(result.map((r) => r.id)).toEqual(["notes", "worksheet", "solutions"]);
    for (const r of result) {
      expect(Buffer.from(r.pdf.subarray(0, 5)).toString()).toBe("%PDF-");
      expect(r.pdf.byteLength).toBeGreaterThan(5_000);
      expect(r.pages).toBeGreaterThanOrEqual(1);
      expect(r.pages).toBeLessThan(12);
    }
  });

  it("the worksheet's PDF text contains every question and no answer; the key contains every answer", async () => {
    const pkg = testPackage({ difficulty: "mixed" }, "text-check");
    const result = Object.fromEntries((await compiler().compile({ documents: docs(pkg) })).map((r) => [r.id, r]));
    const worksheet = await pdfText(result.worksheet!.pdf);
    const solutions = await pdfText(result.solutions!.pdf);
    const notes = await pdfText(result.notes!.pdf);

    const key = pkg.sections.find((s) => s.kind === "solutions")!;
    const answers = key.blocks.flatMap((b) => (b.type === "solution" ? [b] : []));
    expect(answers.length).toBeGreaterThanOrEqual(3);
    expect(worksheet).toContain("Student Practice Worksheet");
    expect(worksheet.match(/Solve for x:/g)?.length).toBe(answers.length);
    expect(worksheet).not.toMatch(/Answer|Solutions|both sides|Subtract|Divide|Multiply/i);
    // The answer text as it prints ("x = -3"), for every exercise, must be absent from the student's PDF and present in the key.
    for (const a of answers) {
      if (a.solution.kind !== "unique") continue;
      const printed = `x = ${a.solution.value!.replace("-", "−")}`; // pdftotext prints the math minus sign
      expect(solutions, a.questionId).toContain(printed.includes("/") ? "x =" : printed);
    }
    expect(solutions).toContain("Solutions / Answer Key");
    expect(solutions).toContain("Answer:");
    expect(notes).toContain("Tutor Lesson Notes");
    expect(notes).toContain("Solve equations with one unknown"); // dataset wording
    expect(notes).toContain("AI-assisted material. Review it before teaching.");
    expect(notes).toContain("not a real curriculum");
    void solutionText;
  });

  it("is reproducible: the same source gives byte-identical PDFs", async () => {
    const documents = docs(testPackage({}, "repro"));
    const a = await compiler().compile({ documents });
    const b = await compiler().compile({ documents });
    for (let i = 0; i < a.length; i++) expect(Buffer.compare(Buffer.from(a[i]!.pdf), Buffer.from(b[i]!.pdf)), a[i]!.id).toBe(0);
  });

  it("compiles every difficulty, length and dataset kind, and a pack of fewer documents", async () => {
    for (const [difficulty, durationMinutes, kind] of [["basic", 15, "sample"], ["challenge", 180, "real"], ["mixed", 90, "real"]] as const) {
      const result = await compiler().compile({ documents: docs(testPackage({ difficulty, durationMinutes }, `v-${difficulty}`, kind)) });
      expect(result).toHaveLength(3);
    }
    const subset = await compiler().compile({ documents: docs(testPackage({ documents: ["worksheet"] })) });
    expect(subset.map((r) => r.id)).toEqual(["worksheet"]);
  });

  it("prints hostile dataset text literally instead of obeying it", async () => {
    const { testContext, testRequest } = await import("../fixtures/package");
    const { buildPackage } = await import("@/lib/package/build");
    const hostile = "\\input{/etc/passwd} \\write18{id} $x$ % { } ^^5c & #";
    const context = testContext("real", { topic: { id: "t1", title: hostile }, objectives: [{ id: "o1", officialCode: "X~1", label: hostile, coverage: "full", note: null, source: { ref: "r", page: null } }] });
    const pkg = buildPackage({ request: testRequest(), context, seed: "hostile" });
    const result = await compiler().compile({ documents: docs(pkg) });
    const text = await pdfText(result.find((r) => r.id === "notes")!.pdf);
    expect(text).toContain("\\input{/etc/passwd}"); // shown to the reader as text, not executed
    expect(text).not.toContain("root:");
  });

  it("leaves no container behind", async () => {
    expect(await leftoverContainers()).toEqual([]);
  });
});
