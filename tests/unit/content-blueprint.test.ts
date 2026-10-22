import { describe, expect, it } from "vitest";
import { BlueprintSchema } from "@/lib/content/blueprint-schema";
import { LINEAR_GENERAL } from "@/lib/content/blueprints/linear-general";
import { composeLesson } from "@/lib/content/compose";
import { LEGACY_FAMILIES, legacyFamilyId } from "@/lib/content/families";
import { LINEAR_SKILLS, SKILL_LABELS } from "@/lib/content/skills";
import { chooseBasic, chooseChallenge, chooseDegenerate, chooseMixed, generateExerciseSet, generateLinearQuestion } from "@/lib/math/generator";
import { Rng } from "@/lib/math/rng";
import { buildPackage, degenerateExample, exampleLevel, planOutline } from "@/lib/package/build";
import { checkText, curriculumNames } from "@/lib/package/prose-rules";
import { testContext, testRequest } from "../fixtures/package";

const DIFFICULTIES = ["basic", "mixed", "challenge"] as const;

/** The draw buildPackage made before the extraction, kept here verbatim as the reference. */
function directDraw(seed: string, difficulty: (typeof DIFFICULTIES)[number], exampleCount: number, exerciseCount: number, degenerate: boolean) {
  const examples = generateExerciseSet({ jobSeed: `${seed}:examples`, count: exampleCount, difficulty: exampleLevel(difficulty), idPrefix: "we" });
  if (degenerate) examples.push(degenerateExample(seed, `we-${examples.length + 1}`));
  const taken = new Set(examples.map((q) => JSON.stringify(q.problem.equation)));
  for (let attempt = 0; attempt < 20; attempt++) {
    const exercises = generateExerciseSet({ jobSeed: `${seed}:exercises:${attempt}`, count: exerciseCount, difficulty, idPrefix: "ex" });
    if (exercises.every((q) => !taken.has(JSON.stringify(q.problem.equation)))) return { examples, exercises };
  }
  throw new Error("exhausted");
}

describe("BlueprintSchema", () => {
  it("validates linear.general@1", () => {
    expect(BlueprintSchema.safeParse(LINEAR_GENERAL).success).toBe(true);
    expect(`${LINEAR_GENERAL.id}@${LINEAR_GENERAL.version}`).toBe("linear.general@1");
  });

  it("is strict", () => {
    expect(BlueprintSchema.safeParse({ ...LINEAR_GENERAL, extra: 1 }).success).toBe(false);
    expect(BlueprintSchema.safeParse({ ...LINEAR_GENERAL, skills: [] }).success).toBe(false);
    expect(BlueprintSchema.safeParse({ ...LINEAR_GENERAL, skills: ["nope"] }).success).toBe(false);
  });

  it("holds wording that passes the prose rules", () => {
    const names = curriculumNames(testContext());
    const p = LINEAR_GENERAL.prose;
    const texts = [...p.explanation.flatMap((b) => (b.type === "paragraph" ? [b.text] : b.items)), ...p.derivation, p.exampleIntro, ...p.teachingSequence, ...p.commonMistakes];
    for (const t of texts) expect(checkText(t, names), t).toEqual([]);
  });

  it("byte-equals the wording buildPackage used before", () => {
    expect(LINEAR_GENERAL.prose).toEqual({
      explanation: [
        { type: "paragraph", text: "An equation says that two expressions have the same value. Solving it means finding the value of the unknown that makes the statement true." },
        { type: "paragraph", text: "Whatever is done to one side of an equation must also be done to the other side, so that the two sides stay equal." },
        { type: "list", items: ["Undo addition and subtraction first, using the opposite operation on both sides.", "Then undo multiplication or division, again on both sides.", "When the unknown appears on both sides, collect the unknown terms on one side first.", "Always check the answer by substituting it back into the original equation."] },
      ],
      derivation: [
        "Start from an equation that is true for some value of the unknown.",
        "Applying the same operation to both sides keeps the two sides equal, so the new equation has the same solution.",
        "Each operation is chosen to remove one term or factor next to the unknown.",
        "Repeat until the unknown stands alone; the other side then shows its value.",
      ],
      exampleIntro: "Work through each example with the learner, asking them to name the next step before it is shown.",
      teachingSequence: ["Recall earlier work and state the goal of the lesson.", "Introduce the key ideas and the method.", "Work through the examples together.", "Let the learner attempt the exercises, giving help only when asked.", "Review mistakes and summarize."],
      commonMistakes: [
        "Changing only one side of the equation.",
        "Forgetting that a negative sign belongs to the term that follows it.",
        "Adding when the opposite operation is needed.",
        "Dividing only part of one side by the coefficient.",
        "Skipping the check by substitution.",
      ],
    });
  });

  it("is not mutated by building packages", () => {
    const before = JSON.stringify(LINEAR_GENERAL);
    const pkg = buildPackage({ request: testRequest(), context: testContext(), seed: "s" });
    (pkg.sections.find((s) => s.kind === "teaching_sequence")!.blocks[0] as { items: string[] }).items.push("x");
    expect(JSON.stringify(LINEAR_GENERAL)).toBe(before);
  });
});

