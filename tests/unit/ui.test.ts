import { describe, expect, it } from "vitest";
import { isRetrying, isTerminal } from "@/lib/ui/job-view";
import { describeOutcome, generationErrorMessage, stageLabel, stateLabel } from "@/lib/ui/messages";

describe("job view logic", () => {
  it("knows which states are final", () => {
    expect(["succeeded", "failed", "canceled"].every((s) => isTerminal(s as never))).toBe(true);
    expect(["queued", "running"].some((s) => isTerminal(s as never))).toBe(false);
  });
  it("tells a first start apart from a retry", () => {
    expect(isRetrying({ state: "queued", attempt: 0 })).toBe(false);
    expect(isRetrying({ state: "queued", attempt: 2 })).toBe(true);
    expect(isRetrying({ state: "running", attempt: 2 })).toBe(false);
  });
});

describe("user-facing messages", () => {
  it("never says a failed or canceled job used a generation", () => {
    for (const code of ["llm_timeout", "compile_failed", "storage_failed", "budget_exceeded", "something_unknown", null]) {
      expect(describeOutcome("failed", code)).toMatch(/did not use one of your generations/);
    }
    expect(describeOutcome("canceled", "canceled")).toMatch(/did not use one of your generations/);
  });
  it("has nothing to say for jobs that are still running or complete", () => {
    expect(describeOutcome("running", null)).toBeNull();
    expect(describeOutcome("succeeded", null)).toBeNull();
  });
  it("does not leak internal codes into messages", () => {
    for (const code of ["llm_timeout", "compile_failed", "internal_error", "weird_code"]) {
      expect(describeOutcome("failed", code)).not.toContain(code);
    }
    expect(generationErrorMessage("SOMETHING_NEW")).toBe("Something went wrong. Please try again.");
    expect(generationErrorMessage(undefined)).toBeNull();
  });
  it("explains each allowance and limit error in plain words", () => {
    for (const code of ["ALLOWANCE_EXHAUSTED", "RATE_LIMITED", "TOO_MANY_ACTIVE_JOBS", "QUEUE_BUSY", "IDEMPOTENCY_KEY_REUSED", "invalid"]) {
      expect(generationErrorMessage(code)).toMatch(/\w+ \w+ \w+/);
    }
  });
  it("labels every state and stage", () => {
    expect(stateLabel("queued")).toBe("Waiting to start");
    expect(stageLabel("compiling")).toBe("Building the documents");
    expect(stageLabel(null)).toBeNull();
  });
});

import { AllowanceExhausted, NotFound, domainErrorCode } from "@/lib/domain/errors";

describe("domainErrorCode (works across duplicated module copies)", () => {
  it("reads the code from real domain errors", () => {
    expect(domainErrorCode(new NotFound())).toBe("NOT_FOUND");
    expect(domainErrorCode(new AllowanceExhausted(1, "trial"))).toBe("ALLOWANCE_EXHAUSTED");
  });
  it("recognizes an error built by another copy of the class, where instanceof would say no", () => {
    class OtherCopyOfNotFound extends Error {
      readonly isDomainError = true;
      readonly code = "NOT_FOUND";
    }
    const foreign = new OtherCopyOfNotFound("x");
    expect(foreign instanceof NotFound).toBe(false);
    expect(domainErrorCode(foreign)).toBe("NOT_FOUND");
  });
  it("ignores everything that is not a coded domain error", () => {
    class Db extends Error {
      code = "P2002"; // a database driver code, not one of ours
    }
    class LooksLikeOurs extends Error {
      code = "NOT_FOUND"; // right-looking code, but not marked as a domain error
    }
    for (const value of [new Error("x"), new Db("x"), new LooksLikeOurs("x"), "NOT_FOUND", { code: "NOT_FOUND" }, null, undefined]) {
      expect(domainErrorCode(value)).toBeNull();
    }
  });
});
