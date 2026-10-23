import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "../db";

export type Tx = Prisma.TransactionClient;

const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]); // serialization_failure, deadlock_detected

/** Serialization failures and deadlocks are safe to retry as a whole transaction. */
export function isRetryableDbError(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string }; cause?: unknown; message?: string } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code === "P2034") return true; // Prisma: write conflict / deadlock
  if (e.meta?.code && RETRYABLE_SQLSTATES.has(e.meta.code)) return true;
  if (e.code && RETRYABLE_SQLSTATES.has(e.code)) return true;
  if (e.cause && e.cause !== error) return isRetryableDbError(e.cause);
  return /could not serialize access|deadlock detected/i.test(e.message ?? "");
}

export interface TxOptions {
  maxAttempts?: number;
}

/** Runs `fn` in an interactive transaction, retrying the whole thing on retryable database errors. */
export async function inTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>, options: TxOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(fn, { maxWait: 5_000, timeout: 15_000 });
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableDbError(error)) throw error;
    }
  }
}

/**
 * True when some error in the chain carries SQLSTATE `state` (Prisma wraps the driver error: raw queries put it on `code` or
 * `meta.code`, models report e.g. P2039 with the original under meta.driverAdapterError.cause). With `message`, the error's
 * message must also contain that text.
 */
export function hasSqlState(error: unknown, state: string, message?: string): boolean {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return false;
    seen.add(value);
    const v = value as Record<string, unknown>;
    const code = v.originalCode ?? v.code;
    const text = typeof v.originalMessage === "string" ? v.originalMessage : typeof v.message === "string" ? v.message : "";
    if (code === state && (!message || text.includes(message))) return true;
    return Object.values(v).some((child) => walk(child, depth + 1)) || (value instanceof Error && walk(value.cause, depth + 1));
  };
  return walk(error, 0);
}

/** True when the error is a Postgres CHECK violation (SQLSTATE 23514); with `constraint`, only a violation of that constraint counts. */
export function isCheckViolation(error: unknown, constraint?: string): boolean {
  return hasSqlState(error, "23514", constraint ? `"${constraint}"` : undefined);
}
