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
import { pools } from "./helpers";

// Slice S3: versions, switching, revision-safe updates across tabs, sliding expiry, limits. Real Postgres, separate connections.

const info = inject("testDb");
const { admin } = pools();
const ownerDb = createDb(info.adminUrl);
const appDb = createDb(info.appUrl);

const SAMPLE: Dataset = readDatasetDir(path.join(__dirname, "../../data/curricula/sample-math/sample-1"));
const versionId = SAMPLE.meta.version.id;
const TOPIC = `${versionId}/level-a/course-1/equations/both-sides`;

const limitsWith = (over: Partial<Limits> = {}): Limits => ({ ...DEFAULT_LIMITS, ...over });
const dal = (over: Partial<Limits> = {}) => createWebDal(appDb, { curriculum: { allowSample: true }, drafts: { limits: limitsWith(over) } });
const web = dal();

beforeAll(async () => {
  await loadDataset(ownerDb, SAMPLE, { allowSample: true });
});
afterAll(async () => {
  await Promise.all([admin.end(), ownerDb.$disconnect(), appDb.$disconnect()]);
});

const request = () => ({
  requestVersion: 2,
  curriculum: { versionId, topicId: TOPIC },
  durationMinutes: 60,
  difficulty: "mixed",
  documents: ["notes", "worksheet", "solutions"],
  templateId: "classic",
  locale: "en",
});
async function account(w = web) {
  const ctx = makeAuthedCtx(randomUUID());
  await w.account.ensureAccount(ctx);
  return ctx;
}
async function newDraft(ctx: AuthedCtx, w = web) {
  const { draft } = await w.drafts.createDraft(ctx, request(), `key-${randomUUID()}`);
  return { draftId: draft.draftId, versionId: draft.versionId };
}
const view = (ctx: AuthedCtx, d: { draftId: string }, versionId?: string, w = web) => w.drafts.getDraftView(ctx, d.draftId, versionId);
const versionRows = async (draftId: string) => (await admin.query(`SELECT * FROM draft_version WHERE draft_id = $1 ORDER BY ordinal`, [draftId])).rows.map((r) => ({ ...r, content: JSON.stringify(r.content) }));
const draftRow = async (draftId: string) => (await admin.query(`SELECT rev, version_count, active_version_id, expires_at, updated_at FROM draft WHERE id = $1`, [draftId])).rows[0];
const expireAt = (draftId: string, sqlOffset: string) => admin.query(`UPDATE draft SET expires_at = now() ${sqlOffset} WHERE id = $1`, [draftId]);
const counter = async (key: string) => (await admin.query(`SELECT count FROM rate_limit_window WHERE key = $1`, [key])).rows[0]?.count ?? 0;
async function code(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (e) {
    return domainErrorCode(e);
  }
}
const billing = async (ownerId: string) => ({
  bucket: (await admin.query(`SELECT used, reserved, limit_count FROM usage_bucket WHERE owner_id = $1`, [ownerId])).rows,
  reservations: (await admin.query(`SELECT count(*)::int AS n FROM usage_reservation WHERE owner_id = $1`, [ownerId])).rows,
  jobs: (await admin.query(`SELECT count(*)::int AS n FROM generation_job WHERE owner_id = $1`, [ownerId])).rows,
  lessons: (await admin.query(`SELECT count(*)::int AS n FROM lesson WHERE owner_id = $1`, [ownerId])).rows,
});
/** One accepted replacement on a version; returns the version's new rev. */
async function replaceOne(ctx: AuthedCtx, draftId: string, versionId: string, w = web) {
  const v = await w.drafts.getDraftView(ctx, draftId, versionId);
  const r1 = await w.drafts.requestCandidate(ctx, draftId, versionId, v.rev, exerciseIds(v.package)[1]!);
  const cand = (await w.drafts.getDraftView(ctx, draftId, versionId)).adjust.candidate!;
  return (await w.drafts.acceptCandidate(ctx, draftId, versionId, r1.rev, cand.id)).rev;
}

