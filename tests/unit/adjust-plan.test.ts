import { describe, expect, it } from "vitest";
import type { AdjustmentChange, TextEdit } from "@/lib/domain/adjustment";
import { AdjustmentNotApplicable } from "@/lib/domain/errors";
import { canonicalJson } from "@/lib/domain/hash";
import { derivesClosure, MAX_EXAMPLES, MAX_EXERCISES, planAdjustment, referencesDownstream } from "@/lib/package/adjust";
import { planOutline } from "@/lib/package/build";
import type { LessonPackage, Section } from "@/lib/package/schema";
import { testPackage } from "../fixtures/package";

const ID = {
  objectives: "sec-objectives",
  prerequisites: "sec-prerequisites",
  explanation: "sec-explanation",
  derivation: "sec-derivation",
  examples: "sec-worked-examples",
  teaching: "sec-teaching-sequence",
  mistakes: "sec-common-mistakes",
  exercises: "sec-exercises",
  solutions: "sec-solutions",
  alignment: "sec-alignment",
};
const ALL = Object.values(ID);
const without = (...drop: string[]) => ALL.filter((id) => !drop.includes(id));

function reasonOf(pkg: LessonPackage, change: AdjustmentChange): string {
  try {
    planAdjustment(pkg, change);
  } catch (e) {
    expect(e).toBeInstanceOf(AdjustmentNotApplicable);
    return (e as AdjustmentNotApplicable).reason;
  }
  throw new Error("expected AdjustmentNotApplicable");
}

const correct = (sectionId: string, target: TextEdit["target"]): AdjustmentChange => ({
  action: "correct_text",
  edits: [{ sectionId, target, text: "Better words" }],
});

/** The package with its worked-example blocks replaced by `n` unique-solution examples (copies, enough for a count). */
function withExamples(pkg: LessonPackage, n: number): LessonPackage {
  const copy = structuredClone(pkg);
  const s = copy.sections.find((x) => x.kind === "worked_examples")!;
  const example = s.blocks.find((b) => b.type === "worked_example")!;
  (s as { blocks: Section["blocks"] }).blocks = [s.blocks[0]!, ...Array.from({ length: n }, () => structuredClone(example))];
  return copy;
}

