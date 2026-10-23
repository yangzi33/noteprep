import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RenderError } from "@/lib/latex/escape";
import { exerciseIds } from "@/lib/package/draft-ops";
import { buildExportSpec, contentKey, exportKey, renderForExport } from "@/lib/domain/export-spec";
import { code, createHarness, freshKey, sleep, type Harness } from "./export-helpers";

const flags = vi.hoisted(() => ({ forceUnverified: false, renderThrows: null as string | null }));
// Lets a test make the (real) validator report "failed" or the (real) renderer refuse, only around a confirmExport call.
vi.mock("@/lib/package/validate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/package/validate")>();
  return { ...real, validatePackage: (pkg: unknown) => (flags.forceUnverified ? { ...real.validatePackage(pkg), overall: "failed" as const } : real.validatePackage(pkg)) };
});
vi.mock("@/lib/latex/render", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/latex/render")>();
  const { RenderError: RE } = await import("@/lib/latex/escape");
  return {
    ...real,
    renderDocument: (pkg: Parameters<typeof real.renderDocument>[0], id: Parameters<typeof real.renderDocument>[1]) => {
      if (flags.renderThrows) throw new RE(flags.renderThrows);
      return real.renderDocument(pkg, id);
    },
  };
});

let h: Harness;
let same: Harness; // drafts with a fixed seed: identical content across drafts
beforeAll(async () => {
  h = await createHarness();
});
afterEach(async () => {
  flags.forceUnverified = false;
  flags.renderThrows = null;
  await h.expectNoDrift();
  await h.abandonPending();
});
afterAll(async () => {
  await h.close();
  if (same) await same.close();
});

