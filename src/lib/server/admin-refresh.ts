import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "./db";
import { refreshTodayForAll } from "./dal/allowance-admin";
import type { AllowancePolicy } from "./dal/allowance-source";
import { incrementRateLimit } from "./dal/rate-limit";
import { inTransaction } from "./dal/tx";

// Decision logic of POST /api/admin/refresh-allowance (D-113). The route is a thin wrapper around runAdminRefresh.
// Nothing here logs, returns or throws the token.

const BEARER = /^Bearer (.+)$/i;

/** The credential of an `Authorization: Bearer <token>` header, or null for anything else. */
export function bearerToken(header: string | null | undefined): string | null {
  const match = header ? BEARER.exec(header) : null;
  return match?.[1] ? match[1] : null;
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time comparison: both sides are hashed to 32 bytes first, so length and prefix never short-circuit. */
export function tokenMatches(supplied: string | null | undefined, expected: string): boolean {
  const a = digest(supplied ?? "");
  const b = digest(expected);
  return timingSafeEqual(a, b) && supplied != null && supplied.length > 0;
}

export type AdminRefreshOutcome =
  | { status: 200; body: { accounts: number } }
  | { status: 401; body: { error: "unauthorized" } }
  | { status: 409; body: { error: "refresh_disabled" } }
  | { status: 429; body: { error: "rate_limited" } };

export interface AdminRefreshInput {
  /** The raw Authorization header. */
  authorization: string | null;
  expectedToken: string;
  /** Opaque id for the one log line; never derived from the request. */
  requestId: string;
}

export interface AdminRefreshDeps {
  db: Db;
  policy: AllowancePolicy;
  clock: () => Date;
  log?: (line: { event: "admin_refresh"; requestId: string; accounts: number }) => void;
}

class RateLimited extends Error {}

/** Order: token (401), perk on (409), one call per UTC minute (429), then the single UPDATE. Only 200 changes data. */
export async function runAdminRefresh(input: AdminRefreshInput, deps: AdminRefreshDeps): Promise<AdminRefreshOutcome> {
  if (!tokenMatches(bearerToken(input.authorization), input.expectedToken)) return { status: 401, body: { error: "unauthorized" } };
  if (!deps.policy.dailyRefresh.enabled) return { status: 409, body: { error: "refresh_disabled" } };
  const now = deps.clock();
  const minute = Math.floor(now.getTime() / 60_000);
  try {
    // The guard row and the UPDATE share one transaction: a 429 rolls back (nothing was written) and concurrent callers
    // serialize on the same rate_limit_window row, so across instances exactly one call per minute gets through.
    const { accounts } = await inTransaction(deps.db, async (tx) => {
      if ((await incrementRateLimit(tx, `admin:refresh:${minute}`)) > 1) throw new RateLimited();
      return refreshTodayForAll(tx, now, deps.policy);
    });
    (deps.log ?? ((line) => console.info(JSON.stringify(line))))({ event: "admin_refresh", requestId: input.requestId, accounts });
    return { status: 200, body: { accounts } };
  } catch (error) {
    if (error instanceof RateLimited) return { status: 429, body: { error: "rate_limited" } };
    throw error;
  }
}
