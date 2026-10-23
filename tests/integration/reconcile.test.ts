import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseManifest } from "@/lib/domain/manifest";
import { SkeletonCompiler, SkeletonDocumentCompiler } from "@/lib/latex/compiler";
import { FakeLlmProvider } from "@/lib/llm/fake";
import { FsObjectStore, type ObjectStore } from "@/lib/storage/store";
import { runOnce } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";
import { reconcileLesson, type ReconcileReport } from "../../worker/reconcile";
import { createHarness, freshKey, request, sleep, type Harness } from "./export-helpers";

let h: Harness;
let storeDir: string;
let store: FsObjectStore;
beforeAll(async () => {
  h = await createHarness();
  storeDir = await mkdtemp(path.join(os.tmpdir(), "noteprep-reconcile-"));
  store = new FsObjectStore(storeDir);
});
beforeEach(async () => {
  await h.parkForeignJobs();
});
afterEach(async () => {
  await h.expectNoDrift();
  await h.abandonPending();
});
afterAll(async () => {
  await h.close();
  await rm(storeDir, { recursive: true, force: true });
});

const deps = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({
  jobs: h.worker.jobs,
  settlement: h.worker.settlement,
  llm: new FakeLlmProvider(),
  compiler: new SkeletonCompiler(),
  documentCompiler: new SkeletonDocumentCompiler(),
  store,
  leaseMs: 30_000,
  compilerImage: "test-image",
  ...over,
});

const fresh = (): ReconcileReport => ({ lessons: 0, revisionsDeleted: 0, attemptsDeleted: 0, skipped: 0, errors: 0 });
async function reconcile(lessonId: string, ownerId: string, s: ObjectStore = store) {
  const report = fresh();
  await reconcileLesson({ jobs: h.worker.jobs, store: s, graceMs: 0 }, { lessonId, ownerId }, report);
  return report;
}
const exists = async (p: string) => stat(path.join(storeDir, p)).then(() => true, () => false);
async function filesUnder(prefix: string): Promise<string[]> {
  const entries = await readdir(path.join(storeDir, prefix), { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name).slice(storeDir.length + 1)).sort();
}
const orphan = async (ownerId: string, lessonId: string, revisionId: string = randomUUID()) => {
  const prefix = `${ownerId}/${lessonId}/${revisionId}/${randomUUID()}`;
  await store.put(`${prefix}/notes.pdf`, new Uint8Array([9]));
  await store.put(`${prefix}/notes.tex`, new Uint8Array([9]));
  return prefix;
};

async function newExport() {
  const ctx = await h.account(3);
  const d = await h.newDraft(ctx);
  return { ctx, ...(await h.confirm(ctx, d)) };
}
const manifestFiles = async (revisionId: string) => {
  const rev = (await h.admin.query(`SELECT artifact_manifest FROM lesson_revision WHERE id = $1`, [revisionId])).rows[0];
  return parseManifest(rev.artifact_manifest)!.documents.flatMap((d) => [d.pdf.path, d.tex.path]).sort();
};

/** What a reconciler must never touch: every billing and job row of the owner. */
async function fingerprint(ownerId: string) {
  const q = async (sql: string) => (await h.admin.query(sql, [ownerId])).rows;
  return {
    bucket: await q(`SELECT * FROM usage_bucket WHERE owner_id = $1 ORDER BY id`),
    reservations: await q(`SELECT r.* FROM usage_reservation r JOIN generation_job j ON j.id = r.job_id WHERE j.owner_id = $1 ORDER BY r.id`),
    jobs: await q(`SELECT * FROM generation_job WHERE owner_id = $1 ORDER BY id`),
    exports: await q(`SELECT * FROM export WHERE owner_id = $1 ORDER BY id`),
    revisions: await q(`SELECT id, artifact_manifest FROM lesson_revision WHERE owner_id = $1 ORDER BY id`),
    bucketDrift: (await h.workerPg.query(`SELECT d.* FROM usage_bucket_drift d JOIN usage_bucket b ON b.id = d.bucket_id WHERE b.owner_id = $1`, [ownerId])).rows,
    exportDrift: (await h.workerPg.query(`SELECT d.* FROM export_state_drift d JOIN export e ON e.id = d.export_id WHERE e.owner_id = $1`, [ownerId])).rows,
  };
}

