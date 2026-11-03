import { describe, expect, it } from "vitest";
import { runChecker } from "@/lib/math/checkers";
import { parseRawClaim, type AnswerDoc, type Claim, type CheckOutcome, type RawClaim } from "@/lib/math/checkers/types";
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
function check(stem: string, raw: RawClaim, answer: AnswerDoc): CheckOutcome {
  return runChecker({ stem: doc(stem), answer, claim: claimOf(raw) });
}

const pass = { result: "pass", checker: "numeric" };
const mismatch = { result: "fail", checker: "numeric", reason: "answer_mismatch" };
const unreadableClaim = { result: "none", reason: "claim_unreadable" };
const unreadableAnswer = { result: "none", reason: "answer_unreadable" };

const SEQUENCE_STEM = "The first term is \\(3\\), the common difference is \\(4\\). Find term \\(10\\).";
const GEOMETRIC_STEM = "The first term is \\(2\\) and the ratio is \\(3\\). Find term \\(5\\) and the sum of \\(4\\) terms.";

describe("numeric checker: evaluate", () => {
  const passing: [string, string][] = [
    ["2 + 3 \\cdot 4", "14"],
    ["\\frac{2}{3} + \\frac{1}{6}", "\\frac{5}{6}"],
    ["0.2 \\cdot 15", "3"],
    ["\\sqrt{3^2 + 4^2}", "5"],
    ["2^{5}", "32"],
    ["|3 - 10|", "7"],
    ["15\\%", "0.15"],
    ["\\sqrt[3]{64}", "4"],
    ["\\frac{3}{4} \\div \\frac{1}{2}", "1.5"],
  ];
  for (const [expr, stated] of passing) {
    it(`passes ${expr} with ${stated}`, () => {
      expect(check(`Evaluate \\(${expr}\\).`, { kind: "evaluate", expr }, numberAnswer(stated))).toEqual(pass);
    });
  }

  it("fails a wrong value", () => {
    expect(check("Evaluate \\(2 + 3 \\cdot 4\\).", { kind: "evaluate", expr: "2 + 3 \\cdot 4" }, numberAnswer("20"))).toEqual(
      mismatch,
    );
    expect(check("Evaluate \\(\\sqrt{3^2 + 4^2}\\).", { kind: "evaluate", expr: "\\sqrt{3^2 + 4^2}" }, numberAnswer("7"))).toEqual(
      mismatch,
    );
    expect(check("Evaluate \\(15\\%\\).", { kind: "evaluate", expr: "15\\%" }, numberAnswer("15"))).toEqual(mismatch);
  });

  const unreadable = ["1 \\div 0", "x + 1", "2 + 3 = 5", "\\sqrt{2}", "\\frac{1}{0}", "\\sin 30", "2 \\pm 3"];
  for (const expr of unreadable) {
    it(`reports claim_unreadable for ${expr}`, () => {
      expect(check(`Evaluate \\(${expr}\\).`, { kind: "evaluate", expr }, numberAnswer("1"))).toEqual(unreadableClaim);
    });
  }

  it("reports claim_unbound when the expression is not displayed", () => {
    expect(check("Evaluate \\(2 + 3\\).", { kind: "evaluate", expr: "2 + 4" }, numberAnswer("6"))).toEqual({
      result: "none",
      reason: "claim_unbound",
    });
  });

  it("accepts the expression answer kind for a plain number", () => {
    const answer: AnswerDoc = { kind: "expression", value: doc("\\(\\frac{5}{6}\\)") };
    expect(check("Evaluate \\(\\frac{2}{3} + \\frac{1}{6}\\).", { kind: "evaluate", expr: "\\frac{2}{3} + \\frac{1}{6}" }, answer)).toEqual(
      pass,
    );
  });
});

