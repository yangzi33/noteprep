import { canonicalJson, sha256Hex } from "@/lib/domain/hash";
import {
  applyOperation,
  isOperationType,
  sameLinear,
  sameSolution,
  satisfies,
  solve,
  ZeroOperandError,
  type Linear,
  type Solution,
} from "./linear";
import { Rational, withinLimits } from "./rational";
import { QuestionSchema, type Equation, type Problem, type Side } from "./schema";

export const VALIDATOR_VERSION = "linear-1var/0.1.0";

export type ValidationStatus = "verified" | "failed" | "unverified";
export type CheckResult = "pass" | "fail" | "skipped" | "not_applicable";

export interface Check {
  name: string;
  result: CheckResult;
  /** Short machine-readable detail; never contains lesson prose. */
  detail?: string;
  /**
   * Supplementary evidence (a model's second opinion, random numeric sampling). It can only RAISE a
   * concern; it can never make a question verified (docs/architecture.md section 7.4).
   */
  supplementary?: boolean;
}

export interface ItemReport {
  questionId: string;
  status: ValidationStatus;
  checks: Check[];
  limitations: string[];
  /** Hash of the content that was validated; a different hash means this report is stale. */
  contentHash: string;
  validatorVersion: string;
}

export const LIMITATIONS = ["narration text is not validated", "only exact one-variable linear equations are covered"];

const SUPPORTED_FORMS = ["ax+b=c", "ax+b=cx+d"] as const;

/** Every deterministic check a fully verified question must have run. */
const REQUIRED_CHECKS = [
  "params_domain",
  "equation_matches_params",
  "exact_solve",
  "answer_key_match",
  "substitution",
  "step_equivalence",
  "final_form",
] as const;

// --- status derivation ----------------------------------------------------------------------------

/**
 * The status comes from deterministic checks only:
 *  - any failed deterministic check            -> failed
 *  - otherwise any required check not run      -> unverified (partial coverage)
 *  - otherwise                                 -> verified
 * Supplementary checks cannot promote anything; a failed one demotes `verified` to `unverified`.
 */
export function deriveStatus(checks: readonly Check[]): ValidationStatus {
  const deterministic = checks.filter((c) => !c.supplementary);
  if (deterministic.some((c) => c.result === "fail")) return "failed";
  const ran = new Set(deterministic.filter((c) => c.result === "pass" || c.result === "not_applicable").map((c) => c.name));
  const covered = REQUIRED_CHECKS.every((name) => ran.has(name));
  if (!covered) return "unverified";
  if (checks.some((c) => c.supplementary && c.result === "fail")) return "unverified";
  return "verified";
}

/** Attaches supplementary evidence and recomputes the status. */
export function withSupplementary(report: ItemReport, extra: readonly Omit<Check, "supplementary">[]): ItemReport {
  const checks = [...report.checks, ...extra.map((c) => ({ ...c, supplementary: true }))];
  return { ...report, checks, status: deriveStatus(checks) };
}

export function contentHashOf(q: { problem?: unknown; solution?: unknown; steps?: unknown }): string {
  return `sha256:${sha256Hex(canonicalJson({ problem: q.problem, solution: q.solution, steps: q.steps }))}`;
}

/** A stored report only counts for the exact content it was computed from. */
export function currentStatus(report: ItemReport, q: { problem?: unknown; solution?: unknown; steps?: unknown }): ValidationStatus {
  return report.contentHash === contentHashOf(q) ? report.status : "unverified";
}

// --- helpers --------------------------------------------------------------------------------------

class InvalidNumber extends Error {}

function parseNumber(text: string): Rational {
  const r = Rational.tryParse(text);
  if (!r) throw new InvalidNumber("not_exact_rational");
  if (!withinLimits(r)) throw new InvalidNumber("out_of_range");
  return r;
}

function sideToLinear(side: Side): Linear {
  return { a: Rational.sum(side.x.map(parseNumber)), b: Rational.sum(side.c.map(parseNumber)) };
}

