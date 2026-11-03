import type { CheckerName, CheckOutcome } from "@/lib/math/checkers/types";

export const NO_CLAIM: CheckOutcome = { result: "none", reason: "no_claim" };
export const CLAIM_UNBOUND: CheckOutcome = { result: "none", reason: "claim_unbound" };
export const CLAIM_UNREADABLE: CheckOutcome = { result: "none", reason: "claim_unreadable" };
export const ANSWER_UNREADABLE: CheckOutcome = { result: "none", reason: "answer_unreadable" };

/** The only two conclusive outcomes: the checker re-derived the stated answer, or it derived a different one. */
export function verdict(agrees: boolean, checker: CheckerName): CheckOutcome {
  return agrees ? { result: "pass", checker } : { result: "fail", checker, reason: "answer_mismatch" };
}
