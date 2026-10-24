import { describe, expect, it } from "vitest";
import { changesText } from "@/lib/ui/draft-changes";
import { changesBadge, versionLimitNote } from "@/lib/ui/draft-versions";
import { generationErrorMessage } from "@/lib/ui/messages";

// S6-8: every state a draft page can be in has its own, checked wording. The code lists are tables, so a new state needs a line here.
type DraftStateCode = "DRAFT_EXPIRED" | "DRAFT_CONFLICT" | "VERSION_LIMIT" | "CANDIDATE_STALE" | "CANDIDATE_LIMIT" | "ADJUSTMENT_MIN_COUNT" | "DRAFT_BUSY" | "VERSION_RATE_LIMITED";

describe("draft state messages (exhaustive table)", () => {
  const EXPECTED = {
    DRAFT_EXPIRED: /has expired. Start again/, // expired
    DRAFT_CONFLICT: /changed in another tab or window. Reload/, // conflict
    VERSION_LIMIT: /reached its limit of versions/, // version limit
    CANDIDATE_STALE: /out of date. Ask for a new one/, // candidate pending, but outdated
    CANDIDATE_LIMIT: /Pick one, or keep the original/, // candidate pending, too many looked at
    ADJUSTMENT_MIN_COUNT: /needs at least a few questions/, // minimum questions
    DRAFT_BUSY: /busy. Please try again/,
    VERSION_RATE_LIMITED: /many versions recently/,
  } satisfies Record<DraftStateCode, RegExp>;
  for (const [code, pattern] of Object.entries(EXPECTED) as [DraftStateCode, RegExp][]) {
    it(code, () => {
      const m = generationErrorMessage(code)!;
      expect(m).toMatch(pattern);
      expect(m).not.toBe("Something went wrong. Please try again.");
      expect(m).not.toMatch(/exception|stack|null|undefined/i);
      expect(m.endsWith(".")).toBe(true);
    });
  }
});

describe("draft state view helpers", () => {
  it("version limit: a visible note only at or past the limit (active below it)", () => {
    expect(versionLimitNote(1, 5)).toBeNull();
    expect(versionLimitNote(4, 5)).toBeNull();
    expect(versionLimitNote(5, 5)).toContain("the most allowed (5)");
  });
  it("changes text and badge: none, replaced, removed, both, singular and plural", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `q-${i}`);
    const table = [
      { r: 0, d: 0, text: "No changes yet", badge: null },
      { r: 1, d: 0, text: "1 question replaced", badge: "1 replaced" },
      { r: 2, d: 0, text: "2 questions replaced", badge: "2 replaced" },
      { r: 0, d: 1, text: "1 question removed", badge: "1 removed" },
      { r: 1, d: 2, text: "1 question replaced · 2 removed", badge: "1 replaced · 2 removed" },
    ];
    for (const row of table) {
      expect(changesText(row.r, row.d), `${row.r}/${row.d}`).toBe(row.text);
      expect(changesBadge({ replacedIds: ids(row.r), removedIds: ids(row.d) })).toBe(row.badge);
    }
  });
});
