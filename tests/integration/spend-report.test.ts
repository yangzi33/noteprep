import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { createAiActionDal } from "@/lib/server/dal/ai-action";
import { createLlmSpendDal } from "@/lib/server/dal/llm-spend";
import { createSpendReportDal } from "@/lib/server/dal/spend-report";
import { createDb } from "@/lib/server/db";
import { DEFAULT_LIMITS, type Limits } from "@/lib/server/limits";
import { pools, seedExportRows, seedOwner, seedTrialBucket } from "./helpers";
import { EST, parkJobs, resetSpend, seedAiJob } from "./spend-helpers";

// Spec 5.12 observability: counts, tokens, micro-units and codes only, never a content body; read with the worker role.
const info = inject("testDb");
const { admin, worker: workerPg } = pools();
const workerDb = createDb(info.workerUrl);
const LIMITS: Limits = { ...DEFAULT_LIMITS, llmItemsEnabled: 1 };
const spend = createLlmSpendDal(workerDb, LIMITS);
const actions = createAiActionDal(workerDb, LIMITS);
const report = createSpendReportDal(workerDb);

// Files run serially against one database: only what this file creates falls inside the window.
let startedAt = new Date();
const window = () => ({ since: startedAt, until: new Date(Date.now() + 3_600_000) });

beforeAll(async () => {
  startedAt = new Date(Date.now() - 50);
  await parkJobs(admin);
});
beforeEach(async () => {
  await resetSpend(admin);
});
afterAll(async () => {
  await resetSpend(admin);
  await Promise.all([admin.end(), workerPg.end(), workerDb.$disconnect()]);
});

async function action(ownerId: string, over: { kind?: string; draftId?: string | null; withJob?: boolean } = {}) {
  const job = over.withJob === false ? null : await seedAiJob(admin, ownerId);
  const { rows } = await admin.query(
    `INSERT INTO ai_action (owner_id, request_key, kind, draft_id, job_id, slot_hour)
     VALUES ($1, $2, $3, $4, $5, date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') RETURNING id`,
    [ownerId, `k-${randomUUID()}`, over.kind ?? "initial", over.draftId ?? null, job?.jobId ?? null],
  );
  return { id: rows[0].id as string, job };
}

async function call(job: { jobId: string; token: bigint; attempt: number }, seq: number, usage: { inputTokens: number; outputTokens: number; costMicros: number } | null, over: { isRetry?: boolean; errorType?: string; latencyMs?: number } = {}) {
  const r = await spend.reserve({ jobId: job.jobId, attempt: job.attempt, fencingToken: job.token, callSeq: seq, purpose: "prose", isRetry: over.isRetry ?? false, provider: "fake", model: "fake-model", configId: "cfg", promptVersion: "p1", estimate: EST });
  if (r.status !== "reserved") throw new Error(`not reserved: ${r.status}`);
  await spend.settle({ callId: r.callId, usage, usageEstimated: usage === null, latencyMs: over.latencyMs, errorType: over.errorType, reason: usage ? "reported" : "estimated" });
}