describe("drafts are free; confirm reserves exactly one unit", () => {
  it("creating, adjusting and versioning drafts never touches the allowance, jobs or exports", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const view = await h.web.drafts.getDraftView(ctx, d.draftId);
    await h.web.drafts.removeQuestion(ctx, d.draftId, d.versionId, d.rev, exerciseIds(view.package)[0]!);
    await h.web.drafts.createVersion(ctx, d.draftId, view.draftRev);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect(await h.count(`SELECT count(*) AS n FROM generation_job WHERE owner_id = $1`, [ctx.userId])).toBe(0);
    expect(await h.count(`SELECT count(*) AS n FROM export WHERE owner_id = $1`, [ctx.userId])).toBe(0);
    expect(await h.count(`SELECT count(*) AS n FROM export_snapshot WHERE owner_id = $1`, [ctx.userId])).toBe(0);
  });

  it("creates snapshot, lesson shell, export job, export and reservation in one transaction; reserves but never consumes", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const key = freshKey();
    const r = await h.confirm(ctx, d, key);
    expect(r.outcome).toBe("created");
    const exp = await h.exportRow(r.exportId);
    const job = await h.jobRow(r.jobId);
    const reservation = await h.reservationRow(r.jobId);
    expect(exp).toMatchObject({ owner_id: ctx.userId, state: "pending", job_id: r.jobId, lesson_id: r.lessonId, revision_id: null, failure_code: null });
    expect(job).toMatchObject({ kind: "export", state: "queued", owner_id: ctx.userId, lesson_id: r.lessonId, request_hash: exp.export_key, max_calls: 0, calls_used: 0, attempt: 0 });
    expect(BigInt(job.max_tokens)).toBe(0n);
    expect(BigInt(job.max_cost_micros)).toBe(0n);
    expect(job.max_attempts).toBe(h.limits.exportMaxAttempts);
    const deadlineMs = new Date(job.deadline_at).getTime() - Date.now();
    expect(deadlineMs).toBeGreaterThan((h.limits.exportDeadlineMinutes - 1) * 60_000);
    expect(deadlineMs).toBeLessThanOrEqual(h.limits.exportDeadlineMinutes * 60_000 + 2_000);
    expect(reservation).toMatchObject({ state: "reserved", owner_id: ctx.userId });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
    const snap = (await h.admin.query(`SELECT * FROM export_snapshot WHERE id = $1`, [exp.snapshot_id])).rows[0];
    expect(snap).toMatchObject({ owner_id: ctx.userId, draft_id: d.draftId, draft_version_id: d.versionId, draft_version_rev: d.rev, package_hash: d.contentHash, export_key: exp.export_key, validator_version: expect.any(String) });
    expect(snap.spec).toMatchObject({ v: 1, documents: ["notes", "worksheet", "solutions"], locale: "en", pageFormat: "letter", templateVersion: "classic/2", renderVersion: "render/1" });
    expect(Object.keys(snap.tex_sha256).sort()).toEqual(["notes", "solutions", "worksheet"]);
    expect(snap.validation_report.overall).toBe("verified");
    expect(snap.content.request.documents).toEqual(["notes", "worksheet", "solutions"]); // the FULL package, request and context included
    expect(snap.content.context.topic.title).toBeTruthy();
    // the key the DAL stored is the pure function of the stored snapshot
    const spec = snap.spec;
    expect(exportKey(spec, snap.tex_sha256)).toBe(snap.export_key);
    expect(contentKey(spec, snap.tex_sha256)).toBe(snap.content_key);
    const lesson = (await h.admin.query(`SELECT * FROM lesson WHERE id = $1`, [r.lessonId])).rows[0];
    expect(lesson).toMatchObject({ owner_id: ctx.userId, request_version: 2, curriculum_version_id: snap.content.context.curriculum.version.id, topic_id: snap.content.context.topic.id, current_revision_id: null });
    expect(lesson.title).toBe(snap.content.context.topic.title);
    const idem = (await h.admin.query(`SELECT * FROM idempotency_key WHERE owner_id = $1 AND operation = 'export.confirm' AND key = $2`, [ctx.userId, key])).rows[0];
    expect(idem).toMatchObject({ resource_type: "export", resource_id: r.exportId });
  });

  it("is refused with EXPORT_DISABLED when the flag is off, before anything is touched", async () => {
    const off = await createHarness({ enabled: false });
    try {
      const ctx = await off.account();
      const d = await off.newDraft(ctx);
      expect(await code(off.confirm(ctx, d))).toBe("EXPORT_DISABLED");
      expect(await off.count(`SELECT count(*) AS n FROM idempotency_key WHERE owner_id = $1 AND operation = 'export.confirm'`, [ctx.userId])).toBe(0);
      expect(await off.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    } finally {
      await off.close();
    }
  });

  it("the status shows the live state, and 'not used' is knowable only from a released reservation", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const r = await h.confirm(ctx, d);
    let status = await h.web.exports.getExportStatus(ctx, r.exportId);
    expect(status).toMatchObject({ exportId: r.exportId, state: "pending", lessonId: r.lessonId, revisionId: null, job: { state: "queued", stage: null, attempt: 0, cancelRequested: false, errorCode: null }, reservation: { state: "reserved" } });
    expect(status.deadlineAt).toBeInstanceOf(Date);
    await h.fail(r.jobId, "compile_failed");
    status = await h.web.exports.getExportStatus(ctx, r.exportId);
    expect(status).toMatchObject({ state: "failed", job: { state: "failed", errorCode: "compile_failed" }, reservation: { state: "released" } });
  });
});

