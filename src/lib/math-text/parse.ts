import {
  MATHTEXT_LIMITS, MATHTEXT_PARSER_VERSION,
  type BinOp, type FnName, type Greek, type MathNode, type MathTextErrorCode, type MathTextPart, type MathTextResult, type RelOp,
} from "@/lib/math-text/ast";
import { splitMathText } from "@/lib/math-text/split";
import { tokenizeMath, type Token } from "@/lib/math-text/tokenize";

export type ParseResult = { ok: true; node: MathNode } | { ok: false; code: MathTextErrorCode; at: number };

class Fail {
  constructor(readonly code: MathTextErrorCode, readonly at: number) {}
}

const GREEK: ReadonlySet<string> = new Set(["alpha", "beta", "theta", "pi", "mu", "sigma", "lambda"]);
const FNS: ReadonlySet<string> = new Set(["sin", "cos", "tan", "log", "ln", "sec", "csc", "cot", "arcsin", "arccos", "arctan"]);
const REL_CMDS: ReadonlySet<string> = new Set(["le", "ge", "neq", "to", "approx", "in", "mid"]);
// `infty` is deliberately absent: like `\ldots` it starts an operand but never follows one implicitly.
const IMPLICIT_CMDS: ReadonlySet<string> = new Set([...GREEK, ...FNS, "frac", "sqrt", "binom", "bar", "hat", "lim", "sum", "int"]);
const MUL_OPS: Readonly<Record<string, BinOp>> = { times: "times", cdot: "cdot", div: "div", cap: "cap" };

type Script = { circ: true } | { circ: false; node: MathNode };

/**
 * Recursive-descent parser for docs/mathtext.md: one token of lookahead, no backtracking. Recursion is bounded by the
 * explicit depth counter (every nested construct and every prefix sign is checked on entry, limit 8); function
 * chains (`\sin \sin x`) and operator chains are loops, so no input can recurse deeper than that.
 */
