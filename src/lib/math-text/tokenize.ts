import { MATHTEXT_LIMITS, type MathTextErrorCode } from "@/lib/math-text/ast";

export type CmdName =
  | "alpha" | "beta" | "theta" | "pi" | "le" | "ge" | "neq" | "pm" | "times" | "cdot" | "div" | "frac" | "sqrt" | "circ"
  | "sin" | "cos" | "tan" | "log" | "ln" | "ldots";
export type OpChar = "+" | "-" | "=" | "<" | ">" | "/" | "," | "^" | "_" | "|" | "(" | ")" | "[" | "]" | "{" | "}";

export type Token =
  | { k: "num"; v: string; at: number }
  | { k: "letter"; v: string; at: number }
  | { k: "cmd"; v: CmdName; at: number }
  | { k: "pct"; at: number }
  | { k: "op"; v: OpChar; at: number };

export type TokenizeResult = { ok: true; tokens: Token[] } | { ok: false; code: MathTextErrorCode; at: number };

const CMD_NAMES: ReadonlySet<string> = new Set<CmdName>([
  "alpha", "beta", "theta", "pi", "le", "ge", "neq", "pm", "times", "cdot", "div", "frac", "sqrt", "circ",
  "sin", "cos", "tan", "log", "ln", "ldots",
]);
const OP_CHARS: ReadonlySet<string> = new Set<OpChar>(["+", "-", "=", "<", ">", "/", ",", "^", "_", "|", "(", ")", "[", "]", "{", "}"]);

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/**
 * Tokenizes the source of one math span in a single left-to-right scan. Input is already normalized, so the only
 * whitespace is a plain space; anything outside ASCII letters, digits, the operator set, space and a backslash is
 * `math_bad_char` (this covers lone surrogates, U+2028/U+2029 and non-ASCII letters, because the scan walks UTF-16
 * code units). `at` of every token and error is `offset + index in src`, where `offset` is the span's position in
 * the normalized string (SplitPart.at), so positions point into the normalized input.
 */
export function tokenizeMath(src: string, offset: number): TokenizeResult {
  const tokens: Token[] = [];
  const n = src.length;
  const fail = (code: MathTextErrorCode, i: number): TokenizeResult => ({ ok: false, code, at: offset + i });
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    const ch = src[i] as string;
    if (c === 0x20) {
      i++;
    } else if (isDigit(c)) {
      const start = i;
      while (i < n && isDigit(src.charCodeAt(i))) i++;
      const intEnd = i;
      if (src[i] === "." && i + 1 < n && isDigit(src.charCodeAt(i + 1))) {
        i++;
        while (i < n && isDigit(src.charCodeAt(i))) i++;
      }
      const fracDigits = i > intEnd ? i - intEnd - 1 : 0;
      if (intEnd - start > 1 && src[start] === "0") return fail("math_leading_zero", start);
      if (intEnd - start > MATHTEXT_LIMITS.maxIntDigits || fracDigits > MATHTEXT_LIMITS.maxFracDigits) return fail("math_number_too_long", start);
      tokens.push({ k: "num", v: src.slice(start, i), at: offset + start });
    } else if (isLetter(c)) {
      tokens.push({ k: "letter", v: ch, at: offset + i });
      i++;
    } else if (c === 0x5c) {
      const next = i + 1 < n ? src.charCodeAt(i + 1) : -1;
      if (next < 0) return fail("math_bad_char", i);
      if (next === 0x25) {
        tokens.push({ k: "pct", at: offset + i });
        i += 2;
      } else if (isLetter(next)) {
        let j = i + 1;
        while (j < n && isLetter(src.charCodeAt(j))) j++;
        const name = src.slice(i + 1, j);
        if (!CMD_NAMES.has(name)) return fail("math_unknown_command", i);
        tokens.push({ k: "cmd", v: name as CmdName, at: offset + i });
        i = j;
      } else {
        return fail("math_unknown_command", i);
      }
    } else if (OP_CHARS.has(ch)) {
      if (ch === "," && i > 0 && isDigit(src.charCodeAt(i - 1)) && i + 3 < n && isDigit(src.charCodeAt(i + 1)) &&
        isDigit(src.charCodeAt(i + 2)) && isDigit(src.charCodeAt(i + 3)) && !(i + 4 < n && isDigit(src.charCodeAt(i + 4)))) {
        return fail("math_digit_grouping", i);
      }
      tokens.push({ k: "op", v: ch as OpChar, at: offset + i });
      i++;
    } else {
      return fail("math_bad_char", i);
    }
  }
  return { ok: true, tokens };
}
