import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { code, createHarness, type Harness } from "./export-helpers";
import { pgErrorCode, txErrorCode } from "./helpers";

// S5-6: lesson deletion retires succeeded exports (identity freed, nothing refunded). Real Postgres, no mocks.

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.parkForeignJobs();
});
afterEach(async () => {
  await h.expectNoDrift();
  await h.abandonPending();
});
afterAll(async () => {
  await h.close();
});

const CHECK_VIOLATION = "23514";
const STATE_VIOLATION = "55000";

async function pendingExport(trial = 3) {
  const ctx = await h.account(trial);
  const d = await h.newDraft(ctx);
  const r = await h.confirm(ctx, d);
  return { ctx, d, ...r };
}
async function succeededExport(trial = 3) {
  const e = await pendingExport(trial);
  await h.complete(e.jobId);
  return e;
}
const lessonRow = async (id: string) => (await h.admin.query(`SELECT * FROM lesson WHERE id = $1`, [id])).rows[0];
const deleteLesson = (ctx: { userId: string }, lessonId: string) => h.web.lessonDelete.deleteLesson(ctx as never, lessonId);

describe("deleteLesson", () => {
  it("is refused while the lesson has a pending export; nothing changes", async () => {
    const { ctx, exportId, jobId, lessonId } = await pendingExport();
    expect(await code(deleteLesson(ctx, lessonId))).toBe("LESSON_BUSY");
    expect(await lessonRow(lessonId)).toMatchObject({ deleted_at: null });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "pending" });
    expect(await h.jobRow(jobId)).toMatchObject({ state: "queued" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "reserved" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
    // a running job is busy too, and a queued legacy job (no implicit cancel)
    await h.claim(jobId);
    expect(await code(deleteLesson(ctx, lessonId))).toBe("LESSON_BUSY");
    expect(await h.jobRow(jobId)).toMatchObject({ state: "running", cancel_requested_at: null });
  });

  it("retires succeeded exports, keeps the consumed generation, leaves the drift views empty", async () => {
    const { ctx, exportId, jobId, lessonId } = await succeededExport();
    const before = await h.exportRow(exportId);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });

    expect(await deleteLesson(ctx, lessonId)).toEqual({ lessonId, retiredExports: 1 });

    const after = await h.exportRow(exportId);
    expect(after).toMatchObject({ state: "retired", revision_id: before.revision_id, failure_code: null });
    expect(after.settled_at).toEqual(before.settled_at);
    expect((await lessonRow(lessonId)).deleted_at).not.toBeNull();
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "consumed" });
    expect(await h.jobRow(jobId)).toMatchObject({ state: "succeeded" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 }); // no refund
    await h.expectNoDrift();
    expect(await h.web.exports.getExportStatus(ctx, exportId)).toMatchObject({ state: "retired", reservation: { state: "consumed" }, lessonId });
    // the lesson is gone for the owner
    expect(await code(h.web.lessons.getLessonView(ctx, lessonId))).toBe("NOT_FOUND");
  });

  it("a failed or canceled export of the lesson stays as history (not retired)", async () => {
    const { ctx, exportId, lessonId } = await pendingExport();
    await h.web.exports.cancelExport(ctx, exportId);
    expect(await deleteLesson(ctx, lessonId)).toEqual({ lessonId, retiredExports: 0 });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "canceled" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("the same identity can be exported again after deletion and is charged again", async () => {
    const { ctx, d, exportId, lessonId } = await succeededExport();
    // before deletion the same identity is free
    expect(await h.confirm(ctx, d)).toMatchObject({ outcome: "reused", exportId });
    await deleteLesson(ctx, lessonId);
    const again = await h.confirm(ctx, d);
    expect(again.outcome).toBe("created");
    expect(again.exportId).not.toBe(exportId);
    expect(again.lessonId).not.toBe(lessonId);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 1 });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "retired" });
    expect(await h.exportRow(again.exportId)).toMatchObject({ state: "pending" });
    await h.complete(again.jobId);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 2, reserved: 0 });
  });

  it("a foreign, missing, malformed or already deleted lesson is NOT_FOUND and nothing is touched", async () => {
    const mine = await succeededExport();
    const other = await h.account();
    expect(await code(deleteLesson(other, mine.lessonId))).toBe("NOT_FOUND");
    expect(await code(deleteLesson(mine.ctx, randomUUID()))).toBe("NOT_FOUND");
    expect(await code(deleteLesson(mine.ctx, "not-a-uuid"))).toBe("NOT_FOUND");
    expect(await lessonRow(mine.lessonId)).toMatchObject({ deleted_at: null });
    expect(await h.exportRow(mine.exportId)).toMatchObject({ state: "succeeded" });
    await deleteLesson(mine.ctx, mine.lessonId);
    expect(await code(deleteLesson(mine.ctx, mine.lessonId))).toBe("NOT_FOUND");
  });
});

