import type { Dataset } from "./dataset-schema";

/** Courses with fewer distinct topic titles than this are not compared: tiny lists overlap by chance. */
export const TOPIC_SET_MIN = 5;
/** Two courses whose topic-title sets overlap at least this much (Jaccard) are treated as the same content entered twice. */
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

export interface TopicSetDuplicate {
  /** Indexes into `structure.courses`, `first < second`. */
  first: number;
  second: number;
  /** Shared share of the distinct titles of both, 0..1. */
  similarity: number;
}

/**
 * Pairs of courses of one dataset whose topic-title sets are the same content entered twice. Courses under TOPIC_SET_MIN
 * titles are skipped, and parallel tiers of one level (both named, different) may legitimately overlap.
 */
export function findTopicSetDuplicates(dataset: Dataset): TopicSetDuplicate[] {
  const { courses } = dataset.structure;
  const sets = courseTopicSets(dataset);
  const tier = (v: string | undefined) => normaliseTitle(v ?? "");
  const found: TopicSetDuplicate[] = [];
  for (let i = 0; i < courses.length; i++) {
    const a = courses[i]!;
    const setA = sets.get(a.id) ?? new Set<string>();
    if (setA.size < TOPIC_SET_MIN) continue;
    for (let j = i + 1; j < courses.length; j++) {
      const b = courses[j]!;
      const setB = sets.get(b.id) ?? new Set<string>();
      if (setB.size < TOPIC_SET_MIN) continue;
      if (a.levelId !== undefined && a.levelId === b.levelId && tier(a.tier) !== "" && tier(b.tier) !== "" && tier(a.tier) !== tier(b.tier)) continue;
      const { shared, union } = overlap(setA, setB);
      if (shared / union >= TOPIC_SET_SIMILARITY) found.push({ first: i, second: j, similarity: shared / union });
    }
  }
  return found;
}