describe("R6: another version preserves every earlier one", () => {
  it("version 1 is byte-identical after createVersion; switching back shows it exactly, including an earlier replacement", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    await replaceOne(ctx, d.draftId, d.versionId);
    const v1 = await view(ctx, d, d.versionId);
    expect(v1.adjust.changes.replacedIds).toHaveLength(1);
    const [before] = await versionRows(d.draftId);
    const draft0 = await draftRow(d.draftId);
    expect(draft0.rev).toBe(1);
    expect(v1.draftRev).toBe(1);

    const made = await web.drafts.createVersion(ctx, d.draftId, v1.draftRev);
    expect(made).toMatchObject({ draftRev: 2, ordinal: 2 });
    expect(made.versionId).not.toBe(d.versionId);

    const rows = await versionRows(d.draftId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(before); // content, hash, rev, history, changes, pending_candidate, updated_at: all unchanged
    expect(rows[1]!.seed).not.toBe(rows[0]!.seed);
    expect(rows[1]!.content).not.toBe(rows[0]!.content);
    expect(rows[1]!.rev).toBe(1);
    expect(rows[1]!.history).toEqual([]);
    const draft1 = await draftRow(d.draftId);
    expect(draft1).toMatchObject({ rev: 2, version_count: 2, active_version_id: made.versionId });

    // the default view is the new version; the old one is addressable and exact
    const active = await view(ctx, d);
    expect(active).toMatchObject({ ordinal: 2, versionId: made.versionId, draftRev: 2, activeVersionId: made.versionId });
    expect(active.adjust.changes.replacedIds).toEqual([]);
    expect(active.versions.map((v) => [v.ordinal, v.isActive, v.changesSummary.replacedIds.length])).toEqual([[1, false, 1], [2, true, 0]]);
    const old = await view(ctx, d, d.versionId);
    expect(old.contentHash).toBe(v1.contentHash);
    expect(old.package).toEqual(v1.package);

    // switch back: the default view is version 1 again with its replacement
    await web.drafts.switchVersion(ctx, d.draftId, d.versionId, active.draftRev);
    const back = await view(ctx, d);
    expect(back).toMatchObject({ ordinal: 1, draftRev: 3 });
    expect(back.contentHash).toBe(v1.contentHash);
    expect(back.adjust.changes.replacedIds).toEqual(v1.adjust.changes.replacedIds);
    expect(await versionRows(d.draftId)).toEqual(rows);
    expect(await draftRow(d.draftId)).toMatchObject({ active_version_id: d.versionId, version_count: 2 });
  });

  it("question operations stay keyed by version: a stale tab edits version 1 correctly and cannot touch version 2", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v1 = await view(ctx, d);
    const made = await web.drafts.createVersion(ctx, d.draftId, v1.draftRev);
    const v2Before = (await versionRows(d.draftId))[1];
    // the tab that still shows version 1 (rev 1) edits it
    const r = await web.drafts.removeQuestion(ctx, d.draftId, d.versionId, v1.rev, exerciseIds(v1.package)[0]!);
    expect(r.rev).toBe(v1.rev + 1);
    expect((await versionRows(d.draftId))[1]).toEqual(v2Before);
    expect((await view(ctx, d, made.versionId)).adjust.changes.removedIds).toEqual([]);
    expect((await view(ctx, d, d.versionId)).adjust.changes.removedIds).toHaveLength(1);
  });

  it("ordinals keep counting up and the new version has a new seed each time", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    let rev = 1;
    for (let i = 2; i <= 4; i++) rev = (await web.drafts.createVersion(ctx, d.draftId, rev)).draftRev;
    const rows = await versionRows(d.draftId);
    expect(rows.map((r) => r.ordinal)).toEqual([1, 2, 3, 4]);
    expect(new Set(rows.map((r) => r.seed)).size).toBe(4);
    expect(await draftRow(d.draftId)).toMatchObject({ rev: 4, version_count: 4 });
  });
});

