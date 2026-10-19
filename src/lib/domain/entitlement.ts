/** Local view of a verified Stripe subscription (docs/architecture.md section 9.2). */
export interface SubscriptionView {
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  latestInvoicePaid: boolean;
}

/**
 * New paid reservations are allowed only for an `active` subscription inside its paid period.
 * Every other status, including unknown and `trialing`, is denied. `cancel_at_period_end`
 * does not matter: access lasts until the period ends.
 */
export function isEntitled(sub: SubscriptionView | null, now: Date): boolean {
  if (!sub) return false;
  if (sub.status !== "active") return false;
  if (!sub.latestInvoicePaid || !sub.periodStart || !sub.periodEnd) return false;
  return sub.periodStart.getTime() <= now.getTime() && now.getTime() < sub.periodEnd.getTime();
}

/** Bucket period key: subscription item period start in epoch seconds (docs/decisions.md D-13). */
export function periodKeyFor(periodStart: Date): bigint {
  return BigInt(Math.floor(periodStart.getTime() / 1000));
}
