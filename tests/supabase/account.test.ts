import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { makeAuthedCtx } from "@/lib/server/auth/context";
import { createDb } from "@/lib/server/db";
import { createWebDal } from "@/lib/server/dal";
import { createConfirmedUser, deleteCreatedUsers, env } from "./helpers";

const db = createDb(env().appUrl);
const dal = createWebDal(db);
const owner = new pg.Pool({ connectionString: env().dbUrl, max: 2 });

afterAll(async () => {
  await deleteCreatedUsers();
  await db.$disconnect();
  await owner.end();
});

describe("account creation for real Auth users", () => {
  it("creates one profile and one trial bucket for a user, however often the callback runs", async () => {
    const user = await createConfirmedUser();
    const ctx = makeAuthedCtx(user.id);
    expect(await dal.account.getStatus(ctx)).toBeNull();
    await Promise.all(Array.from({ length: 6 }, () => dal.account.ensureAccount(ctx)));
    await dal.account.ensureAccount(ctx);
    expect(await dal.account.getStatus(ctx)).toBe("active");
    const { rows } = await owner.query(`SELECT kind, limit_count, used, reserved FROM usage_bucket WHERE owner_id = $1`, [user.id]);
    expect(rows).toEqual([{ kind: "trial", limit_count: 3, used: 0, reserved: 0 }]);
  });

  it("the web login role works through the real database roles (RLS enabled, no BYPASSRLS)", async () => {
    const { rows } = await owner.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'app_runtime'`);
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});
