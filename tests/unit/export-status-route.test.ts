import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFound } from "@/lib/domain/errors";

const E = "55555555-5555-4555-8555-555555555555";
const m = vi.hoisted(() => ({ user: null as { ctx: { userId: string } } | null, getExportStatus: vi.fn() }));

vi.mock("@/lib/server/auth/require-user", () => ({ getRequestUser: async () => m.user }));
vi.mock("@/lib/server/dal/instance", () => ({ webDal: () => ({ exports: { getExportStatus: m.getExportStatus } }) }));

import { GET } from "@/app/api/exports/[id]/route";

const call = () => GET(new Request("http://x/api/exports/" + E), { params: Promise.resolve({ id: E }) });
const dto = {
  exportId: E,
  state: "pending",
  job: { state: "queued", stage: null, attempt: 0, maxAttempts: 3, cancelRequested: false, errorCode: null },
  reservation: { state: "reserved" },
  lessonId: "l",
  revisionId: null,
  deadlineAt: new Date("2026-10-24T10:00:00Z"),
  // never part of the DTO, but the route must not forward anything unexpected either
  snapshotId: "snap",
  exportKey: "key",
  jobId: "job",
};

beforeEach(() => {
  m.user = { ctx: { userId: "u1" } };
  m.getExportStatus.mockReset();
});

describe("GET /api/exports/[id]", () => {
  it("401 for an anonymous caller, without touching the DAL", async () => {
    m.user = null;
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(m.getExportStatus).not.toHaveBeenCalled();
  });
  it("404 for a missing or foreign export, no-store", async () => {
    m.getExportStatus.mockRejectedValueOnce(new NotFound());
    const res = await call();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(m.getExportStatus).toHaveBeenCalledWith({ userId: "u1" }, E);
  });
  it("200 returns the view only: no snapshot, key, job id or reservation", async () => {
    m.getExportStatus.mockResolvedValue(dto);
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body).toMatchObject({ exportId: E, state: "pending", charge: "held", lessonId: "l", revisionId: null, deadlineAt: "2026-10-24T10:00:00.000Z" });
    expect(JSON.stringify(body)).not.toMatch(/snap|exportKey|jobId|"key"|reservation/);
  });
  it("rethrows an unexpected error (a 500, not a leak)", async () => {
    m.getExportStatus.mockRejectedValueOnce(new Error("boom"));
    await expect(call()).rejects.toThrow("boom");
  });
});
