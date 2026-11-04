import { describe, expect, it } from "vitest";
import { runChecker } from "@/lib/math/checkers";
import { parseRawClaim, type AnswerDoc, type Claim, type CheckOutcome } from "@/lib/math/checkers/types";
import { parseMathText, type MathTextDoc } from "@/lib/math-text";

function doc(source: string): MathTextDoc {
  const r = parseMathText(source);
  if (!r.ok) throw new Error(`parse failed (${r.code}): ${source}`);
  return r.doc;
}
function claimOf(raw: unknown): Claim {
  const r = parseRawClaim(raw);
  if (!r.ok) throw new Error(`claim invalid: ${JSON.stringify(raw)}`);
  return r.claim;
}
function numberAnswer(source: string): AnswerDoc {
  return { kind: "number", value: doc(`\\(${source}\\)`) };
}
function textAnswer(source: string): AnswerDoc {
  return { kind: "text", value: doc(source) };
}
function rootsAnswer(...sources: string[]): AnswerDoc {
  return { kind: "roots", value: sources.map((s) => doc(`\\(${s}\\)`)) };
}
/** The stem displays the equation, so every claim built from the same source is bound by construction. */
function check(kind: "linear_equation" | "quadratic_equation", expr: string, answer: AnswerDoc): CheckOutcome {
  return runChecker({ stem: doc(`Solve \\(${expr}\\).`), answer, claim: claimOf({ kind, expr }) });
}

