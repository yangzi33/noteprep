import "server-only";
import { z } from "zod";
import {
  AccountNotActive,
  AllowanceExhausted,
  domainErrorCode,
  DomainError,
  DraftExpired,
  ExportBusy,
  ExportConflict,
  ExportDisabled,
  ExportNotVerified,
  ExportRenderFailed,
  ExportUnavailable,
  IdempotencyConflict,
  InvalidRequest,
  InvariantViolation,
  NotFound,
  QueueBusy,
  RateLimited,
  TooManyActiveJobs,
} from "@/lib/domain/errors";
import {
  EXPORT_FAILURE_MEMO_THRESHOLD,
  EXPORT_FAILURE_MEMO_WINDOW_HOURS,
  confirmRequestPayload,
  isPageFormat,
  NON_RETRYABLE_EXPORT_FAILURES,
  PAGE_FORMAT,
  prepareExport,
  type PageFormat,
  RenderError,
} from "@/lib/domain/export-spec";
import { requestHash } from "@/lib/domain/hash";
import { IdempotencyKeySchema } from "@/lib/domain/idempotency";
import type { LessonRequestV2 } from "@/lib/domain/lesson-request";
import type { CurriculumContext } from "@/lib/curriculum/context";
import { Prisma } from "@/generated/prisma/client";
import { packageContentHash } from "@/lib/package/adjust";
import { validatePackage } from "@/lib/package/validate";
import type { AuthedCtx } from "../auth/context";
import type { Db } from "../db";
import { DEV_DEFAULT_LIMITS, type GenerationLimits } from "@/lib/domain/generation";
import { DEFAULT_LIMITS, type Limits } from "../limits";
import { lockAllowanceBucket } from "./allowance-source";
import { cancelOwnedJob } from "./cancel";
import { stateOf, summaryOf } from "./drafts";
import type { ConfirmExportResult, ExportStatusDto, JobDto } from "./dto";
import { incrementRateLimit } from "./rate-limit";
import { hasSqlState, inTransaction, type Tx } from "./tx";

// BILLING MODULE. confirmExport reserves one allowance unit in the same transaction that creates the snapshot, the lesson
// shell, the export job, the export row and the reservation. It may import reservation and settlement code; drafts.ts must
// never import it (tests/unit/drafts-isolation.test.ts).
//
// LOCK ORDER (docs/superpowers/plans/2026-10-24-s4-export-billing-spec.md): profile -> draft -> draft_version -> generation_job
// -> export -> lesson -> reservation -> usage_bucket; rate_limit_window rows are leaf locks. Before the confirm transaction, a separate
// short transaction increments the attempt counter (exp:try:u:) holding nothing else. confirmExport holds profile X, then
// rate_limit_window, then the allowance bucket X, and only INSERTS rows after that. It never takes a lock on a generation_job,
// export or lesson row (every lookup below is a plain read), so no path holding the profile lock can wait on a job lock.

export const EXPORT_CONFIRM_OPERATION = "export.confirm";
const EXPORT_CONFIRM_VERSION = 1;

export interface ExportDeps {
  /** EXPORT_ENABLED. Off: confirmExport refuses with EXPORT_DISABLED before touching anything. */
  enabled?: boolean;
  limits?: Limits;
  /** Queue backlog and job defaults shared with generation. */
  generationLimits?: GenerationLimits;
  clock?: () => Date;
}

export interface ConfirmExportInput {
  draftId: string;
  versionId: string;
  /** The version revision and content hash the confirmation page was rendered from: the tutor pays for exactly that. */
  expectedRev: number;
  expectedContentHash: string;
  /** Export option (not draft content). Absent means letter; anything outside the allowlist is refused before anything is reserved. */
  pageFormat?: string;
}

const uuid = z.uuid();
/** Errors of the pre-transaction phase that a REPLAY of an earlier identical request may outlive (the draft expired, was purged or changed). */
const DEFERRABLE = new Set(["NOT_FOUND", "DRAFT_EXPIRED", "EXPORT_CONFLICT", "EXPORT_NOT_VERIFIED", "EXPORT_RENDER_FAILED"]);

