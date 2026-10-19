import { DEV_DEFAULT_LIMITS } from "@/lib/domain/generation";

/** Relaxed rate limits so one test file can create several jobs; the job budgets stay the real defaults. */
export const DEFAULT_LIMITS_FOR_TESTS = { ...DEV_DEFAULT_LIMITS, maxActiveJobsPerUser: 100, maxQueuedJobsGlobal: 100_000, rateLimitPerHourPerUser: 1000 };
