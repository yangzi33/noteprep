import { describe, expect, it, vi } from "vitest";
import type { CurriculumContext } from "@/lib/curriculum/context";
import type { AdjustmentChange } from "@/lib/domain/adjustment";
import { AdjustmentNotApplicable } from "@/lib/domain/errors";
import { canonicalJson, sha256Hex } from "@/lib/domain/hash";
import { difficultyRamp, GENERATOR_VERSION, questionFingerprint, type Difficulty } from "@/lib/math/generator";
import { Rational } from "@/lib/math/rational";
import { validateLinearQuestion } from "@/lib/math/validate";
import { Rng } from "@/lib/math/rng";
import { adjustmentSeed, applyAdjustment, MAX_EXAMPLES, packageContentHash, planAdjustment, type ApplicableChange } from "@/lib/package/adjust";
import { planOutline } from "@/lib/package/build";
import { effectiveSettings } from "@/lib/package/effective";
import { PackageSchema, type LessonPackage, type Section } from "@/lib/package/schema";
import { validatePackage } from "@/lib/package/validate";
import { documentView } from "@/lib/package/views";
import { testPackage } from "../fixtures/package";

// Lets one test make every draw fail, to reach the retry limit; every other test uses the real generator unchanged.
const draws = vi.hoisted(() => ({ fail: false, seeds: [] as string[] }));
vi.mock("@/lib/math/generator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/math/generator")>();
  return {
    ...actual,
    generateExerciseSet: (args: Parameters<typeof actual.generateExerciseSet>[0]) => {
      if (draws.fail) {
        draws.seeds.push(args.jobSeed);
        throw new Error(actual.DRAW_EXHAUSTED);
      }
      return actual.generateExerciseSet(args);
    },
  };
});

type Block = Section["blocks"][number];
type QuestionBlock = Extract<Block, { type: "question" }>;
type SolutionBlock = Extract<Block, { type: "solution" }>;
type ExampleBlock = Extract<Block, { type: "worked_example" }>;

const sectionOf = (pkg: LessonPackage, kind: Section["kind"]) => pkg.sections.find((s) => s.kind === kind)!;
const blocksOf = (pkg: LessonPackage, kind: Section["kind"]) => sectionOf(pkg, kind).blocks as Block[];
const questions = (pkg: LessonPackage) => blocksOf(pkg, "exercises").filter((b): b is QuestionBlock => b.type === "question");
const solutions = (pkg: LessonPackage) => blocksOf(pkg, "solutions").filter((b): b is SolutionBlock => b.type === "solution");
const examples = (pkg: LessonPackage) => blocksOf(pkg, "worked_examples").filter((b): b is ExampleBlock => b.type === "worked_example");

const seedFor = (pkg: LessonPackage, change: AdjustmentChange) => adjustmentSeed(pkg, packageContentHash(pkg), change);
const apply = (pkg: LessonPackage, change: ApplicableChange) =>
  applyAdjustment(pkg, change, { seed: seedFor(pkg, change), context: pkg.context as CurriculumContext });

const num = (text: string) => Rational.parse(text);
const isInteger = (text: string) => num(text).den === 1n;
const answerOf = (pkg: LessonPackage, questionId: string) => {
  const s = solutions(pkg).find((b) => b.questionId === questionId)!;
  return s.solution.kind === "unique" ? num(s.solution.value!) : null;
};

/** The generator's readability rule for one level (see src/lib/math/generator.ts), checked on a stored question. */
function fitsLevel(pkg: LessonPackage, q: QuestionBlock, level: Difficulty): boolean {
  const x = answerOf(pkg, q.questionId);
  if (!x || x.isZero()) return false;
  const params = Object.values(q.problem.params);
  if (level === "basic") {
    const a = Number(q.problem.params.a);
    return q.problem.form === "ax+b=c" && params.every(isInteger) && a >= 2 && a <= 9 && x.den === 1n && Math.abs(Number(x.num)) <= 10;
  }
  if (level === "mixed") return params.every(isInteger) && x.den === 1n && Math.abs(Number(x.num)) <= 12;
  return x.den !== 1n || !params.every(isInteger);
}

/** Every exercise, paired with its solution, is verified by the independent single-question validator. */
function expectEveryQuestionVerified(pkg: LessonPackage) {
  const sols = new Map(solutions(pkg).map((s) => [s.questionId, s]));
  for (const q of questions(pkg)) {
    const s = sols.get(q.questionId)!;
    const report = validateLinearQuestion({ id: q.questionId, role: "exercise", problem: q.problem, solution: s.solution, steps: s.steps });
    expect(report.status, q.questionId).toBe("verified");
  }
}

/** Plan section 2.3, for any plan and result. */
function expectPlanHolds(source: LessonPackage, change: AdjustmentChange, result: LessonPackage) {
  const plan = planAdjustment(source, change);
  for (const id of plan.unchanged) {
    expect(canonicalJson(result.sections.find((s) => s.id === id)), id).toBe(canonicalJson(source.sections.find((s) => s.id === id)));
  }
  for (const id of plan.rehashed) {
    const a = result.sections.find((s) => s.id === id)!;
    const b = source.sections.find((s) => s.id === id)!;
    expect({ kind: a.kind, title: a.title, blocks: a.blocks, contentHash: a.contentHash, provenance: a.provenance, edited: a.edited }).toEqual({
      kind: b.kind, title: b.title, blocks: b.blocks, contentHash: b.contentHash, provenance: b.provenance, edited: b.edited,
    });
  }
  expect(result.sections.map((s) => s.id)).toEqual(source.sections.map((s) => s.id));
  for (const key of ["documents", "deps", "request", "context", "seed", "schemaVersion"] as const) expect(canonicalJson(result[key]), key).toBe(canonicalJson(source[key]));
  if (!plan.outlineChanged) expect(canonicalJson(result.outline)).toBe(canonicalJson(source.outline));
  const report = validatePackage(result);
  expect(report.overall, JSON.stringify([report.structure.issues, report.prose.issues])).toBe("verified");
}

function expectWorksheetHasNoAnswers(pkg: LessonPackage) {
  const view = documentView(pkg, "worksheet");
  const types = view.sections.flatMap((s) => (s.blocks as Block[]).map((b) => b.type));
  expect(types).not.toContain("solution");
  expect(types).not.toContain("worked_example");
  expect(JSON.stringify(view)).not.toContain('"steps"');
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AdjustmentNotApplicable);
    return (e as AdjustmentNotApplicable).reason;
  }
  throw new Error("expected AdjustmentNotApplicable");
}

