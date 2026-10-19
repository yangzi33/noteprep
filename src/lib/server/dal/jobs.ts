import "server-only";
import { NotFound, StaleOrCanceled } from "@/lib/domain/errors";
import { backoffDelayMs, DEFAULT_BACKOFF, type BackoffPolicy } from "@/lib/domain/retry";
import type { Db } from "../db";
import { finishLockedJob } from "./reservation";
import { inTransaction, type Tx } from "./tx";

export interface ClaimedJob {
  id: string;
  ownerId: string;
  lessonId: string;
  /** Present on every write this attempt makes; a newer claim invalidates it. */
  fencingToken: bigint;
  attempt: number;
  maxAttempts: number;
  deadlineAt: Date;
}

export type HeartbeatResult = "ok" | "cancel_requested" | "lost";

export interface UsageCharge {
  calls: number;
  tokens: number;
  costMicros: number;
}

export interface SweepReport {
  requeued: number;
  failed: number;
  canceled: number;
  /** Buckets whose counters disagree with their reservation rows: an alert, never auto-repaired. */
  drift: string[];
}

type Stage = "generating" | "validating" | "compiling" | "storing";

interface RunningRow {
  state: string;
  fencing_token: bigint;
  attempt: number;
  max_attempts: number;
  deadline_at: Date;
  cancel_requested_at: Date | null;
}

