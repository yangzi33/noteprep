import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, inject } from "vitest";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { readDatasetDir } from "@/lib/curriculum/files";
import { domainErrorCode } from "@/lib/domain/errors";
import type { ExportSpec, TexShas } from "@/lib/domain/export-spec";
import { DEV_DEFAULT_LIMITS, type GenerationLimits } from "@/lib/domain/generation";
import { artifactPathV2, MANIFEST_V2, type ManifestV2 } from "@/lib/domain/manifest";
import { makeAuthedCtx, type AuthedCtx } from "@/lib/server/auth/context";
import { createWebDal, createWorkerDal } from "@/lib/server/dal";
import type { CommitExportInput } from "@/lib/server/dal";
import { loadDataset } from "@/lib/server/curriculum/load";
import { createDb } from "@/lib/server/db";
import { DEFAULT_LIMITS, type Limits } from "@/lib/server/limits";
import { pools } from "./helpers";

// Shared by the export-*.test.ts suites. Everything here talks to the real database.

const SAMPLE: Dataset = readDatasetDir(path.join(__dirname, "../../data/curricula/sample-math/sample-1"));
export const versionId = SAMPLE.meta.version.id;
export const TOPIC = `${versionId}/level-a/course-1/equations/both-sides`;

export const OPEN_GEN: GenerationLimits = { ...DEV_DEFAULT_LIMITS, maxActiveJobsPerUser: 100, maxQueuedJobsGlobal: 100_000, rateLimitPerHourPerUser: 1000, rateLimitPerHourPerIp: 1000 };
/** Generous export limits so a test that exercises one rule is not tripped by another. */
export const OPEN_LIMITS: Limits = { ...DEFAULT_LIMITS, exportsPerUserPerHour: 10_000, exportConcurrencyPerUser: 20, exportMaxQueuedGlobal: 100_000, draftCreatesPerUserPerHour: 10_000, maxActiveDraftsPerUser: 1_000 };

export const request = (overrides: Record<string, unknown> = {}) => ({
  requestVersion: 2,
  curriculum: { versionId, topicId: TOPIC },
  durationMinutes: 60,
  difficulty: "mixed",
  documents: ["notes", "worksheet", "solutions"],
  templateId: "classic",
  locale: "en",
  ...overrides,
});

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const freshKey = () => `key-${randomUUID()}`;
export async function code(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (e) {
    return domainErrorCode(e) ?? `NON_DOMAIN:${String((e as Error)?.message ?? e)}`;
  }
}

export interface DraftRef {
  draftId: string;
  versionId: string;
  rev: number;
  contentHash: string;
}

export interface HarnessOptions {
  limits?: Partial<Limits>;
  gen?: Partial<GenerationLimits>;
  clock?: () => Date;
  /** A fixed draft seed makes two drafts of one request byte-identical (same rendered source, different draft and version ids). */
  fixedSeed?: string;
  enabled?: boolean;
}

