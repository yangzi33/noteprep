import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { StaleOrCanceled } from "@/lib/domain/errors";
import { createDb } from "@/lib/server/db";
import { createLlmSpendDal, type ReserveInput } from "@/lib/server/dal/llm-spend";
import { DEFAULT_LIMITS, type Limits } from "@/lib/server/limits";
import { pgErrorCode, pools, seedOwner } from "./helpers";
import { EST, parkJobs, resetSpend, seedAiJob, type AiJob } from "./spend-helpers";

// Spec section 5.5 / 5.5a, checks 7 and 8, Counting C1-C8 and Limits L1-L5: the ledger against a REAL Postgres.
const info = inject("testDb");
const { admin, app, worker: workerPg } = pools();
const workerDb = createDb(info.workerUrl);

const LIMITS: Limits = { ...DEFAULT_LIMITS, llmItemsEnabled: 1, llmSpendPerCallMicros: 100_000, llmSpendPerPreviewMicros: 150_000 };
const dal = (over: Partial<Limits> = {}) => createLlmSpendDal(workerDb, { ...LIMITS, ...over });

let seq = 0;
const reserveInput = (job: AiJob, over: Partial<ReserveInput> = {}): ReserveInput => ({
  jobId: job.jobId,
  attempt: job.attempt,
  fencingToken: job.token,
  callSeq: ++seq,
  purpose: "items",
  isRetry: false,
  provider: "fake",
  model: "fake-model-1",
  estimate: EST,
  ...over,
});

const counters = async () => {
  const month = (await admin.query(`SELECT reserved_micros::text r, settled_micros::text s FROM llm_spend_month`)).rows;
  return { month: month.map((m) => [Number(m.r), Number(m.s)]) };
};
const drift = async () => (await admin.query(`SELECT * FROM llm_spend_drift`)).rows;
const callRow = async (id: string) => (await admin.query(`SELECT * FROM llm_call WHERE id = $1`, [id])).rows[0];

beforeAll(async () => {
  await parkJobs(admin);
});
beforeEach(async () => {
  await resetSpend(admin);
  seq = 0;
});
afterAll(async () => {
  await resetSpend(admin);
  await Promise.all([admin.end(), app.end(), workerPg.end(), workerDb.$disconnect()]);
});

async function freshJob(over: Parameters<typeof seedAiJob>[2] = {}) {
  const ownerId = await seedOwner(admin);
  return seedAiJob(admin, ownerId, over);
}

