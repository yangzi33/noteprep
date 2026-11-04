import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MAX_WORKSHEET_QUESTIONS } from "@/lib/package/schema";
import { packageContentHash } from "@/lib/package/adjust";
import { exerciseIds } from "@/lib/package/draft-ops";
import { validatePackage } from "@/lib/package/validate";
import type { AuthedCtx } from "@/lib/server/auth/context";
import { code, createHarness, type DraftRef, type Harness } from "./export-helpers";

let h: Harness;
let strict: Harness;
beforeAll(async () => {
  h = await createHarness();
  strict = await createHarness({ limits: { addQuestionsPerUserPerHour: 2 } });
});
afterEach(async () => {
  await h.expectNoDrift();
  await h.abandonPending();
});
afterAll(async () => {
  await h.close();
  await strict.close();
});

const view = (ctx: AuthedCtx, d: DraftRef, hh = h) => hh.web.drafts.getDraftView(ctx, d.draftId, d.versionId);
const row = async (versionId: string) =>
  (await h.admin.query(`SELECT rev, content::text AS content_text, content_hash, next_question_seq, history, changes, question_meta FROM draft_version WHERE id = $1`, [versionId])).rows[0];
const counter = async (key: string) => (await h.admin.query(`SELECT COALESCE(sum(count), 0)::int AS n FROM rate_limit_window WHERE key = $1`, [key])).rows[0].n as number;
const billing = async (ownerId: string) => ({
  bucket: (await h.admin.query(`SELECT used, reserved, limit_count FROM usage_bucket WHERE owner_id = $1`, [ownerId])).rows,
  reservations: (await h.admin.query(`SELECT count(*)::int AS n FROM usage_reservation WHERE owner_id = $1`, [ownerId])).rows,
  jobs: (await h.admin.query(`SELECT count(*)::int AS n FROM generation_job WHERE owner_id = $1`, [ownerId])).rows,
  exports: (await h.admin.query(`SELECT count(*)::int AS n FROM export WHERE owner_id = $1`, [ownerId])).rows,
});

