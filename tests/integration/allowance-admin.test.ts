import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAdminRefresh } from "@/lib/server/admin-refresh";
import { createWebDal } from "@/lib/server/dal";
import type { AllowancePolicy } from "@/lib/server/dal/allowance-source";
import { refreshTodayForAll } from "@/lib/server/dal/allowance-admin";
import { inTransaction } from "@/lib/server/dal/tx";
import { code, createHarness, freshKey, OPEN_GEN, OPEN_LIMITS, type Harness } from "./export-helpers";

// The operator top-up (D-113): limit_count = used + reserved + limit for today's daily buckets; counters are never edited.
let h: Harness;
const clk = { now: new Date() };
const ON: AllowancePolicy = { dailyRefresh: { enabled: true, limit: 5 } };
const OFF: AllowancePolicy = { dailyRefresh: { enabled: false, limit: 5 } };
const TOKEN = "k".repeat(48);

function dalWith(policy: AllowancePolicy) {
  return createWebDal(h.appDb, { limits: OPEN_GEN, clock: () => clk.now, curriculum: { allowSample: true }, drafts: { limits: OPEN_LIMITS }, exports: { enabled: true, limits: OPEN_LIMITS }, allowancePolicy: policy });
}
let on: ReturnType<typeof dalWith>;

beforeAll(async () => {
  h = await createHarness({ clock: () => clk.now });
  on = dalWith(ON);
  await h.parkForeignJobs();
});
beforeEach(async () => {
  await h.admin.query(`DELETE FROM rate_limit_window WHERE key LIKE 'admin:refresh:%'`);
});
afterEach(async () => {
  await h.expectNoDrift();
  await h.abandonPending();
  vi.restoreAllMocks();
  clk.now = new Date();
});
afterAll(async () => {
  await h.close();
});

const dailyRow = async (ownerId: string) => (await h.admin.query(`SELECT used, reserved, limit_count FROM usage_bucket WHERE owner_id = $1 AND kind = 'daily'`, [ownerId])).rows[0] as { used: number; reserved: number; limit_count: number } | undefined;
const bucketTable = async (ownerId: string) => (await h.admin.query(`SELECT id, kind, used, reserved, limit_count FROM usage_bucket WHERE owner_id = $1 ORDER BY kind`, [ownerId])).rows;
async function exportOnce(ctx: Parameters<typeof h.newDraft>[0], dal = on) {
  const d = await h.newDraft(ctx, {}, dal);
  return h.confirm(ctx, d, freshKey(), dal);
}
const call = (over: { authorization?: string | null; policy?: AllowancePolicy; at?: Date } = {}) =>
  runAdminRefresh({ authorization: over.authorization === undefined ? `Bearer ${TOKEN}` : over.authorization, expectedToken: TOKEN, requestId: "req-1" }, { db: h.appDb, policy: over.policy ?? ON, clock: () => over.at ?? clk.now });
// The one-per-minute guard rows are cleared before each test; tests that need a second call choose the minute explicitly.
// A minute boundary of the current UTC day such that this minute and the next one are both on that day (a pinned midday clock
// would put drafts and reservations hours away from the database clock, so the real day is used and only the minute is chosen).
const minuteStart = () => {
  const base = Math.floor(Date.now() / 60_000) * 60_000;
  const crosses = Math.floor((base + 60_000) / 86_400_000) !== Math.floor(base / 86_400_000);
  return new Date(crosses ? base - 60_000 : base);
};
const nextMinute = () => clk.now;
const rateRows = async () => Number((await h.admin.query(`SELECT count(*)::int AS n FROM rate_limit_window WHERE key LIKE 'admin:refresh:%'`)).rows[0].n);

