import { MATHTEXT_LIMITS, type MathTextErrorCode } from "@/lib/math-text/ast";

export type SplitPart = { t: "text"; s: string } | { t: "span"; src: string; at: number };
export type SplitResult = { ok: true; parts: SplitPart[] } | { ok: false; code: MathTextErrorCode; at?: number };

/** NFC, then CR, LF, TAB and U+00A0 become a space. The input limit is measured on this form. */
function mapWhitespace(input: string): string {
  return input.normalize("NFC").replace(/[\r\n\t ]/g, " ");
}

// String.prototype.trim also strips U+FEFF and U+2028/9, which must stay visible to the character checks.
const trimSpaces = (s: string): string => s.replace(/^ +/, "").replace(/ +$/, "");

/** The full normalization of docs/mathtext.md: NFC, whitespace mapping, runs of spaces collapsed, trimmed. */
export function normalizeMathTextInput(input: string): string {
  return trimSpaces(mapWhitespace(input).replace(/ {2,}/g, " "));
}

// Letters the pinned fonts cannot print (the same set as UNPRINTABLE_LETTERS in src/lib/latex/escape.ts).
const UNPRINTABLE = new Set([0x126, 0x127, 0x138, 0x13f, 0x140, 0x149, 0x166, 0x167, 0x17f]);
const TEXT_PUNCT = new Set([..." .,;:!?'\"’-–—()[]/%$&+="].map((c) => c.codePointAt(0) as number));

/** Text allowlist of docs/mathtext.md: explicit Latin ranges, digits, space and the documented punctuation. */
function isAllowedTextChar(cp: number): boolean {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0x30 && cp <= 0x39)) return true;
  if (TEXT_PUNCT.has(cp)) return true;
  if ((cp >= 0xc0 && cp <= 0xd6) || (cp >= 0xd8 && cp <= 0xf6) || (cp >= 0xf8 && cp <= 0xff)) return true;
  return cp >= 0x100 && cp <= 0x17f && !UNPRINTABLE.has(cp);
}

function isControl(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

function isBidiOrInvisible(cp: number): boolean {
  return (
    cp === 0x61c || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || cp === 0x2060 ||
    (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff
  );
}

/**
 * Splits a MathText string into text parts and `\( ... \)` spans in one left-to-right scan. Only delimiters, text
 * characters and size limits are decided here; the content of a span is the tokenizer's business. `at` is the offset
 * of the span source in the normalized string.
 */
export function splitMathText(input: string): SplitResult {
  const L = MATHTEXT_LIMITS;
  if (input.length > L.maxInputChars) return { ok: false, code: "too_long" }; // O(1): before any other work
  const mapped = mapWhitespace(input);
  if (mapped.length > L.maxInputChars) return { ok: false, code: "too_long" };
  const s = trimSpaces(mapped.replace(/ {2,}/g, " "));
  if (s === "") return { ok: false, code: "empty" };

  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (isControl(cp)) return { ok: false, code: "text_control_char", at: i };
    if (isBidiOrInvisible(cp)) return { ok: false, code: "text_bidi_char", at: i };
  }

  const parts: SplitPart[] = [];
  let spans = 0;
  let textStart = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "\\") {
      i++;
      continue;
    }
    const next = s[i + 1];
    if (next === ")") return { ok: false, code: "delim_unexpected_close", at: i };
    if (next !== "(") return { ok: false, code: "text_backslash", at: i };
    if (i > textStart) parts.push({ t: "text", s: s.slice(textStart, i) });
    if (++spans > L.maxSpans) return { ok: false, code: "too_many_spans", at: i };
    const start = i + 2;
    let j = start;
    let close = -1;
    while (close < 0) {
      const k = s.indexOf("\\", j);
      if (k < 0) return { ok: false, code: "delim_unterminated", at: i };
      if (s[k + 1] === "(") return { ok: false, code: "delim_nested", at: k };
      if (s[k + 1] === ")") close = k;
      else j = k + 1;
    }
    const src = s.slice(start, close);
    if (src.length > L.maxSpanChars) return { ok: false, code: "span_too_long", at: start };
    if (/^ *$/.test(src)) return { ok: false, code: "span_empty", at: start };
    parts.push({ t: "span", src, at: start });
    i = textStart = close + 2;
  }
  if (textStart < s.length) parts.push({ t: "text", s: s.slice(textStart) });

  for (const p of parts) {
    if (p.t !== "text") continue;
    if (p.s.includes("://") || /www\./i.test(p.s)) return { ok: false, code: "text_url" };
    if (p.s.includes("@")) return { ok: false, code: "text_email" };
  }
  for (const p of parts) {
    if (p.t !== "text") continue;
    for (const ch of p.s) if (!isAllowedTextChar(ch.codePointAt(0) as number)) return { ok: false, code: "text_bad_char" };
  }
  return { ok: true, parts };
}