describe("the tutor pays for exactly what was seen", () => {
  it("a change between view and confirm gives EXPORT_CONFLICT and reserves nothing", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const view = await h.web.drafts.getDraftView(ctx, d.draftId);
    await h.web.drafts.removeQuestion(ctx, d.draftId, d.versionId, d.rev, exerciseIds(view.package)[0]!);
    expect(await code(h.confirm(ctx, d))).toBe("EXPORT_CONFLICT");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect(await h.count(`SELECT count(*) AS n FROM export WHERE owner_id = $1`, [ctx.userId])).toBe(0);
    // a refusal leaves no idempotency record either: the same key may be used again with the fresh page
    const fresh = await h.viewRef(ctx, d.draftId, d.versionId);
    expect((await h.confirm(ctx, fresh)).outcome).toBe("created");
  });

  it("a wrong revision or a wrong content hash alone is also a conflict", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    expect(await code(h.confirm(ctx, { ...d, rev: d.rev + 1 }))).toBe("EXPORT_CONFLICT");
    expect(await code(h.confirm(ctx, { ...d, contentHash: "sha256:" + "0".repeat(64) }))).toBe("EXPORT_CONFLICT");
    expect(await h.bucket(ctx.userId)).toMatchObject({ reserved: 0 });
  });

  it("an unverified package can never be exported: EXPORT_NOT_VERIFIED, nothing reserved", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    flags.forceUnverified = true;
    expect(await code(h.confirm(ctx, d))).toBe("EXPORT_NOT_VERIFIED");
    flags.forceUnverified = false;
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect(await h.count(`SELECT count(*) AS n FROM export_snapshot WHERE owner_id = $1`, [ctx.userId])).toBe(0);
  });

  it("a package the renderer refuses gives EXPORT_RENDER_FAILED and costs nothing", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    flags.renderThrows = "text_too_long";
    const err = await h.confirm(ctx, d).catch((e) => e);
    expect(err).toMatchObject({ code: "EXPORT_RENDER_FAILED", reason: "text_too_long" });
    expect(RenderError).toBeDefined();
    flags.renderThrows = null;
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("the draft must be live: an expired draft gives DRAFT_EXPIRED, an unknown one NOT_FOUND", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    await h.admin.query(`UPDATE draft SET expires_at = now() - interval '1 minute' WHERE id = $1`, [d.draftId]);
    expect(await code(h.confirm(ctx, d))).toBe("DRAFT_EXPIRED");
    expect(await code(h.confirm(ctx, { ...d, draftId: randomUUID() }))).toBe("NOT_FOUND");
    expect(await code(h.confirm(ctx, { ...d, versionId: randomUUID() }))).toBe("NOT_FOUND");
    expect(await code(h.confirm(ctx, { ...d, draftId: "not-a-uuid" }))).toBe("NOT_FOUND");
    expect(await h.bucket(ctx.userId)).toMatchObject({ reserved: 0 });
  });

  it("a draft that expires between the pre-read and the transaction is caught by the database-clock re-check", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    // The app clock is far in the past, so the pre-transaction check passes; the database clock says expired.
    const slow = await createHarness({ clock: () => new Date(Date.now() - 365 * 86_400_000) });
    try {
      await h.admin.query(`UPDATE draft SET expires_at = now() - interval '1 minute' WHERE id = $1`, [d.draftId]);
      expect(await code(slow.confirm(ctx, d))).toBe("DRAFT_EXPIRED");
      expect(await h.bucket(ctx.userId)).toMatchObject({ reserved: 0 });
    } finally {
      await slow.close();
    }
  });

  it("malformed arguments are InvalidRequest", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    expect(await code(h.confirm(ctx, d, "short"))).toBe("INVALID_REQUEST");
    expect(await code(h.confirm(ctx, { ...d, rev: 0 }))).toBe("INVALID_REQUEST");
    expect(await code(h.confirm(ctx, { ...d, contentHash: "" }))).toBe("INVALID_REQUEST");
  });

  it("an account that is not active cannot export", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    await h.admin.query(`UPDATE profile SET status = 'deleting' WHERE id = $1`, [ctx.userId]);
    expect(await code(h.confirm(ctx, d))).toBe("ACCOUNT_NOT_ACTIVE");
    await h.admin.query(`UPDATE profile SET status = 'active' WHERE id = $1`, [ctx.userId]);
  });
});

