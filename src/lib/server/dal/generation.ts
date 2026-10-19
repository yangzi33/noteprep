import "server-only";
import { z } from "zod";
import {
  AccountNotActive,
  AllowanceExhausted,
  IdempotencyConflict,
  InvariantViolation,
  NotFound,
  QueueBusy,
  RateLimited,
  TooManyActiveJobs,
} from "@/lib/domain/errors";
import { isEntitled, periodKeyFor } from "@/lib/domain/entitlement";
import {
  DEV_DEFAULT_LIMITS,
  GENERATE_OPERATION,
  GENERATE_REQUEST_VERSION,
  GenerateInput,
  IdempotencyKeySchema,
  type GenerationLimits,
} from "@/lib/domain/generation";
import { requestHash } from "@/lib/domain/hash";
import type { AuthedCtx } from "../auth/context";
import type { Db } from "../db";
import { toJobDto, type JobDto } from "./dto";
import { releaseReservation } from "./reservation";
import { inTransaction, type Tx } from "./tx";

export interface GenerationDeps {
  limits?: GenerationLimits;
  clock?: () => Date;
}

export interface CreateGenerationOptions {
  /** Salted hash of the client IP, computed by the caller; never the raw address. */
  ipHash?: string;
}

export interface CreateGenerationResult {
  job: JobDto;
  /** True when an earlier identical request (same idempotency key) already created this job. */
  replayed: boolean;
}

interface BucketRow {
  id: string;
  used: number;
  reserved: number;
  limit_count: number;
}

const uuid = z.uuid();

