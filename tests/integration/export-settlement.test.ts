import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ManifestV2 } from "@/lib/domain/manifest";
import { parseManifestV2 } from "@/lib/domain/manifest";
import { createWorkerDal } from "@/lib/server/dal";
import { SkeletonCompiler, SkeletonDocumentCompiler } from "@/lib/latex/compiler";
import { FakeLlmProvider } from "@/lib/llm/fake";
import { FsObjectStore } from "@/lib/storage/store";
import { runOnce } from "../../worker/loop";
import type { PipelineDeps } from "../../worker/pipeline";
import { code, createHarness, freshKey, request, type Harness } from "./export-helpers";

let h: Harness;
let storeDir: string;
let deps: PipelineDeps;
beforeAll(async () => {
  h = await createHarness();
  storeDir = await mkdtemp(path.join(os.tmpdir(), "noteprep-export-"));
  deps = { jobs: h.worker.jobs, settlement: h.worker.settlement, llm: new FakeLlmProvider(), compiler: new SkeletonCompiler(), documentCompiler: new SkeletonDocumentCompiler(), store: new FsObjectStore(storeDir), leaseMs: 30_000 };
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

async function newExport(trial = 3) {
  const ctx = await h.account(trial);
  const d = await h.newDraft(ctx);
  const r = await h.confirm(ctx, d);
  return { ctx, d, ...r };
}
const expectUnchanged = async (ctx: { userId: string }, expected: { used: number; reserved: number }) => expect(await h.bucket(ctx.userId)).toMatchObject(expected);

describe("commitExport", () => {
  it("publishes revision 1 from the snapshot, consumes the reservation exactly once and settles job and export together", async () => {
    const { ctx, exportId, jobId, lessonId } = await newExport();
    const token = await h.claim(jobId);
    const input = await h.commitInput(jobId, token);
    expect(await h.worker.settlement.commitExport(input)).toEqual({ revisionId: input.revisionId, replayed: false });

    const exp = await h.exportRow(exportId);
    expect(exp).toMatchObject({ state: "succeeded", revision_id: input.revisionId, failure_code: null });
    expect(exp.settled_at).not.toBeNull();
    expect(await h.jobRow(jobId)).toMatchObject({ state: "succeeded", revision_id: input.revisionId, stage: null, lease_owner: null });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "consumed", settle_reason: "succeeded" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });

    const snap = (await h.admin.query(`SELECT * FROM export_snapshot WHERE id = $1`, [exp.snapshot_id])).rows[0];
    const rev = (await h.admin.query(`SELECT * FROM lesson_revision WHERE id = $1`, [input.revisionId])).rows[0];
    expect(rev).toMatchObject({ lesson_id: lessonId, owner_id: ctx.userId, number: 1, status: "finalized", schema_version: 2, content_hash: snap.package_hash, validation_status: "verified", template_version: "classic/2", validator_version: snap.validator_version, created_by_job_id: jobId });
    expect(rev.content).toEqual(snap.content);
    expect(rev.validation_report).toEqual(snap.validation_report);
    expect(rev.generation_meta).toMatchObject({ exportId, snapshotId: snap.id, exportKey: snap.export_key, spec: snap.spec, compiler: { image: "test" } });
    expect(rev.generation_meta.documents).toEqual([
      { document: "notes", pages: 2 },
      { document: "worksheet", pages: 2 },
      { document: "solutions", pages: 2 },
    ]);
    expect(parseManifestV2(rev.artifact_manifest)).toEqual(input.manifest);
    expect((await h.admin.query(`SELECT current_revision_id FROM lesson WHERE id = $1`, [lessonId])).rows[0].current_revision_id).toBe(input.revisionId);

    // The existing view, package and download paths work unchanged on an export's lesson (manifest v2, no reader change).
    const view = await h.web.lessons.getLessonView(ctx, lessonId);
    expect(view).toMatchObject({ lessonId, revisionId: input.revisionId, revisionNumber: 1, isCurrent: true, templateVersion: "classic/2", validationStatus: "verified" });
    expect(view.documents.map((x) => x.document)).toEqual(["notes", "worksheet", "solutions"]);
    expect((await h.web.lessons.getLessonPackage(ctx, lessonId)).package.documents).toHaveLength(3);
    expect((await h.web.lessons.getArtifact(ctx, lessonId, input.revisionId, "worksheet")).filename).toMatch(/\.pdf$/);
    expect((await h.web.exports.getExportStatus(ctx, exportId))).toMatchObject({ state: "succeeded", revisionId: input.revisionId, reservation: { state: "consumed" }, job: { state: "succeeded" } });
  });

  it("a replay after a lost acknowledgement is a no-op", async () => {
    const { ctx, jobId } = await newExport();
    const token = await h.claim(jobId);
    const input = await h.commitInput(jobId, token);
    const other = await h.commitInput(jobId, token); // built now: the attempt's input is readable only while the job runs
    await h.worker.settlement.commitExport(input);
    expect(await h.worker.settlement.commitExport(input)).toEqual({ revisionId: input.revisionId, replayed: true });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
    expect(await h.count(`SELECT count(*) AS n FROM lesson_revision WHERE created_by_job_id = $1`, [jobId])).toBe(1);
    // the same token with ANOTHER revision id is not a replay
    expect(await code(h.worker.settlement.commitExport(other))).toBe("STALE_OR_CANCELED");
  });

  it("a late commit from a superseded attempt (stale token) changes nothing", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const stale = await h.claim(jobId);
    const staleInput = await h.commitInput(jobId, stale);
    expect(await h.worker.jobs.retryOrFail(jobId, stale, "storage_failed", () => 0)).toBe("requeued");
    const fresh = await h.claim(jobId);
    expect(await code(h.worker.settlement.commitExport(staleInput))).toBe("STALE_OR_CANCELED");
    expect(await code(h.worker.settlement.commitExport({ ...(await h.commitInput(jobId, fresh)), fencingToken: fresh + 7n }))).toBe("STALE_OR_CANCELED");
    await expectUnchanged(ctx, { used: 0, reserved: 1 });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "pending" });
    expect(await h.count(`SELECT count(*) AS n FROM lesson_revision WHERE created_by_job_id = $1`, [jobId])).toBe(0);
    await h.worker.settlement.commitExport(await h.commitInput(jobId, fresh));
    await expectUnchanged(ctx, { used: 1, reserved: 0 });
  });

  it("a worker retry reuses the original reservation, and the export consumes once", async () => {
    const { ctx, jobId } = await newExport();
    const reservationId = (await h.reservationRow(jobId)).id;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const token = await h.claim(jobId);
      expect(await h.worker.jobs.retryOrFail(jobId, token, "storage_failed", () => 0)).toBe("requeued");
      await expectUnchanged(ctx, { used: 0, reserved: 1 });
      expect((await h.reservationRow(jobId)).id).toBe(reservationId);
    }
    const token = await h.claim(jobId);
    await h.worker.settlement.commitExport(await h.commitInput(jobId, token));
    expect(await h.count(`SELECT count(*) AS n FROM usage_reservation WHERE job_id = $1`, [jobId])).toBe(1);
    await expectUnchanged(ctx, { used: 1, reserved: 0 });
  });

  it("a crash before commit: the sweeper requeues, the retry commits, consumption happens once", async () => {
    const { ctx, exportId, jobId } = await newExport();
    await h.claim(jobId);
    await h.admin.query(`UPDATE generation_job SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [jobId]);
    const report = await h.worker.jobs.sweep();
    expect(report.sweepRowErrors).toBe(0);
    expect(report.requeued).toBeGreaterThanOrEqual(1);
    expect(await h.jobRow(jobId)).toMatchObject({ state: "queued" });
    await h.admin.query(`UPDATE generation_job SET run_after = now() WHERE id = $1`, [jobId]);
    await expectUnchanged(ctx, { used: 0, reserved: 1 });
    const token = await h.claim(jobId);
    await h.worker.settlement.commitExport(await h.commitInput(jobId, token));
    await expectUnchanged(ctx, { used: 1, reserved: 0 });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "succeeded" });
  });
});

describe("the render chain and the manifest are checked against the snapshot", () => {
  it("a manifest whose source hash differs from the confirmed snapshot is ManifestIncomplete: nothing consumed, the caller path releases", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const token = await h.claim(jobId);
    const bad = await h.commitInput(jobId, token, { texOverride: { worksheet: "d".repeat(64) } });
    expect(await code(h.worker.settlement.commitExport(bad))).toBe("MANIFEST_INCOMPLETE");
    await expectUnchanged(ctx, { used: 0, reserved: 1 });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "pending", revision_id: null });
    expect(await h.count(`SELECT count(*) AS n FROM lesson_revision WHERE created_by_job_id = $1`, [jobId])).toBe(0);
    // what the worker does next: fail the job for good, which releases the reservation and fails the export
    await h.worker.settlement.finishJob({ jobId, fencingToken: token, outcome: "failed", errorCode: "render_mismatch" });
    await expectUnchanged(ctx, { used: 0, reserved: 0 });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "render_mismatch" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released", settle_reason: "failed:render_mismatch" });
  });

  it("a missing, extra or misplaced document, another template or a path outside the attempt prefix is refused", async () => {
    const { ctx, jobId } = await newExport();
    const token = await h.claim(jobId);
    const good = await h.commitInput(jobId, token);
    const mutate = (fn: (m: ManifestV2) => void) => {
      const manifest = structuredClone(good.manifest);
      fn(manifest);
      return { ...good, manifest };
    };
    const cases = [
      mutate((m) => m.documents.pop()),
      mutate((m) => m.documents.push({ ...m.documents[0]! })),
      mutate((m) => (m.templateVersion = "classic/1")),
      mutate((m) => (m.documents[0]!.pdf.path = "someone/else/notes.pdf")),
      mutate((m) => (m.documents[1]!.pdf.pages = 0)),
      mutate((m) => (m.documents[2]!.tex.sha256 = "zz")),
      { ...good, attemptId: randomUUID() }, // paths belong to another attempt
    ];
    for (const c of cases) expect(await code(h.worker.settlement.commitExport(c))).toBe("MANIFEST_INCOMPLETE");
    await expectUnchanged(ctx, { used: 0, reserved: 1 });
    await h.worker.settlement.commitExport(good);
    await expectUnchanged(ctx, { used: 1, reserved: 0 });
  });

  it("commitExport refuses a generate job, and commitSuccess refuses an export job", async () => {
    const { ctx, jobId } = await newExport();
    const token = await h.claim(jobId);
    const input = await h.commitInput(jobId, token);
    expect(
      await code(
        h.worker.settlement.commitSuccess({
          jobId,
          fencingToken: token,
          attemptId: input.attemptId,
          revisionId: input.revisionId,
          revision: { schemaVersion: 2, content: {}, contentHash: "x", validationReport: {}, validationStatus: "verified", templateVersion: "classic/2", validatorVersion: "v" },
          manifest: input.manifest,
          requestedDocuments: ["notes", "worksheet", "solutions"],
        }),
      ),
    ).toBe("INVARIANT_VIOLATION");
    await expectUnchanged(ctx, { used: 0, reserved: 1 });
    // a legacy generate job through commitExport
    const legacy = await h.web.generation.createGeneration(ctx, request(), freshKey());
    const legacyToken = await h.claim(legacy.job.id).catch(async () => {
      await h.admin.query(`UPDATE generation_job SET state = 'running', stage = 'storing', lease_owner = 'w', lease_expires_at = now() + interval '5 minutes', fencing_token = 1, attempt = 1 WHERE id = $1`, [legacy.job.id]);
      return 1n;
    });
    expect(await code(h.worker.settlement.commitExport({ ...input, jobId: legacy.job.id, fencingToken: legacyToken }))).toBe("INVARIANT_VIOLATION");
    await h.worker.settlement.finishJob({ jobId: legacy.job.id, fencingToken: legacyToken, outcome: "failed", errorCode: "x" });
  });

  it("a deleted lesson or an account being deleted blocks publication", async () => {
    const { ctx, jobId, lessonId } = await newExport();
    const token = await h.claim(jobId);
    const input = await h.commitInput(jobId, token);
    await h.admin.query(`UPDATE lesson SET deleted_at = now() WHERE id = $1`, [lessonId]);
    expect(await code(h.worker.settlement.commitExport(input))).toBe("STALE_OR_CANCELED");
    await h.admin.query(`UPDATE lesson SET deleted_at = NULL WHERE id = $1`, [lessonId]);
    await h.admin.query(`UPDATE profile SET status = 'deleting' WHERE id = $1`, [ctx.userId]);
    expect(await code(h.worker.settlement.commitExport(input))).toBe("STALE_OR_CANCELED");
    await h.admin.query(`UPDATE profile SET status = 'active' WHERE id = $1`, [ctx.userId]);
    await expectUnchanged(ctx, { used: 0, reserved: 1 });
    await h.worker.settlement.commitExport(input);
  });
});

describe("cancel", () => {
  it("a queued export is canceled at once: job canceled, export failed 'canceled', reservation released, the key is free again", async () => {
    const { ctx, d, exportId, jobId } = await newExport();
    const job = await h.web.generation.cancelJob(ctx, jobId);
    expect(job).toMatchObject({ kind: "export", state: "canceled", errorCode: "canceled", cancelRequested: true });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "canceled" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released", settle_reason: "canceled" });
    await expectUnchanged(ctx, { used: 0, reserved: 0 });
    expect((await h.confirm(ctx, d)).outcome).toBe("created");
  });

  it("a running export is only flagged; the worker's finish releases it and a late commit is refused", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const token = await h.claim(jobId);
    const input = await h.commitInput(jobId, token);
    expect(await h.web.generation.cancelJob(ctx, jobId)).toMatchObject({ state: "running", cancelRequested: true });
    await expectUnchanged(ctx, { used: 0, reserved: 1 });
    expect(await code(h.worker.settlement.commitExport(input))).toBe("STALE_OR_CANCELED");
    expect(await h.worker.jobs.heartbeat(jobId, token, 30_000)).toBe("cancel_requested");
    await h.worker.settlement.finishJob({ jobId, fencingToken: token, outcome: "canceled", errorCode: "canceled" });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "canceled" });
    await expectUnchanged(ctx, { used: 0, reserved: 0 });
  });

  it("canceling after commit changes nothing", async () => {
    const { ctx, exportId, jobId } = await newExport();
    await h.complete(jobId);
    expect(await h.web.generation.cancelJob(ctx, jobId)).toMatchObject({ state: "succeeded" });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "succeeded" });
    await expectUnchanged(ctx, { used: 1, reserved: 0 });
  });

  it("another user cannot cancel it", async () => {
    const { jobId } = await newExport();
    const mallory = await h.account();
    expect(await code(h.web.generation.cancelJob(mallory, jobId))).toBe("NOT_FOUND");
    expect(await h.jobRow(jobId)).toMatchObject({ state: "queued" });
  });
});

describe("terminal paths all settle the export before releasing the reservation", () => {
  it("retryOrFail giving up (attempts used up) fails the export with the code and releases", async () => {
    const { ctx, exportId, jobId } = await newExport();
    let result: string = "";
    for (let i = 0; i < 3; i++) {
      const token = await h.claim(jobId);
      result = await h.worker.jobs.retryOrFail(jobId, token, "storage_failed", () => 0);
    }
    expect(result).toBe("failed");
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "storage_failed" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released" });
    await expectUnchanged(ctx, { used: 0, reserved: 0 });
  });

  it("retryOrFail with a cancel request ends the job as canceled", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const token = await h.claim(jobId);
    await h.web.generation.cancelJob(ctx, jobId);
    expect(await h.worker.jobs.retryOrFail(jobId, token, "storage_failed")).toBe("failed");
    expect(await h.jobRow(jobId)).toMatchObject({ state: "canceled" });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "canceled" });
  });

  it("the sweeper fails a queued export past its deadline and one that used its attempts, and cancels a flagged one", async () => {
    const a = await newExport();
    const b = await newExport();
    const c = await newExport();
    await h.admin.query(`UPDATE generation_job SET deadline_at = now() - interval '1 second' WHERE id = $1`, [a.jobId]);
    await h.admin.query(`UPDATE generation_job SET attempt = max_attempts WHERE id = $1`, [b.jobId]);
    await h.admin.query(`UPDATE generation_job SET cancel_requested_at = now() WHERE id = $1`, [c.jobId]);
    const report = await h.worker.jobs.sweep();
    expect(report.sweepRowErrors).toBe(0);
    expect(await h.exportRow(a.exportId)).toMatchObject({ state: "failed", failure_code: "deadline_exceeded" });
    expect(await h.exportRow(b.exportId)).toMatchObject({ state: "failed", failure_code: "max_attempts_exceeded" });
    expect(await h.exportRow(c.exportId)).toMatchObject({ state: "failed", failure_code: "canceled" });
    for (const x of [a, b, c]) {
      expect(await h.reservationRow(x.jobId)).toMatchObject({ state: "released" });
      await expectUnchanged(x.ctx, { used: 0, reserved: 0 });
    }
  });
});

describe("deadline (C4)", () => {
  it("a commit after the job's deadline (database clock) is refused with DEADLINE_EXCEEDED; finishing it releases the reservation", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const token = await h.claim(jobId);
    const input = await h.commitInput(jobId, token);
    await h.admin.query(`UPDATE generation_job SET deadline_at = now() - interval '1 second' WHERE id = $1`, [jobId]);
    expect(await code(h.worker.settlement.commitExport(input))).toBe("DEADLINE_EXCEEDED");
    await expectUnchanged(ctx, { used: 0, reserved: 1 });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "pending" });
    await h.worker.settlement.finishJob({ jobId, fencingToken: token, outcome: "failed", errorCode: "deadline_exceeded" });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "deadline_exceeded" });
    await expectUnchanged(ctx, { used: 0, reserved: 0 });
  });

  it("the sweeper fails a RUNNING export past deadline + grace even with a healthy lease, and the worker's late commit is fenced out", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const token = await h.claim(jobId);
    const input = await h.commitInput(jobId, token);
    await h.admin.query(`UPDATE generation_job SET deadline_at = now() - interval '5 seconds' WHERE id = $1`, [jobId]);

    const patient = createWorkerDal(h.workerDb, { backoff: { baseMs: 1, capMs: 5 }, exportDeadlineGraceSeconds: 3600 });
    await patient.jobs.sweep();
    expect(await h.jobRow(jobId)).toMatchObject({ state: "running" }); // inside the grace period

    const report = await h.worker.jobs.sweep(); // grace 0
    expect(report.sweepRowErrors).toBe(0);
    expect(await h.jobRow(jobId)).toMatchObject({ state: "failed", error_code: "deadline_exceeded" });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "deadline_exceeded" });
    await expectUnchanged(ctx, { used: 0, reserved: 0 });
    expect(await code(h.worker.settlement.commitExport(input))).toBe("STALE_OR_CANCELED");
    await expectUnchanged(ctx, { used: 0, reserved: 0 });
  });

  it("legacy generate jobs keep their behaviour: a running legacy job with a healthy lease past its deadline is NOT touched by the export rule", async () => {
    const ctx = await h.account();
    const legacy = await h.web.generation.createGeneration(ctx, request(), freshKey());
    await h.claim(legacy.job.id).catch(() => undefined);
    await h.admin.query(`UPDATE generation_job SET state = 'running', stage = 'generating', lease_owner = 'w', lease_expires_at = now() + interval '5 minutes', fencing_token = 1, attempt = 1, deadline_at = now() - interval '5 seconds' WHERE id = $1`, [legacy.job.id]);
    await h.worker.jobs.sweep();
    expect(await h.jobRow(legacy.job.id)).toMatchObject({ state: "running" });
    await h.worker.settlement.finishJob({ jobId: legacy.job.id, fencingToken: 1n, outcome: "failed", errorCode: "x" });
  });
});

describe("commit versus sweep", () => {
  it("while commit holds the job lock the sweeper skips the row; commit then wins", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const token = await h.claim(jobId);
    const input = await h.commitInput(jobId, token);
    await h.admin.query(`UPDATE generation_job SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [jobId]);
    const c = await h.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT 1 FROM generation_job WHERE id = $1 FOR UPDATE`, [jobId]);
      const sweeping = h.worker.jobs.sweep();
      const committing = h.worker.settlement.commitExport(input);
      await new Promise((r) => setTimeout(r, 300));
      await c.query("COMMIT");
      const [report] = await Promise.all([sweeping, committing]);
      expect(report.sweepRowErrors).toBe(0);
    } finally {
      c.release();
    }
    expect(await h.exportRow(exportId)).toMatchObject({ state: "succeeded" });
    await expectUnchanged(ctx, { used: 1, reserved: 0 });
  });

  it("racing commit and sweep on expired leases: exactly one outcome every time, drift empty", async () => {
    for (let round = 0; round < 12; round++) {
      const { ctx, exportId, jobId } = await newExport();
      const token = await h.claim(jobId);
      const input = await h.commitInput(jobId, token);
      await h.admin.query(`UPDATE generation_job SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [jobId]);
      const [commit, sweep] = await Promise.allSettled([h.worker.settlement.commitExport(input), h.worker.jobs.sweep()]);
      if (sweep.status === "fulfilled") expect(sweep.value.sweepRowErrors).toBe(0);
      const exp = await h.exportRow(exportId);
      const bucket = await h.bucket(ctx.userId);
      if (commit.status === "fulfilled") {
        expect(exp.state).toBe("succeeded");
        expect(bucket).toMatchObject({ used: 1, reserved: 0 });
      } else {
        expect((commit.reason as { code: string }).code).toBe("STALE_OR_CANCELED");
        expect(exp.state).toBe("pending");
        expect(await h.jobRow(jobId)).toMatchObject({ state: "queued" });
        expect(bucket).toMatchObject({ used: 0, reserved: 1 });
      }
      await h.expectNoDrift();
      await h.abandonPending();
    }
  });
});

