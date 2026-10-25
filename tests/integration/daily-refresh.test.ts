import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { utcDayNumber } from "@/lib/domain/daily-refresh";
import { AllowanceExhausted } from "@/lib/domain/errors";
import type { AuthedCtx } from "@/lib/server/auth/context";
import { createWebDal } from "@/lib/server/dal";
import type { AllowancePolicy } from "@/lib/server/dal/allowance-source";
import { code, createHarness, freshKey, OPEN_GEN, OPEN_LIMITS, type Harness } from "./export-helpers";

// The beta daily refresh (D-112): 5 exports per UTC day while the perk is on, the lifetime 3 (counting beta use) when it is off.
let h: Harness;
const clk = { now: new Date() };
const ON: AllowancePolicy = { dailyRefresh: { enabled: true, limit: 5 } };
const OFF: AllowancePolicy = { dailyRefresh: { enabled: false, limit: 5 } };

function dalWith(policy: AllowancePolicy) {
  return createWebDal(h.appDb, {
    limits: OPEN_GEN,
    clock: () => clk.now,
    curriculum: { allowSample: true },
    drafts: { limits: OPEN_LIMITS },
    exports: { enabled: true, limits: OPEN_LIMITS },
    allowancePolicy: policy,
  });
}
let on: ReturnType<typeof dalWith>;
let off: ReturnType<typeof dalWith>;

beforeAll(async () => {
  h = await createHarness({ clock: () => clk.now });
  on = dalWith(ON);
  off = dalWith(OFF);
  await h.parkForeignJobs();
});
afterEach(async () => {
  await h.expectNoDrift();
  await h.abandonPending();
  clk.now = new Date();
});
afterAll(async () => {
  await h.close();
});

const midnightAfter = (d: Date) => new Date((Number(utcDayNumber(d)) + 1) * 86_400_000);
const dailyRows = async (ownerId: string) =>
  (await h.admin.query(`SELECT * FROM usage_bucket WHERE owner_id = $1 AND kind = 'daily' ORDER BY period_key`, [ownerId])).rows as { id: string; used: number; reserved: number; limit_count: number; period_key: string; starts_at: Date; ends_at: Date }[];

async function exportOnce(ctx: AuthedCtx, dal: typeof on) {
  const d = await h.newDraft(ctx, {}, dal);
  return h.confirm(ctx, d, freshKey(), dal);
}
async function exportAndComplete(ctx: AuthedCtx, dal: typeof on) {
  const r = await exportOnce(ctx, dal);
  await h.complete(r.jobId);
  return r;
}

