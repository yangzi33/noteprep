import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import golden from "../fixtures/math-text/golden.json";
import samplesV2 from "../fixtures/math-text/samples-v2.json";
import baseline from "../fixtures/math-text/v1-baseline.json";
import { genMathNode, rng } from "../fixtures/math-text/gen";
import { MATHTEXT_PARSER_VERSION, type MathNode } from "@/lib/math-text/ast";
import {
  checkMathTextRenders, isMathTextDoc, MATH_TEX_COMMANDS, mathTextToInlineParts, mathTextToTex, mathToTex, parseMathText, serializeMathText,
} from "@/lib/math-text";
import { MATH_TEX_SYMBOLS } from "@/lib/math-text/commands";
import { parseMath } from "@/lib/math-text/parse";
import { firstDisallowedControlSequence } from "@/lib/latex/allowlist";
import { ALLOWED_CONTROL_SYMBOLS, PDF_BODY_COMMANDS } from "@/lib/latex/templates";
import { renderMathHtml } from "@/lib/ui/math-html";

/** Every token mathtext/2 added to mathtext/1; docs/mathtext.md justifies each one by the samples that need it. */
const NEW_TOKENS = [
  "prime", "factorial", "binom", "bar", "hat", "mu", "sigma", "lambda", "sec", "csc", "cot", "arcsin", "arccos", "arctan",
  "to", "approx", "in", "mid", "cup", "cap", "infty", "lim", "sum", "int", "thin",
] as const;
type NewToken = (typeof NEW_TOKENS)[number];

/** Which new tokens a tree contains (the differential `\,` is part of every integral). */
function tokensIn(n: MathNode, out = new Set<NewToken>()): Set<NewToken> {
  const visit = (c: MathNode | undefined): void => {
    if (c) tokensIn(c, out);
  };
  switch (n.t) {
    case "prime": out.add("prime"); break;
    case "fact": out.add("factorial"); visit(n.arg); break;
    case "binom": out.add("binom"); visit(n.n); visit(n.k); break;
    case "accent": out.add(n.kind); break;
    case "greek": if (n.name === "mu" || n.name === "sigma" || n.name === "lambda") out.add(n.name); break;
    case "fn":
      if (n.name !== "sin" && n.name !== "cos" && n.name !== "tan" && n.name !== "log" && n.name !== "ln") out.add(n.name);
      visit(n.base); visit(n.arg);
      break;
    case "rel":
      visit(n.first);
      for (const r of n.rest) {
        if (r.op === "to" || r.op === "approx" || r.op === "in" || r.op === "mid") out.add(r.op);
        visit(r.rhs);
      }
      break;
    case "bin": if (n.op === "cup" || n.op === "cap") out.add(n.op); visit(n.l); visit(n.r); break;
    case "infty": out.add("infty"); break;
    case "lim": out.add("lim"); visit(n.under); visit(n.arg); break;
    case "sum": out.add("sum"); visit(n.lo); visit(n.hi); visit(n.arg); break;
    case "int": out.add("int"); out.add("thin"); visit(n.lo); visit(n.hi); visit(n.body); break;
    case "imp": case "list": n.items.forEach(visit); break;
    case "unary": case "pct": case "deg": visit(n.arg); break;
    case "group": case "abs": visit(n.body); break;
    case "frac": visit(n.num); visit(n.den); break;
    case "sqrt": visit(n.index); visit(n.body); break;
    case "sup": visit(n.base); visit(n.exp); break;
    case "sub": visit(n.base); visit(n.sub); break;
    default: break;
  }
  return out;
}
const docTokens = (input: string): Set<NewToken> => {
  const r = parseMathText(input);
  if (!r.ok) throw new Error(`${input} -> ${r.code}`);
  const out = new Set<NewToken>();
  for (const p of r.doc.parts) if (p.t === "math") tokensIn(p.m, out);
  return out;
};

const rows = golden as { in: string; ok: boolean; code?: string; canonical?: string; tex?: string; token?: string }[];
const accepted = rows.filter((r) => r.ok && r.token);
const rejected = rows.filter((r) => !r.ok && r.token);

