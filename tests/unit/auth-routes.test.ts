import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ verifyOtp: vi.fn(), exchange: vi.fn() }));
vi.mock("@/lib/supabase/public-env", () => ({ publicEnv: () => ({ siteUrl: "https://site.test" }) }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({ auth: { verifyOtp: m.verifyOtp, exchangeCodeForSession: m.exchange } }) }));

import { GET as callback } from "@/app/auth/callback/route";

const req = (path: string) => new NextRequest(`https://evil.example${path}`, { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } });
const loc = (r: Response) => r.headers.get("location");

beforeEach(() => {
  vi.clearAllMocks();
  m.verifyOtp.mockResolvedValue({ error: null });
  m.exchange.mockResolvedValue({ error: null });
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
  it("fails closed when verification throws", async () => {
    m.verifyOtp.mockRejectedValueOnce(new Error("boom"));
    expect(loc(await callback(req("/auth/callback?token_hash=h&type=signup")))).toBe("https://site.test/login?error=callback");
    m.exchange.mockRejectedValueOnce(new Error("boom"));
    expect(loc(await callback(req("/auth/callback?code=c")))).toBe("https://site.test/login?error=callback");
  });
  it("keeps the code path and the failure redirect", async () => {
    expect(loc(await callback(req("/auth/callback?code=c")))).toBe("https://site.test/dashboard");
    expect(m.exchange).toHaveBeenCalledWith("c");
    m.exchange.mockResolvedValueOnce({ error: { message: "x" } });
    expect(loc(await callback(req("/auth/callback?code=c")))).toBe("https://site.test/login?error=callback");
  });
});
