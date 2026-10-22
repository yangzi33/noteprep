import { describe, expect, it } from "vitest";
import { renderDocument, renderPackage } from "@/lib/latex/render";
import { solutionText } from "@/lib/latex/math";
import { buildPackage } from "@/lib/package/build";
import { validatePackage } from "@/lib/package/validate";
import { suggestedTestContext, testPackage, testRequest } from "../fixtures/package";
import { compiler, compileRaw, leftoverContainers, pdfText } from "./helpers";

const docs = (p: ReturnType<typeof testPackage>) => renderPackage(p).map((d) => ({ id: d.id, tex: d.tex }));

describe("a lesson from a suggested topic, end to end", () => {
  it("builds, validates as verified, renders and compiles all three PDFs with the real sandbox compiler", async () => {
    const pkg = buildPackage({ request: testRequest(), context: suggestedTestContext(), seed: "suggested-e2e" });
    expect(validatePackage(JSON.parse(JSON.stringify(pkg))).overall).toBe("verified");
    const result = await compiler().compile({ documents: docs(pkg) });
    expect(result.map((r) => r.id)).toEqual(["notes", "worksheet", "solutions"]);
    for (const r of result) {
      expect(Buffer.from(r.pdf.subarray(0, 5)).toString()).toBe("%PDF-");
      expect(r.pages).toBeGreaterThanOrEqual(1);
    }
    const notes = (await pdfText(result[0]!.pdf)).replace(/-\s+/g, "").replace(/\s+/g, " "); // sentences wrap across lines and words are hyphenated
    expect(notes).toContain("Practise: Solving linear equations");
    expect(notes).toContain("unofficial NotePrep suggestion");
    expect(notes).toContain("not endorsed by any curriculum authority");
    expect(notes).not.toMatch(/This lesson addresses/);
  });
});

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
    // The answer text as it prints ("x = -3") must be present in the key. This loop does NOT prove it is absent from the
    // student's PDF: that is covered by the wording check above and, at source level, by latex-render.test.ts.
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

  it("the running header prints the topic title on every page, and long or hostile titles neither overflow nor break the build", async () => {
    const base = testPackage();
    const withTitle = (title: string) => ({ ...base, context: { ...(base.context as object), topic: { id: "t1", title } } }) as typeof base;
    const titles = [
      "Solving linear equations with one unknown variable using inverse operations", // cut to 60
      "WWWWWWW ".repeat(5), // wide capitals in words (35 chars): wraps to 2 lines. 60 wide capitals can need 3 (cosmetic: fancyhdr warns, nothing breaks)
      "Mixed Numbers, Ratios And Percentages Of Quantities In Real Life Problems", // capitalised, wraps to 2 lines
      "A&B 50% x_1 #2 $3 {a} ~ ^ \"q\" \\input{/etc/passwd} \\write18{id} Café",
      "",
    ];
    for (const title of titles) {
      const r = await compileRaw({ "notes.tex": renderDocument(withTitle(title), "notes").tex });
      const log = Buffer.from(r.byName.get("notes.log") ?? new Uint8Array()).toString("utf8");
      expect(log.split("\n").filter((l) => /Missing character|Undefined control|Illegal character|Overfull \\hbox|Overfull \\vbox|headheight.{0,12}too small|too small/.test(l)), title).toEqual([]);
      const pdf = r.byName.get("notes.pdf")!;
      expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-");
      const text = await pdfText(pdf);
      expect(text).toContain("Tutor Lesson Notes");
      if (title === "") expect(text).toContain("NotePrep");
      if (title.startsWith("Solving")) expect(text).toContain("variable using...");
    }
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
