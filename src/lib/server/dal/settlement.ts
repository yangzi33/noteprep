import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import {
  InvariantViolation,
  ManifestIncomplete,
  NotCompleteSuccess,
  NotFound,
  StaleOrCanceled,
} from "@/lib/domain/errors";
import { assertManifestComplete, assertManifestV2Complete, type ManifestEntry, type ManifestV2 } from "@/lib/domain/manifest";
import { DOCUMENT_KINDS, type DocumentKind } from "@/lib/package/schema";
import type { Db } from "../db";
import { finishLockedJob } from "./reservation";
import { inTransaction, type Tx } from "./tx";

export interface RevisionDraft {
  schemaVersion: number;
  /** Any JSON-serializable value; validated by the caller and stored as jsonb. */
  content: unknown;
  contentHash: string;
  validationReport: unknown;
  validationStatus: "verified" | "failed" | "unverified";
  templateVersion: string;
  validatorVersion: string;
  generationMeta?: unknown;
}

export interface CommitSuccessInput {
  jobId: string;
  /** The fencing token received when this attempt claimed the job. */
  fencingToken: bigint;
  attemptId: string;
  /** Pre-generated before upload so object paths can include it. */
  revisionId: string;
  revision: RevisionDraft;
  /** A legacy four-file list, or a version 2 manifest (the requested documents must then be named). */
  manifest: readonly ManifestEntry[] | ManifestV2;
  requestedDocuments?: readonly DocumentKind[];
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

const DOCUMENTS = new Set<string>(DOCUMENT_KINDS);

/** The documents a version 2 request asked for, read from the lesson's stored request; null when it is not well formed. */
function storedRequestedDocuments(inputSpec: unknown): DocumentKind[] | null {
  const documents = (inputSpec as { request?: { documents?: unknown } } | null)?.request?.documents;
  if (!Array.isArray(documents) || documents.length === 0 || !documents.every((d) => typeof d === "string" && DOCUMENTS.has(d))) return null;
  return documents as DocumentKind[];
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x));

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
        const lesson = await tx.$queryRaw<{ deleted_at: Date | null; request_version: number; input_spec: unknown }[]>`
          SELECT deleted_at, request_version, input_spec FROM lesson WHERE id = ${job.lesson_id}::uuid FOR SHARE`;
        const profile = await tx.$queryRaw<{ status: string }[]>`
          SELECT status::text AS status FROM profile WHERE id = ${job.owner_id}::uuid FOR SHARE`;
        if (!lesson[0] || lesson[0].deleted_at || profile[0]?.status !== "active") throw new StaleOrCanceled();

        if (input.revision.validationStatus !== "verified") {
          throw new NotCompleteSuccess("only fully verified output counts as a complete generation");
        }
        const scope = { ownerId: job.owner_id, lessonId: job.lesson_id, revisionId: input.revisionId, attemptId: input.attemptId };
        if (lesson[0].request_version === 2) {
          // The pack that was asked for is what the lesson stored at enqueue, never the worker's own statement of it.
          const requested = storedRequestedDocuments(lesson[0].input_spec);
          if (!requested) throw new InvariantViolation("the lesson has no stored document request");
          if (input.requestedDocuments && !sameSet(input.requestedDocuments, requested)) throw new ManifestIncomplete("the documents differ from the stored request");
          if (Array.isArray(input.manifest)) throw new ManifestIncomplete("a version 2 lesson needs a version 2 manifest");
          const manifest = input.manifest as ManifestV2;
          if (manifest.templateVersion !== input.revision.templateVersion) throw new ManifestIncomplete("the manifest and the revision use different templates");
          assertManifestV2Complete(manifest, scope, requested);
        } else if (Array.isArray(input.manifest)) assertManifestComplete(input.manifest as readonly ManifestEntry[], scope);
        else assertManifestV2Complete(input.manifest as ManifestV2, scope, input.requestedDocuments ?? []);

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
            content: input.revision.content as Prisma.InputJsonValue,
            contentHash: input.revision.contentHash,
            validationReport: input.revision.validationReport as Prisma.InputJsonValue,
            validationStatus: input.revision.validationStatus,
            templateVersion: input.revision.templateVersion,
            validatorVersion: input.revision.validatorVersion,
            generationMeta: input.revision.generationMeta as Prisma.InputJsonValue | undefined,
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
        await finishLockedJob(tx, input.jobId, input.outcome, input.errorCode);
      });
    },
  };
}
