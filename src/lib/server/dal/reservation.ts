import "server-only";
import type { Tx } from "./tx";

/**
 * reserved -> released, at most once. Returns whether a reservation was actually released;
 * a settled (or missing) reservation is left untouched, which makes retries safe.
 */
export async function releaseReservation(tx: Tx, jobId: string, reason: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ bucket_id: string }[]>`
    UPDATE usage_reservation
       SET state = 'released'::reservation_state, settle_reason = ${reason}, settled_at = now()
     WHERE job_id = ${jobId}::uuid AND state = 'reserved'::reservation_state
 RETURNING bucket_id`;
  const row = rows[0];
  if (!row) return false;
  await tx.$executeRaw`UPDATE usage_bucket SET reserved = reserved - 1 WHERE id = ${row.bucket_id}::uuid`;
  return true;
}

export type TerminalOutcome = "failed" | "canceled";

/**
 * An export that did not succeed: pending -> failed with the failure code, in the caller's transaction (the job is already
 * locked, so the lock order is job -> export). A no-op for every job that has no pending export row (all legacy jobs), and
 * for an export that has already settled. MUST run before the reservation is released: the deferred consistency trigger
 * requires a failed export to have a released reservation, and a released reservation to have a failed export.
 */
export async function settleExportFailure(tx: Tx, jobId: string, code: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE export SET state = 'failed', failure_code = ${code}, settled_at = now()
     WHERE job_id = ${jobId}::uuid AND state = 'pending'`;
}

export interface FinishOptions {
  /** Also record the cancel request (cancelJob on a queued job). */
  markCancelRequested?: boolean;
}

/**
 * Ends a job that the caller has ALREADY LOCKED (SELECT ... FOR UPDATE in the same transaction). EVERY terminal path goes
 * through here (finishJob, retryOrFail giving up, the sweeper, cancelJob on a queued job), in this order: settle the export
 * (if any), release the reservation (once), record the terminal state. So allowance is never held by a finished job.
 */
export async function finishLockedJob(tx: Tx, jobId: string, outcome: TerminalOutcome, errorCode: string, options: FinishOptions = {}): Promise<void> {
  await settleExportFailure(tx, jobId, errorCode);
  await releaseReservation(tx, jobId, outcome === "canceled" ? "canceled" : `failed:${errorCode}`);
  const now = new Date();
  await tx.generationJob.update({
    where: { id: jobId },
    data: {
      state: outcome,
      stage: null,
      errorCode,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: now,
      ...(options.markCancelRequested ? { cancelRequestedAt: now } : {}),
    },
  });
}
