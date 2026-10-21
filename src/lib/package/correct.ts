import { z } from "zod";
import type { CurriculumContext } from "@/lib/curriculum/context";
import { TextEditTarget, type TextEdit } from "@/lib/domain/adjustment";
import { CorrectionRejected } from "@/lib/domain/errors";
import { canonicalJson } from "@/lib/domain/hash";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { printsLiterally } from "@/lib/latex/escape";
import { packageContentHash, planAdjustment } from "./adjust";
import { ALIGNMENT_TITLE } from "./build";
import { resolveEditTarget } from "./editable";
import { rehashPackage } from "./inputs";
import { checkText, curriculumNames } from "./prose-rules";
import type { LessonPackage, Section } from "./schema";
import { validatePackage, type Issue } from "./validate";

export { EDITABLE_BLOCKS, EDIT_FIELD_OF, titleEditable, type EditableBlockType } from "./editable";

/** At most this many edits in one correction (the request schema's bound, enforced again here). */
export const MAX_EDITS = 20;
/** Length bounds after normalisation: the package schema's title and text limits. */
export const MAX_TITLE_LENGTH = 120;
export const MAX_TEXT_LENGTH = 600;
/** A longer run of letters cannot be broken across lines by the template, and no ordinary English word is this long. */
export const MAX_WORD_LENGTH = 40;

/**
 * The wording as it is checked and stored: NFC; typographic single and double quotes (‘ ’ “ ”, which phone keyboards
 * insert) replaced by the plain ' and "; every whitespace run (tabs, newlines, NBSP, other Unicode spaces) collapsed
 * to one space; trimmed. Invisible format characters (zero-width, bidi controls) are not whitespace and stay, so the
 * character check rejects them.
 */
export function normalizeEditText(raw: string): string {
  return raw.normalize("NFC").replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/\s+/gu, " ").trim();
}

/** A scheme glued to what follows ("javascript:alert", "mailto:x", "ftp://"): a link even without "http" or a domain. */
const URL_LIKE = /\p{L}:(?=[\p{L}/])/u;

/**
 * Words that state a quantity (plan 2.6: a tutor cannot type any number, "step two" included; D-65). Banned as whole
 * words, case-insensitively; a hyphen is a word boundary, so "twenty-one" and "one-half" are caught.
 *  - cardinals: zero, two..twenty, thirty, forty, fifty, sixty, seventy, eighty, ninety, hundred(s), thousand(s),
 *    million(s), billion(s), dozen(s);
 *  - fractions and ordinals from third on: half, halves, halve(d), quarter(s), third(s), fourth(s) .. tenth(s);
 *  - multiplicative and counting words: twice, thrice, double(s/d), triple(s/d), single, couple(s), pair(s).
 * Deliberately allowed: "one" (also a pronoun: "no one", "each one", "one way"; it is refused only as an operand, see
 * ONE_AS_OPERAND), "first" and "second" (ordinary sequencing; "second" is also a unit), "next", "last", "once", and
 * words that merely contain a number word ("someone", "often", "thirdly", "halfway", "doubly").
 */
const NUMBER_WORD_LIST = [
  "zero", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundreds?", "thousands?", "millions?", "billions?", "dozens?",
  "half", "halves", "halved?", "quarters?", "thirds?", "fourths?", "fifths?", "sixths?", "sevenths?", "eighths?", "ninths?", "tenths?",
  "twice", "thrice", "doubles?", "doubled", "triples?", "tripled", "single", "couples?", "pairs?",
];
const NUMBER_WORD = new RegExp(`(?<![\\p{L}\\p{N}])(?:${NUMBER_WORD_LIST.join("|")})(?![\\p{L}\\p{N}])`, "iu");
/** "one" used as a number: an operand of an operation ("add one to", "divide both sides by one", "minus one", "one plus x"). */
const ONE_AS_OPERAND = new RegExp(
  [
    "\\b(?:add|adds|added|adding|subtract|subtracts|subtracted|subtracting|take away|takes away|taking away) one\\b",
    "\\b(?:divide|divides|divided|dividing|multiply|multiplies|multiplied|multiplying)\\b(?: [\\p{L}']+){0,6} by one\\b",
    "\\b(?:plus|minus|times|negative|squared|cubed|equals|equal to) one\\b",
    "\\bone (?:plus|minus|times|squared|cubed)\\b",
  ].join("|"),
  "iu",
);

