/**
 * The control-sequence scanner shared by `assertTexIsSafe` (whole documents) and the MathText static check (one math
 * span). Moved verbatim out of `assertTexIsSafe`: a control word is a backslash plus letters or `@`, a control symbol a
 * backslash plus one other character (so `\\` consumes both backslashes and a following letter is plain text).
 * Returns the first name outside the sets, for internal use only (never shown to users), or null.
 */
export function firstDisallowedControlSequence(tex: string, commands: ReadonlySet<string>, symbols: ReadonlySet<string>): string | null {
  for (const match of tex.matchAll(/\\([A-Za-z@]+|.)/gs)) {
    const name = match[1]!;
    const ok = /^[A-Za-z@]+$/.test(name) ? commands.has(name) : symbols.has(name);
    if (!ok) return name;
  }
  return null;
}