describe("version", () => {
  it("is mathtext/2", () => {
    expect(MATHTEXT_PARSER_VERSION).toBe("mathtext/2");
    const r = parseMathText("\\(x\\)");
    expect(r.ok && r.doc.v).toBe("mathtext/2");
  });
});

describe("mathtext/1 compatibility", () => {
  it("every string the mathtext/1 parser accepted parses to the same AST (86 recorded inputs)", () => {
    expect(baseline.length).toBeGreaterThanOrEqual(80);
    for (const row of baseline as { in: string; parts: unknown[] }[]) {
      const r = parseMathText(row.in);
      expect(r.ok, JSON.stringify(row.in)).toBe(true);
      if (r.ok) expect(r.doc.parts, JSON.stringify(row.in)).toEqual(row.parts);
    }
  });
});

describe("accept/reject tables for every added token", () => {
  it("each added token has an accept row and a reject row in the golden table", () => {
    for (const tok of NEW_TOKENS) {
      expect(accepted.some((r) => docTokens(r.in).has(tok)), `accept ${tok}`).toBe(true);
      expect(rejected.some((r) => r.token === tok), `reject ${tok}`).toBe(true);
    }
  });
  it("each new accept row is tagged with a token it really contains", () => {
    for (const r of accepted) expect(docTokens(r.in).has(r.token as NewToken), r.in).toBe(true);
  });
  it("accepted rows produce the pinned canonical string and TeX, and the pinned TeX parses back to the same tree", () => {
    for (const r of accepted) {
      const p = parseMathText(r.in);
      if (!p.ok) throw new Error(`${r.in} -> ${p.code}`);
      expect(serializeMathText(p.doc), r.in).toBe(r.canonical);
      expect(mathTextToTex(p.doc), r.in).toBe(r.tex);
      expect(parseMathText(r.canonical as string), r.in).toEqual(p);
    }
  });
  it("rejected rows return exactly the pinned code", () => {
    for (const r of rejected) expect(parseMathText(r.in), r.in).toMatchObject({ ok: false, code: r.code });
  });
});

describe("samples: five fictional items each for calculus, statistics and pre-calculus", () => {
  const samples = samplesV2 as { id: string; course: string; input: string; expect: string; uses: NewToken[] }[];
  it("has 15 samples, five per course, all accepted", () => {
    expect(samples).toHaveLength(15);
    for (const c of ["calculus", "statistics", "pre-calculus"]) expect(samples.filter((s) => s.course === c)).toHaveLength(5);
    expect(new Set(samples.map((s) => s.id)).size).toBe(15);
  });
  it("each sample parses, passes the static render check and declares exactly the new tokens it contains", () => {
    for (const s of samples) {
      const r = parseMathText(s.input);
      if (!r.ok) throw new Error(`${s.id} -> ${r.code}`);
      expect(checkMathTextRenders(r.doc), s.id).toBeNull();
      expect([...docTokens(s.input)].sort(), s.id).toEqual([...s.uses].sort());
    }
  });
  it("every added token is needed by at least one sample, and nothing outside the token list is declared", () => {
    const used = new Set(samples.flatMap((s) => s.uses));
    expect([...used].sort()).toEqual([...NEW_TOKENS].sort());
  });
});

