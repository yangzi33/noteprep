import type { CheckOutcome } from "@/lib/math/checkers/types";

/** Internal validation status of an item. `verified` is the deterministic source; the rest belong to model-written items. */
export const ITEM_STATUSES = ["verified", "code_checked", "cross_checked", "unchecked", "failed"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** The statuses a model-written item can hold. */
export type AiStatus = Exclude<ItemStatus, "verified">;

export type TutorLabel = "checked" | "review";

export const TUTOR_LABEL_TEXT: Record<TutorLabel, string> = {
  checked: "Checked by code",
  review: "AI-generated: please review",
};

/** Tutors see two states only; model agreement (`cross_checked`) is never a stronger state than `unchecked`. */
export function tutorLabel(status: ItemStatus): TutorLabel {
  return status === "verified" || status === "code_checked" ? "checked" : "review";
}

export function tutorLabelText(status: ItemStatus): string {
  return TUTOR_LABEL_TEXT[tutorLabel(status)];
}

export function isCodeChecked(status: ItemStatus): boolean {
  return tutorLabel(status) === "checked";
}

/** What the optional second model call concluded: `agree`, `disagree`, or null when none ran or it could not be read. */
export type CrossCheckResult = "agree" | "disagree" | null;

/** A code checker has the last word; the cross-check only matters where no checker applied. */
export function statusFromChecks(outcome: CheckOutcome, cross: CrossCheckResult): AiStatus {
  if (outcome.result === "pass") return "code_checked";
  if (outcome.result === "fail") return "failed";
  if (cross === "agree") return "cross_checked";
  if (cross === "disagree") return "failed";
  return "unchecked";
}