function equationToLinear(eq: Equation): { lhs: Linear; rhs: Linear } {
  return { lhs: sideToLinear(eq.lhs), rhs: sideToLinear(eq.rhs) };
}

function sameList(parsed: readonly Rational[], expected: readonly Rational[]): boolean {
  return parsed.length === expected.length && parsed.every((r, i) => r.eq(expected[i]!));
}

/** The equation that the parameters of a supported form imply, written as lists of terms. */
function expectedEquation(form: string, p: Record<string, Rational>): { lhsX: Rational[]; lhsC: Rational[]; rhsX: Rational[]; rhsC: Rational[] } {
  const g = (k: string) => p[k]!;
  return form === "ax+b=c"
    ? { lhsX: [g("a")], lhsC: [g("b")], rhsX: [], rhsC: [g("c")] }
    : { lhsX: [g("a")], lhsC: [g("b")], rhsX: [g("c")], rhsC: [g("d")] };
}

function requiredParams(form: string): string[] {
  return form === "ax+b=c" ? ["a", "b", "c"] : ["a", "b", "c", "d"];
}

function unverifiedReport(id: string, hash: string, reason: string): ItemReport {
  const checks: Check[] = [{ name: "supported_type", result: "fail", detail: reason }];
  // A structurally unsupported question is unverified by definition; it is never a "failed" one.
  return { questionId: id, status: "unverified", checks, limitations: LIMITATIONS, contentHash: hash, validatorVersion: VALIDATOR_VERSION };
}

// --- the validator --------------------------------------------------------------------------------

/**
 * Independently re-derives everything about one question and reports what could be proven:
 * parameters and domain, the equation implied by the parameters, the exact solution, the claimed
 * answer, substitution into the original equation, equivalence of every step, and the final form.
 * Unknown shapes are unverified; wrong math is failed; unchecked coverage is unverified.
 */
