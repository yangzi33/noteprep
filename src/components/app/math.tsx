import { renderMathHtml, type InlineMathPart } from "@/lib/ui/math-html";

/**
 * Server-rendered math. KaTeX output is the only markup in the draft that goes through dangerouslySetInnerHTML;
 * when KaTeX refuses the input the TeX is shown as escaped code instead.
 */
export function MathView({ tex, mode }: { tex: string; mode: "inline" | "display" }) {
  const result = renderMathHtml(tex, mode);
  if (!result.ok) return <code>{tex}</code>;
  return <span dangerouslySetInnerHTML={{ __html: result.html }} />;
}

export function Inlines({ parts }: { parts: InlineMathPart[] }) {
  return (
    <>
      {parts.map((part, i) => (part.kind === "text" ? <span key={i}>{part.value}</span> : <MathView key={i} tex={part.tex} mode="inline" />))}
    </>
  );
}
