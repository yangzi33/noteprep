import { describe, expect, it } from "vitest";
import {
  calendarDaysBetween,
  formatDateTime,
  formatShortDate,
  isSelectableTimeZone,
  isValidTimeZone,
  matchTimeZone,
  resolveTimeZone,
  supportedTimeZones,
} from "@/lib/ui/timezone";

describe("isValidTimeZone", () => {
  it("accepts IANA names and UTC", () => {
    for (const z of ["UTC", "America/Toronto", "Asia/Kolkata", "America/Argentina/Buenos_Aires"]) expect(isValidTimeZone(z)).toBe(true);
  });
  it("rejects junk, offsets, empty and non-strings", () => {
    for (const z of ["", "Mars/Olympus", "+05:00", "EST5EDT; DROP", "x".repeat(65), "../etc/passwd", null, undefined, 5]) expect(isValidTimeZone(z)).toBe(false);
  });
});

describe("resolveTimeZone", () => {
  it("default: uses the detected zone when nothing is saved", () => {
    expect(resolveTimeZone(null, "America/Toronto")).toBe("America/Toronto");
    expect(resolveTimeZone(undefined, "Asia/Tokyo")).toBe("Asia/Tokyo");
  });
  it("override: a saved zone wins over the detected one", () => {
    expect(resolveTimeZone("Europe/Paris", "America/Toronto")).toBe("Europe/Paris");
  });
  it("invalid fallback: a bad saved zone falls back to detected, then UTC", () => {
    expect(resolveTimeZone("Nowhere/Land", "America/Toronto")).toBe("America/Toronto");
    expect(resolveTimeZone("Nowhere/Land", "also bad")).toBe("UTC");
    expect(resolveTimeZone(null, null)).toBe("UTC");
  });
});

describe("formatDateTime", () => {
  const instant = new Date("2026-03-05T20:30:00Z");
  it("shows the instant in the zone with a short zone label", () => {
    expect(formatDateTime(instant, "America/Toronto")).toBe("Mar 5, 2026, 3:30 PM EST");
    expect(formatDateTime(instant, "UTC")).toBe("Mar 5, 2026, 8:30 PM UTC");
  });
  it("labels zones without a short English name by their GMT offset", () => {
    expect(formatDateTime(instant, "Asia/Tokyo")).toBe("Mar 6, 2026, 5:30 AM GMT+9");
    expect(formatDateTime(instant, "Asia/Kolkata")).toBe("Mar 6, 2026, 2:00 AM GMT+5:30");
  });
  it("can move the calendar day", () => {
    expect(formatDateTime(new Date("2026-03-05T23:30:00Z"), "Asia/Tokyo")).toMatch(/^Mar 6, 2026, 8:30 AM /);
  });
  it("uses plain spaces only", () => {
    expect(formatDateTime(instant, "America/Toronto")).not.toMatch(/[  ]/);
  });
  it("treats an invalid zone as UTC instead of throwing", () => {
    expect(formatDateTime(instant, "Nowhere/Land")).toBe("Mar 5, 2026, 8:30 PM UTC");
  });
  it("DST edge: the label and offset change across the spring-forward gap", () => {
    expect(formatDateTime(new Date("2026-03-08T06:59:00Z"), "America/New_York")).toBe("Mar 8, 2026, 1:59 AM EST");
    expect(formatDateTime(new Date("2026-03-08T07:00:00Z"), "America/New_York")).toBe("Mar 8, 2026, 3:00 AM EDT");
  });
  it("DST edge: fall-back repeats 1:30 AM with EDT then EST", () => {
    expect(formatDateTime(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe("Nov 1, 2026, 1:30 AM EDT");
    expect(formatDateTime(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe("Nov 1, 2026, 1:30 AM EST");
  });
});

describe("calendarDaysBetween", () => {
  it("counts calendar days in the zone, not 24-hour blocks", () => {
    // 11 PM and 1 AM next day in Toronto are 2 hours apart but 1 calendar day apart.
    expect(calendarDaysBetween(new Date("2026-03-06T04:00:00Z"), new Date("2026-03-06T06:00:00Z"), "America/Toronto")).toBe(1);
    expect(calendarDaysBetween(new Date("2026-03-06T04:00:00Z"), new Date("2026-03-06T06:00:00Z"), "UTC")).toBe(0);
  });
  it("is stable across a DST change", () => {
    expect(calendarDaysBetween(new Date("2026-03-07T17:00:00Z"), new Date("2026-03-09T17:00:00Z"), "America/New_York")).toBe(2);
  });
});

describe("formatShortDate", () => {
  it("includes the zone label", () => {
    expect(formatShortDate(new Date("2026-10-28T10:00:00Z"), "America/Toronto")).toBe("Oct 28, EDT");
  });
});

describe("zone list", () => {
  it("offers UTC and common zones, sorted, without duplicates", () => {
    const list = supportedTimeZones();
    expect(list).toContain("UTC");
    expect(list).toContain("America/Toronto");
    expect(new Set(list).size).toBe(list.length);
    expect(list.every(isValidTimeZone)).toBe(true);
  });
  it("only listed zones are selectable", () => {
    expect(isSelectableTimeZone("Europe/Paris")).toBe(true);
    expect(isSelectableTimeZone("europe/paris")).toBe(false);
    expect(isSelectableTimeZone("Nowhere/Land")).toBe(false);
  });
  it("matchTimeZone finds the canonical name case-insensitively", () => {
    expect(matchTimeZone("  europe/paris ")).toBe("Europe/Paris");
    expect(matchTimeZone("america/new york")).toBe("America/New_York");
    expect(matchTimeZone("Toronto")).toBe("America/Toronto");
    expect(matchTimeZone("")).toBeNull();
    expect(matchTimeZone("Nowhere/Land")).toBeNull();
  });
});
