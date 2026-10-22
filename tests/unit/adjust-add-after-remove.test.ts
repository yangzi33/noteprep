import { describe, expect, it } from "vitest";
import { adjustmentSeed, applyAdjustment, packageContentHash } from "@/lib/package/adjust";
import { rehashPackage } from "@/lib/package/inputs";
import type { CurriculumContext } from "@/lib/curriculum/context";
import type { LessonPackage, Section } from "@/lib/package/schema";
import { validatePackage } from "@/lib/package/validate";
import { testPackage } from "../fixtures/package";

type Block = Section["blocks"][number];

/** Test helper: drops one exercise (question, its writing space) and its solution, as a later removal feature would. */
function withoutExercise(pkg: LessonPackage, questionId: string): LessonPackage {
  const sections = pkg.sections.map((s) => {
    if (s.kind === "exercises") {
      const blocks = s.blocks as Block[];
      const at = blocks.findIndex((b) => b.type === "question" && b.questionId === questionId);
      const next = blocks.filter((_, i) => i !== at && i !== at + 1);
      return { ...s, blocks: next } as Section;
    }
    if (s.kind === "solutions") return { ...s, blocks: (s.blocks as Block[]).filter((b) => !(b.type === "solution" && b.questionId === questionId)) } as Section;
    return s;
  });
  return rehashPackage({ ...pkg, sections }, pkg.request as { difficulty: "basic" | "mixed" | "challenge" }, pkg.context as CurriculumContext);
}

const ids = (pkg: LessonPackage) => (pkg.sections.find((s) => s.kind === "exercises")!.blocks as Block[]).flatMap((b) => (b.type === "question" ? [b.questionId] : []));

describe("add_exercises after a removal", () => {
  it("never reuses an existing id (it continues after the largest number, not after the count)", () => {
    const pkg = testPackage({ difficulty: "mixed", durationMinutes: 60 });
    const before = ids(pkg);
    expect(before.length).toBeGreaterThan(3);
    const removed = withoutExercise(pkg, before[0]!); // ex-2.. remain; count + 1 would be an existing id
    const change = { action: "add_exercises", count: 2 } as const;
    const next = applyAdjustment(removed, change, { seed: adjustmentSeed(removed, packageContentHash(removed), change), context: removed.context as CurriculumContext });
    const after = ids(next);
    expect(new Set(after).size).toBe(after.length);
    expect(after.slice(-2).sort()).toEqual([`ex-${before.length + 1}`, `ex-${before.length + 2}`]);
    expect(validatePackage(next).overall).toBe("verified");
  });
});
