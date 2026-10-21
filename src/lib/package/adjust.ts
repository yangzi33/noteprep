import type { CurriculumContext } from "@/lib/curriculum/context";
import { methodOf, type AdjustmentChange, type AdjustmentMethod, type TextEdit } from "@/lib/domain/adjustment";
import { AdjustmentNotApplicable } from "@/lib/domain/errors";
import { canonicalJson, sha256Hex } from "@/lib/domain/hash";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { DRAW_EXHAUSTED, GENERATOR_VERSION, generateExerciseSet, questionFingerprint, type Difficulty, type GeneratedQuestion } from "@/lib/math/generator";
import { LINEAR_CONCEPT_ID, planOutline } from "./build";
import { effectiveSettings } from "./effective";
import { rehashPackage } from "./inputs";
import type { ExercisesSection, LessonPackage, Section, SectionKind, SolutionsSection } from "./schema";

/** Most exercises a package may hold (the block cap is 60 and each exercise takes two blocks: 1 + 2n <= 60). */
export const MAX_EXERCISES = 20;
/** Most unique-solution worked examples a package may hold. */
export const MAX_EXAMPLES = 4;

/** unchanged: the whole section is kept; rehash: only inputsHash is recomputed; regenerate: the section is rebuilt. */
export type Disposition = "unchanged" | "rehash" | "regenerate";

export interface AdjustmentPlan {
  action: AdjustmentChange["action"];
  method: AdjustmentMethod;
  /** Every section of the package, in package order. `method` is null unless the section is regenerated. */
  sections: { id: string; disposition: Disposition; method: "deterministic" | "llm" | "tutor_edit" | null }[];
  /** Sections the change edits or regenerates directly. */
  changed: string[];
  /** Sections regenerated or re-derived only because they derive from a changed section. */
  dependents: string[];
  /** Sections whose readable content stays identical but whose inputsHash must be recomputed. */
  rehashed: string[];
  unchanged: string[];
  outlineChanged: boolean;
}

type Deps = Pick<LessonPackage, "deps">;

