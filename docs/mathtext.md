# MathText grammar (`mathtext/1`)

MathText is the only way model-written math reaches a document. Our own hand-written parser turns a string into one typed AST (`src/lib/math-text/ast.ts`); the PDF (TeX) and the preview (HTML) are both rendered from that AST. Errors are codes, never text. Fixtures: `tests/fixtures/math-text/`.

## String form

Plain text with inline math in `\( ... \)`. A bare `$` is text. No display math in slice B: `\[ \]` is rejected, and `$$` is just text. Input is at most 2000 characters and has at least one non-space character after normalization.

## Text rules

- Normalization first: Unicode NFC; CR, LF, TAB and U+00A0 become a space; then runs of spaces collapse to one and the document is trimmed. The 2000-character limit is measured after NFC and this whitespace mapping, before collapsing and trimming.
- Checks run in this order: length, empty, control and bidi characters (the whole string, including inside spans), backslash and span splitting, URLs and e-mail in text, the text character allowlist; inside a span: unknown commands and bad characters (tokenizer), then structure (parser). So an unknown command is `math_unknown_command` even if the span is also unbalanced.
- Allowed in text, operationally: `A-Z a-z`; Latin-1 Supplement letters U+00C0-U+00D6, U+00D8-U+00F6, U+00F8-U+00FF; Latin Extended-A U+0100-U+017F except the nine letters the pinned fonts cannot print (U+0126, U+0127, U+0138, U+013F, U+0140, U+0149, U+0166, U+0167, U+017F; see `UNPRINTABLE_LETTERS` in `src/lib/latex/escape.ts`); digits `0-9`; space; and the punctuation `. , ; : ! ? ' " ’ - – — ( ) [ ] / % $ & + =`. Nothing else: fullwidth forms, ligatures (U+FB00-U+FB06), `ª`, `º`, `×`, `÷`, Cyrillic, U+2212, `< > * # ~ @ { } | ^ _` are `text_bad_char`. Comparisons belong in math spans. Inside a span the tokenizer rejects any character outside the math character set, including lone surrogates, U+2028/U+2029 and a trailing backslash, with `math_bad_char`.
- C0/C1 controls (NUL, U+0085, ...) are `text_control_char`. Bidi controls and invisible characters (U+200B-U+200F, U+202A-U+202E, U+2060, U+2066-U+2069, U+FEFF) are `text_bidi_char`.
- A backslash in text (anything outside a matched `\(` `\)`, including `\[`, `\%`, a doubled `\\(`, and a trailing lone `\`) is `text_backslash`; scanning is left to right and a backslash not followed by `(` or `)` is an error at once. A `\)` with no open span is `delim_unexpected_close`; a `\(` inside a span is `delim_nested`. URLs (`scheme://`, `www.`) are `text_url`; `x@y` is `text_email`. Links are never emitted; URL- and e-mail-like text is rejected only by these documented checks.
- Output: HTML text is escaped by React; TeX text goes through the escape helper (`$ & %` become `\$ \& \%`). Renderers must not emit two adjacent math spans as `$$` (display math in TeX).

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
                                               -- at most one "^" and one "_" per base, either order
script   := digit | letter | "{" math "}"
primary  := number | letter | greek | "\ldots" | "(" math ")" | "[" math "]" | "|" expr "|"   -- no "|" directly inside or beside a bar
          | "\frac" "{" math "}" "{" math "}" | "\sqrt" ("[" math "]")? "{" math "}"
          | fn ( "_" script )? postfix          -- "_" only after \log
number   := "0" | [1-9][0-9]{0,11}  ("." [0-9]{1,6})?
```

Greek: `\alpha \beta \theta \pi`. Functions: `\sin \cos \tan \log \ln`. Letters are single ASCII letters. A comma directly between a digit and exactly three digits (`1,500`) is `math_digit_grouping`; write lists as `1, 500`.

## Limits

- 2000 characters per string (after NFC and whitespace mapping, see above); 20 spans per string.
- 300 characters per span, counting the characters between `\(` and `\)` (delimiters excluded).
- Integers up to 12 digits; decimals up to 6 fraction digits.
- Depth 8: the number of nested open constructs, where each of `( )`, `[ ]`, `| |`, a `{ }` argument of `\frac`, `\sqrt` or a script, and each prefix sign (`-`, `+`, `\pm`) counts one level; flat operator chains (`a+b+c+...`) do not. The outermost construct is level 1, so eight nested parentheses are accepted and nine are `math_depth`. Depth is checked on entering a construct, which bounds recursion.
- Exponent nesting 3, counted as nested `sup` nodes: a chain of 3 is accepted, a chain of 4 is `math_exponent_depth`.
- Absolute value: `|x|`, `|x+1|` and `2|x|` are accepted; a bar directly at the start of a bar body or directly after a closing bar (`||x||`, `|a||b|`) is `math_unexpected_token`. Nested absolute values are not supported.
- Scripts: a base takes at most one `^` and one `_`, in either order; a second of the same kind (`x^2^3`, `x_1_2`, `30^\circ^2`) is `math_bad_script`. Both `x^2_3` and `x_1^2` parse to `sup(sub(base, s), e)`.

## Canonical form

One rule set, used by `mathToTex` (Task A5): no whitespace except one space after a control word when the next character is an ASCII letter, one space after a function name unless `_` follows it (`\sin 30`, `\log_{2}8`), and one space after every list comma (so `\(1, 500\)` never re-serializes as the rejected `1,500`); scripts always braced (`x^{2}`, `a_{n}`, `30^{\circ}`), subscript before superscript (`x_{3}^{2}`); `\sqrt[n]{b}`; `\frac{a}{b}`; text parts have whitespace runs collapsed to one space and the document trimmed. The canonical string re-parses to the same AST.

## Error codes

| Code | Example input |
|---|---|
| `empty` | `   ` |
| `too_long` | 2001 characters |
| `text_bad_char` | `5 − 3` (U+2212), `a < b` |
| `text_control_char` | `a<NUL>b` |
| `text_bidi_char` | `a<U+202E>b` |
| `text_backslash` | `Sum \[1+2\]`, `x\` |
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
| `math_unexpected_token` | `\(2 +\)`, `\(||x||\)` |
| `math_brace_misuse` | `\(\frac{1\)` |
| `math_bad_script` | `\(x^+\)`, `\(x^2^3\)` |
| `math_depth` | 10 nested parentheses |
| `math_exponent_depth` | `\(2^{3^{4^{5^{6}}}}\)` |
| `render_tex_disallowed`, `render_tex_too_long`, `render_katex_rejected` | render-time checks (Tasks A7, A8), not parse errors |

## Change policy

The grammar grows only by deliberate change: edit this page, bump `MATHTEXT_PARSER_VERSION`, and extend the fixtures.
