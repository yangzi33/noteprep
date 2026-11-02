# Slice B-a (MathText) and B-b (OpenAI adapter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two foundations of slice B that nothing else depends on yet: MathText, the only path by which model-written math can reach a document (B-a), and an OpenAI adapter behind the existing provider-agnostic LLM interface (B-b).

**Architecture:** B-a is a pure TypeScript module `src/lib/math-text/`: a hand-written splitter, tokenizer and recursive-descent parser produce one typed AST; one function turns math nodes into TeX, and that TeX is at the same time the canonical MathText serialization (so whatever we emit re-parses to the same AST). The PDF path escapes text with the existing `escapeText` tables; the HTML path hands the same TeX to the existing `renderMathHtml`/`Inlines`. One macro allowlist constant feeds the MathText checks and `assertTexIsSafe`. B-b adds `src/lib/llm/openai.ts`, a plain-HTTPS adapter with injected `fetch`, mirroring `anthropic.ts`, plus two small backward-compatible additions to `src/lib/llm/types.ts`. Nothing is wired into drafts, packages or the worker pipeline (B-c and B-e do that).

**Tech Stack:** Node `^24.11.0`, pnpm `10.33.0`, TypeScript 5.9 strict, Vitest 5 (unit config `vitest.config.mts`, `tests/unit/**/*.test.ts`), zod 4 (env only), katex 0.19.0 (already a dependency; reached only through `src/lib/ui/math-html.ts`), React 19 `renderToStaticMarkup` for HTML assertions.

**Spec:** `docs/superpowers/specs/2026-11-01-slice-b-llm-items-design.md` (sections 4, 5.4, 5.6, 9, 10, acceptance check 2, appendix A). Binding: CLAUDE.md sections 2, 7, 8, 9, 11 and the Evaluator-Optimizer workflow (as amended on `docs/slice-b-claude-md`, D-116); decisions D-96 (MathText mandatory; reverses the D-85 deferral), D-95, D-81 and D-40 (OpenAI preferred, keep Anthropic and fake, no model id or price defaults), D-98 (spend never under-counted), D-117 (D-43 grade band; privacy notice is NOT part of this work).

**Branches:** B-a on `feat/slice-b-a-mathtext`, B-b on `feat/slice-b-b-openai`, both from `main`; their file sets are disjoint (B-a: `src/lib/math-text/**`, `src/lib/latex/{escape,templates,render,allowlist}.ts`, `docs/mathtext.md`; B-b: `src/lib/llm/**`, `worker/env.ts`, `src/lib/ui/messages.ts`, `scripts/`, `package.json`, the other docs), so they can run in parallel.

## Global Constraints

- No new runtime or dev dependency. The parser is hand-written; no KaTeX/MathJax is used for validation beyond the existing `renderMathHtml`; property tests use a seeded PRNG written in the test tree (rationale: no `fast-check`, reproducible seeds, nothing to pin).
- pnpm only, one lockfile (unchanged); TypeScript strict; tests are Vitest unit tests only. No real network call in any test or in CI: every adapter test injects `fetch`.
- `process.env` is read only in `src/lib/server/env.ts`, `worker/env.ts`, `src/lib/supabase/public-env.ts` (and `scripts/**`, tests). The adapter and MathText read no environment.
- No model id, price, or API key default anywhere in the repository (D-40). Secrets only via the worker's server env; never logged, never in an error, result, or thrown message.
- MathText string form: "plain text with inline math in `\( ... \)`; a bare `$` is text. No display math in slice B."
- MathText math subset (verbatim): "bounded integers and decimals; single Latin letters; `\alpha \beta \theta \pi`; `+ - = < > \le \ge \neq \pm \times \cdot \div / ,`; balanced `()` `[]`; `|x|`; `\frac{}{}`; `^`; `_`; `\sqrt{}` and `\sqrt[n]{}`; `\%`; `^\circ`; `\sin \cos \tan \log \ln`; `\ldots`." Limits (verbatim): "span at most 300 characters, depth 8, exponent nesting 3, 20 spans per string." "The grammar grows only by deliberate change."
- Parser: "hand-written recursive descent into a typed AST, versioned (`MATHTEXT_PARSER_VERSION`); errors are codes; no regex sanitizing as the boundary."
- Renderers: "`toTex(ast)` emits a fixed macro set (text through `t()` in `src/lib/latex/escape.ts`; `ALLOWED_BODY_COMMANDS` grows by exactly those macros); HTML renders the SAME TeX via `renderMathHtml`; text through React escaping. Canonical serializer with `parse(serialize(ast)) == ast`."
- Math content is never raw model text in LaTeX or HTML; MathText is the only way model math reaches a document.
- `RENDER_VERSION` stays `render/1` and `TEMPLATE_VERSION` stays `classic/2`: B-a must not change one byte of a deterministic document (`tests/unit/render-golden.test.ts` stays green untouched).
- Every task ends with `pnpm typecheck`, `pnpm lint` and its focused tests passing; commit per task with explicit paths (`git add <paths>`, never `git add -A`); never push from a task.
- Model routing: Sonnet implementers and routine per-task evaluators; Opus independent reviews for the rendering boundary (Task A9) and the provider boundary (Task B8). The evaluator is never the agent that wrote the code.

## Review Focus

