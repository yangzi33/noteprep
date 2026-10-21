import { Rng } from "./rng";
import { Rational } from "./rational";
import type { Equation, Problem, Question, Step } from "./schema";

/** Bump when output for a given seed changes, so the change is a deliberate, visible decision. */
export const GENERATOR_VERSION = "linear-gen/1";

export type Difficulty = "basic" | "mixed" | "challenge";
export type Form = "ax+b=c" | "ax+b=cx+d";
export type Outcome = "unique" | "no_solution" | "identity";

/**
 * Readability rules per difficulty (documented here and enforced by tests):
 *  basic     one form (ax+b=c); integer coefficients with 2 <= a <= 9; nonzero integer answer in [-10, 10]
 *  mixed     either form; integer coefficients, possibly negative; nonzero integer answer in [-12, 12]
 *  challenge fractional answer with integer coefficients, or a unit-fraction coefficient (a = +-1/q)
 * No question has a zero answer or a coefficient of 1 on x in the original equation, and every number
 * stays far inside the validator's limits.
 */
export interface GenerateOptions {
  /** Question id, for example "ex-1"; step ids are `<id>.s1`, `<id>.s2`, ... */
  id: string;
  difficulty: Difficulty;
  /** Same seed and options, same question. Use `<jobId>:<questionId>`. */
  seed: string;
  form?: Form;
  /** no_solution and identity exist only for the two-sided form. */
  outcome?: Outcome;
}

export interface GeneratedQuestion {
  id: string;
  problem: Problem;
  solution: Question["solution"];
  steps: Step[];
  meta: { generatorVersion: string; difficulty: Difficulty; form: Form; outcome: Outcome; style: string };
}

const R = (n: number | bigint | Rational) => (n instanceof Rational ? n : Rational.of(BigInt(n)));
const s = (r: Rational) => r.toString();

const eq = (lx: Rational[], lc: Rational[], rx: Rational[], rc: Rational[]): Equation => ({
  lhs: { x: lx.map(s), c: lc.map(s) },
  rhs: { x: rx.map(s), c: rc.map(s) },
});

type Op = "add_const_both_sides" | "add_x_term_both_sides" | "multiply_both_sides" | "divide_both_sides";
const OP = {
  addConst: "add_const_both_sides",
  addX: "add_x_term_both_sides",
  mul: "multiply_both_sides",
  div: "divide_both_sides",
} as const satisfies Record<string, Op>;

class Builder {
  steps: Step[] = [];
  constructor(private readonly id: string) {}
  add(type: Op, value: Rational, result: Equation) {
    this.steps.push({ id: `${this.id}.s${this.steps.length + 1}`, op: { type, value: s(value) }, result });
  }
}

/** Ends a worked solution: isolate x from `coef * x = rhs` by the natural operation. */
function isolate(b: Builder, coef: Rational, rhs: Rational) {
  if (coef.eq(Rational.ONE)) return; // nothing left to do
  const reciprocal = Rational.ONE.div(coef);
  const result = Rational.of(rhs.mul(reciprocal).num, rhs.mul(reciprocal).den);
  const solved = eq([Rational.ONE], [], [], [result]);
  if (reciprocal.den === 1n) b.add(OP.mul, reciprocal, solved); // coefficient is +-1/q: multiply by +-q
  else b.add(OP.div, coef, solved); // otherwise divide by the coefficient
}

function solveOneSided(id: string, a: Rational, bb: Rational, c: Rational): Step[] {
  const b = new Builder(id);
  const moved = c.sub(bb);
  b.add(OP.addConst, bb.neg(), eq([a], [], [], [moved]));
  isolate(b, a, moved);
  return b.steps;
}

function solveTwoSided(id: string, a: Rational, bb: Rational, c: Rational, d: Rational): Step[] {
  const b = new Builder(id);
  const coef = a.sub(c);
  b.add(OP.addX, c.neg(), eq([coef], [bb], [], [d]));
  if (coef.isZero()) return b.steps; // x cancelled: the line is a true or false statement about constants
  const moved = d.sub(bb);
  b.add(OP.addConst, bb.neg(), eq([coef], [], [], [moved]));
  isolate(b, coef, moved);
  return b.steps;
}