describe("spend report", () => {
  it("is empty and well formed with no activity", async () => {
    const r = await report.report(window());
    expect(r.totals).toMatchObject({ calls: 0, costMicros: 0 });
    expect(r.callsPerAction).toEqual({ actions: 0, calls: 0, average: 0, max: 0 });
    expect(r.latencyMs).toEqual({ p50: null, p95: null });
    expect(r.costPerSuccessfulExport).toEqual({ exports: 0, costMicros: 0, perExportMicros: null });
  });

  it("counts AI Actions per owner, draft, kind and outcome, and calls per action", async () => {
    const a = await seedOwner(admin);
    const b = await seedOwner(admin);
    const draft = randomUUID();
    const a1 = await action(a, { draftId: draft });
    const a2 = await action(a, { kind: "replace", draftId: draft });
    const b1 = await action(b, { kind: "easier" });
    await action(b, { withJob: false });
    await call(a1.job!, 1, { inputTokens: 100, outputTokens: 50, costMicros: 1_000 }, { latencyMs: 200 });
    await call(a1.job!, 2, { inputTokens: 100, outputTokens: 50, costMicros: 1_000 }, { isRetry: true, latencyMs: 400 });
    await call(a2.job!, 1, null, { errorType: "timeout" });
    expect(await actions.completeById(a1.id)).toBe(true);
    await admin.query(`UPDATE generation_job SET state = 'failed', stage = NULL, error_code = 'timeout', lease_owner = NULL, lease_expires_at = NULL, finished_at = now() WHERE id = $1`, [b1.job!.jobId]);
    await actions.finalizeTerminal(50);

    const r = await report.report(window());
    expect(r.actionsByOwner.find((o) => o.ownerId === a)).toMatchObject({ total: 2, completed: 1, accepted: 1 });
    expect(r.actionsByOwner.find((o) => o.ownerId === b)).toMatchObject({ total: 2, released: 1, accepted: 1 });
    expect(r.actionsByDraft).toEqual([{ draftId: draft, total: 2 }]);
    expect(r.outcomes).toEqual(expect.arrayContaining([{ kind: "initial", state: "completed", failureCode: null, count: 1 }, { kind: "easier", state: "released", failureCode: "timeout", count: 1 }]));
    expect(r.callsPerAction).toEqual({ actions: 2, calls: 3, average: 1.5, max: 2 });
    expect(r.totals).toMatchObject({ calls: 3, inputTokens: 200 + 1000, outputTokens: 100 + 500, estimatedCalls: 1, retryCalls: 1, releasedCalls: 0 });
    expect(r.totals.costMicros).toBe(2_000 + EST.micros);
    expect(r.latencyMs).toEqual({ p50: 200, p95: 400 });
    expect(r.byConfig).toEqual(expect.arrayContaining([{ provider: "fake", model: "fake-model", configId: "cfg", promptVersion: "p1", errorType: "timeout", calls: 1, costMicros: EST.micros }]));
  });

  it("holds no content: only identifiers, numbers and codes", async () => {
    const a = await seedOwner(admin);
    const x = await action(a, { draftId: randomUUID() });
    await call(x.job!, 1, { inputTokens: 1, outputTokens: 1, costMicros: 1 });
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
    };
    walk(await report.report(window()));
    expect([...keys].sort()).toEqual(
      [
        "accepted", "actions", "actionsByDraft", "actionsByOwner", "average", "byConfig", "calls", "callsPerAction", "completed", "configId", "costMicros", "costPerSuccessfulExport",
        "count", "draftId", "errorType", "estimatedCalls", "exports", "failed", "failureCode", "inputTokens", "kind", "latencyMs", "max", "model", "outcomes", "outputTokens", "ownerId",
        "p50", "p95", "perExportMicros", "promptVersion", "provider", "released", "releasedCalls", "retryCalls", "since", "state", "total", "totals", "until", "window",
      ].sort(),
    );
  });

  it("derives cost per successful export from the AI Actions of exported drafts", async () => {
    const a = await seedOwner(admin);
    const bucket = await seedTrialBucket(admin, a);
    const rows = await seedExportRows(admin, a, bucket);
    const { rows: snap } = await admin.query(`SELECT draft_id FROM export_snapshot WHERE id = $1`, [rows.snapshotId]);
    const x = await action(a, { draftId: snap[0].draft_id });
    await call(x.job!, 1, { inputTokens: 10, outputTokens: 10, costMicros: 4_000 });
    const client = await admin.connect();
    try {
      await client.query(`SET session_replication_role = replica`);
      await client.query(`UPDATE export SET state = 'succeeded', revision_id = gen_random_uuid(), settled_at = now() WHERE id = $1`, [rows.exportId]);
      await client.query(`UPDATE generation_job SET state = 'failed', error_code = 'test_cleanup', stage = NULL, lease_owner = NULL, lease_expires_at = NULL, finished_at = now() WHERE id = $1`, [rows.jobId]);
    } finally {
      await client.query(`SET session_replication_role = DEFAULT`);
      client.release();
    }
    const r = await report.report(window());
    expect(r.costPerSuccessfulExport).toEqual({ exports: 1, costMicros: 4_000, perExportMicros: 4_000 });
  });
});
