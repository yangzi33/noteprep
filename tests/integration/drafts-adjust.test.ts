import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import type { Dataset } from "@/lib/curriculum/dataset-schema";
import { readDatasetDir } from "@/lib/curriculum/files";
import { DRAW_EXHAUSTED } from "@/lib/math/generator";
import { domainErrorCode } from "@/lib/domain/errors";
import { packageContentHash } from "@/lib/package/adjust";
import { exerciseIds } from "@/lib/package/draft-ops";
import { validatePackage } from "@/lib/package/validate";
import { makeAuthedCtx, type AuthedCtx } from "@/lib/server/auth/context";
import { createWebDal } from "@/lib/server/dal";
import { loadDataset } from "@/lib/server/curriculum/load";
import { createDb } from "@/lib/server/db";
import { DEFAULT_LIMITS, type Limits } from "@/lib/server/limits";
import { pools } from "./helpers";

const flags = vi.hoisted(() => ({ exhausted: false }));
// Lets one test make the (real) item source run dry, to prove DRAW_EXHAUSTED changes nothing.
vi.mock("@/lib/content/item-source", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/content/item-source")>();
  return {
    ...real,
    deterministicLinearSource: {
      ...real.deterministicLinearSource,
      draw: (req: Parameters<typeof real.deterministicLinearSource.draw>[0]) => {
        if (flags.exhausted) throw new Error("could not draw a distinct question");
        return real.deterministicLinearSource.draw(req);
      },
    },
  };
});

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
async function account(w = web) {
  const ctx = makeAuthedCtx(randomUUID());
  await w.account.ensureAccount(ctx);
  return ctx;
}
async function newDraft(ctx: AuthedCtx, w = web, over: Record<string, unknown> = {}) {
  const { draft } = await w.drafts.createDraft(ctx, request(over), `key-${randomUUID()}`);
  return { draftId: draft.draftId, versionId: draft.versionId };
}
const view = (ctx: AuthedCtx, d: { draftId: string; versionId: string }, w = web) => w.drafts.getDraftView(ctx, d.draftId, d.versionId);
const row = async (versionId: string) =>
  (await admin.query(`SELECT rev, content::text AS content_text, content_hash, next_question_seq, history, changes, question_meta, pending_candidate FROM draft_version WHERE id = $1`, [versionId])).rows[0];
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];
const expireAt = (draftId: string, sqlOffset: string) => admin.query(`UPDATE draft SET expires_at = now() ${sqlOffset} WHERE id = $1`, [draftId]);
type Err = Error & { code: string; currentRev: number };
const err = (p: Promise<unknown>) => p.then(() => null as never, (e: unknown) => e as Err);
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
});

describe("R5: candidates never change the draft content", () => {
  it("request, try another and keep original bump rev by one each and leave content bytes and hash identical", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v0 = await view(ctx, d);
    const target = exerciseIds(v0.package)[2]!;
    const before = await row(d.versionId);

    let rev = v0.rev;
    const r1 = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, rev, target);
    expect(r1.rev).toBe(rev + 1);
    rev = r1.rev;
    const v1 = await view(ctx, d);
    expect(v1.adjust.candidate).toMatchObject({ targetQuestionId: target, attempt: 1, tried: [] });
    const first = v1.adjust.candidate!;

    const r2 = await web.drafts.tryAnother(ctx, d.draftId, d.versionId, rev, first.id);
    expect(r2.rev).toBe(rev + 1);
    rev = r2.rev;
    const second = (await view(ctx, d)).adjust.candidate!;
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ attempt: 2, tried: [first.item.fingerprint] });
    expect(second.item.fingerprint).not.toBe(first.item.fingerprint);

    const r3 = await web.drafts.keepOriginal(ctx, d.draftId, d.versionId, rev, second.id);
    expect(r3.rev).toBe(rev + 1);

    const after = await row(d.versionId);
    expect(after.content_text).toBe(before.content_text);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.pending_candidate).toBeNull();
    expect(after.rev).toBe(before.rev + 3);
    expect(after.history).toEqual([]);
    const v3 = await view(ctx, d);
    expect(v3.contentHash).toBe(v0.contentHash);
    expect(packageContentHash(v3.package)).toBe(v0.contentHash);
  });

  it("the pending candidate survives a reload (a fresh DAL) and a request for another question replaces it", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v0 = await view(ctx, d);
    const [a, b] = exerciseIds(v0.package);
    const r1 = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v0.rev, a!);
    const reloaded = await view(ctx, d, dal());
    expect(reloaded.adjust.candidate?.targetQuestionId).toBe(a);
    expect(reloaded.rev).toBe(r1.rev);
    await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, r1.rev, b!);
    const swapped = (await view(ctx, d)).adjust.candidate!;
    expect(swapped).toMatchObject({ targetQuestionId: b, attempt: 1, tried: [] });
    expect(await one(`SELECT count(*)::int AS n FROM draft_version WHERE id = $1 AND pending_candidate IS NOT NULL`, [d.versionId])).toEqual({ n: 1 });
  });
});

