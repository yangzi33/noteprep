import type { Dataset } from "./dataset-schema";

/** Courses with fewer distinct topic titles than this are not compared: tiny lists overlap by chance. */
export const TOPIC_SET_MIN = 5;
/** Two courses whose topic-title sets overlap at least this much (shared titles over the larger set) are treated as the same content entered twice. */
export const TOPIC_SET_SIMILARITY = 0.8;

export const normaliseTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The distinct normalised topic titles of each course, across all of its units. */
export function courseTopicSets(dataset: Dataset): Map<string, Set<string>> {
  const courseOfUnit = new Map(dataset.structure.units.map((u) => [u.id, u.courseId]));
  const sets = new Map<string, Set<string>>(dataset.structure.courses.map((c) => [c.id, new Set<string>()]));
  for (const t of dataset.structure.topics) {
    const courseId = courseOfUnit.get(t.unitId);
    if (courseId !== undefined) sets.get(courseId)?.add(normaliseTitle(t.title));
  }
  return sets;
}

/** Shared and total distinct titles of two sets. */
export function overlap(a: Set<string>, b: Set<string>): { shared: number; union: number } {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return { shared, union: a.size + b.size - shared };
}

type Variantable = { tier?: string; pathway?: string; sourceName?: string; sourceSection?: string };

/** Words that only say a label is a tier or a pathway; "Foundation tier" is found in a source that prints "Foundation". */
const GENERIC = new Set(["tier", "pathway", "route", "option", "course"]);

const sourceWords = (c: Variantable) => ` ${normaliseTitle(`${c.sourceName ?? ""} ${c.sourceSection ?? ""}`)} `;
const labelWords = (label: string | undefined) => normaliseTitle(label ?? "").split(" ").filter((w) => w !== "" && !GENERIC.has(w));

/** Whether every word of a tier or pathway label is printed, as a whole word, in the course's own source name or cited section. */
export function labelInSource(label: string | undefined, c: Variantable): boolean {
  const words = labelWords(label);
  const text = sourceWords(c);
  return words.length > 0 && words.every((w) => text.includes(` ${w} `));
}

/**
 * The tier and pathway labels of a course that can tell it apart from a sibling: the source prints them, and they are not
 * year or grade designations (a digit), which would let "Year 7" and "Year 8" excuse one list entered twice.
 */
function usableLabels(c: Variantable): string[] {
  return [c.tier, c.pathway].filter((l): l is string => l !== undefined && !/\d/.test(l) && labelInSource(l, c));
}

/** Two courses are told apart when each has a usable label that the other course's source does not print. */
function toldApart(a: Variantable, b: Variantable): boolean {
  const own = (x: Variantable, other: Variantable) => usableLabels(x).some((l) => !labelInSource(l, other));
  return own(a, b) && own(b, a);
}

export interface TopicSetDuplicate {
  /** Indexes into `structure.courses`, `first < second`. */
  first: number;
  second: number;
  /** Shared titles as a share of the larger of the two sets, 0..1. */
  similarity: number;
}

/**
 * Pairs of courses of one dataset whose topic-title sets are the same content entered twice. Similarity is the shared
 * titles over the larger set, so a copy with a few retitled topics is still caught while a course that is clearly larger
 * than the one it contains (12 of 18 titles) is not. Courses under TOPIC_SET_MIN titles are skipped. Parallel
 * variants of one level, each carrying a tier or pathway that its own source prints and the other's does not, may overlap.
 */
export function findTopicSetDuplicates(dataset: Dataset): TopicSetDuplicate[] {
  const { courses } = dataset.structure;
  const sets = courseTopicSets(dataset);
  const found: TopicSetDuplicate[] = [];
  for (let i = 0; i < courses.length; i++) {
    const a = courses[i]!;
    const setA = sets.get(a.id) ?? new Set<string>();
    if (setA.size < TOPIC_SET_MIN) continue;
    for (let j = i + 1; j < courses.length; j++) {
      const b = courses[j]!;
      const setB = sets.get(b.id) ?? new Set<string>();
      if (setB.size < TOPIC_SET_MIN) continue;
      if (a.levelId !== undefined && a.levelId === b.levelId && toldApart(a, b)) continue;
      const { shared } = overlap(setA, setB);
      const similarity = shared / Math.max(setA.size, setB.size);
      if (similarity >= TOPIC_SET_SIMILARITY) found.push({ first: i, second: j, similarity });
    }
  }
  return found;
}
