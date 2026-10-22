import "server-only";
import type { GenerationJob } from "@/generated/prisma/client";
import type { ChangeSummary, PendingCandidate, Slot } from "@/lib/package/draft-ops";
import type { DocumentKind, LessonPackage } from "@/lib/package/schema";

/** What callers may see of a job: no budgets, lease details or request hash. */
export interface JobDto {
  id: string;
  kind: "generate" | "compile";
  state: "queued" | "running" | "succeeded" | "failed" | "canceled";
  stage: "generating" | "validating" | "compiling" | "storing" | null;
  lessonId: string;
  revisionId: string | null;
  attempt: number;
  maxAttempts: number;
  cancelRequested: boolean;
  errorCode: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export function toJobDto(job: GenerationJob): JobDto {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    stage: job.stage,
    lessonId: job.lessonId,
    revisionId: job.revisionId,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    cancelRequested: job.cancelRequestedAt !== null,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

/** What `createDraft` returns: ids and the expiry only. */
export interface DraftCreated {
  draftId: string;
  versionId: string;
  expiresAt: Date;
}

/** The Prepare page's selection parameters (curriculum version, level, course, unit, topic). */
export interface DraftSelection {
  v: string;
  level?: string;
  course?: string;
  unit?: string;
  topic: string;
}

/** One row of the drafts list. No content and no context blob. */
export interface DraftSummaryDto {
  draftId: string;
  title: string;
  documents: DocumentKind[];
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

/**
 * One version of a draft for server-side rendering. `package` is the full verified package: pass it to the HTML view
 * builders on the server and send only the resulting view tree to client components, never the package itself.
 * The curriculum context blob is not a separate field (it is inside the package, as the validators need it).
 */
export interface DraftViewDto {
  draftId: string;
  versionId: string;
  ordinal: number;
  /** Revision of the shown version (question operations name it). */
  rev: number;
  /** Revision of the draft row (the active-version pointer); version operations name it. */
  draftRev: number;
  /** The version the draft currently points at (the one shown when the URL names none). */
  activeVersionId: string;
  /** Every version, lightweight, in ordinal order. */
  versions: DraftVersionSummary[];
  versionLimit: number;
  contentHash: string;
  expiresAt: Date;
  documents: DocumentKind[];
  title: string;
  /** The choices this draft was made from, as the Prepare page's URL parameters: enough to start the same selection again. */
  selection: DraftSelection;
  package: LessonPackage;
  /** Question-level adjustment state (S2). Server-side only, like `package`. */
  adjust: DraftAdjustView;
}

/** One version without its content. */
export interface DraftVersionSummary {
  versionId: string;
  ordinal: number;
  createdAt: Date;
  changesSummary: ChangeSummary;
  isActive: boolean;
}

/** What createVersion and switchVersion return: the new draft revision and the version now active. */
export interface DraftVersionResult {
  draftRev: number;
  versionId: string;
  ordinal: number;
  expiresAt: Date;
}

export interface DraftAdjustView {
  /** The exercises in worksheet order with the level and origin of each. */
  slots: Slot[];
  changes: ChangeSummary;
  /** What the Undo button would undo, or null when there is nothing to undo. */
  undoLabel: string | null;
  /** The single pending candidate, if any (it survives a refresh). */
  candidate: PendingCandidate | null;
  /** Remaining question count above which Remove is allowed (the effective minimum). */
  minExercises: number;
}

/** What an adjustment returns: the version's new revision and content hash. */
export interface DraftMutationResult {
  rev: number;
  contentHash: string;
}