describe("worker_runtime can read what the reconciler reads", () => {
  it("SELECT on lesson and lesson_revision, through the worker role", async () => {
    const { ctx, lessonId } = await newExport();
    const state = await h.worker.jobs.readLessonForReconcile(lessonId, 0);
    expect(state).toMatchObject({ ownerId: ctx.userId, revisions: [] });
  });
});

describe("crash after upload, before commit", () => {
  it("the job is retried and succeeds once; the first attempt's prefix is deleted; the published files remain", async () => {
    const { ctx, jobId, lessonId } = await newExport();
    let puts = 0;
    const crashing: ObjectStore = {
      put: async (p, d) => {
        if (++puts === 4) throw new Error("simulated crash"); // not a StorageError: the attempt's own cleanup leaves the prefix
        return store.put(p, d);
      },
      stat: (p) => store.stat(p),
      list: (p, o) => store.list(p, o),
      deleteObject: (p) => store.deleteObject(p),
      deletePrefix: (p) => store.deletePrefix(p),
    };
    expect(await runOnce(deps({ store: crashing }), "w-crash")).toBe("requeued");
    const leftover = await filesUnder(`${ctx.userId}/${lessonId}`);
    expect(leftover.length).toBe(3);
    await sleep(15);
    expect(await runOnce(deps(), "w-retry")).toBe("succeeded");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });

    const revisionId = (await h.admin.query(`SELECT revision_id FROM generation_job WHERE id = $1`, [jobId])).rows[0].revision_id as string;
    const published = await manifestFiles(revisionId);
    expect(published.length).toBe(6);
    expect((await filesUnder(`${ctx.userId}/${lessonId}`)).length).toBe(9);

    const before = await fingerprint(ctx.userId);
    expect(await reconcile(lessonId, ctx.userId)).toMatchObject({ revisionsDeleted: 1, attemptsDeleted: 0, errors: 0 });
    expect(await filesUnder(`${ctx.userId}/${lessonId}`)).toEqual(published);
    expect(await fingerprint(ctx.userId)).toEqual(before);
    // a second pass finds nothing
    expect(await reconcile(lessonId, ctx.userId)).toMatchObject({ revisionsDeleted: 0, attemptsDeleted: 0 });
  });
});

