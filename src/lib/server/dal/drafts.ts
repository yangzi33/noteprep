import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { AccountNotActive, CandidateLimit, CandidateRateLimited, CandidateStale, DraftBusy, DraftConflict, DraftExpired, InvalidRequest, DraftLimit, DraftRateLimited, IdempotencyConflict, InvariantViolation, NotFound, VersionLimit, VersionRateLimited } from "@/lib/domain/errors";
import { requestHash } from "@/lib/domain/hash";
import { IdempotencyKeySchema } from "@/lib/domain/idempotency";
import { LessonRequestV2 } from "@/lib/domain/lesson-request";
import { PackageBuildError } from "@/lib/content/errors";
import type { CurriculumContext } from "@/lib/curriculum/context";
import { Prisma } from "@/generated/prisma/client";
import { packageContentHash } from "@/lib/package/adjust";
import { buildPackageWithMeta } from "@/lib/package/build";
import {
  acceptReplacement,
  BUILDER_MIN_EXERCISES,
  changeSummary,
  drawReplacement,
  exerciseIds,
  questionSlots,
  removeQuestion as removeQuestionOp,
  undoLabel,
  undoLast,
  type DraftState,
  type HistoryEntry,
  type MetaMap,
  type OpsConfig,
  type ChangeSummary,
  type PendingCandidate,
  type StoredChanges,
} from "@/lib/package/draft-ops";
import { PackageSchema, type DocumentKind, type LessonPackage } from "@/lib/package/schema";
import { validatePackage } from "@/lib/package/validate";
import type { AuthedCtx } from "../auth/context";
import type { Db } from "../db";
import { DEFAULT_LIMITS, type Limits } from "../limits";
import type { DraftCreated, DraftMutationResult, DraftSelection, DraftSummaryDto, DraftVersionResult, DraftVersionSummary, DraftViewDto } from "./dto";
import { incrementRateLimit } from "./rate-limit";
import { resolveRequestContext, type ResolveContext } from "./request-context";
import { hasSqlState, inTransaction, isCheckViolation, type Tx } from "./tx";

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


const asMeta = (value: unknown): MetaMap => (value && typeof value === "object" ? (value as MetaMap) : {});
function asChanges(value: unknown): StoredChanges {
  const c = (value && typeof value === "object" ? value : {}) as Partial<StoredChanges>;
  return { replacedIds: c.replacedIds ?? [], removedIds: c.removedIds ?? [], modifiedIds: c.modifiedIds ?? [] };
}

/** The state of a version row (with its draft's request and context) for the pure operations; the stored hash must match. */
function stateOf(row: { content: unknown; contentHash: string; questionMeta: unknown; nextQuestionSeq: number; history: unknown; changes: unknown }, draft: { request: unknown; context: unknown }): DraftState {
  const full = { ...(row.content as object), request: draft.request, context: draft.context };
  if (packageContentHash(full as LessonPackage) !== row.contentHash) throw new InvariantViolation("stored draft content does not match its hash");
  const parsed = PackageSchema.safeParse(full);
  if (!parsed.success) throw new InvariantViolation("stored draft content is not a package");
  return { pkg: parsed.data, meta: asMeta(row.questionMeta), nextSeq: row.nextQuestionSeq, history: (Array.isArray(row.history) ? row.history : []) as HistoryEntry[], changes: asChanges(row.changes) };
}

/** Summary of a version from its stored meta and changes (no package content needed: meta entries of removed questions are deleted). */
function summaryOf(questionMeta: unknown, changes: unknown): ChangeSummary {
  const replacedIds = Object.entries(asMeta(questionMeta))
    .filter(([, m]) => m.origin === "replacement")
    .map(([id]) => id);
  return { replacedIds, removedIds: [...new Set(asChanges(changes).removedIds)], modifiedIds: [...replacedIds] };
}

