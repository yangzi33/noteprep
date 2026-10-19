import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createConfirmedUser, deleteCreatedUsers, env, type TestUser } from "./helpers";

const owner = new pg.Pool({ connectionString: env().dbUrl, max: 2 });
let user: TestUser;
let tables: string[] = [];

beforeAll(async () => {
  user = await createConfirmedUser();
  const { rows } = await owner.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  tables = rows.map((r) => r.tablename as string);
});
afterAll(async () => {
  await deleteCreatedUsers();
  await owner.end();
});

async function rest(path: string, init: { method?: string; bearer?: string; body?: unknown } = {}) {
  const e = env();
  const res = await fetch(`${e.apiUrl}/rest/v1/${path}`, {
    method: init.method ?? "GET",
    headers: {
      apikey: e.publishableKey,
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

describe("Supabase Data API (PostgREST) cannot reach business tables", () => {
  it("sees the application tables in the public schema", () => {
    for (const t of ["profile", "lesson", "lesson_revision", "generation_job", "usage_bucket", "usage_reservation", "subscription", "webhook_event"]) {
      expect(tables).toContain(t);
    }
  });

  it("anon and authenticated hold no privileges on any public table, including migration state", async () => {
    const { rows } = await owner.query(
      `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`,
    );
    expect(rows).toEqual([]);
  });

  it("returns no rows for any table to an anonymous caller or to a signed-in user", async () => {
    for (const table of tables) {
      for (const bearer of [undefined, user.accessToken]) {
        const res = await rest(`${table}?select=*&limit=1`, { bearer });
        expect(res.status, `${table} as ${bearer ? "user" : "anon"}: ${res.text}`).toBeGreaterThanOrEqual(400);
        expect(res.text).not.toMatch(/"id"/);
      }
    }
  });

  it("refuses writes, including a user inserting their own profile or buckets", async () => {
    const attempts = [
      rest("profile", { method: "POST", bearer: user.accessToken, body: { id: user.id } }),
      rest("usage_bucket", { method: "POST", bearer: user.accessToken, body: { owner_id: user.id, kind: "trial", limit_count: 999 } }),
      rest("subscription", { method: "POST", bearer: user.accessToken, body: { owner_id: user.id } }),
      rest(`usage_bucket?owner_id=eq.${user.id}`, { method: "PATCH", bearer: user.accessToken, body: { limit_count: 999 } }),
      rest(`profile?id=eq.${user.id}`, { method: "DELETE", bearer: user.accessToken }),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM profile WHERE id = $1`, [user.id]);
    expect(rows[0].n).toBe(0);
  });
});
