import type { CurriculumContext } from "@/lib/curriculum/context";
import { methodOf, type AdjustmentChange, type AdjustmentMethod, type TextEdit } from "@/lib/domain/adjustment";
import { AdjustmentNotApplicable } from "@/lib/domain/errors";
import { canonicalJson, sha256Hex } from "@/lib/domain/hash";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { DRAW_EXHAUSTED, GENERATOR_VERSION, generateExerciseSet, questionFingerprint, type Difficulty, type GeneratedQuestion } from "@/lib/math/generator";
import { degenerateExample, exampleLevel, LINEAR_CONCEPT_ID, planOutline, sectionMinutes, timingBlock, workedExampleBlock } from "./build";
import { resolveEditTarget } from "./editable";
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

/** Is `edit` allowed on this package? Throws `target_not_found` or `not_editable` (EDITABLE_BLOCKS, plan section 2.6). */
function checkEditTarget(pkg: LessonPackage, edit: TextEdit): void {
  const resolved = resolveEditTarget(pkg, edit.sectionId, edit.target);
  if (!resolved.ok) notApplicable(resolved.reason);
}

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
        .filter((o) => !regenerated.has(o.id) && o.minutes !== sectionMinutes(o.kind, next))
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

/** Seeds tried (`<seed>:exercises:<attempt>`, `<seed>:examples:<attempt>`) before giving up on drawing questions that are all new. */
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

/**
 * Questions that repeat nothing in `exclude`, trying `<seed>:<kind>:0..19`; otherwise not applicable. Exercises get
 * ids `ex-N`, worked examples `we-N`, as the builder numbers them.
 */
