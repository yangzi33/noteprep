import { describe, expect, it } from "vitest";
import { bindsToStem } from "@/lib/math/checkers/bind";
import { evalRational, evalSurdSet } from "@/lib/math/checkers/numeric";
import { polyDegree, polyFromNode, polyVars, univariateCoef } from "@/lib/math/checkers/poly";
import { Surd } from "@/lib/math/checkers/surd";
import { parseRawClaim, type Claim } from "@/lib/math/checkers/types";
import { Rational } from "@/lib/math/rational";
import { parseMathText, type MathNode, type MathTextDoc } from "@/lib/math-text";

function doc(source: string): MathTextDoc {
  const r = parseMathText(source);
  if (!r.ok) throw new Error(`parse failed (${r.code}): ${source}`);
  return r.doc;
}
function span(source: string): MathTextDoc {
  return doc(`\\(${source}\\)`);
}
function node(source: string): MathNode {
  const part = span(source).parts[0]!;
  if (part.t !== "math") throw new Error("not a math part");
  return part.m;
}
function claim(raw: unknown): Claim {
  const r = parseRawClaim(raw);
  if (!r.ok) throw new Error(`claim invalid: ${JSON.stringify(raw)}`);
  return r.claim;
}
function rat(text: string): Rational {
  return Rational.parse(text);
}

describe("Surd", () => {
  it("represents rationals with radicand 1", () => {
    const s = Surd.rational(rat("3/4"))!;
    expect(s.isRational()).toBe(true);
    expect(s.key()).toBe("3/4+0/1r1");
  });

  it("simplifies square roots of perfect squares to rationals", () => {
    expect(Surd.sqrtOfRational(rat("9/4"), 2)?.key()).toBe("3/2+0/1r1");
    expect(Surd.sqrtOfRational(rat("0"), 2)?.key()).toBe("0/1+0/1r1");
  });

  it("extracts square factors and keeps a squarefree radicand", () => {
    const s = Surd.sqrtOfRational(rat("12"), 2);
    expect(s?.key()).toBe("0/1+2/1r3");
    expect(Surd.sqrtOfRational(rat("1/2"), 2)?.key()).toBe("0/1+1/2r2");
  });

  it("refuses negative radicands and roots it cannot represent", () => {
    expect(Surd.sqrtOfRational(rat("-4"), 2)).toBeNull();
    expect(Surd.sqrtOfRational(rat("2"), 3)).toBeNull();
    expect(Surd.sqrtOfRational(rat("8"), 3)?.key()).toBe("2/1+0/1r1");
  });

  it("adds, multiplies and divides inside one quadratic field", () => {
    const root5 = Surd.sqrtOfRational(rat("5"), 2)!;
    const half = Surd.rational(rat("1/2"))!;
    const golden = half.add(root5.mul(half)!)!;
    expect(golden.key()).toBe("1/2+1/2r5");
    expect(golden.mul(golden)!.sub(golden)!.key()).toBe("1/1+0/1r1"); // phi^2 - phi = 1
    expect(golden.div(golden)!.key()).toBe("1/1+0/1r1");
  });

  it("refuses to combine different radicands", () => {
    const root2 = Surd.sqrtOfRational(rat("2"), 2)!;
    const root3 = Surd.sqrtOfRational(rat("3"), 2)!;
    expect(root2.add(root3)).toBeNull();
    expect(root2.add(Surd.rational(rat("1"))!)?.key()).toBe("1/1+1/1r2");
  });

  it("compares by exact value", () => {
    const a = Surd.sqrtOfRational(rat("8"), 2)!; // 2 sqrt 2
    const b = Surd.sqrtOfRational(rat("2"), 2)!.mul(Surd.rational(rat("2"))!)!;
    expect(a.eq(b)).toBe(true);
    expect(a.eq(Surd.sqrtOfRational(rat("2"), 2)!)).toBe(false);
  });
});

