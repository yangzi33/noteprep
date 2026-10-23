import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ManifestIncomplete } from "@/lib/domain/errors";
import { renderForExport, type ExportSpec } from "@/lib/domain/export-spec";
import { sha256Hex } from "@/lib/domain/hash";
import { parseManifest } from "@/lib/domain/manifest";
import { CompileError, SkeletonCompiler, SkeletonDocumentCompiler, type DocumentCompiler } from "@/lib/latex/compiler";
import { FakeLlmProvider } from "@/lib/llm/fake";
import { renderDocument } from "@/lib/latex/render";
import { PackageSchema } from "@/lib/package/schema";
import { FsObjectStore, sha256Of, StorageError, type ObjectStore } from "@/lib/storage/store";
import { runOnce } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";
import { code, createHarness, freshKey, request, sleep, type Harness } from "./export-helpers";

let h: Harness;
let storeDir: string;
let store: FsObjectStore;
beforeAll(async () => {
  h = await createHarness();
  storeDir = await mkdtemp(path.join(os.tmpdir(), "noteprep-export-worker-"));
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

async function newExport(trial = 3) {
  const ctx = await h.account(trial);
  const d = await h.newDraft(ctx);
  const r = await h.confirm(ctx, d);
  return { ctx, d, ...r };
}

/** Every file below an owner's prefix in the test store. */
async function filesOf(ownerId: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(storeDir, ownerId), { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function runUntilDone(jobId: string, d = deps(), max = 8) {
  const outcomes: (string | null)[] = [];
  for (let i = 0; i < max; i++) {
    outcomes.push(await runOnce(d, "w-export"));
    const state = (await h.jobRow(jobId)).state;
    if (state === "succeeded" || state === "failed" || state === "canceled") break;
    await sleep(15);
  }
  return outcomes;
}

/** Waits until compile() has been entered, then holds it until released or aborted. */
class BlockingCompiler implements DocumentCompiler {
  readonly id = "blocking";
  private release!: () => void;
  private entered!: () => void;
  readonly started = new Promise<void>((r) => (this.entered = r));
  private readonly gate = new Promise<void>((r) => (this.release = r));
  compiles = 0;
  constructor(private readonly onEntered?: () => Promise<void>) {}
  open() {
    this.release();
  }
  async compile(req: Parameters<DocumentCompiler["compile"]>[0]) {
    this.compiles++;
    this.entered();
    await this.onEntered?.();
    await new Promise<void>((resolve, reject) => {
      this.gate.then(resolve);
      req.signal?.addEventListener("abort", () => reject(req.signal!.reason), { once: true });
    });
    return new SkeletonDocumentCompiler().compile(req);
  }
}

class WrappedStore implements ObjectStore {
  stats = new Map<string, number>();
  constructor(
    private readonly inner: ObjectStore,
    private readonly hooks: { put?: (p: string, n: number) => void; stat?: (p: string, n: number) => { bytes: number; sha256: string } | null | undefined } = {},
  ) {}
  puts = 0;
  async put(p: string, data: Uint8Array) {
    this.hooks.put?.(p, ++this.puts);
    return this.inner.put(p, data);
  }
  async stat(p: string) {
    const n = (this.stats.get(p) ?? 0) + 1;
    this.stats.set(p, n);
    const lie = this.hooks.stat?.(p, n);
    return lie === undefined ? this.inner.stat(p) : lie;
  }
  deletePrefix(p: string) {
    return this.inner.deletePrefix(p);
  }
}

describe("the worker runs export jobs", () => {
  it("compiles, stores and commits: the revision is the snapshot, the files are the manifest, one generation is consumed", async () => {
    const { ctx, exportId, jobId, lessonId } = await newExport();
    expect(await runOnce(deps(), "w-ok")).toBe("succeeded");

    const exp = await h.exportRow(exportId);
    expect(exp).toMatchObject({ state: "succeeded", failure_code: null });
    expect(await h.jobRow(jobId)).toMatchObject({ state: "succeeded", stage: null, calls_used: 0 });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "consumed", settle_reason: "succeeded" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });

    const snap = (await h.admin.query(`SELECT * FROM export_snapshot WHERE id = $1`, [exp.snapshot_id])).rows[0];
    const rev = (await h.admin.query(`SELECT * FROM lesson_revision WHERE id = $1`, [exp.revision_id])).rows[0];
    expect(rev.content).toEqual(snap.content);
    expect(rev.content_hash).toBe(snap.package_hash);
    expect(rev.generation_meta.compiler).toEqual({ id: "skeleton", image: "test-image" });
    expect(rev.artifact_manifest).toMatchObject({ manifestVersion: 3, pageFormat: "letter", compile: { profile: "compile/1", image: "test-image" }, exportKey: exp.export_key });
    const manifest = parseManifest(rev.artifact_manifest)!;
    expect(manifest.documents.map((d) => d.document)).toEqual(["notes", "worksheet", "solutions"]);
    for (const d of manifest.documents) {
      expect(d.tex.sha256).toBe(snap.tex_sha256[d.document]);
      for (const file of [d.pdf, d.tex]) {
        const bytes = new Uint8Array(await readFile(path.join(storeDir, file.path)));
        expect(sha256Of(bytes)).toBe(file.sha256);
        expect(bytes.byteLength).toBe(file.bytes);
      }
    }

    const view = await h.web.lessons.getLessonView(ctx, lessonId);
    expect(view.revisionId).toBe(exp.revision_id);
    expect(view.documents.map((d) => d.document)).toEqual(["notes", "worksheet", "solutions"]);
    const artifact = await h.web.lessons.getArtifact(ctx, lessonId, view.revisionId, "worksheet");
    expect(artifact.path.endsWith(".pdf")).toBe(true);
    expect(JSON.stringify({ view, artifact })).not.toMatch(/\.tex|tex_?sha/i);
  });

  it("the snapshot survives the jsonb round trip: re-rendering what the database returns reproduces the confirm-time hashes", async () => {
    const { jobId } = await newExport();
    const token = await h.claim(jobId);
    const input = await h.worker.jobs.getExportInput(jobId, token);
    const pkg = PackageSchema.parse(input.content);
    expect(renderForExport(pkg, (input.spec as ExportSpec).documents)).toEqual(input.texSha256);
    for (const doc of (input.spec as ExportSpec).documents) expect(sha256Hex(renderDocument(pkg, doc).tex)).toBe((input.texSha256 as Record<string, string>)[doc]);
  });

  it("a compile failure that retrying cannot fix fails the export and releases the reservation", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const outcome = await runOnce(deps({ documentCompiler: new SkeletonDocumentCompiler([new CompileError("compile_failed", false)]) }), "w-cf");
    expect(outcome).toBe("failed");
    expect(await h.jobRow(jobId)).toMatchObject({ state: "failed", error_code: "compile_failed" });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "compile_failed" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released", settle_reason: "failed:compile_failed" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect(await filesOf(ctx.userId)).toEqual([]);
  });

  it("an unavailable sandbox requeues with the SAME reservation; the next attempt succeeds and consumes once", async () => {
    const { ctx, jobId } = await newExport();
    const before = await h.reservationRow(jobId);
    const d = deps({ documentCompiler: new SkeletonDocumentCompiler([new CompileError("sandbox_unavailable", true), "ok"]) });
    expect(await runOnce(d, "w-r1")).toBe("requeued");
    expect(await h.reservationRow(jobId)).toMatchObject({ id: before.id, state: "reserved" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
    await sleep(15);
    expect(await runOnce(d, "w-r2")).toBe("succeeded");
    expect(await h.reservationRow(jobId)).toMatchObject({ id: before.id, state: "consumed" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
    expect(await h.jobRow(jobId)).toMatchObject({ attempt: 2 });
  });

  it("a storage failure requeues and the attempt's objects are deleted", async () => {
    const { ctx, jobId } = await newExport();
    const flaky = new WrappedStore(store, {
      put: (_p, n) => {
        if (n === 3) throw new StorageError(true, { op: "put", message: "boom" });
      },
    });
    expect(await runOnce(deps({ store: flaky }), "w-s1")).toBe("requeued");
    expect(await filesOf(ctx.userId)).toEqual([]);
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "reserved" });
    await sleep(15);
    expect(await runOnce(deps(), "w-s2")).toBe("succeeded");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
  });

  it("the final stat pass catches an object that changed after it was verified, and requeues without committing", async () => {
    const { ctx, jobId } = await newExport();
    const lying = new WrappedStore(store, { stat: (_p, n) => (n === 2 ? { bytes: 1, sha256: "0".repeat(64) } : undefined) });
    expect(await runOnce(deps({ store: lying }), "w-fs")).toBe("requeued");
    expect(await filesOf(ctx.userId)).toEqual([]);
    expect(await h.jobRow(jobId)).toMatchObject({ state: "queued" });
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM lesson_revision WHERE created_by_job_id = $1`, [jobId])).rows[0].n).toBe(0);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
  });

  it("a render or template version this worker does not match is retried until attempts run out, then fails and releases; it never feeds the failure memo", async () => {
    const { ctx, d, exportId, jobId } = await newExport();
    const mismatched = deps({ exportVerifyEnv: { renderVersion: "render/other" } });
    const outcomes = await runUntilDone(jobId, mismatched);
    expect(outcomes[0]).toBe("requeued");
    expect(await h.jobRow(jobId)).toMatchObject({ state: "failed", error_code: "render_version_mismatch" });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "render_version_mismatch" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    for (let i = 0; i < 3; i++) {
      const again = await h.confirm(ctx, d);
      expect(again.outcome).toBe("created");
      await runUntilDone(again.jobId, mismatched);
    }
    expect((await h.confirm(ctx, d)).outcome).toBe("created"); // still allowed after three such failures
  });

  it("a re-render that differs from the confirmed hash fails without retry, and three of them stop further confirms of that content", async () => {
    const drifting = deps({ exportVerifyEnv: { render: (pkg, id) => ({ ...renderDocument(pkg, id), tex: renderDocument(pkg, id).tex + "% drift\n" }) } });
    const ctx = await h.account(10);
    const d = await h.newDraft(ctx);
    for (let i = 0; i < 3; i++) {
      const r = await h.confirm(ctx, d);
      expect(await runOnce(drifting, "w-rm")).toBe("failed");
      expect(await h.jobRow(r.jobId)).toMatchObject({ state: "failed", error_code: "render_mismatch", attempt: 1 });
      expect(await h.reservationRow(r.jobId)).toMatchObject({ state: "released", settle_reason: "failed:render_mismatch" });
    }
    expect(await code(h.confirm(ctx, d))).toBe("EXPORT_UNAVAILABLE");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("cancel while running: the export fails as canceled, the reservation is released, nothing is published and a late commit is fenced out", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const blocker = new BlockingCompiler();
    const running = runOnce(deps({ documentCompiler: blocker, leaseMs: 300 }), "w-cancel"); // heartbeat every 100 ms
    await blocker.started;
    const token = BigInt((await h.jobRow(jobId)).fencing_token);
    const late = await h.commitInput(jobId, token);
    await h.web.generation.cancelJob(ctx, jobId);
    expect(await running).toBe("canceled");
    expect(await h.jobRow(jobId)).toMatchObject({ state: "canceled", error_code: "canceled" });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "canceled" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released" });
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM lesson_revision WHERE created_by_job_id = $1`, [jobId])).rows[0].n).toBe(0);
    expect(await code(h.worker.settlement.commitExport(late))).toBe("STALE_OR_CANCELED");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("a deadline moved in the database during compile is refused by the commit (database clock), failing as deadline_exceeded and releasing", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const slow = new BlockingCompiler(async () => {
      await h.admin.query(`UPDATE generation_job SET deadline_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
    });
    slow.open();
    expect(await runOnce(deps({ documentCompiler: slow }), "w-dl")).toBe("failed");
    expect(await h.jobRow(jobId)).toMatchObject({ state: "failed", error_code: "deadline_exceeded" });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "deadline_exceeded" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released", settle_reason: "failed:deadline_exceeded" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect(await filesOf(ctx.userId)).toEqual([]);
  });

  it("the worker's own deadline check stops an attempt past its deadline before compiling or storing anything", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const documentCompiler = new SkeletonDocumentCompiler();
    const jobs = {
      ...h.worker.jobs,
      claimNext: async (workerId: string, leaseMs: number) => {
        const job = await h.worker.jobs.claimNext(workerId, leaseMs);
        return job && { ...job, deadlineAt: new Date(Date.now() - 1000) }; // the claim says the deadline has passed
      },
    };
    expect(await runOnce(deps({ jobs, documentCompiler }), "w-wd")).toBe("failed");
    expect(documentCompiler.compiles).toBe(0);
    expect(await filesOf(ctx.userId)).toEqual([]);
    expect(await h.jobRow(jobId)).toMatchObject({ state: "failed", error_code: "deadline_exceeded", attempt: 1 });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "deadline_exceeded" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released", settle_reason: "failed:deadline_exceeded" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("a commit refused as an incomplete manifest is manifest_incomplete: failed, released, objects deleted, never requeued", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const settlement = {
      ...h.worker.settlement,
      commitExport: async () => {
        throw new ManifestIncomplete("test");
      },
    };
    expect(await runOnce(deps({ settlement }), "w-mi")).toBe("failed");
    expect(await h.jobRow(jobId)).toMatchObject({ state: "failed", error_code: "manifest_incomplete", attempt: 1 });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "manifest_incomplete" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released", settle_reason: "failed:manifest_incomplete" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect(await filesOf(ctx.userId)).toEqual([]);
  });

  it("a commit refused for the deadline (database clock) is deadline_exceeded, not internal_error, is not requeued and its objects are deleted", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const settlement = {
      ...h.worker.settlement,
      commitExport: async (input: Parameters<typeof h.worker.settlement.commitExport>[0]) => {
        await h.admin.query(`UPDATE generation_job SET deadline_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
        return h.worker.settlement.commitExport(input);
      },
    };
    expect(await runOnce(deps({ settlement }), "w-dc")).toBe("failed");
    expect(await h.jobRow(jobId)).toMatchObject({ state: "failed", error_code: "deadline_exceeded", attempt: 1 });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "deadline_exceeded" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect(await filesOf(ctx.userId)).toEqual([]);
  });

  it("a worker that lost its lease is abandoned and the new attempt consumes exactly once", async () => {
    const { ctx, jobId } = await newExport();
    const blocker = new BlockingCompiler();
    const first = runOnce(deps({ documentCompiler: blocker }), "w-first");
    await blocker.started;
    await h.admin.query(`UPDATE generation_job SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
    await h.worker.jobs.sweep();
    expect(await h.jobRow(jobId)).toMatchObject({ state: "queued" });
    await sleep(15);
    expect(await runOnce(deps(), "w-second")).toBe("succeeded");
    blocker.open();
    expect(await first).toBe("abandoned");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
    expect((await h.admin.query(`SELECT count(*)::int AS n FROM lesson_revision WHERE created_by_job_id = $1`, [jobId])).rows[0].n).toBe(1);
    expect(await h.jobRow(jobId)).toMatchObject({ state: "succeeded", attempt: 2 });
    expect((await filesOf(ctx.userId)).length).toBe(6); // only the winning attempt's files: the stale one never stored anything
    expect(blocker.compiles).toBe(1);
  });

  it("a lost commit acknowledgement leaves the committed result alone: abandoned, consumed once", async () => {
    const { ctx, jobId } = await newExport();
    const settlement = {
      ...h.worker.settlement,
      commitExport: async (input: Parameters<typeof h.worker.settlement.commitExport>[0]) => {
        await h.worker.settlement.commitExport(input);
        throw new Error("connection lost after commit");
      },
    };
    expect(await runOnce(deps({ settlement }), "w-ack")).toBe("abandoned");
    expect(await h.jobRow(jobId)).toMatchObject({ state: "succeeded" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
    expect((await filesOf(ctx.userId)).length).toBe(6); // the published objects were not deleted
  });

  it("generate jobs and export jobs run side by side", async () => {
    const ctx = await h.account();
    const gen = await h.web.generation.createGeneration(ctx, request(), freshKey());
    const d = await h.newDraft(ctx);
    const exp = await h.confirm(ctx, d);
    const outcomes = [await runOnce(deps(), "w-mix"), await runOnce(deps(), "w-mix")];
    expect(outcomes).toEqual(["succeeded", "succeeded"]);
    expect(await h.jobRow(gen.job.id)).toMatchObject({ state: "succeeded", kind: "generate" });
    expect(await h.jobRow(exp.jobId)).toMatchObject({ state: "succeeded", kind: "export" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 2, reserved: 0 });
  });
});