describe("linear_equation checker", () => {
  const passing: [string, string][] = [
    ["2x + 3 = 7", "2"],
    ["2x + 3 = 7", "x = 2"],
    ["\\frac{1}{2}x = 3", "6"],
    ["0.25x + 1 = 2", "4"],
    ["-3x = 12", "-4"],
    ["2(x - 3) = 4x + 1", "-\\frac{7}{2}"],
    ["\\frac{x + 1}{3} = 2", "5"],
    ["5 = 2x + 1", "2"],
    ["3t - 6 = 0", "t = 2"],
    ["7 - 2x = 2x - 1", "2"],
    ["0.2x = 0.5", "\\frac{5}{2}"],
  ];
  for (const [expr, stated] of passing) {
    it(`passes ${expr} with ${stated}`, () => {
      expect(check("linear_equation", expr, numberAnswer(stated))).toEqual({ result: "pass", checker: "linear_equation" });
    });
  }

  const failing: [string, string][] = [
    ["2x + 3 = 7", "-2"],
    ["2x + 3 = 7", "3"],
    ["2x + 3 = 7", "x = 1"],
    ["-3x = 12", "4"],
    ["2(x - 3) = 4x + 1", "\\frac{7}{2}"],
    ["\\frac{1}{2}x = 3", "\\frac{3}{2}"],
    ["2x + 1 = 2x + 5", "0"],
    ["2x + 1 = 2x + 1", "1"],
  ];
  for (const [expr, stated] of failing) {
    it(`fails ${expr} stated as ${stated}`, () => {
      expect(check("linear_equation", expr, numberAnswer(stated))).toEqual({
        result: "fail",
        checker: "linear_equation",
        reason: "answer_mismatch",
      });
    });
  }

  it("accepts the degenerate cases only through the matching text answer", () => {
    expect(check("linear_equation", "2x + 1 = 2x + 5", textAnswer("No solution."))).toEqual({
      result: "pass",
      checker: "linear_equation",
    });
    expect(check("linear_equation", "2x + 1 = 2x + 1", textAnswer("Infinitely many solutions"))).toEqual({
      result: "pass",
      checker: "linear_equation",
    });
    expect(check("linear_equation", "2x + 1 = 2x + 1", textAnswer("all real numbers"))).toEqual({
      result: "pass",
      checker: "linear_equation",
    });
  });

  it("fails a text answer that contradicts the equation", () => {
    const mismatch = { result: "fail", checker: "linear_equation", reason: "answer_mismatch" };
    expect(check("linear_equation", "2x + 3 = 7", textAnswer("no solution"))).toEqual(mismatch);
    expect(check("linear_equation", "2x + 3 = 7", textAnswer("infinitely many solutions"))).toEqual(mismatch);
    expect(check("linear_equation", "2x + 1 = 2x + 5", textAnswer("all real numbers"))).toEqual(mismatch);
    expect(check("linear_equation", "2x + 1 = 2x + 1", textAnswer("no solution"))).toEqual(mismatch);
  });

  it("reports no check when the claim is not displayed in the stem", () => {
    const outcome = runChecker({
      stem: doc("Solve \\(2x + 3 = 7\\)."),
      answer: numberAnswer("5"),
      claim: claimOf({ kind: "linear_equation", expr: "2x + 3 = 13" }),
    });
    expect(outcome).toEqual({ result: "none", reason: "claim_unbound" });
  });

  it("reports no check without a claim", () => {
    const outcome = runChecker({ stem: doc("Solve \\(2x = 4\\)."), answer: numberAnswer("2"), claim: undefined });
    expect(outcome).toEqual({ result: "none", reason: "no_claim" });
  });

  const unreadableClaims = ["x^2 = 4", "x + y = 3", "2 + 3 = 5", "x < 3", "2x + 3", "\\frac{1}{x} = 2", "x = 1 = 1"];
  for (const expr of unreadableClaims) {
    it(`reports claim_unreadable for ${expr}`, () => {
      expect(check("linear_equation", expr, numberAnswer("1"))).toEqual({ result: "none", reason: "claim_unreadable" });
    });
  }

  const unreadableAnswers = ["\\sqrt{2}", "y = 2", "x", "2x"];
  for (const stated of unreadableAnswers) {
    it(`reports answer_unreadable for the stated answer ${stated}`, () => {
      expect(check("linear_equation", "2x + 3 = 7", numberAnswer(stated))).toEqual({
        result: "none",
        reason: "answer_unreadable",
      });
    });
  }

  it("reports answer_unreadable for unknown prose and for a wrong answer kind", () => {
    expect(check("linear_equation", "2x + 3 = 7", textAnswer("about two"))).toEqual({
      result: "none",
      reason: "answer_unreadable",
    });
    expect(check("linear_equation", "2x + 3 = 7", rootsAnswer("2"))).toEqual({ result: "none", reason: "answer_unreadable" });
  });

  it("accepts a unit word after the number but refuses hedging prose", () => {
    const answer: AnswerDoc = { kind: "number", value: doc("\\(2\\) cm") };
    expect(check("linear_equation", "2x + 3 = 7", answer)).toEqual({ result: "pass", checker: "linear_equation" });
    const hedged: AnswerDoc = { kind: "number", value: doc("\\(2\\) or \\(3\\)") };
    expect(check("linear_equation", "2x + 3 = 7", hedged)).toEqual({ result: "none", reason: "answer_unreadable" });
  });
});