describe("numeric checker: percent, counting and sequences", () => {
  const percentStem = "What is \\(25\\%\\) of \\(80\\)?";

  it("checks a percentage of a whole", () => {
    expect(check(percentStem, { kind: "percent_of", percent: "25", whole: "80" }, numberAnswer("20"))).toEqual(pass);
    expect(check(percentStem, { kind: "percent_of", percent: "25", whole: "80" }, numberAnswer("20\\%"))).toEqual(pass);
    expect(check(percentStem, { kind: "percent_of", percent: "25", whole: "80" }, numberAnswer("25"))).toEqual(mismatch);
    expect(check(percentStem, { kind: "percent_of", percent: "25", whole: "80" }, numberAnswer("2000"))).toEqual(mismatch);
  });

  it("refuses a percentage claim whose numbers are not in the stem", () => {
    expect(check(percentStem, { kind: "percent_of", percent: "30", whole: "80" }, numberAnswer("24"))).toEqual({
      result: "none",
      reason: "claim_unbound",
    });
  });

  const countingStem = "In how many ways can \\(3\\) items be chosen from \\(10\\)?";

  it("checks combinations and permutations exactly", () => {
    expect(check(countingStem, { kind: "nCr", n: 10, r: 3 }, numberAnswer("120"))).toEqual(pass);
    expect(check(countingStem, { kind: "nPr", n: 10, r: 3 }, numberAnswer("720"))).toEqual(pass);
    expect(check(countingStem, { kind: "nCr", n: 10, r: 3 }, numberAnswer("720"))).toEqual(mismatch);
    expect(check(countingStem, { kind: "nPr", n: 10, r: 3 }, numberAnswer("120"))).toEqual(mismatch);
  });

  it("refuses counting claims outside the bounds", () => {
    expect(check(countingStem, { kind: "nCr", n: 3, r: 10 }, numberAnswer("1"))).toEqual(unreadableClaim);
    const big = "Choose \\(60\\) from \\(60\\).";
    expect(check(big, { kind: "nPr", n: 60, r: 60 }, numberAnswer("1"))).toEqual(unreadableClaim);
    const huge = "Choose \\(3\\) from \\(100\\).";
    expect(check(huge, { kind: "nCr", n: 100, r: 3 }, numberAnswer("161700"))).toEqual(unreadableClaim);
  });

  it("checks arithmetic terms and sums", () => {
    expect(check(SEQUENCE_STEM, { kind: "arithmetic_term", first: "3", step: "4", n: 10 }, numberAnswer("39"))).toEqual(pass);
    expect(check(SEQUENCE_STEM, { kind: "arithmetic_sum", first: "3", step: "4", n: 10 }, numberAnswer("210"))).toEqual(pass);
    expect(check(SEQUENCE_STEM, { kind: "arithmetic_term", first: "3", step: "4", n: 10 }, numberAnswer("43"))).toEqual(mismatch);
    expect(check(SEQUENCE_STEM, { kind: "arithmetic_sum", first: "3", step: "4", n: 10 }, numberAnswer("195"))).toEqual(mismatch);
  });

  it("checks geometric terms and sums, including ratio one", () => {
    expect(check(GEOMETRIC_STEM, { kind: "geometric_term", first: "2", step: "3", n: 5 }, numberAnswer("162"))).toEqual(pass);
    expect(check(GEOMETRIC_STEM, { kind: "geometric_sum", first: "2", step: "3", n: 4 }, numberAnswer("80"))).toEqual(pass);
    expect(check(GEOMETRIC_STEM, { kind: "geometric_term", first: "2", step: "3", n: 5 }, numberAnswer("486"))).toEqual(mismatch);
    const flat = "The first term is \\(5\\), the ratio is \\(1\\); add \\(4\\) terms.";
    expect(check(flat, { kind: "geometric_sum", first: "5", step: "1", n: 4 }, numberAnswer("20"))).toEqual(pass);
  });

  it("refuses sequence claims outside the bounds", () => {
    const zero = "The first term is \\(3\\), the difference is \\(4\\), take \\(0\\) terms.";
    expect(check(zero, { kind: "arithmetic_term", first: "3", step: "4", n: 0 }, numberAnswer("3"))).toEqual(unreadableClaim);
    const long = "The first term is \\(2\\), the ratio is \\(3\\), term \\(100\\).";
    expect(check(long, { kind: "geometric_term", first: "2", step: "3", n: 100 }, numberAnswer("1"))).toEqual(unreadableClaim);
  });

  it("refuses a sequence claim whose step is not written in the stem", () => {
    const implicitStep = "The sequence starts \\(3\\), \\(7\\), \\(11\\). Find term \\(10\\).";
    expect(check(implicitStep, { kind: "arithmetic_term", first: "3", step: "4", n: 10 }, numberAnswer("39"))).toEqual({
      result: "none",
      reason: "claim_unbound",
    });
  });
});

