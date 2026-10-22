import { describe, expect, it } from "vitest";
import { DeadlineExceeded, domainErrorCode, ExportBusy, ExportConflict, ExportDisabled, ExportNotVerified, ExportRenderFailed, ExportUnavailable } from "@/lib/domain/errors";
import { EXPORT_FAILURE_MEMO_THRESHOLD, NON_RETRYABLE_EXPORT_FAILURES } from "@/lib/domain/export-spec";
import { describeOutcome, generationErrorMessage } from "@/lib/ui/messages";

describe("export errors and messages", () => {
  it("each typed error carries its stable code and has its own user message", () => {
    const errors = [new ExportConflict(), new ExportNotVerified(), new ExportRenderFailed("x"), new ExportBusy(), new ExportUnavailable(), new ExportDisabled()];
    for (const error of errors) {
      const c = domainErrorCode(error)!;
      expect(c).toMatch(/^EXPORT_/);
      expect(generationErrorMessage(c)).not.toBe("Something went wrong. Please try again.");
    }
    expect(domainErrorCode(new DeadlineExceeded())).toBe("DEADLINE_EXCEEDED");
    expect(new ExportRenderFailed("text_too_long").message).not.toContain("text_too_long"); // the reason is a field, never in the message
  });

  it("the failure memo counts only failures a retry cannot fix", () => {
    for (const transient of ["canceled", "deadline_exceeded", "max_attempts_exceeded", "storage_failed", "internal_error", "export_not_supported", "sandbox_unavailable", "compile_timeout"]) {
      expect(NON_RETRYABLE_EXPORT_FAILURES as readonly string[], transient).not.toContain(transient);
    }
    expect(new Set(NON_RETRYABLE_EXPORT_FAILURES).size).toBe(NON_RETRYABLE_EXPORT_FAILURES.length);
    expect(EXPORT_FAILURE_MEMO_THRESHOLD).toBe(3);
  });

  it("a failed export still says it did not use an allowance", () => {
    expect(describeOutcome("failed", "export_not_supported")).toMatch(/did not use one of your generations/);
  });
});
