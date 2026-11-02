import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError, NotFound } from "@/lib/domain/errors";
import { logAction, logActionFailure } from "@/lib/server/log-action";

afterEach(() => vi.restoreAllMocks());

const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

describe("logAction", () => {
  it("writes one JSON line with the event, a timestamp and the given ids", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logAction("export_confirm_failed", { code: "QUEUE_BUSY", draftId: "d-1" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(lines(spy)[0]).toMatchObject({ event: "export_confirm_failed", code: "QUEUE_BUSY", draftId: "d-1" });
    expect(typeof lines(spy)[0]!.ts).toBe("string");
  });
});

describe("logActionFailure", () => {
  it("logs only the code of a domain refusal, at warn level", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logActionFailure("draft_adjust_failed", new NotFound(), { draftId: "d-1" });
    expect(err).not.toHaveBeenCalled();
    expect(lines(warn)[0]).toMatchObject({ event: "draft_adjust_failed", code: "NOT_FOUND", draftId: "d-1" });
    expect(Object.keys(lines(warn)[0]!).sort()).toEqual(["code", "draftId", "event", "ts"]);
  });

  it("logs only the error class of an unexpected error: no message, stack or email", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("Unique constraint failed for tutor@example.com at /srv/app/secret.ts");
    boom.name = "PrismaClientKnownRequestError";
    logActionFailure("prepare_failed", boom, {});
    expect(warn).not.toHaveBeenCalled();
    const raw = String(err.mock.calls[0]![0]);
    expect(lines(err)[0]).toMatchObject({ event: "prepare_failed", errorClass: "PrismaClientKnownRequestError" });
    expect(raw).not.toMatch(/tutor@example\.com|secret\.ts|Unique constraint|at \S+:\d+/);
    expect(lines(err)[0]).not.toHaveProperty("code");
  });

  it("does not trust a thrown non-Error value", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logActionFailure("prepare_failed", "tutor@example.com", {});
    logActionFailure("prepare_failed", { message: "x@y.z", name: "x@y.z" }, {});
    expect(err.mock.calls.map((c) => String(c[0])).join("")).not.toContain("@");
  });

  it("logs the code of a DomainError subclass and never its message", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logActionFailure("x", new (class extends DomainError {})("RATE_LIMITED", "msg with tutor@example.com"), {});
    expect(lines(warn)[0]).toMatchObject({ code: "RATE_LIMITED" });
    expect(String(warn.mock.calls[0]![0])).not.toContain("@");
  });
});
