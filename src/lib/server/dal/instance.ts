import "server-only";
import { getDb } from "../db";
import { serverEnv } from "../env";
import { createWebDal } from "./index";

const globalForDal = globalThis as unknown as { __noteprepWebDal?: ReturnType<typeof createWebDal> };

/** The web runtime's DAL, built on the process-wide `app_runtime` connection. */
export function webDal() {
  globalForDal.__noteprepWebDal ??= createWebDal(getDb(), { curriculum: { allowSample: serverEnv().CURRICULUM_ALLOW_SAMPLE === "1" } });
  return globalForDal.__noteprepWebDal;
}
