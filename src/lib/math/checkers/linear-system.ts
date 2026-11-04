/**
 * Checker (3): two linear equations in the same two variables, solved exactly by Cramer's rule. A zero
 * determinant separates parallel lines (no solution) from one repeated line (infinitely many).
 */
import { readPairAnswer, readTextAnswer } from "@/lib/math/checkers/answer";
import { claimExprNode } from "@/lib/math/checkers/bind";
import { ANSWER_UNREADABLE, CLAIM_UNREADABLE, verdict } from "@/lib/math/checkers/outcomes";
import {
  linearCoef,
  polyDegree,
  polyFromNode,
  polySub,
  polyVars,
  splitRelation,
  univariateCoef,
  type Poly,
} from "@/lib/math/checkers/poly";
import type { AnswerDoc, Claim, CheckOutcome } from "@/lib/math/checkers/types";
import type { Rational } from "@/lib/math/rational";
import type { MathTextDoc } from "@/lib/math-text";

type SystemClaim = Extract<Claim, { kind: "linear_system" }>;

export type SystemSolution =
  | { kind: "unique"; values: [Rational, Rational] }
  | { kind: "no_solution" }
  | { kind: "identity" };

/** lhs - rhs as a polynomial of degree exactly 1: `0 = 1` and `xy = 1` are not linear equations. */
function asLinearEquation(doc: MathTextDoc): Poly | null {
  const node = claimExprNode(doc);
  const relation = node === null ? null : splitRelation(node, ["="]);
  if (relation === null) return null;
  const lhs = polyFromNode(relation.lhs);
  const rhs = lhs === null ? null : polyFromNode(relation.rhs);
  if (lhs === null || rhs === null) return null;
  const difference = polySub(lhs, rhs);
  return difference === null || polyDegree(difference) !== 1 ? null : difference;
}

/** The exact solution and the two variable names in alphabetical order, or null outside this claim's shape. */
export function solveSystem(claim: SystemClaim): { variables: [string, string]; solution: SystemSolution } | null {
  const first = asLinearEquation(claim.exprs[0]);
  const second = asLinearEquation(claim.exprs[1]);
  if (first === null || second === null) return null;
  const names = [...new Set([...polyVars(first), ...polyVars(second)])].sort();
  if (names.length !== 2) return null;
  const [x, y] = [names[0]!, names[1]!];
  const row = (p: Poly) => ({ a: linearCoef(p, x), b: linearCoef(p, y), c: univariateCoef(p, x, 0).neg() });
  const [p, q] = [row(first), row(second)];
  const determinant = p.a.mul(q.b).sub(q.a.mul(p.b));
  const forX = p.c.mul(q.b).sub(q.c.mul(p.b));
  const forY = p.a.mul(q.c).sub(q.a.mul(p.c));
  const variables: [string, string] = [x, y];
  if (!determinant.isZero()) {
    return { variables, solution: { kind: "unique", values: [forX.div(determinant), forY.div(determinant)] } };
  }
  const consistent = forX.isZero() && forY.isZero();
  return { variables, solution: { kind: consistent ? "identity" : "no_solution" } };
}

export function checkLinearSystem(claim: SystemClaim, answer: AnswerDoc): CheckOutcome {
  const solved = solveSystem(claim);
  if (solved === null) return CLAIM_UNREADABLE;
  const { variables, solution } = solved;

  if (answer.kind === "text") {
    const token = readTextAnswer(answer.value);
    if (token === null) return ANSWER_UNREADABLE;
    const expected = solution.kind === "no_solution" ? "none" : solution.kind === "identity" ? "all" : null;
    return verdict(token === expected, "linear_system");
  }
  const stated = readPairAnswer(answer.value);
  if (stated === null) return ANSWER_UNREADABLE;
  if (stated.labels !== null && (stated.labels[0] !== variables[0] || stated.labels[1] !== variables[1])) {
    return ANSWER_UNREADABLE;
  }
  if (solution.kind !== "unique") return verdict(false, "linear_system");
  const agrees = solution.values[0].eq(stated.values[0]) && solution.values[1].eq(stated.values[1]);
  return verdict(agrees, "linear_system");
}
