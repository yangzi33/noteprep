export type JobState = "queued" | "running" | "succeeded" | "failed" | "canceled";

/** What the browser is allowed to know about a job: the same fields the API returns. */
export interface JobView {
  id: string;
  state: JobState;
  stage: "generating" | "validating" | "compiling" | "storing" | null;
  attempt: number;
  maxAttempts: number;
  cancelRequested: boolean;
  errorCode: string | null;
  lessonId: string;
  revisionId: string | null;
}

export function isTerminal(state: JobState): boolean {
  return state === "succeeded" || state === "failed" || state === "canceled";
}

/** A queued job that has already been tried is waiting to retry, not starting for the first time. */
export function isRetrying(job: Pick<JobView, "state" | "attempt">): boolean {
  return job.state === "queued" && job.attempt > 0;
}

export function toJobView(job: {
  id: string;
  state: JobState;
  stage: JobView["stage"];
  attempt: number;
  maxAttempts: number;
  cancelRequested: boolean;
  errorCode: string | null;
  lessonId: string;
  revisionId: string | null;
}): JobView {
  return {
    id: job.id,
    state: job.state,
    stage: job.stage,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    cancelRequested: job.cancelRequested,
    errorCode: job.errorCode,
    lessonId: job.lessonId,
    revisionId: job.revisionId,
  };
}