describe("reserve", () => {
  it("writes a reserved ledger row and the counters BEFORE any call (check 7, C1)", async () => {
    const job = await freshJob();
    const r = await dal().reserve(reserveInput(job));
    expect(r.status).toBe("reserved");
    if (r.status !== "reserved") return;
    const row = await callRow(r.callId);
    expect(row).toMatchObject({ state: "reserved", owner_id: job.ownerId, job_id: job.jobId, purpose: "items", provider: "fake", model: "fake-model-1" });
    expect(Number(row.estimate_micros)).toBe(EST.micros);
    expect(row.cost_micros).toBeNull();
    expect(await counters()).toEqual({ month: [[EST.micros, 0]] });
    const d = (await admin.query(`SELECT reserved_micros::text r, calls FROM llm_spend_user_day WHERE owner_id = $1`, [job.ownerId])).rows[0];
    expect([Number(d.r), d.calls]).toEqual([EST.micros, 1]);
    expect(await drift()).toEqual([]);
  });

  it("is idempotent per job attempt and call: a repeat returns the row and charges nothing (C2)", async () => {
    const job = await freshJob();
    const input = reserveInput(job);
    const first = await dal().reserve(input);
    const again = await dal().reserve(input);
    expect(first.status).toBe("reserved");
    expect(again).toMatchObject({ status: "exists", state: "reserved" });
    expect(again.status === "exists" && first.status === "reserved" && again.callId === first.callId).toBe(true);
    expect((await admin.query(`SELECT count(*)::int n FROM llm_call WHERE job_id = $1`, [job.jobId])).rows[0].n).toBe(1);
    expect(await counters()).toEqual({ month: [[EST.micros, 0]] });
  });

  it("concurrent identical reserves create exactly one row and one charge (C2)", async () => {
    const job = await freshJob();
    const input = reserveInput(job);
    const results = await Promise.all(Array.from({ length: 8 }, () => dal().reserve(input)));
    expect(results.filter((r) => r.status === "reserved")).toHaveLength(1);
    expect(results.filter((r) => r.status === "exists")).toHaveLength(7);
    expect(await counters()).toEqual({ month: [[EST.micros, 0]] });
    expect(await drift()).toEqual([]);
  });

  it("a later attempt of the same job has its own call sequence (C3)", async () => {
    const job = await freshJob();
    await dal().reserve(reserveInput(job, { callSeq: 1 }));
    await admin.query(`UPDATE generation_job SET attempt = 2, fencing_token = 2 WHERE id = $1`, [job.jobId]);
    const r = await dal().reserve({ ...reserveInput(job, { callSeq: 1 }), attempt: 2, fencingToken: 2n });
    expect(r.status).toBe("reserved");
  });

  it("refuses a worker without the current lease, attempt or a pending cancel, and writes nothing (L3, check 8)", async () => {
    const job = await freshJob();
    await expect(dal().reserve(reserveInput(job, { fencingToken: 0n }))).rejects.toBeInstanceOf(StaleOrCanceled);
    await expect(dal().reserve(reserveInput(job, { fencingToken: 2n }))).rejects.toBeInstanceOf(StaleOrCanceled);
    await expect(dal().reserve(reserveInput(job, { attempt: 2 }))).rejects.toBeInstanceOf(StaleOrCanceled);
    await admin.query(`UPDATE generation_job SET cancel_requested_at = now() WHERE id = $1`, [job.jobId]);
    await expect(dal().reserve(reserveInput(job))).rejects.toBeInstanceOf(StaleOrCanceled);
    const queued = await freshJob({ state: "queued" });
    await expect(dal().reserve(reserveInput(queued, { attempt: 0, fencingToken: 0n }))).rejects.toBeInstanceOf(StaleOrCanceled);
    const done = await freshJob();
    await admin.query(`UPDATE generation_job SET state = 'failed', stage = NULL, lease_owner = NULL, lease_expires_at = NULL, finished_at = now() WHERE id = $1`, [done.jobId]);
    await expect(dal().reserve(reserveInput(done))).rejects.toBeInstanceOf(StaleOrCanceled);
    expect((await admin.query(`SELECT count(*)::int n FROM llm_call`)).rows[0].n).toBe(0);
    expect(await counters()).toEqual({ month: [] });
  });

  it("the kill switch refuses items and cross-check calls but not prose (L5)", async () => {
    const job = await freshJob();
    const off = dal({ llmItemsEnabled: 0 });
    expect(await off.reserve(reserveInput(job, { purpose: "items" }))).toEqual({ status: "refused", reason: "kill_switch" });
    expect(await off.reserve(reserveInput(job, { purpose: "crosscheck" }))).toEqual({ status: "refused", reason: "kill_switch" });
    expect((await off.reserve(reserveInput(job, { purpose: "prose" }))).status).toBe("reserved");
  });

  it("refuses an estimate above the per-call cap, also the request's own cap (L1)", async () => {
    const job = await freshJob();
    const big = { ...EST, micros: 100_001 };
    expect(await dal().reserve(reserveInput(job, { estimate: big }))).toEqual({ status: "refused", reason: "call_cap" });
    expect(await dal().reserve(reserveInput(job, { callCapMicros: EST.micros - 1 }))).toEqual({ status: "refused", reason: "call_cap" });
    expect((await dal().reserve(reserveInput(job, { callCapMicros: EST.micros }))).status).toBe("reserved");
  });

  it("enforces the per-job call, token, retry and cost caps from ledger sums (L1)", async () => {
    const calls = await freshJob({ maxCalls: 2 });
    expect((await dal().reserve(reserveInput(calls))).status).toBe("reserved");
    expect((await dal().reserve(reserveInput(calls))).status).toBe("reserved");
    expect(await dal().reserve(reserveInput(calls))).toEqual({ status: "refused", reason: "job_calls" });

    const tokens = await freshJob({ maxTokens: 2 * (EST.inputTokens + EST.outputTokens) });
    await dal().reserve(reserveInput(tokens));
    await dal().reserve(reserveInput(tokens));
    expect(await dal().reserve(reserveInput(tokens))).toEqual({ status: "refused", reason: "job_tokens" });

    const cost = await freshJob({ maxCostMicros: 2 * EST.micros });
    await dal().reserve(reserveInput(cost));
    await dal().reserve(reserveInput(cost));
    expect(await dal().reserve(reserveInput(cost))).toEqual({ status: "refused", reason: "job_cost" });

    const retries = await freshJob();
    const two = dal({ llmMaxRetriesPerJob: 2 });
    await two.reserve(reserveInput(retries, { isRetry: true }));
    await two.reserve(reserveInput(retries, { isRetry: true }));
    expect(await two.reserve(reserveInput(retries, { isRetry: true }))).toEqual({ status: "refused", reason: "job_retries" });
    expect((await two.reserve(reserveInput(retries, { isRetry: false }))).status).toBe("reserved");
  });

  it("a settled call counts its actual usage toward the job caps, a released one counts nothing", async () => {
    const job = await freshJob({ maxCostMicros: 25_000 });
    const a = await dal().reserve(reserveInput(job));
    if (a.status !== "reserved") throw new Error("expected reserved");
    await dal().settle({ callId: a.callId, usage: { inputTokens: 10, outputTokens: 10, costMicros: 20_000 }, usageEstimated: false, reason: "reported" });
    expect(await dal().reserve(reserveInput(job))).toEqual({ status: "refused", reason: "job_cost" });
    const small = await freshJob({ maxCostMicros: 25_000 });
    const b = await dal().reserve(reserveInput(small));
    if (b.status !== "reserved") throw new Error("expected reserved");
    await dal().release({ callId: b.callId, reason: "not_sent" });
    expect((await dal().reserve(reserveInput(small))).status).toBe("reserved");
  });
});