describe("R7: concurrent edits reject stale revisions", () => {
  it("two createVersion on one draft revision: exactly one wins, the other is a conflict, one version added", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const results = await Promise.allSettled([web.drafts.createVersion(ctx, d.draftId, 1), dal().drafts.createVersion(ctx, d.draftId, 1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(domainErrorCode(failed.reason)).toBe("DRAFT_CONFLICT");
    expect((failed.reason as { currentRev: number }).currentRev).toBe(2);
    expect(await versionRows(d.draftId)).toHaveLength(2);
    expect(await draftRow(d.draftId)).toMatchObject({ rev: 2, version_count: 2 });
  });

  it("createVersion racing an accept on version 1: both succeed, independently and consistently", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v = await view(ctx, d);
    const r1 = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v.rev, exerciseIds(v.package)[0]!);
    const cand = (await view(ctx, d)).adjust.candidate!;
    const [create, accept] = await Promise.allSettled([web.drafts.createVersion(ctx, d.draftId, v.draftRev), dal().drafts.acceptCandidate(ctx, d.draftId, d.versionId, r1.rev, cand.id)]);
    expect(create.status).toBe("fulfilled");
    expect(accept.status).toBe("fulfilled");
    const rows = await versionRows(d.draftId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.rev).toBe(r1.rev + 1);
    expect(rows[0]!.history).toHaveLength(1);
    expect(rows[1]!.history).toEqual([]);
    expect(await draftRow(d.draftId)).toMatchObject({ rev: 2, version_count: 2, active_version_id: rows[1]!.id });
  });

  it("switchVersion racing createVersion on one draft revision: exactly one wins, state is consistent", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const made = await web.drafts.createVersion(ctx, d.draftId, 1); // rev 2, active = v2
    const [sw, cr] = await Promise.allSettled([web.drafts.switchVersion(ctx, d.draftId, d.versionId, made.draftRev), dal().drafts.createVersion(ctx, d.draftId, made.draftRev)]);
    const ok = [sw, cr].filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    const lost = [sw, cr].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(domainErrorCode(lost.reason)).toBe("DRAFT_CONFLICT");
    const draft = await draftRow(d.draftId);
    const rows = await versionRows(d.draftId);
    expect(draft.rev).toBe(made.draftRev + 1);
    if (sw.status === "fulfilled") {
      expect(rows).toHaveLength(2);
      expect(draft.active_version_id).toBe(d.versionId);
    } else {
      expect(rows).toHaveLength(3);
      expect(draft.active_version_id).toBe(rows[2]!.id);
    }
  });

  it("two switches on one revision: one wins; a stale switch is a conflict with the current rev and changes nothing", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const made = await web.drafts.createVersion(ctx, d.draftId, 1);
    const results = await Promise.allSettled([web.drafts.switchVersion(ctx, d.draftId, d.versionId, 2), dal().drafts.switchVersion(ctx, d.draftId, made.versionId, 2)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const before = await draftRow(d.draftId);
    const stale = await web.drafts.switchVersion(ctx, d.draftId, d.versionId, 2).catch((e) => e as { code: string; currentRev: number });
    expect(stale).toMatchObject({ code: "DRAFT_CONFLICT", currentRev: 3 });
    expect(await draftRow(d.draftId)).toEqual(before);
  });

  it("two accepts on one version revision: exactly one wins", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v = await view(ctx, d);
    const r1 = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v.rev, exerciseIds(v.package)[0]!);
    const cand = (await view(ctx, d)).adjust.candidate!;
    const results = await Promise.allSettled([web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, r1.rev, cand.id), dal().drafts.acceptCandidate(ctx, d.draftId, d.versionId, r1.rev, cand.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(domainErrorCode((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toBe("DRAFT_CONFLICT");
  });

  it("a stale draft revision is refused for both version operations and changes nothing", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const made = await web.drafts.createVersion(ctx, d.draftId, 1);
    const before = { draft: await draftRow(d.draftId), rows: await versionRows(d.draftId) };
    expect(await code(web.drafts.createVersion(ctx, d.draftId, 1))).toBe("DRAFT_CONFLICT");
    expect(await code(web.drafts.switchVersion(ctx, d.draftId, made.versionId, 1))).toBe("DRAFT_CONFLICT");
    expect(await code(web.drafts.createVersion(ctx, d.draftId, 0))).toBe("INVALID_REQUEST");
    expect({ draft: await draftRow(d.draftId), rows: await versionRows(d.draftId) }).toEqual(before);
  });
});

describe("version limit", () => {
  it("refuses the version past maxVersionsPerDraft with VERSION_LIMIT and inserts nothing; switching still works", async () => {
    const strict = dal({ maxVersionsPerDraft: 2 });
    const ctx = await account(strict);
    const d = await newDraft(ctx, strict);
    const made = await strict.drafts.createVersion(ctx, d.draftId, 1);
    const before = { draft: await draftRow(d.draftId), rows: await versionRows(d.draftId), counter: await counter(`ver:u:${ctx.userId}`) };
    expect(await code(strict.drafts.createVersion(ctx, d.draftId, made.draftRev))).toBe("VERSION_LIMIT");
    expect({ draft: await draftRow(d.draftId), rows: await versionRows(d.draftId), counter: await counter(`ver:u:${ctx.userId}`) }).toEqual(before);
    expect((await strict.drafts.getDraftView(ctx, d.draftId)).versionLimit).toBe(2);
    await strict.drafts.switchVersion(ctx, d.draftId, d.versionId, made.draftRev);
  });
});

describe("switching never overwrites a version", () => {
  it("every version row is byte-identical after any number of switches; only the draft pointer moves", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    await replaceOne(ctx, d.draftId, d.versionId);
    let rev = (await view(ctx, d)).draftRev;
    const second = await web.drafts.createVersion(ctx, d.draftId, rev);
    rev = second.draftRev;
    const before = await versionRows(d.draftId);
    for (const target of [d.versionId, second.versionId, d.versionId]) rev = (await web.drafts.switchVersion(ctx, d.draftId, target, rev)).draftRev;
    expect(await versionRows(d.draftId)).toEqual(before);
    expect(await draftRow(d.draftId)).toMatchObject({ rev: 5, active_version_id: d.versionId, version_count: 2 });
  });
});

describe("R17 (extended): ownership", () => {
  it("another account cannot create, switch or list versions; a version of another draft is not found; nothing changes", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const own2 = await newDraft(ctx);
    const intruder = await account();
    const before = { draft: await draftRow(d.draftId), rows: await versionRows(d.draftId) };
    expect(await code(web.drafts.createVersion(intruder, d.draftId, 1))).toBe("NOT_FOUND");
    expect(await code(web.drafts.switchVersion(intruder, d.draftId, d.versionId, 1))).toBe("NOT_FOUND");
    expect(await code(web.drafts.listVersions(intruder, d.draftId))).toBe("NOT_FOUND");
    expect(await code(web.drafts.getDraftView(intruder, d.draftId, d.versionId))).toBe("NOT_FOUND");
    expect(await code(web.drafts.createVersion(intruder, randomUUID(), 1))).toBe("NOT_FOUND"); // indistinguishable from missing
    // the owner: a version of a different draft (even their own) is not a version of this draft
    expect(await code(web.drafts.switchVersion(ctx, d.draftId, own2.versionId, 1))).toBe("NOT_FOUND");
    expect(await code(web.drafts.getDraftView(ctx, d.draftId, own2.versionId))).toBe("NOT_FOUND");
    expect(await code(web.drafts.switchVersion(ctx, d.draftId, "not-a-uuid", 1))).toBe("NOT_FOUND");
    expect({ draft: await draftRow(d.draftId), rows: await versionRows(d.draftId) }).toEqual(before);
    expect((await web.drafts.listVersions(ctx, d.draftId)).map((v) => v.ordinal)).toEqual([1]);
  });

  it("the list is lightweight: summaries without content", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    await web.drafts.createVersion(ctx, d.draftId, 1);
    const list = await web.drafts.listVersions(ctx, d.draftId);
    expect(list).toHaveLength(2);
    for (const v of list) expect(Object.keys(v).sort()).toEqual(["changesSummary", "createdAt", "isActive", "ordinal", "versionId"]);
    expect(list.map((v) => v.isActive)).toEqual([false, true]);
  });
});

