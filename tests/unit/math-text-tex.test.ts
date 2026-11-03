import { describe, expect, it } from "vitest";
import golden from "../fixtures/math-text/golden.json";
import samples from "../fixtures/math-text/samples.json";
import { genMathNode, rng } from "../fixtures/math-text/gen";
import { MATHTEXT_LIMITS, type MathNode } from "@/lib/math-text/ast";
import { MATH_TEX_COMMANDS, MATH_TEX_SYMBOLS } from "@/lib/math-text/commands";
import { parseMath, parseMathText } from "@/lib/math-text/parse";
import { parseMathText as publicParse } from "@/lib/math-text";
import { mathTextToTex, mathToTex, serializeMathText } from "@/lib/math-text/to-tex";
import { escapeText, escapeTextFragment, RenderError } from "@/lib/latex/escape";

const accepted = golden.filter((r) => r.ok);
const mustParse = (input: string) => {
  const r = parseMathText(input);
  if (!r.ok) throw new Error(`${input} -> ${r.code}`);
  return r;
};

describe("mathToTex and the canonical serializer", () => {
  it("emits the golden canonical form and TeX", () => {
    for (const row of accepted) {
      const r = mustParse(row.in);
      expect(serializeMathText(r.doc), row.in).toBe(row.canonical);
      expect(mathTextToTex(r.doc), row.in).toBe(row.tex);
    }
  });
  it("round trips: parse(serialize(doc)) equals doc for every accepted fixture", () => {
    for (const input of [...accepted.map((r) => r.in), ...samples.filter((s) => s.expect === "accept").map((s) => s.input)]) {
      const a = mustParse(input);
      expect(parseMathText(serializeMathText(a.doc)), input).toEqual(a);
    }
  });
  it("emitted tex re-parses to the same AST (5000 generated trees, seed 20261101)", () => {
    const next = rng(20261101);
    for (let i = 0; i < 5000; i++) {
      const node = genMathNode(next);
      expect(parseMath(mathToTex(node), 0), mathToTex(node)).toEqual({ ok: true, node });
    }
  });
  it("generated trees are varied and reach the depth limit constructs", () => {
    const next = rng(20261101);
    const kinds = new Set<string>();
    const walk = (n: MathNode): void => {
      kinds.add(n.t);
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) v.forEach((x) => (x && typeof x === "object" ? walk("rhs" in x ? x.rhs : (x as MathNode)) : 0));
        else if (v && typeof v === "object") walk(v as MathNode);
      }
    };
    for (let i = 0; i < 5000; i++) walk(genMathNode(next));
    for (const k of ["num", "var", "greek", "ldots", "bin", "imp", "unary", "rel", "list", "group", "abs", "frac", "sqrt", "sup", "sub", "pct", "deg", "fn",
      "infty", "prime", "fact", "binom", "accent", "lim", "sum", "int"]) {
      expect(kinds.has(k), k).toBe(true);
    }
  });
  it("emits only allowlisted control words", () => {
    const next = rng(7);
    for (let i = 0; i < 2000; i++) {
      for (const m of mathToTex(genMathNode(next)).matchAll(/\\([A-Za-z]+|.)/g)) {
        expect(/^[A-Za-z]+$/.test(m[1]!) ? MATH_TEX_COMMANDS.has(m[1]!) : MATH_TEX_SYMBOLS.has(m[1]!)).toBe(true);
      }
    }
  });
  it("allowlist is exactly the documented set", () => {
    expect([...MATH_TEX_COMMANDS].sort()).toEqual(
      ("alpha beta theta pi le ge neq pm times cdot div frac sqrt circ sin cos tan log ln ldots " +
        "mu sigma lambda sec csc cot arcsin arccos arctan to approx in mid cup cap infty binom bar hat lim sum int").split(" ").sort(),
    );
    expect([...MATH_TEX_SYMBOLS].sort()).toEqual(["%", ","]);
  });
  it("separates control words from following letters and adjacent digits", () => {
    // The parser now refuses `\sin 3 4` (math_adjacent_numbers); the serializer's digit separation is kept for hand-built trees.
    const n = (v: string): MathNode => ({ t: "num", v });
    expect(mathToTex({ t: "imp", items: [{ t: "fn", name: "sin", arg: n("3") }, n("4")] })).toBe(String.raw`\sin 3 4`);
    expect(mathToTex(parseOk(String.raw`a \times b`))).toBe(String.raw`a\times b`);
    expect(mathToTex(parseOk(String.raw`\pm \pm x`))).toBe(String.raw`\pm\pm x`);
    expect(mathToTex(parseOk(String.raw`\sin \cos x`))).toBe(String.raw`\sin \cos x`);
    expect(mathToTex(parseOk(String.raw`\pi x`))).toBe(String.raw`\pi x`);
  });
  it("handles the deepest chain the parser can produce with bounded output", () => {
    const chain = "x+".repeat(149) + "x"; // 299 characters: about 149 nested left bin nodes
    const alt = "1+".repeat(149) + "1";
    for (const src of [chain, alt, "x^2".repeat(99), "x_1^2".repeat(59), "1,".repeat(149) + "1"]) {
      expect(src.length).toBeLessThanOrEqual(MATHTEXT_LIMITS.maxSpanChars);
      const node = parseOk(src);
      const tex = mathToTex(node);
      expect(parseMath(tex, 0)).toEqual({ ok: true, node });
      expect(tex.length).toBeLessThanOrEqual(2 * src.length);
    }
    const wrapped = mustParse(String.raw`\(` + chain + String.raw`\)`);
    expect(mathTextToTex(wrapped.doc)).toBe(`$${chain}$`);
  });
});

