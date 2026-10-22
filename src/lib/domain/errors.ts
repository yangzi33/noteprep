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
    readonly source: "trial" | "paid",
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
