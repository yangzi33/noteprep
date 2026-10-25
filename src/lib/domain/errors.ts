/** Domain errors carry a stable machine-readable code; messages never include content. */
export class DomainError extends Error {
  /** Explicit marker (a property, not a class identity) so duplicated module copies still recognize each other. */
  readonly isDomainError = true;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AllowanceExhausted extends DomainError {
  constructor(
    /** Reservations currently held by in-flight jobs; they return if those jobs fail. */
    readonly pending: number,
    readonly source: "trial" | "paid" | "daily",
  ) {
    super("ALLOWANCE_EXHAUSTED", "No generation allowance remaining");
  }
}

export class IdempotencyConflict extends DomainError {
  constructor() {
    super("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used with a different request");
  }
}

export class RateLimited extends DomainError {
  constructor() {
    super("RATE_LIMITED", "Too many requests");
  }
}

export class TooManyActiveJobs extends DomainError {
  constructor() {
    super("TOO_MANY_ACTIVE_JOBS", "Too many jobs in progress for this account");
  }
}

export class QueueBusy extends DomainError {
  constructor() {
    super("QUEUE_BUSY", "The service is busy; try again later");
  }
}

export class AccountNotActive extends DomainError {
  constructor() {
    super("ACCOUNT_NOT_ACTIVE", "Account is missing or being deleted");
  }
}

export class NotFound extends DomainError {
  constructor() {
    super("NOT_FOUND", "Not found");
  }
}

/** The caller no longer holds the job (stale fencing token, wrong state, canceled or deleted lesson). */
export class StaleOrCanceled extends DomainError {
  constructor() {
    super("STALE_OR_CANCELED", "Job is no longer owned by this attempt");
  }
}

export class ManifestIncomplete extends DomainError {
  constructor(detail: string) {
    super("MANIFEST_INCOMPLETE", detail);
  }
}

export class NotCompleteSuccess extends DomainError {
  constructor(detail: string) {
    super("NOT_COMPLETE_SUCCESS", detail);
  }
}

/** The curriculum version or topic does not exist, is not published, or is not visible in this environment. */
export class CurriculumNotFound extends DomainError {
  constructor() {
    super("CURRICULUM_NOT_FOUND", "Curriculum selection not found");
  }
}

/** The topic exists in the dataset but the engine cannot generate and verify practice for it. */
export class TopicUnsupported extends DomainError {
  constructor() {
    super("TOPIC_UNSUPPORTED", "This topic is not supported yet");
  }
}

/** The chosen level/course/unit/topic/objectives do not fit together. */
export class InvalidSelection extends DomainError {
  constructor(detail = "Invalid selection") {
    super("INVALID_SELECTION", detail);
  }
}

/** The requested adjustment cannot change this lesson (for example it is already at the easiest level). */
export class AdjustmentNotApplicable extends DomainError {
  constructor(
    /** A machine-readable reason code (never user text). */
    readonly reason: string,
  ) {
    super("ADJUSTMENT_NOT_APPLICABLE", "This adjustment does not apply to the lesson");
  }
}

/** The lesson's head revision is no longer the revision the adjustment was requested against. */
export class SourceSuperseded extends DomainError {
  constructor() {
    super("SOURCE_SUPERSEDED", "The lesson has changed since this adjustment was requested");
  }
}

export class AdjustmentInProgress extends DomainError {
  constructor() {
    super("ADJUSTMENT_IN_PROGRESS", "An adjustment is already in progress for this lesson");
  }
}

export class AdjustmentBudgetExhausted extends DomainError {
  constructor() {
    super("ADJUSTMENT_BUDGET_EXHAUSTED", "No adjustment budget remaining for this lesson");
  }
}

/** The adjustment kind is switched off or its backend is unavailable in this environment. */
export class AdjustmentUnavailable extends DomainError {
  constructor() {
    super("ADJUSTMENT_UNAVAILABLE", "This adjustment is not available");
  }
}

/** A text correction failed validation. `codes` are machine-readable issue codes, never the text itself. */
export class CorrectionRejected extends DomainError {
  constructor(readonly codes: string[]) {
    super("CORRECTION_REJECTED", "The correction was rejected");
  }
}

/** The draft passed its expiry (or was already purged): it can no longer be opened. */
export class DraftExpired extends DomainError {
  constructor() {
    super("DRAFT_EXPIRED", "This draft has expired");
  }
}

/** The account already holds the maximum number of active drafts. */
export class DraftLimit extends DomainError {
  constructor() {
    super("DRAFT_LIMIT", "Too many active drafts");
  }
}

/** Too many drafts were created recently (per account, per address or service-wide). */
export class DraftRateLimited extends DomainError {
  constructor() {
    super("DRAFT_RATE_LIMITED", "Too many drafts created recently");
  }
}

/** A drawn question did not pass the item gate (structured shape, exact re-solve, validator "verified"). */
export class ItemRejected extends DomainError {
  constructor(
    /** A machine-readable reason (never question content). */
    readonly reason: string,
  ) {
    super("ITEM_REJECTED", "A question did not pass verification");
  }
}

/** An operation was called with arguments that cannot be valid (for example a revision that is not a positive integer). */
export class InvalidRequest extends DomainError {
  constructor(detail = "Invalid request") {
    super("INVALID_REQUEST", detail);
  }
}

/** The version changed since the page was rendered (another tab or window): the caller names the current revision. */
export class DraftConflict extends DomainError {
  constructor(readonly currentRev: number) {
    super("DRAFT_CONFLICT", "This draft changed in another tab or window");
  }
}

/** The pending candidate is gone, is not the one named, or was made for content the draft no longer has. */
export class CandidateStale extends DomainError {
  constructor() {
    super("CANDIDATE_STALE", "This candidate is no longer current");
  }
}

/** Removing the question would leave fewer exercises than the configured (and builder) minimum. */
export class MinQuestionCount extends DomainError {
  constructor(readonly minimum: number) {
    super("ADJUSTMENT_MIN_COUNT", "A worksheet needs a minimum number of questions");
  }
}

/** No other question at this level is available (the draw found nothing outside the exclusion set). */
export class DrawExhausted extends DomainError {
  constructor() {
    super("DRAW_EXHAUSTED", "No other question at this level is available");
  }
}

/** The question id is not an exercise of this version (worked examples cannot be adjusted). */
export class QuestionNotFound extends DomainError {
  constructor() {
    super("QUESTION_NOT_FOUND", "Question not found");
  }
}

export class NothingToUndo extends DomainError {
  constructor() {
    super("NOTHING_TO_UNDO", "There is nothing to undo");
  }
}

/** Too many alternatives were requested for one question in this session. */
export class CandidateLimit extends DomainError {
  constructor() {
    super("CANDIDATE_LIMIT", "Too many alternatives requested for this question");
  }
}

/** Too many alternatives were requested recently across the account. */
export class CandidateRateLimited extends DomainError {
  constructor() {
    super("CANDIDATE_RATE_LIMITED", "Too many alternative questions requested recently");
  }
}

/** The draft row (or one of its versions) stayed locked by another request for longer than the lock timeout: safe to retry. */
export class DraftBusy extends DomainError {
  constructor() {
    super("DRAFT_BUSY", "This draft is busy");
  }
}

/** The draft already holds the maximum number of versions (nothing is evicted automatically). */
export class VersionLimit extends DomainError {
  constructor(readonly max: number) {
    super("VERSION_LIMIT", "This draft has reached its limit of versions");
  }
}

/** Too many versions were created recently across the account. */
export class VersionRateLimited extends DomainError {
  constructor() {
    super("VERSION_RATE_LIMITED", "Too many versions created recently");
  }
}

// --- export (S4a) ---------------------------------------------------------------------------------------------

/** The draft changed since the confirmation page was rendered (revision or content hash), or the form is stale: nothing was reserved. */
export class ExportConflict extends DomainError {
  constructor() {
    super("EXPORT_CONFLICT", "This draft changed since the confirmation page was shown");
  }
}

/** The package did not validate as verified: it can never be exported. */
export class ExportNotVerified extends DomainError {
  constructor() {
    super("EXPORT_NOT_VERIFIED", "This draft is not fully verified");
  }
}

/** The renderer refused the package: nothing was reserved. `reason` is a machine-readable RenderError code, never content. */
export class ExportRenderFailed extends DomainError {
  constructor(readonly reason: string) {
    super("EXPORT_RENDER_FAILED", "The documents could not be laid out");
  }
}

/** An equivalent export is being cancelled or has outlived its deadline (or a row lock timed out): try again shortly. */
export class ExportBusy extends DomainError {
  constructor() {
    super("EXPORT_BUSY", "An export of this draft is busy");
  }
}

/** The same export failed repeatedly for a reason that retrying will not fix. */
export class ExportUnavailable extends DomainError {
  constructor() {
    super("EXPORT_UNAVAILABLE", "This export is not available");
  }
}

/** Export is switched off in this environment (EXPORT_ENABLED). */
export class ExportDisabled extends DomainError {
  constructor() {
    super("EXPORT_DISABLED", "Export is not enabled");
  }
}

/** The job's deadline has passed: a late commit is refused so it can never be billed (the caller finishes the job as failed). */
export class DeadlineExceeded extends DomainError {
  constructor() {
    super("DEADLINE_EXCEEDED", "The job passed its deadline");
  }
}

export class InvariantViolation extends DomainError {
  constructor(detail: string) {
    super("INVARIANT_VIOLATION", detail);
  }
}

/**
 * The stable code of a domain error, or null for anything else. Match on this rather than `instanceof`
 * wherever a caller may live in a different bundle than the thrower: Next.js builds server components,
 * server actions and route handlers separately, so each gets its own copy of these classes and an
 * `instanceof` check can fail even though the error is the right kind (found by the E2E tests).
 */
export function domainErrorCode(error: unknown): string | null {
  const e = error as { isDomainError?: unknown; code?: unknown } | null;
  if (error instanceof Error && e?.isDomainError === true && typeof e.code === "string") return e.code;
  return null;
}

/** The lesson still has a queued or running job; deleting it never cancels work implicitly (cancel the export first). */
export class LessonBusy extends DomainError {
  constructor() {
    super("LESSON_BUSY", "This lesson still has work in progress");
  }
}