describe("addQuestions through the DAL", () => {
  it("appends k questions: rev + 1, hash stored, solutions paired, history says Added k questions, change counts show them", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const v0 = await view(ctx, d);
    const ids0 = exerciseIds(v0.package);
    const before = await row(d.versionId);
    const r = await h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, v0.rev, 3);
    expect(r.rev).toBe(v0.rev + 1);
    const v1 = await view(ctx, d);
    const ids1 = exerciseIds(v1.package);
    expect(ids1).toHaveLength(ids0.length + 3);
    expect(ids1.slice(0, ids0.length)).toEqual(ids0);
    expect(v1.adjust.changes.addedIds).toEqual(ids1.slice(ids0.length));
    expect(v1.adjust.undoLabel).toBe("Added 3 questions");
    expect(v1.adjust.practice).toMatchObject({ questions: ids0.length + 3, minutes: (ids0.length + 3) * 5 });
    expect(v1.adjust.addMax).toBe(5);
    expect(v1.adjust.maxExercises).toBe(MAX_WORKSHEET_QUESTIONS);
    expect(validatePackage(v1.package).overall).toBe("verified");
    const stored = await row(d.versionId);
    expect(stored.rev).toBe(before.rev + 1);
    expect(stored.content_hash).toBe(packageContentHash(v1.package));
    expect(stored.next_question_seq).toBe(before.next_question_seq + 3);
    expect(stored.history).toHaveLength(1);
    expect(stored.history[0].summary).toBe("Added 3 questions");
    expect(stored.history[0].beforeHash).toBe(before.content_hash);
    // the before-image holds the original blocks
    expect(stored.history[0].before.exercises.blocks).toEqual(v0.package.sections.find((s) => s.kind === "exercises")!.blocks);
  });

  it("undo restores the original hash and ids are never reused afterwards", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const v0 = await view(ctx, d);
    const a = await h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, v0.rev, 2);
    const addedIds = (await view(ctx, d)).adjust.changes.addedIds;
    const u = await h.web.drafts.undo(ctx, d.draftId, d.versionId, a.rev);
    const v2 = await view(ctx, d);
    expect(v2.contentHash).toBe(v0.contentHash);
    expect(v2.adjust.changes.addedIds).toEqual([]);
    const b = await h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, u.rev, 2);
    expect(b.rev).toBe(u.rev + 1);
    const again = (await view(ctx, d)).adjust.changes.addedIds;
    expect(again.filter((id) => addedIds.includes(id))).toEqual([]);
  });

  it("is refused at the cap with WORKSHEET_FULL and changes nothing, and the refused click is not counted", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx, { durationMinutes: 180 });
    let v = await view(ctx, d);
    let rev = v.rev;
    while (exerciseIds(v.package).length + 5 <= MAX_WORKSHEET_QUESTIONS) {
      rev = (await h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, rev, 5)).rev;
      v = await view(ctx, d);
    }
    const room = MAX_WORKSHEET_QUESTIONS - exerciseIds(v.package).length;
    if (room > 0) {
      expect(await code(h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, rev, room + 1))).toBe("WORKSHEET_FULL");
      rev = (await h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, rev, room)).rev;
    }
    v = await view(ctx, d);
    expect(exerciseIds(v.package)).toHaveLength(MAX_WORKSHEET_QUESTIONS);
    const before = await row(d.versionId);
    const counted = await counter(`add:u:${ctx.userId}`);
    expect(await code(h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, rev, 1))).toBe("WORKSHEET_FULL");
    expect(await row(d.versionId)).toEqual(before);
    expect(await counter(`add:u:${ctx.userId}`)).toBe(counted);
    expect(validatePackage(v.package).overall).toBe("verified");
  });

  it("refuses a count outside 1..5 and changes nothing", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const before = await row(d.versionId);
    for (const n of [0, 6, 1.5]) expect(await code(h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, d.rev, n)), String(n)).toBe("INVALID_REQUEST");
    expect(await row(d.versionId)).toEqual(before);
  });

  it("a stale expectedRev is a typed conflict and nothing changes", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    await h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, d.rev, 1);
    const before = await row(d.versionId);
    expect(await code(h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, d.rev, 1))).toBe("DRAFT_CONFLICT");
    expect(await row(d.versionId)).toEqual(before);
  });

  it("two adds from one revision: exactly one wins", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const results = await Promise.allSettled([h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, d.rev, 2), h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, d.rev, 2)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(await code(Promise.reject(failed.reason))).toBe("DRAFT_CONFLICT");
    const stored = await row(d.versionId);
    expect(stored.rev).toBe(d.rev + 1);
    expect(stored.history).toHaveLength(1);
  });

  it("another account sees NOT_FOUND and the draft is untouched", async () => {
    const ctx = await h.account();
    const mallory = await h.account();
    const d = await h.newDraft(ctx);
    const before = await row(d.versionId);
    expect(await code(h.web.drafts.addQuestions(mallory, d.draftId, d.versionId, d.rev, 1))).toBe("NOT_FOUND");
    expect(await row(d.versionId)).toEqual(before);
  });

  it("is rate limited per account (key add:u:); the refused add rolls back and others are unaffected", async () => {
    const ctx = await strict.account();
    const d = await strict.newDraft(ctx);
    const a = await strict.web.drafts.addQuestions(ctx, d.draftId, d.versionId, d.rev, 1);
    const b = await strict.web.drafts.addQuestions(ctx, d.draftId, d.versionId, a.rev, 1);
    const before = await row(d.versionId);
    expect(await code(strict.web.drafts.addQuestions(ctx, d.draftId, d.versionId, b.rev, 1))).toBe("ADD_RATE_LIMITED");
    expect(await row(d.versionId)).toEqual(before);
    expect(await counter(`add:u:${ctx.userId}`)).toBe(2);
    const other = await strict.account();
    const od = await strict.newDraft(other);
    await strict.web.drafts.addQuestions(other, od.draftId, od.versionId, od.rev, 1);
  });

  it("touches no allowance, reservation, job or export", async () => {
    const ctx = await h.account();
    const before = await billing(ctx.userId);
    const d = await h.newDraft(ctx);
    const v = await view(ctx, d);
    const a = await h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, v.rev, 4);
    await h.web.drafts.removeQuestion(ctx, d.draftId, d.versionId, a.rev, (await view(ctx, d)).adjust.changes.addedIds[0]!);
    expect(await billing(ctx.userId)).toEqual(before);
  });

  it("drops a pending candidate (its base content changed)", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const v0 = await view(ctx, d);
    const r1 = await h.web.drafts.requestCandidate(ctx, d.draftId, d.versionId, v0.rev, exerciseIds(v0.package)[0]!);
    expect((await view(ctx, d)).adjust.candidate).not.toBeNull();
    await h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, r1.rev, 1);
    expect((await view(ctx, d)).adjust.candidate).toBeNull();
  });
});

