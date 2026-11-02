import type { MathTextDoc } from "@/lib/math-text/ast";
import { mathToTex } from "@/lib/math-text/to-tex";
import type { InlineMathPart } from "@/lib/ui/math-html";

/**
 * The HTML side of the MathText boundary. Text parts carry the raw string (React escapes it; it is never parsed as
 * markup), math parts carry the TeX `mathToTex` emits, which `Inlines` hands to `renderMathHtml` (KaTeX with trust off).
 * No model string reaches `dangerouslySetInnerHTML` any other way. Run `checkMathTextRenders` before admitting content.
 */
export function mathTextToInlineParts(doc: MathTextDoc): InlineMathPart[] {
  return doc.parts.map((p): InlineMathPart => (p.t === "text" ? { kind: "text", value: p.s } : { kind: "math", tex: mathToTex(p.m) }));
}
