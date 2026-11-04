/**
 * MathText AST to a sparse polynomial with exact rational coefficients. This is the only normalisation the
 * checkers use: it is not a CAS (no factoring, no simplification of variable denominators, no functions) and
 * every path is total — an unsupported shape, an unbounded exponent or a magnitude overflow returns null.
 */
import { Surd, withinMagnitude } from "@/lib/math/checkers/surd";
import { Rational } from "@/lib/math/rational";
import type { MathNode } from "@/lib/math-text";

export const POLY_LIMITS = { maxDegree: 12, maxTerms: 64, maxExponent: 12, maxNodes: 5000, maxDepth: 256 } as const;

/** Monomial keys: "" for the constant term, otherwise `x^1` or `x^2*y^1` with variable names sorted. */
export interface Poly {
  readonly terms: ReadonlyMap<string, Rational>;
}

function monoKey(vars: ReadonlyMap<string, number>): string {
  return [...vars.entries()]
    .filter(([, e]) => e > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, e]) => `${n}^${e}`)
    .join("*");
}

function monoVars(key: string): Map<string, number> {
  const vars = new Map<string, number>();
  if (key === "") return vars;
  for (const piece of key.split("*")) {
    const [name, exp] = piece.split("^");
    vars.set(name!, Number(exp));
  }
  return vars;
}

function monoDegree(key: string): number {
  let total = 0;
  for (const exp of monoVars(key).values()) total += exp;
  return total;
}

/** Drops zero coefficients and enforces the term, degree and magnitude bounds. */
function build(terms: Map<string, Rational>): Poly | null {
  const out = new Map<string, Rational>();
  for (const [key, coef] of terms) {
    if (coef.isZero()) continue;
    if (!withinMagnitude(coef)) return null;
    if (monoDegree(key) > POLY_LIMITS.maxDegree) return null;
    out.set(key, coef);
  }
  return out.size > POLY_LIMITS.maxTerms ? null : { terms: out };
}

export function constPoly(value: Rational): Poly | null {
  return build(new Map([["", value]]));
}

export function polyAdd(a: Poly, b: Poly): Poly | null {
  const terms = new Map(a.terms);
  for (const [key, coef] of b.terms) terms.set(key, (terms.get(key) ?? Rational.ZERO).add(coef));
  return build(terms);
}

export function polySub(a: Poly, b: Poly): Poly | null {
  const terms = new Map(a.terms);
  for (const [key, coef] of b.terms) terms.set(key, (terms.get(key) ?? Rational.ZERO).sub(coef));
  return build(terms);
}

export function polyNeg(a: Poly): Poly | null {
  const terms = new Map<string, Rational>();
  for (const [key, coef] of a.terms) terms.set(key, coef.neg());
  return build(terms);
}

export function polyMul(a: Poly, b: Poly): Poly | null {
  if (a.terms.size * b.terms.size > POLY_LIMITS.maxTerms * POLY_LIMITS.maxTerms) return null;
  const terms = new Map<string, Rational>();
  for (const [ka, ca] of a.terms) {
    for (const [kb, cb] of b.terms) {
      const vars = monoVars(ka);
      for (const [name, exp] of monoVars(kb)) vars.set(name, (vars.get(name) ?? 0) + exp);
      const key = monoKey(vars);
      if (monoDegree(key) > POLY_LIMITS.maxDegree) return null;
      const next = (terms.get(key) ?? Rational.ZERO).add(ca.mul(cb));
      if (!withinMagnitude(next)) return null;
      terms.set(key, next);
    }
  }
  return build(terms);
}

function polyPow(base: Poly, exponent: number): Poly | null {
  if (!Number.isInteger(exponent) || Math.abs(exponent) > POLY_LIMITS.maxExponent) return null;
  if (exponent < 0) {
    const value = polyAsRational(base);
    if (value === null || value.isZero()) return null;
    const inverse = Rational.ONE.div(value);
    let acc = Rational.ONE;
    for (let i = 0; i < -exponent; i++) {
      acc = acc.mul(inverse);
      if (!withinMagnitude(acc)) return null;
    }
    return constPoly(acc);
  }
  if (exponent === 0) {
    const value = polyAsRational(base);
    if (value !== null && value.isZero()) return null; // 0^0 is undefined, never 1
    return constPoly(Rational.ONE);
  }
  let acc = constPoly(Rational.ONE);
  for (let i = 0; i < exponent && acc !== null; i++) acc = polyMul(acc, base);
  return acc;
}

export function polyVars(p: Poly): string[] {
  const names = new Set<string>();
  for (const key of p.terms.keys()) for (const name of monoVars(key).keys()) names.add(name);
  return [...names].sort();
}

export function polyDegree(p: Poly): number {
  let degree = 0;
  for (const key of p.terms.keys()) degree = Math.max(degree, monoDegree(key));
  return degree;
}

export function polyAsRational(p: Poly): Rational | null {
  if (p.terms.size === 0) return Rational.ZERO;
  if (p.terms.size === 1 && p.terms.has("")) return p.terms.get("")!;
  return null;
}

/** Coefficient of `v^k` with no other variable present; the checkers only ask this of univariate polynomials. */
export function univariateCoef(p: Poly, v: string, k: number): Rational {
  return p.terms.get(k === 0 ? "" : `${v}^${k}`) ?? Rational.ZERO;
}

