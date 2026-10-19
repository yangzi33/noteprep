/**
 * Thin provider-agnostic interface (docs/architecture.md section 8). Vendor SDK details stay inside
 * adapter files; nothing here is specific to one provider. Results are UNVALIDATED data until the
 * application's own schema has parsed them.
 */
export interface StructuredRequest {
  requestId: string;
  jobId: string;
  task: "lesson_prose";
  schemaVersion: number;
  system: string;
  /** Already minimized and sanitized by the caller; never account, billing or other users' data. */
  input: unknown;
  limits: { timeoutMs: number; maxOutputTokens: number; maxCostMicros: number };
  signal?: AbortSignal;
}

export type LlmErrorType =
  | "timeout"
  | "rate_limited"
  | "overloaded"
  | "invalid_output"
  | "refused"
  | "auth"
  | "bad_request"
  | "unknown";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Internal cost accounting in micro-units, not a customer billing amount. */
  costMicros: number;
}

export type StructuredResult =
  | { ok: true; value: unknown; resultSchemaVersion: number; provider: string; model: string; usage: Usage }
  | { ok: false; error: { type: LlmErrorType; retryable: boolean }; usage?: Usage };

export interface LlmProvider {
  readonly id: string;
  generateStructured(request: StructuredRequest): Promise<StructuredResult>;
}

/** Only these error types are worth retrying; the rest would fail the same way again. */
export function isRetryableLlmError(type: LlmErrorType): boolean {
  return type === "timeout" || type === "rate_limited" || type === "overloaded";
}