describe("adjustmentSeed", () => {
  const pkg = testPackage({ difficulty: "mixed" }, "seed-1");
  const hash = packageContentHash(pkg);

  it("is the package seed plus a hash of the source content hash and the change (plan section 2.2)", () => {
    const change: AdjustmentChange = { action: "add_exercises", count: 2 };
    expect(adjustmentSeed(pkg, hash, change)).toBe(`seed-1:adj:${sha256Hex(canonicalJson({ source: hash, change })).slice(0, 16)}`);
    expect(adjustmentSeed(pkg, hash, change)).toMatch(/^seed-1:adj:[0-9a-f]{16}$/);
  });
  it("is stable for the same inputs and differs for another source or another change", () => {
    const harder: AdjustmentChange = { action: "make_harder" };
    expect(adjustmentSeed(pkg, hash, harder)).toBe(adjustmentSeed(structuredClone(pkg), hash, { action: "make_harder" }));
    expect(adjustmentSeed(pkg, `sha256:${"0".repeat(64)}`, harder)).not.toBe(adjustmentSeed(pkg, hash, harder));
    expect(adjustmentSeed(pkg, hash, { action: "make_easier" })).not.toBe(adjustmentSeed(pkg, hash, harder));
    expect(adjustmentSeed(pkg, hash, { action: "add_exercises", count: 1 })).not.toBe(adjustmentSeed(pkg, hash, { action: "add_exercises", count: 2 }));
  });
  it("packageContentHash is the revision content hash: sha256 of the canonical JSON", () => {
    expect(hash).toBe(`sha256:${sha256Hex(canonicalJson(pkg))}`);
  });
});

describe("make_harder / make_easier", () => {
  const cases: [Difficulty, "make_harder" | "make_easier", Difficulty][] = [
    ["basic", "make_harder", "mixed"],
    ["mixed", "make_harder", "challenge"],
    ["challenge", "make_easier", "mixed"],
    ["mixed", "make_easier", "basic"],
  ];
  for (const [from, action, to] of cases) {
    for (const durationMinutes of [15, 60, 180]) {
      it(`${action} on ${from} (${durationMinutes} min) regenerates every exercise at ${to}`, () => {
        const source = testPackage({ difficulty: from, durationMinutes }, `ladder-${from}-${durationMinutes}`);
        const before = canonicalJson(source);
        const change = { action } as const;
        const seed = seedFor(source, change);
        const result = apply(source, change);

        expect(canonicalJson(source)).toBe(before); // the input is never mutated
        expect(effectiveSettings(result).difficulty).toBe(to);
        expect(effectiveSettings(result).durationMinutes).toBe(durationMinutes);

        const n = questions(source).length;
        expect(questions(result)).toHaveLength(n);
        expect(questions(result).map((q) => q.questionId)).toEqual(Array.from({ length: n }, (_, i) => `ex-${i + 1}`));
        expect(solutions(result).map((s) => s.questionId)).toEqual(questions(result).map((q) => q.questionId));
        expectEveryQuestionVerified(result);

        // each position follows the generator's own layout for the new difficulty (mixed: the thirds ramp)
        const levels = difficultyRamp(n, to);
        questions(result).forEach((q, i) => expect(fitsLevel(result, q, levels[i]!), `${q.questionId} as ${levels[i]}`).toBe(true));

        const exProv = sectionOf(result, "exercises").provenance;
        expect(exProv).toEqual({ method: "deterministic", seed, difficulty: to, generatorVersion: GENERATOR_VERSION });
        expect(sectionOf(result, "solutions").provenance).toEqual(exProv);

        // nothing repeats a question the source already had (exercises or worked examples)
        const old = new Set([...questions(source), ...examples(source)].map(questionFingerprint));
        expect(questions(result).some((q) => old.has(questionFingerprint(q)))).toBe(false);
        expect(new Set(questions(result).map(questionFingerprint)).size).toBe(n);

        // the non-question blocks and titles are kept
        expect(blocksOf(result, "exercises")[0]).toEqual(blocksOf(source, "exercises")[0]);
        expect(blocksOf(result, "solutions")[0]).toEqual(blocksOf(source, "solutions")[0]);
        expect(sectionOf(result, "exercises").title).toBe(sectionOf(source, "exercises").title);
        expect(blocksOf(result, "exercises").filter((b) => b.type === "writing_space")).toEqual(blocksOf(source, "exercises").filter((b) => b.type === "writing_space"));

        expect(result.adjustments).toEqual([{ action, method: "deterministic", seed, sourceContentHash: packageContentHash(source) }]);
        expectPlanHolds(source, change, result);
        expectWorksheetHasNoAnswers(result);
      });
    }
  }

  it("make_harder on challenge and make_easier on basic are not applicable (the planner says so)", () => {
    const challenge = testPackage({ difficulty: "challenge" });
    const basic = testPackage({ difficulty: "basic" });
    expect(reasonOf(() => apply(challenge, { action: "make_harder" }))).toBe("at_hardest");
    expect(reasonOf(() => apply(basic, { action: "make_easier" }))).toBe("at_easiest");
  });

  it("walks the whole ladder and back, reading the current difficulty from the adjusted package", () => {
    let pkg = testPackage({ difficulty: "basic" }, "walk");
    const seen: Difficulty[] = [];
    for (const action of ["make_harder", "make_harder", "make_easier", "make_easier"] as const) {
      pkg = apply(pkg, { action });
      seen.push(effectiveSettings(pkg).difficulty);
      expect(validatePackage(pkg).overall).toBe("verified");
    }
    expect(seen).toEqual(["mixed", "challenge", "mixed", "basic"]);
    expect(pkg.adjustments?.map((a) => a.action)).toEqual(["make_harder", "make_harder", "make_easier", "make_easier"]);
    expect(reasonOf(() => apply(pkg, { action: "make_easier" }))).toBe("at_easiest");
    expect((pkg.request as { difficulty: string }).difficulty).toBe("basic"); // the request snapshot is never rewritten
  });
});

