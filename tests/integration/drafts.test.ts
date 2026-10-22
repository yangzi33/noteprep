import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { verifyContextHash } from "@/lib/curriculum/context";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { readDatasetDir } from "@/lib/curriculum/files";
import { DraftExpired, DraftLimit, DraftRateLimited, IdempotencyConflict, NotFound, TopicUnsupported, domainErrorCode } from "@/lib/domain/errors";
import { canonicalJson } from "@/lib/domain/hash";
import { PackageBuildError } from "@/lib/content/errors";
import { packageContentHash } from "@/lib/package/adjust";
import { buildPackageWithMeta } from "@/lib/package/build";
import { validatePackage } from "@/lib/package/validate";
import { DEFAULT_LIMITS, type Limits } from "@/lib/server/limits";
import { makeAuthedCtx } from "@/lib/server/auth/context";
import { createWebDal, createWorkerDal } from "@/lib/server/dal";
import { loadDataset } from "@/lib/server/curriculum/load";
import { createDb } from "@/lib/server/db";
import { pools } from "./helpers";

const flags = vi.hoisted(() => ({ forceInvalid: false }));
// Lets one test make the (real) package validator refuse, to prove nothing is stored for an unverified package.
vi.mock("@/lib/package/validate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/package/validate")>();
  return { ...real, validatePackage: (pkg: unknown) => (flags.forceInvalid ? { ...real.validatePackage(pkg), overall: "failed" as const } : real.validatePackage(pkg)) };
});

const info = inject("testDb");
const { admin } = pools();
const ownerDb = createDb(info.adminUrl);
const appDb = createDb(info.appUrl);
const workerDb = createDb(info.workerUrl);

const SAMPLE: Dataset = readDatasetDir(path.join(__dirname, "../../data/curricula/sample-math/sample-1"));
const versionId = SAMPLE.meta.version.id;
const base = `${versionId}/level-a/course-1`;
const TOPIC = `${base}/equations/both-sides`;
const UNSUPPORTED_TOPIC = `${base}/shapes/areas`;

const limitsWith = (over: Partial<Limits> = {}): Limits => ({ ...DEFAULT_LIMITS, ...over });
const dal = (over: Partial<Limits> = {}) => createWebDal(appDb, { curriculum: { allowSample: true }, drafts: { limits: limitsWith(over) } });
const web = dal();
const purger = createWorkerDal(workerDb, { purgeGraceDays: 7 }).drafts;

beforeAll(async () => {
  await loadDataset(ownerDb, SAMPLE, { allowSample: true });
});
afterAll(async () => {
  await Promise.all([admin.end(), ownerDb.$disconnect(), appDb.$disconnect(), workerDb.$disconnect()]);
});

const request = (overrides: Record<string, unknown> = {}) => ({
  requestVersion: 2,
  curriculum: { versionId, topicId: TOPIC },
  durationMinutes: 60,
  difficulty: "mixed",
  documents: ["notes", "worksheet", "solutions"],
  templateId: "classic",
  locale: "en",
  ...overrides,
});
const key = () => `key-${randomUUID()}`;
async function account(w = web) {
  const ctx = makeAuthedCtx(randomUUID());
  await w.account.ensureAccount(ctx);
  return ctx;
}
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];
const count = async (sql: string, params: unknown[] = []) => Number((await one(`SELECT count(*)::int AS n FROM ${sql}`, params)).n);
const bucket = async (ownerId: string) => (await one(`SELECT used, reserved, limit_count FROM usage_bucket WHERE owner_id = $1`, [ownerId])) as { used: number; reserved: number; limit_count: number };
const driftFor = async (ownerId: string) => (await admin.query(`SELECT d.* FROM usage_bucket_drift d JOIN usage_bucket b ON b.id = d.bucket_id WHERE b.owner_id = $1`, [ownerId])).rows;
const expireAt = (draftId: string, sqlOffset: string) => admin.query(`UPDATE draft SET expires_at = now() ${sqlOffset} WHERE id = $1`, [draftId]);