describe("double click, equivalent exports and reuse", () => {
  it("ten parallel confirms with ONE key: one export, one reserved unit, nine replays", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const key = freshKey();
    const results = await Promise.all(Array.from({ length: 10 }, () => h.confirm(ctx, d, key)));
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "replayed")).toHaveLength(9);
    expect(new Set(results.map((r) => r.exportId)).size).toBe(1);
    expect(await h.count(`SELECT count(*) AS n FROM export WHERE owner_id = $1`, [ctx.userId])).toBe(1);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
  });

  it("ten parallel confirms with TEN keys for the same content: one export, the others join it", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const results = await Promise.all(Array.from({ length: 10 }, () => h.confirm(ctx, d)));
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "joined")).toHaveLength(9);
    expect(new Set(results.map((r) => r.exportId)).size).toBe(1);
    expect(await h.count(`SELECT count(*) AS n FROM export WHERE owner_id = $1`, [ctx.userId])).toBe(1);
    expect(await h.count(`SELECT count(*) AS n FROM export_snapshot WHERE owner_id = $1`, [ctx.userId])).toBe(1);
    expect(await h.count(`SELECT count(*) AS n FROM idempotency_key WHERE owner_id = $1 AND operation = 'export.confirm'`, [ctx.userId])).toBe(10);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
  });

  it("two different drafts and versions that render to the same source are one export (joined)", async () => {
    same ??= await createHarness({ fixedSeed: "fixed-seed" });
    const ctx = await same.account();
    const a = await same.newDraft(ctx);
    const b = await same.newDraft(ctx);
    expect(a.draftId).not.toBe(b.draftId);
    expect(a.contentHash).toBe(b.contentHash);
    const first = await same.confirm(ctx, a);
    const second = await same.confirm(ctx, b);
    expect(second).toMatchObject({ outcome: "joined", exportId: first.exportId });
    expect(await same.bucket(ctx.userId)).toMatchObject({ reserved: 1 });
    await same.abandonPending();
  });

  it("another version, another document set or another difficulty is another export with its own key", async () => {
    const ctx = await h.account(10);
    const base = await h.newDraft(ctx);
    const view = await h.web.drafts.getDraftView(ctx, base.draftId);
    const made = await h.web.drafts.createVersion(ctx, base.draftId, view.draftRev);
    const v2 = await h.viewRef(ctx, base.draftId, made.versionId);
    const subset = await h.newDraft(ctx, { documents: ["worksheet"] });
    const hard = await h.newDraft(ctx, { difficulty: "challenge" });
    const outcomes = [];
    for (const d of [base, v2, subset, hard]) outcomes.push(await h.confirm(ctx, d));
    expect(outcomes.map((o) => o.outcome)).toEqual(["created", "created", "created", "created"]);
    const keys = (await h.exportsOf(ctx.userId)).map((e) => e.export_key);
    expect(new Set(keys).size).toBe(4);
    expect(await h.bucket(ctx.userId)).toMatchObject({ reserved: 4 });
  });

  it("a succeeded export is reused for free, even with nothing left and past every limit", async () => {
    const ctx = await h.account(1);
    const d = await h.newDraft(ctx);
    const first = await h.confirm(ctx, d);
    await h.complete(first.jobId);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0, limit_count: 1 });
    const windowBefore = await h.count(`SELECT coalesce(sum(count), 0) AS n FROM rate_limit_window WHERE key = $1`, [`exp:u:${ctx.userId}`]);
    const again = await h.confirm(ctx, d);
    expect(again).toMatchObject({ outcome: "reused", exportId: first.exportId, jobId: first.jobId });
    // another draft has a random seed, so a different pack: it is NOT reusable, and with nothing left it is refused
    const other = await h.newDraft(ctx);
    expect(other.contentHash).not.toBe(d.contentHash);
    expect(await code(h.confirm(ctx, other))).toBe("ALLOWANCE_EXHAUSTED");
    expect(await h.count(`SELECT coalesce(sum(count), 0) AS n FROM rate_limit_window WHERE key = $1`, [`exp:u:${ctx.userId}`])).toBe(windowBefore);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
    expect(await h.count(`SELECT count(*) AS n FROM export WHERE owner_id = $1`, [ctx.userId])).toBe(1);
  });

  it("the last unit goes to exactly one of two different exports racing for it", async () => {
    for (let round = 0; round < 3; round++) {
      const ctx = await h.account(1);
      const [a, b] = [await h.newDraft(ctx), await h.newDraft(ctx)];
      const results = await Promise.allSettled([h.confirm(ctx, a), h.confirm(ctx, b)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: "ALLOWANCE_EXHAUSTED" });
      expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
      expect(await h.count(`SELECT count(*) AS n FROM export WHERE owner_id = $1`, [ctx.userId])).toBe(1);
    }
  });

  it("six distinct exports racing for two units: exactly two are created", async () => {
    const ctx = await h.account(2);
    const drafts = await Promise.all(Array.from({ length: 6 }, () => h.newDraft(ctx)));
    const results = await Promise.allSettled(drafts.map((d) => h.confirm(ctx, d)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "ALLOWANCE_EXHAUSTED" });
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 2 });
  });
});