describe("accept, remove, undo", () => {
  it("accept replaces the exercise and its solution atomically; a second accept does nothing", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v0 = await view(ctx, d);
    const ids0 = exerciseIds(v0.package);
    const target = ids0[1]!;
    const r1 = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v0.rev, target);
    const cand = (await view(ctx, d)).adjust.candidate!;
    const r2 = await web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, r1.rev, cand.id);
    const v1 = await view(ctx, d);
    expect(v1.rev).toBe(r2.rev);
    const ids1 = exerciseIds(v1.package);
    expect(ids1[1]).toBe(cand.item.id);
    expect(ids1).toHaveLength(ids0.length);
    expect(v1.adjust.candidate).toBeNull();
    expect(v1.adjust.changes).toMatchObject({ replacedIds: [cand.item.id], removedIds: [] });
    expect(v1.adjust.undoLabel).toBe("Replaced question 2");
    expect(validatePackage(v1.package).overall).toBe("verified");
    const stored = await row(d.versionId);
    expect(stored.content_hash).toBe(packageContentHash(v1.package));
    expect(stored.next_question_seq).toBe(ids0.length + 2);

    // replay of the same click: same expectedRev -> conflict; the new rev with the spent candidate -> stale; nothing changes
    expect(await code(web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, r1.rev, cand.id))).toBe("DRAFT_CONFLICT");
    expect(await code(web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, r2.rev, cand.id))).toBe("CANDIDATE_STALE");
    expect((await row(d.versionId)).rev).toBe(r2.rev);
  });

  it("two parallel accepts on one revision: exactly one wins, the other is a conflict", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v0 = await view(ctx, d);
    const r1 = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v0.rev, exerciseIds(v0.package)[0]!);
    const cand = (await view(ctx, d)).adjust.candidate!;
    const results = await Promise.allSettled([
      web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, r1.rev, cand.id),
      web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, r1.rev, cand.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(domainErrorCode(failed.reason)).toBe("DRAFT_CONFLICT");
    expect((failed.reason as { currentRev: number }).currentRev).toBe(r1.rev + 1);
    expect((await row(d.versionId)).history).toHaveLength(1);
  });

  it("a candidate whose base hash no longer matches is stale and applies nothing", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v0 = await view(ctx, d);
    const r1 = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v0.rev, exerciseIds(v0.package)[0]!);
    const cand = (await view(ctx, d)).adjust.candidate!;
    await admin.query(`UPDATE draft_version SET pending_candidate = jsonb_set(pending_candidate, '{baseHash}', '"sha256:x"'), rev = rev + 1 WHERE id = $1`, [d.versionId]);
    const before = await row(d.versionId);
    expect(await code(web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, r1.rev + 1, cand.id))).toBe("CANDIDATE_STALE");
    expect(await row(d.versionId)).toEqual(before);
  });

  it("remove respects the minimum, undo restores the exact content (hash) and never reuses ids", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v0 = await view(ctx, d);
    const ids0 = exerciseIds(v0.package);
    const r1 = await web.drafts.removeQuestion(ctx, d.draftId, d.versionId, v0.rev, ids0[0]!);
    const v1 = await view(ctx, d);
    expect(exerciseIds(v1.package)).toEqual(ids0.slice(1));
    expect(v1.adjust.changes).toMatchObject({ removedIds: [ids0[0]], replacedIds: [] });
    expect(validatePackage(v1.package).overall).toBe("verified");

    const r2 = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, r1.rev, ids0[1]!);
    const cand = (await view(ctx, d)).adjust.candidate!;
    const r3 = await web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, r2.rev, cand.id);
    const r4 = await web.drafts.undo(ctx, d.draftId, d.versionId, r3.rev);
    const afterUndo = await view(ctx, d);
    expect(afterUndo.contentHash).toBe(v1.contentHash);
    expect(afterUndo.adjust.changes).toEqual(v1.adjust.changes);
    const seqAfterUndo = (await row(d.versionId)).next_question_seq;
    expect(seqAfterUndo).toBe(ids0.length + 2); // not rolled back

    // a new replacement of the same slot gets a fresh id, never the undone one
    const r5 = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, r4.rev, ids0[1]!);
    const cand2 = (await view(ctx, d)).adjust.candidate!;
    expect(cand2.item.id).not.toBe(cand.item.id);
    await web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, r5.rev, cand2.id);

    // undo everything back to the start
    let v = await view(ctx, d);
    while (v.adjust.undoLabel) {
      await web.drafts.undo(ctx, d.draftId, d.versionId, v.rev);
      v = await view(ctx, d);
    }
    expect(v.contentHash).toBe(v0.contentHash);
    expect(await code(web.drafts.undo(ctx, d.draftId, d.versionId, v.rev))).toBe("NOTHING_TO_UNDO");

    // minimum
    const small = await newDraft(ctx, web, { durationMinutes: 30, difficulty: "basic" });
    const sv = await view(ctx, small);
    expect(exerciseIds(sv.package)).toHaveLength(3);
    const before = await row(small.versionId);
    expect(await code(web.drafts.removeQuestion(ctx, small.draftId, small.versionId, sv.rev, exerciseIds(sv.package)[0]!))).toBe("ADJUSTMENT_MIN_COUNT");
    expect(await row(small.versionId)).toEqual(before);
  });

  it("a worked-example id or an unknown id is refused without changing anything", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v0 = await view(ctx, d);
    const before = await row(d.versionId);
    expect(await code(web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v0.rev, "we-1"))).toBe("QUESTION_NOT_FOUND");
    expect(await code(web.drafts.removeQuestion(ctx, d.draftId, d.versionId, v0.rev, "ex-9999"))).toBe("QUESTION_NOT_FOUND");
    expect(await row(d.versionId)).toEqual(before);
  });

  it("DRAW_EXHAUSTED is typed and changes nothing", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v0 = await view(ctx, d);
    const before = await row(d.versionId);
    flags.exhausted = true;
    try {
      expect(await code(web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v0.rev, exerciseIds(v0.package)[0]!))).toBe("DRAW_EXHAUSTED");
    } finally {
      flags.exhausted = false;
    }
    expect(DRAW_EXHAUSTED).toBeTruthy();
    expect(await row(d.versionId)).toEqual(before);
  });
});

