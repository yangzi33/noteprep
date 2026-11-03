import { describe, expect, it } from "vitest";
import { ITEM_STATUSES, isCodeChecked, statusFromChecks, tutorLabel, tutorLabelText, TUTOR_LABEL_TEXT } from "@/lib/content/ai-status";

describe("tutor labels (two states only)", () => {
  it("maps verified and code_checked to the first label and everything else to the second", () => {
    expect(tutorLabel("verified")).toBe("checked");
    expect(tutorLabel("code_checked")).toBe("checked");
    expect(tutorLabel("cross_checked")).toBe("review");
    expect(tutorLabel("unchecked")).toBe("review");
    expect(tutorLabel("failed")).toBe("review");
  });

  it("uses exactly the two owner-approved texts", () => {
    expect(TUTOR_LABEL_TEXT).toEqual({ checked: "Checked by code", review: "AI-generated: please review" });
    expect(new Set(ITEM_STATUSES.map((s) => tutorLabelText(s)))).toEqual(new Set(["Checked by code", "AI-generated: please review"]));
  });

  it("never shows cross_checked as a separate state", () => {
    expect(tutorLabelText("cross_checked")).toBe(tutorLabelText("unchecked"));
  });

  it("isCodeChecked is true only for verified and code_checked", () => {
    expect(ITEM_STATUSES.filter(isCodeChecked)).toEqual(["verified", "code_checked"]);
  });
});

describe("statusFromChecks", () => {
  it("a passing checker is code_checked, regardless of a cross-check", () => {
    expect(statusFromChecks({ result: "pass", checker: "numeric" }, null)).toBe("code_checked");
    expect(statusFromChecks({ result: "pass", checker: "numeric" }, "disagree")).toBe("code_checked");
  });
  it("a failing checker is failed, even when a cross-check agreed", () => {
    expect(statusFromChecks({ result: "fail", checker: "numeric", reason: "answer_mismatch" }, "agree")).toBe("failed");
  });
  it("no check: cross-check decides", () => {
    const none = { result: "none", reason: "no_claim" } as const;
    expect(statusFromChecks(none, "agree")).toBe("cross_checked");
    expect(statusFromChecks(none, "disagree")).toBe("failed");
    expect(statusFromChecks(none, null)).toBe("unchecked");
  });
});