describe("retry after failure", () => {
  it("a failed export leaves the live-key index: the same key replays the failed one, a new key makes a new export and reservation", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const key = freshKey();
    const first = await h.confirm(ctx, d, key);
    await h.fail(first.jobId, "storage_failed");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect(await h.exportRow(first.exportId)).toMatchObject({ state: "failed", failure_code: "storage_failed" });

    const replay = await h.confirm(ctx, d, key);
    expect(replay).toMatchObject({ outcome: "replayed", exportId: first.exportId });
    expect((await h.web.exports.getExportStatus(ctx, replay.exportId)).state).toBe("failed");
    expect(await h.bucket(ctx.userId)).toMatchObject({ reserved: 0 }); // replaying a failure reserves nothing

    const retry = await h.confirm(ctx, d, freshKey());
    expect(retry.outcome).toBe("created");
    expect(retry.exportId).not.toBe(first.exportId);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
    const rows = await h.exportsOf(ctx.userId);
    expect(rows.map((r) => r.state)).toEqual(["failed", "pending"]);
    expect(rows[0].export_key).toBe(rows[1].export_key);
  });

  it("three non-retryable failures of one export refuse the fourth try with EXPORT_UNAVAILABLE; retryable ones never count", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    for (let i = 0; i < 4; i++) {
      const r = await h.confirm(ctx, d);
      await h.fail(r.jobId, "storage_failed"); // transient: not memoised
    }
    for (let i = 0; i < 3; i++) {
      const r = await h.confirm(ctx, d);
      await h.fail(r.jobId, i === 0 ? "render_mismatch" : "compile_failed");
    }
    expect(await code(h.confirm(ctx, d))).toBe("EXPORT_UNAVAILABLE");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    // another draft (another key) is unaffected
    const other = await h.newDraft(ctx);
    expect((await h.confirm(ctx, other)).outcome).toBe("created");
  });

  it("failures older than 24 hours are forgotten", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    for (let i = 0; i < 3; i++) {
      const r = await h.confirm(ctx, d);
      await h.fail(r.jobId, "compile_failed");
    }
    expect(await code(h.confirm(ctx, d))).toBe("EXPORT_UNAVAILABLE");
    await h.admin.query(`ALTER TABLE export DISABLE TRIGGER export_guard`);
    try {
      await h.admin.query(`UPDATE export SET settled_at = now() - interval '25 hours' WHERE owner_id = $1`, [ctx.userId]);
    } finally {
      await h.admin.query(`ALTER TABLE export ENABLE TRIGGER export_guard`);
    }
    expect((await h.confirm(ctx, d)).outcome).toBe("created");
  });
});

