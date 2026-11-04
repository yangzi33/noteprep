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
function textAnswer(source: string): AnswerDoc {
  return { kind: "text", value: doc(source) };
}
function pairAnswer(...sources: string[]): AnswerDoc {
  return { kind: "pair", value: sources.map((s) => doc(`\\(${s}\\)`)) };
}
function inequalityAnswer(source: string): AnswerDoc {
  return { kind: "inequality", value: doc(`\\(${source}\\)`) };
}
function checkSystem(first: string, second: string, answer: AnswerDoc): CheckOutcome {
  return runChecker({
    stem: doc(`Solve \\(${first}\\) and \\(${second}\\).`),
    answer,
    claim: claimOf({ kind: "linear_system", exprs: [first, second] }),
  });
}
function checkInequality(expr: string, answer: AnswerDoc): CheckOutcome {
  return runChecker({ stem: doc(`Solve \\(${expr}\\).`), answer, claim: claimOf({ kind: "linear_inequality", expr }) });
}

describe("linear_system checker", () => {
  const pass = { result: "pass", checker: "linear_system" };
  const mismatch = { result: "fail", checker: "linear_system", reason: "answer_mismatch" };

  const passing: [string, string, string[]][] = [
    ["x + y = 5", "x - y = 1", ["3", "2"]],
    ["x + y = 5", "x - y = 1", ["x = 3", "y = 2"]],
    ["x + y = 5", "x - y = 1", ["y = 2", "x = 3"]],
    ["x + y = 5", "x - y = 1", ["(3, 2)"]],
    ["2x + 3y = 12", "x - y = 1", ["3", "2"]],
    ["2x - 3y = 4", "x + y = 3", ["\\frac{13}{5}", "\\frac{2}{5}"]],
    ["0.5x + y = 2", "x - y = 1", ["2", "1"]],
    ["\\frac{1}{2}x + y = 2", "x - y = 1", ["2", "1"]],
    ["-x + 2y = 3", "x + y = 3", ["1", "2"]],
    ["a + b = 5", "a - b = 1", ["3", "2"]],
    ["3x = 2y", "x + y = 5", ["2", "3"]],
    ["2(x + y) = 10", "x - y = 1", ["3", "2"]],
  ];
  for (const [first, second, stated] of passing) {
    it(`passes ${first}; ${second} with ${stated.join(", ")}`, () => {
      expect(checkSystem(first, second, pairAnswer(...stated))).toEqual(pass);
    });
  }

  const failing: [string, string, string[]][] = [
    ["x + y = 5", "x - y = 1", ["2", "3"]],
    ["x + y = 5", "x - y = 1", ["-3", "2"]],
    ["x + y = 5", "x - y = 1", ["3", "3"]],
    ["x + y = 5", "x - y = 1", ["x = 2", "y = 3"]],
    ["x + y = 5", "x - y = 1", ["(2, 3)"]],
    ["-x + 2y = 3", "x + y = 3", ["2", "1"]],
  ];
  for (const [first, second, stated] of failing) {
    it(`fails ${first}; ${second} stated as ${stated.join(", ")}`, () => {
      expect(checkSystem(first, second, pairAnswer(...stated))).toEqual(mismatch);
    });
  }

  it("separates parallel lines from the same line", () => {
    expect(checkSystem("x + y = 1", "2x + 2y = 3", textAnswer("No solution"))).toEqual(pass);
    expect(checkSystem("x + y = 1", "2x + 2y = 2", textAnswer("infinitely many solutions"))).toEqual(pass);
    expect(checkSystem("x + y = 1", "2x + 2y = 3", textAnswer("infinitely many solutions"))).toEqual(mismatch);
    expect(checkSystem("x + y = 1", "2x + 2y = 2", textAnswer("no solution"))).toEqual(mismatch);
    expect(checkSystem("x + y = 1", "2x + 2y = 3", pairAnswer("1", "0"))).toEqual(mismatch);
    expect(checkSystem("x + y = 5", "x - y = 1", textAnswer("no solution"))).toEqual(mismatch);
  });

  it("reports claim_unbound when an equation is not displayed or only one span matches", () => {
    expect(
      runChecker({
        stem: doc("Solve \\(x + y = 5\\) and \\(x - y = 1\\)."),
        answer: pairAnswer("3", "2"),
        claim: claimOf({ kind: "linear_system", exprs: ["x + y = 5", "x - y = 2"] }),
      }),
    ).toEqual({ result: "none", reason: "claim_unbound" });
    expect(
      runChecker({
        stem: doc("Solve \\(x + y = 5\\) and \\(x - y = 1\\)."),
        answer: pairAnswer("3", "2"),
        claim: claimOf({ kind: "linear_system", exprs: ["x + y = 5", "x + y = 5"] }),
      }),
    ).toEqual({ result: "none", reason: "claim_unbound" });
  });

  const unreadable: [string, string][] = [
    ["x^2 + y = 1", "x - y = 1"],
    ["x + y = 5", "x + z = 1"],
    ["x = 5", "2x = 1"],
    ["xy = 1", "x + y = 3"],
    ["x + y", "x - y = 1"],
    ["x + y = 5", "2 = 3"],
  ];
  for (const [first, second] of unreadable) {
    it(`reports claim_unreadable for ${first}; ${second}`, () => {
      expect(checkSystem(first, second, pairAnswer("1", "1"))).toEqual({ result: "none", reason: "claim_unreadable" });
    });
  }

  it("reports answer_unreadable for the wrong shape or kind", () => {
    const unreadableAnswer = { result: "none", reason: "answer_unreadable" };
    expect(checkSystem("x + y = 5", "x - y = 1", pairAnswer("3"))).toEqual(unreadableAnswer);
    expect(checkSystem("x + y = 5", "x - y = 1", pairAnswer("3", "2", "1"))).toEqual(unreadableAnswer);
    expect(checkSystem("x + y = 5", "x - y = 1", pairAnswer("x = 3", "2"))).toEqual(unreadableAnswer);
    expect(checkSystem("x + y = 5", "x - y = 1", pairAnswer("(3, 2, 1)"))).toEqual(unreadableAnswer);
    expect(checkSystem("x + y = 5", "x - y = 1", pairAnswer("z = 3", "y = 2"))).toEqual(unreadableAnswer);
    expect(checkSystem("x + y = 5", "x - y = 1", { kind: "number", value: doc("\\(3\\)") })).toEqual(unreadableAnswer);
    expect(checkSystem("x + y = 5", "x - y = 1", textAnswer("three and two"))).toEqual(unreadableAnswer);
  });
});

