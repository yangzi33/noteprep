import { describe, expect, it } from "vitest";
import golden from "../fixtures/math-text/golden.json";
import samples from "../fixtures/math-text/samples.json";
import { HOSTILE_CASES } from "../fixtures/math-text/hostile";
import { UNPRINTABLE_LETTERS } from "@/lib/latex/escape";
import { normalizeMathTextInput, splitMathText } from "@/lib/math-text/split";

describe("splitMathText", () => {
  it("splits text and spans and keeps a bare dollar as text", () => {
    expect(splitMathText(String.raw`Pay $5 for \(x+1\) items`)).toEqual({
      ok: true,
      parts: [{ t: "text", s: "Pay $5 for " }, { t: "span", src: "x+1", at: 13 }, { t: "text", s: " items" }],
    });
  });
  it("keeps adjacent spans as two spans with nothing between them", () => {
    expect(splitMathText(String.raw`\(x\)\(x\)`)).toEqual({ ok: true, parts: [{ t: "span", src: "x", at: 2 }, { t: "span", src: "x", at: 7 }] });
  });
  it("treats $$x$$ as plain text", () => {
    expect(splitMathText("$$x$$")).toEqual({ ok: true, parts: [{ t: "text", s: "$$x$$" }] });
  });
  it("accepts a Latin Extended-A letter and refuses an unprintable one", () => {
    expect(splitMathText("Łódź")).toEqual({ ok: true, parts: [{ t: "text", s: "Łódź" }] });
    expect(splitMathText("Ħ")).toMatchObject({ ok: false, code: "text_bad_char" });
  });
  it.each([
    [String.raw`\(x`, "delim_unterminated"], [String.raw`x\)`, "delim_unexpected_close"], [String.raw`\(a\(b\)\)`, "delim_nested"],
    [String.raw`\\(x\)`, "text_backslash"], [String.raw`\[x\]`, "text_backslash"], ["end \\", "text_backslash"], [String.raw`\( \)`, "span_empty"],
  ])("delimiters never leak: %s -> %s", (input, code) => expect(splitMathText(input)).toMatchObject({ ok: false, code }));
  it.each([
    ["a\u0000b", "text_control_char"], ["a‮b", "text_bidi_char"], ["a‍b", "text_bidi_char"], ["﻿ab", "text_bidi_char"],
    ["＼(x＼)", "text_bad_char"], ["5 − 3", "text_bad_char"], ["2 × 3", "text_bad_char"], ["a < b", "text_bad_char"],
  ])("rejects invisible and confusable characters: %j -> %s", (input, code) => expect(splitMathText(input)).toMatchObject({ ok: false, code }));
  it("normalizes NFC, newlines and no-break spaces before checking", () => {
    expect(splitMathText("Café\nnow here")).toEqual({ ok: true, parts: [{ t: "text", s: "Café now here" }] });
    expect(normalizeMathTextInput("  a \r\n b\t")).toBe("a b");
  });
  it("rejects URLs and emails in text", () => {
    expect(splitMathText("see https://evil.test")).toMatchObject({ code: "text_url" });
    expect(splitMathText("visit WWW.evil.test")).toMatchObject({ code: "text_url" });
    expect(splitMathText("a@b.co")).toMatchObject({ code: "text_email" });
  });
  it("measures the input limit after NFC", () => {
    const decomposed = "e\u0301".repeat(1000) + "e"; // 2001 UTF-16 units, 1001 characters after NFC
    expect(decomposed.length).toBe(2001);
    expect(splitMathText(decomposed)).toMatchObject({ ok: true });
    expect(splitMathText("e\u0301".repeat(1000) + "ee")).toMatchObject({ ok: true });
    expect(splitMathText("\u00E9".repeat(2001))).toEqual({ ok: false, code: "too_long" });
    expect(splitMathText("e\u0301".repeat(2001))).toEqual({ ok: false, code: "too_long" }); // 4002 units, NFC 2001
    expect(splitMathText("x".repeat(8001))).toEqual({ ok: false, code: "too_long" });
  });
  it("rejects every letter the pinned fonts cannot print", () => {
    expect(UNPRINTABLE_LETTERS.size).toBe(9);
    for (const ch of UNPRINTABLE_LETTERS) expect(splitMathText(ch), ch).toMatchObject({ ok: false, code: "text_bad_char" });
  });
  it("enforces size limits", () => {
    expect(splitMathText("x".repeat(100_000))).toEqual({ ok: false, code: "too_long" });
    expect(splitMathText(`\\(${"x".repeat(301)}\\)`)).toMatchObject({ code: "span_too_long" });
    expect(splitMathText(`\\(${"x".repeat(300)}\\)`)).toMatchObject({ ok: true });
    expect(splitMathText("\\(x\\)".repeat(21))).toMatchObject({ code: "too_many_spans" });
    expect(splitMathText("   ")).toEqual({ ok: false, code: "empty" });
  });
});

// Fixture rows decided at the split stage: delimiters, text characters, URL/e-mail, size limits, normalization, empty.
// Rows whose expected outcome is a math_* code (tokenizer/parser, tasks A3/A4) are only required to survive the split.
const SPLIT_CODES = /^(empty|too_long|text_|delim_|too_many_spans|span_)/;
type Row = { name: string; input: string; code?: string; ok: boolean };
const rows: Row[] = [
  ...golden.map((r) => ({ name: "golden", input: r.in, ok: !!r.ok, code: r.code })),
  ...samples.map((s) => ({ name: s.id, input: s.input, ok: s.expect === "accept", code: typeof s.expect === "object" ? s.expect.reject : undefined })),
  ...HOSTILE_CASES.map((h) => ({ name: "hostile", input: h.in, ok: h.expect !== "reject", code: h.code })),
];
describe("split stage against the shared fixtures", () => {
  it.each(rows.map((r) => [r.name, r.input.length > 60 ? `${r.input.slice(0, 57)}...(${r.input.length})` : r.input, r] as const))(
    "%s: %j",
    (_n, _label, r) => {
      const res = splitMathText(r.input);
      if (r.code && SPLIT_CODES.test(r.code)) expect(res).toMatchObject({ ok: false, code: r.code });
      else expect(res.ok, "split must pass; the rest is the tokenizer's job").toBe(true);
      if (r.ok && res.ok && !res.parts.some((p) => p.t === "span")) {
        // text-only accept rows must equal their canonical form
        const canonical = golden.find((g) => g.in === r.input)?.canonical;
        if (canonical) expect(res.parts.map((p) => (p.t === "text" ? p.s : "")).join("")).toBe(canonical);
      }
    },
  );
  it("covers every row kind", () => {
    expect(rows.filter((r) => r.code && SPLIT_CODES.test(r.code)).length).toBeGreaterThan(30);
  });
});