describe("planAdjustment: exercise-class actions", () => {
  it("make_harder on mixed regenerates exercises, solutions follow by derives", () => {
    const plan = planAdjustment(testPackage({ difficulty: "mixed" }), { action: "make_harder" });
    expect(plan).toMatchObject({ action: "make_harder", method: "deterministic", changed: [ID.exercises], dependents: [ID.solutions], rehashed: [], unchanged: without(ID.exercises, ID.solutions), outlineChanged: false });
    expect(plan.sections.map((s) => s.id)).toEqual(ALL);
    expect(plan.sections.find((s) => s.id === ID.exercises)).toEqual({ id: ID.exercises, disposition: "regenerate", method: "deterministic" });
    expect(plan.sections.find((s) => s.id === ID.solutions)).toEqual({ id: ID.solutions, disposition: "regenerate", method: "deterministic" });
    expect(plan.sections.find((s) => s.id === ID.alignment)).toEqual({ id: ID.alignment, disposition: "unchanged", method: null });
  });

  it("make_easier on mixed has the same shape", () => {
    const plan = planAdjustment(testPackage({ difficulty: "mixed" }), { action: "make_easier" });
    expect([plan.changed, plan.dependents, plan.rehashed]).toEqual([[ID.exercises], [ID.solutions], []]);
  });

  it("stops at the ends of the ladder", () => {
    expect(reasonOf(testPackage({ difficulty: "basic" }), { action: "make_easier" })).toBe("at_easiest");
    expect(reasonOf(testPackage({ difficulty: "challenge" }), { action: "make_harder" })).toBe("at_hardest");
    expect(() => planAdjustment(testPackage({ difficulty: "basic" }), { action: "make_harder" })).not.toThrow();
    expect(() => planAdjustment(testPackage({ difficulty: "challenge" }), { action: "make_easier" })).not.toThrow();
  });

  it("uses the effective difficulty of an already adjusted package", () => {
    const pkg = structuredClone(testPackage({ difficulty: "mixed" }));
    pkg.sections.find((s) => s.kind === "exercises")!.provenance.difficulty = "challenge";
    expect(reasonOf(pkg, { action: "make_harder" })).toBe("at_hardest");
  });

  it("is inapplicable when the capability does not support the target level", () => {
    const pkg = structuredClone(testPackage({ difficulty: "mixed" }));
    const concept = (pkg.context as { concepts: { capability: { difficulties: string[] } }[] }).concepts[0]!;
    concept.capability.difficulties = ["basic", "mixed"];
    expect(reasonOf(pkg, { action: "make_harder" })).toBe("unsupported_difficulty");
    expect(() => planAdjustment(pkg, { action: "make_easier" })).not.toThrow();
  });

  it("add_exercises regenerates exercises and solutions; the outline stays", () => {
    const plan = planAdjustment(testPackage(), { action: "add_exercises", count: 3 });
    expect(plan).toMatchObject({ changed: [ID.exercises], dependents: [ID.solutions], rehashed: [], unchanged: without(ID.exercises, ID.solutions), outlineChanged: false });
  });

  it("add_exercises refuses to go beyond MAX_EXERCISES", () => {
    expect(MAX_EXERCISES).toBe(20);
    const pkg = testPackage(); // 60 minutes: 6 exercises
    expect(() => planAdjustment(pkg, { action: "add_exercises", count: 6 })).not.toThrow();
    const full = testPackage({ durationMinutes: 180 }); // 12 exercises
    expect(() => planAdjustment(full, { action: "add_exercises", count: 6 })).not.toThrow();
    const twelve = structuredClone(full);
    const ex = twelve.sections.find((s) => s.kind === "exercises")!;
    const q = ex.blocks.filter((b) => b.type !== "paragraph");
    (ex as { blocks: Section["blocks"] }).blocks = [ex.blocks[0]!, ...q, ...q.slice(0, 2 * 5)]; // 17 exercises
    expect(() => planAdjustment(twelve, { action: "add_exercises", count: 3 })).not.toThrow();
    expect(reasonOf(twelve, { action: "add_exercises", count: 4 })).toBe("max_exercises");
  });
});

describe("planAdjustment: worked examples", () => {
  it("add_worked_example regenerates only worked_examples", () => {
    const plan = planAdjustment(testPackage(), { action: "add_worked_example" });
    expect(plan).toMatchObject({ changed: [ID.examples], dependents: [], rehashed: [], unchanged: without(ID.examples), outlineChanged: false });
  });

  it("refuses at MAX_EXAMPLES unique-solution examples, not counting the no-solution one", () => {
    expect(MAX_EXAMPLES).toBe(4);
    const three = withExamples(testPackage(), 3);
    expect(() => planAdjustment(three, { action: "add_worked_example" })).not.toThrow();
    expect(reasonOf(withExamples(testPackage(), 4), { action: "add_worked_example" })).toBe("max_examples");
  });
});

describe("planAdjustment: change_duration", () => {
  it("refuses the same duration", () => {
    expect(reasonOf(testPackage({ durationMinutes: 60 }), { action: "change_duration", durationMinutes: 60 })).toBe("same_duration");
  });

  it("60 -> 90 regenerates exercises, solutions, worked examples and the teaching sequence", () => {
    const from = planOutline(60);
    const to = planOutline(90);
    expect([from.exerciseCount, to.exerciseCount, from.exampleCount, to.exampleCount]).toEqual([6, 8, 2, 3]);
    const plan = planAdjustment(testPackage({ durationMinutes: 60 }), { action: "change_duration", durationMinutes: 90 });
    expect(plan.changed).toEqual([ID.examples, ID.teaching, ID.exercises]);
    expect(plan.dependents).toEqual([ID.solutions]);
    // explanation minutes move (9 -> 14) so its inputsHash must be recomputed, its content stays.
    expect(plan.rehashed).toEqual([ID.explanation]);
    expect(plan.unchanged).toEqual(without(ID.examples, ID.teaching, ID.exercises, ID.solutions, ID.explanation));
    expect(plan.outlineChanged).toBe(true);
    expect(plan.sections.filter((s) => s.disposition === "regenerate").every((s) => s.method === "deterministic")).toBe(true);
  });

  it("keeps exercises when the count is unchanged but rehashes them for the moved minutes", () => {
    const pkg = testPackage({ durationMinutes: 60 });
    const to = planOutline(62);
    expect(to.exerciseCount).toBe(planOutline(60).exerciseCount);
    expect(to.exampleCount).toBe(planOutline(60).exampleCount);
    const plan = planAdjustment(pkg, { action: "change_duration", durationMinutes: 62 });
    expect(plan.changed).toEqual([ID.teaching]);
    expect(plan.dependents).toEqual([]);
    expect(plan.rehashed).toEqual(expect.arrayContaining([ID.exercises, ID.examples]));
    expect(plan.rehashed).not.toContain(ID.solutions);
    expect(plan.outlineChanged).toBe(true);
  });
});