interface Prepared {
  pkg: ReturnType<typeof stateOf>["pkg"];
  questionMeta: unknown;
  changeSummary: unknown;
  version: { id: string; rev: number; contentHash: string };
  report: ReturnType<typeof validatePackage>;
  prepared: ReturnType<typeof prepareExport>;
}

export function createExportDal(db: Db, deps: ExportDeps = {}) {
  const enabled = deps.enabled ?? false;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const genLimits = deps.generationLimits ?? DEV_DEFAULT_LIMITS;
  const clock = deps.clock ?? (() => new Date());

  /**
   * Everything expensive and read-only, BEFORE the transaction: ids, the draft and version (owner filtered), the staleness
   * check against what the tutor saw, verification, rendering and hashing. Nothing here locks a row.
   */
  async function prepare(ownerId: string, input: ConfirmExportInput, pageFormat: PageFormat): Promise<Prepared> {
    const draft = await db.draft.findFirst({ where: { id: input.draftId, ownerId } });
    if (!draft) throw new NotFound();
    const version = await db.draftVersion.findFirst({ where: { id: input.versionId, draftId: draft.id, ownerId } });
    if (!version) throw new NotFound();
    if (draft.status !== "active" || draft.expiresAt.getTime() <= clock().getTime()) throw new DraftExpired();
    if (version.rev !== input.expectedRev || version.contentHash !== input.expectedContentHash) throw new ExportConflict();
    const state = stateOf(version, draft); // throws InvariantViolation when the stored content does not match its hash
    // The snapshot stores the PARSED package, so that is what must carry the hash the tutor saw.
    if (packageContentHash(state.pkg) !== version.contentHash) throw new InvariantViolation("the parsed draft content does not match its hash");
    const report = validatePackage(state.pkg);
    if (report.overall !== "verified") throw new ExportNotVerified();
    let prepared: ReturnType<typeof prepareExport>;
    try {
      prepared = prepareExport(state.pkg, pageFormat);
    } catch (error) {
      if (error instanceof RenderError) throw new ExportRenderFailed(error.code);
      throw error;
    }
    return {
      pkg: state.pkg,
      questionMeta: version.questionMeta,
      changeSummary: summaryOf(version.questionMeta, version.changes),
      version: { id: version.id, rev: version.rev, contentHash: version.contentHash },
      report,
      prepared,
    };
  }

  async function backfill(tx: Tx, ownerId: string, key: string, exportId: string) {
    await tx.idempotencyKey.update({
      where: { ownerId_operation_key: { ownerId, operation: EXPORT_CONFIRM_OPERATION, key } },
      data: { resourceType: "export", resourceId: exportId },
    });
  }

  async function confirmTx(
    ownerId: string,
    input: ConfirmExportInput,
    key: string,
    hash: string,
    prep: Prepared | { deferred: DomainError },
  ): Promise<ConfirmExportResult> {
    return inTransaction(db, async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${limits.draftLockTimeoutMs}ms`}, true)`;

      // 1. Per-account serialization point (the same lock createGeneration and createDraft take). First, held to commit.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM profile WHERE id = ${ownerId}::uuid AND status = 'active'::profile_status FOR UPDATE`;
      if (locked.length === 0) throw new AccountNotActive();

      // 2. Idempotency, BEFORE any draft check: the same key and request answers again with the current resource, even if
      // the draft has since changed, expired or been purged; the same key with another request conflicts.
      const created = await tx.idempotencyKey.createMany({
        data: [{ ownerId, operation: EXPORT_CONFIRM_OPERATION, key, requestHash: hash }],
        skipDuplicates: true,
      });
      if (created.count === 0) {
        const previous = await tx.idempotencyKey.findUnique({
          where: { ownerId_operation_key: { ownerId, operation: EXPORT_CONFIRM_OPERATION, key } },
        });
        if (!previous) throw new InvariantViolation("idempotency key vanished");
        if (previous.requestHash !== hash) throw new IdempotencyConflict();
        const existing = previous.resourceId ? await tx.export.findFirst({ where: { id: previous.resourceId, ownerId } }) : null;
        if (!existing) throw new InvariantViolation("idempotency record has no export");
        return { outcome: "replayed", exportId: existing.id, jobId: existing.jobId, lessonId: existing.lessonId };
      }
      if ("deferred" in prep) throw prep.deferred; // a new key and the pre-transaction phase refused: roll the key back

      // 3. Re-check what the tutor saw, with the DATABASE clock, without locking the draft or its version.
      const rows = await tx.$queryRaw<{ live: boolean; rev: number; content_hash: string }[]>`
        SELECT (d.status = 'active'::draft_status AND d.expires_at > now()) AS live, v.rev, v.content_hash
          FROM draft d JOIN draft_version v ON v.draft_id = d.id AND v.owner_id = d.owner_id
         WHERE d.id = ${input.draftId}::uuid AND d.owner_id = ${ownerId}::uuid AND v.id = ${input.versionId}::uuid`;
      const current = rows[0];
      if (!current) throw new NotFound();
      if (!current.live) throw new DraftExpired();
      if (current.rev !== input.expectedRev || current.content_hash !== input.expectedContentHash) throw new ExportConflict();

      const { prepared, pkg, report } = prep;

      // 4. Reuse or join WITHOUT locking any job row (C2). The lesson must not be deleted: a retired export no longer
      // matches, and a lesson that is still alive may be reused (deleteLesson locks job -> export -> lesson and commits atomically, so
      // this plain read sees either all of the deletion or none of it).
      // unless it is doomed (cancel requested, or past its deadline and not yet swept): then the tutor must wait.
      const live = await tx.$queryRaw<{ id: string; state: string; job_id: string; lesson_id: string; cancel: boolean; past: boolean }[]>`
        SELECT e.id, e.state, e.job_id, e.lesson_id, (j.cancel_requested_at IS NOT NULL) AS cancel, (j.deadline_at <= now()) AS past
          FROM export e JOIN generation_job j ON j.id = e.job_id
           JOIN lesson l ON l.id = e.lesson_id AND l.deleted_at IS NULL
         WHERE e.owner_id = ${ownerId}::uuid AND e.export_key = ${prepared.exportKey} AND e.state IN ('pending', 'succeeded')`;
      const found = live[0];
      if (found) {
        if (found.state === "pending" && (found.cancel || found.past)) throw new ExportBusy();
        await backfill(tx, ownerId, key, found.id);
        return { outcome: found.state === "succeeded" ? "reused" : "joined", exportId: found.id, jobId: found.job_id, lessonId: found.lesson_id };
      }

      // 5. Failure memo: the same export kept failing for reasons a retry cannot fix.
      const memo = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM export
         WHERE owner_id = ${ownerId}::uuid AND export_key = ${prepared.exportKey} AND state = 'failed'
           AND failure_code = ANY(${[...NON_RETRYABLE_EXPORT_FAILURES]}::text[])
           AND settled_at > now() - make_interval(hours => ${EXPORT_FAILURE_MEMO_WINDOW_HOURS}::int)`;
      if ((memo[0]?.n ?? 0) >= EXPORT_FAILURE_MEMO_THRESHOLD) throw new ExportUnavailable();

      // 6. Limits, only on the create path. A refusal rolls everything back, counters included.
      if ((await incrementRateLimit(tx, `exp:u:${ownerId}`)) > limits.exportsPerUserPerHour) throw new RateLimited();
      const active = await tx.generationJob.count({ where: { ownerId, kind: "export", state: { in: ["queued", "running"] } } });
      if (active >= limits.exportConcurrencyPerUser) throw new TooManyActiveJobs();
      const backlog = await tx.generationJob.count({ where: { state: "queued" } });
      if (backlog >= Math.min(genLimits.maxQueuedJobsGlobal, limits.exportMaxQueuedGlobal)) throw new QueueBusy();

      // 7. Reserve. Same bucket resolution and lock as createGeneration; the conditional UPDATE is the arbiter.
      const { bucket, source } = await lockAllowanceBucket(tx, ownerId, clock());
      const reserved = await tx.$executeRaw`
        UPDATE usage_bucket SET reserved = reserved + 1
         WHERE id = ${bucket.id}::uuid AND used + reserved < limit_count`;
      if (reserved === 0) throw new AllowanceExhausted(bucket.reserved, source);

      // 8. Inserts: snapshot, lesson shell, job, export, reservation, then the idempotency back-reference.
      const request = pkg.request as unknown as LessonRequestV2;
      const context = pkg.context as unknown as CurriculumContext;
      const dbNow = (await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0]!.now;
      const snapshot = await tx.exportSnapshot.create({
        data: {
          ownerId,
          draftId: input.draftId,
          draftVersionId: input.versionId,
          draftVersionRev: input.expectedRev,
          content: pkg as unknown as Prisma.InputJsonValue,
          packageHash: input.expectedContentHash,
          questionMeta: prep.questionMeta as Prisma.InputJsonValue,
          changeSummary: prep.changeSummary as unknown as Prisma.InputJsonValue,
          spec: prepared.spec as unknown as Prisma.InputJsonValue,
          texSha256: prepared.texShas as unknown as Prisma.InputJsonValue,
          exportKey: prepared.exportKey,
          contentKey: prepared.contentKey,
          validationReport: report as unknown as Prisma.InputJsonValue,
          validatorVersion: report.validatorVersion,
        },
      });
      const lesson = await tx.lesson.create({
        data: {
          ownerId,
          title: context.topic.title,
          inputSpec: { requestVersion: 2, request, context } as unknown as Prisma.InputJsonValue,
          requestVersion: 2,
          curriculumVersionId: context.curriculum.version.id,
          topicId: context.topic.id,
          objectiveIds: context.objectives.map((o) => o.id),
        },
      });
      const job = await tx.generationJob.create({
        data: {
          ownerId,
          kind: "export",
          lessonId: lesson.id,
          requestHash: prepared.exportKey,
          maxAttempts: limits.exportMaxAttempts,
          deadlineAt: new Date(dbNow.getTime() + limits.exportDeadlineMinutes * 60_000),
          maxCalls: 0,
          maxTokens: 0n,
          maxCostMicros: 0n,
        },
      });
      const exportRow = await tx.export.create({
        data: { ownerId, snapshotId: snapshot.id, exportKey: prepared.exportKey, lessonId: lesson.id, jobId: job.id },
      });
      await tx.usageReservation.create({ data: { ownerId, bucketId: bucket.id, jobId: job.id } });
      await backfill(tx, ownerId, key, exportRow.id);
      return { outcome: "created", exportId: exportRow.id, jobId: job.id, lessonId: lesson.id };
    });
  }

  return {
    /**
     * The tutor confirmed an export of exactly the version they saw. Reserves one allowance unit (never consumes it: only
     * commitExport does) and queues the job, or joins/reuses an equivalent export for free. See the module comment for
     * the lock order, and the spec for the order of steps.
     */
    async confirmExport(ctx: AuthedCtx, input: ConfirmExportInput, rawKey: string): Promise<ConfirmExportResult> {
      if (!enabled) throw new ExportDisabled();
      const ownerId = ctx.userId;
      if (!uuid.safeParse(input.draftId).success || !uuid.safeParse(input.versionId).success) throw new NotFound();
      const key = IdempotencyKeySchema.safeParse(rawKey);
      if (!key.success) throw new InvalidRequest("invalid idempotency key");
      if (!Number.isInteger(input.expectedRev) || input.expectedRev < 1) throw new InvalidRequest("expectedRev must be a positive integer");
      if (typeof input.expectedContentHash !== "string" || input.expectedContentHash.length === 0 || input.expectedContentHash.length > 200) {
        throw new InvalidRequest("expectedContentHash is required");
      }
      const pageFormat = input.pageFormat ?? PAGE_FORMAT;
      if (!isPageFormat(pageFormat)) throw new InvalidRequest("unsupported page format");
      // The hash is of what the client SENT, so a replay compares like with like whatever the server has since learned.
      const hash = requestHash(EXPORT_CONFIRM_OPERATION, EXPORT_CONFIRM_VERSION, confirmRequestPayload({ ...input, pageFormat }));

      // Attempt limit (M-5), BEFORE the CPU-heavy prepare. Only a NEW key counts: a replay (double click, retry) is never
      // refused. The increment runs in its own short transaction that holds no profile lock (rate_limit_window is a leaf
      // lock taken alone), so it stays committed whether the confirm later succeeds or is refused.
      const recorded = await db.idempotencyKey.findUnique({
        where: { ownerId_operation_key: { ownerId, operation: EXPORT_CONFIRM_OPERATION, key: key.data } },
        select: { requestHash: true },
      });
      // A recorded key reused with DIFFERENT input is the idempotency conflict, answered here before prepare (it would
      // otherwise cost a full validate and render per call, uncounted). Only a true replay (same hash) skips the counter.
      if (recorded && recorded.requestHash !== hash) throw new IdempotencyConflict();
      if (!recorded) {
        const attempts = await inTransaction(db, (tx) => incrementRateLimit(tx, `exp:try:u:${ownerId}`));
        if (attempts > limits.exportConfirmAttemptsPerUserPerHour) throw new RateLimited();
      }

      let prep: Prepared | { deferred: DomainError };
      try {
        prep = await prepare(ownerId, input, pageFormat);
      } catch (error) {
        const code = domainErrorCode(error);
        if (!code || !DEFERRABLE.has(code)) throw error;
        // A replay of an earlier identical request must still answer (idempotency is checked before the draft): continue
        // into the transaction only when this key was already recorded; there a NEW key re-throws this error.
        const previous = await db.idempotencyKey.findUnique({
          where: { ownerId_operation_key: { ownerId, operation: EXPORT_CONFIRM_OPERATION, key: key.data } },
          select: { requestHash: true },
        });
        if (!previous) throw error;
        prep = { deferred: error as DomainError };
      }

      try {
        return await confirmTx(ownerId, input, key.data, hash, prep);
      } catch (error) {
        if (hasSqlState(error, "55P03")) throw new ExportBusy();
        // Serialized by the profile lock, so a unique violation anywhere in the create path means an invariant broke.
        if (hasSqlState(error, "23505")) throw new InvariantViolation("unique violation while confirming an export");
        throw error;
      }
    },

    /** Owner-filtered; a missing export and someone else's export are indistinguishable. */
    async getExportStatus(ctx: AuthedCtx, exportId: string): Promise<ExportStatusDto> {
      if (!uuid.safeParse(exportId).success) throw new NotFound();
      const row = await db.export.findFirst({
        where: { id: exportId, ownerId: ctx.userId },
        include: { job: { include: { reservation: { select: { state: true } } } } },
      });
      if (!row) throw new NotFound();
      const { job } = row;
      return {
        exportId: row.id,
        state: row.state as ExportStatusDto["state"],
        job: {
          state: job.state,
          stage: job.stage,
          attempt: job.attempt,
          maxAttempts: job.maxAttempts,
          cancelRequested: job.cancelRequestedAt !== null,
          errorCode: job.errorCode,
        },
        reservation: { state: job.reservation?.state ?? null },
        lessonId: row.lessonId,
        revisionId: row.revisionId,
        deadlineAt: job.deadlineAt,
      };
    },

    /**
     * Cancels the export's job like generation.cancelJob (queued: canceled and released now; running: only flagged; terminal:
     * unchanged). NOT gated by EXPORT_ENABLED: the rollback procedure must be able to stop exports with the flag off.
     * Owner-filtered; a foreign export is NOT_FOUND. The lock order is job -> export -> reservation -> bucket (cancelOwnedJob).
     */
    async cancelExport(ctx: AuthedCtx, exportId: string): Promise<JobDto> {
      if (!uuid.safeParse(exportId).success) throw new NotFound();
      // A plain read: job_id never changes, and the job row is locked by cancelOwnedJob, which re-checks the owner.
      const row = await db.export.findFirst({ where: { id: exportId, ownerId: ctx.userId }, select: { jobId: true } });
      if (!row) throw new NotFound();
      return cancelOwnedJob(db, ctx.userId, row.jobId);
    },

    /** The export of one of the caller's jobs, or null (no such job, someone else's job, or not an export). Owner-filtered. */
    async findExportIdByJob(ctx: AuthedCtx, jobId: string): Promise<string | null> {
      if (!uuid.safeParse(jobId).success) return null;
      const row = await db.export.findFirst({ where: { jobId, ownerId: ctx.userId }, select: { id: true } });
      return row?.id ?? null;
    },
  };
}

export type ExportDal = ReturnType<typeof createExportDal>;
