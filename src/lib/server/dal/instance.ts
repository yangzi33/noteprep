import "server-only";
import { getDb } from "../db";
import { serverEnv } from "../env";
import { createWebDal } from "./index";

const globalForDal = globalThis as unknown as { __noteprepWebDal?: ReturnType<typeof createWebDal> };

/** The web runtime's DAL, built on the process-wide `app_runtime` connection. */
export function webDal() {
  globalForDal.__noteprepWebDal ??= createWebDal(getDb(), { allowancePolicy: { dailyRefresh: { enabled: serverEnv().limits.dailyRefreshEnabled === 1, limit: serverEnv().limits.dailyRefreshLimit } },  curriculum: { allowSample: serverEnv().CURRICULUM_ALLOW_SAMPLE === "1" }, drafts: { limits: serverEnv().limits }, exports: { enabled: serverEnv().EXPORT_ENABLED === "1", limits: serverEnv().limits } });
  return globalForDal.__noteprepWebDal;
}