describe("perk on", () => {
  it("perk on: five exports succeed, the sixth is ALLOWANCE_EXHAUSTED, trial bucket unchanged", async () => {
    const ctx = await h.account();
    for (let i = 0; i < 5; i++) await exportAndComplete(ctx, on);
    expect(await code(exportOnce(ctx, on))).toBe("ALLOWANCE_EXHAUSTED");
    const err = await exportOnce(ctx, on).catch((e) => e);
    expect(err).toBeInstanceOf(AllowanceExhausted);
    expect((err as AllowanceExhausted).source).toBe("daily");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0, limit_count: 3 });
    const rows = await dailyRows(ctx.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ used: 5, reserved: 0, limit_count: 5, period_key: String(utcDayNumber(clk.now)) });
    expect(rows[0]!.ends_at.getTime() - rows[0]!.starts_at.getTime()).toBe(86_400_000);
  });

  it("perk on: next UTC day allows another export", async () => {
    const ctx = await h.account();
    for (let i = 0; i < 5; i++) await exportOnce(ctx, on);
    expect(await code(exportOnce(ctx, on))).toBe("ALLOWANCE_EXHAUSTED");
    clk.now = new Date(midnightAfter(clk.now).getTime() + 3_600_000);
    await exportOnce(ctx, on);
    const rows = await dailyRows(ctx.userId);
    expect(rows.map((r) => [r.used, r.reserved])).toEqual([[0, 5], [0, 1]]);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });

  it("two concurrent confirmations for the last daily export: exactly one wins", async () => {
    const ctx = await h.account();
    for (let i = 0; i < 4; i++) await exportOnce(ctx, on);
    const [a, b] = await Promise.all([h.newDraft(ctx, {}, on), h.newDraft(ctx, {}, on)]);
    const results = await Promise.all([code(h.confirm(ctx, a, freshKey(), on)), code(h.confirm(ctx, b, freshKey(), on))]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === "ALLOWANCE_EXHAUSTED")).toHaveLength(1);
    expect((await dailyRows(ctx.userId))[0]).toMatchObject({ used: 0, reserved: 5 });
  });

  it("concurrent first reservations of a day create exactly one daily bucket", async () => {
    const ctx = await h.account();
    const drafts = await Promise.all([1, 2, 3].map(() => h.newDraft(ctx, {}, on)));
    const results = await Promise.all(drafts.map((d) => code(h.confirm(ctx, d, freshKey(), on))));
    expect(results).toEqual([null, null, null]);
    const rows = await dailyRows(ctx.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ used: 0, reserved: 3 });
  });

  it("double click and identical re-export use no extra daily count", async () => {
    const ctx = await h.account();
    const d = await h.newDraft(ctx, {}, on);
    const key = freshKey();
    const [a, b] = await Promise.all([h.confirm(ctx, d, key, on), h.confirm(ctx, d, key, on)]);
    expect(b.exportId).toBe(a.exportId);
    const c = await h.confirm(ctx, d, freshKey(), on);
    expect(c.exportId).toBe(a.exportId);
    expect((await dailyRows(ctx.userId))[0]).toMatchObject({ used: 0, reserved: 1 });
    await h.complete(a.jobId);
    const again = await h.confirm(ctx, d, freshKey(), on);
    expect(again.exportId).toBe(a.exportId);
    expect((await dailyRows(ctx.userId))[0]).toMatchObject({ used: 1, reserved: 0 });
  });

  it("failed and canceled exports release the daily reservation", async () => {
    const ctx = await h.account();
    const failed = await exportOnce(ctx, on);
    expect((await dailyRows(ctx.userId))[0]).toMatchObject({ used: 0, reserved: 1 });
    await h.fail(failed.jobId);
    expect((await dailyRows(ctx.userId))[0]).toMatchObject({ used: 0, reserved: 0 });
    expect(await h.reservationRow(failed.jobId)).toMatchObject({ state: "released" });

    const canceled = await exportOnce(ctx, on);
    expect((await dailyRows(ctx.userId))[0]).toMatchObject({ used: 0, reserved: 1 });
    await on.exports.cancelExport(ctx, canceled.exportId);
    expect((await dailyRows(ctx.userId))[0]).toMatchObject({ used: 0, reserved: 0 });
    expect(await h.reservationRow(canceled.jobId)).toMatchObject({ state: "released" });
  });

  it("reservation at 23:59:59.999 settles on its own day, the next day's bucket untouched", async () => {
    const ctx = await h.account();
    const midnight = midnightAfter(clk.now);
    clk.now = new Date(midnight.getTime() - 1);
    const before = await exportOnce(ctx, on);
    clk.now = midnight;
    const after = await exportOnce(ctx, on);
    const rows = await dailyRows(ctx.userId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.used, r.reserved])).toEqual([[0, 1], [0, 1]]);
    expect(rows[1]!.starts_at.getTime()).toBe(midnight.getTime());

    await h.complete(before.jobId);
    expect((await dailyRows(ctx.userId)).map((r) => [r.used, r.reserved])).toEqual([[1, 0], [0, 1]]);
    expect(await h.reservationRow(before.jobId)).toMatchObject({ bucket_id: rows[0]!.id, state: "consumed" });
    expect(await h.reservationRow(after.jobId)).toMatchObject({ bucket_id: rows[1]!.id, state: "reserved" });
  });

  it("limit changed mid-day: today's bucket keeps its limit_count, tomorrow uses the new value", async () => {
    const ctx = await h.account();
    await exportOnce(ctx, on);
    const two = dalWith({ dailyRefresh: { enabled: true, limit: 2 } });
    await exportOnce(ctx, two);
    await exportOnce(ctx, two);
    expect((await dailyRows(ctx.userId))[0]).toMatchObject({ limit_count: 5, reserved: 3 });
    clk.now = new Date(midnightAfter(clk.now).getTime() + 1000);
    await exportOnce(ctx, two);
    await exportOnce(ctx, two);
    expect(await code(exportOnce(ctx, two))).toBe("ALLOWANCE_EXHAUSTED");
    expect((await dailyRows(ctx.userId))[1]).toMatchObject({ limit_count: 2, reserved: 2 });
  });

  it("a free account with trial use gets a fresh daily bucket when the perk turns on", async () => {
    const ctx = await h.account();
    await exportAndComplete(ctx, off);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1 });
    for (let i = 0; i < 5; i++) await exportOnce(ctx, on);
    expect(await code(exportOnce(ctx, on))).toBe("ALLOWANCE_EXHAUSTED");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
    expect(await dailyRows(ctx.userId)).toHaveLength(1);
    expect((await off.history.getAllowance(ctx))).toMatchObject({ source: "trial", limit: 3, used: 1, pending: 5, remaining: 0 });
  });
});

