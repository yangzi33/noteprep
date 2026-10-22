import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  AccountNotActive,
  AllowanceExhausted,
  IdempotencyConflict,
  ManifestIncomplete,
  NotCompleteSuccess,
  NotFound,
  QueueBusy,
  RateLimited,
  StaleOrCanceled,
  TooManyActiveJobs,
} from "@/lib/domain/errors";
import { DEV_DEFAULT_LIMITS, type GenerationLimits } from "@/lib/domain/generation";
import { EDITIONS, FORMATS, artifactPath, type ManifestEntry } from "@/lib/domain/manifest";
import { makeAuthedCtx as makeCtx } from "@/lib/server/auth/context";
import { createDb } from "@/lib/server/db";
import { createWebDal, createWorkerDal, type CommitSuccessInput } from "@/lib/server/dal";
import { isRetryableDbError } from "@/lib/server/dal/tx";
import { inject } from "vitest";
import { pools } from "./helpers";

// The database is shared by every test file, and other files corrupt a bucket's counters on purpose (to test the
// constraints and the drift view). Drift is therefore checked only for the accounts THIS file created.
const ownedHere = new Set<string>();
const makeAuthedCtx = (id: string) => {
  ownedHere.add(id);
  return makeCtx(id);
};
const driftHere = async (db: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> }) =>
  (await db.query(`SELECT d.* FROM usage_bucket_drift d JOIN usage_bucket b ON b.id = d.bucket_id WHERE b.owner_id = ANY($1::uuid[])`, [[...ownedHere]])).rows;

const info = inject("testDb");
const { admin, worker: workerPg } = pools();
const appDb = createDb(info.appUrl);
const workerDb = createDb(info.workerUrl);

afterAll(async () => {
  await Promise.all([admin.end(), workerPg.end(), appDb.$disconnect(), workerDb.$disconnect()]);
});

// Generous limits so that tests exercising one rule are not tripped by another.
const OPEN: GenerationLimits = {
  ...DEV_DEFAULT_LIMITS,
  maxActiveJobsPerUser: 100,
  maxQueuedJobsGlobal: 100_000,
  rateLimitPerHourPerUser: 1000,
  rateLimitPerHourPerIp: 1000,
};

const web = createWebDal(appDb, { limits: OPEN });
const settle = createWorkerDal(workerDb).settlement;

function input(n = 5, notes?: string) {
  return {
    topic: "linear_equations_one_variable",
    level: "Grade 7-8 equivalent",
    objectives: ["Solve ax + b = c"],
    durationMinutes: 60,
    difficulty: "mixed",
    questionCount: n,
    ...(notes ? { notes } : {}),
  };
}

const key = () => `key-${randomUUID()}`;

async function newAccount(trialLimit = 3) {
  const ctx = makeAuthedCtx(randomUUID());
  await web.account.ensureAccount(ctx);
  if (trialLimit !== 3) await admin.query(`UPDATE usage_bucket SET limit_count = $2 WHERE owner_id = $1`, [ctx.userId, trialLimit]);
  return ctx;
}

async function bucketOf(ownerId: string, kind = "trial") {
  const { rows } = await admin.query(
    `SELECT id, used, reserved, limit_count FROM usage_bucket WHERE owner_id = $1 AND kind = $2::bucket_kind`,
    [ownerId, kind],
  );
  return rows[0] as { id: string; used: number; reserved: number; limit_count: number };
}

async function expectNoDrift() {
  expect(await driftHere(workerPg)).toEqual([]);
}

/** Simulates the claim step (implemented in P1-T6) so settlement can be tested on its own. */
async function claim(jobId: string, token = 1n) {
  await admin.query(
    `UPDATE generation_job SET state = 'running', stage = 'storing', lease_owner = 'test-worker',
            lease_expires_at = now() + interval '5 minutes', fencing_token = $2, attempt = attempt + 1, started_at = now()
      WHERE id = $1`,
    [jobId, token.toString()],
  );
  return token;
}

