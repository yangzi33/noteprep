import { mkdtemp, readdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseManifest, type ManifestV3 } from "@/lib/domain/manifest";
import { SkeletonCompiler, SkeletonDocumentCompiler, type CompiledDocument, type DocumentCompiler } from "@/lib/latex/compiler";
import { FakeLlmProvider } from "@/lib/llm/fake";
import { FsObjectStore, sha256Of } from "@/lib/storage/store";
import { runOnce } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";
import { RecoveryRefused, recoverRevision, verifyRevisionArtifacts, type RecoverDeps } from "../../worker/recover";
import { createHarness, sleep, type Harness } from "./export-helpers";

let h: Harness;
let storeDir: string;
let store: FsObjectStore;
beforeAll(async () => {
  h = await createHarness();
  storeDir = await mkdtemp(path.join(os.tmpdir(), "noteprep-recover-"));
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

const IMAGE = "test-image";
const pipelineDeps = (): PipelineDeps => ({ jobs: h.worker.jobs, settlement: h.worker.settlement, llm: new FakeLlmProvider(), compiler: new SkeletonCompiler(), documentCompiler: new SkeletonDocumentCompiler(), store, leaseMs: 30_000, compilerImage: IMAGE });
const recoverDeps = (over: Partial<RecoverDeps> = {}): RecoverDeps => ({ recovery: h.worker.recovery, store, documentCompiler: new SkeletonDocumentCompiler(), compilerImage: IMAGE, ...over });

async function exported() {
  const ctx = await h.account();
  const d = await h.newDraft(ctx);
  const { jobId, exportId } = await h.confirm(ctx, d);
  for (let i = 0; i < 8 && (await h.jobRow(jobId)).state !== "succeeded"; i++) {
    if ((await runOnce(pipelineDeps(), "w-recover")) === null) await sleep(15);
  }
  expect((await h.jobRow(jobId)).state).toBe("succeeded");
  const exp = await h.exportRow(exportId);
  const rev = (await h.admin.query(`SELECT id, lesson_id FROM lesson_revision WHERE id = $1`, [exp.revision_id])).rows[0];
  const manifest = parseManifest((await h.admin.query(`SELECT artifact_manifest FROM lesson_revision WHERE id = $1`, [rev.id])).rows[0].artifact_manifest) as ManifestV3;
  return { ctx, revisionId: rev.id as string, lessonId: rev.lesson_id as string, manifest, jobId, exportId };
}

async function files(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await readdir(storeDir, { recursive: true, withFileTypes: true });
  for (const e of entries) if (e.isFile()) out[path.join(e.parentPath, e.name).slice(storeDir.length + 1)] = sha256Of(new Uint8Array(await readFile(path.join(e.parentPath, e.name))));
  return out;
}

/** Everything billing, job and settlement related for the owner, as plain rows. */
async function dbState(ownerId: string) {
  const q = async (sql: string) => (await h.admin.query(sql, [ownerId])).rows;
  return {
    buckets: await q(`SELECT * FROM usage_bucket WHERE owner_id = $1 ORDER BY id`),
    reservations: await q(`SELECT r.* FROM usage_reservation r JOIN usage_bucket b ON b.id = r.bucket_id WHERE b.owner_id = $1 ORDER BY r.id`),
    jobs: await q(`SELECT * FROM generation_job WHERE owner_id = $1 ORDER BY id`),
    exports: await q(`SELECT * FROM export WHERE owner_id = $1 ORDER BY id`),
    revisions: await q(`SELECT * FROM lesson_revision WHERE owner_id = $1 ORDER BY id`),
    snapshots: await q(`SELECT * FROM export_snapshot WHERE owner_id = $1 ORDER BY id`),
    lessons: await q(`SELECT * FROM lesson WHERE owner_id = $1 ORDER BY id`),
    bucketDrift: (await h.admin.query(`SELECT d.* FROM usage_bucket_drift d JOIN usage_bucket b ON b.id = d.bucket_id WHERE b.owner_id = $1`, [ownerId])).rows,
    exportDrift: (await h.admin.query(`SELECT d.* FROM export_state_drift d JOIN export e ON e.id = d.export_id WHERE e.owner_id = $1`, [ownerId])).rows,
  };
}

/** The manifest is write-once, so a test that needs a different stored manifest bypasses the guard trigger for one transaction (superuser test role). */
async function forceManifest(revisionId: string, manifest: unknown) {
  const client = await h.admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(`UPDATE lesson_revision SET artifact_manifest = $2::jsonb WHERE id = $1`, [revisionId, JSON.stringify(manifest)]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RecoveryRefused) return e.code;
    throw e;
  }
  return "NOT_REFUSED";
}

class DifferentCompiler implements DocumentCompiler {
  readonly id = "different";
  async compile(r: { documents: { id: CompiledDocument["id"]; tex: string }[] }): Promise<CompiledDocument[]> {
    return r.documents.map((d) => ({ id: d.id, pdf: new TextEncoder().encode(`other bytes ${d.tex.length}`), pages: 1 }));
  }
}

describe("verifyRevisionArtifacts", () => {
  it("reports ok, missing, size_mismatch and sha_mismatch per file", async () => {
    const x = await exported();
    expect((await verifyRevisionArtifacts(recoverDeps(), x.revisionId)).ok).toBe(true);
    const [a, b, c] = x.manifest.documents;
    await unlink(path.join(storeDir, a!.pdf.path));
    await writeFile(path.join(storeDir, b!.pdf.path), "short");
    const same = new Uint8Array(await readFile(path.join(storeDir, c!.tex.path)));
    const flipped = Buffer.from(same);
    flipped[0] = flipped[0]! ^ 1;
    await writeFile(path.join(storeDir, c!.tex.path), flipped);
    const report = await verifyRevisionArtifacts(recoverDeps(), x.revisionId);
    expect(report.ok).toBe(false);
    const status = (doc: string, format: string) => report.files.find((f) => f.document === doc && f.format === format)!.status;
    expect(status(a!.document, "pdf")).toBe("missing");
    expect(status(b!.document, "pdf")).toBe("size_mismatch");
    expect(status(c!.document, "tex")).toBe("sha_mismatch");
    expect(status(a!.document, "tex")).toBe("ok");
  });
});

describe("recoverRevision", () => {
  it("restores a deleted and a corrupted PDF (and a deleted source) to the identical sha, writing only the manifest's paths, with no database change", async () => {
    const x = await exported();
    const [a, b] = x.manifest.documents;
    const before = await files();
    await unlink(path.join(storeDir, a!.pdf.path));
    await writeFile(path.join(storeDir, b!.pdf.path), "corrupted");
    await unlink(path.join(storeDir, b!.tex.path));
    const stateBefore = await dbState(x.ctx.userId);

    const report = await recoverRevision(recoverDeps(), x.revisionId);
    expect(report.status).toBe("restored");
    expect(report.restored).toBe(3);
    expect(await files()).toEqual(before); // identical shas, no extra file
    expect((await verifyRevisionArtifacts(recoverDeps(), x.revisionId)).ok).toBe(true);
    expect(await dbState(x.ctx.userId)).toEqual(stateBefore);
  });

  it("does nothing when everything is intact", async () => {
    const x = await exported();
    const compiler = new SkeletonDocumentCompiler();
    const report = await recoverRevision(recoverDeps({ documentCompiler: compiler }), x.revisionId);
    expect(report.status).toBe("intact");
    expect(compiler.compiles).toBe(0);
  });

  it("--check reports what it would restore and writes nothing", async () => {
    const x = await exported();
    await unlink(path.join(storeDir, x.manifest.documents[0]!.pdf.path));
    const filesBefore = await files();
    const stateBefore = await dbState(x.ctx.userId);
    const report = await recoverRevision(recoverDeps(), x.revisionId, { check: true });
    expect(report.status).toBe("would_restore");
    expect(await files()).toEqual(filesBefore);
    expect(await dbState(x.ctx.userId)).toEqual(stateBefore);
  });

  it("refuses a recompile that is not byte-identical and writes nothing", async () => {
    const x = await exported();
    const gone = x.manifest.documents[0]!.pdf.path;
    await unlink(path.join(storeDir, gone));
    const filesBefore = await files();
    const stateBefore = await dbState(x.ctx.userId);
    expect(await refusal(recoverRevision(recoverDeps({ documentCompiler: new DifferentCompiler() }), x.revisionId))).toBe("recompile_not_identical");
    expect(await files()).toEqual(filesBefore);
    expect(await dbState(x.ctx.userId)).toEqual(stateBefore);
  });

  it("refuses when the running image differs from the manifest's", async () => {
    const x = await exported();
    await unlink(path.join(storeDir, x.manifest.documents[0]!.pdf.path));
    const filesBefore = await files();
    const compiler = new SkeletonDocumentCompiler();
    expect(await refusal(recoverRevision(recoverDeps({ compilerImage: "another-image", documentCompiler: compiler }), x.revisionId))).toBe("image_mismatch");
    expect(compiler.compiles).toBe(0);
    expect(await files()).toEqual(filesBefore);
  });

  it("refuses a lesson that was deleted (its export is retired) and writes nothing", async () => {
    const x = await exported();
    await unlink(path.join(storeDir, x.manifest.documents[0]!.pdf.path));
    await h.web.lessonDelete.deleteLesson(x.ctx, x.lessonId);
    expect((await h.exportRow(x.exportId)).state).toBe("retired");
    const filesBefore = await files();
    const stateBefore = await dbState(x.ctx.userId);
    expect(await refusal(recoverRevision(recoverDeps(), x.revisionId))).toBe("lesson_deleted");
    expect(await files()).toEqual(filesBefore);
    expect(await dbState(x.ctx.userId)).toEqual(stateBefore);
  });

  it("refuses a revision that is not an export revision (manifest v2)", async () => {
    const x = await exported();
    const v2 = { manifestVersion: 2, templateVersion: x.manifest.templateVersion, documents: x.manifest.documents };
    await forceManifest(x.revisionId, v2);
    await unlink(path.join(storeDir, x.manifest.documents[0]!.pdf.path));
    const filesBefore = await files();
    expect(await refusal(recoverRevision(recoverDeps(), x.revisionId))).toBe("not_export_revision");
    expect(await files()).toEqual(filesBefore);
  });

  it("refuses an unknown revision and a snapshot whose rendered source no longer matches the manifest", async () => {
    expect(await refusal(recoverRevision(recoverDeps(), "00000000-0000-4000-8000-000000000000"))).toBe("not_found");
    const x = await exported();
    const tampered = { ...x.manifest, documents: x.manifest.documents.map((d, i) => (i === 0 ? { ...d, tex: { ...d.tex, sha256: "d".repeat(64) } } : d)) };
    await forceManifest(x.revisionId, tampered);
    await unlink(path.join(storeDir, x.manifest.documents[0]!.pdf.path));
    expect(await refusal(recoverRevision(recoverDeps(), x.revisionId))).toBe("tex_mismatch");
  });
});
