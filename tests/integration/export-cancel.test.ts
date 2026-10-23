import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { code, createHarness, type Harness } from "./export-helpers";

let h: Harness;
let off: Harness["web"]; // the same database, EXPORT_ENABLED off
beforeAll(async () => {
  h = await createHarness();
  const { createWebDal } = await import("@/lib/server/dal");
  off = createWebDal(h.appDb, { curriculum: { allowSample: true }, exports: { enabled: false, limits: h.limits } });
});
afterEach(async () => {
  await h.expectNoDrift();
  await h.abandonPending();
});
afterAll(async () => {
  await h.close();
});

async function newExport() {
  const ctx = await h.account();
  const d = await h.newDraft(ctx);
  const r = await h.confirm(ctx, d);
  return { ctx, d, ...r };
}

describe("cancelExport", () => {
  it("cancels a queued export at once: job canceled, export failed(canceled), reservation released, allowance back", async () => {
    const { ctx, exportId, jobId } = await newExport();
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
    const job = await h.web.exports.cancelExport(ctx, exportId);
    expect(job).toMatchObject({ state: "canceled", cancelRequested: true });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "canceled" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released", settle_reason: "canceled" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect(await h.web.exports.getExportStatus(ctx, exportId)).toMatchObject({ state: "failed", reservation: { state: "released" }, job: { state: "canceled", errorCode: "canceled" } });
    // idempotent
    expect(await h.web.exports.cancelExport(ctx, exportId)).toMatchObject({ state: "canceled" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("works with EXPORT_ENABLED off (rollback needs it), and so does the status read", async () => {
    const { ctx, exportId, jobId } = await newExport();
    expect(await code(off.exports.confirmExport(ctx, { draftId: randomUUID(), versionId: randomUUID(), expectedRev: 1, expectedContentHash: "x" }, "k".repeat(16)))).toBe("EXPORT_DISABLED");
    expect(await off.exports.getExportStatus(ctx, exportId)).toMatchObject({ state: "pending" });
    expect(await off.exports.cancelExport(ctx, exportId)).toMatchObject({ state: "canceled" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released" });
    expect(await off.exports.getExportStatus(ctx, exportId)).toMatchObject({ state: "failed" });
  });

  it("a running export is only flagged: the lease path settles it, and the reservation stays held meanwhile", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const token = await h.claim(jobId);
    const job = await h.web.exports.cancelExport(ctx, exportId);
    expect(job).toMatchObject({ state: "running", cancelRequested: true });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "reserved" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
    expect(await h.web.exports.getExportStatus(ctx, exportId)).toMatchObject({ state: "pending", job: { cancelRequested: true, state: "running" } });
    // the worker notices at its next heartbeat and finishes the job as canceled
    await h.worker.settlement.finishJob({ jobId, fencingToken: token, outcome: "canceled", errorCode: "canceled" });
    expect(await h.reservationRow(jobId)).toMatchObject({ state: "released" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("a finished export is unchanged by cancel and consumed allowance is not given back", async () => {
    const { ctx, exportId, jobId } = await newExport();
    await h.complete(jobId);
    expect(await h.web.exports.cancelExport(ctx, exportId)).toMatchObject({ state: "succeeded" });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "succeeded" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
  });

  it("another user, a malformed id and an unknown id are all NOT_FOUND and change nothing", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const mallory = await h.account();
    const before = { j: await h.jobRow(jobId), r: await h.reservationRow(jobId), b: await h.bucket(ctx.userId) };
    expect(await code(h.web.exports.cancelExport(mallory, exportId))).toBe("NOT_FOUND");
    expect(await code(h.web.exports.cancelExport(mallory, jobId))).toBe("NOT_FOUND"); // a job id is not an export id
    expect(await code(h.web.exports.cancelExport(ctx, jobId))).toBe("NOT_FOUND");
    expect(await code(h.web.exports.cancelExport(mallory, "nope"))).toBe("NOT_FOUND");
    expect(await code(h.web.exports.cancelExport(mallory, randomUUID()))).toBe("NOT_FOUND");
    expect({ j: await h.jobRow(jobId), r: await h.reservationRow(jobId), b: await h.bucket(ctx.userId) }).toEqual(before);
    expect((await h.web.exports.getExportStatus(ctx, exportId)).job.state).toBe("queued");
  });

  it("generation.cancelJob still cancels an export job through the shared path (behaviour unchanged)", async () => {
    const { ctx, exportId, jobId } = await newExport();
    expect(await h.web.generation.cancelJob(ctx, jobId)).toMatchObject({ state: "canceled" });
    expect(await h.exportRow(exportId)).toMatchObject({ state: "failed", failure_code: "canceled" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });
});

describe("findExportIdByJob", () => {
  it("returns the export of the caller's job, and null for anyone else, a non-export job or garbage", async () => {
    const { ctx, exportId, jobId } = await newExport();
    const mallory = await h.account();
    expect(await h.web.exports.findExportIdByJob(ctx, jobId)).toBe(exportId);
    expect(await h.web.exports.findExportIdByJob(mallory, jobId)).toBeNull();
    expect(await h.web.exports.findExportIdByJob(ctx, randomUUID())).toBeNull();
    expect(await h.web.exports.findExportIdByJob(ctx, "nope")).toBeNull();
    const { job } = await h.web.generation.createGeneration(ctx, { topic: "linear_equations_one_variable", level: "Grade 7-8 equivalent", objectives: ["Solve ax + b = c"], durationMinutes: 60, difficulty: "mixed", questionCount: 5 }, `key-${randomUUID()}`);
    expect(await h.web.exports.findExportIdByJob(ctx, job.id)).toBeNull();
    await h.web.generation.cancelJob(ctx, job.id);
  });
});

describe("getExportStatus owner isolation", () => {
  it("is NOT_FOUND for another user and carries no snapshot, key or job id", async () => {
    const { ctx, exportId } = await newExport();
    const mallory = await h.account();
    expect(await code(h.web.exports.getExportStatus(mallory, exportId))).toBe("NOT_FOUND");
    const dto = await h.web.exports.getExportStatus(ctx, exportId);
    expect(JSON.stringify(dto)).not.toMatch(/snapshot|exportKey|jobId|path/i);
  });
});
