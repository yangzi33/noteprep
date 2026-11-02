import { beforeEach, describe, expect, it, vi } from "vitest";
import { mayCreateAccount, parseAllowlist, parseSignupPolicy, type SignupPolicy } from "@/lib/server/auth/signup-policy";

const m = vi.hoisted(() => ({
  policy: { mode: "invite", allowlist: new Set(["tutor@example.test"]) } as SignupPolicy,
  signUp: vi.fn(),
  resend: vi.fn(),
  hit: vi.fn(),
  getStatus: vi.fn(),
  ensureAccount: vi.fn(),
  user: { ctx: { userId: "u1" }, email: "tutor@example.test" } as { ctx: { userId: string }; email: string } | null,
  confirmedAt: "2026-01-01T00:00:00Z" as string | null,
}));

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
vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }) }));
vi.mock("@/lib/server/env", () => ({ signupPolicy: () => m.policy }));
vi.mock("@/lib/supabase/public-env", () => ({ publicEnv: () => ({ siteUrl: "https://site.test" }) }));
vi.mock("@/lib/server/dal/instance", () => ({
  webDal: () => ({ authRate: { hit: m.hit }, account: { getStatus: m.getStatus, ensureAccount: m.ensureAccount } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: { signUp: m.signUp, getUser: async () => ({ data: { user: { id: "u1", email_confirmed_at: m.confirmedAt } } }) },
  }),
  createStatelessSupabase: () => ({ auth: { resend: m.resend } }),
}));
vi.mock("@/lib/server/auth/verify", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth/verify")>()),
  verifyClaims: async () => (m.user ? { userId: m.user.ctx.userId, email: m.user.email } : null),
}));

import { signUp } from "@/app/login/actions";
import { resendConfirmation } from "@/app/login/recovery-actions";
import { requireAccount } from "@/lib/server/auth/require-user";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
async function redirectOf(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof Redirected) return e.href;
    throw e;
  }
  return "no redirect";
}

describe("parseSignupPolicy", () => {
  it("fails closed in production: unset or unknown mode means invite", () => {
    expect(parseSignupPolicy({ NODE_ENV: "production" }).mode).toBe("invite");
    expect(parseSignupPolicy({ NODE_ENV: "production", SIGNUP_MODE: "" }).mode).toBe("invite");
    expect(parseSignupPolicy({ NODE_ENV: "production", SIGNUP_MODE: "OPEN" }).mode).toBe("invite");
    expect(parseSignupPolicy({ NODE_ENV: "production", SIGNUP_MODE: "yes" }).mode).toBe("invite");
  });
  it("is open in development and test unless told otherwise, and open only when asked in production", () => {
    expect(parseSignupPolicy({ NODE_ENV: "development" }).mode).toBe("open");
    expect(parseSignupPolicy({ NODE_ENV: "test" }).mode).toBe("open");
    expect(parseSignupPolicy({ NODE_ENV: "development", SIGNUP_MODE: "invite" }).mode).toBe("invite");
    expect(parseSignupPolicy({ NODE_ENV: "production", SIGNUP_MODE: "open" }).mode).toBe("open");
  });
});

