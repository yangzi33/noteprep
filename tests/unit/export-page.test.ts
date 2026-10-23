import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFound } from "@/lib/domain/errors";

const E = "55555555-5555-4555-8555-555555555555";
const L = "33333333-3333-4333-8333-333333333333";
const R = "44444444-4444-4444-8444-444444444444";
const m = vi.hoisted(() => ({ getExportStatus: vi.fn(), getLessonView: vi.fn() }));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/server/auth/require-user", () => ({ requireAccount: async () => ({ ctx: { userId: "u1" } }) }));
vi.mock("@/lib/server/dal/instance", () => ({ webDal: () => ({ exports: { getExportStatus: m.getExportStatus }, lessons: { getLessonView: m.getLessonView } }) }));
vi.mock("@/components/export-status", () => ({ ExportStatus: () => null }));

import ExportPage from "@/app/exports/[id]/page";

const dto = (over: Record<string, unknown> = {}, job: Record<string, unknown> = {}, reservation = "reserved") => ({
  exportId: E, state: "pending", job: { state: "queued", stage: null, attempt: 0, maxAttempts: 3, cancelRequested: false, errorCode: null, ...job }, reservation: { state: reservation }, lessonId: L, revisionId: null, deadlineAt: new Date("2026-10-24T10:00:00Z"), ...over,
});

async function render(search: Record<string, string | string[] | undefined> = {}) {
  const main = (await ExportPage({ params: Promise.resolve({ id: E }), searchParams: Promise.resolve(search) })) as ReactElement<{ children: ReactElement<Record<string, unknown>> }>;
  const status = main.props.children as ReactElement<Record<string, unknown>>;
  return { status, props: status.props };
}

beforeEach(() => {
  m.getExportStatus.mockReset();
  m.getLessonView.mockReset();
});

describe("/exports/[id] page", () => {
  it("is a 404 when the export is missing or not the caller's", async () => {
    m.getExportStatus.mockRejectedValueOnce(new NotFound());
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(m.getExportStatus).toHaveBeenCalledWith({ userId: "u1" }, E);
  });
  it("rethrows unexpected errors", async () => {
    m.getExportStatus.mockRejectedValueOnce(new Error("db down"));
    await expect(render()).rejects.toThrow("db down");
  });
  it("passes the client view only, and no documents before success", async () => {
    m.getExportStatus.mockResolvedValueOnce({ ...dto(), snapshotId: "s", exportKey: "k", jobId: "j" });
    const { props } = await render();
    expect(props.documents).toEqual([]);
    expect(props.initial).toMatchObject({ exportId: E, state: "pending", charge: "held" });
    expect(JSON.stringify(props.initial)).not.toMatch(/snapshot|exportKey|jobId|reservation/);
    expect(m.getLessonView).not.toHaveBeenCalled();
  });
  it("allow-lists ?outcome=: reused and joined pass, anything else (or an array) is dropped", async () => {
    for (const [raw, want] of [["reused", "reused"], ["joined", "joined"], ["<b>x</b>", null], ["REUSED", null], [undefined, null], [["joined", "reused"], "joined"]] as const) {
      m.getExportStatus.mockResolvedValueOnce(dto());
      expect((await render({ outcome: raw as string | string[] | undefined })).props.outcome, String(raw)).toBe(want);
    }
  });
  it("on success loads the documents of exactly that revision", async () => {
    m.getExportStatus.mockResolvedValueOnce(dto({ state: "succeeded", revisionId: R }, { state: "succeeded" }, "consumed"));
    m.getLessonView.mockResolvedValueOnce({ documents: [{ document: "notes", pages: 2, bytes: 5 }, { document: "worksheet", pages: 1, bytes: 5 }] });
    const { props } = await render();
    expect(m.getLessonView).toHaveBeenCalledWith({ userId: "u1" }, L, R);
    expect(props.documents).toEqual([{ document: "notes", pages: 2 }, { document: "worksheet", pages: 1 }]);
  });
  it("a succeeded export whose lesson view is NOT_FOUND still renders, with no documents", async () => {
    m.getExportStatus.mockResolvedValueOnce(dto({ state: "succeeded", revisionId: R }, { state: "succeeded" }, "consumed"));
    m.getLessonView.mockRejectedValueOnce(new NotFound());
    expect((await render()).props.documents).toEqual([]);
  });
  it("the component key changes with every server-side state change, so the client re-mounts", async () => {
    m.getExportStatus.mockResolvedValueOnce(dto());
    const a = (await render()).status.key;
    m.getExportStatus.mockResolvedValueOnce(dto({}, { cancelRequested: true, state: "running" }));
    const b = (await render()).status.key;
    m.getExportStatus.mockResolvedValueOnce(dto({ state: "failed" }, { state: "canceled" }, "released"));
    const c = (await render()).status.key;
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
