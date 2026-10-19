/** User-facing wording for domain error codes and job outcomes. Never includes internal detail. */

const GENERATION_ERRORS: Record<string, string> = {
  invalid: "Please check the form: every field needs a valid value.",
  ALLOWANCE_EXHAUSTED:
    "You have no generations left. If a job is still in progress, its allowance comes back if that job fails.",
  RATE_LIMITED: "You have made too many requests recently. Please try again later.",
  TOO_MANY_ACTIVE_JOBS: "You already have jobs in progress. Wait for one to finish, or cancel one.",
  QUEUE_BUSY: "The service is busy right now. Please try again in a few minutes.",
  IDEMPOTENCY_KEY_REUSED: "This form was already submitted with different details. Reload the page and try again.",
  ACCOUNT_NOT_ACTIVE: "This account cannot create new lessons.",
  CURRICULUM_NOT_FOUND: "That curriculum selection is not available. Please choose again.",
  TOPIC_UNSUPPORTED: "We cannot yet generate verified practice for that topic. Please choose another topic.",
  INVALID_SELECTION: "Those choices do not fit together. Please start the selection again.",
};

export function generationErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return GENERATION_ERRORS[code] ?? "Something went wrong. Please try again.";
}

const FAILURE_REASONS: Record<string, string> = {
  llm_timeout: "The writing service took too long to respond.",
  llm_rate_limited: "The writing service was busy.",
  llm_overloaded: "The writing service was busy.",
  llm_invalid_output: "The writing service returned something we could not use.",
  llm_refused: "The writing service declined the request.",
  invalid_output: "The generated text did not pass our checks.",
  compile_failed: "The documents could not be built.",
  compile_timeout: "Building the documents took too long.",
  sandbox_unavailable: "The document builder was unavailable.",
  storage_failed: "The finished files could not be saved.",
  budget_exceeded: "This lesson needed more resources than allowed.",
  deadline_exceeded: "The job took too long and was stopped.",
  max_attempts_exceeded: "The job could not be completed after several tries.",
  internal_error: "An unexpected error occurred.",
};

/** A failed or canceled job never costs a generation; the message says so. */
export function describeOutcome(state: string, errorCode: string | null): string | null {
  if (state === "canceled") return "Canceled. This did not use one of your generations.";
  if (state !== "failed") return null;
  const reason = (errorCode && FAILURE_REASONS[errorCode]) || "The lesson could not be completed.";
  return `${reason} This did not use one of your generations.`;
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
