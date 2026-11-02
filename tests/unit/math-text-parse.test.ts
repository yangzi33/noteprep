import { describe, expect, it } from "vitest";
import golden from "../fixtures/math-text/golden.json";
import samples from "../fixtures/math-text/samples.json";
import { HOSTILE_CASES } from "../fixtures/math-text/hostile";
import { parseMath, parseMathText } from "@/lib/math-text/parse";
import type { MathNode } from "@/lib/math-text/ast";
import { isMathTextDoc } from "@/lib/math-text/guard";

const ok = (src: string): MathNode => {
  const r = parseMath(src, 0);
  if (!r.ok) throw new Error(r.code);
  return r.node;
};

describe("parseMath", () => {
  it("parses left-associative binary operators and implicit products", () => {
    expect(ok("a-b-c")).toEqual({ t: "bin", op: "-", l: { t: "bin", op: "-", l: { t: "var", name: "a" }, r: { t: "var", name: "b" } }, r: { t: "var", name: "c" } });
    expect(ok("2x")).toEqual({ t: "imp", items: [{ t: "num", v: "2" }, { t: "var", name: "x" }] });
  });
  it("binds implicit products tighter than explicit multiplication", () => {
    expect(ok(String.raw`2\times 3x`)).toEqual({
      t: "bin", op: "times", l: { t: "num", v: "2" },
      r: { t: "imp", items: [{ t: "num", v: "3" }, { t: "var", name: "x" }] },
    });
  });
  it("parses chained relations, lists, degree and log base", () => {
    expect(ok(String.raw`1<x\le 5`)).toMatchObject({ t: "rel", rest: [{ op: "<" }, { op: "le" }] });
    expect(ok("(2, 3)")).toMatchObject({ t: "group", open: "(", body: { t: "list" } });
    expect(ok(String.raw`30^\circ`)).toEqual({ t: "deg", arg: { t: "num", v: "30" } });
    expect(ok(String.raw`30^{\circ}`)).toEqual({ t: "deg", arg: { t: "num", v: "30" } });
    expect(ok(String.raw`\log_{2} 8`)).toMatchObject({ t: "fn", name: "log", base: { t: "num", v: "2" }, arg: { t: "num", v: "8" } });
  });
  it("never produces single-item imp or list", () => {
    expect(ok("(x)")).toEqual({ t: "group", open: "(", body: { t: "var", name: "x" } });
  });
  it("orders scripts as sup(sub(base))", () => {
    const want = { t: "sup", base: { t: "sub", base: { t: "var", name: "x" }, sub: { t: "num", v: "3" } }, exp: { t: "num", v: "2" } };
    expect(ok("x^2_3")).toEqual(want);
    expect(ok("x_3^2")).toEqual(want);
  });
  it("accepts three nested exponents", () => {
    expect(parseMath("2^{3^{4^{5}}}", 0)).toMatchObject({ ok: true });
  });
  it.each([
    ["2 3", "math_adjacent_numbers"], ["(x", "math_unbalanced"], ["(x]", "math_unbalanced"], ["{x}", "math_brace_misuse"],
    ["x}", "math_brace_misuse"], ["x^", "math_bad_script"], ["x^{2}^{3}", "math_bad_script"], ["x^12", "math_bad_script"],
    [String.raw`\sin_{2} x`, "math_bad_script"], [String.raw`\sin^{2} x`, "math_bad_script"],
    [String.raw`30^\circ_2`, "math_bad_script"], [String.raw`50\%^2`, "math_bad_script"],
    [String.raw`\sqrt{}`, "math_unexpected_token"], ["^^5c", "math_unexpected_token"], [String.raw`\frac\input x`, "math_unknown_command"],
    ["||x||", "math_unexpected_token"], ["|a||b|", "math_unexpected_token"], ["|x+|y||", "math_unexpected_token"],
    [String.raw`2^{3^{4^{5^{6}}}}`, "math_exponent_depth"], ["(".repeat(9) + "x" + ")".repeat(9), "math_depth"],
  ])("rejects %s as %s", (src, code) => {
    const r = parseMath(src, 0);
    expect(r).toMatchObject({ ok: false, code });
    expect(typeof (r as { at: number }).at).toBe("number");
  });
  it("reports at relative to the offset", () => {
    expect(parseMath("2 3", 10)).toMatchObject({ ok: false, at: 12 });
  });
  it("bounded depth without recursion blow-up", () => {
    const t0 = Date.now();
    expect(parseMath("(".repeat(10_000) + "x" + ")".repeat(10_000), 0)).toMatchObject({ ok: false, code: "math_depth" });
    expect(parseMath("-".repeat(10_000) + "x", 0)).toMatchObject({ ok: false, code: "math_depth" });
    expect(parseMath(String.raw`\sin `.repeat(10_000) + "x", 0)).toMatchObject({ ok: true });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

// Shape check for accepted ASTs: the runtime guard in src (src/lib/math-text/guard.ts) is the single strict validator.
function assertDoc(r: ReturnType<typeof parseMathText>): void {
  if (!r.ok) return;
  expect(r.doc.v).toBe("mathtext/1");
  expect(isMathTextDoc(r.doc)).toBe(true);
  r.doc.parts.forEach((p, i) => {
    if (p.t === "text") expect(i === 0 || r.doc.parts[i - 1]!.t !== "text").toBe(true);
  });
}

describe("parseMathText over the fixtures", () => {
  it("matches every golden row's ok/code", () => {
    let n = 0;
    for (const row of golden) {
      const r = parseMathText(row.in);
      expect(r, JSON.stringify(row.in.slice(0, 60))).toMatchObject(row.ok ? { ok: true } : { ok: false, code: row.code });
      assertDoc(r);
      n++;
    }
    expect(n).toBe(golden.length);
  });
  it("matches every sample's expectation", () => {
    for (const s of samples) {
      const r = parseMathText(s.input);
      expect(r, s.id).toMatchObject(s.expect === "accept" ? { ok: true } : { ok: false, code: (s.expect as { reject: string }).reject });
      assertDoc(r);
    }
  });
  it("matches every hostile row", () => {
    let n = 0;
    for (const h of HOSTILE_CASES) {
      const r = parseMathText(h.in);
      if (h.expect === "reject") expect(r, JSON.stringify(h.in.slice(0, 40))).toMatchObject({ ok: false, code: h.code });
      else assertDoc(r);
      n++;
    }
    expect(n).toBe(HOSTILE_CASES.length);
  });
  it("returns text and math parts with the parser version", () => {
    expect(parseMathText(String.raw`Solve \(x=1\).`)).toEqual({
      ok: true,
      doc: { v: "mathtext/1", parts: [{ t: "text", s: "Solve " }, { t: "math", m: { t: "rel", first: { t: "var", name: "x" }, rest: [{ op: "=", rhs: { t: "num", v: "1" } }] } }, { t: "text", s: "." }] },
    });
  });
});

describe("shape validator", () => {
  it("is the src guard: it rejects extra or missing properties and accepts a real parse (more cases in math-text-guard.test.ts)", () => {
    const wrap = (m: unknown) => ({ v: "mathtext/1", parts: [{ t: "math", m }] });
    expect(isMathTextDoc(wrap({ t: "var", name: "x", extra: 1 }))).toBe(false);
    expect(isMathTextDoc(wrap({ t: "frac", num: { t: "var", name: "x" } }))).toBe(false);
    expect(isMathTextDoc(wrap(ok(String.raw`\sqrt[3]{2}`)))).toBe(true);
  });
});

describe("root index", () => {
  it("counts one depth level (7 nested parentheses inside accepted, 8 rejected)", () => {
    expect(parseMathText(String.raw`\(\sqrt[(((((((x)))))))]{1}\)`).ok).toBe(true);
    expect(parseMathText(String.raw`\(\sqrt[((((((((x))))))))]{1}\)`)).toMatchObject({ ok: false, code: "math_depth" });
  });
  it("accepts simple indexes and refuses brackets and roots inside, at the offending token", () => {
    for (const ok of [String.raw`\sqrt[3]{27}`, String.raw`\sqrt[n]{x}`, String.raw`\sqrt[2x+1]{y}`]) expect(parseMathText(`\\(${ok}\\)`).ok, ok).toBe(true);
    const bad = parseMathText(String.raw`\(\sqrt[2\sqrt{4}]{y}\)`);
    expect(bad).toMatchObject({ ok: false, code: "math_unexpected_token" });
    expect(parseMathText(String.raw`\(\sqrt[1[2]]{y}\)`)).toMatchObject({ ok: false, code: "math_unexpected_token" });
  });
});

describe("depth 8 accepted, 9 rejected, per construct kind", () => {
  const chain = (n: number, wrap: (inner: string) => string, leaf = "x"): string => {
    let s = leaf;
    for (let i = 0; i < n; i++) s = wrap(s);
    return s;
  };
  const kinds: [string, (inner: string) => string][] = [
    ["frac numerator", (s) => String.raw`\frac{${s}}{1}`],
    ["frac denominator", (s) => String.raw`\frac{1}{${s}}`],
    ["subscript braces", (s) => `x_{${s}}`],
    ["sqrt body", (s) => String.raw`\sqrt{${s}}`],
    ["parentheses", (s) => `(${s})`],
    ["brackets", (s) => `[${s}]`],
    ["abs bars (alternating with parens is the only legal nesting)", (s) => `(${s})`],
  ];
  it.each(kinds)("%s", (_name, wrap) => {
    expect(parseMath(chain(8, wrap), 0)).toMatchObject({ ok: true });
    expect(parseMath(chain(9, wrap), 0)).toMatchObject({ ok: false, code: "math_depth" });
  });
  it("mixed parentheses and brackets", () => {
    const mixed = (n: number) => { let s = "x"; for (let i = 0; i < n; i++) s = i % 2 ? `[${s}]` : `(${s})`; return s; };
    expect(parseMath(mixed(8), 0)).toMatchObject({ ok: true });
    expect(parseMath(mixed(9), 0)).toMatchObject({ ok: false, code: "math_depth" });
  });
  it("mixed construct kinds including superscript braces", () => {
    const wraps = [(s: string) => `x^{${s}}`, (s: string) => String.raw`\frac{${s}}{1}`, (s: string) => `(${s})`, (s: string) => `x_{${s}}`];
    const mk = (n: number) => { let s = "y"; for (let i = 0; i < n; i++) s = (wraps[i % 4] as (s: string) => string)(s); return s; };
    expect(parseMath(mk(8), 0)).toMatchObject({ ok: true });
    expect(parseMath(mk(9), 0)).toMatchObject({ ok: false, code: "math_depth" });
  });
  it("superscript braces up to the exponent limit, at depth", () => {
    expect(parseMath("(((x^{y^{z^{w}}})))", 0)).toMatchObject({ ok: true }); // 3 + 3 levels
    expect(parseMath("((x^{y^{z^{w^{v}}}}))", 0)).toMatchObject({ ok: false, code: "math_exponent_depth" });
    expect(parseMath("((((x^{(y^{(z)})}))))", 0)).toMatchObject({ ok: true }); // 4 + 4 levels = 8
    expect(parseMath("(((((x^{(y^{(z)})})))))", 0)).toMatchObject({ ok: false, code: "math_depth" }); // 9
  });
  it("unary signs", () => {
    expect(parseMath("-".repeat(8) + "x", 0)).toMatchObject({ ok: true });
    expect(parseMath("-".repeat(9) + "x", 0)).toMatchObject({ ok: false, code: "math_depth" });
  });
  it("absolute value sits at depth like any construct", () => {
    expect(parseMath("(".repeat(7) + "|x|" + ")".repeat(7), 0)).toMatchObject({ ok: true });
    expect(parseMath("(".repeat(8) + "|x|" + ")".repeat(8), 0)).toMatchObject({ ok: false, code: "math_depth" });
  });
});

describe("absolute value nesting and signed adjacent numbers", () => {
  it.each(["|(|x|)|", String.raw`|\frac{|x|}{2}|`, "|x+|y||", "|x^{|y|}|", String.raw`|\sqrt[|2|]{x}|`, "|[|x|]|"])("rejects nested bars in %s", (src) => {
    expect(parseMath(src, 0)).toMatchObject({ ok: false, code: "math_unexpected_token" });
  });
  it.each(["|x|", "|x+1|", "2|x|", "|x|+|y|", "|x|(|y|)", "(|x|)(|y|)"])("accepts %s", (src) => {
    expect(parseMath(src, 0)).toMatchObject({ ok: true });
  });
  it("rejects a signed number followed by a number but not a subtraction", () => {
    expect(parseMath("-2 3", 0)).toMatchObject({ ok: false, code: "math_adjacent_numbers" });
    expect(parseMath("2 -3", 0)).toMatchObject({ ok: true, node: { t: "bin", op: "-" } });
    expect(ok("-2x")).toMatchObject({ t: "imp" });
    expect(ok(String.raw`\pi 3`)).toMatchObject({ t: "imp" });
    expect(ok("2^2 3")).toMatchObject({ t: "imp" });
  });
  it("tokenizer errors in a later span win over parser errors in an earlier span", () => {
    expect(parseMathText(String.raw`\((x\) and \(\input\)`)).toMatchObject({ ok: false, code: "math_unknown_command" });
  });
});
