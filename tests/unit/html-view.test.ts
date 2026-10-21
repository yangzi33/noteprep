import { describe, expect, it } from "vitest";
import { DOCUMENT_TITLES } from "@/lib/latex/templates";
import { renderDocument } from "@/lib/latex/render";
import { equationTex, operationText, solutionText } from "@/lib/latex/math";
import { htmlDocument, type HtmlBlock, type Inline } from "@/lib/package/html-view";
import { DOCUMENT_KINDS, type LessonPackage, type Section } from "@/lib/package/schema";
import { testPackage } from "../fixtures/package";

type Block = Section["blocks"][number];
const pkg = testPackage();

const numbered = (b: HtmlBlock) => b.type === "question" || b.type === "worked" || b.type === "solution";
const blocksOf = (doc: ReturnType<typeof htmlDocument>) => doc.sections.flatMap((s) => s.blocks);
const rejoin = (parts: Inline[]) => parts.map((p) => (p.kind === "math" ? `$${p.tex}$` : p.value)).join("");

/** All math TeX the PDF renderer can produce for this package, from the three shared functions only. */
function allowedMath(p: LessonPackage): Set<string> {
  const out = new Set<string>();
  const addInline = (text: string) => {
    for (const m of text.matchAll(/\$([^$]*)\$/g)) out.add(m[1]!);
  };
  for (const s of p.sections) {
    for (const b of s.blocks) {
      if (b.type === "question") out.add(equationTex(b.problem.equation));
      if (b.type === "worked_example" || b.type === "solution") {
        if (b.type === "worked_example") out.add(equationTex(b.problem.equation));
        addInline(solutionText(b.solution));
        for (const st of b.steps) {
          addInline(operationText(st.op));
          out.add(equationTex(st.result));
        }
      }
    }
  }
  return out;
}