export function createGenerationDal(db: Db, deps: GenerationDeps = {}) {
  const limits = deps.limits ?? DEV_DEFAULT_LIMITS;
  const clock = deps.clock ?? (() => new Date());

  async function bumpRateLimit(tx: Tx, key: string, max: number) {
    const rows = await tx.$queryRaw<{ count: number }[]>`
      INSERT INTO rate_limit_window (key, window_start, count)
      VALUES (${key}, date_trunc('hour', now()), 1)
      ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_window.count + 1
      RETURNING count`;
    if ((rows[0]?.count ?? 0) > max) throw new RateLimited();
  }

  /** Locks the bucket this job will draw from. The source is fixed here and never re-chosen. */
  async function lockAllowanceBucket(tx: Tx, ownerId: string, now: Date): Promise<{ bucket: BucketRow; source: "trial" | "paid" }> {
    const subscription = await tx.subscription.findFirst({ where: { ownerId, status: "active" } });
    if (isEntitled(subscription, now) && subscription?.periodStart) {
      // Entitled accounts draw only from the paid period bucket (no fallback to the trial; decisions D-07).
      const rows = await tx.$queryRaw<BucketRow[]>`
        SELECT id, used, reserved, limit_count FROM usage_bucket
         WHERE subscription_id = ${subscription.id}::uuid
           AND period_key = ${periodKeyFor(subscription.periodStart)}::bigint
           AND starts_at <= ${now}::timestamptz AND ends_at > ${now}::timestamptz
           FOR UPDATE`;
      const bucket = rows[0];
      if (!bucket) throw new AllowanceExhausted(0, "paid"); // fail closed: sync has not created the period bucket
      return { bucket, source: "paid" };
    }
    const rows = await tx.$queryRaw<BucketRow[]>`
      SELECT id, used, reserved, limit_count FROM usage_bucket
       WHERE owner_id = ${ownerId}::uuid AND kind = 'trial'::bucket_kind FOR UPDATE`;
    const bucket = rows[0];
    if (!bucket) throw new InvariantViolation("account has no trial bucket; ensureAccount was not run");
    return { bucket, source: "trial" };
  }

  return {
    /**
     * Validate, then in ONE transaction: serialize on the account, apply the idempotency key, enforce
     * limits, reserve one allowance unit, create the lesson shell, the job and its reservation.
     * The model is never called here, and nothing is decremented later "after the fact".
     */
    async createGeneration(
      ctx: AuthedCtx,
      rawInput: unknown,
      rawIdempotencyKey: string,
      options: CreateGenerationOptions = {},
    ): Promise<CreateGenerationResult> {
      const input = GenerateInput.parse(rawInput);
      const key = IdempotencyKeySchema.parse(rawIdempotencyKey);
      const hash = requestHash(GENERATE_OPERATION, GENERATE_REQUEST_VERSION, input);
      const ownerId = ctx.userId;

      return inTransaction(db, async (tx) => {
        const now = clock();

        // 0. Per-account serialization point.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM profile WHERE id = ${ownerId}::uuid AND status = 'active'::profile_status FOR UPDATE`;
        if (locked.length === 0) throw new AccountNotActive();

        // 1. Idempotency: same key + same request -> original job; same key + different request -> conflict.
        const created = await tx.idempotencyKey.createMany({
          data: [{ ownerId, operation: GENERATE_OPERATION, key, requestHash: hash }],
          skipDuplicates: true,
        });
        if (created.count === 0) {
          const previous = await tx.idempotencyKey.findUnique({
            where: { ownerId_operation_key: { ownerId, operation: GENERATE_OPERATION, key } },
          });
          if (!previous) throw new InvariantViolation("idempotency key vanished");
          if (previous.requestHash !== hash) throw new IdempotencyConflict();
          const job = previous.resourceId
            ? await tx.generationJob.findFirst({ where: { id: previous.resourceId, ownerId } })
            : null;
          if (!job) throw new InvariantViolation("idempotency record has no job");
          return { job: toJobDto(job), replayed: true };
        }

        // 2. Durable limits. Counters committed with a job are never refunded when it later fails.
        await bumpRateLimit(tx, `gen:u:${ownerId}`, limits.rateLimitPerHourPerUser);
        if (options.ipHash) await bumpRateLimit(tx, `gen:ip:${options.ipHash}`, limits.rateLimitPerHourPerIp);
        const active = await tx.generationJob.count({ where: { ownerId, state: { in: ["queued", "running"] } } });
        if (active >= limits.maxActiveJobsPerUser) throw new TooManyActiveJobs();
        const backlog = await tx.generationJob.count({ where: { state: "queued" } });
        if (backlog >= limits.maxQueuedJobsGlobal) throw new QueueBusy();

        // 3. Reserve. The conditional UPDATE is the arbiter; the CHECK constraint is the backstop.
        const { bucket, source } = await lockAllowanceBucket(tx, ownerId, now);
        const reserved = await tx.$executeRaw`
          UPDATE usage_bucket SET reserved = reserved + 1
           WHERE id = ${bucket.id}::uuid AND used + reserved < limit_count`;
        if (reserved === 0) throw new AllowanceExhausted(bucket.reserved, source);

        // 4. Lesson shell, job, reservation, and the idempotency back-reference.
        const lesson = await tx.lesson.create({
          data: { ownerId, title: "Linear equations in one variable", inputSpec: input },
        });
        const job = await tx.generationJob.create({
          data: {
            ownerId,
            kind: "generate",
            lessonId: lesson.id,
            requestHash: hash,
            maxAttempts: limits.job.maxAttempts,
            deadlineAt: new Date(now.getTime() + limits.job.deadlineMinutes * 60_000),
            maxCalls: limits.job.maxCalls,
            maxTokens: BigInt(limits.job.maxTokens),
            maxCostMicros: BigInt(limits.job.maxCostMicros),
          },
        });
        await tx.usageReservation.create({ data: { ownerId, bucketId: bucket.id, jobId: job.id } });
        await tx.idempotencyKey.update({
          where: { ownerId_operation_key: { ownerId, operation: GENERATE_OPERATION, key } },
          data: { resourceType: "job", resourceId: job.id },
        });
        return { job: toJobDto(job), replayed: false };
      });
    },

    /** Owner-filtered read; a missing job and someone else's job are indistinguishable. */
    async getJob(ctx: AuthedCtx, jobId: string): Promise<JobDto> {
      if (!uuid.safeParse(jobId).success) throw new NotFound();
      const job = await db.generationJob.findFirst({ where: { id: jobId, ownerId: ctx.userId } });
      if (!job) throw new NotFound();
      return toJobDto(job);
    },

    /**
     * Queued job: canceled now and its reservation released. Running job: only flagged; the worker
     * (or the sweeper) finishes it, and a late success cannot be published. Terminal: unchanged.
     */
    async cancelJob(ctx: AuthedCtx, jobId: string): Promise<JobDto> {
      if (!uuid.safeParse(jobId).success) throw new NotFound();
      return inTransaction(db, async (tx) => {
        const rows = await tx.$queryRaw<{ id: string; state: string }[]>`
          SELECT id, state::text AS state FROM generation_job
           WHERE id = ${jobId}::uuid AND owner_id = ${ctx.userId}::uuid FOR UPDATE`;
        const row = rows[0];
        if (!row) throw new NotFound();
        if (row.state === "queued") {
          await releaseReservation(tx, jobId, "canceled");
          const job = await tx.generationJob.update({
            where: { id: jobId },
            data: { state: "canceled", errorCode: "canceled", finishedAt: new Date(), cancelRequestedAt: new Date() },
          });
          return toJobDto(job);
        }
        if (row.state === "running") {
          await tx.$executeRaw`
            UPDATE generation_job SET cancel_requested_at = COALESCE(cancel_requested_at, now()) WHERE id = ${jobId}::uuid`;
        }
        const job = await tx.generationJob.findUniqueOrThrow({ where: { id: jobId } });
        return toJobDto(job);
      });
    },
  };
}
