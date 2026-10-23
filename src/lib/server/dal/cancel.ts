import "server-only";
import { NotFound } from "@/lib/domain/errors";
import type { Db } from "../db";
import { toJobDto, type JobDto } from "./dto";
import { finishLockedJob } from "./reservation";
import { inTransaction } from "./tx";

/**
 * Queued job: canceled now and its reservation released (and its export, if any, settled as failed). Running job: only
 * flagged; the worker (or the sweeper) finishes it, and a late success cannot be published. Terminal: unchanged.
 * Shared by generation.cancelJob and export.cancelExport. Lock order: the job row X, then finishLockedJob (export,
 * reservation, bucket). `jobId` must already be a valid uuid.
 */
export async function cancelOwnedJob(db: Db, ownerId: string, jobId: string): Promise<JobDto> {
  return inTransaction(db, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; state: string }[]>`
      SELECT id, state::text AS state FROM generation_job
       WHERE id = ${jobId}::uuid AND owner_id = ${ownerId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new NotFound();
    if (row.state === "queued") {
      await finishLockedJob(tx, jobId, "canceled", "canceled", { markCancelRequested: true });
      return toJobDto(await tx.generationJob.findUniqueOrThrow({ where: { id: jobId } }));
    }
    if (row.state === "running") {
      await tx.$executeRaw`
        UPDATE generation_job SET cancel_requested_at = COALESCE(cancel_requested_at, now()) WHERE id = ${jobId}::uuid`;
    }
    const job = await tx.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    return toJobDto(job);
  });
}