describe("htmlDocument", () => {
  it("uses the PDF titles, the topic title as subtitle, and the header meta line", () => {
    for (const id of DOCUMENT_KINDS) {
      const doc = htmlDocument(pkg, id);
      expect(doc.document).toBe(id);
      expect(doc.title).toBe(DOCUMENT_TITLES[id]);
      expect(doc.subtitle).toBe("Solving with one unknown");
      expect(doc.meta).toBe(id === "worksheet" ? null : "60 minutes · Mixed (easy to hard)");
    }
  });

  it("matches the PDF header text for the difficulty label", () => {
    expect(renderDocument(pkg, "notes").tex).toContain("60 minutes \\quad Mixed (easy to hard)");
    for (const [difficulty, label] of [["basic", "Basic"], ["challenge", "Challenge"]] as const) {
      const p = testPackage({ difficulty });
      expect(htmlDocument(p, "notes").meta).toBe(`60 minutes · ${label}`);
      expect(renderDocument(p, "notes").tex).toContain(`60 minutes \\quad ${label}`);
    }
  });

  it("agrees with the PDF source on numbering, counts, and math strings", () => {
    for (const id of DOCUMENT_KINDS) {
      const doc = htmlDocument(pkg, id);
      const tex = renderDocument(pkg, id).tex;
      const blocks = blocksOf(doc);
      const numberedBlocks = blocks.filter(numbered);
      const texCount = [...tex.matchAll(/\\textbf\{(?:Example )?\d+\.\}/g)].length;
      expect(numberedBlocks.length).toBeGreaterThan(0);
      expect(numberedBlocks.length).toBe(texCount);

      // Numbering restarts at 1 in every section and increments per block.
      for (const section of doc.sections) {
        const nums = section.blocks.filter(numbered).map((b) => (b as { number: number }).number);
        expect(nums).toEqual(nums.map((_, i) => i + 1));
      }
      // The exact number labels appear in the TeX.
      for (const section of doc.sections) {
        for (const b of section.blocks) {
          if (b.type === "worked") expect(tex).toContain(`\\textbf{Example ${b.number}.}`);
          else if (b.type === "question" || b.type === "solution") expect(tex).toContain(`\\textbf{${b.number}.}`);
        }
      }
      for (const b of blocks) {
        if (b.type === "question") expect(tex).toContain(b.tex);
        if (b.type === "solution" || b.type === "worked") {
          expect(tex).toContain(b.problemTex);
          for (const s of b.steps) expect(tex).toContain(s.resultTex);
          expect(tex).toContain(`\\answerline{${rejoin(b.answer)}}`);
        }
      }
    }
  });

  it("rebuilds answers with solutionText and steps with operationText", () => {
    const notes = htmlDocument(pkg, "notes");
    const worked = pkg.sections.flatMap((s) => s.blocks as Block[]).flatMap((b) => (b.type === "worked_example" ? [b] : []));
    const htmlWorked = blocksOf(notes).filter((b) => b.type === "worked");
    expect(htmlWorked.length).toBe(worked.length);
    worked.forEach((w, i) => {
      const h = htmlWorked[i]!;
      if (h.type !== "worked") throw new Error("shape");
      expect(h.questionId).toBe(w.questionId);
      expect(rejoin(h.answer)).toBe(solutionText(w.solution));
      expect(h.problemTex).toBe(equationTex(w.problem.equation));
      expect(h.steps.map((s) => rejoin(s.parts))).toEqual(w.steps.map((s) => operationText(s.op)));
      expect(h.steps.map((s) => s.resultTex)).toEqual(w.steps.map((s) => equationTex(s.result)));
    });
  });

  it("keeps answers out of the worksheet", () => {
    const doc = htmlDocument(pkg, "worksheet");
    expect(doc.sections.map((s) => s.kind)).toEqual(["exercises", "alignment"]);
    const types = new Set(blocksOf(doc).map((b) => b.type));
    expect(types.has("solution")).toBe(false);
    expect(types.has("worked")).toBe(false);
    expect(blocksOf(doc).filter((b) => b.type === "question").length).toBeGreaterThan(0);
  });

  it("links every solution to a worksheet question by id", () => {
    const questionIds = blocksOf(htmlDocument(pkg, "worksheet")).flatMap((b) => (b.type === "question" ? [b.questionId] : []));
    const solutionIds = blocksOf(htmlDocument(pkg, "solutions")).flatMap((b) => (b.type === "solution" ? [b.questionId] : []));
    expect(solutionIds.length).toBeGreaterThan(0);
    expect(solutionIds).toEqual(questionIds);
  });

  it("throws RangeError for a solution without a matching question", () => {
    const broken = structuredClone(pkg);
    for (const s of broken.sections) {
      if (s.kind === "exercises") s.blocks = s.blocks.filter((b) => b.type !== "question") as typeof s.blocks;
    }
    expect(() => htmlDocument(broken, "solutions")).toThrow(RangeError);
  });

  it("keeps hostile text as plain strings and takes math only from the shared functions", () => {
    const hostile = structuredClone(pkg);
    for (const s of hostile.sections) {
      for (const b of s.blocks) {
        if (b.type === "paragraph") b.text = "<script>alert(1)</script>";
        if (b.type === "list") b.items = ["</li><img src=x onerror=alert(1)>", "$\\input{/etc/passwd}$"];
      }
    }
    const allowed = allowedMath(hostile);
    const seenText: string[] = [];
    for (const id of DOCUMENT_KINDS) {
      const doc = htmlDocument(hostile, id);
      for (const b of blocksOf(doc)) {
        if (b.type === "paragraph") seenText.push(b.text);
        if (b.type === "list") seenText.push(...b.items);
        if (b.type === "question") expect(allowed.has(b.tex)).toBe(true);
        if (b.type === "worked" || b.type === "solution") {
          expect(allowed.has(b.problemTex)).toBe(true);
          for (const s of b.steps) {
            expect(allowed.has(s.resultTex)).toBe(true);
            for (const p of s.parts) if (p.kind === "math") expect(allowed.has(p.tex)).toBe(true);
          }
          for (const p of b.answer) if (p.kind === "math") expect(allowed.has(p.tex)).toBe(true);
        }
      }
    }
    expect(seenText).toContain("<script>alert(1)</script>");
    expect(seenText).toContain("</li><img src=x onerror=alert(1)>");
    expect(seenText).toContain("$\\input{/etc/passwd}$");
  });

  it("lists alignment objectives in full, with partial coverage flagged", () => {
    const doc = htmlDocument(pkg, "worksheet");
    const alignment = blocksOf(doc).find((b) => b.type === "alignment");
    if (!alignment || alignment.type !== "alignment") throw new Error("no alignment block");
    expect(alignment.claim).toBe("none");
    expect(alignment.curriculumName).toBe("Fictional Mathematics Programme");
    expect(alignment.datasetKind).toBe("sample");
    expect(alignment.objectives.map((o) => o.partial)).toEqual([false, true]);
    expect(alignment.objectives.map((o) => o.officialCode)).toEqual(["FIC-E.1", "FIC-E.2"]);
    expect(alignment.objectives.map((o) => o.note)).toEqual([null, "substitution only"]);
  });

  it("throws RangeError when the worksheet document lists a solutions section", () => {
    const broken = structuredClone(pkg);
    const solutions = broken.sections.find((s) => s.kind === "solutions");
    if (!solutions) throw new Error("fixture has no solutions section");
    const worksheet = broken.documents.find((d) => d.id === "worksheet");
    if (!worksheet) throw new Error("fixture has no worksheet document");
    (worksheet.sectionIds as string[]).push(solutions.id);
    expect(() => htmlDocument(broken, "worksheet")).toThrow(RangeError);
  });

  it("restarts numbering in every section that has numbered blocks", () => {
    const two = structuredClone(pkg);
    const source = two.sections.find((s) => s.blocks.some((b) => b.type === "worked_example"));
    if (!source) throw new Error("fixture has no worked example");
    const moved = (source.blocks as Block[]).filter((b) => b.type === "worked_example");
    expect(moved.length).toBeGreaterThan(0);
    const copy = structuredClone(source);
    copy.id = `${source.id}-second`;
    const kept = (source.blocks as Block[]).filter((b) => b.type !== "worked_example");
    source.blocks = [...kept, moved[0]!] as typeof source.blocks;
    copy.blocks = [moved[moved.length - 1]!] as typeof copy.blocks;
    const notes = two.documents.find((d) => d.id === "notes")!;
    (notes.sectionIds as string[]).splice(notes.sectionIds.indexOf(source.id) + 1, 0, copy.id);
    two.sections.splice(two.sections.indexOf(source) + 1, 0, copy);
    const doc = htmlDocument(two, "notes");
    const per = doc.sections.map((s) => s.blocks.filter(numbered).map((b) => (b as { number: number }).number)).filter((n) => n.length > 0);
    expect(per.length).toBeGreaterThanOrEqual(2);
    for (const nums of per) expect(nums).toEqual(nums.map((_, i) => i + 1));
    expect(per[per.length - 1]).toEqual([1]);
  });

  it("keeps a paragraph that contains $x$ as one plain string, with no math part", () => {
    const p = structuredClone(pkg);
    for (const s of p.sections) for (const b of s.blocks) if (b.type === "paragraph") b.text = "Say $x$ aloud.";
    const paragraphs = blocksOf(htmlDocument(p, "notes")).filter((b) => b.type === "paragraph");
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const b of paragraphs) {
      expect(b).toEqual({ type: "paragraph", text: "Say $x$ aloud." });
      expect(typeof (b as { text: unknown }).text).toBe("string");
    }
  });
});
