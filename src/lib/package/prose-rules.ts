import type { CurriculumContext } from "@/lib/curriculum/context";

/**
 * Rules for every piece of generated wording (templates and model output alike). Math enters a document only
 * through validated question blocks, so a number, formula symbol, link or curriculum word in prose is a defect:
 * the narration could contradict the math or make a curriculum claim that only the dataset may make.
 */
const MATH_OR_MARKUP = /[\d=$\\<>{}^_~|]|https?:|www\./i;
/** Top-level domains that turn a bare "word.com" into a link a tutor could follow (an allowlist cannot be complete). */
const TLDS = "com|org|net|io|ai|app|dev|edu|gov|co|info|xyz|me|ly|tv|us|uk|ca|shop";
/** Spelled-out "dot com" only for the common words, so "a dot page by page" stays fine. Spaces around the dot are caught too. */
const SPOKEN_TLDS = "com|org|net|edu|gov|io|app|dev|ai";
const BARE_DOMAIN = new RegExp(`[\\p{L}\\p{N}-](?:\\.| \\. )(?:${TLDS})\\b|\\bdot (?:${SPOKEN_TLDS})\\b`, "iu");
/** Number words are quantities. "one" is left out on purpose: it is also a pronoun ("no one", "each one", "one way"). */
const NUM = "(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)";
/**
 * A number word that is an operand in an operation phrase: "add seven to", "subtract three from", "divide both sides by three",
 * "minus nine", "two plus x", "two times as large". "add two examples" and "three times if needed" are ordinary prose and pass.
 */
const NUMBER_WORD_QUANTITY = new RegExp(
  [
    `\\b(?:add|adds|subtract|subtracts|multiply|multiplies|take away) ${NUM} (?:to|from|by|and|on|off)\\b`,
    `\\b(?:add|adds|subtract|subtracts|multiply|multiplies|divide|divides)(?: [a-z]+){0,3} (?:by|to|from) ${NUM}\\b`,
    `\\b(?:plus|minus) ${NUM}\\b`,
    `\\b${NUM} (?:plus|minus|times) (?:${NUM}|x|y|n)\\b`,
    `\\b${NUM} times as\\b`,
  ].join("|"),
  "i",
);
const DIGITS_IN_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"].join("|");
const ORDINALS = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth";
/** The prompt forbids grade levels. "grade the answers" (the verb) stays fine. */
const GRADE_LEVEL = new RegExp(`\\bgrades?\\s+(?:${DIGITS_IN_WORDS}|[a-z]*\\d+)\\b|\\b(?:${ORDINALS})\\s+grade\\b`, "i");
/** "standard form" is ordinary maths wording; any other "standard(s)" is a claim. */
const CLAIM_WORDS = /\b(align(ed|s|ment)?|curricul\w*|syllabus|standards?(?!\s+(form|way|method|notation|algorithm))|expectations?|programmes?|ministry|official(ly)?)\b/i;
/**
 * Text that talks about the instructions or the model instead of the lesson (a symptom of injected instructions).
 * A bare "prompt" is NOT in the list: tutors prompt learners all the time (a real answer was wrongly rejected for it).
 */
const META_TEXT = /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|earlier|instructions?)\b|system (prompt|instructions?)|as an? (ai|language model)|language model|\bjson\b|\b(developer|dev|debug|admin|god|jailbreak|unrestricted|dan) mode\b|jailbreak|\breveal\b.{0,30}\b(rules|instructions|prompt)|\bhidden (rules|instructions|prompt)/i;
/** Letters, marks, plain spaces and ordinary punctuation. Anything else (markdown, brackets, emoji, controls) is rejected. */
const ALLOWED_CHARS = /^[\p{L}\p{M}\p{Zs}.,;:'"()!?\-–—]+$/u;

export function curriculumNames(context: CurriculumContext): string[] {
  return [context.curriculum.name, context.curriculum.version.label, ...context.objectives.flatMap((o) => (o.officialCode ? [o.officialCode] : []))]
    .map((n) => n.toLowerCase())
    .filter((n) => n.length >= 3);
}

/** Every rule a text breaks (not just the first), so a report shows the whole problem. */
export function checkText(rawText: string, names: string[]): string[] {
  // Any run of whitespace (NBSP, tabs, double spaces) must not hide a phrase; ALLOWED_CHARS still sees the raw text.
  const text = rawText.replace(/\s+/gu, " ");
  const codes: string[] = [];
  const mathOrMarkup = MATH_OR_MARKUP.test(text) || BARE_DOMAIN.test(text) || NUMBER_WORD_QUANTITY.test(text);
  if (mathOrMarkup) codes.push("PROSE_HAS_MATH_OR_MARKUP");
  if (!mathOrMarkup && !ALLOWED_CHARS.test(rawText)) codes.push("PROSE_UNUSUAL_CHARACTERS");
  if (CLAIM_WORDS.test(text) || GRADE_LEVEL.test(text)) codes.push("PROSE_MAKES_CURRICULUM_CLAIM");
  if (META_TEXT.test(text)) codes.push("PROSE_META_TEXT");
  const lower = text.toLowerCase();
  if (names.some((n) => lower.includes(n))) codes.push("PROSE_NAMES_CURRICULUM");
  return codes;
}
