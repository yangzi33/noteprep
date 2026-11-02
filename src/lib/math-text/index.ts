/**
 * Public surface of MathText: the only import path for code outside `src/lib/math-text`. `parseMathText` here is the
 * strict entry point (raw parse plus the round-trip admission rule); the raw parser, `split`, `tokenize` and
 * `parseMath` stay internal. Pure TypeScript: no server-only, React or database imports.
 */
import type { MathTextResult } from "@/lib/math-text/ast";
import { admitMathText } from "@/lib/math-text/strict";

export function parseMathText(input: string): MathTextResult {
  return admitMathText(input);
}

export { MATHTEXT_LIMITS, MATHTEXT_PARSER_VERSION, MATH_TEXT_ERROR_CODES } from "@/lib/math-text/ast";
export type { MathNode, MathTextDoc, MathTextErrorCode, MathTextPart, MathTextResult } from "@/lib/math-text/ast";
export { checkMathTextRenders } from "@/lib/math-text/check";
export { MATH_TEX_COMMANDS } from "@/lib/math-text/commands";
export { isMathTextDoc } from "@/lib/math-text/guard";
export { mathTextToInlineParts } from "@/lib/math-text/to-html";
export { mathTextToTex, mathToTex, serializeMathText } from "@/lib/math-text/to-tex";
