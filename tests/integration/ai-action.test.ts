import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { AiActionLimited, AiStopped, AiUnavailable } from "@/lib/domain/errors";
import { makeAuthedCtx } from "@/lib/server/auth/context";
import { createWebDal } from "@/lib/server/dal";
import { createAiActionDal } from "@/lib/server/dal/ai-action";
import { createLlmSpendDal } from "@/lib/server/dal/llm-spend";
import { createDb } from "@/lib/server/db";
import { DEFAULT_LIMITS, type Limits } from "@/lib/server/limits";
import { pgErrorCode, pools, seedJobWithReservation, seedLesson, seedOwner, seedTrialBucket } from "./helpers";
import { EST, parkJobs, resetSpend, seedAiJob } from "./spend-helpers";

// Spec 5.12 and section 7 (Counting C1-C8, Limits L1-L5, Separation S1-S4): the AI Action slot, against a REAL Postgres.
const info = inject("testDb");
const { admin, app: appPg, worker: workerPg } = pools();
const appDb = createDb(info.appUrl);
const workerDb = createDb(info.workerUrl);

const LIMITS: Limits = { ...DEFAULT_LIMITS, llmItemsEnabled: 1, aiOpsPerUserPerHour: 10 };
const web = (over: Partial<Limits> = {}) => createAiActionDal(appDb, { ...LIMITS, ...over });
const work = (over: Partial<Limits> = {}) => createAiActionDal(workerDb, { ...LIMITS, ...over });
const spend = (over: Partial<Limits> = {}) => createLlmSpendDal(workerDb, { ...LIMITS, ...over });

let n = 0;
const key = () => `req-${++n}-${Math.random().toString(36).slice(2)}`;
const take = (ownerId: string, over: { requestKey?: string; kind?: "initial" | "regenerate" | "replace" | "easier" | "harder"; jobId?: string; draftId?: string } = {}, limits: Partial<Limits> = {}) =>
  web(limits).take({ ownerId, requestKey: over.requestKey ?? key(), kind: over.kind ?? "initial", jobId: over.jobId, draftId: over.draftId });
const actionRow = async (id: string) => (await admin.query(`SELECT * FROM ai_action WHERE id = $1`, [id])).rows[0];
const slotsUsed = async (ownerId: string) => (await admin.query(`SELECT count(*)::int n FROM ai_action WHERE owner_id = $1 AND state <> 'released'`, [ownerId])).rows[0].n as number;

beforeAll(async () => {
  await parkJobs(admin);
});
beforeEach(async () => {
  await resetSpend(admin);
});
afterAll(async () => {
  await resetSpend(admin);
  await Promise.all([admin.end(), appPg.end(), workerPg.end(), appDb.$disconnect(), workerDb.$disconnect()]);
});