describe("quadratic_equation checker", () => {
  const pass = { result: "pass", checker: "quadratic_equation" };
  const mismatch = { result: "fail", checker: "quadratic_equation", reason: "answer_mismatch" };

  const passing: [string, string[]][] = [
    ["x^2 - 5x + 6 = 0", ["x = 2", "x = 3"]],
    ["x^2 - 5x + 6 = 0", ["3", "2"]],
    ["x^2 - 4 = 0", ["2", "-2"]],
    ["x^2 - 2x + 1 = 0", ["1"]],
    ["x^2 - 2x + 1 = 0", ["1", "1"]],
    ["2x^2 - 4x = 0", ["0", "2"]],
    ["\\frac{1}{2}x^2 - 2 = 0", ["-2", "2"]],
    ["x^2 = 5x - 6", ["2", "3"]],
    ["x^2 - 2 = 0", ["\\sqrt{2}", "-\\sqrt{2}"]],
    ["x^2 - 2 = 0", ["\\pm\\sqrt{2}"]],
    ["x^2 - x - 1 = 0", ["\\frac{1 \\pm \\sqrt{5}}{2}"]],
    ["x^2 - x - 1 = 0", ["\\frac{1 + \\sqrt{5}}{2}", "\\frac{1 - \\sqrt{5}}{2}"]],
    ["0.5x^2 - 2x + 2 = 0", ["2"]],
    ["x^2 + 2x - 8 = 0", ["-4", "2"]],
    ["2x^2 - 8 = 0", ["x = 2", "x = -2"]],
  ];
  for (const [expr, roots] of passing) {
    it(`passes ${expr} with ${roots.join(", ")}`, () => {
      expect(check("quadratic_equation", expr, rootsAnswer(...roots))).toEqual(pass);
    });
  }

  const failing: [string, string[]][] = [
    ["x^2 - 5x + 6 = 0", ["2"]],
    ["x^2 - 5x + 6 = 0", ["2", "3", "4"]],
    ["x^2 - 5x + 6 = 0", ["2", "4"]],
    ["x^2 - 5x + 6 = 0", ["-2", "-3"]],
    ["x^2 - 4 = 0", ["2"]],
    ["x^2 - 2x + 1 = 0", ["1", "-1"]],
    ["x^2 - x - 1 = 0", ["\\frac{1 + \\sqrt{5}}{2}"]],
    ["x^2 - x - 1 = 0", ["\\frac{-1 \\pm \\sqrt{5}}{2}"]],
    ["x^2 + 2x - 8 = 0", ["4", "-2"]],
  ];
  for (const [expr, roots] of failing) {
    it(`fails ${expr} stated as ${roots.join(", ")}`, () => {
      expect(check("quadratic_equation", expr, rootsAnswer(...roots))).toEqual(mismatch);
    });
  }

  it("handles the no-real-root case through text only", () => {
    expect(check("quadratic_equation", "x^2 + 1 = 0", textAnswer("No real roots"))).toEqual(pass);
    expect(check("quadratic_equation", "x^2 + 1 = 0", textAnswer("no real solutions"))).toEqual(pass);
    expect(check("quadratic_equation", "x^2 + 1 = 0", textAnswer("no solution"))).toEqual(pass);
    expect(check("quadratic_equation", "x^2 + 1 = 0", rootsAnswer("1", "-1"))).toEqual(mismatch);
    expect(check("quadratic_equation", "x^2 - 4 = 0", textAnswer("no real roots"))).toEqual(mismatch);
    expect(check("quadratic_equation", "x^2 - 4 = 0", textAnswer("infinitely many solutions"))).toEqual(mismatch);
  });

  const unreadableClaims = ["2x + 1 = 3", "x^3 - 1 = 0", "x^2 + y = 0", "x^2 - 4", "x^2 \\ge 4"];
  for (const expr of unreadableClaims) {
    it(`reports claim_unreadable for ${expr}`, () => {
      expect(check("quadratic_equation", expr, rootsAnswer("2"))).toEqual({ result: "none", reason: "claim_unreadable" });
    });
  }

  it("reports answer_unreadable for mixed radicands, variables and the wrong kind", () => {
    expect(check("quadratic_equation", "x^2 - 5x + 6 = 0", rootsAnswer("\\sqrt{2}", "\\sqrt{3}"))).toEqual({
      result: "none",
      reason: "answer_unreadable",
    });
    expect(check("quadratic_equation", "x^2 - 5x + 6 = 0", rootsAnswer("x"))).toEqual({
      result: "none",
      reason: "answer_unreadable",
    });
    expect(check("quadratic_equation", "x^2 - 5x + 6 = 0", numberAnswer("2"))).toEqual({
      result: "none",
      reason: "answer_unreadable",
    });
    expect(check("quadratic_equation", "x^2 - 5x + 6 = 0", { kind: "roots", value: [] })).toEqual({
      result: "none",
      reason: "answer_unreadable",
    });
  });

  it("rejects a root labelled with the wrong variable", () => {
    expect(check("quadratic_equation", "x^2 - 4 = 0", rootsAnswer("y = 2", "y = -2"))).toEqual({
      result: "none",
      reason: "answer_unreadable",
    });
  });
});
