/** Raised for anything the renderer refuses to put into a document. Carries a stable code, never the offending text. */
export class RenderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RenderError";
  }
}

const SPECIAL: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "&": "\\&",
  "#": "\\#",
  _: "\\_",
  "%": "\\%",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
  "<": "\\textless{}",
  ">": "\\textgreater{}",
  "|": "\\textbar{}",
  '"': "\\textquotedbl{}",
  " ": "~",
  "–": "--",
  "—": "---",
  "‘": "`",
  "’": "'",
  "“": "``",
  "”": "''",
  "…": "\\ldots{}",
};

/** Characters with a safe, known rendering in the pinned fonts (T1 encoding, Latin-1 and Latin Extended-A letters). */
const PLAIN = /^[A-Za-z0-9 .,;:!?'()\-/+=@*\[\]]$/;
const LATIN_LETTER = /^[À-ſ]$/u;
/**
 * Letters inside that range which the pinned T1/utf8 setup has no definition for (LaTeX stops with "Unicode character not
 * set up"), found by compiling the whole range in the real image (tests/latex/escape-chars.test.ts): H and T with stroke,
 * kra, the two Ls with middle dot, n with a leading apostrophe, long s.
 */
const UNPRINTABLE_LETTERS = new Set(["Ħ", "ħ", "ĸ", "Ŀ", "ŀ", "ŉ", "Ŧ", "ŧ", "ſ"]);

const MAX_TEXT = 5000;

/**
 * True when `escapeText` renders this single character as itself or as a fixed escape sequence, false when it would
 * print "?" (the same tables `escapeText` uses, so callers that refuse unprintable input cannot drift from it).
 */
export function printsLiterally(ch: string): boolean {
  return SPECIAL[ch] !== undefined || PLAIN.test(ch) || (LATIN_LETTER.test(ch) && !UNPRINTABLE_LETTERS.has(ch));
}

/**
 * Turns arbitrary text into text that LaTeX prints literally. Every character is either passed through from a short
 * safe list, replaced by a fixed escape sequence, or replaced by "?" when the pinned fonts cannot print it (emoji, other
 * scripts, control characters). Nothing in the input can start a command: a backslash, brace, dollar, percent, caret
 * and the like never reach the output unescaped.
 */
export function escapeText(input: string): string {
  const text = input.normalize("NFC").replace(/[\r\n\t\f\v]+/g, " ");
  if (text.length > MAX_TEXT) throw new RenderError("text_too_long");
  let out = "";
  for (const ch of text) {
    const special = SPECIAL[ch];
    if (special !== undefined) out += special;
    else if (PLAIN.test(ch) || (LATIN_LETTER.test(ch) && !UNPRINTABLE_LETTERS.has(ch))) out += ch === "[" || ch === "]" ? `{${ch}}` : ch;
    else out += "?";
  }
  return out.replace(/ {2,}/g, " ").trim();
}
