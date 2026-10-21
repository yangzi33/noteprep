import { describe, expect, it, vi } from "vitest";
import type { CurriculumContext } from "@/lib/curriculum/context";
import type { AdjustmentChange } from "@/lib/domain/adjustment";
import { AdjustmentNotApplicable } from "@/lib/domain/errors";
import { canonicalJson, sha256Hex } from "@/lib/domain/hash";
import { difficultyRamp, GENERATOR_VERSION, questionFingerprint, type Difficulty } from "@/lib/math/generator";
import { Rational } from "@/lib/math/rational";
import { validateLinearQuestion } from "@/lib/math/validate";
import { adjustmentSeed, applyAdjustment, packageContentHash, planAdjustment, type ApplicableChange } from "@/lib/package/adjust";
import { effectiveSettings } from "@/lib/package/effective";
import type { LessonPackage, Section } from "@/lib/package/schema";
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
  it("add_worked_example and change_duration are not implemented yet (Task 6)", () => {
    const source = testPackage({ difficulty: "mixed" }, "t6");
    const context = source.context as CurriculumContext;
    expect(() => applyAdjustment(source, { action: "add_worked_example" }, { seed: "s", context })).toThrow(/not implemented/);
    expect(() => applyAdjustment(source, { action: "change_duration", durationMinutes: 90 }, { seed: "s", context })).toThrow(/not implemented/);
  });
});