describe("add_exercises", () => {
  for (const difficulty of ["basic", "mixed", "challenge"] as const) {
    for (const count of [1, 3, 6]) {
      it(`adds ${count} to a ${difficulty} package, keeping every existing block byte for byte`, () => {
        const source = testPackage({ difficulty, durationMinutes: 60 }, `add-${difficulty}-${count}`);
        const before = canonicalJson(source);
        const change = { action: "add_exercises", count } as const;
        const seed = seedFor(source, change);
        const result = apply(source, change);
        expect(canonicalJson(source)).toBe(before);

        const n = questions(source).length;
        const exBlocks = blocksOf(source, "exercises");
        const solBlocks = blocksOf(source, "solutions");
        // the intro and the first n question / writing_space pairs, and the first n solutions, are unchanged
        expect(JSON.stringify(blocksOf(result, "exercises").slice(0, exBlocks.length))).toBe(JSON.stringify(exBlocks));
        expect(JSON.stringify(blocksOf(result, "solutions").slice(0, solBlocks.length))).toBe(JSON.stringify(solBlocks));
        expect(blocksOf(result, "exercises")).toHaveLength(exBlocks.length + 2 * count);
        expect(blocksOf(result, "solutions")).toHaveLength(solBlocks.length + count);

        const added = questions(result).slice(n);
        expect(added.map((q) => q.questionId)).toEqual(Array.from({ length: count }, (_, i) => `ex-${n + i + 1}`));
        expect(blocksOf(result, "exercises").slice(exBlocks.length).map((b) => b.type)).toEqual(Array.from({ length: count }, () => ["question", "writing_space"]).flat());
        expect(solutions(result).map((s) => s.questionId)).toEqual(questions(result).map((q) => q.questionId));

        // new questions: at the current level as a whole (mixed: the mixed level, no new ramp), and never a repeat
        for (const q of added) expect(fitsLevel(result, q, difficulty), q.questionId).toBe(true);
        const old = new Set([...questions(source), ...examples(source)].map(questionFingerprint));
        expect(added.some((q) => old.has(questionFingerprint(q)))).toBe(false);
        expect(new Set(questions(result).map(questionFingerprint)).size).toBe(n + count);
        expectEveryQuestionVerified(result);

        const exProv = sectionOf(result, "exercises").provenance;
        expect(exProv).toEqual({ method: "deterministic", seed, difficulty, generatorVersion: GENERATOR_VERSION });
        expect(sectionOf(result, "solutions").provenance).toEqual(exProv);
        expect(effectiveSettings(result)).toEqual(effectiveSettings(source));
        expect(result.adjustments).toEqual([{ action: "add_exercises", method: "deterministic", seed, sourceContentHash: packageContentHash(source) }]);

        expectPlanHolds(source, change, result);
        expectWorksheetHasNoAnswers(result);
      });
    }
  }

  it("uses the adjusted difficulty, not the request's, after make_harder", () => {
    const harder = apply(testPackage({ difficulty: "mixed" }, "chain"), { action: "make_harder" });
    const result = apply(harder, { action: "add_exercises", count: 2 });
    const n = questions(harder).length;
    expect(sectionOf(result, "exercises").provenance.difficulty).toBe("challenge");
    for (const q of questions(result).slice(n)) expect(fitsLevel(result, q, "challenge")).toBe(true);
    expect(result.adjustments?.map((a) => a.action)).toEqual(["make_harder", "add_exercises"]);
    expect(result.adjustments?.[1]?.sourceContentHash).toBe(packageContentHash(harder));
    expectPlanHolds(harder, { action: "add_exercises", count: 2 }, result);
  });

  it("make_easier after add_exercises regenerates the larger set at the lower level", () => {
    const added = apply(testPackage({ difficulty: "challenge" }, "chain-2"), { action: "add_exercises", count: 4 });
    const result = apply(added, { action: "make_easier" });
    expect(questions(result)).toHaveLength(questions(added).length);
    expect(effectiveSettings(result).difficulty).toBe("mixed");
    expectPlanHolds(added, { action: "make_easier" }, result);
  });

  it("stops at MAX_EXERCISES (the planner refuses)", () => {
    let pkg = testPackage({ difficulty: "basic", durationMinutes: 180 }, "cap"); // 12 exercises
    pkg = apply(pkg, { action: "add_exercises", count: 6 });
    expect(questions(pkg)).toHaveLength(18);
    expect(reasonOf(() => apply(pkg, { action: "add_exercises", count: 3 }))).toBe("max_exercises");
    pkg = apply(pkg, { action: "add_exercises", count: 2 });
    expect(questions(pkg)).toHaveLength(20);
    expect(blocksOf(pkg, "exercises")).toHaveLength(41);
    expect(validatePackage(pkg).overall).toBe("verified");
  });

  it("gives up with no_distinct_questions after 20 seeds", () => {
    const source = testPackage({ difficulty: "basic" }, "exhaust");
    const change = { action: "add_exercises", count: 1 } as const;
    const seed = seedFor(source, change);
    draws.fail = true;
    draws.seeds = [];
    try {
      expect(reasonOf(() => apply(source, change))).toBe("no_distinct_questions");
    } finally {
      draws.fail = false;
    }
    expect(draws.seeds).toEqual(Array.from({ length: 20 }, (_, i) => `${seed}:exercises:${i}`));
  });
});

describe("determinism and purity", () => {
  const changes: ApplicableChange[] = [{ action: "make_harder" }, { action: "make_easier" }, { action: "add_exercises", count: 3 }];
  it("the same package, change and seed give a byte-identical result", () => {
    const source = testPackage({ difficulty: "mixed" }, "det");
    for (const change of changes) expect(JSON.stringify(apply(source, change))).toBe(JSON.stringify(apply(structuredClone(source), change)));
  });
  it("another seed gives other questions", () => {
    const source = testPackage({ difficulty: "mixed" }, "det");
    const context = source.context as CurriculumContext;
    const a = applyAdjustment(source, { action: "make_harder" }, { seed: adjustmentSeed(source, packageContentHash(source), { action: "make_harder" }), context });
    const b = applyAdjustment(source, { action: "make_harder" }, { seed: adjustmentSeed(source, `sha256:${"1".repeat(64)}`, { action: "make_harder" }), context });
    expect(a.sections.find((s) => s.kind === "exercises")!.provenance.seed).not.toBe(b.sections.find((s) => s.kind === "exercises")!.provenance.seed);
    expect(questions(a).map(questionFingerprint)).not.toEqual(questions(b).map(questionFingerprint));
  });
  it("refuses a context that is not the package's snapshot", () => {
    const source = testPackage({ difficulty: "mixed" }, "ctx");
    const other = testPackage({ difficulty: "mixed" }, "ctx", "real").context as CurriculumContext;
    expect(() => applyAdjustment(source, { action: "make_harder" }, { seed: "s", context: other })).toThrow(/context/);
  });
});

