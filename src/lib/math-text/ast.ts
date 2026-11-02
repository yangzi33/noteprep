/** Version of the MathText grammar. Bump on any deliberate grammar change (see docs/mathtext.md). */
export const MATHTEXT_PARSER_VERSION = "mathtext/1";

export const MATHTEXT_LIMITS = {
  maxInputChars: 2000,
  maxSpanChars: 300,
  maxDepth: 8,
  maxExponentDepth: 3,
  maxSpans: 20,
  maxIntDigits: 12,
  maxFracDigits: 6,
} as const;

/** Every way MathText can be refused. Codes only: a result never carries the offending text. */
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
  | { t: "num"; v: string } // literal digits as written (canonical: no leading zeros)
  | { t: "var"; name: string } // one ASCII letter
  | { t: "greek"; name: Greek }
  | { t: "ldots" }
  | { t: "bin"; op: BinOp; l: MathNode; r: MathNode } // left-associative
  | { t: "imp"; items: MathNode[] } // implicit product, >= 2 items
  | { t: "unary"; op: "-" | "+" | "pm"; arg: MathNode }
  | { t: "rel"; first: MathNode; rest: { op: RelOp; rhs: MathNode }[] }
  | { t: "list"; items: MathNode[] } // comma list, >= 2 items
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
export interface MathTextDoc {
  v: typeof MATHTEXT_PARSER_VERSION;
  parts: MathTextPart[];
}
export type MathTextResult = { ok: true; doc: MathTextDoc } | { ok: false; code: MathTextErrorCode; at?: number };
