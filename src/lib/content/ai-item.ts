import { z } from "zod";
import { canonicalJson, sha256Hex } from "@/lib/domain/hash";
import { type AiStatus, type CrossCheckResult, statusFromChecks } from "@/lib/content/ai-status";
import {
  ANSWER_KINDS,
  CHECKERS_VERSION,
  ClaimSchema,
  type AnswerDoc,
  type AnswerKind,
  type Claim,
  canonicalAnswer,
  parseRawClaim,
  runChecker,
} from "@/lib/math/checkers";
import {
  MATHTEXT_PARSER_VERSION,
  checkMathTextRenders,
  isMathTextDoc,
  parseMathText,
  type MathTextDoc,
} from "@/lib/math-text";
import { checkText } from "@/lib/package/prose-rules";

// The model-item gate (spec 5.2). A model's item enters a lesson only as an `AiItem`, which only `admitAiItem` makes:
// strict schema, lengths, MathText parse of every field, forbidden wording, answer kind, claim binding and exact check,
// static render check, de-duplication. Every refusal is a reason code; nothing the model wrote is copied into one.

export const AI_ITEMS_SCHEMA_VERSION = "ai-items/1";

export const AI_ROLES = ["example", "exercise"] as const;
export const AI_DIFFICULTIES = ["basic", "mixed", "challenge"] as const;

export const AI_LIMITS = { stem: 600, answer: 300, step: 300, steps: 8, listAnswers: 4 } as const;

const Roles = z.enum(AI_ROLES);
const Difficulties = z.enum(AI_DIFFICULTIES);

const RawAnswer = z.strictObject({
  kind: z.enum(ANSWER_KINDS),
  value: z.union([z.string().min(1).max(AI_LIMITS.answer), z.array(z.string().min(1).max(AI_LIMITS.answer)).min(1).max(AI_LIMITS.listAnswers)]),
});

/** The item exactly as a model returns it. No other keys are accepted; `check` is parsed separately (it is a claim, not text). */
export const RawAiItemSchema = z.strictObject({
  role: Roles,
  difficulty: Difficulties,
  stem: z.string().min(1).max(AI_LIMITS.stem),
  answer: RawAnswer,
  steps: z.array(z.string().min(1).max(AI_LIMITS.step)).min(1).max(AI_LIMITS.steps),
  check: z.unknown().optional(),
});

/** What the pipeline records about the call that produced an item (spec 5.8). Strings only, set by our code. */
export const GenConfigSchema = z.strictObject({
  promptVersion: z.string().min(1).max(40),
  schemaVersion: z.literal(AI_ITEMS_SCHEMA_VERSION),
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(80),
  configId: z.string().min(1).max(80),
  checkersVersion: z.string().min(1).max(40),
  parserVersion: z.string().min(1).max(40),
});
export type GenConfig = z.infer<typeof GenConfigSchema>;
export type CallConfig = Pick<GenConfig, "promptVersion" | "provider" | "model" | "configId">;

export const MathDoc = z.custom<MathTextDoc>((v) => isMathTextDoc(v));
export const StoredAnswerSchema = z.strictObject({ kind: z.enum(ANSWER_KINDS), value: z.union([MathDoc, z.array(MathDoc).min(1).max(AI_LIMITS.listAnswers)]) });
export const ItemHashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const AiStatusSchema = z.enum(["code_checked", "cross_checked", "unchecked", "failed"]);

/** The persisted form of an admitted item, as it is spread over a question block and a solution block. */
export const StoredAiItemSchema = z.strictObject({
  role: Roles,
  difficulty: Difficulties,
  stem: MathDoc,
  answer: StoredAnswerSchema,
  steps: z.array(MathDoc).min(1).max(AI_LIMITS.steps),
  claim: ClaimSchema.optional(),
  status: AiStatusSchema,
  itemHash: ItemHashSchema,
  genConfig: GenConfigSchema,
});
export type StoredAiItem = z.infer<typeof StoredAiItemSchema>;

declare const admitted: unique symbol;
/** An item that passed the gate. `fingerprint` is for de-duplication; `itemHash` pairs the question with its answer. */
export type AiItem = StoredAiItem & { readonly [admitted]: true; readonly fingerprint: string };

