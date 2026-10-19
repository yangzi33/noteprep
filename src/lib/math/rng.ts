import { sha256Hex } from "@/lib/domain/hash";

/**
 * Deterministic random integers from a string seed. Each draw hashes `seed|counter` with SHA-256, so
 * results are identical on every platform and Node version (no Math.random, no floating point) and a
 * retried job regenerates exactly the same questions. Ranges are sampled by rejection, so there is no
 * modulo bias.
 */
export class Rng {
  private counter = 0;

  constructor(private readonly seed: string) {}

  /** 48 random bits as a bigint. */
  private bits(): bigint {
    return BigInt(`0x${sha256Hex(`${this.seed}|${this.counter++}`).slice(0, 12)}`);
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError("bad integer range");
    const span = BigInt(max - min + 1);
    const space = 1n << 48n;
    const limit = space - (space % span); // largest multiple of span that fits: values above it are rejected
    for (;;) {
      const v = this.bits();
      if (v < limit) return min + Number(v % span);
    }
  }

  /** Uniform integer in [min, max] excluding the listed values. */
  intExcluding(min: number, max: number, excluded: readonly number[]): number {
    const allowed = max - min + 1 - excluded.filter((e) => e >= min && e <= max).length;
    if (allowed <= 0) throw new RangeError("no value left to draw");
    for (;;) {
      const v = this.int(min, max);
      if (!excluded.includes(v)) return v;
    }
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("nothing to pick from");
    return items[this.int(0, items.length - 1)]!;
  }

  /** True with probability numerator/denominator. */
  chance(numerator: number, denominator: number): boolean {
    return this.int(0, denominator - 1) < numerator;
  }
}
