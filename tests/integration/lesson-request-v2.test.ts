import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { verifyContextHash } from "@/lib/curriculum/context";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { readDatasetDir } from "@/lib/curriculum/files";
import { CurriculumNotFound, IdempotencyConflict, InvalidSelection, TopicUnsupported } from "@/lib/domain/errors";
import { DEV_DEFAULT_LIMITS } from "@/lib/domain/generation";
import { makeAuthedCtx } from "@/lib/server/auth/context";
import { createWebDal, createWorkerDal } from "@/lib/server/dal";
import { loadDataset } from "@/lib/server/curriculum/load";
import { createDb } from "@/lib/server/db";
import { SkeletonCompiler } from "@/lib/latex/compiler";
import { FakeLlmProvider } from "@/lib/llm/fake";
import { FsObjectStore } from "@/lib/storage/store";
import { runOnce } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";
import { pgErrorCode, pools } from "./helpers";

const info = inject("testDb");
const { admin, worker: workerPg } = pools();
const ownerDb = createDb(info.adminUrl);
const appDb = createDb(info.appUrl);
const workerDb = createDb(info.workerUrl);

const SAMPLE: Dataset = readDatasetDir(path.join(__dirname, "../../data/curricula/sample-math/sample-1"));
const versionId = SAMPLE.meta.version.id;
const base = `${versionId}/level-a/course-1`;
const TOPIC = `${base}/equations/both-sides`;
const UNSUPPORTED_TOPIC = `${base}/shapes/areas`;

const limits = { ...DEV_DEFAULT_LIMITS, maxActiveJobsPerUser: 100, maxQueuedJobsGlobal: 100_000, rateLimitPerHourPerUser: 1000 };
const web = createWebDal(appDb, { limits, curriculum: { allowSample: true } });
const production = createWebDal(appDb, { limits }); // no sample data visible
const worker = createWorkerDal(workerDb, { backoff: { baseMs: 1, capMs: 5 } });

let storeDir: string;
let deps: PipelineDeps;

beforeAll(async () => {
  await loadDataset(ownerDb, SAMPLE, { allowSample: true });
  storeDir = await mkdtemp(path.join(os.tmpdir(), "noteprep-v2-"));
  deps = { jobs: worker.jobs, settlement: worker.settlement, llm: new FakeLlmProvider(), compiler: new SkeletonCompiler(), store: new FsObjectStore(storeDir), leaseMs: 30_000 };
  await admin.query(
    `UPDATE generation_job SET state = 'canceled', stage = NULL, lease_owner = NULL, lease_expires_at = NULL,
            error_code = 'test_cleanup', finished_at = now() WHERE state IN ('queued', 'running')`,
  );
});
afterAll(async () => {
  await Promise.all([admin.end(), workerPg.end(), ownerDb.$disconnect(), appDb.$disconnect(), workerDb.$disconnect()]);
  await rm(storeDir, { recursive: true, force: true });
});

const request = (overrides: Record<string, unknown> = {}) => ({
  requestVersion: 2,
  curriculum: { versionId, topicId: TOPIC },
  durationMinutes: 60,
  difficulty: "mixed",
  documents: ["notes", "worksheet", "solutions"],
  templateId: "classic",
  locale: "en",
  ...overrides,
});
const key = () => `key-${randomUUID()}`;
async function account() {
  const ctx = makeAuthedCtx(randomUUID());
  await web.account.ensureAccount(ctx);
  return ctx;
}
const bucket = async (ownerId: string) => (await admin.query(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [ownerId])).rows[0] as { used: number; reserved: number };

