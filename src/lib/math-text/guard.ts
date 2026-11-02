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
/** Far above any tree the parser can build (about 150 for a long operator chain), far below the stack limit. */
const MAX_GUARD_DEPTH = 1000;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function exactKeys(o: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed.map((k) => k.replace("?", "")));
  for (const k of Object.keys(o)) if (!names.has(k) || o[k] === undefined) return false;
  for (const k of allowed) if (!k.endsWith("?") && !(k in o)) return false;
  return true;
}

function isNode(n: unknown, depth: number): boolean {
  if (depth > MAX_GUARD_DEPTH || !isRecord(n) || typeof n.t !== "string") return false;
  const allowed = Object.hasOwn(KEYS, n.t) ? KEYS[n.t] : undefined;
  if (!allowed || !exactKeys(n, allowed)) return false;
  const d = depth + 1;
  switch (n.t) {
    case "num": return typeof n.v === "string" && NUM.test(n.v);
    case "var": return typeof n.name === "string" && VAR.test(n.name);
    case "greek": return typeof n.name === "string" && GREEK.has(n.name);
    case "ldots": return true;
    case "bin": return typeof n.op === "string" && BIN_OPS.has(n.op) && isNode(n.l, d) && isNode(n.r, d);
    case "imp": case "list": return Array.isArray(n.items) && n.items.length >= 2 && n.items.every((x) => isNode(x, d));
    case "unary": return typeof n.op === "string" && UNARY_OPS.has(n.op) && isNode(n.arg, d);
    case "rel":
      return isNode(n.first, d) && Array.isArray(n.rest) && n.rest.length >= 1 &&
        n.rest.every((r) => isRecord(r) && exactKeys(r, ["op", "rhs"]) && typeof r.op === "string" && REL_OPS.has(r.op) && isNode(r.rhs, d));
    case "group": return (n.open === "(" || n.open === "[") && isNode(n.body, d);
    case "abs": return isNode(n.body, d);
    case "frac": return isNode(n.num, d) && isNode(n.den, d);
    case "sqrt": return isNode(n.body, d) && (!("index" in n) || isNode(n.index, d));
    case "sup": return isNode(n.base, d) && isNode(n.exp, d);
    case "sub": return isNode(n.base, d) && isNode(n.sub, d);
    case "pct": case "deg": return isNode(n.arg, d);
    case "fn":
      return typeof n.name === "string" && FNS.has(n.name) && isNode(n.arg, d) &&
        (!("base" in n) || (n.name === "log" && isNode(n.base, d)));
    default: return false;
  }
}

/**
 * Strict runtime shape check of a MathText document (closed node-kind set, exact keys, enums, number and variable
 * formats, version). A value that passes can be handed to `mathToTex`, the check and the HTML parts without any
 * further trust in where it came from. Total: never throws.
 */
export function isMathTextDoc(value: unknown): value is MathTextDoc {
  try {
    if (!isRecord(value) || !exactKeys(value, ["v", "parts"]) || value.v !== MATHTEXT_PARSER_VERSION || !Array.isArray(value.parts)) return false;
    return value.parts.every((p) => {
      if (!isRecord(p)) return false;
      if (p.t === "text") return exactKeys(p, ["t", "s"]) && typeof p.s === "string";
      if (p.t === "math") return exactKeys(p, ["t", "m"]) && isNode(p.m, 0);
      return false;
    });
  } catch {
    return false;
  }
}