describe("create another version keeps the larger count", () => {
  it("a version made after adds has the added count, request unchanged; the old version stays as it was", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const v0 = await view(ctx, d);
    const n = exerciseIds(v0.package).length;
    await h.web.drafts.addQuestions(ctx, d.draftId, d.versionId, v0.rev, 4);
    const v1 = await view(ctx, d);
    const made = await h.web.drafts.createVersion(ctx, d.draftId, v1.draftRev);
    const v2 = await h.web.drafts.getDraftView(ctx, d.draftId, made.versionId);
    expect(exerciseIds(v2.package)).toHaveLength(n + 4);
    expect(JSON.stringify(v2.package.request)).toBe(JSON.stringify(v0.package.request));
    expect(validatePackage(v2.package).overall).toBe("verified");
    expect(v2.adjust.changes.addedIds).toEqual([]);
    const back = await h.web.drafts.getDraftView(ctx, d.draftId, d.versionId);
    expect(back.contentHash).toBe(v1.contentHash);
  });

  it("a version made after removals still has at least the planned count", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx);
    const v0 = await view(ctx, d);
    const n = exerciseIds(v0.package).length;
    await h.web.drafts.removeQuestion(ctx, d.draftId, d.versionId, v0.rev, exerciseIds(v0.package)[0]!);
    const made = await h.web.drafts.createVersion(ctx, d.draftId, (await view(ctx, d)).draftRev);
    expect(exerciseIds((await h.web.drafts.getDraftView(ctx, d.draftId, made.versionId)).package)).toHaveLength(n);
  });
});

describe("export after add", () => {
  it("freezes N+k exercises and solutions with a new exportKey; add, undo, export reuses the original exportKey", async () => {
    const ctx = await h.account();
    const d0 = await h.newDraft(ctx);
    const n = exerciseIds((await view(ctx, d0)).package).length;
    const first = await h.confirm(ctx, d0);
    const k0 = (await h.exportRow(first.exportId)).export_key as string;

    const a = await h.web.drafts.addQuestions(ctx, d0.draftId, d0.versionId, d0.rev, 3);
    const dAdd = await h.viewRef(ctx, d0.draftId, d0.versionId);
    expect(dAdd.rev).toBe(a.rev);
    const second = await h.confirm(ctx, dAdd);
    const exp = await h.exportRow(second.exportId);
    expect(exp.export_key).not.toBe(k0);
    const snap = (await h.admin.query(`SELECT content FROM export_snapshot WHERE id = $1`, [exp.snapshot_id])).rows[0].content;
    const sections = snap.sections as { kind: string; blocks: { type: string }[] }[];
    expect(sections.find((s) => s.kind === "exercises")!.blocks.filter((b) => b.type === "question")).toHaveLength(n + 3);
    expect(sections.find((s) => s.kind === "solutions")!.blocks.filter((b) => b.type === "solution")).toHaveLength(n + 3);

    const u = await h.web.drafts.undo(ctx, d0.draftId, d0.versionId, a.rev);
    const dUndo = await h.viewRef(ctx, d0.draftId, d0.versionId);
    expect(dUndo.rev).toBe(u.rev);
    const third = await h.confirm(ctx, dUndo);
    expect(third.exportId).toBe(first.exportId);
    expect((await h.exportRow(third.exportId)).export_key).toBe(k0);
  });
});
