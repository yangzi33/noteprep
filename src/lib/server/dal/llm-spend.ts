import "server-only";
import { StaleOrCanceled } from "@/lib/domain/errors";
import type { Db } from "../db";
import type { Limits } from "../limits";
import { inTransaction, type Tx } from "./tx";

/*
 * The spend ledger (spec 5.5, 5.5a). One llm_call row per provider call, reserved BEFORE the call and settled after.
 * Lock order everywhere: generation_job -> llm_spend_month -> llm_spend_user -> llm_spend_user_day -> llm_call -> ai_action.
 * Money is integer micro-units. Rows never carry prompt or response bodies.
 */

export type CallPurpose = "items" | "prose" | "crosscheck";

export type RefusalReason =
  | "kill_switch"
  | "global_stopped"
  | "global_cap"
  | "user_lifetime_cap"
  | "user_day_cap"
  | "user_hour_calls"
  | "job_calls"
  | "job_tokens"
  | "job_retries"
  | "job_cost"
  | "call_cap";

export interface CallEstimate {
  micros: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ReserveInput {
  jobId: string;
  attempt: number;
  fencingToken: bigint;
  /** 1-based sequence of the call within the attempt: with the job and attempt it is the idempotency key. */
  callSeq: number;
  purpose: CallPurpose;
  isRetry: boolean;
  provider: string;
  model: string;
  configId?: string | null;
  promptVersion?: string | null;
  estimate: CallEstimate;
  /** The request's own cost cap; the effective per-call cap is the smaller of this and the configured one. */
  callCapMicros?: number;
}

export type ReserveResult =
  | { status: "reserved"; callId: string }
  /** The (job, attempt, call) already has a row: nothing was charged and the call must not be sent again. */
  | { status: "exists"; callId: string; state: string }
  | { status: "refused"; reason: RefusalReason };

export interface SettleInput {
  callId: string;
  /** Reported usage, or null to settle at the estimate (never zero). */
  usage: { inputTokens: number; outputTokens: number; costMicros: number } | null;
  usageEstimated: boolean;
  latencyMs?: number;
  errorType?: string | null;
  reason: "reported" | "estimated" | "recovered";
}

export interface DriftRow {
  scope: string;
  key: string;
  counterReserved: number;
  counterSettled: number;
  ledgerReserved: number;
  ledgerSettled: number;
}

interface CallRow {
  id: string;
  state: string;
}

interface JobRow {
  owner_id: string;
  state: string;
  fencing_token: bigint;
  attempt: number;
  cancel_requested_at: Date | null;
  max_calls: number;
  max_tokens: bigint;
  max_cost_micros: bigint;
}

interface Clock {
  month: string;
  day: string;
}

const n = (value: bigint | number | string | null | undefined): number => (value == null ? 0 : Number(value));

async function lockCounters(tx: Tx, ownerId: string, clock: Clock): Promise<{ month: { reserved: number; settled: number; stopped: boolean }; user: { reserved: number; settled: number }; day: { reserved: number; settled: number } }> {
  await tx.$executeRaw`INSERT INTO llm_spend_month (month) VALUES (${clock.month}::date) ON CONFLICT DO NOTHING`;
  await tx.$executeRaw`INSERT INTO llm_spend_user (owner_id) VALUES (${ownerId}::uuid) ON CONFLICT DO NOTHING`;
  await tx.$executeRaw`INSERT INTO llm_spend_user_day (owner_id, day) VALUES (${ownerId}::uuid, ${clock.day}::date) ON CONFLICT DO NOTHING`;
  const month = (
    await tx.$queryRaw<{ reserved: bigint; settled: bigint; stopped: boolean }[]>`
      SELECT reserved_micros AS reserved, settled_micros AS settled, (stopped_at IS NOT NULL) AS stopped
        FROM llm_spend_month WHERE month = ${clock.month}::date FOR UPDATE`
  )[0];
  const user = (
    await tx.$queryRaw<{ reserved: bigint; settled: bigint }[]>`
      SELECT lifetime_reserved_micros AS reserved, lifetime_settled_micros AS settled
        FROM llm_spend_user WHERE owner_id = ${ownerId}::uuid FOR UPDATE`
  )[0];
  const day = (
    await tx.$queryRaw<{ reserved: bigint; settled: bigint }[]>`
      SELECT reserved_micros AS reserved, settled_micros AS settled
        FROM llm_spend_user_day WHERE owner_id = ${ownerId}::uuid AND day = ${clock.day}::date FOR UPDATE`
  )[0];
  if (!month || !user || !day) throw new Error("spend counters missing after upsert");
  return {
    month: { reserved: n(month.reserved), settled: n(month.settled), stopped: month.stopped },
    user: { reserved: n(user.reserved), settled: n(user.settled) },
    day: { reserved: n(day.reserved), settled: n(day.settled) },
  };
}

async function utcClock(tx: Tx): Promise<Clock> {
  const rows = await tx.$queryRaw<{ month: string; day: string }[]>`
    SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS month,
           to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`;
  return rows[0]!;
}

export function createLlmSpendDal(db: Db, limits: Limits) {
  /** Moves a reserved call to settled or released in the caller's transaction; the job is already locked (or terminal). */
  async function finish(
    tx: Tx,
    call: { id: string; owner_id: string; job_id: string; call_month: string; call_day: string },
    mode: { kind: "settle"; input: SettleInput } | { kind: "release"; reason: string },
  ): Promise<{ done: boolean; costMicros: number }> {
    const clock: Clock = { month: call.call_month, day: call.call_day };
    await lockJob(tx, call.job_id);
    await lockCounters(tx, call.owner_id, clock);
    let rows: { estimate_micros: bigint; estimate_input_tokens: bigint; estimate_output_tokens: bigint; cost_micros: bigint | null; input_tokens: bigint | null; output_tokens: bigint | null }[];
    if (mode.kind === "settle") {
      const s = mode.input;
      rows = await tx.$queryRaw`
        UPDATE llm_call
           SET state = 'settled',
               input_tokens = COALESCE(${s.usage?.inputTokens ?? null}::bigint, estimate_input_tokens),
               output_tokens = COALESCE(${s.usage?.outputTokens ?? null}::bigint, estimate_output_tokens),
               cost_micros = COALESCE(${s.usage?.costMicros ?? null}::bigint, estimate_micros),
               usage_estimated = ${s.usage === null || s.usageEstimated},
               latency_ms = ${s.latencyMs ?? null}::int, error_type = ${s.errorType ?? null},
               reason = ${s.reason}, settled_at = now()
         WHERE id = ${call.id}::uuid AND state = 'reserved'
     RETURNING estimate_micros, estimate_input_tokens, estimate_output_tokens, cost_micros, input_tokens, output_tokens`;
    } else {
      rows = await tx.$queryRaw`
        UPDATE llm_call SET state = 'released', reason = ${mode.reason}, settled_at = now()
         WHERE id = ${call.id}::uuid AND state = 'reserved'
     RETURNING estimate_micros, estimate_input_tokens, estimate_output_tokens, cost_micros, input_tokens, output_tokens`;
    }
    const row = rows[0];
    if (!row) return { done: false, costMicros: 0 };
    const estimate = n(row.estimate_micros);
    const cost = mode.kind === "settle" ? n(row.cost_micros) : 0;
    const callDelta = mode.kind === "release" ? 1 : 0;
    await tx.$executeRaw`
      UPDATE llm_spend_month
         SET reserved_micros = reserved_micros - ${estimate}::bigint,
             settled_micros = settled_micros + ${cost}::bigint,
             alerted_70_at = CASE WHEN alerted_70_at IS NULL AND (settled_micros + ${cost}::bigint) * 100 >= ${limits.llmSpendGlobalMonthlyMicros}::bigint * ${limits.llmSpendAlertPercent}::int
                                  THEN now() ELSE alerted_70_at END,
             stopped_at = CASE WHEN stopped_at IS NULL AND settled_micros + ${cost}::bigint >= ${limits.llmSpendGlobalMonthlyMicros}::bigint
                               THEN now() ELSE stopped_at END
       WHERE month = ${clock.month}::date`;
    await tx.$executeRaw`
      UPDATE llm_spend_user
         SET lifetime_reserved_micros = lifetime_reserved_micros - ${estimate}::bigint, lifetime_settled_micros = lifetime_settled_micros + ${cost}::bigint
       WHERE owner_id = ${call.owner_id}::uuid`;
    await tx.$executeRaw`
      UPDATE llm_spend_user_day
         SET reserved_micros = reserved_micros - ${estimate}::bigint, settled_micros = settled_micros + ${cost}::bigint, calls = calls - ${callDelta}::int
       WHERE owner_id = ${call.owner_id}::uuid AND day = ${clock.day}::date`;
    if (mode.kind === "settle") {
      // The job row of a finished job is immutable (guard trigger); the ledger stays the authority for its spend.
      await tx.$executeRaw`
        UPDATE generation_job
           SET calls_used = calls_used + 1, tokens_used = tokens_used + ${n(row.input_tokens) + n(row.output_tokens)}::bigint,
               cost_micros = cost_micros + ${cost}::bigint
         WHERE id = ${call.job_id}::uuid AND state IN ('queued'::job_state, 'running'::job_state)`;
    }
    return { done: true, costMicros: cost };
  }

  async function lockJob(tx: Tx, jobId: string): Promise<JobRow | undefined> {
    const rows = await tx.$queryRaw<JobRow[]>`
      SELECT owner_id, state::text AS state, fencing_token, attempt, cancel_requested_at, max_calls, max_tokens, max_cost_micros
        FROM generation_job WHERE id = ${jobId}::uuid FOR UPDATE`;
    return rows[0];
  }

  async function readCall(callId: string) {
    const rows = await db.$queryRaw<{ id: string; owner_id: string; job_id: string; call_month: string; call_day: string }[]>`
      SELECT id, owner_id, job_id, to_char(call_month, 'YYYY-MM-DD') AS call_month, to_char(call_day, 'YYYY-MM-DD') AS call_day
        FROM llm_call WHERE id = ${callId}::uuid`;
    return rows[0];
  }

  return {
    /**
     * Checks every cap and records the reservation for one call in ONE row-locked transaction (check 8). A refusal is returned,
     * not thrown, so the caller can fail the job with a typed error; a worker without the current lease gets StaleOrCanceled.
     */
    async reserve(input: ReserveInput): Promise<ReserveResult> {
      return inTransaction(db, async (tx) => {
        const job = await lockJob(tx, input.jobId);
        if (!job || job.state !== "running" || job.fencing_token !== input.fencingToken || job.attempt !== input.attempt || job.cancel_requested_at) {
          throw new StaleOrCanceled();
        }
        const existing = await tx.$queryRaw<CallRow[]>`
          SELECT id, state FROM llm_call WHERE job_id = ${input.jobId}::uuid AND job_attempt = ${input.attempt}::int AND call_seq = ${input.callSeq}::int`;
        if (existing[0]) return { status: "exists", callId: existing[0].id, state: existing[0].state } as const;

        if (limits.llmItemsEnabled === 0 && input.purpose !== "prose") return { status: "refused", reason: "kill_switch" } as const;

        const ownerId = job.owner_id;
        const clock = await utcClock(tx);
        const c = await lockCounters(tx, ownerId, clock);
        const est = input.estimate;

        const used = (
          await tx.$queryRaw<{ calls: bigint; retries: bigint; tokens: bigint; cost: bigint }[]>`
            SELECT COUNT(*) AS calls, COUNT(*) FILTER (WHERE is_retry) AS retries,
                   COALESCE(SUM(CASE WHEN state = 'settled' THEN input_tokens + output_tokens ELSE estimate_input_tokens + estimate_output_tokens END), 0)::bigint AS tokens,
                   COALESCE(SUM(CASE WHEN state = 'settled' THEN cost_micros ELSE estimate_micros END), 0)::bigint AS cost
              FROM llm_call WHERE job_id = ${input.jobId}::uuid AND state <> 'released'`
        )[0]!;
        const hourly = (
          await tx.$queryRaw<{ calls: bigint }[]>`
            SELECT COUNT(*) AS calls FROM llm_call
             WHERE owner_id = ${ownerId}::uuid AND state <> 'released'
               AND created_at >= date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
        )[0]!;

        const cap = limits.llmSpendGlobalMonthlyMicros;
        const callCap = Math.min(limits.llmSpendPerCallMicros, input.callCapMicros ?? Number.MAX_SAFE_INTEGER);
        const jobCostCap = Math.min(limits.llmSpendPerPreviewMicros, n(job.max_cost_micros));
        const refusal: RefusalReason | null =
          c.month.stopped || c.month.settled >= cap
            ? "global_stopped"
            : c.month.reserved + c.month.settled + est.micros > cap
              ? "global_cap"
              : c.user.reserved + c.user.settled + est.micros > limits.llmSpendLifetimeMicrosPerUser
                ? "user_lifetime_cap"
                : c.day.reserved + c.day.settled + est.micros > limits.llmSpendDailyMicrosPerUser
                  ? "user_day_cap"
                  : n(hourly.calls) >= limits.llmCallsPerUserPerHour
                    ? "user_hour_calls"
                    : n(used.calls) >= Math.min(limits.llmMaxCallsPerJob, job.max_calls)
                      ? "job_calls"
                      : input.isRetry && n(used.retries) >= limits.llmMaxRetriesPerJob
                        ? "job_retries"
                        : n(used.tokens) + est.inputTokens + est.outputTokens > Math.min(limits.llmMaxTokensPerJob, n(job.max_tokens))
                          ? "job_tokens"
                          : n(used.cost) + est.micros > jobCostCap
                            ? "job_cost"
                            : est.micros > callCap
                              ? "call_cap"
                              : null;
        if (refusal) {
          if (c.month.settled >= cap) await tx.$executeRaw`UPDATE llm_spend_month SET stopped_at = now() WHERE month = ${clock.month}::date AND stopped_at IS NULL`;
          return { status: "refused", reason: refusal } as const;
        }

        const rows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO llm_call (owner_id, job_id, job_attempt, fencing_token, call_seq, purpose, is_retry, provider, model, config_id, prompt_version,
                                estimate_micros, estimate_input_tokens, estimate_output_tokens, call_month, call_day)
          VALUES (${ownerId}::uuid, ${input.jobId}::uuid, ${input.attempt}::int, ${input.fencingToken}::bigint, ${input.callSeq}::int, ${input.purpose}, ${input.isRetry},
                  ${input.provider}, ${input.model}, ${input.configId ?? null}, ${input.promptVersion ?? null},
                  ${est.micros}::bigint, ${est.inputTokens}::bigint, ${est.outputTokens}::bigint, ${clock.month}::date, ${clock.day}::date)
          RETURNING id`;
        await tx.$executeRaw`UPDATE llm_spend_month SET reserved_micros = reserved_micros + ${est.micros}::bigint WHERE month = ${clock.month}::date`;
        await tx.$executeRaw`UPDATE llm_spend_user SET lifetime_reserved_micros = lifetime_reserved_micros + ${est.micros}::bigint WHERE owner_id = ${ownerId}::uuid`;
        await tx.$executeRaw`
          UPDATE llm_spend_user_day SET reserved_micros = reserved_micros + ${est.micros}::bigint, calls = calls + 1
           WHERE owner_id = ${ownerId}::uuid AND day = ${clock.day}::date`;
        // From the first reservation on, the request's hourly slot can never be given back.
        await tx.$executeRaw`UPDATE ai_action SET provider_called = true WHERE job_id = ${input.jobId}::uuid AND state = 'accepted' AND provider_called = false`;
        return { status: "reserved", callId: rows[0]!.id } as const;
      });
    },

    /** reserved -> settled, once: at the reported usage, or at the estimate when none was reported. False when it was no longer reserved. */
    async settle(input: SettleInput): Promise<{ settled: boolean; costMicros: number }> {
      const call = await readCall(input.callId);
      if (!call) return { settled: false, costMicros: 0 };
      const res = await inTransaction(db, (tx) => finish(tx, call, { kind: "settle", input }));
      return { settled: res.done, costMicros: res.costMicros };
    },

    /** reserved -> released, only for a call that provably was not sent. False when it was no longer reserved. */
    async release(input: { callId: string; reason: string }): Promise<boolean> {
      const call = await readCall(input.callId);
      if (!call) return false;
      return (await inTransaction(db, (tx) => finish(tx, call, { kind: "release", reason: input.reason }))).done;
    },

    /** Settles reservations nobody settled (a crashed or lost worker) at their estimate, never zero. One transaction per row. */
    async recoverStale(limit = 50): Promise<{ recovered: number; errors: number }> {
      const rows = await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM llm_call
         WHERE state = 'reserved' AND created_at < now() - make_interval(secs => ${limits.llmStaleReservationSeconds}::int)
         ORDER BY created_at LIMIT ${limit}::int`;
      let recovered = 0;
      let errors = 0;
      for (const { id } of rows) {
        try {
          const r = await this.settle({ callId: id, usage: null, usageEstimated: true, reason: "recovered" });
          if (r.settled) recovered += 1;
        } catch {
          errors += 1;
        }
      }
      return { recovered, errors };
    },

    /** Months whose 70 percent alert was raised and not yet emitted; each is returned to exactly one caller. */
    async claimAlerts(): Promise<string[]> {
      const rows = await db.$queryRaw<{ month: string }[]>`
        UPDATE llm_spend_month SET alert_emitted_at = now()
         WHERE alerted_70_at IS NOT NULL AND alert_emitted_at IS NULL
     RETURNING to_char(month, 'YYYY-MM') AS month`;
      return rows.map((r) => r.month);
    },

    /** Counters that disagree with the ledger: an alert, never auto-repaired. */
    async drift(): Promise<DriftRow[]> {
      const rows = await db.$queryRaw<{ scope: string; key: string; counter_reserved: bigint; counter_settled: bigint; ledger_reserved: bigint; ledger_settled: bigint }[]>`
        SELECT scope, key, counter_reserved, counter_settled, ledger_reserved, ledger_settled FROM llm_spend_drift`;
      return rows.map((r) => ({
        scope: r.scope,
        key: r.key,
        counterReserved: n(r.counter_reserved),
        counterSettled: n(r.counter_settled),
        ledgerReserved: n(r.ledger_reserved),
        ledgerSettled: n(r.ledger_settled),
      }));
    },
  };
}

export type LlmSpendDal = ReturnType<typeof createLlmSpendDal>;
