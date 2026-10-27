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

const dal = (max: number, globalMax = 100_000) => createAuthRateDal(h.appDb, { authEmailPerIpPerHour: max, authEmailGlobalPerHour: globalMax });
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

  it("applies a global cap per kind, checked first, without creating per-IP rows once it is hit", async () => {
    const d = dal(100, 3);
    const ips = Array.from({ length: 6 }, () => randomUUID());
    const results = [];
    for (const ip of ips) results.push((await d.hit(ip, "reset")).allowed);
    expect(results).toEqual([true, true, true, false, false, false]);
    const perIp = (await h.admin.query(`SELECT count(*)::int AS n FROM rate_limit_window WHERE key LIKE 'auth:reset:ip:%'`)).rows[0].n;
    expect(perIp).toBe(3);
    expect((await rows("auth:reset:global"))[0]?.count).toBe(3); // refused requests are not counted globally
    expect((await d.hit(randomUUID(), "resend")).allowed).toBe(true); // the other kind has its own cap
  });

  it("counts only requests the per-IP limit allows toward the global cap", async () => {
    const d = dal(3, 100);
    const ip = randomUUID();
    for (let i = 0; i < 8; i++) await d.hit(ip, "reset");
    expect((await rows("auth:reset:global"))[0]?.count).toBe(3);
    expect((await rows(`auth:reset:ip:${ip}`))[0]?.count).toBe(8);
  });

  it("two different IPs share the global cap and no per-IP row appears once it is reached", async () => {
    const d = dal(10, 4);
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    expect([(await d.hit(a, "resend")).allowed, (await d.hit(a, "resend")).allowed, (await d.hit(b, "resend")).allowed, (await d.hit(b, "resend")).allowed]).toEqual([true, true, true, true]);
    expect((await d.hit(c, "resend")).allowed).toBe(false);
    expect((await d.hit(a, "resend")).allowed).toBe(false);
    expect(await rows(`auth:resend:ip:${c}`)).toHaveLength(0);
    expect((await rows(`auth:resend:ip:${a}`))[0]?.count).toBe(2);
    expect((await rows("auth:resend:global"))[0]?.count).toBe(4);
  });

  it("keys on whatever hash it is given, so /64 and IPv4-mapped equivalence comes from clientIpHash", async () => {
    const { clientIpHash } = await import("@/lib/server/auth/client-ip");
    const hdr = (ip: string) => ({ get: (k: string) => (k === "x-real-ip" ? ip : null) });
    const d = dal(1);
    expect((await d.hit(clientIpHash(hdr("2001:db8:1:2::1")), "reset")).allowed).toBe(true);
    expect((await d.hit(clientIpHash(hdr("2001:db8:1:2:ffff::9")), "reset")).allowed).toBe(false);
    expect((await d.hit(clientIpHash(hdr("203.0.113.7")), "reset")).allowed).toBe(true);
    expect((await d.hit(clientIpHash(hdr("::ffff:203.0.113.7")), "reset")).allowed).toBe(false);
  });
});