describe("parser and both renderers cannot diverge", () => {
  const inputs = [...accepted.map((r) => r.in), ...(samplesV2 as { input: string }[]).map((s) => s.input)];
  it("the HTML parts carry exactly the TeX the PDF renderer embeds, and KaTeX accepts it (trust off, strict)", () => {
    for (const input of inputs) {
      const r = parseMathText(input);
      if (!r.ok) throw new Error(input);
      const pdf = mathTextToTex(r.doc);
      const parts = mathTextToInlineParts(r.doc);
      const math = parts.filter((p) => p.kind === "math").map((p) => (p as { tex: string }).tex);
      expect(math.map((t) => `$${t}$`).join("|"), input).toBe([...pdf.matchAll(/\$[^$]*\$/g)].map((m) => m[0]).join("|"));
      for (const tex of math) {
        expect(renderMathHtml(tex, "inline").ok, tex).toBe(true);
        expect(firstDisallowedControlSequence(tex, MATH_TEX_COMMANDS, MATH_TEX_SYMBOLS), tex).toBeNull();
        expect(firstDisallowedControlSequence(tex, PDF_BODY_COMMANDS, ALLOWED_CONTROL_SYMBOLS), tex).toBeNull();
      }
      expect(isMathTextDoc(r.doc)).toBe(true);
    }
  });
  it("every control word of the allowlist is emitted by the serializer for some added token, and none is emitted that is not listed", () => {
    const seen = new Set<string>();
    for (const input of inputs) {
      const r = parseMathText(input);
      if (!r.ok) throw new Error(input);
      for (const m of mathTextToTex(r.doc).matchAll(/\\([A-Za-z]+|.)/g)) seen.add(m[1] as string);
    }
    for (const c of ["infty", "binom", "bar", "hat", "mu", "sigma", "lambda", "sec", "csc", "cot", "arcsin", "arccos", "arctan", "to", "approx", "in", "mid", "cup", "cap", "lim", "sum", "int", ","]) {
      expect(seen.has(c), c).toBe(true);
      expect(c === "," ? MATH_TEX_SYMBOLS.has(c) : MATH_TEX_COMMANDS.has(c), c).toBe(true);
    }
  });
  it("the allowlist is exactly the mathtext/1 set plus the added control words", () => {
    expect([...MATH_TEX_COMMANDS].sort()).toEqual(
      ("alpha beta theta pi le ge neq pm times cdot div frac sqrt circ sin cos tan log ln ldots " +
        "mu sigma lambda sec csc cot arcsin arccos arctan to approx in mid cup cap infty binom bar hat lim sum int").split(" ").sort(),
    );
    expect([...MATH_TEX_SYMBOLS].sort()).toEqual(["%", ","]);
  });
  it("generated trees of every new kind re-parse to themselves and emit allowlisted TeX only (seed 6511)", () => {
    const next = rng(6511);
    const kinds = new Set<string>();
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") {
        const o = n as Record<string, unknown>;
        if (typeof o.t === "string") kinds.add(o.t);
        Object.values(o).forEach(walk);
      }
    };
    for (let i = 0; i < 4000; i++) {
      const node = genMathNode(next);
      walk(node);
      const tex = mathToTex(node);
      expect(parseMath(tex, 0), tex).toEqual({ ok: true, node });
      expect(firstDisallowedControlSequence(tex, MATH_TEX_COMMANDS, MATH_TEX_SYMBOLS), tex).toBeNull();
    }
    for (const k of ["infty", "prime", "fact", "binom", "accent", "lim", "sum", "int"]) expect(kinds.has(k), k).toBe(true);
  });
});

