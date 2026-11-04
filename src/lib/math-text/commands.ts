/**
 * The one macro allowlist for model-written math: every control word and control symbol `mathToTex` can emit, and
 * nothing else. Imports nothing, so the renderer, the static check and `assertTexIsSafe` can all share it.
 */
export const MATH_TEX_COMMANDS: ReadonlySet<string> = new Set([
  "alpha", "beta", "theta", "pi", "le", "ge", "neq", "pm", "times", "cdot", "div", "frac", "sqrt", "circ",
  "sin", "cos", "tan", "log", "ln", "ldots",
  "mu", "sigma", "lambda", "sec", "csc", "cot", "arcsin", "arccos", "arctan", "to", "approx", "in", "mid", "cup", "cap",
  "infty", "binom", "bar", "hat", "lim", "sum", "int",
]);

/** Control symbols (a backslash plus one non-letter): the percent sign and the thin space before an integral's differential. */
export const MATH_TEX_SYMBOLS: ReadonlySet<string> = new Set(["%", ","]);
