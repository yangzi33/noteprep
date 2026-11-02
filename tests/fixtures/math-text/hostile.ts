/** Inputs that must never reach TeX or HTML unchecked. Each is rejected with a code or, if accepted, re-emitted safely. */
export const HOSTILE: readonly string[] = [
  "\\input{/etc/passwd}",
  "\\(\\input{x}\\)",
  "\\(\\csname x\\endcsname\\)",
  "\\(\\catcode 92=12\\)",
  "\\(^^5c\\)",
  "\\(\\def\\a{\\a\\a}\\a\\)",
  "\\(\\frac{1\\)",
  "\\(}\\)",
  "\\(\\href{javascript:alert(1)}{x}\\)",
  "<script>alert(1)</script>",
  "\\(<img src=x onerror=1>\\)",
  "\\(\\frac\\input x\\)",
  "\\(\\sqrt[\\csname]{2}\\)",
  "\\(x^\\input\\)",
  "\\(\\pin\\)",
  "\\(\\lefts\\)",
  "\uFF3C(x\uFF3C)", // fullwidth backslash
  "\\(\u0445\\)", // Cyrillic small ha
  "a\u202Eb", // bidi override
  "a\u200Db", // zero-width joiner
  "\uFEFF\\(x\\)", // BOM
  "a\u0000b", // NUL
  "\\(" + "(".repeat(10_000) + "\\)",
  "\\(" + "-".repeat(10_000) + "x\\)",
  "x".repeat(100_000),
  "\\(" + "x".repeat(301) + "\\)",
  "\\(x\\)".repeat(21),
  "\\(2^{3^{4^{5}}}\\)",
  "mail me at a@b.co",
  "see https://evil.test",
];
