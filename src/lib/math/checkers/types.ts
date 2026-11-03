import { z } from "zod";
import { isMathTextDoc, parseMathText, type MathTextDoc } from "@/lib/math-text";

/** Version of the five exact checkers and the claim vocabulary. Bump on any change that can alter an outcome. */
export const CHECKERS_VERSION = "checkers/1";

export const ANSWER_KINDS = ["number", "expression", "roots", "pair", "inequality", "text"] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];

/** A stated answer after MathText parsing: one document, or a list of documents for `roots` and `pair`. */
export interface AnswerDoc {
  kind: AnswerKind;
  value: MathTextDoc | MathTextDoc[];
}

export const CHECKER_NAMES = ["linear_equation", "quadratic_equation", "linear_system", "numeric", "linear_inequality"] as const;
export type CheckerName = (typeof CHECKER_NAMES)[number];

/** Why a claim counted as no check (the item is then `unchecked`, never `failed`). */
export const NO_CHECK_REASONS = ["no_claim", "claim_unbound", "claim_unreadable", "answer_unreadable"] as const;
export type NoCheckReason = (typeof NO_CHECK_REASONS)[number];

/** `pass`: a checker re-derived the stated answer from a bound claim. `fail`: it derived a different one. `none`: no check applied. */
export type CheckOutcome =
  | { result: "none"; reason: NoCheckReason }
  | { result: "pass"; checker: CheckerName }
  | { result: "fail"; checker: CheckerName; reason: "answer_mismatch" };

// --- claims -----------------------------------------------------------------------------------------------
// A claim is the structured statement a checker tests ("this span of the stem is a linear equation in one variable").
// Expression operands are MathText math sources WITHOUT the `\(` `\)` delimiters and must equal a math span of the stem
// (binding). Numeric operands (`NumStr`, small integers) must occur as numbers in the stem (binding by token).

/** A decimal or integer literal, optionally negative: `-4`, `0.25`, `12`. At most 9 integer digits and 6 fraction digits. */
export const NumStr = z.string().regex(/^-?(0|[1-9]\d{0,8})(\.\d{1,6})?$/);
const SmallInt = z.number().int().min(0).max(1000);
const ExprSource = z.string().min(1).max(300);

const ExprDoc = z.custom<MathTextDoc>((v) => isMathTextDoc(v) && v.parts.length === 1 && v.parts[0]!.t === "math");

const claimSchema = <E extends z.ZodType<unknown>>(expr: E) =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("linear_equation"), expr }),
    z.strictObject({ kind: z.literal("quadratic_equation"), expr }),
    z.strictObject({ kind: z.literal("linear_inequality"), expr }),
    z.strictObject({ kind: z.literal("evaluate"), expr }),
    z.strictObject({ kind: z.literal("linear_system"), exprs: z.tuple([expr, expr]) }),
    z.strictObject({ kind: z.literal("percent_of"), percent: NumStr, whole: NumStr }),
    z.strictObject({ kind: z.literal("nCr"), n: SmallInt, r: SmallInt }),
    z.strictObject({ kind: z.literal("nPr"), n: SmallInt, r: SmallInt }),
    z.strictObject({ kind: z.literal("arithmetic_term"), first: NumStr, step: NumStr, n: SmallInt }),
    z.strictObject({ kind: z.literal("arithmetic_sum"), first: NumStr, step: NumStr, n: SmallInt }),
    z.strictObject({ kind: z.literal("geometric_term"), first: NumStr, step: NumStr, n: SmallInt }),
    z.strictObject({ kind: z.literal("geometric_sum"), first: NumStr, step: NumStr, n: SmallInt }),
    z.strictObject({ kind: z.literal("poly_value"), expr, at: NumStr }),
  ]);

export const RawClaimSchema = claimSchema(ExprSource);
export type RawClaim = z.infer<typeof RawClaimSchema>;

/** The stored form: every expression operand is a one-span MathText document, parsed by our own code. */
export const ClaimSchema = claimSchema(ExprDoc);
export type Claim = z.infer<typeof ClaimSchema>;

/** `\(` + source + `\)` through the strict MathText entry; exactly one math part and nothing else, else null. */
export function parseExprSource(source: string): MathTextDoc | null {
  if (source.includes("\\(") || source.includes("\\)")) return null;
  const r = parseMathText(`\\(${source}\\)`);
  if (!r.ok || r.doc.parts.length !== 1 || r.doc.parts[0]!.t !== "math") return null;
  return r.doc;
}

/** Raw model claim to stored claim. Total: a claim that is not in the vocabulary, or whose expressions do not parse, is `claim_invalid`. */
export function parseRawClaim(raw: unknown): { ok: true; claim: Claim } | { ok: false; code: "claim_invalid" } {
  const parsed = RawClaimSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "claim_invalid" };
  const c = parsed.data;
  const doc = (s: string) => parseExprSource(s);
  if ("exprs" in c) {
    const [a, b] = [doc(c.exprs[0]), doc(c.exprs[1])];
    return a && b ? { ok: true, claim: { kind: c.kind, exprs: [a, b] } } : { ok: false, code: "claim_invalid" };
  }
  if ("expr" in c) {
    const d = doc(c.expr);
    if (!d) return { ok: false, code: "claim_invalid" };
    return { ok: true, claim: c.kind === "poly_value" ? { kind: c.kind, expr: d, at: c.at } : ({ kind: c.kind, expr: d } as Claim) };
  }
  return { ok: true, claim: c as Claim };
}
