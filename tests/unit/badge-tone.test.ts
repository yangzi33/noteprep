import { describe, expect, it } from "vitest";
import { badgeTone } from "@/lib/ui/badge-tone";

describe("badgeTone", () => {
  it("maps states to tones", () => {
    expect(badgeTone("succeeded")).toBe("accent");
    expect(badgeTone("failed")).toBe("danger");
    expect(badgeTone("canceled")).toBe("neutral");
    expect(badgeTone("queued")).toBe("neutral");
    expect(badgeTone("running")).toBe("neutral");
  });
});
