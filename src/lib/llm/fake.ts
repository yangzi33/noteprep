import { isRetryableLlmError, type LlmErrorType, type LlmProvider, type StructuredRequest, type StructuredResult } from "./types";

export type FakeStep = "ok" | { error: LlmErrorType };

/**
 * Deterministic provider for tests and local development; needs no credentials. `script` is
 * consumed one entry per call; when it runs out the last entry repeats.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly id = "fake";
  calls = 0;

  constructor(private readonly script: readonly FakeStep[] = ["ok"]) {}

  async generateStructured(request: StructuredRequest): Promise<StructuredResult> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)] ?? "ok";
    this.calls++;
    const usage = { inputTokens: 100, outputTokens: 50, costMicros: 1_000 };
    if (step !== "ok") {
      return { ok: false, error: { type: step.error, retryable: isRetryableLlmError(step.error) }, usage };
    }
    return {
      ok: true,
      value: {
        objectives: ["Solve one-variable linear equations"],
        narrations: {},
        jobId: request.jobId,
      },
      resultSchemaVersion: 1,
      provider: this.id,
      model: "fake-model",
      usage,
    };
  }
}