describe("database rules (raw SQL cannot bypass the DAL)", () => {
  const markDeleted = (lessonId: string): [string, unknown[]] => [`UPDATE lesson SET deleted_at = now() WHERE id = $1`, [lessonId]];

  it("retiring needs a deleted lesson, and a legal retirement cannot change anything else about the export", async () => {
    const { exportId, lessonId } = await succeededExport();
    expect(await pgErrorCode(() => h.admin.query(`UPDATE export SET state = 'retired' WHERE id = $1`, [exportId]))).toBe(STATE_VIOLATION);
    expect(await h.exportRow(exportId)).toMatchObject({ state: "succeeded" });
    for (const set of [`settled_at = now() + interval '1 day'`, `failure_code = 'x'`, `revision_id = NULL`, `export_key = 'other'`]) {
      const result = await txErrorCode(h.admin, [markDeleted(lessonId), [`UPDATE export SET state = 'retired', ${set} WHERE id = $1`, [exportId]]]);
      expect(result, set).not.toBeNull();
    }
    expect(await lessonRow(lessonId)).toMatchObject({ deleted_at: null });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "succeeded" });
    // the legal pair commits; afterwards the export is final
    expect(await txErrorCode(h.admin, [markDeleted(lessonId), [`UPDATE export SET state = 'retired' WHERE id = $1`, [exportId]]])).toBeNull();
    for (const state of ["succeeded", "pending", "failed", "retired"]) {
      expect(await pgErrorCode(() => h.admin.query(`UPDATE export SET state = '${state}' WHERE id = $1`, [exportId])), state).toBe(STATE_VIOLATION);
    }
    expect(await pgErrorCode(() => h.admin.query(`UPDATE export SET settled_at = now() WHERE id = $1`, [exportId]))).toBe(STATE_VIOLATION);
  });

  it("a pending export cannot be retired, and its lesson cannot be marked deleted", async () => {
    const { exportId, lessonId } = await pendingExport();
    expect(await pgErrorCode(() => h.admin.query(`UPDATE export SET state = 'retired' WHERE id = $1`, [exportId]))).toBe(STATE_VIOLATION);
    expect(await txErrorCode(h.admin, [markDeleted(lessonId)])).toBe(CHECK_VIOLATION);
  });

  it("deleted_at cannot be set while an export of the lesson is still succeeded (checked at commit)", async () => {
    const done = await succeededExport();
    expect(await txErrorCode(h.admin, [markDeleted(done.lessonId)])).toBe(CHECK_VIOLATION);
    expect(await lessonRow(done.lessonId)).toMatchObject({ deleted_at: null });
  });

  it("a retired export is checked against its job, reservation and lesson", async () => {
    const { exportId, jobId, lessonId } = await succeededExport();
    expect(await txErrorCode(h.admin, [markDeleted(lessonId), [`UPDATE export SET state = 'retired' WHERE id = $1`, [exportId]]])).toBeNull();
    // the reservation is one-way and the retired export needs it consumed
    expect(await txErrorCode(h.admin, [[`UPDATE usage_reservation SET state = 'released', settled_at = now() WHERE job_id = $1`, [jobId]]])).not.toBeNull();
    // deletion is one-way: un-deleting (or re-timestamping) a lesson with a retired export fails with 55000
    expect(await pgErrorCode(() => h.admin.query(`UPDATE lesson SET deleted_at = NULL WHERE id = $1`, [lessonId]))).toBe(STATE_VIOLATION);
    expect(await pgErrorCode(() => h.admin.query(`UPDATE lesson SET deleted_at = now() + interval '1 day' WHERE id = $1`, [lessonId]))).toBe(STATE_VIOLATION);
    expect((await lessonRow(lessonId)).deleted_at).not.toBeNull();
    await h.expectNoDrift();
  });

  it("un-deleting a deleted lesson fails (55000) for a lesson whose only export failed", async () => {
    const ctx = await h.account(3);
    const d = await h.newDraft(ctx);
    const { lessonId } = await h.confirm(ctx, d);
    await h.abandonPending();
    await h.admin.query(`UPDATE lesson SET deleted_at = now() WHERE id = $1`, [lessonId]);
    expect(await pgErrorCode(() => h.admin.query(`UPDATE lesson SET deleted_at = NULL WHERE id = $1`, [lessonId]))).toBe(STATE_VIOLATION);
    expect((await lessonRow(lessonId)).deleted_at).not.toBeNull();
  });

  it("the state CHECK knows retired, and nothing new was granted", async () => {
    const def = (await h.admin.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'export_state_valid'`)).rows[0].d as string;
    expect(def).toMatch(/retired/);
    const priv = async (role: string, table: string, p: string) =>
      (await h.admin.query(`SELECT has_table_privilege($1, format('public.%I', $2::text), $3) AS ok`, [role, table, p])).rows[0].ok as boolean;
    for (const role of ["app_runtime", "worker_runtime"]) expect(await priv(role, "export", "DELETE")).toBe(false);
  });
});

describe("races", () => {
  it("delete vs commitExport: the commit always wins or the delete is refused; never a lost charge", async () => {
    for (let i = 0; i < 12; i++) {
      const { ctx, jobId, lessonId, exportId } = await pendingExport();
      const token = await h.claim(jobId);
      const input = await h.commitInput(jobId, token);
      const [commit, del] = await Promise.allSettled([h.worker.settlement.commitExport(input), deleteLesson(ctx, lessonId)]);
      expect(commit.status, `iteration ${i}`).toBe("fulfilled");
      if (del.status === "rejected") expect(await code(Promise.reject(del.reason))).toBe("LESSON_BUSY");
      const exp = await h.exportRow(exportId);
      expect(exp.state).toBe(del.status === "fulfilled" ? "retired" : "succeeded");
      expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
      expect(await h.reservationRow(jobId)).toMatchObject({ state: "consumed" });
    }
  });

  it("delete vs confirm of the same identity: whichever runs first, the outcome is consistent; a reused export is never pointed at an already deleted lesson", async () => {
    for (let i = 0; i < 12; i++) {
      const { ctx, d, exportId, lessonId } = await succeededExport();
      const [del, conf] = await Promise.allSettled([deleteLesson(ctx, lessonId), h.confirm(ctx, d)]);
      expect(del.status, `iteration ${i}`).toBe("fulfilled");
      expect(conf.status, `iteration ${i}`).toBe("fulfilled");
      const outcome = (conf as PromiseFulfilledResult<Awaited<ReturnType<typeof h.confirm>>>).value;
      const bucket = await h.bucket(ctx.userId);
      if (outcome.outcome === "reused") {
        // the confirm ran first, so the delete came after it
        expect(outcome.exportId).toBe(exportId);
        expect(bucket).toMatchObject({ used: 1, reserved: 0 });
      } else {
        expect(outcome.outcome).toBe("created"); // the delete ran first: the identity was free again
        expect(outcome.exportId).not.toBe(exportId);
        expect(bucket).toMatchObject({ used: 1, reserved: 1 });
      }
      expect(await h.exportRow(exportId)).toMatchObject({ state: "retired" });
      // no pending or succeeded export may sit on a deleted lesson
      expect(await h.count(`SELECT count(*) AS n FROM export e JOIN lesson l ON l.id = e.lesson_id WHERE e.owner_id = $1 AND e.state IN ('pending','succeeded') AND l.deleted_at IS NOT NULL`, [ctx.userId])).toBe(0);
      await h.abandonPending();
    }
  });

  it("delete vs cancel and delete vs sweep: either order ends consistent", async () => {
    for (let i = 0; i < 10; i++) {
      const { ctx, exportId, lessonId, jobId } = await pendingExport();
      const [cancel, del] = await Promise.allSettled([h.web.exports.cancelExport(ctx, exportId), deleteLesson(ctx, lessonId)]);
      expect(cancel.status).toBe("fulfilled");
      if (del.status === "rejected") expect(await code(Promise.reject(del.reason))).toBe("LESSON_BUSY");
      expect(await h.exportRow(exportId)).toMatchObject({ state: "failed" });
      expect(await h.reservationRow(jobId)).toMatchObject({ state: "released" });
      expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    }
    for (let i = 0; i < 10; i++) {
      const { ctx, exportId, lessonId, jobId } = await pendingExport();
      await h.claim(jobId);
      await h.admin.query(`UPDATE generation_job SET lease_expires_at = now() - interval '1 minute', attempt = max_attempts WHERE id = $1`, [jobId]);
      const [sweep, del] = await Promise.allSettled([h.worker.jobs.sweep(), deleteLesson(ctx, lessonId)]);
      expect(sweep.status).toBe("fulfilled");
      if (del.status === "rejected") expect(await code(Promise.reject(del.reason))).toBe("LESSON_BUSY");
      await h.worker.jobs.sweep();
      expect(await h.exportRow(exportId)).toMatchObject({ state: "failed" });
      expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
      // deleted_at is set exactly when the delete was accepted
      expect((await lessonRow(lessonId)).deleted_at === null).toBe(del.status === "rejected");
    }
  });
});
