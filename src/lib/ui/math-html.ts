import katex from "katex";

// Safe server-side math rendering. KaTeX output is the only markup allowed
// into dangerouslySetInnerHTML; callers fall back to escaped plain text on
// { ok: false }. TeX must come only from validated math fields, never from
// arbitrary lesson text.

export type MathHtmlResult = { ok: true; html: string } | { ok: false };

const MAX_TEX_LENGTH = 500;

// Finding (katex 0.19.0): with trust:false, \href does not become a link, but
// KaTeX (throwOnError:true notwithstanding) renders it as red error text and
// echoes the raw source, including "javascript:...", in the MathML
// <annotation>. That is inert, yet it would put a URL scheme into the page, so
// commands that take URLs, files or raw HTML are rejected up front. Our math
// vocabulary (validated rationals and fixed operations) never needs them.
const FORBIDDEN_COMMANDS = /\\(?:href|url|includegraphics|input|include|html[A-Za-z]*|write|read|openin|openout|csname|catcode)(?![A-Za-z])/;

export function renderMathHtml(tex: string, mode: "inline" | "display"): MathHtmlResult {
  if (tex.length > MAX_TEX_LENGTH || FORBIDDEN_COMMANDS.test(tex)) return { ok: false };
  try {
    const html = katex.renderToString(tex, {
      displayMode: mode === "display",
      throwOnError: true,
      trust: false,
      strict: "error",
      maxExpand: 1000,
      maxSize: 20,
      output: "htmlAndMathml",
    });
    return { ok: true, html };
  } catch {
    return { ok: false };
  }
}

export type InlineMathPart = { kind: "text"; value: string } | { kind: "math"; tex: string };

export function splitInlineMath(text: string): InlineMathPart[] {
  const segments = text.split("$");
  const parts: InlineMathPart[] = [];
  const push = (value: string) => {
    if (value === "") return;
    const last = parts[parts.length - 1];
    if (last && last.kind === "text") last.value += value;
    else parts.push({ kind: "text", value });
  };
  // Even-indexed segments are text, odd-indexed are math. With an odd number
  // of `$` the final math segment is unpaired and is kept as literal text.
  const pairedEnd = segments.length % 2 === 1 ? segments.length : segments.length - 1;
  segments.forEach((segment, i) => {
    if (i >= pairedEnd) {
      push("$" + segment);
    } else if (i % 2 === 0) {
      push(segment);
    } else if (segment === "") {
      push("$$");
    } else {
      parts.push({ kind: "math", tex: segment });
    }
  });
  return parts;
}
