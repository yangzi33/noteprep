import { describe, expect, it } from "vitest";
import golden from "../fixtures/math-text/golden.json";
import samples from "../fixtures/math-text/samples.json";
import { HOSTILE_CASES } from "../fixtures/math-text/hostile";
import { parseMath, parseMathText } from "@/lib/math-text/parse";
import type { MathNode } from "@/lib/math-text/ast";

const ok = (src: string): MathNode => {
  const r = parseMath(src, 0);
  if (!r.ok) throw new Error(r.code);
  return r.node;
};

describe("parseMath", () => {
  it("parses left-associative binary operators and implicit products", () => {
    expect(ok("a-b-c")).toEqual({ t: "bin", op: "-", l: { t: "bin", op: "-", l: { t: "var", name: "a" }, r: { t: "var", name: "b" } }, r: { t: "var", name: "c" } });
    expect(ok("2x")).toEqual({ t: "imp", items: [{ t: "num", v: "2" }, { t: "var", name: "x" }] });
  });
  it("binds implicit products tighter than explicit multiplication", () => {
    expect(ok(String.raw`2\times 3x`)).toEqual({
      t: "bin", op: "times", l: { t: "num", v: "2" },
      r: { t: "imp", items: [{ t: "num", v: "3" }, { t: "var", name: "x" }] },
    });
  });
  it("parses chained relations, lists, degree and log base", () => {
    expect(ok(String.raw`1<x\le 5`)).toMatchObject({ t: "rel", rest: [{ op: "<" }, { op: "le" }] });
    expect(ok("(2, 3)")).toMatchObject({ t: "group", open: "(", body: { t: "list" } });
    expect(ok(String.raw`30^\circ`)).toEqual({ t: "deg", arg: { t: "num", v: "30" } });
    expect(ok(String.raw`30^{\circ}`)).toEqual({ t: "deg", arg: { t: "num", v: "30" } });
    expect(ok(String.raw`\log_{2} 8`)).toMatchObject({ t: "fn", name: "log", base: { t: "num", v: "2" }, arg: { t: "num", v: "8" } });
  });
  it("never produces single-item imp or list", () => {
    expect(ok("(x)")).toEqual({ t: "group", open: "(", body: { t: "var", name: "x" } });
  });
  it("orders scripts as sup(sub(base))", () => {
    const want = { t: "sup", base: { t: "sub", base: { t: "var", name: "x" }, sub: { t: "num", v: "3" } }, exp: { t: "num", v: "2" } };
    expect(ok("x^2_3")).toEqual(want);
    expect(ok("x_3^2")).toEqual(want);
  });
  it("accepts three nested exponents", () => {
    expect(parseMath("2^{3^{4^{5}}}", 0)).toMatchObject({ ok: true });
  });
  it.each([
    ["2 3", "math_adjacent_numbers"], ["(x", "math_unbalanced"], ["(x]", "math_unbalanced"], ["{x}", "math_brace_misuse"],
    ["x}", "math_brace_misuse"], ["x^", "math_bad_script"], ["x^{2}^{3}", "math_bad_script"], ["x^12", "math_bad_script"],
    [String.raw`\sin_{2} x`, "math_bad_script"], [String.raw`\sin^{2} x`, "math_bad_script"],
    [String.raw`30^\circ_2`, "math_bad_script"], [String.raw`50\%^2`, "math_bad_script"],
    [String.raw`\sqrt{}`, "math_unexpected_token"], ["^^5c", "math_unexpected_token"], [String.raw`\frac\input x`, "math_unknown_command"],
    ["||x||", "math_unexpected_token"], ["|a||b|", "math_unexpected_token"], ["|x+|y||", "math_unexpected_token"],
    [String.raw`2^{3^{4^{5^{6}}}}`, "math_exponent_depth"], ["(".repeat(9) + "x" + ")".repeat(9), "math_depth"],
  ])("rejects %s as %s", (src, code) => {
    const r = parseMath(src, 0);
    expect(r).toMatchObject({ ok: false, code });
    expect(typeof (r as { at: number }).at).toBe("number");
  });
  it("reports at relative to the offset", () => {
    expect(parseMath("2 3", 10)).toMatchObject({ ok: false, at: 12 });
  });
  it("bounded depth without recursion blow-up", () => {
    const t0 = Date.now();
    expect(parseMath("(".repeat(10_000) + "x" + ")".repeat(10_000), 0)).toMatchObject({ ok: false, code: "math_depth" });
    expect(parseMath("-".repeat(10_000) + "x", 0)).toMatchObject({ ok: false, code: "math_depth" });
    expect(parseMath(String.raw`\sin `.repeat(10_000) + "x", 0)).toMatchObject({ ok: true });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

// Shape check for accepted ASTs: every node is a known type with well-formed children.
function assertNode(n: unknown): void {
  const o = n as Record<string, unknown>;
  const node = (x: unknown) => assertNode(x);
  switch (o.t) {
    case "num": expect(o.v).toMatch(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/); return;
    case "var": expect(o.name).toMatch(/^[A-Za-z]$/); return;
    case "greek": expect(["alpha", "beta", "theta", "pi"]).toContain(o.name); return;
    case "ldots": return;
    case "bin": expect(["+", "-", "pm", "times", "cdot", "div", "/"]).toContain(o.op); node(o.l); node(o.r); return;
    case "imp": case "list": expect((o.items as unknown[]).length).toBeGreaterThanOrEqual(2); (o.items as unknown[]).forEach(node); return;
    case "unary": expect(["-", "+", "pm"]).toContain(o.op); node(o.arg); return;
    case "rel": node(o.first); expect((o.rest as unknown[]).length).toBeGreaterThanOrEqual(1);
      for (const r of o.rest as { op: string; rhs: unknown }[]) { expect(["=", "<", ">", "le", "ge", "neq"]).toContain(r.op); node(r.rhs); } return;
    case "group": expect(["(", "["]).toContain(o.open); node(o.body); return;
    case "abs": node(o.body); return;
    case "frac": node(o.num); node(o.den); return;
    case "sqrt": if (o.index !== undefined) node(o.index); node(o.body); return;
    case "sup": node(o.base); node(o.exp); return;
    case "sub": node(o.base); node(o.sub); return;
    case "pct": case "deg": node(o.arg); return;
    case "fn": expect(["sin", "cos", "tan", "log", "ln"]).toContain(o.name); if (o.base !== undefined) { expect(o.name).toBe("log"); node(o.base); } node(o.arg); return;
    default: throw new Error(`unknown node ${String(o.t)}`);
  }
}
function assertDoc(r: ReturnType<typeof parseMathText>): void {
  if (!r.ok) return;
  expect(r.doc.v).toBe("mathtext/1");
  r.doc.parts.forEach((p, i) => {
    if (p.t === "math") assertNode(p.m);
    else expect(i === 0 || r.doc.parts[i - 1]!.t !== "text").toBe(true);
  });
}

describe("parseMathText over the fixtures", () => {
  it("matches every golden row's ok/code", () => {
    let n = 0;
    for (const row of golden) {
      const r = parseMathText(row.in);
      expect(r, JSON.stringify(row.in.slice(0, 60))).toMatchObject(row.ok ? { ok: true } : { ok: false, code: row.code });
      assertDoc(r);
      n++;
    }
    expect(n).toBe(golden.length);
  });
  it("matches every sample's expectation", () => {
    for (const s of samples) {
      const r = parseMathText(s.input);
      expect(r, s.id).toMatchObject(s.expect === "accept" ? { ok: true } : { ok: false, code: (s.expect as { reject: string }).reject });
      assertDoc(r);
    }
  });
  it("matches every hostile row", () => {
    let n = 0;
    for (const h of HOSTILE_CASES) {
      const r = parseMathText(h.in);
      if (h.expect === "reject") expect(r, JSON.stringify(h.in.slice(0, 40))).toMatchObject({ ok: false, code: h.code });
      else assertDoc(r);
      n++;
    }
    expect(n).toBe(HOSTILE_CASES.length);
  });
  it("returns text and math parts with the parser version", () => {
    expect(parseMathText(String.raw`Solve \(x=1\).`)).toEqual({
      ok: true,
      doc: { v: "mathtext/1", parts: [{ t: "text", s: "Solve " }, { t: "math", m: { t: "rel", first: { t: "var", name: "x" }, rest: [{ op: "=", rhs: { t: "num", v: "1" } }] } }, { t: "text", s: "." }] },
    });
  });
});
