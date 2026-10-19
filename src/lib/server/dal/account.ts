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
