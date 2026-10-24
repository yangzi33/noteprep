import { describe, expect, it } from "vitest";
import { DeadlineExceeded, domainErrorCode, ExportBusy, ExportConflict, ExportDisabled, ExportNotVerified, ExportRenderFailed, ExportUnavailable } from "@/lib/domain/errors";
import { EXPORT_FAILURE_MEMO_THRESHOLD, NON_RETRYABLE_EXPORT_FAILURES } from "@/lib/domain/export-spec";
import { CONFIRM_REDIRECT_CODES, confirmErrorTarget, confirmSuccessHref } from "@/lib/ui/export-confirm";
import { describeOutcome, FAILURE_REASONS, generationErrorMessage } from "@/lib/ui/messages";

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
    for (const transient of ["render_version_mismatch", "manifest_incomplete", "canceled", "deadline_exceeded", "max_attempts_exceeded", "storage_failed", "internal_error", "export_not_supported", "sandbox_unavailable", "compile_timeout"]) {
      expect(NON_RETRYABLE_EXPORT_FAILURES as readonly string[], transient).not.toContain(transient);
    }
    expect(new Set(NON_RETRYABLE_EXPORT_FAILURES).size).toBe(NON_RETRYABLE_EXPORT_FAILURES.length);
    expect(EXPORT_FAILURE_MEMO_THRESHOLD).toBe(3);
  });

  it("every failure code the export worker can record has a tutor-facing reason", () => {
    const codes = ["render_version_mismatch", "snapshot_invalid", "manifest_incomplete", "canceled", "render_mismatch", "render_failed", "validation_failed", "compile_failed", "compile_timeout", "sandbox_unavailable", "storage_failed", "deadline_exceeded", "max_attempts_exceeded", "internal_error"];
    for (const c of codes) {
      expect(FAILURE_REASONS[c], c).toBeTruthy();
      expect(FAILURE_REASONS[c], c).not.toMatch(/no generation|did not use/i); // that claim belongs to the status page, keyed off the reservation
    }
    for (const c of NON_RETRYABLE_EXPORT_FAILURES) expect(FAILURE_REASONS[c], c).toBeTruthy();
  });

  it("a failed export still says it did not use an allowance", () => {
    expect(describeOutcome("failed", "export_not_supported")).toMatch(/did not use one of your generations/);
  });
});

// --- S6-8: every confirm error code and success outcome, as exhaustive tables ---

type ConfirmCode = (typeof CONFIRM_REDIRECT_CODES)[number];

describe("every confirm error code (exhaustive table)", () => {
  // Adding a code to CONFIRM_REDIRECT_CODES is a compile error until it has an expectation here.
  const EXPECTED = {
    EXPORT_CONFLICT: { message: /changed after you opened the confirmation page/, notUsed: true, to: "draft" },
    DRAFT_EXPIRED: { message: /draft has expired/, notUsed: false, to: "draft" },
    ALLOWANCE_EXHAUSTED: { message: /no generations left/, notUsed: false, to: "confirm" },
    RATE_LIMITED: { message: /too many requests/, notUsed: false, to: "confirm" },
    TOO_MANY_ACTIVE_JOBS: { message: /jobs in progress/, notUsed: false, to: "confirm" },
    QUEUE_BUSY: { message: /busy/, notUsed: false, to: "confirm" },
    EXPORT_BUSY: { message: /being stopped or finished/, notUsed: false, to: "confirm" },
    EXPORT_UNAVAILABLE: { message: /failed several times/, notUsed: true, to: "confirm" },
    EXPORT_DISABLED: { message: /export is paused/, notUsed: false, to: "confirm" },
    EXPORT_NOT_VERIFIED: { message: /not fully checked/, notUsed: true, to: "confirm" },
    EXPORT_RENDER_FAILED: { message: /could not lay out/, notUsed: true, to: "confirm" },
    IDEMPOTENCY_KEY_REUSED: { message: /already submitted with different details/, notUsed: false, to: "confirm" },
    ACCOUNT_NOT_ACTIVE: { message: /cannot create new lessons/, notUsed: false, to: "confirm" },
    INVALID_REQUEST: { message: /not valid/, notUsed: false, to: "confirm" },
  } satisfies Record<ConfirmCode, { message: RegExp; notUsed: boolean; to: "draft" | "confirm" }>;

  for (const [code, want] of Object.entries(EXPECTED) as [ConfirmCode, (typeof EXPECTED)[ConfirmCode]][]) {
    it(`${code}: message, "nothing was used" where it is true, and where the tutor lands`, () => {
      const message = generationErrorMessage(code)!;
      expect(message).toMatch(want.message);
      expect(message).not.toBe("Something went wrong. Please try again.");
      if (want.notUsed) expect(message).toMatch(/Nothing was used\./);
      const target = confirmErrorTarget(code, "d-1", "v-1");
      expect(target.kind).toBe("redirect");
      if (target.kind === "redirect") {
        expect(target.href).toBe(want.to === "draft" ? `/drafts/d-1?v=v-1&error=${code}` : `/drafts/d-1/export?v=v-1&error=${code}`);
      }
    });
  }
  it("an unknown code is rethrown (never silently swallowed) and NOT_FOUND is the not-found page", () => {
    expect(confirmErrorTarget("SOMETHING_ELSE", "d", "v")).toEqual({ kind: "rethrow" });
    expect(confirmErrorTarget(null, "d", "v")).toEqual({ kind: "rethrow" });
    expect(confirmErrorTarget("NOT_FOUND", "d", "v")).toEqual({ kind: "notFound" });
  });
  it("the table lists exactly the codes the action redirects with", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...CONFIRM_REDIRECT_CODES].sort());
  });
});

describe("every confirm success outcome (exhaustive table)", () => {
  const HREFS = {
    created: "/exports/e-1",
    replayed: "/exports/e-1",
    joined: "/exports/e-1?outcome=joined",
    reused: "/exports/e-1?outcome=reused",
  } satisfies Record<"created" | "joined" | "reused" | "replayed", string>;
  for (const [outcome, href] of Object.entries(HREFS) as [keyof typeof HREFS, string][]) {
    it(`${outcome} goes to ${href}`, () => {
      expect(confirmSuccessHref({ outcome, exportId: "e-1" })).toBe(href);
    });
  }
});