describe("sweep hardening (C3)", () => {
  it("a poisoned row is counted and skipped: the other rows are still recovered", async () => {
    const poison = await newExport();
    const healthy = await newExport();
    for (const x of [poison, healthy]) {
      await h.claim(x.jobId);
      await h.admin.query(`UPDATE generation_job SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [x.jobId]);
    }
    // Poison: the reservation row vanishes (a bug or a manual repair gone wrong), so no settlement of this job can be consistent.
    const reservation = await h.reservationRow(poison.jobId);
    await h.admin.query(`DELETE FROM usage_reservation WHERE job_id = $1`, [poison.jobId]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const report = await h.worker.jobs.sweep();
      // the poisoned row is logged with its id and the SQLSTATE (23514 from the deferred consistency trigger), never a message body
      const events = logged.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((e) => e.event === "sweep_row_error");
      expect(events).toContainEqual(expect.objectContaining({ jobId: poison.jobId, code: "23514" }));
      expect(JSON.stringify(events)).not.toContain("usage reservation");
      expect(report.sweepRowErrors).toBeGreaterThanOrEqual(1);
      expect(report.requeued).toBeGreaterThanOrEqual(1);
      expect(await h.jobRow(healthy.jobId)).toMatchObject({ state: "queued" }); // recovered
      expect(await h.jobRow(poison.jobId)).toMatchObject({ state: "running" }); // untouched: its transaction rolled back
      expect(report.exportDrift).toContain(poison.exportId); // and it is reported
    } finally {
      logged.mockRestore();
      await h.admin.query(`INSERT INTO usage_reservation (id, owner_id, bucket_id, job_id) VALUES ($1,$2,$3,$4)`, [reservation.id, reservation.owner_id, reservation.bucket_id, reservation.job_id]);
    }
    const again = await h.worker.jobs.sweep();
    expect(again.sweepRowErrors).toBe(0);
    expect(await h.jobRow(poison.jobId)).toMatchObject({ state: "queued" });
  });

  it("the report has the new shape and reports nothing for a healthy database", async () => {
    await newExport();
    const report = await h.worker.jobs.sweep();
    expect(Object.keys(report).sort()).toEqual(["canceled", "drift", "exportDrift", "failed", "requeued", "sweepRowErrors"]);
    expect(report.sweepRowErrors).toBe(0);
  });
});

describe("claiming, input and the runner safety net", () => {
  it("claimNext claims export jobs (stage compiling, kind returned) and legacy jobs as before (stage generating)", async () => {
    await h.parkForeignJobs();
    const exp = await newExport();
    const claimed = await h.worker.jobs.claimNext("w-test", 30_000);
    expect(claimed).toMatchObject({ id: exp.jobId, kind: "export", ownerId: exp.ctx.userId, lessonId: exp.lessonId, attempt: 1 });
    expect(await h.jobRow(exp.jobId)).toMatchObject({ state: "running", stage: "compiling", lease_owner: "w-test" });
    const ctx = await h.account();
    const legacy = await h.web.generation.createGeneration(ctx, request(), freshKey());
    const second = await h.worker.jobs.claimNext("w-test", 30_000);
    expect(second).toMatchObject({ id: legacy.job.id, kind: "generate" });
    expect(await h.jobRow(legacy.job.id)).toMatchObject({ stage: "generating" });
    await h.worker.settlement.finishJob({ jobId: legacy.job.id, fencingToken: second!.fencingToken, outcome: "failed", errorCode: "x" });
  });

  it("getExportInput is readable only by the attempt that owns the running job", async () => {
    const { exportId, jobId, ctx } = await newExport();
    await expect(h.worker.jobs.getExportInput(jobId, 1n)).rejects.toMatchObject({ code: "STALE_OR_CANCELED" }); // queued: nobody owns it
    const token = await h.claim(jobId);
    const input = await h.worker.jobs.getExportInput(jobId, token);
    expect(input).toMatchObject({ exportId, ownerId: ctx.userId });
    expect((input.spec as { documents: string[] }).documents).toEqual(["notes", "worksheet", "solutions"]);
    expect(Object.keys(input.texSha256 as object)).toHaveLength(3);
    await expect(h.worker.jobs.getExportInput(jobId, token + 1n)).rejects.toMatchObject({ code: "STALE_OR_CANCELED" });
    await h.worker.settlement.finishJob({ jobId, fencingToken: token, outcome: "failed", errorCode: "x" });
    await expect(h.worker.jobs.getExportInput(jobId, token)).rejects.toMatchObject({ code: "STALE_OR_CANCELED" });
  });

  it("the worker runs export jobs", async () => {
    await h.parkForeignJobs();
    const { ctx, exportId, jobId } = await newExport();
    const outcome = await runOnce(deps, "w-runs-export");
    expect(outcome).toBe("succeeded");
    expect(await h.jobRow(jobId)).toMatchObject({ state: "succeeded", error_code: null });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "succeeded", failure_code: null });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "consumed" });
    await expectUnchanged(ctx, { used: 1, reserved: 0 });
  });

  it("the legacy generate pipeline still runs for generate jobs next to export jobs", async () => {
    await h.parkForeignJobs();
    const ctx = await h.account();
    const legacy = await h.web.generation.createGeneration(ctx, request(), freshKey());
    expect(await runOnce(deps, "w-legacy")).toBe("succeeded");
    expect(await h.jobRow(legacy.job.id)).toMatchObject({ state: "succeeded" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
  });
});

describe("history and historical lessons", () => {
  it("listJobs includes exports with kind and exportId; a failed or pending export has no revision", async () => {
    const ctx = await h.account();
    const [a, b] = [await h.newDraft(ctx), await h.newDraft(ctx)];
    const first = await h.confirm(ctx, a);
    const second = await h.confirm(ctx, b);
    await h.complete(first.jobId);
    const items = await h.web.history.listJobs(ctx);
    const byJob = Object.fromEntries(items.map((i) => [i.jobId, i]));
    expect(byJob[first.jobId]).toMatchObject({ kind: "export", exportId: first.exportId, state: "succeeded", lessonId: first.lessonId });
    expect(byJob[first.jobId]!.revisionId).not.toBeNull();
    expect(byJob[second.jobId]).toMatchObject({ kind: "export", exportId: second.exportId, state: "queued", revisionId: null });
    const legacy = await h.web.generation.createGeneration(ctx, request(), freshKey());
    const again = await h.web.history.listJobs(ctx);
    expect(again.find((i) => i.jobId === legacy.job.id)).toMatchObject({ kind: "generate", exportId: null });
    await h.web.generation.cancelJob(ctx, legacy.job.id);
  });

  it("a historical generate lesson (v2 manifest) is untouched by exports: view, download and counters", async () => {
    await h.parkForeignJobs();
    const ctx = await h.account(10);
    const legacy = await h.web.generation.createGeneration(ctx, request(), freshKey());
    expect(await runOnce(deps, "w-hist")).toBe("succeeded");
    const lessonId = legacy.job.lessonId;
    const before = {
      view: await h.web.lessons.getLessonView(ctx, lessonId),
      artifact: await h.web.lessons.getArtifact(ctx, lessonId, (await h.web.lessons.getLessonView(ctx, lessonId)).revisionId, "notes"),
      pkg: await h.web.lessons.getLessonPackage(ctx, lessonId),
      revisionRows: (await h.admin.query(`SELECT id, content_hash, artifact_manifest, generation_meta FROM lesson_revision WHERE lesson_id = $1`, [lessonId])).rows,
    };
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });

    // exports of the same account: one fails, one succeeds
    const failing = await h.confirm(ctx, await h.newDraft(ctx));
    await h.fail(failing.jobId, "compile_failed");
    const ok = await h.confirm(ctx, await h.newDraft(ctx));
    await h.complete(ok.jobId);

    expect(await h.web.lessons.getLessonView(ctx, lessonId)).toEqual(before.view);
    expect(await h.web.lessons.getArtifact(ctx, lessonId, before.view.revisionId, "notes")).toEqual(before.artifact);
    expect(await h.web.lessons.getLessonPackage(ctx, lessonId)).toEqual(before.pkg);
    expect((await h.admin.query(`SELECT id, content_hash, artifact_manifest, generation_meta FROM lesson_revision WHERE lesson_id = $1`, [lessonId])).rows).toEqual(before.revisionRows);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 2, reserved: 0 }); // exactly the one successful export was charged
  });
});