function parseTokens(tokens: readonly Token[], eofAt: number): MathNode {
  const MAX_DEPTH = MATHTEXT_LIMITS.maxDepth;
  let pos = 0;
  let depth = 0;
  let expDepth = 0;
  let absDepth = 0; // number of enclosing absolute-value bars at any nesting
  const ctx: string[] = []; // open constructs, innermost last: "(" "[" "{" "|"

  const peek = (): Token | undefined => tokens[pos];
  const fail = (code: MathTextErrorCode, t?: Token): never => {
    throw new Fail(code, t ? t.at : eofAt);
  };
  const isOp = (t: Token | undefined, v: string): boolean => t?.k === "op" && t.v === v;
  const isCmd = (t: Token | undefined, v: string): boolean => t?.k === "cmd" && t.v === v;
  const open = (t: Token | undefined, c: string): void => {
    if (++depth > MAX_DEPTH) fail("math_depth", t);
    ctx.push(c);
    if (c === "|") absDepth++;
  };
  const close = (): void => {
    depth--;
    if (ctx.pop() === "|") absDepth--;
  };
  // A wrong or missing closer: braces are brace misuse everywhere, anything else is an unbalanced group.
  const closerFail = (t: Token | undefined): never => fail(isOp(t, "{") || isOp(t, "}") ? "math_brace_misuse" : "math_unbalanced", t);
  const expectCloser = (v: ")" | "]" | "|"): void => {
    const t = peek();
    if (!isOp(t, v)) closerFail(t);
    pos++;
  };
  const expectBrace = (): void => {
    const t = peek();
    if (!isOp(t, "}")) fail("math_brace_misuse", t);
    pos++;
  };

  function parseList(): MathNode {
    const items = [parseRelation()];
    while (isOp(peek(), ",")) {
      pos++;
      items.push(parseRelation());
    }
    return items.length === 1 ? (items[0] as MathNode) : { t: "list", items };
  }

  function relOp(t: Token | undefined): RelOp | null {
    if (t?.k === "op" && (t.v === "=" || t.v === "<" || t.v === ">")) return t.v;
    if (t?.k === "cmd" && REL_CMDS.has(t.v)) return t.v as RelOp;
    return null;
  }

  function parseRelation(): MathNode {
    const first = parseExpr();
    const rest: { op: RelOp; rhs: MathNode }[] = [];
    for (let op = relOp(peek()); op; op = relOp(peek())) {
      pos++;
      rest.push({ op, rhs: parseExpr() });
    }
    return rest.length ? { t: "rel", first, rest } : first;
  }

  function addOp(t: Token | undefined): BinOp | null {
    if (t?.k === "op" && (t.v === "+" || t.v === "-")) return t.v;
    if (isCmd(t, "pm")) return "pm";
    return isCmd(t, "cup") ? "cup" : null;
  }

  function parseExpr(): MathNode {
    let acc = parseTerm();
    for (let op = addOp(peek()); op; op = addOp(peek())) {
      pos++;
      acc = { t: "bin", op, l: acc, r: parseTerm() };
    }
    return acc;
  }

  function mulOp(t: Token | undefined): BinOp | null {
    if (isOp(t, "/")) return "/";
    return t?.k === "cmd" ? (MUL_OPS[t.v] ?? null) : null;
  }

  function parseTerm(): MathNode {
    let acc = parseOperand();
    for (let op = mulOp(peek()); op; op = mulOp(peek())) {
      pos++;
      acc = { t: "bin", op, l: acc, r: parseOperand() };
    }
    return acc;
  }

  // Implicit products bind tighter than mulop: `2 \times 3x` is bin(times, 2, imp(3, x)).
  function startsImplicit(t: Token | undefined): boolean {
    if (!t) return false;
    if (t.k === "num" || t.k === "letter") return true;
    if (t.k === "cmd") return IMPLICIT_CMDS.has(t.v);
    if (t.k === "op") return t.v === "(" || t.v === "[" || (t.v === "|" && ctx[ctx.length - 1] !== "|");
    return false;
  }

  // True when the last glyph the node emits is a bare number, so a number or a fraction written right after it would
  // merge with it visually (`\sin 2 3` reads "sin 23", `3\frac{1}{2}` reads "three and a half"). Per node kind: a
  // number is one; a prefix sign, a function (`\sin 2`, `\log_{2}8`), an implicit product, a binary operation, a relation
  // and a comma list end with their last operand; everything else ends in a closer, a script, a percent sign or a
  // letter-like glyph (`)`, `]`, `|`, `}`, `\%`, a variable, a Greek letter, `\ldots`) and is unambiguous.
  function endsInNumber(n: MathNode): boolean {
    switch (n.t) {
      case "num": return true;
      case "unary": case "fn": case "lim": case "sum": return endsInNumber(n.arg);
      case "bin": return endsInNumber(n.r);
      case "imp": case "list": return endsInNumber(n.items[n.items.length - 1] as MathNode);
      case "rel": return endsInNumber((n.rest[n.rest.length - 1] as { rhs: MathNode }).rhs);
      default: return false;
    }
  }

  // An integral ends with its differential, so nothing may follow it in an implicit product: `\int x\,dx y` would
  // otherwise be ambiguous with a longer integrand once serialized.
  function endsWithInt(n: MathNode): boolean {
    switch (n.t) {
      case "int": return true;
      case "unary": case "fn": case "lim": case "sum": return endsWithInt(n.arg);
      default: return false;
    }
  }

  function parseOperand(): MathNode {
    const first = parseUnary();
    const items = [first];
    while (startsImplicit(peek()) && !endsWithInt(items[items.length - 1] as MathNode)) {
      const t = peek() as Token;
      const last = items[items.length - 1] as MathNode;
      if ((t.k === "num" || isCmd(t, "frac")) && endsInNumber(last)) fail("math_adjacent_numbers", t);
      if (isOp(t, "|") && last.t === "abs") fail("math_unexpected_token", t);
      items.push(parsePostfix());
    }
    return items.length === 1 ? first : { t: "imp", items };
  }

  function parseUnary(): MathNode {
    const t = peek();
    let op: "-" | "+" | "pm" | null = null;
    if (t?.k === "op" && (t.v === "-" || t.v === "+")) op = t.v;
    else if (isCmd(t, "pm")) op = "pm";
    if (!op) return parsePostfix();
    if (++depth > MAX_DEPTH) fail("math_depth", t);
    pos++;
    const arg = parseUnary();
    depth--;
    return { t: "unary", op, arg };
  }

  function parsePostfix(): MathNode {
    const fns: { name: FnName; base?: MathNode }[] = [];
    for (let t = peek(); t?.k === "cmd" && FNS.has(t.v); t = peek()) {
      pos++;
      const name = t.v as FnName;
      const n = peek();
      let base: MathNode | undefined;
      if (isOp(n, "_")) {
        if (name !== "log") fail("math_bad_script", n);
        pos++;
        const s = parseScript(false, n as Token);
        if (s.circ) fail("math_bad_script", n);
        else base = s.node;
      } else if (isOp(n, "^")) {
        fail("math_bad_script", n);
      }
      fns.push(base ? { name, base } : { name });
    }
    let node = parseScripted();
    for (let i = fns.length - 1; i >= 0; i--) {
      const f = fns[i] as { name: FnName; base?: MathNode };
      node = f.base ? { t: "fn", name: f.name, base: f.base, arg: node } : { t: "fn", name: f.name, arg: node };
    }
    return node;
  }

  // primary followed by scripts and percent signs. A base takes one "^" and one "_" in either order; after a degree or
  // percent no further script is allowed.
  function parseScripted(): MathNode {
    let node = parsePrimary();
    // Primes and the big operators take no scripts or percent sign afterwards.
    if (node.t === "prime" || node.t === "lim" || node.t === "sum" || node.t === "int") {
      const n = peek();
      if (isOp(n, "^") || isOp(n, "_")) fail("math_bad_script", n);
      return node;
    }
    let sub: MathNode | undefined;
    let sup: MathNode | undefined;
    let blocked = false;
    const applySub = (): void => {
      if (sub) node = { t: "sub", base: node, sub };
      sub = undefined;
    };
    for (;;) {
      const t = peek();
      if (isOp(t, "^")) {
        if (blocked || sup) fail("math_bad_script", t);
        pos++;
        const s = parseScript(true, t as Token);
        if (s.circ) {
          applySub();
          node = { t: "deg", arg: node };
          blocked = true;
        } else {
          sup = s.node;
        }
      } else if (isOp(t, "_")) {
        if (blocked || sub) fail("math_bad_script", t);
        pos++;
        const s = parseScript(false, t as Token);
        if (s.circ) fail("math_bad_script", t);
        else sub = s.node;
      } else if (t?.k === "pct") {
        applySub();
        if (sup) node = { t: "sup", base: node, exp: sup };
        sup = undefined;
        pos++;
        node = { t: "pct", arg: node };
        blocked = true;
      } else {
        break;
      }
    }
    applySub();
    if (sup) node = { t: "sup", base: node, exp: sup };
    const bang = peek();
    if (isOp(bang, "!")) {
      // Factorial of a whole number, a variable or a parenthesized expression only; never of a scripted or other base.
      const okBase = node.t === "var" || node.t === "group" || (node.t === "num" && !node.v.includes("."));
      if (!okBase) fail("math_unexpected_token", bang);
      pos++;
      node = { t: "fact", arg: node };
      const n = peek();
      if (isOp(n, "^") || isOp(n, "_")) fail("math_bad_script", n);
    }
    return node;
  }

  // One bound of `\sum` or `\int`: a single digit, a letter or a braced list; no degree sign.
  function parseBound(owner: Token): MathNode {
    pos++;
    const s = parseScript(false, owner);
    if (s.circ) return fail("math_bad_script", owner);
    return s.node;
  }

  function parseBounds(): { lo?: MathNode; hi?: MathNode } {
    const out: { lo?: MathNode; hi?: MathNode } = {};
    for (;;) {
      const t = peek();
      if (isOp(t, "_")) {
        if (out.lo) fail("math_bad_script", t);
        out.lo = parseBound(t as Token);
      } else if (isOp(t, "^")) {
        if (out.hi) fail("math_bad_script", t);
        out.hi = parseBound(t as Token);
      } else {
        return out;
      }
    }
  }

  function withDepth<T>(t: Token, f: () => T): T {
    if (++depth > MAX_DEPTH) fail("math_depth", t);
    const r = f();
    depth--;
    return r;
  }

  // script := digit | letter | "{" math "}"; for "^" also \circ or {\circ}, which build `deg`.
  function parseScript(forSup: boolean, owner: Token): Script {
    const t = peek();
    if (!t) return fail("math_bad_script", owner);
    const checkExp = (): void => {
      if (forSup && expDepth >= MATHTEXT_LIMITS.maxExponentDepth) fail("math_exponent_depth", t);
    };
    if (t.k === "num") {
      if (t.v.length !== 1) fail("math_bad_script", t); // a script is one digit; use braces for more
      checkExp();
      pos++;
      return { circ: false, node: { t: "num", v: t.v } };
    }
    if (t.k === "letter") {
      checkExp();
      pos++;
      return { circ: false, node: { t: "var", name: t.v } };
    }
    if (forSup && isCmd(t, "circ")) {
      pos++;
      return { circ: true };
    }
    if (isOp(t, "{")) {
      open(t, "{");
      pos++;
      if (forSup && isCmd(peek(), "circ")) {
        pos++;
        expectBrace();
        close();
        return { circ: true };
      }
      checkExp();
      if (forSup) expDepth++;
      const node = parseList();
      if (forSup) expDepth--;
      expectBrace();
      close();
      return { circ: false, node };
    }
    return fail("math_bad_script", t);
  }

  function parseBraced(): MathNode {
    const t = peek();
    if (!isOp(t, "{")) fail("math_brace_misuse", t);
    open(t, "{");
    pos++;
    const node = parseList();
    expectBrace();
    close();
    return node;
  }

  function parsePrimary(): MathNode {
    const t = peek();
    if (!t) return fail("math_unexpected_token");
    if (t.k === "num") {
      pos++;
      return { t: "num", v: t.v };
    }
    if (t.k === "letter") {
      pos++;
      let count = 0;
      while (count < 3 && isOp(peek(), "'")) {
        pos++;
        count++;
      }
      return count ? { t: "prime", name: t.v, count: count as 1 | 2 | 3 } : { t: "var", name: t.v };
    }
    if (t.k === "cmd") {
      if (t.v === "infty") {
        pos++;
        return { t: "infty" };
      }
      if (t.v === "binom") {
        pos++;
        const n = parseBraced();
        const k = parseBraced();
        return { t: "binom", n, k };
      }
      if (t.v === "bar" || t.v === "hat") {
        pos++;
        const o = peek();
        if (!isOp(o, "{")) fail("math_brace_misuse", o);
        pos++;
        const l = peek();
        if (l?.k !== "letter") fail("math_unexpected_token", l);
        pos++;
        expectBrace();
        return { t: "accent", kind: t.v, name: (l as { v: string }).v };
      }
      if (t.v === "lim") {
        pos++;
        const u = peek();
        if (!isOp(u, "_")) fail("math_bad_script", u ?? t);
        pos++;
        const b = peek();
        if (!isOp(b, "{")) fail("math_brace_misuse", b);
        open(b, "{");
        pos++;
        const under = parseRelation();
        expectBrace();
        close();
        return { t: "lim", under, arg: withDepth(t, parseOperand) };
      }
      if (t.v === "sum") {
        pos++;
        const { lo, hi } = parseBounds();
        const arg = withDepth(t, parseOperand);
        return { t: "sum", ...(lo ? { lo } : {}), ...(hi ? { hi } : {}), arg };
      }
      if (t.v === "int") {
        pos++;
        const { lo, hi } = parseBounds();
        const body = withDepth(t, parseExpr);
        const th = peek();
        if (th?.k !== "thin") fail("math_unexpected_token", th);
        pos++;
        const d = peek();
        if (d?.k !== "letter" || d.v !== "d") fail("math_unexpected_token", d);
        pos++;
        const v = peek();
        if (v?.k !== "letter") fail("math_unexpected_token", v);
        pos++;
        return { t: "int", ...(lo ? { lo } : {}), ...(hi ? { hi } : {}), body, v: (v as { v: string }).v };
      }
      if (GREEK.has(t.v)) {
        pos++;
        return { t: "greek", name: t.v as Greek };
      }
      if (t.v === "ldots") {
        pos++;
        return { t: "ldots" };
      }
      if (t.v === "frac") {
        pos++;
        const num = parseBraced();
        const den = parseBraced();
        return { t: "frac", num, den };
      }
      if (t.v === "sqrt") {
        pos++;
        let index: MathNode | undefined;
        const b = peek();
        if (isOp(b, "[")) {
          open(b, "[");
          pos++;
          // TeX ends the optional argument at the first `]` outside braces: a bracket or a root inside the index would
          // not mean what the AST says, so the index may hold neither (docs/mathtext.md, "Root index").
          for (let k = pos; k < tokens.length && !isOp(tokens[k], "]"); k++) {
            const it = tokens[k] as Token;
            if (isOp(it, "[") || isCmd(it, "sqrt")) return fail("math_unexpected_token", it);
          }
          index = parseList();
          expectCloser("]");
          close();
        }
        const body = parseBraced();
        return index ? { t: "sqrt", index, body } : { t: "sqrt", body };
      }
      return fail("math_unexpected_token", t);
    }
    if (t.k === "op") {
      if (t.v === "(" || t.v === "[") {
        open(t, t.v);
        pos++;
        const body = parseList();
        expectCloser(t.v === "(" ? ")" : "]");
        close();
        return { t: "group", open: t.v, body };
      }
      if (t.v === "|") {
        if (absDepth > 0) return fail("math_unexpected_token", t); // nested absolute value, at any nesting
        open(t, "|");
        pos++;
        if (isOp(peek(), "|")) fail("math_unexpected_token", peek());
        const body = parseExpr();
        expectCloser("|");
        close();
        return { t: "abs", body };
      }
      if (t.v === "{") return fail("math_brace_misuse", t);
      if (t.v === "}") return fail(ctx[ctx.length - 1] === "{" ? "math_unexpected_token" : "math_brace_misuse", t);
    }
    return fail("math_unexpected_token", t);
  }

  const node = parseList();
  const rest = peek();
  if (rest) {
    if (isOp(rest, ")") || isOp(rest, "]")) fail("math_unbalanced", rest);
    if (isOp(rest, "{") || isOp(rest, "}")) fail("math_brace_misuse", rest);
    fail("math_unexpected_token", rest);
  }
  return node;
}

