import { describe, expect, it } from "vitest";
import {
  ADJUSTMENT_REQUEST_VERSION,
  ADJUST_OPERATION,
  AdjustmentChange,
  AdjustmentRequest,
  DEV_DEFAULT_ADJUSTMENT_LIMITS,
  TextEdit,
  methodOf,
} from "@/lib/domain/adjustment";
import {
  AdjustmentBudgetExhausted,
  AdjustmentInProgress,
  AdjustmentNotApplicable,
  AdjustmentUnavailable,
  CorrectionRejected,
  DomainError,
  SourceSuperseded,
  domainErrorCode,
} from "@/lib/domain/errors";

const SOURCE = "0b9e5d3e-6f0a-4a58-9d57-1f7c8f0f2a11";
const edit = { sectionId: "explanation", target: { field: "title" }, text: "Clearer title" };
const ok = (change: unknown) => AdjustmentRequest.safeParse({ requestVersion: 1, sourceRevisionId: SOURCE, change }).success;

describe("AdjustmentRequest", () => {
  it("accepts every action", () => {
    for (const change of [
      { action: "make_easier" },
      { action: "make_harder" },
      { action: "add_exercises", count: 1 },
      { action: "add_exercises", count: 6 },
      { action: "add_worked_example" },
      { action: "change_duration", durationMinutes: 15 },
      { action: "change_duration", durationMinutes: 180 },
      { action: "correct_text", edits: [edit] },
      { action: "reduce_theory" },
    ])
      expect(ok(change), JSON.stringify(change)).toBe(true);
    expect(ADJUST_OPERATION).toBe("adjust");
    expect(ADJUSTMENT_REQUEST_VERSION).toBe(1);
  });
  it("rejects unknown actions and extra keys", () => {
    expect(ok({ action: "delete_everything" })).toBe(false);
    expect(ok({ action: "make_easier", extra: 1 })).toBe(false);
    expect(AdjustmentRequest.safeParse({ requestVersion: 1, sourceRevisionId: SOURCE, change: { action: "make_easier" }, x: 1 }).success).toBe(false);
    expect(AdjustmentRequest.safeParse({ requestVersion: 2, sourceRevisionId: SOURCE, change: { action: "make_easier" } }).success).toBe(false);
  });
  it("bounds count, duration and edits", () => {
    expect(ok({ action: "add_exercises", count: 0 })).toBe(false);
    expect(ok({ action: "add_exercises", count: 7 })).toBe(false);
    expect(ok({ action: "add_exercises", count: 1.5 })).toBe(false);
    expect(ok({ action: "change_duration", durationMinutes: 14 })).toBe(false);
    expect(ok({ action: "change_duration", durationMinutes: 181 })).toBe(false);
    expect(ok({ action: "correct_text", edits: [] })).toBe(false);
    expect(ok({ action: "correct_text", edits: Array.from({ length: 20 }, () => edit) })).toBe(true);
    expect(ok({ action: "correct_text", edits: Array.from({ length: 21 }, () => edit) })).toBe(false);
  });
  it("bounds text edits", () => {
    const withText = (text: string) => TextEdit.safeParse({ ...edit, text }).success;
    expect(withText("a".repeat(600))).toBe(true);
    expect(withText("a".repeat(601))).toBe(false);
    expect(withText("")).toBe(false);
    expect(TextEdit.safeParse({ ...edit, sectionId: "" }).success).toBe(false);
    expect(TextEdit.safeParse({ ...edit, extra: 1 }).success).toBe(false);
  });
  it("bounds edit targets", () => {
    const t = (target: unknown) => TextEdit.safeParse({ ...edit, target }).success;
    expect(t({ field: "block_text", blockIndex: 59 })).toBe(true);
    expect(t({ field: "block_text", blockIndex: 60 })).toBe(false);
    expect(t({ field: "block_text", blockIndex: -1 })).toBe(false);
    expect(t({ field: "block_item", blockIndex: 0, itemIndex: 19 })).toBe(true);
    expect(t({ field: "block_item", blockIndex: 0, itemIndex: 20 })).toBe(false);
    expect(t({ field: "block_item", blockIndex: 60, itemIndex: 0 })).toBe(false);
    expect(t({ field: "title", blockIndex: 0 })).toBe(false);
    expect(t({ field: "other" })).toBe(false);
  });
  it("requires a uuid source revision", () => {
    expect(AdjustmentRequest.safeParse({ requestVersion: 1, sourceRevisionId: "not-a-uuid", change: { action: "make_easier" } }).success).toBe(false);
    expect(AdjustmentChange.safeParse({ action: "make_easier" }).success).toBe(true);
  });
});

