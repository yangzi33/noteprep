import { z } from "zod";
import { IdempotencyKeySchema } from "./idempotency";

export const GENERATE_OPERATION = "generate";
export const GENERATE_REQUEST_VERSION = 1;

/** Only topics with validation coverage are accepted (docs/product.md section 2). */
export const SUPPORTED_TOPICS = ["linear_equations_one_variable"] as const;

export const GenerateInput = z.strictObject({
  topic: z.enum(SUPPORTED_TOPICS),
  level: z.string().trim().min(1).max(80),
  objectives: z.array(z.string().trim().min(1).max(200)).min(1).max(5),
  durationMinutes: z.number().int().min(15).max(180),
  difficulty: z.enum(["basic", "mixed", "challenge"]),
  questionCount: z.number().int().min(1).max(20),
  notes: z.string().trim().max(500).optional(),
});
export type GenerateInput = z.infer<typeof GenerateInput>;

export { IdempotencyKeySchema };

/**
 * Operational limits. These are DEVELOPMENT DEFAULTS, not tuned values: real thresholds
 * need cost data first (docs/decisions.md D-19). All are overridable by configuration.
 */
export interface GenerationLimits {
  maxActiveJobsPerUser: number;
  maxQueuedJobsGlobal: number;
  rateLimitPerHourPerUser: number;
  rateLimitPerHourPerIp: number;
  job: {
    maxAttempts: number;
    maxCalls: number;
    maxTokens: number;
    maxCostMicros: number;
    deadlineMinutes: number;
  };
  trialLimit: number;
}

export const DEV_DEFAULT_LIMITS: GenerationLimits = {
  maxActiveJobsPerUser: 2,
  maxQueuedJobsGlobal: 200,
  rateLimitPerHourPerUser: 10,
  rateLimitPerHourPerIp: 30,
  job: { maxAttempts: 3, maxCalls: 8, maxTokens: 60_000, maxCostMicros: 1_000_000, deadlineMinutes: 15 },
  trialLimit: 3, // fixed by product rules (CLAUDE.md section 5)
};