describe("what the reconciler leaves alone", () => {
  it("a stale late upload (orphan revision and orphan attempt inside the published revision) is deleted; billing and drift views are unchanged", async () => {
    const { ctx, jobId, lessonId } = await newExport();
    expect(await runOnce(deps(), "w-ok")).toBe("succeeded");
    const revisionId = (await h.admin.query(`SELECT revision_id FROM generation_job WHERE id = $1`, [jobId])).rows[0].revision_id as string;
    const published = await manifestFiles(revisionId);
    const lateRevision = await orphan(ctx.userId, lessonId);
    const lateAttempt = await orphan(ctx.userId, lessonId, revisionId);
    const before = await fingerprint(ctx.userId);
    expect(await reconcile(lessonId, ctx.userId)).toMatchObject({ revisionsDeleted: 1, attemptsDeleted: 1, errors: 0 });
    expect(await exists(lateRevision)).toBe(false);
    expect(await exists(lateAttempt)).toBe(false);
    expect(await filesUnder(`${ctx.userId}/${lessonId}`)).toEqual(published);
    expect(await fingerprint(ctx.userId)).toEqual(before);
  });

  it("a lesson with a running job is untouched, and is not even a candidate", async () => {
    const { ctx, jobId, lessonId } = await newExport();
    await h.claim(jobId);
    const stray = await orphan(ctx.userId, lessonId);
    expect(await reconcile(lessonId, ctx.userId)).toMatchObject({ revisionsDeleted: 0, attemptsDeleted: 0, skipped: 1 });
    expect(await exists(stray)).toBe(true);
    const ids = (await h.worker.jobs.listReconcileCandidates(1000, 0)).map((c) => c.lessonId);
    expect(ids).not.toContain(lessonId);
  });

  it("a lesson with a queued job is untouched", async () => {
    const { ctx, lessonId } = await newExport();
    const stray = await orphan(ctx.userId, lessonId);
    expect(await reconcile(lessonId, ctx.userId)).toMatchObject({ revisionsDeleted: 0, skipped: 1 });
    expect(await exists(stray)).toBe(true);
  });

  it("a lesson inside the grace window is untouched", async () => {
    const { ctx, lessonId } = await newExport();
    await runOnce(deps(), "w-grace");
    const stray = await orphan(ctx.userId, lessonId);
    const report = fresh();
    await reconcileLesson({ jobs: h.worker.jobs, store, graceMs: 3_600_000 }, { lessonId, ownerId: ctx.userId }, report);
    expect(report).toMatchObject({ revisionsDeleted: 0, skipped: 1 });
    expect(await exists(stray)).toBe(true);
    expect((await h.worker.jobs.listReconcileCandidates(1000, 3_600_000)).map((c) => c.lessonId)).not.toContain(lessonId);
  });

  it("a deleted lesson's objects are out of scope", async () => {
    const { ctx, lessonId } = await newExport();
    await runOnce(deps(), "w-del");
    const stray = await orphan(ctx.userId, lessonId);
    await h.web.lessonDelete.deleteLesson(ctx, lessonId); // the real deletion path: retires the export and marks the lesson
    expect(await reconcile(lessonId, ctx.userId)).toMatchObject({ revisionsDeleted: 0, attemptsDeleted: 0 });
    expect(await exists(stray)).toBe(true);
    expect((await h.worker.jobs.listReconcileCandidates(1000, 0)).map((c) => c.lessonId)).not.toContain(lessonId);
  });

  it("a legacy v1 four-file pack stays; an orphan attempt next to it goes", async () => {
    const ctx = await h.account(3);
    const { job } = await h.web.generation.createGeneration(
      ctx,
      { topic: "linear_equations_one_variable", level: "Grade 7-8 equivalent", objectives: ["Solve ax + b = c"], durationMinutes: 60, difficulty: "mixed", questionCount: 5, notes: randomUUID() },
      freshKey(),
    );
    expect(await runOnce(deps(), "w-v1")).toBe("succeeded");
    const lessonId = (await h.admin.query(`SELECT lesson_id FROM generation_job WHERE id = $1`, [job.id])).rows[0].lesson_id as string;
    const rev = (await h.admin.query(`SELECT id, artifact_manifest FROM lesson_revision WHERE lesson_id = $1`, [lessonId])).rows[0];
    expect(Array.isArray(rev.artifact_manifest)).toBe(true);
    const published = await filesUnder(`${ctx.userId}/${lessonId}`);
    expect(published.length).toBe(4);
    const stray = await orphan(ctx.userId, lessonId, rev.id);
    const before = await fingerprint(ctx.userId);
    expect(await reconcile(lessonId, ctx.userId)).toMatchObject({ attemptsDeleted: 1, revisionsDeleted: 0, errors: 0 });
    expect(await exists(stray)).toBe(false);
    expect(await filesUnder(`${ctx.userId}/${lessonId}`)).toEqual(published);
    expect(await fingerprint(ctx.userId)).toEqual(before);
  });

  it("a v2 pack and a v3 export pack both stay", async () => {
    const ctx = await h.account(3);
    const { job } = await h.web.generation.createGeneration(ctx, request(), freshKey());
    expect(await runOnce(deps(), "w-v2")).toBe("succeeded");
    const lessonId = (await h.admin.query(`SELECT lesson_id FROM generation_job WHERE id = $1`, [job.id])).rows[0].lesson_id as string;
    const v2 = (await h.admin.query(`SELECT id, artifact_manifest FROM lesson_revision WHERE lesson_id = $1`, [lessonId])).rows[0];
    expect(v2.artifact_manifest.manifestVersion).toBe(2);
    const v2Files = await manifestFiles(v2.id);
    const v2Stray = await orphan(ctx.userId, lessonId, v2.id);
    const before2 = await fingerprint(ctx.userId);
    expect(await reconcile(lessonId, ctx.userId)).toMatchObject({ attemptsDeleted: 1, errors: 0 });
    expect(await exists(v2Stray)).toBe(false);
    expect(await filesUnder(`${ctx.userId}/${lessonId}`)).toEqual(v2Files);
    expect(await fingerprint(ctx.userId)).toEqual(before2);

    const exp = await newExport();
    expect(await runOnce(deps(), "w-v3")).toBe("succeeded");
    const v3Rev = (await h.admin.query(`SELECT revision_id FROM generation_job WHERE id = $1`, [exp.jobId])).rows[0].revision_id as string;
    expect((await h.admin.query(`SELECT artifact_manifest->>'manifestVersion' AS v FROM lesson_revision WHERE id = $1`, [v3Rev])).rows[0].v).toBe("3");
    const v3Files = await manifestFiles(v3Rev);
    const v3Stray = await orphan(exp.ctx.userId, exp.lessonId, v3Rev);
    expect(await reconcile(exp.lessonId, exp.ctx.userId)).toMatchObject({ attemptsDeleted: 1, errors: 0 });
    expect(await exists(v3Stray)).toBe(false);
    expect(await filesUnder(`${exp.ctx.userId}/${exp.lessonId}`)).toEqual(v3Files);
  });
});

