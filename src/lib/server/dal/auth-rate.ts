import "server-only";
import { DEFAULT_LIMITS, type Limits } from "../limits";
import type { Db } from "../db";
import { incrementRateLimit } from "./rate-limit";
import { inTransaction } from "./tx";

export type AuthEmailKind = "reset" | "resend";

/**
 * Per-IP and global limit on the unauthenticated actions that can send email. `hit` counts one request in the current hour window
 * (key auth:<kind>:ip:<hash>) and says whether it is still within the limit. It never throws a limit error: the caller
 * answers a refused request exactly like an accepted one.
 */
export function createAuthRateDal(db: Db, limits: Pick<Limits, "authEmailPerIpPerHour" | "authEmailGlobalPerHour"> = DEFAULT_LIMITS) {
  return {
    async hit(ipHash: string, kind: AuthEmailKind): Promise<{ allowed: boolean; count: number }> {
      return inTransaction(db, async (tx) => {
        const globalKey = `auth:${kind}:global`;
        // 1. Already at the global cap: refuse without creating a per-IP row or touching the counter (bounds row growth).
        const rows = await tx.$queryRaw<{ count: number }[]>`
          SELECT count FROM rate_limit_window WHERE key = ${globalKey} AND window_start = date_trunc('hour', now())`;
        const current = rows[0]?.count ?? 0;
        if (current >= limits.authEmailGlobalPerHour) return { allowed: false, count: current };
        // 2. Per-IP: a refused request never counts toward the global cap, so one host cannot exhaust it for everyone.
        const count = await incrementRateLimit(tx, `auth:${kind}:ip:${ipHash}`);
        if (count > limits.authEmailPerIpPerHour) return { allowed: false, count };
        // 3. Only accepted requests count globally; a race past the cap refuses (and rolls nothing back: the row stays counted).
        const global = await incrementRateLimit(tx, globalKey);
        return { allowed: global <= limits.authEmailGlobalPerHour, count };
      });
    },
  };
}
