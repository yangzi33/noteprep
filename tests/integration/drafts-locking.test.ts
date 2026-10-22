import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { readDatasetDir } from "@/lib/curriculum/files";
import { domainErrorCode } from "@/lib/domain/errors";
import { exerciseIds } from "@/lib/package/draft-ops";
import { makeAuthedCtx, type AuthedCtx } from "@/lib/server/auth/context";
import { createWebDal } from "@/lib/server/dal";
import { loadDataset } from "@/lib/server/curriculum/load";
import { createDb } from "@/lib/server/db";
import { DEFAULT_LIMITS, type Limits } from "@/lib/server/limits";
import { pgErrorCode, pools } from "./helpers";

// Lock order, lock timeouts, database-clock expiry, the lifetime cap and the freeze guard (S3 review fixes).
// Global order of every draft write: profile (createDraft) -> draft row -> counter rows -> version row(s).

const info = inject("testDb");
const { admin, app, worker } = pools();
const ownerDb = createDb(info.adminUrl);
const appDb = createDb(info.appUrl);

const SAMPLE: Dataset = readDatasetDir(path.join(__dirname, "../../data/curricula/sample-math/sample-1"));
const versionId = SAMPLE.meta.version.id;
const TOPIC = `${versionId}/level-a/course-1/equations/both-sides`;

const dalWith = (over: Partial<Limits> = {}, clock?: () => Date) => createWebDal(appDb, { curriculum: { allowSample: true }, drafts: { limits: { ...DEFAULT_LIMITS, ...over }, ...(clock ? { clock } : {}) } });
const web = dalWith();

beforeAll(async () => {
  await loadDataset(ownerDb, SAMPLE, { allowSample: true });
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end(), worker.end(), ownerDb.$disconnect(), appDb.$disconnect()]);
});

const request = () => ({ requestVersion: 2, curriculum: { versionId, topicId: TOPIC }, durationMinutes: 60, difficulty: "mixed", documents: ["notes", "worksheet", "solutions"], templateId: "classic", locale: "en" });
async function account(w = web) {
  const ctx = makeAuthedCtx(randomUUID());
  await w.account.ensureAccount(ctx);
  return ctx;
}
async function newDraft(ctx: AuthedCtx, w = web) {
  const { draft } = await w.drafts.createDraft(ctx, request(), `key-${randomUUID()}`);
  return { draftId: draft.draftId, versionId: draft.versionId };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function code(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (e) {
    return domainErrorCode(e);
  }
}
/** Deadlocks the server has detected in this database (stats are flushed about once a second, hence the wait). */
async function deadlocks() {
  await sleep(1300);
  await admin.query(`SELECT pg_stat_clear_snapshot()`);
  return Number((await admin.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).rows[0].deadlocks);
}
/** Holds the draft row lock from a separate connection until `release()`. */
async function holdDraft(draftId: string, mode = "UPDATE") {
  const c = await admin.connect();
  await c.query("BEGIN");
  await c.query(`SELECT 1 FROM draft WHERE id = $1 FOR ${mode}`, [draftId]);
  return {
    async release() {
      await c.query("COMMIT");
      c.release();
    },
  };
}
const draftRow = async (draftId: string) => (await admin.query(`SELECT rev, version_count, active_version_id, expires_at, created_at FROM draft WHERE id = $1`, [draftId])).rows[0];

describe("lock order: draft row first, then version rows", () => {
  it("switchVersion to v1 and removeQuestion on v1, both queued behind the draft lock, both succeed with no deadlock", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const made = await web.drafts.createVersion(ctx, d.draftId, 1); // active = v2, draft rev 2
    const v1 = await web.drafts.getDraftView(ctx, d.draftId, d.versionId);
    const before = await deadlocks();
    const held = await holdDraft(d.draftId);
    const t0 = Date.now();
    const sw = web.drafts.switchVersion(ctx, d.draftId, d.versionId, made.draftRev);
    const rm = dalWith().drafts.removeQuestion(ctx, d.draftId, d.versionId, v1.rev, exerciseIds(v1.package)[0]!);
    await sleep(500); // both are now waiting
    await held.release();
    const results = await Promise.allSettled([sw, rm]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(Date.now() - t0).toBeLessThan(1500); // a deadlock is only detected after deadlock_timeout (1 s) and retried
    expect(await deadlocks()).toBe(before);
    expect(await draftRow(d.draftId)).toMatchObject({ rev: 3, active_version_id: d.versionId });
  });

  it("randomised mix of switchVersion, createVersion and question operations on the same draft: no deadlock, only typed refusals", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const allowed = new Set(["DRAFT_CONFLICT", "CANDIDATE_STALE", "ADJUSTMENT_MIN_COUNT", "NOTHING_TO_UNDO", "QUESTION_NOT_FOUND", "VERSION_LIMIT"]);
    const before = await deadlocks();
    let created = 1;
    for (let round = 0; round < 12; round++) {
      const list = await web.drafts.listVersions(ctx, d.draftId);
      const view = await web.drafts.getDraftView(ctx, d.draftId);
      const target = list[rnd(list.length)]!;
      const tv = await web.drafts.getDraftView(ctx, d.draftId, target.versionId);
      const ids = exerciseIds(tv.package);
      const ops: Promise<unknown>[] = [web.drafts.switchVersion(ctx, d.draftId, target.versionId, view.draftRev)];
      ops.push(dalWith().drafts.requestCandidate(ctx, d.draftId, target.versionId, tv.rev, ids[rnd(ids.length)]!));
      ops.push(dalWith().drafts.removeQuestion(ctx, d.draftId, target.versionId, tv.rev, ids[rnd(ids.length)]!));
      if (rnd(3) === 0 && created < 5) ops.push(dalWith().drafts.createVersion(ctx, d.draftId, view.draftRev));
      ops.push(dalWith().drafts.undo(ctx, d.draftId, target.versionId, tv.rev));
      for (const r of await Promise.allSettled(ops)) {
        if (r.status === "rejected") expect(allowed, String((r.reason as Error).message)).toContain(domainErrorCode(r.reason));
      }
      created = (await web.drafts.listVersions(ctx, d.draftId)).length;
    }
    expect(await deadlocks()).toBe(before);
  });
});

