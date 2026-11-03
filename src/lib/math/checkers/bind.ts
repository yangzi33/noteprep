/**
 * The binding rule: a checker may only prove something about what the tutor can actually see. An expression
 * operand must be structurally equal to a math span the stem displays; a numeric operand must occur as a
 * number in the stem.
 *
 * Limitation, deliberate: numeric binding is presence only, not position or role. A claim about `25` and `80`
 * binds to "What is 25% of 80?" and equally to "What is 80% of 25?", so the numeric checkers are protected
 * against invented numbers but not against a swapped reading of the stem. Expression operands carry the full
 * structure and are therefore the strong case.
 */
import { Rational } from "@/lib/math/rational";
import type { MathNode, MathTextDoc } from "@/lib/math-text";
import { numLiteralToRational, numStrToRational } from "@/lib/math/checkers/poly";
import type { Claim } from "@/lib/math/checkers/types";

const MAX_STEM_NODES = 8000;

function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (k) => Object.hasOwn(b, k) && sameData((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** The one math node of a claim expression operand (the schema admits exactly one math part). */
export function claimExprNode(doc: MathTextDoc): MathNode | null {
  const part = doc.parts.length === 1 ? doc.parts[0] : undefined;
  return part !== undefined && part.t === "math" ? part.m : null;
}

/** Everything a claim expression may equal: each math span, plus each item of a comma list span. */
function stemSpans(stem: MathTextDoc): MathNode[] {
  const spans: MathNode[] = [];
  for (const part of stem.parts) {
    if (part.t !== "math") continue;
    spans.push(part.m);
    if (part.m.t === "list") spans.push(...part.m.items);
  }
  return spans;
}

function collectNumbers(node: MathNode, into: Set<string>, budget: { nodes: number }): void {
  const stack: MathNode[] = [node];
  while (stack.length > 0) {
    if (++budget.nodes > MAX_STEM_NODES) return;
    const current = stack.pop()!;
    if (current.t === "num") {
      const value = numLiteralToRational(current.v);
      if (value !== null) into.add(value.toString());
      continue;
    }
    for (const value of Object.values(current)) {
      if (typeof value === "object" && value !== null) stack.push(...(Array.isArray(value) ? value : [value as MathNode]));
    }
  }
}

/** Every number the stem displays, as exact non-negative rationals: `num` nodes plus digit runs in text. */
export function stemNumbers(stem: MathTextDoc): Set<string> {
  const numbers = new Set<string>();
  const budget = { nodes: 0 };
  for (const part of stem.parts) {
    if (part.t === "math") {
      collectNumbers(part.m, numbers, budget);
      continue;
    }
    for (const match of part.s.matchAll(/\d+(?:\.\d+)?/g)) {
      const value = numLiteralToRational(match[0]);
      if (value !== null) numbers.add(value.toString());
    }
  }
  return numbers;
}

function hasNumber(numbers: Set<string>, operand: string | number): boolean {
  const value = typeof operand === "number" ? Rational.of(BigInt(operand)) : numStrToRational(operand);
  if (value === null) return false;
  return numbers.has((value.num < 0n ? value.neg() : value).toString());
}

/** Does the claim only speak about expressions and numbers the stem displays? */
export function bindsToStem(stem: MathTextDoc, claim: Claim): boolean {
  const spans = stemSpans(stem);
  const matches = (doc: MathTextDoc): number[] => {
    const node = claimExprNode(doc);
    if (node === null) return [];
    return spans.flatMap((span, index) => (sameData(span, node) ? [index] : []));
  };
  const numbers = stemNumbers(stem);

  switch (claim.kind) {
    case "linear_equation":
    case "quadratic_equation":
    case "linear_inequality":
    case "evaluate":
      return matches(claim.expr).length > 0;
    case "poly_value":
      return matches(claim.expr).length > 0 && hasNumber(numbers, claim.at);
    case "linear_system": {
      const first = matches(claim.exprs[0]);
      const second = matches(claim.exprs[1]);
      return first.some((i) => second.some((j) => i !== j));
    }
    case "percent_of":
      return hasNumber(numbers, claim.percent) && hasNumber(numbers, claim.whole);
    case "nCr":
    case "nPr":
      return hasNumber(numbers, claim.n) && hasNumber(numbers, claim.r);
    case "arithmetic_term":
    case "arithmetic_sum":
    case "geometric_term":
    case "geometric_sum":
      return hasNumber(numbers, claim.first) && hasNumber(numbers, claim.step) && hasNumber(numbers, claim.n);
  }
}
