import "server-only";
import { AiActionLimited, AiStopped, AiUnavailable } from "@/lib/domain/errors";
import type { Db } from "../db";
import type { Limits } from "../limits";
import { finishLockedJob } from "./reservation";
import { inTransaction, type Tx } from "./tx";

/*
 * AI Actions (spec 5.12, decision D-98): one row per user-initiated AI request, the unit of the hourly limit.
 * The count is a COUNT over rows of the current UTC hour that were not released, so it cannot drift from the rows.
 * Internal retries, refills, polling and duplicate idempotency keys never add rows. A slot is given back only when no provider
 * call was ever reserved for the request. Lock order: profile (web take) | job -> ai_action (worker).
 */

export type AiActionKind = "initial" | "regenerate" | "replace" | "easier" | "harder";
export type AiActionState = "accepted" | "completed" | "failed" | "released";

export interface AiActionRow {
  id: string;
  ownerId: string;
  requestKey: string;
  kind: AiActionKind;
  draftId: string | null;
  jobId: string | null;
  state: AiActionState;
  providerCalled: boolean;
}

export interface TakeInput {
  ownerId: string;
  /** The request's idempotency key, already scoped by operation by the caller. */
  requestKey: string;
  kind: AiActionKind;
  draftId?: string | null;
  jobId?: string | null;
}

export interface TakeResult {
  action: AiActionRow;
  /** True when the key had been taken before: no new slot, no limit check. */
  replayed: boolean;
}

export type CloseOutcome = "released" | "failed" | "noop";

interface Raw {
  id: string;
  owner_id: string;
  request_key: string;
  kind: AiActionKind;
  draft_id: string | null;
  job_id: string | null;
  state: AiActionState;
  provider_called: boolean;
}

const toRow = (r: Raw): AiActionRow => ({
  id: r.id,
  ownerId: r.owner_id,
  requestKey: r.request_key,
  kind: r.kind,
  draftId: r.draft_id,
  jobId: r.job_id,
  state: r.state,
  providerCalled: r.provider_called,
});