describe("concurrent reserves never overspend any cap (L2, check 8)", () => {
  const N = 16;
  const race = async (jobs: AiJob[], d = dal()) => Promise.all(jobs.map((j) => d.reserve(reserveInput(j))));
  const accepted = (rs: Awaited<ReturnType<typeof race>>) => rs.filter((r) => r.status === "reserved").length;
  const reasons = (rs: Awaited<ReturnType<typeof race>>) => [...new Set(rs.flatMap((r) => (r.status === "refused" ? [r.reason] : [])))];

  it("global monthly cap", async () => {
    const jobs = await Promise.all(Array.from({ length: N }, () => freshJob()));
    const rs = await race(jobs, dal({ llmSpendGlobalMonthlyMicros: 5 * EST.micros, llmSpendLifetimeMicrosPerUser: 5 * EST.micros, llmSpendDailyMicrosPerUser: 5 * EST.micros, llmSpendPerPreviewMicros: 5 * EST.micros, llmSpendPerCallMicros: 5 * EST.micros }));
    expect(accepted(rs)).toBe(5);
    expect(reasons(rs)).toEqual(["global_cap"]);
    expect(await counters()).toEqual({ month: [[5 * EST.micros, 0]] });
    expect(await drift()).toEqual([]);
  });

  it("per-user daily cap, lifetime cap and hourly call cap, each by one user over many jobs", async () => {
    const cases: Array<[Partial<Limits>, number, string]> = [
      [{ llmSpendDailyMicrosPerUser: 4 * EST.micros, llmSpendPerPreviewMicros: 4 * EST.micros, llmSpendPerCallMicros: 4 * EST.micros }, 4, "user_day_cap"],
      [{ llmSpendLifetimeMicrosPerUser: 3 * EST.micros, llmSpendDailyMicrosPerUser: 3 * EST.micros, llmSpendPerPreviewMicros: 3 * EST.micros, llmSpendPerCallMicros: 3 * EST.micros }, 3, "user_lifetime_cap"],
      [{ llmCallsPerUserPerHour: 6 }, 6, "user_hour_calls"],
    ];
    for (const [over, expected, reason] of cases) {
      await resetSpend(admin);
      const ownerId = await seedOwner(admin);
      const jobs = await Promise.all(Array.from({ length: N }, () => seedAiJob(admin, ownerId)));
      const rs = await race(jobs, dal(over));
      expect(accepted(rs)).toBe(expected);
      expect(reasons(rs)).toEqual([reason]);
      expect(await drift()).toEqual([]);
    }
  });

  it("per-job call cap with several workers on the same job", async () => {
    const job = await freshJob({ maxCalls: 3 });
    const rs = await Promise.all(Array.from({ length: N }, () => dal().reserve(reserveInput(job))));
    expect(accepted(rs)).toBe(3);
    expect(reasons(rs)).toEqual(["job_calls"]);
  });

  it("a reservation racing a settle never loses an update", async () => {
    const jobs = await Promise.all(Array.from({ length: 6 }, () => freshJob()));
    const first = await Promise.all(jobs.map((j) => dal().reserve(reserveInput(j))));
    const ids = first.flatMap((r) => (r.status === "reserved" ? [r.callId] : []));
    await Promise.all([
      ...ids.map((callId) => dal().settle({ callId, usage: { inputTokens: 5, outputTokens: 5, costMicros: 7_000 }, usageEstimated: false, reason: "reported" })),
      ...jobs.map((j) => dal().reserve(reserveInput(j))),
    ]);
    expect(await drift()).toEqual([]);
    expect(await counters()).toEqual({ month: [[6 * EST.micros, 6 * 7_000]] });
  });
});

