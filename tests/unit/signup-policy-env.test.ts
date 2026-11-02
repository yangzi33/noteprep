import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.spyOn(console, "warn");

async function policyWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const key of ["NODE_ENV", "SIGNUP_MODE", "SIGNUP_ALLOWLIST"]) vi.stubEnv(key, env[key]);
  return (await import("@/lib/server/env")).signupPolicy();
}
const lines = () => warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

beforeEach(() => warn.mockImplementation(() => {}));
afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockReset();
});

describe("signupPolicy() startup log lines", () => {
  it("logs counts only (no addresses) when allowlist entries are ignored", async () => {
    const policy = await policyWith({ NODE_ENV: "production", SIGNUP_MODE: "invite", SIGNUP_ALLOWLIST: "a@example.test, A@example.test, junk" });
    expect(policy.allowlist.size).toBe(1);
    expect(lines()).toEqual([{ event: "signup_allowlist_entries_ignored", invalid: 1, duplicate: 1, overCap: 0, accepted: 1 }]);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("example.test");
  });
  it("logs when SIGNUP_MODE is set but not recognised, without echoing the value", async () => {
    const policy = await policyWith({ NODE_ENV: "production", SIGNUP_MODE: "Open ", SIGNUP_ALLOWLIST: "a@example.test" });
    expect(policy.mode).toBe("invite");
    expect(lines()).toEqual([{ event: "signup_mode_unrecognised", effective: "invite" }]);
  });
  it("is silent for a clean configuration", async () => {
    await policyWith({ NODE_ENV: "production", SIGNUP_MODE: "invite", SIGNUP_ALLOWLIST: "a@example.test" });
    expect(warn).not.toHaveBeenCalled();
  });
});