describe("methodOf", () => {
  it("maps every action", () => {
    const expected: Record<string, string> = {
      make_easier: "deterministic",
      make_harder: "deterministic",
      add_exercises: "deterministic",
      add_worked_example: "deterministic",
      change_duration: "deterministic",
      correct_text: "deterministic",
      reduce_theory: "llm",
    };
    const changes = [
      { action: "make_easier" },
      { action: "make_harder" },
      { action: "add_exercises", count: 2 },
      { action: "add_worked_example" },
      { action: "change_duration", durationMinutes: 60 },
      { action: "correct_text", edits: [edit] },
      { action: "reduce_theory" },
    ] as const;
    for (const c of changes) expect(methodOf(AdjustmentChange.parse(c)), c.action).toBe(expected[c.action]);
  });
});

describe("DEV_DEFAULT_ADJUSTMENT_LIMITS", () => {
  it("holds the documented test values", () => {
    expect(DEV_DEFAULT_ADJUSTMENT_LIMITS).toEqual({
      ratePerHourPerUser: 30,
      ratePerDayPerUser: 150,
      ratePerHourPerIp: 60,
      maxActivePerLesson: 1,
      maxActivePerUser: 2,
      job: { maxAttempts: 3, deadlineMinutes: 10 },
      llm: { enabled: false, budgetPerLesson: 5, job: { maxCalls: 2, maxTokens: 20_000, maxCostMicros: 100_000 } },
    });
  });
});

describe("adjustment domain errors", () => {
  const secret = "SECRET-USER-TEXT";
  const cases: [DomainError, string][] = [
    [new AdjustmentNotApplicable("already_basic"), "ADJUSTMENT_NOT_APPLICABLE"],
    [new SourceSuperseded(), "SOURCE_SUPERSEDED"],
    [new AdjustmentInProgress(), "ADJUSTMENT_IN_PROGRESS"],
    [new AdjustmentBudgetExhausted(), "ADJUSTMENT_BUDGET_EXHAUSTED"],
    [new AdjustmentUnavailable(), "ADJUSTMENT_UNAVAILABLE"],
    [new CorrectionRejected(["contains_digit", "contains_url"]), "CORRECTION_REJECTED"],
  ];
  it("carry stable codes recognised by domainErrorCode", () => {
    for (const [error, code] of cases) {
      expect(error.code).toBe(code);
      expect(domainErrorCode(error)).toBe(code);
    }
  });
  it("are recognised when built by another copy of the class", () => {
    for (const [, code] of cases) {
      class Other extends Error {
        readonly isDomainError = true;
        readonly code = code;
      }
      expect(domainErrorCode(new Other("x"))).toBe(code);
    }
  });
  it("expose reason and codes but keep messages free of content", () => {
    expect((cases[0]![0] as AdjustmentNotApplicable).reason).toBe("already_basic");
    expect((cases[5]![0] as CorrectionRejected).codes).toEqual(["contains_digit", "contains_url"]);
    for (const e of [new AdjustmentNotApplicable(secret), new CorrectionRejected([secret])]) {
      // reason/codes are machine codes supplied by the caller; the message itself must not echo them
      expect(e.message).not.toContain(secret);
    }
    for (const [error] of cases) expect(error.message).not.toContain("SECRET");
  });
});
