import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { makeAuthedCtx } from "@/lib/server/auth/context";
import { createDb } from "@/lib/server/db";
import { createWebDal } from "@/lib/server/dal";
import { pgErrorCode, pools } from "./helpers";

const info = inject("testDb");
const { admin, app, worker } = pools();
const db = createDb(info.appUrl);
const dal = createWebDal(db);

afterAll(async () => {
  await Promise.all([admin.end(), app.end(), worker.end(), db.$disconnect()]);
});

const newUser = async () => {
  const ctx = makeAuthedCtx(randomUUID());
  await dal.account.ensureAccount(ctx);
  return ctx;
};

describe("display time zone preference", () => {
  it("is Auto (null) until saved, then persists, then resets to Auto", async () => {
    const ctx = await newUser();
    expect(await dal.account.getTimeZone(ctx)).toBeNull();
    await dal.account.setTimeZone(ctx, "America/Toronto");
    expect(await dal.account.getTimeZone(ctx)).toBe("America/Toronto");
    await dal.account.setTimeZone(ctx, null);
    expect(await dal.account.getTimeZone(ctx)).toBeNull();
  });

  it("is per user: saving for one account does not touch another", async () => {
    const a = await newUser();
    const b = await newUser();
    await dal.account.setTimeZone(a, "Asia/Tokyo");
    expect(await dal.account.getTimeZone(b)).toBeNull();
  });

  it("does nothing for an unknown account and reads null", async () => {
    const ghost = makeAuthedCtx(randomUUID());
    await dal.account.setTimeZone(ghost, "Asia/Tokyo");
    expect(await dal.account.getTimeZone(ghost)).toBeNull();
  });

  it("the database bounds the stored name", async () => {
    const ctx = await newUser();
    expect(await pgErrorCode(() => app.query(`UPDATE profile SET timezone = $1 WHERE id = $2`, ["x".repeat(65), ctx.userId]))).toBe("23514");
  });
});
