import "server-only";
import { DEFAULT_LIMITS, type Limits } from "../limits";
import type { Db } from "../db";
import { incrementRateLimit } from "./rate-limit";
import { inTransaction } from "./tx";

export type AuthEmailKind = "reset" | "resend";

/**
 * Per-IP limit on the unauthenticated actions that can send email. `hit` counts one request in the current hour window
 * (key auth:<kind>:ip:<hash>) and says whether it is still within the limit. It never throws a limit error: the caller
 * answers a refused request exactly like an accepted one.
 */
export function createAuthRateDal(db: Db, limits: Pick<Limits, "authEmailPerIpPerHour"> = DEFAULT_LIMITS) {
  return {
    async hit(ipHash: string, kind: AuthEmailKind): Promise<{ allowed: boolean; count: number }> {
      const count = await inTransaction(db, (tx) => incrementRateLimit(tx, `auth:${kind}:ip:${ipHash}`));
      return { allowed: count <= limits.authEmailPerIpPerHour, count };
    },
  };
}