describe("skills", () => {
  it("labels every skill, without digits, in wording that passes the prose rules", () => {
    const names = curriculumNames(testContext());
    expect(Object.keys(SKILL_LABELS).sort()).toEqual([...LINEAR_SKILLS].sort());
    for (const label of Object.values(SKILL_LABELS)) {
      expect(label).not.toMatch(/\d/);
      expect(checkText(label, names), label).toEqual([]);
    }
  });
});

describe("composeLesson (general blueprint)", () => {
  for (const difficulty of DIFFICULTIES)
    for (const durationMinutes of [15, 45, 120])
      for (const seed of ["a", "lesson-17", "m0-seed-3"]) {
        it(`equals the previous direct draw for ${difficulty}/${durationMinutes}/${seed}`, () => {
          const plan = planOutline(durationMinutes);
          const degenerate = difficulty !== "basic";
          const want = directDraw(seed, difficulty, plan.exampleCount, plan.exerciseCount, degenerate);
          const got = composeLesson(LINEAR_GENERAL, { difficulty }, seed, { exampleCount: plan.exampleCount, exerciseCount: plan.exerciseCount, noSolutionExample: degenerate });
          expect(got.examples).toEqual(want.examples);
          expect(got.exercises).toEqual(want.exercises);
          expect(got.slots.map((s) => s.questionId)).toEqual(want.exercises.map((q) => q.id));
          expect(got.slots.map((s) => s.position)).toEqual(want.exercises.map((_, i) => i + 1));
        });
      }
});

describe("legacy families", () => {
  it("draw the same parameters the generator chooses", () => {
    const byId = new Map(LEGACY_FAMILIES.map((f) => [f.id, f]));
    const strings = (c: { params: Record<string, { toString(): string }> }) => Object.fromEntries(Object.entries(c.params).map(([k, v]) => [k, v.toString()]));
    for (const n of ["x", "y", "z"]) {
      const rng = () => new Rng(`legacy|${n}`);
      expect(byId.get("legacy.basic@1")!.draw(rng())).toEqual(strings(chooseBasic(rng())));
      expect(byId.get("legacy.mixed.one-sided@1")!.draw(rng())).toEqual(strings(chooseMixed(rng(), "ax+b=c")));
      expect(byId.get("legacy.mixed.two-sided@1")!.draw(rng())).toEqual(strings(chooseMixed(rng(), "ax+b=cx+d")));
      expect(byId.get("legacy.challenge.one-sided@1")!.draw(rng())).toEqual(strings(chooseChallenge(rng(), "ax+b=c")));
      expect(byId.get("legacy.challenge.two-sided@1")!.draw(rng())).toEqual(strings(chooseChallenge(rng(), "ax+b=cx+d")));
      expect(byId.get("legacy.degenerate@1")!.draw(rng())).toEqual(strings(chooseDegenerate(rng(), "no_solution")));
    }
  });

  it("name an existing family for every generated question", () => {
    const ids = new Set(LEGACY_FAMILIES.map((f) => f.id));
    for (const difficulty of DIFFICULTIES)
      for (const q of generateExerciseSet({ jobSeed: "fam", count: 9, difficulty })) expect(ids.has(legacyFamilyId(q.meta)), q.id).toBe(true);
    expect(ids.has(legacyFamilyId(generateLinearQuestion({ id: "d", difficulty: "mixed", form: "ax+b=cx+d", outcome: "no_solution", seed: "d" }).meta))).toBe(true);
  });
});