describe("round-trip admission at the public entry point (docs/mathtext.md)", () => {
  it("rejects a depth-8 source with an unbraced script: its canonical form needs one more depth level", () => {
    const src = `\\(${"(".repeat(8)}x^2${")".repeat(8)}\\)`;
    expect(parseMathText(src).ok).toBe(true);
    expect(publicParse(src)).toMatchObject({ ok: false, code: "math_depth" });
  });
  it("rejects a 297-character span whose canonical form exceeds the 300-character span cap", () => {
    const src = `\\(${"x^2".repeat(99)}\\)`;
    expect(parseMathText(src).ok).toBe(true);
    expect(publicParse(src)).toMatchObject({ ok: false, code: "span_too_long" });
  });
});

describe("mathTextToTex", () => {
  it("escapes text and keeps the spaces around math", () => {
    const r = mustParse(String.raw`Pay $5 & tax for \(x\) items`);
    expect(mathTextToTex(r.doc)).toBe(String.raw`Pay \$5 \& tax for $x$ items`);
  });
  it("never emits two adjacent math spans as display math", () => {
    const r = mustParse(String.raw`\(x\)\(x\)`);
    expect(mathTextToTex(r.doc)).toBe("$x${}$x$");
    expect(mathTextToTex(r.doc)).not.toContain("$$");
    expect(serializeMathText(r.doc)).toBe(String.raw`\(x\)\(x\)`);
    expect(parseMathText(serializeMathText(r.doc))).toEqual(r);
  });
  it("wraps text brackets through the escape helper", () => {
    const r = mustParse(String.raw`See [1] and \(x\)`);
    expect(mathTextToTex(r.doc)).toBe(String.raw`See {[}1{]} and $x$`);
  });
  it("throws text_too_long like escapeText", () => {
    expect(() => mathTextToTex({ v: "mathtext/2", parts: [{ t: "text", s: "a".repeat(5001) }] })).toThrow(RenderError);
  });
});

describe("escapeTextFragment", () => {
  it("keeps edge spaces that escapeText trims, with identical escaping", () => {
    expect(escapeTextFragment("  a  &  b ")).toBe(String.raw` a \& b `);
    expect(escapeText("  a  &  b ")).toBe(String.raw`a \& b`);
  });
});

function parseOk(src: string): MathNode {
  const r = parseMath(src, 0);
  if (!r.ok) throw new Error(`${src} -> ${r.code}`);
  return r.node;
}
