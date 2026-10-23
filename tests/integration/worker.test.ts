import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { StaleOrCanceled } from "@/lib/domain/errors";
import { DEV_DEFAULT_LIMITS } from "@/lib/domain/generation";
import { makeAuthedCtx as makeCtx } from "@/lib/server/auth/context";
import { createDb } from "@/lib/server/db";
import { createWebDal, createWorkerDal } from "@/lib/server/dal";
import { CompileError, SKELETON_MARKER, SkeletonCompiler } from "@/lib/latex/compiler";
import { FakeLlmProvider, type FakeStep } from "@/lib/llm/fake";
import type { LlmProvider, StructuredRequest, StructuredResult } from "@/lib/llm/types";
import { FsObjectStore, StorageError, type ObjectStore } from "@/lib/storage/store";
import { runOnce } from "../../worker/loop";
import { processJob } from "../../worker/runner";
import type { PipelineDeps } from "../../worker/pipeline";
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

const web = createWebDal(appDb, {
  limits: { ...DEV_DEFAULT_LIMITS, maxActiveJobsPerUser: 100, maxQueuedJobsGlobal: 100_000, rateLimitPerHourPerUser: 1000 },
});
// Tiny backoff so retried jobs become runnable within milliseconds.
const worker = createWorkerDal(workerDb, { backoff: { baseMs: 1, capMs: 5 } });

let storeDir: string;
let store: FsObjectStore;

beforeAll(async () => {
  storeDir = await mkdtemp(path.join(os.tmpdir(), "noteprep-worker-"));
  store = new FsObjectStore(storeDir);
  // The database is shared by every test file in this run: park leftovers so claims only see our jobs.
  await admin.query(
    `UPDATE generation_job SET state = 'canceled', stage = NULL, lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'test_cleanup', finished_at = now() WHERE state IN ('queued', 'running')`,
  );
});
afterAll(async () => {
  await Promise.all([admin.end(), workerPg.end(), appDb.$disconnect(), workerDb.$disconnect()]);
  await rm(storeDir, { recursive: true, force: true });
});

const input = {
  topic: "linear_equations_one_variable",
  level: "Grade 7-8 equivalent",
  objectives: ["Solve ax + b = c"],
  durationMinutes: 60,
  difficulty: "mixed",
  questionCount: 5,
};

