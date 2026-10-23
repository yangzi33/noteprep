import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DEFAULT_LIMITS_FOR_TESTS } from "./limits";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { readDatasetDir } from "@/lib/curriculum/files";
import { MAX_PDF_PAGES, parseManifest } from "@/lib/domain/manifest";
import { makeAuthedCtx } from "@/lib/server/auth/context";
import { createWebDal, createWorkerDal } from "@/lib/server/dal";
import { loadDataset } from "@/lib/server/curriculum/load";
import { createDb } from "@/lib/server/db";
import { DEFAULT_LIMITS, type Limits } from "@/lib/server/limits";
import { SkeletonCompiler } from "@/lib/latex/compiler";
import { FakeLlmProvider } from "@/lib/llm/fake";
import { PackageSchema } from "@/lib/package/schema";
import { FsObjectStore, sha256Of } from "@/lib/storage/store";
import { runOnce } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";
import { pools } from "../integration/helpers";
import { compiler, IMAGE, leftoverContainers, pdfText } from "./helpers";
import { provePdf } from "./pdf-proof";

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
let deps: PipelineDeps;

beforeAll(async () => {
  await loadDataset(ownerDb, SAMPLE, { allowSample: true });
  storeDir = await mkdtemp(path.join(os.tmpdir(), "noteprep-export-chain-"));
  deps = { jobs: worker.jobs, settlement: worker.settlement, llm: new FakeLlmProvider(), compiler: new SkeletonCompiler(), documentCompiler: compiler(), store: new FsObjectStore(storeDir), leaseMs: 120_000, compilerImage: IMAGE };
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

describe("a confirmed draft exported to real PDFs with the real compiler", () => {
  it("draft -> confirm -> worker -> three compiled PDFs, answers only in the solutions, one generation consumed", async () => {
    const ctx = makeAuthedCtx(randomUUID());
    await web.account.ensureAccount(ctx);
    const { draft } = await web.drafts.createDraft(ctx, request, `key-${randomUUID()}`);
    const view = await web.drafts.getDraftView(ctx, draft.draftId, draft.versionId);
    const { jobId, exportId } = await web.exports.confirmExport(ctx, { draftId: draft.draftId, versionId: draft.versionId, expectedRev: view.rev, expectedContentHash: view.contentHash }, `key-${randomUUID()}`);

    for (let i = 0; i < 6 && !["succeeded", "failed"].includes((await admin.query(`SELECT state FROM generation_job WHERE id = $1`, [jobId])).rows[0].state); i++) {
      if ((await runOnce(deps, "w-export-chain")) === null) await new Promise((r) => setTimeout(r, 20));
    }
    expect((await admin.query(`SELECT state, error_code FROM generation_job WHERE id = $1`, [jobId])).rows[0]).toEqual({ state: "succeeded", error_code: null });
    const exp = (await admin.query(`SELECT * FROM export WHERE id = $1`, [exportId])).rows[0];
    expect(exp).toMatchObject({ state: "succeeded" });
    const rev = (await admin.query(`SELECT * FROM lesson_revision WHERE id = $1`, [exp.revision_id])).rows[0];
    const manifest = parseManifest(rev.artifact_manifest)!;
    expect(manifest.documents.map((d) => d.document)).toEqual(["notes", "worksheet", "solutions"]);
    const pkg = PackageSchema.parse(rev.content);

    const texts: Record<string, string> = {};
    for (const d of manifest.documents) {
      const pdf = new Uint8Array(await readFile(path.join(storeDir, d.pdf.path)));
      expect(Buffer.from(pdf.subarray(0, 5)).toString()).toBe("%PDF-");
      expect(sha256Of(pdf)).toBe(d.pdf.sha256);
      expect(d.pdf.pages).toBeGreaterThanOrEqual(1);
      expect(d.pdf.pages).toBeLessThanOrEqual(MAX_PDF_PAGES);
      texts[d.document] = await pdfText(pdf);
      expect(texts[d.document]!.length).toBeGreaterThan(200);
    }
    // the worksheet shows the exercises and none of the answer key's wording; the solutions carry the answers
    const exercises = pkg.sections.find((s) => s.kind === "exercises")!;
    expect(texts.worksheet).toContain("Student Practice Worksheet");
    const questions = exercises.blocks.filter((b) => b.type === "question").length;
    expect(texts.worksheet!.match(/Solve for x:/g)?.length ?? 0).toBeGreaterThanOrEqual(questions); // every exercise prompt is on the worksheet
    expect(texts.worksheet).not.toContain("Answer:");
    expect(texts.solutions).toContain("Answer:");

    // The stored PDFs prove against the FROZEN SNAPSHOT (what the tutor confirmed), not only against the published revision.
    const snap = (await admin.query(`SELECT content, spec FROM export_snapshot WHERE id = $1`, [exp.snapshot_id])).rows[0];
    const frozen = PackageSchema.parse(snap.content);
    for (const d of manifest.documents) {
      const pdf = new Uint8Array(await readFile(path.join(storeDir, d.pdf.path)));
      const proof = await provePdf(pdf, frozen, d.document);
      expect(proof.failures, `${d.document}\n${proof.failures.join("\n")}`).toEqual([]);
      expect(proof.pages).toBe(d.pdf.pages);
    }
    // Recompiling the stored source reproduces the manifest's PDF hash.
    const stored = await Promise.all(manifest.documents.map(async (d) => ({ id: d.document, tex: await readFile(path.join(storeDir, d.tex.path), "utf8") })));
    const again = await compiler().compile({ documents: stored });
    for (const d of manifest.documents) {
      expect(sha256Of(again.find((r) => r.id === d.document)!.pdf), `${d.document} recompiled`).toBe(d.pdf.sha256);
    }

    expect((await admin.query(`SELECT used, reserved FROM usage_bucket WHERE owner_id = $1`, [ctx.userId])).rows[0]).toEqual({ used: 1, reserved: 0 });
    expect(await leftoverContainers()).toEqual([]);
  });
});