describe("refreshTodayForAll", () => {
  it("an exhausted account can reserve again after a top-up; counters are not edited and drift stays clean", async () => {
    const ctx = await h.account();
    for (let i = 0; i < 5; i++) await h.complete((await exportOnce(ctx)).jobId);
    expect(await code(exportOnce(ctx))).toBe("ALLOWANCE_EXHAUSTED");
    const trialBefore = await h.bucket(ctx.userId);

    const r = await inTransaction(h.appDb, (tx) => refreshTodayForAll(tx, clk.now, ON));
    expect(r.accounts).toBeGreaterThanOrEqual(1); // the UPDATE touches every daily bucket of today in the shared DB
    expect(await dailyRow(ctx.userId)).toEqual({ used: 5, reserved: 0, limit_count: 10 });
    expect(await h.bucket(ctx.userId)).toEqual(trialBefore);

    await h.complete((await exportOnce(ctx)).jobId);
    expect(await dailyRow(ctx.userId)).toEqual({ used: 6, reserved: 0, limit_count: 10 });
  });

  it("never lowers a limit: after reservations are released and DAILY_REFRESH_LIMIT is 5, the row stays at 8 and is not counted", async () => {
    const ctx = await h.account();
    const jobs = [];
    for (let i = 0; i < 3; i++) jobs.push(await exportOnce(ctx));
    await inTransaction(h.appDb, (tx) => refreshTodayForAll(tx, clk.now, ON));
    expect(await dailyRow(ctx.userId)).toEqual({ used: 0, reserved: 3, limit_count: 8 });
    for (const j of jobs) await h.fail(j.jobId);
    expect(await dailyRow(ctx.userId)).toEqual({ used: 0, reserved: 0, limit_count: 8 });
    // Run the top-up again with the same limit: the released row (limit 8 > 0 + 0 + 5) must not be lowered or counted.
    await inTransaction(h.appDb, (tx) => refreshTodayForAll(tx, clk.now, ON));
    expect(await dailyRow(ctx.userId)).toEqual({ used: 0, reserved: 0, limit_count: 8 });
    const third = await inTransaction(h.appDb, (tx) => refreshTodayForAll(tx, clk.now, ON));
    expect(third.accounts).toBe(0);
  });

  it("a reserved (in-flight) bucket counts toward the new limit", async () => {
    const ctx = await h.account();
    for (let i = 0; i < 3; i++) await exportOnce(ctx);
    await inTransaction(h.appDb, (tx) => refreshTodayForAll(tx, clk.now, ON));
    expect(await dailyRow(ctx.userId)).toEqual({ used: 0, reserved: 3, limit_count: 8 });
  });

  it("does not touch trial or paid buckets, other days, or accounts already at the target", async () => {
    const trialOnly = await h.account();
    const fresh = await h.account();
    await exportOnce(fresh); // daily bucket {0, 1, 5}: limit 5 != 1 + 5, so it is topped up
    const before = await bucketTable(trialOnly.userId);
    const yesterday = new Date(clk.now.getTime() - 86_400_000);
    const stale = await h.account();
    clk.now = yesterday;
    await exportOnce(stale);
    clk.now = new Date();
    const staleBefore = await bucketTable(stale.userId);

    await inTransaction(h.appDb, (tx) => refreshTodayForAll(tx, clk.now, ON));
    expect(await bucketTable(trialOnly.userId)).toEqual(before);
    expect(await bucketTable(stale.userId)).toEqual(staleBefore);
    // Idempotent: a second run changes no row for an account already at used + reserved + limit.
    await inTransaction(h.appDb, (tx) => refreshTodayForAll(tx, clk.now, ON));
    expect(await dailyRow(fresh.userId)).toEqual({ used: 0, reserved: 1, limit_count: 6 });
    const third = await inTransaction(h.appDb, (tx) => refreshTodayForAll(tx, clk.now, ON));
    expect(third.accounts).toBe(0);
  });

  it("a paid bucket is untouched, even when the owner also has a daily row", async () => {
    const ctx = await h.account();
    await exportOnce(ctx);
    const start = new Date(clk.now.getTime() - 86_400_000);
    const end = new Date(clk.now.getTime() + 30 * 86_400_000);
    const sub = await h.admin.query(
      `INSERT INTO subscription (owner_id, stripe_subscription_id, stripe_price_id, status, period_start, period_end, latest_invoice_paid, synced_at)
       VALUES ($1, $2, 'price_test', 'active', $3, $4, true, now()) RETURNING id`,
      [ctx.userId, `sub_${randomUUID()}`, start, end],
    );
    await h.admin.query(
      `INSERT INTO usage_bucket (owner_id, kind, limit_count, subscription_id, period_key, starts_at, ends_at) VALUES ($1, 'paid', 2, $2, $3, $4, $5)`,
      [ctx.userId, sub.rows[0].id, Math.floor(start.getTime() / 1000), start, end],
    );
    const before = await bucketTable(ctx.userId);
    await inTransaction(h.appDb, (tx) => refreshTodayForAll(tx, clk.now, ON));
    const after = await bucketTable(ctx.userId);
    expect(after.filter((r) => r.kind !== "daily")).toEqual(before.filter((r) => r.kind !== "daily"));
    expect(after.find((r) => r.kind === "daily")).toMatchObject({ used: 0, reserved: 1, limit_count: 6 });
  });
});

