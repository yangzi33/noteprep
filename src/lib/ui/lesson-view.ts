import type { AlignmentView } from "@/lib/server/dal";
import type { DocumentKind } from "@/lib/package/schema";

export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  notes: "Tutor Lesson Notes",
  worksheet: "Student Practice Worksheet",
  solutions: "Solutions / Answer Key",
};

export const DOCUMENT_PURPOSE: Record<DocumentKind, string> = {
  notes: "For you: explanations, worked examples and a teaching sequence",
  worksheet: "For the student: practice questions with space to write, no answers",
  solutions: "For you: answers and worked steps for the worksheet",
};

/**
 * The sentence shown about curriculum alignment. It is built from the dataset's own fields only. A lesson from a sample
 * or synthetic dataset never gets an alignment claim, however the model worded anything else.
 */
export function alignmentNotice(alignment: Pick<AlignmentView, "claim" | "curriculumName" | "versionLabel" | "datasetKind">): string {
  if (alignment.datasetKind === "real") {
    return alignment.claim === "aligned"
      ? `Built from ${alignment.curriculumName} (${alignment.versionLabel}).`
      : `Built from ${alignment.curriculumName} (${alignment.versionLabel}). This lesson makes no claim of alignment.`;
  }
  return `Based on the ${alignment.datasetKind === "synthetic" ? "test" : "sample"} dataset “${alignment.curriculumName}” (${alignment.versionLabel}). This is not a real curriculum and makes no claim of alignment.`;
}

/** What a finished job's status panel offers: the revision's preview when there is one, otherwise an honest note. */
export function succeededLessonLink(job: { lessonId: string; revisionId: string | null }): { href: string | null; text: string } {
  return job.revisionId
    ? { href: `/lessons/${job.lessonId}?rev=${job.revisionId}`, text: "The lesson pack is ready." }
    : { href: null, text: "The lesson pack was saved, but it has no preview." };
}
