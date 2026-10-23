import "server-only";
import type { Db } from "../db";
import { createAccountDal } from "./account";
import { createCurriculumDal, type CurriculumDalOptions } from "./curriculum";
import { createDraftsDal, createDraftsPurgeDal, type DraftDeps } from "./drafts";
import { createGenerationDal, type GenerationDeps } from "./generation";
import { createHistoryDal } from "./history";
import type { BackoffPolicy } from "@/lib/domain/retry";
import { createJobsDal } from "./jobs";
import { createLessonsDal } from "./lessons";
import { createSettlementDal } from "./settlement";

export { toJobDto, type JobDto } from "./dto";
export type { DraftCreated, DraftSelection, DraftSummaryDto, DraftViewDto } from "./dto";
export type { CreateDraftOptions, CreateDraftResult, DraftsDal, DraftsPurgeDal, PurgeReport } from "./drafts";
export type { CommitSuccessInput, FinishJobInput, RevisionDraft } from "./settlement";
export type { AllowanceView, HistoryItem } from "./history";
export type { AlignmentView, ArtifactRef, LessonDocumentView, LessonView } from "./lessons";
export type { CurriculumSummary, SelectionOption, SelectionOptions, SelectionPath, SelectionStep } from "./curriculum";
export type { ClaimedJob, HeartbeatResult, JobsDal, SweepReport, UsageCharge } from "./jobs";

/** Web runtime: account setup, enqueueing, owner-filtered reads. Use the `app_runtime` connection. */
export function createWebDal(db: Db, deps?: GenerationDeps & { curriculum?: CurriculumDalOptions; drafts?: Omit<DraftDeps, "resolveContext"> }) {
  const curriculum = createCurriculumDal(db, deps?.curriculum);
  return {
    account: createAccountDal(db, deps?.limits?.trialLimit),
    generation: createGenerationDal(db, { ...deps, resolveContext: curriculum.resolveCurriculumContext }),
    history: createHistoryDal(db, deps),
    lessons: createLessonsDal(db),
    drafts: createDraftsDal(db, { ...deps?.drafts, resolveContext: curriculum.resolveCurriculumContext }),
    curriculum,
  };
}

/** Worker runtime: settlement. Use the `worker_runtime` connection. */
export function createWorkerDal(db: Db, options: { backoff?: BackoffPolicy; purgeGraceDays?: number } = {}) {
  return {
    settlement: createSettlementDal(db),
    jobs: createJobsDal(db, options.backoff),
    drafts: createDraftsPurgeDal(db, { graceDays: options.purgeGraceDays }),
  };
}
