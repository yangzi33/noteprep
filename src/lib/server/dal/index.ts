import "server-only";
import type { Db } from "../db";
import type { AuthedCtx } from "../auth/context";
import type { TakeInput as AiActionTakeInput } from "./ai-action";
import { DEFAULT_ALLOWANCE_POLICY, type AllowancePolicy } from "./allowance-source";
import { createAccountDal } from "./account";
import { createAiActionDal } from "./ai-action";
import { createAuthRateDal } from "./auth-rate";
import { createCurriculumDal, type CurriculumDalOptions } from "./curriculum";
import { createDraftsDal, createDraftsPurgeDal, type DraftDeps } from "./drafts";
import { createExportDal, type ExportDeps } from "./export";
import { createGenerationDal, type GenerationDeps } from "./generation";
import { createHistoryDal } from "./history";
import type { BackoffPolicy } from "@/lib/domain/retry";
import { createJobsDal } from "./jobs";
import { createLessonDeleteDal } from "./lesson-delete";
import { createLessonsDal } from "./lessons";
import { createLlmSpendDal } from "./llm-spend";
import { createRecoveryDal } from "./recovery";
import { createSettlementDal } from "./settlement";
import { createSpendReportDal } from "./spend-report";
import { DEFAULT_LIMITS, type Limits } from "../limits";

export { toJobDto, type JobDto } from "./dto";
export type { DraftCreated, DraftSelection, DraftSummaryDto, DraftViewDto } from "./dto";
export type { CreateDraftOptions, CreateDraftResult, DraftsDal, DraftsPurgeDal, PurgeReport } from "./drafts";
export type { ConfirmExportInput, ExportDal } from "./export";
export type { ConfirmExportResult, ExportStatusDto } from "./dto";
export type { CommitExportInput, CommitSuccessInput, FinishJobInput, RevisionDraft } from "./settlement";
export type { RecoveryDal, RecoveryRevision } from "./recovery";
export type { LessonDeleteResult } from "./lesson-delete";
export type { AllowanceView, HistoryItem } from "./history";
export type { AlignmentView, ArtifactRef, LessonDocumentView, LessonView } from "./lessons";
export type { CurriculumSummary, SelectionOption, SelectionOptions, SelectionPath, SelectionStep } from "./curriculum";
export type { AiActionKind, AiActionRow, AiActionState, TakeInput as AiActionTakeInput } from "./ai-action";
export type { CallEstimate, CallPurpose, RefusalReason, ReserveInput, ReserveResult, SettleInput, LlmSpendDal } from "./llm-spend";
export type { SpendReport, SpendReportDal, SpendReportWindow } from "./spend-report";
export type { ClaimedJob, ExportInput, HeartbeatResult, JobsDal, SweepReport, UsageCharge } from "./jobs";

function aiActionsFor(dal: ReturnType<typeof createAiActionDal>) {
  return {
    take: (ctx: AuthedCtx, input: Omit<AiActionTakeInput, "ownerId">) => dal.take({ ...input, ownerId: ctx.userId }),
  };
}

/** Web runtime: account setup, enqueueing, owner-filtered reads. Use the `app_runtime` connection. */
export function createWebDal(db: Db, deps?: GenerationDeps & { curriculum?: CurriculumDalOptions; drafts?: Omit<DraftDeps, "resolveContext">; exports?: Omit<ExportDeps, "generationLimits">; allowancePolicy?: AllowancePolicy; aiLimits?: Limits }) {
  const allowancePolicy = deps?.allowancePolicy ?? DEFAULT_ALLOWANCE_POLICY;
  const curriculum = createCurriculumDal(db, deps?.curriculum);
  return {
    account: createAccountDal(db, deps?.limits?.trialLimit),
    authRate: createAuthRateDal(db, deps?.drafts?.limits),
    generation: createGenerationDal(db, { ...deps, allowancePolicy, resolveContext: curriculum.resolveCurriculumContext }),
    history: createHistoryDal(db, { ...deps, allowancePolicy }),
    lessons: createLessonsDal(db),
    lessonDelete: createLessonDeleteDal(db),
    drafts: createDraftsDal(db, { ...deps?.drafts, resolveContext: curriculum.resolveCurriculumContext }),
    exports: createExportDal(db, { clock: deps?.clock, allowancePolicy, ...deps?.exports, generationLimits: deps?.limits }),
    /**
     * User-initiated AI requests: the hourly limit, the kill switch and the global stop (spec 5.12). Only the caller's own slot can be
     * taken; closing and finalizing belong to the worker, and the slice that enqueues AI jobs composes `takeIn` in its own transaction.
     */
    aiActions: aiActionsFor(createAiActionDal(db, deps?.aiLimits ?? DEFAULT_LIMITS)),
    curriculum,
  };
}

/** Worker runtime: settlement. Use the `worker_runtime` connection. */
export function createWorkerDal(db: Db, options: { backoff?: BackoffPolicy; purgeGraceDays?: number; exportDeadlineGraceSeconds?: number; limits?: Limits } = {}) {
  const limits = options.limits ?? DEFAULT_LIMITS;
  return {
    /** The LLM spend ledger: reserve before every provider call, settle after (spec 5.5). */
    spend: createLlmSpendDal(db, limits),
    aiActions: createAiActionDal(db, limits),
    spendReport: createSpendReportDal(db),
    settlement: createSettlementDal(db),
    jobs: createJobsDal(db, options.backoff, { exportDeadlineGraceSeconds: options.exportDeadlineGraceSeconds }),
    drafts: createDraftsPurgeDal(db, { graceDays: options.purgeGraceDays }),
    /** Read-only: used by the operator recovery script only (worker/recover.ts). */
    recovery: createRecoveryDal(db),
  };
}