describe("runAdminRefresh", () => {
  it("200 with the account count only; logs only the request id and the count", async () => {
    const ctx = await h.account();
    await exportOnce(ctx);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const all = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation(() => {}));
    const res = await call({ at: nextMinute() });
    // the count covers every daily bucket of today in the shared DB; the body has no other key
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["accounts"]);
    const lines = JSON.stringify([log.mock.calls, ...all.map((s) => s.mock.calls)]);
    expect(lines).toContain("req-1");
    expect(lines).not.toContain(TOKEN);
    expect(lines).not.toContain(ctx.userId);
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });

  it("tops up the current day through the full path", async () => {
    const ctx = await h.account();
    const at = nextMinute();
    for (let i = 0; i < 5; i++) await h.complete((await exportOnce(ctx)).jobId);
    expect(await code(exportOnce(ctx))).toBe("ALLOWANCE_EXHAUSTED");
    const res = await call({ at });
    expect(res.status).toBe(200);
    expect((res.body as { accounts: number }).accounts).toBeGreaterThanOrEqual(1); // every daily bucket of today in the shared DB
    expect(await dailyRow(ctx.userId)).toEqual({ used: 5, reserved: 0, limit_count: 10 });
    await exportOnce(ctx);
  });

  it("401 for wrong, empty, missing, prefix-only and wrong-scheme tokens; no data or rate row changes", async () => {
    const ctx = await h.account();
    await exportOnce(ctx);
    const before = await dailyRow(ctx.userId);
    const rates = await rateRows();
    for (const authorization of [null, "", "Bearer ", "Bearer wrong", `Bearer ${TOKEN.slice(0, 20)}`, `Basic ${TOKEN}`, TOKEN]) {
      const res = await call({ authorization, at: nextMinute() });
      expect(res).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
    expect(await dailyRow(ctx.userId)).toEqual(before);
    expect(await rateRows()).toBe(rates);
  });

  it("an unauthenticated flood does not use the one-per-minute guard", async () => {
    const at = nextMinute();
    for (let i = 0; i < 5; i++) expect((await call({ authorization: "Bearer nope", at })).status).toBe(401);
    expect((await call({ at })).status).toBe(200);
  });

  it("409 when the perk is off, changing nothing and not using the guard", async () => {
    const ctx = await h.account();
    await exportOnce(ctx);
    const before = await dailyRow(ctx.userId);
    const rates = await rateRows();
    const at = nextMinute();
    expect(await call({ policy: OFF, at })).toEqual({ status: 409, body: { error: "refresh_disabled" } });
    expect(await dailyRow(ctx.userId)).toEqual(before);
    expect(await rateRows()).toBe(rates);
    expect((await call({ at })).status).toBe(200);
  });

  it("429 for a second call inside the same minute, changing no data; works again after the window", async () => {
    const ctx = await h.account();
    const at = minuteStart();
    for (let i = 0; i < 5; i++) await h.complete((await exportOnce(ctx)).jobId);
    expect((await call({ at })).status).toBe(200);
    await exportOnce(ctx); // used 5 -> reserved 1: row {5,1,10}; target would be 11
    const before = await dailyRow(ctx.userId);
    expect(await call({ at: new Date(at.getTime() + 30_000) })).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(await dailyRow(ctx.userId)).toEqual(before);
    expect((await call({ at: new Date(at.getTime() + 60_000) })).status).toBe(200);
    expect(await dailyRow(ctx.userId)).toEqual({ used: 5, reserved: 1, limit_count: 11 });
  });

  it("concurrent authenticated calls: exactly one succeeds", async () => {
    const at = nextMinute();
    const results = await Promise.all([call({ at }), call({ at }), call({ at })]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
  });
});