type Field = "stem" | "answer" | "step";
export type AiRejectReason =
  | "schema"
  | "length"
  | `parse:${Field}:${string}`
  | `forbidden:${Field}:${string}`
  | "answer_kind"
  | "answer_shape"
  | "claim_invalid"
  | "check_failed"
  | `unsafe:${Field}:${string}`
  | "duplicate";

export type AdmitResult = { ok: true; item: AiItem } | { ok: false; reason: AiRejectReason };

export interface AdmitOptions {
  /** Answer kinds the topic allows. */
  allowedKinds: readonly AnswerKind[];
  /** Curriculum names and official codes of the selected context; wording that contains one is refused. */
  forbiddenNames: readonly string[];
  /** Fingerprints already in the draft, its spares and the blocklist. */
  exclude: ReadonlySet<string>;
  config: CallConfig;
  /** Called with the reason code of every refusal (the caller logs it). Receives a code only, never any text the model wrote. */
  onReject?: (reason: AiRejectReason) => void;
}

/** Wording rules on the text parts of a document. Digits and symbols in text are MathText's business, not prose rules'. */
const WORDING_CODES = new Set(["PROSE_MAKES_CURRICULUM_CLAIM", "PROSE_META_TEXT", "PROSE_NAMES_CURRICULUM"]);

export function forbiddenWording(doc: MathTextDoc, names: readonly string[]): string | null {
  for (const part of doc.parts) {
    if (part.t !== "text") continue;
    const hit = checkText(part.s, [...names]).find((c) => WORDING_CODES.has(c));
    if (hit) return hit;
  }
  return null;
}

type Located<T> = { ok: true; value: T } | { ok: false; reason: AiRejectReason };

function parseField(field: Field, source: string, names: readonly string[]): Located<MathTextDoc> {
  const parsed = parseMathText(source);
  if (!parsed.ok) return { ok: false, reason: `parse:${field}:${parsed.code}` };
  const wording = forbiddenWording(parsed.doc, names);
  if (wording) return { ok: false, reason: `forbidden:${field}:${wording}` };
  const unsafe = checkMathTextRenders(parsed.doc);
  if (unsafe) return { ok: false, reason: `unsafe:${field}:${unsafe}` };
  return { ok: true, value: parsed.doc };
}

/** Everything an item's hash covers: the question, the answer, the steps and the claim, never the status or the model's difficulty guess. */
export function itemHashOf(item: Pick<StoredAiItem, "stem" | "answer" | "steps" | "claim">): string {
  return sha256Hex(canonicalJson({ v: AI_ITEMS_SCHEMA_VERSION, stem: item.stem, answer: item.answer, steps: item.steps, claim: item.claim ?? null }));
}

/** Two items are the same question when the stem and the stated answer have the same canonical AST. */
export function fingerprintOf(stem: MathTextDoc, answer: AnswerDoc): string {
  return sha256Hex(canonicalJson({ stem, answer }));
}

export function genConfigFor(call: CallConfig): GenConfig {
  return { ...call, schemaVersion: AI_ITEMS_SCHEMA_VERSION, checkersVersion: CHECKERS_VERSION, parserVersion: MATHTEXT_PARSER_VERSION };
}

function shapeMatches(kind: AnswerKind, value: string | readonly unknown[]): boolean {
  if (kind === "roots") return Array.isArray(value);
  if (kind === "pair") return Array.isArray(value) && value.length <= 2;
  return typeof value === "string";
}

/** Whether a stored answer's value has the shape its kind needs (a list for `roots` and `pair`, one document otherwise). */
export function answerShapeOk(answer: AnswerDoc): boolean {
  return shapeMatches(answer.kind, Array.isArray(answer.value) ? answer.value : "doc");
}

function parseAnswer(raw: z.infer<typeof RawAnswer>, names: readonly string[]): Located<AnswerDoc> {
  const sources = Array.isArray(raw.value) ? raw.value : [raw.value];
  const docs: MathTextDoc[] = [];
  for (const source of sources) {
    const doc = parseField("answer", source, names);
    if (!doc.ok) return doc;
    docs.push(doc.value);
  }
  return { ok: true, value: { kind: raw.kind, value: Array.isArray(raw.value) ? docs : docs[0]! } };
}

/** The gate. Total: returns a reason code for anything wrong, never throws, never echoes model text. */
export function admitAiItem(raw: unknown, options: AdmitOptions): AdmitResult {
  const result = admit(raw, options);
  if (!result.ok) options.onReject?.(result.reason);
  return result;
}