/** Sections that derive (transitively, over `derives` edges only) from `ids`, excluding `ids` themselves. */
export function derivesClosure(pkg: Deps, ids: readonly string[]): string[] {
  const start = new Set(ids);
  const out = new Set<string>();
  const queue = [...ids];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of pkg.deps) {
      if (edge.kind === "derives" && edge.from === current && !out.has(edge.to)) {
        out.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  for (const id of start) out.delete(id);
  return [...out].sort();
}

/**
 * Sections one `references` edge downstream of `ids`, excluding `ids` themselves. A reference only reads the upstream
 * contentHash, so these sections keep their content and need a rehash, never a regeneration.
 */
export function referencesDownstream(pkg: Deps, ids: readonly string[]): string[] {
  const from = new Set(ids);
  const out = new Set<string>();
  for (const edge of pkg.deps) if (edge.kind === "references" && from.has(edge.from)) out.add(edge.to);
  for (const id of from) out.delete(id);
  return [...out].sort();
}

const notApplicable = (reason: string): never => {
  throw new AdjustmentNotApplicable(reason);
};

const LADDER: readonly Difficulty[] = ["basic", "mixed", "challenge"];

function idOf(pkg: LessonPackage, kind: SectionKind): string {
  const section = pkg.sections.find((s) => s.kind === kind);
  if (!section) return notApplicable("target_not_found");
  return section.id;
}

const countBlocks = (pkg: LessonPackage, kind: SectionKind, pred: (b: Section["blocks"][number]) => boolean) =>
  pkg.sections.filter((s) => s.kind === kind).reduce((n, s) => n + (s.blocks as Section["blocks"]).filter(pred).length, 0);

const uniqueExamples = (pkg: LessonPackage) =>
  countBlocks(pkg, "worked_examples", (b) => b.type === "worked_example" && b.solution.kind === "unique");
const exerciseCount = (pkg: LessonPackage) => countBlocks(pkg, "exercises", (b) => b.type === "question");

/** Is `edit` allowed on this package? Throws `target_not_found` or `not_editable` (plan section 2.6). */
function checkEditTarget(pkg: LessonPackage, edit: TextEdit): void {
  const section = pkg.sections.find((s) => s.id === edit.sectionId);
  if (!section) return notApplicable("target_not_found");
  const { target } = edit;
  if (target.field === "title") {
    if (section.kind === "alignment") notApplicable("not_editable");
    return;
  }
  const block = (section.blocks as Section["blocks"])[target.blockIndex];
  if (!block) return notApplicable("target_not_found");
  if (target.field === "block_text") {
    if (block.type !== "paragraph" && block.type !== "note") notApplicable("not_editable");
    return;
  }
  // block_item: only the lists and step lists that hold prose; the dataset's objective and prerequisite lists are fixed.
  if (block.type !== "list" && block.type !== "step_list") return notApplicable("not_editable");
  if (section.kind === "objectives" || section.kind === "prerequisites") return notApplicable("not_editable");
  const items = block.type === "list" ? block.items : block.steps;
  if (target.itemIndex >= items.length) notApplicable("target_not_found");
}

const NEW_MINUTES_KEYS: Partial<Record<SectionKind, "explanation" | "examples" | "review" | "exercises">> = {
  explanation: "explanation",
  worked_examples: "examples",
  teaching_sequence: "review",
  exercises: "exercises",
};

interface Draft {
  changed: string[];
  changedMethod: "deterministic" | "llm" | "tutor_edit";
  rehash?: string[];
  outlineChanged?: boolean;
}

/**
 * What an adjustment would touch, without touching anything. Pure: the package is never modified. Regeneration follows
 * only the `derives` closure; `references` downstream sections are rehashed (plan section 1.5 item 10).
 */
export function planAdjustment(pkg: LessonPackage, change: AdjustmentChange): AdjustmentPlan {
  const draft = draftFor(pkg, change);
  const changed = new Set(draft.changed);
  const dependents = new Set(derivesClosure(pkg, draft.changed).filter((id) => !changed.has(id)));
  const rehash = new Set((draft.rehash ?? referencesDownstream(pkg, draft.changed)).filter((id) => !changed.has(id) && !dependents.has(id)));

  const sections = pkg.sections.map((s) => {
    if (changed.has(s.id)) return { id: s.id, disposition: "regenerate" as const, method: draft.changedMethod };
    if (dependents.has(s.id)) return { id: s.id, disposition: "regenerate" as const, method: "deterministic" as const };
    if (rehash.has(s.id)) return { id: s.id, disposition: "rehash" as const, method: null };
    return { id: s.id, disposition: "unchanged" as const, method: null };
  });
  const ids = (d: Disposition, pred: (id: string) => boolean = () => true) => sections.filter((s) => s.disposition === d && pred(s.id)).map((s) => s.id);
  return {
    action: change.action,
    method: methodOf(change),
    sections,
    changed: sections.filter((s) => changed.has(s.id)).map((s) => s.id),
    dependents: ids("regenerate", (id) => dependents.has(id)),
    rehashed: ids("rehash"),
    unchanged: ids("unchanged"),
    outlineChanged: draft.outlineChanged ?? false,
  };
}

function draftFor(pkg: LessonPackage, change: AdjustmentChange): Draft {
  switch (change.action) {
    case "make_easier":
    case "make_harder": {
      const current = effectiveSettings(pkg).difficulty;
      const index = LADDER.indexOf(current);
      const harder = change.action === "make_harder";
      if (harder && index >= LADDER.length - 1) notApplicable("at_hardest");
      if (!harder && index <= 0) notApplicable("at_easiest");
      const target = LADDER[index + (harder ? 1 : -1)]!;
      const concept = (pkg.context as CurriculumContext).concepts?.find((c) => c.id === LINEAR_CONCEPT_ID);
      if (!concept || !concept.capability.difficulties.includes(target)) notApplicable("unsupported_difficulty");
      return { changed: [idOf(pkg, "exercises")], changedMethod: "deterministic" };
    }
    case "add_exercises": {
      const total = exerciseCount(pkg) + change.count;
      if (total > MAX_EXERCISES || 1 + 2 * total > 60) notApplicable("max_exercises");
      return { changed: [idOf(pkg, "exercises")], changedMethod: "deterministic" };
    }
    case "add_worked_example": {
      if (uniqueExamples(pkg) >= MAX_EXAMPLES) notApplicable("max_examples");
      return { changed: [idOf(pkg, "worked_examples")], changedMethod: "deterministic" };
    }
    case "change_duration": {
      if (change.durationMinutes === pkg.outline.totalMinutes) notApplicable("same_duration");
      const next = planOutline(change.durationMinutes);
      const changed: SectionKind[] = [];
      if (next.exerciseCount !== exerciseCount(pkg)) changed.push("exercises");
      if (next.exampleCount !== uniqueExamples(pkg)) changed.push("worked_examples");
      changed.push("teaching_sequence");
      // A section that is not rebuilt but whose minutes moved has a different inputsHash (minutes are hashed in).
      const regenerated = new Set<string>(changed.map((k) => idOf(pkg, k)));
      const rehash = pkg.outline.sections
        .filter((o) => {
          const key = NEW_MINUTES_KEYS[o.kind];
          return !regenerated.has(o.id) && o.minutes !== (key ? next[key] : 0);
        })
        .map((o) => o.id);
      return { changed: changed.map((k) => idOf(pkg, k)), changedMethod: "deterministic", rehash, outlineChanged: true };
    }
    case "correct_text": {
      for (const edit of change.edits) checkEditTarget(pkg, edit);
      const edited = new Set(change.edits.map((e) => e.sectionId));
      return { changed: pkg.sections.filter((s) => edited.has(s.id)).map((s) => s.id), changedMethod: "tutor_edit" };
    }
    case "reduce_theory":
      return { changed: [idOf(pkg, "explanation"), idOf(pkg, "derivation")], changedMethod: "llm" };
  }
}

// --- applying an adjustment ------------------------------------------------------------------------------

/** The changes `applyAdjustment` executes (correct_text has its own path, reduce_theory needs the model). */
export type ApplicableChange = Exclude<AdjustmentChange, { action: "correct_text" | "reduce_theory" }>;

/** The content hash of a revision holding this package: sha256 of its canonical JSON (as the worker stores it). */
export function packageContentHash(pkg: LessonPackage): string {
  return `sha256:${sha256Hex(canonicalJson(pkg))}`;
}

/**
 * The seed for one adjustment: derived from the source revision's content hash and the canonical change, so a retried
 * job regenerates byte-identical questions and another source (or another change) gets other questions.
 */
export function adjustmentSeed(pkg: LessonPackage, sourceContentHash: string, change: AdjustmentChange): string {
  return `${pkg.seed}:adj:${sha256Hex(canonicalJson({ source: sourceContentHash, change })).slice(0, 16)}`;
}

/** Seeds tried (`<seed>:exercises:<attempt>`) before giving up on drawing questions that are all new. */
const DRAW_ATTEMPTS = 20;
/** The writing space under each exercise, as the builder lays it out. */
const WRITING_SPACE_LINES = 4;

type Block = Section["blocks"][number];
type ExerciseBlock = ExercisesSection["blocks"][number];
type SolutionBlock = SolutionsSection["blocks"][number];

/** Fingerprints of every question in the package: worked examples and exercises. */
function takenFingerprints(pkg: LessonPackage): Set<string> {
  const out = new Set<string>();
  for (const section of pkg.sections) {
    for (const block of section.blocks as Block[]) {
      if (block.type === "question" || block.type === "worked_example") out.add(questionFingerprint(block));
    }
  }
  return out;
}

/** Questions that repeat nothing in `exclude`, trying `<seed>:exercises:0..19`; otherwise not applicable. */
function drawNewQuestions(seed: string, args: { count: number; difficulty: Difficulty; startIndex?: number; ramp?: boolean }, exclude: ReadonlySet<string>): GeneratedQuestion[] {
  for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt++) {
    try {
      const set = generateExerciseSet({ jobSeed: `${seed}:exercises:${attempt}`, idPrefix: "ex", exclude, ...args });
      if (set.length === args.count && set.every((q) => !exclude.has(questionFingerprint(q)))) return set;
    } catch (e) {
      if (!(e instanceof Error && e.message === DRAW_EXHAUSTED)) throw e;
    }
  }
  return notApplicable("no_distinct_questions");
}