async function jobRow(jobId: string) {
  const { rows } = await admin.query(`SELECT * FROM generation_job WHERE id = $1`, [jobId]);
  return rows[0];
}

async function commitInput(jobId: string, token: bigint, patch: Partial<CommitSuccessInput> = {}): Promise<CommitSuccessInput> {
  const { rows } = await admin.query(`SELECT owner_id, lesson_id FROM generation_job WHERE id = $1`, [jobId]);
  const { owner_id: ownerId, lesson_id: lessonId } = rows[0];
  const revisionId = randomUUID();
  const attemptId = randomUUID();
  const scope = { ownerId, lessonId, revisionId, attemptId };
  const manifest: ManifestEntry[] = EDITIONS.flatMap((edition) =>
    FORMATS.map((format) => ({
      edition,
      format,
      path: artifactPath(scope, edition, format),
      sha256: "b".repeat(64),
      bytes: 1234,
    })),
  );
  return {
    jobId,
    fencingToken: token,
    attemptId,
    revisionId,
    revision: {
      schemaVersion: 1,
      content: { fixture: true },
      contentHash: "sha256:fixture",
      validationReport: { overall: "verified" },
      validationStatus: "verified",
      templateVersion: "handout/1.0.0",
      validatorVersion: "test/0",
    },
    manifest,
    ...patch,
  };
}

/** Create -> claim -> commit: one complete generation. */
async function completeOne(ctx: ReturnType<typeof makeAuthedCtx>) {
  const { job } = await web.generation.createGeneration(ctx, input(), key());
  const token = await claim(job.id);
  const result = await settle.commitSuccess(await commitInput(job.id, token));
  return { job, result };
}

describe("account setup", () => {
  it("converges on one profile and one trial bucket under concurrent duplicate callbacks", async () => {
    const ctx = makeAuthedCtx(randomUUID());
    await Promise.all(Array.from({ length: 8 }, () => web.account.ensureAccount(ctx)));
    const profiles = await admin.query(`SELECT count(*)::int AS n FROM profile WHERE id = $1`, [ctx.userId]);
    const buckets = await admin.query(`SELECT limit_count, used, reserved FROM usage_bucket WHERE owner_id = $1`, [ctx.userId]);
    expect(profiles.rows[0].n).toBe(1);
    expect(buckets.rows).toEqual([{ limit_count: 3, used: 0, reserved: 0 }]);
  });

  it("does not reset an existing allowance when run again", async () => {
    const ctx = await newAccount();
    await completeOne(ctx);
    await web.account.ensureAccount(ctx);
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 1, reserved: 0, limit_count: 3 });
  });

  it("serializes enqueueing with account deletion on the profile row", async () => {
    const ctx = await newAccount();
    const deleter = await admin.connect();
    try {
      await deleter.query("BEGIN");
      await deleter.query(`SELECT 1 FROM profile WHERE id = $1 FOR UPDATE`, [ctx.userId]); // deletion flow holds the account
      const enqueue = web.generation.createGeneration(ctx, input(), key()).then(
        () => "created",
        (e: unknown) => e,
      );
      const early = await Promise.race([enqueue, new Promise((r) => setTimeout(() => r("still waiting"), 500))]);
      expect(early).toBe("still waiting"); // the enqueue waits for the lock instead of racing past it
      await deleter.query(`UPDATE profile SET status = 'deleting' WHERE id = $1`, [ctx.userId]);
      await deleter.query("COMMIT");
      expect(await enqueue).toBeInstanceOf(AccountNotActive); // and then sees the new state
    } finally {
      deleter.release();
    }
    const jobs = await admin.query(`SELECT count(*)::int AS n FROM generation_job WHERE owner_id = $1`, [ctx.userId]);
    expect(jobs.rows[0].n).toBe(0);
  });

  it("refuses to enqueue for an account that is missing or being deleted", async () => {
    await expect(web.generation.createGeneration(makeAuthedCtx(randomUUID()), input(), key())).rejects.toBeInstanceOf(
      AccountNotActive,
    );
    const ctx = await newAccount();
    await admin.query(`UPDATE profile SET status = 'deleting' WHERE id = $1`, [ctx.userId]);
    await expect(web.generation.createGeneration(ctx, input(), key())).rejects.toBeInstanceOf(AccountNotActive);
  });
});

