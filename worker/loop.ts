import type { AiActionDal } from "@/lib/server/dal/ai-action";
import type { LlmSpendDal } from "@/lib/server/dal/llm-spend";
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
  /** Spend upkeep, a step of each sweep: settle stale reservations, close AI Actions, apply the kill switch, raise the 70 percent alert once. */
  spend?: { spend: Pick<LlmSpendDal, "recoverStale" | "claimAlerts" | "drift">; aiActions: Pick<AiActionDal, "finalizeTerminal" | "failQueuedWhenDisabled" | "releaseOrphans">; batchSize: number };
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
  log("job_claimed", { jobId: job.id, kind: job.kind, attempt: job.attempt, worker: workerId });
  return processJob(job, deps);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve(); // abort may have landed while a sweep/claim was awaiting
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Each step is isolated: one failing never stops the others or the job sweep. Events carry counts and codes only. */
export async function spendUpkeep(spend: NonNullable<LoopOptions["spend"]>): Promise<void> {
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      log(`${name}_error`, { code: error instanceof Error ? error.name : "unknown" });
    }
  };
  await step("spend_recover", async () => {
    const r = await spend.spend.recoverStale(spend.batchSize);
    if (r.recovered || r.errors) log("spend_recover", { recovered: r.recovered, errors: r.errors });
  });
  await step("ai_action_finalize", async () => {
    const r = await spend.aiActions.finalizeTerminal(spend.batchSize);
    if (r.completed || r.released || r.failed) log("ai_action_finalize", { ...r });
  });
  await step("ai_action_orphans", async () => {
    const released = await spend.aiActions.releaseOrphans(spend.batchSize);
    if (released) log("ai_action_orphans", { released });
  });
  await step("ai_kill_switch", async () => {
    const failed = await spend.aiActions.failQueuedWhenDisabled(spend.batchSize);
    if (failed) log("ai_kill_switch", { failedJobs: failed });
  });
  await step("spend_alert", async () => {
    for (const month of await spend.spend.claimAlerts()) log("llm_spend_alert", { month });
  });
  await step("spend_drift", async () => {
    const drift = await spend.spend.drift();
    if (drift.length) log("llm_spend_drift", { rows: drift.length });
  });
}

async function sweepForever(jobs: JobsDal, sweepMs: number, signal: AbortSignal, onAlive?: () => void, drafts?: LoopOptions["drafts"], spend?: LoopOptions["spend"]) {
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
    if (spend && !signal.aborted) await spendUpkeep(spend);
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

/** A real provider must never run unmetered or without the spend upkeep: refuse to start rather than spend outside the caps. */
export function assertSpendWired(options: Pick<LoopOptions, "deps" | "spend">): void {
  if (options.deps.llm.id === "fake") return;
  if (!options.deps.spend || !options.spend) throw new Error(`provider ${options.deps.llm.id} requires the spend ledger (deps.spend) and the spend upkeep (options.spend)`);
}

/** Polls for work until `signal` aborts; an in-flight job is allowed to finish (graceful shutdown). */
export async function runWorkerLoop(options: LoopOptions): Promise<void> {
  const { deps, workerId, pollMs, sweepMs, signal } = options;
  assertSpendWired(options);
  const step = options.runOnce ?? runOnce;
  const sweeper = sweepForever(deps.jobs, sweepMs, signal, options.onAlive, options.drafts, options.spend);
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
