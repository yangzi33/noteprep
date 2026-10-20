import type { JobsDal } from "@/lib/server/dal/jobs";
import { log } from "./log";
import { processJob, type JobOutcome } from "./runner";
import type { PipelineDeps } from "./pipeline";

export interface LoopOptions {
  deps: PipelineDeps;
  workerId: string;
  pollMs: number;
  sweepMs: number;
  signal: AbortSignal;
  /** Called after a successful sweep or job step: proof the worker reached the database. */
  onAlive?: () => void;
  /** Test seam; defaults to `runOnce`. */
  runOnce?: (deps: PipelineDeps, workerId: string) => Promise<JobOutcome | null>;
}

/** Claims and processes at most one job. Returns what happened, or null when nothing was runnable. */
export async function runOnce(deps: PipelineDeps, workerId: string): Promise<JobOutcome | null> {
  const job = await deps.jobs.claimNext(workerId, deps.leaseMs);
  if (!job) return null;
  log("job_claimed", { jobId: job.id, attempt: job.attempt, worker: workerId });
  return processJob(job, deps);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve(); // abort may have landed while a sweep/claim was awaiting
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

async function sweepForever(jobs: JobsDal, sweepMs: number, signal: AbortSignal, onAlive?: () => void) {
  while (!signal.aborted) {
    try {
      const report = await jobs.sweep();
      onAlive?.();
      if (report.requeued || report.failed || report.canceled || report.drift.length) {
        log("sweep", { requeued: report.requeued, failed: report.failed, canceled: report.canceled, drift: report.drift.length });
      }
    } catch (error) {
      log("sweep_error", { code: error instanceof Error ? error.name : "unknown" });
    }
    await sleep(sweepMs, signal);
  }
}

/** Polls for work until `signal` aborts; an in-flight job is allowed to finish (graceful shutdown). */
export async function runWorkerLoop(options: LoopOptions): Promise<void> {
  const { deps, workerId, pollMs, sweepMs, signal } = options;
  const step = options.runOnce ?? runOnce;
  const sweeper = sweepForever(deps.jobs, sweepMs, signal, options.onAlive);
  while (!signal.aborted) {
    try {
      const outcome = await step(deps, workerId);
      // An abandoned job means settlement failed, so the database was not demonstrably reachable.
      if (outcome !== "abandoned") options.onAlive?.();
      if (outcome === null) await sleep(pollMs, signal);
    } catch (error) {
      log("loop_error", { code: error instanceof Error ? error.name : "unknown" });
      await sleep(pollMs, signal);
    }
  }
  await sweeper;
  log("worker_stopped", { worker: workerId });
}