describe("the three free generations", () => {
  it("allows three complete generations and rejects the fourth", async () => {
    const ctx = await newAccount();
    for (let i = 1; i <= 3; i++) {
      await completeOne(ctx);
      expect(await bucketOf(ctx.userId)).toMatchObject({ used: i, reserved: 0 });
    }
    const err = await web.generation.createGeneration(ctx, input(), key()).catch((e) => e);
    expect(err).toBeInstanceOf(AllowanceExhausted);
    expect(err).toMatchObject({ source: "trial", pending: 0 });
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 3, reserved: 0 });
    const jobs = await admin.query(`SELECT count(*)::int AS n FROM generation_job WHERE owner_id = $1`, [ctx.userId]);
    expect(jobs.rows[0].n).toBe(3); // the rejected request left nothing behind
    await expectNoDrift();
  });

  it("lets exactly one of many concurrent requests take the last unit", async () => {
    const ctx = await newAccount();
    await completeOne(ctx);
    await completeOne(ctx); // used = 2, one unit left
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => web.generation.createGeneration(ctx, input(5, `n${i}`), key())),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(AllowanceExhausted);
    expect(rejected[0]?.reason).toMatchObject({ pending: 1 });
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 2, reserved: 1 });
    await expectNoDrift();
  });

  it("returns the unit when the winner fails, so the loser's retry can succeed", async () => {
    const ctx = await newAccount(1);
    const first = await web.generation.createGeneration(ctx, input(5, "a"), key());
    await expect(web.generation.createGeneration(ctx, input(5, "b"), key())).rejects.toBeInstanceOf(AllowanceExhausted);
    const token = await claim(first.job.id);
    await settle.finishJob({ jobId: first.job.id, fencingToken: token, outcome: "failed", errorCode: "llm_timeout" });
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    await expect(web.generation.createGeneration(ctx, input(5, "b"), key())).resolves.toMatchObject({ replayed: false });
  });
});

describe("idempotency", () => {
  it("returns the original job for the same key and request, without a second reservation", async () => {
    const ctx = await newAccount();
    const k = key();
    const first = await web.generation.createGeneration(ctx, input(), k);
    const again = await web.generation.createGeneration(ctx, input(), k);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.job.id).toBe(first.job.id);
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
  });

  it("collapses concurrent identical requests into one job", async () => {
    const ctx = await newAccount();
    const k = key();
    const results = await Promise.all(Array.from({ length: 6 }, () => web.generation.createGeneration(ctx, input(), k)));
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await bucketOf(ctx.userId)).toMatchObject({ reserved: 1 });
    await expectNoDrift();
  });

  it("conflicts when the same key is reused for a different request, with no side effects", async () => {
    const ctx = await newAccount();
    const k = key();
    await web.generation.createGeneration(ctx, input(5), k);
    await expect(web.generation.createGeneration(ctx, input(6), k)).rejects.toBeInstanceOf(IdempotencyConflict);
    expect(await bucketOf(ctx.userId)).toMatchObject({ reserved: 1 });
  });

  it("still replays after the job finished, and the key is scoped to the account", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const k = key();
    const { job } = await web.generation.createGeneration(a, input(), k);
    const token = await claim(job.id);
    await settle.commitSuccess(await commitInput(job.id, token));
    const replay = await web.generation.createGeneration(a, input(), k);
    expect(replay).toMatchObject({ replayed: true, job: { id: job.id, state: "succeeded" } });
    const other = await web.generation.createGeneration(b, input(), k); // same key text, different account
    expect(other.replayed).toBe(false);
    expect(other.job.id).not.toBe(job.id);
  });
});

