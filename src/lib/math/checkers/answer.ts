/**
 * Reading a stated answer. Answers come from a model, so every reader is total and strict: a shape it does not
 * recognise is `null` (the item ends up unchecked), never a guess. A guess here would either hide a wrong
 * answer or fail a right one.
 */
import { evalRational, evalSurdSet } from "@/lib/math/checkers/numeric";
import type { Surd } from "@/lib/math/checkers/surd";
import { isMathTextDoc, type MathNode, type MathTextDoc, type MathTextPart } from "@/lib/math-text";
import type { Rational } from "@/lib/math/rational";

/** The three answers that are prose rather than a value; each synonym group collapses to one token. */
export type TextToken = "none" | "all" | "no_real_roots";

const TEXT_SYNONYMS: ReadonlyMap<string, TextToken> = new Map([
  ["no solution", "none"],
  ["no solutions", "none"],
  ["no solution exists", "none"],
  ["there is no solution", "none"],
  ["there are no solutions", "none"],
  ["the equation has no solution", "none"],
  ["no real solution", "none"],
  ["no real solutions", "none"],
  ["infinitely many solutions", "all"],
  ["infinitely many", "all"],
  ["infinite solutions", "all"],
  ["all real numbers", "all"],
  ["all reals", "all"],
  ["all real numbers are solutions", "all"],
  ["every real number", "all"],
  ["every real number is a solution", "all"],
  ["identity", "all"],
  ["no real roots", "no_real_roots"],
  ["no real root", "no_real_roots"],
  ["no roots", "no_real_roots"],
  ["no real zeros", "no_real_roots"],
  ["does not have real roots", "no_real_roots"],
  ["it does not have real roots", "no_real_roots"],
  ["the equation does not have real roots", "no_real_roots"],
] as const);

/** Words that would turn a value answer into a hedge or a second answer; their presence makes it unreadable. */
const DISQUALIFYING_WORDS = new Set(["not", "no", "or", "and", "but"]);
const MAX_UNIT_WORDS = 3;
const MAX_STATED_ROOTS = 6;

export type RelationalOp = "<" | ">" | "le" | "ge";

function asDoc(value: unknown): MathTextDoc | null {
  return isMathTextDoc(value) ? value : null;
}

/** `roots` and `pair` carry a list; a single document is read as a one-element list. */
export function asDocList(value: unknown): MathTextDoc[] | null {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) return null;
  const docs = list.map(asDoc);
  return docs.every((d): d is MathTextDoc => d !== null) ? docs : null;
}

/** Text around a value may only be unit words: no hedging, no second answer, no punctuation. */
function unitWordsOnly(parts: readonly MathTextPart[]): boolean {
  const words: string[] = [];
  for (const part of parts) {
    if (part.t !== "text") continue;
    if (!/^[A-Za-z ]*$/.test(part.s)) return false;
    words.push(...part.s.split(" ").filter((w) => w.length > 0));
  }
  if (words.length > MAX_UNIT_WORDS) return false;
  return !words.some((w) => DISQUALIFYING_WORDS.has(w.toLowerCase()));
}

/** The single math node of a value answer, with optional unit words around it. */
function soleMathNode(value: unknown): MathNode | null {
  const doc = asDoc(value);
  if (doc === null) return null;
  const math = doc.parts.filter((p) => p.t === "math");
  if (math.length !== 1 || !unitWordsOnly(doc.parts)) return null;
  const only = math[0]!;
  return only.t === "math" ? only.m : null;
}

/** `x = <value>` strips to the variable name and the right-hand side. */
function stripVariableLabel(node: MathNode): { label: string | null; body: MathNode } | null {
  if (node.t !== "rel") return { label: null, body: node };
  if (node.rest.length !== 1 || node.rest[0]!.op !== "=" || node.first.t !== "var") return null;
  return { label: node.first.name, body: node.rest[0]!.rhs };
}

/**
 * A stated number. `20\%` for a value of 20 counts as 20: the percent sign is a unit here, stripped at the
 * top level only (inside an expression `\%` keeps its arithmetic meaning of a division by 100).
 */
export interface NumberAnswer {
  label: string | null;
  value: Rational;
}

