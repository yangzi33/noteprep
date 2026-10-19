/** Domain errors carry a stable machine-readable code; messages never include content. */
export class DomainError extends Error {
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

export class InvariantViolation extends DomainError {
  constructor(detail: string) {
    super("INVARIANT_VIOLATION", detail);
  }
}
