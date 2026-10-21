import { describe, expect, it } from "vitest";
import {
  GENERATOR_VERSION,
  difficultyRamp,
  generateExerciseSet,
  generateLinearQuestion,
  type Difficulty,
  type Form,
  type GenerateOptions,
  type GeneratedQuestion,
  type Outcome,
} from "@/lib/math/generator";
import { isChallengeLevel } from "@/lib/package/adjust";
import { Rational, withinLimits } from "@/lib/math/rational";
import { Rng } from "@/lib/math/rng";
import { validateLinearQuestion, validateLessonMath } from "@/lib/math/validate";
import { createHash } from "node:crypto";
import { DRAW_EXHAUSTED, questionFingerprint } from "@/lib/math/generator";

const toQuestion = (g: GeneratedQuestion) => ({ id: g.id, role: "exercise" as const, problem: g.problem, solution: g.solution, steps: g.steps });
const num = (text: string) => Rational.parse(text);
const isInteger = (text: string) => num(text).den === 1n;
const SEEDS = 400;

describe("seeded random numbers", () => {
  it("repeats exactly for the same seed and differs for another", () => {
    const draw = (seed: string) => Array.from({ length: 20 }, (_, i) => new Rng(seed).int(0, 1_000_000) + i);
    expect(draw("a")).toEqual(draw("a"));
    expect(draw("a")).not.toEqual(draw("b"));
    const r1 = new Rng("x");
    const r2 = new Rng("x");
    expect(Array.from({ length: 50 }, () => r1.int(-9, 9))).toEqual(Array.from({ length: 50 }, () => r2.int(-9, 9)));
  });
  it("stays inside its range, covers all of it, and is not visibly biased", () => {
    const rng = new Rng("coverage");
    const counts = new Map<number, number>();
    for (let i = 0; i < 12_000; i++) {
      const v = rng.int(1, 6);
      expect(v >= 1 && v <= 6).toBe(true);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const c of counts.values()) expect(Math.abs(c - 2000)).toBeLessThan(250); // ~5 sigma
  });
  it("can exclude values and refuses impossible requests", () => {
    const rng = new Rng("ex");
    for (let i = 0; i < 500; i++) expect([0, 1].includes(rng.intExcluding(-3, 3, [0, 1]))).toBe(false);
    expect(() => rng.intExcluding(0, 1, [0, 1])).toThrow(RangeError);
    expect(() => rng.int(3, 2)).toThrow(RangeError);
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});

describe("every generated question is verified by the independent validator", () => {
  const combos: [Difficulty, Form | undefined, Outcome][] = [
    ["basic", undefined, "unique"],
    ["mixed", "ax+b=c", "unique"],
    ["mixed", "ax+b=cx+d", "unique"],
    ["mixed", undefined, "unique"],
    ["challenge", "ax+b=c", "unique"],
    ["challenge", "ax+b=cx+d", "unique"],
    ["challenge", undefined, "unique"],
    ["challenge", "ax+b=cx+d", "no_solution"],
    ["challenge", "ax+b=cx+d", "identity"],
    ["mixed", "ax+b=cx+d", "no_solution"],
    ["basic", "ax+b=cx+d", "identity"],
  ];
  it.each(combos)("%s / %s / %s over many seeds", (difficulty, form, outcome) => {
    for (let i = 0; i < SEEDS; i++) {
      const g = generateLinearQuestion({ id: "q", difficulty, form, outcome, seed: `prop-${i}` });
      const report = validateLinearQuestion(toQuestion(g));
      expect(report.status, `${difficulty}/${form}/${outcome}/seed ${i}: ${JSON.stringify(report.checks.filter((c) => c.result === "fail"))}`).toBe("verified");
      expect(report.checks.every((c) => c.result === "pass" || c.result === "not_applicable")).toBe(true);
    }
  });
});

describe("determinism and variety", () => {
  const opts = (seed: string): GenerateOptions => ({ id: "ex-1", difficulty: "mixed", seed });
  it("the same seed always gives the same question, step by step", () => {
    expect(generateLinearQuestion(opts("job-1:ex-1"))).toEqual(generateLinearQuestion(opts("job-1:ex-1")));
  });
  it("different seeds give a wide variety of questions", () => {
    const distinct = new Set(Array.from({ length: 300 }, (_, i) => JSON.stringify(generateLinearQuestion(opts(`v-${i}`)).problem.equation)));
    expect(distinct.size).toBeGreaterThan(250);
  });
  it("records which generator produced it", () => {
    expect(generateLinearQuestion(opts("m")).meta).toMatchObject({ generatorVersion: GENERATOR_VERSION, difficulty: "mixed" });
  });
  it("pins a few outputs so a change to the generator is a deliberate, visible decision (not a correctness oracle)", () => {
    const eqText = (g: GeneratedQuestion) => JSON.stringify([g.problem.form, g.problem.params, g.solution]);
    expect(eqText(generateLinearQuestion({ id: "q", difficulty: "basic", seed: "golden-1" }))).toBe(
      eqText(generateLinearQuestion({ id: "q", difficulty: "basic", seed: "golden-1" })),
    );
    const golden = generateLinearQuestion({ id: "q", difficulty: "basic", seed: "golden-1" });
    expect(golden.problem.form).toBe("ax+b=c");
    expect(GENERATOR_VERSION).toBe("linear-gen/1"); // bump together with any change to the golden outputs
  });
});

describe("readability rules by difficulty", () => {
  const draw = (difficulty: Difficulty, form?: Form) =>
    Array.from({ length: SEEDS }, (_, i) => generateLinearQuestion({ id: "q", difficulty, form, seed: `read-${i}` }));
  const x = (g: GeneratedQuestion) => (g.solution.kind === "unique" ? num(g.solution.value!) : null);

  it("basic: one-sided form, integer coefficients 2..9, nonzero integer answer within 10", () => {
    for (const g of draw("basic")) {
      const { a, b, c } = g.problem.params;
      expect(g.problem.form).toBe("ax+b=c");
      expect([a, b, c].every((v) => isInteger(v!))).toBe(true);
      expect(Number(a)).toBeGreaterThanOrEqual(2);
      expect(Number(a)).toBeLessThanOrEqual(9);
      expect(Number(b)).not.toBe(0);
      expect(x(g)!.den).toBe(1n);
      expect(x(g)!.isZero()).toBe(false);
      expect(Math.abs(Number(x(g)!.num))).toBeLessThanOrEqual(10);
    }
  });
  it("mixed: integer answers, never zero, never a coefficient of 1 on x in the one-sided form", () => {
    for (const g of draw("mixed")) {
      expect(x(g)!.den).toBe(1n);
      expect(x(g)!.isZero()).toBe(false);
      expect(Math.abs(Number(x(g)!.num))).toBeLessThanOrEqual(12);
      if (g.problem.form === "ax+b=c") expect(["1", "-1", "0"]).not.toContain(g.problem.params.a);
      else expect(g.problem.params.a).not.toBe(g.problem.params.c); // so x does not cancel
    }
    const forms = new Set(draw("mixed").map((g) => g.problem.form));
    expect(forms).toEqual(new Set(["ax+b=c", "ax+b=cx+d"])); // both appear
  });
  it("challenge: every question has a fractional answer or a fractional coefficient, never a zero answer", () => {
    const styles = new Set<string>();
    for (const g of draw("challenge")) {
      const fractionalAnswer = x(g)!.den !== 1n;
      const fractionalCoefficient = Object.values(g.problem.params).some((v) => !isInteger(v));
      expect(fractionalAnswer || fractionalCoefficient).toBe(true);
      expect(x(g)!.isZero()).toBe(false);
      styles.add(g.meta.style);
    }
    expect(styles).toEqual(new Set(["fraction_answer", "fraction_coefficient"]));
  });
  it("keeps every number inside the validator's limits and within a readable size", () => {
    for (const difficulty of ["basic", "mixed", "challenge"] as const) {
      for (const g of draw(difficulty)) {
        const all = [
          ...Object.values(g.problem.params),
          ...g.steps.flatMap((s) => [s.op.value, ...s.result.lhs.x, ...s.result.lhs.c, ...s.result.rhs.x, ...s.result.rhs.c]),
        ];
        for (const v of all) expect(withinLimits(num(v))).toBe(true);
        expect(g.steps.length).toBeLessThanOrEqual(4);
        expect(g.steps.length).toBeGreaterThanOrEqual(1);
      }
    }
  });
  it("step ids are unique and carry the question id", () => {
    for (const g of draw("mixed")) {
      expect(new Set(g.steps.map((s) => s.id)).size).toBe(g.steps.length);
      expect(g.steps.every((s) => s.id.startsWith("q.s"))).toBe(true);
    }
  });
});

describe("outcomes other than a unique solution", () => {
  it("no_solution has equal x coefficients and different constants; identity has both equal", () => {
    for (let i = 0; i < SEEDS; i++) {
      const none = generateLinearQuestion({ id: "q", difficulty: "challenge", form: "ax+b=cx+d", outcome: "no_solution", seed: `n-${i}` });
      const all = generateLinearQuestion({ id: "q", difficulty: "challenge", form: "ax+b=cx+d", outcome: "identity", seed: `i-${i}` });
      expect(none.solution).toEqual({ kind: "no_solution" });
      expect(none.problem.params.a).toBe(none.problem.params.c);
      expect(none.problem.params.b).not.toBe(none.problem.params.d);
      expect(all.solution).toEqual({ kind: "identity" });
      expect(all.problem.params.a).toBe(all.problem.params.c);
      expect(all.problem.params.b).toBe(all.problem.params.d);
      expect(none.steps).toHaveLength(1);
    }
  });
  it("are never produced unless asked for, and need the two-sided form", () => {
    for (let i = 0; i < SEEDS; i++) {
      for (const difficulty of ["basic", "mixed", "challenge"] as const) {
        expect(generateLinearQuestion({ id: "q", difficulty, seed: `u-${i}` }).solution.kind).toBe("unique");
      }
    }
    expect(() => generateLinearQuestion({ id: "q", difficulty: "mixed", form: "ax+b=c", outcome: "no_solution", seed: "s" })).toThrow(RangeError);
    expect(() => generateLinearQuestion({ id: "q", difficulty: "basic", form: "ax+b=cx+d", seed: "s" })).toThrow(RangeError);
  });
});

describe("exercise sets", () => {
  it("ramps from easy to hard when mixed, and uses one level otherwise", () => {
    expect(difficultyRamp(6, "mixed")).toEqual(["basic", "basic", "mixed", "mixed", "challenge", "challenge"]);
    expect(difficultyRamp(1, "mixed")).toEqual(["basic"]);
    expect(difficultyRamp(4, "challenge")).toEqual(["challenge", "challenge", "challenge", "challenge"]);
    expect(difficultyRamp(0, "mixed")).toEqual([]);
  });
  it("honours the requested count with no repeated equation and ids ex-1..ex-n, for every size", () => {
    for (let count = 1; count <= 20; count++) {
      for (const difficulty of ["basic", "mixed", "challenge"] as const) {
        const set = generateExerciseSet({ jobSeed: `job-${count}`, count, difficulty });
        expect(set).toHaveLength(count);
        expect(set.map((q) => q.id)).toEqual(Array.from({ length: count }, (_, i) => `ex-${i + 1}`));
        expect(new Set(set.map((q) => JSON.stringify(q.problem.equation))).size).toBe(count);
      }
    }
  });
  it("never repeats an equation within a set, even over many sets where chance collisions are common", () => {
    // basic has only a few thousand distinct questions, so across 1500 sets of 20 a collision is certain
    // to be drawn somewhere unless the set builder actively avoids it.
    for (let job = 0; job < 1500; job++) {
      const set = generateExerciseSet({ jobSeed: `dedupe-${job}`, count: 20, difficulty: "basic" });
      expect(new Set(set.map((q) => JSON.stringify(q.problem.equation))).size).toBe(20);
    }
  });
  it("is reproducible for a job, and different jobs get different sets", () => {
    const a = generateExerciseSet({ jobSeed: "job-A", count: 8, difficulty: "mixed" });
    expect(generateExerciseSet({ jobSeed: "job-A", count: 8, difficulty: "mixed" })).toEqual(a);
    expect(generateExerciseSet({ jobSeed: "job-B", count: 8, difficulty: "mixed" })).not.toEqual(a);
  });
  it("assembles into a lesson that the whole-lesson validator verifies", () => {
    for (const difficulty of ["basic", "mixed", "challenge"] as const) {
      const set = generateExerciseSet({ jobSeed: `lesson-${difficulty}`, count: 12, difficulty });
      const report = validateLessonMath({
        workedExamples: [{ ...toQuestion(generateLinearQuestion({ id: "we-1", difficulty: "basic", seed: "we" })), role: undefined }],
        exercises: set.map((q) => ({ id: q.id, problem: q.problem })),
        answerKey: set.map((q) => ({ questionId: q.id, solution: q.solution, steps: q.steps })),
      });
      expect(report.overall, JSON.stringify(report.items.filter((i) => i.status !== "verified"))).toBe("verified");
      expect(report.setChecks.every((c) => c.result === "pass")).toBe(true);
    }
  });
});

describe("exercise sets for quick adjustments (optional startIndex, exclude, ramp)", () => {
  // Recorded from generateExerciseSet before startIndex/exclude/ramp existed (commit 70b2725): calls without the new
  // options must keep producing exactly these sets, so packages built before and after stay byte-identical.
  const GOLDEN_SETS_SHA256 = "7523390853e8ed1ec1eb26005efc4d41ead686bf637fcaec9cd90ba99dc1993b";
  const goldenMatrix = (extra: Record<string, unknown>) => {
    const out: Record<string, string> = {};
    for (const difficulty of ["basic", "mixed", "challenge"] as const)
      for (const count of [1, 3, 7, 12, 20])
        for (const [jobSeed, idPrefix] of [["golden-a", undefined], ["golden-b:exercises:0", "ex"], ["golden-c:examples", "we"]] as const) {
          const set = generateExerciseSet({ jobSeed, count, difficulty, ...(idPrefix ? { idPrefix } : {}), ...extra });
          out[`${difficulty}|${count}|${jobSeed}|${idPrefix ?? ""}`] = JSON.stringify(set);
        }
    return createHash("sha256").update(JSON.stringify(out)).digest("hex");
  };

  it("without the new options, output is byte-identical to the recorded sets", () => {
    expect(goldenMatrix({})).toBe(GOLDEN_SETS_SHA256);
  });
  it("the defaults spelled out (startIndex 1, empty exclude, ramp on) are the same sets", () => {
    expect(goldenMatrix({ startIndex: 1, exclude: new Set<string>(), ramp: true })).toBe(GOLDEN_SETS_SHA256);
  });
  it("startIndex continues the ids and the per-question seeds from that number", () => {
    const set = generateExerciseSet({ jobSeed: "job-S", count: 3, difficulty: "basic", startIndex: 10 });
    expect(set.map((q) => q.id)).toEqual(["ex-10", "ex-11", "ex-12"]);
    expect(set.flatMap((q) => q.steps.map((st) => st.id)).every((id) => /^ex-1[012]\.s\d+$/.test(id))).toBe(true);
    // ex-10 is drawn exactly as the tenth question of a full set at the same level would be
    const full = generateExerciseSet({ jobSeed: "job-S", count: 12, difficulty: "basic" });
    expect(set[0]).toEqual(full[9]);
    for (const q of set) expect(validateLinearQuestion(toQuestion(q)).status).toBe("verified");
  });
  it("never returns a question whose fingerprint is excluded", () => {
    const first = generateExerciseSet({ jobSeed: "job-X", count: 8, difficulty: "basic" });
    const exclude = new Set(first.slice(0, 4).map(questionFingerprint));
    for (let job = 0; job < 200; job++) {
      const set = generateExerciseSet({ jobSeed: job === 0 ? "job-X" : `job-X-${job}`, count: 8, difficulty: "basic", exclude });
      expect(set.some((q) => exclude.has(questionFingerprint(q)))).toBe(false);
      expect(new Set(set.map(questionFingerprint)).size).toBe(8);
    }
    // the same seed re-draws only the excluded positions; the others are unchanged
    const again = generateExerciseSet({ jobSeed: "job-X", count: 8, difficulty: "basic", exclude });
    expect(again.slice(4)).toEqual(first.slice(4));
    expect(again.slice(0, 4).map(questionFingerprint).some((f) => exclude.has(f))).toBe(false);
  });
  it("gives up with DRAW_EXHAUSTED when every candidate is excluded", () => {
    const pool = new Set<string>();
    // a seed whose 50 retries at one id are all collected beforehand
    for (let retry = 0; retry < 50; retry++) pool.add(questionFingerprint(generateLinearQuestion({ id: "ex-1", difficulty: "basic", seed: `job-E:ex-1:${retry}` })));
    expect(() => generateExerciseSet({ jobSeed: "job-E", count: 1, difficulty: "basic", exclude: pool })).toThrow(DRAW_EXHAUSTED);
  });
  it("ramp: false keeps every question at the given level, also for mixed", () => {
    const set = generateExerciseSet({ jobSeed: "job-R", count: 6, difficulty: "mixed", ramp: false });
    expect(set.map((q) => q.meta.difficulty)).toEqual(Array(6).fill("mixed"));
    const ramped = generateExerciseSet({ jobSeed: "job-R", count: 6, difficulty: "mixed" });
    expect(ramped.map((q) => q.meta.difficulty)).toEqual(difficultyRamp(6, "mixed"));
    expect(generateExerciseSet({ jobSeed: "job-R", count: 6, difficulty: "challenge", ramp: false })).toEqual(generateExerciseSet({ jobSeed: "job-R", count: 6, difficulty: "challenge" }));
  });
  it("questionFingerprint is the equation, for a generated question and for a stored block alike, in any key order", () => {
    const q = generateLinearQuestion({ id: "q", difficulty: "mixed", seed: "fp" });
    expect(questionFingerprint({ problem: { equation: q.problem.equation } })).toBe(questionFingerprint(q));
    const { lhs, rhs } = q.problem.equation;
    const reordered = { rhs: { c: rhs.c, x: rhs.x }, lhs: { c: lhs.c, x: lhs.x } };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(q.problem.equation));
    expect(questionFingerprint({ problem: { equation: reordered } })).toBe(questionFingerprint(q));
    const other = generateLinearQuestion({ id: "q", difficulty: "mixed", seed: "fp-2" });
    expect(questionFingerprint(other)).not.toBe(questionFingerprint(q));
  });
});

describe("challenge classification used by add_exercises on a mixed set (D-72)", () => {
  const classify = (q: GeneratedQuestion) => isChallengeLevel(q.problem, q.solution);

  for (const level of ["basic", "mixed", "challenge"] as const) {
    it(`classes every ${level} question as ${level === "challenge" ? "" : "not "}challenge-level`, () => {
      for (let i = 0; i < 300; i++) {
        const q = generateLinearQuestion({ id: "ex-1", difficulty: level, seed: `class-${level}-${i}` });
        expect(classify(q), `${level} ${i}`).toBe(level === "challenge");
      }
    });
  }

  it("classes no_solution and identity questions as not challenge-level", () => {
    for (const difficulty of ["mixed", "challenge"] as const) {
      for (const outcome of ["no_solution", "identity"] as const) {
        for (let i = 0; i < 100; i++) {
          const q = generateLinearQuestion({ id: "ex-1", difficulty, seed: `class-${difficulty}-${outcome}-${i}`, form: "ax+b=cx+d", outcome });
          expect(classify(q), `${difficulty} ${outcome} ${i}`).toBe(false);
        }
      }
    }
  });
});
