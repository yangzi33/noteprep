/** User-facing wording for domain error codes and job outcomes. Never includes internal detail. */

const GENERATION_ERRORS: Record<string, string> = {
  invalid: "Please choose at least one document, a lesson length and a difficulty, then try again.",
  ALLOWANCE_EXHAUSTED: "You have used all your free lesson packs. If a job is still in progress, its lesson pack comes back if that job fails.",
  RATE_LIMITED: "You have made too many requests recently. Please try again later.",
  TOO_MANY_ACTIVE_JOBS: "You already have jobs in progress. Wait for one to finish, or cancel one.",
  QUEUE_BUSY: "The service is busy right now. Please try again in a few minutes.",
  IDEMPOTENCY_KEY_REUSED: "This form was already submitted with different details. Reload the page and try again.",
  ACCOUNT_NOT_ACTIVE: "This account cannot create new lessons.",
  CURRICULUM_NOT_FOUND: "That curriculum selection is not available. Please choose again.",
  TOPIC_UNSUPPORTED: "We cannot yet generate verified practice for that topic. Please choose another topic.",
  INVALID_SELECTION: "Those choices do not fit together. Please start the selection again.",
  DRAFT_EXPIRED: "This draft has expired. Start again with the same choices to make a new one.",
  DRAFT_LIMIT: "You have many drafts open. Open one of them, or wait for older drafts to expire.",
  DRAFT_RATE_LIMITED: "You have created many drafts recently. Please try again later.",
  INVALID_REQUEST: "That request was not valid. Reload the page and try again.",
  DRAFT_CONFLICT: "This draft changed in another tab or window. Reload to see the latest.",
  CANDIDATE_STALE: "That suggestion is out of date. Ask for a new one.",
  ADJUSTMENT_MIN_COUNT: "A worksheet needs at least a few questions, so this one cannot be removed.",
  DRAW_EXHAUSTED: "No other question at this level is available.",
  QUESTION_NOT_FOUND: "That question is no longer in this worksheet.",
  NOTHING_TO_UNDO: "There is nothing to undo.",
  CANDIDATE_LIMIT: "You have looked at several alternatives for this question. Pick one, or keep the original.",
  CANDIDATE_RATE_LIMITED: "You have asked for many alternative questions recently. Please try again later.",
  DRAFT_BUSY: "This draft is busy. Please try again.",
  VERSION_LIMIT: "This draft has reached its limit of versions. Switch to one you have, or start a new draft.",
  VERSION_RATE_LIMITED: "You have created many versions recently. Please try again later.",
  ITEM_REJECTED: "We could not build a fully checked lesson from those choices. Please try again.",
  PACKAGE_BUILD_FAILED: "We could not build this lesson from the selected topic.",
  EXPORT_CONFLICT: "This draft changed after you opened the confirmation page. Review it again before you export. Nothing was used.",
  EXPORT_NOT_VERIFIED: "This draft is not fully checked, so it cannot be exported. Nothing was used.",
  EXPORT_RENDER_FAILED: "We could not lay out these documents. Nothing was used.",
  EXPORT_BUSY: "An export of this draft is being stopped or finished. Please try again in a moment.",
  EXPORT_UNAVAILABLE: "This export failed several times and cannot be retried. Nothing was used. Try changing the draft.",
  EXPORT_DISABLED: "PDF export is paused right now. Your draft is saved.",
};

export type AllowanceSourceKind = "trial" | "paid" | "daily";

/**
 * The message for an exhausted allowance. Billing is off in this test version, so the daily and trial texts say "contact us"
 * and never point at a subscribe action (words only, no address). With no source (the page has no allowance) or a paid source it is the generic text.
 */
export function exhaustedMessage(source: AllowanceSourceKind | null): string {
  if (source === "daily") {
    return "You have used all of today's free lesson packs. The count comes back at 00:00 UTC. If a job is still in progress, its lesson pack comes back if that job fails. To get more sooner, contact us.";
  }
  if (source === "trial") {
    return "You have used all your free lesson packs. If a job is still in progress, its lesson pack comes back if that job fails. To get more, contact us.";
  }
  return GENERATION_ERRORS.ALLOWANCE_EXHAUSTED!;
}

/** The notice shown on the selection pages when the allowance is used up (the daily wording, or the trial one with no subscribe action). */
export function exhaustedNotice(source: AllowanceSourceKind): string {
  return source === "daily" ? exhaustedMessage("daily") : "You have used all of your free lesson packs. To get more, contact us.";
}

export function generationErrorMessage(code: string | null | undefined, source: AllowanceSourceKind | null = null): string | null {
  if (!code) return null;
  if (code === "ALLOWANCE_EXHAUSTED") return exhaustedMessage(source);
  return GENERATION_ERRORS[code] ?? "Something went wrong. Please try again.";
}

export const FAILURE_REASONS: Record<string, string> = {
  llm_timeout: "The writing service took too long to respond.",
  llm_rate_limited: "The writing service was busy.",
  llm_overloaded: "The writing service was busy.",
  llm_invalid_output: "The writing service returned something we could not use.",
  llm_refused: "The writing service declined the request.",
  invalid_output: "The generated text did not pass our checks.",
  compile_failed: "The documents could not be built.",
  compile_timeout: "Building the documents took too long.",
  render_failed: "The documents could not be laid out.",
  validation_failed: "The lesson did not pass our checks, so it was not saved.",
  package_build_failed: "We could not build this lesson from the selected topic.",
  legacy_unsupported: "The quick form is not available. Please use the curriculum selection.",
  sandbox_unavailable: "The document builder was unavailable.",
  storage_failed: "The finished files could not be saved.",
  budget_exceeded: "This lesson needed more resources than allowed.",
  deadline_exceeded: "The job took too long and was stopped.",
  max_attempts_exceeded: "The job could not be completed after several tries.",
  internal_error: "An unexpected error occurred.",
  export_not_supported: "Export is not available on this service yet.",
  render_mismatch: "The documents did not match what was confirmed.",
  render_version_mismatch: "The document layout was updated while this was waiting. Please confirm the export again.",
  snapshot_invalid: "The confirmed lesson could not be read back correctly, so the documents were not built.",
  manifest_incomplete: "The finished files were incomplete, so they were not saved.",
  canceled: "The export was canceled.",
};

/** A failed or canceled job never costs a lesson pack; the message says so. */
export function describeOutcome(state: string, errorCode: string | null): string | null {
  if (state === "canceled") return "Canceled. This did not use one of your lesson packs.";
  if (state !== "failed") return null;
  const reason = (errorCode && FAILURE_REASONS[errorCode]) || "The lesson could not be completed.";
  return `${reason} This did not use one of your lesson packs.`;
}

const STATE_LABELS: Record<string, string> = {
  queued: "Waiting to start",
  running: "In progress",
  succeeded: "Complete",
  failed: "Failed",
  canceled: "Canceled",
};

const STAGE_LABELS: Record<string, string> = {
  generating: "Writing the lesson text",
  validating: "Checking the lesson",
  compiling: "Building the documents",
  storing: "Saving the files",
};

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

export function stageLabel(stage: string | null): string | null {
  return stage ? (STAGE_LABELS[stage] ?? stage) : null;
}
