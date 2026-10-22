import { learningObjectiveItems, type CurriculumContext } from "@/lib/curriculum/context";
import { DomainError } from "@/lib/domain/errors";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { GENERATOR_VERSION, generateExerciseSet, generateLinearQuestion, type GeneratedQuestion } from "@/lib/math/generator";
import { sectionContentHash, sectionInputsHash } from "./hash";
import { PROSE_PROMPT_VERSION, type ProseDraft } from "./prose";
import {
  PACKAGE_SCHEMA_VERSION,
  DOCUMENT_SECTION_KINDS,
  SECTION_KINDS,
  type LessonPackage,
  type Section,
  type SectionKind,
} from "./schema";

/** The one concept the engine can generate for today (docs/curriculum-architecture.md section 3). */
export const LINEAR_CONCEPT_ID = "linear-equations-one-variable";

export class PackageBuildError extends DomainError {
  constructor(message: string) {
    super("PACKAGE_BUILD_FAILED", message);
  }
}

export interface BuildInput {
  request: LessonRequestV2;
  context: CurriculumContext;
  /** Same seed, same request and context: byte-identical package. The pipeline uses the lesson id. */
  seed: string;
  /**
   * Model-written wording that already passed the prose rules. Without it the templated wording is used, so the
   * model can only ever improve the words of a package that is complete and verified without it.
   */
  prose?: { draft: ProseDraft; model: string | null };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Minutes per section; always sums to the requested duration. */
export function planOutline(totalMinutes: number) {
  const explanation = Math.round(totalMinutes * 0.15);
  const examples = Math.round(totalMinutes * 0.25);
  const review = Math.round(totalMinutes * 0.1);
  const exercises = totalMinutes - explanation - examples - review;
  const exerciseCount = clamp(Math.floor(exercises / 5), 3, 12);
  const exampleCount = clamp(Math.floor(totalMinutes / 30), 1, 3);
  return { explanation, examples, review, exercises, exerciseCount, exampleCount };
}

export type OutlinePlan = ReturnType<typeof planOutline>;

/** The minutes the outline gives a section of this kind (the four timed sections; every other kind gets 0). */
export function sectionMinutes(kind: SectionKind, plan: OutlinePlan): number {
  switch (kind) {
    case "explanation":
      return plan.explanation;
    case "worked_examples":
      return plan.examples;
    case "teaching_sequence":
      return plan.review;
    case "exercises":
      return plan.exercises;
    default:
      return 0;
  }
}

/** The teaching sequence's timing block for an outline plan. */
export function timingBlock(plan: OutlinePlan): Extract<Section["blocks"][number], { type: "timing" }> {
  return {
    type: "timing",
    items: [
      { label: "Key ideas", minutes: Math.max(1, plan.explanation) },
      { label: "Worked examples", minutes: Math.max(1, plan.examples) },
      { label: "Exercises", minutes: Math.max(1, plan.exercises) },
      { label: "Review", minutes: Math.max(1, plan.review) },
    ],
  };
}

/** The level worked examples are drawn at for a lesson difficulty: basic stays basic, anything else is the mixed set. */
export const exampleLevel = (difficulty: "basic" | "mixed" | "challenge"): "basic" | "mixed" => (difficulty === "basic" ? "basic" : "mixed");

/** The no-solution worked example a non-basic lesson ends its examples with; the equation depends on the seed only. */
export const degenerateExample = (seed: string, id: string): GeneratedQuestion =>
  generateLinearQuestion({ id, difficulty: "mixed", form: "ax+b=cx+d", outcome: "no_solution", seed: `${seed}:we-degenerate` });

/** A worked example block for a generated question. */
export const workedExampleBlock = (q: GeneratedQuestion) => ({ type: "worked_example" as const, questionId: q.id, problem: q.problem, solution: q.solution, steps: q.steps });

/** The note that follows the no-solution example (it must stay the last example). */
export const NO_SOLUTION_NOTE = "The last example has no solution. Discuss why the unknown disappears and what that tells us.";

const fingerprint = (q: GeneratedQuestion) => JSON.stringify(q.problem.equation);

/** Examples and exercises never repeat an equation; the draw is deterministic and bounded. */
function drawQuestions(seed: string, difficulty: "basic" | "mixed" | "challenge", exampleCount: number, exerciseCount: number, withDegenerateExample: boolean) {
  const examples = generateExerciseSet({ jobSeed: `${seed}:examples`, count: exampleCount, difficulty: exampleLevel(difficulty), idPrefix: "we" });
  if (withDegenerateExample) examples.push(degenerateExample(seed, `we-${examples.length + 1}`));
  const taken = new Set(examples.map(fingerprint));
  for (let attempt = 0; attempt < 20; attempt++) {
    const exercises = generateExerciseSet({ jobSeed: `${seed}:exercises:${attempt}`, count: exerciseCount, difficulty, idPrefix: "ex" });
    if (exercises.every((q) => !taken.has(fingerprint(q)))) return { examples, exercises };
  }
  throw new PackageBuildError("could not draw exercises that differ from the worked examples");
}

type Draft = { kind: SectionKind; title: string; blocks: Section["blocks"]; method: "deterministic" | "llm"; model?: string; minutes: number; params: Record<string, unknown> };

/** Edges: `from` is upstream of `to`. Solutions are a pure function of the exercises, so they always travel together. */
export const EDGES = [
  { from: "objectives", to: "explanation", kind: "references" },
  { from: "objectives", to: "exercises", kind: "references" },
  { from: "explanation", to: "worked_examples", kind: "references" },
  { from: "exercises", to: "solutions", kind: "derives" },
] as const satisfies readonly { from: SectionKind; to: SectionKind; kind: "derives" | "references" }[];

export interface InputsParamsArgs {
  seed: string;
  difficulty: "basic" | "mixed" | "challenge";
  exampleCount: number;
  exerciseCount: number;
  /** Set when the section's wording was model-written. */
  llm: { promptVersion: string; model: string | null } | null;
}

/**
 * The parameters a section was made from, other than the context hash, its minutes and its upstream sections.
 * The builder hashes them into `inputsHash`; the validator rebuilds them from the stored package to verify it.
 */
export function sectionInputsParams(kind: SectionKind, a: InputsParamsArgs): Record<string, unknown> {
  const llm: Record<string, unknown> = a.llm ? { promptVersion: a.llm.promptVersion, model: a.llm.model } : {};
  switch (kind) {
    case "worked_examples":
      return { seed: a.seed, exampleCount: a.exampleCount, difficulty: a.difficulty, generatorVersion: GENERATOR_VERSION, ...llm };
    case "exercises":
    case "solutions":
      return { seed: a.seed, exerciseCount: a.exerciseCount, difficulty: a.difficulty, generatorVersion: GENERATOR_VERSION };
    case "explanation":
    case "derivation":
    case "teaching_sequence":
    case "common_mistakes":
      return llm;
    case "objectives":
    case "prerequisites":
    case "alignment":
      return {};
  }
}

/** The one title an alignment section may carry (the validator requires it verbatim). */
export const ALIGNMENT_TITLE = "Curriculum information";

export const sectionId = (kind: SectionKind) => `sec-${kind.replace("_", "-")}`;

export function buildPackage({ request, context, seed, prose }: BuildInput): LessonPackage {
  const concept = context.concepts.find((c) => c.id === LINEAR_CONCEPT_ID);
  if (!concept) throw new PackageBuildError("the selected topic has no concept the engine can generate");
  if (!concept.capability.difficulties.includes(request.difficulty)) throw new PackageBuildError("the engine does not support this difficulty for the selected concept");

  const plan = planOutline(request.durationMinutes);
  const wantDegenerate = request.difficulty !== "basic" && concept.capability.outcomes.includes("no_solution");
  const { examples, exercises } = drawQuestions(seed, request.difficulty, plan.exampleCount, plan.exerciseCount, wantDegenerate);

  // Sections whose words the model wrote say so; the rest of the package is identical with or without it.
  const llmMeta = prose ? ({ method: "llm", ...(prose.model ? { model: prose.model } : {}) } as const) : ({ method: "deterministic" } as const);
  const paramsOf = (kind: SectionKind) =>
    sectionInputsParams(kind, { seed, difficulty: request.difficulty, exampleCount: examples.length, exerciseCount: exercises.length, llm: prose ? { promptVersion: PROSE_PROMPT_VERSION, model: prose.model } : null });

  const drafts: Draft[] = [
    {
      kind: "objectives",
      title: "Learning objectives",
      blocks: [
        { type: "paragraph", text: "By the end of this lesson the learner should be able to work towards the following objectives." },
        { type: "list", items: learningObjectiveItems(context) },
      ],
      method: "deterministic",
      minutes: 0,
      params: paramsOf("objectives"),
    },
    {
      kind: "prerequisites",
      title: "Prerequisites",
      blocks:
        context.prerequisites.length === 0
          ? [{ type: "paragraph", text: "No earlier topics are listed as prerequisites for this topic in the selected dataset." }]
          : [
              { type: "paragraph", text: "Check that the learner is comfortable with the following earlier topics before starting." },
              { type: "list", items: context.prerequisites.map((p) => p.title) },
            ],
      method: "deterministic",
      minutes: 0,
      params: paramsOf("prerequisites"),
    },
    {
      kind: "explanation",
      title: "Key ideas",
      blocks: prose
        ? prose.draft.explanation.map((text) => ({ type: "paragraph" as const, text }))
        : [
            { type: "paragraph", text: "An equation says that two expressions have the same value. Solving it means finding the value of the unknown that makes the statement true." },
            { type: "paragraph", text: "Whatever is done to one side of an equation must also be done to the other side, so that the two sides stay equal." },
            { type: "list", items: ["Undo addition and subtraction first, using the opposite operation on both sides.", "Then undo multiplication or division, again on both sides.", "When the unknown appears on both sides, collect the unknown terms on one side first.", "Always check the answer by substituting it back into the original equation."] },
          ],
      ...llmMeta,
      minutes: sectionMinutes("explanation", plan),
      params: paramsOf("explanation"),
    },
    {
      kind: "derivation",
      title: "Why the method works",
      blocks: [
        {
          type: "step_list",
          steps: prose
            ? prose.draft.derivation
            : [
                "Start from an equation that is true for some value of the unknown.",
                "Applying the same operation to both sides keeps the two sides equal, so the new equation has the same solution.",
                "Each operation is chosen to remove one term or factor next to the unknown.",
                "Repeat until the unknown stands alone; the other side then shows its value.",
              ],
        },
      ],
      ...llmMeta,
      minutes: 0,
      params: paramsOf("derivation"),
    },
    {
      kind: "worked_examples",
      title: "Worked examples",
      blocks: [
        { type: "paragraph", text: prose ? prose.draft.exampleIntro : "Work through each example with the learner, asking them to name the next step before it is shown." },
        ...examples.map(workedExampleBlock),
        ...(wantDegenerate ? [{ type: "note" as const, text: NO_SOLUTION_NOTE }] : []),
      ],
      ...llmMeta,
      minutes: sectionMinutes("worked_examples", plan),
      params: paramsOf("worked_examples"),
    },
    {
      kind: "teaching_sequence",
      title: "Teaching sequence",
      blocks: [
        { type: "list", items: prose ? prose.draft.teachingSequence : ["Recall earlier work and state the goal of the lesson.", "Introduce the key ideas and the method.", "Work through the examples together.", "Let the learner attempt the exercises, giving help only when asked.", "Review mistakes and summarize."] },
        timingBlock(plan),
      ],
      ...llmMeta,
      minutes: sectionMinutes("teaching_sequence", plan),
      params: paramsOf("teaching_sequence"),
    },
    {
      kind: "common_mistakes",
      title: "Common mistakes",
      blocks: [
        {
          type: "list",
          items: prose
            ? prose.draft.commonMistakes
            : [
                "Changing only one side of the equation.",
                "Forgetting that a negative sign belongs to the term that follows it.",
                "Adding when the opposite operation is needed.",
                "Dividing only part of one side by the coefficient.",
                "Skipping the check by substitution.",
              ],
        },
      ],
      ...llmMeta,
      minutes: 0,
      params: paramsOf("common_mistakes"),
    },
    {
      kind: "exercises",
      title: "Practice exercises",
      blocks: [
        { type: "paragraph", text: "Solve each equation. Show every step in the space provided." },
        ...exercises.flatMap((q) => [
          { type: "question" as const, questionId: q.id, problem: q.problem },
          { type: "writing_space" as const, lines: 4 },
        ]),
      ],
      method: "deterministic",
      minutes: sectionMinutes("exercises", plan),
      params: paramsOf("exercises"),
    },
    {
      kind: "solutions",
      title: "Solutions",
      blocks: [
        { type: "paragraph", text: "Worked solutions for every exercise, in the same order." },
        ...exercises.map((q) => ({ type: "solution" as const, questionId: q.id, solution: q.solution, steps: q.steps })),
      ],
      method: "deterministic",
      minutes: 0,
      params: paramsOf("solutions"),
    },
    {
      kind: "alignment",
      title: ALIGNMENT_TITLE,
      blocks: [
        {
          type: "alignment",
          claim: context.alignmentClaimsAllowed ? "aligned" : "none",
          curriculumName: context.curriculum.name,
          versionLabel: context.curriculum.version.label,
          datasetKind: context.curriculum.version.kind,
          objectives: context.objectives.map((o) => ({ id: o.id, officialCode: o.officialCode, label: o.label, coverage: o.coverage, note: o.note })),
        },
      ],
      method: "deterministic",
      minutes: 0,
      params: paramsOf("alignment"),
    },
  ];

  // Hashes in dependency order: a section's inputsHash includes the contentHash of its upstream sections.
  const sections: Section[] = [];
  const contentHashes = new Map<SectionKind, string>();
  for (const draft of drafts) {
    const upstream = EDGES.filter((e) => e.to === draft.kind).map((e) => {
      const hash = contentHashes.get(e.from);
      if (!hash) throw new PackageBuildError(`section order is wrong: ${e.from} must be built before ${draft.kind}`);
      return hash;
    });
    const withoutHashes = { kind: draft.kind, title: draft.title, blocks: draft.blocks } as Pick<Section, "kind" | "title" | "blocks">;
    const contentHash = sectionContentHash(withoutHashes);
    contentHashes.set(draft.kind, contentHash);
    sections.push({
      ...withoutHashes,
      id: sectionId(draft.kind),
      provenance: {
        method: draft.method,
        ...(draft.params.seed ? { seed: String(draft.params.seed), generatorVersion: GENERATOR_VERSION } : {}),
        ...(draft.method === "llm" ? { promptVersion: PROSE_PROMPT_VERSION, ...(draft.model ? { model: draft.model } : {}) } : {}),
      },
      inputsHash: sectionInputsHash({ kind: draft.kind, params: { ...draft.params, contextHash: context.contextHash, minutes: draft.minutes }, upstreamContentHashes: upstream }),
      contentHash,
    } as Section);
  }

  const objectiveIds = context.objectives.map((o) => o.id);
  return {
    schemaVersion: PACKAGE_SCHEMA_VERSION,
    request,
    context,
    seed,
    outline: {
      totalMinutes: request.durationMinutes,
      sections: drafts.map((d) => ({ id: sectionId(d.kind), kind: d.kind, minutes: d.minutes, objectiveIds })),
    },
    sections,
    documents: request.documents.map((id) => ({
      id,
      sectionIds: DOCUMENT_SECTION_KINDS[id].map((kind) => sectionId(kind)),
      templateId: request.templateId,
    })),
    deps: EDGES.map((e) => ({ from: sectionId(e.from), to: sectionId(e.to), kind: e.kind })),
  };
}

/** Every section a change to `id` forces to be regenerated: the transitive closure of the edges, excluding `id` itself. */
export function dependentsOf(pkg: Pick<LessonPackage, "deps">, id: string): string[] {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of pkg.deps) {
      if (edge.from === current && !out.has(edge.to)) {
        out.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  out.delete(id);
  return [...out].sort();
}

export { SECTION_KINDS };
