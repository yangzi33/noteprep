import { isRetryableLlmError, type LlmErrorType, type LlmProvider, type StructuredRequest, type StructuredResult } from "./types";

export type FakeStep = "ok" | { error: LlmErrorType } | { value: unknown };

/** Valid, rule-abiding wording for the lesson-notes task: what a well-behaved model would return. */
export const FAKE_PROSE = {
  explanation: [
    "An equation states that two expressions have the same value, and solving it means finding the unknown value that makes the statement true.",
    "Whatever is done to one side must also be done to the other side so that both sides always stay equal to each other.",
  ],
  derivation: [
    "Begin with an equation that is true for some value of the unknown quantity.",
    "Doing the same thing to both sides keeps them equal, so the new equation has exactly the same solution as before.",
    "Each step removes one term or factor that sits next to the unknown quantity.",
  ],
  exampleIntro: "Work through each example together and ask the learner to name the next step before it is shown.",
  teachingSequence: [
    "Recall earlier work and explain the goal of the lesson clearly.",
    "Introduce the key ideas and the method in your own words.",
    "Work through the examples together and let the learner lead.",
    "Let the learner try the exercises and help only when asked.",
  ],
  commonMistakes: [
    "Changing only one side of the equation and forgetting the other side.",
    "Adding when the opposite operation is needed to undo a term.",
    "Skipping the final check by putting the answer back into the equation.",
  ],
} as const;

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
    if (step !== "ok" && "error" in step) {
      return { ok: false, error: { type: step.error, retryable: isRetryableLlmError(step.error) }, usage };
    }
    if (step !== "ok") return { ok: true, value: step.value, resultSchemaVersion: request.schemaVersion, provider: this.id, model: "fake-model", usage };
    if (request.task === "section_prose") {
      return { ok: true, value: FAKE_PROSE, resultSchemaVersion: request.schemaVersion, provider: this.id, model: "fake-model", usage };
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
