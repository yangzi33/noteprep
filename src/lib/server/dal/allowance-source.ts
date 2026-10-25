import "server-only";
import { AllowanceExhausted, InvariantViolation } from "@/lib/domain/errors";
import { isEntitled, periodKeyFor } from "@/lib/domain/entitlement";
import { Prisma } from "@/generated/prisma/client";
import type { Tx } from "./tx";

/** Allowance settings the web DAL carries to the allowance rule. The daily refresh is a temporary beta perk (D-112), off by default. */
export interface AllowancePolicy {
  dailyRefresh: { enabled: boolean; limit: number };
}

export const DEFAULT_ALLOWANCE_POLICY: AllowancePolicy = { dailyRefresh: { enabled: false, limit: 5 } };

export type AllowanceSource =
  | { kind: "trial" }
  | { kind: "paid"; subscriptionId: string; periodKey: bigint };

export interface BucketRow {
  id: string;
  used: number;
  reserved: number;
  limit_count: number;
}

/**
 * The single rule for which allowance a request draws from: an entitled account (active, paid, inside
 * its period) uses only its paid period bucket; everyone else uses the lifetime trial. No fallback
 * from paid to trial (docs/decisions.md D-07). Reservation and the allowance display both use this.
 */
export async function resolveAllowanceSource(tx: Tx, ownerId: string, now: Date): Promise<AllowanceSource> {
  const subscription = await tx.subscription.findFirst({ where: { ownerId, status: "active" } });
  if (subscription?.periodStart && isEntitled(subscription, now)) {
    return { kind: "paid", subscriptionId: subscription.id, periodKey: periodKeyFor(subscription.periodStart) };
  }
  return { kind: "trial" };
}

/**
 * The bucket row a source draws from, inside the paid bucket's validity window (starts_at <= now < ends_at), or null.
 * The lock path and the display path both come through here, so what the page shows is what a reservation would use.
 */
async function selectBucket(tx: Tx, ownerId: string, source: AllowanceSource, now: Date, lock: boolean): Promise<BucketRow | null> {
  const forUpdate = lock ? Prisma.sql`FOR UPDATE` : Prisma.empty;
  const rows =
    source.kind === "paid"
      ? await tx.$queryRaw<BucketRow[]>`
          SELECT id, used, reserved, limit_count FROM usage_bucket
           WHERE subscription_id = ${source.subscriptionId}::uuid
             AND period_key = ${source.periodKey}::bigint
             AND starts_at <= ${now}::timestamptz AND ends_at > ${now}::timestamptz
           ${forUpdate}`
      : await tx.$queryRaw<BucketRow[]>`
          SELECT id, used, reserved, limit_count FROM usage_bucket
           WHERE owner_id = ${ownerId}::uuid AND kind = 'trial'::bucket_kind
           ${forUpdate}`;
  return rows[0] ?? null;
}

/** Locks the bucket a new job will draw from. The source is fixed here and never re-chosen. Shared by generation and export. */
export async function lockAllowanceBucket(tx: Tx, ownerId: string, now: Date): Promise<{ bucket: BucketRow; source: "trial" | "paid" }> {
  const source = await resolveAllowanceSource(tx, ownerId, now);
  const bucket = await selectBucket(tx, ownerId, source, now, true);
  if (!bucket) {
    if (source.kind === "paid") throw new AllowanceExhausted(0, "paid"); // fail closed: sync has not created the period bucket
    throw new InvariantViolation("account has no trial bucket; ensureAccount was not run");
  }
  return { bucket, source: source.kind };
}

/** The same bucket without a lock, for display: null when the account has none in its validity window. */
export async function readAllowanceBucket(tx: Tx, ownerId: string, now: Date): Promise<{ bucket: BucketRow; source: "trial" | "paid" } | null> {
  const source = await resolveAllowanceSource(tx, ownerId, now);
  const bucket = await selectBucket(tx, ownerId, source, now, false);
  return bucket ? { bucket, source: source.kind } : null;
}
