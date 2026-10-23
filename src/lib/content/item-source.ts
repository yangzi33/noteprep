import { ItemRejected } from "@/lib/domain/errors";
import { generateExerciseSet, questionFingerprint, type Difficulty } from "@/lib/math/generator";
import { QuestionSchema, type Question } from "@/lib/math/schema";
import { contentHashOf, validateLinearQuestion } from "@/lib/math/validate";

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

/** Throws ItemRejected (code ITEM_REJECTED) unless `raw` is well-formed structured math the validator verifies. */
export function admitItem(raw: RawItem, level: Difficulty): VerifiedItem {
  const parsed = QuestionSchema.safeParse(raw);
  if (!parsed.success) throw new ItemRejected("malformed_item");
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
