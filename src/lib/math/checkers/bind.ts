/**
 * The binding rule: a checker may only prove something about what the tutor can actually see. An expression
 * operand must be structurally equal to a math span the stem displays; a numeric operand must occur as a
 * number in the stem.
 *
 * Numeric operands are signed: a negative operand must be displayed negated (a unary minus or a `-` before the
 * digits). The operands of the sequence kinds (first term, step or ratio, count) must also occur in that order,
 * each at its own position, because they are not interchangeable. Two deliberate limitations remain, both of which
 * can leave a checker proving something other than the question's actual task (the outcome is then a `pass` on an
 * item whose stated answer is not the answer to the stem):
 * - for the commutative kinds (percent_of) and nCr/nPr numeric binding is presence only: a claim about `25` and
 *   `80` binds to "What is 25% of 80?" and equally to "What is 80% of 25?";
 * - an expression operand must equal a whole math span (or one item of a comma-list span), so it cannot be a
 *   fragment of a displayed expression, but in a stem that displays several spans it may equal the wrong one.
 * Binding therefore rules out claims about content the stem never shows; it does not establish that the claim
 * is the question. What it does guarantee is that a wrong answer to a bound, readable claim always fails.
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

/** Children in reading order. Key order is not used: stored documents round-trip through jsonb, which reorders keys. */
function children(node: MathNode): MathNode[] {
  switch (node.t) {
    case "bin": return [node.l, node.r];
    case "imp":
    case "list": return node.items;
    case "unary":
    case "pct":
    case "deg": return [node.arg];
    case "rel": return [node.first, ...node.rest.map((r) => r.rhs)];
    case "group":
    case "abs": return [node.body];
    case "frac": return [node.num, node.den];
    case "sqrt": return node.index === undefined ? [node.body] : [node.index, node.body];
    case "sup": return [node.base, node.exp];
    case "sub": return [node.base, node.sub];
    case "fn": return node.base === undefined ? [node.arg] : [node.base, node.arg];
    default: return [];
  }
}

function collectNumbers(root: MathNode, into: string[], budget: { nodes: number }): void {
  const visit = (node: MathNode, negated: boolean): void => {
    if (++budget.nodes > MAX_STEM_NODES) return;
    if (node.t === "num") {
      const value = numLiteralToRational(node.v);
      if (value !== null) into.push((negated ? value.neg() : value).toString());
      return;
    }
    if (node.t === "unary" && node.op === "-" && node.arg.t === "num") {
      visit(node.arg, true);
      return;
    }
    for (const child of children(node)) visit(child, false);
  };
  visit(root, false);
}

/** Every number the stem displays, in reading order, as exact signed rationals: `num` nodes (a unary minus negates) plus digit runs in text. */
export function stemNumbers(stem: MathTextDoc): string[] {
  const numbers: string[] = [];
  const budget = { nodes: 0 };
  for (const part of stem.parts) {
    if (part.t === "math") {
      collectNumbers(part.m, numbers, budget);
      continue;
    }
    for (const match of part.s.matchAll(/(-?)(\d+(?:\.\d+)?)/g)) {
      const value = numLiteralToRational(match[2]!);
      if (value !== null) numbers.push((match[1] === "-" ? value.neg() : value).toString());
    }
  }
  return numbers;
}

function operandKey(operand: string | number): string | null {
  const value = typeof operand === "number" ? Rational.of(BigInt(operand)) : numStrToRational(operand);
  return value === null ? null : value.toString();
}

/** The operand occurs in the stem with its sign. */
function hasNumber(numbers: readonly string[], operand: string | number): boolean {
  const key = operandKey(operand);
  return key !== null && numbers.includes(key);
}

/** The operands occur in the stem in this order, each at its own position, with their signs. */
function hasNumbersInOrder(numbers: readonly string[], operands: readonly (string | number)[]): boolean {
  let from = 0;
  for (const operand of operands) {
    const key = operandKey(operand);
    if (key === null) return false;
    const at = numbers.indexOf(key, from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
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
      return hasNumbersInOrder(numbers, [claim.first, claim.step, claim.n]);
  }
}
