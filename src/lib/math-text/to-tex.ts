import type { BinOp, MathNode, MathTextDoc, RelOp } from "@/lib/math-text/ast";
import { escapeTextFragment } from "@/lib/latex/escape";

const BIN_TEX: Readonly<Record<BinOp, string>> = {
  "+": "+", "-": "-", pm: "\\pm", times: "\\times", cdot: "\\cdot", div: "\\div", "/": "/",
};
const REL_TEX: Readonly<Record<RelOp, string>> = { "=": "=", "<": "<", ">": ">", le: "\\le", ge: "\\ge", neq: "\\neq" };

/**
 * Joins two emitted pieces. A control word must not run into a following ASCII letter (`\times` + `x`), and two digit
 * runs must not merge into one number (`\sin 3` + `4`); everything else is self-delimiting.
 */
function cat(a: string, b: string): string {
  if (a === "" || b === "") return a + b;
  const bc = b.charCodeAt(0);
  const bLetter = (bc >= 65 && bc <= 90) || (bc >= 97 && bc <= 122);
  const bDigit = bc >= 48 && bc <= 57;
  if (!bLetter && !bDigit) return a + b;
  const n = a.length;
  const ac = a.charCodeAt(n - 1);
  if (bDigit && ac >= 48 && ac <= 57) return `${a} ${b}`;
  if (bLetter) {
    // Ends with a control word? Look back over at most the longest control word (5 letters) plus the backslash.
    for (let k = 1; k <= 6 && k <= n; k++) {
      const c = a.charCodeAt(n - k);
      if (c === 92) return k > 1 ? `${a} ${b}` : a + b;
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) break;
    }
  }
  return a + b;
}
/**
 * The ONLY producer of math TeX for model content, and at the same time the canonical MathText math serializer
 * (docs/mathtext.md, "Canonical form"): whatever it emits is accepted by `parseMath` and yields the same AST, for
 * every tree the parser can produce. No whitespace except where `cat` or a function name or a list comma needs one;
 * scripts always braced. Recursion depth equals tree depth (about 150 for a long operator chain), which is fine.
 */
export function mathToTex(node: MathNode): string {
  switch (node.t) {
    case "num": return node.v;
    case "var": return node.name;
    case "greek": return `\\${node.name}`;
    case "ldots": return "\\ldots";
    case "bin": return cat(cat(mathToTex(node.l), BIN_TEX[node.op]), mathToTex(node.r));
    case "imp": return node.items.map(mathToTex).reduce(cat);
    case "unary": return cat(node.op === "pm" ? "\\pm" : node.op, mathToTex(node.arg));
    case "rel": return node.rest.reduce((acc, r) => cat(cat(acc, REL_TEX[r.op]), mathToTex(r.rhs)), mathToTex(node.first));
    case "list": return node.items.map(mathToTex).join(", ");
    case "group": return node.open === "(" ? `(${mathToTex(node.body)})` : `[${mathToTex(node.body)}]`;
    case "abs": return `|${mathToTex(node.body)}|`;
    case "frac": return `\\frac{${mathToTex(node.num)}}{${mathToTex(node.den)}}`;
    case "sqrt": return `\\sqrt${node.index ? `[${mathToTex(node.index)}]` : ""}{${mathToTex(node.body)}}`;
    case "sup": return `${mathToTex(node.base)}^{${mathToTex(node.exp)}}`;
    case "sub": return `${mathToTex(node.base)}_{${mathToTex(node.sub)}}`;
    case "pct": return `${mathToTex(node.arg)}\\%`;
    case "deg": return `${mathToTex(node.arg)}^{\\circ}`;
    case "fn": return cat(`\\${node.name}${node.base ? `_{${mathToTex(node.base)}}` : " "}`, mathToTex(node.arg));
  }
}

/** The canonical MathText string: text parts as they are (already normalized), math as `\(` + `mathToTex` + `\)`. */
export function serializeMathText(doc: MathTextDoc): string {
  return doc.parts.map((p) => (p.t === "text" ? p.s : `\\(${mathToTex(p.m)}\\)`)).join("");
}

/**
 * TeX for a whole MathText: text through the escape helper, math as inline `$...$`. Two math spans with no text
 * between them are separated by `{}` so `$x$$x$` (TeX display math) is never produced. Throws `RenderError("text_too_long")`.
 */
export function mathTextToTex(doc: MathTextDoc): string {
  let out = "";
  let prevMath = false;
  for (const p of doc.parts) {
    if (p.t === "text") {
      out += escapeTextFragment(p.s);
      prevMath = false;
    } else {
      out += `${prevMath ? "{}" : ""}$${mathToTex(p.m)}$`;
      prevMath = true;
    }
  }
  return out;
}
