import "server-only";
import type { GenerationJob } from "@/generated/prisma/client";

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