describe("concurrency control", () => {
  it("a stale expectedRev is a typed conflict carrying the current rev, and changes nothing (every operation)", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v0 = await view(ctx, d);
    const r1 = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v0.rev, exerciseIds(v0.package)[0]!);
    const cand = (await view(ctx, d)).adjust.candidate!;
    const before = await row(d.versionId);
    const stale = v0.rev; // the rev a second tab still holds
    const ops: (() => Promise<unknown>)[] = [
      () => web.drafts.requestCandidate(ctx, d.draftId, d.versionId, stale, exerciseIds(v0.package)[1]!),
      () => web.drafts.tryAnother(ctx, d.draftId, d.versionId, stale, cand.id),
      () => web.drafts.keepOriginal(ctx, d.draftId, d.versionId, stale, cand.id),
      () => web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, stale, cand.id),
      () => web.drafts.removeQuestion(ctx, d.draftId, d.versionId, stale, exerciseIds(v0.package)[1]!),
      () => web.drafts.undo(ctx, d.draftId, d.versionId, stale),
    ];
    for (const op of ops) {
      const error = await err(op());
      expect(domainErrorCode(error)).toBe("DRAFT_CONFLICT");
      expect(error.currentRev).toBe(r1.rev);
    }
    expect(await row(d.versionId)).toEqual(before);
  });

  it("an expired draft refuses every operation and stays frozen", async () => {
    const ctx = await account();
    const d = await newDraft(ctx);
    const v0 = await view(ctx, d);
    const r1 = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v0.rev, exerciseIds(v0.package)[0]!);
    const cand = (await view(ctx, d)).adjust.candidate!;
    await expireAt(d.draftId, "- interval '1 minute'");
    const before = await row(d.versionId);
    const attempts: (() => Promise<unknown>)[] = [
      () => web.drafts.requestCandidate(ctx, d.draftId, d.versionId, r1.rev, exerciseIds(v0.package)[1]!),
      () => web.drafts.tryAnother(ctx, d.draftId, d.versionId, r1.rev, cand.id),
      () => web.drafts.keepOriginal(ctx, d.draftId, d.versionId, r1.rev, cand.id),
      () => web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, r1.rev, cand.id),
      () => web.drafts.removeQuestion(ctx, d.draftId, d.versionId, r1.rev, exerciseIds(v0.package)[1]!),
      () => web.drafts.undo(ctx, d.draftId, d.versionId, r1.rev),
    ];
    for (const a of attempts) expect(await code(a())).toBe("DRAFT_EXPIRED");
    expect(await row(d.versionId)).toEqual(before);
  });
});

