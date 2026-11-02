import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import golden from "../fixtures/math-text/golden.json";
import { acceptedFixtureDocs, generatedDocs, rng } from "../fixtures/math-text/gen";
import { HOSTILE } from "../fixtures/math-text/hostile";
import { Inlines } from "@/components/app/math";
import { MATH_TEXT_ERROR_CODES, MATHTEXT_PARSER_VERSION, type MathTextDoc } from "@/lib/math-text/ast";
import { checkMathTextRenders, MAX_TOTAL_TEX } from "@/lib/math-text/check";
import { parseMathText } from "@/lib/math-text/parse";
import { mathTextToInlineParts } from "@/lib/math-text/to-html";
import { mathToTex, mathTextToTex } from "@/lib/math-text/to-tex";
import { firstDisallowedControlSequence } from "@/lib/latex/allowlist";
import { ALLOWED_CONTROL_SYMBOLS, PDF_BODY_COMMANDS } from "@/lib/latex/templates";

const html = (doc: MathTextDoc) => renderToStaticMarkup(createElement(Inlines, { parts: mathTextToInlineParts(doc) }));

describe("static preview check and HTML parts", () => {
  it("every emitted tex passes the allowlist and KaTeX (accepted fixtures and 3000 generated docs, seed 42)", () => {
    const docs = [...acceptedFixtureDocs(), ...generatedDocs(rng(42), 3000)];
    expect(docs.length).toBeGreaterThan(3000);
    for (const doc of docs) expect(checkMathTextRenders(doc), JSON.stringify(doc)).toBeNull();
  });
  it("no HTML injection: rendered markup of every hostile or accepted input has no active content", () => {
    for (const input of [...HOSTILE, ...golden.map((r) => r.in)]) {
      const r = parseMathText(input);
      if (!r.ok) continue;
      expect(html(r.doc), input).not.toMatch(/<script|<img|<a |href=|javascript:|\son[a-z]+=/i);
    }
  });
  it("text containing angle brackets is escaped by React, never parsed as markup", () => {
    const doc: MathTextDoc = { v: MATHTEXT_PARSER_VERSION, parts: [{ t: "text", s: "if a < b > c <script>" }] };
    expect(html(doc)).toContain("a &lt; b &gt; c &lt;script&gt;");
  });
  it("math parts carry mathToTex, text parts the raw string", () => {
    const r = parseMathText("Solve \\(2x+3=11\\).");
    if (!r.ok) throw new Error();
    expect(mathTextToInlineParts(r.doc)).toEqual([
      { kind: "text", value: "Solve " }, { kind: "math", tex: "2x+3=11" }, { kind: "text", value: "." },
    ]);
  });
  it("reports render_tex_too_long instead of failing open when TeX exceeds the HTML cap", () => {
    const doc: MathTextDoc = { v: MATHTEXT_PARSER_VERSION, parts: [{ t: "math", m: { t: "imp", items: Array.from({ length: 200 }, () => ({ t: "greek", name: "pi" }) as const) } }] };
    expect(checkMathTextRenders(doc)).toBe("render_tex_too_long");
  });
  it("rejects a document whose total TeX exceeds the bound", () => {
    const text = "\"".repeat(2000);
    const parts: MathTextDoc["parts"] = [{ t: "text", s: text }];
    for (let i = 0; i < 20; i++) parts.push({ t: "math", m: { t: "imp", items: Array.from({ length: 100 }, () => ({ t: "greek", name: "pi" }) as const) } });
    // each span is 300+ chars (under the span cap); with the text the whole exceeds nothing, so push it over with more text
    const big: MathTextDoc = { v: MATHTEXT_PARSER_VERSION, parts: [...parts, { t: "text", s: "\"".repeat(2000) }, { t: "text", s: "\"".repeat(2000) }] };
    expect(mathTextToTex(big).length).toBeGreaterThan(MAX_TOTAL_TEX);
    expect(checkMathTextRenders(big)).toBe("render_tex_too_long");
  });
  it("is total: a malformed AST maps to a typed code and never throws", () => {
    const bad = { v: MATHTEXT_PARSER_VERSION, parts: [{ t: "math", m: { t: "nope" } }] } as unknown as MathTextDoc;
    let code: string | null = "unset";
    expect(() => (code = checkMathTextRenders(bad))).not.toThrow();
    expect(MATH_TEXT_ERROR_CODES as readonly string[]).toContain(code);
    const nullPart = { v: MATHTEXT_PARSER_VERSION, parts: [null] } as unknown as MathTextDoc;
    expect(checkMathTextRenders(nullPart)).not.toBeNull();
  });
  it("a root inside a root index is a typed reject (its `]` ends the optional argument early in KaTeX and TeX)", () => {
    const r = parseMathText("\\(\\sqrt[\\sqrt[3]{x}]{2}\\)");
    if (!r.ok) throw new Error(r.code);
    expect(checkMathTextRenders(r.doc)).toBe("render_katex_rejected");
  });
  it("rejects TeX the scanner or the unsafe-construct checks refuse", () => {
    const withVar = (name: string): MathTextDoc => ({ v: MATHTEXT_PARSER_VERSION, parts: [{ t: "math", m: { t: "var", name } }] });
    for (const name of ["%", "#", "$", "\n", "\\input", "^^"]) expect(checkMathTextRenders(withVar(name)), JSON.stringify(name)).toBe("render_tex_disallowed");
    expect(checkMathTextRenders({ v: MATHTEXT_PARSER_VERSION, parts: [{ t: "math", m: { t: "num", v: "\\foo" } }] })).toBe("render_tex_disallowed");
  });
});

