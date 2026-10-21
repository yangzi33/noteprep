import { z } from "zod";

export const ADJUST_OPERATION = "adjust";
export const ADJUSTMENT_REQUEST_VERSION = 1;

export const TextEditTarget = z.discriminatedUnion("field", [
  z.strictObject({ field: z.literal("title") }),
  z.strictObject({ field: z.literal("block_text"), blockIndex: z.number().int().min(0).max(59) }),
  z.strictObject({
    field: z.literal("block_item"),
    blockIndex: z.number().int().min(0).max(59),
    itemIndex: z.number().int().min(0).max(19),
  }),
]);
export type TextEditTarget = z.infer<typeof TextEditTarget>;

export const TextEdit = z.strictObject({
  sectionId: z.string().min(1).max(200),
  target: TextEditTarget,
  text: z.string().min(1).max(600),
});
export type TextEdit = z.infer<typeof TextEdit>;

export const AdjustmentChange = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("make_easier") }),
  z.strictObject({ action: z.literal("make_harder") }),
  z.strictObject({ action: z.literal("add_exercises"), count: z.number().int().min(1).max(6) }),
  z.strictObject({ action: z.literal("add_worked_example") }),
  z.strictObject({ action: z.literal("change_duration"), durationMinutes: z.number().int().min(15).max(180) }),
  z.strictObject({ action: z.literal("correct_text"), edits: z.array(TextEdit).min(1).max(20) }),
  z.strictObject({ action: z.literal("reduce_theory") }), // llm; rejected at enqueue unless enabled
]);
export type AdjustmentChange = z.infer<typeof AdjustmentChange>;

export const AdjustmentRequest = z.strictObject({
  requestVersion: z.literal(ADJUSTMENT_REQUEST_VERSION),
  sourceRevisionId: z.uuid(),
  change: AdjustmentChange,
});
export type AdjustmentRequest = z.infer<typeof AdjustmentRequest>;

export type AdjustmentMethod = "deterministic" | "llm";

/** reduce_theory is the only action that needs the language model. */
export function methodOf(change: AdjustmentChange): AdjustmentMethod {
  return change.action === "reduce_theory" ? "llm" : "deterministic";
}

export interface AdjustmentLimits {
  ratePerHourPerUser: number;
  ratePerDayPerUser: number;
  ratePerHourPerIp: number;
  /** Concurrent active adjustment jobs per lesson. */
  maxActivePerLesson: number;
  /** Concurrent active adjustment jobs per user. */
  maxActivePerUser: number;
  job: { maxAttempts: number; deadlineMinutes: number };
  llm: {
    enabled: boolean;
    budgetPerLesson: number;
    job: { maxCalls: number; maxTokens: number; maxCostMicros: number };
  };
}

/** TEST VALUE: development defaults (D-19), not tuned for production. */
export const DEV_DEFAULT_ADJUSTMENT_LIMITS: AdjustmentLimits = {
  ratePerHourPerUser: 30, // TEST VALUE
  ratePerDayPerUser: 150, // TEST VALUE
  ratePerHourPerIp: 60, // TEST VALUE
  maxActivePerLesson: 1, // TEST VALUE
  maxActivePerUser: 2, // TEST VALUE
  job: { maxAttempts: 3, deadlineMinutes: 10 }, // TEST VALUE
  llm: {
    enabled: false,
    budgetPerLesson: 5, // TEST VALUE
    job: { maxCalls: 2, maxTokens: 20_000, maxCostMicros: 100_000 }, // TEST VALUE
  },
};
