/**
 * The subject dimension of a curriculum. `math` is the stored id (curriculum.subject in the database and in every
 * published dataset); the datasets also accept `mathematics` as an alias and normalise it to `math` on read.
 * Only ACTIVE_SUBJECTS are ever offered to tutors (decision D-116: Math is the only active subject); other
 * subjects may be present in the data but stay invisible until separately approved and given a generation engine.
 */
export const SUBJECTS = ["math", "physics", "chemistry", "biology", "science"] as const;
export type Subject = (typeof SUBJECTS)[number];

export const ACTIVE_SUBJECTS: readonly Subject[] = ["math"];

export function isActiveSubject(subject: string): boolean {
  return (ACTIVE_SUBJECTS as readonly string[]).includes(subject);
}
