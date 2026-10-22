import { admitItem, deterministicLinearSource, type ItemSource, type VerifiedItem } from "@/lib/content/item-source";
import type { CurriculumContext } from "@/lib/curriculum/context";
import { CandidateStale, DrawExhausted, InvariantViolation, ItemRejected, MinQuestionCount, NothingToUndo, QuestionNotFound } from "@/lib/domain/errors";
import { canonicalJson, sha256Hex } from "@/lib/domain/hash";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { DRAW_EXHAUSTED, type Difficulty } from "@/lib/math/generator";
import { packageContentHash, takenFingerprints } from "./adjust";
import { rehashPackage } from "./inputs";
import type { LessonPackage, Section } from "./schema";
import { validatePackage } from "./validate";

// Question-level adjustment of a draft version (S2): pure functions over a `DraftState`. No clock, no randomness (the
// candidate id and the timestamp are passed in), no I/O. The DAL runs them inside a transaction and stores the result.

/** A worksheet never has fewer exercises than the builder's own minimum (`planOutline` clamps to 3). */
export const BUILDER_MIN_EXERCISES = 3;
/**
 * Compact-JSON budget for the undo history. The database CHECK (2,000,000 bytes) measures `jsonb::text`, which adds a space
 * after every ":" and ",", so the app bound stays well below it.
 */
export const HISTORY_MAX_BYTES = 1_500_000;

export type QuestionOrigin = "initial" | "generated" | "replacement";
/** `slot` is the baseline question id this one descends from (set on replacements only; the question itself when absent). */
export interface QuestionMeta {
  level: Difficulty;
  origin: QuestionOrigin;
  slot?: string;
}
export type MetaMap = Record<string, QuestionMeta>;

/** Derived relative to the version's generated baseline. A replaced question counts once however often it was replaced. */
export interface ChangeSummary {
  replacedIds: string[];
  removedIds: string[];
  /** The ids (current ones) of questions whose content differs from the baseline: today the replacements. */
  modifiedIds: string[];
}

/** What the stored `changes` column holds: the summary (removedIds is the authoritative part; the rest is derived). */
export type StoredChanges = ChangeSummary;

type ExercisesSection = Extract<Section, { kind: "exercises" }>;
type SolutionsSection = Extract<Section, { kind: "solutions" }>;

export interface HistoryEntry {
  op: "replace" | "remove";
  /** ISO timestamp. */
  at: string;
  before: {
    exercises: ExercisesSection;
    solutions: SolutionsSection;
    question_meta: MetaMap;
    next_question_seq: number;
    changes: StoredChanges;
  };
  beforeHash: string;
  afterHash: string;
  /** What undo will say it undoes, e.g. "Replaced question 3". */
  summary: string;
}

export interface DraftState {
  /** The full package (request and context included): its content hash is the version's `content_hash`. */
  pkg: LessonPackage;
  meta: MetaMap;
  /** Next exercise number; never decreases (ids are never reused, not even after undo). */
  nextSeq: number;
  history: HistoryEntry[];
  changes: StoredChanges;
}

export interface OpsConfig {
  minExercises: number;
  undoDepth: number;
  /** Test seam; defaults to HISTORY_MAX_BYTES. */
  historyMaxBytes?: number;
}

export interface Slot {
  position: number;
  questionId: string;
  level: Difficulty;
  origin: QuestionOrigin;
}

/** What is stored in `draft_version.pending_candidate`: a verified question, serialisable, and the content it was drawn against. */
export interface PendingCandidate {
  id: string;
  targetQuestionId: string;
  baseRev: number;
  baseHash: string;
  item: {
    id: string;
    level: Difficulty;
    fingerprint: string;
    problem: VerifiedItem["question"]["problem"];
    solution: VerifiedItem["question"]["solution"];
    steps: VerifiedItem["question"]["steps"];
  };
  attempt: number;
  /** Fingerprints already offered for this slot in this session (not including the current candidate). */
  tried: string[];
}

// --- reading -----------------------------------------------------------------------------------------

const exercisesOf = (pkg: LessonPackage) => pkg.sections.find((s): s is ExercisesSection => s.kind === "exercises");
const solutionsOf = (pkg: LessonPackage) => pkg.sections.find((s): s is SolutionsSection => s.kind === "solutions");

export function exerciseIds(pkg: LessonPackage): string[] {
  return (exercisesOf(pkg)?.blocks ?? []).flatMap((b) => (b.type === "question" ? [b.questionId] : []));
}

/** The exercises in worksheet order with the level each was drawn at. Worked examples are not slots. */
export function questionSlots(pkg: LessonPackage, meta: MetaMap): Slot[] {
  return exerciseIds(pkg).map((questionId, i) => {
    const m = meta[questionId];
    if (!m) throw new InvariantViolation(`question ${questionId} has no recorded level`);
    return { position: i + 1, questionId, level: m.level, origin: m.origin };
  });
}

const isBaseline = (m: QuestionMeta | undefined) => m !== undefined && m.origin !== "replacement";