export async function createHarness(options: HarnessOptions = {}) {
  const info = inject("testDb");
  const { admin, app, worker: workerPg } = pools();
  const ownerDb = createDb(info.adminUrl);
  const appDb = createDb(info.appUrl);
  const workerDb = createDb(info.workerUrl);
  await loadDataset(ownerDb, SAMPLE, { allowSample: true });

  const limits: Limits = { ...OPEN_LIMITS, ...options.limits };
  const gen: GenerationLimits = { ...OPEN_GEN, ...options.gen };
  const web = createWebDal(appDb, {
    limits: gen,
    ...(options.clock ? { clock: options.clock } : {}),
    curriculum: { allowSample: true },
    drafts: { limits, ...(options.fixedSeed ? { newSeed: () => options.fixedSeed! } : {}) },
    exports: { enabled: options.enabled ?? true, limits },
  });
  const worker = createWorkerDal(workerDb, { backoff: { baseMs: 1, capMs: 5 }, exportDeadlineGraceSeconds: 0 });

  const owned = new Set<string>();

  async function account(trialLimit = 3): Promise<AuthedCtx> {
    const ctx = makeAuthedCtx(randomUUID());
    owned.add(ctx.userId);
    await web.account.ensureAccount(ctx);
    if (trialLimit !== 3) await admin.query(`UPDATE usage_bucket SET limit_count = $2 WHERE owner_id = $1`, [ctx.userId, trialLimit]);
    return ctx;
  }

  async function newDraft(ctx: AuthedCtx, overrides: Record<string, unknown> = {}, dal = web): Promise<DraftRef> {
    const { draft } = await dal.drafts.createDraft(ctx, request(overrides), freshKey());
    return viewRef(ctx, draft.draftId, draft.versionId, dal);
  }

  async function viewRef(ctx: AuthedCtx, draftId: string, vid: string, dal = web): Promise<DraftRef> {
    const view = await dal.drafts.getDraftView(ctx, draftId, vid);
    return { draftId, versionId: vid, rev: view.rev, contentHash: view.contentHash };
  }

  const confirm = (ctx: AuthedCtx, d: DraftRef, key = freshKey(), dal = web) =>
    dal.exports.confirmExport(ctx, { draftId: d.draftId, versionId: d.versionId, expectedRev: d.rev, expectedContentHash: d.contentHash }, key);

  /** What a claim does, for ONE specific job (the database is shared, so claimNext could pick someone else's). */
  async function claim(jobId: string): Promise<bigint> {
    const { rows } = await admin.query(
      `UPDATE generation_job SET state = 'running', stage = 'compiling', lease_owner = 'test-worker',
              lease_expires_at = now() + interval '5 minutes', fencing_token = fencing_token + 1, attempt = attempt + 1, started_at = COALESCE(started_at, now())
        WHERE id = $1 AND state = 'queued' RETURNING fencing_token`,
      [jobId],
    );
    if (!rows[0]) throw new Error("job is not queued");
    return BigInt(rows[0].fencing_token);
  }

  /** The worker's side of a successful export, without the compiler: a valid v2 manifest whose source hashes come from the snapshot. */
  async function manifestFor(jobId: string, token: bigint, patch: { revisionId?: string; attemptId?: string; texOverride?: Record<string, string> } = {}) {
    const input = await worker.jobs.getExportInput(jobId, token);
    const spec = input.spec as ExportSpec;
    const shas = input.texSha256 as TexShas;
    const revisionId = patch.revisionId ?? randomUUID();
    const attemptId = patch.attemptId ?? randomUUID();
    const scope = { ownerId: input.ownerId, lessonId: input.lessonId, revisionId, attemptId };
    const manifest: ManifestV2 = {
      manifestVersion: MANIFEST_V2,
      templateVersion: spec.templateVersion,
      documents: spec.documents.map((document) => ({
        document,
        pdf: { path: artifactPathV2(scope, document, "pdf"), sha256: "c".repeat(64), bytes: 4096, pages: 2 },
        tex: { path: artifactPathV2(scope, document, "tex"), sha256: patch.texOverride?.[document] ?? shas[document]!, bytes: 2048 },
      })),
    };
    return { input, spec, revisionId, attemptId, manifest };
  }

  async function commitInput(jobId: string, token: bigint, patch: Parameters<typeof manifestFor>[2] = {}): Promise<CommitExportInput> {
    const m = await manifestFor(jobId, token, patch);
    return { jobId, fencingToken: token, attemptId: m.attemptId, revisionId: m.revisionId, manifest: m.manifest, compiler: { image: "test" } };
  }

  /** Claim then commit: one complete, successful export. */
  async function complete(jobId: string) {
    const token = await claim(jobId);
    const input = await commitInput(jobId, token);
    await worker.settlement.commitExport(input);
    return { token, input };
  }

  async function fail(jobId: string, errorCode = "compile_failed") {
    const token = await claim(jobId);
    await worker.settlement.finishJob({ jobId, fencingToken: token, outcome: "failed", errorCode });
    return token;
  }

  const bucket = async (ownerId: string) =>
    (await admin.query(`SELECT id, used, reserved, limit_count FROM usage_bucket WHERE owner_id = $1 AND kind = 'trial'`, [ownerId])).rows[0] as { id: string; used: number; reserved: number; limit_count: number };
  const exportRow = async (id: string) => (await admin.query(`SELECT * FROM export WHERE id = $1`, [id])).rows[0];
  const jobRow = async (id: string) => (await admin.query(`SELECT * FROM generation_job WHERE id = $1`, [id])).rows[0];
  const reservationRow = async (jobId: string) => (await admin.query(`SELECT * FROM usage_reservation WHERE job_id = $1`, [jobId])).rows[0];
  const count = async (sql: string, params: unknown[] = []) => Number((await admin.query(sql, params)).rows[0].n);
  const exportsOf = async (ownerId: string) => (await admin.query(`SELECT * FROM export WHERE owner_id = $1 ORDER BY created_at`, [ownerId])).rows;

  /** Both drift views, for the accounts this suite created (the database is shared and other files corrupt counters on purpose). */
  async function expectNoDrift() {
    const buckets = await workerPg.query(`SELECT d.* FROM usage_bucket_drift d JOIN usage_bucket b ON b.id = d.bucket_id WHERE b.owner_id = ANY($1::uuid[])`, [[...owned]]);
    expect(buckets.rows).toEqual([]);
    const exports = await workerPg.query(`SELECT d.* FROM export_state_drift d JOIN export e ON e.id = d.export_id WHERE e.owner_id = ANY($1::uuid[])`, [[...owned]]);
    expect(exports.rows).toEqual([]);
  }

  /**
   * Settles every still-pending export of this suite's accounts consistently (export failed, job failed, reservation released,
   * counter returned) so no queued or running export job leaks into other files; they share one database.
   */
  async function abandonPending() {
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE export SET state = 'failed', failure_code = 'test_cleanup', settled_at = now() WHERE state = 'pending' AND owner_id = ANY($1::uuid[])`, [[...owned]]);
      await client.query(
        `WITH released AS (
           UPDATE usage_reservation r SET state = 'released', settle_reason = 'test_cleanup', settled_at = now()
             FROM export e WHERE e.job_id = r.job_id AND e.failure_code = 'test_cleanup' AND r.state = 'reserved' AND e.owner_id = ANY($1::uuid[])
           RETURNING r.bucket_id)
         UPDATE usage_bucket b SET reserved = b.reserved - x.n FROM (SELECT bucket_id, count(*)::int AS n FROM released GROUP BY bucket_id) x WHERE x.bucket_id = b.id`,
        [[...owned]],
      );
      await client.query(
        `UPDATE generation_job j SET state = 'failed', stage = NULL, error_code = 'test_cleanup', lease_owner = NULL, lease_expires_at = NULL, finished_at = now()
           FROM export e WHERE e.job_id = j.id AND e.failure_code = 'test_cleanup' AND j.state IN ('queued', 'running') AND e.owner_id = ANY($1::uuid[])`,
        [[...owned]],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Parks leftovers of other files so claimNext and runOnce only see this suite's jobs (legacy jobs only; exports are cleaned by their suites). */
  async function parkForeignJobs() {
    await admin.query(
      `UPDATE generation_job SET state = 'canceled', stage = NULL, lease_owner = NULL, lease_expires_at = NULL,
              error_code = 'test_cleanup', finished_at = now() WHERE state IN ('queued', 'running') AND kind <> 'export'`,
    );
  }

  /** Deadlocks the server has detected in this database (statistics are flushed about once a second, hence the wait). */
  async function deadlocks() {
    await sleep(1300);
    await admin.query(`SELECT pg_stat_clear_snapshot()`);
    return Number((await admin.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).rows[0].deadlocks);
  }

  async function close() {
    await abandonPending();
    await Promise.all([admin.end(), app.end(), workerPg.end(), ownerDb.$disconnect(), appDb.$disconnect(), workerDb.$disconnect()]);
  }

  return {
    admin, workerPg, appDb, workerDb, web, worker, owned, limits,
    account, newDraft, viewRef, confirm, claim, manifestFor, commitInput, complete, fail,
    bucket, exportRow, jobRow, reservationRow, count, exportsOf, expectNoDrift, abandonPending, parkForeignJobs, deadlocks, close,
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;
