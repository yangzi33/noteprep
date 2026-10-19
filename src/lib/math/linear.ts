import { Rational } from "./rational";

/** a·x + b */
export interface Linear {
  a: Rational;
  b: Rational;
}

export type Solution = { kind: "unique"; value: Rational } | { kind: "no_solution" } | { kind: "identity" };

/** Solves lhs = rhs exactly by comparing coefficients; there is no search and no numeric approximation. */
export function solve(lhs: Linear, rhs: Linear): Solution {
  const a = lhs.a.sub(rhs.a);
  const b = rhs.b.sub(lhs.b);
  if (a.isZero()) return b.isZero() ? { kind: "identity" } : { kind: "no_solution" };
  return { kind: "unique", value: b.div(a) };
}

export function sameSolution(p: Solution, q: Solution): boolean {
  if (p.kind !== q.kind) return false;
  return p.kind !== "unique" || (q.kind === "unique" && p.value.eq(q.value));
}

export function evaluate(f: Linear, x: Rational): Rational {
  return f.a.mul(x).add(f.b);
}

/** Does the claimed value satisfy the original equation, side by side? */
export function satisfies(lhs: Linear, rhs: Linear, x: Rational): boolean {
  return evaluate(lhs, x).eq(evaluate(rhs, x));
}

export type OperationType = "add_const_both_sides" | "add_x_term_both_sides" | "multiply_both_sides" | "divide_both_sides";

export const OPERATION_TYPES: readonly OperationType[] = [
  "add_const_both_sides",
  "add_x_term_both_sides",
  "multiply_both_sides",
  "divide_both_sides",
];

export function isOperationType(type: string): type is OperationType {
  return (OPERATION_TYPES as readonly string[]).includes(type);
}

export class ZeroOperandError extends Error {
  constructor() {
    super("multiplying or dividing both sides by zero");
    this.name = "ZeroOperandError";
  }
}

/**
 * What the equation must look like (as sums) after applying `type` with `value` to both sides.
 * Multiplying or dividing by zero is rejected: it would not preserve the solution set.
 */
export function applyOperation(lhs: Linear, rhs: Linear, type: OperationType, value: Rational): { lhs: Linear; rhs: Linear } {
  switch (type) {
    case "add_const_both_sides":
      return { lhs: { a: lhs.a, b: lhs.b.add(value) }, rhs: { a: rhs.a, b: rhs.b.add(value) } };
    case "add_x_term_both_sides":
      return { lhs: { a: lhs.a.add(value), b: lhs.b }, rhs: { a: rhs.a.add(value), b: rhs.b } };
    case "multiply_both_sides":
      if (value.isZero()) throw new ZeroOperandError();
      return { lhs: { a: lhs.a.mul(value), b: lhs.b.mul(value) }, rhs: { a: rhs.a.mul(value), b: rhs.b.mul(value) } };
    case "divide_both_sides":
      if (value.isZero()) throw new ZeroOperandError();
      return { lhs: { a: lhs.a.div(value), b: lhs.b.div(value) }, rhs: { a: rhs.a.div(value), b: rhs.b.div(value) } };
  }
}

export function sameLinear(p: Linear, q: Linear): boolean {
  return p.a.eq(q.a) && p.b.eq(q.b);
}
