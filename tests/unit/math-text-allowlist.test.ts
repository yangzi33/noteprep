import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import golden from "../fixtures/math-text/golden.json";
import { firstDisallowedControlSequence } from "@/lib/latex/allowlist";
import { equationTex, operationText, solutionText } from "@/lib/latex/math";
import { RenderError } from "@/lib/latex/escape";
import { ALLOWED_BODY_COMMANDS, ALLOWED_CONTROL_SYMBOLS, PDF_BODY_COMMANDS } from "@/lib/latex/templates";
import { MATH_TEX_COMMANDS, MATH_TEX_SYMBOLS } from "@/lib/math-text/commands";
import { parseMathText } from "@/lib/math-text/parse";
import { mathTextToTex, mathToTex } from "@/lib/math-text/to-tex";
import { splitInlineMath } from "@/lib/ui/math-html";
/* eslint-disable @typescript-eslint/no-explicit-any -- fixture JSON is untyped here; the renderer functions validate shape */

interface QuestionFixture {
  name: string;
  question: Record<string, any>;
}
const fixtures: QuestionFixture[] = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/math/questions.json"), "utf8"));

/** Fixtures whose rendering does not throw RenderError (the renderer refuses some invalid questions). */
function renderableQuestions(): { question: any }[] {
  const out: { question: any }[] = [];
  for (const f of fixtures) {
    const q = f.question;
    try {
      const texts = [equationTex(q.problem.equation), solutionText(q.solution), ...q.steps.flatMap((s: any) => [operationText(s.op), equationTex(s.result)])];
      void texts;
      out.push({ question: q });
    } catch (e) {
      if (!(e instanceof RenderError) && !(e instanceof TypeError)) throw e;
    }
  }
  return out;
}

const scan = (tex: string) => firstDisallowedControlSequence(tex, PDF_BODY_COMMANDS, ALLOWED_CONTROL_SYMBOLS);
const mathScan = (tex: string) => firstDisallowedControlSequence(tex, MATH_TEX_COMMANDS, MATH_TEX_SYMBOLS);

describe("one macro allowlist", () => {
  it("the PDF body allowlist contains every MathText macro", () => {
    for (const c of MATH_TEX_COMMANDS) expect(PDF_BODY_COMMANDS.has(c)).toBe(true);
    for (const s of MATH_TEX_SYMBOLS) expect(ALLOWED_CONTROL_SYMBOLS.has(s)).toBe(true);
  });
  it("the deterministic set stays free of MathText-only macros, and the PDF set is exactly their union", () => {
    expect(PDF_BODY_COMMANDS.size).toBe(new Set([...ALLOWED_BODY_COMMANDS, ...MATH_TEX_COMMANDS]).size);
    for (const c of ALLOWED_BODY_COMMANDS) expect(PDF_BODY_COMMANDS.has(c)).toBe(true);
    expect(PDF_BODY_COMMANDS.has("sin")).toBe(true);
    expect(ALLOWED_BODY_COMMANDS.has("sin")).toBe(false);
  });
  it("every MathText macro is produced by at least one accepted fixture (no dead allowlist entries)", () => {
    const seen = new Set<string>();
    for (const row of golden.filter((r) => r.ok)) for (const m of (row.tex as string).matchAll(/\\([A-Za-z]+)/g)) seen.add(m[1]!);
    expect([...MATH_TEX_COMMANDS].filter((c) => !seen.has(c))).toEqual([]);
  });
  it("accepted MathText TeX passes the PDF scan, and each math span the MathText-only scan; {} between adjacent spans is fine", () => {
    for (const row of golden.filter((r) => r.ok)) {
      expect(scan(row.tex as string), row.in).toBeNull();
      const r = parseMathText(row.in);
      if (!r.ok) throw new Error(row.in);
      for (const p of r.doc.parts) if (p.t === "math") expect(mathScan(mathToTex(p.m)), row.in).toBeNull();
    }
    const r = parseMathText("\\(x\\)\\(x\\)");
    if (!r.ok) throw new Error("parse");
    const adjacent = mathTextToTex(r.doc);
    expect(adjacent).toBe("$x${}$x$");
    expect(scan(adjacent)).toBeNull();
    expect(mathScan(adjacent)).toBeNull(); // braces and $ are not control sequences; the scanner never sees them
  });
  it("the deterministic renderer's math stays inside the same allowlist", () => {
    const questions = renderableQuestions();
    expect(questions.length).toBeGreaterThan(5);
    for (const { question: q } of questions) {
      const texts = [equationTex(q.problem.equation), solutionText(q.solution), ...q.steps.flatMap((s: any) => [operationText(s.op), equationTex(s.result)])];
      for (const part of texts.flatMap((t: string) => splitInlineMath(t.includes("$") ? t : `$${t}$`)).filter((p) => p.kind === "math")) {
        expect(firstDisallowedControlSequence((part as { tex: string }).tex, MATH_TEX_COMMANDS, MATH_TEX_SYMBOLS)).toBeNull();
      }
    }
  });
});

describe("the scanner still refuses what assertTexIsSafe refused before", () => {
  it("refuses \\input", () => expect(scan(String.raw`\input{x}`)).toBe("input"));
  it("refuses \\write18, \\def, \\csname, \\catcode, \\openin", () => {
    expect(scan(String.raw`\write18{ls}`)).toBe("write");
    expect(scan(String.raw`\def\x{y}`)).toBe("def");
    expect(scan(String.raw`\csname relax\endcsname`)).toBe("csname");
    expect(scan(String.raw`\catcode` + "`a=12")).toBe("catcode");
    expect(scan(String.raw`\openin1=f`)).toBe("openin");
  });
  it("names are matched whole: prefixes and extensions of allowed words are refused", () => {
    expect(scan(String.raw`\pin`)).toBe("pin");
    expect(scan(String.raw`\fracs`)).toBe("fracs");
    expect(scan(String.raw`\sinx`)).toBe("sinx");
    expect(scan(String.raw`\fra`)).toBe("fra");
    expect(scan(String.raw`\frac{1}{2}`)).toBeNull();
  });
  it("control symbols: the existing set is kept, others are refused", () => {
    expect(scan(String.raw`\&`)).toBeNull(); // allowed before (escapeText emits it)
    expect(scan(String.raw`\#`)).toBeNull();
    expect(scan(String.raw`\^`)).toBe("^");
    expect(scan(String.raw`\~`)).toBe("~");
    expect(scan(String.raw`\ `)).toBe(" ");
    expect(mathScan(String.raw`\&`)).toBe("&"); // the math-only scan is stricter
  });
  it("a double backslash consumes the second one; a letter after it is plain text", () => {
    expect(scan(String.raw`\\input`)).toBeNull();
    expect(scan(String.raw`\\\input`)).toBe("input");
  });
  it("the scanner finds only backslash sequences; ^^ notation and comments are caught by assertTexIsSafe's other checks", () => {
    expect(scan("^^5cinput")).toBeNull();
    expect(scan("^^5c^^5c")).toBeNull();
  });
});
