/**
 * Checker (5): one linear inequality in one variable. Dividing by a negative coefficient flips the direction,
 * and strict and non-strict are never interchangeable. Interval notation is not a supported answer form.
 */
import { readInequalityAnswer, readTextAnswer, type RelationalOp } from "@/lib/math/checkers/answer";
import { claimExprNode } from "@/lib/math/checkers/bind";
import { ANSWER_UNREADABLE, CLAIM_UNREADABLE, verdict } from "@/lib/math/checkers/outcomes";
import { linearCoef, polyDegree, polyFromNode, polyVars, splitRelation, univariateCoef } from "@/lib/math/checkers/poly";
import type { AnswerDoc, Claim, CheckOutcome } from "@/lib/math/checkers/types";
import type { Rational } from "@/lib/math/rational";

type InequalityClaim = Extract<Claim, { kind: "linear_inequality" }>;

const OPS: readonly RelationalOp[] = ["<", ">", "le", "ge"];
const FLIP: Record<RelationalOp, RelationalOp> = { "<": ">", ">": "<", le: "ge", ge: "le" };

export type SolutionSet = { kind: "half_line"; op: RelationalOp; bound: Rational } | { kind: "all" } | { kind: "empty" };

/** Is `0 op value` true? Used when the variable cancels. */
function holdsAtZero(op: RelationalOp, value: Rational): boolean {
  switch (op) {
    case "<":
      return value.num > 0n;
    case ">":
      return value.num < 0n;
    case "le":
      return value.num >= 0n;
    case "ge":
      return value.num <= 0n;
  }
}

/** The exact solution set and the variable, or null outside this claim's shape. */
export function solveInequality(claim: InequalityClaim): { variable: string; set: SolutionSet } | null {
  const node = claimExprNode(claim.expr);
  const relation = node === null ? null : splitRelation(node, OPS);
  if (relation === null) return null;
  const lhs = polyFromNode(relation.lhs);
  const rhs = lhs === null ? null : polyFromNode(relation.rhs);
  if (lhs === null || rhs === null) return null;
  const variables = new Set([...polyVars(lhs), ...polyVars(rhs)]);
  if (variables.size !== 1 || polyDegree(lhs) > 1 || polyDegree(rhs) > 1) return null;
  const variable = [...variables][0]!;
  // a*x op c, with a = lhs - rhs coefficient and c the constants moved to the right.
  const a = linearCoef(lhs, variable).sub(linearCoef(rhs, variable));
  const c = univariateCoef(rhs, variable, 0).sub(univariateCoef(lhs, variable, 0));
  if (a.isZero()) return { variable, set: holdsAtZero(relation.op, c) ? { kind: "all" } : { kind: "empty" } };
  const op = a.num < 0n ? FLIP[relation.op] : relation.op;
  return { variable, set: { kind: "half_line", op, bound: c.div(a) } };
}

export function checkLinearInequality(claim: InequalityClaim, answer: AnswerDoc): CheckOutcome {
  const solved = solveInequality(claim);
  if (solved === null) return CLAIM_UNREADABLE;
  const { variable, set } = solved;

  if (answer.kind === "text") {
    const token = readTextAnswer(answer.value);
    if (token === null) return ANSWER_UNREADABLE;
    const expected = set.kind === "empty" ? "none" : set.kind === "all" ? "all" : null;
    return verdict(token === expected, "linear_inequality");
  }
  const stated = readInequalityAnswer(answer.value);
  if (stated === null || stated.variable !== variable) return ANSWER_UNREADABLE;
  if (set.kind !== "half_line") return verdict(false, "linear_inequality");
  return verdict(stated.op === set.op && stated.bound.eq(set.bound), "linear_inequality");
}
