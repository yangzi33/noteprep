import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFound } from "@/lib/domain/errors";

const J = "66666666-6666-4666-8666-666666666666";
const E = "55555555-5555-4555-8555-555555555555";
const m = vi.hoisted(() => ({ getJob: vi.fn(), findExportIdByJob: vi.fn(), getLessonView: vi.fn() }));
class Redirected extends Error {
  constructor(readonly href: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (href: string) => {
    throw new Redirected(href);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/server/auth/require-user", () => ({ requireAccount: async () => ({ ctx: { userId: "u1" } }) }));
vi.mock("@/lib/server/dal/instance", () => ({
  webDal: () => ({ generation: { getJob: m.getJob }, exports: { findExportIdByJob: m.findExportIdByJob }, lessons: { getLessonView: m.getLessonView } }),
}));
vi.mock("@/components/job-status", () => ({ JobStatus: () => null }));

import JobPage from "@/app/jobs/[id]/page";

const job = (over: Record<string, unknown> = {}) => ({
  id: J, kind: "export", state: "queued", stage: null, lessonId: "l", revisionId: null, attempt: 0, maxAttempts: 3, cancelRequested: false, errorCode: null, createdAt: new Date(), finishedAt: null, ...over,
});
const run = async () => {
  try {
    await JobPage({ params: Promise.resolve({ id: J }) });
  } catch (e) {
    if (e instanceof Redirected) return e.href;
    throw e;
  }
  return null;
};

beforeEach(() => {
  m.getJob.mockReset();
  m.findExportIdByJob.mockReset();
  m.getLessonView.mockReset();
});

describe("/jobs/[id] for an export job", () => {
  it("redirects every state except succeeded to the export status page", async () => {
    for (const state of ["queued", "running", "failed", "canceled"]) {
      m.getJob.mockResolvedValueOnce(job({ state }));
      m.findExportIdByJob.mockResolvedValueOnce(E);
      expect(await run()).toBe(`/exports/${E}`);
    }
    expect(m.findExportIdByJob).toHaveBeenCalledWith({ userId: "u1" }, J);
  });
  it("keeps the legacy page when there is no export row", async () => {
    m.getJob.mockResolvedValueOnce(job());
    m.findExportIdByJob.mockResolvedValueOnce(null);
    expect(await run()).toBeNull();
  });
  it("never looks up an export for a legacy generation job", async () => {
    m.getJob.mockResolvedValueOnce(job({ kind: "generate", state: "failed" }));
    expect(await run()).toBeNull();
    expect(m.findExportIdByJob).not.toHaveBeenCalled();
  });
  it("a succeeded export goes to its lesson as before", async () => {
    m.getJob.mockResolvedValueOnce(job({ state: "succeeded", revisionId: "r" }));
    m.getLessonView.mockResolvedValueOnce({ lessonId: "l", revisionId: "r" });
    expect(await run()).toBe("/lessons/l?rev=r");
    expect(m.findExportIdByJob).not.toHaveBeenCalled();
  });
  it("an unknown job is a 404", async () => {
    m.getJob.mockRejectedValueOnce(new NotFound());
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