describe("duplicate detection does not depend on JSON key order", () => {
  // A package read back from storage has canonical (sorted) keys, not the generator's {x, c} order.
  const roundTrip = (pkg: LessonPackage): LessonPackage => JSON.parse(canonicalJson(pkg)) as LessonPackage;
  const allEquations = (pkg: LessonPackage) => [...examples(pkg), ...questions(pkg)].map((b) => canonicalJson(b.problem.equation));
  const expectNoRepeatedEquation = (pkg: LessonPackage, label: string) => {
    const eqs = allEquations(pkg);
    expect(new Set(eqs).size, label).toBe(eqs.length);
  };

  it("the same source in memory, canonically re-serialized, or re-parsed by the schema gives the same result", () => {
    const changes: ApplicableChange[] = [{ action: "make_harder" }, { action: "make_easier" }, { action: "add_exercises", count: 1 }, { action: "add_exercises", count: 3 }, { action: "add_exercises", count: 6 }];
    for (const [i, difficulty] of (["basic", "mixed", "challenge"] as const).entries()) {
      const source = testPackage({ difficulty, durationMinutes: 90 }, `order-${i}`);
      const deliveries = [source, roundTrip(source), PackageSchema.parse(JSON.parse(canonicalJson(source))) as LessonPackage];
      for (const change of changes) {
        if ((difficulty === "basic" && change.action === "make_easier") || (difficulty === "challenge" && change.action === "make_harder")) continue;
        const [a, b, c] = deliveries.map((pkg) => canonicalJson(apply(pkg, change)));
        expect(b, `${difficulty} ${change.action}`).toBe(a);
        expect(c, `${difficulty} ${change.action}`).toBe(a);
      }
    }
  });

  // Found by review and by a search with the old key-order-sensitive fingerprint: each appended a repeat of a worked example.
  const KNOWN: [Difficulty, number, string][] = [
    ["mixed", 167, "seed-40"],
    ["basic", 167, "seed-0"],
    ["challenge", 167, "seed-7"],
    ["basic", 45, "seed-11"],
    ["basic", 180, "seed-12"],
    ["basic", 180, "seed-27"],
  ];
  it.each(KNOWN)("%s / %i min / %s: add_exercises 6 after a canonical round trip repeats no equation", (difficulty, durationMinutes, seed) => {
    const source = roundTrip(testPackage({ difficulty, durationMinutes }, seed));
    const result = apply(source, { action: "add_exercises", count: 6 });
    expectNoRepeatedEquation(result, `${difficulty}/${durationMinutes}/${seed}`);
    expect(validatePackage(result).overall).toBe("verified");
  });

  it("over many seeds, no adjustment of a stored package repeats an equation across examples and exercises", () => {
    for (let i = 0; i < 100; i++) {
      for (const difficulty of ["basic", "mixed", "challenge"] as const) {
        const durationMinutes = [45, 90, 167, 180][i % 4]!;
        const source = roundTrip(testPackage({ difficulty, durationMinutes }, `many-${i}`));
        const changes: ApplicableChange[] = [{ action: "add_exercises", count: 6 }, { action: difficulty === "challenge" ? "make_easier" : "make_harder" }];
        for (const change of changes) expectNoRepeatedEquation(apply(source, change), `${difficulty}/${durationMinutes}/many-${i}/${change.action}`);
      }
    }
  });
});

// --- Task 6: add_worked_example and change_duration ------------------------------------------------------

const isUniqueExample = (b: ExampleBlock) => b.solution.kind === "unique";
const uniqueExamples = (pkg: LessonPackage) => examples(pkg).filter(isUniqueExample);
const canonicalCopy = (pkg: LessonPackage): LessonPackage => JSON.parse(canonicalJson(pkg)) as LessonPackage;
const parsedCopy = (pkg: LessonPackage): LessonPackage => PackageSchema.parse(JSON.parse(canonicalJson(pkg))) as LessonPackage;

function expectEveryExampleVerified(pkg: LessonPackage) {
  for (const b of examples(pkg)) {
    const report = validateLinearQuestion({ id: b.questionId, role: "example", problem: b.problem, solution: b.solution, steps: b.steps });
    expect(report.status, b.questionId).toBe("verified");
  }
}

function expectNoRepeatedEquation(pkg: LessonPackage) {
  const eqs = [...examples(pkg), ...questions(pkg)].map(questionFingerprint);
  expect(new Set(eqs).size).toBe(eqs.length);
  const ids = [...examples(pkg), ...questions(pkg)].map((b) => b.questionId);
  expect(new Set(ids).size).toBe(ids.length);
}

/** The readability rule of a level, checked on a worked example (its own answer). */
function exampleFitsLevel(b: ExampleBlock, level: Difficulty): boolean {
  if (b.solution.kind !== "unique") return false;
  const x = num(b.solution.value!);
  const params = Object.values(b.problem.params);
  if (x.isZero()) return false;
  if (level === "basic") {
    const a = Number(b.problem.params.a);
    return b.problem.form === "ax+b=c" && params.every(isInteger) && a >= 2 && a <= 9 && x.den === 1n && Math.abs(Number(x.num)) <= 10;
  }
  if (level === "mixed") return params.every(isInteger) && x.den === 1n && Math.abs(Number(x.num)) <= 12;
  return x.den !== 1n || !params.every(isInteger);
}

const deliveryFormsAgree = (source: LessonPackage, change: ApplicableChange) => {
  const [a, b, c] = [source, canonicalCopy(source), parsedCopy(source)].map((pkg) => canonicalJson(apply(pkg, change)));
  expect(b).toBe(a);
  expect(c).toBe(a);
};

