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
import {
  DEV_DEFAULT_LIMITS,
  GENERATE_OPERATION,
  GENERATE_REQUEST_VERSION,
  IdempotencyKeySchema,
  type GenerationLimits,
} from "@/lib/domain/generation";
import { requestHash } from "@/lib/domain/hash";
import { parseLessonRequest } from "@/lib/domain/lesson-request";
import type { Prisma } from "@/generated/prisma/client";
import type { AuthedCtx } from "../auth/context";
import { lockAllowanceBucket } from "./allowance-source";
import type { Db } from "../db";
import { cancelOwnedJob } from "./cancel";
import { toJobDto, type JobDto } from "./dto";
import { incrementRateLimit } from "./rate-limit";
import { resolveRequestContext, type ResolveContext } from "./request-context";
import { inTransaction, type Tx } from "./tx";

export type { ResolveContext };

export interface GenerationDeps {
  /** Resolves a v2 request's curriculum context (provided by createWebDal). Without it v2 requests are refused. */
  resolveContext?: ResolveContext;
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

const uuid = z.uuid();

export function createGenerationDal(db: Db, deps: GenerationDeps = {}) {
  const limits = deps.limits ?? DEV_DEFAULT_LIMITS;
  const clock = deps.clock ?? (() => new Date());

  async function bumpRateLimit(tx: Tx, key: string, max: number) {
    if ((await incrementRateLimit(tx, key)) > max) throw new RateLimited();
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
      const parsed = parseLessonRequest(rawInput);
      const key = IdempotencyKeySchema.parse(rawIdempotencyKey);
      const hash = requestHash(GENERATE_OPERATION, parsed.version === 1 ? GENERATE_REQUEST_VERSION : 2, parsed.input);
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

        // 1b. What the lesson is made of. A v2 request resolves its curriculum context HERE, after the replay
        // check above (so retrying an old request still returns the original job even if the curriculum
        // version has since been superseded) and before anything is reserved (so a refused topic costs nothing).
        let lessonData: Omit<Prisma.LessonUncheckedCreateInput, "ownerId">;
        if (parsed.version === 1) {
          lessonData = { title: "Linear equations in one variable", inputSpec: parsed.input };
        } else {
          const request = parsed.input;
          const context = await resolveRequestContext(deps.resolveContext, request, tx);
          lessonData = {
            title: context.topic.title,
            inputSpec: { requestVersion: 2, request, context } as unknown as Prisma.InputJsonValue,
            requestVersion: 2,
            curriculumVersionId: context.curriculum.version.id,
            topicId: context.topic.id,
            objectiveIds: context.objectives.map((o) => o.id),
          };
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
        const lesson = await tx.lesson.create({ data: { ownerId, ...lessonData } });
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
      return cancelOwnedJob(db, ctx.userId, jobId);
    },
  };
}
