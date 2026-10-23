import "server-only";
import { z } from "zod";
import { AccountNotActive, LessonBusy, NotFound } from "@/lib/domain/errors";
import type { AuthedCtx } from "../auth/context";
import type { Db } from "../db";
import { inTransaction } from "./tx";

// LOCK ORDER: generation_job -> export -> lesson -> profile (FOR SHARE), the same order commitExport uses (job X, export X, lesson S,
// profile S). The owner's first design was profile first, but that deadlocks: a delete holding profile S and waiting on a job lock
// held by a commit, while that commit waits for profile S queued behind a confirmExport that waits for profile X (Postgres queues a
// share request behind a waiting exclusive one; seen in the S4 deadlock loop with delete added, deadlock counter 0 -> 2). The rule
// of the S4 spec holds: nothing that holds a profile lock may wait on a job, export or lesson lock. Serialization with confirmExport
// is not needed for correctness: confirm either reads the export before this commit (reused, the lesson was still alive) or after
// it (the export is retired and the identity is free). This module never touches usage_reservation or usage_bucket: no refund.

const uuid = z.uuid();

export interface LessonDeleteResult {
  lessonId: string;
  /** How many succeeded exports of the lesson became 'retired' (their identity is free again; nothing was refunded). */
  retiredExports: number;
}

/** Soft-deletes one of the caller's lessons. No UI uses it yet (Phase 3). Owner comes from the verified context. */
export function createLessonDeleteDal(db: Db) {
  return {
    async deleteLesson(ctx: AuthedCtx, lessonId: string): Promise<LessonDeleteResult> {
      if (!uuid.safeParse(lessonId).success) throw new NotFound();
      const ownerId = ctx.userId;
      return inTransaction(db, async (tx) => {
        // Plain owner-filtered existence check first, so a foreign or missing lesson is NotFound without locking anything of it.
        const exists = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM lesson WHERE id = ${lessonId}::uuid AND owner_id = ${ownerId}::uuid AND deleted_at IS NULL`;
        if (exists.length === 0) throw new NotFound();

        // Jobs first (id order; nothing else is held), then read the exports with fresh statements: a commit that held a job lock has finished by now.
        const jobs = await tx.$queryRaw<{ id: string; state: string }[]>`
          SELECT id, state::text AS state FROM generation_job
           WHERE lesson_id = ${lessonId}::uuid AND owner_id = ${ownerId}::uuid ORDER BY id FOR UPDATE`;
        if (jobs.some((j) => j.state === "queued" || j.state === "running")) throw new LessonBusy();

        const exports = await tx.$queryRaw<{ id: string; state: string }[]>`
          SELECT id, state FROM export
           WHERE lesson_id = ${lessonId}::uuid AND owner_id = ${ownerId}::uuid ORDER BY id FOR UPDATE`;
        if (exports.some((e) => e.state === "pending")) throw new LessonBusy(); // cannot happen with terminal jobs; fail closed

        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM lesson WHERE id = ${lessonId}::uuid AND owner_id = ${ownerId}::uuid AND deleted_at IS NULL FOR UPDATE`;
        if (locked.length === 0) throw new NotFound();

        // Last, like commitExport: the account must still be active (an account being deleted blocks all publication).
        const profile = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM profile WHERE id = ${ownerId}::uuid AND status = 'active'::profile_status FOR SHARE`;
        if (profile.length === 0) throw new AccountNotActive();

        // The guard allows succeeded -> retired only once the lesson is deleted, so the lesson is updated before the exports.
        await tx.$executeRaw`UPDATE lesson SET deleted_at = now() WHERE id = ${lessonId}::uuid AND owner_id = ${ownerId}::uuid`;
        const retired = await tx.$executeRaw`
          UPDATE export SET state = 'retired'
           WHERE lesson_id = ${lessonId}::uuid AND owner_id = ${ownerId}::uuid AND state = 'succeeded'`;
        return { lessonId, retiredExports: retired };
      });
    },
  };
}

export type LessonDeleteDal = ReturnType<typeof createLessonDeleteDal>;
