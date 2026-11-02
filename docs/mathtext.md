# MathText grammar (`mathtext/1`)

MathText is the only way model-written math reaches a document. Our own hand-written parser turns a string into one typed AST (`src/lib/math-text/ast.ts`); the PDF (TeX) and the preview (HTML) are both rendered from that AST. Errors are codes, never text. Fixtures: `tests/fixtures/math-text/`.

## String form

Plain text with inline math in `\( ... \)`. A bare `$` is text. No display math (`\[ \]`, `$$`) in slice B. Input is at most 2000 characters and has at least one non-space character after normalization.

## Text rules

- Normalization first: Unicode NFC; CR, LF, TAB and U+00A0 become a space; runs of spaces collapse to one; the document is trimmed.
- Allowed in text: Latin letters (NFC), ASCII digits, space, and `. , ; : ! ? ' " ’ - – — ( ) [ ] / % $ & + = < > * #`. Everything else is `text_bad_char` (U+2212, `×`, `≤`, Cyrillic, `~`, `{ } | ^ _`).
- C0/C1 controls (NUL, ...) are `text_control_char`. Bidi controls and invisible characters (U+200B-U+200F, U+202A-U+202E, U+2060, U+2066-U+2069, U+FEFF) are `text_bidi_char`.
- A backslash in text (anything outside a matched `\(` `\)`, including `\[` and `\%`) is `text_backslash`. URLs (`scheme://`, `www.`) are `text_url`; `x@y` is `text_email`. These two are checked before the character allowlist.

## Grammar

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

Greek: `\alpha \beta \theta \pi`. Functions: `\sin \cos \tan \log \ln`. Letters are single ASCII letters. A comma directly between a digit and exactly three digits (`1,500`) is `math_digit_grouping`; write lists as `1, 500`.

## Limits

Span at most 300 characters; nesting depth 8; exponent nesting 3 (counted as nested `sup` nodes: a chain of 4 is `math_exponent_depth`); 20 spans per string; integers up to 12 digits and decimals up to 6 fraction digits. Parsing is linear and non-recursive past the depth limit.

## Canonical form

One rule set, used by `mathToTex` (Task A5): no whitespace except one space after a control word when the next character is an ASCII letter, one space after a function name unless `_` follows it (`\sin 30`, `\log_{2}8`), and one space after every list comma (so `\(1, 500\)` never re-serializes as the rejected `1,500`); scripts always braced (`x^{2}`, `a_{n}`, `30^{\circ}`); `\sqrt[n]{b}`; `\frac{a}{b}`; text parts have whitespace runs collapsed to one space and the document trimmed. The canonical string re-parses to the same AST.

## Error codes

| Code | Example input |
|---|---|
| `empty` | `   ` |
| `too_long` | 2001 characters |
| `text_bad_char` | `5 − 3` (U+2212) |
| `text_control_char` | `a<NUL>b` |
| `text_bidi_char` | `a<U+202E>b` |
| `text_backslash` | `Sum \[1+2\]` |
| `text_url` | `see https://evil.test` |
| `text_email` | `mail me at a@b.co` |
| `delim_unterminated` | `\(x\) and \(` |
| `delim_unexpected_close` | `x\)` |
| `delim_nested` | `\(a \( b \) c\)` |
| `too_many_spans` | 21 spans |
| `span_too_long` | a span over 300 characters |
| `span_empty` | `\(\)` |
| `math_bad_char` | `\(x!\)` |
| `math_unknown_command` | `\(\text{hi}\)` |
| `math_number_too_long` | `\(1234567890123\)` |
| `math_leading_zero` | `\(007\)` |
| `math_digit_grouping` | `\(1,500\)` |
| `math_adjacent_numbers` | `\(2 3\)` |
| `math_unbalanced` | `\((x\)` |
| `math_unexpected_token` | `\(2 +\)` |
| `math_brace_misuse` | `\(\frac{1\)` |
| `math_bad_script` | `\(x^+\)` |
| `math_depth` | 9 nested parentheses |
| `math_exponent_depth` | `\(2^{3^{4^{5^{6}}}}\)` |
| `render_tex_disallowed`, `render_tex_too_long`, `render_katex_rejected` | render-time checks (Tasks A7, A8), not parse errors |

## Change policy

The grammar grows only by deliberate change: edit this page, bump `MATHTEXT_PARSER_VERSION`, and extend the fixtures.