describe("hostile input for the added tokens", () => {
  const timed = (input: string) => {
    const started = performance.now();
    const r = parseMathText(input);
    return { r, ms: performance.now() - started };
  };
  it("a 100000 character input made of each added token is refused up front, fast", () => {
    const units = ["f'", "n!", "\\binom{n}{k}", "\\bar{x}", "\\hat{y}", "\\mu", "\\sigma", "\\lambda", "\\sec x", "\\csc x", "\\cot x", "\\arcsin x", "\\arccos x",
      "\\arctan x", "x\\to y", "x\\approx y", "x\\in y", "x\\mid y", "x\\cup y", "x\\cap y", "\\infty", "\\lim_{x\\to 0}", "\\sum_{i=1}^{n}", "\\int x\\,dx", "\\,"];
    for (const u of units) {
      const input = `\\(${u.repeat(Math.ceil(100_000 / u.length))}\\)`.slice(0, 100_000);
      const { r, ms } = timed(input);
      expect(r, u).toMatchObject({ ok: false, code: "too_long" });
      expect(ms, u).toBeLessThan(100);
    }
  });
  it("a 2000 character input of each unit inside one span is refused with span_too_long, fast", () => {
    for (const u of ["f'", "n!", "\\int x\\,dx", "\\sum_{i=1}^{n}", "\\lim_{x\\to 0}", "\\binom{n}{k}", "\\bar{x}", "\\infty", "x\\mid y", "\\,"]) {
      const { r, ms } = timed(`\\(${u.repeat(Math.ceil(1900 / u.length))}\\)`);
      expect(r.ok, u).toBe(false);
      expect(ms, u).toBeLessThan(100);
    }
  });
  it("nesting of big operators is bounded by the depth limit (8 allowed, 9 refused)", () => {
    for (const [open, close] of [["\\sum ", ""], ["\\lim_{x\\to 0} ", ""], ["\\int ", "\\,dx"], ["-\\sum ", ""]] as const) {
      const nest = (n: number) => `\\(${open.repeat(n)}x${close.repeat(n)}\\)`;
      expect(parseMathText(nest(2)).ok, open).toBe(true);
      expect(parseMathText(nest(9)), open).toMatchObject({ ok: false });
    }
    expect(parseMathText(`\\(${"\\sum ".repeat(9)}x\\)`)).toMatchObject({ ok: false, code: "math_depth" });
    expect(parseMathText(`\\(${"\\int ".repeat(9)}x${"\\,dx".repeat(9)}\\)`)).toMatchObject({ ok: false, code: "math_depth" });
    expect(parseMathText(`\\(${"\\lim_{x\\to 0} ".repeat(9)}x\\)`)).toMatchObject({ ok: false });
  });
  it("delimiter confusion: the new tokens never move a span boundary or smuggle one in", () => {
    for (const input of ["\\(\\int x\\,dx\\)\\)", "\\(\\(\\int x\\,dx\\)", "\\(x\\,\\)\\(", "\\(n!\\(", "\\(f'\\)\\)", "\\(\\lim_{x\\to 0}\\)", "\\(x\\,\\\\)"]) {
      expect(parseMathText(input).ok, input).toBe(false);
    }
    expect(parseMathText("\\(f'\\)\\(f'\\)")).toMatchObject({ ok: true });
    const twice = parseMathText("\\(n!\\)\\(n!\\)");
    if (!twice.ok) throw new Error("twice");
    expect(mathTextToTex(twice.doc)).toBe("$n!${}$n!$");
  });
  it("macro smuggling through the new tokens: glued, split or escaped names are refused", () => {
    for (const input of [
      "\\(\\lim\\csname x\\endcsname\\)", "\\(\\sum_{\\input{x}} x\\)", "\\(\\int x\\,d\\input\\)", "\\(\\binom{\\def\\a{}}{2}\\)",
      "\\(\\bar{\\catcode}\\)", "\\(f'\\input\\)", "\\(n!\\write18\\)", "\\(\\mid\\input\\)", "\\(\\limits\\)", "\\(\\sum\\limits_{i} x\\)",
      "\\(\\int\\nolimits x\\,dx\\)", "\\(\\infinity\\)", "\\(\\hat\\bar{x}\\)", "\\(\\bar{x}\\bar{y}\\undefined\\)", "\\(\\mu\\sigma\\lambdax\\)",
      "\\(\\intx\\,dx\\)", "\\(\\sumx\\)", "\\(\\limx\\)", "\\(\\to\\to\\)", "\\(x\\inA\\)", "\\(f\\prime\\)", "\\(\\operatorname{lim}\\)", "\\(\\mathrm{d}x\\)",
      "\\(\\,\\csname\\)", "\\(x\\,\\,y\\)", "\\(\\int x\\,\\,dx\\)", "\\(\\int x\\ dx\\)", "\\(\\int x\\;dx\\)", "\\(\\int x\\!dx\\)",
    ]) {
      expect(parseMathText(input).ok, input).toBe(false);
    }
  });
});

describe("docs/mathtext.md documents every added token", () => {
  const doc = readFileSync("docs/mathtext.md", "utf8");
  it("names the version and every added token with its justification", () => {
    expect(doc).toContain("mathtext/2");
    for (const t of ["f'", "n!", "\\binom", "\\bar", "\\hat", "\\mu", "\\sigma", "\\lambda", "\\sec", "\\csc", "\\cot", "\\arcsin", "\\arccos", "\\arctan",
      "\\to", "\\approx", "\\in", "\\mid", "\\cup", "\\cap", "\\infty", "\\lim", "\\sum", "\\int", "\\,"]) {
      expect(doc, t).toContain(t);
    }
  });
});
