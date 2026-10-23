import type { DraftsPurgeDal } from "@/lib/server/dal/drafts";
import type { JobsDal } from "@/lib/server/dal/jobs";
import { log } from "./log";
import { processJob, type JobOutcome } from "./runner";
import type { PipelineDeps } from "./pipeline";
import type { ReconcileReport } from "./reconcile";

export interface LoopOptions {
  deps: PipelineDeps;
  workerId: string;
  pollMs: number;
  sweepMs: number;
  signal: AbortSignal;
  /** Called after a successful sweep or job step: proof the worker reached the database. */
  onAlive?: () => void;
  /** Expired-draft purge, run as a second step of each sweep (its failure never affects job recovery or liveness). */
  drafts?: { purge: DraftsPurgeDal; batchSize: number };
  /**
   * Orphan-object reconcile in its OWN loop, once per `intervalMs`: it never runs inside the sweep, so a slow or hung storage
   * call cannot delay recovery, purge or liveness. The step itself carries a wall-clock budget; shutdown waits for it at most
   * `shutdownWaitMs` (default 5000). Its failure never affects anything else.
   */
  reconcile?: { step: (signal: AbortSignal) => Promise<ReconcileReport>; intervalMs: number; shutdownWaitMs?: number };
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

async function sweepForever(jobs: JobsDal, sweepMs: number, signal: AbortSignal, onAlive?: () => void, drafts?: LoopOptions["drafts"]) {
  while (!signal.aborted) {
    try {
      const report = await jobs.sweep();
      onAlive?.();
      if (report.requeued || report.failed || report.canceled || report.drift.length || report.exportDrift.length || report.sweepRowErrors) {
        log("sweep", { requeued: report.requeued, failed: report.failed, canceled: report.canceled, drift: report.drift.length, exportDrift: report.exportDrift.length, sweepRowErrors: report.sweepRowErrors });
      }
    } catch (error) {
      log("sweep_error", { code: error instanceof Error ? error.name : "unknown" });
    }
    if (drafts && !signal.aborted) {
      try {
        const purged = await drafts.purge.purgeExpired(drafts.batchSize);
        if (purged.expired || purged.deleted) log("draft_purge", { expired: purged.expired, deleted: purged.deleted });
      } catch (error) {
        log("draft_purge_error", { code: error instanceof Error ? error.name : "unknown" });
      }
    }
    await sleep(sweepMs, signal);
  }
}

async function reconcileForever(reconcile: NonNullable<LoopOptions["reconcile"]>, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      const r = await reconcile.step(signal);
      if (r.revisionsDeleted || r.attemptsDeleted || r.errors) log("reconcile", { ...r });
    } catch (error) {
      log("reconcile_error", { code: error instanceof Error ? error.name : "unknown" });
    }
    await sleep(reconcile.intervalMs, signal);
  }
}

/** Waits for `work`, but at most `ms`. */
function settleWithin(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void work.finally(() => (clearTimeout(timer), resolve()));
  });
}

/** Polls for work until `signal` aborts; an in-flight job is allowed to finish (graceful shutdown). */
export async function runWorkerLoop(options: LoopOptions): Promise<void> {
  const { deps, workerId, pollMs, sweepMs, signal } = options;
  const step = options.runOnce ?? runOnce;
  const sweeper = sweepForever(deps.jobs, sweepMs, signal, options.onAlive, options.drafts);
  const reconciler = options.reconcile ? reconcileForever(options.reconcile, signal) : Promise.resolve();
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
  await settleWithin(reconciler, options.reconcile?.shutdownWaitMs ?? 5_000);
  log("worker_stopped", { worker: workerId });
}
