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
