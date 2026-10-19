/**
 * Exact rational numbers on BigInt. There is no floating point anywhere in the math kernel: every
 * comparison is exact equality of normalized fractions (docs/architecture.md section 7).
 */
export class Rational {
  private constructor(
    readonly num: bigint,
    readonly den: bigint,
  ) {}

  static readonly ZERO = new Rational(0n, 1n);
  static readonly ONE = new Rational(1n, 1n);

  static of(num: bigint, den: bigint = 1n): Rational {
    if (den === 0n) throw new RangeError("zero denominator");
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num < 0n ? -num : num, den);
    return g > 1n ? new Rational(num / g, den / g) : new Rational(num, den);
  }

  /** Accepts only `p` or `p/q` with integer p and positive integer q; no decimals, exponents or spaces. */
  static parse(text: string): Rational {
    const match = /^(-?(?:0|[1-9]\d*))(?:\/([1-9]\d*))?$/.exec(text);
    if (!match) throw new RangeError("not an exact rational");
    return Rational.of(BigInt(match[1]!), match[2] ? BigInt(match[2]) : 1n);
  }

  /** Like parse, but returns null instead of throwing. */
  static tryParse(text: string): Rational | null {
    try {
      return Rational.parse(text);
    } catch {
      return null;
    }
  }

  add(o: Rational): Rational {
    return Rational.of(this.num * o.den + o.num * this.den, this.den * o.den);
  }
  sub(o: Rational): Rational {
    return Rational.of(this.num * o.den - o.num * this.den, this.den * o.den);
  }
  mul(o: Rational): Rational {
    return Rational.of(this.num * o.num, this.den * o.den);
  }
  /** Division by zero is an error, never an Infinity or NaN. */
  div(o: Rational): Rational {
    if (o.isZero()) throw new RangeError("division by zero");
    return Rational.of(this.num * o.den, this.den * o.num);
  }
  neg(): Rational {
    return new Rational(-this.num, this.den);
  }
  isZero(): boolean {
    return this.num === 0n;
  }
  eq(o: Rational): boolean {
    return this.num === o.num && this.den === o.den; // normalized, so equality is componentwise
  }
  toString(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }

  static sum(values: readonly Rational[]): Rational {
    return values.reduce((acc, v) => acc.add(v), Rational.ZERO);
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Bounds on every number that may appear in a question or step; keeps content small and readable. */
export const NUMBER_LIMITS = { maxAbsNumerator: 1_000_000n, maxDenominator: 1_000n } as const;

export function withinLimits(r: Rational): boolean {
  const abs = r.num < 0n ? -r.num : r.num;
  return abs <= NUMBER_LIMITS.maxAbsNumerator && r.den <= NUMBER_LIMITS.maxDenominator;
}
