import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseManifest, type ManifestV3 } from "@/lib/domain/manifest";
import { SkeletonCompiler, SkeletonDocumentCompiler, type CompiledDocument, type DocumentCompiler } from "@/lib/latex/compiler";
import { FakeLlmProvider } from "@/lib/llm/fake";
import { FsObjectStore, sha256Of, type ObjectStore, type StoredObjectInfo } from "@/lib/storage/store";
import type { RecoveryDal, RecoveryRevision } from "@/lib/server/dal/recovery";
import { runOnce } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";
import { RecoveryRefused, recoverRevision, verifyRevisionArtifacts, type RecoverDeps } from "../../worker/recover";
import { createHarness, request, freshKey, sleep, type Harness } from "./export-helpers";

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

/** Wraps the real read; `before(n, row)` may await side effects (n is 1-based) and return a modified row. */
function hookedRecovery(before: (n: number, row: RecoveryRevision | null) => Promise<RecoveryRevision | null | void> | RecoveryRevision | null | void): Pick<RecoveryDal, "readRevisionForRecovery"> {
  let n = 0;
  return {
    async readRevisionForRecovery(id: string) {
      const row = await h.worker.recovery.readRevisionForRecovery(id);
      const out = await before(++n, row);
      return out === undefined ? row : out;
    },
  };
}

/** Records every call; `onPut` runs after the real put; `mangle` changes the bytes actually stored. */
class SpyStore implements ObjectStore {
  puts: string[] = [];
  deletes: string[] = []; // deleteObject calls
  prefixDeletes: string[] = [];
  /** Paths whose next stat after a put reports the bytes that were INTENDED (a store that lies once). */
  lieOnce = new Map<string, StoredObjectInfo>();
  constructor(
    private readonly inner: ObjectStore,
    private readonly opts: { mangle?: boolean; lie?: boolean; onPut?: (p: string) => Promise<void> } = {},
  ) {}
  async put(p: string, data: Uint8Array) {
    this.puts.push(p);
    if (this.opts.lie) this.lieOnce.set(p, { bytes: data.byteLength, sha256: sha256Of(data) });
    const stored = this.opts.mangle ? Uint8Array.from(data, (b, i) => (i === 0 ? b ^ 1 : b)) : data;
    await this.inner.put(p, stored);
    await this.opts.onPut?.(p);
  }
  async stat(p: string) {
    const lie = this.lieOnce.get(p);
    if (lie) {
      this.lieOnce.delete(p);
      return lie;
    }
    return this.inner.stat(p);
  }
  async deleteObject(p: string, o?: { signal?: AbortSignal }) {
    this.deletes.push(p);
    await this.inner.deleteObject(p, o);
  }
  async deletePrefix(prefix: string, o?: { signal?: AbortSignal }) {
    this.prefixDeletes.push(prefix);
    await this.inner.deletePrefix(prefix, o);
  }
  list(prefix: string, o: Parameters<ObjectStore["list"]>[1]) {
    return this.inner.list(prefix, o);
  }
}

