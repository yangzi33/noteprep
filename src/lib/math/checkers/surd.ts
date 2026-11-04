/**
 * Exact arithmetic in one real quadratic field Q(sqrt d): the smallest value domain that can hold the
 * roots of a rational quadratic without floating point. Every operation is total and returns null when
 * the result leaves the field (two different radicands) or the magnitude bound.
 */
import { Rational } from "@/lib/math/rational";

/** Every intermediate numerator and denominator stays below this; past it a checker reports no check. */
export const MAX_MAGNITUDE = 10n ** 30n;

/** Radicands above this are only accepted when they are perfect powers: squarefree extraction is bounded work. */
export const MAX_RADICAND = 1_000_000_000n;

export function withinMagnitude(r: Rational): boolean {
  const abs = r.num < 0n ? -r.num : r.num;
  return abs < MAX_MAGNITUDE && r.den < MAX_MAGNITUDE;
}

/** Exact k-th root of a non-negative integer, or null when it is not a perfect k-th power. */
export function exactIntegerRoot(n: bigint, k: number): bigint | null {
  if (n < 0n) return null;
  if (n < 2n) return n;
  let lo = 1n;
  let hi = 2n;
  while (hi ** BigInt(k) <= n) hi *= 2n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (mid ** BigInt(k) < n) lo = mid + 1n;
    else hi = mid;
  }
  return lo ** BigInt(k) === n ? lo : null;
}

/** m = c^2 * d with d squarefree; only called for m <= MAX_RADICAND, so the trial division is bounded. */
function extractSquareFactor(m: bigint): { c: bigint; d: bigint } {
  let rest = Number(m);
  let c = 1;
  for (let i = 2; i * i <= rest; i++) {
    const sq = i * i;
    while (rest % sq === 0) {
      rest /= sq;
      c *= i;
    }
  }
  return { c: BigInt(c), d: BigInt(rest) };
}

/** u + v*sqrt(d), with d a squarefree integer > 1; a rational value always has v = 0 and d = 1. */
export class Surd {
  private constructor(
    readonly u: Rational,
    readonly v: Rational,
    readonly d: bigint,
  ) {}

  private static make(u: Rational, v: Rational, d: bigint): Surd | null {
    if (!withinMagnitude(u) || !withinMagnitude(v)) return null;
    return v.isZero() ? new Surd(u, Rational.ZERO, 1n) : new Surd(u, v, d);
  }

  static rational(r: Rational): Surd | null {
    return Surd.make(r, Rational.ZERO, 1n);
  }

  /** The exact `index`-th root of a non-negative rational, as a rational, or (for index 2) as c*sqrt(d). */
  static sqrtOfRational(r: Rational, index: number): Surd | null {
    if (!Number.isInteger(index) || index < 2 || index > 4) return null;
    if (r.num < 0n) return null;
    if (r.isZero()) return Surd.rational(Rational.ZERO);
    const rootNum = exactIntegerRoot(r.num, index);
    const rootDen = exactIntegerRoot(r.den, index);
    if (rootNum !== null && rootDen !== null) return Surd.rational(Rational.of(rootNum, rootDen));
    if (index !== 2) return null;
    // sqrt(p/q) = sqrt(p*q)/q
    const m = r.num * r.den;
    if (m > MAX_RADICAND) return null;
    const { c, d } = extractSquareFactor(m);
    if (d <= 1n) return Surd.rational(Rational.of(c, r.den));
    return Surd.make(Rational.ZERO, Rational.of(c, r.den), d);
  }

  isRational(): boolean {
    return this.v.isZero();
  }

  isZero(): boolean {
    return this.u.isZero() && this.v.isZero();
  }

  /** The shared radicand of two values, or null when both are irrational with different radicands. */
  private shared(o: Surd): bigint | null {
    if (this.isRational()) return o.d;
    if (o.isRational()) return this.d;
    return this.d === o.d ? this.d : null;
  }

  add(o: Surd): Surd | null {
    const d = this.shared(o);
    return d === null ? null : Surd.make(this.u.add(o.u), this.v.add(o.v), d);
  }

  sub(o: Surd): Surd | null {
    const d = this.shared(o);
    return d === null ? null : Surd.make(this.u.sub(o.u), this.v.sub(o.v), d);
  }

  neg(): Surd | null {
    return Surd.make(this.u.neg(), this.v.neg(), this.d);
  }

  mul(o: Surd): Surd | null {
    const d = this.shared(o);
    if (d === null) return null;
    const dr = Rational.of(d);
    const u = this.u.mul(o.u).add(this.v.mul(o.v).mul(dr));
    const v = this.u.mul(o.v).add(o.u.mul(this.v));
    return Surd.make(u, v, d);
  }

  div(o: Surd): Surd | null {
    if (o.isZero()) return null;
    const d = this.shared(o);
    if (d === null) return null;
    // Multiply by the conjugate: the norm u^2 - v^2 d is zero only for the zero value, since d is squarefree.
    const norm = o.u.mul(o.u).sub(o.v.mul(o.v).mul(Rational.of(d)));
    if (norm.isZero()) return null;
    const conj = Surd.make(o.u, o.v.neg(), d);
    const product = conj === null ? null : this.mul(conj);
    if (product === null) return null;
    return Surd.make(product.u.div(norm), product.v.div(norm), d);
  }

  eq(o: Surd): boolean {
    return this.u.eq(o.u) && this.v.eq(o.v) && this.d === o.d;
  }

  asRational(): Rational | null {
    return this.isRational() ? this.u : null;
  }

  /** Canonical, collision-free string; used for set comparison and for `canonicalAnswer`. */
  key(): string {
    return `${this.u.num}/${this.u.den}+${this.v.num}/${this.v.den}r${this.d}`;
  }
}