// --- parameter choice -----------------------------------------------------------------------------------

interface Chosen {
  form: Form;
  style: string;
  params: Record<string, Rational>;
}

function chooseBasic(rng: Rng): Chosen {
  const a = rng.int(2, 9);
  const x0 = rng.intExcluding(-10, 10, [0]);
  const b = rng.intExcluding(-12, 12, [0]);
  return { form: "ax+b=c", style: "integer", params: { a: R(a), b: R(b), c: R(a * x0 + b) } };
}

function chooseMixed(rng: Rng, form: Form): Chosen {
  if (form === "ax+b=c") {
    const a = rng.intExcluding(-9, 9, [0, 1, -1]);
    const x0 = rng.intExcluding(-12, 12, [0]);
    const b = rng.intExcluding(-15, 15, [0]);
    return { form, style: "integer", params: { a: R(a), b: R(b), c: R(a * x0 + b) } };
  }
  const a = rng.intExcluding(-9, 9, [0]);
  const c = rng.intExcluding(-9, 9, [0, a]);
  const x0 = rng.intExcluding(-10, 10, [0]);
  const b = rng.intExcluding(-15, 15, [0]);
  return { form, style: "integer", params: { a: R(a), b: R(b), c: R(c), d: R((a - c) * x0 + b) } };
}

function chooseChallenge(rng: Rng, form: Form): Chosen {
  if (form === "ax+b=c" && rng.chance(1, 2)) {
    // unit-fraction coefficient with an integer answer: (1/q)x + b = c, x a multiple of q
    const q = rng.int(2, 5);
    const sign = rng.chance(1, 2) ? 1 : -1;
    const k = rng.intExcluding(-6, 6, [0]);
    const b = rng.intExcluding(-10, 10, [0]);
    return { form, style: "fraction_coefficient", params: { a: Rational.of(BigInt(sign), BigInt(q)), b: R(b), c: R(sign * k + b) } };
  }
  // integer coefficients with a fractional answer: reject until the quotient is not an integer
  for (let attempt = 0; attempt < 500; attempt++) {
    if (form === "ax+b=c") {
      const a = rng.intExcluding(-9, 9, [0, 1, -1]);
      const b = rng.intExcluding(-12, 12, [0]);
      const c = rng.int(-30, 30);
      if ((c - b) % a !== 0 && c !== b) return { form, style: "fraction_answer", params: { a: R(a), b: R(b), c: R(c) } };
    } else {
      const a = rng.intExcluding(-9, 9, [0]);
      const c = rng.intExcluding(-9, 9, [0, a]);
      const b = rng.intExcluding(-12, 12, [0]);
      const d = rng.int(-30, 30);
      if ((d - b) % (a - c) !== 0 && d !== b) return { form, style: "fraction_answer", params: { a: R(a), b: R(b), c: R(c), d: R(d) } };
    }
  }
  throw new Error("could not choose challenge parameters"); // unreachable in practice: acceptance is about 70%
}

function chooseDegenerate(rng: Rng, outcome: Exclude<Outcome, "unique">): Chosen {
  const a = rng.intExcluding(-9, 9, [0]);
  const b = rng.intExcluding(-12, 12, [0]);
  const d = outcome === "identity" ? b : b + rng.intExcluding(-9, 9, [0]);
  return { form: "ax+b=cx+d", style: outcome, params: { a: R(a), b: R(b), c: R(a), d: R(d) } };
}

// --- public API -----------------------------------------------------------------------------------------

/**
 * Builds one question the way the product requires: code selects valid parameters and computes the
 * exact answer and every worked step; no model is involved. The result validates as `verified`.
 */
