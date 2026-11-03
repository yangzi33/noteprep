import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from "vitest";
import { DEV_DEFAULT_LIMITS } from "@/lib/domain/generation";
import { makeAuthedCtx } from "@/lib/server/auth/context";
import { createDb } from "@/lib/server/db";
import { createWebDal, createWorkerDal } from "@/lib/server/dal";
import { DEFAULT_LIMITS } from "@/lib/server/limits";
import { SkeletonCompiler } from "@/lib/latex/compiler";
import { FAKE_PROVIDER_PRICES } from "@/lib/llm/estimate";
import { FakeLlmProvider, type FakeStep } from "@/lib/llm/fake";
import type { LlmProvider } from "@/lib/llm/types";
import { FsObjectStore } from "@/lib/storage/store";
import { runOnce, spendUpkeep } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";
import { pools } from "./helpers";
import { parkJobs, resetSpend } from "./spend-helpers";

const info = inject("testDb");
const { admin, worker: workerPg } = pools();
const appDb = createDb(info.appUrl);
const workerDb = createDb(info.workerUrl);
const web = createWebDal(appDb, { limits: { ...DEV_DEFAULT_LIMITS, maxActiveJobsPerUser: 100, maxQueuedJobsGlobal: 100_000, rateLimitPerHourPerUser: 1000 } });
const worker = createWorkerDal(workerDb, { backoff: { baseMs: 1, capMs: 5 }, limits: DEFAULT_LIMITS });

let storeDir: string;
let store: FsObjectStore;
beforeAll(async () => {
  storeDir = await mkdtemp(path.join(os.tmpdir(), "noteprep-metered-"));
  store = new FsObjectStore(storeDir);
});
beforeEach(async () => {
  await parkJobs(admin);
  await resetSpend(admin);
});
afterAll(async () => {
  await resetSpend(admin);
  await Promise.all([admin.end(), workerPg.end(), appDb.$disconnect(), workerDb.$disconnect()]);
  await rm(storeDir, { recursive: true, force: true });
});

const input = { topic: "linear_equations_one_variable", level: "Grade 7-8 equivalent", objectives: ["Solve ax + b = c"], durationMinutes: 60, difficulty: "mixed", questionCount: 5 };

async function newJob() {
  const ctx = makeAuthedCtx(randomUUID());
  await web.account.ensureAccount(ctx);
  const { job } = await web.generation.createGeneration(ctx, { ...input, notes: randomUUID() }, `key-${randomUUID()}`);
  return { ctx, jobId: job.id };
}

const deps = (llm: LlmProvider): PipelineDeps => ({
  jobs: worker.jobs,
  settlement: worker.settlement,
  llm,
  spend: { port: worker.spend, prices: FAKE_PROVIDER_PRICES, model: "fake-model", configId: "fake" },
  compiler: new SkeletonCompiler(),
  store,
  leaseMs: 30_000,
});

const calls = async (jobId: string) =>
  (await admin.query(`SELECT * FROM llm_call WHERE job_id = $1 ORDER BY job_attempt, call_seq`, [jobId])).rows as Record<string, unknown>[];
const jobRow = async (jobId: string) => (await admin.query(`SELECT * FROM generation_job WHERE id = $1`, [jobId])).rows[0];
const reservation = async (jobId: string) => (await admin.query(`SELECT state FROM usage_reservation WHERE job_id = $1`, [jobId])).rows[0]?.state as string;
const drift = async () => (await admin.query(`SELECT * FROM llm_spend_drift`)).rows;

