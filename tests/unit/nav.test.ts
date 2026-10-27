import { describe, expect, it } from "vitest";
import { activeNavHref, NAV_ITEMS } from "@/lib/ui/nav";

const HREFS = ["/dashboard", "/prepare", "/lessons", "/lessons/new"] as const;

describe("activeNavHref", () => {
  it("prefers the longest matching href", () => {
    expect(activeNavHref("/lessons/new", HREFS)).toBe("/lessons/new");
  });
  it("matches a section and its children", () => {
    expect(activeNavHref("/lessons", HREFS)).toBe("/lessons");
    expect(activeNavHref("/lessons/abc-123", HREFS)).toBe("/lessons");
    expect(activeNavHref("/dashboard", HREFS)).toBe("/dashboard");
    expect(activeNavHref("/prepare", HREFS)).toBe("/prepare");
    expect(activeNavHref("/prepare/x", HREFS)).toBe("/prepare");
  });
  it("only matches on path segment boundaries", () => {
    expect(activeNavHref("/lessons-x", HREFS)).toBeNull();
  });
  it("returns null for no match or an empty list", () => {
    expect(activeNavHref("/", HREFS)).toBeNull();
    expect(activeNavHref("/lessons", [])).toBeNull();
  });
});

describe("NAV_ITEMS", () => {
  it("lists the workspace destinations in order", () => {
    expect(NAV_ITEMS.map((i) => i.href)).toEqual(["/dashboard", "/prepare", "/lessons", "/account"]);
  });
  it("highlights Account on the account page", () => {
    expect(activeNavHref("/account", NAV_ITEMS.map((i) => i.href))).toBe("/account");
  });
});
