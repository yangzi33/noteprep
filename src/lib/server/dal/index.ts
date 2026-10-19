import "server-only";
import type { Db } from "../db";
import { createAccountDal } from "./account";
import { createGenerationDal, type GenerationDeps } from "./generation";
import type { BackoffPolicy } from "@/lib/domain/retry";
import { createJobsDal } from "./jobs";
import { createSettlementDal } from "./settlement";

export { toJobDto, type JobDto } from "./dto";
export type { CommitSuccessInput, FinishJobInput, RevisionDraft } from "./settlement";
export type { ClaimedJob, HeartbeatResult, JobsDal, SweepReport, UsageCharge } from "./jobs";

/** Web runtime: account setup, enqueueing, owner-filtered reads. Use the `app_runtime` connection. */
export function createWebDal(db: Db, deps?: GenerationDeps) {
  return {
    account: createAccountDal(db, deps?.limits?.trialLimit),
    generation: createGenerationDal(db, deps),
  };
}

/** Worker runtime: settlement. Use the `worker_runtime` connection. */
export function createWorkerDal(db: Db, options: { backoff?: BackoffPolicy } = {}) {
  return { settlement: createSettlementDal(db), jobs: createJobsDal(db, options.backoff) };
}
