import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AccountNotActive, DraftExpired, DraftLimit, DraftRateLimited, IdempotencyConflict, InvariantViolation, NotFound } from "@/lib/domain/errors";
import { requestHash } from "@/lib/domain/hash";
import { IdempotencyKeySchema } from "@/lib/domain/idempotency";
import { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { PackageBuildError } from "@/lib/content/errors";
import type { CurriculumContext } from "@/lib/curriculum/context";
import type { Prisma } from "@/generated/prisma/client";
import { packageContentHash } from "@/lib/package/adjust";
import { buildPackageWithMeta } from "@/lib/package/build";
import { PackageSchema, type DocumentKind, type LessonPackage } from "@/lib/package/schema";
import { validatePackage } from "@/lib/package/validate";
import type { AuthedCtx } from "../auth/context";
import type { Db } from "../db";
import { DEFAULT_LIMITS, type Limits } from "../limits";
import type { DraftCreated, DraftSelection, DraftSummaryDto, DraftViewDto } from "./dto";
import { incrementRateLimit } from "./rate-limit";
import { resolveRequestContext, type ResolveContext } from "./request-context";
import { inTransaction, isCheckViolation, type Tx } from "./tx";

// Drafts are FREE: nothing in this module may touch the allowance, reservations or jobs. A test pins that by reading
// this file's imports (tests/unit/drafts-isolation.test.ts); keep it that way.

export const DRAFT_OPERATION = "draft";
const DRAFT_REQUEST_VERSION = 2;
const MS_PER_DAY = 86_400_000;

export interface DraftDeps {
  /** Resolves the curriculum context (provided by createWebDal). Without it drafts cannot be created. */
  resolveContext?: ResolveContext;
  limits?: Limits;
  clock?: () => Date;
  /** Test seam: the version seed. Production uses random bytes, so two drafts of one request differ. */
  newSeed?: () => string;
}

export interface CreateDraftOptions {
  /** Salted hash of the client IP, computed by the caller; never the raw address. */
  ipHash?: string;
}

export interface CreateDraftResult {
  draft: DraftCreated;
  /** True when an earlier identical request (same idempotency key) already created this draft. */
  replayed: boolean;
}

const uuid = z.uuid();

/** Version content is stored WITHOUT `request` and `context`: the draft row holds them once, immutably. */
type StoredContent = Omit<LessonPackage, "request" | "context">;

function split(pkg: LessonPackage): StoredContent {
  const rest: Partial<LessonPackage> = { ...pkg };
  delete rest.request;
  delete rest.context;
  return rest as StoredContent;
}

function selectionOf(request: LessonRequestV2, context: CurriculumContext): DraftSelection {
  return {
    v: request.curriculum.versionId,
    ...(context.level ? { level: context.level.id } : {}),
    course: context.course.id,
    unit: context.unit.id,
    topic: request.curriculum.topicId,
  };
}

/** Next unused exercise number: replacements (S2) continue the numbering, ids are never reused. */
function nextExerciseSeq(pkg: LessonPackage): number {
  let max = 0;
  for (const section of pkg.sections) {
    if (section.kind !== "exercises") continue;
    for (const block of section.blocks) {
      if (block.type !== "question") continue;
      const m = /^ex-(\d+)$/.exec(block.questionId);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

export function createDraftsDal(db: Db, deps: DraftDeps = {}) {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const clock = deps.clock ?? (() => new Date());
  const newSeed = deps.newSeed ?? (() => `draft-${randomBytes(16).toString("hex")}`);

  async function bump(tx: Tx, key: string, max: number) {
    if ((await incrementRateLimit(tx, key)) > max) throw new DraftRateLimited();
  }

  /** The transaction of createDraft. Lock order is part of the safety contract: see the comments inside. */
  async function createDraftTx(ownerId: string, request: LessonRequestV2, key: string, hash: string, options: CreateDraftOptions): Promise<CreateDraftResult> {
    return inTransaction(db, async (tx) => {
      const now = clock();

      // 0. Per-account serialization point (the same lock the generation flow takes). SAFETY CONTRACT: this lock comes
      // first and is held to commit. It is what makes "count active drafts, then insert" (the MAX_ACTIVE_DRAFTS cap
      // below) safe against concurrent creates by one account; do not move the count before it, or take other locks
      // before it. The shared draft:global counter row is locked from the first increment until commit, after this lock.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM profile WHERE id = ${ownerId}::uuid AND status = 'active'::profile_status FOR UPDATE`;
      if (locked.length === 0) throw new AccountNotActive();

      // 1. Idempotency: same key + same request -> the original draft; same key + different request -> conflict.
      const created = await tx.idempotencyKey.createMany({ data: [{ ownerId, operation: DRAFT_OPERATION, key, requestHash: hash }], skipDuplicates: true });
      if (created.count === 0) {
        const previous = await tx.idempotencyKey.findUnique({ where: { ownerId_operation_key: { ownerId, operation: DRAFT_OPERATION, key } } });
        if (!previous) throw new InvariantViolation("idempotency key vanished");
        if (previous.requestHash !== hash) throw new IdempotencyConflict();
        const existing = previous.resourceId ? await tx.draft.findFirst({ where: { id: previous.resourceId, ownerId }, select: { id: true, activeVersionId: true, expiresAt: true } }) : null;
        if (!existing?.activeVersionId) throw new DraftExpired(); // the draft was purged after it expired
        return { draft: { draftId: existing.id, versionId: existing.activeVersionId, expiresAt: existing.expiresAt }, replayed: true };
      }

      // 2. The curriculum context (after the replay check, before anything is stored; a refused topic costs nothing).
      const context = await resolveRequestContext(deps.resolveContext, request, tx);

      // 3. Durable limits. Counters committed with a draft are not refunded when it is later deleted.
      await bump(tx, `draft:u:${ownerId}`, limits.draftCreatesPerUserPerHour);
      if (options.ipHash) await bump(tx, `draft:ip:${options.ipHash}`, limits.draftCreatesPerIpPerHour);
      await bump(tx, "draft:global", limits.draftCreatesGlobalPerHour);
      const active = await tx.draft.count({ where: { ownerId, status: "active", expiresAt: { gt: now } } });
      if (active >= limits.maxActiveDraftsPerUser) throw new DraftLimit();

      // 4. Build and verify. Only a fully verified package may be stored.
      const seed = newSeed();
      const { pkg, levels } = buildPackageWithMeta({ request, context, seed });
      const report = validatePackage(pkg);
      if (report.overall !== "verified") throw new PackageBuildError("the drafted package did not validate as verified");
      const content = split(pkg);
      if (Buffer.byteLength(JSON.stringify(content), "utf8") > limits.maxDraftBytes) throw new PackageBuildError("the drafted package exceeds the size limit");

      // 5. Store: the draft (request and context once), version 1, then the active pointer.
      const expiresAt = new Date(now.getTime() + limits.draftTtlDays * MS_PER_DAY);
      const draft = await tx.draft.create({
        data: {
          ownerId,
          request: request as unknown as Prisma.InputJsonValue,
          requestHash: hash,
          context: context as unknown as Prisma.InputJsonValue,
          versionCount: 1,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        },
      });
      const version = await tx.draftVersion.create({
        data: {
          draftId: draft.id,
          ownerId,
          ordinal: 1,
          seed,
          content: content as unknown as Prisma.InputJsonValue,
          contentHash: packageContentHash(pkg),
          questionMeta: Object.fromEntries(Object.entries(levels).map(([id, level]) => [id, { level, origin: "initial" }])),
          nextQuestionSeq: nextExerciseSeq(pkg),
          validatorVersion: report.validatorVersion,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.draft.update({ where: { id: draft.id }, data: { activeVersionId: version.id } });
      await tx.idempotencyKey.update({
        where: { ownerId_operation_key: { ownerId, operation: DRAFT_OPERATION, key } },
        data: { resourceType: "draft", resourceId: draft.id },
      });
      return { draft: { draftId: draft.id, versionId: version.id, expiresAt }, replayed: false };
    });
  }

  return {
    /**
     * In ONE transaction: serialize on the account, apply the idempotency key, resolve the curriculum context, enforce
     * the creation limits, build and verify a package, and store the draft with its first version. Nothing is reserved,
     * charged or queued. A package that is not fully verified is never stored.
     */
    async createDraft(ctx: AuthedCtx, rawRequest: unknown, rawIdempotencyKey: string, options: CreateDraftOptions = {}): Promise<CreateDraftResult> {
      const request = LessonRequestV2.parse(rawRequest);
      const key = IdempotencyKeySchema.parse(rawIdempotencyKey);
      const hash = requestHash(DRAFT_OPERATION, DRAFT_REQUEST_VERSION, request);
      const ownerId = ctx.userId;

      try {
        return await createDraftTx(ownerId, request, key, hash, options);
      } catch (error) {
        // A size CHECK that fires is the last line of defence (the app limit is lower); it is a refusal, not a server error.
        if (isCheckViolation(error)) throw new PackageBuildError("the drafted package exceeds a storage limit");
        throw error;
      }
    },

    /**
     * Owner-filtered read of one version (the active one by default). Missing, someone else's, or a version of another
     * draft is NotFound; a draft past its expiry is DraftExpired. The package is rebuilt from the stored parts and checked
     * against the stored content hash, so what is shown is exactly what was verified.
     */
    async getDraftView(ctx: AuthedCtx, draftId: string, versionId?: string): Promise<DraftViewDto> {
      if (!uuid.safeParse(draftId).success || (versionId !== undefined && !uuid.safeParse(versionId).success)) throw new NotFound();
      const draft = await db.draft.findFirst({ where: { id: draftId, ownerId: ctx.userId } });
      if (!draft) throw new NotFound();
      if (draft.status === "expired" || draft.expiresAt.getTime() <= clock().getTime()) throw new DraftExpired();
      const wanted = versionId ?? draft.activeVersionId;
      if (!wanted) throw new NotFound();
      const version = await db.draftVersion.findFirst({ where: { id: wanted, draftId: draft.id, ownerId: ctx.userId } });
      if (!version) throw new NotFound();

      const full = { ...(version.content as object), request: draft.request, context: draft.context };
      if (packageContentHash(full as LessonPackage) !== version.contentHash) throw new InvariantViolation("stored draft content does not match its hash");
      const parsed = PackageSchema.safeParse(full);
      if (!parsed.success) throw new InvariantViolation("stored draft content is not a package");
      const pkg = parsed.data;
      const context = draft.context as unknown as CurriculumContext;
      const request = draft.request as unknown as LessonRequestV2;
      return {
        draftId: draft.id,
        versionId: version.id,
        ordinal: version.ordinal,
        rev: version.rev,
        contentHash: version.contentHash,
        expiresAt: draft.expiresAt,
        documents: pkg.documents.map((d) => d.id),
        title: context.topic.title,
        selection: selectionOf(request, context),
        package: pkg,
      };
    },

    /** The selection a draft was made from, for a "start again" link. Works for an expired draft (until it is purged); null otherwise. */
    async getDraftSelection(ctx: AuthedCtx, draftId: string): Promise<DraftSelection | null> {
      if (!uuid.safeParse(draftId).success) return null;
      const draft = await db.draft.findFirst({ where: { id: draftId, ownerId: ctx.userId }, select: { request: true, context: true } });
      if (!draft) return null;
      return selectionOf(draft.request as unknown as LessonRequestV2, draft.context as unknown as CurriculumContext);
    },

    /** The caller's active, unexpired drafts, newest first. Summaries only: no content, no context blob. */
    async listDrafts(ctx: AuthedCtx, limit = 50): Promise<DraftSummaryDto[]> {
      const rows = await db.$queryRaw<{ id: string; title: string; documents: DocumentKind[]; created_at: Date; updated_at: Date; expires_at: Date }[]>`
        SELECT id, context->'topic'->>'title' AS title, ARRAY(SELECT jsonb_array_elements_text(request->'documents')) AS documents,
               created_at, updated_at, expires_at
          FROM draft
         WHERE owner_id = ${ctx.userId}::uuid AND status = 'active'::draft_status AND expires_at > ${clock()}::timestamptz
         ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(limit, 200))}`;
      return rows.map((r) => ({ draftId: r.id, title: r.title, documents: r.documents, createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at }));
    },
  };
}

export type DraftsDal = ReturnType<typeof createDraftsDal>;

export interface PurgeReport {
  /** Active drafts past their expiry that were marked expired. */
  expired: number;
  /** Expired drafts past the grace period that were deleted (their versions cascade). */
  deleted: number;
}

/**
 * Worker side: marks drafts past `expires_at` as expired, then deletes the ones past `expires_at + grace` (written as `expires_at <= now() - grace` so the index on expires_at can be used), in batches
 * of `limit` with SKIP LOCKED so concurrent sweepers never block or double-process. The web role cannot delete.
 */
export function createDraftsPurgeDal(db: Db, options: { graceDays?: number } = {}) {
  const graceDays = options.graceDays ?? DEFAULT_LIMITS.purgeGraceDays;
  return {
    async purgeExpired(limit: number = DEFAULT_LIMITS.purgeBatchSize): Promise<PurgeReport> {
      const batch = Math.max(1, Math.floor(limit));
      const expired = await db.$queryRaw<{ id: string }[]>`
        UPDATE draft SET status = 'expired'::draft_status, updated_at = now()
         WHERE id IN (SELECT id FROM draft WHERE status = 'active'::draft_status AND expires_at <= now()
                       ORDER BY expires_at LIMIT ${batch} FOR UPDATE SKIP LOCKED)
        RETURNING id`;
      const deleted = await db.$queryRaw<{ id: string }[]>`
        DELETE FROM draft
         WHERE id IN (SELECT id FROM draft WHERE status = 'expired'::draft_status AND expires_at <= now() - make_interval(days => ${graceDays}::int)
                       ORDER BY expires_at LIMIT ${batch} FOR UPDATE SKIP LOCKED)
        RETURNING id`;
      return { expired: expired.length, deleted: deleted.length };
    },
  };
}

export type DraftsPurgeDal = ReturnType<typeof createDraftsPurgeDal>;
