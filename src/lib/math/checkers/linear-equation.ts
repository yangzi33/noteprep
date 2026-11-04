/** Checker (1): a linear equation in one variable, solved exactly through `src/lib/math/linear.ts`. */
import { readNumberAnswer, readTextAnswer } from "@/lib/math/checkers/answer";
import { claimExprNode } from "@/lib/math/checkers/bind";
import { ANSWER_UNREADABLE, CLAIM_UNREADABLE, verdict } from "@/lib/math/checkers/outcomes";
import { linearCoef, polyDegree, polyFromNode, polyVars, splitRelation, univariateCoef } from "@/lib/math/checkers/poly";
import type { AnswerDoc, Claim, CheckOutcome } from "@/lib/math/checkers/types";
import { solve, type Solution } from "@/lib/math/linear";

type LinearEquationClaim = Extract<Claim, { kind: "linear_equation" }>;

/** The equation's exact solution and its variable, or null when the claim is not of this shape. */
export function solveClaim(claim: LinearEquationClaim): { variable: string; solution: Solution } | null {
  const node = claimExprNode(claim.expr);
  const relation = node === null ? null : splitRelation(node, ["="]);
  if (relation === null) return null;
  const lhs = polyFromNode(relation.lhs);
  const rhs = lhs === null ? null : polyFromNode(relation.rhs);
  if (lhs === null || rhs === null) return null;
  const variables = new Set([...polyVars(lhs), ...polyVars(rhs)]);
  if (variables.size !== 1 || polyDegree(lhs) > 1 || polyDegree(rhs) > 1) return null;
  const variable = [...variables][0]!;
  const side = (p: typeof lhs) => ({ a: linearCoef(p, variable), b: univariateCoef(p, variable, 0) });
  return { variable, solution: solve(side(lhs), side(rhs)) };
}

export function checkLinearEquation(claim: LinearEquationClaim, answer: AnswerDoc): CheckOutcome {
  const solved = solveClaim(claim);
  if (solved === null) return CLAIM_UNREADABLE;
  const { variable, solution } = solved;

  if (answer.kind === "text") {
    const token = readTextAnswer(answer.value);
    if (token === null) return ANSWER_UNREADABLE;
    const expected = solution.kind === "no_solution" ? "none" : solution.kind === "identity" ? "all" : null;
    return verdict(token === expected, "linear_equation");
  }
  const stated = readNumberAnswer(answer.value);
  if (stated === null || (stated.label !== null && stated.label !== variable)) return ANSWER_UNREADABLE;
  return verdict(solution.kind === "unique" && solution.value.eq(stated.value), "linear_equation");
}