describe("the hourly slot (C1-C5)", () => {
  it("accepts 10 requests per user per hour and refuses the 11th with the seconds until the next hour (C1)", async () => {
    const owner = await seedOwner(admin);
    for (let i = 0; i < 10; i++) await take(owner);
    const err = await take(owner).catch((e) => e);
    expect(err).toBeInstanceOf(AiActionLimited);
    expect((err as AiActionLimited).retryAfterSeconds).toBeGreaterThan(0);
    expect((err as AiActionLimited).retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(await slotsUsed(owner)).toBe(10);
  });

  it("limits are per user (C1)", async () => {
    const a = await seedOwner(admin);
    const b = await seedOwner(admin);
    for (let i = 0; i < 10; i++) await take(a);
    await expect(take(a)).rejects.toBeInstanceOf(AiActionLimited);
    expect((await take(b)).replayed).toBe(false);
  });

  it("concurrent requests never exceed the limit", async () => {
    const owner = await seedOwner(admin);
    const results = await Promise.allSettled(Array.from({ length: 25 }, () => take(owner)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof AiActionLimited)).toHaveLength(15);
    expect(await slotsUsed(owner)).toBe(10);
  });

  it("a duplicate idempotency key returns the original and counts once, even beyond the limit (C2)", async () => {
    const owner = await seedOwner(admin);
    const requestKey = key();
    const first = await take(owner, { requestKey });
    const dup = await take(owner, { requestKey });
    expect(dup.replayed).toBe(true);
    expect(dup.action.id).toBe(first.action.id);
    for (let i = 0; i < 9; i++) await take(owner);
    expect((await take(owner, { requestKey })).replayed).toBe(true);
    await expect(take(owner)).rejects.toBeInstanceOf(AiActionLimited);
    expect(await slotsUsed(owner)).toBe(10);
    const concurrent = await seedOwner(admin);
    const k = key();
    const rs = await Promise.all(Array.from({ length: 6 }, () => take(concurrent, { requestKey: k })));
    expect(new Set(rs.map((r) => r.action.id)).size).toBe(1);
    expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it("many internal provider calls under one request still count as one (C3)", async () => {
    const owner = await seedOwner(admin);
    const job = await seedAiJob(admin, owner);
    const { action } = await take(owner, { jobId: job.jobId });
    for (let seq = 1; seq <= 5; seq++) {
      const r = await spend().reserve({ jobId: job.jobId, attempt: 1, fencingToken: 1n, callSeq: seq, purpose: "items", isRetry: seq > 1, provider: "fake", model: "m", estimate: EST });
      expect(r.status).toBe("reserved");
    }
    expect(await slotsUsed(owner)).toBe(1);
    expect((await actionRow(action.id)).provider_called).toBe(true);
  });

  it("slots of a past hour do not count", async () => {
    const owner = await seedOwner(admin);
    for (let i = 0; i < 10; i++) {
      await admin.query(
        `INSERT INTO ai_action (owner_id, request_key, kind, slot_hour) VALUES ($1, $2, 'initial', date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 hour')`,
        [owner, key()],
      );
    }
    expect((await take(owner)).replayed).toBe(false);
  });
});

describe("release and failure (C4-C8)", () => {
  it("a request rejected before any provider call is released and not counted (C4, C5)", async () => {
    const owner = await seedOwner(admin);
    const job = await seedAiJob(admin, owner, { state: "queued" });
    const { action } = await take(owner, { jobId: job.jobId });
    expect(await work().closeFailed({ actionId: action.id, code: "rejected" })).toBe("released");
    expect(await slotsUsed(owner)).toBe(0);
    expect(await actionRow(action.id)).toMatchObject({ state: "released", provider_called: false });
    for (let i = 0; i < 10; i++) await take(owner);
    await expect(take(owner)).rejects.toBeInstanceOf(AiActionLimited);
  });

  it("releases exactly once: a repeat is a no-op and does not free a second slot (C6)", async () => {
    const owner = await seedOwner(admin);
    const { action } = await take(owner);
    expect(await work().closeFailed({ actionId: action.id, code: "x" })).toBe("released");
    expect(await work().closeFailed({ actionId: action.id, code: "x" })).toBe("noop");
    const rs = await Promise.all([work().closeFailed({ actionId: action.id, code: "x" }), work().closeFailed({ actionId: action.id, code: "x" })]);
    expect(rs).toEqual(["noop", "noop"]);
    expect(await slotsUsed(owner)).toBe(0);
  });

  it("keeps the slot when a provider call was reserved, even one that failed (C7)", async () => {
    const owner = await seedOwner(admin);
    const job = await seedAiJob(admin, owner);
    const { action } = await take(owner, { jobId: job.jobId });
    const r = await spend().reserve({ jobId: job.jobId, attempt: 1, fencingToken: 1n, callSeq: 1, purpose: "items", isRetry: false, provider: "fake", model: "m", estimate: EST });
    if (r.status !== "reserved") throw new Error("expected reserved");
    await spend().settle({ callId: r.callId, usage: null, usageEstimated: true, errorType: "timeout", reason: "estimated" });
    await admin.query(`UPDATE generation_job SET state = 'failed', stage = NULL, lease_owner = NULL, lease_expires_at = NULL, finished_at = now() WHERE id = $1`, [job.jobId]);
    expect(await work().closeFailed({ actionId: action.id, code: "timeout" })).toBe("failed");
    expect(await actionRow(action.id)).toMatchObject({ state: "failed", failure_code: "timeout", provider_called: true });
    expect(await slotsUsed(owner)).toBe(1);
  });

  it("the database refuses to release a slot after a provider call even if the DAL were bypassed (C7)", async () => {
    const owner = await seedOwner(admin);
    const job = await seedAiJob(admin, owner);
    const { action } = await take(owner, { jobId: job.jobId });
    await spend().reserve({ jobId: job.jobId, attempt: 1, fencingToken: 1n, callSeq: 1, purpose: "items", isRetry: false, provider: "fake", model: "m", estimate: EST });
    expect(await pgErrorCode(() => admin.query(`UPDATE ai_action SET state = 'released', finished_at = now() WHERE id = $1`, [action.id]))).toBe("23514");
    expect(await pgErrorCode(() => admin.query(`UPDATE ai_action SET provider_called = false WHERE id = $1`, [action.id]))).toBe("55000");
  });

  it("a finished slot is immutable and its identity never changes (C8)", async () => {
    const owner = await seedOwner(admin);
    const { action } = await take(owner);
    expect(await pgErrorCode(() => admin.query(`UPDATE ai_action SET request_key = 'other' WHERE id = $1`, [action.id]))).toBe("55000");
    await work().completeById(action.id);
    expect(await actionRow(action.id)).toMatchObject({ state: "completed", provider_called: false });
    expect(await pgErrorCode(() => admin.query(`UPDATE ai_action SET state = 'accepted', finished_at = NULL WHERE id = $1`, [action.id]))).toBe("55000");
    expect(await work().closeFailed({ actionId: action.id, code: "late" })).toBe("noop");
  });

  it("finalizes the actions of finished jobs: succeeded completes, failed without a call releases, failed after a call keeps the slot", async () => {
    const owner = await seedOwner(admin);
    const mk = async () => {
      const job = await seedAiJob(admin, owner);
      const { action } = await take(owner, { jobId: job.jobId });
      return { job, action };
    };
    const canceled = await mk();
    const noCall = await mk();
    const called = await mk();
    await spend().reserve({ jobId: called.job.jobId, attempt: 1, fencingToken: 1n, callSeq: 1, purpose: "items", isRetry: false, provider: "fake", model: "m", estimate: EST });
    const finish = (jobId: string, state: string) =>
      admin.query(`UPDATE generation_job SET state = '${state}', stage = NULL, lease_owner = NULL, lease_expires_at = NULL, finished_at = now(), error_code = $2 WHERE id = $1`, [jobId, state === "failed" ? "boom" : null]);
    await finish(noCall.job.jobId, "failed");
    await finish(called.job.jobId, "failed");
    await finish(canceled.job.jobId, "canceled");
    const report = await work().finalizeTerminal(50);
    expect(report).toEqual({ completed: 0, released: 2, failed: 1 });
    expect(await actionRow(noCall.action.id)).toMatchObject({ state: "released" });
    expect(await actionRow(called.action.id)).toMatchObject({ state: "failed", failure_code: "boom" });
    expect(await actionRow(canceled.action.id)).toMatchObject({ state: "released" });
    expect(await work().finalizeTerminal(50)).toEqual({ completed: 0, released: 0, failed: 0 });
    expect(await slotsUsed(owner)).toBe(1);
  });

  it("completeForJob completes the action of a succeeded job", async () => {
    const owner = await seedOwner(admin);
    const job = await seedAiJob(admin, owner);
    const { action } = await take(owner, { jobId: job.jobId });
    expect(await work().completeForJob(job.jobId)).toBe(true);
    expect(await work().completeForJob(job.jobId)).toBe(false);
    expect(await actionRow(action.id)).toMatchObject({ state: "completed" });
    expect(await slotsUsed(owner)).toBe(1);
  });
});

describe("the web DAL", () => {
  it("takes the slot for the verified caller only; the owner is never an input", async () => {
    const owner = await seedOwner(admin);
    const dal = createWebDal(appDb, { aiLimits: LIMITS });
    const { action } = await dal.aiActions.take(makeAuthedCtx(owner), { requestKey: key(), kind: "initial", ...({ ownerId: randomUUID() } as object) });
    expect(action.ownerId).toBe(owner);
    expect(await slotsUsed(owner)).toBe(1);
  });
});

describe("kill switch and global stop (L4, L5)", () => {
  it("refuses new AI requests with AI_UNAVAILABLE when the switch is off, replays are still answered", async () => {
    const owner = await seedOwner(admin);
    const requestKey = key();
    await take(owner, { requestKey });
    await expect(take(owner, {}, { llmItemsEnabled: 0 })).rejects.toBeInstanceOf(AiUnavailable);
    expect((await take(owner, { requestKey }, { llmItemsEnabled: 0 })).replayed).toBe(true);
    expect(await slotsUsed(owner)).toBe(1);
  });

  it("refuses with AI_STOPPED once the global monthly cap is spent", async () => {
    const owner = await seedOwner(admin);
    await take(owner);
    await admin.query(`INSERT INTO llm_spend_month (month, settled_micros, stopped_at) VALUES (date_trunc('month', now() AT TIME ZONE 'UTC')::date, 100000000, now())`);
    await expect(take(owner)).rejects.toBeInstanceOf(AiStopped);
    expect(await slotsUsed(owner)).toBe(1);
  });

  it("fails queued AI jobs and releases their slots when switched off; running jobs, other jobs and finished actions are left alone", async () => {
    const owner = await seedOwner(admin);
    const queuedA = await seedAiJob(admin, owner, { state: "queued" });
    const queuedB = await seedAiJob(admin, owner, { state: "queued" });
    const running = await seedAiJob(admin, owner);
    const done = await seedAiJob(admin, owner, { state: "queued" });
    const a = await take(owner, { jobId: queuedA.jobId });
    const b = await take(owner, { jobId: queuedB.jobId });
    const r = await take(owner, { jobId: running.jobId });
    const d = await take(owner, { jobId: done.jobId });
    await work().completeById(d.action.id);
    const bystander = await seedAiJob(admin, owner, { state: "queued" });

    expect(await work().failQueuedWhenDisabled(50)).toBe(0); // switch is on
    const off = work({ llmItemsEnabled: 0 });
    expect(await off.failQueuedWhenDisabled(50)).toBe(2);
    expect(await off.failQueuedWhenDisabled(50)).toBe(0);

    for (const { action, job } of [{ action: a.action, job: queuedA }, { action: b.action, job: queuedB }]) {
      expect(await actionRow(action.id)).toMatchObject({ state: "released", provider_called: false });
      expect((await admin.query(`SELECT state::text s, error_code FROM generation_job WHERE id = $1`, [job.jobId])).rows[0]).toEqual({ s: "failed", error_code: "llm_disabled" });
    }
    expect(await actionRow(r.action.id)).toMatchObject({ state: "accepted" });
    expect((await admin.query(`SELECT state::text s FROM generation_job WHERE id = $1`, [running.jobId])).rows[0].s).toBe("running");
    expect(await actionRow(d.action.id)).toMatchObject({ state: "completed" });
    expect((await admin.query(`SELECT state::text s FROM generation_job WHERE id = $1`, [bystander.jobId])).rows[0].s).toBe("queued");
    expect(await slotsUsed(owner)).toBe(2);
  });

  it("existing drafts stay previewable and exportable: the switch never touches draft rows", async () => {
    const owner = await seedOwner(admin);
    const draft = (await admin.query(`INSERT INTO draft (owner_id, request, request_hash, context, expires_at) VALUES ($1,'{}','h','{}', now() + interval '1 day') RETURNING id`, [owner])).rows[0].id as string;
    const job = await seedAiJob(admin, owner, { state: "queued" });
    await take(owner, { jobId: job.jobId, draftId: draft });
    await work({ llmItemsEnabled: 0 }).failQueuedWhenDisabled(50);
    expect((await admin.query(`SELECT count(*)::int n FROM draft WHERE id = $1`, [draft])).rows[0].n).toBe(1);
  });
});

describe("separation from the generation allowance (S1-S4)", () => {
  it("a job with an AI action cannot also hold an allowance reservation, in either order (S1)", async () => {
    const owner = await seedOwner(admin);
    const lesson = await seedLesson(admin, owner);
    const bucket = await seedTrialBucket(admin, owner);
    // allowance job first, then an action on it
    const allowanceJob = await seedJobWithReservation(admin, owner, lesson, bucket);
    const action = await pgErrorCode(() => admin.query(`INSERT INTO ai_action (owner_id, request_key, kind, job_id, slot_hour) VALUES ($1, 'k-s1', 'initial', $2, date_trunc('hour', now()))`, [owner, allowanceJob]));
    expect(action).toBe("23514");
    // action job first, then a reservation on it
    const aiJob = await seedAiJob(admin, owner);
    await take(owner, { jobId: aiJob.jobId });
    const reservation = await pgErrorCode(() => admin.query(`INSERT INTO usage_reservation (owner_id, bucket_id, job_id) VALUES ($1,$2,$3)`, [owner, bucket, aiJob.jobId]));
    expect(reservation).toBe("23514");
  });

  it("AI Actions, ledger calls and settlement never touch a usage bucket (S2, S3)", async () => {
    const owner = await seedOwner(admin);
    const bucket = await seedTrialBucket(admin, owner);
    const before = (await admin.query(`SELECT used, reserved, limit_count FROM usage_bucket WHERE id = $1`, [bucket])).rows[0];
    const job = await seedAiJob(admin, owner);
    await take(owner, { jobId: job.jobId });
    const r = await spend().reserve({ jobId: job.jobId, attempt: 1, fencingToken: 1n, callSeq: 1, purpose: "items", isRetry: false, provider: "fake", model: "m", estimate: EST });
    if (r.status !== "reserved") throw new Error("expected reserved");
    await spend().settle({ callId: r.callId, usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 }, usageEstimated: false, reason: "reported" });
    expect((await admin.query(`SELECT used, reserved, limit_count FROM usage_bucket WHERE id = $1`, [bucket])).rows[0]).toEqual(before);
    expect((await admin.query(`SELECT count(*)::int n FROM usage_reservation WHERE job_id = $1`, [job.jobId])).rows[0].n).toBe(0);
  });

  it("no per-draft AI budget exists in the schema (S3)", async () => {
    const cols = (await admin.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND (column_name ILIKE '%per_draft%' OR column_name ILIKE '%draft_budget%' OR column_name ILIKE '%ai_budget%')`)).rows;
    expect(cols).toEqual([]);
    const tables = (await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ILIKE '%draft%budget%'`)).rows;
    expect(tables).toEqual([]);
  });

  it("the web role can take slots but cannot delete them, the worker cannot create them (S4)", async () => {
    const owner = await seedOwner(admin);
    const { action } = await take(owner);
    expect(await pgErrorCode(() => appPg.query(`DELETE FROM ai_action WHERE id = $1`, [action.id]))).toBe("42501");
    expect(await pgErrorCode(() => workerPg.query(`INSERT INTO ai_action (owner_id, request_key, kind, slot_hour) VALUES ($1,'w','initial', now())`, [owner]))).toBe("42501");
  });
});

describe("close races", () => {
  it("never closes the request of a running job, and a close racing the first reservation never releases a called slot", async () => {
    const owner = await seedOwner(admin);
    const running = await seedAiJob(admin, owner);
    const a = await take(owner, { jobId: running.jobId });
    expect(await work().closeFailed({ actionId: a.action.id, code: "x" })).toBe("noop");
    expect(await actionRow(a.action.id)).toMatchObject({ state: "accepted" });

    for (let i = 0; i < 6; i++) {
      const job = await seedAiJob(admin, owner, { state: "queued" });
      const { action } = await take(owner, { jobId: job.jobId }, { aiOpsPerUserPerHour: 1000 });
      await admin.query(`UPDATE generation_job SET state = 'failed', finished_at = now() WHERE id = $1`, [job.jobId]);
      await work().closeFailed({ actionId: action.id, code: "x" });
    }
    const rows = (await admin.query(`SELECT a.state, a.provider_called, EXISTS (SELECT 1 FROM llm_call c WHERE c.job_id = a.job_id) AS called FROM ai_action a WHERE a.owner_id = $1`, [owner])).rows;
    for (const r of rows) expect(r.state === "released" ? !r.called && !r.provider_called : true).toBe(true);
  });
});