describe("evalRational", () => {
  const cases: [string, string][] = [
    ["2 + 3 \\cdot 4", "14"],
    ["2 \\times 3 - 10", "-4"],
    ["(2 + 3)(4 - 1)", "15"],
    ["\\frac{1}{3} + \\frac{1}{6}", "1/2"],
    ["0.25 + 0.75", "1"],
    ["-\\frac{3}{4}", "-3/4"],
    ["50\\%", "1/2"],
    ["2^{10}", "1024"],
    ["3^{2} + 4^{2}", "25"],
    ["\\sqrt{3^2 + 4^2}", "5"],
    ["\\sqrt{\\frac{9}{4}}", "3/2"],
    ["\\sqrt[3]{27}", "3"],
    ["|2 - 9|", "7"],
    ["12 \\div 8", "3/2"],
    ["7/2", "7/2"],
    ["2^{-3}", "1/8"],
    ["0^{3}", "0"],
  ];
  for (const [source, want] of cases) {
    it(`evaluates ${source} exactly`, () => {
      expect(evalRational(node(source))?.toString()).toBe(want);
    });
  }

  it("is exact on decimals that floating point cannot represent", () => {
    expect(evalRational(node("0.1 + 0.2"))!.eq(evalRational(node("0.3"))!)).toBe(true);
    expect(evalRational(node("0.1 + 0.2"))!.eq(rat("3/10"))).toBe(true);
    expect(evalRational(node("0.07 \\cdot 100"))!.eq(rat("7"))).toBe(true);
  });

  const refused = [
    "x + 1",
    "\\sqrt{2}",
    "\\sqrt[3]{2}",
    "\\frac{1}{0}",
    "1 \\div 0",
    "0^{-2}",
    "0^{0}",
    "0^{0.5}",
    "2^{13}",
    "x^{999}",
    "\\sin 30",
    "\\pi",
    "30^\\circ",
    "2 \\pm 3",
    "1 = 1",
    "1, 2",
    "\\ldots",
    "a_{1}",
  ];
  for (const source of refused) {
    it(`refuses ${source}`, () => {
      expect(evalRational(node(source))).toBeNull();
    });
  }

  it("refuses numbers beyond the magnitude bound", () => {
    expect(evalRational(node("999999999999^{12}"))).toBeNull();
    expect(evalRational(node("999999999 \\cdot 999999999"))?.toString()).toBe("999999998000000001");
  });
});

describe("evalSurdSet", () => {
  it("expands a plus-minus into two values", () => {
    const set = evalSurdSet(node("\\frac{1 \\pm \\sqrt{5}}{2}"))!;
    expect(set.map((s) => s.key()).sort()).toEqual(["1/2+-1/2r5", "1/2+1/2r5"].sort());
  });

  it("reads plain rationals and negatives", () => {
    expect(evalSurdSet(node("-\\frac{3}{2}"))!.map((s) => s.key())).toEqual(["-3/2+0/1r1"]);
    expect(evalSurdSet(node("2"))!.map((s) => s.key())).toEqual(["2/1+0/1r1"]);
  });

  it("reads products and quotients with surds", () => {
    expect(evalSurdSet(node("3\\sqrt{2}"))!.map((s) => s.key())).toEqual(["0/1+3/1r2"]);
    expect(evalSurdSet(node("\\frac{\\sqrt{8}}{2}"))!.map((s) => s.key())).toEqual(["0/1+1/1r2"]);
  });

  it("refuses two different radicands in one value", () => {
    expect(evalSurdSet(node("\\sqrt{2} + \\sqrt{3}"))).toBeNull();
  });

  it("refuses variables and unbounded shapes", () => {
    expect(evalSurdSet(node("x"))).toBeNull();
    expect(evalSurdSet(node("\\sqrt{-4}"))).toBeNull();
  });
});

describe("polyFromNode", () => {
  it("normalises an implicit product with a decimal coefficient", () => {
    const p = polyFromNode(node("0.25x"))!;
    expect(polyVars(p)).toEqual(["x"]);
    expect(univariateCoef(p, "x", 1).toString()).toBe("1/4");
    expect(univariateCoef(p, "x", 0).toString()).toBe("0");
  });

  it("distributes products and powers", () => {
    const p = polyFromNode(node("2(x - 3)(x + 1)"))!;
    expect(polyDegree(p)).toBe(2);
    expect(univariateCoef(p, "x", 2).toString()).toBe("2");
    expect(univariateCoef(p, "x", 1).toString()).toBe("-4");
    expect(univariateCoef(p, "x", 0).toString()).toBe("-6");
  });

  it("handles negative coefficients and fractional denominators", () => {
    const p = polyFromNode(node("-\\frac{x + 2}{4}"))!;
    expect(univariateCoef(p, "x", 1).toString()).toBe("-1/4");
    expect(univariateCoef(p, "x", 0).toString()).toBe("-1/2");
  });

  it("keeps two variables apart", () => {
    const p = polyFromNode(node("3x - 2y"))!;
    expect(polyVars(p)).toEqual(["x", "y"]);
    expect(polyDegree(p)).toBe(1);
  });

  it("refuses division by a variable, relations and huge exponents", () => {
    expect(polyFromNode(node("\\frac{1}{x}"))).toBeNull();
    expect(polyFromNode(node("x = 1"))).toBeNull();
    expect(polyFromNode(node("x^{999}"))).toBeNull();
    expect(polyFromNode(node("x \\pm 1"))).toBeNull();
  });
});

