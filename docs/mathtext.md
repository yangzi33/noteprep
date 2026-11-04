Paperclip: GitHub capability_missing; continuing without managed credentials.
# MathText grammar (`mathtext/2`)

MathText is intended to be the only way model-written math reaches a document. Our own hand-written parser turns a string into one typed AST (`src/lib/math-text/ast.ts`); the PDF (TeX) and the preview (HTML) are both rendered from that AST. Errors are codes, never text. Fixtures: `tests/fixtures/math-text/`.

Current wiring (slice B-c): the module is merged (PR #64) and tested. Model-written items reach documents only through it: `admitAiItem` (`src/lib/content/ai-item.ts`) parses every field, `lesson-package/2` stores the ASTs, and the TeX and HTML renderers print from them (see `docs/ai-items.md`). No LLM item source calls it yet (B-e), so production drafts still hold deterministic items only.

## String form

Plain text with inline math in `\( ... \)`. A bare `$` is text. No display math in slice B: `\[ \]` is rejected, and `$$` is just text. Input is at most 2000 characters and has at least one non-space character after normalization.

## Text rules

- Normalization first: Unicode NFC; CR, LF, TAB and U+00A0 become a space; then runs of spaces collapse to one and the document is trimmed. The 2000-character limit is measured after NFC and this whitespace mapping, before collapsing and trimming.
- Checks run in this order: length, empty, control and bidi characters (the whole string, including inside spans), backslash and span splitting, URLs and e-mail in text, the text character allowlist; inside a span: unknown commands and bad characters (tokenizer), then structure (parser). So an unknown command is `math_unknown_command` even if the span is also unbalanced.
- Allowed in text, operationally: `A-Z a-z`; Latin-1 Supplement letters U+00C0-U+00D6, U+00D8-U+00F6, U+00F8-U+00FF; Latin Extended-A U+0100-U+017F except the nine letters the pinned fonts cannot print (U+0126, U+0127, U+0138, U+013F, U+0140, U+0149, U+0166, U+0167, U+017F; see `UNPRINTABLE_LETTERS` in `src/lib/latex/escape.ts`); digits `0-9`; space; and the punctuation `. , ; : ! ? ' " ’ - – — ( ) [ ] / % $ & + =`. Nothing else: fullwidth forms, ligatures (U+FB00-U+FB06), `ª`, `º`, `×`, `÷`, Cyrillic, U+2212, `< > * # ~ @ { } | ^ _` are `text_bad_char`. Two adjacent characters of the dash family `- – —`, two of the quote family `' ’`, or `,,` are `text_bad_char` too (`--`, `a––b`, `a-—b`, `''`, `’’`, `’'`, `,,`; the escape table prints `–` as `--`, `—` as `---` and `’` as `'`): the PDF fonts (T1) turn them into ligatures (an en dash, a closing quote) that the preview would not show; write an en dash or a double quote instead. Comparisons belong in math spans. Inside a span the tokenizer rejects any character outside the math character set, including lone surrogates, U+2028/U+2029 and a trailing backslash, with `math_bad_char`.
- C0/C1 controls (NUL, U+0085, ...) are `text_control_char`. Bidi controls and invisible characters (U+200B-U+200F, U+202A-U+202E, U+2060, U+2066-U+2069, U+FEFF) are `text_bidi_char`.
- A backslash in text (anything outside a matched `\(` `\)`, including `\[`, `\%`, a doubled `\\(`, and a trailing lone `\`) is `text_backslash`; scanning is left to right and a backslash not followed by `(` or `)` is an error at once. A `\)` with no open span is `delim_unexpected_close`; a `\(` inside a span is `delim_nested`. URLs (`scheme://`, `www.`) are `text_url`; `x@y` is `text_email`. Links are never emitted; URL- and e-mail-like text is rejected only by these documented checks.
- Output: HTML text is escaped by React; TeX text goes through the escape helper (`$ & %` become `\$ \& \%`). Renderers must not emit two adjacent math spans as `$$` (display math in TeX). `mathTextToTex` therefore puts `{}` between two math spans with no text between them: `\(x\)\(x\)` is canonical `\(x\)\(x\)` and TeX `$x${}$x$`. Text brackets go through the escape helper, which prints `[` and `]` as `{[}` and `{]}` (`See [1]` becomes `See {[}1{]}`).

## Grammar

```
doc      := (text | "\(" math "\)")+           -- after normalization, at least one non-space char
math     := list
list     := relation ("," relation)*
relation := expr (relop expr)*                 -- relop: = < > \le \ge \neq \to \approx \in \mid
expr     := term (addop term)*                 -- addop: + - \pm \cup      (left-assoc)
term     := unary ((mulop unary) | implicit)*  -- mulop: \times \cdot \div / \cap   implicit: juxtaposed postfix
unary    := ("-" | "+" | "\pm") unary | postfix   -- unary only at expr start or right after an operator/relop/comma/open
postfix  := primary ( "^" script | "_" script | "\%" )*    -- "^\circ" / "^{\circ}" => deg
                                               -- at most one "^" and one "_" per base, either order
                                               -- then at most one "!" on a whole number, a letter or a ( ) group
script   := digit | letter | "{" math "}"
primary  := number | letter "'"{1,3} | greek | "\ldots" | "\infty" | "(" math ")" | "[" math "]" | "|" expr "|"   -- no "|" directly inside or beside a bar
          | "\frac" "{" math "}" "{" math "}" | "\sqrt" ("[" math "]")? "{" math "}"
          | "\binom" "{" math "}" "{" math "}" | ("\bar" | "\hat") "{" letter "}"
          | "\lim" "_" "{" relation "}" operand                    -- the limit takes the rest of the implicit product
          | "\sum" bounds operand                                  -- bounds: ("_" script)? ("^" script)? in either order
          | "\int" bounds expr "\," "d" letter                    -- the differential is mandatory
          | fn ( "_" script )? postfix          -- "_" only after \log
number   := "0" | [1-9][0-9]{0,11}  ("." [0-9]{1,6})?
```

Greek: `\alpha \beta \theta \pi \mu \sigma \lambda`. Functions: `\sin \cos \tan \log \ln \sec \csc \cot \arcsin \arccos \arctan`. Letters are single ASCII letters. A comma directly between a digit and exactly three digits (`1,500`) is `math_digit_grouping`; write lists as `1, 500`.

## Limits

- Check order across spans: every span is tokenized before any span is parsed, so a tokenizer error (`math_bad_char`, `math_unknown_command`, ...) in a later span wins over a parser error in an earlier one.
- Consumers must expect deep ASTs: flat chains build left-nested `bin` nodes (up to about 150 for a 300-character span), so a traversal must be iterative or otherwise bounded for that depth, not only for the depth limit.
- 2000 characters per string (after NFC and whitespace mapping, see above); 20 spans per string.
- 300 characters per span, counting the characters between `\(` and `\)` (delimiters excluded).
- Integers up to 12 digits; decimals up to 6 fraction digits.
- Depth 8: the number of nested open constructs, where each of `( )`, `[ ]`, `| |`, a `{ }` argument of `\frac`, `\sqrt` or a script, and each prefix sign (`-`, `+`, `\pm`) counts one level; flat operator chains (`a+b+c+...`) do not. The outermost construct is level 1, so eight nested parentheses are accepted and nine are `math_depth`. Depth is checked on entering a construct, which bounds recursion. In `mathtext/2` the `{ }` condition of `\lim`, a braced bound, and the argument of `\lim`, `\sum` and `\int` (the integral body) each count one level, so nine nested big operators are `math_depth`.
- Exponent nesting 3, counted as nested `sup` nodes: a chain of 3 is accepted, a chain of 4 is `math_exponent_depth`.
- Absolute value: `|x|`, `|x+1|` and `2|x|` are accepted; a bar directly at the start of a bar body or directly after a closing bar (`||x||`, `|a||b|`) is `math_unexpected_token`. Nested absolute values are not supported: a `|` that would open a bar while any enclosing construct is a bar, at any nesting through parentheses, brackets, `\frac` arguments or script braces (`|(|x|)|`, `|\frac{|x|}{2}|`, `|x+|y||`), is `math_unexpected_token`; two separate bars (`|x|+|y|`) are fine.
- Scripts: a base takes at most one `^` and one `_`, in either order; a second of the same kind (`x^2^3`, `x_1_2`, `30^\circ^2`) is `math_bad_script`. Both `x^2_3` and `x_1^2` parse to `sup(sub(base, s), e)`.
- A script after a degree or percent (`30^\circ_2`, `50\%^2`) is `math_bad_script`; `x_1^\circ` is accepted and means a degree of `x_1`. A `^` or `_` script is one digit, one letter or a braced group: `x^12` is `math_bad_script` (write `x^{12}`).
- Root index: TeX ends the optional argument of `\sqrt[...]` at the first `]` outside braces, so the index of a root may hold neither a bracket token (`[`) nor another `\sqrt`: either is `math_unexpected_token` at the offending token (`\sqrt[\sqrt[3]{x}]{2}`, `\sqrt[[1]]{2}`, `\sqrt[2[x]]{y}`). `\sqrt[3]{27}`, `\sqrt[n]{x}`, `\sqrt[2x+1]{y}` and parentheses, bars and `\frac` inside the index are accepted; the index counts one depth level.
- Braces: a `{` or `}` anywhere except as the delimiters of a `\frac`, `\sqrt` or script argument is `math_brace_misuse` (`{x}`, `x}`); an empty argument (`\sqrt{}`) is `math_unexpected_token`. A missing or wrong closer of `( )`, `[ ]` or `| |` is `math_unbalanced`.
- Implicit products bind tighter than the explicit operators: `2\times 3x` is `2 \times (3x)`. The first item of an implicit product is a prefix-signed operand, so `-2x` is the product of `-2` and `x`. A function takes the next postfix operand as its argument (`\sin 30^\circ`, `\sin \cos x`). Two numbers side by side are `math_adjacent_numbers` even with a prefix sign on the first (`-2 3`), while `2 -3` is a subtraction; a number after a non-number item (`\pi 3`, `2^2 3`) is accepted as an implicit product (it prints `π3`, unambiguous). The adjacency rule looks at the last glyph the previous item prints, not only at the item: a function, prefix sign, product, binary operation, relation or list ends with its last operand, so `\sin 2 3`, `\sin 2.5 3`, `\log_2 8 3`, `\ln 2 3` and `2\sin 3 4` are `math_adjacent_numbers` (the space is invisible in math mode and `2 3` would print as 23). Items ending in a closer, a script, a percent sign or a letter-like glyph (`2(3)`, `(2)3`, `\sin 2 x`) are unaffected. A bare number directly before a `\frac` is the same error (`3\frac{1}{2}` prints like the mixed number three and a half but means 3 times one half): write `3\cdot\frac{1}{2}` or `(3)\frac{1}{2}`; `x\frac{1}{2}` and `2x\frac{1}{2}` are accepted.

## mathtext/2: calculus, statistics and pre-calculus notation

Why: AI drafts for Calculus, Statistics and Pre-calculus topics need notation `mathtext/1` could not parse, so the item gate refused them as `too_few_valid_items`. The token set below is the **minimum** derived from 15 fictional sample items (five per course, `tests/fixtures/math-text/samples-v2.json`, ids `c01`-`c05`, `s01`-`s05`, `p01`-`p05`; every field is an invented stem, answer or step with no real student, school or curriculum text). Every token below is used by at least one sample, and every sample's declared `uses` list is checked against the tokens the parser actually finds in it (`tests/unit/math-text-v2.test.ts`). Nothing was added "just in case": candidates the samples did not need are in the deferred list.

No item source, topic or course is switched on by this change. It is parser, renderer and allowlist work only; no curriculum data is added, no course or unit becomes selectable, and nothing outside `src/lib/math-text` stores `mathtext/1` documents (the only mentions of the version string are the shape guard, tests and this page), so the version bump needs no data migration.

| Token | Written | Needed by | Rule |
|---|---|---|---|
| prime | `f'(x)`, `f''(x)` | c01 (`f'`, `f''`), c05 (`f'(2)`) | A letter followed by one to three `'`. No script or `\%` after it (`f'^2` is `math_bad_script`); four primes or `'` anywhere else is `math_unexpected_token`. |
| `\lim` | `\lim_{x \to 2} \frac{x^2-4}{x-2}` | c02, c04 | The `_{...}` condition is required and braced (`\lim` alone or `\lim_x` is `math_bad_script` or `math_brace_misuse`); the argument is the rest of the implicit product, so a limit is always last in it. No script after it. |
| `\to` | `x \to 2`, `\frac{1}{x} \to 0` | c02, c04, p05 | A relation operator, same level as `=`. |
| `\infty` | `x \to \infty`, `(1, \infty)` | c04, p04, p05 | An operand like `\ldots`: it can start an operand but never continues an implicit product (`2\infty` is `math_unexpected_token`). |
| `\int` | `\int_{0}^{3} 2x\,dx` | c03 | Optional bounds, then an expression, then the mandatory differential `\,d` plus one letter. A missing differential is `math_unexpected_token`. Nothing may follow an integral in its implicit product, and no script or `\%` after it. |
| `\,` | `\int 2x\,dx` | c03 | A thin space, accepted only as the separator before an integral's differential; anywhere else it is `math_unexpected_token`. Every other control symbol (`\;`, `\!`, `\ `) stays `math_unknown_command`. |
| `\sum` | `\sum_{i=1}^{n} x_i` | s01, p03 | Optional lower and upper bound, each at most once, in either order (a duplicate is `math_bad_script`); the argument is the rest of the implicit product. No script after it. |
| `!` | `5!`, `(n+1)!` | s03 | After a whole number, a letter or a `( )` group only; `2.5!`, `x^2!`, `|x|!`, `x\%!`, `x!!` are `math_unexpected_token`. No script after it. |
| `\binom` | `\binom{5}{2}` | s03 | Two braced arguments, like `\frac`. |
| `\bar`, `\hat` | `\bar{x}`, `\hat{y}` | s01, s05 | One braced ASCII letter (`\bar{xy}` and `\bar{}` are `math_unexpected_token`, a missing or extra brace is `math_brace_misuse`). Scripts after it work as on a letter. |
| `\mu \sigma \lambda` | | s02, s05 | Greek letters, same as `\alpha`. |
| `\sec \csc \cot` | `\sec \theta` | p01 | Functions, same as `\sin`. |
| `\arcsin \arccos \arctan` | `\arcsin \frac{1}{2}` | p02 | Functions, same as `\sin`. `\sin^2` and `\sin^{-1}` stay `math_bad_script`. |
| `\approx` | `f(2.1) \approx f(2)` | c05 | A relation operator. |
| `\in` | `x \in (1, \infty)` | p04 | A relation operator. |
| `\mid` | `P(A \mid B)` | s04 | A relation operator; it is the conditional bar and unrelated to the absolute-value bar `|`. |
| `\cup` | `A \cup B` | s04 | An additive operator (same level as `+`). |
| `\cap` | `A \cap B` | s04 | A multiplicative operator (same level as `\times`), so `A \cup B \cap C` reads as `A \cup (B \cap C)`. |

Canonical forms: `f'(x)`, `n!`, `\binom{n}{k}`, `\bar{x}`, `\lim_{x\to2}\frac{x^{2}-4}{x-2}`, `\sum_{i=1}^{4}x_{i}`, `\int_{0}^{3}2x\,dx`, `x\in(2, \infty)`; the serializer inserts a space only where a control word would run into a letter. Bounds and the limit condition are always braced.

Safety and divergence:

- The set of control words and symbols the renderers may emit is `MATH_TEX_COMMANDS` plus `MATH_TEX_SYMBOLS` (`%` and `,`) in `src/lib/math-text/commands.ts`, exactly the added tokens and nothing else; `,` was already in the document-level `ALLOWED_CONTROL_SYMBOLS` of `src/lib/latex/templates.ts`, which is not edited here, and the preamble already loads `amsmath`, which provides `\binom`. So `TEMPLATE_VERSION` and `RENDER_VERSION` are unchanged, and the deterministic render goldens are untouched.
- The PDF and the preview both render `mathToTex`, which is also the canonical serializer, and the strict public parse still requires that the serialization of a result parses back to the same document. A test pins that the HTML preview TeX equals the PDF TeX for every added token and that KaTeX (trust off, strict `error`) accepts all of it.
- All new nesting (limit condition, bounds, integral body, big-operator argument, factorial of a group, accent and binomial arguments) goes through the same depth counter as before (limit 8, each big operator argument counts one level), so recursion stays bounded; 100 000-character inputs are refused by the length check before tokenizing.
- Big operators are the only constructs that take "the rest" of a product. They are therefore always last in an implicit product (a sum or limit swallows what follows; an integral is sealed by its differential). That is what keeps every accepted string unambiguous and round-trippable.
- Existing `mathtext/1` strings parse to the same AST (86 accepted inputs of the old golden and sample files are pinned in `tests/fixtures/math-text/v1-baseline.json`); the old `\(x!\)` `math_bad_char` row was replaced by `\(x?\)` because `!` is now a token. Only the document's `v` field changes.

Deferred (not in the samples, so not added; each would be a further deliberate bump): `\sin^2` and `\sin^{-1}` (function powers), `\sim`, `\notin`, `\subset`, half-open intervals such as `[1, \infty)` (a bracket group still needs a matching closer), one-sided limits (`0^+`), `\widehat`, a Greek letter or several letters under an accent (`\hat{\beta}`, `\bar{xy}`), the double factorial, an unbraced limit condition (`\lim_x`) and `\|`. Items that need them will fail with a typed code and be regenerated or dropped, as before.

## Canonical form

One rule set, used by `mathToTex` (plan task A5, not a code symbol): no whitespace except one space after a control word when the next character is an ASCII letter, one space after a function name unless `_` follows it (`\sin 30`, `\log_{2}8`), and one space after every list comma (so `\(1, 500\)` never re-serializes as the rejected `1,500`); scripts always braced (`x^{2}`, `a_{n}`, `30^{\circ}`), subscript before superscript (`x_{3}^{2}`); `\sqrt[n]{b}`; `\frac{a}{b}`; text parts have whitespace runs collapsed to one space and the document trimmed. The canonical string re-parses to the same AST. Implemented by `mathToTex` in `src/lib/math-text/to-tex.ts`, which is both the TeX renderer and the serializer, so the renderer can only emit what the grammar accepts. A space is also inserted where two pieces would otherwise merge: a control word followed by an ASCII letter (`a\times b`, `\pi x`) and two digit runs (`\sin 3 4`). A `[` group closes with `]`. TeX output uses exactly the control words `alpha beta theta pi le ge neq pm times cdot div frac sqrt circ sin cos tan log ln ldots` (the `mathtext/1` set) plus `mu sigma lambda sec csc cot arcsin arccos arctan to approx in mid cup cap infty binom bar hat lim sum int` (added in `mathtext/2`, one-to-one with the added tokens below) and the symbols `\%` and `\,` (`src/lib/math-text/commands.ts`), plus the `{}` span separator above. Canonical output is at most about twice the length of the source (`x^2` becomes `x^{2}`).

## Round-trip admission and the public surface

Rule: a source is accepted only if its canonical form (`serializeMathText`) parses again, to the same document. The public `parseMathText` of `src/lib/math-text/index.ts` is a thin strict wrapper (`admitMathText`, `strict.ts`) around the raw parser (`parse.ts`, internal): it parses the source, serializes the result, parses that with the raw parser, and compares the two documents by deep equality. The raw limits (300-character span, depth 8) apply to the source as written, but the canonical form can be longer or deeper (braced scripts cost one more depth level, `x^2` becomes `x^{2}`), so a source accepted near the limits can fail the second parse. Such a source is rejected with the second parse's own code (`math_depth`, `span_too_long`, or `too_long` when the canonical document exceeds 2000 characters, e.g. seven spans of 60 repetitions of `x^2`): `((((((((x^2))))))))` is `math_depth`, and 99 repetitions of `x^2` (297 characters, canonical 495) is `span_too_long`. If the second parse succeeds with a different document, the source is rejected with `math_unexpected_token`; that branch is a defect signal, unreachable by construction (the round-trip property of the serializer is tested over fixtures and generated trees, including 250 to 300 character spans) and it exists so that a parser or serializer regression fails closed. Consequence: every accepted public parse result re-parses from its canonical form to itself.

Public surface (`src/lib/math-text/index.ts`, the only import path for code outside the module): `parseMathText`, `serializeMathText`, `mathToTex`, `mathTextToTex`, `mathTextToInlineParts`, `checkMathTextRenders`, `isMathTextDoc`, `MATHTEXT_PARSER_VERSION`, `MATHTEXT_LIMITS`, `MATH_TEXT_ERROR_CODES`, `MATH_TEX_COMMANDS`, and the types `MathNode`, `MathTextDoc`, `MathTextPart`, `MathTextResult`, `MathTextErrorCode`. `isMathTextDoc(value)` (`guard.ts`) is a strict runtime shape validator (closed node-kind set, exact keys, enums for operators and names, formats of `num.v` and `var.name`, version `mathtext/2`, depth at most 256 (the parser cannot produce more than about 150), plain objects and dense arrays with own data properties only: no getters, holes, inherited or symbol keys; a Proxy around a valid document cannot be detected, so documents must be plain data; never throws); `checkMathTextRenders` calls it first and returns `render_tex_disallowed` for any value that is not a valid document, so a hand-built tree can never reach `mathToTex`. `split`, `tokenize`, `parseMath` and the raw parser are internal (the single outside import of an internal file is the shared command list in `src/lib/latex/templates.ts`, pinned by a test).

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
| `math_bad_char` | `\(x?\)` |
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
| `render_tex_disallowed`, `render_tex_too_long`, `render_katex_rejected` | render-time checks, not parse errors |

## Static preview check

`checkMathTextRenders` (`src/lib/math-text/check.ts`) is total (never throws, a caught throw maps to a typed code) and returns `null` or a render code. Order: per part in document order, a text part goes through `escapeTextFragment` and a math span through `mathToTex`; every emitted piece is refused (`render_tex_disallowed`) for a control character, a bare `%` or `#`, `^^`, or a control sequence outside the allowlist (a math span: `MATH_TEX_COMMANDS`/`MATH_TEX_SYMBOLS`, also no `$`; text: `PDF_BODY_COMMANDS`); a span over 500 TeX characters is `render_tex_too_long`; KaTeX refusing a span (`renderMathHtml`) is `render_katex_rejected`. Then the whole document's TeX (`mathTextToTex`) is checked against the total bound of 40 000 characters (`MAX_TOTAL_TEX` = 20 spans x 500 + 2000 text characters x 15, the widest escape of an allowed character) with `render_tex_too_long`, and again against `PDF_BODY_COMMANDS` and the unsafe constructs. HTML parts (`mathTextToInlineParts`): text parts carry the raw string (React escapes it), math parts carry `mathToTex`; no other path reaches `dangerouslySetInnerHTML`.

The check also applies the grammar to the document itself. After the shape guard (which caps the node count at 4000: a source is at most 2000 characters and the densest shape, `xy`, is three nodes for two characters, so the parser produces about 3000 at most), `checkMathTextRenders` requires the public strict entry to accept `serializeMathText(doc)` and return a document deep-equal to `doc`; otherwise it returns `render_tex_disallowed`. So a stored or hand-built document that no parse could produce (a raw URL or bidi character in text, `sup` of a `bin`, a `[` group or a root in a root index, nested bars, empty text, empty `parts`, adjacent text parts) is refused with a typed code, and the later checks (500-character span cap, total TeX bound, KaTeX) are second lines of defence for in-grammar documents only. A parser-accepted document always passes this step.

## Change policy

The grammar grows only by deliberate change: edit this page, bump `MATHTEXT_PARSER_VERSION`, and extend the fixtures. `mathtext/2` is a strict superset of `mathtext/1` (below).
