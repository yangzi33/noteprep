import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/app/login-form";
import { TextField } from "@/components/ui/text-field";
import { accountNotice, loginMessage, passwordMessage } from "@/lib/ui/login-messages";

const m = vi.hoisted(() => ({
  hit: vi.fn(),
  reset: vi.fn(),
  resend: vi.fn(),
  update: vi.fn(),
  requireUser: vi.fn(),
  hdrs: new Map<string, string>(),
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
vi.mock("next/headers", () => ({ headers: async () => ({ get: (k: string) => m.hdrs.get(k) ?? null }) }));
vi.mock("@/lib/server/dal/instance", () => ({ webDal: () => ({ authRate: { hit: m.hit } }) }));
vi.mock("@/lib/server/auth/require-user", () => ({ requireUser: m.requireUser }));
vi.mock("@/lib/supabase/public-env", () => ({ publicEnv: () => ({ siteUrl: "https://site.test" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({ auth: { resetPasswordForEmail: m.reset, resend: m.resend, updateUser: m.update } }),
}));

import { updatePassword } from "@/app/account/password/actions";
import { requestPasswordReset, resendConfirmation } from "@/app/login/recovery-actions";
import { clientIpHash } from "@/lib/server/auth/client-ip";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const run = async (fn: (f: FormData) => Promise<void>, f: FormData) => {
  try {
    await fn(f);
  } catch (e) {
    if (e instanceof Redirected) return e.href;
    throw e;
  }
  return "no redirect";
};

beforeEach(() => {
  vi.clearAllMocks();
  m.hdrs.clear();
  m.hit.mockResolvedValue({ allowed: true, count: 1 });
  m.reset.mockResolvedValue({ error: null });
  m.resend.mockResolvedValue({ error: null });
  m.update.mockResolvedValue({ error: null });
  m.requireUser.mockResolvedValue({ ctx: { userId: "u1" }, email: "a@example.test" });
});

describe("requestPasswordReset", () => {
  it("rejects a malformed email without calling Supabase or the counter", async () => {
    for (const email of ["", "nope", `${"a".repeat(250)}@example.test`]) {
      expect(await run(requestPasswordReset, form({ email }))).toBe("/login/reset?error=invalid");
    }
    expect(m.reset).not.toHaveBeenCalled();
    expect(m.hit).not.toHaveBeenCalled();
  });

  it("sends the link to the fixed recovery URL and answers with the generic notice", async () => {
    expect(await run(requestPasswordReset, form({ email: "a@example.test" }))).toBe("/login?notice=reset-sent");
    expect(m.reset).toHaveBeenCalledWith("a@example.test", { redirectTo: "https://site.test/auth/recovery" });
    expect(m.hit).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{32}$/), "reset");
  });

  it("answers identically when Supabase reports an error or throws", async () => {
    m.reset.mockResolvedValueOnce({ error: { message: "user not found" } });
    expect(await run(requestPasswordReset, form({ email: "a@example.test" }))).toBe("/login?notice=reset-sent");
    m.reset.mockRejectedValueOnce(new Error("boom"));
    expect(await run(requestPasswordReset, form({ email: "a@example.test" }))).toBe("/login?notice=reset-sent");
  });

  it("skips Supabase but gives the same answer when rate limited or when the counter fails", async () => {
    m.hit.mockResolvedValueOnce({ allowed: false, count: 11 });
    expect(await run(requestPasswordReset, form({ email: "a@example.test" }))).toBe("/login?notice=reset-sent");
    m.hit.mockRejectedValueOnce(new Error("db down"));
    expect(await run(requestPasswordReset, form({ email: "a@example.test" }))).toBe("/login?notice=reset-sent");
    expect(m.reset).not.toHaveBeenCalled();
  });
});

describe("resendConfirmation", () => {
  it("rejects a malformed email", async () => {
    expect(await run(resendConfirmation, form({ email: "nope" }))).toBe("/login/resend?error=invalid");
    expect(m.resend).not.toHaveBeenCalled();
  });

  it("resends with the fixed callback URL and answers with the existing generic notice", async () => {
    expect(await run(resendConfirmation, form({ email: "a@example.test" }))).toBe("/login?notice=check-email");
    expect(m.resend).toHaveBeenCalledWith({ type: "signup", email: "a@example.test", options: { emailRedirectTo: "https://site.test/auth/callback" } });
    expect(m.hit).toHaveBeenCalledWith(expect.any(String), "resend");
  });

  it("gives the same answer on failure and when rate limited (no Supabase call)", async () => {
    m.resend.mockRejectedValueOnce(new Error("boom"));
    expect(await run(resendConfirmation, form({ email: "a@example.test" }))).toBe("/login?notice=check-email");
    m.hit.mockResolvedValueOnce({ allowed: false, count: 11 });
    expect(await run(resendConfirmation, form({ email: "a@example.test" }))).toBe("/login?notice=check-email");
    expect(m.resend).toHaveBeenCalledTimes(1);
  });
});

describe("updatePassword", () => {
  const good = { password: "0123456789ab", confirm: "0123456789ab" };

  it("re-checks the session first: a signed-out caller never reaches Supabase", async () => {
    m.requireUser.mockImplementationOnce(() => {
      throw new Redirected("/login");
    });
    expect(await run(updatePassword, form(good))).toBe("/login");
    expect(m.update).not.toHaveBeenCalled();
  });

  it("refuses short, long and mismatching passwords", async () => {
    expect(await run(updatePassword, form({ password: "short", confirm: "short" }))).toBe("/account/password?error=invalid");
    expect(await run(updatePassword, form({ password: "x".repeat(73), confirm: "x".repeat(73) }))).toBe("/account/password?error=invalid");
    expect(await run(updatePassword, form({ password: "0123456789ab", confirm: "0123456789ac" }))).toBe("/account/password?error=mismatch");
    expect(m.update).not.toHaveBeenCalled();
  });

  it("updates the password and never puts it in the redirect", async () => {
    expect(await run(updatePassword, form(good))).toBe("/account?notice=password-updated");
    expect(m.update).toHaveBeenCalledWith({ password: "0123456789ab" });
  });

  it("maps a provider error to the generic failure key", async () => {
    m.update.mockResolvedValueOnce({ error: { message: "same password" } });
    expect(await run(updatePassword, form(good))).toBe("/account/password?error=failed");
  });
});

describe("clientIpHash", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  it("hashes the address, never returns it, and is stable", () => {
    const hash = clientIpHash(h({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }));
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).not.toContain("203");
    expect(clientIpHash(h({ "x-real-ip": "203.0.113.7" }))).toBe(hash);
    expect(clientIpHash(h({ "x-forwarded-for": "203.0.113.8" }))).not.toBe(hash);
  });
  it("uses one shared fallback bucket when no header carries an address", () => {
    expect(clientIpHash(h({}))).toBe(clientIpHash(h({ "x-forwarded-for": " " })));
  });
});

describe("messages", () => {
  it("has the recovery messages and keeps own-key lookups", () => {
    expect(loginMessage("reset-sent")).toMatch(/If this address has an account/);
    expect(loginMessage("recovery")).toMatch(/invalid or expired/);
    for (const fn of [loginMessage, passwordMessage, accountNotice]) {
      for (const key of [undefined, "", "unknown", "__proto__", "constructor", "toString"]) expect(fn(key), String(key)).toBeUndefined();
    }
    expect(passwordMessage("failed")).toMatch(/Request a new reset link/);
    expect(passwordMessage("mismatch")).toBeTruthy();
    expect(accountNotice("password-updated")).toBeTruthy();
  });
});

describe("login form additions", () => {
  const noop = async () => {};
  const html = renderToStaticMarkup(createElement(LoginForm, { signIn: noop, signUp: noop }));
  it("links to both recovery pages and shows the password hint", () => {
    expect(html).toMatch(/href="\/login\/reset"[^>]*>Forgot your password\?</);
    expect(html).toMatch(/href="\/login\/resend"[^>]*>Didn(&#x27;|')t get the confirmation email\?</);
    expect(html).toContain("At least 10 characters");
  });
  it("TextField ties the hint to the input and omits it when absent", () => {
    const withHint = renderToStaticMarkup(createElement(TextField, { label: "X", name: "x", hint: "Help" }));
    const id = withHint.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(withHint).toContain(`id="${id}"`);
    expect(renderToStaticMarkup(createElement(TextField, { label: "X", name: "x" }))).not.toContain("aria-describedby");
  });
});