describe("bindsToStem", () => {
  it("binds a claim expression that equals a math span of the stem", () => {
    const stem = doc("Solve \\(2x + 3 = 7\\) for \\(x\\).");
    expect(bindsToStem(stem, claim({ kind: "linear_equation", expr: "2x + 3 = 7" }))).toBe(true);
  });

  it("refuses a claim expression that is not displayed", () => {
    const stem = doc("Solve \\(2x + 3 = 7\\) for \\(x\\).");
    expect(bindsToStem(stem, claim({ kind: "linear_equation", expr: "2x + 3 = 9" }))).toBe(false);
    expect(bindsToStem(stem, claim({ kind: "linear_equation", expr: "2x = 4" }))).toBe(false);
  });

  it("binds one item of a comma list span", () => {
    const stem = doc("Solve \\(x + y = 5, x - y = 1\\).");
    expect(bindsToStem(stem, claim({ kind: "linear_equation", expr: "x + y = 5" }))).toBe(true);
    expect(bindsToStem(stem, claim({ kind: "linear_system", exprs: ["x + y = 5", "x - y = 1"] }))).toBe(true);
  });

  it("requires two distinct spans for a system", () => {
    const stem = doc("Solve \\(x + y = 5\\) and \\(x - y = 1\\).");
    expect(bindsToStem(stem, claim({ kind: "linear_system", exprs: ["x + y = 5", "x - y = 1"] }))).toBe(true);
    expect(bindsToStem(stem, claim({ kind: "linear_system", exprs: ["x + y = 5", "x + y = 5"] }))).toBe(false);
    const twice = doc("Solve \\(x + y = 5\\) and \\(x + y = 5\\).");
    expect(bindsToStem(twice, claim({ kind: "linear_system", exprs: ["x + y = 5", "x + y = 5"] }))).toBe(true);
  });

  it("binds numeric operands that occur as stem number tokens", () => {
    const stem = doc("The 1st term is 3 and the common difference is 4. Find the 10th term.");
    expect(bindsToStem(stem, claim({ kind: "arithmetic_term", first: "3", step: "4", n: 10 }))).toBe(true);
    expect(bindsToStem(stem, claim({ kind: "arithmetic_term", first: "3", step: "5", n: 10 }))).toBe(false);
    expect(bindsToStem(stem, claim({ kind: "arithmetic_term", first: "3", step: "4", n: 11 }))).toBe(false);
  });

  it("binds numeric operands against num nodes inside math spans, percent included", () => {
    const stem = doc("What is \\(25\\%\\) of \\(80\\)?");
    expect(bindsToStem(stem, claim({ kind: "percent_of", percent: "25", whole: "80" }))).toBe(true);
    expect(bindsToStem(stem, claim({ kind: "percent_of", percent: "80", whole: "25" }))).toBe(true);
    expect(bindsToStem(stem, claim({ kind: "percent_of", percent: "25", whole: "8" }))).toBe(false);
  });

  it("ignores the sign of a numeric operand and reads decimals", () => {
    const stem = doc("A sequence starts at \\(0.5\\) and decreases by \\(2\\) each step; find term \\(4\\).");
    expect(bindsToStem(stem, claim({ kind: "arithmetic_term", first: "0.5", step: "-2", n: 4 }))).toBe(true);
  });

  it("binds a poly_value claim by span and by the evaluation point", () => {
    const stem = doc("Given \\(f(x) = x^2 + 1\\), find \\(f(3)\\).");
    expect(bindsToStem(stem, claim({ kind: "poly_value", expr: "f(x) = x^2 + 1", at: "3" }))).toBe(true);
    expect(bindsToStem(stem, claim({ kind: "poly_value", expr: "f(x) = x^2 + 1", at: "5" }))).toBe(false);
  });

  it("does not split a relation chain into sides", () => {
    const stem = doc("Solve \\(2x + 3 = 7\\).");
    expect(bindsToStem(stem, claim({ kind: "evaluate", expr: "2x + 3" }))).toBe(false);
  });
});