export function readNumberAnswer(value: unknown): NumberAnswer | null {
  const node = soleMathNode(value);
  if (node === null) return null;
  const stripped = stripVariableLabel(node);
  if (stripped === null) return null;
  const body = stripped.body.t === "pct" ? stripped.body.arg : stripped.body;
  const number = evalRational(body);
  return number === null ? null : { label: stripped.label, value: number };
}

export interface RootsAnswer {
  labels: (string | null)[];
  values: Surd[];
}

/** One document per root, or one document carrying `\pm` or a comma list; all roots share one radicand. */
export function readRootsAnswer(value: unknown): RootsAnswer | null {
  const docs = asDocList(value);
  if (docs === null) return null;
  const labels: (string | null)[] = [];
  const values: Surd[] = [];
  for (const doc of docs) {
    const node = soleMathNode(doc);
    if (node === null) return null;
    const stripped = stripVariableLabel(node);
    if (stripped === null) return null;
    labels.push(stripped.label);
    const items = stripped.body.t === "list" ? stripped.body.items : [stripped.body];
    for (const item of items) {
      const set = evalSurdSet(item);
      if (set === null) return null;
      values.push(...set);
    }
    if (values.length > MAX_STATED_ROOTS) return null;
  }
  const radicands = new Set(values.filter((v) => !v.isRational()).map((v) => v.d.toString()));
  return radicands.size > 1 ? null : { labels, values };
}

export interface PairAnswer {
  /** Already in the order the checker compares: by variable name when labelled, as written otherwise. */
  values: [Rational, Rational];
  /** The two variable names in the same order, when the answer labelled both components. */
  labels: [string, string] | null;
}

export function readPairAnswer(value: unknown): PairAnswer | null {
  const docs = asDocList(value);
  if (docs === null) return null;
  if (docs.length === 1) {
    const node = soleMathNode(docs[0]);
    const body = node === null ? null : node.t === "group" ? node.body : node;
    if (body === null || body.t !== "list" || body.items.length !== 2) return null;
    const first = evalRational(body.items[0]!);
    const second = evalRational(body.items[1]!);
    return first === null || second === null ? null : { values: [first, second], labels: null };
  }
  if (docs.length !== 2) return null;
  const [a, b] = docs.map((d) => readNumberAnswer(d));
  if (!a || !b) return null;
  if (a.label === null && b.label === null) return { values: [a.value, b.value], labels: null };
  if (a.label === null || b.label === null || a.label === b.label) return null;
  const [first, second] = a.label < b.label ? [a, b] : [b, a];
  return { values: [first!.value, second!.value], labels: [first!.label!, second!.label!] };
}

export interface InequalityAnswer {
  variable: string;
  /** Always in variable-on-the-left form: `3 < x` is read as `x > 3`. */
  op: RelationalOp;
  bound: Rational;
}

const MIRROR: Record<RelationalOp, RelationalOp> = { "<": ">", ">": "<", le: "ge", ge: "le" };

function isRelationalOp(op: string): op is RelationalOp {
  return op === "<" || op === ">" || op === "le" || op === "ge";
}

export function readInequalityAnswer(value: unknown): InequalityAnswer | null {
  const node = soleMathNode(value);
  if (node === null || node.t !== "rel" || node.rest.length !== 1) return null;
  const { op, rhs } = node.rest[0]!;
  if (!isRelationalOp(op)) return null;
  const left = node.first;
  if (left.t === "var" && rhs.t !== "var") {
    const bound = evalRational(rhs);
    return bound === null ? null : { variable: left.name, op, bound };
  }
  if (rhs.t === "var" && left.t !== "var") {
    const bound = evalRational(left);
    return bound === null ? null : { variable: rhs.name, op: MIRROR[op], bound };
  }
  return null;
}

/** Prose answers: lowercased, punctuation stripped, whitespace collapsed, then matched against the synonyms. */
export function readTextAnswer(value: unknown): TextToken | null {
  const doc = asDoc(value);
  if (doc === null || doc.parts.some((p) => p.t === "math")) return null;
  const normalised = doc.parts
    .map((p) => (p.t === "text" ? p.s : ""))
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  return TEXT_SYNONYMS.get(normalised) ?? null;
}
