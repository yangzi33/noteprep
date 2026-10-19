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
  if (alignment.datasetKind !== "real" || alignment.claim !== "aligned") {
    return `Based on the ${alignment.datasetKind === "synthetic" ? "test" : "sample"} dataset “${alignment.curriculumName}” (${alignment.versionLabel}). This is not a real curriculum and makes no claim of alignment.`;
  }
  return `Built from ${alignment.curriculumName} (${alignment.versionLabel}).`;
}