describe("R1: a draft is free", () => {
  it("creating drafts, including repeated submits, touches no allowance, reservation or job", async () => {
    const ctx = await account();
    const before = await bucket(ctx.userId);
    expect(before).toMatchObject({ used: 0, reserved: 0 });
    const k = key();
    const first = await web.drafts.createDraft(ctx, request(), k);
    for (let i = 0; i < 3; i++) await web.drafts.createDraft(ctx, request(), k); // double clicks and retried submits
    await web.drafts.createDraft(ctx, request({ difficulty: "challenge" }), key());
    await web.drafts.createDraft(ctx, request({ difficulty: "basic", durationMinutes: 45 }), key());
    expect(first.replayed).toBe(false);

    expect(await bucket(ctx.userId)).toEqual(before);
    expect(await count(`usage_reservation WHERE owner_id = $1`, [ctx.userId])).toBe(0);
    expect(await count(`generation_job WHERE owner_id = $1`, [ctx.userId])).toBe(0);
    expect(await count(`lesson WHERE owner_id = $1`, [ctx.userId])).toBe(0);
    expect(await driftFor(ctx.userId)).toEqual([]);
    expect(await count(`draft WHERE owner_id = $1`, [ctx.userId])).toBe(3);
    expect(await count(`draft_version WHERE owner_id = $1`, [ctx.userId])).toBe(3);
  });

  it("a refused draft (unsupported topic, rate limit) also leaves no row, reservation or idempotency record", async () => {
    const ctx = await account();
    await expect(web.drafts.createDraft(ctx, request({ curriculum: { versionId, topicId: UNSUPPORTED_TOPIC } }), key())).rejects.toBeInstanceOf(TopicUnsupported);
    expect(await count(`draft WHERE owner_id = $1`, [ctx.userId])).toBe(0);
    expect(await count(`idempotency_key WHERE owner_id = $1`, [ctx.userId])).toBe(0);
    expect(await bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });
});

describe("idempotency", () => {
  it("the same key and request replays the original draft; a different request with that key conflicts", async () => {
    const ctx = await account();
    const k = key();
    const first = await web.drafts.createDraft(ctx, request(), k);
    const again = await web.drafts.createDraft(ctx, request(), k);
    expect(again.replayed).toBe(true);
    expect(again.draft).toEqual(first.draft);
    await expect(web.drafts.createDraft(ctx, request({ difficulty: "challenge" }), k)).rejects.toBeInstanceOf(IdempotencyConflict);
    expect(await count(`draft WHERE owner_id = $1`, [ctx.userId])).toBe(1);
  });

  it("the key is scoped to the account", async () => {
    const a = await account();
    const b = await account();
    const k = key();
    const da = await web.drafts.createDraft(a, request(), k);
    const db = await web.drafts.createDraft(b, request(), k);
    expect(db.replayed).toBe(false);
    expect(db.draft.draftId).not.toBe(da.draft.draftId);
  });

  it("parallel submits of one key create exactly one draft", async () => {
    const ctx = await account();
    const k = key();
    const results = await Promise.all(Array.from({ length: 5 }, () => web.drafts.createDraft(ctx, request(), k)));
    expect(new Set(results.map((r) => r.draft.draftId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await count(`draft WHERE owner_id = $1`, [ctx.userId])).toBe(1);
  });

  it("a replay still works while the account is over its limits, and after expiry says the draft expired", async () => {
    const strict = dal({ draftCreatesPerUserPerHour: 1 });
    const ctx = await account(strict);
    const k = key();
    const first = await strict.drafts.createDraft(ctx, request(), k);
    expect((await strict.drafts.createDraft(ctx, request(), k)).draft.draftId).toBe(first.draft.draftId); // not counted again
    await admin.query(`DELETE FROM draft WHERE id = $1`, [first.draft.draftId]); // purged
    await expect(strict.drafts.createDraft(ctx, request(), k)).rejects.toBeInstanceOf(DraftExpired);
  });
});

describe("limits", () => {
  it("refuses the request after the per-user hourly limit, with no side effects", async () => {
    const strict = dal({ draftCreatesPerUserPerHour: 2 });
    const ctx = await account(strict);
    await strict.drafts.createDraft(ctx, request(), key());
    await strict.drafts.createDraft(ctx, request({ difficulty: "basic" }), key());
    const refused = key();
    await expect(strict.drafts.createDraft(ctx, request({ difficulty: "challenge" }), refused)).rejects.toBeInstanceOf(DraftRateLimited);
    expect(await count(`draft WHERE owner_id = $1`, [ctx.userId])).toBe(2);
    expect(await count(`idempotency_key WHERE owner_id = $1 AND key = $2`, [ctx.userId, refused])).toBe(0);
    expect((await one(`SELECT count FROM rate_limit_window WHERE key = $1`, [`draft:u:${ctx.userId}`])).count).toBe(2); // the refused attempt rolled back
    expect(await bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("limits by hashed address, across accounts", async () => {
    const strict = dal({ draftCreatesPerIpPerHour: 2 });
    const ipHash = `iphash-${randomUUID()}`;
    const [a, b, c] = [await account(strict), await account(strict), await account(strict)];
    await strict.drafts.createDraft(a, request(), key(), { ipHash });
    await strict.drafts.createDraft(b, request(), key(), { ipHash });
    await expect(strict.drafts.createDraft(c, request(), key(), { ipHash })).rejects.toBeInstanceOf(DraftRateLimited);
    expect(await count(`draft WHERE owner_id = $1`, [c.userId])).toBe(0);
    await strict.drafts.createDraft(c, request(), key(), { ipHash: `iphash-${randomUUID()}` }); // another address is fine
  });

  it("has a service-wide limit", async () => {
    const used = Number((await admin.query(`SELECT count FROM rate_limit_window WHERE key = 'draft:global' AND window_start = date_trunc('hour', now())`)).rows[0]?.count ?? 0);
    const strict = dal({ draftCreatesGlobalPerHour: used + 1 });
    const ctx = await account(strict);
    await strict.drafts.createDraft(ctx, request(), key());
    await expect(strict.drafts.createDraft(ctx, request({ difficulty: "basic" }), key())).rejects.toBeInstanceOf(DraftRateLimited);
    expect(await count(`draft WHERE owner_id = $1`, [ctx.userId])).toBe(1);
  });

  it("caps active drafts per user; expired drafts do not count", async () => {
    const strict = dal({ maxActiveDraftsPerUser: 2 });
    const ctx = await account(strict);
    const d1 = await strict.drafts.createDraft(ctx, request(), key());
    await strict.drafts.createDraft(ctx, request({ difficulty: "basic" }), key());
    await expect(strict.drafts.createDraft(ctx, request({ difficulty: "challenge" }), key())).rejects.toBeInstanceOf(DraftLimit);
    expect(await count(`draft WHERE owner_id = $1`, [ctx.userId])).toBe(2);
    // another user is unaffected
    await strict.drafts.createDraft(await account(strict), request(), key());
    // once one has passed its expiry (even before the sweep marks it) there is room again
    await expireAt(d1.draft.draftId, "- interval '1 minute'");
    await strict.drafts.createDraft(ctx, request({ difficulty: "challenge" }), key());
    expect(await count(`draft WHERE owner_id = $1`, [ctx.userId])).toBe(3);
  });

  it("sets the expiry from the configured TTL", async () => {
    const week = dal({ draftTtlDays: 7 });
    const ctx = await account(week);
    const { draft } = await week.drafts.createDraft(ctx, request(), key());
    const row = await one(`SELECT extract(epoch FROM (expires_at - created_at)) / 86400 AS days FROM draft WHERE id = $1`, [draft.draftId]);
    expect(Number(row.days)).toBeCloseTo(7, 5);
  });

  it("refuses content over the configured size and stores nothing", async () => {
    const tiny = dal({ maxDraftBytes: 10_000 });
    const ctx = await account(tiny);
    await expect(tiny.drafts.createDraft(ctx, request(), key())).rejects.toBeInstanceOf(PackageBuildError);
    expect(await count(`draft WHERE owner_id = $1`, [ctx.userId])).toBe(0);
  });
});

describe("what is stored", () => {
  it("keeps the request and the context once on the draft, and the version content without them", async () => {
    const ctx = await account();
    const { draft } = await web.drafts.createDraft(ctx, request(), key());
    const d = await one(`SELECT * FROM draft WHERE id = $1`, [draft.draftId]);
    const v = await one(`SELECT * FROM draft_version WHERE draft_id = $1`, [draft.draftId]);
    expect(verifyContextHash(d.context)).toBe(true);
    expect(d.request.curriculum.topicId).toBe(TOPIC);
    expect(Object.keys(v.content)).not.toContain("context");
    expect(Object.keys(v.content)).not.toContain("request");
    expect(d.active_version_id).toBe(v.id);
    expect(d).toMatchObject({ status: "active", rev: 1, version_count: 1 });
    expect(v).toMatchObject({ ordinal: 1, rev: 1, history: [], pending_candidate: null, changes: { replacedIds: [], removedIds: [] } });
    // levels are recorded for every drawn question, and the next exercise number continues the numbering
    const ids = Object.keys(v.question_meta);
    expect(ids.length).toBeGreaterThan(3);
    expect(v.question_meta[ids[0]!]).toMatchObject({ origin: "initial" });
    expect(v.next_question_seq).toBe(ids.filter((id) => id.startsWith("ex-")).length + 1);
  });

  it("never stores a package the validator does not call verified", async () => {
    const ctx = await account();
    flags.forceInvalid = true;
    try {
      await expect(web.drafts.createDraft(ctx, request(), key())).rejects.toBeInstanceOf(PackageBuildError);
    } finally {
      flags.forceInvalid = false;
    }
    expect(await count(`draft WHERE owner_id = $1`, [ctx.userId])).toBe(0);
    expect(await count(`idempotency_key WHERE owner_id = $1`, [ctx.userId])).toBe(0);
  });
});

describe("reading a draft", () => {
  it("R18: every question in a created draft is verified", async () => {
    const ctx = await account();
    for (const difficulty of ["basic", "mixed", "challenge"]) {
      const { draft } = await web.drafts.createDraft(ctx, request({ difficulty }), key());
      const view = await web.drafts.getDraftView(ctx, draft.draftId);
      const report = validatePackage(view.package);
      expect(report.overall).toBe("verified");
      expect(report.math?.items.length).toBeGreaterThan(3);
      expect(report.math?.items.every((i) => i.status === "verified")).toBe(true);
    }
  });

  it("reopening gives byte-identical content with the same content hash", async () => {
    const ctx = await account();
    const { draft } = await web.drafts.createDraft(ctx, request(), key());
    const first = await web.drafts.getDraftView(ctx, draft.draftId);
    const reopened = await dal().drafts.getDraftView(ctx, draft.draftId, first.versionId); // a fresh DAL, explicit version
    expect(reopened.contentHash).toBe(first.contentHash);
    expect(canonicalJson(reopened.package)).toBe(canonicalJson(first.package));
    expect(packageContentHash(reopened.package)).toBe(first.contentHash);
    const row = await one(`SELECT content_hash, seed FROM draft_version WHERE id = $1`, [first.versionId]);
    expect(row.content_hash).toBe(first.contentHash);
    // and it is exactly what the deterministic builder makes from the stored parts
    const d = await one(`SELECT request, context FROM draft WHERE id = $1`, [draft.draftId]);
    expect(canonicalJson(buildPackageWithMeta({ request: d.request, context: d.context, seed: row.seed }).pkg)).toBe(canonicalJson(first.package));
    expect(first).toMatchObject({ ordinal: 1, rev: 1, documents: ["notes", "worksheet", "solutions"] });
    expect(first.title).toBe("Sample topic: Unknown on both sides");
    expect(first.selection).toEqual({ v: versionId, level: `${versionId}/level-a`, course: base, unit: `${base}/equations`, topic: TOPIC });
  });

  it("two drafts of one request differ (the seed is random), each deterministic on its own", async () => {
    const ctx = await account();
    const a = await web.drafts.createDraft(ctx, request(), key());
    const b = await web.drafts.createDraft(ctx, request(), key());
    expect((await web.drafts.getDraftView(ctx, a.draft.draftId)).contentHash).not.toBe((await web.drafts.getDraftView(ctx, b.draft.draftId)).contentHash);
  });

  it("detects stored content that no longer matches its hash", async () => {
    const ctx = await account();
    const { draft, } = await web.drafts.createDraft(ctx, request(), key());
    await admin.query(`UPDATE draft_version SET content = jsonb_set(content, '{seed}', '"tampered"'), rev = rev + 1 WHERE draft_id = $1`, [draft.draftId]);
    await expect(web.drafts.getDraftView(ctx, draft.draftId)).rejects.toMatchObject({ code: "INVARIANT_VIOLATION" });
  });
});

describe("R17 (part): other accounts cannot see a draft", () => {
  it("read, list, selection and version access are NotFound or absent, and indistinguishable from a missing draft", async () => {
    const owner = await account();
    const other = await account();
    const mine = await web.drafts.createDraft(owner, request(), key());
    const otherDraft = await web.drafts.createDraft(other, request(), key());

    const foreign = await web.drafts.getDraftView(other, mine.draft.draftId).catch((e) => e);
    const missing = await web.drafts.getDraftView(other, randomUUID()).catch((e) => e);
    expect(foreign).toBeInstanceOf(NotFound);
    expect(missing).toBeInstanceOf(NotFound);
    expect({ code: foreign.code, message: foreign.message }).toEqual({ code: missing.code, message: missing.message });
    await expect(web.drafts.getDraftView(other, "not-a-uuid")).rejects.toBeInstanceOf(NotFound);

    // a version id of another draft cannot be read through one's own draft id, nor through the owner's
    await expect(web.drafts.getDraftView(other, otherDraft.draft.draftId, mine.draft.versionId)).rejects.toBeInstanceOf(NotFound);
    await expect(web.drafts.getDraftView(owner, mine.draft.draftId, otherDraft.draft.versionId)).rejects.toBeInstanceOf(NotFound);

    expect(await web.drafts.getDraftSelection(other, mine.draft.draftId)).toBeNull();
    expect((await web.drafts.listDrafts(other)).map((d) => d.draftId)).toEqual([otherDraft.draft.draftId]);
    expect((await web.drafts.listDrafts(owner)).map((d) => d.draftId)).toEqual([mine.draft.draftId]);
  });

  it("a foreign expired draft still looks missing, not expired (existence is not leaked)", async () => {
    const owner = await account();
    const other = await account();
    const { draft } = await web.drafts.createDraft(owner, request(), key());
    await expireAt(draft.draftId, "- interval '1 hour'");
    await expect(web.drafts.getDraftView(other, draft.draftId)).rejects.toBeInstanceOf(NotFound);
    await expect(web.drafts.getDraftView(owner, draft.draftId)).rejects.toBeInstanceOf(DraftExpired);
  });
});

describe("expiry and purge", () => {
  it("refuses an expired draft, keeps its selection for 'start again', and omits it from the list", async () => {
    const ctx = await account();
    const { draft } = await web.drafts.createDraft(ctx, request(), key());
    await expireAt(draft.draftId, "- interval '1 second'"); // past its time, not yet marked by any sweep
    const error = await web.drafts.getDraftView(ctx, draft.draftId).catch((e) => e);
    expect(domainErrorCode(error)).toBe("DRAFT_EXPIRED");
    expect(await web.drafts.getDraftSelection(ctx, draft.draftId)).toMatchObject({ v: versionId, topic: TOPIC });
    expect(await web.drafts.listDrafts(ctx)).toEqual([]);
  });

  it("marks expired drafts, deletes them only after the grace period, and the versions cascade", async () => {
    const ctx = await account();
    const live = await web.drafts.createDraft(ctx, request(), key());
    const justExpired = await web.drafts.createDraft(ctx, request({ difficulty: "basic" }), key());
    const longGone = await web.drafts.createDraft(ctx, request({ difficulty: "challenge" }), key());
    await expireAt(justExpired.draft.draftId, "- interval '1 hour'");
    await expireAt(longGone.draft.draftId, "- interval '8 days'");

    const report = await purger.purgeExpired(1000);
    expect(report.expired).toBeGreaterThanOrEqual(2);
    expect(report.deleted).toBeGreaterThanOrEqual(1);

    const status = async (id: string) => (await one(`SELECT status FROM draft WHERE id = $1`, [id]))?.status;
    expect(await status(live.draft.draftId)).toBe("active");
    expect(await status(justExpired.draft.draftId)).toBe("expired"); // marked, kept during the grace period
    expect(await status(longGone.draft.draftId)).toBeUndefined(); // deleted
    expect(await count(`draft_version WHERE draft_id = $1`, [longGone.draft.draftId])).toBe(0);
    expect(await count(`draft_version WHERE draft_id = $1`, [justExpired.draft.draftId])).toBe(1);
    await expect(web.drafts.getDraftView(ctx, longGone.draft.draftId)).rejects.toBeInstanceOf(NotFound);
    await expect(web.drafts.getDraftView(ctx, justExpired.draft.draftId)).rejects.toBeInstanceOf(DraftExpired);

    // after the grace period the marked one goes too
    await expireAt(justExpired.draft.draftId, "- interval '8 days'");
    await purger.purgeExpired(1000);
    expect(await count(`draft WHERE id = $1`, [justExpired.draft.draftId])).toBe(0);
    expect(await count(`draft_version WHERE draft_id = $1`, [justExpired.draft.draftId])).toBe(0);
    expect(await count(`draft WHERE id = $1`, [live.draft.draftId])).toBe(1); // a live draft is never touched
  });

  it("works in bounded batches, and concurrent sweepers neither fail nor leave anything behind", async () => {
    await purger.purgeExpired(100_000); // clear what other tests left, so the arithmetic below is exact
    const ctx = await account();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await web.drafts.createDraft(ctx, request({ durationMinutes: 30 + i }), key())).draft.draftId);
    await admin.query(`UPDATE draft SET expires_at = now() - interval '9 days' WHERE id = ANY($1::uuid[])`, [ids]);

    // each call marks at most 2 and deletes at most 2 (the marking step runs first, so the ones it just marked are deletable)
    expect(await purger.purgeExpired(2)).toEqual({ expired: 2, deleted: 2 });
    expect(await count(`draft WHERE id = ANY($1::uuid[])`, [ids])).toBe(4);
    expect(await purger.purgeExpired(2)).toEqual({ expired: 2, deleted: 2 });
    expect(await purger.purgeExpired(2)).toEqual({ expired: 2, deleted: 2 });
    expect(await count(`draft WHERE id = ANY($1::uuid[])`, [ids])).toBe(0);

    // concurrent sweepers: every draft is deleted exactly once and nobody fails
    const more: string[] = [];
    for (let i = 0; i < 6; i++) more.push((await web.drafts.createDraft(ctx, request({ durationMinutes: 80 + i }), key())).draft.draftId);
    await admin.query(`UPDATE draft SET expires_at = now() - interval '9 days' WHERE id = ANY($1::uuid[])`, [more]);
    const results = await Promise.all([purger.purgeExpired(100), purger.purgeExpired(100), purger.purgeExpired(100)]);
    expect(results.reduce((n, r) => n + r.deleted, 0)).toBe(6);
    expect(await count(`draft WHERE id = ANY($1::uuid[])`, [more])).toBe(0);
    expect(await count(`draft_version WHERE draft_id = ANY($1::uuid[])`, [more])).toBe(0);
  });

  it("the web role cannot purge: it has no DELETE", async () => {
    const ctx = await account();
    const { draft } = await web.drafts.createDraft(ctx, request(), key());
    await expect(appDb.$executeRaw`DELETE FROM draft WHERE id = ${draft.draftId}::uuid`).rejects.toThrow(/permission denied/);
  });
});