export function validateLinearQuestion(raw: unknown): ItemReport {
  const hash = contentHashOf(
    raw && typeof raw === "object"
      ? (raw as { problem?: unknown; solution?: unknown; steps?: unknown })
      : { problem: raw, solution: null, steps: null },
  );
  const rawId = raw && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : "unknown";

  const parsed = QuestionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      questionId: rawId,
      status: "failed",
      checks: [{ name: "schema", result: "fail", detail: "malformed_question" }],
      limitations: LIMITATIONS,
      contentHash: hash,
      validatorVersion: VALIDATOR_VERSION,
    };
  }
  const q = parsed.data;
  const problem: Problem = q.problem;

  // Unsupported problem types and forms are not wrong; they are simply not covered.
  if (problem.type !== "linear_one_var") return unverifiedReport(q.id, hash, "unsupported_problem_type");
  if (!(SUPPORTED_FORMS as readonly string[]).includes(problem.form)) return unverifiedReport(q.id, hash, "unsupported_form");
  for (const step of q.steps) {
    if (!isOperationType(step.op.type)) return unverifiedReport(q.id, hash, "unsupported_operation");
  }
  if (q.solution.kind !== "unique" && q.solution.kind !== "no_solution" && q.solution.kind !== "identity") {
    return unverifiedReport(q.id, hash, "unsupported_solution_kind");
  }

  const checks: Check[] = [];
  const add = (name: string, result: CheckResult, detail?: string) => checks.push({ name, result, ...(detail ? { detail } : {}) });
  const finish = (): ItemReport => ({
    questionId: q.id,
    status: deriveStatus(checks),
    checks,
    limitations: LIMITATIONS,
    contentHash: hash,
    validatorVersion: VALIDATOR_VERSION,
  });
  const skipRest = (from: number) => {
    for (const name of REQUIRED_CHECKS.slice(from)) add(name, "skipped", "earlier_check_failed");
  };

  // 1. parameters: exact numbers, in range, the right keys, and a nonzero leading coefficient for ax+b=c
  const needed = requiredParams(problem.form);
  const keys = Object.keys(problem.params);
  let params: Record<string, Rational> = {};
  let lhs: Linear;
  let rhs: Linear;
  try {
    if (keys.length !== needed.length || !needed.every((k) => keys.includes(k))) throw new InvalidNumber("wrong_parameter_set");
    params = Object.fromEntries(needed.map((k) => [k, parseNumber(problem.params[k]!)]));
    if (problem.form === "ax+b=c" && params.a!.isZero()) throw new InvalidNumber("zero_leading_coefficient");
    ({ lhs, rhs } = equationToLinear(problem.equation));
  } catch (error) {
    add("params_domain", "fail", error instanceof InvalidNumber ? error.message : "invalid");
    skipRest(1);
    return finish();
  }
  add("params_domain", "pass");

  // 2. the written equation must be exactly what the parameters imply
  const expected = expectedEquation(problem.form, params);
  const eq = problem.equation;
  const matches =
    sameList(eq.lhs.x.map(parseNumber), expected.lhsX) &&
    sameList(eq.lhs.c.map(parseNumber), expected.lhsC) &&
    sameList(eq.rhs.x.map(parseNumber), expected.rhsX) &&
    sameList(eq.rhs.c.map(parseNumber), expected.rhsC);
  add("equation_matches_params", matches ? "pass" : "fail", matches ? undefined : "equation_differs_from_parameters");

  // 3. the exact solution, derived from the equation alone
  const truth: Solution = solve(lhs, rhs);
  add("exact_solve", "pass", truth.kind === "unique" ? `x=${truth.value.toString()}` : truth.kind);

  // 4. the claimed answer must be that solution
  let claimed: Solution | null = null;
  try {
    claimed =
      q.solution.kind === "unique"
        ? { kind: "unique", value: parseNumber(q.solution.value ?? "") }
        : ({ kind: q.solution.kind } as Solution);
  } catch {
    add("answer_key_match", "fail", "answer_not_exact_rational");
  }
  if (claimed) add("answer_key_match", sameSolution(claimed, truth) ? "pass" : "fail", sameSolution(claimed, truth) ? undefined : "answer_differs_from_solution");

  // 5. substitution into the ORIGINAL equation (only meaningful for a unique solution)
  if (truth.kind === "unique") add("substitution", satisfies(lhs, rhs, truth.value) ? "pass" : "fail", "x=solution");
  else add("substitution", "not_applicable", truth.kind);

  // 6. every step: the declared operation applied to the previous state must give the stated result, with
  //    a nonzero multiplier/divisor, and must not change the solution set
  if (q.steps.length === 0) {
    add("step_equivalence", "skipped", "no_steps");
    add("final_form", "skipped", "no_steps");
    return finish();
  }
  const ids = new Set<string>();
  let prev = { lhs, rhs };
  let stepsOk = true;
  let failure = "";
  for (const step of q.steps) {
    if (ids.has(step.id)) {
      stepsOk = false;
      failure = `duplicate_step_id:${step.id}`;
      break;
    }
    ids.add(step.id);
    try {
      const value = parseNumber(step.op.value);
      const next = equationToLinear(step.result);
      const applied = applyOperation(prev.lhs, prev.rhs, step.op.type as never, value);
      if (!sameLinear(applied.lhs, next.lhs) || !sameLinear(applied.rhs, next.rhs)) throw new InvalidNumber("result_mismatch");
      if (!sameSolution(solve(prev.lhs, prev.rhs), solve(next.lhs, next.rhs))) throw new InvalidNumber("solution_changed");
      prev = next;
    } catch (error) {
      stepsOk = false;
      failure = `${step.id}:${error instanceof ZeroOperandError ? "zero_operand" : error instanceof InvalidNumber ? error.message : "invalid"}`;
      break;
    }
  }
  add("step_equivalence", stepsOk ? "pass" : "fail", stepsOk ? `${q.steps.length}/${q.steps.length}` : failure);
  if (!stepsOk) {
    add("final_form", "skipped", "step_failed");
    return finish();
  }

  // 7. the last line must state the result in a recognizable final form that agrees with the truth
  const finalA = prev.lhs.a.sub(prev.rhs.a);
  let finalOk: boolean;
  if (truth.kind === "unique") {
    finalOk = prev.lhs.a.eq(Rational.ONE) && prev.lhs.b.isZero() && prev.rhs.a.isZero() && prev.rhs.b.eq(truth.value);
  } else if (finalA.isZero()) {
    const holds = prev.lhs.b.eq(prev.rhs.b);
    finalOk = truth.kind === "identity" ? holds : !holds;
  } else {
    finalOk = false;
  }
  add("final_form", finalOk ? "pass" : "fail", finalOk ? undefined : "last_step_does_not_state_the_result");
  return finish();
}

