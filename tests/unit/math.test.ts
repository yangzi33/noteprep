import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyOperation, isOperationType, sameSolution, satisfies, solve, ZeroOperandError } from "@/lib/math/linear";
import { NUMBER_LIMITS, Rational, withinLimits } from "@/lib/math/rational";
import { QuestionSchema } from "@/lib/math/schema";
import {
  contentHashOf,
  currentStatus,
  deriveStatus,
  validateLessonMath,
  validateLinearQuestion,
  withSupplementary,
  type Check,
  type LessonMathInput,
  type ValidationStatus,
} from "@/lib/math/validate";

const R = Rational.parse;
const load = <T>(file: string): T => JSON.parse(readFileSync(path.join(__dirname, "../fixtures/math", file), "utf8"));

describe("exact rational arithmetic", () => {
  it("normalizes sign and lowest terms", () => {
    expect(Rational.of(2n, 4n).toString()).toBe("1/2");
    expect(Rational.of(1n, -2n).toString()).toBe("-1/2");
    expect(Rational.of(-6n, -3n).toString()).toBe("2");
    expect(R("-0").toString()).toBe("0");
    expect(R("2/6").eq(R("1/3"))).toBe(true);
  });
  it("is exact where floating point is not", () => {
    expect(R("1/10").add(R("2/10")).eq(R("3/10"))).toBe(true); // 0.1 + 0.2 !== 0.3 in floats
    expect(R("1/3").add(R("1/3")).add(R("1/3")).eq(Rational.ONE)).toBe(true);
    expect(R("1/3").mul(R("3")).eq(Rational.ONE)).toBe(true);
  });
  it("never divides by zero", () => {
    expect(() => R("1").div(Rational.ZERO)).toThrow(RangeError);
    expect(() => Rational.of(1n, 0n)).toThrow(RangeError);
  });
  it("sums lists and handles very large values without overflow", () => {
    expect(Rational.sum([R("1/2"), R("1/3"), R("1/6")]).eq(Rational.ONE)).toBe(true);
    const big = Rational.of(10n ** 40n, 3n);
    expect(big.mul(R("3")).eq(Rational.of(10n ** 40n))).toBe(true);
  });
  it.each(["0.5", "1e3", " 1", "1 ", "+1", "--1", "1/0", "1/-2", "1/2/3", "abc", "", "٣", "1.", ".5", "00", "01", "1_000"])(
    "refuses %j as an exact number",
    (text) => {
      expect(Rational.tryParse(text)).toBeNull();
    },
  );
  it("applies range limits to the numbers that may appear in content", () => {
    expect(withinLimits(R("1000000"))).toBe(true);
    expect(withinLimits(R("1000001"))).toBe(false);
    expect(withinLimits(R("1/1000"))).toBe(true);
    expect(withinLimits(R("1/1001"))).toBe(false);
    expect(NUMBER_LIMITS.maxAbsNumerator).toBe(1_000_000n);
  });
});

describe("linear solving and operations", () => {
  const lin = (a: string, b: string) => ({ a: R(a), b: R(b) });
  it("classifies unique, no-solution and identity equations by coefficients", () => {
    const unique = solve(lin("3", "5"), lin("0", "20"));
    expect(unique.kind === "unique" && unique.value.toString()).toBe("5");
    expect(solve(lin("4", "6"), lin("4", "-2")).kind).toBe("no_solution");
    expect(solve(lin("2", "3"), lin("2", "3")).kind).toBe("identity");
    expect(sameSolution(unique, solve(lin("1", "0"), lin("0", "5")))).toBe(true);
    expect(sameSolution(unique, { kind: "no_solution" })).toBe(false);
  });
  it("checks a claimed value by substitution", () => {
    expect(satisfies(lin("2", "-7"), lin("5", "8"), R("-5"))).toBe(true);
    expect(satisfies(lin("2", "-7"), lin("5", "8"), R("5"))).toBe(false);
  });
  it("applies each operation to both sides and refuses a zero multiplier or divisor", () => {
    const l = lin("3", "5");
    const r = lin("0", "20");
    expect(applyOperation(l, r, "add_const_both_sides", R("-5"))).toEqual({ lhs: lin("3", "0"), rhs: lin("0", "15") });
    expect(applyOperation(l, r, "add_x_term_both_sides", R("-3")).lhs.a.isZero()).toBe(true);
    expect(applyOperation(lin("1/2", "0"), lin("0", "4"), "multiply_both_sides", R("2")).rhs.b.toString()).toBe("8");
    expect(() => applyOperation(l, r, "divide_both_sides", Rational.ZERO)).toThrow(ZeroOperandError);
    expect(() => applyOperation(l, r, "multiply_both_sides", Rational.ZERO)).toThrow(ZeroOperandError);
    expect(isOperationType("distribute")).toBe(false);
  });
});

