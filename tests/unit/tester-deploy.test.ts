import { afterEach, describe, expect, it, vi } from "vitest";
import { assertTesterDeploy, testerDeployProblems } from "@/lib/server/tester-deploy";

const ok = { NOTEPREP_TESTER_DEPLOY: "1", NEXT_PUBLIC_SUPPORT_EMAIL: "help@example.test", NOTEPREP_MAIL_SENDER: "Example Mailer", LLM_PROVIDER: "fake" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("tester deploy check", () => {
  it("ignores a deploy that is not marked as a tester deploy", () => {
    expect(testerDeployProblems({})).toEqual([]);
    expect(testerDeployProblems({ NOTEPREP_TESTER_DEPLOY: "0" })).toEqual([]);
  });

  it("accepts a fully configured tester deploy", () => {
    expect(testerDeployProblems(ok)).toEqual([]);
    expect(() => assertTesterDeploy(ok)).not.toThrow();
  });

  it("requires a plain contact address", () => {
    for (const v of [undefined, "", "not an address", "<support address>"]) {
      expect(testerDeployProblems({ ...ok, NEXT_PUBLIC_SUPPORT_EMAIL: v }).join(), String(v)).toMatch(/NEXT_PUBLIC_SUPPORT_EMAIL/);
    }
  });

  it("requires the owner-confirmed mail sender and rejects placeholders", () => {
    for (const v of [undefined, "", "  ", "<mail sender>", "TBD", "to be confirmed"]) {
      expect(testerDeployProblems({ ...ok, NOTEPREP_MAIL_SENDER: v }).join(), String(v)).toMatch(/NOTEPREP_MAIL_SENDER/);
    }
  });

  it("requires LLM_PROVIDER to be set explicitly so the AI statement cannot rest on a default", () => {
    expect(testerDeployProblems({ ...ok, LLM_PROVIDER: undefined }).join()).toMatch(/LLM_PROVIDER/);
  });

  it("makes next.config.ts fail the build for an incomplete tester deploy and pass for a complete one", async () => {
    vi.stubEnv("NOTEPREP_TESTER_DEPLOY", "1");
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "");
    vi.stubEnv("NOTEPREP_MAIL_SENDER", "");
    vi.stubEnv("LLM_PROVIDER", "fake");
    await expect(import("../../next.config")).rejects.toThrow(/NEXT_PUBLIC_SUPPORT_EMAIL[\s\S]*NOTEPREP_MAIL_SENDER/);
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "help@example.test");
    vi.stubEnv("NOTEPREP_MAIL_SENDER", "Example Mailer");
    await expect(import("../../next.config")).resolves.toBeDefined();
  });
});
