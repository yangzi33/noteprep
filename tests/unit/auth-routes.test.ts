import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ verifyOtp: vi.fn(), exchange: vi.fn() }));
vi.mock("@/lib/supabase/public-env", () => ({ publicEnv: () => ({ siteUrl: "https://site.test" }) }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({ auth: { verifyOtp: m.verifyOtp, exchangeCodeForSession: m.exchange } }) }));

import { GET as callback } from "@/app/auth/callback/route";
import { GET as recovery } from "@/app/auth/recovery/route";

const req = (path: string) => new NextRequest(`https://evil.example${path}`, { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } });
const loc = (r: Response) => r.headers.get("location");

beforeEach(() => {
  vi.clearAllMocks();
  m.verifyOtp.mockResolvedValue({ error: null });
  m.exchange.mockResolvedValue({ error: null });
});

describe("GET /auth/recovery", () => {
  it("verifies a recovery token hash and redirects to the fixed page on the configured origin", async () => {
    const r = await recovery(req("/auth/recovery?token_hash=abc&type=recovery&next=https://evil.example/x"));
    expect(loc(r)).toBe("https://site.test/account/password");
    expect(m.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "abc" });
    expect(m.exchange).not.toHaveBeenCalled();
  });
  it("rejects any other type without calling Supabase", async () => {
    for (const t of ["signup", "email", "magiclink", "", "RECOVERY"]) {
      expect(loc(await recovery(req(`/auth/recovery?token_hash=abc&type=${t}`)))).toBe("https://site.test/login?error=recovery");
    }
    expect(loc(await recovery(req("/auth/recovery?token_hash=abc")))).toBe("https://site.test/login?error=recovery");
    expect(m.verifyOtp).not.toHaveBeenCalled();
  });
  it("falls back to the code exchange for old links and ignores next", async () => {
    const r = await recovery(req("/auth/recovery?code=c1&next=//evil.example"));
    expect(loc(r)).toBe("https://site.test/account/password");
    expect(m.exchange).toHaveBeenCalledWith("c1");
  });
  it("redirects to the failure page, echoing nothing, on provider error, throw or no parameters", async () => {
    m.verifyOtp.mockResolvedValueOnce({ error: { message: "expired" } });
    expect(loc(await recovery(req("/auth/recovery?token_hash=secret-token&type=recovery")))).toBe("https://site.test/login?error=recovery");
    m.exchange.mockRejectedValueOnce(new Error("boom"));
    expect(loc(await recovery(req("/auth/recovery?code=secret-code")))).toBe("https://site.test/login?error=recovery");
    expect(loc(await recovery(req("/auth/recovery")))).toBe("https://site.test/login?error=recovery");
  });
});

describe("GET /auth/callback", () => {
  it("verifies signup and email token hashes and honours a safe next path", async () => {
    for (const type of ["signup", "email"]) {
      m.verifyOtp.mockClear();
      expect(loc(await callback(req(`/auth/callback?token_hash=h&type=${type}&next=/lessons`)))).toBe("https://site.test/lessons");
      expect(m.verifyOtp).toHaveBeenCalledWith({ type, token_hash: "h" });
    }
  });
  it("replaces an unsafe next path and rejects other types", async () => {
    expect(loc(await callback(req("/auth/callback?token_hash=h&type=signup&next=//evil.example")))).toBe("https://site.test/dashboard");
    expect(loc(await callback(req("/auth/callback?token_hash=h&type=recovery")))).toBe("https://site.test/login?error=callback");
    expect(loc(await callback(req("/auth/callback?token_hash=h")))).toBe("https://site.test/login?error=callback");
  });
  it("keeps the code path and the failure redirect", async () => {
    expect(loc(await callback(req("/auth/callback?code=c")))).toBe("https://site.test/dashboard");
    expect(m.exchange).toHaveBeenCalledWith("c");
    m.exchange.mockResolvedValueOnce({ error: { message: "x" } });
    expect(loc(await callback(req("/auth/callback?code=c")))).toBe("https://site.test/login?error=callback");
  });
});