describe("the pipeline with the spend ledger", () => {
  it("reserves and settles every provider call, keeping the job counters equal to the ledger (checks 7, C1, C5)", async () => {
    const { jobId } = await newJob();
    const llm = new FakeLlmProvider();
    expect(await runOnce(deps(llm), "w1")).toBe("succeeded");
    expect(llm.calls).toBe(1);
    const rows = await calls(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "settled", reason: "reported", purpose: "prose", is_retry: false, provider: "fake", model: "fake-model", usage_estimated: false, job_attempt: 1, call_seq: 1 });
    expect(Number(rows[0]!.cost_micros)).toBe(1_000);
    expect(Number(rows[0]!.estimate_micros)).toBeGreaterThan(0);
    expect(await jobRow(jobId)).toMatchObject({ state: "succeeded", calls_used: 1, tokens_used: "150", cost_micros: "1000" });
    expect(await reservation(jobId)).toBe("consumed");
    expect(await drift()).toEqual([]);
  });

  it("a retried attempt reserves its own call row and each call is charged once (C2, C3)", async () => {
    const { jobId } = await newJob();
    const llm = new FakeLlmProvider([{ error: "timeout" }, "ok"] satisfies FakeStep[]);
    const d = deps(llm);
    expect(await runOnce(d, "w1")).toBe("requeued");
    await new Promise((r) => setTimeout(r, 20));
    expect(await runOnce(d, "w1")).toBe("succeeded");
    const rows = await calls(jobId);
    expect(rows.map((r) => [r.job_attempt, r.call_seq, r.is_retry, r.state, r.error_type])).toEqual([
      [1, 1, false, "settled", "timeout"],
      [2, 1, true, "settled", null],
    ]);
    expect(await jobRow(jobId)).toMatchObject({ calls_used: 2, tokens_used: "300" });
    expect(await drift()).toEqual([]);
  });

  it("a cap that is full refuses before anything is sent: the job fails, nothing is charged, the allowance is released (L1)", async () => {
    const { ctx, jobId } = await newJob();
    await admin.query(`INSERT INTO llm_spend_month (month, reserved_micros, settled_micros) VALUES (date_trunc('month', (now() AT TIME ZONE 'UTC'))::date, 0, $1)`, [DEFAULT_LIMITS.llmSpendGlobalMonthlyMicros]);
    const llm = new FakeLlmProvider();
    expect(await runOnce(deps(llm), "w1")).toBe("failed");
    expect(llm.calls).toBe(0);
    expect(await calls(jobId)).toEqual([]);
    expect(await jobRow(jobId)).toMatchObject({ state: "failed", error_code: "llm_quota_exhausted", calls_used: 0 });
    expect(await reservation(jobId)).toBe("released");
    const status = await web.generation.getJob(ctx, jobId);
    expect(status).toMatchObject({ state: "failed" });
  });

  it("a provider that throws is charged at the estimate, never at zero (C6)", async () => {
    const { jobId } = await newJob();
    const boom: LlmProvider = { id: "fake", generateStructured: async () => { throw new Error("socket hang up"); } };
    await runOnce(deps(boom), "w1");
    const [row] = await calls(jobId);
    expect(row).toMatchObject({ state: "settled", reason: "estimated", usage_estimated: true, error_type: "exception" });
    expect(Number(row!.cost_micros)).toBe(Number(row!.estimate_micros));
    expect(Number(row!.cost_micros)).toBeGreaterThan(0);
    expect(await drift()).toEqual([]);
  });

  it("a worker that dies after reserving leaves a row that the sweep settles at the estimate (C6)", async () => {
    const { jobId } = await newJob();
    const claim = (await worker.jobs.claimNext("w-dead", 30_000))!;
    await worker.spend.reserve({
      jobId: claim.id, attempt: claim.attempt, fencingToken: claim.fencingToken, callSeq: 1, purpose: "prose", isRetry: false,
      provider: "fake", model: "fake-model", estimate: { micros: 7_000, inputTokens: 100, outputTokens: 50 },
    });
    const impatient = createWorkerDal(workerDb, { limits: { ...DEFAULT_LIMITS, llmStaleReservationSeconds: 0 } });
    await spendUpkeep({ spend: impatient.spend, aiActions: impatient.aiActions, batchSize: 50 });
    const [row] = await calls(jobId);
    expect(row).toMatchObject({ state: "settled", reason: "recovered", usage_estimated: true });
    expect(Number(row!.cost_micros)).toBe(7_000);
    expect(await drift()).toEqual([]);
  });
});
