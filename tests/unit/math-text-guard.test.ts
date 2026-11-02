import { describe, expect, it } from "vitest";
import { acceptedFixtureDocs } from "../fixtures/math-text/gen";
import { checkMathTextRenders, isMathTextDoc, MATHTEXT_PARSER_VERSION, type MathTextDoc } from "@/lib/math-text";

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
