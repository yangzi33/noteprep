import { describe, expect, it } from "vitest";
import { changesBadge, CREATE_VERSION_HELP, versionLabel, versionLimitNote } from "@/lib/ui/draft-versions";

describe("version view-model helpers", () => {
  it("labels versions by ordinal", () => {
    expect(versionLabel(1)).toBe("Version 1");
    expect(versionLabel(12)).toBe("Version 12");
  });
  it("shows a visible limit note only at the limit", () => {
    expect(versionLimitNote(4, 5)).toBeNull();
    expect(versionLimitNote(5, 5)).toMatch(/5 versions, the most allowed \(5\)/);
    expect(versionLimitNote(6, 5)).not.toBeNull();
  });
  it("has the reassurance text", () => {
    expect(CREATE_VERSION_HELP).toBe("Your current version is kept. You can switch back any time.");
  });
  it("builds a short changes badge, or none for an untouched version", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `ex-${i}`);
    expect(changesBadge({ replacedIds: [], removedIds: [] })).toBeNull();
    expect(changesBadge({ replacedIds: ids(1), removedIds: [] })).toBe("1 replaced");
    expect(changesBadge({ replacedIds: [], removedIds: ids(2) })).toBe("2 removed");
    expect(changesBadge({ replacedIds: ids(3), removedIds: ids(1) })).toBe("3 replaced · 1 removed");
  });
});
