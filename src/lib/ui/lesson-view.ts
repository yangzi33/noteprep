import type { AlignmentView } from "@/lib/server/dal";
import type { DocumentKind } from "@/lib/package/schema";

export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  notes: "Tutor Lesson Notes",
  worksheet: "Student Practice Worksheet",
  solutions: "Solutions / Answer Key",
};

/** The review reminder shown on the draft, export confirmation and lesson pages. Never claims zero errors. */
export const REVIEW_REMINDER = "AI-assisted material can contain mistakes. Read everything before you use it with a student.";

export const DOCUMENT_PURPOSE: Record<DocumentKind, string> = {
  notes: "For you: explanations, worked examples and a teaching sequence",
  worksheet: "For the student: practice questions with space to write, no answers",
  solutions: "For you: answers and worked steps for the worksheet",
};

/**
 * The sentence shown about curriculum alignment. It is built from the dataset's own fields only. A lesson from a sample
 * synthetic or suggested dataset never gets an alignment claim, however the model worded anything else.
 */
export function alignmentNotice(alignment: Pick<AlignmentView, "claim" | "curriculumName" | "versionLabel" | "datasetKind">): string {
  if (alignment.datasetKind === "real") {
    return alignment.claim === "aligned"
      ? `Built from ${alignment.curriculumName} (${alignment.versionLabel}).`
      : `Built from ${alignment.curriculumName} (${alignment.versionLabel}). This lesson makes no claim of alignment.`;
  }
  if (alignment.datasetKind === "suggested") {
    return `The topic list is an unofficial NotePrep suggestion (“${alignment.curriculumName} (${alignment.versionLabel})”). It is not an official curriculum and is not endorsed by any curriculum authority. This lesson makes no claim of alignment.`;
  }
  return `Based on the ${alignment.datasetKind === "synthetic" ? "test" : "sample"} dataset “${alignment.curriculumName}” (${alignment.versionLabel}). This is not a real curriculum and makes no claim of alignment.`;
}

/**
 * What a succeeded job's status panel says. A link appears only when the server has confirmed that a preview exists;
 * a succeeded state that the browser saw by polling waits for the server's answer (the page then redirects or re-renders).
 */
export function succeededPanel(job: { lessonId: string; revisionId: string | null }, state: { serverConfirmed: boolean; hasPreview: boolean }): { href: string | null; text: string } {
  if (!state.serverConfirmed) return { href: null, text: "Opening your lesson…" };
  if (state.hasPreview && job.revisionId) return { href: `/lessons/${job.lessonId}?rev=${job.revisionId}`, text: "The lesson pack is ready." };
  return { href: null, text: "The lesson pack was saved; there is no preview for this one." };
}