describe("settle, release and recovery", () => {
  it("settles to the reported usage and moves the counters; a repeat is a no-op (C4, C5)", async () => {
    const job = await freshJob();
    const r = await dal().reserve(reserveInput(job));
    if (r.status !== "reserved") throw new Error("expected reserved");
    const usage = { inputTokens: 120, outputTokens: 80, costMicros: 4_321 };
    expect(await dal().settle({ callId: r.callId, usage, usageEstimated: false, latencyMs: 42, reason: "reported" })).toMatchObject({ settled: true });
    expect(await dal().settle({ callId: r.callId, usage: { ...usage, costMicros: 99 }, usageEstimated: false, reason: "reported" })).toMatchObject({ settled: false });
    const row = await callRow(r.callId);
    expect(row).toMatchObject({ state: "settled", reason: "reported", latency_ms: 42, usage_estimated: false });
    expect([Number(row.input_tokens), Number(row.output_tokens), Number(row.cost_micros)]).toEqual([120, 80, 4_321]);
    expect(await counters()).toEqual({ month: [[0, 4_321]] });
    const job2 = (await admin.query(`SELECT calls_used, tokens_used::text t, cost_micros::text c FROM generation_job WHERE id = $1`, [job.jobId])).rows[0];
    expect([job2.calls_used, Number(job2.t), Number(job2.c)]).toEqual([1, 200, 4_321]);
    expect(await drift()).toEqual([]);
  });

  it("settles at the estimate, never zero, when no usage was reported (C6)", async () => {
    const job = await freshJob();
    const r = await dal().reserve(reserveInput(job));
    if (r.status !== "reserved") throw new Error("expected reserved");
    await dal().settle({ callId: r.callId, usage: null, usageEstimated: true, errorType: "timeout", reason: "estimated" });
    const row = await callRow(r.callId);
    expect(row).toMatchObject({ state: "settled", usage_estimated: true, error_type: "timeout", reason: "estimated" });
    expect(Number(row.cost_micros)).toBe(EST.micros);
    expect(await counters()).toEqual({ month: [[0, EST.micros]] });
  });

  it("releases only a reserved call, returns its reservation and cannot release twice (C7)", async () => {
    const job = await freshJob();
    const r = await dal().reserve(reserveInput(job));
    if (r.status !== "reserved") throw new Error("expected reserved");
    expect(await dal().release({ callId: r.callId, reason: "not_sent" })).toBe(true);
    expect(await dal().release({ callId: r.callId, reason: "not_sent" })).toBe(false);
    expect(await dal().settle({ callId: r.callId, usage: null, usageEstimated: true, reason: "estimated" })).toMatchObject({ settled: false });
    expect(await counters()).toEqual({ month: [[0, 0]] });
    const d = (await admin.query(`SELECT calls FROM llm_spend_user_day WHERE owner_id = $1`, [job.ownerId])).rows[0];
    expect(d.calls).toBe(0);
    const s = await dal().reserve(reserveInput(job));
    if (s.status !== "reserved") throw new Error("expected reserved");
    await dal().settle({ callId: s.callId, usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 }, usageEstimated: false, reason: "reported" });
    expect(await dal().release({ callId: s.callId, reason: "not_sent" })).toBe(false);
    expect(await drift()).toEqual([]);
  });

  it("a late settle after the job ended updates the ledger but not the immutable job row (C8)", async () => {
    const job = await freshJob();
    const r = await dal().reserve(reserveInput(job));
    if (r.status !== "reserved") throw new Error("expected reserved");
    await admin.query(`UPDATE generation_job SET state = 'failed', stage = NULL, lease_owner = NULL, lease_expires_at = NULL, finished_at = now() WHERE id = $1`, [job.jobId]);
    expect(await dal().settle({ callId: r.callId, usage: { inputTokens: 3, outputTokens: 3, costMicros: 777 }, usageEstimated: false, reason: "reported" })).toMatchObject({ settled: true });
    expect(await counters()).toEqual({ month: [[0, 777]] });
    const j = (await admin.query(`SELECT calls_used, cost_micros::text c FROM generation_job WHERE id = $1`, [job.jobId])).rows[0];
    expect([j.calls_used, Number(j.c)]).toEqual([0, 0]);
    expect(await drift()).toEqual([]);
  });

  it("recovers stale reservations at their estimate and leaves fresh ones alone (check 7, C6)", async () => {
    const old = await freshJob();
    const a = await dal().reserve(reserveInput(old));
    const fresh = dal({ llmStaleReservationSeconds: 3_600 });
    expect(await fresh.recoverStale(10)).toEqual({ recovered: 0, errors: 0 });
    const stale = dal({ llmStaleReservationSeconds: 0 });
    expect(await stale.recoverStale(10)).toEqual({ recovered: 1, errors: 0 });
    expect(await stale.recoverStale(10)).toEqual({ recovered: 0, errors: 0 });
    if (a.status !== "reserved") throw new Error("expected reserved");
    const row = await callRow(a.callId);
    expect(row).toMatchObject({ state: "settled", reason: "recovered", usage_estimated: true });
    expect(Number(row.cost_micros)).toBe(EST.micros);
    expect(await counters()).toEqual({ month: [[0, EST.micros]] });
    expect(await drift()).toEqual([]);
  });

  it("concurrent recovery sweeps charge each stale call once", async () => {
    const jobs = await Promise.all(Array.from({ length: 5 }, () => freshJob()));
    await Promise.all(jobs.map((j) => dal().reserve(reserveInput(j))));
    const stale = dal({ llmStaleReservationSeconds: 0 });
    await Promise.all([stale.recoverStale(10), stale.recoverStale(10), stale.recoverStale(10)]);
    expect(await counters()).toEqual({ month: [[0, 5 * EST.micros]] });
    expect(await drift()).toEqual([]);
  });
});