describe("perk off after beta use", () => {
  it.each([[0, 3], [1, 2], [2, 1]])("perk off after %i beta exports: remaining is max(0, limit_count - N), one more is allowed up to the limit", async (n, remaining) => {
    const ctx = await h.account();
    for (let i = 0; i < n; i++) await exportAndComplete(ctx, on);
    expect(await off.history.getAllowance(ctx)).toMatchObject({ source: "trial", limit: 3, used: n, pending: 0, remaining });
    for (let i = 0; i < remaining; i++) await exportAndComplete(ctx, off);
    expect(await code(exportOnce(ctx, off))).toBe("ALLOWANCE_EXHAUSTED");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: remaining, reserved: 0 });
    expect(await off.history.getAllowance(ctx)).toMatchObject({ remaining: 0 });
  });

  it("perk off after N beta exports: remaining is max(0, limit_count - N), N >= 3 refuses, an in-flight beta export counts", async () => {
    const ctx = await h.account();
    for (let i = 0; i < 3; i++) await exportAndComplete(ctx, on);
    const err = await exportOnce(ctx, off).catch((e) => e);
    expect(err).toBeInstanceOf(AllowanceExhausted);
    expect((err as AllowanceExhausted).source).toBe("trial");
    expect(await off.history.getAllowance(ctx)).toMatchObject({ used: 3, remaining: 0 });

    const more = await h.account();
    await exportAndComplete(more, on);
    await exportAndComplete(more, on);
    const inflight = await exportOnce(more, on); // reserved, not yet consumed, when the perk is switched off
    expect(await off.history.getAllowance(more)).toMatchObject({ used: 2, pending: 1, remaining: 0 });
    expect(await code(exportOnce(more, off))).toBe("ALLOWANCE_EXHAUSTED");
    await h.fail(inflight.jobId); // its reservation returns, so the count does too
    expect(await off.history.getAllowance(more)).toMatchObject({ used: 2, pending: 0, remaining: 1 });
    await exportOnce(more, off);
    expect(await h.bucket(more.userId)).toMatchObject({ reserved: 1 });
  });

  it("a trial reservation made with the perk off settles on the trial bucket after the perk is turned on", async () => {
    const ctx = await h.account();
    const r = await exportOnce(ctx, off);
    expect(await code(exportOnce(ctx, on))).toBeNull(); // perk on meanwhile: a daily bucket is created and used
    await h.complete(r.jobId);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 1, reserved: 0 });
    expect(await dailyRows(ctx.userId).then((rows) => rows.map((x) => [x.used, x.reserved]))).toEqual([[0, 1]]);
    expect(await h.reservationRow(r.jobId)).toMatchObject({ state: "consumed" });
  });

  it("perk on, off, on stays consistent and the drift views are empty after every step", async () => {
    const ctx = await h.account();
    await exportAndComplete(ctx, on);
    await h.expectNoDrift();
    await exportAndComplete(ctx, off);
    await h.expectNoDrift();
    await exportAndComplete(ctx, off);
    await h.expectNoDrift();
    expect(await code(exportOnce(ctx, off))).toBe("ALLOWANCE_EXHAUSTED");
    await exportAndComplete(ctx, on);
    await h.expectNoDrift();
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 2, reserved: 0 });
    expect((await dailyRows(ctx.userId))[0]).toMatchObject({ used: 2, reserved: 0 });
    expect(await code(exportOnce(ctx, off))).toBe("ALLOWANCE_EXHAUSTED");
  });
});