describe("expiry", () => {
  it("an expired draft refuses createVersion, switchVersion and listVersions, and nothing changes or revives", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const made = await web.drafts.createVersion(ctx, d.draftId, 1);
    await expireAt(d.draftId, "- interval '1 minute'");
    const before = { draft: await draftRow(d.draftId), rows: await versionRows(d.draftId), counter: await counter(`ver:u:${ctx.userId}`) };
    expect(await code(web.drafts.createVersion(ctx, d.draftId, made.draftRev))).toBe("DRAFT_EXPIRED");
    expect(await code(web.drafts.switchVersion(ctx, d.draftId, d.versionId, made.draftRev))).toBe("DRAFT_EXPIRED");
    expect(await code(web.drafts.listVersions(ctx, d.draftId))).toBe("DRAFT_EXPIRED");
    expect({ draft: await draftRow(d.draftId), rows: await versionRows(d.draftId), counter: await counter(`ver:u:${ctx.userId}`) }).toEqual(before);
  });

  it("every mutation slides the expiry to now + TTL and bumps updated_at; the TTL is configurable", async () => {
    const short = dal({ draftTtlDays: 3 });
    const ctx = await account(short);
    const d = await newDraft(ctx, short);
    const days = async () => Number((await admin.query(`SELECT extract(epoch FROM (expires_at - now())) / 86400 AS d FROM draft WHERE id = $1`, [d.draftId])).rows[0].d);
    const expectFresh = async () => {
      expect(await days()).toBeGreaterThan(2.99);
      expect(await days()).toBeLessThanOrEqual(3);
    };
    await expireAt(d.draftId, "+ interval '1 hour'");
    expect(await days()).toBeLessThan(0.1);
    const t0 = (await draftRow(d.draftId)).updated_at as Date;
    // a question operation (S2)
    const v = await view(ctx, d, undefined, short);
    await short.drafts.requestCandidate(ctx, d.draftId, d.versionId, v.rev, exerciseIds(v.package)[0]!);
    await expectFresh();
    expect((await draftRow(d.draftId)).rev).toBe(1); // S2 operations do not touch the pointer revision
    expect(((await draftRow(d.draftId)).updated_at as Date).getTime()).toBeGreaterThan(t0.getTime());
    // createVersion
    await expireAt(d.draftId, "+ interval '1 hour'");
    const made = await short.drafts.createVersion(ctx, d.draftId, 1);
    await expectFresh();
    // switchVersion
    await expireAt(d.draftId, "+ interval '1 hour'");
    await short.drafts.switchVersion(ctx, d.draftId, d.versionId, made.draftRev);
    await expectFresh();
  });
});

