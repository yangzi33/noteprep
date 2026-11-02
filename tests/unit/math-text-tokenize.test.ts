import { describe, expect, it } from "vitest";
import golden from "../fixtures/math-text/golden.json";
import samples from "../fixtures/math-text/samples.json";
import { HOSTILE_CASES } from "../fixtures/math-text/hostile";
import type { MathTextErrorCode } from "@/lib/math-text/ast";
import { splitMathText } from "@/lib/math-text/split";
import { tokenizeMath } from "@/lib/math-text/tokenize";

describe("tokenizeMath", () => {
  it("tokenizes commands, numbers and operators with offsets", () => {
    expect(tokenizeMath(String.raw`\frac{3}{4}x\le 2.5`, 0)).toEqual({ ok: true, tokens: [
      { k: "cmd", v: "frac", at: 0 }, { k: "op", v: "{", at: 5 }, { k: "num", v: "3", at: 6 }, { k: "op", v: "}", at: 7 },
      { k: "op", v: "{", at: 8 }, { k: "num", v: "4", at: 9 }, { k: "op", v: "}", at: 10 }, { k: "letter", v: "x", at: 11 },
      { k: "cmd", v: "le", at: 12 }, { k: "num", v: "2.5", at: 16 }] });
  });
  it("adds the span offset to every token position and to errors", () => {
    expect(tokenizeMath("x+1", 10)).toEqual({ ok: true, tokens: [
      { k: "letter", v: "x", at: 10 }, { k: "op", v: "+", at: 11 }, { k: "num", v: "1", at: 12 }] });
    expect(tokenizeMath("x ! y", 10)).toEqual({ ok: false, code: "math_bad_char", at: 12 });
  });
  it("tokenizes percent and every command name", () => {
    expect(tokenizeMath(String.raw`15\%`, 0)).toEqual({ ok: true, tokens: [{ k: "num", v: "15", at: 0 }, { k: "pct", at: 2 }] });
    for (const c of ["alpha", "beta", "theta", "pi", "le", "ge", "neq", "pm", "times", "cdot", "div", "frac", "sqrt", "circ", "sin", "cos", "tan", "log", "ln", "ldots"])
      expect(tokenizeMath(`\\${c}`, 0)).toEqual({ ok: true, tokens: [{ k: "cmd", v: c, at: 0 }] });
  });
  it.each([
    [String.raw`\pin`, "math_unknown_command"], [String.raw`\lefts`, "math_unknown_command"], [String.raw`\input`, "math_unknown_command"],
    [String.raw`\text{a}`, "math_unknown_command"], [String.raw`\$`, "math_unknown_command"], ["х", "math_bad_char"], ["2−3", "math_bad_char"],
    ["007", "math_leading_zero"], ["00", "math_leading_zero"], ["1234567890123", "math_number_too_long"], ["1.1234567", "math_number_too_long"],
    ["1,500", "math_digit_grouping"], ["x*y", "math_bad_char"], ["x;y", "math_bad_char"], ["a&b", "math_bad_char"], ["#1", "math_bad_char"],
    ["\uD800", "math_bad_char"], ["x y", "math_bad_char"], ["x y", "math_bad_char"], ["x\\", "math_bad_char"], ["é", "math_bad_char"],
    [".5", "math_bad_char"], ["1.", "math_bad_char"], ["\\", "math_bad_char"], ["x\tx", "math_bad_char"],
  ])("rejects %j as %s", (src, code) => expect(tokenizeMath(src, 0)).toMatchObject({ ok: false, code }));
  it("accepts numbers at the limits and zero forms", () => {
    expect(tokenizeMath("123456789012", 0)).toMatchObject({ ok: true });
    expect(tokenizeMath("0.123456", 0)).toMatchObject({ ok: true });
    expect(tokenizeMath("0", 0)).toEqual({ ok: true, tokens: [{ k: "num", v: "0", at: 0 }] });
  });
  it("accepts a list with a space after the comma and commas that are not grouping", () => {
    expect(tokenizeMath("1, 500", 0)).toMatchObject({ ok: true });
    expect(tokenizeMath("2,5,8", 0)).toMatchObject({ ok: true });
    expect(tokenizeMath("1,5000", 0)).toMatchObject({ ok: true });
    expect(tokenizeMath("1,50", 0)).toMatchObject({ ok: true });
    expect(tokenizeMath("x,500", 0)).toMatchObject({ ok: true });
  });
  it("is linear on a long run of operators", () => {
    const t = tokenizeMath("(".repeat(300), 0);
    expect(t).toMatchObject({ ok: true });
  });
});

// Scope: a fixture row is a tokenizer-stage row when its expected code is one of TOKENIZER_CODES; those must fail
// with exactly that code. Every other math_* code is parser-stage (A4): the spans must tokenize successfully.
// Codes without the math_ prefix are decided by splitMathText, which must refuse the input with that code.
// Rows that expect acceptance (and reject_or_safe rows that split) must split and tokenize.
const TOKENIZER_CODES = new Set<MathTextErrorCode>(["math_bad_char", "math_unknown_command", "math_leading_zero", "math_number_too_long", "math_digit_grouping"]);

type Row = { in: string; code?: MathTextErrorCode };
const rows: Row[] = [
  ...golden.map((r) => ({ in: r.in, code: r.ok ? undefined : (r.code as MathTextErrorCode) })),
  ...samples.map((s) => ({ in: s.input, code: typeof s.expect === "object" ? (s.expect.reject as MathTextErrorCode) : undefined })),
  ...HOSTILE_CASES.map((h) => ({ in: h.in, code: h.expect === "reject" ? h.code : undefined })),
];

function firstSpanFailure(input: string): { split: MathTextErrorCode } | { code?: MathTextErrorCode } {
  const sp = splitMathText(input);
  if (!sp.ok) return { split: sp.code };
  for (const p of sp.parts) {
    if (p.t !== "span") continue;
    const r = tokenizeMath(p.src, p.at);
    if (!r.ok) return { code: r.code };
  }
  return {};
}

describe("tokenizer against the shared fixtures", () => {
  it.each(rows.map((r) => [JSON.stringify(r.in.length > 50 ? r.in.slice(0, 50) + "..." : r.in), r] as const))("row %s", (_n, row) => {
    const out = firstSpanFailure(row.in);
    if (row.code === undefined) {
      expect(out).toEqual({});
    } else if (TOKENIZER_CODES.has(row.code)) {
      expect(out).toEqual({ code: row.code });
    } else if (row.code.startsWith("math_")) {
      expect(out).toEqual({});
    } else {
      expect(out).toEqual({ split: row.code });
    }
  });
});
