import "server-only";
import { isEntitled, periodKeyFor } from "@/lib/domain/entitlement";
import type { Tx } from "./tx";

export type AllowanceSource =
  | { kind: "trial" }
  | { kind: "paid"; subscriptionId: string; periodKey: bigint };

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
