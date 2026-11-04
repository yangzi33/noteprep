import { describe, expect, it } from "vitest";
import { preamble } from "@/lib/latex/templates";
import { parseMathText, mathTextToTex } from "@/lib/math-text";
import samples from "../fixtures/math-text/samples-v2.json";
import { compileRaw, pdfText } from "./helpers";

interface Sample {
  id: string;
  input: string;
  uses: string[];
}
const all = samples as Sample[];

function texOf(input: string): string {
  const r = parseMathText(input);
  if (!r.ok) throw new Error(`sample does not parse: ${input}`);
  return mathTextToTex(r.doc);
}

/** One document per course keeps the log readable; every sample is a paragraph rendered by the real MathText TeX path. */
async function compileSamples(group: Sample[], title: string) {
  const body = group.map((s) => `${texOf(s.input)}\n`);
  const tex = [preamble("notes", title), "\\begin{document}", ...body.map((l) => `${l}\n`), "\\end{document}", ""].join("\n");
  const r = await compileRaw({ "notes.tex": tex });
  const log = Buffer.from(r.byName.get("notes.log") ?? new Uint8Array()).toString("utf8");
  return { r, log, tex };
}

describe("mathtext/2 samples compile in the real LaTeX image", () => {
  it("covers every added token at least once across the samples", () => {
    const used = new Set(all.flatMap((s) => s.uses));
    for (const t of ["prime", "factorial", "binom", "bar", "hat", "mu", "sigma", "lambda", "sec", "csc", "cot", "arcsin", "arccos", "arctan", "to", "approx", "in", "mid", "cup", "cap", "infty", "lim", "sum", "int", "thin"]) {
      expect(used.has(t), t).toBe(true);
    }
  });

  for (const [course, prefix] of [["calculus", "c"], ["statistics", "s"], ["pre-calculus", "p"]] as const) {
    it(`the five ${course} samples compile to a PDF with no undefined control sequence or missing glyph`, async () => {
      const group = all.filter((s) => s.id.startsWith(prefix));
      expect(group).toHaveLength(5);
      const { r, log } = await compileSamples(group, `MathText v2 ${course}`);
      const bad = log.split("\n").filter((l) => /Undefined control|Missing character|Illegal character|Missing \$ inserted|Extra \}|Runaway|Emergency stop/.test(l));
      expect(bad).toEqual([]);
      expect(r.exitCode).toBe(0);
      expect(r.byName.has("notes.pdf")).toBe(true);
      const text = (await pdfText(r.byName.get("notes.pdf")!)).replace(/\s+/g, " ");
      expect(text).toContain("MathText v2");
      if (prefix === "c") {
        expect(text).toContain("Evaluate");
        expect(text).toContain("lim");
        expect(text).toContain("dx");
        expect(text).toContain("∞");
      } else if (prefix === "s") {
        expect(text).toContain("Compute");
        expect(text).toContain("µ");
        expect(text).toContain("σ");
      } else {
        expect(text).toContain("arcsin");
        expect(text).toContain("sec");
        expect(text).toContain("∈");
      }
    });
  }
});