/** Replaced / removed / modified relative to the generated baseline. */
export function changeSummary(state: Pick<DraftState, "pkg" | "meta" | "changes">): ChangeSummary {
  const replacedIds = exerciseIds(state.pkg).filter((id) => state.meta[id] && !isBaseline(state.meta[id]));
  const removedIds = [...new Set(state.changes.removedIds)];
  return { replacedIds, removedIds, modifiedIds: [...replacedIds] };
}

/** The seed of one candidate: another attempt, another question or other content gives other questions. */
export function candidateSeed(versionSeed: string, questionId: string, attempt: number, baseHash: string): string {
  return `${versionSeed}:cand:${sha256Hex(canonicalJson({ questionId, attempt, baseHash })).slice(0, 16)}`;
}

function requireSlot(state: DraftState, questionId: string): Slot {
  const slot = questionSlots(state.pkg, state.meta).find((s) => s.questionId === questionId);
  if (!slot) throw new QuestionNotFound();
  return slot;
}

// --- drawing -----------------------------------------------------------------------------------------

export interface DrawOptions {
  versionSeed: string;
  attempt: number;
  /** Fingerprints already tried for this slot. */
  tried: readonly string[];
  /** Pending-candidate bookkeeping, passed through. */
  baseRev: number;
  candidateId: string;
  source?: ItemSource;
}

/**
 * One candidate replacement for `questionId`, at the same level, that repeats no exercise or worked example of the version, nor
 * the original, nor an earlier candidate for the slot. Verified by the item gate. Throws DrawExhausted when the source has
 * nothing else to offer. Does not change the state.
 */
export async function drawReplacement(state: DraftState, questionId: string, opts: DrawOptions): Promise<PendingCandidate> {
  const slot = requireSlot(state, questionId);
  const baseHash = packageContentHash(state.pkg);
  const exclude = new Set<string>([...takenFingerprints(state.pkg), ...opts.tried]);
  const seed = candidateSeed(opts.versionSeed, questionId, opts.attempt, baseHash);
  const source = opts.source ?? deterministicLinearSource;
  let raw;
  try {
    raw = await source.draw({ role: "exercise", index: state.nextSeq, level: slot.level, seed, exclude });
  } catch (error) {
    if (error instanceof Error && error.message === DRAW_EXHAUSTED) throw new DrawExhausted();
    throw error;
  }
  if (raw.id !== `ex-${state.nextSeq}`) throw new ItemRejected("unexpected_id");
  const item = admitItem(raw, slot.level);
  if (exclude.has(item.fingerprint)) throw new DrawExhausted(); // a source that ignores the exclusion set has nothing new
  return {
    id: opts.candidateId,
    targetQuestionId: questionId,
    baseRev: opts.baseRev,
    baseHash,
    item: { id: item.id, level: item.level, fingerprint: item.fingerprint, problem: item.question.problem, solution: item.question.solution, steps: item.question.steps },
    attempt: opts.attempt,
    tried: [...opts.tried],
  };
}

// --- applying ----------------------------------------------------------------------------------------

function boundHistory(history: HistoryEntry[], cfg: OpsConfig): HistoryEntry[] {
  let next = history.slice(-Math.max(1, cfg.undoDepth));
  const max = cfg.historyMaxBytes ?? HISTORY_MAX_BYTES;
  // Drop the oldest entries until the whole stack fits; the newest entry is always kept (it is what undo needs).
  while (next.length > 1 && Buffer.byteLength(JSON.stringify(next), "utf8") > max) next = next.slice(1);
  return next;
}

/** The package with the two sections replaced, rehashed, and checked: only a fully verified package comes back. */
function finish(base: LessonPackage, exercises: ExercisesSection, solutions: SolutionsSection): LessonPackage {
  const sections = base.sections.map((s) => (s.id === exercises.id ? exercises : s.id === solutions.id ? solutions : s)) as Section[];
  const next = rehashPackage({ ...base, sections }, base.request as Pick<LessonRequestV2, "difficulty">, base.context as CurriculumContext);
  const report = validatePackage(next);
  if (report.overall !== "verified") throw new InvariantViolation(`the adjusted package did not validate (${report.overall})`);
  return next;
}

function entry(op: HistoryEntry["op"], at: Date, state: DraftState, afterHash: string, summary: string): HistoryEntry {
  const exercises = exercisesOf(state.pkg);
  const solutions = solutionsOf(state.pkg);
  if (!exercises || !solutions) throw new InvariantViolation("the package has no exercises or solutions section");
  return {
    op,
    at: at.toISOString(),
    before: {
      exercises: structuredClone(exercises),
      solutions: structuredClone(solutions),
      question_meta: structuredClone(state.meta),
      next_question_seq: state.nextSeq,
      changes: structuredClone(state.changes),
    },
    beforeHash: packageContentHash(state.pkg),
    afterHash,
    summary,
  };
}

const seqOf = (id: string) => Number(/^ex-(\d+)$/.exec(id)?.[1] ?? NaN);