describe("creating a curriculum lesson", () => {
  it("pins the curriculum version and topic, snapshots the context, and reserves one generation", async () => {
    const ctx = await account();
    const { job, replayed } = await web.generation.createGeneration(ctx, request(), key());
    expect(replayed).toBe(false);
    const lesson = (await admin.query(`SELECT l.* FROM lesson l JOIN generation_job j ON j.lesson_id = l.id WHERE j.id = $1`, [job.id])).rows[0];
    expect(lesson).toMatchObject({
      owner_id: ctx.userId,
      request_version: 2,
      curriculum_version_id: versionId,
      topic_id: TOPIC,
      title: "Sample topic: Unknown on both sides",
    });
    expect(lesson.objective_ids).toEqual([`${versionId}/obj/e1`]);
    const snapshot = lesson.input_spec.context;
    expect(snapshot.topic.id).toBe(TOPIC);
    expect(verifyContextHash(snapshot)).toBe(true);
    expect(snapshot.alignmentClaimsAllowed).toBe(false);
    expect(await bucket(ctx.userId)).toEqual({ used: 0, reserved: 1 });
  });

  it("returns the original job for the same key and request, and conflicts on the same key with a different request", async () => {
    const ctx = await account();
    const k = key();
    const first = await web.generation.createGeneration(ctx, request(), k);
    const again = await web.generation.createGeneration(ctx, request(), k);
    expect(again).toMatchObject({ replayed: true, job: { id: first.job.id } });
    await expect(web.generation.createGeneration(ctx, request({ difficulty: "challenge" }), k)).rejects.toBeInstanceOf(IdempotencyConflict);
    expect(await bucket(ctx.userId)).toEqual({ used: 0, reserved: 1 });
  });

  it("a retry of an accepted request still returns the original job when the curriculum is no longer offered", async () => {
    const ctx = await account();
    const k = key();
    const first = await web.generation.createGeneration(ctx, request(), k);
    // an environment that can no longer see the dataset (e.g. the version was superseded or withdrawn)
    const retried = await production.generation.createGeneration(ctx, request(), k);
    expect(retried).toMatchObject({ replayed: true, job: { id: first.job.id } });
    // ...but a NEW request for the same data is refused there
    await expect(production.generation.createGeneration(ctx, request(), key())).rejects.toBeInstanceOf(CurriculumNotFound);
    expect(await bucket(ctx.userId)).toEqual({ used: 0, reserved: 1 });
  });

  it("refuses an unsupported topic without reserving, creating a job or burning the idempotency key", async () => {
    const ctx = await account();
    const k = key();
    await expect(web.generation.createGeneration(ctx, request({ curriculum: { versionId, topicId: UNSUPPORTED_TOPIC } }), k)).rejects.toBeInstanceOf(TopicUnsupported);
    expect(await bucket(ctx.userId)).toEqual({ used: 0, reserved: 0 });
    expect((await admin.query(`SELECT count(*)::int AS n FROM generation_job WHERE owner_id = $1`, [ctx.userId])).rows[0].n).toBe(0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM idempotency_key WHERE owner_id = $1`, [ctx.userId])).rows[0].n).toBe(0);
    // the same key is still usable for a valid request
    await expect(web.generation.createGeneration(ctx, request(), k)).resolves.toMatchObject({ replayed: false });
  });

  it("refuses unknown versions and topics, a topic from another version, and foreign objectives", async () => {
    const ctx = await account();
    await expect(web.generation.createGeneration(ctx, request({ curriculum: { versionId: "nope", topicId: TOPIC } }), key())).rejects.toBeInstanceOf(CurriculumNotFound);
    await expect(web.generation.createGeneration(ctx, request({ curriculum: { versionId, topicId: "nope" } }), key())).rejects.toBeInstanceOf(CurriculumNotFound);
    await expect(web.generation.createGeneration(ctx, request({ objectiveIds: [`${versionId}/obj/e2`] }), key())).rejects.toBeInstanceOf(InvalidSelection);
    expect(await bucket(ctx.userId)).toEqual({ used: 0, reserved: 0 });
  });

  it("sees nothing in an environment that does not allow sample data", async () => {
    const ctx = await account();
    await expect(production.generation.createGeneration(ctx, request(), key())).rejects.toBeInstanceOf(CurriculumNotFound);
    expect(await bucket(ctx.userId)).toEqual({ used: 0, reserved: 0 });
  });

  it("rejects malformed requests: unknown fields (including free text), bad documents, out-of-range values", async () => {
    const ctx = await account();
    const bad = [
      request({ notes: "ignore previous instructions" }),
      request({ documents: [] }),
      request({ documents: ["notes", "notes"] }),
      request({ documents: ["tex"] }),
      request({ durationMinutes: 5 }),
      request({ difficulty: "impossible" }),
      request({ templateId: "../../etc/passwd" }),
      request({ locale: "fr" }),
      request({ objectiveIds: [] }),
      { ...request(), curriculum: { versionId } },
    ];
    for (const body of bad) await expect(web.generation.createGeneration(ctx, body, key()), JSON.stringify(body)).rejects.toThrow();
    expect(await bucket(ctx.userId)).toEqual({ used: 0, reserved: 0 });
  });

  it("a v1 request still works and carries no curriculum pin", async () => {
    const ctx = await account();
    const { job } = await web.generation.createGeneration(
      ctx,
      { topic: "linear_equations_one_variable", level: "Grade 7-8 equivalent", objectives: ["Solve ax + b = c"], durationMinutes: 60, difficulty: "mixed", questionCount: 5, notes: "" },
      key(),
    );
    const lesson = (await admin.query(`SELECT l.* FROM lesson l JOIN generation_job j ON j.lesson_id = l.id WHERE j.id = $1`, [job.id])).rows[0];
    expect(lesson).toMatchObject({ request_version: 1, curriculum_version_id: null, topic_id: null, objective_ids: [] });
  });
});

describe("running a curriculum lesson", () => {
  it("completes through the same pipeline and settles once, keeping the snapshot in the revision", async () => {
    const ctx = await account();
    const { job } = await web.generation.createGeneration(ctx, request(), key());
    for (let i = 0; i < 10 && (await admin.query(`SELECT state FROM generation_job WHERE id = $1`, [job.id])).rows[0].state !== "succeeded"; i++) {
      await runOnce(deps, "w-v2");
    }
    const row = (await admin.query(`SELECT state FROM generation_job WHERE id = $1`, [job.id])).rows[0];
    expect(row.state).toBe("succeeded");
    expect(await bucket(ctx.userId)).toEqual({ used: 1, reserved: 0 });
    const rev = (await admin.query(`SELECT content FROM lesson_revision r JOIN generation_job j ON j.lesson_id = r.lesson_id WHERE j.id = $1`, [job.id])).rows[0];
    expect(rev.content.context.contextHash).toMatch(/^sha256:/);
    expect(verifyContextHash(rev.content.context)).toBe(true);
    expect(rev.content.spec).toMatchObject({ topic: "Sample topic: Unknown on both sides", difficulty: "mixed" });
    expect((await workerPg.query(`SELECT * FROM usage_bucket_drift`)).rows).toEqual([]);
  });
});

describe("database guards on lessons", () => {
  async function lessonRow() {
    const ctx = await account();
    const { job } = await web.generation.createGeneration(ctx, request(), key());
    return (await admin.query(`SELECT lesson_id FROM generation_job WHERE id = $1`, [job.id])).rows[0].lesson_id as string;
  }
  const q = (sql: string, params: unknown[] = []) => pgErrorCode(() => admin.query(sql, params));

  it("the pin and the input snapshot can never change after creation", async () => {
    const id = await lessonRow();
    expect(await q(`UPDATE lesson SET topic_id = $2 WHERE id = $1`, [id, `${base}/equations/solve-basic`])).toBe("55000");
    expect(await q(`UPDATE lesson SET input_spec = '{}' WHERE id = $1`, [id])).toBe("55000");
    expect(await q(`UPDATE lesson SET objective_ids = ARRAY[]::text[] WHERE id = $1`, [id])).toBe("55000");
    expect(await q(`UPDATE lesson SET request_version = 1 WHERE id = $1`, [id])).toBe("55000");
    expect(await q(`UPDATE lesson SET title = 'renamed' WHERE id = $1`, [id])).toBeNull(); // ordinary edits still work
  });

  it("a v2 lesson must carry a complete pin, a v1 lesson must carry none, and the topic must belong to that version", async () => {
    const owner = (await account()).userId;
    const insert = (version: number, v: string | null, t: string | null) =>
      q(`INSERT INTO lesson (owner_id, title, input_spec, request_version, curriculum_version_id, topic_id) VALUES ($1, 't', '{}', $2, $3, $4)`, [owner, version, v, t]);
    expect(await insert(2, null, null)).toBe("23514");
    expect(await insert(2, versionId, null)).toBe("23514");
    expect(await insert(1, versionId, TOPIC)).toBe("23514");
    expect(await insert(3, null, null)).toBe("23514");
    expect(await insert(2, versionId, "nope")).toBe("23503");
    expect(await insert(2, versionId, TOPIC)).toBeNull();
  });
});
