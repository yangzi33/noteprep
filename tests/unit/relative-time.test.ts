import { describe, expect, it } from "vitest";
import { expiryPhrase, relativeExpiry } from "@/lib/ui/relative-time";

const now = new Date("2026-10-26T15:00:00Z");

describe("relativeExpiry", () => {
  it("says expired at or after the expiry", () => {
    expect(relativeExpiry(new Date("2026-10-26T15:00:00Z"), now, "UTC")).toBe("expired");
    expect(relativeExpiry(new Date("2026-10-25T00:00:00Z"), now, "UTC")).toBe("expired");
  });
  it("says today later on the same UTC day", () => {
    expect(relativeExpiry(new Date("2026-10-26T23:59:00Z"), now, "UTC")).toBe("today");
  });
  it("says tomorrow for the next UTC day", () => {
    expect(relativeExpiry(new Date("2026-10-27T01:00:00Z"), now, "UTC")).toBe("tomorrow");
  });
  it("counts UTC calendar days", () => {
    expect(relativeExpiry(new Date("2026-10-28T10:00:00Z"), now, "UTC")).toBe("in 2 days");
    expect(relativeExpiry(new Date("2026-11-02T00:00:00Z"), now, "UTC")).toBe("in 7 days");
  });
});

describe("expiryPhrase", () => {
  it("adds the UTC date", () => {
    expect(expiryPhrase(new Date("2026-10-28T10:00:00Z"), now, "UTC")).toBe("in 2 days (Oct 28, UTC)");
    expect(expiryPhrase(new Date("2026-10-25T10:00:00Z"), now, "UTC")).toBe("expired (Oct 25, UTC)");
  });
});

describe("in a non-UTC zone", () => {
  const toronto = "America/Toronto";
  it("counts calendar days in the zone", () => {
    // 22:00 EDT today vs 00:30 EDT the next day: expires "tomorrow" for the tutor, though only 2.5 hours away.
    const n = new Date("2026-10-27T02:00:00Z");
    expect(relativeExpiry(new Date("2026-10-27T04:30:00Z"), n, toronto)).toBe("tomorrow");
    expect(relativeExpiry(new Date("2026-10-27T04:30:00Z"), n, "UTC")).toBe("today");
  });
  it("labels the date with the zone", () => {
    expect(expiryPhrase(new Date("2026-10-28T10:00:00Z"), now, toronto)).toBe("in 2 days (Oct 28, EDT)");
  });
});