describe("add_worked_example", () => {
  for (const [difficulty, level] of [["mixed", "mixed"], ["challenge", "mixed"]] as const) {
    it(`on a ${difficulty} package inserts one example after the last unique-solution one, before the no-solution example and the note`, () => {
      const source = testPackage({ difficulty, durationMinutes: 60 }, `we-${difficulty}`);
      const before = canonicalJson(source);
      const change = { action: "add_worked_example" } as const;
      const seed = seedFor(source, change);
      const result = apply(source, change);
      expect(canonicalJson(source)).toBe(before);

      const src = blocksOf(source, "worked_examples");
      const out = blocksOf(result, "worked_examples");
      expect(src.map((b) => b.type)).toEqual(["paragraph", "worked_example", "worked_example", "worked_example", "note"]);
      expect(examples(source).map((b) => b.questionId)).toEqual(["we-1", "we-2", "we-3"]);
      expect(examples(source)[2]!.solution.kind).toBe("no_solution");

      // the new block sits at index 3; every other block is the source's, byte for byte and in order
      expect(out).toHaveLength(src.length + 1);
      const added = out[3] as ExampleBlock;
      expect(JSON.stringify([...out.slice(0, 3), ...out.slice(4)])).toBe(JSON.stringify(src));
      expect(added.type).toBe("worked_example");
      expect(added.questionId).toBe("we-4"); // the largest we-N plus one
      expect(isUniqueExample(added)).toBe(true);
      expect(added.steps.every((s, i) => s.id === `we-4.s${i + 1}`)).toBe(true);
      expect(exampleFitsLevel(added, level)).toBe(true);
      expect(out.at(-1)).toEqual(src.at(-1)); // the note is still last
      expect((out.at(-2) as ExampleBlock).solution.kind).toBe("no_solution"); // and still follows the no-solution example
      expect(out[0]).toEqual(src[0]); // intro paragraph

      const old = new Set([...examples(source), ...questions(source)].map(questionFingerprint));
      expect(old.has(questionFingerprint(added))).toBe(false);
      expectNoRepeatedEquation(result);
      expectEveryExampleVerified(result);

      expect(sectionOf(result, "worked_examples").provenance).toEqual({ ...sectionOf(source, "worked_examples").provenance, seed, difficulty, generatorVersion: GENERATOR_VERSION });
      expect(canonicalJson(result.outline)).toBe(canonicalJson(source.outline)); // D-65: no timing change
      expect(result.adjustments).toEqual([{ action: "add_worked_example", method: "deterministic", seed, sourceContentHash: packageContentHash(source) }]);
      expectPlanHolds(source, change, result);
      expectWorksheetHasNoAnswers(result);
      expect(JSON.stringify(apply(structuredClone(source), change))).toBe(JSON.stringify(result));
      deliveryFormsAgree(source, change);
    });
  }

  it("on a basic package (no no-solution example) appends the example at the end", () => {
    const source = testPackage({ difficulty: "basic", durationMinutes: 60 }, "we-basic");
    const result = apply(source, { action: "add_worked_example" });
    const src = blocksOf(source, "worked_examples");
    const out = blocksOf(result, "worked_examples");
    expect(src.map((b) => b.type)).toEqual(["paragraph", "worked_example", "worked_example"]);
    expect(JSON.stringify(out.slice(0, src.length))).toBe(JSON.stringify(src));
    expect(out).toHaveLength(src.length + 1);
    const added = out.at(-1) as ExampleBlock;
    expect(added.questionId).toBe("we-3");
    expect(exampleFitsLevel(added, "basic")).toBe(true);
    expectNoRepeatedEquation(result);
    expectEveryExampleVerified(result);
    expectPlanHolds(source, { action: "add_worked_example" }, result);
    deliveryFormsAgree(source, { action: "add_worked_example" });
  });

  it("can be repeated up to MAX_EXAMPLES, with unique ids, always before the no-solution example", () => {
    let pkg = testPackage({ difficulty: "mixed", durationMinutes: 30 }, "we-repeat"); // 1 unique + no-solution
    expect(examples(pkg).map((b) => b.questionId)).toEqual(["we-1", "we-2"]);
    const sources: LessonPackage[] = [];
    while (uniqueExamples(pkg).length < MAX_EXAMPLES) {
      sources.push(pkg);
      const next = apply(pkg, { action: "add_worked_example" });
      expectPlanHolds(pkg, { action: "add_worked_example" }, next);
      pkg = next;
    }
    expect(sources).toHaveLength(3);
    expect(examples(pkg).map((b) => b.questionId)).toEqual(["we-1", "we-3", "we-4", "we-5", "we-2"]);
    expect(blocksOf(pkg, "worked_examples").map((b) => b.type)).toEqual(["paragraph", ...Array(5).fill("worked_example"), "note"]);
    expect(examples(pkg).at(-1)!.solution.kind).toBe("no_solution");
    expectNoRepeatedEquation(pkg);
    expectEveryExampleVerified(pkg);
    expect(reasonOf(() => apply(pkg, { action: "add_worked_example" }))).toBe("max_examples");
    expect(pkg.adjustments).toHaveLength(3);
    // the source of each step is a different revision, so each step drew with a different seed
    expect(new Set(pkg.adjustments!.map((a) => a.seed)).size).toBe(3);
  });

  it("draws at the worked-examples section's own difficulty, not the exercises' adjusted one", () => {
    const harder = apply(testPackage({ difficulty: "basic" }, "we-after-harder"), { action: "make_harder" });
    const result = apply(harder, { action: "add_worked_example" });
    expect(sectionOf(result, "worked_examples").provenance.difficulty).toBe("basic");
    expect(exampleFitsLevel(examples(result).at(-1)!, "basic")).toBe(true);
    expectPlanHolds(harder, { action: "add_worked_example" }, result);
  });

  it("gives up with no_distinct_questions after 20 seeds", () => {
    const source = testPackage({ difficulty: "mixed" }, "we-exhaust");
    const change = { action: "add_worked_example" } as const;
    const seed = seedFor(source, change);
    draws.fail = true;
    draws.seeds = [];
    try {
      expect(reasonOf(() => apply(source, change))).toBe("no_distinct_questions");
    } finally {
      draws.fail = false;
    }
    expect(draws.seeds).toEqual(Array.from({ length: 20 }, (_, i) => `${seed}:examples:${i}`));
  });
});

