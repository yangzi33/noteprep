import { describe, expect, it } from "vitest";
import { acceptedFixtureDocs } from "../fixtures/math-text/gen";
import { checkMathTextRenders, isMathTextDoc, MATHTEXT_PARSER_VERSION, parseMathText, type MathTextDoc } from "@/lib/math-text";

const doc = (m: unknown): unknown => ({ v: MATHTEXT_PARSER_VERSION, parts: [{ t: "math", m }] });
const x = { t: "var", name: "x" };

describe("isMathTextDoc", () => {
  it("accepts every accepted fixture document", () => {
    for (const d of acceptedFixtureDocs()) expect(isMathTextDoc(d)).toBe(true);
  });
  it("rejects non-documents, wrong versions and extra or missing keys", () => {
    for (const v of [null, undefined, 1, "x", [], {}, { v: "mathtext/1" }, { v: "mathtext/2", parts: [] }, { v: MATHTEXT_PARSER_VERSION, parts: [], extra: 1 },
      { v: MATHTEXT_PARSER_VERSION, parts: [{ t: "text" }] }, { v: MATHTEXT_PARSER_VERSION, parts: [{ t: "text", s: "a", z: 1 }] },
      { v: MATHTEXT_PARSER_VERSION, parts: [{ t: "html", s: "<b>" }] }, { v: MATHTEXT_PARSER_VERSION, parts: [{ t: "text", s: 3 }] }]) {
      expect(isMathTextDoc(v), JSON.stringify(v)).toBe(false);
    }
  });
  it("rejects malformed nodes", () => {
    const bad: unknown[] = [
      { t: "bin", op: "zz", l: { t: "num", v: "1" }, r: { t: "num", v: "1" } },
      { t: "bin", op: "+", l: x }, { t: "num", v: "01" }, { t: "num", v: "1e5" }, { t: "num", v: 1 }, { t: "num", v: "1234567890123" },
      { t: "var", name: "xy" }, { t: "var", name: "\\" }, { t: "greek", name: "gamma" }, { t: "raw", tex: "\\input{x}" },
      { t: "toString" }, { t: "__proto__" }, { t: "imp", items: [x] }, { t: "list", items: [] }, { t: "unary", op: "*", arg: x },
      { t: "rel", first: x, rest: [] }, { t: "rel", first: x, rest: [{ op: "~", rhs: x }] }, { t: "rel", first: x, rest: [{ op: "=", rhs: x, z: 1 }] },
      { t: "group", open: "{", body: x }, { t: "fn", name: "sec", arg: x }, { t: "fn", name: "sin", base: x, arg: x },
      { t: "sqrt", body: x, index: undefined }, { t: "sup", base: x }, { t: "var", name: "x", extra: true },
    ];
    for (const n of bad) expect(isMathTextDoc(doc(n)), JSON.stringify(n)).toBe(false);
  });
  it("accepts optional parts: a root index and a log base", () => {
    expect(isMathTextDoc(doc({ t: "sqrt", index: { t: "num", v: "3" }, body: x }))).toBe(true);
    expect(isMathTextDoc(doc({ t: "fn", name: "log", base: { t: "num", v: "2" }, arg: x }))).toBe(true);
  });
  it("rejects sparse arrays: holes in parts, items and rest", () => {
    const holeParts = { v: MATHTEXT_PARSER_VERSION, parts: new Array(1) };
    expect(isMathTextDoc(holeParts)).toBe(false);
    const holeItems: unknown[] = new Array(3);
    holeItems[0] = { t: "num", v: "1" };
    holeItems[2] = { t: "num", v: "2" };
    expect(isMathTextDoc(doc({ t: "list", items: holeItems }))).toBe(false);
    const holeRest: unknown[] = new Array(1);
    expect(isMathTextDoc(doc({ t: "rel", first: x, rest: holeRest }))).toBe(false);
    expect(isMathTextDoc(doc({ t: "list", items: [x, x] }))).toBe(true);
  });
  it("rejects inherited values, Object.create documents, class instances and a null prototype", () => {
    const proto = { v: MATHTEXT_PARSER_VERSION, parts: [] };
    expect(isMathTextDoc(Object.create(proto))).toBe(false);
    expect(isMathTextDoc(Object.assign(Object.create(proto), { v: MATHTEXT_PARSER_VERSION, parts: [] }))).toBe(false);
    const inheritedV = Object.create({ v: "1" }) as Record<string, unknown>;
    inheritedV.t = "num";
    expect(isMathTextDoc(doc(inheritedV))).toBe(false);
    class Doc { v = MATHTEXT_PARSER_VERSION; parts: unknown[] = []; }
    expect(isMathTextDoc(new Doc())).toBe(false);
    expect(isMathTextDoc(Object.assign(Object.create(null), { v: MATHTEXT_PARSER_VERSION, parts: [] }))).toBe(false);
  });
  it("rejects accessor properties, even one that answers validly on the first read", () => {
    let reads = 0;
    const getter = { t: "num" } as Record<string, unknown>;
    Object.defineProperty(getter, "v", { enumerable: true, get: () => (++reads === 1 ? "1" : "<img onerror=1>") });
    expect(isMathTextDoc(doc(getter))).toBe(false);
    const setter = { v: MATHTEXT_PARSER_VERSION } as Record<string, unknown>;
    Object.defineProperty(setter, "parts", { enumerable: true, get: () => [] });
    expect(isMathTextDoc(setter)).toBe(false);
  });
  it("rejects a __proto__ key from JSON.parse and symbol keys; accepts a JSON round trip of a real doc", () => {
    expect(isMathTextDoc(JSON.parse(`{"v":"mathtext/1","parts":[],"__proto__":{"x":1}}`))).toBe(false);
    expect(isMathTextDoc(JSON.parse(`{"v":"mathtext/1","parts":[{"t":"math","m":{"t":"var","name":"x","__proto__":{}}}]}`))).toBe(false);
    expect(isMathTextDoc({ v: MATHTEXT_PARSER_VERSION, parts: [], [Symbol("s")]: 1 })).toBe(false);
    const r = parseMathText("Solve \\(x+1=2\\).");
    if (!r.ok) throw new Error("parse");
    expect(isMathTextDoc(JSON.parse(JSON.stringify(r.doc)))).toBe(true);
  });
  it("a Proxy around a valid document cannot be detected and passes (documented limit)", () => {
    const r = parseMathText("\\(x\\)");
    if (!r.ok) throw new Error("parse");
    expect(isMathTextDoc(new Proxy(r.doc, {}))).toBe(true);
  });
  it("accepts the deepest parser-producible AST and rejects a 300-deep hand-built chain", () => {
    const r = parseMathText(`\\(${Array(150).fill("x").join("+")}\\)`);
    if (!r.ok) throw new Error(`parse ${r.code}`);
    expect(JSON.stringify(r.doc).match(/"t":"bin"/g)).toHaveLength(149);
    expect(isMathTextDoc(r.doc)).toBe(true);
    let deep: unknown = x;
    for (let i = 0; i < 300; i++) deep = { t: "bin", op: "+", l: deep, r: x };
    expect(isMathTextDoc(doc(deep))).toBe(false);
    let ok256: unknown = x;
    for (let i = 0; i < 200; i++) ok256 = { t: "bin", op: "+", l: ok256, r: x };
    expect(isMathTextDoc(doc(ok256))).toBe(true);
  });
  it("is total on absurdly deep and cyclic values", () => {
    let deep: unknown = x;
    for (let i = 0; i < 100_000; i++) deep = { t: "abs", body: deep };
    expect(isMathTextDoc(doc(deep))).toBe(false);
    const cyc: Record<string, unknown> = { t: "abs" };
    cyc.body = cyc;
    expect(isMathTextDoc(doc(cyc))).toBe(false);
  });
});

