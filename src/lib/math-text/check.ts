import { MATHTEXT_LIMITS, type MathTextDoc, type MathTextErrorCode } from "@/lib/math-text/ast";
import { isMathTextDoc } from "@/lib/math-text/guard";
import { MATH_TEX_COMMANDS, MATH_TEX_SYMBOLS } from "@/lib/math-text/commands";
import { mathTextToTex, mathToTex } from "@/lib/math-text/to-tex";
import { escapeTextFragment, RenderError } from "@/lib/latex/escape";
import { firstDisallowedControlSequence, firstUnsafeTexConstruct } from "@/lib/latex/allowlist";
import { ALLOWED_CONTROL_SYMBOLS, PDF_BODY_COMMANDS } from "@/lib/latex/templates";
import { renderMathHtml } from "@/lib/ui/math-html";

/** Longest TeX of one math span; the same cap `renderMathHtml` applies. */
export const MAX_SPAN_TEX = 500;
/**
 * Longest total TeX of one MathText: 20 spans x 500 characters (10 000) plus 30 000 for text, which is 2000 text
 * characters at the worst escape expansion of an allowed character (`"` becomes the 15-character `\textquotedbl{}`).
 */
export const MAX_TOTAL_TEX = MATHTEXT_LIMITS.maxSpans * MAX_SPAN_TEX + 2000 * 15;

// Same stance as `assertTexIsSafe` (src/lib/latex/render.ts), through the shared `firstUnsafeTexConstruct`: the
// control-sequence scanner sees only backslash sequences, so comments, ^^ notation and parameter characters are
// rejected separately. Control characters are an addition of this check.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
export function hasUnsafeConstruct(tex: string): boolean {
  return CONTROL_CHARS.test(tex) || firstUnsafeTexConstruct(tex) !== null;
}

/**
 * The static preview check (spec 5.2): everything the HTML preview and the PDF renderer will do with this MathText is
 * decided here, before it is admitted, so a preview can never show what the PDF refuses or the reverse. Total: never
 * throws, never fails open. Order: (1) per part in document order: text through the escape helper then the unsafe
 * construct and scanner checks; a math span through `mathToTex`, then control characters, `$`, `%`, `^^`, `#`, the
 * span scanner, the 500 character cap, KaTeX; (2) the whole document's TeX: total cap, then the PDF body scanner and
 * unsafe constructs.
 */
export function checkMathTextRenders(doc: MathTextDoc): MathTextErrorCode | null {
  // Runtime shape first: a hand-built value that is not a valid document never reaches `mathToTex`.
  if (!isMathTextDoc(doc)) return "render_tex_disallowed";
  try {
    for (const p of doc.parts) {
      if (p.t === "text") {
        let tex: string;
        try {
          tex = escapeTextFragment(p.s);
        } catch (e) {
          return e instanceof RenderError && e.code === "text_too_long" ? "render_tex_too_long" : "render_tex_disallowed";
        }
        if (hasUnsafeConstruct(tex) || /(?<!\\)\$/.test(tex)) return "render_tex_disallowed";
        if (firstDisallowedControlSequence(tex, PDF_BODY_COMMANDS, ALLOWED_CONTROL_SYMBOLS) !== null) return "render_tex_disallowed";
        continue;
      }
      let tex: string;
      try {
        tex = mathToTex(p.m);
      } catch {
        return "render_tex_disallowed";
      }
      if (tex.includes("$") || hasUnsafeConstruct(tex)) return "render_tex_disallowed";
      if (firstDisallowedControlSequence(tex, MATH_TEX_COMMANDS, MATH_TEX_SYMBOLS) !== null) return "render_tex_disallowed";
      if (tex.length > MAX_SPAN_TEX) return "render_tex_too_long";
      if (!renderMathHtml(tex, "inline").ok) return "render_katex_rejected";
    }
    let whole: string;
    try {
      whole = mathTextToTex(doc);
    } catch (e) {
      return e instanceof RenderError && e.code === "text_too_long" ? "render_tex_too_long" : "render_tex_disallowed";
    }
    if (whole.length > MAX_TOTAL_TEX) return "render_tex_too_long";
    if (firstDisallowedControlSequence(whole, PDF_BODY_COMMANDS, ALLOWED_CONTROL_SYMBOLS) !== null) return "render_tex_disallowed";
    if (hasUnsafeConstruct(whole)) return "render_tex_disallowed";
    return null;
  } catch {
    return "render_katex_rejected";
  }
}