/** Lowercase letters and digits only, accents removed: "Nörthwind-Algebra, Path" -> "northwindalgebrapath". */
export function nameSkeleton(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
/** Names shorter than this (as skeletons) are skipped: they would match inside ordinary words. */
const MIN_SKELETON = 4;

/** The skeletons a correction may not contain: the validator's curriculum names (name, version label, codes) and the alignment title. */
export function curriculumSkeletons(context: CurriculumContext): string[] {
  return [...new Set([...curriculumNames(context), ALIGNMENT_TITLE].map(nameSkeleton).filter((s) => s.length >= MIN_SKELETON))];
}

/**
 * Every rule a corrected text breaks, as stable codes (never the text). The same prose rules the validator applies to
 * generated wording (checkText: digits and math or markup characters, URLs and domains, number words used as operands,
 * curriculum claims and grade levels, meta text, curriculum names and codes, characters outside letters, spaces and
 * plain punctuation), plus rules for typed input only (generated text is not affected):
 *  - not empty, length, and no word longer than MAX_WORD_LENGTH;
 *  - `url_like`: a scheme glued to what follows;
 *  - `number_word`: NUMBER_WORD_LIST, and "one" as an operand;
 *  - `PROSE_NAMES_CURRICULUM` also when the skeleton of the text contains a curriculum skeleton (spacing, punctuation,
 *    case and accent variants of a name or code);
 *  - `compatibility_characters`: the text changes under NFKC (full-width letters, ligatures such as Ĳ, superscripts);
 *  - `unprintable_characters`: a letter or mark the LaTeX renderer would print as "?" (other scripts, which can also
 *    look like Latin letters and slip a banned word past the word rules, and leftover combining marks).
 */
export function correctionTextProblems(raw: string, kind: "title" | "text", names: readonly string[], skeletons: readonly string[] = []): string[] {
  if (raw.length > MAX_TEXT_LENGTH) return ["text_too_long"];
  const text = normalizeEditText(raw);
  if (text.length === 0) return ["text_empty"];
  const codes: string[] = [];
  if (text.length > (kind === "title" ? MAX_TITLE_LENGTH : MAX_TEXT_LENGTH)) codes.push("text_too_long");
  codes.push(...checkText(text, [...names]));
  if (URL_LIKE.test(text)) codes.push("url_like");
  if (text.split(/[\s\-–—]+/u).some((word) => [...word].length > MAX_WORD_LENGTH)) codes.push("word_too_long");
  if (NUMBER_WORD.test(text) || ONE_AS_OPERAND.test(text)) codes.push("number_word");
  const skeleton = nameSkeleton(text);
  if (skeletons.some((s) => skeleton.includes(s))) codes.push("PROSE_NAMES_CURRICULUM");
  if (text.normalize("NFKC") !== text) codes.push("compatibility_characters");
  if (![...text].every((ch) => !/[\p{L}\p{M}]/u.test(ch) || printsLiterally(ch))) codes.push("unprintable_characters");
  return [...new Set(codes)];
}

/** The edit's shape; the text is bounded by the rules above so an over-long text reports `text_too_long`. */
const EditShape = z.strictObject({ sectionId: z.string().min(1).max(200), target: TextEditTarget, text: z.string() });

const targetKey = (edit: TextEdit) => canonicalJson({ s: edit.sectionId, t: edit.target });

interface Checked {
  issues: Issue[];
  /** The edits that change something, with their normalised text. */
  effective: TextEdit[];
}

function check(pkg: LessonPackage, edits: readonly TextEdit[], context: CurriculumContext): Checked {
  const issues: Issue[] = [];
  const effective: TextEdit[] = [];
  if ((pkg.context as { contextHash?: unknown } | null)?.contextHash !== context.contextHash) return { issues: [{ code: "context_mismatch" }], effective };
  if (!Array.isArray(edits)) return { issues: [{ code: "invalid_edit" }], effective };
  if (edits.length > MAX_EDITS) return { issues: [{ code: "too_many_edits" }], effective };
  const names = curriculumNames(context);
  const skeletons = curriculumSkeletons(context);
  const seen = new Set<string>();
  edits.forEach((raw: unknown, i) => {
    const where = `edit:${i}`;
    const parsed = EditShape.safeParse(raw);
    if (!parsed.success) {
      issues.push({ code: "invalid_edit", where });
      return;
    }
    const edit = parsed.data;
    const resolved = resolveEditTarget(pkg, edit.sectionId, edit.target);
    if (!resolved.ok) {
      issues.push({ code: resolved.reason, where });
      return;
    }
    const key = targetKey(edit);
    if (seen.has(key)) issues.push({ code: "duplicate_target", where });
    seen.add(key);
    const text = edit.text.length > MAX_TEXT_LENGTH ? edit.text : normalizeEditText(edit.text);
    if (text === resolved.current) return; // a no-op: allowed, ignored
    for (const code of correctionTextProblems(edit.text, edit.target.field === "title" ? "title" : "text", names, skeletons)) issues.push({ code, where });
    effective.push({ ...edit, text });
  });
  if (issues.length === 0 && effective.length === 0) issues.push({ code: "nothing_changed" });
  return { issues, effective };
}

/**
 * Whether a tutor's text corrections may be applied: every target exists and is editable (EDITABLE_BLOCKS), no target
 * appears twice, at most MAX_EDITS edits, every changed text passes `correctionTextProblems`, and at least one edit
 * changes something. Issues carry codes and the edit's position only, never its text. Pure.
 */
export function checkCorrections(pkg: LessonPackage, edits: readonly TextEdit[], context: CurriculumContext): { ok: true } | { ok: false; issues: Issue[] } {
  const { issues } = check(pkg, edits, context);
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

type Block = Section["blocks"][number];

function withEdit(section: Section, edit: TextEdit): Section {
  const { target } = edit;
  if (target.field === "title") return { ...section, title: edit.text } as Section;
  const blocks = (section.blocks as Block[]).map((block, i): Block => {
    if (i !== target.blockIndex) return block;
    if (target.field === "block_text") return { ...block, text: edit.text } as Block;
    if (block.type === "list") return { ...block, items: block.items.map((item, j) => (j === target.itemIndex ? edit.text : item)) };
    if (block.type === "step_list") return { ...block, steps: block.steps.map((step, j) => (j === target.itemIndex ? edit.text : step)) };
    throw new Error("applyCorrections: an item edit reached a block without items");
  });
  return { ...section, blocks } as Section;
}

const MATH_OR_DATASET = new Set(["question", "solution", "worked_example", "writing_space", "timing", "alignment"]);
/** Everything a correction may not change: math and dataset blocks whole, and the shape (types, item counts) of prose. */
const fixedContent = (pkg: LessonPackage) =>
  canonicalJson(
    pkg.sections.map((s) => ({
      id: s.id,
      kind: s.kind,
      blocks: (s.blocks as Block[]).map((b) => {
        if (MATH_OR_DATASET.has(b.type)) return b;
        if (b.type === "list") return s.kind === "objectives" || s.kind === "prerequisites" ? b : { type: b.type, n: b.items.length };
        if (b.type === "step_list") return { type: b.type, n: b.steps.length };
        return b.type;
      }),
    })),
  );
const withoutInputsHash = (s: Section | undefined) => (s ? Object.fromEntries(Object.entries(s).filter(([key]) => key !== "inputsHash")) : undefined);

/**
 * Applies a tutor's text corrections and returns the new package. Pure and deterministic; `pkg` is never modified.
 * Throws `CorrectionRejected(codes)` (codes only, never the text) when `checkCorrections` refuses the edits or the
 * result would not verify.
 *
 * Each edited section gets `provenance.method = "tutor_edit"` (its seed, difficulty, generator and prompt versions are
 * kept) and `edited: true`; no-op edits are ignored. The package is rehashed: sections downstream by `references` only
 * get a new inputsHash, and the solutions (derived from the exercises) keep every block, since an edit never touches a
 * question. One `adjustments` record is appended (action and source hash; no text, no seed). Questions, answers, steps,
 * writing space, timing, alignment, the dataset lists, outline, deps, documents, request, context and seed are
 * byte-identical, and the planner's classification is checked as a contract.
 */
export function applyCorrections(pkg: LessonPackage, edits: readonly TextEdit[], context: CurriculumContext): LessonPackage {
  const { issues, effective } = check(pkg, edits, context);
  if (issues.length > 0) throw new CorrectionRejected([...new Set(issues.map((i) => i.code))]);
  const plan = planAdjustment(pkg, { action: "correct_text", edits: effective });

  const source = structuredClone(pkg);
  const edited = new Set(effective.map((e) => e.sectionId));
  const sections = source.sections.map((section) => {
    if (!edited.has(section.id)) return section;
    const next = effective.filter((e) => e.sectionId === section.id).reduce(withEdit, section);
    return { ...next, provenance: { ...next.provenance, method: "tutor_edit" as const }, edited: true } as Section;
  });
  const next: LessonPackage = {
    ...source,
    sections,
    adjustments: [...(source.adjustments ?? []), { action: "correct_text", method: "tutor_edit", sourceContentHash: packageContentHash(pkg) }],
  };
  const result = rehashPackage(next, source.request as Pick<LessonRequestV2, "difficulty">, context);

  // The planner's classification is the contract: kept sections byte for byte, rehashed and derived ones with only a
  // new inputsHash, and nothing outside the edited wording changes.
  const find = (p: LessonPackage, id: string) => p.sections.find((s) => s.id === id);
  for (const id of plan.unchanged) {
    if (canonicalJson(find(pkg, id)) !== canonicalJson(find(result, id))) throw new Error(`applyCorrections: section ${id} changed but the plan keeps it`);
  }
  for (const id of [...plan.rehashed, ...plan.dependents]) {
    if (canonicalJson(withoutInputsHash(find(pkg, id))) !== canonicalJson(withoutInputsHash(find(result, id)))) {
      throw new Error(`applyCorrections: section ${id} changed but the plan only rehashes it`);
    }
  }
  for (const key of ["schemaVersion", "request", "context", "seed", "outline", "deps", "documents"] as const) {
    if (canonicalJson(result[key]) !== canonicalJson(pkg[key])) throw new Error(`applyCorrections: ${key} changed`);
  }
  if (fixedContent(result) !== fixedContent(pkg)) throw new Error("applyCorrections: math or dataset content changed");

  if (validatePackage(result).overall !== "verified") throw new CorrectionRejected(["result_not_verified"]);
  return result;
}