describe("lock timeout", () => {
  it("an operation waiting on a held draft row fails with DRAFT_BUSY after the configured time and rolls back; the next attempt succeeds", async () => {
    const busy = dalWith({ draftLockTimeoutMs: 300 });
    const ctx = await account(busy);
    const d = await newDraft(ctx, busy);
    const v = await busy.drafts.getDraftView(ctx, d.draftId);
    const held = await holdDraft(d.draftId);
    for (const run of [
      () => busy.drafts.createVersion(ctx, d.draftId, v.draftRev),
      () => busy.drafts.switchVersion(ctx, d.draftId, d.versionId, v.draftRev),
      () => busy.drafts.removeQuestion(ctx, d.draftId, d.versionId, v.rev, exerciseIds(v.package)[0]!),
    ]) {
      const t0 = Date.now();
      expect(await code(run())).toBe("DRAFT_BUSY");
      expect(Date.now() - t0).toBeLessThan(2500);
    }
    await held.release();
    expect((await admin.query(`SELECT count(*)::int AS n FROM draft_version WHERE draft_id = $1`, [d.draftId])).rows[0].n).toBe(1);
    expect((await draftRow(d.draftId)).rev).toBe(1);
    await busy.drafts.removeQuestion(ctx, d.draftId, d.versionId, v.rev, exerciseIds(v.package)[0]!);
    await busy.drafts.createVersion(ctx, d.draftId, v.draftRev);
  });

  it("a version row held by someone else also times out as DRAFT_BUSY, not a hang", async () => {
    const busy = dalWith({ draftLockTimeoutMs: 300 });
    const ctx = await account(busy);
    const d = await newDraft(ctx, busy);
    const v = await busy.drafts.getDraftView(ctx, d.draftId);
    const c = await admin.connect();
    await c.query("BEGIN");
    await c.query(`SELECT 1 FROM draft_version WHERE id = $1 FOR UPDATE`, [d.versionId]);
    expect(await code(busy.drafts.removeQuestion(ctx, d.draftId, d.versionId, v.rev, exerciseIds(v.package)[0]!))).toBe("DRAFT_BUSY");
    await c.query("COMMIT");
    c.release();
  });
});

describe("expiry is decided by the database clock", () => {
  it("a draft 5 s past due by database time is expired even when the application clock is 60 s behind", async () => {
    const skewed = dalWith({}, () => new Date(Date.now() - 60_000));
    const ctx = await account(skewed);
    const d = await newDraft(ctx, skewed);
    const v = await skewed.drafts.getDraftView(ctx, d.draftId);
    await admin.query(`UPDATE draft SET expires_at = now() - interval '5 seconds' WHERE id = $1`, [d.draftId]);
    const before = await draftRow(d.draftId);
    expect(await code(skewed.drafts.createVersion(ctx, d.draftId, v.draftRev))).toBe("DRAFT_EXPIRED");
    expect(await code(skewed.drafts.switchVersion(ctx, d.draftId, d.versionId, v.draftRev))).toBe("DRAFT_EXPIRED");
    expect(await code(skewed.drafts.removeQuestion(ctx, d.draftId, d.versionId, v.rev, exerciseIds(v.package)[0]!))).toBe("DRAFT_EXPIRED");
    expect(await draftRow(d.draftId)).toEqual(before);
  });
});

