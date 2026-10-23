import { StaleOrCanceled } from "@/lib/domain/errors";
import type { ClaimedJob } from "@/lib/server/dal/jobs";
import { storageLogFields } from "@/lib/storage/store";
import { log } from "./log";
import { CancelRequested, LostLease, PipelineError, runPipeline, type PipelineDeps } from "./pipeline";

export type JobOutcome = "succeeded" | "requeued" | "failed" | "canceled" | "abandoned";

/**
 * Runs one claimed job to a resolution while a heartbeat timer keeps the lease alive. Whatever
 * happens, the job ends in a state the database already allows: succeeded (settled in one
 * transaction), requeued with backoff, failed/canceled (reservation released), or abandoned because
 * a newer attempt owns it. The heartbeat is cleared on every path.
 */
export async function processJob(job: ClaimedJob, deps: PipelineDeps): Promise<JobOutcome> {
  const controller = new AbortController();
  const { jobs, settlement, leaseMs } = deps;
  const fields = { jobId: job.id, attempt: job.attempt };

  const timer = setInterval(() => {
    jobs
      .heartbeat(job.id, job.fencingToken, leaseMs)
      .then((state) => {
        if (state === "lost") controller.abort(new LostLease());
        else if (state === "cancel_requested") controller.abort(new CancelRequested());
      })
      .catch(() => {
        // A failed heartbeat is not fatal by itself; if it keeps failing the lease simply expires.
      });
  }, Math.max(1, Math.floor(leaseMs / 3)));

  try {
    // SAFETY NET until the export handler exists (S4b replaces this): an export job this worker cannot run is finished as
    // failed, which releases its reservation, instead of being run through the legacy generate pipeline.
    if (job.kind === "export") {
      clearInterval(timer);
      await settlement.finishJob({ jobId: job.id, fencingToken: job.fencingToken, outcome: "failed", errorCode: "export_not_supported" });
      log("job_failed", { ...fields, code: "export_not_supported" });
      return "failed";
    }
    await runPipeline(job, deps, controller.signal);
    log("job_succeeded", fields);
    return "succeeded";
  } catch (raw) {
    const error = controller.signal.aborted ? controller.signal.reason : raw;
    try {
      if (error instanceof LostLease || error instanceof StaleOrCanceled) {
        log("job_abandoned", fields);
        return "abandoned";
      }
      if (error instanceof CancelRequested) {
        await settlement.finishJob({ jobId: job.id, fencingToken: job.fencingToken, outcome: "canceled", errorCode: "canceled" });
        log("job_canceled", fields);
        return "canceled";
      }
      if (error instanceof PipelineError && !error.retryable) {
        await settlement.finishJob({ jobId: job.id, fencingToken: job.fencingToken, outcome: "failed", errorCode: error.code });
        log("job_failed", { ...fields, code: error.code, ...storageLogFields(error.storage) });
        return "failed";
      }
      // Retryable pipeline errors and anything unexpected: bounded retry against the same reservation.
      const code = error instanceof PipelineError ? error.code : "internal_error";
      const result = await jobs.retryOrFail(job.id, job.fencingToken, code);
      log(result === "requeued" ? "job_requeued" : "job_failed", { ...fields, code, ...(error instanceof PipelineError ? storageLogFields(error.storage) : {}) });
      return result;
    } catch (settleError) {
      if (settleError instanceof StaleOrCanceled) {
        log("job_abandoned", fields);
        return "abandoned";
      }
      // Could not record the outcome (for example the database is down): the lease will expire and
      // the sweeper recovers the job. Nothing is consumed or lost.
      log("job_unsettled", { ...fields, code: settleError instanceof Error ? settleError.name : "unknown" });
      return "abandoned";
    }
  } finally {
    clearInterval(timer);
  }
}
