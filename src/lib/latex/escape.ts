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

const MAX_TEXT = 5000;

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
    else if (PLAIN.test(ch) || LATIN_LETTER.test(ch)) out += ch === "[" || ch === "]" ? `{${ch}}` : ch;
    else out += "?";
  }
  return out.replace(/ {2,}/g, " ").trim();
}