export function generateLinearQuestion(options: GenerateOptions): GeneratedQuestion {
  const outcome = options.outcome ?? "unique";
  if (outcome !== "unique" && options.form === "ax+b=c") throw new RangeError("no_solution and identity need the two-sided form");
  const rng = new Rng(`${GENERATOR_VERSION}|${options.seed}|${options.difficulty}|${options.form ?? "any"}|${outcome}`);

  let chosen: Chosen;
  if (outcome !== "unique") chosen = chooseDegenerate(rng, outcome);
  else if (options.difficulty === "basic") chosen = chooseBasic(rng);
  else {
    const form: Form = options.form ?? (rng.chance(1, 2) ? "ax+b=c" : "ax+b=cx+d");
    chosen = options.difficulty === "mixed" ? chooseMixed(rng, form) : chooseChallenge(rng, form);
  }
  if (options.difficulty === "basic" && options.form === "ax+b=cx+d" && outcome === "unique") {
    throw new RangeError("basic questions use the one-sided form");
  }

  const p = chosen.params;
  const { a, b } = { a: p.a!, b: p.b! };
  let equation: Equation;
  let steps: Step[];
  let solution: Question["solution"];

  if (chosen.form === "ax+b=c") {
    const c = p.c!;
    equation = eq([a], [b], [], [c]);
    steps = solveOneSided(options.id, a, b, c);
    solution = { kind: "unique", value: s(c.sub(b).div(a)) };
  } else {
    const c = p.c!;
    const d = p.d!;
    equation = eq([a], [b], [c], [d]);
    steps = solveTwoSided(options.id, a, b, c, d);
    solution = outcome === "unique" ? { kind: "unique", value: s(d.sub(b).div(a.sub(c))) } : { kind: outcome };
  }

  return {
    id: options.id,
    problem: {
      type: "linear_one_var",
      form: chosen.form,
      params: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, s(v)])),
      equation,
    },
    solution,
    steps,
    meta: { generatorVersion: GENERATOR_VERSION, difficulty: options.difficulty, form: chosen.form, outcome, style: chosen.style },
  };
}

/** The three levels, in the order a tutor would use them. */
export function difficultyRamp(count: number, difficulty: Difficulty): Difficulty[] {
  if (difficulty !== "mixed") return Array.from({ length: count }, () => difficulty);
  const third = Math.ceil(count / 3);
  return Array.from({ length: count }, (_, i) => (i < third ? "basic" : i < 2 * third ? "mixed" : "challenge"));
}

/** What makes two questions the same for de-duplication: the equation as written. Works on stored blocks too. */
export function questionFingerprint(q: { problem: { equation: unknown } }): string {
  return JSON.stringify(q.problem.equation);
}

/** Thrown by `generateExerciseSet` when no distinct question can be drawn for a position. */
export const DRAW_EXHAUSTED = "could not draw a distinct question";

/**
 * A set of exercises with no repeated equation. Asking for "mixed" gives an easy-to-hard ramp. Each
 * question has its own seed derived from the job, and a repeat is re-drawn with a bumped sub-seed.
 *
 * The optional arguments exist for quick adjustments and change nothing when omitted:
 *  startIndex  number of the first question (default 1), so appended questions continue the ids
 *              (`ex-<startIndex>`, ...) and their per-question seeds
 *  exclude     fingerprints (see `questionFingerprint`) that count as already taken, so a new question never
 *              repeats one that is already in the package
 *  ramp        false keeps every question at `difficulty`, also for "mixed" (default true: the ramp above)
 */
export function generateExerciseSet(args: {
  jobSeed: string;
  count: number;
  difficulty: Difficulty;
  idPrefix?: string;
  startIndex?: number;
  exclude?: ReadonlySet<string>;
  ramp?: boolean;
}): GeneratedQuestion[] {
  const prefix = args.idPrefix ?? "ex";
  const start = args.startIndex ?? 1;
  if (!Number.isInteger(start) || start < 1) throw new RangeError("startIndex must be a positive integer");
  const exclude = args.exclude ?? new Set<string>();
  const levels = args.ramp === false ? Array.from({ length: args.count }, () => args.difficulty) : difficultyRamp(args.count, args.difficulty);
  const seen = new Set<string>();
  const out: GeneratedQuestion[] = [];
  levels.forEach((level, i) => {
    const id = `${prefix}-${start + i}`;
    for (let retry = 0; retry < 50; retry++) {
      const q = generateLinearQuestion({ id, difficulty: level, seed: `${args.jobSeed}:${id}:${retry}` });
      const fp = questionFingerprint(q);
      if (!seen.has(fp) && !exclude.has(fp)) {
        seen.add(fp);
        out.push(q);
        return;
      }
    }
    throw new Error(DRAW_EXHAUSTED); // practically unreachable without `exclude`: thousands of variants exist per level
  });
  return out;
}