/** Coefficient of a degree-1 monomial in `v` (`x` in `3x - 2y`). */
export function linearCoef(p: Poly, v: string): Rational {
  return p.terms.get(`${v}^1`) ?? Rational.ZERO;
}

export function numLiteralToRational(literal: string): Rational | null {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(literal);
  if (!m) return null;
  const frac = m[2] ?? "";
  return Rational.of(BigInt(m[1]! + frac), 10n ** BigInt(frac.length));
}

/** A signed decimal literal as used by the claim operands (`NumStr`). */
export function numStrToRational(literal: string): Rational | null {
  const negative = literal.startsWith("-");
  const r = numLiteralToRational(negative ? literal.slice(1) : literal);
  return r === null ? null : negative ? r.neg() : r;
}

/** A two-sided relation with exactly one of the accepted operators; a chain (`1 < x < 3`) is refused. */
export function splitRelation<O extends string>(
  node: MathNode,
  ops: readonly O[],
): { op: O; lhs: MathNode; rhs: MathNode } | null {
  if (node.t !== "rel" || node.rest.length !== 1) return null;
  const only = node.rest[0]!;
  const op = ops.find((candidate) => (candidate as string) === only.op);
  return op === undefined ? null : { op, lhs: node.first, rhs: only.rhs };
}

interface Budget {
  nodes: number;
}

function walk(node: MathNode, depth: number, budget: Budget): Poly | null {
  if (depth > POLY_LIMITS.maxDepth) return null;
  if (++budget.nodes > POLY_LIMITS.maxNodes) return null;
  switch (node.t) {
    case "num": {
      const value = numLiteralToRational(node.v);
      return value === null ? null : constPoly(value);
    }
    case "var":
      return /^[A-Za-z]$/.test(node.name) ? build(new Map([[`${node.name}^1`, Rational.ONE]])) : null;
    case "group":
      return walk(node.body, depth + 1, budget);
    case "unary": {
      if (node.op === "pm") return null;
      const arg = walk(node.arg, depth + 1, budget);
      if (arg === null) return null;
      return node.op === "-" ? polyNeg(arg) : arg;
    }
    case "bin": {
      if (node.op === "pm") return null;
      const l = walk(node.l, depth + 1, budget);
      const r = l === null ? null : walk(node.r, depth + 1, budget);
      if (l === null || r === null) return null;
      switch (node.op) {
        case "+":
          return polyAdd(l, r);
        case "-":
          return polySub(l, r);
        case "times":
        case "cdot":
          return polyMul(l, r);
        case "div":
        case "/":
          return divideByConstant(l, r);
      }
      return null;
    }
    case "imp": {
      let acc = constPoly(Rational.ONE);
      for (const item of node.items) {
        const next = acc === null ? null : walk(item, depth + 1, budget);
        acc = next === null || acc === null ? null : polyMul(acc, next);
        if (acc === null) return null;
      }
      return acc;
    }
    case "frac": {
      const num = walk(node.num, depth + 1, budget);
      const den = num === null ? null : walk(node.den, depth + 1, budget);
      if (num === null || den === null) return null;
      return divideByConstant(num, den);
    }
    case "pct": {
      const arg = walk(node.arg, depth + 1, budget);
      const hundred = constPoly(Rational.of(100n));
      return arg === null || hundred === null ? null : divideByConstant(arg, hundred);
    }
    case "abs": {
      const body = walk(node.body, depth + 1, budget);
      const value = body === null ? null : polyAsRational(body);
      if (value === null) return null;
      return constPoly(value.num < 0n ? value.neg() : value);
    }
    case "sup": {
      const base = walk(node.base, depth + 1, budget);
      const exponent = base === null ? null : walk(node.exp, depth + 1, budget);
      const exponentValue = exponent === null ? null : polyAsRational(exponent);
      if (base === null || exponentValue === null || exponentValue.den !== 1n) return null;
      const asNumber = Number(exponentValue.num);
      return Math.abs(asNumber) > POLY_LIMITS.maxExponent ? null : polyPow(base, asNumber);
    }
    case "sqrt": {
      const body = walk(node.body, depth + 1, budget);
      const radicand = body === null ? null : polyAsRational(body);
      if (radicand === null) return null;
      let index = 2;
      if (node.index !== undefined) {
        const indexPoly = walk(node.index, depth + 1, budget);
        const indexValue = indexPoly === null ? null : polyAsRational(indexPoly);
        if (indexValue === null || indexValue.den !== 1n) return null;
        index = Number(indexValue.num);
      }
      const root = Surd.sqrtOfRational(radicand, index)?.asRational() ?? null;
      return root === null ? null : constPoly(root);
    }
    default:
      return null; // rel, list, greek, ldots, sub, deg, fn: not polynomial shapes
  }
}

function divideByConstant(num: Poly, den: Poly): Poly | null {
  const value = polyAsRational(den);
  if (value === null || value.isZero()) return null;
  const inverse = constPoly(Rational.ONE.div(value));
  return inverse === null ? null : polyMul(num, inverse);
}

/** The whole node as a polynomial, or null for any shape outside the supported restricted AST. */
export function polyFromNode(node: MathNode): Poly | null {
  return walk(node, 1, { nodes: 0 });
}
