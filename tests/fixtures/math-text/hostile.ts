import type { MathTextErrorCode } from "@/lib/math-text/ast";

/**
 * Inputs that must never reach TeX or HTML unchecked, each with the documented outcome (docs/mathtext.md):
 * `reject` means the parser returns that exact code; `reject_or_safe` means it may accept, but only if the emitted TeX
 * re-parses to the same AST and passes the allowlist (the input sits within the documented limits).
 */
export interface HostileCase {
  in: string;
  expect: "reject" | "reject_or_safe";
  code?: MathTextErrorCode;
}

export const HOSTILE_CASES: readonly HostileCase[] = [
  { in: "\\input{/etc/passwd}", expect: "reject", code: "text_backslash" },
  { in: "\\(\\input{x}\\)", expect: "reject", code: "math_unknown_command" },
  { in: "\\(\\csname x\\endcsname\\)", expect: "reject", code: "math_unknown_command" },
  { in: "\\(\\catcode 92=12\\)", expect: "reject", code: "math_unknown_command" },
  { in: "\\(^^5c\\)", expect: "reject", code: "math_unexpected_token" },
  { in: "\\(\\def\\a{\\a\\a}\\a\\)", expect: "reject", code: "math_unknown_command" },
  { in: "\\(\\frac{1\\)", expect: "reject", code: "math_brace_misuse" },
  { in: "\\(}\\)", expect: "reject", code: "math_brace_misuse" },
  { in: "\\(\\href{javascript:alert(1)}{x}\\)", expect: "reject", code: "math_unknown_command" },
  { in: "<script>alert(1)</script>", expect: "reject", code: "text_bad_char" },
  { in: "\\(<img src=x onerror=1>\\)", expect: "reject", code: "math_unexpected_token" },
  { in: "\\(\\frac\\input x\\)", expect: "reject", code: "math_unknown_command" },
  { in: "\\(\\sqrt[\\csname]{2}\\)", expect: "reject", code: "math_unknown_command" },
  { in: "\\(x^\\input\\)", expect: "reject", code: "math_unknown_command" },
  { in: "\\(\\pin\\)", expect: "reject", code: "math_unknown_command" },
  { in: "\\(\\lefts\\)", expect: "reject", code: "math_unknown_command" },
  { in: "\\(x \\le\\def\\)", expect: "reject", code: "math_unknown_command" },
  { in: "\uFF3C(x\uFF3C)", expect: "reject", code: "text_bad_char" }, // fullwidth backslash
  { in: "\uFF21 marks", expect: "reject", code: "text_bad_char" }, // fullwidth A
  { in: "\uFB01nd x", expect: "reject", code: "text_bad_char" }, // fi ligature
  { in: "\\(\u0445\\)", expect: "reject", code: "math_bad_char" }, // Cyrillic small ha
  { in: "a\u202Eb", expect: "reject", code: "text_bidi_char" },
  { in: "\\(x\u202Ey\\)", expect: "reject", code: "text_bidi_char" }, // bidi inside a span
  { in: "a\u200Db", expect: "reject", code: "text_bidi_char" }, // zero-width joiner
  { in: "\uFEFF\\(x\\)", expect: "reject", code: "text_bidi_char" }, // BOM
  { in: "a\u0000b", expect: "reject", code: "text_control_char" },
  { in: "a\u0085b", expect: "reject", code: "text_control_char" }, // C1 NEL
  { in: "\\\\(x\\\\)", expect: "reject", code: "text_backslash" },
  { in: "x\\", expect: "reject", code: "text_backslash" },
  { in: "\\(x\\) and \\)", expect: "reject", code: "delim_unexpected_close" },
  { in: "\\(x \\(y\\)\\)", expect: "reject", code: "delim_nested" },
  // Tokenizer stage (A3): split passes these on, the tokenizer rejects any character outside the math character set.
  { in: "\\(\uD800\\)", expect: "reject", code: "math_bad_char" }, // lone surrogate inside a span
  { in: "\\(x\u2028y\\)", expect: "reject", code: "math_bad_char" }, // line separator inside a span
  { in: "\\(x\u2029y\\)", expect: "reject", code: "math_bad_char" }, // paragraph separator inside a span
  { in: "\\(x\\\\)", expect: "reject", code: "math_bad_char" }, // span source ends with a lone backslash
  { in: "$$x$$", expect: "reject_or_safe" }, // plain text: `$` is an ordinary character
  // Over the 2000-character string limit.
  { in: "\\(" + "(".repeat(10_000) + "\\)", expect: "reject", code: "too_long" },
  { in: "\\(" + "-".repeat(10_000) + "x\\)", expect: "reject", code: "too_long" },
  { in: "x".repeat(100_000), expect: "reject", code: "too_long" },
  { in: "\\(" + "x".repeat(301) + "\\)", expect: "reject", code: "span_too_long" },
  { in: "\\(x\\)".repeat(21), expect: "reject", code: "too_many_spans" },
  // Within the 300-character span limit: depth is checked on entering a construct, so these are math_depth
  // even though they are also unbalanced.
  { in: "\\(" + "(".repeat(140) + "\\)", expect: "reject", code: "math_depth" },
  { in: "\\(" + "\\frac{".repeat(45) + "\\)", expect: "reject", code: "math_depth" },
  { in: "\\(" + "-".repeat(299) + "x\\)", expect: "reject", code: "math_depth" }, // each prefix sign is one level
  { in: "\\(" + "(|".repeat(140) + "\\)", expect: "reject", code: "math_depth" },
  { in: "\\(2^{3^{4^{5}}}\\)", expect: "reject_or_safe" }, // three nested exponents are within the limit
  { in: "mail me at a@b.co", expect: "reject", code: "text_email" },
  { in: "see https://evil.test", expect: "reject", code: "text_url" },
];

export const HOSTILE: readonly string[] = HOSTILE_CASES.map((c) => c.in);