describe("global alert and stop (5.5a)", () => {
  const tight = { llmSpendGlobalMonthlyMicros: 100_000, llmSpendLifetimeMicrosPerUser: 100_000, llmSpendDailyMicrosPerUser: 100_000, llmSpendPerPreviewMicros: 100_000, llmSpendPerCallMicros: 100_000 };

  async function spendOne(d: ReturnType<typeof dal>, costMicros: number) {
    const job = await freshJob();
    const r = await d.reserve(reserveInput(job, { estimate: { micros: costMicros, inputTokens: 1, outputTokens: 1 } }));
    if (r.status !== "reserved") throw new Error(`expected reserved, got ${JSON.stringify(r)}`);
    await d.settle({ callId: r.callId, usage: { inputTokens: 1, outputTokens: 1, costMicros }, usageEstimated: false, reason: "reported" });
  }

  it("raises the 70 percent alert once and the event is claimed once (check 8)", async () => {
    const d = dal(tight);
    await spendOne(d, 69_999);
    expect(await d.claimAlerts()).toEqual([]);
    await spendOne(d, 1);
    await spendOne(d, 1);
    const month = (await admin.query(`SELECT alerted_70_at, stopped_at FROM llm_spend_month`)).rows[0];
    expect(month.alerted_70_at).not.toBeNull();
    expect(month.stopped_at).toBeNull();
    const [first, second] = await Promise.all([d.claimAlerts(), d.claimAlerts()]);
    expect([first.length, second.length].sort()).toEqual([0, 1]);
    expect(await d.claimAlerts()).toEqual([]);
  });

  it("concurrent settles crossing the threshold raise the alert exactly once", async () => {
    const d = dal({ ...tight, llmSpendGlobalMonthlyMicros: 1_000_000, llmSpendLifetimeMicrosPerUser: 1_000_000, llmSpendDailyMicrosPerUser: 1_000_000, llmSpendPerPreviewMicros: 1_000_000 });
    const jobs = await Promise.all(Array.from({ length: 10 }, () => freshJob()));
    const rs = await Promise.all(jobs.map((j) => d.reserve(reserveInput(j, { estimate: { micros: 100_000, inputTokens: 1, outputTokens: 1 } }))));
    await Promise.all(rs.map((r) => (r.status === "reserved" ? d.settle({ callId: r.callId, usage: { inputTokens: 1, outputTokens: 1, costMicros: 100_000 }, usageEstimated: false, reason: "reported" }) : null)));
    expect((await d.claimAlerts()).length).toBe(1);
    expect((await d.claimAlerts()).length).toBe(0);
    expect(await drift()).toEqual([]);
  });

  it("stops every further call at 100 percent and refuses with global_stopped", async () => {
    const d = dal(tight);
    await spendOne(d, 100_000);
    const month = (await admin.query(`SELECT stopped_at FROM llm_spend_month`)).rows[0];
    expect(month.stopped_at).not.toBeNull();
    const job = await freshJob();
    expect(await d.reserve(reserveInput(job, { estimate: { micros: 1, inputTokens: 1, outputTokens: 1 } }))).toEqual({ status: "refused", reason: "global_stopped" });
  });
});