describe("settlement", () => {
  it("publishes the revision, finishes the job and consumes the reservation together", async () => {
    const ctx = await newAccount();
    const { job, result } = await completeOne(ctx);
    expect(result.replayed).toBe(false);
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ state: "succeeded", stage: null, revision_id: result.revisionId, lease_owner: null });
    const lesson = await admin.query(`SELECT current_revision_id FROM lesson WHERE id = $1`, [row.lesson_id]);
    expect(lesson.rows[0].current_revision_id).toBe(result.revisionId);
    const rev = await admin.query(`SELECT status, number, artifact_manifest FROM lesson_revision WHERE id = $1`, [result.revisionId]);
    expect(rev.rows[0]).toMatchObject({ status: "finalized", number: 1 });
    expect(rev.rows[0].artifact_manifest).toHaveLength(4);
    const reservation = await admin.query(`SELECT state FROM usage_reservation WHERE job_id = $1`, [job.id]);
    expect(reservation.rows[0].state).toBe("consumed");
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
  });

  it("consumes at most once when commit is repeated or raced", async () => {
    const ctx = await newAccount();
    const { job } = await web.generation.createGeneration(ctx, input(), key());
    const token = await claim(job.id);
    const commit = await commitInput(job.id, token);
    const results = await Promise.allSettled([settle.commitSuccess(commit), settle.commitSuccess(commit), settle.commitSuccess(commit)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(results.filter((r) => r.status === "fulfilled" && !r.value.replayed)).toHaveLength(1);
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
    const revs = await admin.query(`SELECT count(*)::int AS n FROM lesson_revision WHERE created_by_job_id = $1`, [job.id]);
    expect(revs.rows[0].n).toBe(1);
  });

  it("rejects a late success from a stale attempt and leaves allowance untouched", async () => {
    const ctx = await newAccount();
    const { job } = await web.generation.createGeneration(ctx, input(), key());
    const oldToken = await claim(job.id, 1n);
    const stale = await commitInput(job.id, oldToken);
    // Lease expires; the sweeper requeues and a second worker claims with a higher token.
    await admin.query(`UPDATE generation_job SET state = 'queued', stage = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1`, [job.id]);
    await expect(settle.commitSuccess(stale)).rejects.toBeInstanceOf(StaleOrCanceled); // queued again
    await claim(job.id, 2n);
    await expect(settle.commitSuccess(stale)).rejects.toBeInstanceOf(StaleOrCanceled); // old token
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
    const revs = await admin.query(`SELECT count(*)::int AS n FROM lesson_revision WHERE created_by_job_id = $1`, [job.id]);
    expect(revs.rows[0].n).toBe(0);
    // The current attempt can still finish normally.
    await expect(settle.commitSuccess(await commitInput(job.id, 2n))).resolves.toMatchObject({ replayed: false });
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
  });

  it("rejects publication after the job failed or was canceled", async () => {
    const ctx = await newAccount();
    const { job } = await web.generation.createGeneration(ctx, input(), key());
    const token = await claim(job.id);
    const commit = await commitInput(job.id, token);
    await settle.finishJob({ jobId: job.id, fencingToken: token, outcome: "failed", errorCode: "compile_failed" });
    await expect(settle.commitSuccess(commit)).rejects.toBeInstanceOf(StaleOrCanceled);
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("rejects publication once cancellation was requested", async () => {
    const ctx = await newAccount();
    const { job } = await web.generation.createGeneration(ctx, input(), key());
    const token = await claim(job.id);
    const commit = await commitInput(job.id, token);
    const canceled = await web.generation.cancelJob(ctx, job.id);
    expect(canceled).toMatchObject({ state: "running", cancelRequested: true });
    await expect(settle.commitSuccess(commit)).rejects.toBeInstanceOf(StaleOrCanceled);
    await settle.finishJob({ jobId: job.id, fencingToken: token, outcome: "canceled", errorCode: "canceled" });
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect(await jobRow(job.id)).toMatchObject({ state: "canceled" });
  });

  it("does not publish into a deleted lesson or for an account being deleted", async () => {
    const ctx = await newAccount();
    const { job } = await web.generation.createGeneration(ctx, input(), key());
    const token = await claim(job.id);
    const commit = await commitInput(job.id, token);
    await admin.query(`UPDATE lesson SET deleted_at = now() WHERE id = (SELECT lesson_id FROM generation_job WHERE id = $1)`, [job.id]);
    await expect(settle.commitSuccess(commit)).rejects.toBeInstanceOf(StaleOrCanceled);

    const ctx2 = await newAccount();
    const second = await web.generation.createGeneration(ctx2, input(), key());
    const token2 = await claim(second.job.id);
    const commit2 = await commitInput(second.job.id, token2);
    await admin.query(`UPDATE profile SET status = 'deleting' WHERE id = $1`, [ctx2.userId]);
    await expect(settle.commitSuccess(commit2)).rejects.toBeInstanceOf(StaleOrCanceled);
    expect(await bucketOf(ctx2.userId)).toMatchObject({ used: 0, reserved: 1 });
  });

  it("does not count output that is incomplete or not fully verified", async () => {
    const ctx = await newAccount();
    const { job } = await web.generation.createGeneration(ctx, input(), key());
    const token = await claim(job.id);
    const good = await commitInput(job.id, token);
    const legacy = good.manifest as ManifestEntry[]; // the legacy four-file list

    await expect(settle.commitSuccess({ ...good, manifest: legacy.slice(0, 3) })).rejects.toBeInstanceOf(ManifestIncomplete);
    const noStudentPdf = legacy.filter((m) => !(m.edition === "student" && m.format === "pdf"));
    await expect(settle.commitSuccess({ ...good, manifest: noStudentPdf })).rejects.toBeInstanceOf(ManifestIncomplete);
    await expect(
      settle.commitSuccess({ ...good, revision: { ...good.revision, validationStatus: "unverified" } }),
    ).rejects.toBeInstanceOf(NotCompleteSuccess);
    await expect(
      settle.commitSuccess({ ...good, revision: { ...good.revision, validationStatus: "failed" } }),
    ).rejects.toBeInstanceOf(NotCompleteSuccess);

    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 0, reserved: 1 }); // nothing consumed, nothing released yet
    expect(await jobRow(job.id)).toMatchObject({ state: "running" });
    await expect(settle.commitSuccess(good)).resolves.toMatchObject({ replayed: false });
  });

  it("every failure path releases the reservation without consuming", async () => {
    const ctx = await newAccount();
    for (const code of ["llm_timeout", "validation_failed", "compile_failed", "storage_failed"]) {
      const { job } = await web.generation.createGeneration(ctx, input(5, code), key());
      const token = await claim(job.id);
      await settle.finishJob({ jobId: job.id, fencingToken: token, outcome: "failed", errorCode: code });
      const res = await admin.query(`SELECT state, settle_reason FROM usage_reservation WHERE job_id = $1`, [job.id]);
      expect(res.rows[0]).toEqual({ state: "released", settle_reason: `failed:${code}` });
    }
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    await expectNoDrift();
  });
});

