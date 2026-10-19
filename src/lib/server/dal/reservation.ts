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