describe("integrity and grants", () => {
  it("a settled call and the estimate of a reserved call are immutable (55000)", async () => {
    const job = await freshJob();
    const r = await dal().reserve(reserveInput(job));
    if (r.status !== "reserved") throw new Error("expected reserved");
    expect(await pgErrorCode(() => admin.query(`UPDATE llm_call SET estimate_micros = 1 WHERE id = $1`, [r.callId]))).toBe("55000");
    await dal().settle({ callId: r.callId, usage: { inputTokens: 1, outputTokens: 1, costMicros: 5 }, usageEstimated: false, reason: "reported" });
    expect(await pgErrorCode(() => admin.query(`UPDATE llm_call SET cost_micros = 0 WHERE id = $1`, [r.callId]))).toBe("55000");
    expect(await pgErrorCode(() => admin.query(`UPDATE llm_call SET state = 'reserved', settled_at = NULL WHERE id = $1`, [r.callId]))).toBe("55000");
  });

  it("a ledger row must belong to the same owner as its job (23503)", async () => {
    const job = await freshJob();
    const other = await seedOwner(admin);
    const code = await pgErrorCode(() =>
      admin.query(
        `INSERT INTO llm_call (owner_id, job_id, job_attempt, fencing_token, call_seq, purpose, provider, model, estimate_micros, estimate_input_tokens,
                               estimate_output_tokens, call_month, call_day)
         VALUES ($1,$2,1,1,99,'items','fake','m',1,1,1, current_date, current_date)`,
        [other, job.jobId],
      ),
    );
    expect(code).toBe("23503");
  });

  it("the web role reads but never writes the ledger or the counters; neither role can delete (42501)", async () => {
    const job = await freshJob();
    const r = await dal().reserve(reserveInput(job));
    if (r.status !== "reserved") throw new Error("expected reserved");
    expect((await app.query(`SELECT count(*)::int n FROM llm_call`)).rows[0].n).toBe(1);
    for (const sql of [
      `UPDATE llm_call SET provider = 'x'`,
      `INSERT INTO llm_spend_month (month) VALUES ('2030-01-01')`,
      `UPDATE llm_spend_month SET settled_micros = 0`,
      `UPDATE llm_spend_user SET lifetime_settled_micros = 0`,
      `UPDATE llm_spend_user_day SET settled_micros = 0`,
      `DELETE FROM llm_call`,
    ]) {
      expect(await pgErrorCode(() => app.query(sql)), sql).toBe("42501");
    }
    for (const sql of [`DELETE FROM llm_call`, `DELETE FROM llm_spend_month`, `DELETE FROM ai_action`]) {
      expect(await pgErrorCode(() => workerPg.query(sql)), sql).toBe("42501");
    }
  });

  it("the drift view reports counters that disagree with the ledger and is empty otherwise", async () => {
    const job = await freshJob();
    const r = await dal().reserve(reserveInput(job));
    if (r.status !== "reserved") throw new Error("expected reserved");
    expect(await drift()).toEqual([]);
    await admin.query(`UPDATE llm_spend_month SET reserved_micros = reserved_micros + 1`);
    expect((await drift()).map((d) => d.scope)).toEqual(["month"]);
    await admin.query(`UPDATE llm_spend_month SET reserved_micros = reserved_micros - 1`);
    await admin.query(`UPDATE llm_spend_user SET lifetime_reserved_micros = 0`);
    await admin.query(`UPDATE llm_spend_user_day SET calls = 7`);
    expect((await drift()).map((d) => d.scope).sort()).toEqual(["day", "user"]);
    expect((await workerPg.query(`SELECT scope FROM llm_spend_drift`)).rows.length).toBe(2);
  });
});
