import "server-only";
import { utcDayNumber } from "@/lib/domain/daily-refresh";
import type { AllowancePolicy } from "./allowance-source";
import type { Tx } from "./tx";

/**
 * Operator top-up (D-113): every daily bucket of the current UTC day gets limit_count = used + reserved + limit, so each
 * free account can export `limit` more times right now. One statement; it touches ONLY kind = 'daily' rows of today, never
 * edits used or reserved (the drift views stay clean), and skips rows whose limit would not change. `now` is the DAL clock.
 */
export async function refreshTodayForAll(tx: Tx, now: Date, policy: AllowancePolicy): Promise<{ accounts: number }> {
  const day = utcDayNumber(now);
  const limit = policy.dailyRefresh.limit;
  const accounts = await tx.$executeRaw`
    UPDATE usage_bucket
       SET limit_count = used + reserved + ${limit}::int
     WHERE kind = 'daily'::bucket_kind
       AND period_key = ${day}::bigint
       AND limit_count <> used + reserved + ${limit}::int`;
  return { accounts };
}