interface QuestionFixture {
  name: string;
  reasoning: string;
  question: unknown;
  expect: { status: ValidationStatus; mustFail?: string[]; reason?: string };
}

describe("hand-reviewed question fixtures", () => {
  const fixtures = load<QuestionFixture[]>("questions.json");

  it("has a spread of cases", () => {
    const count = (s: ValidationStatus) => fixtures.filter((f) => f.expect.status === s).length;
    expect(count("verified")).toBeGreaterThanOrEqual(8);
    expect(count("failed")).toBeGreaterThanOrEqual(12);
    expect(count("unverified")).toBeGreaterThanOrEqual(4);
    expect(new Set(fixtures.map((f) => f.name)).size).toBe(fixtures.length);
  });

  it.each(fixtures.map((f) => [f.name, f] as const))("%s", (_name, fixture) => {
    expect(fixture.reasoning.length).toBeGreaterThan(10); // every case carries its human derivation
    const report = validateLinearQuestion(fixture.question);
    expect(report.status, JSON.stringify(report.checks)).toBe(fixture.expect.status);
    for (const name of fixture.expect.mustFail ?? []) {
      expect(report.checks.find((c) => c.name === name)?.result, `check ${name}`).toBe("fail");
    }
    if (fixture.expect.reason) {
      expect(report.checks.some((c) => c.detail?.includes(fixture.expect.reason!))).toBe(true);
    }
    if (fixture.expect.status === "verified") {
      // Verified means every required deterministic check ran and passed (or was not applicable).
      expect(report.checks.every((c) => c.result === "pass" || c.result === "not_applicable")).toBe(true);
    }
  });

  it("records the validator version, a content hash and the limits of what was checked", () => {
    const report = validateLinearQuestion(fixtures[0]!.question);
    expect(report.validatorVersion).toMatch(/^linear-1var\//);
    expect(report.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.limitations.join(" ")).toMatch(/narration/);
  });
});

describe("whole-lesson fixtures", () => {
  const lessons = load<{ name: string; reasoning: string; lesson: LessonMathInput; expect: { overall: ValidationStatus; failedSetChecks?: string[] } }[]>("lessons.json");
  it.each(lessons.map((l) => [l.name, l] as const))("%s", (_name, f) => {
    const report = validateLessonMath(f.lesson);
    expect(report.overall).toBe(f.expect.overall);
    for (const name of f.expect.failedSetChecks ?? []) {
      expect(report.setChecks.find((c) => c.name === name)?.result).toBe("fail");
    }
  });

  it("reports one item per example and exercise, tied to the right ids", () => {
    const complete = lessons.find((l) => l.name === "complete_and_correct")!;
    const report = validateLessonMath(complete.lesson);
    expect(report.items.map((i) => i.questionId)).toEqual(["we-1", "ex-1", "ex-2"]);
    expect(report.items.every((i) => i.status === "verified")).toBe(true);
    expect(report.setChecks.every((c) => c.result === "pass")).toBe(true);
  });
});

describe("what can and cannot make a question verified", () => {
  const questions = load<QuestionFixture[]>("questions.json");
  const byName = (name: string) => questions.find((f) => f.name === name)!.question;

  it("derives the status from deterministic checks only", () => {
    const pass = (name: string): Check => ({ name, result: "pass" });
    const all = ["params_domain", "equation_matches_params", "exact_solve", "answer_key_match", "substitution", "step_equivalence", "final_form"].map(pass);
    expect(deriveStatus(all)).toBe("verified");
    expect(deriveStatus(all.slice(1))).toBe("unverified"); // a required check never ran
    expect(deriveStatus([...all, { name: "step_equivalence", result: "fail" }])).toBe("failed");
    expect(deriveStatus([])).toBe("unverified");
  });

  it("a model's review or random sampling cannot upgrade an unverified or failed question", () => {
    const unverified = validateLinearQuestion(byName("no_steps_to_check"));
    const failed = validateLinearQuestion(byName("wrong_answer"));
    for (const evidence of [
      [{ name: "llm_review", result: "pass" as const }],
      [{ name: "random_numeric_sampling", result: "pass" as const, detail: "1000 samples" }],
      [
        { name: "llm_review", result: "pass" as const },
        { name: "random_numeric_sampling", result: "pass" as const },
      ],
    ]) {
      expect(withSupplementary(unverified, evidence).status).toBe("unverified");
      expect(withSupplementary(failed, evidence).status).toBe("failed");
    }
  });

  it("a supplementary concern demotes verified to unverified, so a human must look", () => {
    const verified = validateLinearQuestion(byName("unique_integer"));
    expect(verified.status).toBe("verified");
    const flagged = withSupplementary(verified, [{ name: "llm_review", result: "fail", detail: "possible_issue" }]);
    expect(flagged.status).toBe("unverified");
    expect(flagged.checks.at(-1)).toMatchObject({ supplementary: true });
    expect(withSupplementary(verified, [{ name: "llm_review", result: "pass" }]).status).toBe("verified"); // unchanged, not improved
  });
});

describe("edits invalidate earlier validation", () => {
  const base = JSON.parse(JSON.stringify(load<QuestionFixture[]>("questions.json").find((f) => f.name === "unique_integer")!.question));

  it("a report is current only for the exact content it was computed from", () => {
    const report = validateLinearQuestion(base);
    expect(currentStatus(report, base)).toBe("verified");
    // key order does not matter
    expect(currentStatus(report, { steps: base.steps, solution: base.solution, problem: base.problem })).toBe("verified");
  });

  it.each([
    ["a changed parameter", (q: typeof base) => void (q.problem.params.a = "4")],
    ["a changed answer", (q: typeof base) => void (q.solution.value = "6")],
    ["an edited step", (q: typeof base) => void (q.steps[0].result.rhs.c = ["16"])],
    ["a removed step", (q: typeof base) => void q.steps.pop()],
  ])("%s makes the old verdict stale", (_name, edit) => {
    const report = validateLinearQuestion(base);
    const edited = JSON.parse(JSON.stringify(base));
    edit(edited);
    expect(contentHashOf(edited)).not.toBe(report.contentHash);
    expect(currentStatus(report, edited)).toBe("unverified");
  });

  it("revalidating the edited content gives its own, possibly different, verdict", () => {
    const edited = JSON.parse(JSON.stringify(base));
    edited.problem.params.a = "4"; // the equation text still says 3x
    expect(validateLinearQuestion(edited).status).toBe("failed");
  });
});

describe("the validator never executes or evaluates content", () => {
  it("treats code-looking strings as plain, invalid numbers", () => {
    const q = JSON.parse(JSON.stringify(load<QuestionFixture[]>("questions.json").find((f) => f.name === "unique_integer")!.question));
    for (const hostile of ["process.exit(1)", "2+2", "constructor", "__proto__", "1; DROP TABLE x"]) {
      q.problem.params.a = hostile;
      expect(validateLinearQuestion(q).status).toBe("failed");
    }
  });
  it("tolerates non-object input without throwing", () => {
    for (const junk of [null, undefined, 42, "text", [], {}]) {
      expect(validateLinearQuestion(junk).status).toBe("failed");
    }
  });
});

describe("math schemas are strict", () => {
  it("an extra key inside a question, problem, solution or step fails validation", () => {
    const question = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/math/questions.json"), "utf8"))[0].question;
    expect(QuestionSchema.safeParse(question).success).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inject = (mutate: (q: any) => void) => {
      const q = JSON.parse(JSON.stringify(question));
      mutate(q);
      return QuestionSchema.safeParse(q).success;
    };
    expect(inject((q) => (q.extra = 1))).toBe(false);
    expect(inject((q) => (q.problem.extra = 1))).toBe(false);
    expect(inject((q) => (q.problem.equation.extra = 1))).toBe(false);
    expect(inject((q) => (q.problem.equation.lhs.extra = 1))).toBe(false);
    expect(inject((q) => (q.solution.extra = 1))).toBe(false);
    expect(inject((q) => (q.steps[0].extra = 1))).toBe(false);
    expect(inject((q) => (q.steps[0].op.extra = 1))).toBe(false);
  });
});
