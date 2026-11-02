/**
 * The one macro allowlist for model-written math: every control word and control symbol `mathToTex` can emit, and
 * nothing else. Imports nothing, so the renderer, the static check and `assertTexIsSafe` can all share it.
 */
export const MATH_TEX_COMMANDS: ReadonlySet<string> = new Set([
  "alpha", "beta", "theta", "pi", "le", "ge", "neq", "pm", "times", "cdot", "div", "frac", "sqrt", "circ",
  "sin", "cos", "tan", "log", "ln", "ldots",
]);

/** Control symbols (a backslash plus one non-letter): only the percent sign. */
export const MATH_TEX_SYMBOLS: ReadonlySet<string> = new Set(["%"]);