function drawNewQuestions(
  seed: string,
  args: { count: number; difficulty: Difficulty; startIndex?: number; ramp?: boolean },
  exclude: ReadonlySet<string>,
  kind: "exercises" | "examples" = "exercises",
): GeneratedQuestion[] {
  const idPrefix = kind === "exercises" ? "ex" : "we";
  for (let attempt = 0; attempt < DRAW_ATTEMPTS; attempt++) {
    try {
      const set = generateExerciseSet({ jobSeed: `${seed}:${kind}:${attempt}`, idPrefix, exclude, ...args });
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

type WorkedExamplesSection = Extract<Section, { kind: "worked_examples" }>;
type WorkedExamplesBlock = WorkedExamplesSection["blocks"][number];
type ExampleBlock = Extract<WorkedExamplesBlock, { type: "worked_example" }>;
type TeachingSequenceSection = Extract<Section, { kind: "teaching_sequence" }>;

const isExample = (b: WorkedExamplesBlock): b is ExampleBlock => b.type === "worked_example";
const isUniqueExample = (b: WorkedExamplesBlock): boolean => isExample(b) && b.solution.kind === "unique";

function sectionOfKind<K extends SectionKind>(pkg: LessonPackage, kind: K): Extract<Section, { kind: K }> {
  const found = pkg.sections.find((s) => s.kind === kind);
  if (!found) throw new Error(`applyAdjustment: the package has no ${kind} section`);
  return found as Extract<Section, { kind: K }>;
}

/** The difficulty the worked examples were drawn for: their own provenance, else the request (as the builder records it). */
const examplesDifficulty = (pkg: LessonPackage, section: WorkedExamplesSection): Difficulty =>
  section.provenance.difficulty ?? (pkg.request as { difficulty: Difficulty }).difficulty;

/** The provenance a section regenerated by `seed` records; method and model notes of its kept wording stay. */
const regeneratedProvenance = (section: Section, seed: string, difficulty: Difficulty): Section["provenance"] => ({
  ...section.provenance,
  seed,
  difficulty,
  generatorVersion: GENERATOR_VERSION,
});

/** The whole exercise set and its answer key drawn again: `count` questions at `difficulty` (mixed: the thirds ramp). */
function redrawExercises(source: LessonPackage, seed: string, count: number, difficulty: Difficulty, exclude: ReadonlySet<string>) {
  const exercises = sectionOfKind(source, "exercises");
  const solutions = sectionOfKind(source, "solutions");
  const fresh = drawNewQuestions(seed, { count, difficulty }, exclude);
  // Solutions derive from the exercises, so both record the same seed and difficulty.
  const provenance = { method: "deterministic" as const, seed, difficulty, generatorVersion: GENERATOR_VERSION };
  return {
    drawn: fresh,
    sections: [
      { ...exercises, blocks: placeMath(exercises.blocks, isExerciseMath, false, exerciseBlocksOf(fresh)), provenance } as Section,
      { ...solutions, blocks: placeMath(solutions.blocks, isSolutionMath, false, solutionBlocksOf(fresh)), provenance } as Section,
    ],
  };
}

/**
 * The no-solution example under a new id, drawn again through the builder's own code path. Its equation depends only
 * on the package seed, so the result is the same example renumbered; anything else means the block is not the
 * builder's and is refused rather than rewritten.
 */
function renumberedDegenerate(pkg: LessonPackage, block: ExampleBlock, id: string): ExampleBlock {
  if (canonicalJson(workedExampleBlock(degenerateExample(pkg.seed, block.questionId))) !== canonicalJson(block)) {
    throw new Error("applyAdjustment: the no-solution example is not the one the builder made");
  }
  return workedExampleBlock(degenerateExample(pkg.seed, id));
}

/** add_worked_example: one new unique-solution example after the last one, before the no-solution example and note. */
function addWorkedExample(source: LessonPackage, seed: string, taken: ReadonlySet<string>): Section[] {
  const section = sectionOfKind(source, "worked_examples");
  const blocks = section.blocks;
  const last = blocks.findLastIndex(isUniqueExample);
  if (last < 0) throw new Error("applyAdjustment: the worked examples section has no unique-solution example");
  // The largest we-N plus one, so the id stays unique however many examples were added (or renumbered) before.
  const numbers = blocks.filter(isExample).map((b) => /^we-(\d+)$/.exec(b.questionId)).map((m) => (m ? Number(m[1]) : 0));
  const startIndex = Math.max(0, ...numbers) + 1;
  const difficulty = examplesDifficulty(source, section);
  // One example at the level the builder draws examples at for this difficulty (no ramp for a single new example).
  const [added] = drawNewQuestions(seed, { count: 1, difficulty: exampleLevel(difficulty), startIndex, ramp: false }, taken, "examples");
  const ids = new Set(source.sections.flatMap((s) => (s.blocks as Block[]).flatMap((b) => ("questionId" in b ? [b.questionId] : []))));
  if (!added || ids.has(added.id)) throw new Error("applyAdjustment: the new example id is already taken");
  const next = [...blocks.slice(0, last + 1), workedExampleBlock(added), ...blocks.slice(last + 1)];
  return [{ ...section, blocks: next, provenance: regeneratedProvenance(section, seed, difficulty) } as Section];
}

/**
 * change_duration. The outline is the builder's for the new duration; the plan says which sections are rebuilt:
 *  - teaching_sequence: only its timing block is replaced (the builder's, for the new outline);
 *  - worked_examples, when the number of unique-solution examples differs from the new outline's: the unique examples
 *    are drawn again (we-1..we-k, the builder's draw at the section's difficulty); the intro paragraph, the
 *    no-solution example (renumbered we-(k+1), as the builder numbers it) and its note keep their places;
 *  - exercises + solutions, when the number of exercises differs: the whole set is drawn again at the current
 *    effective difficulty.
 * Owner-visible: the comparison uses the package's actual counts, so examples or exercises added earlier by
 * add_worked_example / add_exercises are discarded and redrawn whenever the new duration's count differs (they are
 * kept only when it matches).
 */
function changeDuration(source: LessonPackage, durationMinutes: number, plan: AdjustmentPlan, seed: string, taken: Set<string>) {
  const next = planOutline(durationMinutes);
  const outline: LessonPackage["outline"] = {
    totalMinutes: durationMinutes,
    sections: source.outline.sections.map((o) => ({ ...o, minutes: sectionMinutes(o.kind, next) })),
  };
  const regenerate = new Set(plan.changed);
  const teaching = sectionOfKind(source, "teaching_sequence");
  const examples = sectionOfKind(source, "worked_examples");
  const exercises = sectionOfKind(source, "exercises");
  const known = new Set([teaching.id, examples.id, exercises.id]);
  if (!regenerate.has(teaching.id) || plan.changed.some((id) => !known.has(id))) throw new Error("applyAdjustment: unexpected plan for change_duration");

  const replaced: Section[] = [];
  if (!teaching.blocks.some((b) => b.type === "timing")) throw new Error("applyAdjustment: the teaching sequence has no timing block");
  const teachingBlocks = teaching.blocks.map((b): TeachingSequenceSection["blocks"][number] => (b.type === "timing" ? timingBlock(next) : b));
  replaced.push({ ...teaching, blocks: teachingBlocks } as Section);

  if (regenerate.has(examples.id)) {
    const difficulty = examplesDifficulty(source, examples);
    const fresh = drawNewQuestions(seed, { count: next.exampleCount, difficulty: exampleLevel(difficulty) }, taken, "examples");
    for (const q of fresh) taken.add(questionFingerprint(q));
    const degenerate = examples.blocks.filter((b): b is ExampleBlock => isExample(b) && !isUniqueExample(b));
    if (degenerate.length > 1) throw new Error("applyAdjustment: more than one example without a unique solution");
    const kept = degenerate.map((b) => renumberedDegenerate(source, b, `we-${fresh.length + 1}`));
    const first = examples.blocks.findIndex(isUniqueExample);
    if (first < 0) throw new Error("applyAdjustment: the worked examples section has no unique-solution example");
    const rest = examples.blocks.filter((b) => !isUniqueExample(b)).map((b) => (b === degenerate[0] ? kept[0]! : b));
    // Nothing before the first unique example is an example, so `first` is also its position in `rest`.
    const blocks = [...rest.slice(0, first), ...fresh.map(workedExampleBlock), ...rest.slice(first)];
    replaced.push({ ...examples, blocks, provenance: regeneratedProvenance(examples, seed, difficulty) } as Section);
  }

  if (regenerate.has(exercises.id)) {
    replaced.push(...redrawExercises(source, seed, next.exerciseCount, effectiveSettings(source).difficulty, taken).sections);
  }
  return { replaced, outline };
}

/** The exercise-only adjustments: make_easier, make_harder, add_exercises. */
function exerciseChange(source: LessonPackage, change: Extract<ApplicableChange, { action: "make_easier" | "make_harder" | "add_exercises" }>, seed: string, taken: ReadonlySet<string>): Section[] {
  const current = effectiveSettings(source).difficulty;
  if (change.action !== "add_exercises") {
    const difficulty = LADDER[LADDER.indexOf(current) + (change.action === "make_harder" ? 1 : -1)]!;
    const count = sectionOfKind(source, "exercises").blocks.filter((b) => b.type === "question").length;
    return redrawExercises(source, seed, count, difficulty, taken).sections;
  }
  const exercises = sectionOfKind(source, "exercises");
  const solutions = sectionOfKind(source, "solutions");
  const count = exercises.blocks.filter((b) => b.type === "question").length;
  const added = drawNewQuestions(seed, { count: change.count, difficulty: current, startIndex: count + 1, ramp: false }, taken);
  const ids = new Set(exercises.blocks.flatMap((b) => (b.type === "question" ? [b.questionId] : [])));
  if (added.some((q) => ids.has(q.id))) throw new Error("applyAdjustment: a new question id is already taken");
  // After add_exercises the section mixes questions drawn from earlier seeds with new ones and `seed` is only the
  // latest: the recomputed inputsHash is then a self-consistency tag for the stored package, not proof that these
  // inputs alone reproduce the section.
  const provenance = { method: "deterministic" as const, seed, difficulty: current, generatorVersion: GENERATOR_VERSION };
  return [
    { ...exercises, blocks: placeMath(exercises.blocks, isExerciseMath, true, exerciseBlocksOf(added)), provenance } as Section,
    { ...solutions, blocks: placeMath(solutions.blocks, isSolutionMath, true, solutionBlocksOf(added)), provenance } as Section,
  ];
}

const withoutInputsHash = (s: Section | undefined) => (s ? Object.fromEntries(Object.entries(s).filter(([key]) => key !== "inputsHash")) : undefined);

/**
 * Executes a deterministic adjustment and returns the new package, already rehashed and with one more `adjustments`
 * record. Pure: no clock, no randomness beyond `seed`, no I/O, and `pkg` is never modified. Throws
 * `AdjustmentNotApplicable` when the planner refuses the change or no new distinct questions can be drawn. The
 * planner's classification is the contract: what it rebuilds is rebuilt here, and every section it keeps or only
 * rehashes is checked to come back unchanged.
 *
 * make_easier / make_harder: every exercise is drawn again, same count, one step down or up basic < mixed < challenge,
 * exactly as the generator lays out a set at that difficulty. Moving to mixed (basic -> harder, challenge -> easier)
 * gives the generator's thirds ramp: the first third basic, the next mixed, the rest challenge. Moving away from mixed
 * gives one level throughout: mixed -> harder is all challenge, mixed -> easier all basic. New questions repeat no
 * question of the source (exercises or worked examples), and the solutions are re-derived from them.
 *
 * add_exercises: the existing exercise and solution blocks stay byte-identical; the new questions continue the ids
 * (ex-(n+1), ...), are drawn at the current effective difficulty, and repeat no question already in the package.
 *
 * add_worked_example: one new unique-solution example (id: the largest we-N plus one) right after the last
 * unique-solution example, so the no-solution example and its note stay last. It is drawn at the level the builder
 * uses for the worked examples' difficulty (basic -> basic, otherwise mixed), repeats no question of the package, and
 * every other block stays byte-identical. The outline does not change.
 *
 * change_duration: see `changeDuration`. New questions repeat no question of the source, nor each other.
 *
 * Product-visible behaviours (owner decisions recorded here; do not change without one):
 *  - add_exercises on a MIXED set appends every new question at the mixed level; the existing easy-to-hard ramp is
 *    not redone, so the set no longer ends on its hardest questions.
 *  - A regenerated exercises / solutions / worked examples section keeps its title, its intro paragraphs and its
 *    `edited` flag: a tutor's correction to that wording survives the adjustment. Only the questions, writing spaces
 *    and solutions are replaced or appended.
 *  - change_duration discards examples / exercises added earlier when the new duration's count differs.
 */
export function applyAdjustment(pkg: LessonPackage, change: ApplicableChange, opts: { seed: string; context: CurriculumContext }): LessonPackage {
  const plan = planAdjustment(pkg, change); // throws AdjustmentNotApplicable
  if ((pkg.context as { contextHash?: unknown }).contextHash !== opts.context.contextHash) {
    throw new Error("applyAdjustment: the context is not the package's curriculum snapshot");
  }
  const source = structuredClone(pkg);
  const { seed } = opts;
  const taken = takenFingerprints(source);

  let replaced: Section[];
  let outline = source.outline;
  if (change.action === "add_worked_example") replaced = addWorkedExample(source, seed, taken);
  else if (change.action === "change_duration") ({ replaced, outline } = changeDuration(source, change.durationMinutes, plan, seed, taken));
  else replaced = exerciseChange(source, change, seed, taken);

  const byId = new Map(replaced.map((s) => [s.id, s]));
  const regenerated = new Set(plan.sections.filter((s) => s.disposition === "regenerate").map((s) => s.id));
  for (const id of byId.keys()) if (!regenerated.has(id)) throw new Error(`applyAdjustment: section ${id} rebuilt but the plan does not regenerate it`);
  const next: LessonPackage = {
    ...source,
    outline,
    sections: source.sections.map((s) => byId.get(s.id) ?? s),
    adjustments: [...(source.adjustments ?? []), { action: change.action, method: "deterministic", seed, sourceContentHash: packageContentHash(pkg) }],
  };
  const result = rehashPackage(next, source.request as Pick<LessonRequestV2, "difficulty">, opts.context);

  // The plan is the contract: a section it keeps must come back byte for byte, a rehashed one with only a new inputsHash.
  const find = (p: LessonPackage, id: string) => p.sections.find((s) => s.id === id);
  for (const id of plan.unchanged) {
    if (canonicalJson(find(pkg, id)) !== canonicalJson(find(result, id))) throw new Error(`applyAdjustment: section ${id} changed but the plan keeps it`);
  }
  for (const id of plan.rehashed) {
    if (canonicalJson(withoutInputsHash(find(pkg, id))) !== canonicalJson(withoutInputsHash(find(result, id)))) {
      throw new Error(`applyAdjustment: section ${id} changed but the plan only rehashes it`);
    }
  }
  if (!plan.outlineChanged && canonicalJson(result.outline) !== canonicalJson(pkg.outline)) throw new Error("applyAdjustment: the outline changed but the plan keeps it");
  return result;
}