function runParser(tokens: readonly Token[], eofAt: number): ParseResult {
  try {
    return { ok: true, node: parseTokens(tokens, eofAt) };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, code: e.code, at: e.at };
    throw e;
  }
}

/** Tokenizes and parses the source of one math span; `offset` is the span's position in the normalized string. */
export function parseMath(src: string, offset: number): ParseResult {
  const tk = tokenizeMath(src, offset);
  if (!tk.ok) return tk;
  return runParser(tk.tokens, offset + src.length);
}

/**
 * The only entry point for model-written math: split, then tokenize every span, then parse every span (the documented
 * check order is stage by stage), and return text parts and typed math nodes. Errors are codes with a position.
 */
export function parseMathText(input: string): MathTextResult {
  const sp = splitMathText(input);
  if (!sp.ok) return sp;
  // Tokenizer failures win over parser failures anywhere in the document, so tokenize every span first.
  const lexed: ({ tokens: readonly Token[]; eofAt: number } | null)[] = [];
  for (const p of sp.parts) {
    if (p.t !== "span") {
      lexed.push(null);
      continue;
    }
    const tk = tokenizeMath(p.src, p.at);
    if (!tk.ok) return tk;
    lexed.push({ tokens: tk.tokens, eofAt: p.at + p.src.length });
  }
  const parts: MathTextPart[] = [];
  for (let i = 0; i < sp.parts.length; i++) {
    const p = sp.parts[i] as (typeof sp.parts)[number];
    const lx = lexed[i];
    if (p.t === "text" || !lx) {
      if (p.t !== "text") continue;
      const prev = parts[parts.length - 1];
      if (prev?.t === "text") prev.s += p.s;
      else parts.push({ t: "text", s: p.s });
      continue;
    }
    const r = runParser(lx.tokens, lx.eofAt);
    if (!r.ok) return r;
    parts.push({ t: "math", m: r.node });
  }
  return { ok: true, doc: { v: MATHTEXT_PARSER_VERSION, parts } };
}
