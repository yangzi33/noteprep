import "server-only";
import type { AuthedCtx } from "../auth/context";
import type { Db } from "../db";
import { readAllowanceBucket } from "./allowance-source";

export interface AllowanceView {
  source: "trial" | "paid";
  limit: number;
  used: number;
  /** Held by jobs still in flight; returns to `remaining` if they fail. */
  pending: number;
  /** limit - used - pending: what a new request can still reserve. */
  remaining: number;
}

export interface HistoryItem {
  jobId: string;
  lessonId: string;
  title: string;
  state: "queued" | "running" | "succeeded" | "failed" | "canceled";
  stage: "generating" | "validating" | "compiling" | "storing" | null;
  errorCode: string | null;
  revisionId: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface HistoryDeps {
  clock?: () => Date;
}

/** Read-only, owner-filtered views for the account's history and remaining allowance. */
export function createHistoryDal(db: Db, deps: HistoryDeps = {}) {
  const clock = deps.clock ?? (() => new Date());
  return {
    async getAllowance(ctx: AuthedCtx): Promise<AllowanceView | null> {
      return db.$transaction(async (tx) => {
        const found = await readAllowanceBucket(tx, ctx.userId, clock());
        if (!found) return null;
        const { bucket, source } = found;
        return {
          source,
          limit: bucket.limit_count,
          used: bucket.used,
          pending: bucket.reserved,
          remaining: bucket.limit_count - bucket.used - bucket.reserved,
        };
      });
    },

    async listJobs(ctx: AuthedCtx, limit = 50): Promise<HistoryItem[]> {
      const jobs = await db.generationJob.findMany({
        where: { ownerId: ctx.userId, kind: "generate", lesson: { deletedAt: null } },
        orderBy: { createdAt: "desc" },
        take: Math.min(Math.max(limit, 1), 200),
        include: { lesson: { select: { title: true } } },
      });
      return jobs.map((job) => ({
        jobId: job.id,
        lessonId: job.lessonId,
        title: job.lesson.title,
        state: job.state,
        stage: job.stage,
        errorCode: job.errorCode,
        revisionId: job.revisionId,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
      }));
    },
  };
}