describe("checkMathTextRenders fails closed on a hand-built document", () => {
  it("returns render_tex_disallowed for a bin with an unknown operator (previously emitted 1undefined1)", () => {
    const hand = doc({ t: "bin", op: "zz", l: { t: "num", v: "1" }, r: { t: "num", v: "1" } }) as MathTextDoc;
    expect(checkMathTextRenders(hand)).toBe("render_tex_disallowed");
  });
  it("returns render_tex_disallowed for values that are not documents", () => {
    expect(checkMathTextRenders(null as unknown as MathTextDoc)).toBe("render_tex_disallowed");
    expect(checkMathTextRenders({ v: "mathtext/1" } as unknown as MathTextDoc)).toBe("render_tex_disallowed");
  });
});

describe("checkMathTextRenders applies the grammar to hand-built documents", () => {
  const one = (m: unknown): MathTextDoc => doc(m) as MathTextDoc;
  const text = (s: string): MathTextDoc => ({ v: MATHTEXT_PARSER_VERSION, parts: [{ t: "text", s }] });
  const bin = { t: "bin", op: "+", l: x, r: x };
  const cases: [string, MathTextDoc][] = [
    ["raw URL in text", text("see http://evil.example/x")],
    ["bidi character in text", text("abc\u202edef")],
    ["empty text", text("")],
    ["empty parts", { v: MATHTEXT_PARSER_VERSION, parts: [] }],
    ["sup of a bin (x+x^{2} would mean something else)", one({ t: "sup", base: bin, exp: x })],
    ["root index with a [ group", one({ t: "sqrt", index: { t: "group", open: "[", body: x }, body: x })],
    ["nested abs", one({ t: "abs", body: { t: "abs", body: x } })],
    ["two adjacent text parts", { v: MATHTEXT_PARSER_VERSION, parts: [{ t: "text", s: "a" }, { t: "text", s: "b" }] }],
  ];
  for (const [name, d] of cases) {
    it(`returns a typed code for ${name}`, () => {
      expect(checkMathTextRenders(d)).toBe("render_tex_disallowed");
    });
  }
  it("every parser-accepted fixture still returns null", () => {
    for (const d of acceptedFixtureDocs()) expect(checkMathTextRenders(d), JSON.stringify(d)).toBeNull();
  });
  it("rejects an 80000-item hand-built imp quickly, in the guard and in the check", () => {
    const big = one({ t: "imp", items: Array.from({ length: 80_000 }, () => x) });
    const started = performance.now();
    expect(isMathTextDoc(big)).toBe(false);
    expect(checkMathTextRenders(big)).toBe("render_tex_disallowed");
    expect(performance.now() - started).toBeLessThan(200);
  });
  it("caps the node count at 4000", () => {
    const wide = (n: number) => one({ t: "list", items: Array.from({ length: n }, () => x) });
    expect(isMathTextDoc(wide(3000))).toBe(true);
    expect(isMathTextDoc(wide(4000))).toBe(false); // 4000 leaves plus the list node
  });
});