/**
 * The blocks with new math blocks placed after the last existing one. `keep: false` drops the existing math blocks
 * (the prose around them stays, in order); `keep: true` keeps them exactly as they are.
 */
function placeMath<B extends { type: string }>(blocks: readonly B[], isMath: (b: B) => boolean, keep: boolean, added: readonly B[]): B[] {
  let last = -1;
  blocks.forEach((b, i) => {
    if (isMath(b)) last = i;
  });
  if (last < 0) throw new Error("adjustment: the section has no question blocks");
  const head = blocks.slice(0, last + 1);
  return [...(keep ? head : head.filter((b) => !isMath(b))), ...added, ...blocks.slice(last + 1)];
}

const isExerciseMath = (b: ExerciseBlock) => b.type === "question" || b.type === "writing_space";
const isSolutionMath = (b: SolutionBlock) => b.type === "solution";
const exerciseBlocksOf = (qs: readonly GeneratedQuestion[]): ExerciseBlock[] =>
  qs.flatMap((q) => [
    { type: "question" as const, questionId: q.id, problem: q.problem },
    { type: "writing_space" as const, lines: WRITING_SPACE_LINES },
  ]);
const solutionBlocksOf = (qs: readonly GeneratedQuestion[]): SolutionBlock[] => qs.map((q) => ({ type: "solution" as const, questionId: q.id, solution: q.solution, steps: q.steps }));

