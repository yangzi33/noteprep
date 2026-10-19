import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DEFAULT_LIMITS_FOR_TESTS } from "./limits";
import { verifyContextHash } from "@/lib/curriculum/context";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { readDatasetDir } from "@/lib/curriculum/files";
import { makeAuthedCtx } from "@/lib/server/auth/context";
import { createWebDal, createWorkerDal } from "@/lib/server/dal";
import { loadDataset } from "@/lib/server/curriculum/load";
import { createDb } from "@/lib/server/db";
import { SkeletonCompiler } from "@/lib/latex/compiler";
import { FakeLlmProvider } from "@/lib/llm/fake";
import { FsObjectStore, sha256Of } from "@/lib/storage/store";
import { runOnce } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";
import { pools } from "../integration/helpers";
import { compiler, leftoverContainers, pdfText } from "./helpers";

const info = inject("testDb");
const { admin, worker: workerPg } = pools();
const ownerDb = createDb(info.adminUrl);
const appDb = createDb(info.appUrl);
const workerDb = createDb(info.workerUrl);
const SAMPLE: Dataset = readDatasetDir(path.join(__dirname, "../../data/curricula/sample-math/sample-1"));
const web = createWebDal(appDb, { limits: DEFAULT_LIMITS_FOR_TESTS, curriculum: { allowSample: true } });
const worker = createWorkerDal(workerDb, { backoff: { baseMs: 1, capMs: 5 } });
let storeDir: string;
let deps: PipelineDeps;

beforeAll(async () => {
  await loadDataset(ownerDb, SAMPLE, { allowSample: true });
  storeDir = await mkdtemp(path.join(os.tmpdir(), "noteprep-chain-"));
  deps = { jobs: worker.jobs, settlement: worker.settlement, llm: new FakeLlmProvider(), compiler: new SkeletonCompiler(), documentCompiler: compiler(), store: new FsObjectStore(storeDir), leaseMs: 120_000, proseMode: "llm" };
  await admin.query(`UPDATE generation_job SET state = 'canceled', stage = NULL, lease_owner = NULL, lease_expires_at = NULL, error_code = 'test_cleanup', finished_at = now() WHERE state IN ('queued', 'running')`);
});
afterAll(async () => {
  await Promise.all([admin.end(), workerPg.end(), ownerDb.$disconnect(), appDb.$disconnect(), workerDb.$disconnect()]);
  await rm(storeDir, { recursive: true, force: true });
});

const request = (over: Record<string, unknown> = {}) => ({
  requestVersion: 2,
  curriculum: { versionId: SAMPLE.meta.version.id, topicId: `${SAMPLE.meta.version.id}/level-a/course-1/equations/both-sides` },
  durationMinutes: 60,
  difficulty: "mixed",
  documents: ["notes", "worksheet", "solutions"],
  templateId: "classic",
  locale: "en",
  ...over,
});

describe("a lesson from request to compiled PDFs, with everything real except the model", () => {
  it("generates, renders, compiles in the sandbox, stores, and settles exactly once", async () => {
    const ctx = makeAuthedCtx(randomUUID());
    await web.account.ensureAccount(ctx);
    const { job } = await web.generation.createGeneration(ctx, request(), `key-${randomUUID()}`);
    for (let i = 0; i < 12 && !["succeeded", "failed"].includes((await admin.query(`SELECT state FROM generation_job WHERE id = $1`, [job.id])).rows[0].state); i++) {
      if ((await runOnce(deps, "w-chain")) === null) await new Promise((r) => setTimeout(r, 20));
    }
    const row = (await admin.query(`SELECT state, error_code, calls_used FROM generation_job WHERE id = $1`, [job.id])).rows[0];
    expect(row).toMatchObject({ state: "succeeded", error_code: null, calls_used: 1 });

    const rev = (await admin.query(`SELECT r.* FROM lesson_revision r JOIN generation_job j ON j.lesson_id = r.lesson_id WHERE j.id = $1`, [job.id])).rows[0];
    expect(rev).toMatchObject({ schema_version: 2, validation_status: "verified", template_version: "classic/1", status: "finalized" });
    expect(verifyContextHash(rev.content.context)).toBe(true);
    const manifest = rev.artifact_manifest;
    expect(manifest.documents.map((d: { document: string }) => d.document)).toEqual(["notes", "worksheet", "solutions"]);

    const texts: Record<string, string> = {};
    for (const d of manifest.documents) {
      const pdf = new Uint8Array(await readFile(path.join(storeDir, d.pdf.path)));
      expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-"); // a real PDF, not the placeholder
      expect(Buffer.from(pdf).toString("latin1")).not.toContain("SKELETON");
      expect(sha256Of(pdf)).toBe(d.pdf.sha256);
      expect(pdf.byteLength).toBe(d.pdf.bytes);
      texts[d.document] = await pdfText(pdf);
      expect(texts[d.document]!.length).toBeGreaterThan(200);
    }
    expect(texts.worksheet).toContain("Student Practice Worksheet");
    // (the topic is named "Unknown on both sides", so only the step phrasing is checked, not the bare words)
    expect(texts.worksheet).not.toMatch(/Answer|Solutions|from both sides|to both sides|both sides by/i);
    expect(texts.solutions).toContain("Answer:");
    expect(texts.notes).toContain("Sample objective: solve one-unknown equations"); // dataset wording reached the compiled notes
    expect(texts.notes).toContain("not a real curriculum"); // and the sample data is labelled as such

    const bucket = (await admin.query(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [ctx.userId])).rows[0];
    expect(bucket).toEqual({ used: 1, reserved: 0 });
    expect((await workerPg.query(`SELECT d.* FROM usage_bucket_drift d JOIN usage_bucket b ON b.id = d.bucket_id WHERE b.owner_id = $1`, [ctx.userId])).rows).toEqual([]);
    expect(await leftoverContainers()).toEqual([]);
  });

  it("a document the sandbox cannot compile fails the job and returns the allowance (real container)", async () => {
    const broken = { ...deps.documentCompiler!, id: "broken", compile: (r: Parameters<NonNullable<PipelineDeps["documentCompiler"]>["compile"]>[0]) => compiler().compile({ ...r, documents: r.documents.map((d) => ({ ...d, tex: d.tex.replace("\\end{document}", "\\undefinedcommand\\end{document}") })) }) };
    const ctx = makeAuthedCtx(randomUUID());
    await web.account.ensureAccount(ctx);
    const { job } = await web.generation.createGeneration(ctx, request(), `key-${randomUUID()}`);
    const d: PipelineDeps = { ...deps, documentCompiler: broken };
    for (let i = 0; i < 8 && !["succeeded", "failed"].includes((await admin.query(`SELECT state FROM generation_job WHERE id = $1`, [job.id])).rows[0].state); i++) {
      if ((await runOnce(d, "w-chain-fail")) === null) await new Promise((r) => setTimeout(r, 20));
    }
    expect((await admin.query(`SELECT state, error_code FROM generation_job WHERE id = $1`, [job.id])).rows[0]).toMatchObject({ state: "failed", error_code: "compile_failed" });
    expect((await admin.query(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [ctx.userId])).rows[0]).toEqual({ used: 0, reserved: 0 });
    expect((await admin.query(`SELECT count(*)::int AS n FROM lesson_revision r JOIN generation_job j ON j.lesson_id = r.lesson_id WHERE j.id = $1`, [job.id])).rows[0].n).toBe(0);
    expect(await leftoverContainers()).toEqual([]);
  });
});