describe("parseAllowlist and mayCreateAccount", () => {
  it("splits on commas, semicolons, spaces and newlines, lower-cases and drops non-addresses", () => {
    const list = parseAllowlist(" A@Example.test, b@example.test;c@example.test\nnot-an-email\n@x.test  d@example.test ");
    expect([...list].sort()).toEqual(["a@example.test", "b@example.test", "c@example.test", "d@example.test"]);
  });
  it("matches whole addresses only, case-insensitively", () => {
    const policy = parseSignupPolicy({ NODE_ENV: "production", SIGNUP_ALLOWLIST: "tutor@example.test" });
    expect(mayCreateAccount(policy, "Tutor@Example.test ")).toBe(true);
    expect(mayCreateAccount(policy, "tutor@example.test.evil.test")).toBe(false);
    expect(mayCreateAccount(policy, "evil+tutor@example.test")).toBe(false);
    expect(mayCreateAccount(policy, "x@tutor@example.test")).toBe(false);
  });
  it("an empty allowlist in invite mode admits nobody; open mode admits everybody", () => {
    expect(mayCreateAccount(parseSignupPolicy({ NODE_ENV: "production" }), "tutor@example.test")).toBe(false);
    expect(mayCreateAccount(parseSignupPolicy({ NODE_ENV: "test" }), "anyone@example.test")).toBe(true);
  });
  it("caps the list", () => {
    const raw = Array.from({ length: 800 }, (_, i) => `u${i}@example.test`).join(",");
    expect(parseAllowlist(raw).size).toBe(500);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  m.policy = { mode: "invite", allowlist: new Set(["tutor@example.test"]) };
  m.signUp.mockResolvedValue({ error: null });
  m.resend.mockResolvedValue({ error: null });
  m.hit.mockResolvedValue({ allowed: true, count: 1 });
  m.getStatus.mockResolvedValue(null);
  m.user = { ctx: { userId: "u1" }, email: "tutor@example.test" };
  m.confirmedAt = "2026-01-01T00:00:00Z";
});

describe("signUp in invite mode", () => {
  it("creates the Auth user only for an invited address", async () => {
    expect(await redirectOf(() => signUp(form({ email: "tutor@example.test", password: "correct horse battery" })))).toBe("/login?notice=check-email-invite");
    expect(m.signUp).toHaveBeenCalledTimes(1);
  });
  it("answers an uninvited address identically and never calls Supabase", async () => {
    expect(await redirectOf(() => signUp(form({ email: "stranger@example.test", password: "correct horse battery" })))).toBe("/login?notice=check-email-invite");
    expect(m.signUp).not.toHaveBeenCalled();
  });
  it("keeps the open-mode answer in open mode", async () => {
    m.policy = { mode: "open", allowlist: new Set() };
    expect(await redirectOf(() => signUp(form({ email: "stranger@example.test", password: "correct horse battery" })))).toBe("/login?notice=check-email");
    expect(m.signUp).toHaveBeenCalledTimes(1);
  });
});

describe("resendConfirmation in invite mode", () => {
  it("sends only to an invited address, with the same answer either way", async () => {
    expect(await redirectOf(() => resendConfirmation(form({ email: "stranger@example.test" })))).toBe("/login?notice=check-email-invite");
    expect(m.resend).not.toHaveBeenCalled();
    expect(await redirectOf(() => resendConfirmation(form({ email: "tutor@example.test" })))).toBe("/login?notice=check-email-invite");
    expect(m.resend).toHaveBeenCalledTimes(1);
  });
});

describe("invite-list membership does not change the metered work", () => {
  const listed = "tutor@example.test";
  const unlisted = "stranger@example.test";
  const run = {
    signUp: (email: string) => redirectOf(() => signUp(form({ email, password: "correct horse battery" }))),
    resend: (email: string) => redirectOf(() => resendConfirmation(form({ email }))),
  };

  it.each(["signUp", "resend"] as const)("%s hits the per-IP limiter exactly once for a listed and for an unlisted address", async (action) => {
    await run[action](listed);
    await run[action](unlisted);
    expect(m.hit).toHaveBeenCalledTimes(2);
    expect(m.hit.mock.calls.map((c) => c[1])).toEqual([action === "signUp" ? "signup" : "resend", action === "signUp" ? "signup" : "resend"]);
  });
  it.each(["signUp", "resend"] as const)("%s meters before any provider call", async (action) => {
    const order: string[] = [];
    m.hit.mockImplementation(async () => (order.push("hit"), { allowed: true, count: 1 }));
    m.signUp.mockImplementation(async () => (order.push("provider"), { error: null }));
    m.resend.mockImplementation(async () => (order.push("provider"), { error: null }));
    await run[action](listed);
    expect(order).toEqual(["hit", "provider"]);
  });
  it.each(["signUp", "resend"] as const)("%s over the limit skips the provider and answers like an accepted request", async (action) => {
    const accepted = await run[action](listed);
    m.signUp.mockClear();
    m.resend.mockClear();
    m.hit.mockResolvedValue({ allowed: false, count: 11 });
    expect(await run[action](listed)).toBe(accepted);
    expect(m.signUp).not.toHaveBeenCalled();
    expect(m.resend).not.toHaveBeenCalled();
  });
  it.each(["signUp", "resend"] as const)("%s treats a failing counter as over the limit, silently and without the address", async (action) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.hit.mockRejectedValue(new Error(`db down for ${listed}`));
    expect(await run[action](listed)).toBe("/login?notice=check-email-invite");
    expect(m.signUp).not.toHaveBeenCalled();
    expect(m.resend).not.toHaveBeenCalled();
    expect(spy.mock.calls.flat().join(" ")).not.toContain("example.test");
    spy.mockRestore();
  });
});

describe("requireAccount in invite mode", () => {
  it("creates the account for a confirmed, invited address", async () => {
    await requireAccount();
    expect(m.ensureAccount).toHaveBeenCalledTimes(1);
  });
  it("sends a confirmed but uninvited address to /not-invited without creating a profile or allowance", async () => {
    m.user = { ctx: { userId: "u1" }, email: "stranger@example.test" };
    expect(await redirectOf(requireAccount)).toBe("/not-invited");
    expect(m.ensureAccount).not.toHaveBeenCalled();
  });
  it("still asks an unconfirmed address to confirm first", async () => {
    m.confirmedAt = null;
    expect(await redirectOf(requireAccount)).toBe("/login?error=unverified");
    expect(m.ensureAccount).not.toHaveBeenCalled();
  });
  it("lets an existing active profile keep working even if it is not on the list", async () => {
    m.user = { ctx: { userId: "u1" }, email: "stranger@example.test" };
    m.getStatus.mockResolvedValue("active");
    await expect(requireAccount()).resolves.toMatchObject({ email: "stranger@example.test" });
    expect(m.ensureAccount).not.toHaveBeenCalled();
  });
});
