import { describe, expect, it } from "vitest";
import { itemHashOf, type StoredAiItem } from "@/lib/content/ai-item";
import { parseMathText, type MathTextDoc } from "@/lib/math-text";
import { rehashPackage } from "@/lib/package/inputs";
import { PackageSchema, type LessonPackage } from "@/lib/package/schema";
import { validatePackage } from "@/lib/package/validate";
import type { CurriculumContext } from "@/lib/curriculum/context";
import { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { aiTestPackage } from "../fixtures/ai-package";
import { testPackage } from "../fixtures/package";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const doc = (source: string): MathTextDoc => {
  const r = parseMathText(source);
  if (!r.ok) throw new Error(r.code);
  return r.doc;
};
const codes = (pkg: unknown) => {
  const r = validatePackage(pkg);
  return { overall: r.overall, codes: [...r.structure.issues, ...(r.ai?.issues ?? []), ...r.prose.issues].map((i) => i.code) };
};

type AnyBlock = { type: string; questionId?: string } & Record<string, unknown>;
/** Edit blocks of a copy of the package, then recompute section hashes so only the semantic check can object. */
function edit(pkg: LessonPackage, fn: (blocks: AnyBlock[]) => void): LessonPackage {
  const copy = clone(pkg);
  fn(copy.sections.flatMap((s) => s.blocks as AnyBlock[]));
  return rehashPackage(copy, LessonRequestV2.parse(copy.request), copy.context as CurriculumContext);
}
const block = (blocks: AnyBlock[], type: string, id: string) => blocks.find((b) => b.type === type && b.questionId === id)!;

describe("lesson-package/2 with model items", () => {
  it("parses, validates as labelled, and reports one label per item", () => {
    const { pkg } = aiTestPackage();
    expect(PackageSchema.safeParse(pkg).success).toBe(true);
    expect(pkg.schemaVersion).toBe("lesson-package/2");
    const r = validatePackage(pkg);
    expect(r.overall, JSON.stringify([r.structure.issues, r.ai?.issues, r.prose.issues])).toBe("labelled");
    expect(r.ai?.items.map((i) => [i.questionId, i.status, i.label])).toEqual([
      ["we-1", "code_checked", "checked"],
      ["ex-1", "code_checked", "checked"],
      ["ex-2", "unchecked", "review"],
      ["ex-3", "code_checked", "checked"],
    ]);
  });

  it("the deterministic builder still produces /1 and validates verified", () => {
    const pkg = testPackage();
    expect(pkg.schemaVersion).toBe("lesson-package/1");
    const r = validatePackage(pkg);
    expect(r.overall).toBe("verified");
    expect(r.ai).toBeNull();
  });

  it("fails when the answer key is in a different order from the worksheet", () => {
    const { pkg } = aiTestPackage();
    const copy = clone(pkg);
    const solutions = copy.sections.find((s) => s.kind === "solutions")!;
    solutions.blocks = [...solutions.blocks].reverse();
    const reordered = rehashPackage(copy, LessonRequestV2.parse(copy.request), copy.context as CurriculumContext);
    const r = codes(reordered);
    expect(r.overall).toBe("failed");
    expect(r.codes).toContain("EXERCISES_SOLUTIONS_MISMATCH");
  });

  it("refuses model blocks in a /1 package", () => {
    const { pkg } = aiTestPackage();
    const v1 = rehashPackage({ ...clone(pkg), schemaVersion: "lesson-package/1" }, LessonRequestV2.parse(pkg.request), pkg.context as CurriculumContext);
    expect(codes(v1)).toMatchObject({ overall: "failed" });
    expect(codes(v1).codes).toContain("AI_BLOCK_IN_V1");
  });
});

describe("stored statuses are re-derived by code", () => {
  it("altering a stored code_checked answer fails validation (hash no longer matches)", () => {
    const { pkg } = aiTestPackage();
    const tampered = edit(pkg, (blocks) => {
      block(blocks, "ai_solution", "ex-1").answer = { kind: "number", value: doc("\\(x=5\\)") };
    });
    expect(codes(tampered)).toMatchObject({ overall: "failed" });
    expect(codes(tampered).codes).toContain("AI_ITEM_HASH_MISMATCH");
  });

  it("a tampered answer with a recomputed hash is caught by running the checker again", () => {
    const { pkg } = aiTestPackage();
    const tampered = edit(pkg, (blocks) => {
      const q = block(blocks, "ai_question", "ex-1");
      const a = block(blocks, "ai_solution", "ex-1");
      a.answer = { kind: "number", value: doc("\\(x=5\\)") };
      const hash = itemHashOf({ stem: q.stem as MathTextDoc, answer: a.answer as StoredAiItem["answer"], steps: a.steps as MathTextDoc[], claim: a.claim as StoredAiItem["claim"] });
      q.itemHash = hash;
      a.itemHash = hash;
    });
    const r = codes(tampered);
    expect(r.overall).toBe("failed");
    expect(r.codes).toContain("AI_CHECK_FAILED");
  });

  it("a status stronger than code can derive is refused", () => {
    const { pkg } = aiTestPackage();
    const overstated = edit(pkg, (blocks) => {
      block(blocks, "ai_question", "ex-2").status = "code_checked";
      block(blocks, "ai_solution", "ex-2").status = "code_checked";
    });
    expect(codes(overstated).codes).toContain("AI_STATUS_OVERSTATED");
    expect(codes(overstated).overall).toBe("failed");
  });

  it("dropping the claim from a code_checked item is refused", () => {
    const { pkg } = aiTestPackage();
    const stripped = edit(pkg, (blocks) => {
      const q = block(blocks, "ai_question", "ex-1");
      const a = block(blocks, "ai_solution", "ex-1");
      delete a.claim;
      const hash = itemHashOf({ stem: q.stem as MathTextDoc, answer: a.answer as StoredAiItem["answer"], steps: a.steps as MathTextDoc[] });
      q.itemHash = hash;
      a.itemHash = hash;
    });
    expect(codes(stripped).codes).toContain("AI_STATUS_OVERSTATED");
  });

  it("a stored failed item fails the package", () => {
    const { pkg } = aiTestPackage();
    const failed = edit(pkg, (blocks) => {
      block(blocks, "ai_question", "ex-2").status = "failed";
      block(blocks, "ai_solution", "ex-2").status = "failed";
    });
    expect(codes(failed)).toMatchObject({ overall: "failed" });
    expect(codes(failed).codes).toContain("AI_ITEM_FAILED");
  });

  it("a stored cross_checked status is kept for an item no checker covers", () => {
    const { pkg } = aiTestPackage();
    const crossed = edit(pkg, (blocks) => {
      block(blocks, "ai_question", "ex-2").status = "cross_checked";
      block(blocks, "ai_solution", "ex-2").status = "cross_checked";
    });
    const r = validatePackage(crossed);
    expect(r.overall).toBe("labelled");
    expect(r.ai?.items.find((i) => i.questionId === "ex-2")).toMatchObject({ status: "cross_checked", label: "review" });
  });
});

describe("pairing of questions and answers", () => {
  it("fails when the answer's item hash differs from the question's", () => {
    const { pkg } = aiTestPackage();
    const broken = edit(pkg, (blocks) => {
      block(blocks, "ai_solution", "ex-3").itemHash = "0".repeat(64);
    });
    expect(codes(broken).codes).toContain("AI_HASH_PAIR_MISMATCH");
  });

  it("fails when two exercises swap answers (ids and hashes no longer agree)", () => {
    const { pkg } = aiTestPackage();
    const swapped = edit(pkg, (blocks) => {
      const a1 = block(blocks, "ai_solution", "ex-1");
      const a3 = block(blocks, "ai_solution", "ex-3");
      [a1.answer, a3.answer] = [a3.answer, a1.answer];
    });
    expect(codes(swapped).overall).toBe("failed");
  });

  it("fails when an exercise has no answer, or an answer no exercise", () => {
    const { pkg } = aiTestPackage();
    const missing = edit(pkg, (blocks) => {
      block(blocks, "ai_solution", "ex-3").questionId = "ex-9";
    });
    const r = codes(missing);
    expect(r.overall).toBe("failed");
    expect(r.codes).toEqual(expect.arrayContaining(["AI_MISSING_SOLUTION", "AI_MISSING_QUESTION"]));
  });

  it("fails on a repeated question id", () => {
    const { pkg } = aiTestPackage();
    const dup = edit(pkg, (blocks) => {
      block(blocks, "ai_question", "ex-3").questionId = "ex-1";
    });
    expect(codes(dup).codes).toContain("AI_QUESTION_ID_DUPLICATE");
  });
});

describe("wording and duplicates in model items", () => {
  it("refuses a curriculum name that entered a stored item", () => {
    const { pkg } = aiTestPackage();
    const named = edit(pkg, (blocks) => {
      const q = block(blocks, "ai_question", "ex-2");
      const a = block(blocks, "ai_solution", "ex-2");
      q.stem = doc("This follows the Fictional Mathematics Programme. Explain why \\(a+b=b+a\\).");
      const hash = itemHashOf({ stem: q.stem as MathTextDoc, answer: a.answer as StoredAiItem["answer"], steps: a.steps as MathTextDoc[] });
      q.itemHash = hash;
      a.itemHash = hash;
    });
    expect(codes(named).codes).toContain("AI_FORBIDDEN_WORDING");
  });

  it("refuses the same question twice", () => {
    const { pkg } = aiTestPackage();
    const twice = edit(pkg, (blocks) => {
      const q1 = block(blocks, "ai_question", "ex-1");
      const a1 = block(blocks, "ai_solution", "ex-1");
      const q3 = block(blocks, "ai_question", "ex-3");
      const a3 = block(blocks, "ai_solution", "ex-3");
      Object.assign(q3, { stem: q1.stem, itemHash: q1.itemHash, status: q1.status });
      Object.assign(a3, { answer: a1.answer, steps: a1.steps, claim: a1.claim, itemHash: a1.itemHash, status: a1.status });
    });
    expect(codes(twice).codes).toContain("AI_DUPLICATE_ITEM");
  });
});