/**
 * Executes a deterministic adjustment and returns the new package, already rehashed and with one more `adjustments`
 * record. Pure: no clock, no randomness beyond `seed`, no I/O, and `pkg` is never modified. Throws
 * `AdjustmentNotApplicable` when the planner refuses the change or no new distinct questions can be drawn.
 *
 * make_easier / make_harder: every exercise is drawn again, same count, one step down or up basic < mixed < challenge,
 * exactly as the generator lays out a set at that difficulty. Moving to mixed (basic -> harder, challenge -> easier)
 * gives the generator's thirds ramp: the first third basic, the next mixed, the rest challenge. Moving away from mixed
 * gives one level throughout: mixed -> harder is all challenge, mixed -> easier all basic. New questions repeat no
 * question of the source (exercises or worked examples), and the solutions are re-derived from them.
 *
 * add_exercises: the existing exercise and solution blocks stay byte-identical; the new questions continue the ids
 * (ex-(n+1), ...), are drawn at the current effective difficulty (mixed means the mixed level for each new question,
 * the existing ramp is not re-laid), and repeat no question already in the package.
 */
export function applyAdjustment(pkg: LessonPackage, change: ApplicableChange, opts: { seed: string; context: CurriculumContext }): LessonPackage {
  if (change.action === "add_worked_example" || change.action === "change_duration") {
    throw new Error(`applyAdjustment: ${change.action} is not implemented yet`);
  }
  const plan = planAdjustment(pkg, change); // throws AdjustmentNotApplicable
  if ((pkg.context as { contextHash?: unknown }).contextHash !== opts.context.contextHash) {
    throw new Error("applyAdjustment: the context is not the package's curriculum snapshot");
  }
  const source = structuredClone(pkg);
  const { seed } = opts;
  const current = effectiveSettings(source).difficulty;
  const exercises = source.sections.find((s): s is ExercisesSection => s.kind === "exercises")!;
  const solutions = source.sections.find((s): s is SolutionsSection => s.kind === "solutions");
  if (!solutions) throw new Error("applyAdjustment: the package has no solutions section");
  const count = exercises.blocks.filter((b) => b.type === "question").length;
  const taken = takenFingerprints(source);

  let difficulty: Difficulty;
  let exerciseBlocks: ExerciseBlock[];
  let solutionBlocks: SolutionBlock[];
  if (change.action === "add_exercises") {
    difficulty = current;
    const added = drawNewQuestions(seed, { count: change.count, difficulty, startIndex: count + 1, ramp: false }, taken);
    const ids = new Set(exercises.blocks.flatMap((b) => (b.type === "question" ? [b.questionId] : [])));
    if (added.some((q) => ids.has(q.id))) throw new Error("applyAdjustment: a new question id is already taken");
    exerciseBlocks = placeMath(exercises.blocks, isExerciseMath, true, exerciseBlocksOf(added));
    solutionBlocks = placeMath(solutions.blocks, isSolutionMath, true, solutionBlocksOf(added));
  } else {
    difficulty = LADDER[LADDER.indexOf(current) + (change.action === "make_harder" ? 1 : -1)]!;
    const fresh = drawNewQuestions(seed, { count, difficulty }, taken);
    exerciseBlocks = placeMath(exercises.blocks, isExerciseMath, false, exerciseBlocksOf(fresh));
    solutionBlocks = placeMath(solutions.blocks, isSolutionMath, false, solutionBlocksOf(fresh));
  }

  // Solutions derive from the exercises, so both record the same seed and difficulty. After add_exercises the section
  // mixes questions drawn from earlier seeds with new ones and `seed` is only the latest: the recomputed inputsHash is
  // then a self-consistency tag for the stored package, not proof that these inputs alone reproduce the section.
  const provenance = { method: "deterministic" as const, seed, difficulty, generatorVersion: GENERATOR_VERSION };
  const next: LessonPackage = {
    ...source,
    sections: source.sections.map((s) => {
      if (s.id === exercises.id) return { ...s, blocks: exerciseBlocks, provenance } as Section;
      if (s.id === solutions.id) return { ...s, blocks: solutionBlocks, provenance } as Section;
      return s;
    }),
    adjustments: [...(source.adjustments ?? []), { action: change.action, method: "deterministic", seed, sourceContentHash: packageContentHash(pkg) }],
  };
  const result = rehashPackage(next, source.request as Pick<LessonRequestV2, "difficulty">, opts.context);

  // The plan is the contract: a section it keeps must come back byte for byte.
  for (const id of plan.unchanged) {
    const before = pkg.sections.find((s) => s.id === id);
    const after = result.sections.find((s) => s.id === id);
    if (canonicalJson(before) !== canonicalJson(after)) throw new Error(`applyAdjustment: section ${id} changed but the plan keeps it`);
  }
  return result;
}