describe("listReconcileCandidates", () => {
  it("is ordered by lesson id, pages with a keyset cursor and never repeats", async () => {
    const lessons: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { lessonId } = await newExport();
      await runOnce(deps(), `w-list-${i}`);
      lessons.push(lessonId);
    }
    const all: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page: { lessonId: string }[] = await h.worker.jobs.listReconcileCandidates(2, 0, after);
      if (page.length === 0) break;
      all.push(...page.map((p) => p.lessonId));
      after = page[page.length - 1]!.lessonId;
    }
    expect(all).toEqual([...all].sort());
    expect(new Set(all).size).toBe(all.length);
    for (const id of lessons) expect(all).toContain(id);
    await expect(h.worker.jobs.listReconcileCandidates(0, 0)).rejects.toThrow();
  });
});

describe("commit versus reconcile", () => {
  it("50 races: the reconciler never deletes a published file", async () => {
    for (let i = 0; i < 50; i++) {
      const ctx = await h.account(3);
      const d = await h.newDraft(ctx);
      const { jobId, lessonId } = await h.confirm(ctx, d);
      const token = await h.claim(jobId);
      const input = await h.commitInput(jobId, token);
      const files = input.manifest.documents.flatMap((doc) => [doc.pdf.path, doc.tex.path]);
      for (const f of files) await store.put(f, new Uint8Array([1, 2, 3]));
      const stray = await orphan(ctx.userId, lessonId);
      const commit = async () => {
        if (i % 3 === 1) await sleep(1);
        await h.worker.settlement.commitExport(input);
      };
      const recon = async () => {
        if (i % 3 === 2) await sleep(1);
        await reconcile(lessonId, ctx.userId);
      };
      await Promise.all([commit(), recon()]);
      for (const f of files) expect(await exists(f), `run ${i}: ${f}`).toBe(true);
      expect(await h.exportRow((await h.exportsOf(ctx.userId))[0].id)).toMatchObject({ state: "succeeded" });
      expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
      // once the job is done, the stray goes and the published files still stay
      await reconcile(lessonId, ctx.userId);
      expect(await exists(stray)).toBe(false);
      for (const f of files) expect(await exists(f), `run ${i} after: ${f}`).toBe(true);
    }
  }, 120_000);
});
