import golden from "./golden.json";
import samples from "./samples.json";
import { MATHTEXT_PARSER_VERSION, type BinOp, type FnName, type Greek, type MathNode, type MathTextDoc, type MathTextPart, type RelOp } from "@/lib/math-text/ast";
import { parseMathText } from "@/lib/math-text/parse";

/** mulberry32: a small seeded PRNG so property tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ctx {
  next: () => number;
  d: number; // parser depth already used (open constructs and prefix signs)
  exp: number; // enclosing exponent scripts
  abs: boolean; // inside an absolute value: no further bars
  idx?: boolean; // inside a root index: a nested root's `]` would end the optional argument early (KaTeX and TeX both refuse it)
  budget: { left: number }; // shared node budget: keeps trees small enough for one math span
}

const MAX_DEPTH = 8;
const MAX_EXP = 3;
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GREEK: Greek[] = ["alpha", "beta", "theta", "pi"];
const FNS: FnName[] = ["sin", "cos", "tan", "log", "ln"];
const ADD: BinOp[] = ["+", "-", "pm"];
const MUL: BinOp[] = ["times", "cdot", "div", "/"];
const REL: RelOp[] = ["=", "<", ">", "le", "ge", "neq"];

const int = (c: Ctx, n: number): number => Math.floor(c.next() * n);
const chance = (c: Ctx, p: number): boolean => c.next() < p;
const sub = (c: Ctx, extra: Partial<Ctx> = {}): Ctx => ({ ...c, d: c.d + 1, ...extra });
// Probability that a compound construct is chosen shrinks with depth, which keeps trees small.
const compound = (c: Ctx): boolean => c.budget.left-- > 0 && c.d < MAX_DEPTH && chance(c, Math.max(0.12, 0.5 - c.d * 0.07));
const spend = (c: Ctx): boolean => c.budget.left-- > 0;

function genNum(c: Ctx): MathNode {
  const intLen = chance(c, 0.1) ? 12 : 1 + int(c, 3);
  let v = intLen === 1 ? String(int(c, 10)) : String(1 + int(c, 9));
  if (intLen > 1) for (let i = 1; i < intLen; i++) v += int(c, 10);
  if (chance(c, 0.2)) {
    const f = 1 + int(c, 6);
    v += ".";
    for (let i = 0; i < f; i++) v += int(c, 10);
  }
  return { t: "num", v };
}

function genAtom(c: Ctx): MathNode {
  const r = int(c, 10);
  if (r < 3) return genNum(c);
  if (r < 7) return { t: "var", name: LETTERS[int(c, LETTERS.length)] as string };
  if (r < 9) return { t: "greek", name: GREEK[int(c, 4)] as Greek };
  return { t: "ldots" };
}

function genPrimary(c: Ctx): MathNode {
  if (!compound(c)) return genAtom(c);
  const r = int(c, 6);
  const room = (n: number): boolean => c.d + n <= MAX_DEPTH;
  if (r <= 1 && room(1)) return { t: "group", open: chance(c, 0.5) ? "(" : "[", body: genList(sub(c)) };
  if (r === 2 && room(1) && !c.abs) return { t: "abs", body: genExpr(sub(c, { abs: true })) };
  if (r === 3 && room(1)) return { t: "frac", num: genList(sub(c)), den: genList(sub(c)) };
  if (r === 4 && room(1) && !c.idx) {
    const body = genList(sub(c));
    return chance(c, 0.4) ? { t: "sqrt", index: genList(sub(c, { idx: true })), body } : { t: "sqrt", body };
  }
  return genAtom(c);
}

/** primary with optional scripts, degree and percent signs, exactly the shapes `parseScripted` can build. */
function genScripted(c: Ctx): MathNode {
  const base = genPrimary(c);
  const canSup = c.exp < MAX_EXP && c.d + 1 <= MAX_DEPTH && spend(c);
  const canSub = c.d + 1 <= MAX_DEPTH && spend(c);
  const r = int(c, 12);
  let node = base;
  const withSub = (): void => {
    node = { t: "sub", base: node, sub: genList(sub(c)) };
  };
  if (r === 1 && canSub) withSub();
  else if (r === 2 && canSup) node = { t: "sup", base: node, exp: genList(sub(c, { exp: c.exp + 1 })) };
  else if (r === 3 && canSup && canSub) {
    withSub();
    node = { t: "sup", base: node, exp: genList(sub(c, { exp: c.exp + 1 })) };
  } else if (r === 4 && c.d + 1 <= MAX_DEPTH) {
    node = { t: "deg", arg: node };
  } else if (r === 5 && canSub && c.d + 1 <= MAX_DEPTH) {
    withSub();
    node = { t: "deg", arg: node };
  }
  if (r >= 6 && r <= 7) return node; // plain
  if (chance(c, 0.12)) node = { t: "pct", arg: node };
  if (chance(c, 0.03)) node = { t: "pct", arg: node };
  return node;
}

function genPostfix(c: Ctx): MathNode {
  const fns: { name: FnName; base?: MathNode }[] = [];
  while (fns.length < 2 && spend(c) && chance(c, 0.1)) {
    const name = FNS[int(c, 5)] as FnName;
    if (name === "log" && chance(c, 0.5) && c.d + 1 <= MAX_DEPTH) fns.push({ name, base: genList(sub(c)) });
    else fns.push({ name });
  }
  let node = genScripted(c);
  for (let i = fns.length - 1; i >= 0; i--) {
    const f = fns[i] as { name: FnName; base?: MathNode };
    node = f.base ? { t: "fn", name: f.name, base: f.base, arg: node } : { t: "fn", name: f.name, arg: node };
  }
  return node;
}