describe("cancellation and ownership", () => {
  it("cancels a queued job immediately and releases its reservation, idempotently", async () => {
    const ctx = await newAccount(1);
    const { job } = await web.generation.createGeneration(ctx, input(), key());
    const first = await web.generation.cancelJob(ctx, job.id);
    expect(first).toMatchObject({ state: "canceled", errorCode: "canceled" });
    expect(await web.generation.cancelJob(ctx, job.id)).toMatchObject({ state: "canceled" });
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    await expect(web.generation.createGeneration(ctx, input(5, "again"), key())).resolves.toBeDefined();
  });

  it("hides other users' jobs on read and cancel", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const { job } = await web.generation.createGeneration(a, input(), key());
    await expect(web.generation.getJob(b, job.id)).rejects.toBeInstanceOf(NotFound);
    await expect(web.generation.cancelJob(b, job.id)).rejects.toBeInstanceOf(NotFound);
    await expect(web.generation.getJob(b, "not-a-uuid")).rejects.toBeInstanceOf(NotFound);
    await expect(web.generation.getJob(b, randomUUID())).rejects.toBeInstanceOf(NotFound);
    expect(await jobRow(job.id)).toMatchObject({ state: "queued" });
    await expect(web.generation.getJob(a, job.id)).resolves.toMatchObject({ id: job.id });
  });
});