/** Same length, same page count, one bit different. */
class BitFlipCompiler implements DocumentCompiler {
  readonly id = "bitflip";
  compiles = 0;
  async compile(r: Parameters<DocumentCompiler["compile"]>[0]): Promise<CompiledDocument[]> {
    this.compiles++;
    const real = await new SkeletonDocumentCompiler().compile(r);
    return real.map((d) => ({ ...d, pdf: Uint8Array.from(d.pdf, (b, i) => (i === d.pdf.length - 1 ? b ^ 1 : b)) }));
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
    const compiler = new SkeletonDocumentCompiler();
    const spy = new SpyStore(store);
    const report = await recoverRevision(recoverDeps({ documentCompiler: compiler, store: spy }), x.revisionId, { check: true });
    expect(report.status).toBe("would_restore");
    expect(compiler.compiles).toBeGreaterThan(0); // --check really recompiles
    expect(spy.puts).toEqual([]);
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

  it("refuses a revision that is not an export revision (a real manifest v2 from the generate pipeline)", async () => {
    const ctx = await h.account();
    const { job } = await h.web.generation.createGeneration(ctx, request(), freshKey());
    for (let i = 0; i < 10 && (await h.jobRow(job.id)).state !== "succeeded"; i++) {
      if ((await runOnce(pipelineDeps(), "w-recover-v2")) === null) await sleep(15);
    }
    expect((await h.jobRow(job.id)).state).toBe("succeeded");
    const rev = (await h.admin.query(`SELECT r2.id, r2.artifact_manifest FROM lesson_revision r2 JOIN generation_job j ON j.lesson_id = r2.lesson_id WHERE j.id = $1`, [job.id])).rows[0];
    expect(rev.artifact_manifest.manifestVersion).toBe(2);
    const v2 = parseManifest(rev.artifact_manifest)!;
    await unlink(path.join(storeDir, v2.documents[0]!.pdf.path));
    const filesBefore = await files();
    const spy = new SpyStore(store);
    expect(await refusal(recoverRevision(recoverDeps({ store: spy }), rev.id))).toBe("not_export_revision");
    expect(spy.puts).toEqual([]);
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

describe("recoverRevision, the central checks", () => {
  it("refuses a recompile with the same size and page count but one flipped bit (the PDF sha is compared)", async () => {
    const x = await exported();
    await unlink(path.join(storeDir, x.manifest.documents[0]!.pdf.path));
    const spy = new SpyStore(store);
    const filesBefore = await files();
    expect(await refusal(recoverRevision(recoverDeps({ documentCompiler: new BitFlipCompiler(), store: spy }), x.revisionId))).toBe("recompile_not_identical");
    expect(spy.puts).toEqual([]);
    expect(await files()).toEqual(filesBefore);
  });

  it("does not report restored when the store keeps different bytes than it was given, and stops at the first bad file", async () => {
    const x = await exported();
    await unlink(path.join(storeDir, x.manifest.documents[0]!.pdf.path));
    await unlink(path.join(storeDir, x.manifest.documents[1]!.pdf.path));
    const spy = new SpyStore(store, { mangle: true });
    const code = await refusal(recoverRevision(recoverDeps({ store: spy }), x.revisionId));
    expect(["verify_failed", "store_failed"]).toContain(code);
    expect(spy.puts).toHaveLength(1);
  });

  it("verifies the whole revision again at the end even when each put looked fine", async () => {
    const x = await exported();
    await unlink(path.join(storeDir, x.manifest.documents[0]!.pdf.path));
    const spy = new SpyStore(store, { mangle: true, lie: true }); // the first stat after each put reports the intended bytes
    expect(await refusal(recoverRevision(recoverDeps({ store: spy }), x.revisionId))).toBe("verify_failed");
  });

  it("reads the revision again right before writing: a lesson deleted during the compile gets no put", async () => {
    const x = await exported();
    await unlink(path.join(storeDir, x.manifest.documents[0]!.pdf.path));
    const spy = new SpyStore(store);
    const recovery = hookedRecovery(async (n) => {
      if (n === 1) await h.web.lessonDelete.deleteLesson(x.ctx, x.lessonId);
    });
    // The first read still shows a live lesson; only the fresh read can refuse, and it must do so with the plain code.
    expect(await refusal(recoverRevision(recoverDeps({ store: spy, recovery }), x.revisionId))).toBe("lesson_deleted");
    expect(spy.puts).toEqual([]);
  });

  it("takes back exactly the files it wrote when the lesson is deleted after the writes", async () => {
    const x = await exported();
    const [a, b] = x.manifest.documents;
    const before = await files();
    await unlink(path.join(storeDir, a!.pdf.path));
    await unlink(path.join(storeDir, b!.tex.path));
    const survivors = await files();
    let deleted = false;
    const spy = new SpyStore(store, {
      onPut: async () => {
        if (!deleted) {
          deleted = true;
          await h.web.lessonDelete.deleteLesson(x.ctx, x.lessonId);
        }
      },
    });
    expect(await refusal(recoverRevision(recoverDeps({ store: spy }), x.revisionId))).toBe("lesson_deleted_during_recovery");
    expect(spy.puts.length).toBe(2);
    expect([...spy.deletes].sort()).toEqual([...spy.puts].sort());
    expect(spy.prefixDeletes).toEqual([]); // single objects, never a prefix
    expect(spy.puts.every((p) => p in before)).toBe(true); // only manifest paths
    expect(await files()).toEqual(survivors); // nothing it wrote is left, nothing else was touched
  });

  it.each([
    ["snapshot_missing", (r: RecoveryRevision) => ({ ...r, snapshot: null })],
    ["export_not_succeeded", (r: RecoveryRevision) => ({ ...r, exportState: "failed" })],
    ["export_not_succeeded", (r: RecoveryRevision) => ({ ...r, exportState: null, exportId: null })],
    ["export_ambiguous", (r: RecoveryRevision) => ({ ...r, exportCount: 2 })],
    ["export_mismatch", (r: RecoveryRevision) => ({ ...r, exportId: randomUUID() })],
    ["export_mismatch", (r: RecoveryRevision) => ({ ...r, exportSnapshotId: randomUUID() })],
  ])("refuses with %s and writes nothing", async (expected, change) => {
    const x = await exported();
    await unlink(path.join(storeDir, x.manifest.documents[0]!.pdf.path));
    const spy = new SpyStore(store);
    const recovery = hookedRecovery((_n, row) => (row ? change(row) : row));
    expect(await refusal(recoverRevision(recoverDeps({ store: spy, recovery }), x.revisionId))).toBe(expected);
    expect(spy.puts).toEqual([]);
  });

  it.each([["dotdot", ".."], ["empty", ""], ["dot", "."], ["not a uuid", "attempt-1"]])("refuses a manifest whose attempt segment is %s", async (_label, segment) => {
    const x = await exported();
    const forged = {
      ...x.manifest,
      documents: x.manifest.documents.map((d) => {
        const fix = (p: string) => p.split("/").map((part, i) => (i === 3 ? segment : part)).join("/");
        return { ...d, pdf: { ...d.pdf, path: fix(d.pdf.path) }, tex: { ...d.tex, path: fix(d.tex.path) } };
      }),
    };
    await forceManifest(x.revisionId, forged);
    const spy = new SpyStore(store);
    expect(await refusal(recoverRevision(recoverDeps({ store: spy }), x.revisionId))).toBe("manifest_invalid");
    expect(spy.puts).toEqual([]);
  });

  it("refuses attempt segments that differ between documents", async () => {
    const x = await exported();
    const other = randomUUID();
    const forged = { ...x.manifest, documents: x.manifest.documents.map((d, i) => (i === 0 ? d : { ...d, pdf: { ...d.pdf, path: d.pdf.path.replace(d.pdf.path.split("/")[3]!, other) } })) };
    await forceManifest(x.revisionId, forged);
    expect(await refusal(recoverRevision(recoverDeps(), x.revisionId))).toBe("manifest_invalid");
  });
});