describe("change_duration", () => {
  /** One change_duration, checked against a package freshly built at the new duration and against the plan. */
  function checkDuration(source: LessonPackage, to: number) {
    const before = canonicalJson(source);
    const change = { action: "change_duration", durationMinutes: to } as const;
    const plan = planAdjustment(source, change);
    const seed = seedFor(source, change);
    const result = apply(source, change);
    expect(canonicalJson(source)).toBe(before);
    expect(plan.outlineChanged).toBe(true);

    const request = source.request as { difficulty: Difficulty };
    const fresh = testPackage({ difficulty: request.difficulty, durationMinutes: to }, source.seed);
    const p = planOutline(to);
    // the outline is exactly the builder's for the new duration
    expect(canonicalJson(result.outline)).toBe(canonicalJson(fresh.outline));
    expect(result.outline.totalMinutes).toBe(to);
    expect(result.outline.sections.reduce((n, s) => n + s.minutes, 0)).toBe(to);
    expect(Object.fromEntries(result.outline.sections.filter((s) => s.minutes > 0).map((s) => [s.kind, s.minutes]))).toEqual({
      explanation: p.explanation, worked_examples: p.examples, teaching_sequence: p.review, exercises: p.exercises,
    });
    expect(effectiveSettings(result)).toEqual({ difficulty: effectiveSettings(source).difficulty, durationMinutes: to });

    // teaching sequence: only the timing block changes, and it matches the outline
    const ts = blocksOf(result, "teaching_sequence");
    const tsSource = blocksOf(source, "teaching_sequence");
    expect(ts.map((b) => b.type)).toEqual(tsSource.map((b) => b.type));
    ts.forEach((b, i) => {
      if (b.type === "timing") expect(b).toEqual(blocksOf(fresh, "teaching_sequence")[i]);
      else expect(JSON.stringify(b)).toBe(JSON.stringify(tsSource[i]));
    });

    const exercisesRedrawn = plan.changed.includes(sectionOf(source, "exercises").id);
    const examplesRedrawn = plan.changed.includes(sectionOf(source, "worked_examples").id);
    expect(exercisesRedrawn).toBe(questions(source).length !== p.exerciseCount);
    expect(examplesRedrawn).toBe(uniqueExamples(source).length !== p.exampleCount);
    const old = new Set([...examples(source), ...questions(source)].map(questionFingerprint));

    if (exercisesRedrawn) {
      const n = p.exerciseCount;
      const level = effectiveSettings(source).difficulty;
      expect(questions(result).map((q) => q.questionId)).toEqual(Array.from({ length: n }, (_, i) => `ex-${i + 1}`));
      const levels = difficultyRamp(n, level);
      questions(result).forEach((q, i) => expect(fitsLevel(result, q, levels[i]!), q.questionId).toBe(true));
      expect(questions(result).some((q) => old.has(questionFingerprint(q)))).toBe(false);
      const prov = { method: "deterministic", seed, difficulty: level, generatorVersion: GENERATOR_VERSION };
      expect(sectionOf(result, "exercises").provenance).toEqual(prov);
      expect(sectionOf(result, "solutions").provenance).toEqual(prov);
      expect(blocksOf(result, "exercises")[0]).toEqual(blocksOf(source, "exercises")[0]);
      expect(blocksOf(result, "exercises")).toHaveLength(1 + 2 * n);
    } else {
      expect(JSON.stringify(blocksOf(result, "exercises"))).toBe(JSON.stringify(blocksOf(source, "exercises")));
      expect(JSON.stringify(blocksOf(result, "solutions"))).toBe(JSON.stringify(blocksOf(source, "solutions")));
    }

    const weSource = blocksOf(source, "worked_examples");
    const weResult = blocksOf(result, "worked_examples");
    if (examplesRedrawn) {
      const k = p.exampleCount;
      const degenerate = examples(source).filter((b) => !isUniqueExample(b));
      // the builder's layout: intro, k unique examples we-1..we-k, then the no-solution example and its note
      expect(weResult[0]).toEqual(weSource[0]);
      expect(weResult.map((b) => b.type)).toEqual(["paragraph", ...Array(k + degenerate.length).fill("worked_example"), ...weSource.filter((b) => b.type === "note").map(() => "note")]);
      expect(examples(result).map((b) => b.questionId)).toEqual(Array.from({ length: k + degenerate.length }, (_, i) => `we-${i + 1}`));
      expect(uniqueExamples(result)).toHaveLength(k);
      if (degenerate.length > 0) {
        const kept = examples(result).at(-1)!;
        expect(kept.solution).toEqual(degenerate[0]!.solution);
        expect(questionFingerprint(kept)).toBe(questionFingerprint(degenerate[0]!));
        expect(weResult.at(-1)).toEqual(weSource.at(-1));
      }
      expect(uniqueExamples(result).some((b) => old.has(questionFingerprint(b)))).toBe(false);
      const sectionLevel = sectionOf(source, "worked_examples").provenance.difficulty ?? request.difficulty;
      const levels = difficultyRamp(k, sectionLevel === "basic" ? "basic" : "mixed");
      uniqueExamples(result).forEach((b, i) => expect(exampleFitsLevel(b, levels[i]!), b.questionId).toBe(true));
      expect(sectionOf(result, "worked_examples").provenance).toEqual({ ...sectionOf(source, "worked_examples").provenance, seed, difficulty: sectionLevel, generatorVersion: GENERATOR_VERSION });
    } else {
      expect(JSON.stringify(weResult)).toBe(JSON.stringify(weSource));
    }

    expectNoRepeatedEquation(result);
    expectEveryQuestionVerified(result);
    expectEveryExampleVerified(result);
    expect(result.adjustments).toEqual([...(source.adjustments ?? []), { action: "change_duration", method: "deterministic", seed, sourceContentHash: packageContentHash(source) }]);
    expectPlanHolds(source, change, result);
    expectWorksheetHasNoAnswers(result);
    expect(JSON.stringify(apply(structuredClone(source), change))).toBe(JSON.stringify(result));
    deliveryFormsAgree(source, change);
    return { plan, result };
  }

  const ids = (pkg: LessonPackage, ...kinds: Section["kind"][]) => kinds.map((k) => sectionOf(pkg, k).id);

  for (const difficulty of ["basic", "mixed", "challenge"] as const) {
    it(`${difficulty} 60 -> 30: fewer exercises and examples`, () => {
      const source = testPackage({ difficulty, durationMinutes: 60 }, `dur-${difficulty}-30`);
      const { plan, result } = checkDuration(source, 30);
      expect(plan.changed).toEqual(ids(source, "worked_examples", "teaching_sequence", "exercises"));
      expect(questions(result)).toHaveLength(3);
      expect(uniqueExamples(result)).toHaveLength(1);
    });
    it(`${difficulty} 60 -> 90: more exercises and examples`, () => {
      const source = testPackage({ difficulty, durationMinutes: 60 }, `dur-${difficulty}-90`);
      const { result } = checkDuration(source, 90);
      expect(questions(result)).toHaveLength(8);
      expect(uniqueExamples(result)).toHaveLength(3);
    });
  }

  it("90 -> 30", () => {
    const { result } = checkDuration(testPackage({ difficulty: "mixed", durationMinutes: 90 }, "dur-90-30"), 30);
    expect(examples(result).map((b) => b.questionId)).toEqual(["we-1", "we-2"]);
  });

  it("60 -> 62 changes only minutes: the timing block is regenerated, the rest is kept or rehashed", () => {
    const source = testPackage({ difficulty: "mixed", durationMinutes: 60 }, "dur-62");
    const { plan } = checkDuration(source, 62);
    expect(plan.changed).toEqual(ids(source, "teaching_sequence"));
    expect(plan.rehashed).toEqual(ids(source, "worked_examples", "exercises"));
    expect(plan.dependents).toEqual([]);
  });

  it("90 -> 95 redraws the exercises (8 -> 9) and keeps the examples (3 -> 3)", () => {
    const source = testPackage({ difficulty: "challenge", durationMinutes: 90 }, "dur-95");
    const { plan, result } = checkDuration(source, 95);
    expect(plan.changed).toEqual(ids(source, "teaching_sequence", "exercises"));
    expect(plan.dependents).toEqual(ids(source, "solutions"));
    expect(plan.rehashed).toEqual(ids(source, "worked_examples"));
    expect(questions(result)).toHaveLength(9);
  });

  it("refuses the same duration", () => {
    expect(reasonOf(() => apply(testPackage({ durationMinutes: 60 }), { action: "change_duration", durationMinutes: 60 }))).toBe("same_duration");
    const changed = apply(testPackage({ durationMinutes: 60 }, "dur-same"), { action: "change_duration", durationMinutes: 45 });
    expect(reasonOf(() => apply(changed, { action: "change_duration", durationMinutes: 45 }))).toBe("same_duration");
  });

  it("uses the adjusted difficulty for the exercises after make_harder", () => {
    const harder = apply(testPackage({ difficulty: "mixed", durationMinutes: 60 }, "dur-harder"), { action: "make_harder" });
    const { result } = checkDuration(harder, 120);
    expect(sectionOf(result, "exercises").provenance.difficulty).toBe("challenge");
  });

  it("discards examples and exercises added earlier when the new duration's counts differ, and keeps them otherwise", () => {
    let pkg = testPackage({ difficulty: "mixed", durationMinutes: 60 }, "dur-chain");
    pkg = apply(pkg, { action: "add_worked_example" }); // 3 unique
    pkg = apply(pkg, { action: "add_exercises", count: 2 }); // 8 exercises
    // 90 minutes means 8 exercises and 3 examples: both counts already match, so nothing is redrawn
    const kept = checkDuration(pkg, 90);
    expect(kept.plan.changed).toEqual(ids(pkg, "teaching_sequence"));
    expect(questions(kept.result)).toHaveLength(8);
    // back to 60: 6 exercises and 2 examples, so both sets are redrawn and the additions are gone
    const back = checkDuration(kept.result, 60);
    expect(questions(back.result)).toHaveLength(6);
    expect(uniqueExamples(back.result)).toHaveLength(2);
    expect(back.result.adjustments?.map((a) => a.action)).toEqual(["add_worked_example", "add_exercises", "change_duration", "change_duration"]);
  });

  it("covers the extremes of the duration range", () => {
    checkDuration(testPackage({ difficulty: "mixed", durationMinutes: 15 }, "dur-15"), 180);
    checkDuration(testPackage({ difficulty: "basic", durationMinutes: 180 }, "dur-180"), 15);
  });
});

