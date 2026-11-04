/**
 * Checker (4): bounded exact numeric claims — a closed expression, a percentage, combinations and permutations,
 * arithmetic and geometric terms and sums (closed forms, never loops over n), and a polynomial evaluated at a
 * point. Every count has a hard bound and every result stays inside the magnitude bound.
 */
import { readNumberAnswer } from "@/lib/math/checkers/answer";
import { claimExprNode } from "@/lib/math/checkers/bind";
import { ANSWER_UNREADABLE, CLAIM_UNREADABLE, verdict } from "@/lib/math/checkers/outcomes";
import { numStrToRational, polyDegree, polyFromNode, polyVars, splitRelation, univariateCoef } from "@/lib/math/checkers/poly";
import { withinMagnitude } from "@/lib/math/checkers/surd";
import { evalRational } from "@/lib/math/checkers/numeric";
import type { AnswerDoc, Claim, CheckOutcome } from "@/lib/math/checkers/types";
import { Rational } from "@/lib/math/rational";
import type { MathNode } from "@/lib/math-text";

const NUMERIC_KINDS = [
  "evaluate",
  "percent_of",
  "nCr",
  "nPr",
  "arithmetic_term",
  "arithmetic_sum",
  "geometric_term",
  "geometric_sum",
  "poly_value",
] as const;

export type NumericClaimKind = (typeof NUMERIC_KINDS)[number];
export type NumericClaim = Extract<Claim, { kind: NumericClaimKind }>;

export function isNumericClaimKind(kind: Claim["kind"]): kind is NumericClaimKind {
  return (NUMERIC_KINDS as readonly string[]).includes(kind);
}

const LIMITS = { maxCountingN: 60, maxGeometricN: 40, maxPolyDegree: 6 } as const;

function bounded(value: Rational | null): Rational | null {
  return value !== null && withinMagnitude(value) ? value : null;
}

function power(base: Rational, times: number): Rational | null {
  let acc = Rational.ONE;
  for (let i = 0; i < times; i++) {
    acc = acc.mul(base);
    if (!withinMagnitude(acc)) return null;
  }
  return acc;
}

function combinations(n: number, r: number): Rational | null {
  if (r > n - r) return combinations(n, n - r);
  let acc = 1n;
  for (let i = 1n; i <= BigInt(r); i++) {
    acc = (acc * (BigInt(n) - BigInt(r) + i)) / i;
    if (!withinMagnitude(Rational.of(acc))) return null;
  }
  return Rational.of(acc);
}

function permutations(n: number, r: number): Rational | null {
  let acc = 1n;
  for (let i = 0; i < r; i++) {
    acc *= BigInt(n - i);
    if (!withinMagnitude(Rational.of(acc))) return null;
  }
  return Rational.of(acc);
}

/** `f(x)` as the pair of names, so a claim about `f(x) = ...` can be tied to its variable. */
function functionArgument(node: MathNode): string | null {
  if (node.t !== "imp" || node.items.length !== 2) return null;
  const [name, argument] = node.items;
  if (name?.t !== "var" || argument?.t !== "group" || argument.open !== "(" || argument.body.t !== "var") return null;
  return argument.body.name;
}

function polyValue(claim: Extract<Claim, { kind: "poly_value" }>): Rational | null {
  const node = claimExprNode(claim.expr);
  if (node === null) return null;
  let body = node;
  let variable: string | null = null;
  if (node.t === "rel") {
    const relation = splitRelation(node, ["="]);
    if (relation === null) return null;
    variable = functionArgument(relation.lhs);
    if (variable === null) return null;
    body = relation.rhs;
  }
  const poly = polyFromNode(body);
  if (poly === null || polyDegree(poly) > LIMITS.maxPolyDegree) return null;
  const names = polyVars(poly);
  if (variable === null) {
    if (names.length !== 1) return null;
    variable = names[0]!;
  } else if (names.some((name) => name !== variable)) {
    return null;
  }
  const at = numStrToRational(claim.at);
  if (at === null) return null;
  let total = Rational.ZERO;
  for (let degree = 0; degree <= LIMITS.maxPolyDegree; degree++) {
    const coefficient = univariateCoef(poly, variable, degree);
    if (coefficient.isZero()) continue;
    const term = power(at, degree);
    if (term === null) return null;
    total = total.add(coefficient.mul(term));
    if (!withinMagnitude(total)) return null;
  }
  return total;
}

/** What the claim asserts the answer is, or null when the claim is outside this checker's bounds or shape. */
export function expectedValue(claim: NumericClaim): Rational | null {
  switch (claim.kind) {
    case "evaluate": {
      const node = claimExprNode(claim.expr);
      if (node === null || node.t === "rel") return null;
      return bounded(evalRational(node));
    }
    case "percent_of": {
      const percent = numStrToRational(claim.percent);
      const whole = numStrToRational(claim.whole);
      if (percent === null || whole === null) return null;
      return bounded(percent.div(Rational.of(100n)).mul(whole));
    }
    case "nCr":
    case "nPr": {
      const { n, r } = claim;
      if (n > LIMITS.maxCountingN || r > n) return null;
      return claim.kind === "nCr" ? combinations(n, r) : permutations(n, r);
    }
    case "arithmetic_term":
    case "arithmetic_sum":
    case "geometric_term":
    case "geometric_sum": {
      const first = numStrToRational(claim.first);
      const step = numStrToRational(claim.step);
      const n = claim.n;
      if (first === null || step === null || n < 1) return null;
      const terms = Rational.of(BigInt(n));
      const before = Rational.of(BigInt(n - 1));
      if (claim.kind === "arithmetic_term") return bounded(first.add(before.mul(step)));
      if (claim.kind === "arithmetic_sum") {
        const twice = first.mul(Rational.of(2n)).add(before.mul(step));
        return bounded(terms.div(Rational.of(2n)).mul(twice));
      }
      if (n > LIMITS.maxGeometricN) return null;
      if (claim.kind === "geometric_term") {
        const factor = power(step, n - 1);
        return factor === null ? null : bounded(first.mul(factor));
      }
      if (step.eq(Rational.ONE)) return bounded(terms.mul(first));
      const grown = power(step, n);
      if (grown === null) return null;
      return bounded(first.mul(grown.sub(Rational.ONE)).div(step.sub(Rational.ONE)));
    }
    case "poly_value":
      return bounded(polyValue(claim));
  }
}

export function checkNumeric(claim: NumericClaim, answer: AnswerDoc): CheckOutcome {
  const expected = expectedValue(claim);
  if (expected === null) return CLAIM_UNREADABLE;
  const stated = readNumberAnswer(answer.value);
  if (stated === null) return ANSWER_UNREADABLE;
  return verdict(expected.eq(stated.value), "numeric");
}
