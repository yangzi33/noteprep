import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { DEV_DEFAULT_LIMITS } from "@/lib/domain/generation";
import { makeAuthedCtx } from "@/lib/server/auth/context";
import { createDb } from "@/lib/server/db";
import { createWebDal } from "@/lib/server/dal";
import { pools } from "./helpers";

const info = inject("testDb");
const { admin } = pools();
const appDb = createDb(info.appUrl);
const NOW = new Date("2026-03-15T00:00:00Z");
const web = createWebDal(appDb, {
  clock: () => NOW,
  limits: { ...DEV_DEFAULT_LIMITS, maxActiveJobsPerUser: 100, maxQueuedJobsGlobal: 100_000, rateLimitPerHourPerUser: 1000 },
});

afterAll(async () => {
  await admin.end();
  await appDb.$disconnect();
});

const input = (notes: string) => ({
  topic: "linear_equations_one_variable",
  level: "Grade 7-8 equivalent",
  objectives: ["Solve ax + b = c"],
  durationMinutes: 60,
  difficulty: "mixed",
  questionCount: 5,
  notes,
});
const key = () => `key-${randomUUID()}`;

async function account() {
  const ctx = makeAuthedCtx(randomUUID());
  await web.account.ensureAccount(ctx);
  return ctx;
}

describe("remaining allowance view", () => {
  it("shows the full trial for a new account and null before the account exists", async () => {
    const ctx = await account();
    expect(await web.history.getAllowance(ctx)).toEqual({ source: "trial", limit: 3, used: 0, pending: 0, remaining: 3 });
    expect(await web.history.getAllowance(makeAuthedCtx(randomUUID()))).toBeNull();
  });

  it("counts an in-flight job as pending and gives it back when the job is canceled", async () => {
    const ctx = await account();
    const { job } = await web.generation.createGeneration(ctx, input("a"), key());
    expect(await web.history.getAllowance(ctx)).toMatchObject({ used: 0, pending: 1, remaining: 2 });
    await web.generation.cancelJob(ctx, job.id);
    expect(await web.history.getAllowance(ctx)).toMatchObject({ used: 0, pending: 0, remaining: 3 });
  });

  it("subtracts both consumed and pending units", async () => {
    const ctx = await account();
    await admin.query(`UPDATE usage_bucket SET used = 2, reserved = 1 WHERE owner_id = $1`, [ctx.userId]);
    expect(await web.history.getAllowance(ctx)).toEqual({ source: "trial", limit: 3, used: 2, pending: 1, remaining: 0 });
  });

  it("reports the paid period bucket, not the trial, for an entitled account", async () => {
    const ctx = await account();
    const start = new Date("2026-03-01T00:00:00Z");
    const end = new Date("2026-04-01T00:00:00Z");
    const sub = await admin.query(
      `INSERT INTO subscription (owner_id, stripe_subscription_id, stripe_price_id, status, period_start, period_end, latest_invoice_paid, synced_at)
       VALUES ($1, $2, 'price_test', 'active', $3, $4, true, now()) RETURNING id`,
      [ctx.userId, `sub_${randomUUID()}`, start, end],
    );
    await admin.query(
      `INSERT INTO usage_bucket (owner_id, kind, limit_count, used, subscription_id, period_key, starts_at, ends_at)
       VALUES ($1, 'paid', 5, 1, $2, $3, $4, $5)`,
      [ctx.userId, sub.rows[0].id, Math.floor(start.getTime() / 1000), start, end],
    );
    expect(await web.history.getAllowance(ctx)).toEqual({ source: "paid", limit: 5, used: 1, pending: 0, remaining: 4 });
  });
});

describe("job history", () => {
  it("lists only the caller's jobs, newest first, with their state", async () => {
    const alice = await account();
    const bob = await account();
    const first = await web.generation.createGeneration(alice, input("first"), key());
    await new Promise((r) => setTimeout(r, 10));
    const second = await web.generation.createGeneration(alice, input("second"), key());
    await web.generation.createGeneration(bob, input("bobs"), key());
    await web.generation.cancelJob(alice, first.job.id);

    const items = await web.history.listJobs(alice);
    expect(items.map((i) => i.jobId)).toEqual([second.job.id, first.job.id]);
    expect(items.map((i) => i.state)).toEqual(["queued", "canceled"]);
    expect(items[0]).toMatchObject({ title: "Linear equations in one variable", revisionId: null, errorCode: null });
    expect((await web.history.listJobs(bob)).map((i) => i.jobId)).not.toContain(first.job.id);
  });

  it("hides deleted lessons and clamps the page size", async () => {
    const ctx = await account();
    const { job } = await web.generation.createGeneration(ctx, input("x"), key());
    await admin.query(`UPDATE lesson SET deleted_at = now() WHERE id = (SELECT lesson_id FROM generation_job WHERE id = $1)`, [job.id]);
    expect(await web.history.listJobs(ctx)).toEqual([]);
    expect(await web.history.listJobs(ctx, -5)).toEqual([]);
    expect(await web.history.listJobs(ctx, 10_000)).toEqual([]);
  });
});
