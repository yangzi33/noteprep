/**
 * The two exact evaluators the checkers share: `evalRational` for closed numeric expressions and
 * `evalSurdSet` for stated roots, which may carry `\pm` and one square root. Both are total.
 */
import { POLY_LIMITS, polyAsRational, polyFromNode } from "@/lib/math/checkers/poly";
import { Surd } from "@/lib/math/checkers/surd";
import { Rational } from "@/lib/math/rational";
import type { MathNode } from "@/lib/math-text";

/** A closed numeric expression as an exact rational, or null for variables, relations, inexact roots, /0. */
export function evalRational(node: MathNode): Rational | null {
  const poly = polyFromNode(node);
  return poly === null ? null : polyAsRational(poly);
}

/** At most this many alternatives from `\pm`: two signs per value is all school answers need. */
const MAX_ALTERNATIVES = 4;

interface Budget {
  nodes: number;
}

function combine(a: Surd[], b: Surd[], f: (x: Surd, y: Surd) => Surd | null): Surd[] | null {
  if (a.length * b.length > MAX_ALTERNATIVES) return null;
  const out: Surd[] = [];
  for (const x of a) {
    for (const y of b) {
      const value = f(x, y);
      if (value === null) return null;
      out.push(value);
    }
  }
  return out;
}

function mapAll(values: Surd[], f: (x: Surd) => Surd | null): Surd[] | null {
  const out: Surd[] = [];
  for (const value of values) {
    const next = f(value);
    if (next === null) return null;
    out.push(next);
  }
  return out;
}

function walk(node: MathNode, depth: number, budget: Budget): Surd[] | null {
  if (depth > POLY_LIMITS.maxDepth) return null;
  if (++budget.nodes > POLY_LIMITS.maxNodes) return null;
  switch (node.t) {
    case "num":
    case "abs": {
      const value = evalRational(node);
      const surd = value === null ? null : Surd.rational(value);
      return surd === null ? null : [surd];
    }
    case "group":
      return walk(node.body, depth + 1, budget);
    case "unary": {
      const arg = walk(node.arg, depth + 1, budget);
      if (arg === null) return null;
      if (node.op === "+") return arg;
      if (node.op === "-") return mapAll(arg, (x) => x.neg());
      const negated = mapAll(arg, (x) => x.neg());
      if (negated === null || arg.length + negated.length > MAX_ALTERNATIVES) return null;
      return [...arg, ...negated];
    }
    case "bin": {
      const l = walk(node.l, depth + 1, budget);
      const r = l === null ? null : walk(node.r, depth + 1, budget);
      if (l === null || r === null) return null;
      switch (node.op) {
        case "+":
          return combine(l, r, (x, y) => x.add(y));
        case "-":
          return combine(l, r, (x, y) => x.sub(y));
        case "pm": {
          const plus = combine(l, r, (x, y) => x.add(y));
          const minus = combine(l, r, (x, y) => x.sub(y));
          if (plus === null || minus === null || plus.length + minus.length > MAX_ALTERNATIVES) return null;
          return [...plus, ...minus];
        }
        case "times":
        case "cdot":
          return combine(l, r, (x, y) => x.mul(y));
        case "div":
        case "/":
          return combine(l, r, (x, y) => x.div(y));
      }
      return null;
    }
    case "imp": {
      let acc: Surd[] | null = [Surd.rational(Rational.ONE)!];
      for (const item of node.items) {
        const next: Surd[] | null = acc === null ? null : walk(item, depth + 1, budget);
        acc = next === null || acc === null ? null : combine(acc, next, (x, y) => x.mul(y));
        if (acc === null) return null;
      }
      return acc;
    }
    case "frac": {
      const num = walk(node.num, depth + 1, budget);
      const den = num === null ? null : walk(node.den, depth + 1, budget);
      if (num === null || den === null) return null;
      return combine(num, den, (x, y) => x.div(y));
    }
    case "pct": {
      const arg = walk(node.arg, depth + 1, budget);
      const hundred = Surd.rational(Rational.of(100n))!;
      return arg === null ? null : mapAll(arg, (x) => x.div(hundred));
    }
    case "sqrt": {
      const radicand = evalRational(node.body);
      if (radicand === null) return null;
      let index = 2;
      if (node.index !== undefined) {
        const indexValue = evalRational(node.index);
        if (indexValue === null || indexValue.den !== 1n) return null;
        index = Number(indexValue.num);
      }
      const root = Surd.sqrtOfRational(radicand, index);
      return root === null ? null : [root];
    }
    case "sup": {
      const base = walk(node.base, depth + 1, budget);
      const exponent = evalRational(node.exp);
      if (base === null || exponent === null || exponent.den !== 1n) return null;
      const times = Number(exponent.num);
      if (!Number.isInteger(times) || times < 0 || times > POLY_LIMITS.maxExponent) return null;
      return mapAll(base, (x) => {
        let acc: Surd | null = Surd.rational(Rational.ONE);
        for (let i = 0; i < times && acc !== null; i++) acc = acc.mul(x);
        return acc;
      });
    }
    default:
      return null; // var, rel, list, greek, ldots, sub, deg, fn
  }
}

/** The alternatives a stated root expression denotes (one, or two when it carries `\pm`), or null. */
export function evalSurdSet(node: MathNode): Surd[] | null {
  const values = walk(node, 1, { nodes: 0 });
  return values === null || values.length === 0 ? null : values;
}
