import "server-only";
import type { Db } from "../db";
import { DEFAULT_ALLOWANCE_POLICY, type AllowancePolicy } from "./allowance-source";
import { createAccountDal } from "./account";
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
import { createRecoveryDal } from "./recovery";
import { createSettlementDal } from "./settlement";

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
export type { ClaimedJob, ExportInput, HeartbeatResult, JobsDal, SweepReport, UsageCharge } from "./jobs";

/** Web runtime: account setup, enqueueing, owner-filtered reads. Use the `app_runtime` connection. */
export function createWebDal(db: Db, deps?: GenerationDeps & { curriculum?: CurriculumDalOptions; drafts?: Omit<DraftDeps, "resolveContext">; exports?: Omit<ExportDeps, "generationLimits">; allowancePolicy?: AllowancePolicy }) {
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
    curriculum,
  };
}

/** Worker runtime: settlement. Use the `worker_runtime` connection. */
export function createWorkerDal(db: Db, options: { backoff?: BackoffPolicy; purgeGraceDays?: number; exportDeadlineGraceSeconds?: number } = {}) {
  return {
    settlement: createSettlementDal(db),
    jobs: createJobsDal(db, options.backoff, { exportDeadlineGraceSeconds: options.exportDeadlineGraceSeconds }),
    drafts: createDraftsPurgeDal(db, { graceDays: options.purgeGraceDays }),
    /** Read-only: used by the operator recovery script only (worker/recover.ts). */
    recovery: createRecoveryDal(db),
  };
}