describe("planAdjustment: correct_text", () => {
  const pkg = testPackage();

  it("an explanation paragraph: explanation changes, worked_examples is rehashed", () => {
    const plan = planAdjustment(pkg, correct(ID.explanation, { field: "block_text", blockIndex: 0 }));
    expect(plan).toMatchObject({ method: "deterministic", changed: [ID.explanation], dependents: [], rehashed: [ID.examples], unchanged: without(ID.explanation, ID.examples), outlineChanged: false });
    expect(plan.sections.find((s) => s.id === ID.explanation)).toEqual({ id: ID.explanation, disposition: "regenerate", method: "tutor_edit" });
    expect(plan.sections.find((s) => s.id === ID.examples)).toEqual({ id: ID.examples, disposition: "rehash", method: null });
  });

  it("the exercises intro: solutions are re-derived and compared later", () => {
    const plan = planAdjustment(pkg, correct(ID.exercises, { field: "block_text", blockIndex: 0 }));
    expect(plan).toMatchObject({ changed: [ID.exercises], dependents: [ID.solutions], rehashed: [], unchanged: without(ID.exercises, ID.solutions) });
    expect(plan.sections.find((s) => s.id === ID.exercises)!.method).toBe("tutor_edit");
  });

  it("an objectives intro paragraph rehashes everything that references objectives", () => {
    const plan = planAdjustment(pkg, correct(ID.objectives, { field: "block_text", blockIndex: 0 }));
    expect(plan.changed).toEqual([ID.objectives]);
    expect(plan.rehashed).toEqual([ID.explanation, ID.exercises]);
  });

  it("titles, list items and derivation steps are editable", () => {
    expect(planAdjustment(pkg, correct(ID.mistakes, { field: "title" })).changed).toEqual([ID.mistakes]);
    expect(planAdjustment(pkg, correct(ID.explanation, { field: "block_item", blockIndex: 2, itemIndex: 3 })).changed).toEqual([ID.explanation]);
    expect(planAdjustment(pkg, correct(ID.derivation, { field: "block_item", blockIndex: 0, itemIndex: 0 })).changed).toEqual([ID.derivation]);
  });

  it("several edits in one section list it once, in package order", () => {
    const plan = planAdjustment(pkg, {
      action: "correct_text",
      edits: [
        { sectionId: ID.solutions, target: { field: "title" }, text: "Answers" },
        { sectionId: ID.explanation, target: { field: "title" }, text: "Ideas" },
        { sectionId: ID.explanation, target: { field: "block_text", blockIndex: 0 }, text: "Words" },
      ],
    });
    expect(plan.changed).toEqual([ID.explanation, ID.solutions]);
  });

  it("refuses targets that are not editable", () => {
    const exercises = pkg.sections.find((s) => s.kind === "exercises")!;
    const questionIndex = exercises.blocks.findIndex((b) => b.type === "question");
    const writingIndex = exercises.blocks.findIndex((b) => b.type === "writing_space");
    const timingIndex = pkg.sections.find((s) => s.kind === "teaching_sequence")!.blocks.findIndex((b) => b.type === "timing");
    const solutionIndex = pkg.sections.find((s) => s.kind === "solutions")!.blocks.findIndex((b) => b.type === "solution");
    const exampleIndex = pkg.sections.find((s) => s.kind === "worked_examples")!.blocks.findIndex((b) => b.type === "worked_example");
    const cases: [string, Parameters<typeof correct>[1]][] = [
      [ID.exercises, { field: "block_text", blockIndex: questionIndex }],
      [ID.exercises, { field: "block_item", blockIndex: questionIndex, itemIndex: 0 }],
      [ID.exercises, { field: "block_text", blockIndex: writingIndex }],
      [ID.solutions, { field: "block_text", blockIndex: solutionIndex }],
      [ID.examples, { field: "block_text", blockIndex: exampleIndex }],
      [ID.objectives, { field: "block_item", blockIndex: 1, itemIndex: 0 }],
      [ID.prerequisites, { field: "block_item", blockIndex: 1, itemIndex: 0 }],
      [ID.alignment, { field: "block_text", blockIndex: 0 }],
      [ID.alignment, { field: "title" }],
      [ID.teaching, { field: "block_text", blockIndex: timingIndex }],
      [ID.teaching, { field: "block_item", blockIndex: timingIndex, itemIndex: 0 }],
    ];
    for (const [sectionId, target] of cases) expect(reasonOf(pkg, correct(sectionId, target)), `${sectionId} ${JSON.stringify(target)}`).toBe("not_editable");
  });

  it("refuses unknown sections, blocks and items", () => {
    expect(reasonOf(pkg, correct("sec-nope", { field: "title" }))).toBe("target_not_found");
    expect(reasonOf(pkg, correct(ID.explanation, { field: "block_text", blockIndex: 59 }))).toBe("target_not_found");
    expect(reasonOf(pkg, correct(ID.explanation, { field: "block_item", blockIndex: 2, itemIndex: 19 }))).toBe("target_not_found");
  });
});

