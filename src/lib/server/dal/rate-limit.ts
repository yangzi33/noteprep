import "server-only";
import type { Tx } from "./tx";

/**
 * Counts one more event in the current hour window for `key` and returns the new count. The caller decides what is too
 * many; throwing afterwards rolls the increment back with the rest of its transaction.
 */
export async function incrementRateLimit(tx: Tx, key: string): Promise<number> {
  const rows = await tx.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limit_window (key, window_start, count)
    VALUES (${key}, date_trunc('hour', now()), 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_window.count + 1
    RETURNING count`;
  return rows[0]?.count ?? 0;
}