function admit(raw: unknown, options: AdmitOptions): AdmitResult {
  const shape = RawAiItemSchema.safeParse(raw);
  if (!shape.success) return { ok: false, reason: shape.error.issues.some((i) => i.code === "too_big") ? "length" : "schema" };
  const r = shape.data;

  if (!options.allowedKinds.includes(r.answer.kind)) return { ok: false, reason: "answer_kind" };
  if (!shapeMatches(r.answer.kind, r.answer.value)) return { ok: false, reason: "answer_shape" };

  const stem = parseField("stem", r.stem, options.forbiddenNames);
  if (!stem.ok) return stem;
  const answer = parseAnswer(r.answer, options.forbiddenNames);
  if (!answer.ok) return answer;
  const steps: MathTextDoc[] = [];
  for (const s of r.steps) {
    const step = parseField("step", s, options.forbiddenNames);
    if (!step.ok) return step;
    steps.push(step.value);
  }

  let claim: Claim | undefined;
  if (r.check !== undefined) {
    const parsedClaim = parseRawClaim(r.check);
    if (!parsedClaim.ok) return { ok: false, reason: "claim_invalid" };
    claim = parsedClaim.claim;
  }

  const outcome = runChecker({ stem: stem.value, answer: answer.value, claim });
  if (outcome.result === "fail") return { ok: false, reason: "check_failed" };
  const status = statusFromChecks(outcome, null);

  const fingerprint = fingerprintOf(stem.value, answer.value);
  if (options.exclude.has(fingerprint)) return { ok: false, reason: "duplicate" };

  const content = { role: r.role, difficulty: r.difficulty, stem: stem.value, answer: answer.value, steps, ...(status === "code_checked" && claim ? { claim } : {}) };
  const item = { ...content, status, itemHash: itemHashOf(content), genConfig: genConfigFor(options.config), fingerprint } as AiItem;
  return { ok: true, item };
}

/**
 * The optional second model call (spec 5.3): `second` is its raw answer to the bare stem. Only an item no checker covered
 * can become `cross_checked` (agreement) or `failed` (disagreement); a code-checked item is returned unchanged.
 */
export function applyCrossCheck(item: AiItem, second: unknown, names: readonly string[] = []): AiItem {
  if (item.status !== "unchecked") return item;
  const shape = RawAnswer.safeParse(second);
  const parsed = shape.success ? parseAnswer(shape.data, names) : null;
  const result: CrossCheckResult = parsed?.ok ? compareAnswers(item.answer, parsed.value) : null;
  if (result === null) return item;
  return { ...item, status: statusFromChecks({ result: "none", reason: "no_claim" }, result) };
}

function compareAnswers(stated: AnswerDoc, second: AnswerDoc): CrossCheckResult {
  const a = canonicalAnswer(stated);
  const b = canonicalAnswer(second);
  if (a === null || b === null) return null;
  return a === b ? "agree" : "disagree";
}

const RANK: Record<AiStatus, number> = { failed: 0, unchecked: 1, cross_checked: 2, code_checked: 3 };

export type Rederivation =
  | { ok: true; status: AiStatus }
  | { ok: false; code: "ITEM_HASH_MISMATCH" | "STATUS_OVERSTATED" | "CHECK_FAILED"; status: AiStatus };

/**
 * Validation never trusts a stored status. The checker is run again on the stored stem, answer and claim: a disagreement
 * is `failed`; a stored status stronger than what code can re-derive is refused; a stored `cross_checked` stays (it
 * records a past model call that code cannot repeat). A stored status weaker than the code derives is kept as stored.
 */
export function rederiveAiStatus(item: StoredAiItem): Rederivation {
  if (itemHashOf(item) !== item.itemHash) return { ok: false, code: "ITEM_HASH_MISMATCH", status: "failed" };
  const outcome = runChecker({ stem: item.stem, answer: item.answer, claim: item.claim });
  if (outcome.result === "fail") return { ok: false, code: "CHECK_FAILED", status: "failed" };
  const derived: AiStatus = outcome.result === "pass" ? "code_checked" : item.status === "cross_checked" ? "cross_checked" : "unchecked";
  if (RANK[item.status] > RANK[derived]) return { ok: false, code: "STATUS_OVERSTATED", status: derived };
  return { ok: true, status: item.status };
}
