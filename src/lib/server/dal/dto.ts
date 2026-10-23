import "server-only";
import type { GenerationJob } from "@/generated/prisma/client";
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
  rev: number;
  contentHash: string;
  expiresAt: Date;
  documents: DocumentKind[];
  title: string;
  /** The choices this draft was made from, as the Prepare page's URL parameters: enough to start the same selection again. */
  selection: DraftSelection;
  package: LessonPackage;
}
