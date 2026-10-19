import { Rational } from "@/lib/math/rational";
import type { ClaimedSolution, Equation, Side, Step } from "@/lib/math/schema";
import { RenderError } from "./escape";

/**
 * Math enters a document only here, built from validated numbers and a fixed vocabulary. A value that is not an exact
 * rational, or an operation or solution kind the renderer does not know, is a RenderError: nothing is ever copied
 * through as text.
 */
const rational = (text: string): Rational => {
  const r = Rational.tryParse(text);
  if (!r) throw new RenderError("bad_number");
  return r;
};

const abs = (r: Rational): Rational => (r.num < 0n ? r.neg() : r);
const isNegative = (r: Rational) => r.num < 0n;

/** A non-negative rational: "5" or "\frac{3}{4}". */
function magnitude(r: Rational): string {
  const a = abs(r);
  return a.den === 1n ? a.num.toString() : `\\frac{${a.num}}{${a.den}}`;
}

/** A coefficient of x without the sign: 1 -> "x", 3 -> "3x", 3/4 -> "\frac{3}{4}x". */
function xBody(r: Rational): string {
  const a = abs(r);
  return a.eq(Rational.ONE) ? "x" : `${magnitude(a)}x`;
}

export function numberTex(text: string): string {
  const r = rational(text);
  return `${isNegative(r) ? "-" : ""}${magnitude(r)}`;
}

function sideTex(side: Side): string {
  const terms = [
    ...side.x.map((c) => ({ r: rational(c), isX: true })),
    ...side.c.map((c) => ({ r: rational(c), isX: false })),
  ].filter((t) => !t.r.isZero());
  if (terms.length === 0) return "0";
  return terms
    .map((t, i) => {
      const body = t.isX ? xBody(t.r) : magnitude(t.r);
      if (i === 0) return `${isNegative(t.r) ? "-" : ""}${body}`;
      return `${isNegative(t.r) ? " - " : " + "}${body}`;
    })
    .join("");
}

/** The equation as math content (no dollar signs). */
export function equationTex(equation: Equation): string {
  return `${sideTex(equation.lhs)} = ${sideTex(equation.rhs)}`;
}

/** An instruction like "Subtract $5$ from both sides", with its math built from the step's validated value. */
export function operationText(op: Step["op"]): string {
  const v = rational(op.value);
  switch (op.type) {
    case "add_const_both_sides":
      return isNegative(v) ? `Subtract $${magnitude(v)}$ from both sides` : `Add $${magnitude(v)}$ to both sides`;
    case "add_x_term_both_sides":
      return isNegative(v) ? `Subtract $${xBody(v)}$ from both sides` : `Add $${xBody(v)}$ to both sides`;
    case "multiply_both_sides":
      return `Multiply both sides by $${numberTex(op.value)}$`;
    case "divide_both_sides":
      return `Divide both sides by $${numberTex(op.value)}$`;
    default:
      throw new RenderError("unknown_operation");
  }
}

/** The final answer line, in text with inline math. */
export function solutionText(solution: ClaimedSolution): string {
  switch (solution.kind) {
    case "unique":
      if (solution.value === undefined) throw new RenderError("missing_solution_value");
      return `$x = ${numberTex(solution.value)}$`;
    case "no_solution":
      return "No solution: the equation is never true.";
    case "identity":
      return "Every number is a solution: the equation is always true.";
    default:
      throw new RenderError("unknown_solution_kind");
  }
}
