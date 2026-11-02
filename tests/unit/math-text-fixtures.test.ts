import { expect, it } from "vitest";
import samples from "../fixtures/math-text/samples.json";
import golden from "../fixtures/math-text/golden.json";
import { HOSTILE } from "../fixtures/math-text/hostile";
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
it("keeps the hostile corpus non-trivial", () => {
  expect(HOSTILE.length).toBeGreaterThanOrEqual(30);
});