/**
 * Accepts `candidate` in place of its target: the exercise AND its paired solution change together, at the same position
 * and level, under the new id `ex-{nextSeq}`. Refused (CANDIDATE_STALE) when the candidate was drawn against other content;
 * the stored candidate is re-verified (never trusted as stored). Throws unless the whole package validates as verified.
 */
export function acceptReplacement(state: DraftState, candidate: PendingCandidate, cfg: OpsConfig, now: Date): DraftState {
  const beforeHash = packageContentHash(state.pkg);
  if (candidate.baseHash !== beforeHash || seqOf(candidate.item.id) !== state.nextSeq) throw new CandidateStale();
  const slot = requireSlot(state, candidate.targetQuestionId);
  const item = admitItem({ id: candidate.item.id, role: "exercise", problem: candidate.item.problem, solution: candidate.item.solution, steps: candidate.item.steps }, slot.level);
  if (takenFingerprints(state.pkg).has(item.fingerprint)) throw new ItemRejected("duplicate");

  const exercises = structuredClone(exercisesOf(state.pkg)!);
  const solutions = structuredClone(solutionsOf(state.pkg)!);
  const at = exercises.blocks.findIndex((b) => b.type === "question" && b.questionId === slot.questionId);
  const sat = solutions.blocks.findIndex((b) => b.type === "solution" && b.questionId === slot.questionId);
  if (at < 0 || sat < 0) throw new InvariantViolation("the question has no paired solution");
  exercises.blocks[at] = { type: "question", questionId: item.id, problem: item.question.problem };
  solutions.blocks[sat] = { type: "solution", questionId: item.id, solution: item.question.solution, steps: item.question.steps };

  const next = finish(state.pkg, exercises, solutions);
  const meta: MetaMap = { ...state.meta };
  const old = meta[slot.questionId]!;
  delete meta[slot.questionId];
  meta[item.id] = { level: slot.level, origin: "replacement", slot: old.slot ?? slot.questionId };
  const after: DraftState = { pkg: next, meta, nextSeq: state.nextSeq + 1, history: state.history, changes: state.changes };
  after.changes = changeSummary(after);
  after.history = boundHistory([...state.history, entry("replace", now, state, packageContentHash(next), `Replaced question ${slot.position}`)], cfg);
  return after;
}

/** Removes one exercise and its solution (ids of the others stay; numbering is positional at render). */
export function removeQuestion(state: DraftState, questionId: string, cfg: OpsConfig, now: Date): DraftState {
  const slot = requireSlot(state, questionId);
  const minimum = Math.max(cfg.minExercises, BUILDER_MIN_EXERCISES);
  if (exerciseIds(state.pkg).length - 1 < minimum) throw new MinQuestionCount(minimum);

  const exercises = structuredClone(exercisesOf(state.pkg)!);
  const solutions = structuredClone(solutionsOf(state.pkg)!);
  const at = exercises.blocks.findIndex((b) => b.type === "question" && b.questionId === questionId);
  const space = exercises.blocks[at + 1]?.type === "writing_space" ? 1 : 0; // the writing space that follows it
  exercises.blocks.splice(at, 1 + space);
  const sat = solutions.blocks.findIndex((b) => b.type === "solution" && b.questionId === questionId);
  if (sat < 0) throw new InvariantViolation("the question has no paired solution");
  solutions.blocks.splice(sat, 1);

  const next = finish(state.pkg, exercises, solutions);
  const meta: MetaMap = { ...state.meta };
  const old = meta[questionId]!;
  delete meta[questionId];
  const stored: StoredChanges = { ...state.changes, removedIds: [...state.changes.removedIds, old.slot ?? questionId] };
  const after: DraftState = { pkg: next, meta, nextSeq: state.nextSeq, history: state.history, changes: stored };
  after.changes = changeSummary(after);
  after.history = boundHistory([...state.history, entry("remove", now, state, packageContentHash(next), `Removed question ${slot.position}`)], cfg);
  return after;
}

/** What undo would revert, for the button label; null when the history is empty. */
export const undoLabel = (state: Pick<DraftState, "history">): string | null => state.history.at(-1)?.summary ?? null;

/**
 * Undoes the most recent question-level change: restores the exercises and solutions sections, the question metadata and the
 * change summary from the before-image, keeps `nextSeq` (ids are never reused), rehashes, and requires the content hash to
 * equal the recorded one and the package to be verified (a hard error otherwise).
 */
export function undoLast(state: DraftState): DraftState {
  const last = state.history.at(-1);
  if (!last) throw new NothingToUndo();
  const restored = finish(state.pkg, structuredClone(last.before.exercises), structuredClone(last.before.solutions));
  if (packageContentHash(restored) !== last.beforeHash) throw new InvariantViolation("undo did not restore the recorded content hash");
  return {
    pkg: restored,
    meta: structuredClone(last.before.question_meta),
    nextSeq: Math.max(state.nextSeq, last.before.next_question_seq),
    history: state.history.slice(0, -1),
    changes: structuredClone(last.before.changes),
  };
}