describe("numeric checker: poly_value", () => {
  const functionStem = "Given \\(f(x) = x^2 + 1\\), find \\(f(3)\\).";

  it("evaluates a named function at a point", () => {
    expect(check(functionStem, { kind: "poly_value", expr: "f(x) = x^2 + 1", at: "3" }, numberAnswer("10"))).toEqual(pass);
    expect(check(functionStem, { kind: "poly_value", expr: "f(x) = x^2 + 1", at: "3" }, numberAnswer("9"))).toEqual(mismatch);
    expect(check(functionStem, { kind: "poly_value", expr: "f(x) = x^2 + 1", at: "3" }, numberAnswer("7"))).toEqual(mismatch);
  });

  it("evaluates a bare polynomial span at a point", () => {
    const stem = "Evaluate \\(2x^2 - 3x + 1\\) at \\(x = 2\\).";
    expect(check(stem, { kind: "poly_value", expr: "2x^2 - 3x + 1", at: "2" }, numberAnswer("3"))).toEqual(pass);
    expect(check(stem, { kind: "poly_value", expr: "2x^2 - 3x + 1", at: "2" }, numberAnswer("-3"))).toEqual(mismatch);
  });

  it("evaluates at a negative point and with fractional coefficients", () => {
    expect(check(functionStem, { kind: "poly_value", expr: "f(x) = x^2 + 1", at: "-1" }, numberAnswer("2"))).toEqual(pass);
    const half = "Given \\(g(t) = \\frac{1}{2}t + 1\\), find \\(g(3)\\).";
    expect(check(half, { kind: "poly_value", expr: "g(t) = \\frac{1}{2}t + 1", at: "3" }, numberAnswer("\\frac{5}{2}"))).toEqual(pass);
  });

  it("refuses non-polynomial and over-degree functions and an unbound point", () => {
    const reciprocal = "Given \\(g(x) = \\frac{1}{x}\\), find \\(g(2)\\).";
    expect(check(reciprocal, { kind: "poly_value", expr: "g(x) = \\frac{1}{x}", at: "2" }, numberAnswer("0.5"))).toEqual(
      unreadableClaim,
    );
    const degree7 = "Given \\(h(x) = x^{7}\\), find \\(h(2)\\).";
    expect(check(degree7, { kind: "poly_value", expr: "h(x) = x^{7}", at: "2" }, numberAnswer("128"))).toEqual(unreadableClaim);
    expect(check(functionStem, { kind: "poly_value", expr: "f(x) = x^2 + 1", at: "5" }, numberAnswer("26"))).toEqual({
      result: "none",
      reason: "claim_unbound",
    });
  });
});

describe("numeric checker: answer reading", () => {
  const stem = "Evaluate \\(2 + 3\\).";
  const claim: RawClaim = { kind: "evaluate", expr: "2 + 3" };

  it("accepts a unit word after the number", () => {
    expect(check(stem, claim, { kind: "number", value: doc("\\(5\\) cm") })).toEqual(pass);
    expect(check(stem, claim, { kind: "number", value: doc("about \\(5\\) metres per hour") })).toEqual(unreadableAnswer);
    expect(check(stem, claim, { kind: "number", value: doc("\\(5\\) or \\(6\\)") })).toEqual(unreadableAnswer);
  });

  it("refuses answers it cannot read", () => {
    expect(check(stem, claim, { kind: "number", value: doc("five") })).toEqual(unreadableAnswer);
    expect(check(stem, claim, numberAnswer("x"))).toEqual(unreadableAnswer);
    expect(check(stem, claim, numberAnswer("\\sqrt{2}"))).toEqual(unreadableAnswer);
    expect(check(stem, claim, { kind: "roots", value: [doc("\\(5\\)")] })).toEqual(unreadableAnswer);
    expect(check(stem, claim, { kind: "text", value: doc("no solution") })).toEqual(unreadableAnswer);
  });

  it("accepts an equivalent but differently written number", () => {
    expect(check(stem, claim, numberAnswer("\\frac{10}{2}"))).toEqual(pass);
    expect(check(stem, claim, numberAnswer("5.0"))).toEqual(pass);
    expect(check(stem, claim, numberAnswer("n = 5"))).toEqual(pass);
  });
});
