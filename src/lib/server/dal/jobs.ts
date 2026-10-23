import "server-only";
import { NotFound, StaleOrCanceled } from "@/lib/domain/errors";
import { backoffDelayMs, DEFAULT_BACKOFF, type BackoffPolicy } from "@/lib/domain/retry";
import type { Db } from "../db";
import { finishLockedJob } from "./reservation";
import { inTransaction, type Tx } from "./tx";

export interface ClaimedJob {
  id: string;
  /** What the job is: a legacy generation, or an export of a frozen snapshot (S4). */
  kind: "generate" | "export";
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

/** The SQLSTATE or Prisma code somewhere in an error's chain, else "unknown". Never returns message text. */
function errorCodeOf(error: unknown): string {
  const seen = new Set<unknown>();
  let value: unknown = error;
  for (let depth = 0; value && typeof value === "object" && depth < 6 && !seen.has(value); depth++) {
    seen.add(value);
    const v = value as { meta?: { code?: unknown }; originalCode?: unknown; code?: unknown; cause?: unknown };
    for (const c of [v.meta?.code, v.originalCode, v.code]) if (typeof c === "string" && /^[0-9A-Z]{5}$/.test(c)) return c;
    value = v.cause;
  }
  return "unknown";
}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export interface SweepReport {
  requeued: number;
  failed: number;
  canceled: number;
  /** Buckets whose counters disagree with their reservation rows: an alert, never auto-repaired. */
  drift: string[];
  /** Committed exports whose job or reservation disagree (export_state_drift): an alert, never auto-repaired. */
  exportDrift: string[];
  /** Rows whose recovery threw: counted and skipped so one poisoned row cannot stall the batch (it is retried next sweep; alert on > 0). */
  sweepRowErrors: number;
}

/** What an export attempt needs, readable only by the attempt that currently owns the job. */
export interface ExportInput {
  exportId: string;
  snapshotId: string;
  ownerId: string;
  lessonId: string;
  exportKey: string;
  /** The frozen spec ({v, documents, locale, pageFormat, templateVersion, renderVersion}) and the expected rendered-source hashes. */
  spec: unknown;
  texSha256: unknown;
  /** The full LessonPackage as confirmed, and its content hash. */
  content: unknown;
  packageHash: string;
  validatorVersion: string;
  deadlineAt: Date;
}

export interface JobsOptions {
  /** How long past deadline_at a RUNNING export job may stay before the sweeper fails it (the worker checks the deadline itself). */
  exportDeadlineGraceSeconds?: number;
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
export function createJobsDal(db: Db, backoff: BackoffPolicy = DEFAULT_BACKOFF, options: JobsOptions = {}) {
  const graceSeconds = options.exportDeadlineGraceSeconds ?? 60;
  return {
    /**
     * Atomically claims one runnable job: the row lock is skipped (not waited on) when another worker
     * holds it, the fencing token increases, and the lease starts. No transaction stays open afterwards.
     */
    async claimNext(workerId: string, leaseMs: number): Promise<ClaimedJob | null> {
      const rows = await db.$queryRaw<
        { id: string; kind: "generate" | "export"; owner_id: string; lesson_id: string; fencing_token: bigint; attempt: number; max_attempts: number; deadline_at: Date }[]
      >`
        UPDATE generation_job
           SET state = 'running'::job_state,
               stage = CASE WHEN kind = 'export'::job_kind THEN 'compiling'::job_stage ELSE 'generating'::job_stage END,
               lease_owner = ${workerId},
               lease_expires_at = now() + (${leaseMs}::int * interval '1 millisecond'),
               fencing_token = fencing_token + 1, attempt = attempt + 1, started_at = COALESCE(started_at, now())
         WHERE id = (
           SELECT id FROM generation_job
            WHERE state = 'queued'::job_state AND kind IN ('generate'::job_kind, 'export'::job_kind)
              AND run_after <= now() AND cancel_requested_at IS NULL
              AND attempt < max_attempts AND deadline_at > now()
            ORDER BY run_after, created_at
            FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, kind::text AS kind, owner_id, lesson_id, fencing_token, attempt, max_attempts, deadline_at`;
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        kind: row.kind,
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

    /** The export an attempt must produce: job (running, this token) joined to its export and immutable snapshot. */
    async getExportInput(jobId: string, token: bigint): Promise<ExportInput> {
      const rows = await db.$queryRaw<
        { export_id: string; snapshot_id: string; owner_id: string; lesson_id: string; export_key: string; spec: unknown; tex_sha256: unknown; content: unknown; package_hash: string; validator_version: string; deadline_at: Date }[]
      >`
        SELECT e.id AS export_id, s.id AS snapshot_id, j.owner_id, j.lesson_id, e.export_key, s.spec, s.tex_sha256, s.content,
               s.package_hash, s.validator_version, j.deadline_at
          FROM generation_job j
          JOIN export e ON e.job_id = j.id AND e.owner_id = j.owner_id
          JOIN export_snapshot s ON s.id = e.snapshot_id AND s.owner_id = e.owner_id
         WHERE j.id = ${jobId}::uuid AND j.fencing_token = ${token} AND j.state = 'running'::job_state
           AND j.kind = 'export'::job_kind AND e.state = 'pending'`;
      const row = rows[0];
      if (!row) throw new StaleOrCanceled();
      return {
        exportId: row.export_id,
        snapshotId: row.snapshot_id,
        ownerId: row.owner_id,
        lessonId: row.lesson_id,
        exportKey: row.export_key,
        spec: row.spec,
        texSha256: row.tex_sha256,
        content: row.content,
        packageHash: row.package_hash,
        validatorVersion: row.validator_version,
        deadlineAt: row.deadline_at,
      };
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
      const report: SweepReport = { requeued: 0, failed: 0, canceled: 0, drift: [], exportDrift: [], sweepRowErrors: 0 };
      const ids = await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM generation_job
         WHERE (state = 'running'::job_state AND lease_expires_at < now())
            OR (state = 'queued'::job_state AND (deadline_at <= now() OR attempt >= max_attempts OR cancel_requested_at IS NOT NULL))
            OR (state = 'running'::job_state AND kind = 'export'::job_kind AND deadline_at + make_interval(secs => ${graceSeconds}::int) < now())
         ORDER BY created_at LIMIT ${limit}`;
      for (const { id } of ids) {
        // One bad row must never stall the batch: its transaction rolls back (nothing of it is applied), it is counted, and the
        // next row is recovered. The row stays eligible and is retried by the next sweep.
        try {
          const outcome = await inTransaction(db, async (tx): Promise<"requeued" | "failed" | "canceled" | null> => {
            const rows = await tx.$queryRaw<
              { state: string; attempt: number; max_attempts: number; expired: boolean; past_deadline: boolean; canceled: boolean; export_overdue: boolean }[]
            >`
              SELECT state::text AS state, attempt, max_attempts,
                     (state = 'running'::job_state AND lease_expires_at < now()) AS expired,
                     (deadline_at <= now()) AS past_deadline,
                     (cancel_requested_at IS NOT NULL) AS canceled,
                     (state = 'running'::job_state AND kind = 'export'::job_kind AND deadline_at + make_interval(secs => ${graceSeconds}::int) < now()) AS export_overdue
                FROM generation_job WHERE id = ${id}::uuid FOR UPDATE SKIP LOCKED`;
            const job = rows[0];
            if (!job) return null; // another sweeper has it
            const stalled = job.state === "running" && job.expired;
            const stuckQueued = job.state === "queued" && (job.past_deadline || job.attempt >= job.max_attempts || job.canceled);
            if (!stalled && !stuckQueued && !job.export_overdue) return null; // recovered meanwhile (heartbeat or claim) or finished

            if (job.canceled) {
              await finishLockedJob(tx, id, "canceled", "canceled");
              return "canceled";
            } else if (job.past_deadline) {
              await finishLockedJob(tx, id, "failed", "deadline_exceeded");
              return "failed";
            } else if (job.attempt >= job.max_attempts) {
              await finishLockedJob(tx, id, "failed", "max_attempts_exceeded");
              return "failed";
            } else {
              const delayMs = backoffDelayMs(job.attempt, backoff);
              await tx.$executeRaw`
                UPDATE generation_job
                   SET state = 'queued'::job_state, stage = NULL, lease_owner = NULL, lease_expires_at = NULL,
                       run_after = now() + (${delayMs}::int * interval '1 millisecond')
                 WHERE id = ${id}::uuid`;
              return "requeued";
            }
          });
          if (outcome) report[outcome]++; // counted only once the transaction (and its deferred checks) committed
        } catch (error) {
          report.sweepRowErrors++;
          // Id and error class/SQLSTATE only: never the message (it can carry row content) and nothing from the job's payload.
          console.error(JSON.stringify({ ts: new Date().toISOString(), event: "sweep_row_error", jobId: id, code: errorCodeOf(error), errorClass: errorClassOf(error) }));
        }
      }
      const drift = await db.$queryRaw<{ bucket_id: string }[]>`SELECT bucket_id FROM usage_bucket_drift`;
      report.drift = drift.map((d) => d.bucket_id);
      const exportDrift = await db.$queryRaw<{ export_id: string }[]>`SELECT export_id FROM export_state_drift`;
      report.exportDrift = exportDrift.map((d) => d.export_id);
      return report;
    },
  };
}

export type JobsDal = ReturnType<typeof createJobsDal>;