const asCandidate = (value: unknown): PendingCandidate | null => (value && typeof value === "object" ? (value as PendingCandidate) : null);

export function createDraftsDal(db: Db, deps: DraftDeps = {}) {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const clock = deps.clock ?? (() => new Date());
  const newSeed = deps.newSeed ?? (() => `draft-${randomBytes(16).toString("hex")}`);

  async function bump(tx: Tx, key: string, max: number) {
    if ((await incrementRateLimit(tx, key)) > max) throw new DraftRateLimited();
  }

  /** Builds and verifies one package from the stored request and context. Only a fully verified, in-limit package is returned. */
  function buildVerified(request: LessonRequestV2, context: CurriculumContext, seed: string) {
    const { pkg, levels } = buildPackageWithMeta({ request, context, seed });
    const report = validatePackage(pkg);
    if (report.overall !== "verified") throw new PackageBuildError("the drafted package did not validate as verified");
    const content = split(pkg);
    if (Buffer.byteLength(JSON.stringify(content), "utf8") > limits.maxDraftBytes) throw new PackageBuildError("the drafted package exceeds the size limit");
    if (exerciseIds(pkg).length > limits.maxExercises) throw new PackageBuildError("the drafted package has more exercises than allowed");
    return { pkg, levels, report, content };
  }

  /** The expiry of a new draft. Later mutations slide it with `slideExpiry` (database clock, capped). */
  const initialExpiry = (now: Date) => new Date(now.getTime() + limits.draftTtlDays * MS_PER_DAY);

  /**
   * Sliding expiry as a SQL assignment, on the database clock (the same one the draft guard uses): now + TTL, never beyond
   * created_at + the lifetime cap, and never shorter than it already is (a touch does not shorten a draft whose cap was lowered).
   */
  const slideExpiry = () =>
    Prisma.sql`expires_at = GREATEST(expires_at, LEAST(now() + make_interval(days => ${limits.draftTtlDays}::int), created_at + make_interval(days => ${limits.draftMaxLifetimeDays}::int))), updated_at = now()`;

  /**
   * Every draft transaction: bounded lock waits (SET LOCAL lock_timeout -> DRAFT_BUSY, safe to retry) and, as a backstop, a
   * draft-guard refusal about expiry (SQLSTATE 55000) is reported as DRAFT_EXPIRED. Deadlocks and serialization failures are
   * retried by inTransaction.
   *
   * LOCK ORDER, the same for every write: profile (createDraft only) -> draft row -> counter rows (rate_limit_window; leaf
   * locks, nothing else is waited on while holding one) -> version row(s). No path locks a version row before its draft row.
   */
  async function draftTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await inTransaction(db, async (tx) => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${`${limits.draftLockTimeoutMs}ms`}, true)`;
        return fn(tx);
      });
    } catch (error) {
      if (hasSqlState(error, "55P03")) throw new DraftBusy();
      if (hasSqlState(error, "55000", "expired")) throw new DraftExpired();
      throw error;
    }
  }

  /** The transaction of createDraft. Lock order is part of the safety contract: see the comments inside. */
  async function createDraftTx(ownerId: string, request: LessonRequestV2, key: string, hash: string, options: CreateDraftOptions): Promise<CreateDraftResult> {
    return draftTx(async (tx) => {
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
      const { pkg, levels, report, content } = buildVerified(request, context, seed);

      // 5. Store: the draft (request and context once), version 1, then the active pointer.
      const expiresAt = initialExpiry(now);
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


  // --- question-level adjustment (S2) -----------------------------------------------------------------

  const opsConfig = (): OpsConfig => ({ minExercises: limits.minExercises, undoDepth: limits.undoDepth });

  interface Locked {
    draft: { request: unknown; context: unknown };
    version: { id: string; rev: number; seed: string; content: unknown; contentHash: string; questionMeta: unknown; nextQuestionSeq: number; history: unknown; changes: unknown; pendingCandidate: unknown };
    state: DraftState;
  }
  interface Outcome {
    state: DraftState;
    candidate: PendingCandidate | null;
  }

  /**
   * One adjustment: lock the version row (owner filtered, draft active and unexpired), compare the revision the caller saw,
   * run the pure operation and write the result with rev = rev + 1 (the table guard requires exactly +1). Nothing is
   * persisted unless the operation succeeded; a thrown error rolls the whole transaction back.
   */
  async function mutate(ctx: AuthedCtx, draftId: string, versionId: string, expectedRev: number, op: (locked: Locked, tx: Tx) => Promise<Outcome>): Promise<DraftMutationResult> {
    if (!uuid.safeParse(draftId).success || !uuid.safeParse(versionId).success) throw new NotFound();
    if (!Number.isInteger(expectedRev) || expectedRev < 1) throw new InvalidRequest("expectedRev must be a positive integer");
    const ownerId = ctx.userId;
    return draftTx(async (tx) => {
      // 1. The draft row first (FOR NO KEY UPDATE: it excludes other writers of the draft but not the foreign-key share locks
      // that createVersion/switchVersion need on rows they reference), then 2. the version row. Same order as the version operations.
      const drafts = await tx.$queryRaw<{ request: unknown; context: unknown; live: boolean }[]>`
        SELECT request, context, (status = 'active'::draft_status AND expires_at > now()) AS live
          FROM draft WHERE id = ${draftId}::uuid AND owner_id = ${ownerId}::uuid FOR NO KEY UPDATE`;
      const locked = drafts[0];
      if (!locked) throw new NotFound();
      if (!locked.live) throw new DraftExpired();
      const rows = await tx.$queryRaw<{ id: string; rev: number; seed: string; content: unknown; content_hash: string; question_meta: unknown; next_question_seq: number; history: unknown; changes: unknown; pending_candidate: unknown }[]>`
        SELECT id, rev, seed, content, content_hash, question_meta, next_question_seq, history, changes, pending_candidate
          FROM draft_version
         WHERE id = ${versionId}::uuid AND draft_id = ${draftId}::uuid AND owner_id = ${ownerId}::uuid
         FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new NotFound();
      const now = clock();
      if (row.rev !== expectedRev) throw new DraftConflict(row.rev);

      const version = { id: row.id, rev: row.rev, seed: row.seed, content: row.content, contentHash: row.content_hash, questionMeta: row.question_meta, nextQuestionSeq: row.next_question_seq, history: row.history, changes: row.changes, pendingCandidate: row.pending_candidate };
      const draft = { request: locked.request, context: locked.context };
      const { state, candidate } = await op({ draft, version, state: stateOf(version, draft) }, tx);

      const content = split(state.pkg);
      if (Buffer.byteLength(JSON.stringify(content), "utf8") > limits.maxDraftBytes) throw new PackageBuildError("the drafted package exceeds the size limit");
      const contentHash = packageContentHash(state.pkg);
      const updated = await tx.draftVersion.updateMany({
        where: { id: version.id, ownerId, rev: expectedRev },
        data: {
          content: content as unknown as Prisma.InputJsonValue,
          contentHash,
          questionMeta: state.meta as unknown as Prisma.InputJsonValue,
          nextQuestionSeq: state.nextSeq,
          history: state.history as unknown as Prisma.InputJsonValue,
          changes: state.changes as unknown as Prisma.InputJsonValue,
          pendingCandidate: candidate ? (candidate as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          rev: { increment: 1 },
          updatedAt: now,
        },
      });
      if (updated.count !== 1) throw new DraftConflict(expectedRev + 1);
      // Sliding expiry: rev is NOT changed here (the pointer revision belongs to version operations); only expires_at and updated_at move.
      await tx.$executeRaw`UPDATE draft SET ${slideExpiry()} WHERE id = ${draftId}::uuid AND owner_id = ${ownerId}::uuid`;
      return { rev: expectedRev + 1, contentHash };
    });
  }

  // --- versions (S3) ---------------------------------------------------------------------------------

  interface LockedDraft {
    id: string;
    rev: number;
    versionCount: number;
    activeVersionId: string | null;
    request: unknown;
    context: unknown;
  }

  /**
   * Locks the draft row (owner filtered), refuses an expired draft and compares the pointer revision the caller saw.
   * Everything a version operation writes happens after this lock, in the same transaction.
   */
  async function lockDraft(tx: Tx, ownerId: string, draftId: string, expectedDraftRev: number): Promise<LockedDraft> {
    const rows = await tx.$queryRaw<{ id: string; rev: number; version_count: number; active_version_id: string | null; live: boolean; request: unknown; context: unknown }[]>`
      SELECT id, rev, version_count, active_version_id, (status = 'active'::draft_status AND expires_at > now()) AS live, request, context
        FROM draft WHERE id = ${draftId}::uuid AND owner_id = ${ownerId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new NotFound();
    if (!row.live) throw new DraftExpired();
    if (row.rev !== expectedDraftRev) throw new DraftConflict(row.rev);
    return { id: row.id, rev: row.rev, versionCount: row.version_count, activeVersionId: row.active_version_id, request: row.request, context: row.context };
  }

  function checkVersionArgs(draftId: string, expectedDraftRev: number, versionId?: string) {
    if (!uuid.safeParse(draftId).success || (versionId !== undefined && !uuid.safeParse(versionId).success)) throw new NotFound();
    if (!Number.isInteger(expectedDraftRev) || expectedDraftRev < 1) throw new InvalidRequest("expectedDraftRev must be a positive integer");
  }

  async function createVersionTx(ownerId: string, draftId: string, expectedDraftRev: number): Promise<DraftVersionResult> {
    return draftTx(async (tx) => {
      const now = clock();
      const draft = await lockDraft(tx, ownerId, draftId, expectedDraftRev);
      const existing = await tx.draftVersion.count({ where: { draftId, ownerId } });
      if (existing >= limits.maxVersionsPerDraft) throw new VersionLimit(limits.maxVersionsPerDraft);
      if ((await incrementRateLimit(tx, `ver:u:${ownerId}`)) > limits.versionCreatesPerUserPerHour) throw new VersionRateLimited();

      // A new seed every time (never reused); the same request and context as the draft's other versions.
      const seed = newSeed();
      const { pkg, levels, report, content } = buildVerified(draft.request as LessonRequestV2, draft.context as CurriculumContext, seed);
      const ordinal = draft.versionCount + 1; // version_count never decreases: a monotonic allocator
      const version = await tx.draftVersion.create({
        data: {
          draftId,
          ownerId,
          ordinal,
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
      const moved = await tx.$queryRaw<{ expires_at: Date }[]>`
        UPDATE draft SET version_count = version_count + 1, active_version_id = ${version.id}::uuid, rev = rev + 1, ${slideExpiry()}
         WHERE id = ${draftId}::uuid AND owner_id = ${ownerId}::uuid AND rev = ${expectedDraftRev} RETURNING expires_at`;
      if (moved.length !== 1) throw new DraftConflict(expectedDraftRev + 1);
      return { draftRev: expectedDraftRev + 1, versionId: version.id, ordinal, expiresAt: moved[0]!.expires_at };
    });
  }

  /** The candidate for `questionId`: the next attempt of the current session of that slot, or the first attempt of a new one. */
  async function drawFor(locked: Locked, tx: Tx, ownerId: string, questionId: string, attemptOf: PendingCandidate | null): Promise<PendingCandidate> {
    const { state, version } = locked;
    const session = attemptOf && attemptOf.targetQuestionId === questionId && attemptOf.baseHash === packageContentHash(state.pkg) ? attemptOf : null;
    const attempt = session ? session.attempt + 1 : 1;
    if (attempt > limits.candidatesPerSlot) throw new CandidateLimit();
    if ((await incrementRateLimit(tx, `cand:u:${ownerId}`)) > limits.candidatesPerUserPerHour) throw new CandidateRateLimited();
    const tried = session ? [...session.tried, session.item.fingerprint] : [];
    return drawReplacement(state, questionId, { versionSeed: version.seed, attempt, tried, baseRev: version.rev + 1, candidateId: randomUUID() });
  }

  const pendingOf = (locked: Locked) => asCandidate(locked.version.pendingCandidate);
  function requirePending(locked: Locked, candidateId: string): PendingCandidate {
    const pending = pendingOf(locked);
    if (!pending || pending.id !== candidateId) throw new CandidateStale();
    return pending;
  }

  async function listSummaries(draftId: string, ownerId: string, activeVersionId: string | null): Promise<DraftVersionSummary[]> {
    const rows = await db.draftVersion.findMany({ where: { draftId, ownerId }, orderBy: { ordinal: "asc" }, select: { id: true, ordinal: true, createdAt: true, questionMeta: true, changes: true } });
    return rows.map((r) => ({ versionId: r.id, ordinal: r.ordinal, createdAt: r.createdAt, changesSummary: summaryOf(r.questionMeta, r.changes), isActive: r.id === activeVersionId }));
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

      const state = stateOf(version, draft);
      const pkg = state.pkg;
      const versions = await listSummaries(draft.id, ctx.userId, draft.activeVersionId);
      const context = draft.context as unknown as CurriculumContext;
      const request = draft.request as unknown as LessonRequestV2;
      return {
        draftId: draft.id,
        versionId: version.id,
        ordinal: version.ordinal,
        rev: version.rev,
        draftRev: draft.rev,
        activeVersionId: draft.activeVersionId ?? version.id,
        versions,
        versionLimit: limits.maxVersionsPerDraft,
        contentHash: version.contentHash,
        expiresAt: draft.expiresAt,
        updatedAt: draft.updatedAt,
        documents: pkg.documents.map((d) => d.id),
        title: context.topic.title,
        selection: selectionOf(request, context),
        package: pkg,
        adjust: {
          slots: questionSlots(pkg, state.meta),
          changes: changeSummary(state),
          undoLabel: undoLabel(state),
          candidate: asCandidate(version.pendingCandidate),
          minExercises: Math.max(limits.minExercises, BUILDER_MIN_EXERCISES),
        },
      };
    },

    /**
     * Creates another version of the draft from its stored request and a fresh seed, makes it the active one and keeps every
     * earlier version untouched. `expectedDraftRev` is the draft revision the page showed (else DRAFT_CONFLICT). Refused with
     * VERSION_LIMIT at the configured number of versions (nothing is evicted) and VERSION_RATE_LIMITED past the hourly cap.
     */
    async createVersion(ctx: AuthedCtx, draftId: string, expectedDraftRev: number): Promise<DraftVersionResult> {
      checkVersionArgs(draftId, expectedDraftRev);
      try {
        return await createVersionTx(ctx.userId, draftId, expectedDraftRev);
      } catch (error) {
        if (isCheckViolation(error)) throw new PackageBuildError("the drafted package exceeds a storage limit");
        throw error;
      }
    },

    /** Points the draft at another of its own versions. Writes only the draft row (pointer, rev + 1, expiry); no version row is touched. */
    async switchVersion(ctx: AuthedCtx, draftId: string, versionId: string, expectedDraftRev: number): Promise<DraftVersionResult> {
      checkVersionArgs(draftId, expectedDraftRev, versionId);
      const ownerId = ctx.userId;
      return draftTx(async (tx) => {
        await lockDraft(tx, ownerId, draftId, expectedDraftRev);
        const target = await tx.draftVersion.findFirst({ where: { id: versionId, draftId, ownerId }, select: { id: true, ordinal: true } });
        if (!target) throw new NotFound();
        const moved = await tx.$queryRaw<{ expires_at: Date }[]>`
          UPDATE draft SET active_version_id = ${target.id}::uuid, rev = rev + 1, ${slideExpiry()}
           WHERE id = ${draftId}::uuid AND owner_id = ${ownerId}::uuid AND rev = ${expectedDraftRev} RETURNING expires_at`;
        if (moved.length !== 1) throw new DraftConflict(expectedDraftRev + 1);
        return { draftRev: expectedDraftRev + 1, versionId: target.id, ordinal: target.ordinal, expiresAt: moved[0]!.expires_at };
      });
    },

    /** Lightweight summaries of every version of the draft, in ordinal order. No content. */
    async listVersions(ctx: AuthedCtx, draftId: string): Promise<DraftVersionSummary[]> {
      if (!uuid.safeParse(draftId).success) throw new NotFound();
      const draft = await db.draft.findFirst({ where: { id: draftId, ownerId: ctx.userId }, select: { activeVersionId: true, status: true, expiresAt: true } });
      if (!draft) throw new NotFound();
      if (draft.status === "expired" || draft.expiresAt.getTime() <= clock().getTime()) throw new DraftExpired();
      return listSummaries(draftId, ctx.userId, draft.activeVersionId);
    },

    /**
     * Asks for an alternative to one exercise (same level). The original stays in the draft until the candidate is accepted.
     * Asking again for the same question draws the next attempt; asking for another question replaces the pending candidate.
     */
    requestCandidate: (ctx: AuthedCtx, draftId: string, versionId: string, expectedRev: number, questionId: string) =>
      mutate(ctx, draftId, versionId, expectedRev, async (locked, tx) => ({ state: locked.state, candidate: await drawFor(locked, tx, ctx.userId, questionId, pendingOf(locked)) })),

    /** Draws the next alternative for the pending candidate's question, excluding everything tried. */
    tryAnother: (ctx: AuthedCtx, draftId: string, versionId: string, expectedRev: number, candidateId: string) =>
      mutate(ctx, draftId, versionId, expectedRev, async (locked, tx) => {
        const pending = requirePending(locked, candidateId);
        return { state: locked.state, candidate: await drawFor(locked, tx, ctx.userId, pending.targetQuestionId, pending) };
      }),

    /** Drops the pending candidate; the draft content is untouched. */
    keepOriginal: (ctx: AuthedCtx, draftId: string, versionId: string, expectedRev: number, candidateId: string) =>
      mutate(ctx, draftId, versionId, expectedRev, async (locked) => {
        requirePending(locked, candidateId);
        return { state: locked.state, candidate: null };
      }),

    /** Applies the pending candidate (exercise and solution together) if the content is still what it was drawn against. */
    acceptCandidate: (ctx: AuthedCtx, draftId: string, versionId: string, expectedRev: number, candidateId: string) =>
      mutate(ctx, draftId, versionId, expectedRev, async (locked) => {
        const pending = requirePending(locked, candidateId);
        return { state: acceptReplacement(locked.state, pending, opsConfig(), clock()), candidate: null };
      }),

    /** Removes one exercise and its solution (configured minimum applies). A pending candidate is dropped (it was drawn against other content). */
    removeQuestion: (ctx: AuthedCtx, draftId: string, versionId: string, expectedRev: number, questionId: string) =>
      mutate(ctx, draftId, versionId, expectedRev, async (locked) => ({ state: removeQuestionOp(locked.state, questionId, opsConfig(), clock()), candidate: null })),

    /** Undoes the most recent question-level change. A pending candidate is dropped. */
    undo: (ctx: AuthedCtx, draftId: string, versionId: string, expectedRev: number) =>
      mutate(ctx, draftId, versionId, expectedRev, async (locked) => ({ state: undoLast(locked.state), candidate: null })),

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