const isNumLike = (n: MathNode): boolean => n.t === "num" || (n.t === "unary" && isNumLike(n.arg));
const leadsWithAbs = (n: MathNode): boolean =>
  n.t === "abs" || ((n.t === "sup" || n.t === "sub") && leadsWithAbs(n.base)) || ((n.t === "deg" || n.t === "pct") && leadsWithAbs(n.arg));
const endsWithAbs = (n: MathNode): boolean => n.t === "abs" || (n.t === "unary" && endsWithAbs(n.arg));
// `\ldots` is only ever an operand start: the parser does not continue an implicit product with it.
const leadsWithLdots = (n: MathNode): boolean =>
  n.t === "ldots" || ((n.t === "sup" || n.t === "sub") && leadsWithLdots(n.base)) || ((n.t === "deg" || n.t === "pct") && leadsWithLdots(n.arg));
// The parser looks at the first token: `3^2` after `7` is still two numbers side by side.
const startsWithNum = (n: MathNode): boolean =>
  n.t === "num" || ((n.t === "sup" || n.t === "sub") && startsWithNum(n.base)) || ((n.t === "deg" || n.t === "pct") && startsWithNum(n.arg));

function genUnary(c: Ctx): MathNode {
  if (c.d + 1 <= MAX_DEPTH && chance(c, 0.12)) {
    const op = (["-", "+", "pm"] as const)[int(c, 3)] as "-" | "+" | "pm";
    return { t: "unary", op, arg: genUnary(sub(c)) };
  }
  return genPostfix(c);
}

function genOperand(c: Ctx): MathNode {
  const first = genUnary(c);
  if (!(spend(c) && chance(c, 0.25))) return first;
  const items = [first];
  const extra = 1 + int(c, 2);
  for (let i = 0; i < extra; i++) {
    let item = genPostfix(c);
    const last = items[items.length - 1] as MathNode;
    // Parser refusals: two numbers side by side, and a bar directly after a bar.
    if ((startsWithNum(item) && isNumLike(last)) || (leadsWithAbs(item) && endsWithAbs(last)) || leadsWithLdots(item)) item = { t: "var", name: "x" };
    items.push(item);
  }
  return { t: "imp", items };
}

function genTerm(c: Ctx): MathNode {
  let acc = genOperand(c);
  while (spend(c) && chance(c, 0.2)) acc = { t: "bin", op: MUL[int(c, 4)] as BinOp, l: acc, r: genOperand(c) };
  return acc;
}

function genExpr(c: Ctx): MathNode {
  let acc = genTerm(c);
  while (spend(c) && chance(c, 0.25)) acc = { t: "bin", op: ADD[int(c, 3)] as BinOp, l: acc, r: genTerm(c) };
  return acc;
}

function genRelation(c: Ctx): MathNode {
  const first = genExpr(c);
  if (!(spend(c) && chance(c, 0.2))) return first;
  const rest: { op: RelOp; rhs: MathNode }[] = [];
  do rest.push({ op: REL[int(c, 6)] as RelOp, rhs: genExpr(c) });
  while (spend(c) && chance(c, 0.2));
  return { t: "rel", first, rest };
}

function genList(c: Ctx): MathNode {
  if (!(spend(c) && chance(c, 0.1))) return genRelation(c);
  const items = [genRelation(c)];
  do items.push(genRelation(c));
  while (spend(c) && chance(c, 0.3));
  return { t: "list", items };
}

/**
 * A random tree of exactly the shapes `parseMath` can produce within the documented limits (depth 8 counting braced
 * scripts, exponent nesting 3, no nested bars, numbers of at most 12 digits and 6 decimals). `depth` is the parser depth
 * already in use (default 0).
 */
export function genMathNode(next: () => number, depth = 0): MathNode {
  return genList({ next, d: depth, exp: 0, abs: false, budget: { left: 14 + Math.floor(next() * 14) } });
}

const TEXT_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?'\"-()[]/%$&+=";

/** Documents built from random allowed text fragments (never starting or ending a span) and `genMathNode` spans. */
export function generatedDocs(next: () => number, count: number): MathTextDoc[] {
  const docs: MathTextDoc[] = [];
  for (let i = 0; i < count; i++) {
    const parts: MathTextPart[] = [];
    const spans = 1 + Math.floor(next() * 3);
    for (let s = 0; s < spans; s++) {
      if (next() < 0.7) {
        let text = "";
        const len = 1 + Math.floor(next() * 20);
        for (let k = 0; k < len; k++) text += TEXT_CHARS[Math.floor(next() * TEXT_CHARS.length)];
        parts.push({ t: "text", s: ` ${text} ` });
      }
      parts.push({ t: "math", m: genMathNode(next) });
    }
    docs.push({ v: MATHTEXT_PARSER_VERSION, parts });
  }
  return docs;
}

/** The accepted documents of the reviewed fixtures (golden and samples). */
export function acceptedFixtureDocs(): MathTextDoc[] {
  const inputs = [
    ...(golden as { in: string; ok: boolean }[]).filter((r) => r.ok).map((r) => r.in),
    ...(samples as { input: string; expect: unknown }[]).filter((s) => s.expect === "accept").map((s) => s.input),
  ];
  const docs: MathTextDoc[] = [];
  for (const input of inputs) {
    const r = parseMathText(input);
    if (r.ok) docs.push(r.doc);
  }
  return docs;
}
