import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ verifyOtp: vi.fn(), exchange: vi.fn(), create: vi.fn() }));

class Redirected extends Error {
  constructor(readonly href: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Redirected(href);
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => {
    m.create();
    return { auth: { verifyOtp: m.verifyOtp, exchangeCodeForSession: m.exchange } };
  },
}));

import { confirmRecovery } from "@/app/auth/recovery/actions";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const dest = async (f: FormData) => {
  try {
    await confirmRecovery(f);
  } catch (e) {
    if (e instanceof Redirected) return e.href;
    throw e;
  }
  return null;
};

const spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  m.verifyOtp.mockResolvedValue({ error: null });
  m.exchange.mockResolvedValue({ error: null });
  for (const k of ["log", "info", "warn", "error"] as const) spies.push(vi.spyOn(console, k).mockImplementation(() => {}));
});
afterEach(() => {
  spies.splice(0).forEach((s) => s.mockRestore());
});

describe("confirmRecovery", () => {
  it("redeems a token hash and redirects to the fixed relative page", async () => {
    expect(await dest(form({ token_hash: "pkce_abc" }))).toBe("/account/password");
    expect(m.verifyOtp).toHaveBeenCalledWith({ type: "recovery", token_hash: "pkce_abc" });
    expect(m.exchange).not.toHaveBeenCalled();
  });
  it("exchanges a code for old links", async () => {
    expect(await dest(form({ code: "c1" }))).toBe("/account/password");
    expect(m.exchange).toHaveBeenCalledWith("c1");
  });
  it("redirects to the failure page on a provider error", async () => {
    m.verifyOtp.mockResolvedValueOnce({ error: { message: "expired" } });
    expect(await dest(form({ token_hash: "secret-token" }))).toBe("/login?error=recovery");
    m.exchange.mockResolvedValueOnce({ error: { message: "no verifier" } });
    expect(await dest(form({ code: "secret-code" }))).toBe("/login?error=recovery");
  });
  it("never calls Supabase for invalid input", async () => {
    for (const f of [form({}), form({ token_hash: "a b" }), form({ code: "x".repeat(513) }), form({ token_hash: "" })]) {
      expect(await dest(f)).toBe("/login?error=recovery");
    }
    expect(m.create).not.toHaveBeenCalled();
    expect(m.verifyOtp).not.toHaveBeenCalled();
    expect(m.exchange).not.toHaveBeenCalled();
  });
  it("fails closed on a thrown error and logs nothing", async () => {
    m.verifyOtp.mockRejectedValueOnce(new Error("boom secret-token"));
    expect(await dest(form({ token_hash: "secret-token" }))).toBe("/login?error=recovery");
    m.exchange.mockRejectedValueOnce(new Error("boom"));
    expect(await dest(form({ code: "secret-code" }))).toBe("/login?error=recovery");
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