async function lockRunning(tx: Tx, jobId: string, token: bigint): Promise<RunningRow> {
  const rows = await tx.$queryRaw<RunningRow[]>`
    SELECT state::text AS state, fencing_token, attempt, max_attempts, deadline_at, cancel_requested_at
      FROM generation_job WHERE id = ${jobId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new NotFound();
  if (row.state !== "running" || row.fencing_token !== token) throw new StaleOrCanceled();
  return row;
}

/** Worker-side job lifecycle: claim, lease, budget, retry, and the recovery sweeper. */
export function createJobsDal(db: Db, backoff: BackoffPolicy = DEFAULT_BACKOFF) {
  return {
    /**
     * Atomically claims one runnable job: the row lock is skipped (not waited on) when another worker
     * holds it, the fencing token increases, and the lease starts. No transaction stays open afterwards.
     */
    async claimNext(workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
      const rows = await db.$queryRaw<
        { id: string; owner_id: string; lesson_id: string; fencing_token: bigint; attempt: number; max_attempts: number; deadline_at: Date }[]
      >`
        UPDATE generation_job
           SET state = 'running'::job_state, stage = 'generating'::job_stage, lease_owner = ${workerId},
               lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
               fencing_token = fencing_token + 1, attempt = attempt + 1, started_at = COALESCE(started_at, now())
         WHERE id = (
           SELECT id FROM generation_job
            WHERE state = 'queued'::job_state AND kind = 'generate'::job_kind
              AND run_after <= now() AND cancel_requested_at IS NULL
              AND attempt < max_attempts AND deadline_at > now()
            ORDER BY run_after, created_at
            FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, owner_id, lesson_id, fencing_token, attempt, max_attempts, deadline_at`;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        ownerId: row.owner_id,
        lessonId: row.lesson_id,
        fencingToken: row.fencing_token,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        deadlineAt: row.deadline_at,
      };
    },

    /** Extends the lease. `lost` means another claim superseded this attempt: stop immediately. */
    async heartbeat(jobId: string, token: bigint, leaseMs: number, stage?: Stage): Promise<HeartbeatResult> {
      const rows = await db.$queryRaw<{ cancel_requested_at: Date | null }[]>`
        UPDATE generation_job
           SET lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
               stage = COALESCE(${stage ?? null}::job_stage, stage)
         WHERE id = ${jobId}::uuid AND fencing_token = ${token} AND state = 'running'::job_state
     RETURNING cancel_requested_at`;
      const row = rows[0];
      if (!row) return "lost";
      return row.cancel_requested_at ? "cancel_requested" : "ok";
    },

    /** The lesson's request, readable only by the attempt that currently owns the job. */
    async getInput(jobId: string, token: bigint): Promise<unknown> {
      const rows = await db.$queryRaw<{ input_spec: unknown }[]>`
        SELECT l.input_spec FROM generation_job j JOIN lesson l ON l.id = j.lesson_id AND l.owner_id = j.owner_id
         WHERE j.id = ${jobId}::uuid AND j.fencing_token = ${token} AND j.state = 'running'::job_state`;
      if (!rows[0]) throw new StaleOrCanceled();
      return rows[0].input_spec;
    },

    /**
     * Adds an attempt's usage to the job's single total budget (shared by all retries). `exceeded`
     * means a limit is now passed; the caller must stop and fail the job.
     */
    async chargeUsage(jobId: string, token: bigint, usage: UsageCharge): Promise<{ exceeded: boolean }> {
      const rows = await db.$queryRaw<{ exceeded: boolean }[]>`
        UPDATE generation_job
           SET calls_used = calls_used + ${usage.calls}, tokens_used = tokens_used + ${usage.tokens}::bigint,
               cost_micros = cost_micros + ${usage.costMicros}::bigint
         WHERE id = ${jobId}::uuid AND fencing_token = ${token} AND state = 'running'::job_state
     RETURNING (calls_used > max_calls OR tokens_used > max_tokens OR cost_micros > max_cost_micros) AS exceeded`;
      if (!rows[0]) throw new StaleOrCanceled();
      return { exceeded: rows[0].exceeded };
    },

    /**
     * A recoverable failure: back to the queue with exponential backoff and jitter, keeping the SAME
     * reservation, unless attempts or the deadline are used up, in which case the job fails and the
     * reservation is released.
     */
    async retryOrFail(jobId: string, token: bigint, errorCode: string, random: () => number = Math.random): Promise<"requeued" | "failed"> {
      return inTransaction(db, async (tx) => {
        const job = await lockRunning(tx, jobId, token);
        const delayMs = backoffDelayMs(job.attempt, backoff, random);
        const remaining = await tx.$queryRaw<{ ok: boolean }[]>`
          SELECT (now() + (${delayMs}::int * interval '1 millisecond') < ${job.deadline_at}::timestamptz) AS ok`;
        if (job.cancel_requested_at || job.attempt >= job.max_attempts || !remaining[0]?.ok) {
          await finishLockedJob(tx, jobId, job.cancel_requested_at ? "canceled" : "failed", job.cancel_requested_at ? "canceled" : errorCode);
          return "failed";
        }
        await tx.$executeRaw`
          UPDATE generation_job
             SET state = 'queued'::job_state, stage = NULL, lease_owner = NULL, lease_expires_at = NULL,
                 run_after = now() + (${delayMs}::int * interval '1 millisecond')
           WHERE id = ${jobId}::uuid`;
        return "requeued";
      });
    },

    /**
     * Recovery for crashed, stalled and abandoned work. Idempotent and safe to run from several
     * workers: rows are taken with SKIP LOCKED, and every give-up path releases the reservation.
     */
    async sweep(limit = 50): Promise<SweepReport> {
      const report: SweepReport = { requeued: 0, failed: 0, canceled: 0, drift: [] };
      const ids = await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM generation_job
         WHERE (state = 'running'::job_state AND lease_expires_at < now())
            OR (state = 'queued'::job_state AND (deadline_at <= now() OR attempt >= max_attempts OR cancel_requested_at IS NOT NULL))
         ORDER BY created_at LIMIT ${limit}`;
      for (const { id } of ids) {
        await inTransaction(db, async (tx) => {
          const rows = await tx.$queryRaw<
            { state: string; attempt: number; max_attempts: number; expired: boolean; past_deadline: boolean; canceled: boolean }[]
          >`
            SELECT state::text AS state, attempt, max_attempts,
                   (state = 'running'::job_state AND lease_expires_at < now()) AS expired,
                   (deadline_at <= now()) AS past_deadline,
                   (cancel_requested_at IS NOT NULL) AS canceled
              FROM generation_job WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
          const job = rows[0];
          if (!job) return; // another sweeper has it
          const stalled = job.state === "running" && job.expired;
          const stuckQueued = job.state === "queued" && (job.past_deadline || job.attempt >= job.max_attempts || job.canceled);
          if (!stalled && !stuckQueued) return; // recovered meanwhile (heartbeat or claim)

          if (job.canceled) {
            await finishLockedJob(tx, id, "canceled", "canceled");
            report.canceled++;
          } else if (job.past_deadline) {
            await finishLockedJob(tx, id, "failed", "deadline_exceeded");
            report.failed++;
          } else if (job.attempt >= job.max_attempts) {
            await finishLockedJob(tx, id, "failed", "max_attempts_exceeded");
            report.failed++;
          } else {
            const delayMs = backoffDelayMs(job.attempt, backoff);
            await tx.$executeRaw`
              UPDATE generation_job
                 SET state = 'queued'::job_state, stage = NULL, lease_owner = NULL, lease_expires_at = NULL,
                     run_after = now() + (${delayMs}::int * interval '1 millisecond')
               WHERE id = ${id}::uuid`;
            report.requeued++;
          }
        });
      }
      const drift = await db.$queryRaw<{ bucket_id: string }[]>`SELECT bucket_id FROM usage_bucket_drift`;
      report.drift = drift.map((d) => d.bucket_id);
      return report;
    },
  };
}

export type JobsDal = ReturnType<typeof createJobsDal>;