describe("idempotency", () => {
  it("the same key with another request conflicts; nothing is reserved for it", async () => {
    const ctx = await h.account();
    const [a, b] = [await h.newDraft(ctx), await h.newDraft(ctx)];
    const key = freshKey();
    await h.confirm(ctx, a, key);
    expect(await code(h.confirm(ctx, b, key))).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await h.bucket(ctx.userId)).toMatchObject({ reserved: 1 });
  });

  it("a replay answers before any draft check, even after the draft changed, expired or was purged", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const key = freshKey();
    const first = await h.confirm(ctx, d, key);
    const view = await h.web.drafts.getDraftView(ctx, d.draftId);
    await h.web.drafts.removeQuestion(ctx, d.draftId, d.versionId, d.rev, exerciseIds(view.package)[0]!); // stale now
    expect(await h.confirm(ctx, d, key)).toMatchObject({ outcome: "replayed", exportId: first.exportId });
    await h.admin.query(`UPDATE draft SET expires_at = now() - interval '1 minute' WHERE id = $1`, [d.draftId]);
    expect(await h.confirm(ctx, d, key)).toMatchObject({ outcome: "replayed", exportId: first.exportId });
    await h.admin.query(`UPDATE draft SET status = 'expired' WHERE id = $1`, [d.draftId]);
    await h.workerDb.$executeRaw`DELETE FROM draft WHERE id = ${d.draftId}::uuid`; // the purge path
    expect(await h.confirm(ctx, d, key)).toMatchObject({ outcome: "replayed", exportId: first.exportId });
    // a NEW key for the purged draft is refused, and leaves no idempotency record
    const fresh = freshKey();
    expect(await code(h.confirm(ctx, d, fresh))).toBe("NOT_FOUND");
    expect(await h.count(`SELECT count(*) AS n FROM idempotency_key WHERE owner_id = $1 AND key = $2`, [ctx.userId, fresh])).toBe(0);
    // the export and its snapshot survive the draft (no foreign key to the draft tables)
    expect(await h.count(`SELECT count(*) AS n FROM export_snapshot WHERE id = $1`, [(await h.exportRow(first.exportId)).snapshot_id])).toBe(1);
  });

  it("a replay with the same key and a DIFFERENT request body conflicts even when the draft is gone", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const key = freshKey();
    await h.confirm(ctx, d, key);
    expect(await code(h.confirm(ctx, { ...d, rev: d.rev + 5 }, key))).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("limits apply only to the create path; refusals roll back", () => {
  it("exports per hour: joins, reuse and replays are not counted; a refused create leaves no trace", async () => {
    const lim = await createHarness({ limits: { exportsPerUserPerHour: 2 } });
    try {
      const ctx = await lim.account(50);
      const drafts = await Promise.all(Array.from({ length: 4 }, () => lim.newDraft(ctx)));
      const a = await lim.confirm(ctx, drafts[0]!);
      await lim.confirm(ctx, drafts[0]!); // joined, not counted
      await lim.confirm(ctx, drafts[0]!, "replay-key-12345").then(() => lim.confirm(ctx, drafts[0]!, "replay-key-12345"));
      await lim.confirm(ctx, drafts[1]!);
      const counter = async () => lim.count(`SELECT coalesce(sum(count), 0) AS n FROM rate_limit_window WHERE key = $1`, [`exp:u:${ctx.userId}`]);
      expect(await counter()).toBe(2);
      const refusedKey = freshKey();
      expect(await code(lim.confirm(ctx, drafts[2]!, refusedKey))).toBe("RATE_LIMITED");
      expect(await counter()).toBe(2); // the refused increment rolled back
      expect(await lim.count(`SELECT count(*) AS n FROM idempotency_key WHERE owner_id = $1 AND key = $2`, [ctx.userId, refusedKey])).toBe(0);
      expect(await lim.bucket(ctx.userId)).toMatchObject({ reserved: 2 });
      // the first export succeeds and is reused even though the hour is used up
      await lim.complete(a.jobId);
      expect((await lim.confirm(ctx, drafts[0]!)).outcome).toBe("reused");
    } finally {
      await lim.close();
    }
  });

  it("confirm attempts per hour: new keys are counted before prepare, refused ones too, and the count stays committed", async () => {
    const lim = await createHarness({ limits: { exportConfirmAttemptsPerUserPerHour: 3 } });
    try {
      const ctx = await lim.account();
      const d = await lim.newDraft(ctx);
      const counter = async () => lim.count(`SELECT coalesce(sum(count), 0) AS n FROM rate_limit_window WHERE key = $1`, [`exp:try:u:${ctx.userId}`]);
      const stale = { ...d, rev: d.rev + 7 };
      expect(await code(lim.confirm(ctx, stale))).toBe("EXPORT_CONFLICT"); // refused by prepare, still counted
      expect(await counter()).toBe(1);
      const okKey = freshKey();
      expect((await lim.confirm(ctx, d, okKey)).outcome).toBe("created");
      expect(await counter()).toBe(2);
      // a replay of a recorded key is never counted
      expect((await lim.confirm(ctx, d, okKey)).outcome).toBe("replayed");
      expect(await counter()).toBe(2);
      expect(await code(lim.confirm(ctx, stale))).toBe("EXPORT_CONFLICT");
      expect(await counter()).toBe(3);
      // limit reached: a confirm that WOULD conflict is refused by the limit instead (it runs before prepare)
      const refusedKey = freshKey();
      expect(await code(lim.confirm(ctx, stale, refusedKey))).toBe("RATE_LIMITED");
      expect(await counter()).toBe(4); // committed even though refused
      expect(await lim.count(`SELECT count(*) AS n FROM idempotency_key WHERE owner_id = $1 AND key = $2`, [ctx.userId, refusedKey])).toBe(0);
      // a replay still answers while the limit is exceeded
      expect((await lim.confirm(ctx, d, okKey)).outcome).toBe("replayed");
      expect(await counter()).toBe(4);
      expect(await lim.bucket(ctx.userId)).toMatchObject({ reserved: 1 });
    } finally {
      await lim.close();
    }
  });

  it("10 parallel confirms with the same key give one export and one reservation", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const key = freshKey();
    const results = await Promise.all(Array.from({ length: 10 }, () => h.confirm(ctx, d, key)));
    expect(new Set(results.map((r) => r.exportId)).size).toBe(1);
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect((await h.exportsOf(ctx.userId)).length).toBe(1);
    expect(await h.bucket(ctx.userId)).toMatchObject({ reserved: 1, used: 0 });
  });

  it("active export jobs per user", async () => {
    const lim = await createHarness({ limits: { exportConcurrencyPerUser: 1 } });
    try {
      const ctx = await lim.account();
      const [a, b] = [await lim.newDraft(ctx), await lim.newDraft(ctx)];
      await lim.confirm(ctx, a);
      expect(await code(lim.confirm(ctx, b))).toBe("TOO_MANY_ACTIVE_JOBS");
      expect(await lim.bucket(ctx.userId)).toMatchObject({ reserved: 1 });
      expect((await lim.confirm(ctx, a)).outcome).toBe("joined"); // joining is not a new job
    } finally {
      await lim.close();
    }
  });

  it("the global queued cap", async () => {
    const lim = await createHarness({ limits: { exportMaxQueuedGlobal: 1 } });
    try {
      await lim.parkForeignJobs(); // queued legacy jobs of other files would already fill the cap
      const [c1, c2] = [await lim.account(), await lim.account()];
      const [a, b] = [await lim.newDraft(c1), await lim.newDraft(c2)];
      await lim.confirm(c1, a); // exactly one queued job now
      const queued = await lim.count(`SELECT count(*) AS n FROM generation_job WHERE state = 'queued'`);
      expect(queued).toBe(1);
      expect(await code(lim.confirm(c2, b))).toBe("QUEUE_BUSY");
      expect(await lim.bucket(c2.userId)).toMatchObject({ reserved: 0 });
    } finally {
      await lim.close();
    }
  });
});

