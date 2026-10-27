import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAuthRateDal } from "@/lib/server/dal/auth-rate";
import { createHarness, type Harness } from "./export-helpers";

// The per-IP limit on the unauthenticated email actions (auth:<kind>:ip:<hash> in rate_limit_window).
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.admin.query(`DELETE FROM rate_limit_window WHERE key LIKE 'auth:%'`);
});
afterAll(async () => {
  await h.close();
});

const dal = (max: number) => createAuthRateDal(h.appDb, { authEmailPerIpPerHour: max });
const rows = async (key: string) => (await h.admin.query(`SELECT window_start, count FROM rate_limit_window WHERE key = $1`, [key])).rows as { window_start: Date; count: number }[];

describe("authRate.hit", () => {
  it("counts each request and refuses beyond the maximum", async () => {
    const ip = randomUUID();
    const d = dal(3);
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await d.hit(ip, "reset"));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4, 5]);
    expect((await rows(`auth:reset:ip:${ip}`))[0]?.count).toBe(5);
  });

  it("keeps the two kinds and different addresses apart", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const d = dal(1);
    expect((await d.hit(a, "reset")).allowed).toBe(true);
    expect((await d.hit(a, "reset")).allowed).toBe(false);
    expect((await d.hit(a, "resend")).allowed).toBe(true);
    expect((await d.hit(b, "reset")).allowed).toBe(true);
  });

  it("starts a fresh count in a new hour window", async () => {
    const ip = randomUUID();
    const d = dal(1);
    await d.hit(ip, "resend");
    expect((await d.hit(ip, "resend")).allowed).toBe(false);
    await h.admin.query(`UPDATE rate_limit_window SET window_start = window_start - interval '1 hour' WHERE key = $1`, [`auth:resend:ip:${ip}`]);
    expect(await d.hit(ip, "resend")).toEqual({ allowed: true, count: 1 });
    expect(await rows(`auth:resend:ip:${ip}`)).toHaveLength(2);
  });

  it("counts concurrent requests exactly", async () => {
    const ip = randomUUID();
    const d = dal(4);
    const results = await Promise.all(Array.from({ length: 8 }, () => d.hit(ip, "reset")));
    expect(results.filter((r) => r.allowed)).toHaveLength(4);
    expect((await rows(`auth:reset:ip:${ip}`))[0]?.count).toBe(8);
  });
});
