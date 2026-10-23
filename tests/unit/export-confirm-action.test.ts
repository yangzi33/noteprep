import { beforeEach, describe, expect, it, vi } from "vitest";
import { AllowanceExhausted, ExportConflict, InvariantViolation, NotFound, RateLimited } from "@/lib/domain/errors";
import { exportAvailable } from "@/lib/ui/export-confirm";

const D = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";

const m = vi.hoisted(() => ({
  confirmExport: vi.fn(),
  env: { EXPORT_ENABLED: "1", FLOW_MODE: "draft" } as { EXPORT_ENABLED: string; FLOW_MODE: string },
  redirect: vi.fn(),
  notFound: vi.fn(),
}));

class Redirected extends Error {
  constructor(readonly href: string) {
    super("NEXT_REDIRECT");
  }
}
class NotFoundSignal extends Error {}

vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    m.redirect(href);
    throw new Redirected(href);
  },
  notFound: () => {
    m.notFound();
    throw new NotFoundSignal("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/server/auth/require-user", () => ({ requireAccount: async () => ({ ctx: { userId: "u1" } }) }));
vi.mock("@/lib/server/dal/instance", () => ({ webDal: () => ({ exports: { confirmExport: m.confirmExport } }) }));
vi.mock("@/lib/server/env", () => ({ serverEnv: () => m.env }));

import { confirmExportAction } from "@/app/drafts/[id]/export/actions";

const form = (over: Record<string, string> = {}) => {
  const f = new FormData();
  const base: Record<string, string> = { draftId: D, versionId: V, expectedRev: "4", expectedContentHash: "abc", key: "key-0123456789", ...over };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  return f;
};
const run = async (f: FormData) => {
  try {
    await confirmExportAction(f);
  } catch (e) {
    return e;
  }
  return null;
};
const href = (e: unknown) => (e instanceof Redirected ? e.href : `not a redirect: ${String(e)}`);

beforeEach(() => {
  vi.clearAllMocks();
  m.env.EXPORT_ENABLED = "1";
  m.env.FLOW_MODE = "draft";
});

describe("confirmExportAction", () => {
  it("redirects an invalid draft id to /prepare and other invalid input to the confirm page", async () => {
    expect(href(await run(form({ draftId: "nope" })))).toBe("/prepare");
    for (const bad of [{ expectedRev: "0" }, { expectedRev: "x" }, { expectedContentHash: "" }, { key: "short" }, { versionId: "nope" }]) {
      const to = href(await run(form(bad)));
      expect(to, JSON.stringify(bad)).toContain(`/drafts/${D}/export?`);
      expect(to).toContain("error=INVALID_REQUEST");
    }
    expect(m.confirmExport).not.toHaveBeenCalled();
  });

  it("refuses without touching the DAL when export or the draft flow is off", async () => {
    for (const env of [{ EXPORT_ENABLED: "0", FLOW_MODE: "draft" }, { EXPORT_ENABLED: "1", FLOW_MODE: "legacy" }]) {
      Object.assign(m.env, env);
      expect(href(await run(form()))).toBe(`/drafts/${D}/export?v=${V}&error=EXPORT_DISABLED`);
    }
    expect(m.confirmExport).not.toHaveBeenCalled();
  });

  it("passes ids, revision, hash and key to the DAL and redirects to the export", async () => {
    for (const [outcome, tail] of [["created", ""], ["replayed", ""], ["joined", "?outcome=joined"], ["reused", "?outcome=reused"]] as const) {
      m.confirmExport.mockResolvedValueOnce({ outcome, exportId: "e1", jobId: "j", lessonId: "l" });
      expect(href(await run(form()))).toBe(`/exports/e1${tail}`);
    }
    expect(m.confirmExport).toHaveBeenCalledWith({ userId: "u1" }, { draftId: D, versionId: V, expectedRev: 4, expectedContentHash: "abc" }, "key-0123456789");
    expect(m.redirect).toHaveBeenCalledTimes(4); // exactly one redirect per call
  });

  it("maps domain refusals to the right page", async () => {
    m.confirmExport.mockRejectedValueOnce(new ExportConflict());
    expect(href(await run(form()))).toBe(`/drafts/${D}?v=${V}&error=EXPORT_CONFLICT`);
    m.confirmExport.mockRejectedValueOnce(new RateLimited());
    expect(href(await run(form()))).toBe(`/drafts/${D}/export?v=${V}&error=RATE_LIMITED`);
    m.confirmExport.mockRejectedValueOnce(new AllowanceExhausted(0, "trial"));
    expect(href(await run(form()))).toBe(`/drafts/${D}/export?v=${V}&error=ALLOWANCE_EXHAUSTED`);
  });

  it("calls notFound() on NOT_FOUND", async () => {
    m.confirmExport.mockRejectedValueOnce(new NotFound());
    expect(await run(form())).toBeInstanceOf(NotFoundSignal);
    expect(m.notFound).toHaveBeenCalledTimes(1);
    expect(m.redirect).not.toHaveBeenCalled();
  });

  it("rethrows InvariantViolation and unknown errors instead of redirecting", async () => {
    const invariant = new InvariantViolation("broken");
    m.confirmExport.mockRejectedValueOnce(invariant);
    expect(await run(form())).toBe(invariant);
    const unknown = new Error("db down");
    m.confirmExport.mockRejectedValueOnce(unknown);
    expect(await run(form())).toBe(unknown);
    expect(m.redirect).not.toHaveBeenCalled();
  });
});

describe("exportAvailable", () => {
  it("needs both the draft flow and EXPORT_ENABLED=1", () => {
    expect(exportAvailable({ EXPORT_ENABLED: "1", FLOW_MODE: "draft" })).toBe(true);
    expect(exportAvailable({ EXPORT_ENABLED: "0", FLOW_MODE: "draft" })).toBe(false);
    expect(exportAvailable({ EXPORT_ENABLED: "1", FLOW_MODE: "legacy" })).toBe(false);
  });
});
