import { z } from "zod";
import { MAX_EXERCISES } from "@/lib/package/adjust";

// Every threshold of the draft workflow lives here (D-108), parsed from the environment with defaults.
// The defaults are PLACEHOLDERS the owner tunes once there is cost and abuse data; none is a product rule.
// This module does not read process.env itself: src/lib/server/env.ts and worker/env.ts pass their source in.

/** Largest content the database accepts (a CHECK in the draft_tables migration; it measures the jsonb text, which is a little longer than compact JSON). */
export const DB_CONTENT_BACKSTOP_BYTES = 4_000_000;
/**
 * The most MAX_DRAFT_BYTES may be set to. The app measures compact JSON bytes, the CHECK measures jsonb::text (which adds a
 * space after every ":" and ","), so the two are not the same number. Keeping the ceiling well under the backstop means a
 * draft the app accepts can never trip the CHECK; if it ever does, createDraft maps that to PACKAGE_BUILD_FAILED.
 */
export const MAX_DRAFT_BYTES_CEILING = 3_000_000;

const int = (name: string, fallback: number, min: number, max: number) => ({ env: name, schema: z.coerce.number().int().min(min).max(max).default(fallback) });

// [limits key]: { env variable, schema with default }
const SHAPE = {
  // Creation: counted per hour in rate_limit_window (keys draft:u:, draft:ip:, draft:global)
  draftCreatesPerUserPerHour: int("DRAFT_CREATES_PER_USER_PER_HOUR", 30, 1, 10_000),
  draftCreatesPerIpPerHour: int("DRAFT_CREATES_PER_IP_PER_HOUR", 60, 1, 100_000),
  draftCreatesGlobalPerHour: int("DRAFT_CREATES_GLOBAL_PER_HOUR", 5_000, 1, 10_000_000),
  maxActiveDraftsPerUser: int("MAX_ACTIVE_DRAFTS_PER_USER", 20, 1, 1_000),
  // Versions and adjustment (S2, S3): versions per user per hour (key ver:u:), versions per draft, candidates (cand:u:, per slot), undo, exercise counts
  versionCreatesPerUserPerHour: int("VERSION_CREATES_PER_USER_PER_HOUR", 60, 1, 10_000),
  maxVersionsPerDraft: int("MAX_VERSIONS_PER_DRAFT", 5, 1, 50),
  candidatesPerUserPerHour: int("CANDIDATES_PER_USER_PER_HOUR", 120, 1, 100_000),
  candidatesPerSlot: int("CANDIDATES_PER_SLOT", 5, 1, 100),
  undoDepth: int("UNDO_DEPTH", 10, 1, 100),
  minExercises: int("MIN_EXERCISES", 3, 1, MAX_EXERCISES),
  maxExercises: int("MAX_EXERCISES_PER_DRAFT", MAX_EXERCISES, 1, MAX_EXERCISES),
  maxDraftBytes: int("MAX_DRAFT_BYTES", 1_000_000, 10_000, MAX_DRAFT_BYTES_CEILING),
  // Export (S4, S5): unused for now
  exportsPerUserPerHour: int("EXPORTS_PER_USER_PER_HOUR", 10, 1, 10_000),
  exportConcurrencyPerUser: int("EXPORT_CONCURRENCY_PER_USER", 1, 1, 20),
  exportDeadlineMinutes: int("EXPORT_DEADLINE_MINUTES", 10, 1, 120),
  // Expiry and purge
  draftTtlDays: int("DRAFT_TTL_DAYS", 14, 1, 365),
  // Hard cap on sliding expiry: expires_at never goes beyond created_at + this many days (placeholder)
  draftMaxLifetimeDays: int("DRAFT_MAX_LIFETIME_DAYS", 60, 1, 730),
  // How long a draft operation waits for a row lock before DRAFT_BUSY (SET LOCAL lock_timeout; placeholder)
  draftLockTimeoutMs: int("DRAFT_LOCK_TIMEOUT_MS", 5_000, 50, 60_000),
  purgeGraceDays: int("DRAFT_PURGE_GRACE_DAYS", 7, 0, 365),
  purgeBatchSize: int("DRAFT_PURGE_BATCH_SIZE", 100, 1, 10_000),
  // Reserved for a future language-model item source (0 = no budget; nothing reads these yet)
  llmMaxCallsPerDraft: int("LLM_MAX_CALLS_PER_DRAFT", 0, 0, 1_000),
  llmMaxTokensPerDraft: int("LLM_MAX_TOKENS_PER_DRAFT", 0, 0, 10_000_000),
  llmMaxCostMicrosPerDraft: int("LLM_MAX_COST_MICROS_PER_DRAFT", 0, 0, 1_000_000_000),
} as const;

const LimitsSchema = z
  .object(Object.fromEntries(Object.entries(SHAPE).map(([key, { schema }]) => [key, schema])) as { [K in keyof typeof SHAPE]: (typeof SHAPE)[K]["schema"] })
  .refine((l) => l.draftMaxLifetimeDays >= l.draftTtlDays, { message: "DRAFT_MAX_LIFETIME_DAYS must not be below DRAFT_TTL_DAYS", path: ["draftMaxLifetimeDays"] })
  .refine((l) => l.minExercises <= l.maxExercises, { message: "MIN_EXERCISES must not exceed MAX_EXERCISES_PER_DRAFT", path: ["minExercises"] });

export type Limits = z.infer<typeof LimitsSchema>;

/** Every default in one place; the only way to get a limit that was not configured. */
export const DEFAULT_LIMITS: Limits = LimitsSchema.parse({});

/** Reads the limits from an environment-like object. Empty values count as unset; an invalid value throws. */
export function parseLimits(source: Record<string, string | undefined> = {}): Limits {
  const input: Record<string, string> = {};
  for (const [key, { env }] of Object.entries(SHAPE)) {
    const value = source[env];
    if (value !== undefined && value.trim() !== "") input[key] = value;
  }
  return LimitsSchema.parse(input);
}

/** The environment variable that sets a limit (for documentation and error messages). */
export const LIMIT_ENV_NAMES: Record<keyof Limits, string> = Object.fromEntries(Object.entries(SHAPE).map(([k, v]) => [k, v.env])) as Record<keyof Limits, string>;
