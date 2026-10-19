import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/server/auth/redirects";

describe("safeNextPath (open redirect defence)", () => {
  it("keeps same-site absolute paths", () => {
    expect(safeNextPath("/account")).toBe("/account");
    expect(safeNextPath("/lessons/123?tab=files")).toBe("/lessons/123?tab=files");
  });
  it.each([
    "https://evil.example/phish",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "account",
    "",
    "/ok\nSet-Cookie: x=1",
    `/${"a".repeat(300)}`,
  ])("falls back for %j", (bad) => {
    expect(safeNextPath(bad)).toBe("/account");
  });
  it("falls back for missing values and honours a custom fallback", () => {
    expect(safeNextPath(null)).toBe("/account");
    expect(safeNextPath(undefined, "/home")).toBe("/home");
  });
});
