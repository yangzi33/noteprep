import { describe, expect, it } from "vitest";
import { answerKindsFor, canonicalAnswer, runChecker } from "@/lib/math/checkers";
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
function rootsAnswer(...sources: string[]): AnswerDoc {
  return { kind: "roots", value: sources.map((s) => doc(`\\(${s}\\)`)) };
}
function pairAnswer(...sources: string[]): AnswerDoc {
  return { kind: "pair", value: sources.map((s) => doc(`\\(${s}\\)`)) };
}
function run(expr: string, kind: Claim["kind"], answer: AnswerDoc): CheckOutcome {
  return runChecker({ stem: doc(`Solve \\(${expr}\\).`), answer, claim: claimOf({ kind, expr }) });
}

describe("answerKindsFor", () => {
  it("maps every claim kind to the answer kinds a checker can read", () => {
    expect(answerKindsFor("linear_equation")).toEqual(["number", "text"]);
    expect(answerKindsFor("quadratic_equation")).toEqual(["roots", "text"]);
    expect(answerKindsFor("linear_system")).toEqual(["pair", "text"]);
    expect(answerKindsFor("linear_inequality")).toEqual(["inequality", "text"]);
    for (const kind of [
      "evaluate",
      "percent_of",
      "nCr",
      "nPr",
      "arithmetic_term",
      "arithmetic_sum",
      "geometric_term",
      "geometric_sum",
      "poly_value",
    ] as const) {
      expect(answerKindsFor(kind)).toEqual(["number", "expression"]);
    }
  });
});

describe("exactness", () => {
  it("never loses a decimal to floating point", () => {
    expect(run("0.1x = 0.3", "linear_equation", numberAnswer("3"))).toEqual({ result: "pass", checker: "linear_equation" });
    expect(
      runChecker({
        stem: doc("Evaluate \\(0.1 + 0.2\\)."),
        answer: numberAnswer("0.3"),
        claim: claimOf({ kind: "evaluate", expr: "0.1 + 0.2" }),
      }),
    ).toEqual({ result: "pass", checker: "numeric" });
    expect(
      runChecker({
        stem: doc("Evaluate \\(0.1 + 0.2\\)."),
        answer: numberAnswer("0.300001"),
        claim: claimOf({ kind: "evaluate", expr: "0.1 + 0.2" }),
      }),
    ).toEqual({ result: "fail", checker: "numeric", reason: "answer_mismatch" });
    expect(run("0.3x = 0.1", "linear_equation", numberAnswer("\\frac{1}{3}"))).toEqual({
      result: "pass",
      checker: "linear_equation",
    });
  });

  it("handles twelve-digit coefficients exactly", () => {
    expect(run("999999999999x = 999999999999", "linear_equation", numberAnswer("1"))).toEqual({
      result: "pass",
      checker: "linear_equation",
    });
    expect(run("999999999999x = 999999999999", "linear_equation", numberAnswer("2"))).toEqual({
      result: "fail",
      checker: "linear_equation",
      reason: "answer_mismatch",
    });
  });
});

describe("runChecker is total", () => {
  const hostile: [string, Claim["kind"], AnswerDoc][] = [
    ["x^{999} = 1", "linear_equation", numberAnswer("1")],
    ["x^{12} - 1 = 0", "quadratic_equation", rootsAnswer("1", "-1")],
    ["999999999999^{12} = x", "linear_equation", numberAnswer("1")],
    ["((((((((x)))))))) = 1", "linear_equation", numberAnswer("1")],
    [`${"x + ".repeat(70)}x = 1`, "linear_equation", numberAnswer("\\frac{1}{71}")],
    ["2^{2^{2^{2}}} = x", "linear_equation", numberAnswer("1")],
    ["\\sqrt{999999999} = x", "linear_equation", numberAnswer("1")],
    ["x^2 - 999999999 = 0", "quadratic_equation", rootsAnswer("1")],
    ["x^2 - 999999999999 = 0", "quadratic_equation", rootsAnswer("1")],
    ["\\frac{x}{0} = 1", "linear_equation", numberAnswer("0")],
    ["|x| = 2", "linear_equation", numberAnswer("2")],
    ["\\frac{\\frac{\\frac{x}{2}}{2}}{2} = 1", "linear_equation", numberAnswer("8")],
  ];
  for (const [expr, kind, answer] of hostile) {
    it(`never throws on ${expr}`, () => {
      const started = performance.now();
      const outcome = run(expr, kind, answer);
      expect(performance.now() - started).toBeLessThan(200);
      expect(["none", "pass", "fail"]).toContain(outcome.result);
    });
  }

  it("survives answers and claims that are not well-formed documents", () => {
    const stem = doc("Solve \\(2x = 4\\).");
    const claim = claimOf({ kind: "linear_equation", expr: "2x = 4" });
    const broken = [
      { kind: "number", value: undefined },
      { kind: "number", value: { v: "mathtext/1", parts: [] } },
      { kind: "number", value: { v: "other", parts: [{ t: "math", m: { t: "num", v: "2" } }] } },
      { kind: "roots", value: [undefined] },
      { kind: "bogus", value: doc("\\(2\\)") },
    ] as unknown as AnswerDoc[];
    for (const answer of broken) {
      const outcome = runChecker({ stem, answer, claim });
      expect(outcome.result).toBe("none");
    }
    expect(runChecker({ stem, answer: numberAnswer("2"), claim: { kind: "linear_equation" } as unknown as Claim })).toEqual({
      result: "none",
      reason: "claim_unreadable",
    });
  });

  it("reports the whole decision order in the documented sequence", () => {
    const stem = doc("Solve \\(2x = 4\\).");
    expect(runChecker({ stem, answer: numberAnswer("2"), claim: undefined })).toEqual({ result: "none", reason: "no_claim" });
    expect(
      runChecker({ stem, answer: rootsAnswer("2"), claim: claimOf({ kind: "linear_equation", expr: "2x = 5" }) }),
    ).toEqual({ result: "none", reason: "claim_unbound" }); // unbound wins over the wrong answer kind
    expect(runChecker({ stem, answer: rootsAnswer("2"), claim: claimOf({ kind: "linear_equation", expr: "2x = 4" }) })).toEqual(
      { result: "none", reason: "answer_unreadable" },
    );
  });
});

