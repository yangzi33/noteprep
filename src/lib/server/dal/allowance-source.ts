import "server-only";
import { utcDayNumber, utcDayWindow, lifetimeRemaining } from "@/lib/domain/daily-refresh";
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
  | { kind: "paid"; subscriptionId: string; periodKey: bigint }
  | { kind: "daily"; day: bigint };

export interface BucketRow {
  id: string;
  used: number;
  reserved: number;
  limit_count: number;
}

export type AllowanceKind = AllowanceSource["kind"];

/**
 * The single rule for which allowance a request draws from: an entitled account (active, paid, inside
 * its period) uses only its paid period bucket; everyone else uses the lifetime trial, or, while the beta
 * daily refresh is on (D-112), today's UTC-day bucket. No fallback from paid to trial or daily (D-07).
 * Reservation and the allowance display both use this. `now` is the DAL clock; nothing here reads the system time.
 */
export async function resolveAllowanceSource(tx: Tx, ownerId: string, now: Date, policy: AllowancePolicy): Promise<AllowanceSource> {
  const subscription = await tx.subscription.findFirst({ where: { ownerId, status: "active" } });
  if (subscription?.periodStart && isEntitled(subscription, now)) {
    return { kind: "paid", subscriptionId: subscription.id, periodKey: periodKeyFor(subscription.periodStart) };
  }
  return policy.dailyRefresh.enabled ? { kind: "daily", day: utcDayNumber(now) } : { kind: "trial" };
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
      : source.kind === "daily"
        ? await tx.$queryRaw<BucketRow[]>`
          SELECT id, used, reserved, limit_count FROM usage_bucket
           WHERE owner_id = ${ownerId}::uuid AND kind = 'daily'::bucket_kind AND period_key = ${source.day}::bigint
           ${forUpdate}`
        : await tx.$queryRaw<BucketRow[]>`
          SELECT id, used, reserved, limit_count FROM usage_bucket
           WHERE owner_id = ${ownerId}::uuid AND kind = 'trial'::bucket_kind
           ${forUpdate}`;
  return rows[0] ?? null;
}

/** Sum of used and reserved over all of the owner's daily buckets: what the beta perk has already spent against the lifetime total. */
async function dailySums(tx: Tx, ownerId: string): Promise<{ used: number; reserved: number }> {
  const rows = await tx.$queryRaw<{ used: number; reserved: number }[]>`
    SELECT COALESCE(SUM(used), 0)::int AS used, COALESCE(SUM(reserved), 0)::int AS reserved
      FROM usage_bucket WHERE owner_id = ${ownerId}::uuid AND kind = 'daily'::bucket_kind`;
  return rows[0] ?? { used: 0, reserved: 0 };
}

/**
 * Locks the bucket a new job will draw from. The source is fixed here and never re-chosen. Shared by generation and export.
 * Lock order: a daily source inserts its row (if missing) and then locks only that row; a trial source locks the trial row
 * and then reads the daily sums. A paid source never touches daily rows.
 */
export async function lockAllowanceBucket(tx: Tx, ownerId: string, now: Date, policy: AllowancePolicy): Promise<{ bucket: BucketRow; source: AllowanceKind }> {
  const source = await resolveAllowanceSource(tx, ownerId, now, policy);
  if (source.kind === "daily") {
    const { startsAt, endsAt } = utcDayWindow(source.day);
    await tx.$executeRaw`
      INSERT INTO usage_bucket (owner_id, kind, limit_count, period_key, starts_at, ends_at)
      VALUES (${ownerId}::uuid, 'daily'::bucket_kind, ${policy.dailyRefresh.limit}::int, ${source.day}::bigint, ${startsAt}::timestamptz, ${endsAt}::timestamptz)
      ON CONFLICT (owner_id, period_key) WHERE kind = 'daily'::bucket_kind DO NOTHING`;
  }
  const bucket = await selectBucket(tx, ownerId, source, now, true);
  if (!bucket) {
    if (source.kind === "paid") throw new AllowanceExhausted(0, "paid"); // fail closed: sync has not created the period bucket
    throw new InvariantViolation(source.kind === "daily" ? "daily bucket missing after insert" : "account has no trial bucket; ensureAccount was not run");
  }
  if (source.kind === "trial") {
    // The arbiter UPDATE in the callers only sees this row's counters; the beta perk's use counts toward the lifetime total.
    const daily = await dailySums(tx, ownerId);
    if (lifetimeRemaining({ limit: bucket.limit_count, used: bucket.used, reserved: bucket.reserved }, daily) === 0) {
      throw new AllowanceExhausted(bucket.reserved, "trial");
    }
  }
  return { bucket, source: source.kind };
}

/**
 * The same bucket without a lock, for display. Never inserts: a daily source with no row yet (but with a trial bucket, i.e. a set-up account) returns a SYNTHETIC bucket
 * (id "", used 0, reserved 0, policy limit) that exists only for display and must never be reserved against.
 * For the trial source the counters are the lifetime figures (trial plus all daily buckets). Null when no bucket applies.
 */
export async function readAllowanceBucket(tx: Tx, ownerId: string, now: Date, policy: AllowancePolicy): Promise<{ bucket: BucketRow; source: AllowanceKind; resetsAt: Date | null } | null> {
  const source = await resolveAllowanceSource(tx, ownerId, now, policy);
  const bucket = await selectBucket(tx, ownerId, source, now, false);
  if (source.kind === "daily") {
    // No profile yet (ensureAccount creates the trial bucket with it): show "account is being set up", not a synthetic view.
    const trial = await tx.$queryRaw<{ one: number }[]>`SELECT 1 AS one FROM usage_bucket WHERE owner_id = ${ownerId}::uuid AND kind = 'trial'::bucket_kind`;
    if (trial.length === 0) return null;
    return { bucket: bucket ?? { id: "", used: 0, reserved: 0, limit_count: policy.dailyRefresh.limit }, source: "daily", resetsAt: utcDayWindow(source.day).endsAt };
  }
  if (!bucket) return null;
  if (source.kind === "trial") {
    const daily = await dailySums(tx, ownerId);
    return { bucket: { ...bucket, used: bucket.used + daily.used, reserved: bucket.reserved + daily.reserved }, source: "trial", resetsAt: null };
  }
  return { bucket, source: "paid", resetsAt: null };
}
