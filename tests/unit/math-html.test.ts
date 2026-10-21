import { describe, expect, it } from "vitest";
import { renderMathHtml, splitInlineMath } from "@/lib/ui/math-html";

describe("renderMathHtml", () => {
  it("renders inline math", () => {
    const r = renderMathHtml("x = 3", "inline");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.html).toContain('class="katex"');
  });

  it("renders display math", () => {
    const r = renderMathHtml("x = 3", "display");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.html).toContain("katex-display");
  });

  it("renders a fraction", () => {
    expect(renderMathHtml("\\frac{3}{4}x = 5", "inline").ok).toBe(true);
  });

  const hostile = [
    "\\href{javascript:alert(1)}{x}",
    "\\url{http://evil}",
    "\\includegraphics{x}",
    "\\input{/etc/passwd}",
    "\\def\\a{\\a\\a}\\a",
    "x".repeat(501),
    "\\frac{1",
  ];
  it.each(hostile)("rejects or neutralises %s", (tex) => {
    const r = renderMathHtml(tex, "inline");
    if (r.ok) {
      for (const bad of ["<a ", "href=", "<img", "javascript:"]) {
        expect(r.html).not.toContain(bad);
      }
    } else {
      expect(r).toEqual({ ok: false });
    }
  });

  it("rejects URL, file and raw-HTML commands before KaTeX sees them", () => {
    for (const tex of ["\\href{javascript:alert(1)}{x}", "\\url{http://evil}", "\\includegraphics{x}", "\\input{/etc/passwd}"]) {
      expect(renderMathHtml(tex, "inline")).toEqual({ ok: false });
    }
  });

  // These pin the KaTeX options: each fails if the matching option is removed from renderMathHtml.
  it("caps explicit sizes at maxSize (20em), so \\rule cannot cover the page", () => {
    const r = renderMathHtml("\\rule{1000em}{1000em}", "inline");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.html).toContain("height:20em");
    expect(r.html).toContain("border-right-width:20em");
    // The annotation echoes the source text, so check only rendered size attributes.
    expect(r.html).toContain('width="20em" height="20em"');
    expect(r.html).not.toMatch(/(?:width|height)[:=]"?1000em/);
  });

  it("emits MathML next to the HTML (output: htmlAndMathml)", () => {
    const r = renderMathHtml("x = 3", "inline");
    expect(r.ok && r.html.includes("<math")).toBe(true);
  });

  it("is strict: input KaTeX accepts only with strict:ignore is refused", () => {
    // A non-Latin character in math mode is a LaTeX-incompatible input; strict:"error" throws, strict:"ignore" renders.
    expect(renderMathHtml("\u00e9", "inline")).toEqual({ ok: false });
  });

  it("returns ok:false for the macro bomb, the overlong input and the unclosed group", () => {
    for (const tex of ["\\def\\a{\\a\\a}\\a", "x".repeat(501), "\\frac{1"]) {
      expect(renderMathHtml(tex, "inline")).toEqual({ ok: false });
    }
  });
});

describe("splitInlineMath", () => {
  it("splits text and math", () => {
    expect(splitInlineMath("Subtract $5$ from both sides")).toEqual([
      { kind: "text", value: "Subtract " },
      { kind: "math", tex: "5" },
      { kind: "text", value: " from both sides" },
    ]);
  });
  it("keeps plain text as one fragment", () => {
    expect(splitInlineMath("no math")).toEqual([{ kind: "text", value: "no math" }]);
  });
  it("treats an odd dollar as text", () => {
    const parts = splitInlineMath("odd $ sign");
    expect(parts.some((p) => p.kind === "math")).toBe(false);
    expect(parts.map((p) => (p.kind === "text" ? p.value : "")).join("")).toBe("odd $ sign");
  });
  it("returns [] for empty input", () => {
    expect(splitInlineMath("")).toEqual([]);
  });
});