describe("limits that failures do not refund", () => {
  it("counts every accepted request against the hourly limit, even when the jobs fail", async () => {
    const limited = createWebDal(appDb, { limits: { ...OPEN, rateLimitPerHourPerUser: 3 } });
    const ctx = makeAuthedCtx(randomUUID());
    await limited.account.ensureAccount(ctx);
    await admin.query(`UPDATE usage_bucket SET limit_count = 50 WHERE owner_id = $1`, [ctx.userId]);
    for (let i = 0; i < 3; i++) {
      const { job } = await limited.generation.createGeneration(ctx, input(5, `r${i}`), key());
      const token = await claim(job.id);
      await settle.finishJob({ jobId: job.id, fencingToken: token, outcome: "failed", errorCode: "llm_timeout" });
    }
    await expect(limited.generation.createGeneration(ctx, input(5, "r3"), key())).rejects.toBeInstanceOf(RateLimited);
    expect(await bucketOf(ctx.userId)).toMatchObject({ used: 0, reserved: 0 }); // allowance was returned, the rate was not
    const win = await admin.query(`SELECT count FROM rate_limit_window WHERE key = $1`, [`gen:u:${ctx.userId}`]);
    expect(win.rows[0].count).toBe(3); // the rejected request did not increment
  });

  it("limits the IP independently of the account", async () => {
    const limited = createWebDal(appDb, { limits: { ...OPEN, rateLimitPerHourPerIp: 2 } });
    const ipHash = `ip-${randomUUID()}`;
    for (let i = 0; i < 2; i++) {
      const ctx = await newAccount();
      await limited.generation.createGeneration(ctx, input(), key(), { ipHash });
    }
    const third = await newAccount();
    await expect(limited.generation.createGeneration(third, input(), key(), { ipHash })).rejects.toBeInstanceOf(RateLimited);
  });

  it("caps concurrent jobs per account and queued jobs globally", async () => {
    const capped = createWebDal(appDb, { limits: { ...OPEN, maxActiveJobsPerUser: 1 } });
    const ctx = await newAccount();
    await capped.generation.createGeneration(ctx, input(5, "one"), key());
    await expect(capped.generation.createGeneration(ctx, input(5, "two"), key())).rejects.toBeInstanceOf(TooManyActiveJobs);

    // The cap is count-then-insert, so it only holds if requests for one account are serialized.
    const racing = createWebDal(appDb, { limits: { ...OPEN, maxActiveJobsPerUser: 1 } });
    const racer = await newAccount();
    const raced = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => racing.generation.createGeneration(racer, input(5, `race${i}`), key())),
    );
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of raced) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(TooManyActiveJobs);

    const queued = await admin.query(`SELECT count(*)::int AS n FROM generation_job WHERE state = 'queued'`);
    const busy = createWebDal(appDb, { limits: { ...OPEN, maxQueuedJobsGlobal: queued.rows[0].n } });
    await expect(busy.generation.createGeneration(await newAccount(), input(), key())).rejects.toBeInstanceOf(QueueBusy);
  });
});