describe("paid accounts", () => {
  it("paid entitled account ignores daily rows in both settings", async () => {
    const ctx = await h.account();
    for (let i = 0; i < 2; i++) await exportAndComplete(ctx, on); // two beta exports, then it subscribes
    const start = new Date(clk.now.getTime() - 86_400_000);
    const end = new Date(clk.now.getTime() + 30 * 86_400_000);
    const sub = await h.admin.query(
      `INSERT INTO subscription (owner_id, stripe_subscription_id, stripe_price_id, status, period_start, period_end, latest_invoice_paid, synced_at)
       VALUES ($1, $2, 'price_test', 'active', $3, $4, true, now()) RETURNING id`,
      [ctx.userId, `sub_${randomUUID()}`, start, end],
    );
    const paid = await h.admin.query(
      `INSERT INTO usage_bucket (owner_id, kind, limit_count, subscription_id, period_key, starts_at, ends_at)
       VALUES ($1, 'paid', 2, $2, $3, $4, $5) RETURNING id`,
      [ctx.userId, sub.rows[0].id, Math.floor(start.getTime() / 1000), start, end],
    );
    const paidId = paid.rows[0].id as string;
    const before = await dailyRows(ctx.userId);
    for (const dal of [on, off]) {
      expect(await dal.history.getAllowance(ctx)).toMatchObject({ source: "paid", limit: 2, resetsAt: null });
    }
    await exportOnce(ctx, on);
    await exportOnce(ctx, off);
    expect(await code(exportOnce(ctx, on))).toBe("ALLOWANCE_EXHAUSTED");
    expect(await code(exportOnce(ctx, off))).toBe("ALLOWANCE_EXHAUSTED");
    expect((await h.admin.query(`SELECT used, reserved FROM usage_bucket WHERE id = $1`, [paidId])).rows[0]).toMatchObject({ used: 0, reserved: 2 });
    expect(await dailyRows(ctx.userId)).toEqual(before);
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
  });
});

describe("legacy generate flow", () => {
  const input = (notes: string) => ({
    topic: "linear_equations_one_variable",
    level: "Grade 7-8 equivalent",
    objectives: ["Solve ax + b = c"],
    durationMinutes: 60,
    difficulty: "mixed",
    questionCount: 5,
    notes,
  });

  it("createGeneration (legacy flow) follows the same rule", async () => {
    const ctx = await h.account();
    for (let i = 0; i < 5; i++) await on.generation.createGeneration(ctx, input(`n${i}`), freshKey());
    const err = await on.generation.createGeneration(ctx, input("n5"), freshKey()).catch((e) => e);
    expect(err).toBeInstanceOf(AllowanceExhausted);
    expect((err as AllowanceExhausted).source).toBe("daily");
    expect(await h.bucket(ctx.userId)).toMatchObject({ used: 0, reserved: 0 });
    expect((await dailyRows(ctx.userId))[0]).toMatchObject({ used: 0, reserved: 5 });

    // Perk off: the five in-flight beta reservations already use up the lifetime 3.
    const off1 = await off.generation.createGeneration(ctx, input("off"), freshKey()).catch((e) => e);
    expect(off1).toBeInstanceOf(AllowanceExhausted);
    expect((off1 as AllowanceExhausted).source).toBe("trial");
    await h.admin.query(`UPDATE generation_job SET state = 'canceled', error_code = 'test_cleanup', finished_at = now() WHERE owner_id = $1`, [ctx.userId]);
    await h.admin.query(`UPDATE usage_reservation SET state = 'released', settle_reason = 'test_cleanup', settled_at = now() WHERE owner_id = $1`, [ctx.userId]);
    await h.admin.query(`UPDATE usage_bucket SET reserved = 0 WHERE owner_id = $1`, [ctx.userId]);
  });
});

describe("allowance display", () => {
  it("daily display without a row is synthetic and never inserts; with a row it reports the day", async () => {
    const ctx = await h.account();
    expect(await on.history.getAllowance(ctx)).toMatchObject({ source: "daily", limit: 5, used: 0, pending: 0, remaining: 5, resetsAt: midnightAfter(clk.now) });
    expect(await dailyRows(ctx.userId)).toEqual([]);
    await exportAndComplete(ctx, on);
    await exportOnce(ctx, on);
    expect(await on.history.getAllowance(ctx)).toMatchObject({ source: "daily", limit: 5, used: 1, pending: 1, remaining: 3 });
    clk.now = new Date(midnightAfter(clk.now).getTime() + 1);
    expect(await on.history.getAllowance(ctx)).toMatchObject({ used: 0, pending: 0, remaining: 5 });
    expect(await dailyRows(ctx.userId)).toHaveLength(1);
  });

  it("trial display has no resetsAt and folds beta use into the lifetime numbers", async () => {
    const ctx = await h.account();
    expect(await off.history.getAllowance(ctx)).toMatchObject({ source: "trial", limit: 3, used: 0, remaining: 3, resetsAt: null });
  });
});
