import { MATHTEXT_PARSER_VERSION, type MathTextDoc } from "@/lib/math-text/ast";

/** Exact key set per node kind; `?` marks a key that may be absent (and, when present, is never `undefined`). */
const KEYS: Readonly<Record<string, readonly string[]>> = {
  num: ["t", "v"], var: ["t", "name"], greek: ["t", "name"], ldots: ["t"], bin: ["t", "op", "l", "r"], imp: ["t", "items"],
  list: ["t", "items"], unary: ["t", "op", "arg"], rel: ["t", "first", "rest"], group: ["t", "open", "body"], abs: ["t", "body"],
  frac: ["t", "num", "den"], sqrt: ["t", "body", "index?"], sup: ["t", "base", "exp"], sub: ["t", "base", "sub"],
  pct: ["t", "arg"], deg: ["t", "arg"], fn: ["t", "name", "arg", "base?"],
};
const BIN_OPS: ReadonlySet<string> = new Set(["+", "-", "pm", "times", "cdot", "div", "/"]);
const REL_OPS: ReadonlySet<string> = new Set(["=", "<", ">", "le", "ge", "neq"]);
const UNARY_OPS: ReadonlySet<string> = new Set(["-", "+", "pm"]);
const GREEK: ReadonlySet<string> = new Set(["alpha", "beta", "theta", "pi"]);
const FNS: ReadonlySet<string> = new Set(["sin", "cos", "tan", "log", "ln"]);
const NUM = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/;
const VAR = /^[A-Za-z]$/;
/**
 * Above any tree the parser can build (the deepest is about 150: a 300-character span of `x+x+...` is a left-nested
 * chain of 149 `bin` nodes, docs/mathtext.md), far below the stack limit.
 */
const MAX_GUARD_DEPTH = 256;
/**
 * Most nodes a document may hold. A source is at most 2000 characters and a node needs at least two thirds of a
 * character (`xy` is three nodes for two characters, the densest shape), so the parser cannot produce more than about
 * 3000; 4000 leaves margin and stops a hand-built document from making the checks do unbounded work.
 */
export const MAX_DOC_NODES = 4000;

/** A plain object: prototype exactly `Object.prototype` (not null, not a class instance, not `Object.create(x)`). */
const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;

/**
 * Exact own keys: no symbol keys, no key outside `allowed`, every present key an own DATA property (an accessor could
 * answer differently on a second read) holding a defined value, every required key present as an own property.
 */
function exactKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed.map((k) => k.replace("?", "")));
  for (const k of Reflect.ownKeys(o)) {
    if (typeof k !== "string" || !names.has(k)) return false;
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !("value" in d) || d.value === undefined) return false;
  }
  for (const k of allowed) if (!k.endsWith("?") && !Object.hasOwn(o, k)) return false;
  return true;
}

/** A dense plain array: `Array.prototype`, only own data elements at every index (no holes, no extra keys). */
function denseArray(a: unknown): a is unknown[] {
  if (!Array.isArray(a) || a.length > MAX_DOC_NODES || Object.getPrototypeOf(a) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(a);
  if (keys.length !== a.length + 1) return false; // indices plus `length`
  for (let i = 0; i < a.length; i++) {
    const d = Object.getOwnPropertyDescriptor(a, i);
    if (!d || !("value" in d)) return false;
  }
  return keys.every((k) => k === "length" || (typeof k === "string" && /^(0|[1-9]\d*)$/.test(k) && Number(k) < a.length));
}

function isNode(n: unknown, depth: number, budget: { left: number }): boolean {
  if (--budget.left < 0 || depth > MAX_GUARD_DEPTH || !isRecord(n) || typeof n.t !== "string") return false;
  const allowed = Object.hasOwn(KEYS, n.t) ? KEYS[n.t] : undefined;
  if (!allowed || !exactKeys(n, allowed)) return false;
  const d = depth + 1;
  switch (n.t) {
    case "num": return typeof n.v === "string" && NUM.test(n.v);
    case "var": return typeof n.name === "string" && VAR.test(n.name);
    case "greek": return typeof n.name === "string" && GREEK.has(n.name);
    case "ldots": return true;
    case "bin": return typeof n.op === "string" && BIN_OPS.has(n.op) && isNode(n.l, d, budget) && isNode(n.r, d, budget);
    case "imp": case "list": return denseArray(n.items) && n.items.length >= 2 && n.items.every((x) => isNode(x, d, budget));
    case "unary": return typeof n.op === "string" && UNARY_OPS.has(n.op) && isNode(n.arg, d, budget);
    case "rel":
      return isNode(n.first, d, budget) && denseArray(n.rest) && n.rest.length >= 1 &&
        n.rest.every((r) => isRecord(r) && exactKeys(r, ["op", "rhs"]) && typeof r.op === "string" && REL_OPS.has(r.op) && isNode(r.rhs, d, budget));
    case "group": return (n.open === "(" || n.open === "[") && isNode(n.body, d, budget);
    case "abs": return isNode(n.body, d, budget);
    case "frac": return isNode(n.num, d, budget) && isNode(n.den, d, budget);
    case "sqrt": return isNode(n.body, d, budget) && (!Object.hasOwn(n, "index") || isNode(n.index, d, budget));
    case "sup": return isNode(n.base, d, budget) && isNode(n.exp, d, budget);
    case "sub": return isNode(n.base, d, budget) && isNode(n.sub, d, budget);
    case "pct": case "deg": return isNode(n.arg, d, budget);
    case "fn":
      return typeof n.name === "string" && FNS.has(n.name) && isNode(n.arg, d, budget) &&
        (!Object.hasOwn(n, "base") || (n.name === "log" && isNode(n.base, d, budget)));
    default: return false;
  }
}

/**
 * Strict runtime shape check of a MathText document (closed node-kind set, exact keys, enums, number and variable
 * formats, version). A value that passes can be handed to `mathToTex`, the check and the HTML parts without any
 * further trust in where it came from. Strict about the object graph too: plain objects and arrays only, own data
 * properties only (no getters or setters, no holes, no inherited or symbol keys), so what is checked is what is read.
 * Documents must be plain data: a Proxy that wraps a valid document cannot be told apart from it and passes, which is
 * why the guard is applied to values that came from `parseMathText` or JSON, never to live objects of unknown origin.
 * Objects from `JSON.parse` qualify (null-prototype objects do not: not plain by this rule). Total: never throws.
 */
export function isMathTextDoc(value: unknown): value is MathTextDoc {
  try {
    if (!isRecord(value) || !exactKeys(value, ["v", "parts"]) || value.v !== MATHTEXT_PARSER_VERSION || !denseArray(value.parts)) return false;
    const budget = { left: MAX_DOC_NODES };
    return value.parts.every((p) => {
      if (!isRecord(p)) return false;
      if (p.t === "text") return exactKeys(p, ["t", "s"]) && typeof p.s === "string";
      if (p.t === "math") return exactKeys(p, ["t", "m"]) && isNode(p.m, 0, budget);
      return false;
    });
  } catch {
    return false;
  }
}