async function newJob(notes = randomUUID()) {
  const ctx = makeAuthedCtx(randomUUID());
  await web.account.ensureAccount(ctx);
  const { job } = await web.generation.createGeneration(ctx, { ...input, notes }, `key-${randomUUID()}`);
  return { ctx, jobId: job.id };
}

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    jobs: worker.jobs,
    settlement: worker.settlement,
    llm: new FakeLlmProvider(),
    compiler: new SkeletonCompiler(),
    store,
    leaseMs: 30_000,
    ...overrides,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jobRow(jobId: string) {
  const { rows } = await admin.query(`SELECT * FROM generation_job WHERE id = $1`, [jobId]);
  return rows[0];
}
async function bucketOf(ownerId: string) {
  const { rows } = await admin.query(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [ownerId]);
  return rows[0] as { used: number; reserved: number };
}
async function reservationState(jobId: string) {
  const { rows } = await admin.query(`SELECT state, settle_reason FROM usage_reservation WHERE job_id = $1`, [jobId]);
  return rows[0] as { state: string; settle_reason: string | null };
}
async function noDrift() {
  expect(await driftHere(workerPg)).toEqual([]);
}
/** Runs the worker until it reports the job as finished or nothing more is runnable. */
async function drain(d: PipelineDeps, workerId = "w", maxRounds = 20) {
  const outcomes: string[] = [];
  for (let i = 0; i < maxRounds; i++) {
    const outcome = await runOnce(d, workerId);
    if (outcome === null) {
      await wait(15); // a requeued job becomes runnable after its (tiny) backoff
      if ((await runOnce(d, workerId).then((o) => (o && outcomes.push(o), o))) === null) break;
      continue;
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

describe("claiming", () => {
  it("hands each queued job to exactly one of many concurrent claimers", async () => {
    const jobs = await Promise.all(Array.from({ length: 6 }, () => newJob()));
    const claims = await Promise.all(Array.from({ length: 14 }, (_, i) => worker.jobs.claimNext(`w${i}`, 30_000)));
    const claimed = claims.filter((c) => c !== null);
    expect(claimed).toHaveLength(6);
    expect(new Set(claimed.map((c) => c.id))).toEqual(new Set(jobs.map((j) => j.jobId)));
    for (const c of claimed) expect(c).toMatchObject({ fencingToken: 1n, attempt: 1 });
    const row = await jobRow(jobs[0]!.jobId);
    expect(row).toMatchObject({ state: "running", stage: "generating", attempt: 1 });
    expect(row.lease_owner).toMatch(/^w\d+$/);
  });

  it("never waits behind a job another transaction is holding: it takes the next runnable one", async () => {
    const first = await newJob();
    const second = await newJob();
    const holder = await admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM generation_job WHERE id = $1 FOR UPDATE`, [first.jobId]); // e.g. a sweeper mid-transaction
      const outcome = await Promise.race([
        worker.jobs.claimNext("w", 30_000),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1_500)),
      ]);
      expect(outcome).not.toBe("blocked");
      expect(outcome).toMatchObject({ id: second.jobId });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    await worker.jobs.claimNext("cleanup", 30_000); // the first job is claimable again
  });

  it("does not claim jobs that are delayed, cancel-requested, out of attempts or past their deadline", async () => {
    const delayed = await newJob();
    const flagged = await newJob();
    const exhausted = await newJob();
    const late = await newJob();
    await admin.query(`UPDATE generation_job SET run_after = now() + interval '1 hour' WHERE id = $1`, [delayed.jobId]);
    await admin.query(`UPDATE generation_job SET cancel_requested_at = now() WHERE id = $1`, [flagged.jobId]);
    await admin.query(`UPDATE generation_job SET attempt = max_attempts WHERE id = $1`, [exhausted.jobId]);
    await admin.query(`UPDATE generation_job SET deadline_at = now() - interval '1 second' WHERE id = $1`, [late.jobId]);
    expect(await worker.jobs.claimNext("w", 30_000)).toBeNull();
  });
});

describe("leases and heartbeats", () => {
  it("extends the lease for the current attempt and reports cancellation and takeover", async () => {
    const { ctx, jobId } = await newJob();
    const first = (await worker.jobs.claimNext("a", 30_000))!;
    await admin.query(`UPDATE generation_job SET lease_expires_at = now() + interval '1 second' WHERE id = $1`, [jobId]);
    expect(await worker.jobs.heartbeat(jobId, first.fencingToken, 60_000, "compiling")).toBe("ok");
    const row = await jobRow(jobId);
    expect(row.stage).toBe("compiling");
    expect(new Date(row.lease_expires_at).getTime()).toBeGreaterThan(Date.now() + 30_000);

    await web.generation.cancelJob(ctx, jobId);
    expect(await worker.jobs.heartbeat(jobId, first.fencingToken, 60_000)).toBe("cancel_requested");

    // A newer claim (token 2) supersedes the old attempt.
    await admin.query(`UPDATE generation_job SET fencing_token = 2 WHERE id = $1`, [jobId]);
    expect(await worker.jobs.heartbeat(jobId, first.fencingToken, 60_000)).toBe("lost");
  });

  it("only the owning attempt can read the job input or charge usage", async () => {
    const { jobId } = await newJob();
    const claim = (await worker.jobs.claimNext("a", 30_000))!;
    await expect(worker.jobs.getInput(jobId, claim.fencingToken)).resolves.toMatchObject({ topic: "linear_equations_one_variable" });
    await expect(worker.jobs.getInput(jobId, claim.fencingToken + 1n)).rejects.toBeInstanceOf(StaleOrCanceled);
    await expect(worker.jobs.chargeUsage(jobId, claim.fencingToken + 1n, { calls: 1, tokens: 1, costMicros: 1 })).rejects.toBeInstanceOf(
      StaleOrCanceled,
    );
    expect(await worker.jobs.chargeUsage(jobId, claim.fencingToken, { calls: 1, tokens: 10, costMicros: 5 })).toEqual({ exceeded: false });
  });
});

describe("the pipeline end to end (fake LLM, skeleton compiler)", () => {
  it("completes a job: publishes the revision, stores four verified files, consumes once", async () => {
    const { ctx, jobId } = await newJob();
    expect(await runOnce(deps(), "w1")).toBe("succeeded");

    const row = await jobRow(jobId);
    expect(row).toMatchObject({ state: "succeeded", stage: null, attempt: 1, calls_used: 1, lease_owner: null });
    expect(Number(row.tokens_used)).toBe(150);
    expect(Number(row.cost_micros)).toBe(1000);
    expect(await bucketOf(ctx.userId)).toEqual({ used: 1, reserved: 0 });
    expect(await reservationState(jobId)).toMatchObject({ state: "consumed" });

    const rev = (await admin.query(`SELECT status, artifact_manifest, generation_meta FROM lesson_revision WHERE id = $1`, [row.revision_id])).rows[0];
    expect(rev.status).toBe("finalized");
    expect(rev.generation_meta).toMatchObject({ skeleton: true });
    const manifest = rev.artifact_manifest as { edition: string; format: string; path: string; sha256: string; bytes: number }[];
    expect(manifest.map((m) => `${m.edition}.${m.format}`).sort()).toEqual(["student.pdf", "student.tex", "teacher.pdf", "teacher.tex"]);
    for (const m of manifest) {
      expect(m.path.startsWith(`${ctx.userId}/${row.lesson_id}/${row.revision_id}/`)).toBe(true);
      expect(await store.stat(m.path)).toEqual({ bytes: m.bytes, sha256: m.sha256 });
    }
    // The skeleton "PDF" is unmistakably not a PDF.
    const pdf = manifest.find((m) => m.format === "pdf")!;
    expect(await store.stat(pdf.path)).not.toBeNull();
    expect(SKELETON_MARKER).toContain("NOT A COMPILED PDF");
    await noDrift();
  });

  it("retries recoverable errors against the same reservation and consumes once", async () => {
    const { ctx, jobId } = await newJob();
    const llm = new FakeLlmProvider([{ error: "timeout" }, { error: "rate_limited" }, "ok"]);
    const outcomes = await drain(deps({ llm }));
    expect(outcomes).toEqual(["requeued", "requeued", "succeeded"]);
    const row = await jobRow(jobId);
    expect(row).toMatchObject({ state: "succeeded", attempt: 3, calls_used: 3 }); // one budget across all attempts
    expect(await bucketOf(ctx.userId)).toEqual({ used: 1, reserved: 0 });
    expect((await admin.query(`SELECT count(*)::int AS n FROM lesson_revision WHERE created_by_job_id = $1`, [jobId])).rows[0].n).toBe(1);
  });

  it("gives up after the attempt limit and releases the allowance", async () => {
    const { ctx, jobId } = await newJob();
    const outcomes = await drain(deps({ llm: new FakeLlmProvider([{ error: "timeout" }]) }));
    expect(outcomes).toEqual(["requeued", "requeued", "failed"]);
    expect(await jobRow(jobId)).toMatchObject({ state: "failed", error_code: "llm_timeout", attempt: 3 });
    expect(await reservationState(jobId)).toEqual({ state: "released", settle_reason: "failed:llm_timeout" });
    expect(await bucketOf(ctx.userId)).toEqual({ used: 0, reserved: 0 });
    await noDrift();
  });

  const terminal: [string, Partial<PipelineDeps>, string][] = [
    ["a refused/invalid model response", { llm: new FakeLlmProvider([{ error: "invalid_output" }]) }, "llm_invalid_output"],
    ["a compile failure", { compiler: new SkeletonCompiler([new CompileError("compile_failed", false)]) }, "compile_failed"],
    ["a non-retryable storage failure", { store: failingStore(new StorageError(false), 99) }, "storage_failed"],
  ];
  it.each(terminal)("fails immediately on %s without consuming allowance", async (_name, override, code) => {
    const { ctx, jobId } = await newJob();
    expect(await runOnce(deps(override), "w")).toBe("failed");
    expect(await jobRow(jobId)).toMatchObject({ state: "failed", error_code: code, attempt: 1 });
    expect(await reservationState(jobId)).toMatchObject({ state: "released" });
    expect(await bucketOf(ctx.userId)).toEqual({ used: 0, reserved: 0 });
    await noDrift();
  });

  it("retries a transient compile sandbox outage and a transient storage error, then succeeds", async () => {
    const a = await newJob();
    const sandbox = new SkeletonCompiler([new CompileError("sandbox_unavailable", true), "ok"]);
    expect(await drain(deps({ compiler: sandbox }))).toEqual(["requeued", "succeeded"]);
    expect(await bucketOf(a.ctx.userId)).toEqual({ used: 1, reserved: 0 });

    const b = await newJob();
    expect(await drain(deps({ store: failingStore(new StorageError(true), 1) }))).toEqual(["requeued", "succeeded"]);
    expect(await bucketOf(b.ctx.userId)).toEqual({ used: 1, reserved: 0 });
  });

  it("stops and releases when the job's total budget is exceeded", async () => {
    const { ctx, jobId } = await newJob();
    await admin.query(`UPDATE generation_job SET max_calls = 0 WHERE id = $1`, [jobId]);
    expect(await runOnce(deps(), "w")).toBe("failed");
    expect(await jobRow(jobId)).toMatchObject({ state: "failed", error_code: "budget_exceeded" });
    expect(await bucketOf(ctx.userId)).toEqual({ used: 0, reserved: 0 });
  });
});

describe("crashes, stale workers and cancellation", () => {
  it("recovers a crashed worker's job; the zombie cannot publish or consume", async () => {
    const { ctx, jobId } = await newJob();
    const zombie = (await worker.jobs.claimNext("worker-A", 30_000))!; // claims, then "crashes": no heartbeat, no result
    await admin.query(`UPDATE generation_job SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId]);

    expect(await worker.jobs.claimNext("worker-B", 30_000)).toBeNull(); // still running as far as claims go
    const report = await worker.jobs.sweep();
    expect(report.requeued).toBeGreaterThanOrEqual(1);
    expect(await jobRow(jobId)).toMatchObject({ state: "queued", lease_owner: null });
    expect(await reservationState(jobId)).toMatchObject({ state: "reserved" }); // allowance still held, not lost

    await wait(15);
    expect(await runOnce(deps(), "worker-B")).toBe("succeeded");
    expect(await jobRow(jobId)).toMatchObject({ state: "succeeded", attempt: 2 });

    // The zombie wakes up and tries everything it could.
    expect(await worker.jobs.heartbeat(jobId, zombie.fencingToken, 30_000)).toBe("lost");
    expect(await processJob(zombie, deps())).toBe("abandoned");
    await expect(worker.settlement.finishJob({ jobId, fencingToken: zombie.fencingToken, outcome: "failed", errorCode: "x" })).rejects.toBeInstanceOf(
      StaleOrCanceled,
    );
    expect(await bucketOf(ctx.userId)).toEqual({ used: 1, reserved: 0 });
    expect((await admin.query(`SELECT count(*)::int AS n FROM lesson_revision WHERE created_by_job_id = $1`, [jobId])).rows[0].n).toBe(1);
    await noDrift();
  });

  it("cancels a running job at the next checkpoint and discards any late result", async () => {
    const { ctx, jobId } = await newJob();
    const gate = new BlockingLlm();
    const running = runOnce(deps({ llm: gate }), "w");
    await gate.started;
    await web.generation.cancelJob(ctx, jobId); // flag only: the job is running
    gate.release();
    expect(await running).toBe("canceled");
    expect(await jobRow(jobId)).toMatchObject({ state: "canceled", error_code: "canceled" });
    expect(await reservationState(jobId)).toMatchObject({ state: "released" });
    expect(await bucketOf(ctx.userId)).toEqual({ used: 0, reserved: 0 });
    expect((await admin.query(`SELECT count(*)::int AS n FROM lesson_revision WHERE created_by_job_id = $1`, [jobId])).rows[0].n).toBe(0);
  });

  it("aborts an in-flight model call as soon as the heartbeat sees the cancellation", async () => {
    const { ctx, jobId } = await newJob();
    const gate = new BlockingLlm({ honourAbort: true });
    const running = runOnce(deps({ llm: gate, leaseMs: 300 }), "w"); // heartbeat every 100 ms
    await gate.started;
    await web.generation.cancelJob(ctx, jobId);
    expect(await running).toBe("canceled"); // never released the gate: the abort did it
    expect(await bucketOf(ctx.userId)).toEqual({ used: 0, reserved: 0 });
  });
});

describe("sweeper", () => {
  it("fails jobs past their deadline, out of attempts or abandoned with a cancel flag, releasing each reservation once", async () => {
    const queuedLate = await newJob();
    const lastAttempt = await newJob();
    const runningLate = await newJob();
    const canceledRunning = await newJob();
    await admin.query(`UPDATE generation_job SET deadline_at = now() - interval '1 second' WHERE id = $1`, [queuedLate.jobId]);
    for (const j of [lastAttempt, runningLate, canceledRunning]) {
      await admin.query(
        `UPDATE generation_job SET state = 'running', stage = 'compiling', lease_owner = 'dead', lease_expires_at = now() - interval '1 minute',
                fencing_token = 1, attempt = 1 WHERE id = $1`,
        [j.jobId],
      );
    }
    await admin.query(`UPDATE generation_job SET attempt = max_attempts WHERE id = $1`, [lastAttempt.jobId]);
    await admin.query(`UPDATE generation_job SET deadline_at = now() - interval '1 second' WHERE id = $1`, [runningLate.jobId]);
    await admin.query(`UPDATE generation_job SET cancel_requested_at = now() WHERE id = $1`, [canceledRunning.jobId]);

    // Two sweepers at once must not double-process anything.
    const [r1, r2] = await Promise.all([worker.jobs.sweep(), worker.jobs.sweep()]);
    expect(r1.failed + r2.failed).toBe(3);
    expect(r1.canceled + r2.canceled).toBe(1);

    expect(await jobRow(queuedLate.jobId)).toMatchObject({ state: "failed", error_code: "deadline_exceeded" });
    expect(await jobRow(lastAttempt.jobId)).toMatchObject({ state: "failed", error_code: "max_attempts_exceeded" });
    expect(await jobRow(runningLate.jobId)).toMatchObject({ state: "failed", error_code: "deadline_exceeded" });
    expect(await jobRow(canceledRunning.jobId)).toMatchObject({ state: "canceled" });
    for (const j of [queuedLate, lastAttempt, runningLate, canceledRunning]) {
      expect(await reservationState(j.jobId)).toMatchObject({ state: "released" });
      expect(await bucketOf(j.ctx.userId)).toEqual({ used: 0, reserved: 0 });
    }
    await noDrift();
  });

  it("leaves healthy work alone and reports counter drift instead of repairing it", async () => {
    const healthy = await newJob();
    await worker.jobs.claimNext("w", 30_000);
    // The sweeper reports drift across the whole database, where other test files corrupt counters on purpose:
    // look only at this account's bucket.
    const bucketId = (await admin.query(`SELECT id FROM usage_bucket WHERE owner_id = $1`, [healthy.ctx.userId])).rows[0].id as string;
    const quiet = await worker.jobs.sweep();
    expect(await jobRow(healthy.jobId)).toMatchObject({ state: "running" });
    expect(quiet.drift).not.toContain(bucketId);

    await admin.query(`UPDATE usage_bucket SET reserved = reserved + 1 WHERE owner_id = $1`, [healthy.ctx.userId]); // simulated bug
    try {
      const noisy = await worker.jobs.sweep();
      expect(noisy.drift).toContain(bucketId);
      expect(await bucketOf(healthy.ctx.userId)).toEqual({ used: 0, reserved: 2 }); // reported, not repaired
    } finally {
      await admin.query(`UPDATE usage_bucket SET reserved = reserved - 1 WHERE owner_id = $1`, [healthy.ctx.userId]);
    }
  });
});

describe("several workers at once", () => {
  it("drain a queue with every job completed exactly once", async () => {
    const jobs = await Promise.all(Array.from({ length: 9 }, () => newJob()));
    const d = deps();
    await Promise.all(["w1", "w2", "w3"].map((id) => drain(d, id)));
    for (const j of jobs) {
      expect(await jobRow(j.jobId)).toMatchObject({ state: "succeeded", attempt: 1 });
      expect(await bucketOf(j.ctx.userId)).toEqual({ used: 1, reserved: 0 });
    }
    await noDrift();
  });
});

// --- test doubles -----------------------------------------------------------------------------

/** An object store whose first `failures` writes fail with `error`. */
function failingStore(error: StorageError, failures: number): ObjectStore {
  let remaining = failures;
  return {
    put: async (p, data) => {
      if (remaining > 0) {
        remaining--;
        throw error;
      }
      return store.put(p, data);
    },
    stat: (p) => store.stat(p),
    deletePrefix: (p) => store.deletePrefix(p),
    list: (p, o) => store.list(p, o),
  };
}

/** A model call that stays in flight until released (or aborted, when honouring the signal). */
class BlockingLlm implements LlmProvider {
  readonly id = "blocking";
  private releaseCall!: () => void;
  private startedCall!: () => void;
  readonly started = new Promise<void>((resolve) => (this.startedCall = resolve));

  constructor(private readonly options: { honourAbort?: boolean } = {}) {}

  release() {
    this.releaseCall();
  }

  generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    this.startedCall();
    return new Promise<StructuredResult>((resolve, reject) => {
      this.releaseCall = () => resolve({ ok: true, value: { objectives: ["x"] }, resultSchemaVersion: 1, provider: "blocking", model: "m", usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 } });
      if (this.options.honourAbort) request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
    });
  }
}

export type { FakeStep };
