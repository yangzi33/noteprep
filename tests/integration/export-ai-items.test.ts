import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fingerprintOf } from "@/lib/content/ai-item";
import type { CurriculumContext } from "@/lib/curriculum/context";
import { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { aiFingerprints, withAiItems } from "@/lib/package/ai-blocks";
import { packageContentHash } from "@/lib/package/adjust";
import { buildPackage } from "@/lib/package/build";
import type { LessonPackage } from "@/lib/package/schema";
import { admitted, RAW_ITEMS } from "../fixtures/ai-package";
import { code, createHarness, type DraftRef, type Harness } from "./export-helpers";
import type { AuthedCtx } from "@/lib/server/auth/context";

// A labelled draft (model items shown with their labels) exports and is charged once; a draft with a failed, own-flagged
// or taken-down item does not. Fake items only: no model is called here. Draft creation still builds deterministic
// drafts, so the draft's stored version is replaced by a /2 package built from its own request and context.

const flagged = new Map<string, Set<string>>();
const takenDown = new Set<string>();
let h: Harness;

beforeAll(async () => {
  h = await createHarness({
    itemGate: { flagged: async (ownerId) => flagged.get(ownerId) ?? new Set(), takenDown: async () => takenDown },
  });
});
afterEach(async () => {
  flagged.clear();
  takenDown.clear();
  await h.expectNoDrift();
  await h.abandonPending();
});
afterAll(() => h.close());

const items = () => ({
  example: admitted(RAW_ITEMS.example),
  checked: admitted(RAW_ITEMS.checked),
  checkedToo: admitted(RAW_ITEMS.checkedToo),
  unchecked: admitted(RAW_ITEMS.unchecked),
});

/** A draft whose version holds a lesson-package/2 pack. `mutate` may damage the package before it is stored. */
async function labelledDraft(ctx: AuthedCtx, mutate: (pkg: LessonPackage) => LessonPackage = (p) => p): Promise<{ ref: DraftRef; pkg: LessonPackage }> {
  const base = await h.newDraft(ctx);
  const { rows } = await h.admin.query(`SELECT d.request, d.context, v.seed FROM draft d JOIN draft_version v ON v.draft_id = d.id WHERE v.id = $1`, [base.versionId]);
  const request = LessonRequestV2.parse(rows[0].request);
  const context = rows[0].context as CurriculumContext;
  const det = buildPackage({ request, context, seed: rows[0].seed });
  const it = items();
  const pkg = mutate(withAiItems(det, request, context, { examples: [it.example], exercises: [it.checked, it.unchecked, it.checkedToo] }));
  const { request: _r, context: _c, ...content } = pkg;
  const full = { ...content, request: rows[0].request, context: rows[0].context } as LessonPackage;
  await h.admin.query(`UPDATE draft_version SET content = $2::jsonb, content_hash = $3, rev = rev + 1 WHERE id = $1`, [base.versionId, JSON.stringify(content), packageContentHash(full)]);
  return { ref: await h.viewRef(ctx, base.draftId, base.versionId), pkg };
}

const edit = (pkg: LessonPackage, fn: (blocks: Record<string, unknown>[]) => void): LessonPackage => {
  const copy = JSON.parse(JSON.stringify(pkg)) as LessonPackage;
  fn(copy.sections.flatMap((s) => s.blocks as unknown as Record<string, unknown>[]));
  return copy;
};

describe("a labelled draft", () => {
  it("exports, freezes the labels in the snapshot, and consumes exactly one generation", async () => {
    const ctx = await h.account();
    const { ref } = await labelledDraft(ctx);
    const r = await h.confirm(ctx, ref);
    expect(r.outcome).toBe("created");
    const exp = await h.exportRow(r.exportId);
    const snap = (await h.admin.query(`SELECT * FROM export_snapshot WHERE id = $1`, [exp.snapshot_id])).rows[0];
    expect(snap.validation_report.overall).toBe("labelled");
    expect(snap.validation_report.ai.items.map((i: { label: string }) => i.label)).toEqual(["checked", "checked", "review", "checked"]);
    expect(snap.content.schemaVersion).toBe("lesson-package/2");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });

    await h.complete(r.jobId);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
    expect(await h.count(`SELECT count(*) AS n FROM usage_reservation WHERE owner_id = $1 AND state = 'consumed'`, [ctx.userId])).toBe(1);
  });

  it("a retried or double-clicked confirm shares one entitlement", async () => {
    const ctx = await h.account();
    const { ref } = await labelledDraft(ctx);
    const [a, b] = await Promise.all([h.confirm(ctx, ref), h.confirm(ctx, ref)]);
    expect(a.exportId).toBe(b.exportId);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 1 });
  });
});

describe("what blocks an export", () => {
  it("a stored failed item", async () => {
    const ctx = await h.account();
    const { ref } = await labelledDraft(ctx, (pkg) => edit(pkg, (b) => b.filter((x) => x.questionId === "ex-2").forEach((x) => (x.status = "failed"))));
    expect(await code(h.confirm(ctx, ref))).toBe("EXPORT_NOT_VERIFIED");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect(await h.count(`SELECT count(*) AS n FROM export_snapshot WHERE owner_id = $1`, [ctx.userId])).toBe(0);
  });

  it("a stored code_checked answer altered after the check", async () => {
    const ctx = await h.account();
    const { ref } = await labelledDraft(ctx, (pkg) => {
      const swap = edit(pkg, (b) => {
        const one = b.find((x) => x.type === "ai_solution" && x.questionId === "ex-1")!;
        const three = b.find((x) => x.type === "ai_solution" && x.questionId === "ex-3")!;
        one.answer = three.answer;
      });
      return swap;
    });
    expect(await code(h.confirm(ctx, ref))).toBe("EXPORT_NOT_VERIFIED");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("an item the exporting owner flagged, for that owner only", async () => {
    const owner = await h.account();
    const other = await h.account();
    const mine = await labelledDraft(owner);
    const theirs = await labelledDraft(other);
    const target = aiFingerprints(mine.pkg)[1]!;
    flagged.set(owner.userId, new Set([target]));
    expect(await code(h.confirm(owner, mine.ref))).toBe("EXPORT_ITEM_FLAGGED");
    expect(await h.bucket(owner.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect((await h.confirm(other, theirs.ref)).outcome).toBe("created");
    expect(await h.bucket(other.userId)).toMatchObject({ reserved: 1 });
  });

  it("an item an administrator took down, for every account", async () => {
    const a = await h.account();
    const b = await h.account();
    const da = await labelledDraft(a);
    const db = await labelledDraft(b);
    takenDown.add(fingerprintOf(items().unchecked.stem, items().unchecked.answer));
    expect(await code(h.confirm(a, da.ref))).toBe("EXPORT_ITEM_TAKEN_DOWN");
    expect(await code(h.confirm(b, db.ref))).toBe("EXPORT_ITEM_TAKEN_DOWN");
    for (const ctx of [a, b]) expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });
});
