import { beforeEach, describe, expect, it, vi } from "vitest";
import { bearerToken, tokenMatches } from "@/lib/server/admin-refresh";
import { parseServerEnv } from "@/lib/server/env";

const c = vi.hoisted(() => ({ tse: vi.fn() }));
vi.mock("node:crypto", async (orig) => {
  const actual = await orig<typeof import("node:crypto")>();
  c.tse.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: c.tse };
});

const TOKEN = "t".repeat(40);
const DB = "postgresql://app_login:x@127.0.0.1:5432/db";

describe("bearerToken", () => {
  it("extracts only a well-formed Bearer credential", () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    for (const bad of [null, "", "Bearer", "Bearer ", `Basic ${TOKEN}`, TOKEN, `Token ${TOKEN}`]) expect(bearerToken(bad)).toBeNull();
  });
});

describe("tokenMatches", () => {
  it("accepts the exact token only", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
  });
  it("rejects wrong, empty, missing, prefix-only and over-long tokens", () => {
    for (const bad of [null, undefined, "", "x".repeat(40), TOKEN.slice(0, 10), TOKEN.slice(0, -1), TOKEN + "x", " " + TOKEN]) expect(tokenMatches(bad, TOKEN)).toBe(false);
  });
  it("compares SHA-256 digests with timingSafeEqual", async () => {
    c.tse.mockClear();
    tokenMatches("short", TOKEN);
    tokenMatches(TOKEN + TOKEN, TOKEN);
    // Different lengths still reach a compare of two equal-length digests (no length-based early exit).
    expect(c.tse).toHaveBeenCalledTimes(2);
    for (const call of c.tse.mock.calls) expect((call[0] as Buffer).length).toBe(32);
  });
});

describe("ADMIN_REFRESH_* environment", () => {
  it("is off by default and needs no token", () => {
    const env = parseServerEnv({ DATABASE_URL: DB });
    expect(env.ADMIN_REFRESH_ENABLED).toBe("0");
    expect(env.ADMIN_REFRESH_TOKEN).toBeUndefined();
  });
  it("enabled without a token, or with a short one, fails at startup without echoing the value", () => {
    expect(() => parseServerEnv({ DATABASE_URL: DB, ADMIN_REFRESH_ENABLED: "1" })).toThrow(/ADMIN_REFRESH_TOKEN/);
    const short = "s3cr3t-short-value";
    let message = "";
    try {
      parseServerEnv({ DATABASE_URL: DB, ADMIN_REFRESH_ENABLED: "1", ADMIN_REFRESH_TOKEN: short });
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toMatch(/ADMIN_REFRESH_TOKEN/);
    expect(message).not.toContain(short);
  });
  it("enabled with a 32+ character token parses; an invalid flag value fails", () => {
    expect(parseServerEnv({ DATABASE_URL: DB, ADMIN_REFRESH_ENABLED: "1", ADMIN_REFRESH_TOKEN: "a".repeat(32) }).ADMIN_REFRESH_TOKEN).toHaveLength(32);
    expect(() => parseServerEnv({ DATABASE_URL: DB, ADMIN_REFRESH_ENABLED: "yes" })).toThrow();
  });
});

// The route: disabled answers like a missing route, whatever the method or token.
const m = vi.hoisted(() => ({ env: { ADMIN_REFRESH_ENABLED: "0", ADMIN_REFRESH_TOKEN: undefined as string | undefined, limits: { dailyRefreshEnabled: 1, dailyRefreshLimit: 5 } }, run: vi.fn() }));
vi.mock("@/lib/server/env", async (orig) => ({ ...(await orig<typeof import("@/lib/server/env")>()), serverEnv: () => m.env }));
vi.mock("@/lib/server/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/server/admin-refresh", async (orig) => ({ ...(await orig<typeof import("@/lib/server/admin-refresh")>()), runAdminRefresh: m.run }));

describe("route /api/admin/refresh-allowance", () => {
  beforeEach(() => m.run.mockReset());
  const req = (method: string, auth?: string) => new Request("http://x/api/admin/refresh-allowance", { method, headers: auth ? { authorization: auth } : {} });

  it("disabled: every method throws the framework not-found, even with the correct token, and nothing is run", async () => {
    const route = await import("@/app/api/admin/refresh-allowance/route");
    m.env = { ADMIN_REFRESH_ENABLED: "0", ADMIN_REFRESH_TOKEN: TOKEN, limits: m.env.limits };
    for (const handler of [route.POST, route.GET, route.PUT, route.PATCH, route.DELETE]) {
      await expect(Promise.resolve().then(() => handler(req("POST", `Bearer ${TOKEN}`)))).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    }
    expect(m.run).not.toHaveBeenCalled();
  });

  it("enabled: non-POST gets 405 with Allow, without reading the token", async () => {
    const route = await import("@/app/api/admin/refresh-allowance/route");
    m.env = { ADMIN_REFRESH_ENABLED: "1", ADMIN_REFRESH_TOKEN: TOKEN, limits: m.env.limits };
    const res = await route.GET(req("GET", `Bearer ${TOKEN}`));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(m.run).not.toHaveBeenCalled();
  });

  it("enabled: maps outcomes to status, no-store, and a body without the token", async () => {
    const route = await import("@/app/api/admin/refresh-allowance/route");
    m.env = { ADMIN_REFRESH_ENABLED: "1", ADMIN_REFRESH_TOKEN: TOKEN, limits: m.env.limits };
    for (const [outcome, status] of [[{ status: 200, body: { accounts: 3 } }, 200], [{ status: 401, body: { error: "unauthorized" } }, 401], [{ status: 409, body: { error: "conflict" } }, 409], [{ status: 429, body: { error: "rate_limited" } }, 429]] as const) {
      m.run.mockResolvedValueOnce(outcome);
      const res = await route.POST(req("POST", `Bearer ${TOKEN}`));
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(JSON.stringify(await res.json())).not.toContain(TOKEN);
    }
    expect(m.run.mock.calls[0]![0]).toMatchObject({ authorization: `Bearer ${TOKEN}`, expectedToken: TOKEN });
  });
});
