import { describe, expect, it } from "vitest";
import { changesText } from "@/lib/ui/draft-changes";
import { generationErrorMessage } from "@/lib/ui/messages";

describe("changesText", () => {
  it("leaves zero parts out and gets singular and plural right", () => {
    expect(changesText(0, 0)).toBe("No changes yet");
    expect(changesText(1, 0)).toBe("1 question replaced");
    expect(changesText(3, 0)).toBe("3 questions replaced");
    expect(changesText(0, 1)).toBe("1 question removed");
    expect(changesText(0, 2)).toBe("2 questions removed");
    expect(changesText(3, 1)).toBe("3 questions replaced · 1 removed");
    expect(changesText(1, 4)).toBe("1 question replaced · 4 removed");
  });
});

describe("draft messages", () => {
  it("ends the no-alternative message with a period", () => {
    expect(generationErrorMessage("DRAW_EXHAUSTED")).toBe("No other question at this level is available.");
    expect(generationErrorMessage("INVALID_REQUEST")).toMatch(/not valid/);
  });
});