describe("string fuzz: parse then check", () => {
  const SEED = 20261101;
  const TOKENS = [
    ..."0123456789".split(""), ..."abcxyzXYZ".split(""), "+", "-", "=", "<", ">", "/", "*", "^", "_", "(", ")", "[", "]", "{", "}", "|",
    ",", ".", "%", " ", " ", "$", "#", "&", "~", "!", "'", "\\", "^^",
    "\\alpha", "\\pi", "\\theta", "\\beta", "\\frac", "\\sqrt", "\\sin", "\\cos", "\\tan", "\\log", "\\ln", "\\times", "\\cdot", "\\div",
    "\\pm", "\\le", "\\ge", "\\neq", "\\ldots", "\\circ", "\\%", "\\input", "\\def", "\\text", "\\left", "\\\\",
  ];
  it("20000 random strings: typed reject or safe emitted TeX, seed " + SEED, () => {
    const next = rng(SEED);
    let accepted = 0;
    for (let i = 0; i < 20000; i++) {
      let body = "";
      const n = 1 + Math.floor(next() * 14);
      for (let k = 0; k < n; k++) body += TOKENS[Math.floor(next() * TOKENS.length)];
      const input = `\\(${body}\\)`;
      const ctx = `seed ${SEED} input ${JSON.stringify(input)}`;
      const r = parseMathText(input);
      if (!r.ok) continue;
      accepted++;
      const code = checkMathTextRenders(r.doc);
      if (code !== null) {
        expect(MATH_TEXT_ERROR_CODES as readonly string[], ctx).toContain(code);
        continue;
      }
      for (const p of r.doc.parts) {
        if (p.t !== "math") continue;
        const tex = mathToTex(p.m);
        expect(firstDisallowedControlSequence(tex, PDF_BODY_COMMANDS, ALLOWED_CONTROL_SYMBOLS), ctx).toBeNull();
        for (const m of tex.matchAll(/\\([A-Za-z]+)/g)) expect(PDF_BODY_COMMANDS.has(m[1]!), `${ctx} \\${m[1]}`).toBe(true);
        expect(tex.replace(/\\%/g, ""), ctx).not.toMatch(/[$%&#~]|\^\^/);
      }
      expect(mathTextToTex(r.doc), ctx).not.toMatch(/\^\^/);
    }
    expect(accepted).toBeGreaterThan(500);
  });
});
