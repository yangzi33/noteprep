import { describe, expect, it } from "vitest";
import { lifetimeRemaining, utcDayNumber, utcDayWindow } from "@/lib/domain/daily-refresh";

describe("utcDayNumber", () => {
  it("is 0n at the Unix epoch", () => {
    expect(utcDayNumber(new Date("1970-01-01T00:00:00.000Z"))).toBe(0n);
  });

  it("rolls over exactly at UTC midnight", () => {
    const before = utcDayNumber(new Date("2026-10-25T23:59:59.999Z"));
    const after = utcDayNumber(new Date("2026-10-26T00:00:00.000Z"));
    expect(after - before).toBe(1n);
  });
});

describe("utcDayWindow", () => {
  it("brackets the instant and spans 24 hours", () => {
    const d = new Date("2026-10-25T13:37:00.000Z");
    const { startsAt, endsAt } = utcDayWindow(utcDayNumber(d));
    expect(startsAt.getTime()).toBeLessThanOrEqual(d.getTime());
    expect(endsAt.getTime()).toBeGreaterThan(d.getTime());
    expect(endsAt.getTime() - startsAt.getTime()).toBe(86_400_000);
    expect(startsAt.toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });
});

describe("lifetimeRemaining", () => {
  it("clamps at zero and never goes negative", () => {
    expect(lifetimeRemaining({ limit: 3, used: 1, reserved: 1 }, { used: 2, reserved: 0 })).toBe(0);
  });

  it("subtracts the daily counters from the trial remainder", () => {
    expect(lifetimeRemaining({ limit: 3, used: 1, reserved: 0 }, { used: 1, reserved: 0 })).toBe(1);
  });
});