describe("planAdjustment: reduce_theory", () => {
  it("is an llm adjustment: explanation and derivation regenerate, worked_examples is rehashed", () => {
    const plan = planAdjustment(testPackage(), { action: "reduce_theory" });
    expect(plan).toMatchObject({ method: "llm", changed: [ID.explanation, ID.derivation], dependents: [], rehashed: [ID.examples], unchanged: without(ID.explanation, ID.derivation, ID.examples) });
    expect(plan.sections.find((s) => s.id === ID.derivation)).toEqual({ id: ID.derivation, disposition: "regenerate", method: "llm" });
  });
});

describe("closures and purity", () => {
  const pkg = testPackage();

  it("derives closure follows derives edges only; references downstream is one reference hop", () => {
    expect(derivesClosure(pkg, [ID.exercises])).toEqual([ID.solutions]);
    expect(derivesClosure(pkg, [ID.objectives])).toEqual([]);
    expect(derivesClosure(pkg, [ID.solutions])).toEqual([]);
    expect(referencesDownstream(pkg, [ID.objectives])).toEqual([ID.exercises, ID.explanation]); // sorted by id
    expect(referencesDownstream(pkg, [ID.explanation])).toEqual([ID.examples]);
    expect(referencesDownstream(pkg, [ID.exercises])).toEqual([]);
  });

  it("never mutates the package", () => {
    const before = canonicalJson(pkg);
    const changes: AdjustmentChange[] = [
      { action: "make_harder" },
      { action: "make_easier" },
      { action: "add_exercises", count: 2 },
      { action: "add_worked_example" },
      { action: "change_duration", durationMinutes: 90 },
      correct(ID.explanation, { field: "block_text", blockIndex: 0 }),
      { action: "reduce_theory" },
    ];
    for (const change of changes) {
      planAdjustment(pkg, change);
      expect(canonicalJson(pkg)).toBe(before);
    }
    try {
      planAdjustment(pkg, { action: "change_duration", durationMinutes: 60 });
    } catch {
      /* expected */
    }
    expect(canonicalJson(pkg)).toBe(before);
  });
});