describe("canonicalAnswer", () => {
  it("agrees across equivalent ways of writing one number", () => {
    const forms = ["3", "x = 3", "\\frac{6}{2}", "3.0", "6 \\div 2"];
    const canonical = forms.map((f) => canonicalAnswer(numberAnswer(f)));
    expect(canonical.every((c) => c === "n:3/1")).toBe(true);
    expect(canonicalAnswer(numberAnswer("-0.5"))).toBe("n:-1/2");
    expect(canonicalAnswer({ kind: "expression", value: doc("\\(\\frac{1}{2}\\)") })).toBe("n:1/2");
    expect(canonicalAnswer({ kind: "number", value: doc("\\(5\\) cm") })).toBe("n:5/1");
  });

  it("is order-independent for roots and expands plus-minus", () => {
    expect(canonicalAnswer(rootsAnswer("2", "3"))).toBe(canonicalAnswer(rootsAnswer("3", "2")));
    expect(canonicalAnswer(rootsAnswer("\\pm\\sqrt{2}"))).toBe(canonicalAnswer(rootsAnswer("\\sqrt{2}", "-\\sqrt{2}")));
    expect(canonicalAnswer(rootsAnswer("1"))).toBe(canonicalAnswer(rootsAnswer("1", "1")));
    expect(canonicalAnswer(rootsAnswer("x = 2", "x = 3"))).toBe(canonicalAnswer(rootsAnswer("2", "3")));
    expect(canonicalAnswer(rootsAnswer("2", "3"))).not.toBe(canonicalAnswer(rootsAnswer("2", "4")));
    expect(canonicalAnswer(rootsAnswer("\\frac{1 \\pm \\sqrt{5}}{2}"))).toBe(
      canonicalAnswer(rootsAnswer("\\frac{1 + \\sqrt{5}}{2}", "\\frac{1 - \\sqrt{5}}{2}")),
    );
  });

  it("orders a pair by variable name when the answer is labelled", () => {
    expect(canonicalAnswer(pairAnswer("3", "2"))).toBe("pair:3/1,2/1");
    expect(canonicalAnswer(pairAnswer("x = 3", "y = 2"))).toBe("pair:3/1,2/1");
    expect(canonicalAnswer(pairAnswer("y = 2", "x = 3"))).toBe("pair:3/1,2/1");
    expect(canonicalAnswer(pairAnswer("(3, 2)"))).toBe("pair:3/1,2/1");
    expect(canonicalAnswer(pairAnswer("2", "3"))).not.toBe("pair:3/1,2/1");
  });

  it("normalises an inequality to variable-on-the-left form", () => {
    const answer = (source: string): AnswerDoc => ({ kind: "inequality", value: doc(`\\(${source}\\)`) });
    expect(canonicalAnswer(answer("x < 2"))).toBe("ineq:<:2/1");
    expect(canonicalAnswer(answer("2 > x"))).toBe("ineq:<:2/1");
    expect(canonicalAnswer(answer("x \\le 2"))).toBe("ineq:le:2/1");
    expect(canonicalAnswer(answer("x \\le -\\frac{1}{2}"))).toBe("ineq:le:-1/2");
    expect(canonicalAnswer(answer("x < 2"))).not.toBe(canonicalAnswer(answer("x \\le 2")));
  });

  it("maps each synonym group of a text answer to one token", () => {
    const text = (source: string): AnswerDoc => ({ kind: "text", value: doc(source) });
    expect(canonicalAnswer(text("No solution."))).toBe("text:none");
    expect(canonicalAnswer(text("there is no solution"))).toBe("text:none");
    expect(canonicalAnswer(text("No real solutions"))).toBe("text:none");
    expect(canonicalAnswer(text("all real numbers"))).toBe("text:all");
    expect(canonicalAnswer(text("Infinitely many solutions"))).toBe("text:all");
    expect(canonicalAnswer(text("every real number"))).toBe("text:all");
    expect(canonicalAnswer(text("identity"))).toBe("text:all");
    expect(canonicalAnswer(text("no real roots"))).toBe("text:no_real_roots");
    expect(canonicalAnswer(text("does not have real roots"))).toBe("text:no_real_roots");
  });

  it("returns null for anything it cannot read", () => {
    expect(canonicalAnswer({ kind: "number", value: doc("five") })).toBeNull();
    expect(canonicalAnswer(numberAnswer("x"))).toBeNull();
    expect(canonicalAnswer(numberAnswer("\\sqrt{2}"))).toBeNull();
    expect(canonicalAnswer(rootsAnswer("x"))).toBeNull();
    expect(canonicalAnswer(rootsAnswer("\\sqrt{2}", "\\sqrt{3}"))).toBeNull();
    expect(canonicalAnswer({ kind: "text", value: doc("roughly two") })).toBeNull();
    expect(canonicalAnswer({ kind: "pair", value: [doc("\\(3\\)")] })).toBeNull();
    expect(canonicalAnswer({ kind: "inequality", value: doc("\\((2, 5)\\)") })).toBeNull();
    expect(canonicalAnswer({ kind: "number", value: undefined } as unknown as AnswerDoc)).toBeNull();
  });
});