// --- an independent exact re-check: a tiny rational solver that does not use the project's math code -----

type Q = readonly [bigint, bigint];
const gcdQ = (a: bigint, b: bigint): bigint => {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};
const mkQ = (n: bigint, d: bigint): Q => {
  if (d === 0n) throw new Error("zero denominator");
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcdQ(n, d) || 1n;
  return [n / g, d / g];
};
const parseQ = (t: string): Q => {
  const m = /^(-?\d+)(?:\/(\d+))?$/.exec(t);
  if (!m) throw new Error(`not a number: ${t}`);
  return mkQ(BigInt(m[1]!), BigInt(m[2] ?? "1"));
};
const addQ = (a: Q, b: Q) => mkQ(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const subQ = (a: Q, b: Q) => addQ(a, [-b[0], b[1]]);
const mulQ = (a: Q, b: Q) => mkQ(a[0] * b[0], a[1] * b[1]);
const divQ = (a: Q, b: Q) => mkQ(a[0] * b[1], a[1] * b[0]);
const sameQ = (a: Q, b: Q) => a[0] === b[0] && a[1] === b[1];
const Q0: Q = [0n, 1n];
const Q1: Q = [1n, 1n];

type Eq = { lhs: { x: string[]; c: string[] }; rhs: { x: string[]; c: string[] } };
/** An equation as [x coefficient left, constant left, x coefficient right, constant right]. */
const linOf = (e: Eq): Q[] => [e.lhs.x, e.lhs.c, e.rhs.x, e.rhs.c].map((terms) => terms.map(parseQ).reduce(addQ, Q0));

/** Null when the problem, every step and the claimed solution agree exactly; otherwise what is wrong. */
function independentCheck(id: string, problem: { equation: Eq }, solution: { kind: string; value?: string }, steps: { op: { type: string; value: string }; result: Eq }[]): string | null {
  const start = linOf(problem.equation);
  let cur = start;
  for (const step of steps) {
    const v = parseQ(step.op.value);
    const [lx, lc, rx, rc] = cur as [Q, Q, Q, Q];
    let next: Q[];
    if (step.op.type === "add_const_both_sides") next = [lx, addQ(lc, v), rx, addQ(rc, v)];
    else if (step.op.type === "add_x_term_both_sides") next = [addQ(lx, v), lc, addQ(rx, v), rc];
    else if (step.op.type === "multiply_both_sides" && v[0] !== 0n) next = cur.map((q) => mulQ(q, v));
    else if (step.op.type === "divide_both_sides" && v[0] !== 0n) next = cur.map((q) => divQ(q, v));
    else return `${id}: unsupported or invalid operation ${step.op.type} ${step.op.value}`;
    const stated = linOf(step.result);
    if (!next.every((q, i) => sameQ(q, stated[i]!))) return `${id}: step result does not follow from the operation`;
    cur = stated;
  }
  const [lx, lc, rx, rc] = start as [Q, Q, Q, Q];
  const a = subQ(lx, rx);
  const b = subQ(rc, lc);
  const [flx, flc, frx, frc] = cur as [Q, Q, Q, Q];
  if (a[0] !== 0n) {
    const x = divQ(b, a);
    if (solution.kind !== "unique" || solution.value === undefined || !sameQ(parseQ(solution.value), x)) return `${id}: wrong answer`;
    if (!sameQ(addQ(mulQ(lx, x), lc), addQ(mulQ(rx, x), rc))) return `${id}: substitution fails`;
    if (!(sameQ(flx, Q1) && sameQ(flc, Q0) && sameQ(frx, Q0) && sameQ(frc, x))) return `${id}: last step is not x = answer`;
    return null;
  }
  const expected = b[0] === 0n ? "identity" : "no_solution";
  if (solution.kind !== expected) return `${id}: claimed ${solution.kind}, is ${expected}`;
  if (!sameQ(flx, frx)) return `${id}: x not cancelled in the last step`;
  return null;
}

describe("independent exact re-check over random adjustment chains", () => {
  // ADJUST_SWEEP_N raises the number of random sources for a one-off larger sweep; the default keeps the suite quick.
  const N = Number(process.env.ADJUST_SWEEP_N ?? 150);
  it(`${N} random sources, chains of every deterministic action: 0 mismatches`, () => {
    const mismatches: string[] = [];
    const counts: Record<string, number> = {};
    let checked = 0;
    let stepsChecked = 0;
    let packages = 0;
    for (let i = 0; i < N; i++) {
      const rng = new Rng(`m6-task6-sweep|${i}`);
      const difficulty = rng.pick(["basic", "mixed", "challenge"] as const);
      let pkg = testPackage({ difficulty, durationMinutes: rng.int(15, 180) }, `sweep-${i}`);
      if (i % 3 === 1) pkg = canonicalCopy(pkg);
      if (i % 3 === 2) pkg = parsedCopy(pkg);
      const length = rng.int(2, 5);
      for (let k = 0; k < length; k++) {
        const candidates: ApplicableChange[] = [
          { action: "make_easier" },
          { action: "make_harder" },
          { action: "add_exercises", count: rng.int(1, 6) },
          { action: "add_worked_example" },
          { action: "add_worked_example" },
          { action: "change_duration", durationMinutes: rng.int(15, 180) },
          { action: "change_duration", durationMinutes: rng.int(15, 180) },
        ];
        const applicable = candidates.filter((c) => {
          try {
            planAdjustment(pkg, c);
            return true;
          } catch (e) {
            if (e instanceof AdjustmentNotApplicable) return false;
            throw e;
          }
        });
        if (applicable.length === 0) break;
        const change = rng.pick(applicable);
        const next = apply(pkg, change);
        counts[change.action] = (counts[change.action] ?? 0) + 1;
        packages++;
        const report = validatePackage(next);
        if (report.overall !== "verified") mismatches.push(`sweep-${i} step ${k} ${change.action}: ${report.overall}`);
        const sols = new Map(solutions(next).map((s) => [s.questionId, s]));
        for (const b of examples(next)) {
          const m = independentCheck(b.questionId, b.problem as { equation: Eq }, b.solution, b.steps as never);
          if (m) mismatches.push(`sweep-${i} step ${k}: ${m}`);
          checked++;
          stepsChecked += b.steps.length;
        }
        for (const q of questions(next)) {
          const s = sols.get(q.questionId);
          const m = s ? independentCheck(q.questionId, q.problem as { equation: Eq }, s.solution, s.steps as never) : `${q.questionId}: no solution block`;
          if (m) mismatches.push(`sweep-${i} step ${k}: ${m}`);
          checked++;
          stepsChecked += s?.steps.length ?? 0;
        }
        const eqs = [...examples(next), ...questions(next)].map(questionFingerprint);
        if (new Set(eqs).size !== eqs.length) mismatches.push(`sweep-${i} step ${k}: repeated equation`);
        pkg = next;
      }
    }
    if (process.env.ADJUST_SWEEP_N) console.log(JSON.stringify({ sources: N, packages, questions: checked, steps: stepsChecked, counts, mismatches: mismatches.length }));
    expect(mismatches).toEqual([]);
    for (const action of ["make_easier", "make_harder", "add_exercises", "add_worked_example", "change_duration"]) expect(counts[action] ?? 0, action).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(N * 10);
  });

  it("the re-check itself rejects a wrong answer, a wrong step and a wrong outcome", () => {
    const pkg = testPackage({ difficulty: "mixed" }, "self-test");
    const q = questions(pkg)[0]!;
    const s = solutions(pkg)[0]!;
    expect(independentCheck("ok", q.problem as { equation: Eq }, s.solution, s.steps as never)).toBeNull();
    const wrongValue = { kind: "unique", value: `${parseQ(s.solution.value!)[0] + 1n}/${parseQ(s.solution.value!)[1]}` };
    expect(independentCheck("v", q.problem as { equation: Eq }, wrongValue, s.steps as never)).toMatch(/wrong answer/);
    const badSteps = structuredClone(s.steps);
    badSteps[0]!.op.value = "1000";
    expect(independentCheck("s", q.problem as { equation: Eq }, s.solution, badSteps as never)).toMatch(/step result/);
    const nosol = examples(pkg).find((b) => b.solution.kind === "no_solution")!;
    expect(independentCheck("n", nosol.problem as { equation: Eq }, { kind: "identity" }, nosol.steps as never)).toMatch(/claimed identity/);
  });
});
