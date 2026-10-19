import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import {
  InvariantViolation,
  NotCompleteSuccess,
  NotFound,
  StaleOrCanceled,
} from "@/lib/domain/errors";
import { assertManifestComplete, type ManifestEntry } from "@/lib/domain/manifest";
import type { Db } from "../db";
import { releaseReservation } from "./reservation";
import { inTransaction, type Tx } from "./tx";

export interface RevisionDraft {
  schemaVersion: number;
  content: Prisma.InputJsonValue;
  contentHash: string;
  validationReport: Prisma.InputJsonValue;
  validationStatus: "verified" | "failed" | "unverified";
  templateVersion: string;
  validatorVersion: string;
  generationMeta?: Prisma.InputJsonValue;
}

export interface CommitSuccessInput {
  jobId: string;
  /** The fencing token received when this attempt claimed the job. */
  fencingToken: bigint;
  attemptId: string;
  /** Pre-generated before upload so object paths can include it. */
  revisionId: string;
  revision: RevisionDraft;
  manifest: readonly ManifestEntry[];
}

export interface FinishJobInput {
  jobId: string;
  fencingToken: bigint;
  outcome: "failed" | "canceled";
  errorCode: string;
}

interface JobLockRow {
  state: string;
  kind: string;
  owner_id: string;
  lesson_id: string;
  fencing_token: bigint;
  cancel_requested_at: Date | null;
  revision_id: string | null;
}

async function lockJob(tx: Tx, jobId: string): Promise<JobLockRow> {
  const rows = await tx.$queryRaw<JobLockRow[]>`
    SELECT state::text AS state, kind::text AS kind, owner_id, lesson_id, fencing_token, cancel_requested_at, revision_id
      FROM generation_job WHERE id = ${jobId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new NotFound();
  return row;
}

/** Worker-side settlement. Every write is gated by the job's current fencing token and state. */
export function createSettlementDal(db: Db) {
  return {
    /**
     * Publishes the complete revision, marks the job succeeded and consumes its reservation in ONE
     * transaction, at most once. A stale, failed, canceled or deleted-lesson attempt is rejected and
     * leaves everything unchanged. Calling again after success with the same revision is a no-op.
     */
    async commitSuccess(input: CommitSuccessInput): Promise<{ revisionId: string; replayed: boolean }> {
      return inTransaction(db, async (tx) => {
        const job = await lockJob(tx, input.jobId);

        if (job.state === "succeeded" && job.fencing_token === input.fencingToken && job.revision_id === input.revisionId) {
          return { revisionId: input.revisionId, replayed: true };
        }
        if (job.state !== "running" || job.fencing_token !== input.fencingToken || job.cancel_requested_at) {
          throw new StaleOrCanceled();
        }
        if (job.kind !== "generate") throw new InvariantViolation("commitSuccess is for generate jobs");

        // Block publication for deleted lessons and accounts being deleted; SHARE locks wait for an in-flight delete.
        const lesson = await tx.$queryRaw<{ deleted_at: Date | null }[]>`
          SELECT deleted_at FROM lesson WHERE id = ${job.lesson_id}::uuid FOR SHARE`;
        const profile = await tx.$queryRaw<{ status: string }[]>`
          SELECT status::text AS status FROM profile WHERE id = ${job.owner_id}::uuid FOR SHARE`;
        if (!lesson[0] || lesson[0].deleted_at || profile[0]?.status !== "active") throw new StaleOrCanceled();

        if (input.revision.validationStatus !== "verified") {
          throw new NotCompleteSuccess("only fully verified output counts as a complete generation");
        }
        assertManifestComplete(input.manifest, {
          ownerId: job.owner_id,
          lessonId: job.lesson_id,
          revisionId: input.revisionId,
          attemptId: input.attemptId,
        });

        const next = await tx.$queryRaw<{ n: number }[]>`
          SELECT COALESCE(MAX(number), 0) + 1 AS n FROM lesson_revision WHERE lesson_id = ${job.lesson_id}::uuid`;
        await tx.lessonRevision.create({
          data: {
            id: input.revisionId,
            lessonId: job.lesson_id,
            ownerId: job.owner_id,
            number: next[0]?.n ?? 1,
            status: "finalized",
            schemaVersion: input.revision.schemaVersion,
            content: input.revision.content,
            contentHash: input.revision.contentHash,
            validationReport: input.revision.validationReport,
            validationStatus: input.revision.validationStatus,
            templateVersion: input.revision.templateVersion,
            validatorVersion: input.revision.validatorVersion,
            generationMeta: input.revision.generationMeta,
            artifactManifest: input.manifest as unknown as Prisma.InputJsonValue,
            createdByJobId: input.jobId,
          },
        });
        await tx.lesson.update({ where: { id: job.lesson_id }, data: { currentRevisionId: input.revisionId } });

        const consumed = await tx.$queryRaw<{ bucket_id: string }[]>`
          UPDATE usage_reservation
             SET state = 'consumed'::reservation_state, settle_reason = 'succeeded', settled_at = now()
           WHERE job_id = ${input.jobId}::uuid AND state = 'reserved'::reservation_state
       RETURNING bucket_id`;
        const bucketId = consumed[0]?.bucket_id;
        if (!bucketId) throw new InvariantViolation("reservation was not in the reserved state"); // rolls back everything
        await tx.$executeRaw`UPDATE usage_bucket SET reserved = reserved - 1, used = used + 1 WHERE id = ${bucketId}::uuid`;

        await tx.generationJob.update({
          where: { id: input.jobId },
          data: {
            state: "succeeded",
            stage: null,
            revisionId: input.revisionId,
            leaseOwner: null,
            leaseExpiresAt: null,
            finishedAt: new Date(),
          },
        });
        return { revisionId: input.revisionId, replayed: false };
      });
    },

    /** Terminal failure or confirmed cancellation of the current attempt: release the reservation, finish the job. */
    async finishJob(input: FinishJobInput): Promise<void> {
      await inTransaction(db, async (tx) => {
        const job = await lockJob(tx, input.jobId);
        if (job.state !== "running" || job.fencing_token !== input.fencingToken) throw new StaleOrCanceled();
        await releaseReservation(tx, input.jobId, input.outcome === "canceled" ? "canceled" : `failed:${input.errorCode}`);
        await tx.generationJob.update({
          where: { id: input.jobId },
          data: {
            state: input.outcome,
            stage: null,
            errorCode: input.errorCode,
            leaseOwner: null,
            leaseExpiresAt: null,
            finishedAt: new Date(),
          },
        });
      });
    },
  };
}
