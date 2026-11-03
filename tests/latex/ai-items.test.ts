import { describe, expect, it } from "vitest";
import { renderPackage } from "@/lib/latex/render";
import { aiTestPackage } from "../fixtures/ai-package";
import { compiler, pdfText } from "./helpers";

const flat = (s: string) => s.replace(/-\s+/g, "").replace(/\s+/g, " ");

describe("a lesson package with model items, compiled in the real sandbox", () => {
  it("compiles all three PDFs; the legend is in Notes/Solutions, the worksheet has no marker, legend or AI answer", async () => {
    const { pkg } = aiTestPackage();
    const result = Object.fromEntries(
      (await compiler().compile({ documents: renderPackage(pkg).map((d) => ({ id: d.id, tex: d.tex })) })).map((r) => [r.id, r]),
    );
    expect(Object.keys(result).sort()).toEqual(["notes", "solutions", "worksheet"]);
    for (const r of Object.values(result)) expect(Buffer.from(r.pdf.subarray(0, 5)).toString()).toBe("%PDF-");

    const solutions = flat(await pdfText(result.solutions!.pdf));
    const worksheet = flat(await pdfText(result.worksheet!.pdf));
    expect(solutions).toContain("Marked items are AI-generated and were not checked by code");
    expect(solutions).toContain("Addition is commutative");
    expect(worksheet).toContain("Explain why");
    expect(worksheet).not.toContain("Marked items");
    expect(worksheet).not.toContain("Addition is commutative");
    expect(worksheet).not.toContain("*");
  });
});