describe("linear_inequality checker", () => {
  const pass = { result: "pass", checker: "linear_inequality" };
  const mismatch = { result: "fail", checker: "linear_inequality", reason: "answer_mismatch" };

  const passing: [string, string][] = [
    ["2x + 3 < 7", "x < 2"],
    ["2x + 3 < 7", "2 > x"],
    ["-2x > 4", "x < -2"],
    ["3x - 1 \\le 5", "x \\le 2"],
    ["-\\frac{1}{2}x \\ge 1", "x \\le -2"],
    ["2x + 1 \\le 4x", "x \\ge \\frac{1}{2}"],
    ["0.5x > 1", "x > 2"],
    ["2(x - 1) < x + 1", "x < 3"],
    ["5 - x > 1", "x < 4"],
    ["3t + 1 \\ge 7", "t \\ge 2"],
  ];
  for (const [expr, stated] of passing) {
    it(`passes ${expr} with ${stated}`, () => {
      expect(checkInequality(expr, inequalityAnswer(stated))).toEqual(pass);
    });
  }

  const failing: [string, string][] = [
    ["2x + 3 < 7", "x > 2"],
    ["2x + 3 < 7", "x \\le 2"],
    ["2x + 3 < 7", "x < 3"],
    ["2x + 3 < 7", "x < -2"],
    ["-2x > 4", "x > -2"],
    ["3x - 1 \\le 5", "x < 2"],
    ["2x + 1 \\le 4x", "x \\le \\frac{1}{2}"],
    ["-\\frac{1}{2}x \\ge 1", "x \\ge -2"],
  ];
  for (const [expr, stated] of failing) {
    it(`fails ${expr} stated as ${stated}`, () => {
      expect(checkInequality(expr, inequalityAnswer(stated))).toEqual(mismatch);
    });
  }

  it("handles the degenerate solution sets", () => {
    expect(checkInequality("2x + 1 > 2x", textAnswer("All real numbers"))).toEqual(pass);
    expect(checkInequality("2x + 1 < 2x", textAnswer("No solution"))).toEqual(pass);
    expect(checkInequality("2x + 1 > 2x", textAnswer("no solution"))).toEqual(mismatch);
    expect(checkInequality("2x + 1 < 2x", textAnswer("all real numbers"))).toEqual(mismatch);
    expect(checkInequality("2x + 1 > 2x", inequalityAnswer("x > 0"))).toEqual(mismatch);
    expect(checkInequality("2x + 3 < 7", textAnswer("no solution"))).toEqual(mismatch);
  });

  const unreadableClaims = ["x \\neq 3", "2x + 3 = 7", "x^2 < 4", "x < y", "1 < 2", "1 < x < 3"];
  for (const expr of unreadableClaims) {
    it(`reports claim_unreadable for ${expr}`, () => {
      expect(checkInequality(expr, inequalityAnswer("x < 1"))).toEqual({ result: "none", reason: "claim_unreadable" });
    });
  }

  it("reports answer_unreadable for interval notation, the wrong variable and the wrong kind", () => {
    const unreadableAnswer = { result: "none", reason: "answer_unreadable" };
    expect(checkInequality("2x + 3 < 7", inequalityAnswer("(2, 5)"))).toEqual(unreadableAnswer);
    expect(checkInequality("2x + 3 < 7", inequalityAnswer("y < 2"))).toEqual(unreadableAnswer);
    expect(checkInequality("2x + 3 < 7", inequalityAnswer("x < \\sqrt{2}"))).toEqual(unreadableAnswer);
    expect(checkInequality("2x + 3 < 7", inequalityAnswer("x \\neq 2"))).toEqual(unreadableAnswer);
    expect(checkInequality("2x + 3 < 7", inequalityAnswer("2x < 4"))).toEqual(unreadableAnswer);
    expect(checkInequality("2x + 3 < 7", { kind: "number", value: doc("\\(2\\)") })).toEqual(unreadableAnswer);
  });
});
