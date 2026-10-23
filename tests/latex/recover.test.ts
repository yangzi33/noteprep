import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DEFAULT_LIMITS_FOR_TESTS } from "./limits";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { readDatasetDir } from "@/lib/curriculum/files";
import { parseManifest } from "@/lib/domain/manifest";
import { makeAuthedCtx } from "@/lib/server/auth/context";
import { createWebDal, createWorkerDal } from "@/lib/server/dal";
import { loadDataset } from "@/lib/server/curriculum/load";
import { createDb } from "@/lib/server/db";
import { DEFAULT_LIMITS, type Limits } from "@/lib/server/limits";
import { SkeletonCompiler } from "@/lib/latex/compiler";
import { FakeLlmProvider } from "@/lib/llm/fake";
import { FsObjectStore, sha256Of } from "@/lib/storage/store";
import { runOnce } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";
import { recoverRevision, verifyRevisionArtifacts } from "../../worker/recover";
import { pools } from "../integration/helpers";
import { compiler, IMAGE, leftoverContainers } from "./helpers";

// The real compilation image: a deleted and a corrupted stored PDF are rebuilt from the frozen snapshot to the identical sha.
const info = inject("testDb");
const { admin, worker: workerPg } = pools();
const ownerDb = createDb(info.adminUrl);
const appDb = createDb(info.appUrl);
const workerDb = createDb(info.workerUrl);
const SAMPLE: Dataset = readDatasetDir(path.join(__dirname, "../../data/curricula/sample-math/sample-1"));
const exportLimits: Limits = { ...DEFAULT_LIMITS, exportsPerUserPerHour: 10_000, exportConcurrencyPerUser: 20, exportMaxQueuedGlobal: 100_000, draftCreatesPerUserPerHour: 10_000, maxActiveDraftsPerUser: 1_000 };
const web = createWebDal(appDb, { limits: DEFAULT_LIMITS_FOR_TESTS, curriculum: { allowSample: true }, drafts: { limits: exportLimits }, exports: { enabled: true, limits: exportLimits } });
const worker = createWorkerDal(workerDb, { backoff: { baseMs: 1, capMs: 5 } });
let storeDir: string;
let store: FsObjectStore;

beforeAll(async () => {
  await loadDataset(ownerDb, SAMPLE, { allowSample: true });
  storeDir = await mkdtemp(path.join(os.tmpdir(), "noteprep-recover-real-"));
  store = new FsObjectStore(storeDir);
  await admin.query(`UPDATE generation_job SET state = 'canceled', stage = NULL, lease_owner = NULL, lease_expires_at = NULL, error_code = 'test_cleanup', finished_at = now() WHERE state IN ('queued', 'running')`);
});
afterAll(async () => {
  await Promise.all([admin.end(), workerPg.end(), ownerDb.$disconnect(), appDb.$disconnect(), workerDb.$disconnect()]);
  await rm(storeDir, { recursive: true, force: true });
});

const request = {
  requestVersion: 2,
  curriculum: { versionId: SAMPLE.meta.version.id, topicId: `${SAMPLE.meta.version.id}/level-a/course-1/equations/both-sides` },
  durationMinutes: 60,
  difficulty: "mixed",
  documents: ["notes", "worksheet", "solutions"],
  templateId: "classic",
  locale: "en",
};

describe("artifact recovery with the real compiler", () => {
  it("restores a deleted and a corrupted stored PDF to the identical sha", async () => {
    const deps: PipelineDeps = { jobs: worker.jobs, settlement: worker.settlement, llm: new FakeLlmProvider(), compiler: new SkeletonCompiler(), documentCompiler: compiler(), store, leaseMs: 120_000, compilerImage: IMAGE };
    const ctx = makeAuthedCtx(randomUUID());
    await web.account.ensureAccount(ctx);
    const { draft } = await web.drafts.createDraft(ctx, request, `key-${randomUUID()}`);
    const view = await web.drafts.getDraftView(ctx, draft.draftId, draft.versionId);
    const { jobId, exportId } = await web.exports.confirmExport(ctx, { draftId: draft.draftId, versionId: draft.versionId, expectedRev: view.rev, expectedContentHash: view.contentHash }, `key-${randomUUID()}`);
    for (let i = 0; i < 6 && (await admin.query(`SELECT state FROM generation_job WHERE id = $1`, [jobId])).rows[0].state !== "succeeded"; i++) {
      if ((await runOnce(deps, "w-recover-real")) === null) await new Promise((r) => setTimeout(r, 20));
    }
    const exp = (await admin.query(`SELECT revision_id FROM export WHERE id = $1`, [exportId])).rows[0];
    const manifest = parseManifest((await admin.query(`SELECT artifact_manifest FROM lesson_revision WHERE id = $1`, [exp.revision_id])).rows[0].artifact_manifest)!;
    const state = async () => JSON.stringify((await admin.query(`SELECT b.used, b.reserved, r.state FROM usage_bucket b JOIN usage_reservation r ON r.bucket_id = b.id WHERE b.owner_id = $1`, [ctx.userId])).rows);
    const before = await state();
    const containersBefore = new Set(await leftoverContainers());

    const [a, b] = manifest.documents;
    await unlink(path.join(storeDir, a!.pdf.path));
    await writeFile(path.join(storeDir, b!.pdf.path), "corrupted");
    expect((await verifyRevisionArtifacts({ recovery: worker.recovery, store }, exp.revision_id)).ok).toBe(false);

    const report = await recoverRevision({ recovery: worker.recovery, store, documentCompiler: compiler(), compilerImage: IMAGE }, exp.revision_id);
    expect(report.status).toBe("restored");
    for (const d of manifest.documents) {
      expect(sha256Of(new Uint8Array(await readFile(path.join(storeDir, d.pdf.path)))), d.document).toBe(d.pdf.sha256);
    }
    expect((await verifyRevisionArtifacts({ recovery: worker.recovery, store }, exp.revision_id)).ok).toBe(true);
    expect(await state()).toBe(before);
    expect((await leftoverContainers()).filter((n) => !containersBefore.has(n))).toEqual([]); // only containers created by this run
  });
});