export function createAiActionDal(db: Db, limits: Limits) {
  /** Takes the slot in the caller's transaction (so it commits or rolls back with the job it belongs to). */
  async function takeIn(tx: Tx, input: TakeInput): Promise<TakeResult> {
    // Serializes this user's requests; FOR NO KEY UPDATE does not block the foreign-key checks of unrelated inserts.
    await tx.$queryRaw`SELECT id FROM profile WHERE id = ${input.ownerId}::uuid FOR NO KEY UPDATE`;
    const existing = await tx.$queryRaw<Raw[]>`
      SELECT id, owner_id, request_key, kind, draft_id, job_id, state, provider_called
        FROM ai_action WHERE owner_id = ${input.ownerId}::uuid AND request_key = ${input.requestKey}`;
    if (existing[0]) return { action: toRow(existing[0]), replayed: true };

    if (limits.llmItemsEnabled === 0) throw new AiUnavailable();
    const stopped = await tx.$queryRaw<{ stopped: boolean }[]>`
      SELECT true AS stopped FROM llm_spend_month
       WHERE month = date_trunc('month', now() AT TIME ZONE 'UTC')::date AND stopped_at IS NOT NULL`;
    if (stopped[0]) throw new AiStopped();

    const slot = (
      await tx.$queryRaw<{ used: bigint; retry_after: number }[]>`
        SELECT COUNT(*) AS used,
               GREATEST(1, CEIL(EXTRACT(EPOCH FROM (date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 hour' - now()))))::int AS retry_after
          FROM ai_action
         WHERE owner_id = ${input.ownerId}::uuid AND state <> 'released'
           AND slot_hour = date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
    )[0]!;
    if (Number(slot.used) >= limits.aiOpsPerUserPerHour) throw new AiActionLimited(slot.retry_after);

    const rows = await tx.$queryRaw<Raw[]>`
      INSERT INTO ai_action (owner_id, request_key, kind, draft_id, job_id, slot_hour)
      VALUES (${input.ownerId}::uuid, ${input.requestKey}, ${input.kind}, ${input.draftId ?? null}::uuid, ${input.jobId ?? null}::uuid,
              date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      RETURNING id, owner_id, request_key, kind, draft_id, job_id, state, provider_called`;
    return { action: toRow(rows[0]!), replayed: false };
  }

  /** accepted -> released (slot given back) when no provider call exists, else accepted -> failed (slot stays). */
  async function closeLocked(tx: Tx, actionId: string, code: string): Promise<CloseOutcome> {
    // Job first, then the action (the order the reservation path uses), so a reservation cannot slip in between the check and the release.
    const linked = await tx.$queryRaw<{ job_id: string | null }[]>`SELECT job_id FROM ai_action WHERE id = ${actionId}::uuid`;
    if (linked[0]?.job_id) {
      const job = await tx.$queryRaw<{ state: string }[]>`SELECT state::text AS state FROM generation_job WHERE id = ${linked[0].job_id}::uuid FOR UPDATE`;
      // A running job can still reserve calls: its request is not over.
      if (job[0]?.state === "running") return "noop";
    }
    const rows = await tx.$queryRaw<{ job_id: string | null; provider_called: boolean }[]>`
      SELECT job_id, provider_called FROM ai_action WHERE id = ${actionId}::uuid AND state = 'accepted' FOR UPDATE`;
    const row = rows[0];
    if (!row) return "noop";
    const called =
      row.provider_called ||
      (row.job_id !== null && (await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM llm_call WHERE job_id = ${row.job_id}::uuid LIMIT 1`).length > 0);
    if (called) {
      await tx.$executeRaw`
        UPDATE ai_action SET state = 'failed', failure_code = ${code}, provider_called = true, finished_at = now() WHERE id = ${actionId}::uuid`;
      return "failed";
    }
    await tx.$executeRaw`UPDATE ai_action SET state = 'released', failure_code = ${code}, finished_at = now() WHERE id = ${actionId}::uuid`;
    return "released";
  }

  return {
    takeIn,

    /** One user-initiated AI request: replay, kill switch, global stop, then the hourly slot, in one transaction. */
    take(input: TakeInput): Promise<TakeResult> {
      return inTransaction(db, (tx) => takeIn(tx, input));
    },

    /** Links the action of a request to the job that serves it (null until then). */
    async attachJob(actionId: string, jobId: string): Promise<void> {
      await db.$executeRaw`UPDATE ai_action SET job_id = ${jobId}::uuid WHERE id = ${actionId}::uuid AND state = 'accepted' AND job_id IS NULL`;
    },

    /** accepted -> completed for a request that was served (a job that succeeded, or spares). False when it was not accepted. */
    async completeById(actionId: string): Promise<boolean> {
      const n = await db.$executeRaw`UPDATE ai_action SET state = 'completed', finished_at = now() WHERE id = ${actionId}::uuid AND state = 'accepted'`;
      return n > 0;
    },

    async completeForJob(jobId: string): Promise<boolean> {
      const n = await db.$executeRaw`UPDATE ai_action SET state = 'completed', finished_at = now() WHERE job_id = ${jobId}::uuid AND state = 'accepted'`;
      return n > 0;
    },

    /** The request ended without a result. Released exactly once and only if nothing was sent to a provider. */
    closeFailed(input: { actionId: string; code: string }): Promise<CloseOutcome> {
      return inTransaction(db, (tx) => closeLocked(tx, input.actionId, input.code));
    },

    /**
     * Closes the actions of jobs that already ended (the sweep): succeeded completes, failed or canceled releases or keeps the
     * slot. Safe to run from several workers; each row is handled in its own transaction.
     */
    async finalizeTerminal(limit = 100): Promise<{ completed: number; released: number; failed: number }> {
      const rows = await db.$queryRaw<{ id: string; state: string; error_code: string | null }[]>`
        SELECT a.id, j.state::text AS state, j.error_code
          FROM ai_action a JOIN generation_job j ON j.id = a.job_id AND j.owner_id = a.owner_id
         WHERE a.state = 'accepted' AND j.state IN ('succeeded'::job_state, 'failed'::job_state, 'canceled'::job_state)
         ORDER BY a.created_at LIMIT ${limit}::int`;
      const report = { completed: 0, released: 0, failed: 0 };
      for (const row of rows) {
        const outcome = await inTransaction(db, async (tx): Promise<keyof typeof report | null> => {
          if (row.state === "succeeded") {
            const n = await tx.$executeRaw`UPDATE ai_action SET state = 'completed', finished_at = now() WHERE id = ${row.id}::uuid AND state = 'accepted'`;
            return n > 0 ? "completed" : null;
          }
          const closed = await closeLocked(tx, row.id, row.state === "canceled" ? "canceled" : (row.error_code ?? "job_failed"));
          return closed === "noop" ? null : closed;
        });
        if (outcome) report[outcome] += 1;
      }
      return report;
    },

    /**
     * With the kill switch off, queued AI jobs fail with `llm_disabled` and their slots are released (nothing was sent). Works through
     * ai_action.job_id, so it covers every kind of AI job, and leaves running jobs to be refused at their next reservation.
     * Returns the number of jobs failed.
     */
    async failQueuedWhenDisabled(limit = 100): Promise<number> {
      if (limits.llmItemsEnabled !== 0) return 0;
      const rows = await db.$queryRaw<{ id: string; job_id: string }[]>`
        SELECT a.id, a.job_id FROM ai_action a JOIN generation_job j ON j.id = a.job_id AND j.owner_id = a.owner_id
         WHERE a.state = 'accepted' AND j.state = 'queued'::job_state ORDER BY a.created_at LIMIT ${limit}::int`;
      let failed = 0;
      for (const row of rows) {
        const done = await inTransaction(db, async (tx) => {
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM generation_job WHERE id = ${row.job_id}::uuid AND state = 'queued'::job_state FOR UPDATE SKIP LOCKED`;
          if (!locked[0]) return false;
          await finishLockedJob(tx, row.job_id, "failed", "llm_disabled");
          await closeLocked(tx, row.id, "llm_disabled");
          return true;
        });
        if (done) failed += 1;
      }
      return failed;
    },
  };
}

export type AiActionDal = ReturnType<typeof createAiActionDal>;