describe("R17 (extended): other accounts cannot adjust a draft", () => {
  it("every adjustment of another account's draft is NotFound, indistinguishable from a missing one, and changes nothing", async () => {
    const owner = await account();
    const mallory = await account();
    const d = await newDraft(owner);
    const v0 = await view(owner, d);
    const r1 = await web.drafts.requestCandidate(owner, d.draftId, d.versionId, v0.rev, exerciseIds(v0.package)[0]!);
    const cand = (await view(owner, d)).adjust.candidate!;
    const before = await row(d.versionId);
    const q = exerciseIds(v0.package)[1]!;
    const missing = { draftId: randomUUID(), versionId: randomUUID() };
    const attacks: [string, (ctx: AuthedCtx, t: { draftId: string; versionId: string }) => Promise<unknown>][] = [
      ["requestCandidate", (c, t) => web.drafts.requestCandidate(c, t.draftId, t.versionId, r1.rev, q)],
      ["tryAnother", (c, t) => web.drafts.tryAnother(c, t.draftId, t.versionId, r1.rev, cand.id)],
      ["keepOriginal", (c, t) => web.drafts.keepOriginal(c, t.draftId, t.versionId, r1.rev, cand.id)],
      ["acceptCandidate", (c, t) => web.drafts.acceptCandidate(c, t.draftId, t.versionId, r1.rev, cand.id)],
      ["removeQuestion", (c, t) => web.drafts.removeQuestion(c, t.draftId, t.versionId, r1.rev, q)],
      ["undo", (c, t) => web.drafts.undo(c, t.draftId, t.versionId, r1.rev)],
    ];
    for (const [name, attack] of attacks) {
      const foreign = await err(attack(mallory, d));
      const absent = await err(attack(mallory, missing));
      expect(domainErrorCode(foreign), name).toBe("NOT_FOUND");
      expect({ code: foreign.code, message: foreign.message }, name).toEqual({ code: absent.code, message: absent.message });
      // the right draft id with someone else's version id is also NotFound
      const mine = await newDraft(mallory);
      expect(domainErrorCode(await err(attack(mallory, { draftId: mine.draftId, versionId: d.versionId }))), name).toBe("NOT_FOUND");
    }
    expect(await row(d.versionId)).toEqual(before);
  });
});