describe("paid period buckets", () => {
  const NOW = new Date("2026-03-15T00:00:00Z");
  const START = new Date("2026-03-01T00:00:00Z");
  const END = new Date("2026-04-01T00:00:00Z");
  const dal = createWebDal(appDb, { limits: OPEN, clock: () => NOW });

  async function subscribe(ownerId: string, patch: { status?: string; invoicePaid?: boolean; start?: Date; end?: Date } = {}) {
    const start = patch.start ?? START;
    const end = patch.end ?? END;
    const sub = await admin.query(
      `INSERT INTO subscription (owner_id, stripe_subscription_id, stripe_price_id, status, period_start, period_end, latest_invoice_paid, synced_at)
       VALUES ($1, $2, 'price_test', $3, $4, $5, $6, now()) RETURNING id`,
      [ownerId, `sub_${randomUUID()}`, patch.status ?? "active", start, end, patch.invoicePaid ?? true],
    );
    const bucket = await admin.query(
      `INSERT INTO usage_bucket (owner_id, kind, limit_count, subscription_id, period_key, starts_at, ends_at)
       VALUES ($1, 'paid', 2, $2, $3, $4, $5) RETURNING id`,
      [ownerId, sub.rows[0].id, Math.floor(start.getTime() / 1000), start, end],
    );
    return { subscriptionId: sub.rows[0].id as string, bucketId: bucket.rows[0].id as string };
  }

  async function counters(bucketId: string) {
    const { rows } = await admin.query(`SELECT used, reserved FROM usage_bucket WHERE id = $1`, [bucketId]);
    return rows[0];
  }

  async function account() {
    const ctx = makeAuthedCtx(randomUUID());
    await dal.account.ensureAccount(ctx);
    return ctx;
  }

  it("draws from the paid period bucket and leaves the free trial untouched", async () => {
    const ctx = await account();
    const { bucketId } = await subscribe(ctx.userId);
    const { job } = await dal.generation.createGeneration(ctx, input(), key());
    expect(await counters(bucketId)).toMatchObject({ reserved: 1, used: 0 });
    expect(await bucketOf(ctx.userId)).toMatchObject({ reserved: 0, used: 0 });
    const reservation = await admin.query(`SELECT bucket_id FROM usage_reservation WHERE job_id = $1`, [job.id]);
    expect(reservation.rows[0].bucket_id).toBe(bucketId);
  });

  it("does not fall back to the free trial when the paid period is used up", async () => {
    const ctx = await account();
    const { bucketId } = await subscribe(ctx.userId);
    await dal.generation.createGeneration(ctx, input(5, "a"), key());
    await dal.generation.createGeneration(ctx, input(5, "b"), key());
    const err = await dal.generation.createGeneration(ctx, input(5, "c"), key()).catch((e) => e);
    expect(err).toBeInstanceOf(AllowanceExhausted);
    expect(err).toMatchObject({ source: "paid" });
    expect(await counters(bucketId)).toMatchObject({ reserved: 2 });
    expect(await bucketOf(ctx.userId)).toMatchObject({ reserved: 0, limit_count: 3 }); // all 3 free ones intact
  });

  it.each([
    ["past_due", { status: "past_due" }],
    ["unpaid", { status: "unpaid" }],
    ["canceled", { status: "canceled" }],
    ["trialing", { status: "trialing" }],
    ["invoice not paid", { invoicePaid: false }],
    ["period ended", { start: new Date("2026-02-01T00:00:00Z"), end: new Date("2026-03-01T00:00:00Z") }],
  ])("uses only the free trial when the subscription is %s", async (_label, patch) => {
    const ctx = await account();
    const { bucketId } = await subscribe(ctx.userId, patch);
    await dal.generation.createGeneration(ctx, input(), key());
    expect(await counters(bucketId)).toMatchObject({ reserved: 0 });
    expect(await bucketOf(ctx.userId)).toMatchObject({ reserved: 1 });
  });

  it("settles an in-flight job against its original bucket after the period rolls over", async () => {
    const ctx = await account();
    const { bucketId } = await subscribe(ctx.userId);
    const { job } = await dal.generation.createGeneration(ctx, input(), key());
    // Next period starts: the subscription is renewed and a new bucket exists.
    const next = new Date("2026-05-01T00:00:00Z");
    const sub = await admin.query(`SELECT id FROM subscription WHERE owner_id = $1`, [ctx.userId]);
    const nextBucket = await admin.query(
      `INSERT INTO usage_bucket (owner_id, kind, limit_count, subscription_id, period_key, starts_at, ends_at)
       VALUES ($1,'paid',2,$2,$3,$4,$5) RETURNING id`,
      [ctx.userId, sub.rows[0].id, Math.floor(END.getTime() / 1000), END, next],
    );
    const token = await claim(job.id);
    await settle.commitSuccess(await commitInput(job.id, token));
    expect(await counters(bucketId)).toMatchObject({ used: 1, reserved: 0 });
    expect(await counters(nextBucket.rows[0].id)).toMatchObject({ used: 0, reserved: 0 }); // no borrowing
  });

  it("fails closed when an entitled account has no bucket for its period", async () => {
    const ctx = await account();
    const { bucketId } = await subscribe(ctx.userId);
    await admin.query(`DELETE FROM usage_bucket WHERE id = $1`, [bucketId]);
    await expect(dal.generation.createGeneration(ctx, input(), key())).rejects.toBeInstanceOf(AllowanceExhausted);
  });

  it("the allowance display applies the same bucket window as the reservation path (M3 display bug)", async () => {
    const ctx = await account();
    const { bucketId } = await subscribe(ctx.userId);
    expect(await dal.history.getAllowance(ctx)).toMatchObject({ source: "paid", limit: 2, used: 0, remaining: 2 });
    // The subscription period still covers NOW, but the bucket's own window does not: a reservation fails closed,
    // so the page must not show remaining units either.
    await admin.query(`UPDATE usage_bucket SET starts_at = $2, ends_at = $3 WHERE id = $1`, [bucketId, new Date("2026-03-20T00:00:00Z"), END]);
    await expect(dal.generation.createGeneration(ctx, input(), key())).rejects.toBeInstanceOf(AllowanceExhausted);
    expect(await dal.history.getAllowance(ctx)).toBeNull();
  });
});

