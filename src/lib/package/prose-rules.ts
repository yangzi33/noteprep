import type { CurriculumContext } from "@/lib/curriculum/context";

/**
 * Rules for every piece of generated wording (templates and model output alike). Math enters a document only
 * through validated question blocks, so a number, formula symbol, link or curriculum word in prose is a defect:
 * the narration could contradict the math or make a curriculum claim that only the dataset may make.
 */
const MATH_OR_MARKUP = /[\d=$\\<>{}^_~|]|https?:|www\./i;
const CLAIM_WORDS = /\b(align(ed|s|ment)?|curricul\w*|syllabus|standards?|expectations?)\b/i;
/**
 * Text that talks about the instructions or the model instead of the lesson (a symptom of injected instructions).
 * A bare "prompt" is NOT in the list: tutors prompt learners all the time (a real answer was wrongly rejected for it).
 */
const META_TEXT = /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|earlier|instructions?)\b|system prompt|as an? (ai|language model)|language model|\bjson\b/i;
/** Letters, marks, plain spaces and ordinary punctuation. Anything else (markdown, brackets, emoji, controls) is rejected. */
const ALLOWED_CHARS = /^[\p{L}\p{M}\p{Zs}.,;:'"()!?\-–—]+$/u;

export function curriculumNames(context: CurriculumContext): string[] {
  return [context.curriculum.name, context.curriculum.version.label, ...context.objectives.flatMap((o) => (o.officialCode ? [o.officialCode] : []))]
    .map((n) => n.toLowerCase())
    .filter((n) => n.length >= 3);
}

/** Every rule a text breaks (not just the first), so a report shows the whole problem. */
export function checkText(text: string, names: string[]): string[] {
  const codes: string[] = [];
  const mathOrMarkup = MATH_OR_MARKUP.test(text);
  if (mathOrMarkup) codes.push("PROSE_HAS_MATH_OR_MARKUP");
  if (!mathOrMarkup && !ALLOWED_CHARS.test(text)) codes.push("PROSE_UNUSUAL_CHARACTERS");
  if (CLAIM_WORDS.test(text)) codes.push("PROSE_MAKES_CURRICULUM_CLAIM");
  if (META_TEXT.test(text)) codes.push("PROSE_META_TEXT");
  const lower = text.toLowerCase();
  if (names.some((n) => lower.includes(n))) codes.push("PROSE_NAMES_CURRICULUM");
  return codes;
}
