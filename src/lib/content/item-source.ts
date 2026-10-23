import { ItemRejected } from "@/lib/domain/errors";
import { generateExerciseSet, questionFingerprint, type Difficulty } from "@/lib/math/generator";
import { QuestionSchema, type Question } from "@/lib/math/schema";
import { Rational } from "@/lib/math/rational";
import { contentHashOf, validateLinearQuestion } from "@/lib/math/validate";
import { isChallengeLevel } from "@/lib/package/adjust";

// The item-source gate (D-107). Questions enter a lesson only as a VerifiedItem, which only `admitItem` can make:
// the structured problem and solution are schema-parsed (strict objects: there is no free LaTeX or HTML field to
// carry), re-solved with exact rational arithmetic by the validator, and must come out "verified". A future
// non-deterministic source (a model) gets no shortcut: it returns a RawItem like any other source.

/** What makes two questions the same for de-duplication (the equation as written). */
export type Fingerprint = string;

export interface ItemRequest {
  role: "example" | "exercise";
  /** 1-based position number the id is built from: `ex-{index}` or `we-{index}`. */
  index: number;
  level: Difficulty;
  seed: string;
  /** Fingerprints already taken; a source must not return a repeat. */
  exclude: ReadonlySet<Fingerprint>;
}

/** An unverified question as a source produced it: structured math only. Never trusted until admitted. */
export interface RawItem {
  id: string;
  role: "example" | "exercise";
  problem: unknown;
  solution: unknown;
  steps: unknown;
}

export interface ItemSource {
  readonly name: string;
  draw(request: ItemRequest): Promise<RawItem>;
}

declare const verified: unique symbol;

/** A question that passed the gate at `level`. Only `admitItem` produces one. */
export interface VerifiedItem {
  readonly [verified]: true;
  readonly id: string;
  readonly level: Difficulty;
  readonly question: Question;
  readonly fingerprint: Fingerprint;
  readonly contentHash: string;
}

/** Question ids: `ex-N` for exercises and `we-N` for worked examples (the builder's numbering), N a positive integer up to 6 digits. */
const ITEM_ID = /^(ex|we)-[1-9]\d{0,5}$/;

/**
 * Does the structured question look like one drawn at `level`? Only what is checkable from the question itself is
 * checked (the generator's readability rules, see its header): challenge questions have a fractional answer or
 * coefficient, the others have integer ones, and basic questions use the one-sided form with 2 <= a <= 9.
 */
function consistentWithLevel(q: Question, level: Difficulty): boolean {
  const challenge = isChallengeLevel(q.problem, q.solution);
  if (level === "challenge") return challenge;
  if (challenge) return false;
  if (level === "mixed") return true;
  if (q.problem.form !== "ax+b=c") return false;
  const a = Rational.tryParse(q.problem.params.a ?? "");
  return a !== null && a.den === 1n && a.num >= 2n && a.num <= 9n;
}

/** Throws ItemRejected (code ITEM_REJECTED) unless `raw` is well-formed structured math the validator verifies. */
export function admitItem(raw: RawItem, level: Difficulty): VerifiedItem {
  const parsed = QuestionSchema.safeParse(raw);
  if (!parsed.success) throw new ItemRejected("malformed_item");
  const idMatch = ITEM_ID.exec(parsed.data.id);
  if (!idMatch || idMatch[1] !== (parsed.data.role === "example" ? "we" : "ex")) throw new ItemRejected("bad_id");
  if (!consistentWithLevel(parsed.data, level)) throw new ItemRejected("level_mismatch");
  const report = validateLinearQuestion(parsed.data);
  if (report.status !== "verified") throw new ItemRejected(`not_verified:${report.status}`);
  return {
    id: parsed.data.id,
    level,
    question: parsed.data,
    fingerprint: questionFingerprint(parsed.data),
    contentHash: contentHashOf(parsed.data),
  } as VerifiedItem;
}

/** The deterministic generator as an item source: one question at exactly the requested level (no ramp). */
export const deterministicLinearSource: ItemSource = {
  name: "deterministic-linear",
  async draw({ role, index, level, seed, exclude }) {
    const [q] = generateExerciseSet({ jobSeed: seed, count: 1, difficulty: level, idPrefix: role === "example" ? "we" : "ex", startIndex: index, exclude, ramp: false });
    if (!q) throw new ItemRejected("no_item_drawn");
    return { id: q.id, role, problem: q.problem, solution: q.solution, steps: q.steps };
  },
};
