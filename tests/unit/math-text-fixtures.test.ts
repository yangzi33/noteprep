import { expect, it } from "vitest";
import samples from "../fixtures/math-text/samples.json";
import golden from "../fixtures/math-text/golden.json";
import { HOSTILE, HOSTILE_CASES } from "../fixtures/math-text/hostile";
import { MATH_TEXT_ERROR_CODES, MATHTEXT_LIMITS } from "@/lib/math-text/ast";

it("has exactly 20 samples covering the 12 allowlisted topics", () => {
  expect(samples).toHaveLength(20);
  expect(new Set(samples.map((s) => s.topic)).size).toBe(12);
  expect(samples.filter((s) => s.expect === "accept").length).toBeGreaterThanOrEqual(15);
});
it("golden rejects cover every parse error code", () => {
  const used = new Set(golden.filter((r) => !r.ok).map((r) => r.code));
  for (const code of MATH_TEXT_ERROR_CODES.filter((c) => !c.startsWith("render_"))) expect(used).toContain(code);
});
it("pins the spec limits", () => {
  expect(MATHTEXT_LIMITS).toMatchObject({ maxSpanChars: 300, maxDepth: 8, maxExponentDepth: 3, maxSpans: 20 });
});
it("every fixture error code is a known code", () => {
  const known = new Set<string>(MATH_TEXT_ERROR_CODES);
  for (const r of golden) if (!r.ok) expect(known.has(r.code as string), r.code).toBe(true);
  for (const s of samples) if (typeof s.expect === "object") expect(known.has(s.expect.reject), s.expect.reject).toBe(true);
  for (const h of HOSTILE_CASES) if (h.code) expect(known.has(h.code), h.code).toBe(true);
});
it("has unique sample ids and unique golden inputs", () => {
  expect(new Set(samples.map((s) => s.id)).size).toBe(samples.length);
  expect(new Set(golden.map((r) => r.in)).size).toBe(golden.length);
});
it("every hostile entry has a documented expected outcome", () => {
  expect(HOSTILE).toHaveLength(HOSTILE_CASES.length);
  expect(new Set(HOSTILE).size).toBe(HOSTILE.length);
  for (const h of HOSTILE_CASES) {
    expect(["reject", "reject_or_safe"]).toContain(h.expect);
    if (h.expect === "reject") expect(h.code, JSON.stringify(h.in.slice(0, 40))).toBeDefined();
  }
});

// Token-presence checks over the math spans of accept rows: one pattern per MathNode type.
const NODE_PATTERNS: Record<string, RegExp> = {
  num: /\d/,
  var: /(^|[^\\a-z])[a-z]/,
  greek: /\\(alpha|beta|theta|pi)/,
  ldots: /\\ldots/,
  bin: /\\(times|cdot|div|pm)|[\d)}a-z][+\-/][\d(\\a-z]/,
  imp: /\d[a-z(]|[a-z]\\pi|\\alpha\\beta|xy/,
  unary: /^(-|\+|\\pm)/,
  rel: /[=<>]|\\(le|ge|neq)/,
  list: /, /,
  group: /[\da-z][(\[]/,
  abs: /\|/,
  frac: /\\frac\{/,
  sqrt: /\\sqrt/,
  sup: /\^\{/,
  sub: /_\{/,
  pct: /\\%/,
  deg: /\^\{\\circ\}/,
  fn: /\\(sin|cos|tan|log|ln) |\\log_/,
};
it("every MathNode type appears in at least one accept row", () => {
  const spans = golden.filter((r) => r.ok).flatMap((r) => [...(r.canonical as string).matchAll(/\\\((.*?)\\\)/g)].map((m) => m[1]));
  for (const [node, re] of Object.entries(NODE_PATTERNS)) expect(spans.some((m) => re.test(m)), node).toBe(true);
  expect(Object.keys(NODE_PATTERNS)).toHaveLength(18);
});
it("accept rows are normalized and pin both orders of a double script", () => {
  const canon = new Map(golden.filter((r) => r.ok).map((r) => [r.in, r.canonical]));
  expect(canon.get("\\(x^2_3\\)")).toBe("\\(x_{3}^{2}\\)");
  expect(canon.get("\\(x_1^2\\)")).toBe("\\(x_{1}^{2}\\)");
  for (const r of golden.filter((r) => r.ok)) expect(r.canonical).toBe((r.canonical as string).normalize("NFC"));
});
it("pins the boundary rows at and one over each limit", () => {
  const at = (s: string) => golden.some((r) => r.ok && r.in === s);
  const over = (s: string, code: string) => golden.some((r) => !r.ok && r.in === s && r.code === code);
  expect(at("x".repeat(MATHTEXT_LIMITS.maxInputChars))).toBe(true);
  expect(over("x".repeat(MATHTEXT_LIMITS.maxInputChars + 1), "too_long")).toBe(true);
  expect(at("\\(" + "11" + "+x".repeat(149) + "\\)")).toBe(true);
  expect(over("\\(" + "x".repeat(MATHTEXT_LIMITS.maxSpanChars + 1) + "\\)", "span_too_long")).toBe(true);
  expect(at(Array(MATHTEXT_LIMITS.maxSpans).fill("\\(x\\)").join(" "))).toBe(true);
  expect(over("\\(x\\)".repeat(MATHTEXT_LIMITS.maxSpans + 1), "too_many_spans")).toBe(true);
  expect(at("\\(123456789012\\)")).toBe(true);
  expect(over("\\(1234567890123\\)", "math_number_too_long")).toBe(true);
  expect(at("\\(0.123456\\)")).toBe(true);
  expect(over("\\(0.1234567\\)", "math_number_too_long")).toBe(true);
  const nest = (n: number) => "\\(" + "(".repeat(n) + "x" + ")".repeat(n) + "\\)";
  expect(at(nest(MATHTEXT_LIMITS.maxDepth))).toBe(true);
  expect(over(nest(MATHTEXT_LIMITS.maxDepth + 1), "math_depth")).toBe(true);
});
