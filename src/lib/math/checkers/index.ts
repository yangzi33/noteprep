/**
 * The five exact code checkers (docs/.../slice-b-llm-items-design.md 5.3). A checker re-derives the final
 * answer of an item from a claim that is bound to the displayed stem, with exact integer and rational
 * arithmetic over a restricted AST: no `eval`, no `Function`, no floating point and no CAS.
 *
 * `runChecker` is total and bounded. Only two of its outcomes are conclusive: `pass` (the checker re-derived
 * the stated answer) and `fail` (it derived a different one). Everything else is `none` with a reason, which
 * leaves the item unchecked and therefore labelled, never silently accepted.
 */
import {
  readInequalityAnswer,
  readNumberAnswer,
  readPairAnswer,
  readRootsAnswer,
  readTextAnswer,
} from "@/lib/math/checkers/answer";
import { bindsToStem } from "@/lib/math/checkers/bind";
import { checkLinearEquation } from "@/lib/math/checkers/linear-equation";
import { checkLinearInequality } from "@/lib/math/checkers/linear-inequality";
import { checkLinearSystem } from "@/lib/math/checkers/linear-system";
import { checkNumeric, isNumericClaimKind, type NumericClaim } from "@/lib/math/checkers/numeric-claims";
import { ANSWER_UNREADABLE, CLAIM_UNBOUND, CLAIM_UNREADABLE, NO_CLAIM } from "@/lib/math/checkers/outcomes";
import { checkQuadraticEquation } from "@/lib/math/checkers/quadratic-equation";
import { ClaimSchema, type AnswerDoc, type AnswerKind, type Claim, type CheckOutcome } from "@/lib/math/checkers/types";
import type { Rational } from "@/lib/math/rational";
import { isMathTextDoc, type MathTextDoc } from "@/lib/math-text";

export * from "@/lib/math/checkers/types";
export { bindsToStem } from "@/lib/math/checkers/bind";

const NUMERIC_ANSWER_KINDS: readonly AnswerKind[] = ["number", "expression"];

const ANSWER_KINDS_BY_CLAIM: Record<Claim["kind"], readonly AnswerKind[]> = {
  linear_equation: ["number", "text"],
  quadratic_equation: ["roots", "text"],
  linear_system: ["pair", "text"],
  linear_inequality: ["inequality", "text"],
  evaluate: NUMERIC_ANSWER_KINDS,
  percent_of: NUMERIC_ANSWER_KINDS,
  nCr: NUMERIC_ANSWER_KINDS,
  nPr: NUMERIC_ANSWER_KINDS,
  arithmetic_term: NUMERIC_ANSWER_KINDS,
  arithmetic_sum: NUMERIC_ANSWER_KINDS,
  geometric_term: NUMERIC_ANSWER_KINDS,
  geometric_sum: NUMERIC_ANSWER_KINDS,
  poly_value: NUMERIC_ANSWER_KINDS,
};

/** Which stated-answer kinds a claim of this kind can be checked against; anything else is not readable. */
export function answerKindsFor(claimKind: Claim["kind"]): readonly AnswerKind[] {
  return ANSWER_KINDS_BY_CLAIM[claimKind] ?? [];
}

function decide(input: { stem: MathTextDoc; answer: AnswerDoc; claim: Claim | undefined }): CheckOutcome {
  const { stem, answer, claim } = input;
  if (claim === undefined || claim === null) return NO_CLAIM;
  if (!ClaimSchema.safeParse(claim).success) return CLAIM_UNREADABLE;
  if (!isMathTextDoc(stem) || !bindsToStem(stem, claim)) return CLAIM_UNBOUND;
  if (answer === null || typeof answer !== "object") return ANSWER_UNREADABLE;
  if (!answerKindsFor(claim.kind).includes(answer.kind)) return ANSWER_UNREADABLE;
  switch (claim.kind) {
    case "linear_equation":
      return checkLinearEquation(claim, answer);
    case "quadratic_equation":
      return checkQuadraticEquation(claim, answer);
    case "linear_system":
      return checkLinearSystem(claim, answer);
    case "linear_inequality":
      return checkLinearInequality(claim, answer);
    default:
      return isNumericClaimKind(claim.kind) ? checkNumeric(claim as NumericClaim, answer) : CLAIM_UNREADABLE;
  }
}

/**
 * Decision order: no claim, then binding, then the answer kind, then the claim's shape and bounds, then
 * whether the stated answer can be read, and only then the comparison. A readable, bound claim whose stated
 * answer is wrong is always `fail`: that is the outcome that keeps a wrong answer off the page.
 */
export function runChecker(input: { stem: MathTextDoc; answer: AnswerDoc; claim: Claim | undefined }): CheckOutcome {
  try {
    return decide(input);
  } catch {
    return CLAIM_UNREADABLE;
  }
}

function rationalKey(value: Rational): string {
  return `${value.num}/${value.den}`;
}

/**
 * One canonical string per readable answer, for comparing two independent model answers by code (`cross_checked`).
 * Two answers agree exactly when both strings are non-null and equal; the caller makes that comparison.
 */
export function canonicalAnswer(answer: AnswerDoc): string | null {
  try {
    switch (answer.kind) {
      case "number":
      case "expression": {
        const stated = readNumberAnswer(answer.value);
        return stated === null ? null : `n:${rationalKey(stated.value)}`;
      }
      case "roots": {
        const stated = readRootsAnswer(answer.value);
        if (stated === null) return null;
        return `roots:${[...new Set(stated.values.map((root) => root.key()))].sort().join("|")}`;
      }
      case "pair": {
        const stated = readPairAnswer(answer.value);
        return stated === null ? null : `pair:${rationalKey(stated.values[0])},${rationalKey(stated.values[1])}`;
      }
      case "inequality": {
        const stated = readInequalityAnswer(answer.value);
        return stated === null ? null : `ineq:${stated.op}:${rationalKey(stated.bound)}`;
      }
      case "text": {
        const token = readTextAnswer(answer.value);
        return token === null ? null : `text:${token}`;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
