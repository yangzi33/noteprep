import "server-only";
import { DEV_DEFAULT_LIMITS } from "@/lib/domain/generation";
import type { AuthedCtx } from "../auth/context";
import type { Db } from "../db";
import { inTransaction } from "./tx";

export function createAccountDal(db: Db, trialLimit: number = DEV_DEFAULT_LIMITS.trialLimit) {
  return {
    /** The profile's status, or null when the account has not been created yet. */
    async getStatus(ctx: AuthedCtx): Promise<"active" | "deleting" | null> {
      const profile = await db.profile.findUnique({ where: { id: ctx.userId }, select: { status: true } });
      return profile?.status ?? null;
    },

    /** The saved display time zone, or null for Auto (and for an unknown account). */
    async getTimeZone(ctx: AuthedCtx): Promise<string | null> {
      const profile = await db.profile.findUnique({ where: { id: ctx.userId }, select: { timezone: true } });
      return profile?.timezone ?? null;
    },

    /** Saves the caller's own display time zone; null resets to Auto. The caller validates the name. */
    async setTimeZone(ctx: AuthedCtx, timeZone: string | null): Promise<void> {
      await db.profile.updateMany({ where: { id: ctx.userId, status: "active" }, data: { timezone: timeZone } });
    },

    /**
     * Idempotent: creates the profile and its single lifetime trial bucket. Duplicate signup
     * callbacks, retries and races all converge on one profile and one bucket (partial unique index).
     */
    async ensureAccount(ctx: AuthedCtx): Promise<void> {
      await inTransaction(db, async (tx) => {
        await tx.$executeRaw`INSERT INTO profile (id) VALUES (${ctx.userId}::uuid) ON CONFLICT (id) DO NOTHING`;
        await tx.$executeRaw`
          INSERT INTO usage_bucket (owner_id, kind, limit_count)
          VALUES (${ctx.userId}::uuid, 'trial'::bucket_kind, ${trialLimit})
          ON CONFLICT (owner_id) WHERE kind = 'trial'::bucket_kind DO NOTHING`;
      });
    },
  };
}