describe("limits", () => {
  it("rate-limits candidate requests per account (key cand:u:) and the refused one rolls back", async () => {
    const strict = dal({ candidatesPerUserPerHour: 2 });
    const ctx = await account(strict);
    const d = await newDraft(ctx, strict);
    const v0 = await view(ctx, d, strict);
    const ids = exerciseIds(v0.package);
    const r1 = await strict.drafts.requestCandidate(ctx, d.draftId, d.versionId, v0.rev, ids[0]!);
    const r2 = await strict.drafts.requestCandidate(ctx, d.draftId, d.versionId, r1.rev, ids[1]!);
    const before = await row(d.versionId);
    expect(await code(strict.drafts.requestCandidate(ctx, d.draftId, d.versionId, r2.rev, ids[2]!))).toBe("CANDIDATE_RATE_LIMITED");
    expect(await row(d.versionId)).toEqual(before);
    expect((await one(`SELECT count FROM rate_limit_window WHERE key = $1`, [`cand:u:${ctx.userId}`])).count).toBe(2);
    // another account is unaffected
    const other = await account(strict);
    const od = await newDraft(other, strict);
    const ov = await view(other, od, strict);
    await strict.drafts.requestCandidate(other, od.draftId, od.versionId, ov.rev, exerciseIds(ov.package)[0]!);
  });

  it("caps alternatives per slot per session; keeping the original starts a new session", async () => {
    const capped = dal({ candidatesPerSlot: 2 });
    const ctx = await account(capped);
    const d = await newDraft(ctx, capped);
    const v0 = await view(ctx, d, capped);
    const target = exerciseIds(v0.package)[0]!;
    let rev = (await capped.drafts.requestCandidate(ctx, d.draftId, d.versionId, v0.rev, target)).rev;
    rev = (await capped.drafts.requestCandidate(ctx, d.draftId, d.versionId, rev, target)).rev; // same question again: attempt 2
    expect((await view(ctx, d, capped)).adjust.candidate?.attempt).toBe(2);
    expect(await code(capped.drafts.requestCandidate(ctx, d.draftId, d.versionId, rev, target))).toBe("CANDIDATE_LIMIT");
    const cand = (await view(ctx, d, capped)).adjust.candidate!;
    rev = (await capped.drafts.keepOriginal(ctx, d.draftId, d.versionId, rev, cand.id)).rev;
    await capped.drafts.requestCandidate(ctx, d.draftId, d.versionId, rev, target); // a new session
  });
});

describe("free and verified", () => {
  it("a long sequence of operations touches no allowance, reservation or job and leaves every question verified", async () => {
    const ctx = await account();
    const before = await billing(ctx.userId);
    const d = await newDraft(ctx, web, { durationMinutes: 120 });
    let v = await view(ctx, d);
    const startHash = v.contentHash;
    const check = async () => {
      const cur = await view(ctx, d);
      const report = validatePackage(cur.package);
      expect(report.overall).toBe("verified");
      expect(report.math?.items.every((i) => i.status === "verified")).toBe(true);
      expect(cur.contentHash).toBe((await row(d.versionId)).content_hash);
      return cur;
    };
    for (let i = 0; i < 4; i++) {
      v = await view(ctx, d);
      const ids = exerciseIds(v.package);
      let { rev } = await web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v.rev, ids[i]!);
      const c1 = (await view(ctx, d)).adjust.candidate!;
      rev = (await web.drafts.tryAnother(ctx, d.draftId, d.versionId, rev, c1.id)).rev;
      const c2 = (await view(ctx, d)).adjust.candidate!;
      await web.drafts.acceptCandidate(ctx, d.draftId, d.versionId, rev, c2.id);
      await check();
    }
    v = await view(ctx, d);
    await web.drafts.removeQuestion(ctx, d.draftId, d.versionId, v.rev, exerciseIds(v.package).at(-1)!);
    v = await check();
    expect(v.adjust.changes.replacedIds).toHaveLength(4);
    expect(v.adjust.changes.removedIds).toHaveLength(1);
    while (v.adjust.undoLabel) {
      await web.drafts.undo(ctx, d.draftId, d.versionId, v.rev);
      v = await check();
    }
    expect(v.contentHash).toBe(startHash);
    expect(await billing(ctx.userId)).toEqual(before);
  });
});