describe("retryable database errors", () => {
  it("classifies a real deadlock as retryable and lets the other transaction win", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await admin.query(`INSERT INTO profile (id) VALUES ($1), ($2)`, [a, b]);
    let ready = 0;
    const barrier = async () => {
      ready++;
      while (ready < 2) await new Promise((r) => setTimeout(r, 10));
    };
    const touch = (tx: Parameters<Parameters<typeof workerDb.$transaction>[0]>[0], id: string) =>
      tx.$executeRaw`UPDATE profile SET deletion_requested_at = deletion_requested_at WHERE id = ${id}::uuid`;
    const run = (first: string, second: string) =>
      workerDb.$transaction(async (tx) => {
        await touch(tx, first);
        await barrier();
        await touch(tx, second);
      });
    const results = await Promise.allSettled([run(a, b), run(b, a)]);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(isRetryableDbError(failures[0]?.reason)).toBe(true);
  });

  it("does not treat ordinary errors as retryable", () => {
    expect(isRetryableDbError(new Error("boom"))).toBe(false);
    expect(isRetryableDbError(new AllowanceExhausted(0, "trial"))).toBe(false);
    expect(isRetryableDbError({ code: "P2002" })).toBe(false);
    expect(isRetryableDbError({ code: "P2034" })).toBe(true);
    expect(isRetryableDbError({ meta: { code: "40001" } })).toBe(true);
    expect(isRetryableDbError({ cause: { code: "40P01" } })).toBe(true);
  });
});