describe("sliding expiry has a hard cap (draftMaxLifetimeDays)", () => {
  it("touching never extends past created_at + cap, and an operation at the cap works until actual expiry", async () => {
    const capped = dalWith({ draftTtlDays: 3, draftMaxLifetimeDays: 10 });
    const ctx = await account(capped);
    const d = await newDraft(ctx, capped);
    await admin.query(`UPDATE draft SET created_at = now() - interval '9 days', expires_at = now() + interval '12 hours' WHERE id = $1`, [d.draftId]);
    const capAt = async () => Number((await admin.query(`SELECT extract(epoch FROM (created_at + interval '10 days' - expires_at)) AS d FROM draft WHERE id = $1`, [d.draftId])).rows[0].d);
    let v = await capped.drafts.getDraftView(ctx, d.draftId);
    let rev = v.rev;
    for (let i = 0; i < 3; i++) {
      rev = (await capped.drafts.removeQuestion(ctx, d.draftId, d.versionId, rev, exerciseIds((await capped.drafts.getDraftView(ctx, d.draftId)).package)[0]!)).rev; // slides, capped
      expect(Math.abs(await capAt())).toBeLessThan(1); // expires_at == created_at + 10 days
    }
    const made = await capped.drafts.createVersion(ctx, d.draftId, v.draftRev);
    expect(Math.abs(await capAt())).toBeLessThan(1);
    await capped.drafts.switchVersion(ctx, d.draftId, d.versionId, made.draftRev);
    expect(Math.abs(await capAt())).toBeLessThan(1);
    // past the cap already (config lowered): the expiry is never shortened by a touch, the operation still works
    await admin.query(`UPDATE draft SET created_at = now() - interval '20 days', expires_at = now() + interval '1 hour' WHERE id = $1`, [d.draftId]);
    const before = await draftRow(d.draftId);
    v = await capped.drafts.getDraftView(ctx, d.draftId);
    await capped.drafts.removeQuestion(ctx, d.draftId, d.versionId, v.rev, exerciseIds(v.package)[0]!).catch((e) => expect(domainErrorCode(e)).toBe("ADJUSTMENT_MIN_COUNT"));
    expect((await draftRow(d.draftId)).expires_at.getTime()).toBe(before.expires_at.getTime());
    // and after actual expiry everything is refused
    await admin.query(`UPDATE draft SET expires_at = now() - interval '1 second' WHERE id = $1`, [d.draftId]);
    expect(await code(capped.drafts.switchVersion(ctx, d.draftId, d.versionId, v.draftRev))).toBe("DRAFT_EXPIRED");
  });
});

describe("draft guard: an expired or past-due draft is frozen (migration draft_guard_freeze)", () => {
  it("app_runtime cannot change rev, pointer or version_count of a past-due draft; active drafts work; the worker can still mark it expired", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const made = await web.drafts.createVersion(ctx, d.draftId, 1);
    // active: normal moves pass as app_runtime
    await app.query(`UPDATE draft SET rev = rev + 1, active_version_id = $2 WHERE id = $1`, [d.draftId, d.versionId]);
    await app.query(`UPDATE draft SET version_count = version_count WHERE id = $1`, [d.draftId]);
    await admin.query(`UPDATE draft SET expires_at = now() - interval '1 minute' WHERE id = $1`, [d.draftId]);
    const before = await draftRow(d.draftId);
    expect(await pgErrorCode(() => app.query(`UPDATE draft SET rev = rev + 1 WHERE id = $1`, [d.draftId]))).toBe("55000");
    expect(await pgErrorCode(() => app.query(`UPDATE draft SET active_version_id = $2 WHERE id = $1`, [d.draftId, made.versionId]))).toBe("55000");
    expect(await pgErrorCode(() => app.query(`UPDATE draft SET version_count = version_count + 1 WHERE id = $1`, [d.draftId]))).toBe("55000");
    expect(await draftRow(d.draftId)).toEqual(before);
    // the sweeper's status-only mark is unaffected
    await worker.query(`UPDATE draft SET status = 'expired'::draft_status, updated_at = now() WHERE id = $1`, [d.draftId]);
    expect((await admin.query(`SELECT status::text AS s FROM draft WHERE id = $1`, [d.draftId])).rows[0].s).toBe("expired");
    // expired: still frozen
    expect(await pgErrorCode(() => app.query(`UPDATE draft SET rev = rev + 1 WHERE id = $1`, [d.draftId]))).toBe("55000");
    // purge (cascade delete) is unaffected
    await admin.query(`UPDATE draft SET expires_at = now() - interval '30 days' WHERE id = $1`, [d.draftId]).catch(() => undefined);
    await worker.query(`DELETE FROM draft WHERE id = $1`, [d.draftId]);
    expect((await admin.query(`SELECT count(*)::int AS n FROM draft_version WHERE draft_id = $1`, [d.draftId])).rows[0].n).toBe(0);
  });
});
