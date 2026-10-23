import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFound } from "@/lib/domain/errors";

const E = "55555555-5555-4555-8555-555555555555";
const m = vi.hoisted(() => ({ cancelExport: vi.fn() }));
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
vi.mock("@/lib/server/auth/require-user", () => ({ requireAccount: async () => ({ ctx: { userId: "u1" } }) }));
vi.mock("@/lib/server/dal/instance", () => ({ webDal: () => ({ exports: { cancelExport: m.cancelExport } }) }));

import { cancelExportAction } from "@/app/exports/[id]/actions";

const form = (id: unknown) => {
  const f = new FormData();
  if (id !== undefined) f.set("exportId", id as string);
  return f;
};
const target = async (f: FormData) => {
  try {
    await cancelExportAction(f);
  } catch (e) {
    if (e instanceof Redirected) return e.href;
    throw e;
  }
  return null;
};

beforeEach(() => m.cancelExport.mockReset());

describe("cancelExportAction", () => {
  it("cancels and returns to the status page", async () => {
    m.cancelExport.mockResolvedValue({});
    expect(await target(form(E))).toBe(`/exports/${E}`);
    expect(m.cancelExport).toHaveBeenCalledWith({ userId: "u1" }, E);
  });
  it("treats a domain error as nothing to cancel", async () => {
    m.cancelExport.mockRejectedValueOnce(new NotFound());
    expect(await target(form(E))).toBe(`/exports/${E}`);
  });
  it("rethrows a non-domain error (the redirect is outside the try)", async () => {
    m.cancelExport.mockRejectedValueOnce(new Error("db down"));
    await expect(cancelExportAction(form(E))).rejects.toThrow("db down");
  });
  it("a missing or malformed id never reaches the DAL", async () => {
    expect(await target(form(undefined))).toBe("/lessons");
    expect(await target(form("not-a-uuid"))).toBe("/lessons");
    expect(m.cancelExport).not.toHaveBeenCalled();
  });
});
