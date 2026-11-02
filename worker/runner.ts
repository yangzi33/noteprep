import { StaleOrCanceled } from "@/lib/domain/errors";
import type { ClaimedJob } from "@/lib/server/dal/jobs";
import { storageLogFields } from "@/lib/storage/store";
import { runExport } from "./export";
import { log } from "./log";
import { CancelRequested, LostLease, PipelineError, runPipeline, type PipelineDeps } from "./pipeline";

const DETAIL_MAX = 200;

/** Collapses whitespace and truncates; the text itself must already be redacted by whoever raised the error. */
const trimDetail = (detail: string) => detail.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX);

const errorClassOf = (error: unknown) => (error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "unknown");

export type JobOutcome = "succeeded" | "requeued" | "failed" | "canceled" | "abandoned";

/**
 * Runs one claimed job to a resolution while a heartbeat timer keeps the lease alive. Whatever
 * happens, the job ends in a state the database already allows: succeeded (settled in one
 * transaction), requeued with backoff, failed/canceled (reservation released), or abandoned because
 * a newer attempt owns it. The heartbeat is cleared on every path.
 */
export async function processJob(job: ClaimedJob, rawDeps: PipelineDeps): Promise<JobOutcome> {
  const controller = new AbortController();
  const { jobs, settlement, leaseMs } = rawDeps;
  const startedAt = Date.now();
  let stage: string | null = null;
  // The pipelines name the stage on every checkpoint heartbeat; remember the last one for the log lines.
  const deps: PipelineDeps = { ...rawDeps, jobs: { ...jobs, heartbeat: (id, token, lease, next) => (next && (stage = next), jobs.heartbeat(id, token, lease, next)) } };
  const fields = () => ({ jobId: job.id, kind: job.kind, attempt: job.attempt, stage, durationMs: Date.now() - startedAt });

  const timer = setInterval(() => {
    jobs
      .heartbeat(job.id, job.fencingToken, leaseMs)
      .then((state) => {
        if (state === "lost") controller.abort(new LostLease());
        else if (state === "cancel_requested") controller.abort(new CancelRequested());
      })
      .catch((error: unknown) => {
        // A failed heartbeat is not fatal by itself; if it keeps failing the lease simply expires.
        log("job_heartbeat_failed", { jobId: job.id, kind: job.kind, errorClass: errorClassOf(error) });
      });
  }, Math.max(1, Math.floor(leaseMs / 3)));

  try {
    await (job.kind === "export" ? runExport(job, deps, controller.signal) : runPipeline(job, deps, controller.signal));
    log("job_succeeded", fields());
    return "succeeded";
  } catch (raw) {
    const error = controller.signal.aborted ? controller.signal.reason : raw;
    try {
      if (error instanceof LostLease || error instanceof StaleOrCanceled) {
        log("job_abandoned", fields());
        return "abandoned";
      }
      if (error instanceof CancelRequested) {
        await settlement.finishJob({ jobId: job.id, fencingToken: job.fencingToken, outcome: "canceled", errorCode: "canceled" });
        log("job_canceled", fields());
        return "canceled";
      }
      if (error instanceof PipelineError && !error.retryable) {
        await settlement.finishJob({ jobId: job.id, fencingToken: job.fencingToken, outcome: "failed", errorCode: error.code });
        log("job_failed", { ...fields(), code: error.code, errorClass: errorClassOf(error), ...(error.detail ? { detail: trimDetail(error.detail) } : {}), ...storageLogFields(error.storage) });
        return "failed";
      }
      // Retryable pipeline errors and anything unexpected: bounded retry against the same reservation.
      const code = error instanceof PipelineError ? error.code : "internal_error";
      const result = await jobs.retryOrFail(job.id, job.fencingToken, code);
      // Only a PipelineError carries a redacted detail; for anything else the class alone is logged (messages can hold row or provider content).
      const detail = error instanceof PipelineError && error.detail ? { detail: trimDetail(error.detail) } : {};
      log(result === "requeued" ? "job_requeued" : "job_failed", { ...fields(), code, errorClass: errorClassOf(error), ...detail, ...(error instanceof PipelineError ? storageLogFields(error.storage) : {}) });
      return result;
    } catch (settleError) {
      if (settleError instanceof StaleOrCanceled) {
        log("job_abandoned", fields());
        return "abandoned";
      }
      // Could not record the outcome (for example the database is down): the lease will expire and
      // the sweeper recovers the job. Nothing is consumed or lost.
      log("job_unsettled", { ...fields(), code: errorClassOf(settleError), errorClass: errorClassOf(error) });
      return "abandoned";
    }
  } finally {
    clearInterval(timer);
  }
}