describe("no job lock, doomed exports, bounded waits", () => {
  it("confirm joins a pending export WITHOUT waiting for its job row lock (C2)", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const first = await h.confirm(ctx, d);
    const c = await h.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT 1 FROM generation_job WHERE id = $1 FOR UPDATE`, [first.jobId]);
      await c.query(`SELECT 1 FROM export WHERE id = $1 FOR UPDATE`, [first.exportId]);
      const t0 = Date.now();
      const joined = await h.confirm(ctx, d);
      expect(joined).toMatchObject({ outcome: "joined", exportId: first.exportId });
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("a pending export with a cancel request, or past its deadline and unswept, gives EXPORT_BUSY, never a join", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const first = await h.confirm(ctx, d);
    await h.admin.query(`UPDATE generation_job SET cancel_requested_at = now() WHERE id = $1`, [first.jobId]);
    const key = freshKey();
    expect(await code(h.confirm(ctx, d, key))).toBe("EXPORT_BUSY");
    expect(await h.count(`SELECT count(*) AS n FROM idempotency_key WHERE owner_id = $1 AND key = $2`, [ctx.userId, key])).toBe(0);
    await h.admin.query(`UPDATE generation_job SET cancel_requested_at = NULL, deadline_at = now() - interval '1 second' WHERE id = $1`, [first.jobId]);
    expect(await code(h.confirm(ctx, d))).toBe("EXPORT_BUSY");
    expect(await h.bucket(ctx.userId)).toMatchObject({ reserved: 1 });
    // after the sweeper recovers it, a retry creates a new export
    const report = await h.worker.jobs.sweep();
    expect(report.sweepRowErrors).toBe(0);
    expect((await h.confirm(ctx, d)).outcome).toBe("created");
  });

  it("a row lock that stays held beyond the lock timeout is EXPORT_BUSY (safe to retry)", async () => {
    const lim = await createHarness({ limits: { draftLockTimeoutMs: 100 } });
    try {
      const ctx = await lim.account();
      const d = await lim.newDraft(ctx);
      const c = await lim.admin.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT 1 FROM profile WHERE id = $1 FOR UPDATE`, [ctx.userId]);
        const t0 = Date.now();
        expect(await code(lim.confirm(ctx, d))).toBe("EXPORT_BUSY");
        expect(Date.now() - t0).toBeLessThan(2500);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
      expect((await lim.confirm(ctx, d)).outcome).toBe("created");
    } finally {
      await lim.close();
    }
  });

  it("the snapshot is frozen at confirm: later draft changes do not alter it", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const first = await h.confirm(ctx, d);
    const snapId = (await h.exportRow(first.exportId)).snapshot_id;
    const before = (await h.admin.query(`SELECT content, package_hash FROM export_snapshot WHERE id = $1`, [snapId])).rows[0];
    const view = await h.web.drafts.getDraftView(ctx, d.draftId);
    await h.web.drafts.removeQuestion(ctx, d.draftId, d.versionId, d.rev, exerciseIds(view.package)[0]!);
    const after = (await h.admin.query(`SELECT content, package_hash FROM export_snapshot WHERE id = $1`, [snapId])).rows[0];
    expect(after).toEqual(before);
    expect(after.package_hash).toBe(d.contentHash);
    // and the rendered source of what was frozen is what the key says
    const spec = buildExportSpec(before.content);
    expect(renderForExport(before.content, spec.documents)).toEqual((await h.admin.query(`SELECT tex_sha256 FROM export_snapshot WHERE id = $1`, [snapId])).rows[0].tex_sha256);
    await sleep(0);
  });
});