// --- whole-lesson validation ----------------------------------------------------------------------

export interface LessonMathInput {
  workedExamples: unknown[];
  exercises: { id: string; problem: unknown }[];
  answerKey: { questionId: string; solution: unknown; steps: unknown }[];
}

export interface SetCheck {
  name: string;
  result: "pass" | "fail";
  detail?: string;
}

export interface LessonMathReport {
  overall: ValidationStatus;
  items: ItemReport[];
  setChecks: SetCheck[];
  validatorVersion: string;
}

/** Joins exercises with their answer-key entries by id, validates everything, and aggregates. */
export function validateLessonMath(lesson: LessonMathInput): LessonMathReport {
  const setChecks: SetCheck[] = [];
  const items: ItemReport[] = [];

  const exampleIds = lesson.workedExamples.map((e) => (e && typeof e === "object" ? (e as { id?: unknown }).id : undefined));
  const exerciseIds = lesson.exercises.map((e) => e.id);
  const answerIds = lesson.answerKey.map((a) => a.questionId);
  const all = [...exampleIds, ...exerciseIds];
  const duplicates = all.filter((id, i) => all.indexOf(id) !== i);
  setChecks.push(duplicates.length === 0 ? { name: "question_ids_unique", result: "pass" } : { name: "question_ids_unique", result: "fail", detail: String(duplicates[0]) });
  const dupAnswers = answerIds.filter((id, i) => answerIds.indexOf(id) !== i);
  setChecks.push(dupAnswers.length === 0 ? { name: "answer_ids_unique", result: "pass" } : { name: "answer_ids_unique", result: "fail", detail: String(dupAnswers[0]) });
  const orphans = answerIds.filter((id) => !exerciseIds.includes(id));
  setChecks.push(orphans.length === 0 ? { name: "no_orphan_answers", result: "pass" } : { name: "no_orphan_answers", result: "fail", detail: orphans[0] });

  for (const example of lesson.workedExamples) items.push(validateLinearQuestion({ ...(example as object), role: "example" }));

  for (const exercise of lesson.exercises) {
    const answer = lesson.answerKey.find((a) => a.questionId === exercise.id);
    if (!answer) {
      items.push({
        questionId: exercise.id,
        status: "failed",
        checks: [{ name: "answer_present", result: "fail", detail: "no_answer_key_entry" }],
        limitations: LIMITATIONS,
        contentHash: contentHashOf({ problem: exercise.problem, solution: null, steps: null }),
        validatorVersion: VALIDATOR_VERSION,
      });
      continue;
    }
    items.push(validateLinearQuestion({ id: exercise.id, role: "exercise", problem: exercise.problem, solution: answer.solution, steps: answer.steps }));
  }

  const anyFailed = items.some((i) => i.status === "failed") || setChecks.some((c) => c.result === "fail");
  const overall: ValidationStatus = anyFailed ? "failed" : items.length === 0 || items.some((i) => i.status === "unverified") ? "unverified" : "verified";
  return { overall, items, setChecks, validatorVersion: VALIDATOR_VERSION };
}