describe("limits", () => {
  it("rate-limits version creation per account (key ver:u:); the refused one leaves no row and no counter drift", async () => {
    const strict = dal({ versionCreatesPerUserPerHour: 2 });
    const ctx = await account(strict);
    const d = await newDraft(ctx, strict);
    const a = await strict.drafts.createVersion(ctx, d.draftId, 1);
    const b = await strict.drafts.createVersion(ctx, d.draftId, a.draftRev);
    const before = { draft: await draftRow(d.draftId), rows: await versionRows(d.draftId) };
    expect(await counter(`ver:u:${ctx.userId}`)).toBe(2);
    expect(await code(strict.drafts.createVersion(ctx, d.draftId, b.draftRev))).toBe("VERSION_RATE_LIMITED");
    expect(await counter(`ver:u:${ctx.userId}`)).toBe(2);
    expect({ draft: await draftRow(d.draftId), rows: await versionRows(d.draftId) }).toEqual(before);
    // another account is unaffected
    const other = await account(strict);
    const od = await newDraft(other, strict);
    await strict.drafts.createVersion(other, od.draftId, 1);
  });

  it("maxDraftBytes and maxExercises are enforced for new versions (nothing stored); the draft keeps working", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const before = { draft: await draftRow(d.draftId), rows: await versionRows(d.draftId), counter: await counter(`ver:u:${ctx.userId}`) };
    expect(await code(dal({ maxDraftBytes: 10_000 }).drafts.createVersion(ctx, d.draftId, 1))).toBe("PACKAGE_BUILD_FAILED");
    expect(await code(dal({ maxExercises: 3 }).drafts.createVersion(ctx, d.draftId, 1))).toBe("PACKAGE_BUILD_FAILED");
    expect({ draft: await draftRow(d.draftId), rows: await versionRows(d.draftId), counter: await counter(`ver:u:${ctx.userId}`) }).toEqual(before);
    await web.drafts.createVersion(ctx, d.draftId, 1);
  });

  it("maxExercises is enforced when a draft is created: refused, nothing stored", async () => {
    const strict = dal({ maxExercises: 3 });
    const ctx = await account(strict);
    expect(await code(strict.drafts.createDraft(ctx, request(), `key-${randomUUID()}`))).toBe("PACKAGE_BUILD_FAILED");
    expect((await admin.query(`SELECT count(*)::int AS n FROM draft WHERE owner_id = $1`, [ctx.userId])).rows[0].n).toBe(0);
  });

  it("undoDepth bounds the undo history of a version", async () => {
    const shallow = dal({ undoDepth: 2 });
    const ctx = await account(shallow);
    const d = await newDraft(ctx, shallow);
    for (let i = 0; i < 3; i++) await replaceOne(ctx, d.draftId, d.versionId, shallow);
    expect((await versionRows(d.draftId))[0]!.history).toHaveLength(2);
  });
});

describe("free: versions touch no billing", () => {
  it("creating and switching versions leaves bucket, reservations, jobs and lessons untouched", async () => {
    const ctx = await account();
    const before = await billing(ctx.userId);
    const d = await newDraft(ctx);
    const a = await web.drafts.createVersion(ctx, d.draftId, 1);
    await web.drafts.switchVersion(ctx, d.draftId, d.versionId, a.draftRev);
    await web.drafts.createVersion(ctx, d.draftId, a.draftRev + 1);
    expect(await billing(ctx.userId)).toEqual(before);
    expect(before.bucket[0]).toMatchObject({ used: 0, reserved: 0 });
  });
});
