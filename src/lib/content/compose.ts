import { generateExerciseSet, generateLinearQuestion, type GeneratedQuestion } from "@/lib/math/generator";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import type { ContentBlueprint } from "./blueprint-schema";
import { PackageBuildError } from "./errors";
import { legacyFamilyId, type FamilyId } from "./families";

/** The level worked examples are drawn at for a lesson difficulty: basic stays basic, anything else is the mixed set. */
export const exampleLevel = (difficulty: "basic" | "mixed" | "challenge"): "basic" | "mixed" => (difficulty === "basic" ? "basic" : "mixed");

/** The no-solution worked example a non-basic lesson ends its examples with; the equation depends on the seed only. */
export const degenerateExample = (seed: string, id: string): GeneratedQuestion =>
  generateLinearQuestion({ id, difficulty: "mixed", form: "ax+b=cx+d", outcome: "no_solution", seed: `${seed}:we-degenerate` });

const fingerprint = (q: GeneratedQuestion) => JSON.stringify(q.problem.equation);

export interface ComposedLesson {
  examples: GeneratedQuestion[];
  exercises: GeneratedQuestion[];
  /** One entry per exercise, in order: which family produced it. */
  slots: { position: number; part: string; familyId: FamilyId; questionId: string }[];
}

export interface ComposeOptions {
  exampleCount: number;
  exerciseCount: number;
  /** End the examples with the no-solution example (the caller decides from the concept's capability). */
  noSolutionExample: boolean;
}

/**
 * The questions of a lesson. For a legacy blueprint this is exactly the draw buildPackage always did: same seeds, same
 * retry rule, equations never repeated between examples and exercises, deterministic and bounded.
 */
export function composeLesson(bp: ContentBlueprint, req: Pick<LessonRequestV2, "difficulty">, seed: string, opts: ComposeOptions): ComposedLesson {
  if (bp.drawing !== "legacy") throw new PackageBuildError("this blueprint cannot be composed yet");
  const examples = generateExerciseSet({ jobSeed: `${seed}:examples`, count: opts.exampleCount, difficulty: exampleLevel(req.difficulty), idPrefix: "we" });
  if (opts.noSolutionExample) examples.push(degenerateExample(seed, `we-${examples.length + 1}`));
  const taken = new Set(examples.map(fingerprint));
  for (let attempt = 0; attempt < 20; attempt++) {
    const exercises = generateExerciseSet({ jobSeed: `${seed}:exercises:${attempt}`, count: opts.exerciseCount, difficulty: req.difficulty, idPrefix: "ex" });
    if (exercises.every((q) => !taken.has(fingerprint(q)))) {
      const slots = exercises.map((q, i) => ({ position: i + 1, part: "all", familyId: legacyFamilyId(q.meta), questionId: q.id }));
      return { examples, exercises, slots };
    }
  }
  throw new PackageBuildError("could not draw exercises that differ from the worked examples");
}