1. **Delimiter confusion**: `\(` without `\)`, `\)` in text, `\(` inside math, `\\(`, a lone `\` before `(` at the end, `$$`, `\[`. Expected: every case is a typed reject or plain text; no math span ever starts or ends anywhere but a matched `\(`/`\)`. Pinned in Task A2 (`delimiters never leak`).
2. **Unicode confusables and invisible characters**: fullwidth backslash `＼`, Cyrillic letters inside math, U+2212 minus, `×`, `≤`, NUL, C1 controls, bidi overrides, zero-width joiners, BOM, decomposed (non-NFC) letters. Expected: rejected with a code, or (for NFC, CR/LF/TAB, U+00A0) normalized before parsing; never reaches TeX as `?`. Pinned in Task A2 (`rejects invisible and confusable characters`) and Task A3.
3. **Macro smuggling through allowed constructs and parser/renderer divergence**: `\frac\input x`, `\sqrt[\csname x\endcsname]{2}`, `x^\input`, `^^5c`, `\le\def`, a command name prefix like `\pin` or `\lefts`. Expected: rejected; and for every accepted input, the emitted TeX re-parses to the identical AST and passes both the allowlist scanner and KaTeX strict. Pinned in Task A5 (`emitted tex re-parses to the same AST`) and Task A7 (`every emitted tex passes the allowlist and KaTeX`).
4. **Huge or deep inputs**: 100k-character strings, 10k nested `(`, 10k unary minus signs, 300-character spans whose TeX would exceed `renderMathHtml`'s 500-character cap. Expected: bounded time, no stack overflow, a typed reject (`too_long`, `math_depth`, `render_tex_too_long`). Pinned in Task A4 (`bounded depth without recursion blow-up`) and Task A8 (`bounded work on hostile sizes`).
5. **Provider errors that look retryable or cheap**: HTTP 429 `insufficient_quota` (project hard limit reached, amendment 9) retried like a rate limit; a 200 whose body is a refusal or truncated treated as success; usage missing recorded as zero spend; an oversized body read into memory. Expected: quota is non-retryable `quota_exhausted`; refusal/truncation are failures; missing usage yields a conservative ceiling with `usageEstimated: true`; oversized bodies are cut and fail. Pinned in Task B4 (`never reports zero spend`) and Task B5 (`quota exhaustion is not retried`).

---

## File structure

B-a (`src/lib/math-text/`, pure, no React, no server-only, no Prisma):

| File | Responsibility |
|---|---|
| `ast.ts` | AST types, `MATHTEXT_PARSER_VERSION`, limit constants, `MATH_TEXT_ERROR_CODES`, result type |
| `commands.ts` | `MATH_TEX_COMMANDS`, `MATH_TEX_SYMBOLS`: the one macro allowlist (imports nothing) |
| `split.ts` | normalization, text-segment rules, `\(`/`\)` splitting, span limits |
| `tokenize.ts` | math-span tokenizer |
| `parse.ts` | recursive-descent parser and `parseMathText` (public entry) |
| `to-tex.ts` | `mathToTex` (also the canonical math serialization), `serializeMathText`, `mathTextToTex` |
| `to-html.ts` | `mathTextToInlineParts` for the existing `Inlines` component |
| `check.ts` | `checkMathTextRenders`: the static preview check (allowlist scan plus KaTeX strict) |
| `index.ts` | the stable public surface |

Shared, modified: `src/lib/latex/allowlist.ts` (new: `firstDisallowedControlSequence`), `src/lib/latex/escape.ts` (adds `escapeTextFragment`), `src/lib/latex/templates.ts` (allowlist union), `src/lib/latex/render.ts` (uses the scanner). Docs: `docs/mathtext.md` (one-page grammar). Fixtures: `tests/fixtures/math-text/{samples.json,golden.json,hostile.ts,gen.ts}`.

B-b: `src/lib/llm/openai.ts` (new), `src/lib/llm/http.ts` (new: capped body read, retry-after parsing), `src/lib/llm/types.ts`, `src/lib/llm/factory.ts`, `worker/env.ts`, `src/lib/ui/messages.ts`, `scripts/eval-prose.ts` (provider enum), `scripts/smoke-llm.ts` (optional), docs.

---

## Sub-slice B-a: MathText

### Task A1: Grammar spec, AST contract and the fixture corpus

**Files:**
- Create: `docs/mathtext.md`, `src/lib/math-text/ast.ts`, `tests/fixtures/math-text/samples.json`, `tests/fixtures/math-text/golden.json`, `tests/fixtures/math-text/hostile.ts`
- Test: `tests/unit/math-text-fixtures.test.ts`

**Interfaces:**
- Produces (exact, `ast.ts`):

```ts
export const MATHTEXT_PARSER_VERSION = "mathtext/1";
export const MATHTEXT_LIMITS = { maxInputChars: 2000, maxSpanChars: 300, maxDepth: 8, maxExponentDepth: 3, maxSpans: 20, maxIntDigits: 12, maxFracDigits: 6 } as const;
export const MATH_TEXT_ERROR_CODES = [
  "empty", "too_long", "text_bad_char", "text_control_char", "text_bidi_char", "text_backslash", "text_url", "text_email",
  "delim_unterminated", "delim_unexpected_close", "delim_nested", "too_many_spans", "span_too_long", "span_empty",
  "math_bad_char", "math_unknown_command", "math_number_too_long", "math_leading_zero", "math_digit_grouping",
  "math_adjacent_numbers", "math_unbalanced", "math_unexpected_token", "math_brace_misuse", "math_bad_script",
  "math_depth", "math_exponent_depth",
  "render_tex_disallowed", "render_tex_too_long", "render_katex_rejected",
] as const;
export type MathTextErrorCode = (typeof MATH_TEXT_ERROR_CODES)[number];
export type Greek = "alpha" | "beta" | "theta" | "pi";
export type FnName = "sin" | "cos" | "tan" | "log" | "ln";
export type BinOp = "+" | "-" | "pm" | "times" | "cdot" | "div" | "/";
export type RelOp = "=" | "<" | ">" | "le" | "ge" | "neq";
export type MathNode =
  | { t: "num"; v: string }                       // literal digits as written (canonical: no leading zeros)
  | { t: "var"; name: string }                    // one ASCII letter
  | { t: "greek"; name: Greek }
  | { t: "ldots" }
  | { t: "bin"; op: BinOp; l: MathNode; r: MathNode } // left-associative
  | { t: "imp"; items: MathNode[] }               // implicit product, >= 2 items
  | { t: "unary"; op: "-" | "+" | "pm"; arg: MathNode }
  | { t: "rel"; first: MathNode; rest: { op: RelOp; rhs: MathNode }[] }
  | { t: "list"; items: MathNode[] }              // comma list, >= 2 items
  | { t: "group"; open: "(" | "["; body: MathNode }
  | { t: "abs"; body: MathNode }
  | { t: "frac"; num: MathNode; den: MathNode }
  | { t: "sqrt"; index?: MathNode; body: MathNode }
  | { t: "sup"; base: MathNode; exp: MathNode }
  | { t: "sub"; base: MathNode; sub: MathNode }
  | { t: "pct"; arg: MathNode }
  | { t: "deg"; arg: MathNode }
  | { t: "fn"; name: FnName; base?: MathNode; arg: MathNode }; // base only for log
export type MathTextPart = { t: "text"; s: string } | { t: "math"; m: MathNode };
export interface MathTextDoc { v: typeof MATHTEXT_PARSER_VERSION; parts: MathTextPart[] }
export type MathTextResult = { ok: true; doc: MathTextDoc } | { ok: false; code: MathTextErrorCode; at?: number };
```

- [ ] **Step 1: Write `docs/mathtext.md`** (one page, English): the string form, the text rules, the EBNF below, the limits, the canonical form rules, the error codes with one example each, and "the grammar grows only by deliberate change (bump `MATHTEXT_PARSER_VERSION`)".

```
doc      := (text | "\(" math "\)")+           -- after normalization, at least one non-space char
math     := list
list     := relation ("," relation)*
relation := expr (relop expr)*                 -- relop: = < > \le \ge \neq
expr     := term (addop term)*                 -- addop: + - \pm      (left-assoc)
term     := unary ((mulop unary) | implicit)*  -- mulop: \times \cdot \div /   implicit: juxtaposed postfix
unary    := ("-" | "+" | "\pm") unary | postfix   -- unary only at expr start or right after an operator/relop/comma/open
postfix  := primary ( "^" script | "_" script | "\%" )*    -- "^\circ" / "^{\circ}" => deg
script   := digit | letter | "{" math "}"
primary  := number | letter | greek | "\ldots" | "(" math ")" | "[" math "]" | "|" expr "|"
          | "\frac" "{" math "}" "{" math "}" | "\sqrt" ("[" math "]")? "{" math "}"
          | fn ( "_" script )? postfix          -- "_" only after \log
number   := "0" | [1-9][0-9]{0,11}  ("." [0-9]{1,6})?
```

Canonical form (one rule set, used by `mathToTex` in Task A5): no whitespace except one space after a control word when the next character is an ASCII letter, and one space after every list comma (so `\(1, 500\)` never re-serializes as the rejected digit grouping `1,500`); scripts always braced (`x^{2}`, `a_{n}`, `30^{\circ}`); `\sqrt[n]{b}`; `\frac{a}{b}`; text parts have whitespace runs collapsed to one space and the document trimmed.

- [ ] **Step 2: Write `samples.json`**: exactly 20 realistic item documents as a model would write them, covering all 12 allowlisted topics (`percent-of-quantity`, `percent-change`, `proportions`, `exponent-laws`, `pythagorean-theorem`, `simple-probability`, `equations-with-brackets`, `systems-linear-equations`, `quadratic-equations-factoring`, `function-notation`, `quadratic-formula`, `sequences-series`). Shape per row: `{ "id": "s01", "topic": "...", "field": "stem" | "answer" | "step", "input": "...", "expect": "accept" | { "reject": "<code>" }, "note": "..." }`. At least 15 accept; the rejects are the realistic failure modes: Unicode minus (`text_bad_char` or `math_bad_char`), `\text{...}` (`math_unknown_command`), display math `\[...\]` (`text_backslash`), thousands separator `\(1,500\)` (`math_digit_grouping`). One accept row is `"Solve $2x+3=11$."` with note "accepted as plain text; B-c decides whether `$` in an AI field is a gate failure".

- [ ] **Step 3: Write `golden.json`**: rows `{ "in", "ok": true, "canonical", "tex" } | { "in", "ok": false, "code" }`. Requirements: every `MathNode.t` appears in at least one accept row; every `MATH_TEXT_ERROR_CODES` entry except the three `render_*` codes appears in at least one reject row. Pin these rows verbatim (they fix the canonical form):

| in | ok | canonical | tex |
|---|---|---|---|
| `Solve \(2x + 3 = 11\).` | true | `Solve \(2x+3=11\).` | `Solve $2x+3=11$.` |
| `\(\frac{1}{2} \pi r^2\)` | true | `\(\frac{1}{2}\pi r^{2}\)` | `$\frac{1}{2}\pi r^{2}$` |
| `\(a_{n+1} = a_n + 3\)` | true | `\(a_{n+1}=a_{n}+3\)` | `$a_{n+1}=a_{n}+3$` |
| `\(\sin 30^\circ\)` | true | `\(\sin 30^{\circ}\)` | `$\sin 30^{\circ}$` |
| `Cost: $5 and 15\% off? No: \(15\%\) of \(80\)` | false | | code `text_backslash` |
| `\(1,500\)` | false | | code `math_digit_grouping` |
| `\(2 3\)` | false | | code `math_adjacent_numbers` |
| `\(x\) and \(` | false | | code `delim_unterminated` |

- [ ] **Step 4: Write `hostile.ts`**: `export const HOSTILE: readonly string[]` with at least: `\input{/etc/passwd}`, `\(\input{x}\)`, `\(\csname x\endcsname\)`, `\(\catcode 92=12\)`, `\(^^5c\)`, `\(\def\a{\a\a}\a\)`, `\(\frac{1\)`, `\(}\)`, `\(\href{javascript:alert(1)}{x}\)`, `<script>alert(1)</script>`, `\(<img src=x onerror=1>\)`, `\(\frac\input x\)`, `\(\sqrt[\csname]{2}\)`, `\(x^\input\)`, `\(\pin\)`, `\(\lefts\)`, `＼(x＼)`, `\(х\)` (Cyrillic), `a‮b`, `a‍b`, `﻿\(x\)`, `a\u0000b`, `\(` + `(`.repeat(10_000) + `\)`, `\(` + `-`.repeat(10_000) + `x\)`, `"x".repeat(100_000)`, `\(` + `x`.repeat(301) + `\)`, `\(x\)`.repeat(21), `\(2^{3^{4^{5}}}\)`, `mail me at a@b.co`, `see https://evil.test`.

- [ ] **Step 5: Write the failing fixture test**

```ts
import samples from "../fixtures/math-text/samples.json";
import golden from "../fixtures/math-text/golden.json";
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
```

- [ ] **Step 6: Run** `pnpm vitest run tests/unit/math-text-fixtures.test.ts`. Expected: FAIL first (module missing), then PASS after `ast.ts` exists.
- [ ] **Step 7: Run** `pnpm typecheck && pnpm lint`. Expected: clean.
- [ ] **Step 8: Commit**

```bash
git add docs/mathtext.md src/lib/math-text/ast.ts tests/fixtures/math-text/samples.json tests/fixtures/math-text/golden.json tests/fixtures/math-text/hostile.ts tests/unit/math-text-fixtures.test.ts
git commit -m "feat(math-text): grammar spec, AST contract and fixture corpus"
```

### Task A2: Normalization, text rules and span splitting

**Files:**
- Create: `src/lib/math-text/split.ts`
- Test: `tests/unit/math-text-split.test.ts`

**Interfaces:**
- Consumes: `MathTextErrorCode`, `MATHTEXT_LIMITS` (A1); `printsLiterally` from `src/lib/latex/escape.ts`.
- Produces: `normalizeMathTextInput(input: string): string`; `splitMathText(input: string): { ok: true; parts: ({ t: "text"; s: string } | { t: "span"; src: string; at: number })[] } | { ok: false; code: MathTextErrorCode; at?: number }`.

Rules (decided here): check `input.length > maxInputChars` FIRST (`too_long`, before normalization, so 100k strings cost O(1) beyond the length read); then NFC; CR, LF, TAB, U+00A0 become a space. Text characters are allowed iff `printsLiterally(ch)` and `ch` is not `\`, `{`, `}`, and none of: C0/C1 controls (`text_control_char`), bidi and invisible formatting U+061C, U+200B-U+200F, U+202A-U+202E, U+2066-U+2069, U+FEFF (`text_bidi_char`). Any `\` in text not followed by `(` is `text_backslash` (this covers `\[`, `\)` in text is `delim_unexpected_close`). Text containing `://` or case-insensitive `www.` is `text_url`; any `@` is `text_email`. Inside a span, `\(` is `delim_nested`; end of input inside a span is `delim_unterminated`; span length after trim 0 is `span_empty`, over 300 is `span_too_long`; more than 20 spans `too_many_spans`; a document with no non-space character `empty`.

- [ ] **Step 1: Write the failing tests**

```ts
it("splits text and spans and keeps a bare dollar as text", () => {
  expect(splitMathText(String.raw`Pay $5 for \(x+1\) items`)).toEqual({ ok: true, parts: [
    { t: "text", s: "Pay $5 for " }, { t: "span", src: "x+1", at: 13 }, { t: "text", s: " items" }] });
});
it.each([
  [String.raw`\(x`, "delim_unterminated"], [String.raw`x\)`, "delim_unexpected_close"], [String.raw`\(a\(b\)\)`, "delim_nested"],
  [String.raw`\\(x\)`, "text_backslash"], [String.raw`\[x\]`, "text_backslash"], ["end \\", "text_backslash"], [String.raw`\( \)`, "span_empty"],
])("delimiters never leak: %s -> %s", (input, code) => expect(splitMathText(input)).toMatchObject({ ok: false, code }));
it.each([
  ["a\u0000b", "text_control_char"], ["a‮b", "text_bidi_char"], ["a‍b", "text_bidi_char"], ["﻿ab", "text_bidi_char"],
  ["＼(x＼)", "text_bad_char"], ["5 − 3", "text_bad_char"], ["2 × 3", "text_bad_char"],
])("rejects invisible and confusable characters: %j -> %s", (input, code) => expect(splitMathText(input)).toMatchObject({ ok: false, code }));
it("normalizes NFC, newlines and no-break spaces before checking", () => {
  expect(splitMathText("Café\nnow")).toEqual({ ok: true, parts: [{ t: "text", s: "Café now" }] });
});
it("rejects URLs and emails in text", () => {
  expect(splitMathText("see https://evil.test")).toMatchObject({ code: "text_url" });
  expect(splitMathText("visit www.evil.test")).toMatchObject({ code: "text_url" });
  expect(splitMathText("a@b.co")).toMatchObject({ code: "text_email" });
});
it("enforces size limits before any other work", () => {
  expect(splitMathText("x".repeat(100_000))).toEqual({ ok: false, code: "too_long" });
  expect(splitMathText(`\\(${"x".repeat(301)}\\)`)).toMatchObject({ code: "span_too_long" });
  expect(splitMathText("\\(x\\)".repeat(21))).toMatchObject({ code: "too_many_spans" });
  expect(splitMathText("   ")).toEqual({ ok: false, code: "empty" });
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/math-text-split.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `normalizeMathTextInput` and `splitMathText` in `split.ts` as one left-to-right scan (no regex on the whole input as the boundary; regex is allowed only for the URL/email detection on an already-accepted text part).
- [ ] **Step 4: Run** the test, `pnpm typecheck`, `pnpm lint`. Expected: PASS, clean.
- [ ] **Step 5: Commit** `git add src/lib/math-text/split.ts tests/unit/math-text-split.test.ts` then `git commit -m "feat(math-text): normalization, text rules and span splitting"`.

### Task A3: Math tokenizer

**Files:**
- Create: `src/lib/math-text/tokenize.ts`
- Test: `tests/unit/math-text-tokenize.test.ts`

**Interfaces:**
- Consumes: `MathTextErrorCode`, `MATHTEXT_LIMITS`, `Greek`, `FnName`, `BinOp`, `RelOp` (A1).
- Produces:

```ts
export type Token =
  | { k: "num"; v: string; at: number } | { k: "letter"; v: string; at: number }
  | { k: "cmd"; v: "alpha" | "beta" | "theta" | "pi" | "le" | "ge" | "neq" | "pm" | "times" | "cdot" | "div" | "frac" | "sqrt" | "circ" | "sin" | "cos" | "tan" | "log" | "ln" | "ldots"; at: number }
  | { k: "pct"; at: number }
  | { k: "op"; v: "+" | "-" | "=" | "<" | ">" | "/" | "," | "^" | "_" | "|" | "(" | ")" | "[" | "]" | "{" | "}"; at: number };
export function tokenizeMath(src: string, offset: number): { ok: true; tokens: Token[] } | { ok: false; code: MathTextErrorCode; at: number };
```

Rules: whitespace (space only, after A2 normalization) separates tokens and is otherwise dropped, but the tokenizer records adjacency so `1,500` (comma with a digit immediately on both sides) is `math_digit_grouping`. A command is `\` followed by the maximal run of ASCII letters; a name not in the `cmd` list is `math_unknown_command` (so `\pin`, `\lefts`, `\input`, `\text` all fail); `\%` is `pct`; any other `\` + non-letter is `math_unknown_command`. Numbers follow the A1 `number` rule: leading zero `math_leading_zero`, too many digits `math_number_too_long`. Any character outside ASCII letters, digits, the `op` set, space and `\` is `math_bad_char` (this rejects `^^5c` only at the parser; `^` is a token, see Task A4).

- [ ] **Step 1: Write the failing tests**

```ts
it("tokenizes commands, numbers and operators with offsets", () => {
  expect(tokenizeMath(String.raw`\frac{3}{4}x\le 2.5`, 0)).toEqual({ ok: true, tokens: [
    { k: "cmd", v: "frac", at: 0 }, { k: "op", v: "{", at: 5 }, { k: "num", v: "3", at: 6 }, { k: "op", v: "}", at: 7 },
    { k: "op", v: "{", at: 8 }, { k: "num", v: "4", at: 9 }, { k: "op", v: "}", at: 10 }, { k: "letter", v: "x", at: 11 },
    { k: "cmd", v: "le", at: 12 }, { k: "num", v: "2.5", at: 16 }] });
});
it.each([
  [String.raw`\pin`, "math_unknown_command"], [String.raw`\lefts`, "math_unknown_command"], [String.raw`\input`, "math_unknown_command"],
  [String.raw`\text{a}`, "math_unknown_command"], [String.raw`\$`, "math_unknown_command"], ["х", "math_bad_char"], ["2−3", "math_bad_char"],
  ["007", "math_leading_zero"], ["1234567890123", "math_number_too_long"], ["1.1234567", "math_number_too_long"], ["1,500", "math_digit_grouping"],
  ["x*y", "math_bad_char"], ["x;y", "math_bad_char"], ["a&b", "math_bad_char"], ["#1", "math_bad_char"],
])("rejects %j as %s", (src, code) => expect(tokenizeMath(src, 0)).toMatchObject({ ok: false, code }));
it("accepts a list with a space after the comma", () => {
  expect(tokenizeMath("1, 500", 0)).toMatchObject({ ok: true });
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/math-text-tokenize.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `tokenizeMath` as a single linear scan.
- [ ] **Step 4: Run** test, typecheck, lint. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/math-text/tokenize.ts tests/unit/math-text-tokenize.test.ts` then `git commit -m "feat(math-text): math tokenizer"`.

### Task A4: Recursive-descent parser and `parseMathText`

**Files:**
- Create: `src/lib/math-text/parse.ts`
- Test: `tests/unit/math-text-parse.test.ts`

**Interfaces:**
- Consumes: `splitMathText` (A2), `tokenizeMath`, `Token` (A3), AST types (A1).
- Produces: `parseMath(src: string, offset: number): { ok: true; node: MathNode } | { ok: false; code: MathTextErrorCode; at: number }`; `parseMathText(input: string): MathTextResult` (text parts are the collapsed text, math parts the parsed nodes; adjacent text parts merged; document trimmed).

Decisions the tests pin: left-associative `bin`; a single-item `imp`/`list` is never produced (the item itself is returned); `imp` refuses a `num` directly after a `num` (`math_adjacent_numbers`); `{`/`}` anywhere but a `\frac`/`\sqrt`/script argument is `math_brace_misuse`; `^` or `_` without a valid script, a second script of the same kind, `_` after a function other than `\log`, or `^` after a function, is `math_bad_script`; `^` followed by `\circ` or `{\circ}` builds `deg`; a mismatched or missing closer is `math_unbalanced`. Depth counts every group, `abs`, `frac`, `sqrt`, script argument AND every unary operator; depth above 8 is `math_depth`, checked on entry to each nested production so recursion depth is bounded by 8 regardless of input. Exponent nesting above 3 is `math_exponent_depth`.

- [ ] **Step 1: Write the failing tests**

```ts
const ok = (src: string) => { const r = parseMath(src, 0); if (!r.ok) throw new Error(r.code); return r.node; };
it("parses left-associative binary operators and implicit products", () => {
  expect(ok("a-b-c")).toEqual({ t: "bin", op: "-", l: { t: "bin", op: "-", l: { t: "var", name: "a" }, r: { t: "var", name: "b" } }, r: { t: "var", name: "c" } });
  expect(ok("2x")).toEqual({ t: "imp", items: [{ t: "num", v: "2" }, { t: "var", name: "x" }] });
});
it("parses chained relations, lists, degree and log base", () => {
  expect(ok(String.raw`1<x\le 5`)).toMatchObject({ t: "rel", rest: [{ op: "<" }, { op: "le" }] });
  expect(ok("(2, 3)")).toMatchObject({ t: "group", open: "(", body: { t: "list" } });
  expect(ok(String.raw`30^\circ`)).toEqual({ t: "deg", arg: { t: "num", v: "30" } });
  expect(ok(String.raw`\log_{2} 8`)).toMatchObject({ t: "fn", name: "log", base: { t: "num", v: "2" }, arg: { t: "num", v: "8" } });
});
it.each([
  ["2 3", "math_adjacent_numbers"], ["(x", "math_unbalanced"], ["(x]", "math_unbalanced"], ["{x}", "math_brace_misuse"],
  ["x^", "math_bad_script"], ["x^{2}^{3}", "math_bad_script"], [String.raw`\sin_{2} x`, "math_bad_script"], [String.raw`\sin^{2} x`, "math_bad_script"],
  [String.raw`\sqrt{}`, "math_unexpected_token"], ["^^5c", "math_unexpected_token"], [String.raw`\frac\input x`, "math_unknown_command"],
  [String.raw`2^{3^{4^{5^{6}}}}`, "math_exponent_depth"], ["(".repeat(9) + "x" + ")".repeat(9), "math_depth"],
])("rejects %s as %s", (src, code) => expect(parseMath(src, 0)).toMatchObject({ ok: false, code }));
it("bounded depth without recursion blow-up", () => {
  expect(parseMath("(".repeat(10_000) + "x" + ")".repeat(10_000), 0)).toMatchObject({ ok: false, code: "math_depth" });
  expect(parseMath("-".repeat(10_000) + "x", 0)).toMatchObject({ ok: false, code: "math_depth" });
});
it("matches every golden row's ok/code and every sample's expectation", () => {
  for (const row of golden) expect(parseMathText(row.in)).toMatchObject(row.ok ? { ok: true } : { ok: false, code: row.code });
  for (const s of samples) expect(parseMathText(s.input)).toMatchObject(s.expect === "accept" ? { ok: true } : { ok: false, code: s.expect.reject });
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/math-text-parse.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `parseMath` and `parseMathText` per the A1 EBNF, one token of lookahead, no backtracking.
- [ ] **Step 4: Run** test, typecheck, lint. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/math-text/parse.ts tests/unit/math-text-parse.test.ts` then `git commit -m "feat(math-text): recursive-descent parser"`.

### Task A5: TeX emission, canonical serializer and round trip

**Files:**
- Create: `src/lib/math-text/to-tex.ts`, `src/lib/math-text/commands.ts`, `tests/fixtures/math-text/gen.ts`
- Modify: `src/lib/latex/escape.ts` (add `escapeTextFragment`; `escapeText` becomes `escapeTextFragment(...)` plus the existing trim, output unchanged)
- Test: `tests/unit/math-text-tex.test.ts`

**Interfaces:**
- Consumes: AST (A1), `parseMath`, `parseMathText` (A4).
- Produces:
  - `commands.ts`: `export const MATH_TEX_COMMANDS: ReadonlySet<string>` = exactly `alpha beta theta pi le ge neq pm times cdot div frac sqrt circ sin cos tan log ln ldots`; `export const MATH_TEX_SYMBOLS: ReadonlySet<string>` = exactly `%`.
  - `to-tex.ts`: `mathToTex(node: MathNode): string` (canonical, per the A1 canonical rules; the ONLY producer of math TeX for model content); `serializeMathText(doc: MathTextDoc): string` (text raw, math as `\(` + `mathToTex` + `\)`); `mathTextToTex(doc: MathTextDoc): string` (text through `escapeTextFragment`, math as `$` + `mathToTex` + `$`; throws `RenderError("text_too_long")` like `escapeText`).
  - `escape.ts`: `escapeTextFragment(input: string): string` (same tables as `escapeText`, collapses runs of spaces, does not trim).
  - `gen.ts`: `export function rng(seed: number): () => number` (mulberry32) and `export function genMathNode(next: () => number, depth?: number): MathNode` generating only parser-producible trees within the limits.

Decision: one function is both the TeX renderer and the canonical math serializer, so the renderer can only emit what the grammar accepts. `group` with `open: "["` closes with `]`.

- [ ] **Step 1: Write the failing tests**

```ts
it("emits the golden canonical form and TeX", () => {
  for (const row of golden.filter((r) => r.ok)) {
    const r = parseMathText(row.in); if (!r.ok) throw new Error(row.in);
    expect(serializeMathText(r.doc)).toBe(row.canonical);
    expect(mathTextToTex(r.doc)).toBe(row.tex);
  }
});
it("round trips: parse(serialize(doc)) equals doc for every accepted fixture", () => {
  for (const input of [...golden.filter((r) => r.ok).map((r) => r.in), ...samples.filter((s) => s.expect === "accept").map((s) => s.input)]) {
    const a = parseMathText(input); if (!a.ok) throw new Error(input);
    expect(parseMathText(serializeMathText(a.doc))).toEqual(a);
  }
});
it("emitted tex re-parses to the same AST (5000 generated trees, seed 20261101)", () => {
  const next = rng(20261101);
  for (let i = 0; i < 5000; i++) {
    const node = genMathNode(next);
    expect(parseMath(mathToTex(node), 0)).toEqual({ ok: true, node });
  }
});
it("emits only allowlisted control words", () => {
  const next = rng(7);
  for (let i = 0; i < 2000; i++) for (const m of mathToTex(genMathNode(next)).matchAll(/\\([A-Za-z]+|.)/g)) {
    expect(/^[A-Za-z]+$/.test(m[1]!) ? MATH_TEX_COMMANDS.has(m[1]!) : MATH_TEX_SYMBOLS.has(m[1]!)).toBe(true);
  }
});
it("escapes text and keeps the spaces around math", () => {
  const r = parseMathText(String.raw`Pay $5 & tax for \(x\) items`); if (!r.ok) throw new Error();
  expect(mathTextToTex(r.doc)).toBe(String.raw`Pay \$5 \& tax for $x$ items`);
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/math-text-tex.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `commands.ts`, `escapeTextFragment`, `to-tex.ts`, `gen.ts`.
- [ ] **Step 4: Run** the test plus `pnpm vitest run tests/unit/render-golden.test.ts tests/unit/latex-render.test.ts`, typecheck, lint. Expected: PASS; golden unchanged.
- [ ] **Step 5: Commit** `git add src/lib/math-text/to-tex.ts src/lib/math-text/commands.ts src/lib/latex/escape.ts tests/fixtures/math-text/gen.ts tests/unit/math-text-tex.test.ts` then `git commit -m "feat(math-text): canonical TeX emission and round trip"`.

### Task A6: One macro allowlist for both rendering paths

**Files:**
- Create: `src/lib/latex/allowlist.ts`
- Modify: `src/lib/latex/templates.ts` (`ALLOWED_BODY_COMMANDS` = existing set ∪ `MATH_TEX_COMMANDS`), `src/lib/latex/render.ts` (`assertTexIsSafe` uses the scanner; behaviour unchanged)
- Test: `tests/unit/math-text-allowlist.test.ts`

**Interfaces:**
- Consumes: `MATH_TEX_COMMANDS`, `MATH_TEX_SYMBOLS` (A5); `equationTex`, `numberTex`, `operationText`, `solutionText` from `src/lib/latex/math.ts`; `splitInlineMath` from `src/lib/ui/math-html.ts`.
- Produces: `firstDisallowedControlSequence(tex: string, commands: ReadonlySet<string>, symbols: ReadonlySet<string>): string | null` (the regex loop now inside `assertTexIsSafe`, moved verbatim; returns the offending name for internal use only, never shown to users).

Decision and rationale: `MATH_TEX_COMMANDS` (A5) is the single source of the math macro vocabulary. The PDF allowlist imports it, so `ALLOWED_BODY_COMMANDS` grows by exactly those macros (spec 5.4). The deterministic path is reconciled by a test, not by changing `renderMathHtml`: every math string the deterministic renderer can produce must pass the same scanner with `MATH_TEX_COMMANDS`. `renderMathHtml` keeps its existing denylist and KaTeX options unchanged, because switching it to the allowlist would make the existing `maxSize` pinning test in `tests/unit/math-html.test.ts` unreachable (that test must not be deleted or weakened) and would change deterministic preview behaviour for no safety gain (that TeX is code-built). MathText-sourced TeX gets the allowlist scan in `check.ts` (A7) before it reaches `renderMathHtml`. Result: both paths emit TeX inside one allowlist, and a new macro needs one edit in `commands.ts` plus a grammar change.

- [ ] **Step 1: Write the failing tests**

```ts
it("the PDF body allowlist contains every MathText macro", () => {
  for (const c of MATH_TEX_COMMANDS) expect(ALLOWED_BODY_COMMANDS.has(c)).toBe(true);
  for (const s of MATH_TEX_SYMBOLS) expect(ALLOWED_CONTROL_SYMBOLS.has(s)).toBe(true);
});
it("every MathText macro is produced by at least one accepted fixture (no dead allowlist entries)", () => {
  const seen = new Set<string>();
  for (const row of golden.filter((r) => r.ok)) for (const m of row.tex.matchAll(/\\([A-Za-z]+)/g)) seen.add(m[1]!);
  expect([...MATH_TEX_COMMANDS].filter((c) => !seen.has(c))).toEqual([]);
});
it("the deterministic renderer's math stays inside the same allowlist", () => {
  for (const { question: q } of renderableQuestions()) {   // tests/fixtures/math/questions.json entries whose rendering does not throw RenderError
    const texts = [equationTex(q.problem.equation), solutionText(q.solution), ...q.steps.flatMap((s) => [operationText(s.op), equationTex(s.result)])];
    for (const part of texts.flatMap((t) => splitInlineMath(t.includes("$") ? t : `$${t}$`)).filter((p) => p.kind === "math")) {
      expect(firstDisallowedControlSequence(part.tex, MATH_TEX_COMMANDS, MATH_TEX_SYMBOLS)).toBeNull();
    }
  }
});
it("assertTexIsSafe still refuses what it refused before", () => {
  expect(firstDisallowedControlSequence(String.raw`\input{x}`, ALLOWED_BODY_COMMANDS, ALLOWED_CONTROL_SYMBOLS)).toBe("input");
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/math-text-allowlist.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `allowlist.ts`, the union in `templates.ts`, and the `assertTexIsSafe` refactor.
- [ ] **Step 4: Run** the test plus `pnpm vitest run tests/unit/render-golden.test.ts tests/unit/latex-render.test.ts tests/unit/math-html.test.ts tests/unit/compile-inputs-golden.test.ts`, typecheck, lint. Expected: PASS, goldens untouched, no `RENDER_VERSION` bump.
- [ ] **Step 5: Commit** `git add src/lib/latex/allowlist.ts src/lib/latex/templates.ts src/lib/latex/render.ts tests/unit/math-text-allowlist.test.ts` then `git commit -m "feat(latex): one macro allowlist shared by MathText and the PDF renderer"`.

### Task A7: HTML parts and the static preview check

**Files:**
- Create: `src/lib/math-text/to-html.ts`, `src/lib/math-text/check.ts`
- Test: `tests/unit/math-text-render.test.ts`

**Interfaces:**
- Consumes: `mathToTex` (A5), `firstDisallowedControlSequence` (A6), `renderMathHtml`, `InlineMathPart` (`src/lib/ui/math-html.ts`), `Inlines` (`src/components/app/math.tsx`, tests only).
- Produces: `mathTextToInlineParts(doc: MathTextDoc): InlineMathPart[]` (text parts carry the raw string for React escaping; math parts carry `mathToTex(node)`); `checkMathTextRenders(doc: MathTextDoc): MathTextErrorCode | null` (for each math part: scanner with `MATH_TEX_COMMANDS`/`MATH_TEX_SYMBOLS` else `render_tex_disallowed`; TeX length over 500 else `render_tex_too_long`; `renderMathHtml(tex, "inline").ok` else `render_katex_rejected`; also `mathTextToTex` must not throw, and its output must pass the scanner with `ALLOWED_BODY_COMMANDS`/`ALLOWED_CONTROL_SYMBOLS`). This is the spec 5.2 "static preview check"; B-c calls it from `admitAiItem`.

- [ ] **Step 1: Write the failing tests**

```ts
it("every emitted tex passes the allowlist and KaTeX (accepted fixtures and 3000 generated docs, seed 42)", () => {
  for (const doc of [...acceptedFixtureDocs(), ...generatedDocs(rng(42), 3000)]) expect(checkMathTextRenders(doc)).toBeNull();
});
it("no HTML injection: rendered markup of every hostile or accepted input has no active content", () => {
  for (const input of [...HOSTILE, ...golden.map((r) => r.in)]) {
    const r = parseMathText(input); if (!r.ok) continue;
    const html = renderToStaticMarkup(createElement(Inlines, { parts: mathTextToInlineParts(r.doc) }));
    expect(html).not.toMatch(/<script|<img|<a |href=|javascript:|\son[a-z]+=/i);
  }
});
it("text containing angle brackets is escaped by React, never parsed as markup", () => {
  const r = parseMathText("if a < b > c"); if (!r.ok) throw new Error();
  expect(renderToStaticMarkup(createElement(Inlines, { parts: mathTextToInlineParts(r.doc) }))).toContain("a &lt; b &gt; c");
});
it("reports render_tex_too_long instead of failing open when TeX exceeds the HTML cap", () => {
  // Hand-built AST: a 300-character span cannot expand past 500 TeX characters (worst case x^2 -> x^{2}), so this guard is defensive.
  const doc: MathTextDoc = { v: MATHTEXT_PARSER_VERSION, parts: [{ t: "math", m: { t: "imp", items: Array.from({ length: 200 }, () => ({ t: "greek", name: "pi" }) as const) } }] };
  expect(checkMathTextRenders(doc)).toBe("render_tex_too_long");
});
```

(`acceptedFixtureDocs` and `generatedDocs` are small helpers in `tests/fixtures/math-text/gen.ts`; `generatedDocs` interleaves random allowed text with `genMathNode` spans.)

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/math-text-render.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `to-html.ts` and `check.ts`. Keep the TeX canonical form compact enough that a 300-character span of ordinary content stays under 500 TeX characters; the over-cap case is a typed reject, never a fallback to raw text.
- [ ] **Step 4: Run** test, typecheck, lint. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/math-text/to-html.ts src/lib/math-text/check.ts tests/fixtures/math-text/gen.ts tests/unit/math-text-render.test.ts` then `git commit -m "feat(math-text): HTML parts and static preview check"`.

### Task A8: Hostile fuzzing, linear-time bound and the public surface

**Files:**
- Create: `src/lib/math-text/index.ts`
- Modify: `tests/fixtures/math-text/gen.ts` (adds `pickAccepted(next): string` over accepted golden and sample inputs, and `mutate(input: string, next): string`: 1 to 5 inserts, deletes or replacements drawn from ASCII plus `\ { } ^ _ $ % # & ~ < >`, U+202E, U+200D, U+FF3C, U+2212)
- Test: `tests/unit/math-text-fuzz.test.ts`

**Interfaces:**
- Produces (`index.ts`, the only import path for B-c and later): `parseMathText`, `serializeMathText`, `mathToTex`, `mathTextToTex`, `mathTextToInlineParts`, `checkMathTextRenders`, `MATHTEXT_PARSER_VERSION`, `MATHTEXT_LIMITS`, `MATH_TEXT_ERROR_CODES`, `MATH_TEX_COMMANDS`, and the types `MathNode`, `MathTextDoc`, `MathTextPart`, `MathTextResult`, `MathTextErrorCode`. `split`, `tokenize` and `parseMath` stay internal.

- [ ] **Step 1: Write the failing tests**

```ts
it("hostile corpus: every input is rejected, or accepted only with TeX that passes the static check", () => {
  for (const input of HOSTILE) {
    const r = parseMathText(input);
    if (r.ok) { expect(checkMathTextRenders(r.doc)).toBeNull(); expect(mathTextToTex(r.doc)).not.toMatch(/\\(input|csname|catcode|def|href|url)\b|\^\^/); }
    else expect(MATH_TEXT_ERROR_CODES).toContain(r.code);
  }
});
it("mutation fuzz: 20000 random edits of accepted fixtures never throw and never emit an unknown control word (seed 9)", () => {
  const next = rng(9);
  for (let i = 0; i < 20_000; i++) {
    const r = parseMathText(mutate(pickAccepted(next), next));
    if (r.ok) expect(checkMathTextRenders(r.doc)).toBeNull();
  }
});
it("bounded work on hostile sizes", () => {
  const started = performance.now();
  for (const input of ["x".repeat(100_000), "\\(".repeat(50_000), `\\(${"(".repeat(1_990)}\\)`, `\\(${"-".repeat(1_990)}x\\)`, "a ".repeat(999)]) parseMathText(input);
  expect(performance.now() - started).toBeLessThan(250);
});
it("exposes exactly the documented public surface", async () => {
  expect(Object.keys(await import("@/lib/math-text")).sort()).toEqual(
    ["MATHTEXT_LIMITS", "MATHTEXT_PARSER_VERSION", "MATH_TEXT_ERROR_CODES", "MATH_TEX_COMMANDS", "checkMathTextRenders", "mathTextToInlineParts", "mathTextToTex", "mathToTex", "parseMathText", "serializeMathText"]);
});
it("imports nothing server-only, React or database-related", () => {
  for (const file of readdirSync("src/lib/math-text")) expect(readFileSync(`src/lib/math-text/${file}`, "utf8")).not.toMatch(/from "(server-only|react|@prisma|@\/lib\/server)/);
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/math-text-fuzz.test.ts`. Expected: FAIL (no `index.ts`).
- [ ] **Step 3: Implement** `index.ts`; fix any defect the fuzz finds in the owning module (with a new golden row for each defect found).
- [ ] **Step 4: Run** `pnpm vitest run tests/unit/math-text-*.test.ts`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`. Expected: all PASS.
- [ ] **Step 5: Commit** `git add src/lib/math-text/index.ts tests/fixtures/math-text/gen.ts tests/unit/math-text-fuzz.test.ts` (plus any fixed module and golden rows by path) then `git commit -m "test(math-text): hostile fuzzing, work bound and public surface"`.

### Task A9: Independent Opus rendering-boundary review (hand-off, no code)

**Files:** none created by the reviewer (read-only `evaluator` agent, `model: opus`). Fixes go back to a Sonnet implementer; a fix of a Critical or Important finding gets a pinning test in the owning task's test file.

- [ ] **Step 1: Dispatch the reviewer** with: the diff `main...feat/slice-b-a-mathtext`; this plan's B-a section; spec section 5.4 and D-96; `docs/mathtext.md`; the files `src/lib/math-text/*`, `src/lib/latex/{allowlist,escape,templates,render}.ts`, `src/lib/ui/math-html.ts`, `src/components/app/math.tsx`; the test files `tests/unit/math-text-*.test.ts`; the fixtures. Do NOT give it the implementer's conclusions or this Review Focus list as answers; give it the checklist below as questions.
- [ ] **Step 2: Reviewer checklist (each answered with evidence: a file and line, or a test it ran):**
  1. Can any byte sequence accepted by `parseMathText` yield TeX containing a control word or symbol outside `MATH_TEX_COMMANDS`/`MATH_TEX_SYMBOLS`, a `%` comment, `^^`, `#`, `$` inside math, an unbalanced brace, or a `\begin`/`\end`?
  2. Can text parts carry `\`, `{`, `}`, controls, bidi or zero-width characters, URLs or emails into TeX or HTML?
  3. Is every accepted string's emitted TeX re-parseable to the same AST (no divergence between parser, serializer and renderer)?
  4. Is recursion depth and total work bounded for any input (stack, time, memory)?
  5. Does the HTML path render only `renderMathHtml` output and React-escaped text; does `checkMathTextRenders` run the allowlist BEFORE KaTeX?
  6. Is the deterministic path unchanged (golden hashes, `RENDER_VERSION`), and do both paths share one macro allowlist?
  7. Are error results codes only (no echo of input)?
  8. Anything in KaTeX 0.19.0 or TeX Live behaviour for the allowed macros (`\sqrt[...]`, `^{\circ}`, `\log_{...}`) that the tests do not cover.
- [ ] **Step 3: Gate.** B-a is done only when the reviewer reports no Critical or Important finding open, after at most 3 evaluator-optimizer cycles; the final validator run (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`) is recorded in the PR description. Not run here: real-model sample trials (see open questions).

---

## Sub-slice B-b: OpenAI adapter

### Task B1: Verify the official OpenAI API and record the contract (no code)

**Files:**
- Modify: `docs/architecture.md` section 8 (add an English subsection "OpenAI adapter contract (verified YYYY-MM-DD)")

The planner could not browse. The implementer MUST check the current official OpenAI documentation with WebFetch/WebSearch (platform.openai.com / developers.openai.com API reference and the structured-outputs guide only; no third-party blogs) and fill this table with the exact names, a source link per row and the date. The plan's tentative target is the **Responses API**; every tentative value below is UNVERIFIED.

| Item | Tentative (UNVERIFIED) | Verified value + source link |
|---|---|---|
| Endpoint | `POST {base}/v1/responses`, base `https://api.openai.com` | |
| Auth header | `Authorization: Bearer <key>` | |
| System text / input | `instructions` (string), `input` (user message with the JSON input as one text item) | |
| Structured output | `text.format = { type: "json_schema", name, schema, strict: true }`; strict-mode schema rules (every object `additionalProperties: false`, every property listed in `required`, supported keywords, `name` pattern and length) | |
| Output limit | `max_output_tokens` (does it include reasoning tokens?) | |
| Data retention | `store: false` accepted and honoured | |
| Success shape | `status: "completed"`, `output[]` item `type: "message"` with content `type: "output_text"`, `text` | |
| Refusal shape | content item `type: "refusal"`, field `refusal` | |
| Truncation shape | `status: "incomplete"`, `incomplete_details.reason` in `max_output_tokens` / `content_filter` | |
| Usage | `usage.input_tokens`, `usage.output_tokens` (incl. reasoning?), cached-token detail field | |
| Request id | response header `x-request-id` | |
| Errors | body `{ error: { type, code, message } }`; 429 `code: "rate_limit_exceeded"` vs `"insufficient_quota"`; 401, 403, 404 (model), 400 (`context_length_exceeded`), 500, 503 | |
| Retry hints | `retry-after`, `retry-after-ms`, `x-ratelimit-reset-*` headers on 429 | |
| Unsupported params for some models | e.g. `temperature` on reasoning models (the adapter sends none) | |

- [ ] **Step 1: Fill the table** in `docs/architecture.md` with links and today's date. Never write a model id or a price.
- [ ] **Step 2: Gate.** If any verified value contradicts the tentative column in a way that changes an interface in Tasks B2 to B5 (for example Chat Completions is recommended over Responses for strict JSON schema, or refusals arrive differently), STOP and report to the controller with the table; do not adapt the plan silently. Name-only differences (a header or field spelled differently) are applied directly in B3 to B5 and noted in the commit message.
- [ ] **Step 3: Commit** `git add docs/architecture.md` then `git commit -m "docs(llm): record the verified OpenAI Responses API contract"`.

### Task B2: Backward-compatible interface additions and HTTP helpers

**Files:**
- Modify: `src/lib/llm/types.ts`, `src/lib/ui/messages.ts`
- Create: `src/lib/llm/http.ts`
- Test: `tests/unit/llm-http.test.ts`, `tests/unit/llm-providers.test.ts` (extend)

**Interfaces:**
- Produces (types.ts): `LlmErrorType` gains `"quota_exhausted"` (provider-side spend or quota limit reached; never retryable); the failure `error` object gains `retryAfterMs?: number`. `isRetryableLlmError` is unchanged in behaviour (quota is not in its list). Anthropic and fake compile unchanged.
- Produces (messages.ts): `FAILURE_REASONS.llm_quota_exhausted = "The writing service is temporarily unavailable."` (never blames the user, names no provider).
- Produces (http.ts): `readTextCapped(response: Response, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; reason: "too_large" | "read_failed" }>` (streams `response.body`, cancels the reader past the cap); `parseRetryAfterMs(headers: Headers, now: number, capMs?: number): number | undefined` (prefers `retry-after-ms`, then `retry-after` as seconds or HTTP date; non-negative; capped at `capMs`, default 60_000; garbage gives `undefined`; header names finalized from Task B1).

- [ ] **Step 1: Write the failing tests**

```ts
it("quota exhaustion is a known, non-retryable error type", () => {
  expect(isRetryableLlmError("quota_exhausted")).toBe(false);
});
it("reads a body up to the cap and refuses one past it without buffering it all", async () => {
  expect(await readTextCapped(new Response("abc"), 3)).toEqual({ ok: true, text: "abc" });
  expect(await readTextCapped(new Response("x".repeat(2_000_000)), 1_048_576)).toEqual({ ok: false, reason: "too_large" });
});
it.each([
  [{ "retry-after-ms": "1500" }, 1500], [{ "retry-after": "2" }, 2000], [{ "retry-after": "Sun, 01 Nov 2026 00:00:05 GMT" }, 5000],
  [{ "retry-after": "999999" }, 60_000], [{ "retry-after": "soon" }, undefined], [{}, undefined],
])("parses retry hints %j", (h, ms) => expect(parseRetryAfterMs(new Headers(h), Date.UTC(2026, 10, 1), 60_000)).toBe(ms));
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/llm-http.test.ts tests/unit/llm-providers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the additions.
- [ ] **Step 4: Run** the tests, `pnpm vitest run tests/unit/prose.test.ts tests/unit/prose-cancel.test.ts`, typecheck, lint. Expected: PASS (existing consumers `prose-generate.ts` and `worker/pipeline.ts` map `llm_${type}` and need no change).
- [ ] **Step 5: Commit** `git add src/lib/llm/types.ts src/lib/llm/http.ts src/lib/ui/messages.ts tests/unit/llm-http.test.ts tests/unit/llm-providers.test.ts` then `git commit -m "feat(llm): quota error type, retry hints and capped body reads"`.

### Task B3: OpenAI adapter, request side and success path

**Files:**
- Create: `src/lib/llm/openai.ts`
- Test: `tests/unit/llm-openai.test.ts` (mirror the helpers `mockFetch`, `json`, `request()` of `tests/unit/llm-providers.test.ts`)

**Interfaces:**
- Consumes: `StructuredRequest`, `StructuredResult`, `Usage`, `LlmProvider` (types.ts); `readTextCapped`, `parseRetryAfterMs` (B2); `costMicros`, `usageCeiling` from `src/lib/llm/anthropic.ts` (reuse; they take only prices, so no Anthropic detail leaks).
- Produces:

```ts
export interface OpenAiConfig {
  apiKey: string; model: string; priceInputMicrosPerMTok: number; priceOutputMicrosPerMTok: number;
  baseUrl?: string; fetch?: typeof fetch; now?: () => number;
}
export const OPENAI_LIMITS = { maxRequestBytes: 262_144, maxResponseBytes: 1_048_576 } as const;
export function strictSchemaProblems(schema: Record<string, unknown>): string[]; // rule codes, empty when strict-compatible
export class OpenAiProvider implements LlmProvider { readonly id = "openai"; constructor(config: OpenAiConfig); generateStructured(request: StructuredRequest): Promise<StructuredResult>; }
```

Decisions: the API key lives in a true private field (`#apiKey`), never on `this.config`. The JSON schema `name` is `request.task`. `store: false` is always sent (CLAUDE.md section 9 minimum retention; subject to B1). No `temperature`. The input travels as one JSON document in the user message, never in `instructions`. A request body over `maxRequestBytes`, or a `responseSchema` with `strictSchemaProblems` non-empty, returns `{ ok: false, error: { type: "bad_request", retryable: false } }` with NO usage and makes no fetch call (provably not sent; B-d relies on this to release a reservation).

- [ ] **Step 1: Write the failing tests**

```ts
it("posts to the Responses endpoint with bearer auth, strict schema, store false and the input as data", async () => {
  const { fetchImpl, calls } = mockFetch(() => json(responseOk(), 200, { "x-request-id": "req_abc" }));
  await provider(fetchImpl).generateStructured(request());
  expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
  expect(calls[0]!.init.headers).toEqual({ "content-type": "application/json", authorization: `Bearer ${SECRET}` });
  expect(calls[0]!.body).toEqual({
    model: "test-model-1", instructions: "You write notes.", store: false, max_output_tokens: 1_000,
    input: [{ role: "user", content: [{ type: "input_text", text: JSON.stringify(request().input) }] }],
    text: { format: { type: "json_schema", name: "section_prose", schema: request().responseSchema, strict: true } },
  });
});
it("returns the parsed value, model, usage, cost (rounded up) and request id", async () => {
  const { fetchImpl } = mockFetch(() => json(responseOk({ usage: { input_tokens: 1_000, output_tokens: 200 } }), 200, { "x-request-id": "req_abc" }));
  expect(await provider(fetchImpl).generateStructured(request())).toEqual({ ok: true, value: { a: "hello" }, resultSchemaVersion: 1,
    provider: "openai", model: "test-model-1", usage: { inputTokens: 1_000, outputTokens: 200, costMicros: 6_000 }, providerRequestId: "req_abc" });
});
it("refuses locally, without a network call or usage, an oversized request or a schema strict mode would reject", async () => {
  const { fetchImpl, calls } = mockFetch(() => json(responseOk()));
  expect(await provider(fetchImpl).generateStructured(request({ input: "x".repeat(300_000) }))).toEqual({ ok: false, error: { type: "bad_request", retryable: false } });
  expect(await provider(fetchImpl).generateStructured(request({ responseSchema: { type: "object", properties: { a: { type: "string" } } } }))).toEqual({ ok: false, error: { type: "bad_request", retryable: false } });
  expect(calls).toHaveLength(0);
});
it("accepts the existing prose schema as strict-compatible", () => expect(strictSchemaProblems(PROSE_RESPONSE_SCHEMA)).toEqual([]));
it("drops a provider request id that is not a short token", async () => {
  const { fetchImpl } = mockFetch(() => json(responseOk(), 200, { "x-request-id": "<script>".repeat(40) }));
  expect(await provider(fetchImpl).generateStructured(request())).not.toHaveProperty("providerRequestId");
});
```

(Prices in the test helper: input 3_000_000 and output 15_000_000 micro-units per MTok, clearly labelled test values.)

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/llm-openai.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the constructor, request building, local refusals, the fetch with `AbortSignal.any([request.signal, AbortSignal.timeout(request.limits.timeoutMs)])`, `readTextCapped`, and the completed-status success path. Header comment cites the Task B1 record (link and date) like `anthropic.ts` does.
- [ ] **Step 4: Run** test, typecheck, lint. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/llm/openai.ts tests/unit/llm-openai.test.ts` then `git commit -m "feat(llm): OpenAI adapter request and success path"`.

### Task B4: OpenAI response failure modes and usage accounting

**Files:**
- Modify: `src/lib/llm/openai.ts`
- Test: `tests/unit/llm-openai.test.ts`

**Interfaces:**
- Consumes/produces: unchanged from B3. Usage rule (mirrors Anthropic, D-98 "never zero"): if both `input_tokens` and `output_tokens` are numbers, usage is actual (cost at the full input price even for cached tokens: an over-estimate, never an under-estimate); otherwise any result carries `usageCeiling(requestBody, maxOutputTokens, prices)` and `usageEstimated: true`, and an otherwise successful answer without usage is returned as `invalid_output`.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  ["refusal content", responseOk({ output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }), { type: "refused", retryable: false }],
  ["max_output_tokens", responseOk({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }), { type: "invalid_output", retryable: false, truncated: true }],
  ["content_filter", responseOk({ status: "incomplete", incomplete_details: { reason: "content_filter" } }), { type: "refused", retryable: false }],
  ["text that is not JSON", responseOk({ output: [{ type: "message", content: [{ type: "output_text", text: "{oops" }] }] }), { type: "invalid_output", retryable: false }],
  ["no output text", responseOk({ output: [] }), { type: "invalid_output", retryable: false }],
  ["status failed", responseOk({ status: "failed" }), { type: "server_error", retryable: true }],
])("a 200 with %s is a failure carrying the actual usage", async (_n, body, error) => {
  const { fetchImpl } = mockFetch(() => json(body));
  expect(await provider(fetchImpl).generateStructured(request())).toMatchObject({ ok: false, error, usage: { inputTokens: 1_000, outputTokens: 200 } });
});
it("never reports zero spend: missing or partial usage gives the conservative ceiling", async () => {
  for (const usage of [undefined, { input_tokens: 10 }, { output_tokens: 10 }, { input_tokens: "10", output_tokens: 1 }]) {
    const { fetchImpl } = mockFetch(() => json(responseOk({ usage })));
    const r = await provider(fetchImpl).generateStructured(request());
    expect(r).toMatchObject({ ok: false, error: { type: "invalid_output" }, usageEstimated: true });
    expect(!r.ok && r.usage!.outputTokens).toBe(1_000);
    expect(!r.ok && r.usage!.costMicros).toBeGreaterThan(0);
  }
});
it("a body that is not JSON or exceeds the response cap fails with the ceiling", async () => {
  for (const res of [new Response("<html>"), new Response("x".repeat(1_100_000))]) {
    const { fetchImpl } = mockFetch(() => res);
    expect(await provider(fetchImpl).generateStructured(request())).toMatchObject({ ok: false, error: { type: "invalid_output" }, usageEstimated: true });
  }
});
it("finds the output text by type, not by position (reasoning items first)", async () => {
  const { fetchImpl } = mockFetch(() => json(responseOk({ output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text: '{"a":"hello"}' }] }] })));
  expect(await provider(fetchImpl).generateStructured(request())).toMatchObject({ ok: true, value: { a: "hello" } });
});
```

(Exact field names follow the Task B1 record.)

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/llm-openai.test.ts`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** the response classification.
- [ ] **Step 4: Run** test, typecheck, lint. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/llm/openai.ts tests/unit/llm-openai.test.ts` then `git commit -m "feat(llm): OpenAI refusal, truncation and usage accounting"`.

### Task B5: HTTP error classification, timeouts and secret hygiene

**Files:**
- Modify: `src/lib/llm/openai.ts`
- Test: `tests/unit/llm-openai.test.ts`, `tests/unit/llm-providers.test.ts` (add `OpenAiProvider` to the "same contract for every provider" suite)

**Interfaces:**
- Produces: `classifyOpenAiError(status: number, errorCode: string | undefined): LlmErrorType`: 401/403 `auth`; 429 with code `insufficient_quota` (name from B1) `quota_exhausted`, other 429 `rate_limited`; 503 `overloaded`; 504 `timeout`; other 5xx `server_error`; 404 and other 4xx `bad_request`. Every HTTP error result carries the usage ceiling with `usageEstimated: true` (a call that reached the server may be billed), and `retryAfterMs` only for `rate_limited`/`overloaded`. The error body is read capped and used only for `error.code`; its message is never copied anywhere.

- [ ] **Step 1: Write the failing tests**

```ts
it.each([
  [401, undefined, "auth", false], [403, undefined, "auth", false], [404, "model_not_found", "bad_request", false],
  [400, "context_length_exceeded", "bad_request", false], [429, "rate_limit_exceeded", "rate_limited", true],
  [429, "insufficient_quota", "quota_exhausted", false], [500, undefined, "server_error", true], [502, undefined, "server_error", true],
  [503, undefined, "overloaded", true], [504, undefined, "timeout", true],
])("HTTP %i (%s) -> %s, retryable %s", async (status, code, type, retryable) => {
  const { fetchImpl } = mockFetch(() => json({ error: { type: "x", code, message: `Incorrect API key provided: ${SECRET}` } }, status, { "retry-after": "3" }));
  const r = await provider(fetchImpl).generateStructured(request());
  expect(r).toMatchObject({ ok: false, error: { type, retryable }, usageEstimated: true });
  expect(JSON.stringify(r)).not.toContain(SECRET);
  expect(JSON.stringify(r)).not.toContain("Incorrect API key");
});
it("quota exhaustion is not retried and carries no retry hint; a rate limit carries the hint", async () => {
  const quota = await provider(mockFetch(() => json({ error: { code: "insufficient_quota" } }, 429, { "retry-after": "3" })).fetchImpl).generateStructured(request());
  expect(quota).toMatchObject({ ok: false, error: { type: "quota_exhausted", retryable: false } });
  expect(!quota.ok && quota.error.retryAfterMs).toBeUndefined();
  const limited = await provider(mockFetch(() => json({ error: { code: "rate_limit_exceeded" } }, 429, { "retry-after": "3" })).fetchImpl).generateStructured(request());
  expect(!limited.ok && limited.error.retryAfterMs).toBe(3_000);
});
it("times out with a ceiling, treats a network failure as retryable without leaking its message, and rethrows a caller cancel", async () => {
  // mirror the three Anthropic tests: hanging fetch + timeoutMs 20 -> timeout; fetch rejects with Error(SECRET) -> server_error, no SECRET in result; caller AbortController -> rejects
});
it("never logs and never exposes the key", async () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
  const p = provider(mockFetch(() => json({}, 500)).fetchImpl);
  await p.generateStructured(request());
  expect(JSON.stringify(p)).not.toContain(SECRET);
  expect(inspect(p, { depth: 5 })).not.toContain(SECRET);
  expect(() => new OpenAiProvider({ ...cfg, apiKey: "" })).toThrow(/API key is required/);
  for (const s of spies) expect(s).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/llm-openai.test.ts tests/unit/llm-providers.test.ts`. Expected: FAIL on the new cases.
- [ ] **Step 3: Implement** `classifyOpenAiError`, the error path, the timeout and cancel handling (as in `anthropic.ts`), and add `OpenAiProvider` to the shared contract suite.
- [ ] **Step 4: Run** tests, typecheck, lint. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/llm/openai.ts tests/unit/llm-openai.test.ts tests/unit/llm-providers.test.ts` then `git commit -m "feat(llm): OpenAI error classification, timeouts and secret hygiene"`.

### Task B6: Configuration, factory registration and documentation

**Files:**
- Modify: `worker/env.ts`, `src/lib/llm/factory.ts`, `scripts/eval-prose.ts` (provider enum only), `.env.example`, `README.md` (env table row), `docs/architecture.md` (section 8 one line), `docs/fresh-droplet-setup.md` (line 17 "The OpenAI adapter does not exist yet" and the LLM step), `tests/unit/llm-providers.test.ts`

**Interfaces:**
- Produces: `LlmSettings.LLM_PROVIDER: "fake" | "anthropic" | "openai"`; `createLlmProvider` builds `OpenAiProvider` from the same `LLM_API_KEY`, `LLM_MODEL`, both `LLM_PRICE_*` and optional `LLM_BASE_URL`, throwing `the openai provider needs an API key, a model and both prices` when under-configured. `worker/env.ts`: enum gains `"openai"`; the completeness refinement applies to both real providers with message `LLM_PROVIDER=<value> also needs: ...`. No new variable, no default for model or prices, timeouts stay per call (B-e adds item-call timeout settings).

- [ ] **Step 1: Write the failing tests** (in the existing "provider configuration" block; the existing assertion that `LLM_PROVIDER: "openai"` is rejected is replaced by `"gemini"`, because openai is now valid: this is a corrected expectation, not a weakened one)

```ts
it("refuses openai without a key, a model and both prices (nothing is guessed)", () => {
  expect(() => workerEnv({ ...base, LLM_PROVIDER: "openai" })).toThrow(/LLM_PROVIDER=openai also needs: LLM_API_KEY, LLM_MODEL, LLM_PRICE_INPUT_MICROS_PER_MTOK, LLM_PRICE_OUTPUT_MICROS_PER_MTOK/);
});
it("builds the openai provider from a complete configuration", () => {
  const config = workerEnv({ ...base, LLM_PROVIDER: "openai", LLM_API_KEY: "k", LLM_MODEL: "m", LLM_PRICE_INPUT_MICROS_PER_MTOK: "1", LLM_PRICE_OUTPUT_MICROS_PER_MTOK: "2" });
  expect(createLlmProvider(config).id).toBe("openai");
});
it("rejects an unknown provider", () => expect(() => workerEnv({ ...base, LLM_PROVIDER: "gemini" })).toThrow());
it("ships no model id or price defaults", () => {
  for (const f of ["src/lib/llm/openai.ts", "src/lib/llm/factory.ts", "worker/env.ts", ".env.example"]) expect(readFileSync(f, "utf8")).not.toMatch(/gpt-|LLM_MODEL="[^"]|PRICE_[A-Z_]+="[1-9]/);
});
```

- [ ] **Step 2: Run** `pnpm vitest run tests/unit/llm-providers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the enum, refinement and factory branch; update `scripts/eval-prose.ts`'s `Env` enum to include `openai`.
- [ ] **Step 4: Docs** (technical wording, English, no project marketing): `.env.example` lists `fake | anthropic | openai` with empty placeholders and "set from the provider's current list / price list"; README env table row for `LLM_PROVIDER`; `docs/architecture.md` section 8 notes the adapter and links the B1 record; `docs/fresh-droplet-setup.md` says the adapter exists, stays `fake` until the owner's key, the OpenAI project hard limit (at most USD 100) and the privacy notice (D-43, D-78, D-117(d)) are in place.
- [ ] **Step 5: Run** `pnpm vitest run tests/unit/llm-providers.test.ts tests/unit/lint-boundaries.test.ts tests/unit/host-config.test.ts`, `pnpm typecheck`, `pnpm lint`, `pnpm build`. Expected: PASS.
- [ ] **Step 6: Commit** `git add worker/env.ts src/lib/llm/factory.ts scripts/eval-prose.ts .env.example README.md docs/architecture.md docs/fresh-droplet-setup.md tests/unit/llm-providers.test.ts` then `git commit -m "feat(llm): register the OpenAI provider in configuration; docs"`.

### Task B7 (optional, owner-gated): Manual smoke script

**Files:**
- Create: `scripts/smoke-llm.ts`; Modify: `package.json` (script `smoke:llm`: `tsx --env-file-if-exists=.env scripts/smoke-llm.ts`)

Runs only when the owner provides a key on their machine. It parses settings with `workerEnv`-equivalent zod (scripts may read `process.env`), refuses to run without `--confirm-cost` when the provider is not `fake`, sends ONE request with a tiny fictional schema (`{ "a": string }`, required, `additionalProperties: false`) and `maxOutputTokens` 200, and prints only: provider, model, ok or error type, usage, `usageEstimated`, latency. It never prints the key, the prompt or the answer body.

- [ ] **Step 1: Verify it is unreachable from CI**: `grep -rn "smoke:llm\|smoke-llm" .github/ vitest*.mts playwright*.ts` returns nothing; `pnpm smoke:llm` with `LLM_PROVIDER=fake` prints an ok line and makes no network call.
- [ ] **Step 2: Run** `pnpm typecheck && pnpm lint`. Expected: clean.
- [ ] **Step 3: Commit** `git add scripts/smoke-llm.ts package.json` then `git commit -m "chore(llm): optional manual provider smoke script (never in CI)"`.

### Task B8: Independent Opus provider-boundary review (hand-off, no code)

- [ ] **Step 1: Dispatch** a read-only `evaluator` with `model: opus`, giving: the diff `main...feat/slice-b-b-openai`; the Task B1 record; spec sections 5.5 (estimate and settle rules), 5.6 and 10; CLAUDE.md sections 7 and 9; `src/lib/llm/*`, `worker/env.ts`, the tests. Checklist: (1) can the key reach a result, error, log, `inspect` output, request body or URL; (2) is every non-retryable condition (auth, quota, bad request, refusal, truncation) classified non-retryable; (3) can any path report usage lower than what may have been billed (missing usage, HTTP error after the server saw the request, timeout, oversized body); (4) does a local refusal truly send nothing; (5) are request and response sizes bounded before buffering; (6) does the adapter follow the verified B1 contract exactly, including `store: false` and strict mode; (7) are the Anthropic adapter and the fake unchanged in behaviour. Spec 9 also reviews B-b again with B-e (integration).
- [ ] **Step 2: Gate.** Done when no Critical or Important finding is open after at most 3 cycles and the final `pnpm typecheck && pnpm lint && pnpm test && pnpm build` run is recorded.

---

## Self-review notes

- Spec coverage: 5.4 string form, text rules, math subset and limits (A1 to A4); parser version and codes (A1, A4); `toTex` with fixed macros, `ALLOWED_BODY_COMMANDS` growth, HTML via `renderMathHtml`, canonical serializer and round trip (A5 to A7); golden tables, property tests, hostile corpus incl. `\input \csname \catcode ^^5c \def`, unbalanced braces, deep nesting, 100k strings, `\href{javascript:}`, HTML, confusables, bidi, NUL, linear-time bound (A1, A2, A7, A8); "one-page grammar spec and about 20 sample items" (A1; the real-model trial is an open question); independent Opus review (A9). Section 9 B-b items: adapter, provider enum, factory, injected-fetch contract tests, error classification, official rules first (B1 to B6, B8); D-40 no defaults (B6 test); section 10 staging variable names reused, no new ones in B-b.
- Out of scope by design (later sub-slices): `admitAiItem`, `ai-items/1`, `lesson-package/2`, the cross-check and items prompts, the spend ledger, worker wiring and item-call timeouts.
- Type names are consistent across tasks: `MathNode`, `MathTextDoc`, `MathTextResult`, `MathTextErrorCode`, `MATH_TEX_COMMANDS`, `firstDisallowedControlSequence`, `checkMathTextRenders`, `OpenAiProvider`, `classifyOpenAiError`, `strictSchemaProblems`, `readTextCapped`, `parseRetryAfterMs`.

## Open questions for the owner

1. Spec 5.4 asks for the ~20 sample items to be "tried on candidate models". That needs a key and costs money, so B-a ships hand-written fixtures only; the real trial runs with Task B7 (or in B-g's benchmark) once the key and the OpenAI project limit exist. Is it acceptable to start B-c before that trial?
2. Unicode math symbols (`−`, `×`, `≤`, `²`) are rejected rather than normalized to MathText in slice B (safer, may lower parse rate). The decision is the builder's; tell us if you want normalization instead before B-c's prompt is written.
