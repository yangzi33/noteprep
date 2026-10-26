import { describe, expect, it } from "vitest";
import { expiryPhrase, relativeExpiry } from "@/lib/ui/relative-time";

const now = new Date("2026-10-26T15:00:00Z");

describe("relativeExpiry", () => {
  it("says expired at or after the expiry", () => {
    expect(relativeExpiry(new Date("2026-10-26T15:00:00Z"), now)).toBe("expired");
    expect(relativeExpiry(new Date("2026-10-25T00:00:00Z"), now)).toBe("expired");
  });
  it("says today later on the same UTC day", () => {
    expect(relativeExpiry(new Date("2026-10-26T23:59:00Z"), now)).toBe("today");
  });
  it("says tomorrow for the next UTC day", () => {
    expect(relativeExpiry(new Date("2026-10-27T01:00:00Z"), now)).toBe("tomorrow");
  });
  it("counts UTC calendar days", () => {
    expect(relativeExpiry(new Date("2026-10-28T10:00:00Z"), now)).toBe("in 2 days");
    expect(relativeExpiry(new Date("2026-11-02T00:00:00Z"), now)).toBe("in 7 days");
  });
});

describe("expiryPhrase", () => {
  it("adds the UTC date", () => {
    expect(expiryPhrase(new Date("2026-10-28T10:00:00Z"), now)).toBe("in 2 days (Oct 28, UTC)");
    expect(expiryPhrase(new Date("2026-10-25T10:00:00Z"), now)).toBe("expired (Oct 25, UTC)");
  });
});
